//! Integrator local tool host and delegation broker.
//!
//! The broker listens on a loopback TCP port with a per-app-run token. Agent
//! sessions reach it through `integrator.exe --broker-mcp`, a thin stdio MCP
//! server injected into provider CLIs (see `broker_mcp.rs`), which forwards
//! every `tools/call` here as one line-delimited JSON-RPC request.
//!
//! Secure skill data requests and delegation calls share the same
//! token-authenticated loopback transport, but credentials remain inside the
//! running app and are never returned by the broker. Delegation is fully
//! asynchronous. `delegate_start` returns immediately;
//! children run in their own tasks/processes; messages queue in SQLite and
//! deliver only when the recipient is idle (children) or pulls them
//! (orchestrators). Nothing here ever interrupts the user's conversation.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    str::FromStr,
    sync::Arc,
    time::Duration,
};

use chrono::{DateTime, Utc};
use integrator_core::{
    AutomationId, AutomationRoute, AutomationSource, AutomationTarget, AutomationTrigger,
    Delegation, DelegationCapabilitySnapshot, DelegationId, DelegationPermission, DelegationRoute,
    DelegationSender, DelegationStatus, IntegratorError, ItemKind, ItemProjection, ItemStatus,
    MemoryCreator, NewMemoryEntry, ProviderKind, Result, RuntimeBinding, TaskId, TaskKind,
    TurnStatus,
};
use integrator_runtime::{
    ProjectionMutation, ReducedProviderEvent, StructuredCliEventKind, StructuredCliLaunchOptions,
    StructuredCliProvider, StructuredPermissionMode, acp_turn_projection, parse_acp_mode_state,
    provider_executable, redact_and_bound,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use session_store::{LocalStore, NewAutomation, NewDelegation};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
};
use zeroize::Zeroizing;

use crate::{
    chat_title::{format_subagent_title, generate_subagent_title},
    interrupted_turn::{INTERRUPTED_RESUME_VISIBLE_PROMPT, interrupted_resume_wire_prompt},
    state::{
        AcpRuntime, AcpSessionSpec, AppState, CodexRuntime, DelegationChild, DelegationChildDriver,
        StructuredRuntime,
    },
};

pub const DELEGATION_UPDATE_EVENT: &str = "delegation://update";
const CHILD_DIGEST_OPTIONS: session_store::HandoffDigestOptions =
    session_store::HandoffDigestOptions {
        max_tokens: session_store::HANDOFF_CHILD_MAX_TOKENS,
        max_turns: session_store::HANDOFF_DEFAULT_MAX_TURNS,
        max_images: session_store::HANDOFF_DEFAULT_MAX_IMAGES,
    };
const MAX_LINE_BYTES: usize = 256 * 1024;
const BROKER_AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BROKER_CONNECTIONS: usize = 64;
const MAX_SPECIALISTS: usize = 64;
const MAX_SPECIALIST_CAPABILITIES: usize = 128;
const MAX_SERVICE_FALLBACKS: usize = 4;

// ---------------------------------------------------------------------------
// Settings-backed policy
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationProfile {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub best_for: String,
    #[serde(default)]
    pub working_guidance: String,
    #[serde(default)]
    pub access: Option<DelegationPermission>,
    #[serde(default)]
    pub service_levels: Vec<DelegationServiceLevel>,
    #[serde(default)]
    pub skill_ids: Vec<String>,
    #[serde(default)]
    pub mcp_server_ids: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    // Legacy fields are accepted only to migrate existing local settings.
    #[serde(default, skip_serializing)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default, skip_serializing)]
    pub instruction: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationServiceLevel {
    pub level: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub primary: DelegationRoute,
    #[serde(default)]
    pub fallbacks_enabled: bool,
    #[serde(default)]
    pub fallbacks: Vec<DelegationRoute>,
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

const fn default_true() -> bool {
    true
}

fn service_rank(level: &str) -> u8 {
    match level {
        "budget" => 0,
        "standard" => 1,
        _ => 2,
    }
}

fn default_service_level(
    runtime: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> DelegationServiceLevel {
    DelegationServiceLevel {
        level: "standard".into(),
        enabled: true,
        primary: DelegationRoute {
            runtime: runtime.into(),
            model: model.map(str::to_owned),
            effort: effort.map(str::to_owned),
        },
        fallbacks_enabled: false,
        fallbacks: Vec::new(),
    }
}

/// Built-in fallbacks so delegation works before the user has ever opened
/// the Subagents settings page. Providers that are not installed fail at
/// `delegate_start` with a clear diagnostic instead of being hidden here.
fn default_profiles() -> Vec<DelegationProfile> {
    vec![
        DelegationProfile {
            id: "codex-default".into(),
            label: "Repository Engineer".into(),
            best_for: "Implementation, tests, and careful repository work.".into(),
            working_guidance: String::new(),
            access: Some(DelegationPermission::ReadOnly),
            service_levels: vec![default_service_level("codex", None, None)],
            skill_ids: Vec::new(),
            mcp_server_ids: Vec::new(),
            runtime: None,
            model: None,
            effort: None,
            instruction: None,
            enabled: true,
        },
        DelegationProfile {
            id: "claude-default".into(),
            label: "Product & Code Critic".into(),
            best_for: "Review, synthesis, and nuanced product reasoning.".into(),
            working_guidance: String::new(),
            access: Some(DelegationPermission::ReadOnly),
            service_levels: vec![default_service_level("claude", None, None)],
            skill_ids: Vec::new(),
            mcp_server_ids: Vec::new(),
            runtime: None,
            model: None,
            effort: None,
            instruction: None,
            enabled: true,
        },
        DelegationProfile {
            id: "antigravity-default".into(),
            label: "Research Explorer".into(),
            best_for: "Broad exploration and alternate implementation approaches.".into(),
            working_guidance: String::new(),
            access: Some(DelegationPermission::ReadOnly),
            service_levels: vec![default_service_level("antigravity", None, None)],
            skill_ids: Vec::new(),
            mcp_server_ids: Vec::new(),
            runtime: None,
            model: None,
            effort: None,
            instruction: None,
            enabled: true,
        },
        DelegationProfile {
            id: "cursor-default".into(),
            label: "Codebase Navigator".into(),
            best_for: "Focused codebase navigation and implementation.".into(),
            working_guidance: String::new(),
            access: Some(DelegationPermission::ReadOnly),
            service_levels: vec![default_service_level("cursor", None, None)],
            skill_ids: Vec::new(),
            mcp_server_ids: Vec::new(),
            runtime: None,
            model: None,
            effort: None,
            instruction: None,
            enabled: true,
        },
        DelegationProfile {
            id: "grok-default".into(),
            label: "Verification Runner".into(),
            best_for: "Fast mechanical work and second-pass verification.".into(),
            working_guidance: String::new(),
            access: Some(DelegationPermission::ReadOnly),
            service_levels: vec![default_service_level("grok", None, None)],
            skill_ids: Vec::new(),
            mcp_server_ids: Vec::new(),
            runtime: None,
            model: None,
            effort: None,
            instruction: None,
            enabled: true,
        },
        DelegationProfile {
            id: "kimi-default".into(),
            label: "Long-Context Analyst".into(),
            best_for: "Long-context repository work and an independent coding pass.".into(),
            working_guidance: String::new(),
            access: Some(DelegationPermission::ReadOnly),
            service_levels: vec![default_service_level("kimi", None, None)],
            skill_ids: Vec::new(),
            mcp_server_ids: Vec::new(),
            runtime: None,
            model: None,
            effort: None,
            instruction: None,
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
    let Some(value) = read_setting(store, "settings.delegation.profiles") else {
        return default_profiles();
    };
    let Ok(profiles) = serde_json::from_value::<Vec<DelegationProfile>>(value) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    profiles
        .into_iter()
        .take(MAX_SPECIALISTS)
        .filter_map(normalize_profile)
        .filter(|profile| seen.insert(profile.id.clone()))
        .collect()
}

fn normalize_profile(mut profile: DelegationProfile) -> Option<DelegationProfile> {
    profile.id = profile.id.trim().to_owned();
    profile.label = profile.label.trim().to_owned();
    profile.label = migrated_default_label(&profile.id, &profile.label).into();
    if profile.id.is_empty()
        || profile.label.is_empty()
        || profile.id.len() > 128
        || profile.label.chars().count() > 120
    {
        return None;
    }
    if profile.service_levels.is_empty() {
        let runtime = profile.runtime.as_deref()?;
        ProviderKind::from_str(runtime).ok()?;
        profile.service_levels = vec![default_service_level(
            runtime,
            profile.model.as_deref(),
            profile.effort.as_deref(),
        )];
        profile.working_guidance = profile.instruction.take().unwrap_or_default();
        profile.access = Some(DelegationPermission::ProjectWrite);
    }
    let mut levels = std::collections::HashSet::new();
    profile.service_levels = profile
        .service_levels
        .into_iter()
        .filter_map(|mut service| {
            service.level = service.level.trim().to_owned();
            if !matches!(service.level.as_str(), "budget" | "standard" | "premium")
                || !levels.insert(service.level.clone())
            {
                return None;
            }
            service.primary = normalize_route(service.primary)?;
            let mut seen_routes = std::collections::HashSet::new();
            seen_routes.insert(service.primary.clone());
            service.fallbacks = service
                .fallbacks
                .into_iter()
                .filter_map(normalize_route)
                .filter(|route| seen_routes.insert(route.clone()))
                .take(MAX_SERVICE_FALLBACKS)
                .collect();
            Some(service)
        })
        .collect();
    if profile.service_levels.is_empty() {
        return None;
    }
    profile.skill_ids = normalize_capability_ids(profile.skill_ids);
    profile.mcp_server_ids = normalize_capability_ids(profile.mcp_server_ids);
    profile.best_for = profile.best_for.trim().chars().take(2_000).collect();
    profile.working_guidance = profile
        .working_guidance
        .trim()
        .chars()
        .take(64 * 1024)
        .collect();
    Some(profile)
}

fn migrated_default_label<'a>(id: &str, label: &'a str) -> &'a str {
    match (id, label) {
        ("codex-default", "Codex (OpenAI)") => "Repository Engineer",
        ("claude-default", "Claude") => "Product & Code Critic",
        ("antigravity-default", "Antigravity (Gemini)") => "Research Explorer",
        ("cursor-default", "Cursor") => "Codebase Navigator",
        ("grok-default", "Grok Build") => "Verification Runner",
        ("kimi-default", "Kimi Code") => "Long-Context Analyst",
        _ => label,
    }
}

fn normalize_route(mut route: DelegationRoute) -> Option<DelegationRoute> {
    route.runtime = route.runtime.trim().to_owned();
    let provider = ProviderKind::from_str(&route.runtime).ok()?;
    if !matches!(
        provider,
        ProviderKind::Codex
            | ProviderKind::Claude
            | ProviderKind::Antigravity
            | ProviderKind::Cursor
            | ProviderKind::Grok
            | ProviderKind::Kimi
    ) {
        return None;
    }
    route.model = normalized_optional_text(route.model, 256);
    route.effort = normalized_optional_text(route.effort, 64);
    Some(route)
}

fn normalized_optional_text(value: Option<String>, max_chars: usize) -> Option<String> {
    value
        .map(|value| value.trim().chars().take(max_chars).collect::<String>())
        .filter(|value| !value.is_empty())
}

fn normalize_capability_ids(ids: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    ids.into_iter()
        .map(|id| id.trim().chars().take(256).collect::<String>())
        .filter(|id| !id.is_empty() && seen.insert(id.clone()))
        .take(MAX_SPECIALIST_CAPABILITIES)
        .collect()
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
        .map_or(3, |value| value.clamp(1, 4) as u32)
}

fn custom_instruction(store: &LocalStore) -> Option<String> {
    read_setting(store, "settings.delegation.instruction")
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|value| !value.trim().is_empty())
}

fn select_service_level<'a>(
    profile: &'a DelegationProfile,
    requested: Option<&str>,
    mode: &str,
) -> Result<&'a DelegationServiceLevel> {
    if let Some(requested) = requested {
        if !matches!(requested, "budget" | "standard" | "premium") {
            return Err(IntegratorError::InvalidInput(format!(
                "unknown specialist service level '{requested}'"
            )));
        }
        return profile
            .service_levels
            .iter()
            .find(|service| service.enabled && service.level == requested)
            .ok_or_else(|| {
                IntegratorError::Unavailable(format!(
                    "specialist '{}' does not offer the {requested} service level",
                    profile.label
                ))
            });
    }

    let preferred = if mode == "budget-first" {
        "budget"
    } else {
        "standard"
    };
    profile
        .service_levels
        .iter()
        .find(|service| service.enabled && service.level == preferred)
        .or_else(|| {
            profile
                .service_levels
                .iter()
                .filter(|service| service.enabled)
                .min_by_key(|service| service_rank(&service.level))
        })
        .ok_or_else(|| {
            IntegratorError::Unavailable(format!(
                "specialist '{}' has no enabled service level",
                profile.label
            ))
        })
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/// Durable delegation contract for an orchestrator session. Spells out the
/// full workflow inline: agents that only saw tool names have gone hunting
/// through the repository for how "Integrator delegation" works instead of
/// just calling the tools. Provider sessions keep their history, so this
/// block must enter each session once, not ride every turn: Claude carries
/// it in the per-process system layer (`--append-system-prompt`), Codex and
/// ACP inject it into the thread/session once and repeat it only when its
/// content changes.
pub fn orchestrator_preamble(store: &LocalStore, mode: &str) -> String {
    let mut block = String::from(
        "<delegation>\nYou can delegate subtasks to saved specialists or mint a one-off specialist with its own durable working instructions. The tools are already connected on the `integrator` MCP server: peers_list, delegate_start, delegation_status, delegation_message, delegation_thread, delegation_result, delegation_stop. Call them directly — do not search this repository, read Integrator source code, or shell out to provider CLIs to figure out how delegation works. This block plus the tool descriptions are the complete contract.\n\nWorkflow:\n1. For a saved specialist, call peers_list, choose by Best for, then use delegate_start(profileId, serviceLevel, title, brief, permission). The profile's route, fallbacks, guidance, access, Skills/Plugins, and MCPs are frozen at launch.\n2. When the task benefits from a purpose-built way of thinking rather than saved capabilities, use delegate_start(name, instructions, title, brief). instructions are the durable special sauce: role, reasoning discipline, checks, style, and working method. brief is only the immediate task: goal, constraints, relevant context, and exact deliverable. One-off specialists use this chat's current route, are read-only, and receive no optional Skills or MCP grants.\n3. The child sees only a short digest of recent conversation plus the frozen instructions and brief, so both must stand alone. Do not repeat the task in instructions; do not put durable working method only in brief.\n4. delegate_start returns a delegationId immediately and the subagent runs in the background. Do not block waiting on it — continue your own work, and launch several delegations in parallel when subtasks are independent.\n5. delegation_status — check progress when convenient and whenever a <delegation-update> block appears in your prompt. Subagents may queue questions or progress reports mid-run; answer with delegation_message(delegationId, message). Use delegation_thread(delegationId) when you need the persisted child conversation rather than its compact status. The user can open the same transcript in the Agents rail.\n6. delegation_result(delegationId) — collect the finished deliverable (the subagent's summary plus a transcript digest) and integrate it. Verify delegated work before relying on it; your task is not done while delegations you still need are running.\n7. delegation_stop(delegationId) — stop a subagent you no longer need.\n",
    );
    match mode {
        "manual" => block.push_str(
            "Mode: manual — every delegate_start waits for the user to approve it in the task's Agents rail (right panel) before the subagent launches. Approving the tool call in chat is not the same thing; if a delegation stays pending-approval, tell the user to open the Agents rail and press Approve there.\n",
        ),
        "budget-first" => block.push_str(
            "Mode: budget-first — prefer an enabled Budget service level on the best-matched specialist; the host falls back to its cheapest enabled level when Budget is unavailable.\n",
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

fn specialist_instructions_block(delegation: &Delegation) -> Option<String> {
    let instruction = delegation.capability_snapshot.working_guidance.trim();
    (!instruction.is_empty()).then(|| {
        format!(
            "<specialist-instructions>\n{}\n</specialist-instructions>\n",
            redact_and_bound(instruction, 64 * 1024).0
        )
    })
}

fn child_preamble(delegation: &Delegation, has_tools: bool) -> String {
    let mut block = format!(
        "<subagent-brief>\nYou are a delegated subagent working on behalf of an orchestrator agent in this repository. Your assignment: {}\nWorkspace permission: {}. This boundary is enforced by the host; do not ask to widen it.\n\n",
        delegation.title,
        delegation.permission.as_str(),
    );
    if let Some(instructions) = specialist_instructions_block(delegation) {
        block.push_str(&instructions);
        block.push('\n');
    }
    block.push_str("<task-brief>\n");
    block.push_str(&delegation.brief);
    block.push_str("\n</task-brief>\n");
    if has_tools {
        block.push_str(
            "\nReporting back: your orchestrator may inspect this transcript, but use the `integrator` MCP tools for active coordination so questions and progress are surfaced immediately.\n- task_complete(summary): call this exactly once when your assignment is done. The summary is your entire deliverable — state what you did, files touched, key decisions, and caveats. Ending your final turn without calling task_complete leaves the orchestrator waiting on you.\n- orchestrator_ask(message): queue a question when you are blocked or the brief is ambiguous. Include enough context to answer without opening your transcript. Delivery is asynchronous — keep making progress on anything that does not depend on the answer.\n- orchestrator_report(message): send short progress notes during long-running work; fire and forget.\n",
        );
    } else {
        block.push_str(
            "\nReporting back: your orchestrator may inspect this transcript, but this runtime has no live messaging tools. Instead, Integrator scans your replies for the following blocks and routes them to the orchestrator. Write each block as plain text on its own lines — never inside a code fence, and never as an example you do not mean.\n- <integrator:complete>…</integrator:complete> — emit exactly once, when your assignment is done. Its contents are recorded as your entire deliverable: what you did, files touched, key decisions, caveats.\n- <integrator:ask>…</integrator:ask> — when you are blocked or the brief is ambiguous. Include enough context to answer without requiring transcript inspection; the answer arrives in a later turn, so keep making progress on anything that does not depend on it.\n- <integrator:report>…</integrator:report> — short progress notes during long-running work; fire and forget.\nIf you finish without emitting <integrator:complete>, your final reply is captured as your deliverable instead — but prefer the block.\n",
        );
    }
    block.push_str("</subagent-brief>\n\n");
    block
}

// ---------------------------------------------------------------------------
// Broker transport (host side)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct BrokerGrant {
    role: String,
    scope: String,
    mode: String,
}

#[derive(Clone, Debug)]
pub struct BrokerInfo {
    pub port: u16,
    grants: Arc<std::sync::Mutex<HashMap<String, BrokerGrant>>>,
}

impl BrokerInfo {
    fn new(port: u16) -> Self {
        Self {
            port,
            grants: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }
}

pub fn broker_env(
    info: &BrokerInfo,
    role: &str,
    scope: &str,
    mode: &str,
) -> Vec<(&'static str, String)> {
    let token = uuid::Uuid::new_v4().to_string();
    info.grants.lock().expect("broker grants lock").insert(
        token.clone(),
        BrokerGrant {
            role: role.into(),
            scope: scope.into(),
            mode: mode.into(),
        },
    );
    vec![
        ("INTEGRATOR_BROKER_ADDR", format!("127.0.0.1:{}", info.port)),
        ("INTEGRATOR_BROKER_TOKEN", token),
        ("INTEGRATOR_BROKER_ROLE", role.into()),
        ("INTEGRATOR_BROKER_SCOPE", scope.into()),
        ("INTEGRATOR_BROKER_MODE", mode.into()),
    ]
}

/// Thread-scoped Codex config for Integrator's local tools. Keeping this on
/// `thread/start` avoids mutating the user's global Codex configuration and
/// gives every task its own scope and short-lived app-run token.
pub fn codex_mcp_config(info: &BrokerInfo, role: &str, scope: &str, mode: &str) -> Result<Value> {
    let executable = std::env::current_exe().map_err(IntegratorError::from)?;
    let env: serde_json::Map<String, Value> = broker_env(info, role, scope, mode)
        .into_iter()
        .map(|(key, value)| (key.to_owned(), Value::String(value)))
        .collect();
    let enabled_tools = match role {
        "chat" if mode == "memory-on" => json!([
            "memory_save",
            "schedule_wakeup",
            "schedule_recurring",
            "automation_list",
            "automation_leave_note",
            "automation_cancel",
            "browser_open",
            "browser_list",
            "browser_close",
            "browser_focus",
            "browser_pop_out",
            "browser_dock",
            "browser_fill_login",
            "browser_cookies",
            "browser_navigate",
            "browser_snapshot",
            "browser_screenshot",
            "browser_click",
            "browser_hover",
            "browser_type",
            "browser_press",
            "browser_scroll",
            "browser_drag",
            "browser_wait_for",
        ]),
        "chat" => json!([
            "schedule_wakeup",
            "schedule_recurring",
            "automation_list",
            "automation_leave_note",
            "automation_cancel",
            "browser_open",
            "browser_list",
            "browser_close",
            "browser_focus",
            "browser_pop_out",
            "browser_dock",
            "browser_fill_login",
            "browser_cookies",
            "browser_navigate",
            "browser_snapshot",
            "browser_screenshot",
            "browser_click",
            "browser_hover",
            "browser_type",
            "browser_press",
            "browser_scroll",
            "browser_drag",
            "browser_wait_for",
        ]),
        // A child browses inside its parent's task, owning what it opens. It
        // never gets browser_grant: a tab it was handed is not its to pass on.
        "child" => json!([
            "skill_data_request",
            "task_complete",
            "orchestrator_ask",
            "orchestrator_report",
            "browser_open",
            "browser_list",
            "browser_close",
            "browser_focus",
            "browser_pop_out",
            "browser_dock",
            "browser_fill_login",
            "browser_cookies",
            "browser_navigate",
            "browser_snapshot",
            "browser_screenshot",
            "browser_click",
            "browser_hover",
            "browser_type",
            "browser_press",
            "browser_scroll",
            "browser_drag",
            "browser_wait_for",
        ]),
        _ if mode == "off" => json!([
            "skill_data_request",
            "schedule_wakeup",
            "schedule_recurring",
            "automation_list",
            "automation_leave_note",
            "automation_cancel",
            "browser_open",
            "browser_list",
            "browser_close",
            "browser_grant",
            "browser_focus",
            "browser_pop_out",
            "browser_dock",
            "browser_fill_login",
            "browser_cookies",
            "browser_navigate",
            "browser_snapshot",
            "browser_screenshot",
            "browser_click",
            "browser_hover",
            "browser_type",
            "browser_press",
            "browser_scroll",
            "browser_drag",
            "browser_wait_for",
        ]),
        _ => json!([
            "skill_data_request",
            "schedule_wakeup",
            "schedule_recurring",
            "automation_list",
            "automation_leave_note",
            "automation_cancel",
            "peers_list",
            "delegate_start",
            "delegation_status",
            "delegation_message",
            "delegation_thread",
            "delegation_result",
            "delegation_stop",
            "browser_open",
            "browser_list",
            "browser_close",
            "browser_grant",
            "browser_focus",
            "browser_pop_out",
            "browser_dock",
            "browser_fill_login",
            "browser_cookies",
            "browser_navigate",
            "browser_snapshot",
            "browser_screenshot",
            "browser_click",
            "browser_hover",
            "browser_type",
            "browser_press",
            "browser_scroll",
            "browser_drag",
            "browser_wait_for",
        ]),
    };
    Ok(json!({
        "mcp_servers": {
            "integrator": {
                "command": executable.to_string_lossy(),
                "args": ["--broker-mcp"],
                "env": env,
                "required": true,
                "enabled_tools": enabled_tools,
                // These tools already have narrower native boundaries: skill
                // data is read-only and origin-allowlisted; delegation is
                // scoped by mode, profiles, concurrency, and the Agents-rail
                // gate. A second Codex MCP prompt cannot be surfaced by
                // Integrator and deadlocks before the host receives the call.
                "default_tools_approval_mode": "approve",
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
    let safe_segment = |value: &str| {
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    };
    if !safe_segment(role) || !safe_segment(scope) {
        return Err(IntegratorError::InvalidInput(
            "broker MCP config identity is invalid".into(),
        ));
    }
    let executable = std::env::current_exe().map_err(IntegratorError::from)?;
    let state = app.state::<AppState>();
    let directory = crate::integrator_mcp::private_descendant(
        &state.data_directory,
        Path::new("broker-mcp"),
        true,
    )
    .map_err(IntegratorError::from)?
    .ok_or_else(|| IntegratorError::Unavailable("broker MCP directory was not created".into()))?;
    let env: serde_json::Map<String, Value> = broker_env(info, role, scope, mode)
        .into_iter()
        .map(|(key, value)| (key.to_owned(), Value::String(value)))
        .collect();
    let mut config = json!({
        "mcpServers": {
            "integrator": {
                "command": executable.to_string_lossy(),
                "args": ["--broker-mcp"],
                "env": env,
            }
        }
    });
    let path = directory.join(format!("{role}-{scope}.json"));
    crate::integrator_mcp::write_private_json(&path, &mut config).map_err(IntegratorError::from)?;
    Ok(path)
}

fn prune_stale_mcp_configs_in(data_directory: &Path) -> std::io::Result<usize> {
    let Some(directory) =
        crate::integrator_mcp::private_descendant(data_directory, Path::new("broker-mcp"), false)?
    else {
        return Ok(0);
    };
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
    instructions: Option<&str>,
) -> Result<Value> {
    let executable = std::env::current_exe().map_err(IntegratorError::from)?;
    let mut env: Vec<Value> = broker_env(info, role, scope, mode)
        .into_iter()
        .map(|(key, value)| json!({ "name": key, "value": value }))
        .collect();
    if let Some(instructions) = instructions {
        env.push(json!({
            "name": "INTEGRATOR_BROKER_INSTRUCTIONS",
            "value": instructions,
        }));
    }
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
        let broker = BrokerInfo::new(port);
        {
            let state = app.state::<AppState>();
            *state.broker.lock().expect("broker lock") = Some(broker.clone());
        }
        let connection_slots = Arc::new(Semaphore::new(MAX_BROKER_CONNECTIONS));
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let Ok(connection_slot) = Arc::clone(&connection_slots).try_acquire_owned() else {
                continue;
            };
            let app = app.clone();
            let grants = Arc::clone(&broker.grants);
            tauri::async_runtime::spawn(async move {
                let _connection_slot = connection_slot;
                let _ = serve_connection(app, grants, stream).await;
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
    grants: Arc<std::sync::Mutex<HashMap<String, BrokerGrant>>>,
    stream: TcpStream,
) -> std::io::Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader).take(MAX_LINE_BYTES as u64);
    let mut session: Option<BrokerSession> = None;
    let auth_deadline = tokio::time::Instant::now() + BROKER_AUTH_TIMEOUT;
    let mut line = Zeroizing::new(String::new());
    loop {
        line.clear();
        reader.set_limit(MAX_LINE_BYTES as u64);
        let read = if session.is_none() {
            match tokio::time::timeout_at(auth_deadline, reader.read_line(&mut line)).await {
                Ok(read) => read?,
                Err(_) => return Ok(()),
            }
        } else {
            reader.read_line(&mut line).await?
        };
        if read == 0 {
            return Ok(());
        }
        if read == MAX_LINE_BYTES && !line.ends_with('\n') {
            return Ok(());
        }
        let Ok(mut request) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = request
            .get_mut("id")
            .map(Value::take)
            .unwrap_or(Value::Null);
        let method = request
            .get_mut("method")
            .map(Value::take)
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default();
        let mut params = request
            .get_mut("params")
            .map(Value::take)
            .unwrap_or(Value::Null);
        let mut close_after_response = false;

        let response = if method == "hello" && session.is_none() {
            let token = params
                .as_object_mut()
                .and_then(|values| values.remove("token"))
                .and_then(|value| match value {
                    Value::String(value) => Some(Zeroizing::new(value)),
                    _ => None,
                });
            let grant = token.as_deref().and_then(|token| {
                grants
                    .lock()
                    .expect("broker grants lock")
                    .get(token)
                    .cloned()
            });
            let role = broker_claim_param(&params, "role", 32).unwrap_or_default();
            let scope = broker_claim_param(&params, "scope", 128).unwrap_or_default();
            let mode = broker_claim_param(&params, "mode", 64).unwrap_or_else(|| "balanced".into());
            if grant.as_ref().is_some_and(|grant| {
                grant.role == role && grant.scope == scope && grant.mode == mode
            }) {
                let grant = grant.expect("grant checked above");
                session = Some(BrokerSession {
                    role: grant.role,
                    scope: grant.scope,
                    mode: grant.mode,
                });
                json!({ "id": id, "result": { "ok": true } })
            } else {
                close_after_response = true;
                json!({ "id": id, "error": { "message": "invalid broker token" } })
            }
        } else if method == "hello" {
            json!({ "id": id, "error": { "message": "broker session is already authenticated" } })
        } else if let Some(session) = session.as_ref() {
            match dispatch_tool(&app, session, &method, &params).await {
                Ok(result) => json!({ "id": id, "result": result }),
                Err(error) => {
                    let message = redact_and_bound(&error.to_string(), 2_048).0;
                    json!({ "id": id, "error": { "message": message } })
                }
            }
        } else {
            json!({ "id": id, "error": { "message": "broker session is not authenticated" } })
        };
        let mut payload = response.to_string();
        payload.push('\n');
        writer.write_all(payload.as_bytes()).await?;
        if close_after_response {
            return Ok(());
        }
    }
}

fn broker_claim_param(params: &Value, key: &str, max_bytes: usize) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
        })
        .map(str::to_owned)
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
        ("chat", "memory_save") => {
            let task_id = session
                .scope
                .parse::<TaskId>()
                .map_err(|_| IntegratorError::Unauthorized("invalid Chat task scope".into()))?;
            let state = app.state::<AppState>();
            let task = state.store.get_task(task_id)?;
            if task.kind != TaskKind::Chat {
                return Err(IntegratorError::Unauthorized(
                    "memory_save is available only to Chat tasks".into(),
                ));
            }
            let enabled = state
                .store
                .get_setting("settings.memory.enabled")?
                .is_some_and(|setting| setting.value.as_bool() == Some(true));
            if !enabled {
                return Err(IntegratorError::Unavailable(
                    "Memory is disabled in Settings".into(),
                ));
            }
            let text = text_param(params, "text")
                .ok_or_else(|| IntegratorError::InvalidInput("text is required".into()))?;
            let memory = state.store.create_memory(NewMemoryEntry {
                text,
                creator: MemoryCreator::Agent,
                source_task_id: Some(task_id),
                source_item_id: None,
            })?;
            Ok(json!({ "memory": memory }))
        }
        ("orchestrator" | "child", "skill_data_request") => {
            validate_skill_data_scope(app, session, params)?;
            let state = app.state::<AppState>();
            crate::skill_api::execute(app, &state, params).await
        }
        ("orchestrator" | "chat", "schedule_wakeup") => {
            let task_id = orchestrator_scope(session)?;
            schedule_wakeup(app, task_id, params)
        }
        ("orchestrator" | "chat", "schedule_recurring") => {
            let task_id = orchestrator_scope(session)?;
            schedule_recurring(app, task_id, params)
        }
        ("orchestrator" | "chat", "automation_list") => {
            let task_id = orchestrator_scope(session)?;
            let state = app.state::<AppState>();
            Ok(json!({ "automations": state.store.list_automations(Some(task_id))? }))
        }
        ("orchestrator" | "chat", "automation_leave_note") => {
            let task_id = orchestrator_scope(session)?;
            let id = text_param(params, "automationId")
                .ok_or_else(|| IntegratorError::InvalidInput("automationId is required".into()))?;
            let id = AutomationId::from_str(&id)
                .map_err(|_| IntegratorError::InvalidInput("invalid automationId".into()))?;
            let note = text_param(params, "note")
                .ok_or_else(|| IntegratorError::InvalidInput("note is required".into()))?;
            let state = app.state::<AppState>();
            let automation = state.store.get_automation(id)?;
            if automation.task_id != task_id {
                return Err(IntegratorError::Unauthorized(
                    "automation belongs to another task".into(),
                ));
            }
            let automation = state.store.leave_automation_iteration_note(id, &note)?;
            crate::automations::emit_changed(app, &automation);
            Ok(json!({
                "automationId": automation.id,
                "saved": true,
                "note": "This replaces the note supplied to the next run."
            }))
        }
        ("orchestrator" | "chat", "automation_cancel") => {
            let task_id = orchestrator_scope(session)?;
            let id = text_param(params, "automationId")
                .ok_or_else(|| IntegratorError::InvalidInput("automationId is required".into()))?;
            let id = AutomationId::from_str(&id)
                .map_err(|_| IntegratorError::InvalidInput("invalid automationId".into()))?;
            let state = app.state::<AppState>();
            let automation = state.store.get_automation(id)?;
            if automation.task_id != task_id {
                return Err(IntegratorError::Unauthorized(
                    "automation belongs to another task".into(),
                ));
            }
            let automation = state.store.cancel_automation(id)?;
            state.automation_notify.notify_one();
            Ok(json!({ "automation": automation }))
        }
        (_, method) if method.starts_with("browser_") => {
            // A delegated child browses too, inside its parent's task and owning
            // whatever it opens. Its scope is its delegation id, so the parent
            // task comes from the delegation record rather than from the child.
            let (task_id, delegation_id) = match session.role.as_str() {
                "child" => {
                    let delegation_id = child_scope(session)?;
                    let state = app.state::<AppState>();
                    let delegation = state.store.get_delegation(delegation_id)?;
                    (
                        delegation.parent_task_id.to_string(),
                        Some(delegation_id.to_string()),
                    )
                }
                _ => (
                    session
                        .scope
                        .parse::<TaskId>()
                        .map_err(|_| {
                            IntegratorError::Unauthorized(
                                "invalid task scope for browser tools".into(),
                            )
                        })?
                        .to_string(),
                    None,
                ),
            };
            // The group is the task's, so a child inherits its parent's shared
            // tabs along with its task.
            let tabs = app.state::<std::sync::Arc<crate::browser::BrowserTabs>>();
            let group_id = crate::browser::groups::group_for_task(app, &tabs, &task_id).id;
            let caller = crate::browser::Caller {
                task_id,
                delegation_id,
                group_id,
            };
            browser_tool(app, caller, method, params).await
        }
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
        ("orchestrator", "delegation_thread") => {
            let task_id = orchestrator_scope(session)?;
            let delegation = scoped_delegation(app, task_id, params)?;
            delegation_thread(app, &delegation)
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
            state.store.complete_delegation(delegation_id, &summary)?;
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

fn schedule_wakeup(app: &AppHandle<tauri::Wry>, task_id: TaskId, params: &Value) -> Result<Value> {
    let title = required_text(params, "title")?;
    let prompt = required_text(params, "prompt")?;
    let after_seconds = params.get("afterSeconds").and_then(Value::as_u64);
    let wake_at = optional_time(params, "wakeAt")?;
    let delegation_trigger = params.get("whenDelegationsSettle");
    if usize::from(after_seconds.is_some())
        + usize::from(wake_at.is_some())
        + usize::from(delegation_trigger.is_some())
        != 1
    {
        return Err(IntegratorError::InvalidInput(
            "schedule_wakeup requires exactly one trigger".into(),
        ));
    }
    let trigger = if let Some(seconds) = after_seconds {
        if !(1..=2_592_000).contains(&seconds) {
            return Err(IntegratorError::InvalidInput(
                "afterSeconds must be between 1 second and 30 days".into(),
            ));
        }
        let seconds = i64::try_from(seconds)
            .map_err(|_| IntegratorError::InvalidInput("afterSeconds is too large".into()))?;
        AutomationTrigger::At {
            run_at: Utc::now() + chrono::Duration::seconds(seconds),
        }
    } else if let Some(run_at) = wake_at {
        AutomationTrigger::At { run_at }
    } else {
        let value = delegation_trigger.expect("trigger count checked");
        let ids = value
            .get("delegationIds")
            .and_then(Value::as_array)
            .ok_or_else(|| IntegratorError::InvalidInput("delegationIds must be an array".into()))?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| {
                        IntegratorError::InvalidInput("delegationIds must contain strings".into())
                    })?
                    .parse::<DelegationId>()
                    .map_err(|_| IntegratorError::InvalidInput("invalid delegationId".into()))
            })
            .collect::<Result<Vec<_>>>()?;
        AutomationTrigger::DelegationsSettled {
            delegation_ids: ids,
            require_all: value
                .get("requireAll")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            timeout_at: optional_time(value, "timeoutAt")?,
        }
    };
    let target = match text_param(params, "targetDelegationId") {
        Some(id) => AutomationTarget::Delegation {
            delegation_id: id
                .parse()
                .map_err(|_| IntegratorError::InvalidInput("invalid targetDelegationId".into()))?,
        },
        None => AutomationTarget::Task,
    };
    create_agent_automation(app, task_id, title, prompt, target, trigger, None, false)
}

fn schedule_recurring(
    app: &AppHandle<tauri::Wry>,
    task_id: TaskId,
    params: &Value,
) -> Result<Value> {
    let title = required_text(params, "title")?;
    let prompt = required_text(params, "prompt")?;
    let every_seconds = params
        .get("everySeconds")
        .and_then(Value::as_u64)
        .ok_or_else(|| IntegratorError::InvalidInput("everySeconds is required".into()))?;
    if !(60..=2_592_000).contains(&every_seconds) {
        return Err(IntegratorError::InvalidInput(
            "everySeconds must be between 60 seconds and 30 days".into(),
        ));
    }
    let user_request = required_text(params, "userRequest")?;
    let state = app.state::<AppState>();
    let latest = state.store.latest_user_message(task_id)?.ok_or_else(|| {
        IntegratorError::Unauthorized(
            "recurring automation requires a persisted user request".into(),
        )
    })?;
    if !latest.contains(&user_request) || !explicitly_recurring(&user_request) {
        return Err(IntegratorError::Unauthorized(
            "userRequest must be an exact excerpt of the latest message explicitly requesting recurrence"
                .into(),
        ));
    }
    let seconds = i64::try_from(every_seconds)
        .map_err(|_| IntegratorError::InvalidInput("everySeconds is too large".into()))?;
    let anchor_at = optional_time(params, "firstRunAt")?
        .unwrap_or_else(|| Utc::now() + chrono::Duration::seconds(seconds));
    let end_at = optional_time(params, "endAt")?;
    let iteration_notes = params
        .get("iterationNotes")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if end_at.is_some_and(|end| end < anchor_at) {
        return Err(IntegratorError::InvalidInput(
            "endAt must not be before firstRunAt".into(),
        ));
    }
    create_agent_automation(
        app,
        task_id,
        title,
        prompt,
        AutomationTarget::Task,
        AutomationTrigger::Interval {
            every_seconds,
            anchor_at,
            end_at,
        },
        Some(user_request),
        iteration_notes,
    )
}

fn create_agent_automation(
    app: &AppHandle<tauri::Wry>,
    task_id: TaskId,
    title: String,
    prompt: String,
    target: AutomationTarget,
    trigger: AutomationTrigger,
    recurrence_user_request: Option<String>,
    iteration_notes: bool,
) -> Result<Value> {
    let state = app.state::<AppState>();
    let task = state.store.get_task(task_id)?;
    let resume = state.store.provider_resume_state(task_id)?.ok_or_else(|| {
        IntegratorError::Unauthorized(
            "the task does not yet have a persisted execution policy to freeze".into(),
        )
    })?;
    let route = AutomationRoute {
        runtime: task
            .runtime
            .ok_or_else(|| IntegratorError::InvalidInput("task has no saved runtime".into()))?,
        model: task.model.unwrap_or_else(|| "Provider default".into()),
        effort: task.effort,
        fallbacks: Vec::new(),
        permission: resume.permission,
        delegation: resume.delegation,
        tools: None,
    };
    let automation = state.store.create_automation(NewAutomation {
        task_id,
        title,
        prompt,
        target,
        trigger,
        route,
        source: AutomationSource::Agent,
        recurrence_user_request,
        iteration_notes,
    })?;
    state.automation_notify.notify_one();
    crate::automations::emit_changed(app, &automation);
    Ok(json!({ "automation": automation }))
}

fn required_text(params: &Value, key: &str) -> Result<String> {
    text_param(params, key)
        .ok_or_else(|| IntegratorError::InvalidInput(format!("{key} is required")))
}

fn optional_time(params: &Value, key: &str) -> Result<Option<DateTime<Utc>>> {
    text_param(params, key)
        .map(|value| {
            DateTime::parse_from_rfc3339(&value)
                .map(|time| time.with_timezone(&Utc))
                .map_err(|_| IntegratorError::InvalidInput(format!("{key} must be ISO 8601")))
        })
        .transpose()
}

fn explicitly_recurring(request: &str) -> bool {
    let request = request.to_ascii_lowercase();
    [
        "every ",
        "each day",
        "each week",
        "each month",
        "daily",
        "weekly",
        "monthly",
        "hourly",
        "recurring",
        "repeatedly",
    ]
    .iter()
    .any(|marker| request.contains(marker))
}

fn validate_skill_data_scope(
    app: &AppHandle<tauri::Wry>,
    session: &BrokerSession,
    params: &Value,
) -> Result<()> {
    let state = app.state::<AppState>();
    match session.role.as_str() {
        "orchestrator" => {
            let task_id = orchestrator_scope(session)?;
            state.store.get_task(task_id)?;
        }
        "child" => {
            let delegation_id = child_scope(session)?;
            let delegation = state.store.get_delegation(delegation_id)?;
            let provider = text_param(params, "provider").unwrap_or_default();
            let required_skill = match provider.as_str() {
                "fred" => "gov-data:fred",
                "bls" => "gov-data:bls",
                "census" => "gov-data:census",
                "eia" => "gov-data:eia",
                "alpha-vantage" => "market-data:alpha-vantage",
                _ => {
                    return Err(IntegratorError::InvalidInput(
                        "unknown secure data provider".into(),
                    ));
                }
            };
            if !delegation
                .capability_snapshot
                .skill_ids
                .iter()
                .any(|id| id == required_skill)
            {
                return Err(IntegratorError::Unauthorized(format!(
                    "this specialist was not assigned the '{required_skill}' skill"
                )));
            }
        }
        _ => {
            return Err(IntegratorError::Unauthorized(
                "this broker role cannot request skill data".into(),
            ));
        }
    }
    Ok(())
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

/// How long `browser_wait_for` waits for its condition before answering, and
/// the ceiling a caller may raise it to. The page is asked afresh each time
/// rather than being asked to block, so a slow wait costs one small call every
/// quarter second and never holds the tab.
const WAIT_FOR_DEFAULT_MS: u64 = 5_000;
const WAIT_FOR_MAX_MS: u64 = 30_000;
const WAIT_FOR_POLL: Duration = Duration::from_millis(250);

/// Routes a `browser_*` tool to the task's own browser tabs. Tabs are scoped
/// to the task, so an agent can never reach another task's pages, and every
/// action goes through the same guest runtime the user's toolbar uses.
async fn browser_tool(
    app: &AppHandle<tauri::Wry>,
    caller: crate::browser::Caller,
    method: &str,
    params: &Value,
) -> Result<Value> {
    use crate::browser::{BrowserTabs, agent_invoke, row_for_agent, tabs_for_caller};

    let tabs = app.state::<std::sync::Arc<BrowserTabs>>();
    // Every verb that hands back a tab uses the `browser_list` row shape.
    let row = |tab: &crate::browser::BrowserTab| row_for_agent(app, &tabs, &caller, tab);
    let text = |key: &str| -> Option<String> {
        params
            .get(key)
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let tab_id = || -> Result<String> {
        text("tabId").ok_or_else(|| IntegratorError::InvalidInput("tabId is required".into()))
    };
    // Targets accept a ref from a snapshot, a selector, or text plus a role.
    let target = || {
        json!({
            "ref": params.get("ref"),
            "selector": params.get("selector"),
            "text": params.get("text"),
            "role": params.get("role"),
        })
    };
    // What `browser_type` aims at. `text` is the characters to insert there, so
    // it must never travel into the locator: copied in, it made every type a
    // hunt for a control *named* whatever was being typed, and — since the
    // object was then never empty — took away the "type into whatever has
    // focus" fallback as well.
    let typing_target = || {
        json!({
            "ref": params.get("ref"),
            "selector": params.get("selector"),
            "role": params.get("role"),
        })
    };
    let call = async |method: &str, args: Vec<Value>| -> Result<Value> {
        let id = tab_id()?;
        agent_invoke(app, &tabs, &caller, &id, method, args)
            .await
            .map_err(|error| IntegratorError::Unavailable(error.message))
    };

    match method {
        "browser_open" => {
            let url = text("url");
            let popped_out = params
                .get("poppedOut")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let tab = crate::browser::open_for_agent(app, &tabs, &caller, url, popped_out).await?;
            Ok(json!({ "tab": row(&tab) }))
        }
        "browser_list" => {
            let mut reply = json!({ "tabs": tabs_for_caller(app, &tabs, &caller) });
            if params.get("includeRecent").and_then(Value::as_bool) == Some(true) {
                reply["recent"] = json!(crate::browser::recent_for_caller(app, &tabs, &caller));
            }
            Ok(reply)
        }
        "browser_close" => {
            let id = tab_id()?;
            crate::browser::close_for_agent(app, &tabs, &caller, &id).await?;
            Ok(json!({ "closed": id, "tabs": tabs_for_caller(app, &tabs, &caller) }))
        }
        "browser_pop_out" | "browser_dock" => {
            let id = tab_id()?;
            let tab = crate::browser::set_popped_out_for_agent(
                app,
                &tabs,
                &caller,
                &id,
                method == "browser_pop_out",
            )
            .await?;
            Ok(json!({ "tab": row(&tab) }))
        }
        "browser_navigate" => {
            let id = tab_id()?;
            let url = text("url")
                .ok_or_else(|| IntegratorError::InvalidInput("url is required".into()))?;
            let tab = crate::browser::navigate_for_agent(app, &tabs, &caller, &id, &url).await?;
            Ok(json!({ "tab": row(&tab) }))
        }
        "browser_grant" => {
            let id = tab_id()?;
            let delegation = text("delegationId")
                .ok_or_else(|| IntegratorError::InvalidInput("delegationId is required".into()))?;
            let mode = match text("mode").as_deref() {
                Some("read") => crate::browser::GrantMode::Read,
                Some("drive") | None => crate::browser::GrantMode::Drive,
                Some(other) => {
                    return Err(IntegratorError::InvalidInput(format!(
                        "mode must be read or drive, not {other}"
                    )));
                }
            };
            // Share only with a child of this task. Without this, a caller
            // could name any delegation id and hand its page to a run it has
            // nothing to do with.
            let scoped = DelegationId::from_str(&delegation)
                .map_err(|_| IntegratorError::InvalidInput("invalid delegationId".into()))?;
            let record = app.state::<AppState>().store.get_delegation(scoped)?;
            if record.parent_task_id.to_string() != caller.task_id {
                return Err(IntegratorError::Unauthorized(
                    "that subagent belongs to another task".into(),
                ));
            }
            let tab = crate::browser::grant_for_agent(app, &tabs, &caller, &id, &delegation, mode)?;
            // Naming the share explicitly. `heldBy` still reads as the
            // orchestrator, because it is: whoever last drove the tab holds it,
            // and handing a child a key does not take yours away. Without these
            // two fields the reply was the tab exactly as it looked before, and
            // a grant that had worked read as a call that did nothing.
            Ok(json!({
                "tab": row(&tab),
                "grantedTo": delegation,
                "mode": mode,
                "note": "that subagent can now address this tab by id. You keep it too — \
                         sharing is not handing over.",
            }))
        }
        "browser_focus" => {
            let id = tab_id()?;
            crate::browser::focus_for_agent(app, &tabs, &caller, &id)
                .await
                .map_err(|error| IntegratorError::Unavailable(error.message))
        }
        "browser_cookies" => {
            let id = tab_id()?;
            crate::browser::cookies_for_agent(app, &tabs, &caller, &id)
                .await
                .map_err(|error| IntegratorError::Unavailable(error.message))
        }
        "browser_fill_login" => {
            let id = tab_id()?;
            crate::browser::fill_login_for_agent(
                app,
                &tabs,
                &caller,
                &id,
                text("username").as_deref(),
            )
            .await
            .map_err(|error| match error.code {
                "invalid-input" => IntegratorError::InvalidInput(error.message),
                "unauthorized" => IntegratorError::Unauthorized(error.message),
                _ => IntegratorError::Unavailable(error.message),
            })
        }
        "browser_snapshot" => {
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(200);
            call("snapshot", vec![json!({ "limit": limit })]).await
        }
        "browser_screenshot" => {
            let id = tab_id()?;
            crate::browser::screenshot_for_agent(app, &tabs, &caller, &id)
                .await
                .map_err(|error| match error.code {
                    "unauthorized" => IntegratorError::Unauthorized(error.message),
                    _ => IntegratorError::Unavailable(error.message),
                })
        }
        "browser_click" => call("click", vec![target(), json!({})]).await,
        "browser_hover" => call("hover", vec![target()]).await,
        "browser_type" => {
            let value = text("text")
                .ok_or_else(|| IntegratorError::InvalidInput("text is required".into()))?;
            let clear = params
                .get("clear")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            call(
                "type",
                vec![
                    typing_target(),
                    Value::String(value),
                    json!({ "clear": clear }),
                ],
            )
            .await
        }
        "browser_press" => {
            // A literal space trims away to nothing, and "key is required" then
            // reads as though the argument had been left out altogether. Say
            // what to write instead of what is missing.
            let given = params
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let key = text("key").ok_or_else(|| {
                IntegratorError::InvalidInput(if given.is_empty() {
                    "key is required".into()
                } else {
                    "write Space for the space bar — a bare space is not a key name".to_string()
                })
            })?;
            let modifiers = params
                .get("modifiers")
                .cloned()
                .unwrap_or_else(|| json!([]));
            call("press", vec![Value::String(key), modifiers]).await
        }
        "browser_drag" => {
            let point = |key: &str| params.get(key).cloned().unwrap_or(Value::Null);
            call("drag", vec![point("from"), point("to"), json!({})]).await
        }
        "browser_scroll" => {
            let delta_x = params.get("deltaX").and_then(Value::as_f64).unwrap_or(0.0);
            let delta_y = params.get("deltaY").and_then(Value::as_f64).unwrap_or(0.0);
            call("scroll", vec![target(), json!(delta_x), json!(delta_y)]).await
        }
        "browser_wait_for" => {
            // Waiting is what the name promises, and asking once was not it:
            // a control that appears after five seconds could only be caught
            // by a caller that knew to keep asking, and the guest cannot block
            // for it — a page's main thread is where every other call lands.
            // So the host does the waiting, and the page is asked afresh each
            // time. A caller wanting the old single check passes timeoutMs 0.
            let budget = params
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(WAIT_FOR_DEFAULT_MS)
                .min(WAIT_FOR_MAX_MS);
            let deadline = std::time::Instant::now() + Duration::from_millis(budget);
            let id = tab_id()?;
            loop {
                match agent_invoke(app, &tabs, &caller, &id, "waitFor", vec![params.clone()]).await
                {
                    Ok(seen) => {
                        if seen.get("matched").and_then(Value::as_bool) == Some(true) {
                            return Ok(seen);
                        }
                    }
                    // A page between documents has no runtime to ask yet, and
                    // one that navigates mid-poll answers for a document that is
                    // gone. Both are exactly what waiting is for: a load in
                    // progress used to end the wait on its first poll with
                    // "Cannot read properties of undefined".
                    Err(error)
                        if matches!(error.code, "guest-not-ready" | "page-navigated")
                            && std::time::Instant::now() < deadline => {}
                    Err(error) => return Err(IntegratorError::Unavailable(error.message)),
                }
                if std::time::Instant::now() >= deadline {
                    return Ok(json!({
                        "matched": false,
                        "waitedMs": budget,
                        "note": "the condition never held. Raise timeoutMs if the page is slow, \
                                 or take a snapshot to see what is actually there.",
                    }));
                }
                tokio::time::sleep(WAIT_FOR_POLL).await;
            }
        }
        other => Err(IntegratorError::InvalidInput(format!(
            "unknown browser tool '{other}'"
        ))),
    }
}

fn peers_list(app: &AppHandle<tauri::Wry>, task_id: TaskId, mode: &str) -> Result<Value> {
    let state = app.state::<AppState>();
    let profiles: Vec<DelegationProfile> = delegation_profiles(&state.store)
        .into_iter()
        .filter(|profile| profile.enabled)
        .collect();
    let active = state.store.active_delegation_count(task_id)?;
    let limit = max_concurrent(&state.store);
    Ok(json!({
        "peers": profiles.iter().map(|profile| json!({
            "profileId": profile.id,
            "label": profile.label,
            "bestFor": profile.best_for,
            "accessCeiling": profile.access.unwrap_or(DelegationPermission::ReadOnly).as_str(),
            "skills": profile.skill_ids.len(),
            "mcpServers": profile.mcp_server_ids.len(),
            "serviceLevels": profile.service_levels.iter().filter(|service| service.enabled).map(|service| json!({
                "level": service.level,
                "primary": service.primary,
                "fallbackCount": if service.fallbacks_enabled { service.fallbacks.len() } else { 0 },
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "mode": mode,
        "activeDelegations": active,
        "maxConcurrent": limit,
    }))
}

struct DelegationLaunchProfile {
    id: String,
    label: String,
    best_for: String,
    working_guidance: String,
    access_ceiling: DelegationPermission,
    service_level: String,
    routes: Vec<DelegationRoute>,
    skill_ids: Vec<String>,
    mcp_server_ids: Vec<String>,
}

fn one_off_launch_profile(
    current_runtime: Option<&str>,
    current_model: Option<&str>,
    current_effort: Option<&str>,
    installed: &[ProviderKind],
    name: &str,
    instructions: &str,
    requested_title: &str,
    requested_service_level: Option<&str>,
    permission: DelegationPermission,
) -> Result<DelegationLaunchProfile> {
    if requested_service_level.is_some() {
        return Err(IntegratorError::InvalidInput(
            "serviceLevel applies only to a saved specialist profile".into(),
        ));
    }
    if permission != DelegationPermission::ReadOnly {
        return Err(IntegratorError::Unauthorized(
            "one-off specialists are read-only; use an enabled saved profile for project-write access"
                .into(),
        ));
    }
    if name.chars().count() > 120 {
        return Err(IntegratorError::InvalidInput(
            "one-off specialist name must contain 1 to 120 characters".into(),
        ));
    }
    let runtime = current_runtime.ok_or_else(|| {
        IntegratorError::Unavailable(
            "the current chat has no runtime route for a one-off specialist".into(),
        )
    })?;
    let provider = ProviderKind::from_str(runtime)?;
    if !matches!(
        provider,
        ProviderKind::Codex
            | ProviderKind::Claude
            | ProviderKind::Antigravity
            | ProviderKind::Cursor
            | ProviderKind::Grok
            | ProviderKind::Kimi
    ) {
        return Err(IntegratorError::Unavailable(format!(
            "{} cannot run one-off specialists",
            provider.as_str()
        )));
    }
    if !installed.contains(&provider) {
        return Err(IntegratorError::Unavailable(format!(
            "{} is not installed for the one-off specialist",
            provider.as_str()
        )));
    }
    Ok(DelegationLaunchProfile {
        id: format!("one-off-{}", uuid::Uuid::new_v4()),
        label: name.to_owned(),
        best_for: format!("One-off specialist for {requested_title}."),
        working_guidance: redact_and_bound(instructions, 64 * 1024).0,
        access_ceiling: DelegationPermission::ReadOnly,
        service_level: "standard".into(),
        routes: vec![DelegationRoute {
            runtime: provider.as_str().into(),
            model: current_model.map(str::to_owned),
            effort: current_effort.map(str::to_owned),
        }],
        skill_ids: Vec::new(),
        mcp_server_ids: Vec::new(),
    })
}

async fn delegate_start(
    app: &AppHandle<tauri::Wry>,
    parent_task_id: TaskId,
    mode: &str,
    params: &Value,
) -> Result<Value> {
    let requested_title = text_param(params, "title")
        .ok_or_else(|| IntegratorError::InvalidInput("title is required".into()))?;
    let brief = text_param(params, "brief")
        .ok_or_else(|| IntegratorError::InvalidInput("brief is required".into()))?;
    let profile_id = text_param(params, "profileId");
    let one_off_name = text_param(params, "name");
    let one_off_instructions = text_param(params, "instructions");
    let requested_service_level = text_param(params, "serviceLevel");
    let permission = text_param(params, "permission")
        .map(|value| DelegationPermission::from_str(&value))
        .transpose()?
        .unwrap_or(DelegationPermission::ReadOnly);

    let state = app.state::<AppState>();
    let launch = match (profile_id, one_off_name, one_off_instructions) {
        (Some(profile_id), None, None) => {
            let profile = enabled_profile(&state.store, &profile_id)?;
            let access_ceiling = profile.access.unwrap_or(DelegationPermission::ReadOnly);
            if permission == DelegationPermission::ProjectWrite && access_ceiling.is_read_only() {
                return Err(IntegratorError::Unauthorized(format!(
                    "specialist '{}' is limited to read-only access",
                    profile.label
                )));
            }
            let service = select_service_level(&profile, requested_service_level.as_deref(), mode)?;
            let mut routes = vec![service.primary.clone()];
            if service.fallbacks_enabled {
                routes.extend(service.fallbacks.clone());
            }
            let service_level = service.level.clone();
            DelegationLaunchProfile {
                id: profile.id,
                label: profile.label,
                best_for: profile.best_for,
                working_guidance: profile.working_guidance,
                access_ceiling,
                service_level,
                routes,
                skill_ids: profile.skill_ids,
                mcp_server_ids: profile.mcp_server_ids,
            }
        }
        (None, Some(name), Some(instructions)) => {
            let parent = state.store.get_task(parent_task_id)?;
            let installed = state
                .provider_statuses(false)
                .await?
                .into_iter()
                .filter(|status| status.installed)
                .map(|status| status.provider)
                .collect::<Vec<_>>();
            one_off_launch_profile(
                parent.runtime.as_deref(),
                parent.model.as_deref(),
                parent.effort.as_deref(),
                &installed,
                &name,
                &instructions,
                &requested_title,
                requested_service_level.as_deref(),
                permission,
            )?
        }
        (Some(_), _, _) => {
            return Err(IntegratorError::InvalidInput(
                "use either profileId or name plus instructions, never both".into(),
            ));
        }
        (None, _, _) => {
            return Err(IntegratorError::InvalidInput(
                "delegate_start requires either profileId or both name and instructions".into(),
            ));
        }
    };
    let primary = launch
        .routes
        .first()
        .cloned()
        .ok_or_else(|| IntegratorError::Unavailable("specialist has no launch route".into()))?;
    let snapshot = DelegationCapabilitySnapshot {
        version: 1,
        profile_id: launch.id.clone(),
        profile_label: launch.label.clone(),
        best_for: launch.best_for,
        working_guidance: launch.working_guidance,
        access_ceiling: launch.access_ceiling,
        service_level: launch.service_level.clone(),
        routes: launch.routes,
        skill_ids: launch.skill_ids,
        mcp_server_ids: launch.mcp_server_ids,
        created_at: Utc::now(),
    };
    let active = state.store.active_delegation_count(parent_task_id)?;
    let limit = max_concurrent(&state.store);
    if active >= limit {
        return Err(IntegratorError::Unavailable(format!(
            "delegation limit reached ({active}/{limit} active); wait for a subagent to finish or stop one"
        )));
    }
    if permission == DelegationPermission::ProjectWrite
        && state
            .store
            .active_writing_delegation_count(parent_task_id)?
            >= 1
    {
        return Err(IntegratorError::Unavailable(
            "another project-writing subagent is already active; wait for it to finish or stop it before launching a second writer"
                .into(),
        ));
    }
    let manual = mode == "manual";
    let delegation = state.store.create_delegation(NewDelegation {
        parent_task_id,
        profile_id: launch.id,
        profile_label: launch.label,
        runtime: primary.runtime,
        model: primary.model,
        effort: primary.effort,
        service_level: launch.service_level,
        capability_snapshot: snapshot,
        permission,
        title: requested_title.clone(),
        brief,
        status: if manual {
            DelegationStatus::PendingApproval
        } else {
            DelegationStatus::Starting
        },
    })?;
    // Compute the sibling number after insertion. Even concurrent starts then
    // receive distinct ordinals from the store's deterministic creation order.
    let ordinal = delegation_ordinal(&state.store, &delegation)?;
    let title = format_subagent_title(ordinal, &requested_title);
    let delegation = state
        .store
        .compare_and_set_delegation_title(delegation.id, &requested_title, &title)?
        .unwrap_or(delegation);
    emit_update(app, parent_task_id);
    if manual {
        return Ok(json!({
            "delegationId": delegation.id.to_string(),
            "status": delegation.status.as_str(),
            "permission": delegation.permission.as_str(),
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
        "permission": delegation.permission.as_str(),
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
            "serviceLevel": delegation.service_level,
            "runtime": delegation.runtime,
            "permission": delegation.permission.as_str(),
            "status": delegation.status.as_str(),
            "result": delegation.result,
            "messagesFromSubagent": bodies,
            "updatedAt": delegation.updated_at.to_rfc3339(),
            "note": match delegation.status {
                DelegationStatus::Interrupted => Some(
                    "Subagent was interrupted (restart or process loss). Resume it from the Agents panel or send guidance to continue.",
                ),
                _ => None,
            },
        }));
    }
    if !rows.is_empty() {
        emit_update(app, parent_task_id);
    }
    Ok(json!({ "delegations": rows }))
}

fn delegation_thread(app: &AppHandle<tauri::Wry>, delegation: &Delegation) -> Result<Value> {
    let state = app.state::<AppState>();
    let transcript = delegation.child_task_id.and_then(|task_id| {
        state
            .store
            .task_handoff_digest(task_id, CHILD_DIGEST_OPTIONS)
            .ok()
            .flatten()
            .map(|digest| digest.text)
    });
    Ok(json!({
        "delegationId": delegation.id.to_string(),
        "title": delegation.title,
        "profile": delegation.profile_label,
        "serviceLevel": delegation.service_level,
        "runtime": delegation.runtime,
        "status": delegation.status.as_str(),
        "transcript": transcript,
    }))
}

fn delegation_result(app: &AppHandle<tauri::Wry>, delegation: &Delegation) -> Result<Value> {
    let state = app.state::<AppState>();
    let digest = delegation.child_task_id.and_then(|task_id| {
        state
            .store
            .task_handoff_digest(task_id, CHILD_DIGEST_OPTIONS)
            .ok()
            .flatten()
            .map(|digest| digest.text)
    });
    Ok(json!({
        "delegationId": delegation.id.to_string(),
        "serviceLevel": delegation.service_level,
        "permission": delegation.permission.as_str(),
        "status": delegation.status.as_str(),
        "result": delegation.result,
        "transcriptDigest": digest,
    }))
}

// ---------------------------------------------------------------------------
// Sentinel fallback (children without an MCP injection surface)
// ---------------------------------------------------------------------------

/// One child->orchestrator verb parsed from `<integrator:…>` blocks in a
/// child's reply. Semantically identical to the broker's child tools;
/// providers that cannot load the broker MCP server use this text transport
/// instead.
#[derive(Debug, PartialEq, Eq)]
enum SentinelAction {
    Complete(String),
    Ask(String),
    Report(String),
}

/// Extract `<integrator:complete|ask|report>…</integrator:…>` blocks in
/// document order. Unclosed or empty blocks are ignored; unknown kinds are
/// skipped without consuming the text after them.
fn parse_sentinel_actions(text: &str) -> Vec<SentinelAction> {
    const OPEN: &str = "<integrator:";
    let mut actions = Vec::new();
    let mut cursor = 0;
    while let Some(found) = text[cursor..].find(OPEN) {
        let start = cursor + found;
        let rest = &text[start + OPEN.len()..];
        let Some(kind) = ["complete", "ask", "report"]
            .into_iter()
            .find(|kind| rest.starts_with(&format!("{kind}>")))
        else {
            cursor = start + OPEN.len();
            continue;
        };
        let body_start = start + OPEN.len() + kind.len() + 1;
        let close = format!("</integrator:{kind}>");
        let Some(close_at) = text[body_start..].find(&close) else {
            cursor = start + OPEN.len();
            continue;
        };
        let body = text[body_start..body_start + close_at].trim().to_owned();
        cursor = body_start + close_at + close.len();
        if body.is_empty() {
            continue;
        }
        actions.push(match kind {
            "complete" => SentinelAction::Complete(body),
            "ask" => SentinelAction::Ask(body),
            _ => SentinelAction::Report(body),
        });
    }
    actions
}

/// Sentinel scan state for a freshly spawned child: enabled only when the
/// child has no broker tools, starting past any transcript that already
/// exists (a respawned child must not replay old blocks).
fn sentinel_watermark_for(
    store: &LocalStore,
    child_task_id: TaskId,
    has_tools: bool,
) -> Option<Arc<std::sync::Mutex<i64>>> {
    (!has_tools).then(|| {
        Arc::new(std::sync::Mutex::new(
            store.latest_item_seq(child_task_id).unwrap_or(0),
        ))
    })
}

/// Route any new sentinel blocks from a settled child turn into the same
/// store paths the broker's child tools use. The settle watcher races the
/// persistence pump on the same event channel, so poll briefly until the
/// turn's assistant messages have landed.
async fn process_child_sentinels(app: &AppHandle<tauri::Wry>, child: &Arc<DelegationChild>) {
    let Some(watermark) = child.sentinel_watermark.as_ref() else {
        return;
    };
    let state = app.state::<AppState>();
    let mut seen_rows = false;
    let mut acted = false;
    for attempt in 0..5 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let since = *watermark.lock().expect("sentinel watermark lock");
        let Ok(rows) = state
            .store
            .assistant_messages_since(child.child_task_id, since)
        else {
            break;
        };
        if rows.is_empty() {
            if seen_rows {
                break;
            }
            continue;
        }
        seen_rows = true;
        for (seq, body) in rows {
            for action in parse_sentinel_actions(&body) {
                acted = true;
                match action {
                    SentinelAction::Complete(summary) => {
                        if state
                            .store
                            .complete_delegation(child.delegation_id, &summary)
                            .is_ok()
                        {
                            *child.completed.lock().expect("completed lock") = true;
                        }
                    }
                    SentinelAction::Ask(message) | SentinelAction::Report(message) => {
                        let _ = state.store.add_delegation_message(
                            child.delegation_id,
                            DelegationSender::Child,
                            &message,
                        );
                    }
                }
            }
            *watermark.lock().expect("sentinel watermark lock") = seq;
        }
    }
    if acted {
        emit_update_for_delegation(app, child.delegation_id);
    }
}

// ---------------------------------------------------------------------------
// Child lifecycle
// ---------------------------------------------------------------------------

fn delegation_ordinal(store: &LocalStore, delegation: &Delegation) -> Result<usize> {
    Ok(store
        .list_delegations(delegation.parent_task_id)?
        .iter()
        .position(|candidate| candidate.id == delegation.id)
        .map_or(1, |index| index + 1))
}

/// Name a child chat through the same isolated, cheapest-model helper used by
/// ordinary new chats. The provider turn and sidebar remain responsive: a
/// deterministic ordinal title is already persisted before this runs.
fn schedule_subagent_title_generation(
    app: &AppHandle<tauri::Wry>,
    delegation: &Delegation,
    child_task_id: TaskId,
    expected_task_title: String,
    provider: ProviderKind,
    project: String,
    ordinal: usize,
) {
    let state = app.state::<AppState>();
    let store = Arc::clone(&state.store);
    let data_directory = state.data_directory.clone();
    let expected_delegation_title = delegation.title.clone();
    let source = delegation.brief.clone();
    let parent_task_id = delegation.parent_task_id;
    let delegation_id = delegation.id;
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        let claim_store = Arc::clone(&store);
        let claim_title = expected_task_title.clone();
        let claimed = tauri::async_runtime::spawn_blocking(move || {
            claim_store.claim_task_title_generation(child_task_id, &claim_title)
        })
        .await;
        if !matches!(claimed, Ok(Ok(true))) {
            return;
        }

        let Ok(Some(stem)) =
            generate_subagent_title(&data_directory, provider, &project, &source).await
        else {
            return;
        };
        let title = format_subagent_title(ordinal, &stem);
        let update_store = Arc::clone(&store);
        let updated = tauri::async_runtime::spawn_blocking(move || {
            update_store.compare_and_set_delegation_child_title(
                delegation_id,
                child_task_id,
                &expected_delegation_title,
                &expected_task_title,
                &title,
            )
        })
        .await;
        if matches!(updated, Ok(Ok(true))) {
            emit_update(&app, parent_task_id);
        }
    });
}

/// Launches the child runtime for an approved delegation. Fully async: the
/// child's first turn starts in the background and this returns once the
/// process is up and the delegation is `running`.
pub async fn spawn_child(app: AppHandle<tauri::Wry>, delegation_id: DelegationId) -> Result<()> {
    let state = app.state::<AppState>();
    let mut delegation = state.store.get_delegation(delegation_id)?;
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

    let statuses = state.provider_statuses(false).await?;
    let (route, provider, executable) = delegation
        .capability_snapshot
        .routes
        .iter()
        .find_map(|route| {
            let provider = ProviderKind::from_str(&route.runtime).ok()?;
            let executable = provider_executable(&statuses, provider)?;
            Some((route.clone(), provider, executable))
        })
        .ok_or_else(|| {
            IntegratorError::Unavailable(format!(
                "none of the {} {} routes are currently available",
                delegation.profile_label, delegation.service_level
            ))
        })?;
    if route.runtime != delegation.runtime
        || route.model != delegation.model
        || route.effort != delegation.effort
    {
        delegation = state.store.update_delegation_routing(
            delegation_id,
            &route.runtime,
            route.model.as_deref(),
            route.effort.as_deref(),
        )?;
    }
    let selected_skills = crate::integrator_skills::selected_installed_skills(
        &app,
        &delegation.capability_snapshot.skill_ids,
    )?;
    let selected_mcp_servers = crate::integrator_mcp::selected_enabled_servers(
        &app,
        &state.store,
        &delegation.capability_snapshot.mcp_server_ids,
    )?;
    let projection = crate::integrator_skills::write_projection(
        &state.data_directory,
        provider.as_str(),
        &selected_skills,
    )
    .map_err(IntegratorError::from)?;
    let capability_index = (provider != ProviderKind::Claude)
        .then(|| crate::integrator_skills::skill_index_block(&projection.entries))
        .flatten();
    let ordinal = delegation_ordinal(&state.store, &delegation)?;
    let initial_title = format_subagent_title(ordinal, &delegation.title);
    let child_task = state.store.create_task(integrator_core::NewTask {
        kind: integrator_core::TaskKind::Code,
        title: initial_title.clone(),
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

    // Seed the child with the parent's recent conversation so the brief has
    // context, mirroring the cross-provider primer used for task handoff.
    let parent_digest = state
        .store
        .task_handoff_digest(delegation.parent_task_id, CHILD_DIGEST_OPTIONS)
        .ok()
        .flatten();
    // Wire-only prefix: the digest rides to the provider but must never be
    // persisted as the child's visible user message, or later continuation
    // digests re-ingest it and the nesting compounds on every restart.
    let mut context_prefix = String::new();
    if let Some(digest) = parent_digest.as_ref() {
        context_prefix.push_str(&format!(
            "<orchestrator-context>\nRecent conversation from the delegating task, for background only:\n\n{}\n</orchestrator-context>\n\n",
            digest.text
        ));
    }
    let mut preamble = String::new();

    let broker = state.broker.lock().expect("broker lock").clone();
    let child = match provider {
        ProviderKind::Claude | ProviderKind::Antigravity => {
            let has_tools = broker.is_some();
            preamble.push_str(&child_preamble(&delegation, has_tools));
            let broker_config = match &broker {
                Some(info) => Some(write_mcp_config(
                    &app,
                    info,
                    "child",
                    &delegation_id.to_string(),
                    "off",
                )?),
                _ => None,
            };
            let mcp_config = if provider == ProviderKind::Claude {
                crate::integrator_mcp::write_claude_mcp_config(
                    &state.data_directory,
                    &selected_mcp_servers,
                    broker_config.as_deref(),
                )
                .map_err(IntegratorError::from)?
            } else {
                broker_config
            };
            spawn_structured_child(
                &app,
                &delegation,
                child_task.id,
                provider,
                executable,
                cwd,
                mcp_config,
                projection.plugin_dirs,
                selected_mcp_servers,
                capability_index,
            )
            .await?
        }
        ProviderKind::Codex => {
            // Codex accepts the broker through `thread/start`'s ephemeral
            // config layer, the same injection the orchestrator path uses.
            let mcp_config = match &broker {
                Some(info) => Some(crate::integrator_mcp::merge_codex_mcp_config(
                    codex_mcp_config(info, "child", &delegation_id.to_string(), "off")?,
                    &selected_mcp_servers,
                )),
                None => None,
            };
            preamble.push_str(&child_preamble(&delegation, mcp_config.is_some()));
            spawn_codex_child(
                &app,
                &delegation,
                child_task.id,
                executable,
                cwd,
                mcp_config,
                capability_index,
            )
            .await?
        }
        ProviderKind::Cursor | ProviderKind::Grok | ProviderKind::Kimi => {
            // ACP runtimes accept broker tools through `session/new`'s
            // `mcpServers` projection. Cursor also receives its harness
            // prompt because it exposes that policy surface explicitly.
            let mcp_server = match &broker {
                Some(info) => Some(acp_mcp_server_entry(
                    info,
                    "child",
                    &delegation_id.to_string(),
                    "off",
                    (provider == ProviderKind::Cursor)
                        .then(|| {
                            crate::harness_prompt::instructions_for(
                                &state.store,
                                provider,
                                crate::harness_prompt::LocalToolsProjection::Projected,
                            )
                        })
                        .as_deref(),
                )?),
                _ => None,
            };
            preamble.push_str(&child_preamble(&delegation, mcp_server.is_some()));
            spawn_acp_child(
                &app,
                &delegation,
                child_task.id,
                provider,
                executable,
                cwd,
                mcp_server,
                selected_mcp_servers,
                capability_index,
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
    let wire = format!("{context_prefix}{preamble}");
    start_child_turn(
        &app,
        &child,
        ChildPrompt {
            wire,
            visible: preamble,
            image_paths: parent_digest
                .map(|digest| digest.image_paths)
                .unwrap_or_default(),
        },
    )
    .await?;
    let project = parent
        .repository_path
        .as_deref()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .unwrap_or("software project")
        .to_owned();
    schedule_subagent_title_generation(
        &app,
        &delegation,
        child_task.id,
        initial_title,
        provider,
        project,
        ordinal,
    );
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
    let selected_skills = crate::integrator_skills::selected_installed_skills(
        app,
        &delegation.capability_snapshot.skill_ids,
    )?;
    let selected_mcp_servers = crate::integrator_mcp::selected_enabled_servers(
        app,
        &state.store,
        &delegation.capability_snapshot.mcp_server_ids,
    )?;
    let projection = crate::integrator_skills::write_projection(
        &state.data_directory,
        provider.as_str(),
        &selected_skills,
    )
    .map_err(IntegratorError::from)?;
    let capability_index = (provider != ProviderKind::Claude)
        .then(|| crate::integrator_skills::skill_index_block(&projection.entries))
        .flatten();
    let statuses = state.provider_statuses(false).await?;
    let executable = provider_executable(&statuses, provider).ok_or_else(|| {
        IntegratorError::Unavailable(format!("{} CLI is not installed", provider.as_str()))
    })?;
    let broker = state.broker.lock().expect("broker lock").clone();
    let child = match provider {
        ProviderKind::Claude | ProviderKind::Antigravity => {
            let broker_config = match &broker {
                Some(info) => Some(write_mcp_config(
                    app,
                    info,
                    "child",
                    &delegation.id.to_string(),
                    "off",
                )?),
                _ => None,
            };
            let mcp_config = if provider == ProviderKind::Claude {
                crate::integrator_mcp::write_claude_mcp_config(
                    &state.data_directory,
                    &selected_mcp_servers,
                    broker_config.as_deref(),
                )
                .map_err(IntegratorError::from)?
            } else {
                broker_config
            };
            spawn_structured_child(
                app,
                delegation,
                child_task_id,
                provider,
                executable,
                cwd,
                mcp_config,
                projection.plugin_dirs,
                selected_mcp_servers,
                capability_index,
            )
            .await?
        }
        ProviderKind::Codex => {
            let mcp_config = match &broker {
                Some(info) => Some(crate::integrator_mcp::merge_codex_mcp_config(
                    codex_mcp_config(info, "child", &delegation.id.to_string(), "off")?,
                    &selected_mcp_servers,
                )),
                None => None,
            };
            spawn_codex_child(
                app,
                delegation,
                child_task_id,
                executable,
                cwd,
                mcp_config,
                capability_index,
            )
            .await?
        }
        ProviderKind::Cursor | ProviderKind::Grok | ProviderKind::Kimi => {
            let mcp_server = match &broker {
                Some(info) => Some(acp_mcp_server_entry(
                    info,
                    "child",
                    &delegation.id.to_string(),
                    "off",
                    (provider == ProviderKind::Cursor)
                        .then(|| {
                            crate::harness_prompt::instructions_for(
                                &state.store,
                                provider,
                                crate::harness_prompt::LocalToolsProjection::Projected,
                            )
                        })
                        .as_deref(),
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
                selected_mcp_servers,
                capability_index,
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
    plugin_dirs: Vec<PathBuf>,
    selected_mcp_servers: Vec<crate::integrator_mcp::IntegratorMcpServer>,
    capability_index: Option<String>,
) -> Result<DelegationChild> {
    let state = app.state::<AppState>();
    let client = integrator_runtime::StructuredCliClient::new();
    let process_id = uuid::Uuid::new_v4().to_string();
    let permission_mode = if delegation.permission.is_read_only() {
        StructuredPermissionMode::ReadOnly
    } else {
        StructuredPermissionMode::AcceptEdits
    };
    let (control_overlay, hook_event_log) = if provider == ProviderKind::Antigravity {
        let overlay = crate::antigravity_hooks::create_overlay(
            &state.data_directory,
            &cwd,
            &process_id,
            permission_mode,
            crate::antigravity_hooks::AntigravityOverlayPolicy::Harness(if mcp_config.is_some() {
                crate::harness_prompt::LocalToolsProjection::Projected
            } else {
                crate::harness_prompt::LocalToolsProjection::Unavailable
            }),
            crate::harness_prompt::ExternalBrowserHandoff::from_store(&state.store),
            None,
        )?;
        crate::integrator_mcp::write_antigravity_mcp_config_with_base(
            &overlay.root,
            &selected_mcp_servers,
            mcp_config.as_deref(),
        )
        .map_err(IntegratorError::from)?;
        (Some(overlay.root), Some(overlay.event_log))
    } else {
        (None, None)
    };
    let thread_id = format!("structured.{}.{}", provider.as_str(), uuid::Uuid::new_v4());
    let binding = state
        .store
        .create_runtime_binding(child_task_id, &process_id, provider)?;
    let binding = state.store.attach_provider_thread(&binding, &thread_id)?;
    let session_ref = Arc::new(std::sync::Mutex::new(delegation.child_session_ref.clone()));
    let runtime = StructuredRuntime {
        client: client.clone(),
        process_id,
        alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        binding: Arc::new(std::sync::Mutex::new(Some(binding.clone()))),
        current_turn: Arc::new(std::sync::Mutex::new(None)),
        last_diagnostic: Arc::new(std::sync::Mutex::new(None)),
        permission_requests: Arc::new(std::sync::Mutex::new(HashMap::new())),
        session_ref: Arc::clone(&session_ref),
        control_overlay,
        hook_event_log,
        resume_context: None,
        sent_skill_index: Arc::new(std::sync::Mutex::new(None)),
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
        sentinel_watermark: sentinel_watermark_for(
            &state.store,
            child_task_id,
            mcp_config.is_some(),
        ),
        capability_index: Arc::new(std::sync::Mutex::new(capability_index)),
        driver: DelegationChildDriver::Structured {
            runtime,
            provider,
            executable,
            cwd,
            model: delegation.model.clone(),
            effort: delegation.effort.clone(),
            permission: delegation.permission,
            mcp_config,
            plugin_dirs,
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
    mcp_config: Option<Value>,
    capability_index: Option<String>,
) -> Result<DelegationChild> {
    let state = app.state::<AppState>();
    let client = adapter_codex::CodexClient::spawn(adapter_codex::CodexLaunchOptions {
        executable,
        environment: crate::native_process::runtime_launch_environment(),
        working_directory: Some(cwd.clone()),
        client_version: env!("CARGO_PKG_VERSION").into(),
    })
    .await?;
    let sandbox = if delegation.permission.is_read_only() {
        "read-only"
    } else {
        "workspace-write"
    };
    let has_tools = mcp_config.is_some();
    let effective_config = client.read_config(&cwd).await?;
    let developer_instructions = crate::harness_prompt::codex_developer_instructions_for(
        &state.store,
        &effective_config,
        if has_tools {
            crate::harness_prompt::LocalToolsProjection::Projected
        } else {
            crate::harness_prompt::LocalToolsProjection::Unavailable
        },
    );
    // Children run unattended: never block on approvals; their persisted
    // delegation permission selects the actual Codex sandbox boundary.
    let response = match delegation.child_session_ref.as_deref() {
        Some(thread_id) => match client
            .resume_thread_with_developer_instructions(thread_id, Some(&developer_instructions))
            .await
        {
            Ok(response) => response,
            Err(_) => {
                client
                    .start_thread_with_policies_and_overrides(
                        &cwd,
                        delegation.model.as_deref(),
                        delegation.effort.as_deref(),
                        "never",
                        sandbox,
                        adapter_codex::CodexThreadOverrides {
                            config: mcp_config.clone(),
                            developer_instructions: Some(developer_instructions.clone()),
                            service_tier: None,
                        },
                    )
                    .await?
            }
        },
        None => {
            client
                .start_thread_with_policies_and_overrides(
                    &cwd,
                    delegation.model.as_deref(),
                    delegation.effort.as_deref(),
                    "never",
                    sandbox,
                    adapter_codex::CodexThreadOverrides {
                        config: mcp_config,
                        developer_instructions: Some(developer_instructions),
                        service_tier: None,
                    },
                )
                .await?
        }
    };
    let thread_id = response
        .get("threadId")
        .and_then(Value::as_str)
        .or_else(|| {
            response
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
        })
        .or(delegation.child_session_ref.as_deref())
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
        reconciling: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        binding: Arc::new(std::sync::Mutex::new(Some(binding))),
        context_primer: Arc::new(std::sync::Mutex::new(None)),
        pending_user_prompt: Arc::new(std::sync::Mutex::new(None)),
        sent_delegation_preamble: Arc::new(std::sync::Mutex::new(None)),
        sent_skill_index: Arc::new(std::sync::Mutex::new(None)),
    };
    crate::commands::spawn_projection_pump(app.clone(), Arc::clone(&state.store), runtime.clone());
    let child = DelegationChild {
        delegation_id: delegation.id,
        child_task_id,
        parent_task_id: delegation.parent_task_id,
        busy: Arc::new(std::sync::Mutex::new(false)),
        completed: Arc::new(std::sync::Mutex::new(false)),
        sentinel_watermark: sentinel_watermark_for(&state.store, child_task_id, has_tools),
        capability_index: Arc::new(std::sync::Mutex::new(capability_index)),
        driver: DelegationChildDriver::Codex { runtime, thread_id },
    };
    watch_codex_child(app.clone(), &child, client);
    Ok(child)
}

/// Select the ACP mode matching the persisted child permission. ACP agents
/// use different names for the same boundary (Ask/Plan and Agent/Default), so
/// prefer the first advertised synonym and otherwise retain their default.
fn acp_agent_mode_target(response: &Value, permission: DelegationPermission) -> Option<String> {
    let modes = parse_acp_mode_state(response)?;
    let requested = if permission.is_read_only() {
        &["ask", "plan"][..]
    } else {
        &["agent", "default"][..]
    };
    let target = requested.iter().find_map(|requested| {
        modes.available_modes.iter().find(|mode| {
            mode.id.eq_ignore_ascii_case(requested) || mode.name.eq_ignore_ascii_case(requested)
        })
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
    let Ok(selection_response) = client
        .set_config_option(session_id, &config_id, &resolved)
        .await
    else {
        return;
    };
    let Some(effort) = effort else { return };
    if provider != ProviderKind::Cursor {
        let current = if selection_response.get("configOptions").is_some() {
            &selection_response
        } else {
            session_response
        };
        if let Some((config_id, values)) = acp_session_config(
            current,
            "thought_level",
            &["thinking", "effort", "reasoning"],
        ) && values.iter().any(|value| value == effort)
        {
            let _ = client
                .set_config_option(session_id, &config_id, effort)
                .await;
        }
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
    selected_mcp_servers: Vec<crate::integrator_mcp::IntegratorMcpServer>,
    capability_index: Option<String>,
) -> Result<DelegationChild> {
    let state = app.state::<AppState>();
    let tools = if mcp_server.is_some() {
        crate::harness_prompt::LocalToolsProjection::Projected
    } else {
        crate::harness_prompt::LocalToolsProjection::Unavailable
    };
    let profile = crate::commands::AcpLaunchProfile::Project {
        tools,
        browser: crate::harness_prompt::ExternalBrowserHandoff::from_store(&state.store),
    };
    let arguments = crate::commands::acp_launch_arguments_with_route(
        &provider,
        &profile,
        delegation.model.as_deref(),
        delegation.effort.as_deref(),
    )
    .map_err(|error| IntegratorError::InvalidInput(error.message))?;
    let client = adapter_acp::AcpClient::spawn(adapter_acp::AcpLaunchOptions {
        executable,
        arguments,
        environment: crate::commands::acp_launch_environment(&provider, &profile),
        working_directory: Some(cwd.clone()),
        client_version: env!("CARGO_PKG_VERSION").into(),
        skip_initialized_notification: provider == ProviderKind::Grok,
    })
    .await?;
    if let Err(error) = crate::commands::authenticate_acp_provider(&client, &provider).await {
        let _ = client.shutdown().await;
        return Err(IntegratorError::Unavailable(error.message));
    }
    let capabilities = client.session_capabilities().await;
    let mut mcp_servers: Vec<Value> = mcp_server.into_iter().collect();
    let projected =
        crate::integrator_mcp::acp_mcp_server_entries(&selected_mcp_servers, capabilities, &cwd)
            .map_err(|error| IntegratorError::Unavailable(error.message))?;
    mcp_servers.extend(projected);
    let has_tools = !mcp_servers.is_empty();
    let response = match delegation.child_session_ref.as_deref() {
        Some(session_id) if capabilities.resume => {
            match client
                .resume_session(session_id, &cwd, mcp_servers.clone())
                .await
            {
                Ok(response) => response,
                Err(_) if capabilities.load => {
                    match client
                        .load_session(session_id, &cwd, mcp_servers.clone())
                        .await
                    {
                        Ok(response) => response,
                        Err(_) => match client.new_session(&cwd, mcp_servers.clone()).await {
                            Ok(response) => response,
                            Err(error) => {
                                let _ = client.shutdown().await;
                                return Err(error);
                            }
                        },
                    }
                }
                Err(_) => match client.new_session(&cwd, mcp_servers.clone()).await {
                    Ok(response) => response,
                    Err(error) => {
                        let _ = client.shutdown().await;
                        return Err(error);
                    }
                },
            }
        }
        Some(session_id) if capabilities.load => {
            match client
                .load_session(session_id, &cwd, mcp_servers.clone())
                .await
            {
                Ok(response) => response,
                Err(_) => match client.new_session(&cwd, mcp_servers.clone()).await {
                    Ok(response) => response,
                    Err(error) => {
                        let _ = client.shutdown().await;
                        return Err(error);
                    }
                },
            }
        }
        _ => match client.new_session(&cwd, mcp_servers.clone()).await {
            Ok(response) => response,
            Err(error) => {
                let _ = client.shutdown().await;
                return Err(error);
            }
        },
    };
    let Some(session_id) = response
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| delegation.child_session_ref.clone())
    else {
        let _ = client.shutdown().await;
        return Err(IntegratorError::Unavailable(format!(
            "{} did not return a session identifier",
            provider.as_str()
        )));
    };
    if let Some(mode_id) = acp_agent_mode_target(&response, delegation.permission) {
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
    let (turn_settled, _) = tokio::sync::broadcast::channel(8);
    let runtime = AcpRuntime {
        client: client.clone(),
        provider,
        launch_model: delegation.model.clone(),
        launch_effort: delegation.effort.clone(),
        process_id,
        alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        binding: Arc::new(std::sync::Mutex::new(Some(binding))),
        current_turn: Arc::new(std::sync::Mutex::new(None)),
        current_turn_started_at: Arc::new(std::sync::Mutex::new(None)),
        turn_settled,
        permission_options: Arc::new(std::sync::Mutex::new(HashMap::new())),
        session_modes: Arc::new(std::sync::Mutex::new(parse_acp_mode_state(&response))),
        plan_requests: Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
        available_actions: Arc::new(std::sync::Mutex::new(Vec::new())),
        context_primer: Arc::new(std::sync::Mutex::new(None)),
        delegation_preamble: Arc::new(std::sync::Mutex::new(None)),
        sent_skill_index: Arc::new(std::sync::Mutex::new(None)),
        unattended: true,
        auto_approve_permissions: true,
        read_only: delegation.permission.is_read_only(),
        session_spec: Arc::new(std::sync::Mutex::new(Some(AcpSessionSpec {
            cwd,
            mcp_servers,
        }))),
        replaying_history: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    crate::commands::spawn_acp_pump(app.clone(), Arc::clone(&state.store), runtime.clone());
    let child = DelegationChild {
        delegation_id: delegation.id,
        child_task_id,
        parent_task_id: delegation.parent_task_id,
        busy: Arc::new(std::sync::Mutex::new(false)),
        completed: Arc::new(std::sync::Mutex::new(false)),
        sentinel_watermark: sentinel_watermark_for(&state.store, child_task_id, has_tools),
        capability_index: Arc::new(std::sync::Mutex::new(capability_index)),
        driver: DelegationChildDriver::Acp {
            runtime: runtime.clone(),
            session_id,
        },
    };
    watch_acp_child(app.clone(), &child, runtime);
    Ok(child)
}

/// Wire vs. visible child prompt. Providers receive `wire` (injected digests
/// and control blocks included); the persisted transcript records only
/// `visible`, so injected context never re-enters later digests or clutters
/// the subagent chat. Optional `image_paths` reattach parent/handoff images
/// on the first primed turn only.
struct ChildPrompt {
    wire: String,
    visible: String,
    image_paths: Vec<std::path::PathBuf>,
}

/// Starts (or resumes) one child turn, recording synthetic user/turn
/// projections (with the visible prompt only) for structured and ACP
/// providers; Codex substitutes via its pending-user-prompt annotation.
async fn start_child_turn(
    app: &AppHandle<tauri::Wry>,
    child: &Arc<DelegationChild>,
    mut prompt: ChildPrompt,
) -> Result<()> {
    *child.busy.lock().expect("busy lock") = true;
    // Spent on the first turn only: the child's provider session keeps its
    // history, so repeating the index on every turn would compound it.
    if let Some(index) = child.capability_index.lock().expect("index lock").take() {
        prompt.wire = format!("{index}{}", prompt.wire);
    }
    let result: Result<()> = async {
        match &child.driver {
            DelegationChildDriver::Structured {
                runtime,
                provider,
                executable,
                cwd,
                model,
                effort,
                permission,
                mcp_config,
                plugin_dirs,
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
                    system_instructions: matches!(provider, ProviderKind::Claude).then(|| {
                        crate::harness_prompt::instructions_for(
                            &app.state::<AppState>().store,
                            *provider,
                            if mcp_config.is_some() {
                                crate::harness_prompt::LocalToolsProjection::Projected
                            } else {
                                crate::harness_prompt::LocalToolsProjection::Unavailable
                            },
                        )
                    }),
                    resume_session_id: session_ref.lock().expect("session lock").clone(),
                    permission_mode: if permission.is_read_only() {
                        StructuredPermissionMode::ReadOnly
                    } else {
                        StructuredPermissionMode::AcceptEdits
                    },
                    mcp_config_path: mcp_config.clone(),
                    control_overlay: runtime.control_overlay.clone(),
                    plugin_dirs: plugin_dirs.clone(),
                };
                let hook_offset = runtime
                    .hook_event_log
                    .as_deref()
                    .map(crate::antigravity_hooks::event_log_offset)
                    .unwrap_or(0);
                let turn_id = runtime
                    .client
                    .start_turn_with_images(
                        options,
                        prompt.wire.clone(),
                        prompt.image_paths.clone(),
                    )
                    .await?;
                *runtime.current_turn.lock().expect("turn lock") = Some(turn_id.clone());
                if let Some(event_log) = runtime.hook_event_log.clone() {
                    crate::antigravity_hooks::watch_events(
                        event_log,
                        hook_offset,
                        runtime.client.clone(),
                        turn_id.clone(),
                        Arc::clone(&runtime.alive),
                    );
                }
                if let Some(binding) = runtime.binding.lock().expect("binding lock").clone() {
                    emit_child_turn_started(app, &binding, &turn_id, &prompt.visible);
                }
            }
            DelegationChildDriver::Codex { runtime, thread_id } => {
                // Codex echoes the submitted prompt back as the user item;
                // the pump's annotation swaps it for the visible form.
                *runtime
                    .pending_user_prompt
                    .lock()
                    .expect("user prompt lock") =
                    (prompt.wire != prompt.visible).then(|| crate::state::PendingUserPrompt {
                        wire_prompt: prompt.wire.clone(),
                        visible_prompt: prompt.visible.clone(),
                        native_skill: None,
                        provider_item_id: None,
                    });
                runtime
                    .client
                    .start_turn_with_skill_and_images(
                        thread_id,
                        &prompt.wire,
                        None,
                        &prompt.image_paths,
                    )
                    .await?;
            }
            DelegationChildDriver::Acp {
                runtime,
                session_id,
            } => {
                let turn_id = uuid::Uuid::new_v4().to_string();
                let started_at = Utc::now();
                *runtime
                    .current_turn_started_at
                    .lock()
                    .expect("turn start lock") = Some(started_at);
                *runtime.current_turn.lock().expect("turn lock") = Some(turn_id.clone());
                if let Some(binding) = runtime.binding.lock().expect("binding lock").clone() {
                    emit_child_turn_started(app, &binding, &turn_id, &prompt.visible);
                }
                // The shared ACP pump settles the turn from its ordered
                // PromptFinished boundary, then notifies watch_acp_child.
                // This future only keeps the provider request alive.
                let client = runtime.client.clone();
                let session_id = session_id.clone();
                let wire = prompt.wire.clone();
                let images = prompt.image_paths.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = client.prompt_with_images(&session_id, &wire, &images).await;
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
            phase: None,
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
        loop {
            let event = match receiver.recv().await {
                Ok(event) => event,
                // Lagged is recoverable: the receiver resumes from the oldest
                // retained event. Exiting here would silently stop observing
                // turn boundaries and wedge the delegation forever.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    eprintln!(
                        "delegation watcher lagged behind structured stream by {skipped} events"
                    );
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
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
        loop {
            let event = match receiver.recv().await {
                Ok(event) => event,
                // Recoverable: resume from the oldest retained event instead
                // of abandoning turn-boundary tracking for this delegation.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    eprintln!("delegation watcher lagged behind codex stream by {skipped} events");
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
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

/// Settles ACP delegation state only after the shared projection pump has
/// persisted every stream update preceding the provider's prompt response.
fn watch_acp_child(app: AppHandle<tauri::Wry>, child: &DelegationChild, runtime: AcpRuntime) {
    let delegation_id = child.delegation_id;
    let child_identity = Arc::clone(&child.busy);
    let mut receiver = runtime.turn_settled.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            let settlement = match receiver.recv().await {
                Ok(settlement) => settlement,
                // One settlement per turn makes lag unlikely, but a missed
                // window must not permanently stop settlement tracking.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    eprintln!(
                        "delegation watcher lagged behind ACP settlements by {skipped} events"
                    );
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            child_turn_settled(
                app.clone(),
                delegation_id,
                settlement.failed,
                &child_identity,
            )
            .await;
        }
    });
}

/// The delegation state machine tick that runs whenever a child turn ends:
/// deliver queued orchestrator/user messages as the next turn, otherwise go
/// idle (`waiting`), or settle terminal states.
///
/// Boxed rather than `async fn`: settlement can deliver queued guidance and
/// start the next child turn, whose ordered boundary returns here again. That
/// recursive lifecycle needs type erasure for the compiler to prove it `Send`.
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
    // Children without broker tools report back through `<integrator:…>`
    // blocks in their replies; route any new ones before reading the
    // completion flag so a sentinel-completed turn settles as completed.
    process_child_sentinels(&app, &child).await;
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
    deliver_queued_messages_with_context(app, child, false, false).await
}

async fn deliver_queued_messages_with_context(
    app: &AppHandle<tauri::Wry>,
    child: &Arc<DelegationChild>,
    include_continuation_context: bool,
    resume_interrupted: bool,
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
    // The visible transcript shows only the guidance itself; the
    // continuation digest and control tags ride wire-only so they never
    // re-enter later digests (which previously nested them recursively).
    let mut note = String::from("New guidance from your orchestrator:\n");
    for message in &messages {
        note.push_str(&format!("- {}\n", message.body));
    }
    let visible = if resume_interrupted
        && messages.len() == 1
        && messages[0].body.trim() == INTERRUPTED_RESUME_VISIBLE_PROMPT
    {
        INTERRUPTED_RESUME_VISIBLE_PROMPT.to_owned()
    } else {
        note.clone()
    };
    let mut wire = String::new();
    // resume_interrupted is only set for an explicit "Resume from here" on a
    // process-loss Interrupted child — never after Stop / orchestrator cancel.
    // Re-check the tip at delivery in case Stop won the race after queue.
    let tip_stopped = state
        .store
        .task_tip_stop_requested(child.child_task_id)
        .unwrap_or(false);
    if resume_interrupted && !tip_stopped {
        let interrupted_at = state
            .store
            .task_latest_interrupted_at(child.child_task_id)
            .ok()
            .flatten();
        wire.push_str(&interrupted_resume_wire_prompt(interrupted_at));
        wire.push_str("\n\n");
    }
    if include_continuation_context
        && let Some(digest) = state
            .store
            .task_handoff_digest(child.child_task_id, CHILD_DIGEST_OPTIONS)
            .ok()
            .flatten()
    {
        wire.push_str(&format!(
            "<continuation-context>\nYou are continuing the same delegated conversation through a fresh provider session. Recent locally persisted transcript:\n\n{}\n</continuation-context>\n\n",
            digest.text
        ));
    }
    if include_continuation_context {
        let delegation = state.store.get_delegation(child.delegation_id)?;
        if let Some(instructions) = specialist_instructions_block(&delegation) {
            wire.push_str("Your frozen specialist instructions still apply:\n");
            wire.push_str(&instructions);
            wire.push('\n');
        }
    }
    wire.push_str(&format!(
        "<orchestrator-message>\n{note}</orchestrator-message>\nContinue your assignment accordingly."
    ));
    let message_ids = messages
        .iter()
        .map(|message| message.id.clone())
        .collect::<Vec<_>>();
    let _ = state
        .store
        .update_delegation_status(child.delegation_id, DelegationStatus::Running);
    start_child_turn(
        app,
        child,
        ChildPrompt {
            wire,
            visible,
            image_paths: Vec::new(),
        },
    )
    .await?;
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
                | ProviderKind::Kimi
        ) {
            return Err(IntegratorError::InvalidInput(format!(
                "{} is not a supported delegation target",
                provider.as_str()
            )));
        }
        if !delegation.capability_snapshot.routes.iter().any(|allowed| {
            allowed.runtime == route.runtime
                && allowed.model.as_deref() == route.model.as_deref()
                && allowed.effort.as_deref() == route.effort.as_deref()
        }) {
            return Err(IntegratorError::Unauthorized(
                "this route is not part of the specialist's frozen service level".into(),
            ));
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

    let rebuild = route_changed
        || existing_child.is_none()
        || matches!(
            delegation.status,
            DelegationStatus::Failed | DelegationStatus::Interrupted
        );
    // Only an explicit Resume on a process-loss Interrupted child may inject
    // the interrupt wire prompt. Stopped (user/orchestrator) tips never do,
    // and ordinary follow-ups must not look like crash recovery either.
    let child_stop_requested = delegation
        .child_task_id
        .map(|child_task_id| {
            state
                .store
                .task_tip_stop_requested(child_task_id)
                .unwrap_or(false)
        })
        .unwrap_or(false);
    let resume_interrupted = delegation.status == DelegationStatus::Interrupted
        && message.trim() == INTERRUPTED_RESUME_VISIBLE_PROMPT
        && !child_stop_requested;
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
        match deliver_queued_messages_with_context(app, &child, rebuild, resume_interrupted).await {
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
    // Settle the child tip as a user/orchestrator Stop so reopening the pane
    // cannot treat the cancelled turn as crash recovery and auto-resume it.
    if let Some(child_task_id) = delegation.child_task_id {
        let store = Arc::clone(&state.store);
        let _ =
            tauri::async_runtime::spawn_blocking(move || store.settle_stopped_turn(child_task_id))
                .await;
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
    app.state::<AppState>().automation_notify.notify_one();
    let _ = app.emit(
        DELEGATION_UPDATE_EVENT,
        json!({ "parentTaskId": parent_task_id.to_string() }),
    );
}

/// Notify the UI after boot recovery rewrote process-owned delegations to
/// `interrupted` and queued orchestrator-visible notes.
pub fn emit_recovered_delegation_updates(app: &AppHandle<tauri::Wry>) {
    let state = app.state::<AppState>();
    let Ok(delegations) = state.store.list_interrupted_delegations() else {
        return;
    };
    let mut parents = Vec::new();
    for delegation in delegations {
        if !parents.contains(&delegation.parent_task_id) {
            parents.push(delegation.parent_task_id);
        }
    }
    for parent in parents {
        emit_update(app, parent);
    }
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

use crate::command_api::{CommandError, CommandResult};

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
    let active = state
        .store
        .active_delegation_count(delegation.parent_task_id)
        .map_err(CommandError::from)?;
    let limit = max_concurrent(&state.store);
    if active >= limit {
        return Err(CommandError::from(IntegratorError::Unavailable(format!(
            "delegation limit reached ({active}/{limit} active); finish or stop a subagent before approving another"
        ))));
    }
    if delegation.permission == DelegationPermission::ProjectWrite
        && state
            .store
            .active_writing_delegation_count(delegation.parent_task_id)
            .map_err(CommandError::from)?
            >= 1
    {
        return Err(CommandError::from(IntegratorError::Unavailable(
            "another project-writing subagent is already active; finish or stop it before approving a second writer"
                .into(),
        )));
    }
    state
        .store
        .update_delegation_status(delegation_id, DelegationStatus::Starting)
        .map_err(CommandError::from)?;
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
    let current = state
        .store
        .get_delegation(delegation_id)
        .map_err(CommandError::from)?;
    if current.status != DelegationStatus::PendingApproval {
        return Err(CommandError::from(IntegratorError::InvalidInput(format!(
            "delegation is {}; only pending delegations can be denied",
            current.status.as_str()
        ))));
    }
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
    fn recurring_authorization_requires_recurrence_language() {
        assert!(explicitly_recurring("check this every weekday"));
        assert!(explicitly_recurring("run a weekly review"));
        assert!(!explicitly_recurring("check this again tomorrow"));
    }

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
    fn stale_mcp_config_cleanup_refuses_a_non_directory_control_path() {
        let root = tempfile::tempdir().expect("temporary app data");
        let sentinel = root.path().join("broker-mcp");
        std::fs::write(&sentinel, b"do not replace").expect("control path sentinel");

        assert!(prune_stale_mcp_configs_in(root.path()).is_err());
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"do not replace");
    }

    #[test]
    fn broker_claims_are_bounded_before_authentication() {
        let params = json!({
            "role": "orchestrator",
            "scope": "task-1",
            "mode": "balanced",
            "bad": "x".repeat(129),
        });

        assert_eq!(
            broker_claim_param(&params, "role", 32).as_deref(),
            Some("orchestrator")
        );
        assert!(broker_claim_param(&params, "bad", 128).is_none());
        assert!(broker_claim_param(&json!({ "role": "chat\nadmin" }), "role", 32).is_none());
    }

    #[test]
    fn codex_mcp_config_is_thread_scoped_and_required() {
        let config = codex_mcp_config(
            &BrokerInfo::new(43123),
            "orchestrator",
            "task-1",
            "balanced",
        )
        .expect("Codex MCP config");

        let server = &config["mcp_servers"]["integrator"];
        assert_eq!(server["args"], json!(["--broker-mcp"]));
        assert_eq!(server["required"], json!(true));
        assert_eq!(server["default_tools_approval_mode"], json!("approve"));
        assert_eq!(
            server["enabled_tools"],
            json!([
                "skill_data_request",
                "schedule_wakeup",
                "schedule_recurring",
                "automation_list",
                "automation_leave_note",
                "automation_cancel",
                "peers_list",
                "delegate_start",
                "delegation_status",
                "delegation_message",
                "delegation_thread",
                "delegation_result",
                "delegation_stop",
                "browser_open",
                "browser_list",
                "browser_close",
                "browser_grant",
                "browser_focus",
                "browser_pop_out",
                "browser_dock",
                "browser_fill_login",
                "browser_cookies",
                "browser_navigate",
                "browser_snapshot",
                "browser_screenshot",
                "browser_click",
                "browser_hover",
                "browser_type",
                "browser_press",
                "browser_scroll",
                "browser_drag",
                "browser_wait_for",
            ])
        );
        assert_eq!(
            server["env"]["INTEGRATOR_BROKER_ADDR"],
            json!("127.0.0.1:43123")
        );
        assert_eq!(server["env"]["INTEGRATOR_BROKER_SCOPE"], json!("task-1"));
        assert_eq!(server["env"]["INTEGRATOR_BROKER_MODE"], json!("balanced"));
    }

    #[test]
    fn broker_grants_are_unique_and_bound_to_one_session_claim() {
        let broker = BrokerInfo::new(43126);
        let first = broker_env(&broker, "orchestrator", "task-1", "balanced");
        let second = broker_env(&broker, "child", "delegation-2", "off");
        let token = |env: &Vec<(&'static str, String)>| {
            env.iter()
                .find(|(name, _)| *name == "INTEGRATOR_BROKER_TOKEN")
                .map(|(_, value)| value.clone())
                .expect("broker token")
        };
        let first_token = token(&first);
        let second_token = token(&second);
        assert_ne!(first_token, second_token);

        let grants = broker.grants.lock().expect("broker grants lock");
        let first_grant = grants.get(&first_token).expect("orchestrator grant");
        assert_eq!(first_grant.role, "orchestrator");
        assert_eq!(first_grant.scope, "task-1");
        assert_eq!(first_grant.mode, "balanced");
        let second_grant = grants.get(&second_token).expect("child grant");
        assert_eq!(second_grant.role, "child");
        assert_eq!(second_grant.scope, "delegation-2");
        assert_eq!(second_grant.mode, "off");
    }

    #[test]
    fn codex_data_and_automation_tools_remain_available_when_delegation_is_off() {
        let config = codex_mcp_config(&BrokerInfo::new(43125), "orchestrator", "task-3", "off")
            .expect("Codex MCP config");

        assert_eq!(
            config["mcp_servers"]["integrator"]["enabled_tools"],
            json!([
                "skill_data_request",
                "schedule_wakeup",
                "schedule_recurring",
                "automation_list",
                "automation_leave_note",
                "automation_cancel",
                "browser_open",
                "browser_list",
                "browser_close",
                "browser_grant",
                "browser_focus",
                "browser_pop_out",
                "browser_dock",
                "browser_fill_login",
                "browser_cookies",
                "browser_navigate",
                "browser_snapshot",
                "browser_screenshot",
                "browser_click",
                "browser_hover",
                "browser_type",
                "browser_press",
                "browser_scroll",
                "browser_drag",
                "browser_wait_for",
            ])
        );
    }

    #[test]
    fn chat_mcp_config_exposes_scheduling_and_only_opted_in_memory() {
        let disabled = codex_mcp_config(&BrokerInfo::new(43127), "chat", "task-chat", "off")
            .expect("disabled Chat MCP config");
        assert_eq!(
            disabled["mcp_servers"]["integrator"]["enabled_tools"],
            json!([
                "schedule_wakeup",
                "schedule_recurring",
                "automation_list",
                "automation_leave_note",
                "automation_cancel",
                "browser_open",
                "browser_list",
                "browser_close",
                "browser_focus",
                "browser_pop_out",
                "browser_dock",
                "browser_fill_login",
                "browser_cookies",
                "browser_navigate",
                "browser_snapshot",
                "browser_screenshot",
                "browser_click",
                "browser_hover",
                "browser_type",
                "browser_press",
                "browser_scroll",
                "browser_drag",
                "browser_wait_for",
            ])
        );

        let enabled = codex_mcp_config(&BrokerInfo::new(43128), "chat", "task-chat", "memory-on")
            .expect("enabled Chat MCP config");
        assert_eq!(
            enabled["mcp_servers"]["integrator"]["enabled_tools"],
            json!([
                "memory_save",
                "schedule_wakeup",
                "schedule_recurring",
                "automation_list",
                "automation_leave_note",
                "automation_cancel",
                "browser_open",
                "browser_list",
                "browser_close",
                "browser_focus",
                "browser_pop_out",
                "browser_dock",
                "browser_fill_login",
                "browser_cookies",
                "browser_navigate",
                "browser_snapshot",
                "browser_screenshot",
                "browser_click",
                "browser_hover",
                "browser_type",
                "browser_press",
                "browser_scroll",
                "browser_drag",
                "browser_wait_for",
            ])
        );
    }

    #[test]
    fn cursor_mcp_entry_carries_scope_and_durable_harness_instructions() {
        let entry = acp_mcp_server_entry(
            &BrokerInfo::new(43124),
            "orchestrator",
            "task-2",
            "manual",
            Some("durable harness policy"),
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
        assert!(env.iter().any(|value| {
            value["name"] == "INTEGRATOR_BROKER_INSTRUCTIONS"
                && value["value"] == "durable harness policy"
        }));
    }

    #[test]
    fn profiles_fall_back_to_defaults_with_standard_service_levels() {
        let store = LocalStore::open_in_memory().expect("store");
        let profiles = delegation_profiles(&store);
        assert!(profiles.iter().all(|profile| {
            profile
                .service_levels
                .iter()
                .any(|service| service.level == "standard")
        }));
    }

    #[test]
    fn exact_legacy_default_labels_migrate_without_touching_custom_names() {
        let mut legacy = default_profiles().remove(0);
        legacy.label = "Codex (OpenAI)".into();
        assert_eq!(
            normalize_profile(legacy).expect("legacy profile").label,
            "Repository Engineer"
        );

        let mut custom = default_profiles().remove(0);
        custom.label = "My Codex specialist".into();
        assert_eq!(
            normalize_profile(custom).expect("custom profile").label,
            "My Codex specialist"
        );
    }

    #[test]
    fn configured_concurrency_never_exceeds_the_certified_cap() {
        let store = LocalStore::open_in_memory().expect("store");
        store
            .set_setting("settings.delegation.maxConcurrent", json!(99))
            .expect("set concurrency");
        assert_eq!(max_concurrent(&store), 4);
    }

    #[test]
    fn default_profiles_cover_every_supported_child_runtime() {
        let store = LocalStore::open_in_memory().expect("store");
        let profiles = delegation_profiles(&store);
        for runtime in ["codex", "claude", "antigravity", "cursor", "grok", "kimi"] {
            assert!(
                profiles.iter().any(|profile| {
                    profile
                        .service_levels
                        .iter()
                        .any(|service| service.primary.runtime == runtime)
                }),
                "missing built-in profile for {runtime}"
            );
        }
    }

    #[test]
    fn explicit_service_levels_never_silently_downgrade() {
        let mut profile = default_profiles().remove(0);
        profile.service_levels = vec![
            DelegationServiceLevel {
                level: "budget".into(),
                enabled: false,
                primary: DelegationRoute {
                    runtime: "grok".into(),
                    model: None,
                    effort: None,
                },
                fallbacks_enabled: false,
                fallbacks: Vec::new(),
            },
            default_service_level("codex", Some("standard-model"), None),
            DelegationServiceLevel {
                level: "premium".into(),
                enabled: true,
                primary: DelegationRoute {
                    runtime: "claude".into(),
                    model: Some("premium-model".into()),
                    effort: Some("high".into()),
                },
                fallbacks_enabled: false,
                fallbacks: Vec::new(),
            },
        ];

        assert_eq!(
            select_service_level(&profile, Some("premium"), "balanced")
                .expect("premium service")
                .primary
                .runtime,
            "claude"
        );
        assert!(select_service_level(&profile, Some("budget"), "balanced").is_err());
        assert!(select_service_level(&profile, Some("turbo"), "balanced").is_err());
        assert_eq!(
            select_service_level(&profile, None, "budget-first")
                .expect("cheapest enabled service")
                .level,
            "standard"
        );
    }

    #[test]
    fn stored_specialists_bound_and_normalize_routes_and_capabilities() {
        let store = LocalStore::open_in_memory().expect("store");
        store
            .set_setting(
                "settings.delegation.profiles",
                json!([{
                    "id": "bounded",
                    "label": "Bounded specialist",
                    "access": "read-only",
                    "serviceLevels": [{
                        "level": "standard",
                        "enabled": true,
                        "primary": { "runtime": " codex ", "model": " provider-default " },
                        "fallbacksEnabled": true,
                        "fallbacks": [
                            { "runtime": "codex", "model": "provider-default" },
                            { "runtime": " claude " },
                            { "runtime": "cursor" },
                            { "runtime": "grok" },
                            { "runtime": "antigravity" },
                            { "runtime": "codex", "model": "other" }
                        ]
                    }],
                    "skillIds": [" design-principles ", "design-principles", "documents:documents"],
                    "mcpServerIds": [" figma ", "figma"]
                }]),
            )
            .expect("set specialists");

        let profiles = delegation_profiles(&store);
        assert_eq!(profiles.len(), 1);
        let profile = &profiles[0];
        assert_eq!(
            profile.skill_ids,
            ["design-principles", "documents:documents"]
        );
        assert_eq!(profile.mcp_server_ids, ["figma"]);
        let service = &profile.service_levels[0];
        assert_eq!(service.primary.runtime, "codex");
        assert_eq!(service.primary.model.as_deref(), Some("provider-default"));
        assert_eq!(service.fallbacks.len(), MAX_SERVICE_FALLBACKS);
        assert_eq!(service.fallbacks[0].runtime, "claude");
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
        assert_eq!(
            acp_agent_mode_target(&planning, DelegationPermission::ProjectWrite),
            Some("agent".into())
        );
        assert_eq!(
            acp_agent_mode_target(&planning, DelegationPermission::ReadOnly),
            Some("ask".into())
        );

        let kimi = json!({
            "configOptions": [{
                "id": "mode",
                "category": "mode",
                "currentValue": "default",
                "options": [
                    { "value": "default", "name": "Default" },
                    { "value": "plan", "name": "Plan" },
                    { "value": "auto", "name": "Auto" },
                    { "value": "yolo", "name": "YOLO" }
                ]
            }]
        });
        assert_eq!(
            acp_agent_mode_target(&kimi, DelegationPermission::ReadOnly),
            Some("plan".into())
        );
        assert_eq!(
            acp_agent_mode_target(&kimi, DelegationPermission::ProjectWrite),
            None
        );

        let already_agent = json!({
            "modes": {
                "currentModeId": "agent",
                "availableModes": [{ "id": "agent", "name": "Agent" }]
            }
        });
        assert_eq!(
            acp_agent_mode_target(&already_agent, DelegationPermission::ProjectWrite),
            None
        );
        // Agents without session modes (Grok) skip the pin entirely.
        assert_eq!(
            acp_agent_mode_target(
                &json!({ "sessionId": "session-1" }),
                DelegationPermission::ReadOnly
            ),
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
        assert!(preamble.contains("peers_list"));
        assert!(preamble.contains("one-off specialist"));
        assert!(preamble.contains("durable special sauce"));
        assert!(preamble.contains("do not search this repository"));
    }

    #[test]
    fn one_off_specialists_freeze_method_without_minting_authority() {
        let launch = one_off_launch_profile(
            Some("codex"),
            Some("gpt-5.6-sol"),
            Some("high"),
            &[ProviderKind::Codex, ProviderKind::Claude],
            "Careful Math Specialist",
            "Be terse. State assumptions. Try counterexamples before claiming a proof.",
            "Analyze the recurrence",
            None,
            DelegationPermission::ReadOnly,
        )
        .expect("one-off launch profile");

        assert!(launch.id.starts_with("one-off-"));
        assert_eq!(launch.label, "Careful Math Specialist");
        assert!(launch.working_guidance.contains("Try counterexamples"));
        assert_eq!(launch.access_ceiling, DelegationPermission::ReadOnly);
        assert!(launch.skill_ids.is_empty());
        assert!(launch.mcp_server_ids.is_empty());
        assert_eq!(launch.routes[0].runtime, "codex");
        assert_eq!(launch.routes[0].model.as_deref(), Some("gpt-5.6-sol"));

        let write_attempt = one_off_launch_profile(
            Some("codex"),
            None,
            None,
            &[ProviderKind::Codex],
            "Writer",
            "Edit carefully.",
            "Change the repository",
            None,
            DelegationPermission::ProjectWrite,
        );
        assert!(matches!(
            write_attempt,
            Err(IntegratorError::Unauthorized(_))
        ));
    }

    #[test]
    fn child_preamble_uses_the_frozen_working_guidance() {
        let now = Utc::now();
        let delegation = Delegation {
            id: DelegationId::new(),
            parent_task_id: TaskId::new(),
            child_task_id: None,
            profile_id: "claude-ux".into(),
            profile_label: "Claude UX".into(),
            runtime: "claude".into(),
            model: Some("claude-fable-5".into()),
            effort: Some("high".into()),
            service_level: "premium".into(),
            capability_snapshot: DelegationCapabilitySnapshot {
                version: 1,
                profile_id: "claude-ux".into(),
                profile_label: "Claude UX".into(),
                best_for: "UX review".into(),
                working_guidance: "Test keyboard and reduced-motion behavior.".into(),
                access_ceiling: DelegationPermission::ReadOnly,
                service_level: "premium".into(),
                routes: vec![DelegationRoute {
                    runtime: "claude".into(),
                    model: Some("claude-fable-5".into()),
                    effort: Some("high".into()),
                }],
                skill_ids: Vec::new(),
                mcp_server_ids: Vec::new(),
                created_at: now,
            },
            permission: DelegationPermission::ReadOnly,
            title: "Interaction audit".into(),
            brief: "Review the flow".into(),
            status: DelegationStatus::Starting,
            result: None,
            child_session_ref: None,
            created_at: now,
            updated_at: now,
        };
        let prompt = child_preamble(&delegation, true);
        assert!(prompt.contains("Test keyboard and reduced-motion behavior."));
        assert!(prompt.contains("task_complete"));
        assert!(prompt.contains("Workspace permission: read-only"));
        assert!(prompt.contains("may inspect this transcript"));
        assert!(prompt.contains("<task-brief>\nReview the flow\n</task-brief>"));
        assert!(
            prompt.find("<specialist-instructions>").unwrap()
                < prompt.find("<task-brief>").unwrap()
        );

        let untooled = child_preamble(&delegation, false);
        assert!(!untooled.contains("task_complete"));
        assert!(untooled.contains("<integrator:complete>"));
        assert!(untooled.contains("<integrator:ask>"));
        assert!(untooled.contains("<integrator:report>"));
    }

    #[test]
    fn sentinel_parser_extracts_blocks_in_document_order() {
        let text = "Working on it.\n<integrator:report>halfway there</integrator:report>\nSome text.\n<integrator:ask>which branch?</integrator:ask>\n<integrator:complete>done: edited a.rs, b.rs</integrator:complete>";
        assert_eq!(
            parse_sentinel_actions(text),
            vec![
                SentinelAction::Report("halfway there".into()),
                SentinelAction::Ask("which branch?".into()),
                SentinelAction::Complete("done: edited a.rs, b.rs".into()),
            ]
        );
    }

    #[test]
    fn sentinel_parser_ignores_malformed_empty_and_unknown_blocks() {
        assert!(parse_sentinel_actions("no blocks here").is_empty());
        assert!(parse_sentinel_actions("<integrator:complete>never closed").is_empty());
        assert!(parse_sentinel_actions("<integrator:complete>  </integrator:complete>").is_empty());
        assert!(parse_sentinel_actions("<integrator:launch>x</integrator:launch>").is_empty());
        // An unknown kind must not swallow a valid block after it.
        assert_eq!(
            parse_sentinel_actions(
                "<integrator:launch>x</integrator:launch><integrator:report>ok</integrator:report>"
            ),
            vec![SentinelAction::Report("ok".into())]
        );
        // Multiline bodies survive with outer whitespace trimmed.
        assert_eq!(
            parse_sentinel_actions(
                "<integrator:complete>\nline one\nline two\n</integrator:complete>"
            ),
            vec![SentinelAction::Complete("line one\nline two".into())]
        );
    }
}
