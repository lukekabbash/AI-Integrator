//! Delegation broker: the host side of the cross-provider subagent bridge.
//!
//! The broker listens on a loopback TCP port with a per-app-run token. Agent
//! sessions reach it through `integrator.exe --broker-mcp`, a thin stdio MCP
//! server injected into provider CLIs (see `broker_mcp.rs`), which forwards
//! every `tools/call` here as one line-delimited JSON-RPC request.
//!
//! Delegation is fully asynchronous. `delegate_start` returns immediately;
//! children run in their own tasks/processes; messages queue in SQLite and
//! deliver only when the recipient is idle (children) or pulls them
//! (orchestrators). Nothing here ever interrupts the user's conversation.

use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    str::FromStr,
    sync::Arc,
};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use chrono::Utc;
use integrator_core::{
    Delegation, DelegationId, DelegationSender, DelegationStatus, IntegratorError, ItemKind,
    ItemProjection, ItemStatus, ProviderKind, Result, RuntimeBinding, TaskId, TurnStatus,
};
use integrator_runtime::{
    ProjectionMutation, ReducedProviderEvent, StructuredCliEventKind, StructuredCliLaunchOptions,
    StructuredCliProvider, StructuredPermissionMode, acp_turn_projection, discover_providers,
    parse_acp_mode_state, provider_executable, redact_and_bound,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use session_store::{LocalStore, NewDelegation};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};

use crate::state::{
    AcpRuntime, AppState, CodexRuntime, DelegationChild, DelegationChildDriver, StructuredRuntime,
};

pub const DELEGATION_UPDATE_EVENT: &str = "delegation://update";
const CHILD_DIGEST_BYTES: usize = 6 * 1024;
const MAX_LINE_BYTES: usize = 256 * 1024;

// ---------------------------------------------------------------------------
// Settings-backed policy
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationProfile {
    pub id: String,
    pub label: String,
    pub runtime: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub preferred_child_profile_ids: Vec<String>,
    #[serde(default = "default_cost_tier")]
    pub cost_tier: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationRoutingInput {
    pub runtime: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

fn default_cost_tier() -> String {
    "medium".into()
}

const fn default_true() -> bool {
    true
}

fn cost_rank(tier: &str) -> u8 {
    match tier {
        "low" => 0,
        "medium" => 1,
        _ => 2,
    }
}

/// Built-in fallbacks so delegation works before the user has ever opened
/// the Subagents settings page. Providers that are not installed fail at
/// `delegate_start` with a clear diagnostic instead of being hidden here.
fn default_profiles() -> Vec<DelegationProfile> {
    vec![
        DelegationProfile {
            id: "codex-default".into(),
            label: "Codex (OpenAI)".into(),
            runtime: "codex".into(),
            model: None,
            effort: None,
            instruction: None,
            preferred_child_profile_ids: Vec::new(),
            cost_tier: "low".into(),
            enabled: true,
        },
        DelegationProfile {
            id: "claude-default".into(),
            label: "Claude".into(),
            runtime: "claude".into(),
            model: None,
            effort: None,
            instruction: None,
            preferred_child_profile_ids: Vec::new(),
            cost_tier: "high".into(),
            enabled: true,
        },
        DelegationProfile {
            id: "antigravity-default".into(),
            label: "Antigravity (Gemini)".into(),
            runtime: "antigravity".into(),
            model: None,
            effort: None,
            instruction: None,
            preferred_child_profile_ids: Vec::new(),
            cost_tier: "medium".into(),
            enabled: true,
        },
        DelegationProfile {
            id: "cursor-default".into(),
            label: "Cursor".into(),
            runtime: "cursor".into(),
            model: None,
            effort: None,
            instruction: None,
            preferred_child_profile_ids: Vec::new(),
            cost_tier: "medium".into(),
            enabled: true,
        },
        DelegationProfile {
            id: "grok-default".into(),
            label: "Grok Build".into(),
            runtime: "grok".into(),
            model: None,
            effort: None,
            instruction: None,
            preferred_child_profile_ids: Vec::new(),
            cost_tier: "low".into(),
            enabled: true,
        },
    ]
}

fn read_setting(store: &LocalStore, key: &str) -> Option<Value> {
    store
        .list_settings()
        .ok()?
        .into_iter()
        .find(|setting| setting.key == key)
        .map(|setting| setting.value)
}

/// An explicitly stored list is respected verbatim — including empty, which
/// means the user removed every profile on purpose. Only a missing or
/// malformed setting falls back to the built-in defaults.
pub fn delegation_profiles(store: &LocalStore) -> Vec<DelegationProfile> {
    read_setting(store, "settings.delegation.profiles")
        .and_then(|value| serde_json::from_value::<Vec<DelegationProfile>>(value).ok())
        .unwrap_or_else(default_profiles)
}

fn enabled_profile(store: &LocalStore, profile_id: &str) -> Result<DelegationProfile> {
    delegation_profiles(store)
        .into_iter()
        .find(|profile| profile.id == profile_id && profile.enabled)
        .ok_or_else(|| {
            IntegratorError::InvalidInput(format!(
                "delegation profile '{profile_id}' is not enabled in settings"
            ))
        })
}

fn max_concurrent(store: &LocalStore) -> u32 {
    read_setting(store, "settings.delegation.maxConcurrent")
        .and_then(|value| value.as_u64())
        .map_or(3, |value| value.clamp(1, 16) as u32)
}

fn custom_instruction(store: &LocalStore) -> Option<String> {
    read_setting(store, "settings.delegation.instruction")
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|value| !value.trim().is_empty())
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/// Instruction block prepended to the orchestrator's wire prompt when
/// delegation is active. Kept short: the authoritative tool contracts live in
/// the MCP tool descriptions.
pub fn orchestrator_preamble(store: &LocalStore, mode: &str) -> String {
    let mut block = String::from(
        "<delegation>\nYou can delegate subtasks to subagents on other providers using the `integrator` MCP tools (peers_list, delegate_start, delegation_status, delegation_message, delegation_result, delegation_stop). Delegation is asynchronous: delegate_start returns immediately and the subagent works in the background while you continue. Check in with delegation_status when convenient; nudge or answer a subagent with delegation_message; collect deliverables with delegation_result. Subagents may queue questions for you — they appear in delegation_status results and in <delegation-update> blocks.\n",
    );
    match mode {
        "manual" => block.push_str(
            "Mode: manual — every delegate_start waits for the user to approve it in the task's Agents rail (right panel) before the subagent launches. Approving the tool call in chat is not the same thing; if a delegation stays pending-approval, tell the user to open the Agents rail and press Approve there.\n",
        ),
        "budget-first" => block.push_str(
            "Mode: budget-first — prefer the cheapest profile capable of the subtask; peers_list is ordered cheapest first.\n",
        ),
        _ => {}
    }
    if let Some(instruction) = custom_instruction(store) {
        block.push_str("User delegation policy:\n");
        block.push_str(instruction.trim());
        block.push('\n');
    }
    block.push_str("</delegation>\n\n");
    block
}

/// Undelivered child->orchestrator messages and terminal results, rendered
/// for the orchestrator's next turn and marked delivered. Returns `None`
/// when there is nothing new.
pub fn pending_updates_block(store: &LocalStore, parent_task_id: TaskId) -> Option<String> {
    let pending = store
        .undelivered_child_messages_for_parent(parent_task_id)
        .ok()?;
    if pending.is_empty() {
        return None;
    }
    let mut block = String::from(
        "<delegation-update>\nMessages from your delegated subagents since your last turn:\n",
    );
    let mut delivered = Vec::new();
    for (delegation, message) in &pending {
        block.push_str(&format!(
            "- [{} · {} · {}] {}\n",
            delegation.title,
            delegation.profile_label,
            delegation.status.as_str(),
            message.body
        ));
        delivered.push(message.id.clone());
    }
    block.push_str("Reply with delegation_message, or check delegation_status for details.\n</delegation-update>\n\n");
    let _ = store.mark_delegation_messages_delivered(&delivered);
    Some(block)
}

fn child_preamble(
    delegation: &Delegation,
    has_tools: bool,
    profile: Option<&DelegationProfile>,
    preferred_children: &[String],
) -> String {
    let mut block = format!(
        "<subagent-brief>\nYou are a delegated subagent working on behalf of an orchestrator agent in this repository. Your assignment: {}\n\n{}\n",
        delegation.title, delegation.brief
    );
    if let Some(instruction) = profile
        .and_then(|profile| profile.instruction.as_deref())
        .map(str::trim)
        .filter(|instruction| !instruction.is_empty())
    {
        block.push_str("\n<specialist-instructions>\n");
        block.push_str(&redact_and_bound(instruction, 64 * 1024).0);
        block.push_str("\n</specialist-instructions>\n");
    }
    if !preferred_children.is_empty() {
        block.push_str("\nPreferred downstream helper profiles: ");
        block.push_str(&preferred_children.join(", "));
        block.push_str(
            ". Recursive launching is policy-gated; use this preference when proposing or reporting follow-up delegation.\n",
        );
    }
    if has_tools {
        block.push_str(
            "Use the `integrator` MCP tools: task_complete(summary) when your assignment is done (always call it — the summary is your deliverable), orchestrator_ask(message) to queue a question (asynchronous — finish what you can while waiting), orchestrator_report(message) for progress notes on long work.\n",
        );
    } else {
        block.push_str(
            "When your assignment is done, end your reply with a concise summary of what you did and any caveats — it is captured as your deliverable.\n",
        );
    }
    block.push_str("</subagent-brief>\n\n");
    block
}

// ---------------------------------------------------------------------------
// Broker transport (host side)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct BrokerInfo {
    pub port: u16,
    pub token: String,
}

pub fn broker_env(
    info: &BrokerInfo,
    role: &str,
    scope: &str,
    mode: &str,
) -> Vec<(&'static str, String)> {
    vec![
        ("INTEGRATOR_BROKER_ADDR", format!("127.0.0.1:{}", info.port)),
        ("INTEGRATOR_BROKER_TOKEN", info.token.clone()),
        ("INTEGRATOR_BROKER_ROLE", role.into()),
        ("INTEGRATOR_BROKER_SCOPE", scope.into()),
        ("INTEGRATOR_BROKER_MODE", mode.into()),
    ]
}

/// Thread-scoped Codex config for the local delegation broker. Keeping this
/// on `thread/start` avoids mutating the user's global Codex configuration and
/// gives every task its own broker scope and short-lived app-run token.
pub fn codex_mcp_config(info: &BrokerInfo, role: &str, scope: &str, mode: &str) -> Result<Value> {
    let executable = std::env::current_exe().map_err(IntegratorError::from)?;
    let env: serde_json::Map<String, Value> = broker_env(info, role, scope, mode)
        .into_iter()
        .map(|(key, value)| (key.to_owned(), Value::String(value)))
        .collect();
    Ok(json!({
        "mcp_servers": {
            "integrator": {
                "command": executable.to_string_lossy(),
                "args": ["--broker-mcp"],
                "env": env,
                "required": true,
            }
        }
    }))
}

/// Writes the Claude-CLI MCP config file for one session and returns its
/// path. One file per scope so concurrent sessions never clobber each other.
pub fn write_mcp_config(
    app: &AppHandle<tauri::Wry>,
    info: &BrokerInfo,
    role: &str,
    scope: &str,
    mode: &str,
) -> Result<PathBuf> {
    let executable = std::env::current_exe().map_err(IntegratorError::from)?;
    let state = app.state::<AppState>();
    let directory = state.data_directory.join("broker-mcp");
    std::fs::create_dir_all(&directory).map_err(IntegratorError::from)?;
    let env: serde_json::Map<String, Value> = broker_env(info, role, scope, mode)
        .into_iter()
        .map(|(key, value)| (key.to_owned(), Value::String(value)))
        .collect();
    let config = json!({
        "mcpServers": {
            "integrator": {
                "command": executable.to_string_lossy(),
                "args": ["--broker-mcp"],
                "env": env,
            }
        }
    });
    let path = directory.join(format!("{role}-{scope}.json"));
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&path).map_err(IntegratorError::from)?;
    file.write_all(&serde_json::to_vec_pretty(&config)?)
        .map_err(IntegratorError::from)?;
    Ok(path)
}

fn prune_stale_mcp_configs_in(data_directory: &Path) -> std::io::Result<usize> {
    let directory = data_directory.join("broker-mcp");
    let entries = match std::fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let is_json = entry
            .path()
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("json"));
        if !file_type.is_file() || !is_json {
            continue;
        }
        std::fs::remove_file(entry.path())?;
        removed += 1;
    }
    Ok(removed)
}

/// Delete only stale, regular JSON configs from the app-owned broker scratch
/// directory. The single-instance startup path calls this before issuing the
/// new run's loopback token; directories, links, and unrelated files survive.
pub fn prune_stale_mcp_configs(app: &AppHandle<tauri::Wry>) -> Result<usize> {
    let state = app.state::<AppState>();
    prune_stale_mcp_configs_in(&state.data_directory).map_err(IntegratorError::from)
}

/// The `session/new` `mcpServers` entry for ACP agents.
pub fn acp_mcp_server_entry(
    info: &BrokerInfo,
    role: &str,
    scope: &str,
    mode: &str,
) -> Result<Value> {
    let executable = std::env::current_exe().map_err(IntegratorError::from)?;
    let env: Vec<Value> = broker_env(info, role, scope, mode)
        .into_iter()
        .map(|(key, value)| json!({ "name": key, "value": value }))
        .collect();
    Ok(json!({
        "name": "integrator",
        "command": executable.to_string_lossy(),
        "args": ["--broker-mcp"],
        "env": env,
    }))
}

/// Binds the loopback listener, records the connection info in state, and
/// serves broker connections for the lifetime of the app.
pub fn start_broker_host(app: AppHandle<tauri::Wry>) {
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("delegation broker failed to bind: {error}");
                return;
            }
        };
        let port = match listener.local_addr() {
            Ok(addr) => addr.port(),
            Err(_) => return,
        };
        let token = uuid::Uuid::new_v4().to_string();
        {
            let state = app.state::<AppState>();
            *state.broker.lock().expect("broker lock") = Some(BrokerInfo {
                port,
                token: token.clone(),
            });
        }
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let app = app.clone();
            let token = token.clone();
            tauri::async_runtime::spawn(async move {
                let _ = serve_connection(app, token, stream).await;
            });
        }
    });
}

struct BrokerSession {
    role: String,
    scope: String,
    mode: String,
}

async fn serve_connection(
    app: AppHandle<tauri::Wry>,
    token: String,
    stream: TcpStream,
) -> std::io::Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader).take(MAX_LINE_BYTES as u64);
    let mut session: Option<BrokerSession> = None;
    let mut line = String::new();
    loop {
        line.clear();
        reader.set_limit(MAX_LINE_BYTES as u64);
        if reader.read_line(&mut line).await? == 0 {
            return Ok(());
        }
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let params = request.get("params").cloned().unwrap_or(Value::Null);

        let response = if method == "hello" {
            if params.get("token").and_then(Value::as_str) == Some(token.as_str()) {
                session = Some(BrokerSession {
                    role: text_param(&params, "role").unwrap_or_default(),
                    scope: text_param(&params, "scope").unwrap_or_default(),
                    mode: text_param(&params, "mode").unwrap_or_else(|| "balanced".into()),
                });
                json!({ "id": id, "result": { "ok": true } })
            } else {
                json!({ "id": id, "error": { "message": "invalid broker token" } })
            }
        } else if let Some(session) = session.as_ref() {
            match dispatch_tool(&app, session, &method, &params).await {
                Ok(result) => json!({ "id": id, "result": result }),
                Err(error) => json!({ "id": id, "error": { "message": error.to_string() } }),
            }
        } else {
            json!({ "id": id, "error": { "message": "broker session is not authenticated" } })
        };
        let mut payload = response.to_string();
        payload.push('\n');
        writer.write_all(payload.as_bytes()).await?;
    }
}

fn text_param(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async fn dispatch_tool(
    app: &AppHandle<tauri::Wry>,
    session: &BrokerSession,
    method: &str,
    params: &Value,
) -> Result<Value> {
    match (session.role.as_str(), method) {
        ("orchestrator", "peers_list") => {
            let task_id = orchestrator_scope(session)?;
            peers_list(app, task_id, &session.mode)
        }
        ("orchestrator", "delegate_start") => {
            let task_id = orchestrator_scope(session)?;
            delegate_start(app, task_id, &session.mode, params).await
        }
        ("orchestrator", "delegation_status") => {
            let task_id = orchestrator_scope(session)?;
            delegation_status(app, task_id, params)
        }
        ("orchestrator", "delegation_message") => {
            let task_id = orchestrator_scope(session)?;
            let delegation = scoped_delegation(app, task_id, params)?;
            let message = text_param(params, "message")
                .ok_or_else(|| IntegratorError::InvalidInput("message is required".into()))?;
            queue_message_to_child(
                app,
                delegation.id,
                DelegationSender::Orchestrator,
                &message,
                None,
            )
            .await
        }
        ("orchestrator", "delegation_result") => {
            let task_id = orchestrator_scope(session)?;
            let delegation = scoped_delegation(app, task_id, params)?;
            delegation_result(app, &delegation)
        }
        ("orchestrator", "delegation_stop") => {
            let task_id = orchestrator_scope(session)?;
            let delegation = scoped_delegation(app, task_id, params)?;
            stop_delegation(app, delegation.id).await
        }
        ("child", "orchestrator_ask" | "orchestrator_report") => {
            let delegation_id = child_scope(session)?;
            let message = text_param(params, "message")
                .ok_or_else(|| IntegratorError::InvalidInput("message is required".into()))?;
            let state = app.state::<AppState>();
            state
                .store
                .add_delegation_message(delegation_id, DelegationSender::Child, &message)?;
            emit_update_for_delegation(app, delegation_id);
            Ok(json!({
                "queued": true,
                "note": "Delivered asynchronously; continue working while you wait. If the answer is blocking, say so in your message and pause that subtask."
            }))
        }
        ("child", "task_complete") => {
            let delegation_id = child_scope(session)?;
            let summary = text_param(params, "summary")
                .ok_or_else(|| IntegratorError::InvalidInput("summary is required".into()))?;
            let state = app.state::<AppState>();
            state.store.set_delegation_result(
                delegation_id,
                DelegationStatus::Completed,
                &summary,
            )?;
            if let Some(child) = state
                .delegation_children
                .lock()
                .await
                .get(&delegation_id.to_string())
            {
                *child.completed.lock().expect("completed lock") = true;
            }
            emit_update_for_delegation(app, delegation_id);
            Ok(
                json!({ "ok": true, "note": "Result recorded. Finish your final reply; no further turns are required." }),
            )
        }
        _ => Err(IntegratorError::InvalidInput(format!(
            "tool '{}' is not available to the '{}' role",
            method, session.role
        ))),
    }
}

fn orchestrator_scope(session: &BrokerSession) -> Result<TaskId> {
    TaskId::from_str(&session.scope)
        .map_err(|_| IntegratorError::InvalidInput("invalid orchestrator scope".into()))
}

fn child_scope(session: &BrokerSession) -> Result<DelegationId> {
    DelegationId::from_str(&session.scope)
        .map_err(|_| IntegratorError::InvalidInput("invalid child scope".into()))
}

/// Resolve `delegationId` from params and verify it belongs to the caller's
/// parent task — an orchestrator can never reach another task's children.
fn scoped_delegation(
    app: &AppHandle<tauri::Wry>,
    parent_task_id: TaskId,
    params: &Value,
) -> Result<Delegation> {
    let id = text_param(params, "delegationId")
        .ok_or_else(|| IntegratorError::InvalidInput("delegationId is required".into()))?;
    let id = DelegationId::from_str(&id)
        .map_err(|_| IntegratorError::InvalidInput("invalid delegationId".into()))?;
    let state = app.state::<AppState>();
    let delegation = state.store.get_delegation(id)?;
    if delegation.parent_task_id != parent_task_id {
        return Err(IntegratorError::Unauthorized(
            "delegation belongs to another task".into(),
        ));
    }
    Ok(delegation)
}

fn peers_list(app: &AppHandle<tauri::Wry>, task_id: TaskId, mode: &str) -> Result<Value> {
    let state = app.state::<AppState>();
    let mut profiles: Vec<DelegationProfile> = delegation_profiles(&state.store)
        .into_iter()
        .filter(|profile| profile.enabled)
        .collect();
    if mode == "budget-first" {
        profiles.sort_by_key(|profile| cost_rank(&profile.cost_tier));
    }
    let active = state.store.active_delegation_count(task_id)?;
    let limit = max_concurrent(&state.store);
    Ok(json!({
        "peers": profiles.iter().map(|profile| json!({
            "profileId": profile.id,
            "label": profile.label,
            "runtime": profile.runtime,
            "model": profile.model,
            "reasoningEffort": profile.effort,
            "specialistInstruction": profile.instruction.as_deref().map(|value| redact_and_bound(value, 64 * 1024).0),
            "preferredChildProfileIds": profile.preferred_child_profile_ids,
            "costTier": profile.cost_tier,
        })).collect::<Vec<_>>(),
        "mode": mode,
        "activeDelegations": active,
        "maxConcurrent": limit,
    }))
}

async fn delegate_start(
    app: &AppHandle<tauri::Wry>,
    parent_task_id: TaskId,
    mode: &str,
    params: &Value,
) -> Result<Value> {
    let profile_id = text_param(params, "profileId")
        .ok_or_else(|| IntegratorError::InvalidInput("profileId is required".into()))?;
    let title = text_param(params, "title")
        .ok_or_else(|| IntegratorError::InvalidInput("title is required".into()))?;
    let brief = text_param(params, "brief")
        .ok_or_else(|| IntegratorError::InvalidInput("brief is required".into()))?;

    let state = app.state::<AppState>();
    let profile = enabled_profile(&state.store, &profile_id)?;
    let active = state.store.active_delegation_count(parent_task_id)?;
    let limit = max_concurrent(&state.store);
    if active >= limit {
        return Err(IntegratorError::Unavailable(format!(
            "delegation limit reached ({active}/{limit} active); wait for a subagent to finish or stop one"
        )));
    }
    let manual = mode == "manual";
    let delegation = state.store.create_delegation(NewDelegation {
        parent_task_id,
        profile_id: profile.id.clone(),
        profile_label: profile.label.clone(),
        runtime: profile.runtime.clone(),
        model: profile.model.clone(),
        effort: profile.effort.clone(),
        title,
        brief,
        status: if manual {
            DelegationStatus::PendingApproval
        } else {
            DelegationStatus::Starting
        },
    })?;
    emit_update(app, parent_task_id);
    if manual {
        return Ok(json!({
            "delegationId": delegation.id.to_string(),
            "status": delegation.status.as_str(),
            "note": "Waiting for the user to approve this delegation in the task's Agents rail (right panel). Chat-level tool-call approval does not launch it — if it stays pending, ask the user to press Approve in the Agents rail. Continue other work; check delegation_status later.",
        }));
    }
    if let Err(error) = spawn_child(app.clone(), delegation.id).await {
        let _ = state.store.set_delegation_result(
            delegation.id,
            DelegationStatus::Failed,
            &error.to_string(),
        );
        emit_update(app, parent_task_id);
        return Err(error);
    }
    let delegation = app
        .state::<AppState>()
        .store
        .get_delegation(delegation.id)?;
    Ok(json!({
        "delegationId": delegation.id.to_string(),
        "status": delegation.status.as_str(),
        "note": "Subagent launched asynchronously. Continue your own work; poll delegation_status when convenient.",
    }))
}

fn delegation_status(
    app: &AppHandle<tauri::Wry>,
    parent_task_id: TaskId,
    params: &Value,
) -> Result<Value> {
    let state = app.state::<AppState>();
    let filter = text_param(params, "delegationId");
    let delegations = state.store.list_delegations(parent_task_id)?;
    let mut rows = Vec::new();
    for delegation in delegations {
        if let Some(filter) = &filter
            && delegation.id.to_string() != *filter
        {
            continue;
        }
        let messages = state
            .store
            .undelivered_delegation_messages(delegation.id, false)?;
        let bodies: Vec<String> = messages
            .iter()
            .map(|message| message.body.clone())
            .collect();
        state.store.mark_delegation_messages_delivered(
            &messages
                .iter()
                .map(|message| message.id.clone())
                .collect::<Vec<_>>(),
        )?;
        rows.push(json!({
            "delegationId": delegation.id.to_string(),
            "title": delegation.title,
            "profile": delegation.profile_label,
            "runtime": delegation.runtime,
            "status": delegation.status.as_str(),
            "result": delegation.result,
            "messagesFromSubagent": bodies,
            "updatedAt": delegation.updated_at.to_rfc3339(),
        }));
    }
    if !rows.is_empty() {
        emit_update(app, parent_task_id);
    }
    Ok(json!({ "delegations": rows }))
}

fn delegation_result(app: &AppHandle<tauri::Wry>, delegation: &Delegation) -> Result<Value> {
    let state = app.state::<AppState>();
    let digest = delegation.child_task_id.and_then(|task_id| {
        state
            .store
            .task_conversation_digest(task_id, CHILD_DIGEST_BYTES)
            .ok()
            .flatten()
    });
    Ok(json!({
        "delegationId": delegation.id.to_string(),
        "status": delegation.status.as_str(),
        "result": delegation.result,
        "transcriptDigest": digest,
    }))
}

// ---------------------------------------------------------------------------
// Child lifecycle
// ---------------------------------------------------------------------------

/// Launches the child runtime for an approved delegation. Fully async: the
/// child's first turn starts in the background and this returns once the
/// process is up and the delegation is `running`.
pub async fn spawn_child(app: AppHandle<tauri::Wry>, delegation_id: DelegationId) -> Result<()> {
    let state = app.state::<AppState>();
    let delegation = state.store.get_delegation(delegation_id)?;
    let parent = state.store.get_task(delegation.parent_task_id)?;
    let cwd = parent
        .worktree_path
        .clone()
        .or_else(|| parent.repository_path.clone())
        .ok_or_else(|| {
            IntegratorError::InvalidInput(
                "parent task has no repository/worktree for delegation".into(),
            )
        })?;

    let provider = ProviderKind::from_str(&delegation.runtime)?;
    let configured_profiles = delegation_profiles(&state.store);
    let profile = configured_profiles
        .iter()
        .find(|profile| profile.id == delegation.profile_id);
    let preferred_children = profile
        .map(|profile| {
            profile
                .preferred_child_profile_ids
                .iter()
                .filter_map(|id| {
                    configured_profiles
                        .iter()
                        .find(|candidate| candidate.id == *id && candidate.enabled)
                        .map(|candidate| candidate.label.clone())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let child_task = state.store.create_task(integrator_core::NewTask {
        title: format!("Subagent · {}", delegation.title),
        repository_path: parent.repository_path.clone(),
        worktree_path: parent.worktree_path.clone(),
        runtime: Some(delegation.runtime.clone()),
        model: delegation.model.clone(),
        effort: delegation.effort.clone(),
        parent_task_id: Some(delegation.parent_task_id),
    })?;
    state
        .store
        .attach_delegation_child(delegation_id, child_task.id)?;

    let statuses = tauri::async_runtime::spawn_blocking(discover_providers)
        .await
        .map_err(|_| IntegratorError::Unavailable("provider discovery failed".into()))?;
    let executable = provider_executable(&statuses, provider).ok_or_else(|| {
        IntegratorError::Unavailable(format!("{} CLI is not installed", provider.as_str()))
    })?;

    // Seed the child with the parent's recent conversation so the brief has
    // context, mirroring the cross-provider primer used for task handoff.
    let parent_digest = state
        .store
        .task_conversation_digest(delegation.parent_task_id, CHILD_DIGEST_BYTES)
        .ok()
        .flatten();
    let mut first_prompt = String::new();
    if let Some(digest) = parent_digest {
        first_prompt.push_str(&format!(
            "<orchestrator-context>\nRecent conversation from the delegating task, for background only:\n\n{digest}\n</orchestrator-context>\n\n"
        ));
    }

    let broker = state.broker.lock().expect("broker lock").clone();
    let child = match provider {
        ProviderKind::Claude | ProviderKind::Antigravity => {
            let has_tools = matches!(provider, ProviderKind::Claude) && broker.is_some();
            first_prompt.push_str(&child_preamble(
                &delegation,
                has_tools,
                profile,
                &preferred_children,
            ));
            let mcp_config = match (&broker, provider) {
                (Some(info), ProviderKind::Claude) => Some(write_mcp_config(
                    &app,
                    info,
                    "child",
                    &delegation_id.to_string(),
                    "off",
                )?),
                _ => None,
            };
            spawn_structured_child(
                &app,
                &delegation,
                child_task.id,
                provider,
                executable,
                cwd,
                mcp_config,
            )
            .await?
        }
        ProviderKind::Codex => {
            first_prompt.push_str(&child_preamble(
                &delegation,
                false,
                profile,
                &preferred_children,
            ));
            spawn_codex_child(&app, &delegation, child_task.id, executable, cwd).await?
        }
        ProviderKind::Cursor | ProviderKind::Grok => {
            // Cursor accepts broker tools through ACP `session/new`
            // `mcpServers`; Grok has no injection surface, so its results
            // come from the transcript digest like Antigravity's.
            let mcp_server = match (&broker, provider) {
                (Some(info), ProviderKind::Cursor) => Some(acp_mcp_server_entry(
                    info,
                    "child",
                    &delegation_id.to_string(),
                    "off",
                )?),
                _ => None,
            };
            first_prompt.push_str(&child_preamble(
                &delegation,
                mcp_server.is_some(),
                profile,
                &preferred_children,
            ));
            spawn_acp_child(
                &app,
                &delegation,
                child_task.id,
                provider,
                executable,
                cwd,
                mcp_server,
            )
            .await?
        }
        other => {
            let _ = state
                .store
                .update_delegation_status(delegation_id, DelegationStatus::Failed);
            return Err(IntegratorError::InvalidInput(format!(
                "{} is not a supported delegation target in v1",
                other.as_str()
            )));
        }
    };

    let child = Arc::new(child);
    state
        .delegation_children
        .lock()
        .await
        .insert(delegation_id.to_string(), Arc::clone(&child));
    state
        .store
        .update_delegation_status(delegation_id, DelegationStatus::Running)?;
    emit_update(&app, delegation.parent_task_id);
    start_child_turn(&app, &child, first_prompt).await?;
    Ok(())
}

/// Recreates a provider driver for an existing child task. This is used after
/// app/process closure, an explicit Stop, a failed child, or a user-selected
/// provider/model change. The durable child task remains the transcript owner.
async fn respawn_existing_child(
    app: &AppHandle<tauri::Wry>,
    delegation: &Delegation,
) -> Result<Arc<DelegationChild>> {
    let state = app.state::<AppState>();
    let child_task_id = delegation.child_task_id.ok_or_else(|| {
        IntegratorError::InvalidInput("delegation has no child task to resume".into())
    })?;
    let parent = state.store.get_task(delegation.parent_task_id)?;
    let cwd = parent
        .worktree_path
        .clone()
        .or_else(|| parent.repository_path.clone())
        .ok_or_else(|| {
            IntegratorError::InvalidInput(
                "parent task has no repository/worktree for delegation".into(),
            )
        })?;
    let provider = ProviderKind::from_str(&delegation.runtime)?;
    let statuses = tauri::async_runtime::spawn_blocking(discover_providers)
        .await
        .map_err(|_| IntegratorError::Unavailable("provider discovery failed".into()))?;
    let executable = provider_executable(&statuses, provider).ok_or_else(|| {
        IntegratorError::Unavailable(format!("{} CLI is not installed", provider.as_str()))
    })?;
    let broker = state.broker.lock().expect("broker lock").clone();
    let child = match provider {
        ProviderKind::Claude | ProviderKind::Antigravity => {
            let mcp_config = match (&broker, provider) {
                (Some(info), ProviderKind::Claude) => Some(write_mcp_config(
                    app,
                    info,
                    "child",
                    &delegation.id.to_string(),
                    "off",
                )?),
                _ => None,
            };
            spawn_structured_child(
                app,
                delegation,
                child_task_id,
                provider,
                executable,
                cwd,
                mcp_config,
            )
            .await?
        }
        ProviderKind::Codex => {
            spawn_codex_child(app, delegation, child_task_id, executable, cwd).await?
        }
        ProviderKind::Cursor | ProviderKind::Grok => {
            let mcp_server = match (&broker, provider) {
                (Some(info), ProviderKind::Cursor) => Some(acp_mcp_server_entry(
                    info,
                    "child",
                    &delegation.id.to_string(),
                    "off",
                )?),
                _ => None,
            };
            spawn_acp_child(
                app,
                delegation,
                child_task_id,
                provider,
                executable,
                cwd,
                mcp_server,
            )
            .await?
        }
        other => {
            return Err(IntegratorError::InvalidInput(format!(
                "{} is not a supported delegation target in v1",
                other.as_str()
            )));
        }
    };
    Ok(Arc::new(child))
}

async fn spawn_structured_child(
    app: &AppHandle<tauri::Wry>,
    delegation: &Delegation,
    child_task_id: TaskId,
    provider: ProviderKind,
    executable: PathBuf,
    cwd: PathBuf,
    mcp_config: Option<PathBuf>,
) -> Result<DelegationChild> {
    let state = app.state::<AppState>();
    let client = integrator_runtime::StructuredCliClient::new();
    let process_id = uuid::Uuid::new_v4().to_string();
    let thread_id = format!("structured.{}.{}", provider.as_str(), uuid::Uuid::new_v4());
    let binding = state
        .store
        .create_runtime_binding(child_task_id, &process_id, provider)?;
    let binding = state.store.attach_provider_thread(&binding, &thread_id)?;
    let session_ref = Arc::new(std::sync::Mutex::new(None));
    let runtime = StructuredRuntime {
        client: client.clone(),
        process_id,
        alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        binding: Arc::new(std::sync::Mutex::new(Some(binding.clone()))),
        current_turn: Arc::new(std::sync::Mutex::new(None)),
        last_diagnostic: Arc::new(std::sync::Mutex::new(None)),
        permission_requests: Arc::new(std::sync::Mutex::new(HashMap::new())),
        session_ref: Arc::clone(&session_ref),
    };
    crate::commands::spawn_structured_cli_pump(
        app.clone(),
        Arc::clone(&state.store),
        runtime.clone(),
    );
    let child = DelegationChild {
        delegation_id: delegation.id,
        child_task_id,
        parent_task_id: delegation.parent_task_id,
        busy: Arc::new(std::sync::Mutex::new(false)),
        completed: Arc::new(std::sync::Mutex::new(false)),
        driver: DelegationChildDriver::Structured {
            runtime,
            provider,
            executable,
            cwd,
            model: delegation.model.clone(),
            effort: delegation.effort.clone(),
            mcp_config,
            session_ref,
        },
    };
    watch_structured_child(app.clone(), &child, client);
    Ok(child)
}

async fn spawn_codex_child(
    app: &AppHandle<tauri::Wry>,
    delegation: &Delegation,
    child_task_id: TaskId,
    executable: PathBuf,
    cwd: PathBuf,
) -> Result<DelegationChild> {
    let state = app.state::<AppState>();
    let client = adapter_codex::CodexClient::spawn(adapter_codex::CodexLaunchOptions {
        executable,
        working_directory: Some(cwd.clone()),
        client_version: env!("CARGO_PKG_VERSION").into(),
    })
    .await?;
    // Children run unattended: never block on approvals; the workspace-write
    // sandbox is the enforcement boundary instead.
    let response = client
        .start_thread_with_approval(
            &cwd,
            delegation.model.as_deref(),
            delegation.effort.as_deref(),
            "never",
        )
        .await?;
    let thread_id = response
        .get("threadId")
        .and_then(Value::as_str)
        .or_else(|| {
            response
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
        })
        .ok_or_else(|| {
            IntegratorError::Unavailable("Codex did not return a thread identifier".into())
        })?
        .to_owned();
    let process_id = uuid::Uuid::new_v4().to_string();
    let binding =
        state
            .store
            .create_runtime_binding(child_task_id, &process_id, ProviderKind::Codex)?;
    let binding = state.store.attach_provider_thread(&binding, &thread_id)?;
    state
        .store
        .set_delegation_session_ref(delegation.id, &thread_id)?;
    let runtime = CodexRuntime {
        client: client.clone(),
        process_id,
        alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        binding: Arc::new(std::sync::Mutex::new(Some(binding))),
        context_primer: Arc::new(std::sync::Mutex::new(None)),
        pending_user_prompt: Arc::new(std::sync::Mutex::new(None)),
    };
    crate::commands::spawn_projection_pump(app.clone(), Arc::clone(&state.store), runtime.clone());
    let child = DelegationChild {
        delegation_id: delegation.id,
        child_task_id,
        parent_task_id: delegation.parent_task_id,
        busy: Arc::new(std::sync::Mutex::new(false)),
        completed: Arc::new(std::sync::Mutex::new(false)),
        driver: DelegationChildDriver::Codex { runtime, thread_id },
    };
    watch_codex_child(app.clone(), &child, client);
    Ok(child)
}

/// The mode a delegated ACP child must run in: agents that advertise session
/// modes (Cursor: Agent/Plan/Ask) could otherwise start in whatever mode the
/// user's CLI last used, leaving a brief planned or answered read-only
/// instead of executed. Returns `None` when no switch is needed.
fn acp_agent_mode_target(response: &Value) -> Option<String> {
    let modes = parse_acp_mode_state(response)?;
    let target = modes.available_modes.iter().find(|mode| {
        mode.id.eq_ignore_ascii_case("agent") || mode.name.eq_ignore_ascii_case("agent")
    })?;
    (target.id != modes.current_mode_id).then(|| target.id.clone())
}

/// Find a stable ACP config option by category (with id fallbacks) in a
/// `session/new` response and flatten its advertised values.
fn acp_session_config(
    response: &Value,
    category: &str,
    id_fallbacks: &[&str],
) -> Option<(String, Vec<String>)> {
    let options = response
        .get("configOptions")
        .or_else(|| {
            response
                .get("session")
                .and_then(|session| session.get("configOptions"))
        })?
        .as_array()?;
    let option = options
        .iter()
        .find(|option| option.get("category").and_then(Value::as_str) == Some(category))
        .or_else(|| {
            options.iter().find(|option| {
                option
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id_fallbacks.contains(&id))
            })
        })?;
    let id = option.get("id").and_then(Value::as_str)?.to_owned();
    let mut values = Vec::new();
    collect_acp_config_values(option.get("options"), &mut values);
    Some((id, values))
}

/// ACP config values may nest (groups carry their own `options` arrays).
fn collect_acp_config_values(value: Option<&Value>, into: &mut Vec<String>) {
    let Some(entries) = value.and_then(Value::as_array) else {
        return;
    };
    for entry in entries {
        if let Some(value) = entry.get("value").and_then(Value::as_str) {
            if !value.is_empty() {
                into.push(value.to_owned());
            }
            continue;
        }
        collect_acp_config_values(entry.get("options"), into);
    }
}

/// A profile model id resolved against the session's advertised values.
/// Session catalog ids may be bracketed ("gpt-5.5[reasoning=medium]"), so a
/// plain profile id also matches its bracket-free prefix.
fn resolve_acp_model<'a>(values: &'a [String], model: &str) -> Option<&'a str> {
    values
        .iter()
        .find(|value| value.as_str() == model || value.split('[').next() == Some(model))
        .map(String::as_str)
}

/// Best-effort model/effort pinning for ACP children, mirroring the
/// composer's Cursor selection flow. A value the agent does not advertise is
/// dropped — a stale profile can never fail a delegated turn.
async fn apply_acp_child_routing(
    client: &adapter_acp::AcpClient,
    provider: ProviderKind,
    session_id: &str,
    session_response: &Value,
    model: Option<&str>,
    effort: Option<&str>,
) {
    let Some(model) = model else { return };
    let Some((config_id, values)) =
        acp_session_config(session_response, "model", &["model", "models"])
    else {
        return;
    };
    let Some(resolved) = resolve_acp_model(&values, model) else {
        return;
    };
    let resolved = resolved.to_owned();
    if client
        .set_config_option(session_id, &config_id, &resolved)
        .await
        .is_err()
    {
        return;
    }
    let Some(effort) = effort else { return };
    if provider != ProviderKind::Cursor {
        return;
    }
    // Thought level is per-model and only discoverable through the Cursor
    // extension RPC; older builds without it keep the model's own default.
    let Ok(models) = client.list_cursor_models().await else {
        return;
    };
    let plain_model = resolved.split('[').next().unwrap_or(&resolved);
    if let Some((config_id, values)) = cursor_effort_config(&models, plain_model)
        && values.iter().any(|value| value == effort)
    {
        let _ = client
            .set_config_option(session_id, &config_id, effort)
            .await;
    }
}

/// The thought-level config option id and values for one model in a
/// `cursor/list_available_models` response.
fn cursor_effort_config(response: &Value, model: &str) -> Option<(String, Vec<String>)> {
    let entry = response
        .get("models")?
        .as_array()?
        .iter()
        .find(|entry| entry.get("value").and_then(Value::as_str) == Some(model))?;
    let options = entry.get("configOptions")?.as_array()?;
    let thought: Vec<&Value> = options
        .iter()
        .filter(|option| option.get("category").and_then(Value::as_str) == Some("thought_level"))
        .collect();
    let option = thought
        .iter()
        .find(|option| {
            matches!(
                option.get("id").and_then(Value::as_str),
                Some("effort" | "reasoning")
            )
        })
        .or_else(|| {
            thought.iter().find(|option| {
                let mut values = Vec::new();
                collect_acp_config_values(option.get("options"), &mut values);
                values.len() > 2
            })
        })?;
    let id = option.get("id").and_then(Value::as_str)?.to_owned();
    let mut values = Vec::new();
    collect_acp_config_values(option.get("options"), &mut values);
    Some((id, values))
}

async fn spawn_acp_child(
    app: &AppHandle<tauri::Wry>,
    delegation: &Delegation,
    child_task_id: TaskId,
    provider: ProviderKind,
    executable: PathBuf,
    cwd: PathBuf,
    mcp_server: Option<Value>,
) -> Result<DelegationChild> {
    let state = app.state::<AppState>();
    let arguments = crate::commands::acp_launch_arguments(&provider)
        .map_err(|error| IntegratorError::InvalidInput(error.message))?;
    let client = adapter_acp::AcpClient::spawn(adapter_acp::AcpLaunchOptions {
        executable,
        arguments,
        working_directory: Some(cwd.clone()),
        client_version: env!("CARGO_PKG_VERSION").into(),
    })
    .await?;
    if let Err(error) = crate::commands::authenticate_acp_provider(&client, &provider).await {
        let _ = client.shutdown().await;
        return Err(IntegratorError::Unavailable(error.message));
    }
    let response = match client
        .new_session(&cwd, mcp_server.into_iter().collect())
        .await
    {
        Ok(response) => response,
        Err(error) => {
            let _ = client.shutdown().await;
            return Err(error);
        }
    };
    let Some(session_id) = response
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        let _ = client.shutdown().await;
        return Err(IntegratorError::Unavailable(format!(
            "{} did not return a session identifier",
            provider.as_str()
        )));
    };
    if let Some(mode_id) = acp_agent_mode_target(&response) {
        let _ = client.set_mode(&session_id, &mode_id).await;
    }
    apply_acp_child_routing(
        &client,
        provider,
        &session_id,
        &response,
        delegation.model.as_deref(),
        delegation.effort.as_deref(),
    )
    .await;
    let process_id = uuid::Uuid::new_v4().to_string();
    let binding = state
        .store
        .create_runtime_binding(child_task_id, &process_id, provider)?;
    let binding = state.store.attach_provider_thread(&binding, &session_id)?;
    state
        .store
        .set_delegation_session_ref(delegation.id, &session_id)?;
    let runtime = AcpRuntime {
        client: client.clone(),
        provider,
        process_id,
        alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        binding: Arc::new(std::sync::Mutex::new(Some(binding))),
        current_turn: Arc::new(std::sync::Mutex::new(None)),
        permission_options: Arc::new(std::sync::Mutex::new(HashMap::new())),
        session_modes: Arc::new(std::sync::Mutex::new(parse_acp_mode_state(&response))),
        plan_requests: Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
        available_actions: Arc::new(std::sync::Mutex::new(Vec::new())),
        context_primer: Arc::new(std::sync::Mutex::new(None)),
        delegation_preamble: Arc::new(std::sync::Mutex::new(None)),
        unattended: true,
    };
    crate::commands::spawn_acp_pump(app.clone(), Arc::clone(&state.store), runtime.clone());
    Ok(DelegationChild {
        delegation_id: delegation.id,
        child_task_id,
        parent_task_id: delegation.parent_task_id,
        busy: Arc::new(std::sync::Mutex::new(false)),
        completed: Arc::new(std::sync::Mutex::new(false)),
        driver: DelegationChildDriver::Acp {
            runtime,
            session_id,
        },
    })
}

/// Starts (or resumes) one child turn with the given wire prompt, recording
/// synthetic user/turn projections for structured providers so the child's
/// transcript shows what was injected.
async fn start_child_turn(
    app: &AppHandle<tauri::Wry>,
    child: &Arc<DelegationChild>,
    prompt: String,
) -> Result<()> {
    *child.busy.lock().expect("busy lock") = true;
    let result: Result<()> = async {
        match &child.driver {
            DelegationChildDriver::Structured {
                runtime,
                provider,
                executable,
                cwd,
                model,
                effort,
                mcp_config,
                session_ref,
            } => {
                let structured_provider = match provider {
                    ProviderKind::Claude => StructuredCliProvider::Claude,
                    _ => StructuredCliProvider::Antigravity,
                };
                let options = StructuredCliLaunchOptions {
                    provider: structured_provider,
                    executable: executable.clone(),
                    working_directory: cwd.clone(),
                    model: model.clone(),
                    effort: effort.clone(),
                    resume_session_id: session_ref.lock().expect("session lock").clone(),
                    permission_mode: StructuredPermissionMode::AcceptEdits,
                    mcp_config_path: mcp_config.clone(),
                };
                let turn_id = runtime.client.start_turn(options, prompt.clone()).await?;
                *runtime.current_turn.lock().expect("turn lock") = Some(turn_id.clone());
                if let Some(binding) = runtime.binding.lock().expect("binding lock").clone() {
                    emit_child_turn_started(app, &binding, &turn_id, &prompt);
                }
            }
            DelegationChildDriver::Codex { runtime, thread_id } => {
                runtime.client.start_turn(thread_id, &prompt).await?;
            }
            DelegationChildDriver::Acp {
                runtime,
                session_id,
            } => {
                // `session/prompt` resolves when the turn finishes, so the
                // turn runs on a background task and settles the delegation
                // itself — there is no separate watcher for ACP children.
                let turn_id = uuid::Uuid::new_v4().to_string();
                *runtime.current_turn.lock().expect("turn lock") = Some(turn_id.clone());
                let started_at = Utc::now();
                if let Some(binding) = runtime.binding.lock().expect("binding lock").clone() {
                    emit_child_turn_started(app, &binding, &turn_id, &prompt);
                }
                let app = app.clone();
                let runtime = runtime.clone();
                let session_id = session_id.clone();
                let delegation_id = child.delegation_id;
                let child_identity = Arc::clone(&child.busy);
                tauri::async_runtime::spawn(async move {
                    let outcome = runtime.client.prompt(&session_id, &prompt).await;
                    let now = Utc::now();
                    let (status, error, failed) = match &outcome {
                        Ok(response) => match adapter_acp::StopReason::from_protocol(response) {
                            adapter_acp::StopReason::Cancelled => {
                                (TurnStatus::Interrupted, None, false)
                            }
                            adapter_acp::StopReason::Refusal => (
                                TurnStatus::Failed,
                                Some("The agent refused the turn".to_owned()),
                                true,
                            ),
                            _ => (TurnStatus::Completed, None, false),
                        },
                        Err(error) => (TurnStatus::Failed, Some(error.to_string()), true),
                    };
                    let binding = runtime.binding.lock().expect("binding lock").clone();
                    if let Some(binding) = binding
                        && let Some(thread_id) = binding.thread_id.clone()
                    {
                        let mut turn =
                            acp_turn_projection(&turn_id, status, error, started_at, now);
                        turn.stop_requested = false;
                        let finished = ReducedProviderEvent {
                            method: "client/delegation/turnFinished".into(),
                            thread_id,
                            turn_id: Some(turn_id.clone()),
                            audit_json: "{}".into(),
                            audit_truncated: false,
                            mutation: ProjectionMutation::Turn(turn),
                            occurred_at: now,
                        };
                        let state = app.state::<AppState>();
                        crate::commands::apply_and_emit(&app, &state.store, &binding, &finished);
                    }
                    {
                        let mut current = runtime.current_turn.lock().expect("turn lock");
                        if current.as_deref() == Some(turn_id.as_str()) {
                            *current = None;
                        }
                    }
                    child_turn_settled(app, delegation_id, failed, &child_identity).await;
                });
            }
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        *child.busy.lock().expect("busy lock") = false;
    }
    result
}

fn emit_child_turn_started(
    app: &AppHandle<tauri::Wry>,
    binding: &RuntimeBinding,
    turn_id: &str,
    prompt: &str,
) {
    let state = app.state::<AppState>();
    let Some(thread_id) = binding.thread_id.clone() else {
        return;
    };
    let now = Utc::now();
    let user_item = ReducedProviderEvent {
        method: "client/delegation/userMessage".into(),
        thread_id: thread_id.clone(),
        turn_id: Some(turn_id.to_owned()),
        audit_json: "{}".into(),
        audit_truncated: false,
        mutation: ProjectionMutation::NeutralItem(ItemProjection {
            id: format!("structured:{thread_id}:{turn_id}:user"),
            provider_item_id: format!("{turn_id}-user"),
            kind: ItemKind::UserMessage,
            status: ItemStatus::Completed,
            title: None,
            body: Some(redact_and_bound(prompt, 2 * 1024 * 1024).0),
            native_skill: None,
            command: None,
            cwd: None,
            output: None,
            exit_code: None,
            file_changes: None,
            mcp_server: None,
            mcp_tool: None,
            tool_input: None,
            truncated: false,
            updated_at: now,
        }),
        occurred_at: now,
    };
    crate::commands::apply_and_emit(app, &state.store, binding, &user_item);
    let turn_started = ReducedProviderEvent {
        method: "client/delegation/turnStarted".into(),
        thread_id,
        turn_id: Some(turn_id.to_owned()),
        audit_json: "{}".into(),
        audit_truncated: false,
        mutation: ProjectionMutation::Turn(acp_turn_projection(
            turn_id,
            TurnStatus::InProgress,
            None,
            now,
            now,
        )),
        occurred_at: now,
    };
    crate::commands::apply_and_emit(app, &state.store, binding, &turn_started);
}

/// Second subscriber on the structured client's broadcast channel (the pump
/// owns persistence): tracks the provider session id for resume and drives
/// the delegation state machine on turn boundaries.
fn watch_structured_child(
    app: AppHandle<tauri::Wry>,
    child: &DelegationChild,
    client: integrator_runtime::StructuredCliClient,
) {
    let delegation_id = child.delegation_id;
    let child_identity = Arc::clone(&child.busy);
    let session_ref = match &child.driver {
        DelegationChildDriver::Structured { session_ref, .. } => Arc::clone(session_ref),
        DelegationChildDriver::Codex { .. } | DelegationChildDriver::Acp { .. } => return,
    };
    let mut receiver = client.subscribe();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = receiver.recv().await {
            if let Some(session_id) = event.session_id.clone() {
                let changed = {
                    let mut guard = session_ref.lock().expect("session lock");
                    if guard.as_deref() != Some(session_id.as_str()) {
                        *guard = Some(session_id.clone());
                        true
                    } else {
                        false
                    }
                };
                if changed {
                    let state = app.state::<AppState>();
                    let _ = state
                        .store
                        .set_delegation_session_ref(delegation_id, &session_id);
                }
            }
            if let StructuredCliEventKind::Exited { code, cancelled } = &event.event {
                let failed = !cancelled && *code != Some(0);
                child_turn_settled(app.clone(), delegation_id, failed, &child_identity).await;
            }
        }
    });
}

/// Second subscriber on the Codex client's channel: settles the delegation
/// on `turn/completed` notifications.
fn watch_codex_child(
    app: AppHandle<tauri::Wry>,
    child: &DelegationChild,
    client: adapter_codex::CodexClient,
) {
    let delegation_id = child.delegation_id;
    let child_identity = Arc::clone(&child.busy);
    let mut receiver = client.subscribe();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = receiver.recv().await {
            match event {
                adapter_codex::CodexEvent::Notification { method, params } => {
                    if method == "turn/completed" {
                        let failed = params
                            .get("turn")
                            .and_then(|turn| turn.get("status"))
                            .and_then(Value::as_str)
                            == Some("failed");
                        child_turn_settled(app.clone(), delegation_id, failed, &child_identity)
                            .await;
                    }
                }
                adapter_codex::CodexEvent::Exited => {
                    child_turn_settled(app.clone(), delegation_id, true, &child_identity).await;
                    break;
                }
                _ => {}
            }
        }
    });
}

/// The delegation state machine tick that runs whenever a child turn ends:
/// deliver queued orchestrator/user messages as the next turn, otherwise go
/// idle (`waiting`), or settle terminal states.
///
/// Boxed rather than `async fn`: ACP children settle from inside
/// `start_child_turn`'s own spawned task, so this future is recursive
/// (settle → deliver queued → start turn → settle) and needs type erasure
/// for the compiler to prove it `Send`.
fn child_turn_settled(
    app: AppHandle<tauri::Wry>,
    delegation_id: DelegationId,
    failed: bool,
    child_identity: &Arc<std::sync::Mutex<bool>>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    let child_identity = Arc::clone(child_identity);
    Box::pin(async move {
        child_turn_settled_inner(app, delegation_id, failed, &child_identity).await;
    })
}

async fn child_turn_settled_inner(
    app: AppHandle<tauri::Wry>,
    delegation_id: DelegationId,
    failed: bool,
    child_identity: &Arc<std::sync::Mutex<bool>>,
) {
    let state = app.state::<AppState>();
    let Some(child) = state
        .delegation_children
        .lock()
        .await
        .get(&delegation_id.to_string())
        .cloned()
    else {
        return;
    };
    // A provider being replaced can emit one final settlement after its new
    // driver is registered. Ignore that stale generation completely.
    if !Arc::ptr_eq(&child.busy, child_identity) {
        return;
    }
    *child.busy.lock().expect("busy lock") = false;
    let completed = *child.completed.lock().expect("completed lock");
    let Ok(delegation) = state.store.get_delegation(delegation_id) else {
        return;
    };
    if matches!(
        delegation.status,
        DelegationStatus::Stopped | DelegationStatus::Denied
    ) {
        return;
    }
    if completed || delegation.status == DelegationStatus::Completed {
        emit_update(&app, child.parent_task_id);
        return;
    }
    if failed {
        let _ = state
            .store
            .update_delegation_status(delegation_id, DelegationStatus::Failed);
        emit_update(&app, child.parent_task_id);
        return;
    }
    match deliver_queued_messages(&app, &child).await {
        Ok(true) => {}
        Ok(false) => {
            let _ = state
                .store
                .update_delegation_status(delegation_id, DelegationStatus::Waiting);
        }
        Err(_) => {
            let _ = state
                .store
                .update_delegation_status(delegation_id, DelegationStatus::Failed);
        }
    }
    emit_update(&app, child.parent_task_id);
}

/// Injects any undelivered orchestrator/user messages as the child's next
/// turn. Returns whether a turn was started.
async fn deliver_queued_messages(
    app: &AppHandle<tauri::Wry>,
    child: &Arc<DelegationChild>,
) -> Result<bool> {
    deliver_queued_messages_with_context(app, child, false).await
}

async fn deliver_queued_messages_with_context(
    app: &AppHandle<tauri::Wry>,
    child: &Arc<DelegationChild>,
    include_continuation_context: bool,
) -> Result<bool> {
    let state = app.state::<AppState>();
    if *child.busy.lock().expect("busy lock") {
        return Ok(true);
    }
    let messages = state
        .store
        .undelivered_delegation_messages(child.delegation_id, true)?;
    if messages.is_empty() {
        return Ok(false);
    }
    let mut prompt = String::new();
    if include_continuation_context
        && let Some(digest) = state
            .store
            .task_conversation_digest(child.child_task_id, CHILD_DIGEST_BYTES)
            .ok()
            .flatten()
    {
        prompt.push_str(&format!(
            "<continuation-context>\nYou are continuing the same delegated conversation through a fresh provider session. Recent locally persisted transcript:\n\n{digest}\n</continuation-context>\n\n"
        ));
    }
    prompt.push_str("<orchestrator-message>\nNew guidance from your orchestrator:\n");
    for message in &messages {
        prompt.push_str(&format!("- {}\n", message.body));
    }
    prompt.push_str("</orchestrator-message>\nContinue your assignment accordingly.");
    let message_ids = messages
        .iter()
        .map(|message| message.id.clone())
        .collect::<Vec<_>>();
    let _ = state
        .store
        .update_delegation_status(child.delegation_id, DelegationStatus::Running);
    start_child_turn(app, child, prompt).await?;
    state
        .store
        .mark_delegation_messages_delivered(&message_ids)?;
    Ok(true)
}

/// User or orchestrator message to a child: queued always, delivered now if
/// the child is idle.
pub async fn queue_message_to_child(
    app: &AppHandle<tauri::Wry>,
    delegation_id: DelegationId,
    sender: DelegationSender,
    message: &str,
    routing: Option<DelegationRoutingInput>,
) -> Result<Value> {
    let state = app.state::<AppState>();
    let mut delegation = state.store.get_delegation(delegation_id)?;
    if matches!(
        delegation.status,
        DelegationStatus::PendingApproval | DelegationStatus::Denied | DelegationStatus::Starting
    ) {
        return Err(IntegratorError::InvalidInput(format!(
            "delegation is {}; it cannot receive a message yet",
            delegation.status.as_str()
        )));
    }

    let requested_route = routing.map(|routing| DelegationRoutingInput {
        runtime: routing.runtime.trim().to_owned(),
        model: routing.model.filter(|value| !value.trim().is_empty()),
        effort: routing.effort.filter(|value| !value.trim().is_empty()),
    });
    if let Some(route) = &requested_route {
        let provider = ProviderKind::from_str(&route.runtime)?;
        if !matches!(
            provider,
            ProviderKind::Codex
                | ProviderKind::Claude
                | ProviderKind::Antigravity
                | ProviderKind::Cursor
                | ProviderKind::Grok
        ) {
            return Err(IntegratorError::InvalidInput(format!(
                "{} is not a supported delegation target",
                provider.as_str()
            )));
        }
    }
    let route_changed = requested_route.as_ref().is_some_and(|route| {
        route.runtime != delegation.runtime
            || route.model.as_deref() != delegation.model.as_deref()
            || route.effort.as_deref() != delegation.effort.as_deref()
    });
    let existing_child = state
        .delegation_children
        .lock()
        .await
        .get(&delegation_id.to_string())
        .cloned();
    if route_changed
        && existing_child
            .as_ref()
            .is_some_and(|child| *child.busy.lock().expect("busy lock"))
    {
        return Err(IntegratorError::InvalidInput(
            "stop the active subagent turn before changing its provider or model".into(),
        ));
    }

    if let Some(route) = requested_route.filter(|_| route_changed) {
        delegation = state.store.update_delegation_routing(
            delegation_id,
            &route.runtime,
            route.model.as_deref(),
            route.effort.as_deref(),
        )?;
        if let Some(child_task_id) = delegation.child_task_id {
            state.store.update_task_routing(
                child_task_id,
                &delegation.runtime,
                delegation.model.as_deref().unwrap_or("Provider default"),
                delegation.effort.as_deref(),
            )?;
        }
    }

    state
        .store
        .add_delegation_message(delegation_id, sender, message)?;

    let rebuild =
        route_changed || existing_child.is_none() || delegation.status == DelegationStatus::Failed;
    let child = if rebuild {
        let previous = state
            .delegation_children
            .lock()
            .await
            .remove(&delegation_id.to_string());
        if let Some(previous) = previous {
            match &previous.driver {
                DelegationChildDriver::Codex { runtime, .. } => {
                    let _ = state.store.expire_process_approvals(&runtime.process_id);
                    let _ = runtime.client.shutdown().await;
                }
                DelegationChildDriver::Acp { runtime, .. } => {
                    let _ = state.store.expire_process_approvals(&runtime.process_id);
                    let _ = runtime.client.shutdown().await;
                }
                DelegationChildDriver::Structured { .. } => {}
            }
        }
        let child = match respawn_existing_child(app, &delegation).await {
            Ok(child) => child,
            Err(error) => {
                let _ = state
                    .store
                    .update_delegation_status(delegation_id, DelegationStatus::Failed);
                emit_update(app, delegation.parent_task_id);
                return Err(error);
            }
        };
        state
            .delegation_children
            .lock()
            .await
            .insert(delegation_id.to_string(), Arc::clone(&child));
        child
    } else {
        existing_child.expect("existing child checked above")
    };

    let busy = *child.busy.lock().expect("busy lock");
    let delivered = if busy {
        false
    } else {
        *child.completed.lock().expect("completed lock") = false;
        state.store.reopen_delegation(delegation_id)?;
        match deliver_queued_messages_with_context(app, &child, rebuild).await {
            Ok(delivered) => delivered,
            Err(error) => {
                let _ = state
                    .store
                    .update_delegation_status(delegation_id, DelegationStatus::Failed);
                emit_update(app, delegation.parent_task_id);
                return Err(error);
            }
        }
    };
    emit_update(app, delegation.parent_task_id);
    Ok(json!({
        "queued": true,
        "delivered": delivered,
        "reopened": rebuild || !delegation.status.is_active(),
        "note": if delivered {
            "The subagent was ready; your message started its next turn."
        } else {
            "The subagent is mid-turn; your message is queued and will be delivered when it settles."
        },
    }))
}

pub async fn stop_delegation(
    app: &AppHandle<tauri::Wry>,
    delegation_id: DelegationId,
) -> Result<Value> {
    let state = app.state::<AppState>();
    let delegation = state.store.get_delegation(delegation_id)?;
    let child = state
        .delegation_children
        .lock()
        .await
        .remove(&delegation_id.to_string());
    if let Some(child) = child {
        match &child.driver {
            DelegationChildDriver::Structured { runtime, .. } => {
                let turn = runtime.current_turn.lock().expect("turn lock").clone();
                if let Some(turn) = turn {
                    let _ = runtime.client.cancel(&turn).await;
                }
            }
            DelegationChildDriver::Codex { runtime, .. } => {
                let _ = state.store.expire_process_approvals(&runtime.process_id);
                let _ = runtime.client.shutdown().await;
            }
            DelegationChildDriver::Acp {
                runtime,
                session_id,
            } => {
                // Cancel first so the in-flight prompt resolves as
                // `cancelled` rather than a transport error, then drop the
                // process — a reopened delegation respawns a fresh session.
                let _ = runtime.client.cancel(session_id).await;
                let _ = state.store.expire_process_approvals(&runtime.process_id);
                let _ = runtime.client.shutdown().await;
            }
        }
    }
    let updated = state
        .store
        .update_delegation_status(delegation_id, DelegationStatus::Stopped)?;
    emit_update(app, delegation.parent_task_id);
    Ok(json!({ "delegationId": delegation_id.to_string(), "status": updated.status.as_str() }))
}

// ---------------------------------------------------------------------------
// UI events
// ---------------------------------------------------------------------------

pub fn emit_update(app: &AppHandle<tauri::Wry>, parent_task_id: TaskId) {
    let _ = app.emit(
        DELEGATION_UPDATE_EVENT,
        json!({ "parentTaskId": parent_task_id.to_string() }),
    );
}

fn emit_update_for_delegation(app: &AppHandle<tauri::Wry>, delegation_id: DelegationId) {
    let state = app.state::<AppState>();
    if let Ok(delegation) = state.store.get_delegation(delegation_id) {
        emit_update(app, delegation.parent_task_id);
    }
}

/// The per-delegation view the UI lineage panel renders.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationView {
    #[serde(flatten)]
    pub delegation: Delegation,
    pub unread_from_child: u32,
    pub pending_questions: Vec<String>,
}

pub fn delegation_views(store: &LocalStore, parent_task_id: TaskId) -> Result<Vec<DelegationView>> {
    let unread: HashMap<String, u32> = store
        .unread_child_message_counts(parent_task_id)?
        .into_iter()
        .map(|(id, count)| (id.to_string(), count))
        .collect();
    store
        .list_delegations(parent_task_id)?
        .into_iter()
        .map(|delegation| {
            let pending_questions = store
                .undelivered_delegation_messages(delegation.id, false)?
                .into_iter()
                .map(|message| message.body)
                .collect();
            Ok(DelegationView {
                unread_from_child: unread.get(&delegation.id.to_string()).copied().unwrap_or(0),
                pending_questions,
                delegation,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tauri commands (UI surface)
// ---------------------------------------------------------------------------

use crate::commands::{CommandError, CommandResult};

#[tauri::command]
pub async fn delegation_list(
    state: tauri::State<'_, AppState>,
    task_id: TaskId,
) -> CommandResult<Vec<DelegationView>> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || delegation_views(&store, task_id))
        .await
        .map_err(|_| {
            CommandError::from(IntegratorError::Unavailable(
                "local worker stopped unexpectedly".into(),
            ))
        })?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn delegation_approve(
    app: AppHandle<tauri::Wry>,
    state: tauri::State<'_, AppState>,
    delegation_id: DelegationId,
) -> CommandResult<()> {
    let delegation = state
        .store
        .get_delegation(delegation_id)
        .map_err(CommandError::from)?;
    if delegation.status != DelegationStatus::PendingApproval {
        return Err(CommandError::from(IntegratorError::InvalidInput(format!(
            "delegation is {}; only pending delegations can be approved",
            delegation.status.as_str()
        ))));
    }
    if let Err(error) = spawn_child(app.clone(), delegation_id).await {
        let _ = state.store.set_delegation_result(
            delegation_id,
            DelegationStatus::Failed,
            &error.to_string(),
        );
        emit_update(&app, delegation.parent_task_id);
        return Err(CommandError::from(error));
    }
    Ok(())
}

#[tauri::command]
pub async fn delegation_deny(
    app: AppHandle<tauri::Wry>,
    state: tauri::State<'_, AppState>,
    delegation_id: DelegationId,
) -> CommandResult<()> {
    let delegation = state
        .store
        .update_delegation_status(delegation_id, DelegationStatus::Denied)
        .map_err(CommandError::from)?;
    emit_update(&app, delegation.parent_task_id);
    Ok(())
}

#[tauri::command]
pub async fn delegation_send_message(
    app: AppHandle<tauri::Wry>,
    delegation_id: DelegationId,
    message: String,
    routing: Option<DelegationRoutingInput>,
) -> CommandResult<Value> {
    queue_message_to_child(
        &app,
        delegation_id,
        DelegationSender::User,
        &message,
        routing,
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn delegation_stop_cmd(
    app: AppHandle<tauri::Wry>,
    delegation_id: DelegationId,
) -> CommandResult<Value> {
    stop_delegation(&app, delegation_id)
        .await
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_mcp_config_cleanup_is_narrow_and_idempotent() {
        let root = tempfile::tempdir().expect("temporary app data");
        assert_eq!(
            prune_stale_mcp_configs_in(root.path()).expect("missing directory cleanup"),
            0
        );
        let directory = root.path().join("broker-mcp");
        std::fs::create_dir_all(directory.join("keep.json"))
            .expect("create same-suffix directory sentinel");
        std::fs::write(directory.join("stale.json"), b"ephemeral token fixture")
            .expect("write stale config");
        std::fs::write(directory.join("keep.txt"), b"unrelated sentinel")
            .expect("write unrelated sentinel");

        assert_eq!(
            prune_stale_mcp_configs_in(root.path()).expect("prune stale config"),
            1
        );
        assert!(!directory.join("stale.json").exists());
        assert!(directory.join("keep.txt").is_file());
        assert!(directory.join("keep.json").is_dir());
        assert_eq!(
            prune_stale_mcp_configs_in(root.path()).expect("idempotent cleanup"),
            0
        );
    }

    #[test]
    fn codex_mcp_config_is_thread_scoped_and_required() {
        let config = codex_mcp_config(
            &BrokerInfo {
                port: 43123,
                token: "ephemeral-test-token".into(),
            },
            "orchestrator",
            "task-1",
            "balanced",
        )
        .expect("Codex MCP config");

        let server = &config["mcp_servers"]["integrator"];
        assert_eq!(server["args"], json!(["--broker-mcp"]));
        assert_eq!(server["required"], json!(true));
        assert_eq!(
            server["env"]["INTEGRATOR_BROKER_ADDR"],
            json!("127.0.0.1:43123")
        );
        assert_eq!(server["env"]["INTEGRATOR_BROKER_SCOPE"], json!("task-1"));
        assert_eq!(server["env"]["INTEGRATOR_BROKER_MODE"], json!("balanced"));
    }

    #[test]
    fn acp_mcp_entry_carries_the_orchestrator_scope_for_cursor_and_grok() {
        let entry = acp_mcp_server_entry(
            &BrokerInfo {
                port: 43124,
                token: "ephemeral-test-token".into(),
            },
            "orchestrator",
            "task-2",
            "manual",
        )
        .expect("ACP MCP entry");

        assert_eq!(entry["name"], json!("integrator"));
        assert_eq!(entry["args"], json!(["--broker-mcp"]));
        let env = entry["env"].as_array().expect("ACP env array");
        assert!(env.iter().any(|value| {
            value["name"] == "INTEGRATOR_BROKER_SCOPE" && value["value"] == "task-2"
        }));
        assert!(env.iter().any(|value| {
            value["name"] == "INTEGRATOR_BROKER_MODE" && value["value"] == "manual"
        }));
    }

    #[test]
    fn profiles_fall_back_to_defaults_and_sort_by_cost() {
        let store = LocalStore::open_in_memory().expect("store");
        let mut profiles = delegation_profiles(&store);
        assert!(profiles.iter().any(|profile| profile.runtime == "codex"));
        profiles.sort_by_key(|profile| cost_rank(&profile.cost_tier));
        assert_eq!(profiles.first().map(|p| p.cost_tier.as_str()), Some("low"));
    }

    #[test]
    fn default_profiles_cover_every_supported_child_runtime() {
        let store = LocalStore::open_in_memory().expect("store");
        let profiles = delegation_profiles(&store);
        for runtime in ["codex", "claude", "antigravity", "cursor", "grok"] {
            assert!(
                profiles.iter().any(|profile| profile.runtime == runtime),
                "missing built-in profile for {runtime}"
            );
        }
    }

    #[test]
    fn acp_children_pin_the_agent_mode_only_when_needed() {
        let planning = json!({
            "sessionId": "session-1",
            "modes": {
                "currentModeId": "plan",
                "availableModes": [
                    { "id": "agent", "name": "Agent" },
                    { "id": "plan", "name": "Plan" },
                    { "id": "ask", "name": "Ask" }
                ]
            }
        });
        assert_eq!(acp_agent_mode_target(&planning), Some("agent".into()));

        let already_agent = json!({
            "modes": {
                "currentModeId": "agent",
                "availableModes": [{ "id": "agent", "name": "Agent" }]
            }
        });
        assert_eq!(acp_agent_mode_target(&already_agent), None);
        // Agents without session modes (Grok) skip the pin entirely.
        assert_eq!(
            acp_agent_mode_target(&json!({ "sessionId": "session-1" })),
            None
        );
    }

    #[test]
    fn acp_model_config_resolves_bracketed_session_values() {
        let response = json!({
            "configOptions": [
                { "id": "model", "category": "model", "options": [
                    { "name": "Frontier", "options": [
                        { "value": "gpt-5.5[reasoning=medium]", "name": "GPT-5.5" }
                    ]},
                    { "value": "composer-2.5", "name": "Composer" }
                ]}
            ]
        });
        let (config_id, values) =
            acp_session_config(&response, "model", &["model", "models"]).expect("model option");
        assert_eq!(config_id, "model");
        assert_eq!(
            resolve_acp_model(&values, "gpt-5.5"),
            Some("gpt-5.5[reasoning=medium]")
        );
        assert_eq!(
            resolve_acp_model(&values, "composer-2.5"),
            Some("composer-2.5")
        );
        assert_eq!(resolve_acp_model(&values, "missing"), None);
    }

    #[test]
    fn cursor_effort_config_is_per_model() {
        let response = json!({
            "models": [
                { "value": "gpt-5.5", "configOptions": [
                    { "id": "effort", "category": "thought_level", "currentValue": "medium",
                      "options": [
                        { "value": "low" }, { "value": "medium" }, { "value": "high" }
                    ]}
                ]}
            ]
        });
        let (config_id, values) =
            cursor_effort_config(&response, "gpt-5.5").expect("effort option");
        assert_eq!(config_id, "effort");
        assert!(values.iter().any(|value| value == "high"));
        assert!(cursor_effort_config(&response, "other-model").is_none());
    }

    #[test]
    fn stored_profiles_override_defaults() {
        let store = LocalStore::open_in_memory().expect("store");
        store
            .set_setting(
                "settings.delegation.profiles",
                json!([{ "id": "only", "label": "Only", "runtime": "claude", "costTier": "low" }]),
            )
            .expect("set profiles");
        let profiles = delegation_profiles(&store);
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, "only");
        assert!(profiles[0].enabled);
    }

    #[test]
    fn preamble_reflects_mode_and_custom_instruction() {
        let store = LocalStore::open_in_memory().expect("store");
        store
            .set_setting(
                "settings.delegation.instruction",
                json!("Prefer Codex for mechanical work."),
            )
            .expect("set instruction");
        let preamble = orchestrator_preamble(&store, "budget-first");
        assert!(preamble.contains("budget-first"));
        assert!(preamble.contains("Prefer Codex for mechanical work."));
        assert!(preamble.contains("delegate_start"));
    }

    #[test]
    fn child_preamble_includes_specialist_and_downstream_preferences() {
        let delegation = Delegation {
            id: DelegationId::new(),
            parent_task_id: TaskId::new(),
            child_task_id: None,
            profile_id: "claude-ux".into(),
            profile_label: "Claude UX".into(),
            runtime: "claude".into(),
            model: Some("claude-fable-5".into()),
            effort: Some("high".into()),
            title: "Interaction audit".into(),
            brief: "Review the flow".into(),
            status: DelegationStatus::Starting,
            result: None,
            child_session_ref: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let profile = DelegationProfile {
            id: "claude-ux".into(),
            label: "Claude UX".into(),
            runtime: "claude".into(),
            model: Some("claude-fable-5".into()),
            effort: Some("high".into()),
            instruction: Some("Test keyboard and reduced-motion behavior.".into()),
            preferred_child_profile_ids: vec!["luna-explore".into()],
            cost_tier: "high".into(),
            enabled: true,
        };
        let prompt = child_preamble(&delegation, true, Some(&profile), &["Luna explorer".into()]);
        assert!(prompt.contains("Test keyboard and reduced-motion behavior."));
        assert!(prompt.contains("Luna explorer"));
        assert!(prompt.contains("task_complete"));
    }
}
