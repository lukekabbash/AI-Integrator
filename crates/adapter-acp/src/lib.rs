//! Agent Client Protocol (ACP) stdio client.
//!
//! Speaks JSON-RPC 2.0 over newline-delimited stdio to an ACP agent such as
//! `cursor-agent acp`. The framing, bounded-message, and request-routing
//! behavior deliberately mirrors `adapter-codex`; the protocol surface is the
//! ACP v1 core: `initialize`, `session/new`, `session/prompt` (long-running,
//! resolves at end of turn), `session/cancel`, streamed `session/update`
//! notifications, and `session/request_permission` server requests.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use integrator_core::{IntegratorError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, broadcast, oneshot},
};

mod process_io;

use process_io::{spawn_stderr_drain, spawn_stdout_reader};

const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
/// Bytes of an oversized frame retained for response-id identification.
const DISCARDED_FRAME_HEAD_BYTES: usize = 8 * 1024;
/// Upper bound on a single stdin frame write. Generous: pipe writes to a
/// live local process complete in milliseconds; only a wedged agent that has
/// stopped draining stdin can hit this.
const STDIN_WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const MAX_REQUEST_ID_BYTES: usize = 512;
const EVENT_CAPACITY: usize = 1024;
pub const ACP_PROTOCOL_VERSION: u64 = 1;

/// Tagged string-or-number JSON-RPC id, preserved byte-for-byte.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum AcpRequestId {
    Number(Number),
    String(String),
}

impl AcpRequestId {
    pub fn from_protocol_value(value: &Value) -> Result<Self> {
        let id = match value {
            Value::Number(value) => Self::Number(value.clone()),
            Value::String(value) => Self::String(value.clone()),
            _ => {
                return Err(IntegratorError::InvalidInput(
                    "ACP request id must be a string or number".into(),
                ));
            }
        };
        id.validate()?;
        Ok(id)
    }

    pub fn validate(&self) -> Result<()> {
        if matches!(self, Self::String(value) if value.len() > MAX_REQUEST_ID_BYTES) {
            return Err(IntegratorError::InvalidInput(
                "ACP request id exceeds safety limit".into(),
            ));
        }
        Ok(())
    }

    #[must_use]
    pub fn to_protocol_value(&self) -> Value {
        match self {
            Self::Number(value) => Value::Number(value.clone()),
            Self::String(value) => Value::String(value.clone()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AcpEvent {
    Notification {
        method: String,
        params: Value,
    },
    ServerRequest {
        id: AcpRequestId,
        method: String,
        params: Value,
    },
    ProtocolViolation {
        code: String,
    },
    /// Ordered after every notification emitted by session/load or
    /// session/resume. Consumers use this to leave replay/recovery mode only
    /// after the transport has delivered the provider's full response.
    RecoveryBoundary {
        replayed_history: bool,
    },
    /// Ordered after every `session/update` notification emitted before the
    /// matching `session/prompt` response. Consumers must settle and clear the
    /// active turn from this boundary rather than from the prompt future,
    /// otherwise queued tail chunks can be misattributed or dropped.
    PromptFinished {
        session_id: String,
        outcome: AcpPromptOutcome,
    },
    StderrActivity,
    Exited,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AcpPromptOutcome {
    Response { stop_reason: StopReason },
    Error { message: String },
}

#[derive(Clone, Debug)]
pub struct AcpLaunchOptions {
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    /// Narrow process-local overrides supplied by the native host. Values are
    /// never persisted or included in diagnostics.
    pub environment: Vec<(String, String)>,
    pub working_directory: Option<PathBuf>,
    pub client_version: String,
    /// Grok Build 1.0.3 rejects ACP's `initialized` notification (`Method not
    /// found`). Cursor and Kimi still require it before `session/new`.
    pub skip_initialized_notification: bool,
}

/// The result of a completed `session/prompt` turn.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    Cancelled,
    Unknown,
}

impl StopReason {
    #[must_use]
    pub fn from_protocol(value: &Value) -> Self {
        match value.get("stopReason").and_then(Value::as_str) {
            Some("end_turn") => Self::EndTurn,
            Some("max_tokens") => Self::MaxTokens,
            Some("max_turn_requests") => Self::MaxTurnRequests,
            Some("refusal") => Self::Refusal,
            Some("cancelled") => Self::Cancelled,
            _ => Self::Unknown,
        }
    }
}

#[derive(Clone)]
pub struct AcpClient {
    inner: Arc<Inner>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionCapabilities {
    pub load: bool,
    pub resume: bool,
    pub mcp_http: bool,
    pub mcp_sse: bool,
}

struct Inner {
    child: Mutex<Option<Child>>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, PendingRequest>>>,
    events: broadcast::Sender<AcpEvent>,
    next_id: AtomicU64,
    initialization: Mutex<Value>,
    transport_alive: Arc<AtomicBool>,
}

struct PendingRequest {
    method: String,
    session_id: Option<String>,
    sender: oneshot::Sender<Result<Value>>,
}

impl AcpClient {
    pub async fn spawn(options: AcpLaunchOptions) -> Result<Self> {
        if !options.executable.is_file() {
            return Err(IntegratorError::InvalidInput(
                "ACP agent executable does not exist".into(),
            ));
        }
        if let Some(cwd) = options.working_directory.as_deref()
            && !cwd.is_dir()
        {
            return Err(IntegratorError::InvalidInput(
                "ACP working directory does not exist".into(),
            ));
        }

        let mut command = launch_command(&options.executable, &options.arguments);
        suppress_windows_console(&mut command);
        // Spawn-latency hygiene for vendor CLIs that run update/telemetry
        // preflights on boot (measured >1s of Node startup already; kimi adds
        // a network update check without this). Vendor-specific names are
        // ignored by the other ACP CLIs, so setting them unconditionally is
        // safe and keeps this transport-generic.
        command
            .env("KIMI_CODE_NO_AUTO_UPDATE", "1")
            .env("KIMI_DISABLE_TELEMETRY", "1");
        command.envs(options.environment);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = options.working_directory.as_deref() {
            command.current_dir(cwd);
        }
        let mut child = command.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| IntegratorError::Unavailable("ACP agent stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| IntegratorError::Unavailable("ACP agent stdout unavailable".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| IntegratorError::Unavailable("ACP agent stderr unavailable".into()))?;

        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let transport_alive = Arc::new(AtomicBool::new(true));
        spawn_stdout_reader(
            stdout,
            Arc::clone(&pending),
            events.clone(),
            Arc::clone(&transport_alive),
        );
        spawn_stderr_drain(stderr, events.clone());

        let client = Self {
            inner: Arc::new(Inner {
                child: Mutex::new(Some(child)),
                stdin: Mutex::new(stdin),
                pending,
                events,
                next_id: AtomicU64::new(1),
                initialization: Mutex::new(Value::Null),
                transport_alive,
            }),
        };
        let initialization = client
            .initialize(
                &options.client_version,
                options.skip_initialized_notification,
            )
            .await?;
        *client.inner.initialization.lock().await = initialization;
        Ok(client)
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<AcpEvent> {
        self.inner.events.subscribe()
    }

    /// Native routing uses this before reusing a cached ACP runtime. The
    /// reader clears it before waking failed requests, closing the small gap
    /// between subprocess exit and higher-level event-pump reconciliation.
    #[must_use]
    pub fn is_alive(&self) -> bool {
        self.inner.transport_alive.load(Ordering::Acquire)
    }

    /// Sanitized callers use this only to inspect advertised protocol
    /// capabilities such as auth method ids. It never contains credential
    /// values supplied by Integrator.
    pub async fn initialization(&self) -> Value {
        self.inner.initialization.lock().await.clone()
    }

    pub async fn session_capabilities(&self) -> AcpSessionCapabilities {
        session_capabilities(&self.initialization().await)
    }

    /// Runs ACP's provider-owned authentication handshake. Integrator passes
    /// only a method id the agent advertised (for example, Grok's
    /// `cached_token` or Kimi's `login`) and
    /// never transports API keys or token contents.
    pub async fn authenticate(&self, method_id: &str, headless: bool) -> Result<Value> {
        validate_short_token(method_id, "authentication method id")?;
        self.request(
            "authenticate",
            json!({ "methodId": method_id, "_meta": { "headless": headless } }),
        )
        .await
    }

    /// `mcp_servers` entries follow the ACP `session/new` schema:
    /// `{ name, command, args, env: [{ name, value }] }`. Pass an empty list
    /// for sessions without injected tool surfaces.
    pub async fn new_session(&self, cwd: &Path, mcp_servers: Vec<Value>) -> Result<Value> {
        self.request(
            "session/new",
            json!({ "cwd": cwd.to_string_lossy(), "mcpServers": mcp_servers }),
        )
        .await
    }

    /// Restore an ACP session and replay its history. The capability gate is
    /// mandatory: agents may reject unknown methods or implement only resume.
    pub async fn load_session(
        &self,
        session_id: &str,
        cwd: &Path,
        mcp_servers: Vec<Value>,
    ) -> Result<Value> {
        validate_session_id(session_id)?;
        if !self.session_capabilities().await.load {
            return Err(IntegratorError::Unavailable(
                "ACP agent did not advertise session/load".into(),
            ));
        }
        let response = self
            .request(
                "session/load",
                json!({
                    "sessionId": session_id,
                    "cwd": cwd.to_string_lossy(),
                    "mcpServers": mcp_servers
                }),
            )
            .await?;
        let _ = self.inner.events.send(AcpEvent::RecoveryBoundary {
            replayed_history: true,
        });
        Ok(response)
    }

    /// Reconnect to an ACP session without replaying history. Stable ACP
    /// requires `agentCapabilities.sessionCapabilities.resume`.
    pub async fn resume_session(
        &self,
        session_id: &str,
        cwd: &Path,
        mcp_servers: Vec<Value>,
    ) -> Result<Value> {
        validate_session_id(session_id)?;
        if !self.session_capabilities().await.resume {
            return Err(IntegratorError::Unavailable(
                "ACP agent did not advertise session/resume".into(),
            ));
        }
        let response = self
            .request(
                "session/resume",
                json!({
                    "sessionId": session_id,
                    "cwd": cwd.to_string_lossy(),
                    "mcpServers": mcp_servers
                }),
            )
            .await?;
        let _ = self.inner.events.send(AcpEvent::RecoveryBoundary {
            replayed_history: false,
        });
        Ok(response)
    }

    /// Long-running: the response resolves when the turn finishes. Callers
    /// should await this on a spawned task, not on a UI-facing command.
    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<Value> {
        self.prompt_with_images(session_id, text, &[]).await
    }

    /// Same as [`Self::prompt`], with optional local image paths embedded as
    /// ACP image content blocks (base64 loaded at send time).
    pub async fn prompt_with_images(
        &self,
        session_id: &str,
        text: &str,
        image_paths: &[std::path::PathBuf],
    ) -> Result<Value> {
        validate_session_id(session_id)?;
        let mut prompt = vec![json!({ "type": "text", "text": text })];
        for path in image_paths {
            if let Some(block) = acp_image_block(path) {
                prompt.push(block);
            }
        }
        self.request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": prompt
            }),
        )
        .await
    }

    /// Update a stable ACP session config option, such as the model or its
    /// thought-level parameter.
    pub async fn set_config_option(
        &self,
        session_id: &str,
        config_id: &str,
        value: &str,
    ) -> Result<Value> {
        validate_session_id(session_id)?;
        validate_short_token(config_id, "config option id")?;
        validate_short_token(value, "config option value")?;
        self.request(
            "session/set_config_option",
            json!({ "sessionId": session_id, "configId": config_id, "value": value }),
        )
        .await
    }

    /// Switch the session's mode (e.g. Cursor agent/plan/ask). `mode_id` must
    /// be one of the ids the agent advertised in `session/new`'s `modes`
    /// field; the spec allows this any time, including mid-turn.
    pub async fn set_mode(&self, session_id: &str, mode_id: &str) -> Result<Value> {
        validate_session_id(session_id)?;
        validate_short_token(mode_id, "mode id")?;
        self.request(
            "session/set_mode",
            json!({ "sessionId": session_id, "modeId": mode_id }),
        )
        .await
    }

    /// Cursor extension RPC: the per-account model list with each model's
    /// config options (thought level, context, fast mode). The stable
    /// `session/new` surface only advertises model ids, so this is the only
    /// source for per-model reasoning-effort choices.
    pub async fn list_cursor_models(&self) -> Result<Value> {
        self.request("cursor/list_available_models", json!({}))
            .await
    }

    /// Fire-and-forget cancellation; the in-flight prompt resolves with a
    /// `cancelled` stop reason as the authoritative terminal state.
    pub async fn cancel(&self, session_id: &str) -> Result<()> {
        validate_session_id(session_id)?;
        self.write_message(json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": session_id }
        }))
        .await
    }

    /// Best-effort cleanup for agents that advertise ACP session deletion.
    pub async fn delete_session(&self, session_id: &str) -> Result<Value> {
        validate_session_id(session_id)?;
        self.request("session/delete", json!({ "sessionId": session_id }))
            .await
    }

    pub async fn respond_to_server_request(&self, id: &AcpRequestId, result: Value) -> Result<()> {
        id.validate()?;
        self.write_message(json!({
            "jsonrpc": "2.0",
            "id": id.to_protocol_value(),
            "result": result
        }))
        .await
    }

    pub async fn shutdown(&self) -> Result<()> {
        self.inner.transport_alive.store(false, Ordering::Release);
        let mut child = self.inner.child.lock().await;
        if let Some(mut process) = child.take() {
            process.kill().await?;
            let _ = process.wait().await;
        }
        Ok(())
    }

    async fn initialize(
        &self,
        client_version: &str,
        skip_initialized_notification: bool,
    ) -> Result<Value> {
        let response = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": ACP_PROTOCOL_VERSION,
                    "clientInfo": {
                        "name": "ai-integrator",
                        "title": "AI Integrator",
                        "version": client_version
                    },
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false,
                        // Cursor: without this, sessions run in "variants"
                        // mode — model parameters are baked into bracketed
                        // model ids and `session/set_config_option` rejects
                        // thought-level config ids with -32602.
                        "_meta": { "parameterizedModelPicker": true }
                    }
                }),
            )
            .await?;

        // Stable ACP uses an explicit initialized notification before
        // session/new or any other session request. Grok 1.0.3 does not
        // implement it and logs `Method not found`.
        if !skip_initialized_notification {
            self.write_message(json!({
                "jsonrpc": "2.0",
                "method": "initialized",
                "params": {}
            }))
            .await?;
        }

        Ok(response)
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        let session_id = (method == "session/prompt")
            .then(|| {
                params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .flatten();
        self.inner.pending.lock().await.insert(
            id,
            PendingRequest {
                method: method.to_owned(),
                session_id,
                sender,
            },
        );
        if let Err(error) = self
            .write_message(
                json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
            )
            .await
        {
            if let Some(pending) = self.inner.pending.lock().await.remove(&id) {
                emit_prompt_finished(
                    &self.inner.events,
                    &pending,
                    AcpPromptOutcome::Error {
                        message: error.to_string(),
                    },
                );
            }
            return Err(error);
        }
        receiver
            .await
            .map_err(|_| IntegratorError::Unavailable("ACP agent disconnected".into()))?
    }

    async fn write_message(&self, value: Value) -> Result<()> {
        let encoded = encode_message(&value)?;
        let mut stdin = self.inner.stdin.lock().await;
        // Bounded write: a healthy agent drains its stdin pipe in
        // milliseconds even for the largest allowed frame. Without a bound,
        // an agent that stops reading parks this write holding the stdin
        // mutex, and cancel() — the user's escape hatch — queues behind it
        // forever.
        match tokio::time::timeout(STDIN_WRITE_TIMEOUT, async {
            stdin.write_all(&encoded).await?;
            stdin.flush().await
        })
        .await
        {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => {
                self.inner.transport_alive.store(false, Ordering::Release);
                Err(error.into())
            }
            Err(_) => {
                self.inner.transport_alive.store(false, Ordering::Release);
                Err(IntegratorError::Unavailable(
                    "ACP agent stopped reading its stdin".into(),
                ))
            }
        }
    }
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

fn session_capabilities(initialization: &Value) -> AcpSessionCapabilities {
    let agent = initialization
        .get("agentCapabilities")
        .unwrap_or(&Value::Null);
    AcpSessionCapabilities {
        load: agent
            .get("loadSession")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        resume: agent.pointer("/sessionCapabilities/resume").is_some(),
        mcp_http: agent
            .pointer("/mcpCapabilities/http")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        mcp_sse: agent
            .pointer("/mcpCapabilities/sse")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn launch_command(executable: &Path, arguments: &[String]) -> Command {
    #[cfg(windows)]
    {
        if is_windows_script(executable) {
            // Cursor's installed `agent.cmd` is a batch wrapper around a
            // same-stem PowerShell launcher. Running the batch file through
            // `cmd /c` is fine for bounded probes, but it does not preserve
            // the long-lived duplex stdio channel ACP requires on this host.
            // Prefer the vendor-owned sibling script directly when present.
            let powershell_launcher = executable.with_extension("ps1");
            if powershell_launcher.is_file() && !powershell_shim_drains_stdin(&powershell_launcher)
            {
                let mut command = Command::new(
                    std::env::var_os("SystemRoot")
                        .map(PathBuf::from)
                        .map(|root| {
                            root.join("System32")
                                .join("WindowsPowerShell")
                                .join("v1.0")
                                .join("powershell.exe")
                        })
                        .unwrap_or_else(|| PathBuf::from("powershell.exe")),
                );
                command.args([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ]);
                command.arg(powershell_launcher);
                command.args(arguments);
                return command;
            }
            let mut command =
                Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()));
            command.args(["/d", "/s", "/c"]);
            command.arg(windows_command_line(executable, arguments));
            return command;
        }
    }

    let mut command = Command::new(executable);
    command.args(arguments);
    command
}

/// npm generates PowerShell shims that pipe `$input` into the real binary
/// whenever `$MyInvocation.ExpectingInput` is true. ACP holds stdin open for
/// the life of the session, so that branch blocks draining stdin to an EOF
/// that never arrives and the agent is never launched at all — the process
/// hangs before emitting a byte. Vendor-authored shims (Cursor's `agent.ps1`)
/// have no such branch and stay on the PowerShell route.
#[cfg(windows)]
fn powershell_shim_drains_stdin(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|script| script.contains("ExpectingInput"))
        // An unreadable shim is not worth guessing about: fall back to the
        // `cmd.exe` route, which never has this failure mode.
        .unwrap_or(true)
}

#[cfg(windows)]
fn is_windows_script(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("bat" | "cmd")
    )
}

#[cfg(windows)]
fn windows_command_line(executable: &Path, arguments: &[String]) -> String {
    std::iter::once(executable.to_string_lossy().into_owned())
        .chain(arguments.iter().cloned())
        .map(|value| quote_windows_arg(&value))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(windows)]
fn quote_windows_arg(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".into();
    }
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    let mut backslashes = 0;
    for character in value.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.extend(std::iter::repeat_n('\\', backslashes));
                quoted.push(character);
                backslashes = 0;
            }
        }
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
    quoted.push('"');
    quoted
}

const ACP_IMAGE_MAX_BYTES: u64 = 12 * 1024 * 1024;

fn acp_image_mime(path: &std::path::Path) -> Option<&'static str> {
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

fn acp_image_block(path: &std::path::Path) -> Option<Value> {
    let mime = acp_image_mime(path)?;
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > ACP_IMAGE_MAX_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    Some(json!({
        "type": "image",
        "mimeType": mime,
        "data": STANDARD.encode(bytes),
    }))
}

fn validate_session_id(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 512 {
        return Err(IntegratorError::InvalidInput(
            "invalid ACP session identity".into(),
        ));
    }
    Ok(())
}

fn validate_short_token(value: &str, label: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 {
        return Err(IntegratorError::InvalidInput(format!(
            "invalid ACP {label}"
        )));
    }
    Ok(())
}

fn encode_message(value: &Value) -> Result<Vec<u8>> {
    let mut encoded = serde_json::to_vec(value)?;
    if encoded.len() > MAX_MESSAGE_BYTES {
        return Err(IntegratorError::InvalidInput(
            "ACP protocol message exceeds safety limit".into(),
        ));
    }
    encoded.push(b'\n');
    Ok(encoded)
}

async fn read_jsonl<R, F, Fut>(mut reader: R, mut on_message: F)
where
    R: AsyncRead + Unpin,
    F: FnMut(JsonlFrame) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let mut chunk = [0_u8; 8192];
    let mut line = Vec::new();
    let mut discarding = false;
    loop {
        let count = match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        for byte in &chunk[..count] {
            if *byte == b'\n' {
                if discarding {
                    on_message(JsonlFrame::TooLarge(std::mem::take(&mut line))).await;
                } else if !line.is_empty() {
                    match serde_json::from_slice::<Value>(&line) {
                        Ok(value) => on_message(JsonlFrame::Message(value)).await,
                        Err(_) => {
                            on_message(JsonlFrame::Invalid(std::mem::take(&mut line))).await;
                        }
                    }
                }
                line.clear();
                discarding = false;
            } else if !discarding {
                line.push(*byte);
                if line.len() > MAX_MESSAGE_BYTES {
                    // Keep a bounded head so the dispatcher can identify
                    // which pending request (if any) the discarded frame was
                    // answering; the rest of the line is skipped.
                    line.truncate(DISCARDED_FRAME_HEAD_BYTES);
                    discarding = true;
                }
            }
        }
    }
    if discarding {
        on_message(JsonlFrame::TooLarge(std::mem::take(&mut line))).await;
    } else if !line.is_empty() {
        match serde_json::from_slice::<Value>(&line) {
            Ok(value) => on_message(JsonlFrame::Message(value)).await,
            Err(_) => on_message(JsonlFrame::Invalid(std::mem::take(&mut line))).await,
        }
    }
}

enum JsonlFrame {
    Message(Value),
    Invalid(Vec<u8>),
    TooLarge(Vec<u8>),
}

/// A discarded frame (oversized or malformed) must still fail the pending
/// request it was answering — otherwise that caller waits forever on a
/// response the transport has already thrown away. The violation event is
/// emitted either way; the pending entry is resolved only on positive
/// response evidence from [`discarded_response_id`].
async fn fail_discarded_response(
    bytes: &[u8],
    pending: &Mutex<HashMap<u64, PendingRequest>>,
    events: &broadcast::Sender<AcpEvent>,
    code: &str,
) {
    let _ = events.send(AcpEvent::ProtocolViolation { code: code.into() });
    let Some(id) = discarded_response_id(bytes) else {
        return;
    };
    let Some(request) = pending.lock().await.remove(&id) else {
        return;
    };
    let error = IntegratorError::Unavailable(format!("ACP agent response was discarded ({code})"));
    emit_prompt_finished(
        events,
        &request,
        AcpPromptOutcome::Error {
            message: error.to_string(),
        },
    );
    let _ = request.sender.send(Err(error));
}

/// Scans a (possibly truncated) JSON object head for positive evidence that
/// the frame was a JSON-RPC *response*: a top-level integer `id`, a top-level
/// `result` or `error` key, and no top-level `method` key (which would make
/// it an agent-initiated request whose id lives in a different namespace).
/// Anything ambiguous — truncated id digits, non-integer id, no response
/// key in the retained head — returns `None`, leaving pending state alone,
/// so a misattributed failure is structurally impossible.
fn discarded_response_id(bytes: &[u8]) -> Option<u64> {
    let mut i = 0_usize;
    while bytes.get(i).is_some_and(|byte| byte.is_ascii_whitespace()) {
        i += 1;
    }
    if bytes.get(i) != Some(&b'{') {
        return None;
    }
    i += 1;
    let mut depth = 1_usize;
    let mut expecting_key = true;
    let mut id = None;
    let mut is_response = false;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                let start = i + 1;
                i += 1;
                let mut end = None;
                while i < bytes.len() {
                    match bytes[i] {
                        b'\\' => i += 2,
                        b'"' => {
                            end = Some(i);
                            i += 1;
                            break;
                        }
                        _ => i += 1,
                    }
                }
                let Some(end) = end else { break };
                if depth == 1 && expecting_key {
                    while bytes.get(i).is_some_and(|byte| byte.is_ascii_whitespace()) {
                        i += 1;
                    }
                    if bytes.get(i) != Some(&b':') {
                        break;
                    }
                    match &bytes[start..end] {
                        b"method" => return None,
                        b"result" | b"error" => is_response = true,
                        b"id" => {
                            i += 1;
                            expecting_key = false;
                            while bytes.get(i).is_some_and(|byte| byte.is_ascii_whitespace()) {
                                i += 1;
                            }
                            let digits = i;
                            while bytes.get(i).is_some_and(|byte| byte.is_ascii_digit()) {
                                i += 1;
                            }
                            // Require a terminator so digits cut off by the
                            // head boundary can never parse as a shorter id.
                            let terminated = matches!(bytes.get(i), Some(b',' | b'}'))
                                || bytes.get(i).is_some_and(|byte| byte.is_ascii_whitespace());
                            if i == digits || !terminated {
                                return None;
                            }
                            let parsed: u64 = std::str::from_utf8(&bytes[digits..i])
                                .ok()
                                .and_then(|text| text.parse().ok())?;
                            id = Some(parsed);
                        }
                        _ => {}
                    }
                }
            }
            b'{' | b'[' => {
                depth += 1;
                i += 1;
            }
            b'}' | b']' => {
                if depth == 1 {
                    break;
                }
                depth -= 1;
                i += 1;
            }
            b',' => {
                if depth == 1 {
                    expecting_key = true;
                }
                i += 1;
            }
            b':' => {
                if depth == 1 {
                    expecting_key = false;
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    if is_response { id } else { None }
}

async fn route_message(
    message: Value,
    pending: Arc<Mutex<HashMap<u64, PendingRequest>>>,
    events: broadcast::Sender<AcpEvent>,
) {
    let id_value = message.get("id");
    let method = message.get("method").and_then(Value::as_str);
    if let (Some(id_value), Some(method)) = (id_value, method) {
        match AcpRequestId::from_protocol_value(id_value) {
            Ok(id) => {
                let _ = events.send(AcpEvent::ServerRequest {
                    id,
                    method: method.to_owned(),
                    params: message.get("params").cloned().unwrap_or(Value::Null),
                });
            }
            Err(_) => {
                let _ = events.send(AcpEvent::ProtocolViolation {
                    code: "invalid-server-request-id".into(),
                });
            }
        }
        return;
    }
    if let Some(id_value) = id_value {
        let Some(id) = id_value.as_u64() else {
            let _ = events.send(AcpEvent::ProtocolViolation {
                code: "invalid-response-id".into(),
            });
            return;
        };
        if let Some(request) = pending.lock().await.remove(&id) {
            let result = if let Some(error) = message.get("error") {
                Err(IntegratorError::Protocol(protocol_error(error)))
            } else {
                Ok(message.get("result").cloned().unwrap_or(Value::Null))
            };
            let outcome = match &result {
                Ok(response) => AcpPromptOutcome::Response {
                    stop_reason: StopReason::from_protocol(response),
                },
                Err(error) => AcpPromptOutcome::Error {
                    message: error.to_string(),
                },
            };
            emit_prompt_finished(&events, &request, outcome);
            let _ = request.sender.send(result);
        } else {
            let _ = events.send(AcpEvent::ProtocolViolation {
                code: "unknown-response-id".into(),
            });
        }
        return;
    }
    if let Some(method) = method {
        let _ = events.send(AcpEvent::Notification {
            method: method.to_owned(),
            params: message.get("params").cloned().unwrap_or(Value::Null),
        });
        return;
    }
    let _ = events.send(AcpEvent::ProtocolViolation {
        code: "invalid-frame".into(),
    });
}

fn emit_prompt_finished(
    events: &broadcast::Sender<AcpEvent>,
    request: &PendingRequest,
    outcome: AcpPromptOutcome,
) {
    if request.method != "session/prompt" {
        return;
    }
    let Some(session_id) = request.session_id.clone() else {
        return;
    };
    let _ = events.send(AcpEvent::PromptFinished {
        session_id,
        outcome,
    });
}

fn protocol_error(error: &Value) -> String {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("ACP agent error");
    let code = error.get("code").and_then(Value::as_i64);
    match code {
        Some(code) => format!("{message} (code {code})"),
        None => message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast;

    #[test]
    fn discarded_response_id_requires_positive_response_evidence() {
        // Plain response: id + result → identified.
        assert_eq!(
            discarded_response_id(br#"{"jsonrpc":"2.0","id":42,"result":{"x":1}}"#),
            Some(42)
        );
        // Error response counts too, and truncation after evidence is fine.
        assert_eq!(
            discarded_response_id(br#"{"jsonrpc":"2.0","id":7,"error":{"message":"boo"#),
            Some(7)
        );
        // result key first, giant payload truncated, id after: still fine.
        assert_eq!(
            discarded_response_id(br#"{"result":{"a":"b"},"id":3,"#),
            Some(3)
        );
        // Agent-initiated request: id shares no namespace with ours → None.
        assert_eq!(
            discarded_response_id(br#"{"jsonrpc":"2.0","id":42,"method":"fs/read","params":{}}"#),
            None
        );
        // Notification (no id): None.
        assert_eq!(
            discarded_response_id(br#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#),
            None
        );
        // Truncated id digits at the head boundary must never parse short.
        assert_eq!(discarded_response_id(br#"{"result":null,"id":12"#), None);
        // Non-integer id: None.
        assert_eq!(discarded_response_id(br#"{"id":"42","result":null}"#), None);
        // Nested "method"/"id" inside values must not confuse depth tracking.
        assert_eq!(
            discarded_response_id(
                br#"{"id":9,"result":{"method":"x","id":1,"text":"\"}{"},"more":1}"#
            ),
            Some(9)
        );
        // Not JSON at all: None.
        assert_eq!(discarded_response_id(b"this is not json"), None);
    }

    #[tokio::test]
    async fn discarded_response_fails_the_matching_pending_request() {
        let (events, mut receiver) = broadcast::channel(16);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (sender, response) = tokio::sync::oneshot::channel();
        pending.lock().await.insert(
            5,
            PendingRequest {
                method: "session/prompt".into(),
                session_id: Some("sess-1".into()),
                sender,
            },
        );
        fail_discarded_response(
            br#"{"jsonrpc":"2.0","id":5,"result":{"stopReason":"end_turn"}}"#,
            &pending,
            &events,
            "message-too-large",
        )
        .await;
        assert!(pending.lock().await.is_empty(), "pending entry resolved");
        let result = response.await.expect("sender used");
        assert!(result.is_err(), "discarded frame surfaces as an error");
        // Violation event plus the load-bearing PromptFinished boundary.
        let mut saw_violation = false;
        let mut saw_finished = false;
        while let Ok(event) = receiver.try_recv() {
            match event {
                AcpEvent::ProtocolViolation { code } => {
                    assert_eq!(code, "message-too-large");
                    saw_violation = true;
                }
                AcpEvent::PromptFinished { session_id, .. } => {
                    assert_eq!(session_id, "sess-1");
                    saw_finished = true;
                }
                _ => {}
            }
        }
        assert!(saw_violation && saw_finished);
    }

    #[test]
    fn stop_reason_maps_protocol_values() {
        assert_eq!(
            StopReason::from_protocol(&json!({ "stopReason": "end_turn" })),
            StopReason::EndTurn
        );
        assert_eq!(
            StopReason::from_protocol(&json!({ "stopReason": "cancelled" })),
            StopReason::Cancelled
        );
        assert_eq!(StopReason::from_protocol(&json!({})), StopReason::Unknown);
    }

    #[test]
    fn request_id_round_trips_string_and_number() {
        let string_id = AcpRequestId::from_protocol_value(&json!("req-1")).expect("string id");
        assert_eq!(string_id.to_protocol_value(), json!("req-1"));
        let number_id = AcpRequestId::from_protocol_value(&json!(42)).expect("number id");
        assert_eq!(number_id.to_protocol_value(), json!(42));
        assert!(AcpRequestId::from_protocol_value(&json!(null)).is_err());
    }

    #[test]
    fn protocol_messages_are_newline_delimited_and_bounded() {
        let encoded = encode_message(&json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": "session-1" }
        }))
        .expect("encoded ACP message");
        assert_eq!(encoded.last(), Some(&b'\n'));
        assert_eq!(encoded.iter().filter(|byte| **byte == b'\n').count(), 1);

        let oversized = json!({ "value": "x".repeat(MAX_MESSAGE_BYTES) });
        assert!(encode_message(&oversized).is_err());
    }

    #[test]
    fn adversarial_session_and_config_identifiers_are_rejected() {
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id(&"s".repeat(513)).is_err());
        assert!(validate_short_token("", "config option id").is_err());
        assert!(validate_short_token(&"m".repeat(257), "config option value").is_err());
    }

    #[test]
    fn session_recovery_capabilities_are_feature_detected_exactly() {
        assert_eq!(
            session_capabilities(&json!({
                "agentCapabilities": {
                    "loadSession": true,
                    "sessionCapabilities": { "resume": {} },
                    "mcpCapabilities": { "http": true, "sse": false }
                }
            })),
            AcpSessionCapabilities {
                load: true,
                resume: true,
                mcp_http: true,
                mcp_sse: false,
            }
        );
        assert_eq!(
            session_capabilities(&json!({ "agentCapabilities": {} })),
            AcpSessionCapabilities::default()
        );
    }

    #[tokio::test]
    async fn happy_response_is_delivered_to_the_matching_request() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = oneshot::channel();
        pending.lock().await.insert(
            7,
            PendingRequest {
                method: "initialize".into(),
                session_id: None,
                sender,
            },
        );
        let (events, _) = broadcast::channel(4);

        route_message(
            json!({ "jsonrpc": "2.0", "id": 7, "result": { "stopReason": "end_turn" } }),
            Arc::clone(&pending),
            events,
        )
        .await;

        assert_eq!(
            receiver
                .await
                .expect("pending response")
                .expect("ACP result"),
            json!({ "stopReason": "end_turn" })
        );
        assert!(pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn prompt_boundary_follows_every_buffered_stream_notification() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (sender, response) = oneshot::channel();
        pending.lock().await.insert(
            8,
            PendingRequest {
                method: "session/prompt".into(),
                session_id: Some("session-1".into()),
                sender,
            },
        );
        let (events, mut receiver) = broadcast::channel(128);
        let expected = (0..64)
            .map(|index| format!("tail-{index}"))
            .collect::<Vec<_>>();

        for text in &expected {
            route_message(
                json!({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": "session-1",
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": { "type": "text", "text": text }
                        }
                    }
                }),
                Arc::clone(&pending),
                events.clone(),
            )
            .await;
        }
        route_message(
            json!({ "jsonrpc": "2.0", "id": 8, "result": { "stopReason": "end_turn" } }),
            Arc::clone(&pending),
            events,
        )
        .await;

        let mut streamed = Vec::new();
        for _ in 0..expected.len() {
            let AcpEvent::Notification { method, params } =
                receiver.recv().await.expect("stream notification")
            else {
                panic!("expected buffered stream notification");
            };
            assert_eq!(method, "session/update");
            streamed.push(
                params
                    .pointer("/update/content/text")
                    .and_then(Value::as_str)
                    .expect("stream text")
                    .to_owned(),
            );
        }
        assert_eq!(streamed, expected);
        assert_eq!(
            receiver.recv().await.expect("prompt boundary"),
            AcpEvent::PromptFinished {
                session_id: "session-1".into(),
                outcome: AcpPromptOutcome::Response {
                    stop_reason: StopReason::EndTurn,
                },
            }
        );
        assert_eq!(
            response
                .await
                .expect("pending response")
                .expect("ACP result"),
            json!({ "stopReason": "end_turn" })
        );
        assert!(pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn degraded_prompt_error_preserves_protocol_error_and_orders_the_boundary() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = oneshot::channel();
        pending.lock().await.insert(
            9,
            PendingRequest {
                method: "session/prompt".into(),
                session_id: Some("session-1".into()),
                sender,
            },
        );
        let (events, mut event_receiver) = broadcast::channel(4);

        route_message(
            json!({
                "jsonrpc": "2.0",
                "id": 9,
                "error": { "code": -32000, "message": "session expired" }
            }),
            Arc::clone(&pending),
            events,
        )
        .await;

        assert_eq!(
            event_receiver.recv().await.expect("prompt boundary"),
            AcpEvent::PromptFinished {
                session_id: "session-1".into(),
                outcome: AcpPromptOutcome::Error {
                    message: "provider protocol error: session expired (code -32000)".into(),
                },
            }
        );
        let error = receiver
            .await
            .expect("pending response")
            .expect_err("protocol error");
        assert_eq!(
            error.to_string(),
            "provider protocol error: session expired (code -32000)"
        );
        assert!(pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn permission_request_keeps_string_identity_for_the_reply() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, mut receiver) = broadcast::channel(4);
        route_message(
            json!({
                "jsonrpc": "2.0",
                "id": "permission-1",
                "method": "session/request_permission",
                "params": { "sessionId": "session-1", "options": [] }
            }),
            pending,
            events,
        )
        .await;

        match receiver.recv().await.expect("server request event") {
            AcpEvent::ServerRequest { id, method, .. } => {
                assert_eq!(id, AcpRequestId::String("permission-1".into()));
                assert_eq!(method, "session/request_permission");
            }
            event => panic!("unexpected ACP event: {event:?}"),
        }
    }

    #[tokio::test]
    async fn stale_response_after_restart_is_a_protocol_violation() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, mut receiver) = broadcast::channel(4);
        route_message(
            json!({ "jsonrpc": "2.0", "id": 99, "result": {} }),
            pending,
            events,
        )
        .await;

        assert_eq!(
            receiver.recv().await.expect("protocol violation"),
            AcpEvent::ProtocolViolation {
                code: "unknown-response-id".into()
            }
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_cursor_shim_launch_is_quoted_without_shell_injection() {
        let command = windows_command_line(
            Path::new(r"C:\Program Files\Cursor Agent\agent.cmd"),
            &["acp".into(), "value with spaces".into(), "&whoami".into()],
        );
        assert_eq!(
            command,
            r#""C:\Program Files\Cursor Agent\agent.cmd" "acp" "value with spaces" "&whoami""#
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_cursor_shim_prefers_sibling_powershell_for_duplex_stdio() {
        let directory =
            std::env::temp_dir().join(format!("ai-integrator-acp-launch-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create launcher fixture");
        let batch = directory.join("agent.cmd");
        let powershell = directory.join("agent.ps1");
        std::fs::write(&batch, "@echo off\r\n").expect("write batch fixture");
        std::fs::write(&powershell, "exit 0\r\n").expect("write PowerShell fixture");

        let command = launch_command(&batch, &["acp".into()]);
        let standard = command.as_std();
        assert!(
            standard
                .get_program()
                .to_string_lossy()
                .to_ascii_lowercase()
                .ends_with("powershell.exe")
        );
        assert!(
            standard
                .get_args()
                .any(|argument| argument == powershell.as_os_str())
        );
        assert!(standard.get_args().any(|argument| argument == "acp"));

        let _ = std::fs::remove_dir_all(directory);
    }

    /// npm's shims (Grok, Codex) block on `$input` until stdin reaches EOF,
    /// which never happens on an ACP session, so the agent is never launched.
    /// Those must fall back to `cmd.exe`; the vendor shims above must not.
    #[cfg(windows)]
    #[test]
    fn windows_npm_shim_that_drains_stdin_falls_back_to_cmd() {
        let directory =
            std::env::temp_dir().join(format!("ai-integrator-acp-npm-shim-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create launcher fixture");
        let batch = directory.join("grok.cmd");
        let powershell = directory.join("grok.ps1");
        std::fs::write(&batch, "@echo off\r\n").expect("write batch fixture");
        std::fs::write(
            &powershell,
            "if ($MyInvocation.ExpectingInput) {\r\n  $input | & \"node$exe\" $args\r\n}\r\n",
        )
        .expect("write npm shim fixture");

        assert!(powershell_shim_drains_stdin(&powershell));

        let command = launch_command(&batch, &["agent".into(), "stdio".into()]);
        let standard = command.as_std();
        assert!(
            standard
                .get_program()
                .to_string_lossy()
                .to_ascii_lowercase()
                .ends_with("cmd.exe"),
            "npm shim must not be launched through PowerShell"
        );
        assert!(
            !standard
                .get_args()
                .any(|argument| argument == powershell.as_os_str())
        );

        let _ = std::fs::remove_dir_all(directory);
    }
}
