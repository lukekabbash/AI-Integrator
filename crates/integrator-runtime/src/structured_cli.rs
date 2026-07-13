use std::{path::PathBuf, process::Stdio, sync::Arc};

use integrator_core::{IntegratorError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{Mutex, broadcast, oneshot},
};

use crate::redact_and_bound;

const EVENT_CAPACITY: usize = 512;
const DIAGNOSTIC_LIMIT: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StructuredCliProvider {
    Claude,
    /// Google Antigravity CLI (`agy`), the successor to the retired Gemini
    /// CLI. Print mode emits one final JSON object per turn (no streaming).
    Antigravity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StructuredPermissionMode {
    Prompt,
    ReadOnly,
    AcceptEdits,
    /// Skip provider approval prompts entirely. Only reachable from the
    /// explicit "Full access" profile the user picked in the composer.
    BypassPermissions,
}

#[derive(Clone, Debug)]
pub struct StructuredCliLaunchOptions {
    pub provider: StructuredCliProvider,
    pub executable: PathBuf,
    pub working_directory: PathBuf,
    pub model: Option<String>,
    /// Reasoning effort. Only Claude exposes a CLI flag for this (`--effort`);
    /// other providers ignore it.
    pub effort: Option<String>,
    pub resume_session_id: Option<String>,
    pub permission_mode: StructuredPermissionMode,
    /// MCP config file granting this session the delegation-broker tool
    /// surface. Claude-only in v1: the flag pair is not portable, so other
    /// providers ignore it.
    pub mcp_config_path: Option<PathBuf>,
}

/// Effort levels `claude --effort` accepts. Unknown values are dropped rather
/// than forwarded so a stale UI value cannot fail the whole turn.
const CLAUDE_EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// Maps a UI effort id to the capitalized suffix agy's model names use.
/// Unknown values are dropped: agy silently ignores unrecognized `--model`
/// strings, so a bad compose would silently change the served model.
fn antigravity_effort_suffix(effort: &Option<String>) -> Option<&'static str> {
    match effort.as_deref()? {
        "low" => Some("Low"),
        "medium" => Some("Medium"),
        "high" => Some("High"),
        _ => None,
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuredUsage {
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    /// Tokens spent writing the prompt cache (Claude's
    /// `cache_creation_input_tokens`). Billed as input; kept separate so the
    /// projection can fold them into input without double-counting cache reads.
    pub cache_creation_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// Reasoning tokens (agy's `thinking_tokens`). Claude does not report them.
    pub reasoning_output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    /// Vendor-computed API-equivalent cost in micro-USD (Claude's
    /// `total_cost_usd`). A client-side estimate, not a bill; integer so the
    /// projection types stay `Eq`.
    pub cost_micro_usd: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StructuredCliEventKind {
    Init {
        model: Option<String>,
    },
    Text {
        text: String,
        delta: bool,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        id: String,
        is_error: bool,
        content: String,
    },
    Result {
        success: bool,
        message: Option<String>,
        usage: StructuredUsage,
    },
    /// The CLI is asking whether the agent may use a tool (Claude's
    /// stream-json `control_request`/`can_use_tool`). The turn stays blocked
    /// until `respond_permission` writes the matching `control_response`.
    PermissionRequest {
        request_id: String,
        tool_use_id: String,
        tool_name: String,
        input: Value,
        description: Option<String>,
        /// `permission_suggestions` passed through verbatim so an
        /// "always allow" decision can echo them back to the CLI.
        suggestions: Value,
    },
    Diagnostic {
        message: String,
    },
    /// The CLI reported a permission-mode change (Claude's stream-json
    /// `system`/`status` message, e.g. after an approved `ExitPlanMode`).
    PermissionModeChanged {
        mode: String,
    },
    Exited {
        code: Option<i32>,
        cancelled: bool,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StructuredCliEvent {
    pub turn_id: String,
    pub session_id: Option<String>,
    pub event: StructuredCliEventKind,
}

#[derive(Clone)]
pub struct StructuredCliClient {
    events: broadcast::Sender<StructuredCliEvent>,
    active: Arc<Mutex<Option<ActiveTurn>>>,
}

struct ActiveTurn {
    turn_id: String,
    cancel: oneshot::Sender<()>,
    /// Kept open for Claude so permission `control_response` lines can be
    /// written mid-turn. `None` once the turn result closed the pipe (or for
    /// providers without a control channel).
    stdin: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
}

impl Default for StructuredCliClient {
    fn default() -> Self {
        Self::new()
    }
}

impl StructuredCliClient {
    #[must_use]
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        Self {
            events,
            active: Arc::new(Mutex::new(None)),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<StructuredCliEvent> {
        self.events.subscribe()
    }

    /// Starts one structured CLI turn. Prompt content is written over stdin and
    /// is never included in the child process command line.
    pub async fn start_turn(
        &self,
        options: StructuredCliLaunchOptions,
        prompt: String,
    ) -> Result<String> {
        let mut active = self.active.lock().await;
        if active.is_some() {
            return Err(IntegratorError::Unavailable(
                "a structured CLI turn is already running".into(),
            ));
        }
        let turn_id = uuid::Uuid::new_v4().to_string();
        let (cancel, cancel_rx) = oneshot::channel();
        let stdin_slot: Arc<Mutex<Option<tokio::process::ChildStdin>>> = Arc::new(Mutex::new(None));
        *active = Some(ActiveTurn {
            turn_id: turn_id.clone(),
            cancel,
            stdin: Arc::clone(&stdin_slot),
        });

        let child = match spawn_structured_child(&options) {
            Ok(child) => child,
            Err(error) => {
                *active = None;
                return Err(error);
            }
        };
        let events = self.events.clone();
        let active_turn = Arc::clone(&self.active);
        let task_turn_id = turn_id.clone();
        tokio::spawn(async move {
            run_child(
                child,
                options.provider,
                prompt,
                task_turn_id.clone(),
                cancel_rx,
                events.clone(),
                stdin_slot,
            )
            .await;
            let mut active = active_turn.lock().await;
            if active
                .as_ref()
                .is_some_and(|turn| turn.turn_id == task_turn_id)
            {
                *active = None;
            }
        });
        Ok(turn_id)
    }

    /// Answers a pending `can_use_tool` permission request by writing the
    /// matching `control_response` line to the provider's stdin. `response`
    /// is the protocol payload, e.g. `{"behavior":"allow","updatedInput":{..}}`
    /// or `{"behavior":"deny","message":".."}`.
    pub async fn respond_permission(&self, request_id: &str, response: Value) -> Result<()> {
        let stdin = {
            let active = self.active.lock().await;
            let Some(turn) = active.as_ref() else {
                return Err(IntegratorError::Unavailable(
                    "no structured CLI turn is running".into(),
                ));
            };
            Arc::clone(&turn.stdin)
        };
        let mut guard = stdin.lock().await;
        let Some(writer) = guard.as_mut() else {
            return Err(IntegratorError::Unavailable(
                "the structured CLI control channel is closed".into(),
            ));
        };
        let line = serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": response,
            },
        });
        let mut payload = line.to_string();
        payload.push('\n');
        writer
            .write_all(payload.as_bytes())
            .await
            .map_err(IntegratorError::from)?;
        writer.flush().await.map_err(IntegratorError::from)
    }

    pub async fn cancel(&self, turn_id: &str) -> Result<bool> {
        let mut active = self.active.lock().await;
        let Some(turn) = active.take() else {
            return Ok(false);
        };
        if turn.turn_id != turn_id {
            *active = Some(turn);
            return Err(IntegratorError::Unavailable(
                "the requested structured CLI turn is not active".into(),
            ));
        }
        let _ = turn.cancel.send(());
        Ok(true)
    }
}

fn provider_args(options: &StructuredCliLaunchOptions) -> Vec<String> {
    let mut args = match options.provider {
        StructuredCliProvider::Claude => {
            let mut args: Vec<String> = vec![
                "--print".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--verbose".into(),
                "--include-partial-messages".into(),
                // The prompt is delivered as a stream-json user message so
                // stdin can double as the permission control channel.
                "--input-format".into(),
                "stream-json".into(),
                "--permission-mode".into(),
                match options.permission_mode {
                    StructuredPermissionMode::Prompt => "manual",
                    StructuredPermissionMode::ReadOnly => "plan",
                    StructuredPermissionMode::AcceptEdits => "acceptEdits",
                    StructuredPermissionMode::BypassPermissions => "bypassPermissions",
                }
                .into(),
            ];
            if !matches!(
                options.permission_mode,
                StructuredPermissionMode::BypassPermissions
            ) {
                // Route permission prompts over stdio control requests so the
                // UI can render approval popups instead of tools being
                // silently denied in print mode.
                args.extend(["--permission-prompt-tool".into(), "stdio".into()]);
            }
            args
        }
        // The prompt reaches `agy` over piped stdin (print mode activates on
        // non-TTY stdin without `-p`), keeping prompt text off the command
        // line. `--mode` accepts only `plan` and `accept-edits`; the default
        // request-review mode is agy's own prompt-for-approval behavior.
        StructuredCliProvider::Antigravity => {
            let mut args = vec!["--output-format".into(), "json".into()];
            match options.permission_mode {
                // agy print mode has no control channel to answer its default
                // request-review prompts; callers must not route "ask" here.
                StructuredPermissionMode::Prompt => {}
                StructuredPermissionMode::ReadOnly => {
                    args.extend(["--mode".into(), "plan".into()]);
                }
                StructuredPermissionMode::AcceptEdits => {
                    args.extend(["--mode".into(), "accept-edits".into()]);
                }
                StructuredPermissionMode::BypassPermissions => {
                    args.push("--dangerously-skip-permissions".into());
                }
            }
            args
        }
    };
    if let Some(model) = options
        .model
        .as_deref()
        .filter(|value| !value.is_empty() && *value != "provider-default")
    {
        let model = match options.provider {
            // agy has no effort flag; its catalog encodes the reasoning
            // level in the model name itself ("Gemini 3.1 Pro (High)"), so
            // the selected effort composes into the `--model` value.
            StructuredCliProvider::Antigravity => {
                match antigravity_effort_suffix(&options.effort) {
                    Some(suffix) => format!("{model} ({suffix})"),
                    None => model.to_owned(),
                }
            }
            StructuredCliProvider::Claude => model.to_owned(),
        };
        args.extend(["--model".into(), model]);
    }
    if matches!(options.provider, StructuredCliProvider::Claude) {
        if let Some(effort) = options
            .effort
            .as_deref()
            .filter(|value| CLAUDE_EFFORT_LEVELS.contains(value))
        {
            args.extend(["--effort".into(), effort.into()]);
        }
    }
    if let Some(session) = options
        .resume_session_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        let resume_flag = match options.provider {
            StructuredCliProvider::Claude => "--resume",
            StructuredCliProvider::Antigravity => "--conversation",
        };
        args.extend([resume_flag.into(), session.into()]);
    }
    if matches!(options.provider, StructuredCliProvider::Claude) {
        if let Some(mcp_config) = options.mcp_config_path.as_deref() {
            // `--allowed-tools mcp__integrator` pre-approves the injected
            // broker server's tools; print mode has no interactive prompt to
            // approve them otherwise.
            args.extend([
                "--mcp-config".into(),
                mcp_config.to_string_lossy().into_owned(),
                "--allowed-tools".into(),
                "mcp__integrator".into(),
            ]);
        }
    }
    args
}

fn spawn_structured_child(options: &StructuredCliLaunchOptions) -> Result<Child> {
    let args = provider_args(options);
    let mut command = platform_command(&options.executable, &args);
    command
        .current_dir(&options.working_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.spawn().map_err(IntegratorError::from)
}

fn platform_command(executable: &std::path::Path, args: &[String]) -> Command {
    #[cfg(windows)]
    {
        let extension = executable
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if extension == "ps1" {
            let mut command = Command::new("powershell.exe");
            command
                .args([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(executable)
                .args(args);
            return command;
        }
        if matches!(extension.as_str(), "cmd" | "bat") {
            let mut command =
                Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()));
            command.args(["/d", "/s", "/c"]);
            let line = std::iter::once(executable.to_string_lossy().into_owned())
                .chain(args.iter().cloned())
                .map(|value| quote_windows_arg(&value))
                .collect::<Vec<_>>()
                .join(" ");
            command.arg(line);
            return command;
        }
    }
    let mut command = Command::new(executable);
    command.args(args);
    command
}

#[cfg(windows)]
fn quote_windows_arg(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

async fn run_child(
    mut child: Child,
    provider: StructuredCliProvider,
    prompt: String,
    turn_id: String,
    mut cancel: oneshot::Receiver<()>,
    events: broadcast::Sender<StructuredCliEvent>,
    stdin_slot: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
) {
    if let Some(mut stdin) = child.stdin.take() {
        match provider {
            // Claude speaks stream-json on stdin: the prompt goes over as a
            // user message and the pipe stays open so permission
            // control_responses can be written mid-turn. The pipe closes when
            // the result event lands, which lets `--print` exit.
            StructuredCliProvider::Claude => {
                let init = serde_json::json!({
                    "type": "control_request",
                    "request_id": "integrator-init",
                    "request": { "subtype": "initialize" },
                });
                let user = serde_json::json!({
                    "type": "user",
                    "message": { "role": "user", "content": prompt },
                    "parent_tool_use_id": Value::Null,
                    "session_id": "default",
                });
                let payload = format!("{init}\n{user}\n");
                if stdin.write_all(payload.as_bytes()).await.is_ok() && stdin.flush().await.is_ok()
                {
                    *stdin_slot.lock().await = Some(stdin);
                }
            }
            StructuredCliProvider::Antigravity => {
                let _ = stdin.write_all(prompt.as_bytes()).await;
                let _ = stdin.shutdown().await;
            }
        }
    }
    // Drain stderr concurrently so a verbose provider cannot deadlock on a
    // full pipe. Only a bounded, redacted prefix is retained for diagnostics.
    let stderr_task = child
        .stderr
        .take()
        .map(|stderr| tokio::spawn(drain_diagnostic(stderr)));
    let mut stdout = child.stdout.take().map(BufReader::new);
    let mut line = String::new();
    let mut session_id = None;
    let mut cancelled = false;
    let mut saw_text_delta = false;
    loop {
        let Some(reader) = stdout.as_mut() else { break };
        line.clear();
        tokio::select! {
            read = reader.read_line(&mut line) => match read {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    for event in parse_provider_line(provider, &line) {
                        if let Some(id) = event.session_id.clone() { session_id = Some(id); }
                        if matches!(event.event, StructuredCliEventKind::Text { delta: true, .. }) {
                            saw_text_delta = true;
                        } else if saw_text_delta && matches!(event.event, StructuredCliEventKind::Text { delta: false, .. }) {
                            // Claude emits the completed assistant block after
                            // its partial events. Do not duplicate streamed text.
                            continue;
                        }
                        let terminal = matches!(event.event, StructuredCliEventKind::Result { .. });
                        let _ = events.send(StructuredCliEvent { turn_id: turn_id.clone(), session_id: session_id.clone(), event: event.event });
                        if terminal {
                            // No further user messages follow the turn result;
                            // closing stdin lets the print-mode process exit.
                            if let Some(mut stdin) = stdin_slot.lock().await.take() {
                                let _ = stdin.shutdown().await;
                            }
                        }
                    }
                }
            },
            _ = &mut cancel => {
                cancelled = true;
                terminate_process_tree(&mut child).await;
                break;
            }
        }
    }
    stdin_slot.lock().await.take();
    let status = child.wait().await.ok();
    if !cancelled && status.as_ref().is_some_and(|status| !status.success()) {
        if let Some(task) = stderr_task {
            if let Ok(diagnostic) = task.await {
                if !diagnostic.trim().is_empty() {
                    let message = redact_and_bound(diagnostic.trim(), DIAGNOSTIC_LIMIT).0;
                    let _ = events.send(StructuredCliEvent {
                        turn_id: turn_id.clone(),
                        session_id: session_id.clone(),
                        event: StructuredCliEventKind::Diagnostic { message },
                    });
                }
            }
        }
    }
    let _ = events.send(StructuredCliEvent {
        turn_id,
        session_id,
        event: StructuredCliEventKind::Exited {
            code: status.and_then(|value| value.code()),
            cancelled,
        },
    });
}

async fn drain_diagnostic(mut stderr: impl tokio::io::AsyncRead + Unpin) -> String {
    let mut retained = Vec::with_capacity(DIAGNOSTIC_LIMIT);
    let mut buffer = [0_u8; 4096];
    loop {
        let Ok(count) = stderr.read(&mut buffer).await else {
            break;
        };
        if count == 0 {
            break;
        }
        let remaining = DIAGNOSTIC_LIMIT.saturating_sub(retained.len());
        retained.extend_from_slice(&buffer[..count.min(remaining)]);
    }
    String::from_utf8_lossy(&retained).into_owned()
}

async fn terminate_process_tree(child: &mut Child) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    let _ = child.start_kill();
}

#[derive(Debug)]
struct ParsedEvent {
    session_id: Option<String>,
    event: StructuredCliEventKind,
}

fn parse_provider_line(provider: StructuredCliProvider, line: &str) -> Vec<ParsedEvent> {
    let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
        return Vec::new();
    };
    match provider {
        StructuredCliProvider::Claude => parse_claude_event(&value).into_iter().collect(),
        StructuredCliProvider::Antigravity => parse_antigravity_result(&value),
    }
}

fn parse_claude_event(value: &Value) -> Option<ParsedEvent> {
    let session_id = string_at(value, "session_id");
    match value.get("type")?.as_str()? {
        "system" if value.get("subtype").and_then(Value::as_str) == Some("init") => {
            Some(ParsedEvent {
                session_id,
                event: StructuredCliEventKind::Init {
                    model: string_at(value, "model"),
                },
            })
        }
        // Claude reports permission-mode transitions (e.g. leaving plan mode
        // after an approved ExitPlanMode) as status messages.
        "system" if value.get("subtype").and_then(Value::as_str) == Some("status") => {
            let mode = string_at(value, "permissionMode")?;
            Some(ParsedEvent {
                session_id,
                event: StructuredCliEventKind::PermissionModeChanged { mode },
            })
        }
        "stream_event" => {
            let event = value.get("event")?;
            (event.get("type")?.as_str()? == "content_block_delta").then_some(())?;
            let delta = event.get("delta")?;
            (delta.get("type")?.as_str()? == "text_delta").then_some(())?;
            Some(ParsedEvent {
                session_id,
                event: StructuredCliEventKind::Text {
                    text: string_at(delta, "text").unwrap_or_default(),
                    delta: true,
                },
            })
        }
        "assistant" => parse_claude_assistant(value, session_id),
        "control_request" => parse_claude_control_request(value, session_id),
        "result" => Some(ParsedEvent {
            session_id,
            event: StructuredCliEventKind::Result {
                success: !value
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                message: string_at(value, "result")
                    .map(|text| redact_and_bound(&text, DIAGNOSTIC_LIMIT).0),
                usage: StructuredUsage {
                    cost_micro_usd: micro_usd_at(value, "total_cost_usd"),
                    ..parse_usage(value.get("usage"))
                },
            },
        }),
        _ => None,
    }
}

/// Maps a stream-json `control_request` line onto a permission event. Only
/// `can_use_tool` is surfaced; other control subtypes (e.g. the initialize
/// acknowledgement flow) need no UI.
fn parse_claude_control_request(value: &Value, session_id: Option<String>) -> Option<ParsedEvent> {
    let request = value.get("request")?;
    (request.get("subtype")?.as_str()? == "can_use_tool").then_some(())?;
    Some(ParsedEvent {
        session_id,
        event: StructuredCliEventKind::PermissionRequest {
            request_id: string_at(value, "request_id")?,
            tool_use_id: string_at(request, "tool_use_id").unwrap_or_default(),
            tool_name: string_at(request, "tool_name").unwrap_or_default(),
            input: request.get("input").cloned().unwrap_or(Value::Null),
            description: string_at(request, "description"),
            suggestions: request
                .get("permission_suggestions")
                .cloned()
                .unwrap_or(Value::Null),
        },
    })
}

fn parse_claude_assistant(value: &Value, session_id: Option<String>) -> Option<ParsedEvent> {
    let content = value.pointer("/message/content")?.as_array()?;
    for block in content {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                return Some(ParsedEvent {
                    session_id,
                    event: StructuredCliEventKind::Text {
                        text: string_at(block, "text").unwrap_or_default(),
                        delta: false,
                    },
                });
            }
            Some("tool_use") => {
                return Some(ParsedEvent {
                    session_id,
                    event: StructuredCliEventKind::ToolUse {
                        id: string_at(block, "id").unwrap_or_default(),
                        name: string_at(block, "name").unwrap_or_default(),
                        input: block.get("input").cloned().unwrap_or(Value::Null),
                    },
                });
            }
            _ => {}
        }
    }
    None
}

/// `agy --output-format json` prints exactly one object per turn:
/// `{"conversation_id","status","response","error"?,"usage":{...}}`.
/// The single line therefore expands into a Text event (the full response)
/// followed by a Result event carrying success and usage.
fn parse_antigravity_result(value: &Value) -> Vec<ParsedEvent> {
    let Some(status) = value.get("status").and_then(Value::as_str) else {
        return Vec::new();
    };
    if value.get("conversation_id").is_none() && value.get("response").is_none() {
        return Vec::new();
    }
    let session_id = string_at(value, "conversation_id").filter(|id| !id.is_empty());
    let mut events = Vec::new();
    if let Some(response) = string_at(value, "response").filter(|text| !text.is_empty()) {
        events.push(ParsedEvent {
            session_id: session_id.clone(),
            event: StructuredCliEventKind::Text {
                text: response,
                delta: false,
            },
        });
    }
    events.push(ParsedEvent {
        session_id,
        event: StructuredCliEventKind::Result {
            success: status.eq_ignore_ascii_case("success"),
            message: string_at(value, "error")
                .filter(|text| !text.is_empty())
                .map(|text| redact_and_bound(&text, DIAGNOSTIC_LIMIT).0),
            usage: parse_usage(value.get("usage")),
        },
    });
    events
}

fn parse_usage(value: Option<&Value>) -> StructuredUsage {
    StructuredUsage {
        input_tokens: u64_at(value, "input_tokens"),
        cached_input_tokens: u64_at(value, "cache_read_input_tokens"),
        cache_creation_input_tokens: u64_at(value, "cache_creation_input_tokens"),
        output_tokens: u64_at(value, "output_tokens"),
        reasoning_output_tokens: u64_at(value, "thinking_tokens"),
        total_tokens: u64_at(value, "total_tokens"),
        cost_micro_usd: None,
    }
}

/// Converts Claude's fractional-dollar `total_cost_usd` into micro-USD,
/// rejecting non-finite or negative values a malformed line could carry.
fn micro_usd_at(value: &Value, key: &str) -> Option<u64> {
    let dollars = value.get(key)?.as_f64()?;
    (dollars.is_finite() && dollars >= 0.0).then(|| (dollars * 1_000_000.0).round() as u64)
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}
fn u64_at(value: Option<&Value>, key: &str) -> Option<u64> {
    value
        .and_then(|value| value.get(key))
        .and_then(Value::as_u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_arguments_keep_prompts_off_the_command_line() {
        for provider in [
            StructuredCliProvider::Claude,
            StructuredCliProvider::Antigravity,
        ] {
            let args = provider_args(&StructuredCliLaunchOptions {
                provider,
                executable: "agent".into(),
                working_directory: ".".into(),
                model: None,
                effort: Some("high".into()),
                resume_session_id: Some("session-1".into()),
                permission_mode: StructuredPermissionMode::ReadOnly,
                mcp_config_path: None,
            });
            assert!(!args.iter().any(|arg| arg.contains("secret prompt")));
            let has_effort = args
                .windows(2)
                .any(|w| w[0] == "--effort" && w[1] == "high");
            assert_eq!(has_effort, provider == StructuredCliProvider::Claude);
            match provider {
                StructuredCliProvider::Claude => {
                    assert!(args.iter().any(|arg| arg == "stream-json"));
                    assert!(
                        args.windows(2)
                            .any(|w| w[0] == "--resume" && w[1] == "session-1")
                    );
                }
                StructuredCliProvider::Antigravity => {
                    assert!(
                        args.windows(2)
                            .any(|w| w[0] == "--output-format" && w[1] == "json")
                    );
                    assert!(args.windows(2).any(|w| w[0] == "--mode" && w[1] == "plan"));
                    assert!(
                        args.windows(2)
                            .any(|w| w[0] == "--conversation" && w[1] == "session-1")
                    );
                    // Print mode is activated by piped stdin; `-p` would stop
                    // agy from reading the prompt off stdin.
                    assert!(!args.iter().any(|arg| arg == "-p" || arg == "--print"));
                }
            }
            assert!(!args.iter().any(|arg| arg == "yolo"
                || arg == "bypassPermissions"
                || arg == "--dangerously-skip-permissions"));
        }
    }

    #[test]
    fn prompt_mode_wires_the_stdio_permission_channel_for_claude() {
        let options = |mode| StructuredCliLaunchOptions {
            provider: StructuredCliProvider::Claude,
            executable: "claude".into(),
            working_directory: ".".into(),
            model: None,
            effort: None,
            resume_session_id: None,
            permission_mode: mode,
            mcp_config_path: None,
        };
        for mode in [
            StructuredPermissionMode::Prompt,
            StructuredPermissionMode::ReadOnly,
            StructuredPermissionMode::AcceptEdits,
        ] {
            let args = provider_args(&options(mode));
            assert!(
                args.windows(2)
                    .any(|w| w[0] == "--input-format" && w[1] == "stream-json")
            );
            assert!(
                args.windows(2)
                    .any(|w| w[0] == "--permission-prompt-tool" && w[1] == "stdio")
            );
        }
        let args = provider_args(&options(StructuredPermissionMode::Prompt));
        assert!(
            args.windows(2)
                .any(|w| w[0] == "--permission-mode" && w[1] == "manual")
        );
    }

    #[test]
    fn mcp_config_injects_broker_flags_for_claude_only() {
        let options = |provider| StructuredCliLaunchOptions {
            provider,
            executable: "agent".into(),
            working_directory: ".".into(),
            model: None,
            effort: None,
            resume_session_id: None,
            permission_mode: StructuredPermissionMode::AcceptEdits,
            mcp_config_path: Some("C:/data/broker-mcp/orchestrator-task.json".into()),
        };
        let claude = provider_args(&options(StructuredCliProvider::Claude));
        assert!(claude.windows(2).any(|w| w[0] == "--mcp-config"));
        assert!(
            claude
                .windows(2)
                .any(|w| w[0] == "--allowed-tools" && w[1] == "mcp__integrator")
        );
        let agy = provider_args(&options(StructuredCliProvider::Antigravity));
        assert!(!agy.iter().any(|arg| arg == "--mcp-config"));
    }

    #[test]
    fn full_access_maps_to_each_providers_bypass_flag() {
        let options = |provider| StructuredCliLaunchOptions {
            provider,
            executable: "agent".into(),
            working_directory: ".".into(),
            model: None,
            effort: None,
            resume_session_id: None,
            permission_mode: StructuredPermissionMode::BypassPermissions,
            mcp_config_path: None,
        };
        let claude = provider_args(&options(StructuredCliProvider::Claude));
        assert!(
            claude
                .windows(2)
                .any(|w| w[0] == "--permission-mode" && w[1] == "bypassPermissions")
        );
        // Bypass mode never prompts, so no control channel is requested.
        assert!(!claude.iter().any(|arg| arg == "--permission-prompt-tool"));
        let agy = provider_args(&options(StructuredCliProvider::Antigravity));
        assert!(
            agy.iter()
                .any(|arg| arg == "--dangerously-skip-permissions")
        );
    }

    #[test]
    fn parses_claude_can_use_tool_control_request() {
        let line = r#"{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"curl -s https://example.com"},"description":"Fetch example.com","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"curl -s https://example.com"}],"behavior":"allow","destination":"localSettings"}],"tool_use_id":"toolu_1"}}"#;
        let events = parse_provider_line(StructuredCliProvider::Claude, line);
        assert_eq!(events.len(), 1);
        let StructuredCliEventKind::PermissionRequest {
            request_id,
            tool_use_id,
            tool_name,
            input,
            description,
            suggestions,
        } = &events[0].event
        else {
            panic!("expected permission request, got {:?}", events[0].event);
        };
        assert_eq!(request_id, "req-1");
        assert_eq!(tool_use_id, "toolu_1");
        assert_eq!(tool_name, "Bash");
        assert_eq!(
            input.pointer("/command").and_then(Value::as_str),
            Some("curl -s https://example.com")
        );
        assert_eq!(description.as_deref(), Some("Fetch example.com"));
        assert!(suggestions.is_array());
        // The initialize acknowledgement must not leak into the event stream.
        let ack = r#"{"type":"control_response","response":{"subtype":"success","request_id":"integrator-init","response":{}}}"#;
        assert!(parse_provider_line(StructuredCliProvider::Claude, ack).is_empty());
    }

    #[test]
    fn parses_claude_permission_mode_status() {
        // Observed live: the CLI reports mode transitions (e.g. after an
        // approved ExitPlanMode) as system/status with a permissionMode.
        let line = r#"{"type":"system","subtype":"status","status":null,"permissionMode":"acceptEdits","session_id":"sess-1"}"#;
        let events = parse_provider_line(StructuredCliProvider::Claude, line);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id.as_deref(), Some("sess-1"));
        assert!(matches!(
            &events[0].event,
            StructuredCliEventKind::PermissionModeChanged { mode } if mode == "acceptEdits"
        ));
        // A status without a permission mode carries nothing to project.
        let bare = r#"{"type":"system","subtype":"status","status":"compacting"}"#;
        assert!(parse_provider_line(StructuredCliProvider::Claude, bare).is_empty());
    }

    #[test]
    fn parses_claude_exit_plan_mode_permission_request_with_plan() {
        // Observed live: ExitPlanMode arrives as can_use_tool with the full
        // plan markdown in the tool input.
        let line = r##"{"type":"control_request","request_id":"req-2","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","display_name":"ExitPlanMode","input":{"plan":"# Plan\n\nAdd power(a, b).","planFilePath":"C:\\plans\\p.md"},"tool_use_id":"toolu_2","requires_user_interaction":true}}"##;
        let events = parse_provider_line(StructuredCliProvider::Claude, line);
        assert_eq!(events.len(), 1);
        let StructuredCliEventKind::PermissionRequest {
            tool_name, input, ..
        } = &events[0].event
        else {
            panic!("expected permission request, got {:?}", events[0].event);
        };
        assert_eq!(tool_name, "ExitPlanMode");
        assert_eq!(
            input.pointer("/plan").and_then(Value::as_str),
            Some("# Plan\n\nAdd power(a, b).")
        );
    }

    #[test]
    fn parses_claude_happy_and_auth_failure_fixtures() {
        let happy = include_str!("../fixtures/claude-stream-happy.jsonl");
        let events: Vec<_> = happy
            .lines()
            .flat_map(|line| parse_provider_line(StructuredCliProvider::Claude, line))
            .collect();
        assert!(matches!(
            events[0].event,
            StructuredCliEventKind::Init { .. }
        ));
        assert!(events.iter().any(
            |item| matches!(&item.event, StructuredCliEventKind::Text { text, .. } if text == "OK")
        ));
        assert!(events.iter().any(|item| matches!(
            &item.event,
            StructuredCliEventKind::Result { success: true, usage, .. }
                if usage.input_tokens == Some(4)
                    && usage.cached_input_tokens == Some(2)
                    && usage.cache_creation_input_tokens == Some(3)
                    && usage.output_tokens == Some(1)
                    && usage.cost_micro_usd == Some(12_500)
        )));
        let failure = include_str!("../fixtures/claude-stream-auth-failure.jsonl");
        let event = failure
            .lines()
            .flat_map(|line| parse_provider_line(StructuredCliProvider::Claude, line))
            .next()
            .expect("result");
        assert!(matches!(
            event.event,
            StructuredCliEventKind::Result { success: false, .. }
        ));
    }

    #[test]
    fn antigravity_effort_composes_into_the_model_name() {
        let options = |model: Option<&str>, effort: Option<&str>| StructuredCliLaunchOptions {
            provider: StructuredCliProvider::Antigravity,
            executable: "agy".into(),
            working_directory: ".".into(),
            model: model.map(str::to_owned),
            effort: effort.map(str::to_owned),
            resume_session_id: None,
            permission_mode: StructuredPermissionMode::Prompt,
            mcp_config_path: None,
        };
        let model_arg = |args: Vec<String>| {
            args.windows(2)
                .find(|w| w[0] == "--model")
                .map(|w| w[1].clone())
        };
        assert_eq!(
            model_arg(provider_args(&options(
                Some("Gemini 3.1 Pro"),
                Some("high")
            ))),
            Some("Gemini 3.1 Pro (High)".into())
        );
        assert_eq!(
            model_arg(provider_args(&options(Some("Gemini 3.1 Pro"), None))),
            Some("Gemini 3.1 Pro".into())
        );
        // Unknown effort ids must not mutate the model string.
        assert_eq!(
            model_arg(provider_args(&options(
                Some("Gemini 3.1 Pro"),
                Some("xhigh")
            ))),
            Some("Gemini 3.1 Pro".into())
        );
        // No model selected: nothing to compose, no --model at all.
        assert_eq!(model_arg(provider_args(&options(None, Some("high")))), None);
    }

    #[test]
    fn parses_antigravity_result_line() {
        // Captured verbatim from `agy --output-format json` 1.1.1.
        let line = r#"{"conversation_id":"38a63c25-14b7-486a-8806-187275193d79","status":"SUCCESS","response":"OK\n","duration_seconds":1.4183724,"num_turns":1,"usage":{"input_tokens":24727,"output_tokens":93,"thinking_tokens":87,"total_tokens":24820}}"#;
        let events = parse_provider_line(StructuredCliProvider::Antigravity, line);
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0].session_id.as_deref(),
            Some("38a63c25-14b7-486a-8806-187275193d79")
        );
        assert!(matches!(
            &events[0].event,
            StructuredCliEventKind::Text { text, delta: false } if text == "OK\n"
        ));
        assert!(matches!(
            &events[1].event,
            StructuredCliEventKind::Result { success: true, message: None, usage }
                if usage.input_tokens == Some(24727)
                    && usage.output_tokens == Some(93)
                    && usage.reasoning_output_tokens == Some(87)
                    && usage.total_tokens == Some(24820)
                    && usage.cost_micro_usd.is_none()
        ));
    }

    #[test]
    fn parses_antigravity_error_line() {
        let line = r#"{"conversation_id":"","status":"ERROR","response":"","error":"Error: empty prompt. Usage: agy --print \"your prompt here\"","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"total_tokens":0}}"#;
        let events = parse_provider_line(StructuredCliProvider::Antigravity, line);
        assert_eq!(events.len(), 1);
        assert!(events[0].session_id.is_none());
        assert!(matches!(
            &events[0].event,
            StructuredCliEventKind::Result {
                success: false,
                message: Some(_),
                ..
            }
        ));
    }
}
