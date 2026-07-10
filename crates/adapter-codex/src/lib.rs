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
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, broadcast, oneshot},
};

pub const CODEX_PROTOCOL_VERSION: u32 = 2;
const EVENT_CAPACITY: usize = 256;
const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CodexEvent {
    Notification {
        method: String,
        params: Value,
    },
    ServerRequest {
        id: u64,
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
        self.request(
            "thread/start",
            json!({
                "cwd": cwd.to_string_lossy(),
                "model": model,
                "approvalPolicy": "on-request",
                "sandbox": "workspace-write"
            }),
        )
        .await
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

    pub async fn respond_to_server_request(&self, id: u64, result: Value) -> Result<()> {
        self.write_message(json!({ "id": id, "result": result }))
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
        let mut encoded = serde_json::to_vec(&value)?;
        if encoded.len() > MAX_MESSAGE_BYTES {
            return Err(IntegratorError::InvalidInput(
                "Codex protocol message exceeds safety limit".into(),
            ));
        }
        encoded.push(b'\n');
        let mut stdin = self.inner.stdin.lock().await;
        stdin.write_all(&encoded).await?;
        stdin.flush().await?;
        Ok(())
    }
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
    let id = message.get("id").and_then(Value::as_u64);
    let method = message.get("method").and_then(Value::as_str);
    if let (Some(id), Some(method)) = (id, method) {
        let _ = events.send(CodexEvent::ServerRequest {
            id,
            method: method.to_owned(),
            params: message.get("params").cloned().unwrap_or(Value::Null),
        });
        return;
    }
    if let Some(id) = id {
        if let Some(sender) = pending.lock().await.remove(&id) {
            let result = if let Some(error) = message.get("error") {
                Err(IntegratorError::Protocol(protocol_error(error)))
            } else {
                Ok(message.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = sender.send(result);
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
    }
}
