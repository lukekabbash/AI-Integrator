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
        atomic::{AtomicU64, Ordering},
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

const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
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
    StderrActivity,
    Exited,
}

#[derive(Clone, Debug)]
pub struct AcpLaunchOptions {
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub working_directory: Option<PathBuf>,
    pub client_version: String,
}

/// The result of a completed `session/prompt` turn.
#[derive(Clone, Debug, Eq, PartialEq)]
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

struct Inner {
    child: Mutex<Option<Child>>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>>,
    events: broadcast::Sender<AcpEvent>,
    next_id: AtomicU64,
    initialization: Mutex<Value>,
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
        spawn_stdout_reader(stdout, Arc::clone(&pending), events.clone());
        spawn_stderr_drain(stderr, events.clone());

        let client = Self {
            inner: Arc::new(Inner {
                child: Mutex::new(Some(child)),
                stdin: Mutex::new(stdin),
                pending,
                events,
                next_id: AtomicU64::new(1),
                initialization: Mutex::new(Value::Null),
            }),
        };
        let initialization = client.initialize(&options.client_version).await?;
        *client.inner.initialization.lock().await = initialization;
        Ok(client)
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<AcpEvent> {
        self.inner.events.subscribe()
    }

    /// Sanitized callers use this only to inspect advertised protocol
    /// capabilities such as auth method ids. It never contains credential
    /// values supplied by Integrator.
    pub async fn initialization(&self) -> Value {
        self.inner.initialization.lock().await.clone()
    }

    /// Runs ACP's provider-owned authentication handshake. Integrator passes
    /// only a method id the agent advertised (for Grok, `cached_token`) and
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

    /// Long-running: the response resolves when the turn finishes. Callers
    /// should await this on a spawned task, not on a UI-facing command.
    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<Value> {
        validate_session_id(session_id)?;
        self.request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": text }]
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
        let mut child = self.inner.child.lock().await;
        if let Some(mut process) = child.take() {
            process.kill().await?;
            let _ = process.wait().await;
        }
        Ok(())
    }

    async fn initialize(&self, client_version: &str) -> Result<Value> {
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
        // session/new or any other session request.
        self.write_message(json!({
            "jsonrpc": "2.0",
            "method": "initialized",
            "params": {}
        }))
        .await?;

        Ok(response)
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.inner.pending.lock().await.insert(id, sender);
        if let Err(error) = self
            .write_message(
                json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
            )
            .await
        {
            self.inner.pending.lock().await.remove(&id);
            return Err(error);
        }
        receiver
            .await
            .map_err(|_| IntegratorError::Unavailable("ACP agent disconnected".into()))?
    }

    async fn write_message(&self, value: Value) -> Result<()> {
        let encoded = encode_message(&value)?;
        let mut stdin = self.inner.stdin.lock().await;
        stdin.write_all(&encoded).await?;
        stdin.flush().await?;
        Ok(())
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
            if powershell_launcher.is_file() {
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

fn spawn_stdout_reader(
    stdout: impl AsyncRead + Unpin + Send + 'static,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>>,
    events: broadcast::Sender<AcpEvent>,
) {
    tokio::spawn(async move {
        read_jsonl(stdout, |frame| {
            let pending = Arc::clone(&pending);
            let events = events.clone();
            async move {
                match frame {
                    JsonlFrame::Message(message) => route_message(message, pending, events).await,
                    JsonlFrame::Invalid => {
                        let _ = events.send(AcpEvent::ProtocolViolation {
                            code: "invalid-json".into(),
                        });
                    }
                    JsonlFrame::TooLarge => {
                        let _ = events.send(AcpEvent::ProtocolViolation {
                            code: "message-too-large".into(),
                        });
                    }
                }
            }
        })
        .await;
        let mut pending = pending.lock().await;
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(IntegratorError::Unavailable("ACP agent exited".into())));
        }
        let _ = events.send(AcpEvent::Exited);
    });
}

fn spawn_stderr_drain(
    stderr: impl AsyncRead + Unpin + Send + 'static,
    events: broadcast::Sender<AcpEvent>,
) {
    tokio::spawn(async move {
        let mut stderr = stderr;
        let mut buffer = [0_u8; 8192];
        let mut emitted = false;
        loop {
            match stderr.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(_) if !emitted => {
                    emitted = true;
                    let _ = events.send(AcpEvent::StderrActivity);
                }
                Ok(_) => {}
            }
        }
    });
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
                    on_message(JsonlFrame::TooLarge).await;
                } else if !line.is_empty() {
                    match serde_json::from_slice::<Value>(&line) {
                        Ok(value) => on_message(JsonlFrame::Message(value)).await,
                        Err(_) => on_message(JsonlFrame::Invalid).await,
                    }
                }
                line.clear();
                discarding = false;
            } else if !discarding {
                line.push(*byte);
                if line.len() > MAX_MESSAGE_BYTES {
                    line.clear();
                    discarding = true;
                }
            }
        }
    }
    if discarding {
        on_message(JsonlFrame::TooLarge).await;
    } else if !line.is_empty() {
        match serde_json::from_slice::<Value>(&line) {
            Ok(value) => on_message(JsonlFrame::Message(value)).await,
            Err(_) => on_message(JsonlFrame::Invalid).await,
        }
    }
}

enum JsonlFrame {
    Message(Value),
    Invalid,
    TooLarge,
}

async fn route_message(
    message: Value,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>>,
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
        if let Some(sender) = pending.lock().await.remove(&id) {
            let result = if let Some(error) = message.get("error") {
                Err(IntegratorError::Protocol(protocol_error(error)))
            } else {
                Ok(message.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = sender.send(result);
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

    #[tokio::test]
    async fn happy_response_is_delivered_to_the_matching_request() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = oneshot::channel();
        pending.lock().await.insert(7, sender);
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
    async fn degraded_error_response_preserves_only_protocol_error() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = oneshot::channel();
        pending.lock().await.insert(8, sender);
        let (events, _) = broadcast::channel(4);

        route_message(
            json!({
                "jsonrpc": "2.0",
                "id": 8,
                "error": { "code": -32000, "message": "session expired" }
            }),
            Arc::clone(&pending),
            events,
        )
        .await;

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
}
