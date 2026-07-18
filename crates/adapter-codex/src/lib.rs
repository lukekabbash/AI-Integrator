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
// Matches adapter-acp: a token-delta burst against a briefly slow consumer
// must not evict load-bearing turn-boundary events from the ring.
const EVENT_CAPACITY: usize = 1024;
const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
/// Bytes of an oversized frame retained for response-id identification.
const DISCARDED_FRAME_HEAD_BYTES: usize = 8 * 1024;
/// Upper bound on a single stdin frame write. Generous: pipe writes to a
/// live local process complete in milliseconds; only a wedged agent that has
/// stopped draining stdin can hit this.
const STDIN_WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
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

#[derive(Clone, Debug, Default)]
pub struct CodexThreadOverrides {
    pub config: Option<Value>,
    pub developer_instructions: Option<String>,
}

/// A skill already resolved by the trusted native host from `skills/list`.
/// The renderer never supplies the filesystem path directly.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexSkillSelection {
    pub name: String,
    pub path: PathBuf,
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
        suppress_windows_console(&mut command);
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

    /// Returns Codex's native skill inventory for the effective working
    /// directory. The app-server owns precedence, plugin expansion, and
    /// system/default skill discovery.
    pub async fn list_skills(&self, cwd: &Path, force_reload: bool) -> Result<Value> {
        if !cwd.is_dir() {
            return Err(IntegratorError::InvalidInput(
                "skill working directory does not exist".into(),
            ));
        }
        self.request(
            "skills/list",
            json!({ "cwds": [cwd.to_string_lossy()], "forceReload": force_reload }),
        )
        .await
    }

    /// Sets the persisted goal state surfaced by Codex `/goal`. Starting the
    /// first turn remains a separate request so callers can use the objective
    /// as both the completion condition and the initial prompt.
    pub async fn set_goal(&self, thread_id: &str, objective: &str) -> Result<Value> {
        validate_protocol_id(thread_id, "thread")?;
        let objective = validate_goal_objective(objective)?;
        self.request(
            "thread/goal/set",
            json!({
                "threadId": thread_id,
                "objective": objective,
                "status": "active",
            }),
        )
        .await
    }

    /// Reads the account's subscription rate-limit windows. Codex is the only
    /// provider that publishes quota (`usedPercent`, `resetsAt`) first-class;
    /// callers persist it so the UI can show subscription pressure without
    /// inferring it.
    pub async fn read_rate_limits(&self) -> Result<Value> {
        self.request("account/rateLimits/read", json!({})).await
    }

    /// Returns provider-owned account token activity. This is account-wide
    /// evidence (including Codex work outside Integrator), not task usage.
    pub async fn read_account_usage(&self) -> Result<Value> {
        self.request("account/usage/read", json!({})).await
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

    pub async fn start_thread(
        &self,
        cwd: &Path,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
    ) -> Result<Value> {
        self.start_thread_with_policies(
            cwd,
            model,
            reasoning_effort,
            "on-request",
            "workspace-write",
        )
        .await
    }

    /// `approval_policy` variant used for delegated subagent threads: those
    /// run unattended, so `"never"` keeps them inside the workspace-write
    /// sandbox instead of blocking forever on an approval nobody answers.
    pub async fn start_thread_with_approval(
        &self,
        cwd: &Path,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
        approval_policy: &str,
    ) -> Result<Value> {
        self.start_thread_with_policies(
            cwd,
            model,
            reasoning_effort,
            approval_policy,
            "workspace-write",
        )
        .await
    }

    /// Full policy control for user-selected permission profiles. Both values
    /// are validated against the app-server vocabulary so a stale UI string
    /// cannot smuggle in an unexpected policy.
    pub async fn start_thread_with_policies(
        &self,
        cwd: &Path,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
        approval_policy: &str,
        sandbox: &str,
    ) -> Result<Value> {
        self.start_thread_with_policies_and_overrides(
            cwd,
            model,
            reasoning_effort,
            approval_policy,
            sandbox,
            CodexThreadOverrides::default(),
        )
        .await
    }

    /// Starts a thread with ephemeral config and developer-instruction layers
    /// owned by the embedding client. Integrator uses these for its
    /// task-scoped broker and durable harness policy without modifying the
    /// user's global or project Codex configuration.
    pub async fn start_thread_with_policies_and_overrides(
        &self,
        cwd: &Path,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
        approval_policy: &str,
        sandbox: &str,
        overrides: CodexThreadOverrides,
    ) -> Result<Value> {
        if !matches!(
            approval_policy,
            "untrusted" | "on-request" | "on-failure" | "never"
        ) {
            return Err(IntegratorError::InvalidInput(
                "unsupported approval policy".into(),
            ));
        }
        if !matches!(
            sandbox,
            "read-only" | "workspace-write" | "danger-full-access"
        ) {
            return Err(IntegratorError::InvalidInput(
                "unsupported sandbox mode".into(),
            ));
        }
        if !cwd.is_dir() {
            return Err(IntegratorError::InvalidInput(
                "thread working directory does not exist".into(),
            ));
        }
        let mut params = json!({
            "cwd": cwd.to_string_lossy(),
            "approvalPolicy": approval_policy,
            "sandbox": sandbox
        });
        if let Some(model) = model {
            // "model": null makes the app-server fall back to "Auto", which
            // ChatGPT-account sessions reject — omit the key entirely instead.
            params["model"] = Value::String(model.into());
        }
        if let Some(effort) = reasoning_effort {
            params["reasoningEffort"] = Value::String(effort.into());
        }
        if let Some(config) = overrides.config {
            if !config.is_object() {
                return Err(IntegratorError::InvalidInput(
                    "thread config must be an object".into(),
                ));
            }
            params["config"] = config;
        }
        if let Some(instructions) = overrides.developer_instructions {
            params["developerInstructions"] = Value::String(instructions);
        }
        self.request("thread/start", params).await
    }

    /// Read the effective Codex configuration for one working directory.
    /// Integrator uses this to preserve user/project developer instructions
    /// when it appends its own thread-scoped harness policy.
    pub async fn read_config(&self, cwd: &Path) -> Result<Value> {
        if !cwd.is_dir() {
            return Err(IntegratorError::InvalidInput(
                "configuration working directory does not exist".into(),
            ));
        }
        self.request(
            "config/read",
            json!({ "cwd": cwd.to_string_lossy(), "includeLayers": false }),
        )
        .await
    }

    /// Starts a disposable, read-only helper thread that is excluded from
    /// Codex history. This intentionally exposes no general policy controls.
    pub async fn start_ephemeral_read_only_thread(
        &self,
        cwd: &Path,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
    ) -> Result<Value> {
        if !cwd.is_dir() {
            return Err(IntegratorError::InvalidInput(
                "thread working directory does not exist".into(),
            ));
        }
        let mut params = json!({
            "cwd": cwd.to_string_lossy(),
            "approvalPolicy": "never",
            "sandbox": "read-only",
            "ephemeral": true
        });
        if let Some(model) = model {
            params["model"] = Value::String(model.into());
        }
        if let Some(effort) = reasoning_effort {
            params["reasoningEffort"] = Value::String(effort.into());
        }
        self.request("thread/start", params).await
    }

    pub async fn resume_thread(&self, thread_id: &str) -> Result<Value> {
        self.resume_thread_with_developer_instructions(thread_id, None)
            .await
    }

    pub async fn resume_thread_with_developer_instructions(
        &self,
        thread_id: &str,
        developer_instructions: Option<&str>,
    ) -> Result<Value> {
        validate_protocol_id(thread_id, "thread")?;
        let mut params = json!({ "threadId": thread_id });
        if let Some(instructions) = developer_instructions {
            params["developerInstructions"] = Value::String(instructions.into());
        }
        self.request("thread/resume", params).await
    }

    pub async fn start_turn(&self, thread_id: &str, prompt: &str) -> Result<Value> {
        self.start_turn_with_skill(thread_id, prompt, None).await
    }

    /// Starts a turn with optional native skill and local image attachments
    /// (used when seeding a fresh session from Integrator's shared handoff).
    pub async fn start_turn_with_skill(
        &self,
        thread_id: &str,
        prompt: &str,
        skill: Option<&CodexSkillSelection>,
    ) -> Result<Value> {
        self.start_turn_with_skill_and_images(thread_id, prompt, skill, &[])
            .await
    }

    pub async fn start_turn_with_skill_and_images(
        &self,
        thread_id: &str,
        prompt: &str,
        skill: Option<&CodexSkillSelection>,
        image_paths: &[PathBuf],
    ) -> Result<Value> {
        validate_protocol_id(thread_id, "thread")?;
        let mut input = turn_text_input(prompt)?;
        for path in image_paths {
            if !path.is_absolute() || path.as_os_str().len() > 32 * 1024 {
                continue;
            }
            if !path.is_file() {
                continue;
            }
            input.push(json!({
                "type": "localImage",
                "path": path.to_string_lossy(),
            }));
        }
        if let Some(skill) = skill {
            validate_skill_selection(skill)?;
            input.push(json!({
                "type": "skill",
                "name": skill.name,
                "path": skill.path.to_string_lossy(),
            }));
        }
        self.request(
            "turn/start",
            json!({ "threadId": thread_id, "input": input }),
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

    pub async fn steer_turn(
        &self,
        thread_id: &str,
        expected_turn_id: &str,
        prompt: &str,
    ) -> Result<Value> {
        self.request(
            "turn/steer",
            steer_turn_params(thread_id, expected_turn_id, prompt)?,
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
        let response = self
            .request(
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
            .await?;

        // Codex app-server completes the JSON-RPC handshake only after this
        // notification.
        self.write_message(json!({
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
        // Bounded write: a healthy agent drains its stdin pipe in
        // milliseconds even for the largest allowed frame. Without a bound,
        // an agent that stops reading parks this write holding the stdin
        // mutex, and interrupt/cancel paths queue behind it forever.
        tokio::time::timeout(STDIN_WRITE_TIMEOUT, async {
            stdin.write_all(&encoded).await?;
            stdin.flush().await
        })
        .await
        .map_err(|_| {
            IntegratorError::Unavailable("Codex agent stopped reading its stdin".into())
        })??;
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
                    JsonlFrame::Invalid(bytes) => {
                        fail_discarded_response(&bytes, &pending, &events, "invalid-json").await;
                    }
                    JsonlFrame::TooLarge(head) => {
                        fail_discarded_response(&head, &pending, &events, "message-too-large")
                            .await;
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
    pending: &Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>,
    events: &broadcast::Sender<CodexEvent>,
    code: &str,
) {
    let _ = events.send(CodexEvent::ProtocolViolation { code: code.into() });
    let Some(id) = discarded_response_id(bytes) else {
        return;
    };
    let Some(sender) = pending.lock().await.remove(&id) else {
        return;
    };
    let _ = sender.send(Err(IntegratorError::Unavailable(format!(
        "Codex agent response was discarded ({code})"
    ))));
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

fn turn_text_input(prompt: &str) -> Result<Vec<Value>> {
    let prompt = prompt.trim();
    if prompt.is_empty() || prompt.len() > 2 * 1024 * 1024 {
        return Err(IntegratorError::InvalidInput(
            "prompt must contain 1 byte to 2 MiB".into(),
        ));
    }
    Ok(vec![
        json!({ "type": "text", "text": prompt, "text_elements": [] }),
    ])
}

fn steer_turn_params(thread_id: &str, expected_turn_id: &str, prompt: &str) -> Result<Value> {
    validate_protocol_id(thread_id, "thread")?;
    validate_protocol_id(expected_turn_id, "turn")?;
    Ok(json!({
        "threadId": thread_id,
        "input": turn_text_input(prompt)?,
        "expectedTurnId": expected_turn_id,
    }))
}

fn validate_skill_selection(skill: &CodexSkillSelection) -> Result<()> {
    if skill.name.trim().is_empty() || skill.name.len() > 256 || skill.name.contains(['\r', '\n']) {
        return Err(IntegratorError::InvalidInput(
            "invalid Codex skill name".into(),
        ));
    }
    if !skill.path.is_absolute() || skill.path.as_os_str().len() > 32 * 1024 {
        return Err(IntegratorError::InvalidInput(
            "invalid Codex skill path".into(),
        ));
    }
    Ok(())
}

fn validate_goal_objective(objective: &str) -> Result<&str> {
    let objective = objective.trim();
    if objective.is_empty() || objective.chars().count() > 4_000 {
        return Err(IntegratorError::InvalidInput(
            "Codex goal must contain 1 to 4,000 characters".into(),
        ));
    }
    Ok(objective)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_selection_rejects_renderer_style_relative_paths_and_control_text() {
        assert!(
            validate_skill_selection(&CodexSkillSelection {
                name: "skill-creator".into(),
                path: PathBuf::from("relative/SKILL.md"),
            })
            .is_err()
        );
        assert!(
            validate_skill_selection(&CodexSkillSelection {
                name: "bad\nname".into(),
                path: std::env::temp_dir().join("SKILL.md"),
            })
            .is_err()
        );
    }

    #[test]
    fn goal_objective_uses_the_provider_character_limit() {
        assert_eq!(
            validate_goal_objective("  ship it  ").expect("valid goal objective"),
            "ship it"
        );
        assert!(validate_goal_objective("").is_err());
        assert!(validate_goal_objective(&"x".repeat(4_000)).is_ok());
        assert!(validate_goal_objective(&"x".repeat(4_001)).is_err());
    }

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
    fn steer_turn_uses_the_active_turn_contract_and_bounded_text_input() {
        assert_eq!(
            steer_turn_params("thread-1", "turn-1", "  follow up  ")
                .expect("valid steering params"),
            json!({
                "threadId": "thread-1",
                "input": [{ "type": "text", "text": "follow up", "text_elements": [] }],
                "expectedTurnId": "turn-1",
            })
        );
        assert!(steer_turn_params("../thread", "turn-1", "follow up").is_err());
        assert!(steer_turn_params("thread-1", "turn-1", "   ").is_err());
        assert!(steer_turn_params("thread-1", "turn-1", &"x".repeat(2 * 1024 * 1024 + 1)).is_err());
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
                    JsonlFrame::Invalid(_) => "invalid",
                    JsonlFrame::TooLarge(_) => "too-large",
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
                    .push(matches!(frame, JsonlFrame::TooLarge(_)));
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
                    .push(matches!(frame, JsonlFrame::TooLarge(_)));
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
