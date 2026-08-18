use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use crate::auto_review::{BoundaryKind, BoundaryRequest};
use crate::structured_projection::structured_json_detail;
use integrator_core::{IntegratorError, Result};
use integrator_runtime::{
    StructuredCliClient, StructuredCliEventKind, StructuredPermissionMode, redact_and_bound,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const HOOK_INPUT_LIMIT: u64 = 1024 * 1024;
const HOOK_DETAIL_LIMIT: usize = 64 * 1024;
const DEFAULT_REVIEW_WAIT: Duration = Duration::from_millis(12_000);
const REVIEW_POLL: Duration = Duration::from_millis(40);

pub struct AntigravityOverlay {
    pub root: PathBuf,
    pub event_log: PathBuf,
    /// Sibling of `root`, never `--add-dir`'d, so the agent cannot forge a
    /// verdict by writing into the mailbox the hook and host share.
    pub reviews: PathBuf,
}

#[derive(Clone, Copy, Debug)]
pub enum AntigravityOverlayPolicy {
    Harness(crate::harness_prompt::LocalToolsProjection),
    Chat { memory_enabled: bool },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HookRecord {
    phase: String,
    conversation_id: Option<String>,
    step_idx: Option<u64>,
    tool_name: Option<String>,
    tool_input: Option<String>,
    is_error: bool,
    message: Option<String>,
    decision: Option<String>,
    termination_reason: Option<String>,
    fully_idle: Option<bool>,
}

pub fn create_overlay(
    data_directory: &Path,
    workspace: &Path,
    scope: &str,
    permission: StructuredPermissionMode,
    policy: AntigravityOverlayPolicy,
    browser: crate::harness_prompt::ExternalBrowserHandoff,
    hook_profile: Option<&str>,
) -> Result<AntigravityOverlay> {
    let root = data_directory.join("antigravity-control").join(scope);
    let reviews = data_directory
        .join("antigravity-control")
        .join(format!("{scope}.reviews"));
    let agents = root.join(".agents");
    let rules = agents.join("rules");
    fs::create_dir_all(&agents).map_err(IntegratorError::from)?;
    fs::create_dir_all(&rules).map_err(IntegratorError::from)?;
    if reviews.exists() {
        let _ = fs::remove_dir_all(&reviews);
    }
    fs::create_dir_all(&reviews).map_err(IntegratorError::from)?;
    #[cfg(unix)]
    {
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .map_err(IntegratorError::from)?;
        fs::set_permissions(&agents, fs::Permissions::from_mode(0o700))
            .map_err(IntegratorError::from)?;
        fs::set_permissions(&rules, fs::Permissions::from_mode(0o700))
            .map_err(IntegratorError::from)?;
        fs::set_permissions(&reviews, fs::Permissions::from_mode(0o700))
            .map_err(IntegratorError::from)?;
    }

    let event_log = root.join("events.jsonl");
    secure_file(&event_log)?;
    let executable = std::env::current_exe().map_err(IntegratorError::from)?;
    let hook_permission = match policy {
        AntigravityOverlayPolicy::Chat {
            memory_enabled: true,
        } => "chat-memory",
        AntigravityOverlayPolicy::Chat {
            memory_enabled: false,
        } => "chat",
        AntigravityOverlayPolicy::Harness(_) if hook_profile == Some("auto") => "auto",
        AntigravityOverlayPolicy::Harness(_) => permission_name(permission),
    };
    let command = |phase: &str| {
        [
            shell_arg(&executable.to_string_lossy()),
            "--antigravity-hook".into(),
            shell_arg(phase),
            shell_arg(&event_log.to_string_lossy()),
            shell_arg(&workspace.to_string_lossy()),
            shell_arg(&root.to_string_lossy()),
            shell_arg(hook_permission),
            shell_arg(&reviews.to_string_lossy()),
        ]
        .join(" ")
    };
    let config = json!({
        "integrator-observer": {
            "PreInvocation": [{ "type": "command", "command": command("PreInvocation") }],
            "PreToolUse": [{
                "matcher": "*",
                "hooks": [{ "type": "command", "command": command("PreToolUse") }]
            }],
            "PostToolUse": [{
                "matcher": "*",
                "hooks": [{ "type": "command", "command": command("PostToolUse") }]
            }],
            "PostInvocation": [{ "type": "command", "command": command("PostInvocation") }],
            "Stop": [{ "type": "command", "command": command("Stop") }]
        }
    });
    write_private_json(&agents.join("hooks.json"), &config)?;
    let instructions = match policy {
        AntigravityOverlayPolicy::Harness(local_tools) => crate::harness_prompt::instructions(
            integrator_core::ProviderKind::Antigravity,
            local_tools,
            browser,
        ),
        AntigravityOverlayPolicy::Chat { memory_enabled } => {
            crate::harness_prompt::chat_developer_instructions(memory_enabled, browser)
        }
    };
    write_private_text(&rules.join("ai-integrator.md"), &instructions)?;
    Ok(AntigravityOverlay {
        root,
        event_log,
        reviews,
    })
}

pub fn write_review_wait_ms(reviews: &Path, ms: u64) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(reviews.join("wait-ms"))
        .map_err(IntegratorError::from)?;
    write!(file, "{ms}").map_err(IntegratorError::from)
}

pub fn event_log_offset(path: &Path) -> u64 {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

pub fn watch_events(
    path: PathBuf,
    offset: u64,
    client: StructuredCliClient,
    turn_id: String,
    alive: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let Ok(file) = File::open(path) else {
            return;
        };
        let mut reader = BufReader::new(file);
        if reader.seek(SeekFrom::Start(offset)).is_err() {
            return;
        }
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) if alive.load(Ordering::Acquire) => {
                    std::thread::sleep(Duration::from_millis(40));
                }
                Ok(0) => break,
                Ok(_) => {
                    if let Ok(record) = serde_json::from_str::<HookRecord>(line.trim()) {
                        publish_record(&client, &turn_id, record);
                    }
                }
                Err(_) => break,
            }
        }
    });
}

fn publish_record(client: &StructuredCliClient, turn_id: &str, record: HookRecord) {
    let session_id = record.conversation_id.clone();
    let item_id = format!("agy-tool-{}", record.step_idx.unwrap_or(0));
    match record.phase.as_str() {
        "PreToolUse" => {
            client.emit_host_event(
                turn_id,
                session_id.clone(),
                StructuredCliEventKind::ToolUse {
                    id: item_id.clone(),
                    name: record.tool_name.unwrap_or_else(|| "Runtime event".into()),
                    input: record
                        .tool_input
                        .as_deref()
                        .and_then(|input| serde_json::from_str(input).ok())
                        .unwrap_or(Value::Null),
                },
            );
            if record.decision.as_deref() == Some("deny") {
                client.emit_host_event(
                    turn_id,
                    session_id,
                    StructuredCliEventKind::ToolDenied {
                        id: item_id,
                        content: record
                            .message
                            .unwrap_or_else(|| "Antigravity denied this action".into()),
                    },
                );
            }
        }
        "PostToolUse" => client.emit_host_event(
            turn_id,
            session_id,
            StructuredCliEventKind::ToolResult {
                id: item_id,
                is_error: record.is_error,
                content: record.message.unwrap_or_default(),
            },
        ),
        // The model invocation has begun. Not user-visible on its own, but it
        // updates the turn's diagnostic context so a turn that dies before
        // its first tool call reports "accepted and working" instead of
        // nothing. (Visible agy progress needs the brain-transcript tail.)
        "PreInvocation" => client.emit_host_event(
            turn_id,
            session_id,
            StructuredCliEventKind::Diagnostic {
                message: "Antigravity accepted the request and is working".into(),
            },
        ),
        "Stop" if record.fully_idle == Some(false) => client.emit_host_event(
            turn_id,
            session_id,
            StructuredCliEventKind::Diagnostic {
                message: format!(
                    "Antigravity stopped with background work still active ({})",
                    record
                        .termination_reason
                        .as_deref()
                        .unwrap_or("unknown reason")
                ),
            },
        ),
        _ => {}
    }
}

pub fn run_hook() -> i32 {
    let args = std::env::args().collect::<Vec<_>>();
    let Some(index) = args
        .iter()
        .position(|argument| argument == "--antigravity-hook")
    else {
        return 2;
    };
    let Some(phase) = args.get(index + 1) else {
        return 2;
    };
    let Some(event_log) = args.get(index + 2).map(PathBuf::from) else {
        return 2;
    };
    let Some(workspace) = args.get(index + 3).map(PathBuf::from) else {
        return 2;
    };
    let Some(overlay) = args.get(index + 4).map(PathBuf::from) else {
        return 2;
    };
    let permission = args
        .get(index + 5)
        .map(String::as_str)
        .unwrap_or("read-only");
    let reviews = args.get(index + 6).map(PathBuf::from);

    let mut bytes = Vec::new();
    if std::io::stdin()
        .take(HOOK_INPUT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return write_hook_response(
            phase,
            "deny",
            Some("Integrator could not inspect the action"),
        );
    }
    let input = match parse_hook_input(&bytes) {
        Ok(input) => input,
        Err(reason) => return write_hook_response(phase, "deny", Some(reason)),
    };
    let (decision, reason) = if phase == "PreToolUse" {
        decide_pre_tool_use(&input, &workspace, &overlay, permission, reviews.as_deref())
    } else {
        ("allow".into(), None)
    };
    let record = hook_record(phase, &input, &decision, reason.as_deref());
    if append_record(&event_log, &overlay, &record).is_err() {
        return write_hook_response(
            phase,
            "deny",
            Some("Integrator could not record the action"),
        );
    }
    write_hook_response(phase, &decision, reason.as_deref())
}

fn parse_hook_input(bytes: &[u8]) -> std::result::Result<Value, &'static str> {
    if bytes.len() as u64 > HOOK_INPUT_LIMIT {
        return Err("The runtime action was too large to inspect safely");
    }
    serde_json::from_slice(bytes).map_err(|_| "The runtime action could not be inspected safely")
}

fn hook_record(phase: &str, input: &Value, decision: &str, reason: Option<&str>) -> HookRecord {
    let tool_call = input.get("toolCall");
    let tool_input = tool_call
        .and_then(|call| call.get("args"))
        .and_then(|args| serde_json::to_string(args).ok())
        .map(|detail| redact_and_bound(&detail, HOOK_DETAIL_LIMIT).0);
    let provider_error = input
        .get("error")
        .and_then(Value::as_str)
        .filter(|error| !error.is_empty());
    let message = reason
        .or(provider_error)
        .map(|message| redact_and_bound(message, HOOK_DETAIL_LIMIT).0);
    HookRecord {
        phase: phase.into(),
        conversation_id: input
            .get("conversationId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        step_idx: input.get("stepIdx").and_then(Value::as_u64),
        tool_name: tool_call
            .and_then(|call| call.get("name"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        tool_input,
        is_error: provider_error.is_some(),
        message,
        decision: (phase == "PreToolUse").then(|| decision.to_owned()),
        termination_reason: input
            .get("terminationReason")
            .and_then(Value::as_str)
            .map(str::to_owned),
        fully_idle: input.get("fullyIdle").and_then(Value::as_bool),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum HookGate {
    Allow,
    Deny(&'static str),
    Review(BoundaryKind),
}

fn decide_pre_tool_use(
    input: &Value,
    workspace: &Path,
    overlay: &Path,
    permission: &str,
    reviews: Option<&Path>,
) -> (String, Option<String>) {
    match hook_gate(input, workspace, overlay, permission) {
        HookGate::Allow => ("allow".into(), None),
        HookGate::Deny(reason) => ("deny".into(), Some(reason.into())),
        HookGate::Review(kind) => {
            let Some(reviews) = reviews else {
                return (
                    "deny".into(),
                    Some("the Auto reviewer mailbox is missing".into()),
                );
            };
            request_auto_review(reviews, &boundary_from_hook(kind, input, workspace))
        }
    }
}

fn hook_gate(input: &Value, workspace: &Path, overlay: &Path, permission: &str) -> HookGate {
    let tool_call = input.get("toolCall");
    let name = tool_call
        .and_then(|call| call.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let args = tool_call
        .and_then(|call| call.get("args"))
        .unwrap_or(&Value::Null);

    if permission.starts_with("chat")
        && !is_chat_scheduling_tool(name)
        && !(permission == "chat-memory" && is_chat_memory_tool(name))
    {
        return HookGate::Deny("Tools are unavailable in AI Integrator Chat");
    }
    if permission == "read-only" && is_mutating_tool(name) {
        return HookGate::Deny("This task is read-only");
    }
    for path in tool_paths(args) {
        let candidate = canonical_candidate(workspace, &path);
        if candidate.starts_with(overlay) && is_mutating_tool(name) {
            return HookGate::Deny("Integrator control files cannot be modified");
        }
        if !candidate.starts_with(workspace) && !candidate.starts_with(overlay) {
            return HookGate::Deny("This action is outside the selected workspace");
        }
    }
    if is_mutating_tool(name)
        && args
            .get("CommandLine")
            .or_else(|| args.get("command"))
            .and_then(Value::as_str)
            .is_some_and(|command| command.contains(&overlay.to_string_lossy().to_string()))
    {
        return HookGate::Deny("Integrator control files cannot be modified");
    }
    if permission == "auto"
        && let Some(kind) = review_kind(name)
    {
        return HookGate::Review(kind);
    }
    HookGate::Allow
}

fn review_kind(name: &str) -> Option<BoundaryKind> {
    match name {
        "run_command" => Some(BoundaryKind::Shell),
        "web_fetch" | "web_search" | "WebFetch" | "WebSearch" => Some(BoundaryKind::Network),
        other
            if other.eq_ignore_ascii_case("webfetch")
                || other.eq_ignore_ascii_case("websearch") =>
        {
            Some(BoundaryKind::Network)
        }
        _ => None,
    }
}

fn boundary_from_hook(kind: BoundaryKind, input: &Value, workspace: &Path) -> BoundaryRequest {
    let tool_call = input.get("toolCall");
    let name = tool_call
        .and_then(|call| call.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let args = tool_call
        .and_then(|call| call.get("args"))
        .unwrap_or(&Value::Null);
    let summary = args
        .get("CommandLine")
        .or_else(|| args.get("command"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("Use the {name} tool"));
    BoundaryRequest {
        kind,
        summary,
        detail: format!(
            "tool: {name}\ninput:\n{}",
            structured_json_detail(args).unwrap_or_else(|| "(none)".into())
        ),
        cwd: workspace.to_path_buf(),
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewMailboxRequest {
    pub id: String,
    pub kind: String,
    pub tool_name: String,
    pub summary: String,
    pub detail: String,
    pub cwd: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewMailboxResponse {
    pub id: String,
    pub decision: String,
    pub reason: Option<String>,
}

pub fn write_review_response(reviews: &Path, response: &ReviewMailboxResponse) -> Result<()> {
    let path = reviews_child(reviews, &format!("{}.res.json", response.id))?;
    write_json_atomic(&path, &serde_json::to_value(response)?)
}

pub fn read_review_request(path: &Path) -> Result<ReviewMailboxRequest> {
    let text = fs::read_to_string(path).map_err(IntegratorError::from)?;
    serde_json::from_str(&text).map_err(IntegratorError::from)
}

pub fn pending_review_request_paths(reviews: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(reviews) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                return false;
            };
            if !name.ends_with(".req.json") {
                return false;
            }
            let id = name.trim_end_matches(".req.json");
            !reviews.join(format!("{id}.res.json")).exists()
        })
        .collect()
}

pub fn mailbox_boundary_request(request: &ReviewMailboxRequest) -> BoundaryRequest {
    BoundaryRequest {
        kind: match request.kind.as_str() {
            "shell" => BoundaryKind::Shell,
            "network" => BoundaryKind::Network,
            "file outside the workspace root" => BoundaryKind::FileOutsideRoot,
            _ => BoundaryKind::ToolCall,
        },
        summary: request.summary.clone(),
        detail: request.detail.clone(),
        cwd: PathBuf::from(&request.cwd),
    }
}

fn request_auto_review(reviews: &Path, request: &BoundaryRequest) -> (String, Option<String>) {
    let id = uuid::Uuid::new_v4().to_string();
    let payload = ReviewMailboxRequest {
        id: id.clone(),
        kind: request.kind.as_str().to_owned(),
        tool_name: request
            .detail
            .lines()
            .next()
            .and_then(|line| line.strip_prefix("tool: "))
            .unwrap_or("tool")
            .to_owned(),
        summary: request.summary.clone(),
        detail: request.detail.clone(),
        cwd: request.cwd.to_string_lossy().into_owned(),
    };
    let req_path = match reviews_child(reviews, &format!("{id}.req.json")) {
        Ok(path) => path,
        Err(_) => {
            return (
                "deny".into(),
                Some("the Auto reviewer mailbox is missing".into()),
            );
        }
    };
    let Ok(payload) = serde_json::to_value(&payload) else {
        return (
            "deny".into(),
            Some("Integrator could not ask the Auto reviewer".into()),
        );
    };
    if write_json_atomic(&req_path, &payload).is_err() {
        return (
            "deny".into(),
            Some("Integrator could not ask the Auto reviewer".into()),
        );
    }
    let res_path = reviews.join(format!("{id}.res.json"));
    let deadline = Instant::now() + read_review_wait_ms(reviews);
    while Instant::now() < deadline {
        if let Ok(text) = fs::read_to_string(&res_path)
            && let Ok(response) = serde_json::from_str::<ReviewMailboxResponse>(&text)
            && response.id == id
            && (response.decision == "allow" || response.decision == "deny")
        {
            return (response.decision, response.reason);
        }
        std::thread::sleep(REVIEW_POLL);
    }
    (
        "deny".into(),
        Some("the Auto reviewer did not answer in time".into()),
    )
}

fn read_review_wait_ms(reviews: &Path) -> Duration {
    fs::read_to_string(reviews.join("wait-ms"))
        .ok()
        .and_then(|text| text.trim().parse().ok())
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_REVIEW_WAIT)
}

fn reviews_child(reviews: &Path, name: &str) -> Result<PathBuf> {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(IntegratorError::Unauthorized(
            "review mailbox name escaped the reviews directory".into(),
        ));
    }
    Ok(reviews.join(name))
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<()> {
    let tmp = path.with_extension("tmp");
    write_private_json(&tmp, value)?;
    fs::rename(&tmp, path).map_err(IntegratorError::from)
}

fn is_chat_memory_tool(name: &str) -> bool {
    matches!(
        name,
        "memory_save" | "integrator__memory_save" | "mcp__integrator__memory_save"
    )
}

fn is_chat_scheduling_tool(name: &str) -> bool {
    let name = name
        .strip_prefix("mcp__integrator__")
        .or_else(|| name.strip_prefix("integrator__"))
        .unwrap_or(name);
    matches!(
        name,
        "schedule_wakeup"
            | "schedule_recurring"
            | "automation_list"
            | "automation_leave_note"
            | "automation_cancel"
    )
}

fn is_mutating_tool(name: &str) -> bool {
    matches!(
        name,
        "run_command"
            | "write_to_file"
            | "replace_file_content"
            | "multi_replace_file_content"
            | "delete_file"
            | "move_file"
    )
}

fn tool_paths(value: &Value) -> Vec<PathBuf> {
    let Some(object) = value.as_object() else {
        return Vec::new();
    };
    object
        .iter()
        .filter_map(|(key, value)| {
            let key = key.to_ascii_lowercase();
            let is_path = matches!(
                key.as_str(),
                "absolutepath" | "targetfile" | "directorypath" | "path" | "filepath" | "file_path"
            );
            is_path.then(|| value.as_str()).flatten().map(PathBuf::from)
        })
        .collect()
}

fn canonical_candidate(workspace: &Path, path: &Path) -> PathBuf {
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        workspace.join(path)
    };
    if let Ok(canonical) = dunce::canonicalize(&candidate) {
        return canonical;
    }
    normalize_path(candidate)
}

fn normalize_path(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn append_record(path: &Path, overlay: &Path, record: &HookRecord) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| IntegratorError::Unauthorized("hook event path has no parent".into()))?;
    let parent = dunce::canonicalize(parent).map_err(IntegratorError::from)?;
    let overlay = dunce::canonicalize(overlay).map_err(IntegratorError::from)?;
    if !parent.starts_with(overlay) {
        return Err(IntegratorError::Unauthorized(
            "hook event path escaped the control overlay".into(),
        ));
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).map_err(IntegratorError::from)?;
    serde_json::to_writer(&mut file, record)?;
    file.write_all(b"\n").map_err(IntegratorError::from)
}

fn secure_file(path: &Path) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path).map_err(IntegratorError::from)?;
    Ok(())
}

fn write_private_json(path: &Path, value: &Value) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).map_err(IntegratorError::from)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n").map_err(IntegratorError::from)
}

fn write_private_text(path: &Path, value: &str) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).map_err(IntegratorError::from)?;
    file.write_all(value.as_bytes())
        .map_err(IntegratorError::from)?;
    file.write_all(b"\n").map_err(IntegratorError::from)
}

fn write_hook_response(phase: &str, decision: &str, reason: Option<&str>) -> i32 {
    let response = match phase {
        "PreToolUse" => json!({ "decision": decision, "reason": reason }),
        "Stop" => json!({ "decision": "stop" }),
        _ => json!({}),
    };
    if serde_json::to_writer(std::io::stdout(), &response).is_ok() {
        0
    } else {
        1
    }
}

fn permission_name(permission: StructuredPermissionMode) -> &'static str {
    match permission {
        StructuredPermissionMode::Prompt => "ask",
        StructuredPermissionMode::ReadOnly => "read-only",
        StructuredPermissionMode::Chat => "chat",
        StructuredPermissionMode::AcceptEdits => "project-write",
        StructuredPermissionMode::BypassPermissions => "full-access",
    }
}

#[cfg(unix)]
fn shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(windows)]
fn shell_arg(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_policy_denies_read_only_mutation_and_workspace_escape() {
        let root = tempfile::tempdir().expect("workspace");
        let overlay = tempfile::tempdir().expect("overlay");
        let write = json!({
            "toolCall": { "name": "write_to_file", "args": { "TargetFile": root.path().join("ok.txt") } }
        });
        assert_eq!(
            hook_gate(&write, root.path(), overlay.path(), "read-only"),
            HookGate::Deny("This task is read-only")
        );
        let escape = json!({
            "toolCall": { "name": "view_file", "args": { "AbsolutePath": "/etc/hosts" } }
        });
        assert_eq!(
            hook_gate(&escape, root.path(), overlay.path(), "project-write"),
            HookGate::Deny("This action is outside the selected workspace")
        );

        let read = json!({
            "toolCall": { "name": "view_file", "args": { "AbsolutePath": root.path().join("ok.txt") } }
        });
        assert_eq!(
            hook_gate(&read, root.path(), overlay.path(), "chat"),
            HookGate::Deny("Tools are unavailable in AI Integrator Chat")
        );
        let memory = json!({
            "toolCall": { "name": "mcp__integrator__memory_save", "args": { "text": "Prefers concise replies" } }
        });
        assert_eq!(
            hook_gate(&memory, root.path(), overlay.path(), "chat-memory"),
            HookGate::Allow
        );
        let schedule = json!({
            "toolCall": { "name": "mcp__integrator__schedule_recurring", "args": {} }
        });
        assert_eq!(
            hook_gate(&schedule, root.path(), overlay.path(), "chat"),
            HookGate::Allow
        );
        assert_eq!(
            hook_gate(&read, root.path(), overlay.path(), "chat-memory"),
            HookGate::Deny("Tools are unavailable in AI Integrator Chat")
        );
    }

    #[test]
    fn hook_payloads_fail_closed_when_malformed_or_oversized() {
        assert_eq!(
            parse_hook_input(b"not-json"),
            Err("The runtime action could not be inspected safely")
        );
        let oversized = vec![b' '; HOOK_INPUT_LIMIT as usize + 1];
        assert_eq!(
            parse_hook_input(&oversized),
            Err("The runtime action was too large to inspect safely")
        );
    }

    #[test]
    fn overlay_stays_outside_the_workspace_and_declares_every_hook_phase() {
        let data = tempfile::tempdir().expect("app data");
        let workspace = tempfile::tempdir().expect("workspace");
        let overlay = create_overlay(
            data.path(),
            workspace.path(),
            "scope-1",
            StructuredPermissionMode::AcceptEdits,
            AntigravityOverlayPolicy::Harness(
                crate::harness_prompt::LocalToolsProjection::Unavailable,
            ),
            crate::harness_prompt::ExternalBrowserHandoff::IntegratorOnly,
            None,
        )
        .expect("create overlay");

        assert!(overlay.root.starts_with(data.path()));
        assert!(overlay.reviews.starts_with(data.path()));
        assert!(!overlay.reviews.starts_with(&overlay.root));
        assert!(!overlay.root.starts_with(workspace.path()));
        assert!(!workspace.path().join(".agents/hooks.json").exists());
        let config = std::fs::read_to_string(overlay.root.join(".agents/hooks.json"))
            .expect("read hook config");
        for phase in [
            "PreInvocation",
            "PreToolUse",
            "PostToolUse",
            "PostInvocation",
            "Stop",
        ] {
            assert!(config.contains(phase), "missing {phase}");
        }
        assert!(config.contains("--antigravity-hook"));
        assert!(config.contains("project-write"));
        let harness = std::fs::read_to_string(overlay.root.join(".agents/rules/ai-integrator.md"))
            .expect("read harness rule");
        assert!(harness.contains("durable harness policy"));
        assert!(harness.contains("using the antigravity runtime"));
        assert!(harness.contains("delegation are unavailable"));
        assert!(harness.contains("External-browser handoff is off"));
    }

    #[test]
    fn overlay_harness_reports_projected_integrator_tools_truthfully() {
        let data = tempfile::tempdir().expect("app data");
        let workspace = tempfile::tempdir().expect("workspace");
        let overlay = create_overlay(
            data.path(),
            workspace.path(),
            "scope-tools",
            StructuredPermissionMode::ReadOnly,
            AntigravityOverlayPolicy::Harness(
                crate::harness_prompt::LocalToolsProjection::Projected,
            ),
            crate::harness_prompt::ExternalBrowserHandoff::IntegratorOnly,
            None,
        )
        .expect("create overlay");

        let harness = std::fs::read_to_string(overlay.root.join(".agents/rules/ai-integrator.md"))
            .expect("read harness rule");
        assert!(harness.contains("task-scoped MCP server named `integrator`"));
        assert!(harness.contains("call them directly"));
        assert!(!harness.contains("delegation are unavailable"));
        assert!(harness.contains("External-browser handoff is off"));
    }

    #[test]
    fn chat_overlay_installs_the_conversational_rule_and_denies_general_tools() {
        let data = tempfile::tempdir().expect("app data");
        let workspace = tempfile::tempdir().expect("workspace");
        let overlay = create_overlay(
            data.path(),
            workspace.path(),
            "chat-scope",
            StructuredPermissionMode::Chat,
            AntigravityOverlayPolicy::Chat {
                memory_enabled: true,
            },
            crate::harness_prompt::ExternalBrowserHandoff::IntegratorOnly,
            None,
        )
        .expect("create Chat overlay");

        let rule = std::fs::read_to_string(overlay.root.join(".agents/rules/ai-integrator.md"))
            .expect("read Chat rule");
        assert!(rule.contains("This is not a coding-agent session"));
        assert!(rule.contains("`memory_save`"));
        assert!(rule.contains("schedule_recurring"));
        assert!(rule.contains("External-browser handoff is off"));
        let hooks = std::fs::read_to_string(overlay.root.join(".agents/hooks.json"))
            .expect("read Chat hooks");
        assert!(hooks.contains("chat-memory"));
    }

    #[test]
    fn hook_policy_allows_project_reads_and_protects_the_overlay() {
        let root = tempfile::tempdir().expect("workspace");
        let overlay = tempfile::tempdir().expect("overlay");
        let read = json!({
            "toolCall": { "name": "view_file", "args": { "AbsolutePath": root.path().join("alpha.txt") } }
        });
        assert_eq!(
            hook_gate(&read, root.path(), overlay.path(), "project-write"),
            HookGate::Allow
        );
        let edit_overlay = json!({
            "toolCall": { "name": "write_to_file", "args": { "TargetFile": overlay.path().join("hooks.json") } }
        });
        assert_eq!(
            hook_gate(&edit_overlay, root.path(), overlay.path(), "full-access"),
            HookGate::Deny("Integrator control files cannot be modified")
        );
    }

    #[test]
    fn denied_hook_records_emit_one_declined_tool_lifecycle() {
        let client = StructuredCliClient::new();
        let mut receiver = client.subscribe();
        publish_record(
            &client,
            "turn-1",
            HookRecord {
                phase: "PreToolUse".into(),
                conversation_id: Some("conversation-1".into()),
                step_idx: Some(4),
                tool_name: Some("view_file".into()),
                tool_input: Some(r#"{"AbsolutePath":"/outside.txt"}"#.into()),
                is_error: false,
                message: Some("This action is outside the selected workspace".into()),
                decision: Some("deny".into()),
                termination_reason: None,
                fully_idle: None,
            },
        );

        let started = receiver.try_recv().expect("tool start");
        assert!(matches!(
            started.event,
            StructuredCliEventKind::ToolUse { ref id, ref name, .. }
                if id == "agy-tool-4" && name == "view_file"
        ));
        let denied = receiver.try_recv().expect("tool denial");
        assert!(matches!(
            denied.event,
            StructuredCliEventKind::ToolDenied { ref id, ref content }
                if id == "agy-tool-4" && content.contains("outside")
        ));
    }

    #[test]
    fn auto_reviews_shell_and_allows_in_workspace_edits() {
        let root = tempfile::tempdir().expect("workspace");
        let overlay = tempfile::tempdir().expect("overlay");
        let write = json!({
            "toolCall": {
                "name": "write_to_file",
                "args": { "TargetFile": root.path().join("ok.txt") }
            }
        });
        assert_eq!(
            hook_gate(&write, root.path(), overlay.path(), "auto"),
            HookGate::Allow
        );
        let command = json!({
            "toolCall": { "name": "run_command", "args": { "CommandLine": "npm test" } }
        });
        assert_eq!(
            hook_gate(&command, root.path(), overlay.path(), "auto"),
            HookGate::Review(BoundaryKind::Shell)
        );
        assert_eq!(
            hook_gate(&command, root.path(), overlay.path(), "project-write"),
            HookGate::Allow
        );
    }

    #[test]
    fn overlay_auto_profile_is_passed_to_the_hook() {
        let data = tempfile::tempdir().expect("app data");
        let workspace = tempfile::tempdir().expect("workspace");
        let overlay = create_overlay(
            data.path(),
            workspace.path(),
            "auto-scope",
            StructuredPermissionMode::AcceptEdits,
            AntigravityOverlayPolicy::Harness(
                crate::harness_prompt::LocalToolsProjection::Unavailable,
            ),
            crate::harness_prompt::ExternalBrowserHandoff::IntegratorOnly,
            Some("auto"),
        )
        .expect("create overlay");

        let config = std::fs::read_to_string(overlay.root.join(".agents/hooks.json"))
            .expect("read hook config");
        assert!(config.contains("auto"));
        assert!(!overlay.reviews.starts_with(&overlay.root));
    }

    #[test]
    fn review_mailbox_fail_closes_without_a_host() {
        let reviews = tempfile::tempdir().expect("reviews");
        write_review_wait_ms(reviews.path(), 80).expect("wait-ms");
        let request = BoundaryRequest {
            kind: BoundaryKind::Shell,
            summary: "npm test".into(),
            detail: "tool: run_command\ninput:\n{}".into(),
            cwd: PathBuf::from("/tmp"),
        };
        let (decision, reason) = request_auto_review(reviews.path(), &request);
        assert_eq!(decision, "deny");
        assert!(reason.is_some_and(|text| text.contains("did not answer")));
    }

    #[test]
    fn review_mailbox_reads_the_host_verdict() {
        let reviews = tempfile::tempdir().expect("reviews");
        write_review_wait_ms(reviews.path(), 2_000).expect("wait-ms");
        let reviews_path = reviews.path().to_path_buf();
        let host = std::thread::spawn(move || {
            for _ in 0..50 {
                let pending = pending_review_request_paths(&reviews_path);
                if let Some(path) = pending.first() {
                    let request = read_review_request(path).expect("request");
                    write_review_response(
                        &reviews_path,
                        &ReviewMailboxResponse {
                            id: request.id,
                            decision: "allow".into(),
                            reason: Some("safe test command".into()),
                        },
                    )
                    .expect("response");
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            panic!("host never saw a review request");
        });
        let request = BoundaryRequest {
            kind: BoundaryKind::Shell,
            summary: "npm test".into(),
            detail: "tool: run_command\ninput:\n{}".into(),
            cwd: PathBuf::from("/tmp"),
        };
        let (decision, reason) = request_auto_review(reviews.path(), &request);
        host.join().expect("host");
        assert_eq!(decision, "allow");
        assert_eq!(reason.as_deref(), Some("safe test command"));
    }
}
