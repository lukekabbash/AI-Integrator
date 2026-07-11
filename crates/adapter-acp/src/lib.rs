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

        let mut command = Command::new(&options.executable);
        command
            .args(&options.arguments)
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
            }),
        };
        client.initialize(&options.client_version).await?;
        Ok(client)
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<AcpEvent> {
        self.inner.events.subscribe()
    }

    pub async fn new_session(&self, cwd: &Path) -> Result<Value> {
        self.request(
            "session/new",
            json!({ "cwd": cwd.to_string_lossy(), "mcpServers": [] }),
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
        self.request(
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
                    "terminal": false
                }
            }),
        )
        .await
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

fn validate_session_id(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 512 {
        return Err(IntegratorError::InvalidInput(
            "invalid ACP session identity".into(),
        ));
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
}
