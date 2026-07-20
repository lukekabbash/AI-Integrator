use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use integrator_core::{IntegratorError, Result};
use integrator_runtime::{
    StructuredCliClient, StructuredCliEventKind, StructuredPermissionMode, redact_and_bound,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const HOOK_INPUT_LIMIT: u64 = 1024 * 1024;
const HOOK_DETAIL_LIMIT: usize = 64 * 1024;

pub struct AntigravityOverlay {
    pub root: PathBuf,
    pub event_log: PathBuf,
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
) -> Result<AntigravityOverlay> {
    let root = data_directory.join("antigravity-control").join(scope);
    let agents = root.join(".agents");
    let rules = agents.join("rules");
    fs::create_dir_all(&agents).map_err(IntegratorError::from)?;
    fs::create_dir_all(&rules).map_err(IntegratorError::from)?;
    #[cfg(unix)]
    {
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .map_err(IntegratorError::from)?;
        fs::set_permissions(&agents, fs::Permissions::from_mode(0o700))
            .map_err(IntegratorError::from)?;
        fs::set_permissions(&rules, fs::Permissions::from_mode(0o700))
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
        ),
        AntigravityOverlayPolicy::Chat { memory_enabled } => {
            crate::harness_prompt::chat_developer_instructions(memory_enabled)
        }
    };
    write_private_text(&rules.join("ai-integrator.md"), &instructions)?;
    Ok(AntigravityOverlay { root, event_log })
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
        hook_decision(&input, &workspace, &overlay, permission)
    } else {
        ("allow", None)
    };
    let record = hook_record(phase, &input, decision, reason);
    if append_record(&event_log, &overlay, &record).is_err() {
        return write_hook_response(
            phase,
            "deny",
            Some("Integrator could not record the action"),
        );
    }
    write_hook_response(phase, decision, reason)
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

fn hook_decision<'a>(
    input: &Value,
    workspace: &Path,
    overlay: &Path,
    permission: &str,
) -> (&'a str, Option<&'a str>) {
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
        return ("deny", Some("Tools are unavailable in AI Integrator Chat"));
    }
    if permission == "read-only" && is_mutating_tool(name) {
        return ("deny", Some("This task is read-only"));
    }
    for path in tool_paths(args) {
        let candidate = canonical_candidate(workspace, &path);
        if candidate.starts_with(overlay) && is_mutating_tool(name) {
            return ("deny", Some("Integrator control files cannot be modified"));
        }
        if !candidate.starts_with(workspace) && !candidate.starts_with(overlay) {
            return (
                "deny",
                Some("This action is outside the selected workspace"),
            );
        }
    }
    if is_mutating_tool(name)
        && args
            .get("CommandLine")
            .or_else(|| args.get("command"))
            .and_then(Value::as_str)
            .is_some_and(|command| command.contains(&overlay.to_string_lossy().to_string()))
    {
        return ("deny", Some("Integrator control files cannot be modified"));
    }
    ("allow", None)
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
            hook_decision(&write, root.path(), overlay.path(), "read-only"),
            ("deny", Some("This task is read-only"))
        );
        let escape = json!({
            "toolCall": { "name": "view_file", "args": { "AbsolutePath": "/etc/hosts" } }
        });
        assert_eq!(
            hook_decision(&escape, root.path(), overlay.path(), "project-write"),
            (
                "deny",
                Some("This action is outside the selected workspace")
            )
        );

        let read = json!({
            "toolCall": { "name": "view_file", "args": { "AbsolutePath": root.path().join("ok.txt") } }
        });
        assert_eq!(
            hook_decision(&read, root.path(), overlay.path(), "chat"),
            ("deny", Some("Tools are unavailable in AI Integrator Chat"))
        );
        let memory = json!({
            "toolCall": { "name": "mcp__integrator__memory_save", "args": { "text": "Prefers concise replies" } }
        });
        assert_eq!(
            hook_decision(&memory, root.path(), overlay.path(), "chat-memory"),
            ("allow", None)
        );
        let schedule = json!({
            "toolCall": { "name": "mcp__integrator__schedule_recurring", "args": {} }
        });
        assert_eq!(
            hook_decision(&schedule, root.path(), overlay.path(), "chat"),
            ("allow", None)
        );
        assert_eq!(
            hook_decision(&read, root.path(), overlay.path(), "chat-memory"),
            ("deny", Some("Tools are unavailable in AI Integrator Chat"))
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
        )
        .expect("create overlay");

        assert!(overlay.root.starts_with(data.path()));
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
        )
        .expect("create overlay");

        let harness = std::fs::read_to_string(overlay.root.join(".agents/rules/ai-integrator.md"))
            .expect("read harness rule");
        assert!(harness.contains("task-scoped MCP server named `integrator`"));
        assert!(harness.contains("call them directly"));
        assert!(!harness.contains("delegation are unavailable"));
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
        )
        .expect("create Chat overlay");

        let rule = std::fs::read_to_string(overlay.root.join(".agents/rules/ai-integrator.md"))
            .expect("read Chat rule");
        assert!(rule.contains("This is not a coding-agent session"));
        assert!(rule.contains("`memory_save`"));
        assert!(rule.contains("schedule_recurring"));
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
            hook_decision(&read, root.path(), overlay.path(), "project-write"),
            ("allow", None)
        );
        let edit_overlay = json!({
            "toolCall": { "name": "write_to_file", "args": { "TargetFile": overlay.path().join("hooks.json") } }
        });
        assert_eq!(
            hook_decision(&edit_overlay, root.path(), overlay.path(), "full-access"),
            ("deny", Some("Integrator control files cannot be modified"))
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
}
