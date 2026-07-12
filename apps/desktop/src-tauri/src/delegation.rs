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

use std::{collections::HashMap, path::PathBuf, str::FromStr, sync::Arc};

use chrono::Utc;
use integrator_core::{
    Delegation, DelegationId, DelegationSender, DelegationStatus, IntegratorError, ItemKind,
    ItemProjection, ItemStatus, ProviderKind, Result, RuntimeBinding, TaskId, TurnStatus,
};
use integrator_runtime::{
    ProjectionMutation, ReducedProviderEvent, StructuredCliEventKind, StructuredCliLaunchOptions,
    StructuredCliProvider, StructuredPermissionMode, acp_turn_projection, discover_providers,
    provider_executable, redact_and_bound,
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
    AppState, CodexRuntime, DelegationChild, DelegationChildDriver, StructuredRuntime,
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
    #[serde(default = "default_cost_tier")]
    pub cost_tier: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
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
            cost_tier: "low".into(),
            enabled: true,
        },
        DelegationProfile {
            id: "claude-default".into(),
            label: "Claude".into(),
            runtime: "claude".into(),
            model: None,
            effort: None,
            cost_tier: "high".into(),
            enabled: true,
        },
        DelegationProfile {
            id: "antigravity-default".into(),
            label: "Antigravity (Gemini)".into(),
            runtime: "antigravity".into(),
            model: None,
            effort: None,
            cost_tier: "medium".into(),
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

fn child_preamble(delegation: &Delegation, has_tools: bool) -> String {
    let mut block = format!(
        "<subagent-brief>\nYou are a delegated subagent working on behalf of an orchestrator agent in this repository. Your assignment: {}\n\n{}\n",
        delegation.title, delegation.brief
    );
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
    std::fs::write(&path, serde_json::to_vec_pretty(&config)?).map_err(IntegratorError::from)?;
    Ok(path)
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
            queue_message_to_child(app, delegation.id, DelegationSender::Orchestrator, &message)
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
        if let Some(filter) = &filter {
            if delegation.id.to_string() != *filter {
                continue;
            }
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
    let executable = provider_executable(&statuses, provider.clone()).ok_or_else(|| {
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
            first_prompt.push_str(&child_preamble(&delegation, has_tools));
            let mcp_config = match (&broker, provider.clone()) {
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
            first_prompt.push_str(&child_preamble(&delegation, false));
            spawn_codex_child(&app, &delegation, child_task.id, executable, cwd).await?
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
    let binding =
        state
            .store
            .create_runtime_binding(child_task_id, &process_id, provider.clone())?;
    let binding = state.store.attach_provider_thread(&binding, &thread_id)?;
    let runtime = StructuredRuntime {
        client: client.clone(),
        process_id,
        binding: Arc::new(std::sync::Mutex::new(Some(binding.clone()))),
        current_turn: Arc::new(std::sync::Mutex::new(None)),
        last_diagnostic: Arc::new(std::sync::Mutex::new(None)),
        permission_requests: Arc::new(std::sync::Mutex::new(HashMap::new())),
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
            session_ref: Arc::new(std::sync::Mutex::new(None)),
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
        binding: Arc::new(std::sync::Mutex::new(Some(binding))),
        context_primer: Arc::new(std::sync::Mutex::new(None)),
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

/// Starts (or resumes) one child turn with the given wire prompt, recording
/// synthetic user/turn projections for structured providers so the child's
/// transcript shows what was injected.
async fn start_child_turn(
    app: &AppHandle<tauri::Wry>,
    child: &Arc<DelegationChild>,
    prompt: String,
) -> Result<()> {
    *child.busy.lock().expect("busy lock") = true;
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
    }
    Ok(())
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
    let session_ref = match &child.driver {
        DelegationChildDriver::Structured { session_ref, .. } => Arc::clone(session_ref),
        DelegationChildDriver::Codex { .. } => return,
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
                child_turn_settled(app.clone(), delegation_id, failed).await;
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
                        child_turn_settled(app.clone(), delegation_id, failed).await;
                    }
                }
                adapter_codex::CodexEvent::Exited => {
                    child_turn_settled(app.clone(), delegation_id, true).await;
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
async fn child_turn_settled(app: AppHandle<tauri::Wry>, delegation_id: DelegationId, failed: bool) {
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
    let mut prompt = String::from("<orchestrator-message>\nNew guidance from your orchestrator:\n");
    for message in &messages {
        prompt.push_str(&format!("- {}\n", message.body));
    }
    prompt.push_str("</orchestrator-message>\nContinue your assignment accordingly.");
    state.store.mark_delegation_messages_delivered(
        &messages
            .iter()
            .map(|message| message.id.clone())
            .collect::<Vec<_>>(),
    )?;
    let _ = state
        .store
        .update_delegation_status(child.delegation_id, DelegationStatus::Running);
    start_child_turn(app, child, prompt).await?;
    Ok(true)
}

/// User or orchestrator message to a child: queued always, delivered now if
/// the child is idle.
pub async fn queue_message_to_child(
    app: &AppHandle<tauri::Wry>,
    delegation_id: DelegationId,
    sender: DelegationSender,
    message: &str,
) -> Result<Value> {
    let state = app.state::<AppState>();
    let delegation = state.store.get_delegation(delegation_id)?;
    if !matches!(
        delegation.status,
        DelegationStatus::Running | DelegationStatus::Waiting | DelegationStatus::Starting
    ) {
        return Err(IntegratorError::InvalidInput(format!(
            "delegation is {}; messages can only reach active subagents",
            delegation.status.as_str()
        )));
    }
    state
        .store
        .add_delegation_message(delegation_id, sender, message)?;
    let child = state
        .delegation_children
        .lock()
        .await
        .get(&delegation_id.to_string())
        .cloned();
    let delivered = match child {
        Some(child) if !*child.busy.lock().expect("busy lock") => {
            deliver_queued_messages(app, &child).await.unwrap_or(false)
        }
        _ => false,
    };
    emit_update(app, delegation.parent_task_id);
    Ok(json!({
        "queued": true,
        "delivered": delivered,
        "note": if delivered {
            "The subagent was idle; your message started its next turn."
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
) -> CommandResult<Value> {
    queue_message_to_child(&app, delegation_id, DelegationSender::User, &message)
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
    fn profiles_fall_back_to_defaults_and_sort_by_cost() {
        let store = LocalStore::open_in_memory().expect("store");
        let mut profiles = delegation_profiles(&store);
        assert!(profiles.iter().any(|profile| profile.runtime == "codex"));
        profiles.sort_by_key(|profile| cost_rank(&profile.cost_tier));
        assert_eq!(profiles.first().map(|p| p.cost_tier.as_str()), Some("low"));
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
}
