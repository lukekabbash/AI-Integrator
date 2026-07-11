#![forbid(unsafe_code)]

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

pub const CODEX_PROTOCOL_VERSION: u32 = 3;
const EVENT_CAPACITY: usize = 256;
const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SERVER_REQUEST_ID_BYTES: usize = 512;

/// A JSON-RPC server-request identifier as presented by Codex.
///
/// The tagged representation is used at Integrator's own API boundary. Protocol
/// reads and writes deliberately go through `from_protocol_value` and
/// `to_protocol_value` so the scalar sent back to Codex remains byte-for-byte
/// equivalent at the JSON value level (number versus string is never coerced).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum ServerRequestId {
    Number(Number),
    String(String),
}

impl ServerRequestId {
    pub fn from_protocol_value(value: &Value) -> Result<Self> {
        let id = match value {
            Value::Number(value) => Self::Number(value.clone()),
            Value::String(value) => Self::String(value.clone()),
            _ => {
                return Err(IntegratorError::InvalidInput(
                    "Codex server request id must be a string or number".into(),
                ));
            }
        };
        id.validate()?;
        Ok(id)
    }

    pub fn validate(&self) -> Result<()> {
        if matches!(self, Self::String(value) if value.len() > MAX_SERVER_REQUEST_ID_BYTES) {
            return Err(IntegratorError::InvalidInput(
                "Codex server request id exceeds safety limit".into(),
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
pub enum CodexEvent {
    Notification {
        method: String,
        params: Value,
    },
    ServerRequest {
        id: ServerRequestId,
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
pub struct CodexLaunchOptions {
    pub executable: PathBuf,
    pub working_directory: Option<PathBuf>,
    pub client_version: String,
}

#[derive(Clone)]
pub struct CodexClient {
    inner: Arc<Inner>,
}

struct Inner {
    child: Mutex<Option<Child>>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>>,
    events: broadcast::Sender<CodexEvent>,
    next_id: AtomicU64,
}

impl CodexClient {
    pub async fn spawn(options: CodexLaunchOptions) -> Result<Self> {
        if !options.executable.is_file() {
            return Err(IntegratorError::InvalidInput(
                "Codex executable does not exist".into(),
            ));
        }
        if let Some(cwd) = options.working_directory.as_deref()
            && !cwd.is_dir()
        {
            return Err(IntegratorError::InvalidInput(
                "Codex working directory does not exist".into(),
            ));
        }

        let mut command = Command::new(&options.executable);
        command
            .args(["app-server", "--stdio"])
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
            .ok_or_else(|| IntegratorError::Unavailable("Codex stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| IntegratorError::Unavailable("Codex stdout unavailable".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| IntegratorError::Unavailable("Codex stderr unavailable".into()))?;

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
    pub fn subscribe(&self) -> broadcast::Receiver<CodexEvent> {
        self.inner.events.subscribe()
    }

    pub async fn list_models(&self, include_hidden: bool) -> Result<Value> {
        self.request("model/list", json!({ "includeHidden": include_hidden }))
            .await
    }

    pub async fn list_threads(&self, cursor: Option<String>, limit: u32) -> Result<Value> {
        if !(1..=100).contains(&limit) {
            return Err(IntegratorError::InvalidInput(
                "thread page limit must be between 1 and 100".into(),
            ));
        }
        self.request(
            "thread/list",
            json!({ "cursor": cursor, "limit": limit, "archived": false }),
        )
        .await
    }

    pub async fn read_thread(&self, thread_id: &str, include_turns: bool) -> Result<Value> {
        validate_protocol_id(thread_id, "thread")?;
        self.request(
            "thread/read",
            json!({ "threadId": thread_id, "includeTurns": include_turns }),
        )
        .await
    }

    pub async fn start_thread(&self, cwd: &Path, model: Option<&str>) -> Result<Value> {
        if !cwd.is_dir() {
            return Err(IntegratorError::InvalidInput(
                "thread working directory does not exist".into(),
            ));
        }
        let mut params = json!({
            "cwd": cwd.to_string_lossy(),
            "approvalPolicy": "on-request",
            "sandbox": "workspace-write"
        });
        if let Some(model) = model {
            // "model": null makes the app-server fall back to "Auto", which
            // ChatGPT-account sessions reject — omit the key entirely instead.
            params["model"] = Value::String(model.into());
        }
        self.request("thread/start", params).await
    }

    pub async fn resume_thread(&self, thread_id: &str) -> Result<Value> {
        validate_protocol_id(thread_id, "thread")?;
        self.request("thread/resume", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn start_turn(&self, thread_id: &str, prompt: &str) -> Result<Value> {
        validate_protocol_id(thread_id, "thread")?;
        let prompt = prompt.trim();
        if prompt.is_empty() || prompt.len() > 2 * 1024 * 1024 {
            return Err(IntegratorError::InvalidInput(
                "prompt must contain 1 byte to 2 MiB".into(),
            ));
        }
        self.request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text": prompt }]
            }),
        )
        .await
    }

    pub async fn interrupt_turn(&self, thread_id: &str, turn_id: &str) -> Result<Value> {
        validate_protocol_id(thread_id, "thread")?;
        validate_protocol_id(turn_id, "turn")?;
        self.request(
            "turn/interrupt",
            json!({ "threadId": thread_id, "turnId": turn_id }),
        )
        .await
    }

    pub async fn respond_to_server_request(
        &self,
        id: &ServerRequestId,
        result: Value,
    ) -> Result<()> {
        id.validate()?;
        self.write_message(json!({ "id": id.to_protocol_value(), "result": result }))
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
                "clientInfo": {
                    "name": "ai-integrator",
                    "title": "AI Integrator",
                    "version": client_version
                },
                "capabilities": { "experimentalApi": false }
            }),
        )
        .await
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.inner.pending.lock().await.insert(id, sender);
        if let Err(error) = self
            .write_message(json!({ "id": id, "method": method, "params": params }))
            .await
        {
            self.inner.pending.lock().await.remove(&id);
            return Err(error);
        }
        receiver
            .await
            .map_err(|_| IntegratorError::Unavailable("Codex app-server disconnected".into()))?
    }

    async fn write_message(&self, value: Value) -> Result<()> {
        let encoded = encode_message(&value)?;
        let mut stdin = self.inner.stdin.lock().await;
        stdin.write_all(&encoded).await?;
        stdin.flush().await?;
        Ok(())
    }
}

fn encode_message(value: &Value) -> Result<Vec<u8>> {
    let mut encoded = serde_json::to_vec(value)?;
    if encoded.len() > MAX_MESSAGE_BYTES {
        return Err(IntegratorError::InvalidInput(
            "Codex protocol message exceeds safety limit".into(),
        ));
    }
    encoded.push(b'\n');
    Ok(encoded)
}

fn spawn_stdout_reader(
    stdout: impl AsyncRead + Unpin + Send + 'static,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>>,
    events: broadcast::Sender<CodexEvent>,
) {
    tokio::spawn(async move {
        read_jsonl(stdout, |frame| {
            let pending = Arc::clone(&pending);
            let events = events.clone();
            async move {
                match frame {
                    JsonlFrame::Message(message) => route_message(message, pending, events).await,
                    JsonlFrame::Invalid => {
                        let _ = events.send(CodexEvent::ProtocolViolation {
                            code: "invalid-json".into(),
                        });
                    }
                    JsonlFrame::TooLarge => {
                        let _ = events.send(CodexEvent::ProtocolViolation {
                            code: "message-too-large".into(),
                        });
                    }
                }
            }
        })
        .await;
        let mut pending = pending.lock().await;
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(IntegratorError::Unavailable(
                "Codex app-server exited".into(),
            )));
        }
        let _ = events.send(CodexEvent::Exited);
    });
}

fn spawn_stderr_drain(
    stderr: impl AsyncRead + Unpin + Send + 'static,
    events: broadcast::Sender<CodexEvent>,
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
                    let _ = events.send(CodexEvent::StderrActivity);
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
    events: broadcast::Sender<CodexEvent>,
) {
    let id_value = message.get("id");
    let method = message.get("method").and_then(Value::as_str);
    if let (Some(id_value), Some(method)) = (id_value, method) {
        match ServerRequestId::from_protocol_value(id_value) {
            Ok(id) => {
                let _ = events.send(CodexEvent::ServerRequest {
                    id,
                    method: method.to_owned(),
                    params: message.get("params").cloned().unwrap_or(Value::Null),
                });
            }
            Err(_) => {
                let _ = events.send(CodexEvent::ProtocolViolation {
                    code: "invalid-server-request-id".into(),
                });
            }
        }
        return;
    }
    if let Some(id_value) = id_value {
        let Some(id) = id_value.as_u64() else {
            let code = if ServerRequestId::from_protocol_value(id_value).is_ok() {
                "unknown-response-id"
            } else {
                "invalid-response-id"
            };
            let _ = events.send(CodexEvent::ProtocolViolation { code: code.into() });
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
            let _ = events.send(CodexEvent::ProtocolViolation {
                code: "unknown-response-id".into(),
            });
        }
        return;
    }
    if let Some(method) = method {
        let _ = events.send(CodexEvent::Notification {
            method: method.to_owned(),
            params: message.get("params").cloned().unwrap_or(Value::Null),
        });
    } else {
        let _ = events.send(CodexEvent::ProtocolViolation {
            code: "unclassified-message".into(),
        });
    }
}

fn protocol_error(value: &Value) -> String {
    let code = value
        .get("code")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("provider request failed");
    let message = redact_protocol_text(&message.chars().take(500).collect::<String>());
    format!("{code}: {message}")
}

fn redact_protocol_text(value: &str) -> String {
    value
        .split_whitespace()
        .map(|token| {
            let lowered = token.to_ascii_lowercase();
            if lowered.starts_with("sk-")
                || lowered.starts_with("token=")
                || lowered.starts_with("key=")
                || lowered.starts_with("secret=")
                || (token.contains('@') && token.contains('.'))
            {
                "[redacted]"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn validate_protocol_id(value: &str, label: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 256
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(IntegratorError::InvalidInput(format!("invalid {label} id")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn response_routes_to_pending_request() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = oneshot::channel();
        pending.lock().await.insert(7, sender);
        let (events, _) = broadcast::channel(4);
        route_message(
            json!({ "id": 7, "result": { "ok": true } }),
            pending,
            events,
        )
        .await;
        let response = receiver
            .await
            .expect("receive response")
            .expect("successful response");
        assert_eq!(response["ok"], true);
    }

    #[tokio::test]
    async fn numeric_server_request_id_is_preserved() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, mut receiver) = broadcast::channel(4);
        route_message(
            serde_json::from_str(r#"{"id":42.5,"method":"item/tool/call","params":{}}"#)
                .expect("numeric request fixture"),
            pending,
            events,
        )
        .await;

        let event = receiver.recv().await.expect("server request");
        assert!(matches!(
            event,
            CodexEvent::ServerRequest {
                id: ServerRequestId::Number(ref value),
                ..
            } if value.to_string() == "42.5"
        ));
    }

    #[tokio::test]
    async fn string_server_request_id_is_preserved_without_numeric_coercion() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, mut receiver) = broadcast::channel(4);
        route_message(
            serde_json::from_str(r#"{"id":"00042","method":"item/tool/call","params":{}}"#)
                .expect("string request fixture"),
            pending,
            events,
        )
        .await;

        let event = receiver.recv().await.expect("server request");
        assert!(matches!(
            event,
            CodexEvent::ServerRequest {
                id: ServerRequestId::String(ref value),
                ..
            } if value == "00042"
        ));
        let id = ServerRequestId::String("00042".into());
        assert_eq!(id.to_protocol_value(), json!("00042"));
        assert_eq!(
            serde_json::to_value(&id).expect("tagged application representation"),
            json!({ "kind": "string", "value": "00042" })
        );
        assert_eq!(
            serde_json::to_value(ServerRequestId::Number(Number::from(42)))
                .expect("tagged numeric application representation"),
            json!({ "kind": "number", "value": 42 })
        );
    }

    #[tokio::test]
    async fn malformed_and_oversized_server_request_ids_are_rejected() {
        for id in [json!(null), json!(true), json!({ "nested": 1 })] {
            let pending = Arc::new(Mutex::new(HashMap::new()));
            let (events, mut receiver) = broadcast::channel(4);
            route_message(
                json!({ "id": id, "method": "item/tool/call", "params": {} }),
                pending,
                events,
            )
            .await;
            assert!(matches!(
                receiver.recv().await.expect("protocol violation"),
                CodexEvent::ProtocolViolation { code }
                    if code == "invalid-server-request-id"
            ));
        }

        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, mut receiver) = broadcast::channel(4);
        route_message(
            json!({
                "id": "x".repeat(MAX_SERVER_REQUEST_ID_BYTES + 1),
                "method": "item/tool/call"
            }),
            pending,
            events,
        )
        .await;
        assert!(matches!(
            receiver.recv().await.expect("protocol violation"),
            CodexEvent::ProtocolViolation { code }
                if code == "invalid-server-request-id"
        ));
    }

    #[tokio::test]
    async fn duplicate_and_unknown_responses_are_reported() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = oneshot::channel();
        pending.lock().await.insert(7, sender);
        let (events, mut event_receiver) = broadcast::channel(8);

        route_message(
            json!({ "id": 7, "result": { "ok": true } }),
            Arc::clone(&pending),
            events.clone(),
        )
        .await;
        receiver
            .await
            .expect("receive response")
            .expect("successful response");

        route_message(
            json!({ "id": 7, "result": { "duplicate": true } }),
            Arc::clone(&pending),
            events.clone(),
        )
        .await;
        assert!(matches!(
            event_receiver.recv().await.expect("duplicate violation"),
            CodexEvent::ProtocolViolation { code } if code == "unknown-response-id"
        ));

        route_message(json!({ "id": "not-ours", "result": null }), pending, events).await;
        assert!(matches!(
            event_receiver.recv().await.expect("unknown violation"),
            CodexEvent::ProtocolViolation { code } if code == "unknown-response-id"
        ));
    }

    #[tokio::test]
    async fn notifications_are_broadcast() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, mut receiver) = broadcast::channel(4);
        route_message(
            json!({ "method": "thread/started", "params": { "id": "t1" } }),
            pending,
            events,
        )
        .await;
        let event = receiver.recv().await.expect("notification");
        assert!(
            matches!(event, CodexEvent::Notification { method, .. } if method == "thread/started")
        );
    }

    #[test]
    fn protocol_ids_are_strictly_bounded() {
        assert!(validate_protocol_id("thread_123", "thread").is_ok());
        assert!(validate_protocol_id("../thread", "thread").is_err());
    }

    #[test]
    fn protocol_errors_redact_obvious_credentials() {
        let error = protocol_error(&json!({
            "code": 42,
            "message": "failed for user@example.test token=not-real"
        }));
        assert_eq!(error, "42: failed for [redacted] [redacted]");
    }

    #[tokio::test]
    async fn malformed_and_oversized_frames_degrade_without_panicking() {
        let invalid_frames = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&invalid_frames);
        read_jsonl(b"{broken}\n".as_slice(), move |frame| {
            let observed = Arc::clone(&observed);
            async move {
                observed.lock().await.push(match frame {
                    JsonlFrame::Invalid => "invalid",
                    JsonlFrame::TooLarge => "too-large",
                    JsonlFrame::Message(_) => "message",
                });
            }
        })
        .await;
        assert_eq!(invalid_frames.lock().await.as_slice(), &["invalid"]);

        let mut oversized = vec![b'x'; MAX_MESSAGE_BYTES + 1];
        oversized.push(b'\n');
        let oversized_frames = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&oversized_frames);
        read_jsonl(oversized.as_slice(), move |frame| {
            let observed = Arc::clone(&observed);
            async move {
                observed
                    .lock()
                    .await
                    .push(matches!(frame, JsonlFrame::TooLarge));
            }
        })
        .await;
        assert_eq!(oversized_frames.lock().await.as_slice(), &[true]);

        let unterminated_oversized = vec![b'x'; MAX_MESSAGE_BYTES + 1];
        let observed = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&observed);
        read_jsonl(unterminated_oversized.as_slice(), move |frame| {
            let captured = Arc::clone(&captured);
            async move {
                captured
                    .lock()
                    .await
                    .push(matches!(frame, JsonlFrame::TooLarge));
            }
        })
        .await;
        assert_eq!(observed.lock().await.as_slice(), &[true]);
    }

    #[test]
    fn oversized_outbound_payload_is_rejected_before_write() {
        let payload = json!({ "payload": "x".repeat(MAX_MESSAGE_BYTES) });
        let error = encode_message(&payload).expect_err("payload must exceed safety limit");
        assert!(matches!(error, IntegratorError::InvalidInput(_)));

        let bounded = encode_message(&json!({ "id": "request-1", "result": null }))
            .expect("small response is accepted");
        assert_eq!(bounded.last(), Some(&b'\n'));

        let oversized_id = ServerRequestId::String("x".repeat(MAX_SERVER_REQUEST_ID_BYTES + 1));
        assert!(oversized_id.validate().is_err());
    }
}
