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

// Sized for fast token-delta bursts: the consumer persists each event, so a
// small ring converts brief persistence stalls into dropped stream chunks.
const EVENT_CAPACITY: usize = 2048;
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
    /// Durable AI Integrator policy carried in the provider's native system
    /// instruction layer. Claude receives this through
    /// `--append-system-prompt`; Antigravity loads it from the private control
    /// overlay instead.
    pub system_instructions: Option<String>,
    pub resume_session_id: Option<String>,
    pub permission_mode: StructuredPermissionMode,
    /// MCP config file granting this session the delegation-broker tool
    /// surface. Claude-only in v1: the flag pair is not portable, so other
    /// providers ignore it.
    pub mcp_config_path: Option<PathBuf>,
    /// Integrator-owned Antigravity customization root. The directory may
    /// contain `.agents/hooks.json` and `.agents/mcp_config.json`, but is
    /// never written into the user's repository. Other providers ignore it.
    pub control_overlay: Option<PathBuf>,
    /// Integrator-owned plugin bundles projected into this turn, one
    /// `--plugin-dir` each. Claude-only: the flag is not portable, so other
    /// providers ignore it. Overlays live in app-data, never the repository.
    pub plugin_dirs: Vec<PathBuf>,
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
    /// An official provider hook blocked the action before execution.
    ToolDenied {
        id: String,
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

    /// Publishes a typed event observed through a provider-owned lifecycle
    /// hook. The desktop host uses this for Agy because its print JSON is
    /// final-only; arbitrary hook payloads never cross this boundary.
    pub fn emit_host_event(
        &self,
        turn_id: &str,
        session_id: Option<String>,
        event: StructuredCliEventKind,
    ) {
        let _ = self.events.send(StructuredCliEvent {
            turn_id: turn_id.to_owned(),
            session_id,
            event,
        });
    }

    /// Starts one structured CLI turn. Prompt content is written over stdin and
    /// is never included in the child process command line.
    pub async fn start_turn(
        &self,
        options: StructuredCliLaunchOptions,
        prompt: String,
    ) -> Result<String> {
        self.start_turn_with_images(options, prompt, Vec::new())
            .await
    }

    /// Same as [`Self::start_turn`], reattaching local images for handoff.
    /// Claude receives multimodal content blocks; Antigravity gets explicit
    /// path references in the prompt text.
    pub async fn start_turn_with_images(
        &self,
        options: StructuredCliLaunchOptions,
        prompt: String,
        image_paths: Vec<PathBuf>,
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
                image_paths,
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
            for plugin_dir in &options.plugin_dirs {
                args.extend([
                    "--plugin-dir".into(),
                    plugin_dir.to_string_lossy().into_owned(),
                ]);
            }
            if let Some(instructions) = options
                .system_instructions
                .as_deref()
                .filter(|instructions| !instructions.is_empty())
            {
                args.extend(["--append-system-prompt".into(), instructions.into()]);
            }
            args
        }
        // The prompt reaches `agy` over piped stdin (print mode activates on
        // non-TTY stdin without `-p`), keeping prompt text off the command
        // line. `--mode` accepts only `plan` and `accept-edits`; the default
        // request-review mode is agy's own prompt-for-approval behavior.
        StructuredCliProvider::Antigravity => {
            let mut args = vec!["--output-format".into(), "json".into()];
            // Every first turn receives an exact project instead of falling
            // into agy's empty default project. Resumed turns use
            // `--conversation` below and retain the original project.
            if options.resume_session_id.is_none() {
                args.push("--new-project".into());
            }
            args.push("--sandbox".into());
            if let Some(overlay) = options.control_overlay.as_deref() {
                args.extend(["--add-dir".into(), overlay.to_string_lossy().into_owned()]);
            }
            // Projected skill bundles: readable inside the sandbox so the
            // skill index injected into the prompt can be followed.
            for plugin_dir in &options.plugin_dirs {
                args.extend([
                    "--add-dir".into(),
                    plugin_dir.to_string_lossy().into_owned(),
                ]);
            }
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
    if matches!(options.provider, StructuredCliProvider::Claude)
        && let Some(effort) = options
            .effort
            .as_deref()
            .filter(|value| CLAUDE_EFFORT_LEVELS.contains(value))
    {
        args.extend(["--effort".into(), effort.into()]);
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
    if matches!(options.provider, StructuredCliProvider::Claude)
        && let Some(mcp_config) = options.mcp_config_path.as_deref()
    {
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
    args
}

fn spawn_structured_child(options: &StructuredCliLaunchOptions) -> Result<Child> {
    let args = provider_args(options);
    let mut command = platform_command(&options.executable, &args);
    suppress_windows_console(&mut command);
    command
        .current_dir(&options.working_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if matches!(options.provider, StructuredCliProvider::Antigravity) {
        // Agy must stay on its subscription/keyring path. Remove selector
        // names without reading or logging their values.
        for name in [
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "GOOGLE_GENAI_USE_VERTEXAI",
            "GOOGLE_APPLICATION_CREDENTIALS",
        ] {
            command.env_remove(name);
        }
        // Documented switch: skips the background updater/lock-file check on
        // every spawn. These processes are per-turn, so the check otherwise
        // taxes every message; updates stay owned by the runtime-setup flow.
        command.env("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    }
    if matches!(options.provider, StructuredCliProvider::Claude) {
        // Turn-start latency hygiene: every turn boots a fresh CLI, so
        // update checks and other non-essential network calls tax every
        // message. CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is the
        // documented umbrella switch; DISABLE_AUTOUPDATER is the
        // long-standing updater-specific name kept for older CLIs.
        command.env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
        command.env("DISABLE_AUTOUPDATER", "1");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    command.spawn().map_err(IntegratorError::from)
}

fn suppress_windows_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    let _ = command;
}

const STRUCTURED_IMAGE_MAX_BYTES: u64 = 12 * 1024 * 1024;

fn structured_image_mime(path: &std::path::Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())?
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

fn claude_user_content(prompt: &str, image_paths: &[PathBuf]) -> Value {
    if image_paths.is_empty() {
        return Value::String(prompt.to_owned());
    }
    let mut blocks = vec![serde_json::json!({
        "type": "text",
        "text": prompt,
    })];
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    for path in image_paths {
        let Some(mime) = structured_image_mime(path) else {
            continue;
        };
        let Ok(metadata) = std::fs::metadata(path) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > STRUCTURED_IMAGE_MAX_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        blocks.push(serde_json::json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": mime,
                "data": STANDARD.encode(bytes),
            }
        }));
    }
    Value::Array(blocks)
}

fn antigravity_prompt_with_images(prompt: &str, image_paths: &[PathBuf]) -> String {
    if image_paths.is_empty() {
        return prompt.to_owned();
    }
    let mut lines = vec![
        prompt.to_owned(),
        String::new(),
        "Prior turn images still on disk (open these paths if you need the visual context):".into(),
    ];
    for path in image_paths {
        if path.is_file() {
            lines.push(format!("- {}", path.display()));
        }
    }
    lines.join("\n")
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
    image_paths: Vec<PathBuf>,
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
                let content = claude_user_content(&prompt, &image_paths);
                let user = serde_json::json!({
                    "type": "user",
                    "message": { "role": "user", "content": content },
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
                let prompt = antigravity_prompt_with_images(&prompt, &image_paths);
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
    let mut line = Vec::new();
    let mut session_id = None;
    let mut cancelled = false;
    let mut saw_text_delta = false;
    while let Some(reader) = stdout.as_mut() {
        line.clear();
        tokio::select! {
            // read_until + lossy conversion instead of read_line: read_line
            // fails the whole loop on a single invalid-UTF-8 byte (killing
            // the stream while the child keeps running), whereas invalid
            // bytes here degrade to U+FFFD inside one line at worst.
            read = reader.read_until(b'\n', &mut line) => match read {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&line);
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
    if !cancelled
        && status.as_ref().is_some_and(|status| !status.success())
        && let Some(task) = stderr_task
        && let Ok(diagnostic) = task.await
        && !diagnostic.trim().is_empty()
    {
        let message = redact_and_bound(diagnostic.trim(), DIAGNOSTIC_LIMIT).0;
        let _ = events.send(StructuredCliEvent {
            turn_id: turn_id.clone(),
            session_id: session_id.clone(),
            event: StructuredCliEventKind::Diagnostic { message },
        });
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
    while let Ok(count) = stderr.read(&mut buffer).await {
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
        let mut command = Command::new("taskkill");
        suppress_windows_console(&mut command);
        let _ = command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let process_group = format!("-{pid}");
        let _ = Command::new("/bin/kill")
            .args(["-TERM", "--", &process_group])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
        if child.try_wait().ok().flatten().is_none() {
            let _ = Command::new("/bin/kill")
                .args(["-KILL", "--", &process_group])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
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
        StructuredCliProvider::Claude => parse_claude_event(&value),
        StructuredCliProvider::Antigravity => parse_antigravity_result(&value),
    }
}

fn parse_claude_event(value: &Value) -> Vec<ParsedEvent> {
    let session_id = string_at(value, "session_id");
    let Some(event_type) = value.get("type").and_then(Value::as_str) else {
        return Vec::new();
    };
    let event = match event_type {
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
            let Some(mode) = string_at(value, "permissionMode") else {
                return Vec::new();
            };
            Some(ParsedEvent {
                session_id,
                event: StructuredCliEventKind::PermissionModeChanged { mode },
            })
        }
        // Claude emits api_retry while backing off a failed or rate-limited
        // API call. Without surfacing it the stream simply goes silent for
        // the whole backoff window and reads as a frozen turn.
        "system" if value.get("subtype").and_then(Value::as_str) == Some("api_retry") => {
            let mut message = String::from("Provider is retrying the request");
            if let (Some(attempt), Some(max_attempts)) = (
                value.get("attempt").and_then(Value::as_u64),
                value.get("max_attempts").and_then(Value::as_u64),
            ) {
                message.push_str(&format!(" (attempt {attempt} of {max_attempts})"));
            }
            if let Some(detail) = string_at(value, "error").or_else(|| string_at(value, "message"))
            {
                message.push_str(": ");
                message.push_str(&redact_and_bound(&detail, DIAGNOSTIC_LIMIT).0);
            }
            Some(ParsedEvent {
                session_id,
                event: StructuredCliEventKind::Diagnostic { message },
            })
        }
        "stream_event" => {
            let Some(event) = value.get("event") else {
                return Vec::new();
            };
            if event.get("type").and_then(Value::as_str) != Some("content_block_delta") {
                return Vec::new();
            }
            let Some(delta) = event.get("delta") else {
                return Vec::new();
            };
            if delta.get("type").and_then(Value::as_str) != Some("text_delta") {
                return Vec::new();
            }
            Some(ParsedEvent {
                session_id,
                event: StructuredCliEventKind::Text {
                    text: string_at(delta, "text").unwrap_or_default(),
                    delta: true,
                },
            })
        }
        "assistant" => return parse_claude_assistant(value, session_id),
        "user" => return parse_claude_tool_results(value, session_id),
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
    };
    event.into_iter().collect()
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

fn parse_claude_assistant(value: &Value, session_id: Option<String>) -> Vec<ParsedEvent> {
    let Some(content) = value.pointer("/message/content").and_then(Value::as_array) else {
        return Vec::new();
    };
    content
        .iter()
        .filter_map(|block| match block.get("type").and_then(Value::as_str) {
            Some("text") => Some(ParsedEvent {
                session_id: session_id.clone(),
                event: StructuredCliEventKind::Text {
                    text: string_at(block, "text").unwrap_or_default(),
                    delta: false,
                },
            }),
            Some("tool_use") => Some(ParsedEvent {
                session_id: session_id.clone(),
                event: StructuredCliEventKind::ToolUse {
                    id: string_at(block, "id").unwrap_or_default(),
                    name: string_at(block, "name").unwrap_or_default(),
                    input: block.get("input").cloned().unwrap_or(Value::Null),
                },
            }),
            _ => None,
        })
        .collect()
}

fn parse_claude_tool_results(value: &Value, session_id: Option<String>) -> Vec<ParsedEvent> {
    let Some(content) = value.pointer("/message/content").and_then(Value::as_array) else {
        return Vec::new();
    };
    content
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
        .map(|block| ParsedEvent {
            session_id: session_id.clone(),
            event: StructuredCliEventKind::ToolResult {
                id: string_at(block, "tool_use_id").unwrap_or_default(),
                is_error: block
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                content: claude_tool_result_content(block.get("content")),
            },
        })
        .collect()
}

fn claude_tool_result_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| match block {
                Value::String(text) => Some(text.clone()),
                Value::Object(_) => block
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| serde_json::to_string(block).ok()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::Object(_)) => content
            .and_then(|value| value.get("text"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| content.and_then(|value| serde_json::to_string(value).ok()))
            .unwrap_or_default(),
        _ => String::new(),
    }
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
                system_instructions: None,
                resume_session_id: Some("session-1".into()),
                permission_mode: StructuredPermissionMode::ReadOnly,
                mcp_config_path: None,
                control_overlay: None,
                plugin_dirs: Vec::new(),
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
    fn claude_harness_policy_uses_the_native_system_prompt_layer() {
        let options = |provider| StructuredCliLaunchOptions {
            provider,
            executable: "agent".into(),
            working_directory: ".".into(),
            model: None,
            effort: None,
            system_instructions: Some("durable harness policy".into()),
            resume_session_id: None,
            permission_mode: StructuredPermissionMode::ReadOnly,
            mcp_config_path: None,
            control_overlay: None,
            plugin_dirs: Vec::new(),
        };
        let claude = provider_args(&options(StructuredCliProvider::Claude));
        assert!(claude.windows(2).any(|pair| {
            pair[0] == "--append-system-prompt" && pair[1] == "durable harness policy"
        }));
        let antigravity = provider_args(&options(StructuredCliProvider::Antigravity));
        assert!(
            !antigravity
                .iter()
                .any(|argument| argument == "--append-system-prompt")
        );
    }

    #[test]
    fn plugin_dirs_project_per_provider_mechanism() {
        for provider in [
            StructuredCliProvider::Claude,
            StructuredCliProvider::Antigravity,
        ] {
            let args = provider_args(&StructuredCliLaunchOptions {
                provider,
                executable: "agent".into(),
                working_directory: ".".into(),
                model: None,
                effort: None,
                system_instructions: None,
                resume_session_id: None,
                permission_mode: StructuredPermissionMode::AcceptEdits,
                mcp_config_path: None,
                control_overlay: None,
                plugin_dirs: vec!["/private/tmp/overlay/gov-data".into()],
            });
            let has_plugin_dir = args
                .windows(2)
                .any(|w| w[0] == "--plugin-dir" && w[1] == "/private/tmp/overlay/gov-data");
            let has_add_dir = args
                .windows(2)
                .any(|w| w[0] == "--add-dir" && w[1] == "/private/tmp/overlay/gov-data");
            // Claude loads bundles natively; Antigravity gets sandbox read
            // access and follows the prompt-injected index instead.
            assert_eq!(has_plugin_dir, provider == StructuredCliProvider::Claude);
            assert_eq!(has_add_dir, provider == StructuredCliProvider::Antigravity);
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
            system_instructions: None,
            resume_session_id: None,
            permission_mode: mode,
            mcp_config_path: None,
            control_overlay: None,
            plugin_dirs: Vec::new(),
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
            system_instructions: None,
            resume_session_id: None,
            permission_mode: StructuredPermissionMode::AcceptEdits,
            mcp_config_path: Some("C:/data/broker-mcp/orchestrator-task.json".into()),
            control_overlay: None,
            plugin_dirs: Vec::new(),
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
            system_instructions: None,
            resume_session_id: None,
            permission_mode: StructuredPermissionMode::BypassPermissions,
            mcp_config_path: None,
            control_overlay: None,
            plugin_dirs: Vec::new(),
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
        let retry = r#"{"type":"system","subtype":"api_retry","attempt":2,"max_attempts":10,"error":"overloaded_error","session_id":"sess-1"}"#;
        let events = parse_provider_line(StructuredCliProvider::Claude, retry);
        assert_eq!(events.len(), 1);
        match &events[0].event {
            StructuredCliEventKind::Diagnostic { message } => {
                assert!(message.contains("attempt 2 of 10"), "got: {message}");
                assert!(message.contains("overloaded_error"), "got: {message}");
            }
            other => panic!("expected Diagnostic, got {other:?}"),
        }

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
    fn parses_every_claude_tool_result_block() {
        let line = r#"{"type":"user","session_id":"sess-1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"read output"},{"type":"tool_result","tool_use_id":"tool-2","content":[{"type":"text","text":"exit 7"}],"is_error":true}]}}"#;
        let events = parse_provider_line(StructuredCliProvider::Claude, line);
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            ParsedEvent {
                session_id: Some(session_id),
                event: StructuredCliEventKind::ToolResult { id, is_error: false, content }
            } if session_id == "sess-1" && id == "tool-1" && content == "read output"
        ));
        assert!(matches!(
            &events[1].event,
            StructuredCliEventKind::ToolResult { id, is_error: true, content }
                if id == "tool-2" && content == "exit 7"
        ));
    }

    #[test]
    fn parses_all_displayable_claude_assistant_blocks_and_ignores_thinking() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hidden"},{"type":"text","text":"Checking."},{"type":"tool_use","id":"tool-1","name":"Read","input":{"file_path":"alpha.txt"}}]}}"#;
        let events = parse_provider_line(StructuredCliProvider::Claude, line);
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0].event,
            StructuredCliEventKind::Text { text, delta: false } if text == "Checking."
        ));
        assert!(matches!(
            &events[1].event,
            StructuredCliEventKind::ToolUse { id, name, .. }
                if id == "tool-1" && name == "Read"
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
            system_instructions: None,
            resume_session_id: None,
            permission_mode: StructuredPermissionMode::Prompt,
            mcp_config_path: None,
            control_overlay: None,
            plugin_dirs: Vec::new(),
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
        // The isolated helper path (chat titles, commit messages) pins "low".
        assert_eq!(
            model_arg(provider_args(&options(
                Some("Gemini 3.5 Flash"),
                Some("low")
            ))),
            Some("Gemini 3.5 Flash (Low)".into())
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
    fn antigravity_launches_an_exact_sandboxed_project_and_preserves_it_on_resume() {
        let options = |resume_session_id: Option<&str>| StructuredCliLaunchOptions {
            provider: StructuredCliProvider::Antigravity,
            executable: "agy".into(),
            working_directory: "/workspace/project".into(),
            model: None,
            effort: None,
            system_instructions: None,
            resume_session_id: resume_session_id.map(str::to_owned),
            permission_mode: StructuredPermissionMode::ReadOnly,
            mcp_config_path: None,
            control_overlay: Some("/private/tmp/integrator-overlay".into()),
            plugin_dirs: Vec::new(),
        };

        let first = provider_args(&options(None));
        assert!(first.iter().any(|arg| arg == "--new-project"));
        assert!(first.iter().any(|arg| arg == "--sandbox"));
        assert!(first.windows(2).any(|args| {
            args[0] == "--add-dir" && args[1] == "/private/tmp/integrator-overlay"
        }));
        assert!(!first.iter().any(|arg| arg == "--conversation"));

        let resumed = provider_args(&options(Some("conversation-1")));
        assert!(!resumed.iter().any(|arg| arg == "--new-project"));
        assert!(resumed.iter().any(|arg| arg == "--sandbox"));
        assert!(
            resumed
                .windows(2)
                .any(|args| { args[0] == "--conversation" && args[1] == "conversation-1" })
        );
        assert!(resumed.windows(2).any(|args| {
            args[0] == "--add-dir" && args[1] == "/private/tmp/integrator-overlay"
        }));
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

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_terminates_structured_provider_descendants() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("provider fixture");
        let executable = directory.path().join("fixture-agent.sh");
        std::fs::write(
            &executable,
            "#!/bin/sh\nsleep 30 &\necho $! > child.pid\nwait\n",
        )
        .expect("write provider fixture");
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700))
            .expect("make provider fixture executable");

        let client = StructuredCliClient::new();
        let mut receiver = client.subscribe();
        let turn_id = client
            .start_turn(
                StructuredCliLaunchOptions {
                    provider: StructuredCliProvider::Claude,
                    executable,
                    working_directory: directory.path().into(),
                    model: None,
                    effort: None,
                    system_instructions: None,
                    resume_session_id: None,
                    permission_mode: StructuredPermissionMode::ReadOnly,
                    mcp_config_path: None,
                    control_overlay: None,
                    plugin_dirs: Vec::new(),
                },
                "start fixture".into(),
            )
            .await
            .expect("start provider fixture");
        let pid_path = directory.path().join("child.pid");
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !pid_path.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("descendant pid");
        let descendant = std::fs::read_to_string(&pid_path)
            .expect("read descendant pid")
            .trim()
            .to_owned();

        assert!(client.cancel(&turn_id).await.expect("cancel provider"));
        tokio::time::timeout(std::time::Duration::from_secs(4), async {
            loop {
                let event = receiver.recv().await.expect("provider event");
                if matches!(
                    event.event,
                    StructuredCliEventKind::Exited {
                        cancelled: true,
                        ..
                    }
                ) {
                    break;
                }
            }
        })
        .await
        .expect("cancelled exit");

        let still_alive = Command::new("/bin/kill")
            .args(["-0", &descendant])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|status| status.success());
        assert!(
            !still_alive,
            "structured provider descendant survived cancellation"
        );
    }
}
