use std::{path::PathBuf, process::Stdio, sync::Arc};

use integrator_core::{IntegratorError, Result};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{Mutex, broadcast, oneshot},
};

use crate::redact_and_bound;

use super::{
    DIAGNOSTIC_LIMIT, StructuredCliEvent, StructuredCliEventKind, StructuredCliLaunchOptions,
    StructuredCliProvider, StructuredPermissionMode,
    launch::{
        CLAUDE_CHAT_ISOLATION_ENV, antigravity_prompt_with_images, claude_user_content,
        provider_args,
    },
    parse::parse_provider_line,
};

pub(super) fn spawn_structured_child(options: &StructuredCliLaunchOptions) -> Result<Child> {
    let args = provider_args(options);
    let mut command = platform_command(&options.executable, &args);
    suppress_windows_console(&mut command);
    command
        .current_dir(&options.working_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = crate::runtime_search_path() {
        // Native desktop launches on macOS do not inherit ~/.zshrc. Keep
        // wrapper shebangs (`/usr/bin/env node`) on the same PATH discovery used.
        command.env("PATH", path);
    }
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
        // Defer MCP tool schemas out of the system prompt when the toolset is
        // large (names stay listed; definitions load on demand and do not
        // invalidate the prompt cache). "auto" keeps small toolsets upfront
        // and falls back safely on endpoints without tool_reference support.
        // A user-set value always wins.
        if std::env::var_os("ENABLE_TOOL_SEARCH").is_none() {
            command.env("ENABLE_TOOL_SEARCH", "auto");
        }
        if options.permission_mode == StructuredPermissionMode::Chat {
            for (name, value) in CLAUDE_CHAT_ISOLATION_ENV {
                command.env(*name, *value);
            }
        }
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

pub(super) struct ChildTurnContext {
    turn_id: String,
    cancel: oneshot::Receiver<()>,
    events: broadcast::Sender<StructuredCliEvent>,
    stdin_slot: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
}

impl ChildTurnContext {
    pub(super) fn new(
        turn_id: String,
        cancel: oneshot::Receiver<()>,
        events: broadcast::Sender<StructuredCliEvent>,
        stdin_slot: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    ) -> Self {
        Self {
            turn_id,
            cancel,
            events,
            stdin_slot,
        }
    }
}

pub(super) async fn run_child(
    mut child: Child,
    provider: StructuredCliProvider,
    prompt: String,
    image_paths: Vec<PathBuf>,
    context: ChildTurnContext,
) {
    let ChildTurnContext {
        turn_id,
        mut cancel,
        events,
        stdin_slot,
    } = context;
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
