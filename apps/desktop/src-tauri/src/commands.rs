use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

use adapter_codex::{
    CodexEvent, CodexLaunchOptions, CodexSkillSelection, CodexThreadOverrides, ServerRequestId,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::{DateTime, Utc};
use integrator_core::{
    ApprovalDecision, ApprovalKind, ApprovalProjection, ArchivedTaskPage, ComposerDraft,
    ConnectionState, IntegratorError, ItemKind, ItemProjection, ItemStatus, LocalExport,
    ModeOption, ModeProjection, NewQueuedMessage, NewTask, ProjectId, ProviderKind,
    ProviderResumeState, QueuedMessage, QueuedMessageId, QueuedMessageState, RuntimeBinding,
    RuntimeProjection, RuntimeSession, Setting, StopRequestResult, Task, TaskId, TaskSnapshot,
    TaskSnapshotQuery, TaskState, TransportRequestId, TrustedProject, TurnStatus, Versioned,
};
use integrator_runtime::{
    CommitResult, CreateWorktree, DiffResult, DiffScope, FileStatus, GitOverview, GitRemote,
    GitService, GithubCliService, GithubRepositoryCatalog, GithubVisibility, HistoryCommit,
    ProjectionMutation, ProviderEventInput, PullMode, PushConfirmation, PushPreview, PushResult,
    ReducedProviderEvent, RepositoryIdentity, StructuredCliEventKind, StructuredCliLaunchOptions,
    StructuredCliProvider, StructuredPermissionMode, StructuredUsage, WorktreeInfo, acp_mode_event,
    acp_turn_projection, parse_acp_mode_state, provider_executable, reduce_acp_permission_request,
    reduce_acp_plan_review_request, reduce_acp_update, reduce_connection_event,
    reduce_provider_event,
};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use session_store::LocalStore;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::time::{Duration, timeout};
use zeroize::Zeroizing;

use crate::credential_store::{self, CredentialStorage};
use crate::native_actions::{
    NativeActionHandle, NativeActionInvocation, NativeActionKind, NativeProviderAction,
    discover_file_actions, parse_acp_actions,
};
use crate::state::{
    AcpPermissionOption, AcpRuntime, AcpSessionSpec, AcpTurnSettlement, AppState, CodexRuntime,
    PendingStructuredPermission, PendingUserPrompt, StructuredResumeContext, StructuredRuntime,
    remove_task_runtime, replace_task_runtime,
};

pub(crate) type CommandResult<T> = std::result::Result<T, CommandError>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl From<IntegratorError> for CommandError {
    fn from(error: IntegratorError) -> Self {
        let code = match &error {
            IntegratorError::InvalidInput(_) => "invalid-input",
            IntegratorError::NotFound(_) => "not-found",
            IntegratorError::Unavailable(_) => "unavailable",
            IntegratorError::Unauthorized(_) => "unauthorized",
            IntegratorError::Protocol(_) => "provider-protocol",
            IntegratorError::Storage(_) => "storage",
            IntegratorError::Git(_) => "git",
            IntegratorError::Io(_) => "io",
            IntegratorError::Serialization(_) => "serialization",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    application_version: String,
    domain_schema_version: u32,
    data_directory: PathBuf,
    git_available: bool,
    local_only: bool,
}

#[tauri::command]
pub fn app_bootstrap(state: State<'_, AppState>) -> Versioned<Bootstrap> {
    Versioned::current(Bootstrap {
        application_version: env!("CARGO_PKG_VERSION").into(),
        domain_schema_version: integrator_core::DOMAIN_SCHEMA_VERSION,
        data_directory: state.data_directory.clone(),
        git_available: state.git.is_some(),
        local_only: true,
    })
}

/// Opens a user-visible HTTP(S) URL with the operating system's default
/// browser. The renderer can request only this narrowly validated action; it
/// never receives general process-launch authority.
#[tauri::command]
pub fn open_external_url(url: String) -> CommandResult<()> {
    let parsed = url::Url::parse(&url).map_err(|_| CommandError {
        code: "invalid-input",
        message: "only absolute HTTP(S) URLs can be opened externally".into(),
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(CommandError {
            code: "invalid-input",
            message: "only absolute HTTP(S) URLs can be opened externally".into(),
        });
    }

    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return Err(CommandError {
        code: "external-open-failed",
        message: "opening external URLs is not supported on this platform".into(),
    });

    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        command.arg(parsed.as_str());
        spawn_quiet(command, "could not open the default browser")
    }
}

/// Opens a second window mirroring `task_id`, or focuses it if already open.
/// Runtime/session state lives in process-wide `AppState`, and task events
/// broadcast to every window, so the new window sees the same live task
/// without any additional wiring.
#[tauri::command]
pub fn open_task_window(app: AppHandle, task_id: TaskId) -> CommandResult<()> {
    let label = format!("task-{task_id}");
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::App(format!("index.html?taskId={task_id}").into()),
    )
    .title("AI Integrator")
    .inner_size(1440.0, 900.0)
    .min_inner_size(720.0, 640.0)
    .resizable(true)
    .decorations(false)
    .center()
    .build()
    .map(|_| ())
    .map_err(|error| CommandError {
        code: "unavailable",
        message: format!("could not open a new window: {error}"),
    })
}

#[tauri::command]
pub async fn provider_discover(
    state: State<'_, AppState>,
    force: Option<bool>,
) -> CommandResult<Vec<integrator_core::ProviderStatus>> {
    state
        .provider_statuses(force.unwrap_or(false))
        .await
        .map_err(Into::into)
}

#[derive(Clone, Debug)]
struct ResolvedNativeAction {
    public: NativeProviderAction,
    provider_path: Option<PathBuf>,
}

const CODEX_GOAL_ACTION_ID: &str = "builtin:codex:goal:v1";

/// Returns the active provider's own skill/command inventory for one trusted
/// repository. Discovery uses the provider protocol where one exists and a
/// bounded native scan of documented provider-owned roots otherwise.
#[tauri::command]
pub async fn provider_action_list(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: ProviderKind,
    repository: PathBuf,
) -> CommandResult<Vec<NativeProviderAction>> {
    let repository = authorized_project_directory(&state, repository).await?;
    let mut resolved = match &provider {
        ProviderKind::Codex => codex_native_actions(&state, &repository).await?,
        ProviderKind::Cursor | ProviderKind::Grok => {
            if let Some(actions) = current_acp_actions(&state, &provider).await {
                actions
                    .into_iter()
                    .map(|public| ResolvedNativeAction {
                        public,
                        provider_path: None,
                    })
                    .collect()
            } else {
                probe_acp_actions(&state, &provider, &repository).await?
            }
        }
        ProviderKind::Claude | ProviderKind::Antigravity => {
            let scan_provider = provider;
            let scan_repository = repository.clone();
            tauri::async_runtime::spawn_blocking(move || {
                discover_file_actions(&scan_provider, &scan_repository)
                    .into_iter()
                    .map(|public| ResolvedNativeAction {
                        public,
                        provider_path: None,
                    })
                    .collect::<Vec<_>>()
            })
            .await
            .map_err(|_| worker_error())?
        }
        ProviderKind::CustomAcp => Vec::new(),
    };
    // Integrator-plane skills ride alongside every provider's own catalog:
    // Claude loads them natively via projected plugin bundles; Codex,
    // Antigravity, and ACP runtimes receive a prompt-injected index and
    // body-injected explicit invocations. A provider-native action with the
    // same name wins so native routing is never shadowed.
    {
        let store = Arc::clone(&state.store);
        let skills_app = app.clone();
        let integrator = tauri::async_runtime::spawn_blocking(move || {
            crate::integrator_skills::enabled_skills(&skills_app, &store)
        })
        .await
        .map_err(|_| worker_error())?;
        let known = resolved
            .iter()
            .map(|action| action.public.name.clone())
            .collect::<std::collections::HashSet<_>>();
        for entry in integrator {
            if known.contains(&entry.name) {
                continue;
            }
            resolved.push(ResolvedNativeAction {
                public: NativeProviderAction {
                    id: String::new(),
                    name: entry.name,
                    description: entry.description,
                    source: entry.source,
                    kind: NativeActionKind::Skill,
                    invocation: NativeActionInvocation::Direct,
                    input_hint: None,
                },
                provider_path: Some(entry.path),
            });
        }
    }
    Ok(register_native_actions(
        &state, provider, repository, resolved,
    ))
}

async fn codex_native_actions(
    state: &State<'_, AppState>,
    repository: &Path,
) -> CommandResult<Vec<ResolvedNativeAction>> {
    let task_client = state
        .codex
        .lock()
        .await
        .values()
        .find(|runtime| runtime.alive.load(Ordering::Acquire))
        .map(|runtime| runtime.client.clone());
    let existing = match task_client {
        Some(client) => Some(client),
        None => state
            .codex_catalog
            .lock()
            .await
            .as_ref()
            .filter(|runtime| runtime.alive.load(Ordering::Acquire))
            .map(|runtime| runtime.client.clone()),
    };
    let (client, ephemeral) = match existing {
        Some(client) => (client, false),
        None => {
            let statuses = state
                .provider_statuses(false)
                .await
                .map_err(CommandError::from)?;
            let executable =
                provider_executable(&statuses, ProviderKind::Codex).ok_or_else(|| {
                    CommandError {
                        code: "provider-unavailable",
                        message: "Codex CLI is not installed".into(),
                    }
                })?;
            let client = adapter_codex::CodexClient::spawn(CodexLaunchOptions {
                executable,
                working_directory: Some(repository.to_path_buf()),
                client_version: env!("CARGO_PKG_VERSION").into(),
            })
            .await
            .map_err(CommandError::from)?;
            (client, true)
        }
    };
    let response = client
        .list_skills(repository, false)
        .await
        .map_err(CommandError::from);
    if ephemeral {
        let _ = client.shutdown().await;
    }
    let mut actions = parse_codex_actions(&response?)?;
    actions.insert(0, codex_goal_action());
    Ok(actions)
}

fn codex_goal_action() -> ResolvedNativeAction {
    ResolvedNativeAction {
        public: NativeProviderAction {
            id: CODEX_GOAL_ACTION_ID.into(),
            name: "goal".into(),
            description: "Keep working until a completion condition is met".into(),
            source: "built-in".into(),
            kind: NativeActionKind::Command,
            invocation: NativeActionInvocation::Direct,
            input_hint: Some("completion condition".into()),
        },
        provider_path: None,
    }
}

fn parse_codex_actions(value: &Value) -> CommandResult<Vec<ResolvedNativeAction>> {
    let skills = value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|data| data.first())
        .and_then(|entry| entry.get("skills"))
        .and_then(Value::as_array)
        .ok_or_else(|| CommandError {
            code: "provider-protocol",
            message: "Codex returned an invalid skill inventory".into(),
        })?;
    let mut actions = Vec::new();
    for skill in skills.iter().take(512) {
        if skill.get("enabled").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let Some(name) = skill.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(path) = skill.get("path").and_then(Value::as_str).map(PathBuf::from) else {
            continue;
        };
        let description = skill
            .get("shortDescription")
            .or_else(|| skill.pointer("/interface/shortDescription"))
            .or_else(|| skill.get("description"))
            .and_then(Value::as_str)
            .unwrap_or("Codex skill");
        let source = skill
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("codex");
        let Some(mut public) = NativeProviderAction::acp(name, description, None) else {
            continue;
        };
        public.kind = NativeActionKind::Skill;
        public.source = source.chars().take(64).collect();
        actions.push(ResolvedNativeAction {
            public,
            provider_path: Some(path),
        });
    }
    Ok(actions)
}

async fn current_acp_actions(
    state: &State<'_, AppState>,
    provider: &ProviderKind,
) -> Option<Vec<NativeProviderAction>> {
    let task_runtime = state
        .acp
        .lock()
        .await
        .values()
        .find(|runtime| &runtime.provider == provider && runtime.alive.load(Ordering::Acquire))
        .cloned();
    let runtime = match task_runtime {
        Some(runtime) => runtime,
        None => state.acp_catalog.lock().await.get(provider).cloned()?,
    };
    for _ in 0..12 {
        let actions = runtime
            .available_actions
            .lock()
            .expect("action lock")
            .clone();
        if !actions.is_empty() {
            return Some(actions);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    None
}

async fn probe_acp_actions(
    state: &State<'_, AppState>,
    provider: &ProviderKind,
    repository: &Path,
) -> CommandResult<Vec<ResolvedNativeAction>> {
    let statuses = state
        .provider_statuses(false)
        .await
        .map_err(CommandError::from)?;
    let executable = provider_executable(&statuses, *provider).ok_or_else(|| CommandError {
        code: "provider-unavailable",
        message: format!("{} CLI is not installed", provider.as_str()),
    })?;
    let client = adapter_acp::AcpClient::spawn(adapter_acp::AcpLaunchOptions {
        executable,
        arguments: acp_launch_arguments(provider, None)?,
        working_directory: Some(repository.to_path_buf()),
        client_version: env!("CARGO_PKG_VERSION").into(),
    })
    .await
    .map_err(CommandError::from)?;
    if let Err(error) = authenticate_acp_provider(&client, provider).await {
        let _ = client.shutdown().await;
        return Err(error);
    }
    let mut receiver = client.subscribe();
    let session = client.new_session(repository, Vec::new()).await;
    if let Err(error) = session {
        let _ = client.shutdown().await;
        return Err(CommandError::from(error));
    }
    let mut actions = Vec::new();
    for _ in 0..8 {
        let event = timeout(Duration::from_millis(250), receiver.recv()).await;
        let Ok(Ok(adapter_acp::AcpEvent::Notification { method, params })) = event else {
            continue;
        };
        if method != "session/update" {
            continue;
        }
        if let Some(parsed) = params.get("update").and_then(parse_acp_actions) {
            actions = parsed;
            break;
        }
    }
    let _ = client.shutdown().await;
    Ok(actions
        .into_iter()
        .map(|public| ResolvedNativeAction {
            public,
            provider_path: None,
        })
        .collect())
}

pub(crate) async fn authenticate_acp_provider(
    client: &adapter_acp::AcpClient,
    provider: &ProviderKind,
) -> CommandResult<()> {
    if *provider != ProviderKind::Grok {
        return Ok(());
    }
    let initialization = client.initialization().await;
    let cached_token = acp_has_auth_method(&initialization, "cached_token");
    if !cached_token {
        return Err(CommandError {
            code: "provider-login-required",
            message: "Grok has no vendor-owned cached login; run `grok login` first".into(),
        });
    }
    client
        .authenticate("cached_token", true)
        .await
        .map(|_| ())
        .map_err(CommandError::from)
}

fn acp_has_auth_method(initialization: &Value, expected: &str) -> bool {
    initialization
        .get("authMethods")
        .or_else(|| initialization.get("auth_methods"))
        .and_then(Value::as_array)
        .is_some_and(|methods| {
            methods.iter().any(|method| {
                method.as_str() == Some(expected)
                    || method.get("id").and_then(Value::as_str) == Some(expected)
                    || method.get("methodId").and_then(Value::as_str) == Some(expected)
            })
        })
}

fn register_native_actions(
    state: &State<'_, AppState>,
    provider: ProviderKind,
    repository: PathBuf,
    resolved: Vec<ResolvedNativeAction>,
) -> Vec<NativeProviderAction> {
    let mut handles = state
        .native_action_handles
        .lock()
        .expect("action handle lock");
    reconcile_native_action_handles(&mut handles, provider, repository, resolved)
}

fn reconcile_native_action_handles(
    handles: &mut std::collections::HashMap<String, NativeActionHandle>,
    provider: ProviderKind,
    repository: PathBuf,
    resolved: Vec<ResolvedNativeAction>,
) -> Vec<NativeProviderAction> {
    let mut reusable = handles
        .iter()
        .filter(|(_, handle)| handle.provider == provider && handle.repository == repository)
        .map(|(id, handle)| (id.clone(), handle.clone()))
        .collect::<Vec<_>>();
    handles.retain(|_, handle| handle.provider != provider || handle.repository != repository);
    let mut public_actions = Vec::new();
    for mut resolved in resolved.into_iter().take(512) {
        if resolved.public.id == CODEX_GOAL_ACTION_ID {
            public_actions.push(resolved.public);
            continue;
        }
        let handle = NativeActionHandle {
            provider,
            repository: repository.clone(),
            name: resolved.public.name.clone(),
            source: resolved.public.source.clone(),
            kind: resolved.public.kind,
            invocation: resolved.public.invocation,
            provider_path: resolved.provider_path,
        };
        let id = reusable
            .iter()
            .position(|(_, existing)| existing == &handle)
            .map(|index| reusable.swap_remove(index).0)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        resolved.public.id.clone_from(&id);
        handles.insert(id, handle);
        public_actions.push(resolved.public);
    }
    public_actions
}

fn resolve_native_action_handle(
    state: &State<'_, AppState>,
    provider: &ProviderKind,
    repository: &Path,
    action_id: &str,
) -> CommandResult<NativeActionHandle> {
    if let Some(handle) = stateless_native_action_handle(provider, repository, action_id) {
        return Ok(handle);
    }
    let handle = state
        .native_action_handles
        .lock()
        .expect("action handle lock")
        .get(action_id)
        .cloned()
        .ok_or_else(|| CommandError {
            code: "stale-native-action",
            message: "This provider action changed; open the slash menu and choose it again".into(),
        })?;
    if &handle.provider != provider || handle.repository != repository {
        return Err(CommandError {
            code: "unauthorized",
            message: "provider action does not belong to this runtime and repository".into(),
        });
    }
    if handle.invocation != NativeActionInvocation::Direct {
        return Err(CommandError {
            code: "interactive-only",
            message: "This provider action requires the provider's interactive terminal".into(),
        });
    }
    Ok(handle)
}

fn stateless_native_action_handle(
    provider: &ProviderKind,
    repository: &Path,
    action_id: &str,
) -> Option<NativeActionHandle> {
    (provider == &ProviderKind::Codex && action_id == CODEX_GOAL_ACTION_ID).then(|| {
        NativeActionHandle {
            provider: ProviderKind::Codex,
            repository: repository.to_path_buf(),
            name: "goal".into(),
            source: "built-in".into(),
            kind: NativeActionKind::Command,
            invocation: NativeActionInvocation::Direct,
            provider_path: None,
        }
    })
}

fn native_slash_prompt<'a>(prompt: &'a str, name: &str) -> CommandResult<&'a str> {
    let prefix = format!("/{name}");
    let Some(rest) = prompt.strip_prefix(&prefix) else {
        return Err(CommandError {
            code: "invalid-input",
            message: "selected provider action no longer matches the draft".into(),
        });
    };
    if rest
        .chars()
        .next()
        .is_some_and(|character| !character.is_whitespace())
    {
        return Err(CommandError {
            code: "invalid-input",
            message: "selected provider action no longer matches the draft".into(),
        });
    }
    Ok(rest)
}

#[tauri::command]
pub async fn task_create(
    state: State<'_, AppState>,
    input: NewTask,
    draft: Option<ComposerDraft>,
) -> CommandResult<Task> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || match draft {
        Some(draft) => store.create_task_with_project_draft(input, draft),
        None => store.create_task(input),
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn composer_draft_save(
    state: State<'_, AppState>,
    draft: ComposerDraft,
) -> CommandResult<()> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.upsert_composer_draft(draft))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn queued_message_enqueue(
    state: State<'_, AppState>,
    input: NewQueuedMessage,
) -> CommandResult<QueuedMessage> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.enqueue_message(input))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn queued_message_list(
    state: State<'_, AppState>,
    task_id: TaskId,
) -> CommandResult<Vec<QueuedMessage>> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.list_queued_messages(task_id))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn queued_message_reorder(
    state: State<'_, AppState>,
    task_id: TaskId,
    ordered_ids: Vec<QueuedMessageId>,
) -> CommandResult<Vec<QueuedMessage>> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        store.reorder_queued_messages(task_id, &ordered_ids)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn queued_message_take(
    state: State<'_, AppState>,
    task_id: TaskId,
    message_id: QueuedMessageId,
) -> CommandResult<QueuedMessage> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.take_queued_message(task_id, message_id))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn queued_message_set_dispatching(
    state: State<'_, AppState>,
    task_id: TaskId,
    message_id: QueuedMessageId,
    dispatching: bool,
) -> CommandResult<QueuedMessage> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        store.set_queued_message_state(
            task_id,
            message_id,
            if dispatching {
                QueuedMessageState::Dispatching
            } else {
                QueuedMessageState::Queued
            },
        )
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn task_list(state: State<'_, AppState>) -> CommandResult<Vec<Task>> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.list_tasks())
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn task_list_archived(
    state: State<'_, AppState>,
    cursor: Option<String>,
    limit: Option<usize>,
) -> CommandResult<ArchivedTaskPage> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        store.list_archived_tasks(cursor.as_deref(), limit.unwrap_or(50))
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMessageSearchHit {
    task_id: TaskId,
    snippet: String,
}

#[tauri::command]
pub async fn task_search_messages(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
    include_archived: Option<bool>,
) -> CommandResult<Vec<TaskMessageSearchHit>> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        store
            .search_task_messages(
                &query,
                limit.unwrap_or(30),
                include_archived.unwrap_or(false),
            )
            .map(|matches| {
                matches
                    .into_iter()
                    .map(|(task_id, snippet)| TaskMessageSearchHit { task_id, snippet })
                    .collect()
            })
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn task_set_state(
    state: State<'_, AppState>,
    task_id: TaskId,
    task_state: TaskState,
) -> CommandResult<Task> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.update_task_state(task_id, task_state))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMetadataInput {
    title: Option<String>,
    pinned: Option<bool>,
    archived: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRoutingInput {
    runtime: String,
    model: String,
    effort: Option<String>,
}

#[tauri::command]
pub async fn task_update_metadata(
    state: State<'_, AppState>,
    task_id: TaskId,
    input: TaskMetadataInput,
) -> CommandResult<Task> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        store.update_task_metadata(task_id, input.title, input.pinned, input.archived)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

/// Copies a chat into a new one, keeping settled history up to and including
/// `through_event_id`, or every settled turn when that is absent. Any live turn
/// stays only in the source. The new chat carries no provider resume state, so
/// its first prompt starts a fresh provider session seeded from the copied
/// transcript rather than resuming the source's thread.
#[tauri::command]
pub async fn task_fork(
    state: State<'_, AppState>,
    task_id: TaskId,
    through_event_id: Option<String>,
    title: String,
) -> CommandResult<Task> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        store.fork_task(task_id, through_event_id.as_deref(), title)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

/// Truncate a chat from a user message onward so an edit can re-send from that
/// point. Drops the live runtime binding and resume state so the next turn
/// cannot silently resume the discarded provider transcript.
#[tauri::command]
pub async fn task_truncate_from(
    state: State<'_, AppState>,
    task_id: TaskId,
    from_event_id: String,
    save_context: bool,
) -> CommandResult<()> {
    {
        let mut runtimes = state.codex.lock().await;
        remove_task_runtime(&mut *runtimes, task_id);
    }
    {
        let mut runtimes = state.structured.lock().await;
        remove_task_runtime(&mut *runtimes, task_id);
    }
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        // Edit is allowed mid-stream; settle any tip that Stop has not closed
        // yet so the truncate is not refused as still running.
        let _ = store.settle_stopped_turn(task_id)?;
        store.truncate_task_from(task_id, &from_event_id, save_context)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn task_update_routing(
    state: State<'_, AppState>,
    task_id: TaskId,
    input: TaskRoutingInput,
) -> CommandResult<Task> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        store.update_task_routing(
            task_id,
            &input.runtime,
            &input.model,
            input.effort.as_deref(),
        )
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn task_remove(state: State<'_, AppState>, task_id: TaskId) -> CommandResult<Task> {
    {
        let mut runtimes = state.codex.lock().await;
        remove_task_runtime(&mut *runtimes, task_id);
    }
    {
        let mut runtimes = state.acp.lock().await;
        remove_task_runtime(&mut *runtimes, task_id);
    }
    {
        let mut runtimes = state.structured.lock().await;
        remove_task_runtime(&mut *runtimes, task_id);
    }
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.remove_task(task_id))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn setting_list(state: State<'_, AppState>) -> CommandResult<Vec<Setting>> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.list_settings())
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn setting_set(
    state: State<'_, AppState>,
    key: String,
    value: Value,
) -> CommandResult<Setting> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        let setting = store.set_setting(&key, value)?;
        if key == crate::integrator_mcp::ENABLED_SETTING_KEY {
            crate::integrator_mcp::mark_configuration_changed(&store)?;
        }
        Ok::<Setting, IntegratorError>(setting)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn session_list(state: State<'_, AppState>) -> CommandResult<Vec<RuntimeSession>> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.list_runtime_sessions())
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn local_export(state: State<'_, AppState>) -> CommandResult<LocalExport> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.export())
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn local_clear(state: State<'_, AppState>) -> CommandResult<()> {
    let store = Arc::clone(&state.store);
    let authorizations = Arc::clone(&state.git_authorizations);
    tauri::async_runtime::spawn_blocking(move || {
        let mut authorizations = authorizations.lock().expect("git authorization cache lock");
        store.clear_all_data()?;
        authorizations.clear();
        Ok::<(), IntegratorError>(())
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageTotals {
    total_bytes: u64,
    database_bytes: u64,
    wal_bytes: u64,
    shared_memory_bytes: u64,
    measured_at: DateTime<Utc>,
    kind: &'static str,
}

/// One provider-reported rate-limit window (Codex `RateLimitWindow`).
/// `resets_at` is a Unix timestamp in seconds.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionWindow {
    used_percent: f64,
    #[serde(default)]
    window_duration_mins: Option<u64>,
    #[serde(default)]
    resets_at: Option<i64>,
}

/// Provider-reported subscription quota. Never inferred: only providers that
/// publish rate-limit windows (Codex today) populate this.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionQuota {
    #[serde(default)]
    plan_type: Option<String>,
    #[serde(default)]
    primary: Option<SubscriptionWindow>,
    #[serde(default)]
    secondary: Option<SubscriptionWindow>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageSummary {
    provider: String,
    task_count: u64,
    turn_count: u64,
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    total_tokens: u64,
    model_context_window: Option<u64>,
    /// Vendor-computed API-equivalent cost in USD. Only providers that report
    /// one (Claude's `total_cost_usd`) populate it; it is an estimate, not a
    /// bill, and is absent rather than inferred elsewhere.
    estimated_cost_usd: Option<f64>,
    /// Provider-reported subscription windows; absent when the provider does
    /// not expose quota (it is never inferred).
    subscription: Option<SubscriptionQuota>,
    provenance: &'static str,
    detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    providers: Vec<ProviderUsageSummary>,
    measured_at: DateTime<Utc>,
}

fn file_size(path: PathBuf) -> u64 {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

#[tauri::command]
pub fn storage_totals(state: State<'_, AppState>) -> CommandResult<StorageTotals> {
    let database_bytes = file_size(state.data_directory.join("integrator.sqlite3"));
    let wal_bytes = file_size(state.data_directory.join("integrator.sqlite3-wal"));
    let shared_memory_bytes = file_size(state.data_directory.join("integrator.sqlite3-shm"));
    Ok(StorageTotals {
        total_bytes: database_bytes
            .saturating_add(wal_bytes)
            .saturating_add(shared_memory_bytes),
        database_bytes,
        wal_bytes,
        shared_memory_bytes,
        measured_at: Utc::now(),
        kind: "sqlite",
    })
}

#[tauri::command]
pub async fn usage_summary(state: State<'_, AppState>) -> CommandResult<UsageSummary> {
    let store = Arc::clone(&state.store);
    let (rows, settings) = tauri::async_runtime::spawn_blocking(move || {
        let rows = store.provider_usage_rows()?;
        let settings = store.list_settings()?;
        Ok::<_, integrator_core::IntegratorError>((rows, settings))
    })
    .await
    .map_err(|_| worker_error())??;
    let quota_for = |provider: &str| -> Option<SubscriptionQuota> {
        let key = format!("provider-quota.{provider}");
        settings
            .iter()
            .find(|setting| setting.key == key)
            .and_then(|setting| serde_json::from_value(setting.value.clone()).ok())
    };
    let providers = rows
        .into_iter()
        .map(|(provider, task_count, turn_count, usage)| {
            let subscription = quota_for(&provider);
            ProviderUsageSummary {
                provider,
                task_count,
                turn_count,
                input_tokens: usage.input_tokens,
                cached_input_tokens: usage.cached_input_tokens,
                output_tokens: usage.output_tokens,
                reasoning_output_tokens: usage.reasoning_output_tokens,
                total_tokens: usage.total_tokens,
                model_context_window: usage.model_context_window,
                estimated_cost_usd: usage
                    .vendor_cost_micro_usd
                    .map(|micro| micro as f64 / 1_000_000.0),
                subscription,
                provenance: if usage.total_tokens > 0 {
                    "vendor_exact"
                } else {
                    "unavailable"
                },
                detail: if usage.total_tokens > 0 {
                    "Provider-reported token usage from the persisted native projection.".into()
                } else {
                    "No provider token usage has been reported for this runtime.".into()
                },
            }
        })
        .collect();
    Ok(UsageSummary {
        providers,
        measured_at: Utc::now(),
    })
}

/// Persists provider-reported subscription windows from a rate-limit snapshot
/// (`account/rateLimits/read` response or `account/rateLimits/updated`
/// notification — both carry `rateLimits`). Rolling updates are sparse, so
/// absent windows keep the previously stored values instead of clearing them.
fn store_provider_quota(store: &LocalStore, provider: ProviderKind, params: &Value) {
    let Some(snapshot) = params.get("rateLimits") else {
        return;
    };
    let key = format!("provider-quota.{}", provider.as_str());
    let existing = store
        .get_setting(&key)
        .ok()
        .flatten()
        .map(|setting| setting.value)
        .unwrap_or(Value::Null);
    let window = |name: &str| -> Value {
        snapshot
            .get(name)
            .filter(|window| window.get("usedPercent").is_some())
            .cloned()
            .unwrap_or_else(|| existing.get(name).cloned().unwrap_or(Value::Null))
    };
    let plan_type = snapshot
        .get("planType")
        .and_then(Value::as_str)
        .or_else(|| existing.get("planType").and_then(Value::as_str))
        .map(str::to_owned);
    let value = serde_json::json!({
        "planType": plan_type,
        "primary": window("primary"),
        "secondary": window("secondary"),
        "updatedAt": Utc::now().to_rfc3339(),
    });
    let _ = store.set_setting(&key, value);
}

const VOICE_TYPING_SERVICE: &str = "ai-integrator";
const VOICE_TYPING_ACCOUNT: &str = "openai-stt";
const VOICE_TYPING_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
const VOICE_TYPING_MODEL: &str = "gpt-4o-mini-transcribe";
/// OpenAI rejects transcription uploads above 25 MB; the WAV header adds a
/// fixed 44 bytes on top of the PCM payload.
const VOICE_TYPING_MAX_PCM_BYTES: usize = 25 * 1024 * 1024 - 44;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTypingCredentialStatus {
    configured: bool,
    storage: &'static str,
    provider: &'static str,
}

#[derive(Debug, Deserialize)]
struct TranscriptionResponse {
    text: String,
}

fn voice_typing_error(message: impl Into<String>) -> CommandError {
    CommandError {
        code: "voice-typing",
        message: message.into(),
    }
}

fn voice_typing_storage_name() -> &'static str {
    match credential_store::storage() {
        CredentialStorage::ProtectedLocalFile => "protected-local-file",
        CredentialStorage::OsCredentialStore => "os-credential-store",
    }
}

#[tauri::command]
pub fn voice_typing_credential_status() -> CommandResult<VoiceTypingCredentialStatus> {
    let configured = credential_store::read(VOICE_TYPING_SERVICE, VOICE_TYPING_ACCOUNT)
        .map_err(|_| CommandError {
            code: "credential-store-unavailable",
            message: "Native credential storage could not be read.".into(),
        })?
        .is_some();
    Ok(VoiceTypingCredentialStatus {
        configured,
        storage: voice_typing_storage_name(),
        provider: "openai",
    })
}

#[tauri::command]
pub fn voice_typing_credential_set(api_key: String) -> CommandResult<VoiceTypingCredentialStatus> {
    let api_key = Zeroizing::new(api_key);
    let value = api_key.trim();
    if value.is_empty() {
        return Err(voice_typing_error("Paste an OpenAI API key before saving."));
    }
    credential_store::write(VOICE_TYPING_SERVICE, VOICE_TYPING_ACCOUNT, value).map_err(|_| {
        CommandError {
            code: "credential-store-unavailable",
            message: "The OpenAI API key could not be saved to native credential storage.".into(),
        }
    })?;
    Ok(VoiceTypingCredentialStatus {
        configured: true,
        storage: voice_typing_storage_name(),
        provider: "openai",
    })
}

#[tauri::command]
pub fn voice_typing_credential_clear() -> CommandResult<()> {
    credential_store::delete(VOICE_TYPING_SERVICE, VOICE_TYPING_ACCOUNT).map_err(|_| CommandError {
        code: "credential-store-unavailable",
        message: "The OpenAI API key could not be removed from native credential storage.".into(),
    })
}

/// Minimal RIFF/WAVE container for 16-bit little-endian mono PCM so the clip
/// can be uploaded as a self-describing file.
fn pcm16_to_wav(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let byte_rate = sample_rate * 2;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

#[tauri::command]
pub async fn voice_typing_transcribe(
    pcm_base64: String,
    sample_rate: u32,
) -> CommandResult<String> {
    let Some(api_key) = credential_store::read(VOICE_TYPING_SERVICE, VOICE_TYPING_ACCOUNT)
        .map_err(|_| {
            voice_typing_error("Add an OpenAI API key in Settings before using the mic button.")
        })?
    else {
        return Err(voice_typing_error(
            "Add an OpenAI API key in Settings before using the mic button.",
        ));
    };
    if !(8000..=48000).contains(&sample_rate) {
        return Err(voice_typing_error(
            "The recording sample rate is not supported.",
        ));
    }
    let pcm = BASE64
        .decode(pcm_base64.as_bytes())
        .map_err(|_| voice_typing_error("The recorded audio could not be decoded."))?;
    if pcm.len() < 4 {
        return Err(voice_typing_error("The recording contains no audio."));
    }
    if pcm.len() > VOICE_TYPING_MAX_PCM_BYTES {
        return Err(voice_typing_error(
            "The recording is too long to transcribe. Try a shorter clip.",
        ));
    }

    let wav = pcm16_to_wav(&pcm, sample_rate);
    let boundary = format!("integrator-voice-{}", uuid::Uuid::new_v4());
    let mut body = Vec::with_capacity(wav.len() + 512);
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{VOICE_TYPING_MODEL}\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"voice.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(&wav);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .https_only(true)
        .user_agent(concat!("AI-Integrator/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| voice_typing_error("The transcription client could not be created."))?;
    let response = client
        .post(VOICE_TYPING_URL)
        .bearer_auth(api_key.trim())
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                voice_typing_error("Transcription timed out. Check your connection and try again.")
            } else {
                voice_typing_error("Could not reach the OpenAI transcription service.")
            }
        })?;
    drop(api_key);

    let status = response.status();
    if !status.is_success() {
        // Response bodies can carry request details; map to fixed messages
        // instead of forwarding provider text to the renderer.
        return Err(match status.as_u16() {
            401 | 403 => {
                voice_typing_error("OpenAI rejected the API key. Update it in Settings → General.")
            }
            413 => voice_typing_error("The recording is too long to transcribe."),
            429 => voice_typing_error(
                "OpenAI rate-limited the transcription request. Try again shortly.",
            ),
            _ => voice_typing_error("OpenAI could not transcribe the recording."),
        });
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| voice_typing_error("The transcription response could not be read."))?;
    let transcription: TranscriptionResponse = serde_json::from_slice(&body)
        .map_err(|_| voice_typing_error("The transcription response could not be read."))?;
    Ok(transcription.text.trim().to_owned())
}

#[tauri::command]
pub async fn project_register(
    state: State<'_, AppState>,
    path: PathBuf,
) -> CommandResult<TrustedProject> {
    let git = state.git.clone();
    let store = Arc::clone(&state.store);
    let authorizations = Arc::clone(&state.git_authorizations);
    tauri::async_runtime::spawn_blocking(move || {
        let mut authorizations = authorizations.lock().expect("git authorization cache lock");
        let project_root = canonical_project_directory(&path)?;
        let identity = git
            .as_ref()
            .map(|git| git.repository_if_present(&project_root))
            .transpose()?
            .flatten();
        let display_name = project_root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Project")
            .chars()
            .take(120)
            .collect::<String>();
        let project = store.upsert_trusted_project(
            &display_name,
            &project_root,
            identity
                .as_ref()
                .map(|identity| (identity.root.as_path(), identity.common_directory.as_path())),
        )?;
        authorizations.clear();
        Ok::<TrustedProject, IntegratorError>(project)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

/// Windows forbids `<>:"/\|?*` in file names and trailing dots/spaces; the
/// same rules keep the folder portable everywhere else.
fn validate_project_name(name: &str) -> Result<(), IntegratorError> {
    let name = name.trim();
    if name.is_empty() || name.len() > 120 {
        return Err(IntegratorError::InvalidInput(
            "project name must be between 1 and 120 characters".into(),
        ));
    }
    if name == "." || name == ".." {
        return Err(IntegratorError::InvalidInput(
            "project name cannot be a relative path".into(),
        ));
    }
    if name.chars().any(|c| {
        matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control()
    }) || name.ends_with('.')
    {
        return Err(IntegratorError::InvalidInput(
            "project name contains characters that are not allowed in folder names".into(),
        ));
    }
    Ok(())
}

/// Create a brand-new project folder under `Documents\AI Integrator\Projects`,
/// initialize a Git repository inside it, and register it as a trusted
/// project. Name collisions are resolved by appending `-2`, `-3`, … so the
/// flow never needs a folder picker.
#[tauri::command]
pub async fn project_create(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> CommandResult<TrustedProject> {
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    let store = Arc::clone(&state.store);
    let authorizations = Arc::clone(&state.git_authorizations);
    let documents = app.path().document_dir().map_err(|_| {
        CommandError::from(IntegratorError::Unavailable(
            "could not locate the Documents folder".into(),
        ))
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut authorizations = authorizations.lock().expect("git authorization cache lock");
        let name = name.trim().to_string();
        validate_project_name(&name)?;
        let projects_root = documents.join("AI Integrator").join("Projects");
        fs::create_dir_all(&projects_root).map_err(IntegratorError::Io)?;
        let mut display_name = name.clone();
        let mut destination = projects_root.join(&display_name);
        let mut counter = 2;
        while destination.exists() {
            if counter > 500 {
                return Err(IntegratorError::InvalidInput(format!(
                    "too many projects already share the name \"{name}\""
                )));
            }
            display_name = format!("{name}-{counter}");
            destination = projects_root.join(&display_name);
            counter += 1;
        }
        fs::create_dir(&destination).map_err(IntegratorError::Io)?;
        let identity = git.init(&destination)?;
        let project = store.upsert_trusted_project(
            &display_name,
            &identity.root,
            Some((&identity.root, &identity.common_directory)),
        )?;
        authorizations.clear();
        Ok(project)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCloneInput {
    remote: String,
    parent: PathBuf,
    folder_name: String,
    github_repository: Option<String>,
}

#[tauri::command]
pub fn project_default_parent(app: AppHandle) -> CommandResult<PathBuf> {
    let documents = app.path().document_dir().map_err(|_| CommandError {
        code: "unavailable",
        message: "could not locate the Documents folder".into(),
    })?;
    let parent = documents.join("AI Integrator").join("Projects");
    fs::create_dir_all(&parent).map_err(|error| CommandError::from(IntegratorError::Io(error)))?;
    canonical_project_directory(&parent).map_err(Into::into)
}

/// Clones into one explicit destination and registers the resulting folder.
/// GitHub account discovery remains optional: pasted Git URLs use Git itself,
/// while a repository chosen from the authenticated GitHub catalog uses `gh`.
#[tauri::command]
pub async fn project_clone(
    state: State<'_, AppState>,
    input: ProjectCloneInput,
) -> CommandResult<TrustedProject> {
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    let store = Arc::clone(&state.store);
    let authorizations = Arc::clone(&state.git_authorizations);
    tauri::async_runtime::spawn_blocking(move || {
        validate_project_name(&input.folder_name)?;
        let parent = canonical_project_directory(&input.parent)?;
        let destination = parent.join(input.folder_name.trim());
        let identity = if let Some(repository) = input.github_repository.as_deref() {
            let github = GithubCliService::discover().ok_or_else(|| {
                IntegratorError::Unavailable("GitHub CLI is not installed".into())
            })?;
            github.clone_repository(repository, &destination)?;
            git.repository(&destination)?
        } else {
            git.clone_repository(&input.remote, &destination)?
        };
        let project = store.upsert_trusted_project(
            input.folder_name.trim(),
            &identity.root,
            Some((&identity.root, &identity.common_directory)),
        )?;
        authorizations
            .lock()
            .expect("git authorization cache lock")
            .clear();
        Ok::<TrustedProject, IntegratorError>(project)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn github_repository_list() -> CommandResult<GithubRepositoryCatalog> {
    tauri::async_runtime::spawn_blocking(|| match GithubCliService::discover() {
        Some(github) => github.catalog(),
        None => Ok(GithubRepositoryCatalog {
            installed: false,
            authenticated: false,
            account: None,
            hostname: None,
            repositories: Vec::new(),
            detail: Some("GitHub CLI is not installed.".into()),
        }),
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

/// Explicitly turns one trusted ordinary folder into a Git repository, or
/// adopts the repository the folder already belongs to.
#[tauri::command]
pub async fn project_git_init(
    state: State<'_, AppState>,
    path: PathBuf,
) -> CommandResult<TrustedProject> {
    let root = authorized_project_directory(&state, path).await?;
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    let store = Arc::clone(&state.store);
    let authorizations = Arc::clone(&state.git_authorizations);
    tauri::async_runtime::spawn_blocking(move || {
        // The UI can hold a stale "not a repository" snapshot (for example a
        // project row written before Git detection, or Git initialized outside
        // the app). Adopting the existing repository keeps the action
        // idempotent instead of failing on a folder that is already set up.
        let identity = match git.repository_if_present(&root)? {
            Some(existing) => existing,
            None => git.init(&root)?,
        };
        let display_name = root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Project");
        let project = store.upsert_trusted_project(
            display_name,
            &root,
            Some((&identity.root, &identity.common_directory)),
        )?;
        authorizations
            .lock()
            .expect("git authorization cache lock")
            .clear();
        Ok::<TrustedProject, IntegratorError>(project)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn project_list(state: State<'_, AppState>) -> CommandResult<Vec<TrustedProject>> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.list_trusted_projects())
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn project_remove(
    state: State<'_, AppState>,
    project_id: ProjectId,
    delete_files: Option<bool>,
) -> CommandResult<()> {
    let store = Arc::clone(&state.store);
    let authorizations = Arc::clone(&state.git_authorizations);
    let delete_files = delete_files.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let mut authorizations = authorizations.lock().expect("git authorization cache lock");
        let project = store.remove_trusted_project(project_id)?;
        authorizations.clear();
        if delete_files {
            let root = &project.repository_root;
            // Only the exact registered project folder may be removed, and only
            // when it is still a directory. Never follow this into a file path.
            if root.as_os_str().is_empty()
                || root
                    .components()
                    .all(|component| matches!(component, Component::RootDir | Component::Prefix(_)))
            {
                return Err(IntegratorError::InvalidInput(
                    "refusing to delete an empty or filesystem-root project path".into(),
                ));
            }
            if root.is_dir() {
                fs::remove_dir_all(root).map_err(IntegratorError::Io)?;
            } else if root.exists() {
                return Err(IntegratorError::InvalidInput(format!(
                    "project path is not a directory: {}",
                    root.display()
                )));
            }
        }
        Ok::<(), IntegratorError>(())
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn git_repository(
    state: State<'_, AppState>,
    path: PathBuf,
) -> CommandResult<RepositoryIdentity> {
    let (git, identity) = authorized_git(&state, path).await?;
    tauri::async_runtime::spawn_blocking(move || git.refresh_identity(&identity))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_worktrees(
    state: State<'_, AppState>,
    repository: PathBuf,
) -> CommandResult<Vec<WorktreeInfo>> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.worktrees(&identity.root))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_worktree_create(
    state: State<'_, AppState>,
    repository: PathBuf,
    request: CreateWorktree,
) -> CommandResult<Vec<WorktreeInfo>> {
    let (git, identity) = authorized_git(&state, repository).await?;
    let authorizations = Arc::clone(&state.git_authorizations);
    tauri::async_runtime::spawn_blocking(move || {
        let mut authorizations = authorizations.lock().expect("git authorization cache lock");
        let result = git.create_worktree(&identity.root, &request);
        authorizations.clear();
        result
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn git_status(
    state: State<'_, AppState>,
    repository: PathBuf,
) -> CommandResult<Vec<FileStatus>> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.status(&identity.root))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_tracked_paths(
    state: State<'_, AppState>,
    repository: PathBuf,
    paths: Vec<String>,
) -> CommandResult<Vec<String>> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.tracked_paths(&identity.root, &paths))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_overview(
    state: State<'_, AppState>,
    repository: PathBuf,
) -> CommandResult<GitOverview> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.overview(&identity))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_history(
    state: State<'_, AppState>,
    repository: PathBuf,
    skip: Option<u32>,
    limit: Option<u32>,
) -> CommandResult<Vec<HistoryCommit>> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || {
        git.history_page(&identity.root, skip.unwrap_or(0), limit.unwrap_or(32))
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn git_remote_add(
    state: State<'_, AppState>,
    repository: PathBuf,
    name: String,
    url: String,
) -> CommandResult<Vec<GitRemote>> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.add_remote(&identity.root, &name, &url))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_remote_update(
    state: State<'_, AppState>,
    repository: PathBuf,
    name: String,
    url: String,
) -> CommandResult<Vec<GitRemote>> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.update_remote(&identity.root, &name, &url))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_remote_remove(
    state: State<'_, AppState>,
    repository: PathBuf,
    name: String,
) -> CommandResult<Vec<GitRemote>> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.remove_remote(&identity.root, &name))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_fetch(
    state: State<'_, AppState>,
    repository: PathBuf,
    remote: Option<String>,
) -> CommandResult<GitOverview> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.fetch(&identity.root, remote.as_deref()))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_pull(
    state: State<'_, AppState>,
    repository: PathBuf,
    mode: PullMode,
) -> CommandResult<GitOverview> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.pull(&identity.root, mode))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_publish_branch(
    state: State<'_, AppState>,
    repository: PathBuf,
    remote: String,
) -> CommandResult<PushResult> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.publish_branch(&identity.root, &remote))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_publish_github(
    state: State<'_, AppState>,
    repository: PathBuf,
    name_with_owner: String,
    visibility: GithubVisibility,
    remote: String,
) -> CommandResult<GitOverview> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let github = GithubCliService::discover()
            .ok_or_else(|| IntegratorError::Unavailable("GitHub CLI is not installed".into()))?;
        github.publish_repository(&identity.root, &name_with_owner, visibility, &remote)?;
        let refreshed = git.repository(&identity.root)?;
        git.overview(&refreshed)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

const MAX_PROJECT_FILE_ENTRIES: usize = 5_000;
const MAX_PROJECT_FILE_BYTES: u64 = 1_000_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileEntry {
    path: String,
    size: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileReadInput {
    path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileContent {
    path: String,
    content: String,
    is_binary: bool,
    /// Inline `data:` URL for recognized image files so the renderer can show a
    /// real preview instead of the "binary file" placeholder. `None` for text
    /// files and for binaries we can't display as an image.
    #[serde(skip_serializing_if = "Option::is_none")]
    image_data_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileWriteInput {
    path: String,
    content: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileRenameInput {
    path: String,
    new_name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileOpener {
    id: String,
    label: String,
    description: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileOpenInput {
    path: String,
    opener_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileRevealInput {
    path: String,
}

/// Lists ordinary files inside an explicitly trusted repository. We do not
/// follow symlinks or descend into generated/dependency directories, which
/// keeps the UI tree bounded and prevents a project from exposing arbitrary
/// machine paths through a benign-looking entry.
#[tauri::command]
pub async fn project_file_list(
    state: State<'_, AppState>,
    repository: PathBuf,
) -> CommandResult<Vec<ProjectFileEntry>> {
    let root = authorized_project_directory(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || list_project_files(&root))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn project_file_read(
    state: State<'_, AppState>,
    repository: PathBuf,
    input: ProjectFileReadInput,
) -> CommandResult<ProjectFileContent> {
    let root = authorized_project_directory(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || read_project_file(&root, &input.path))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

/// Writes UTF-8 text back to one trusted project file. The same containment,
/// sensitivity, and size boundaries as reading apply, and only files that
/// already exist can be edited so the renderer never creates new paths.
#[tauri::command]
pub async fn project_file_write(
    state: State<'_, AppState>,
    repository: PathBuf,
    input: ProjectFileWriteInput,
) -> CommandResult<ProjectFileContent> {
    let root = authorized_project_directory(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || {
        write_project_file(&root, &input.path, &input.content)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn project_file_rename(
    state: State<'_, AppState>,
    repository: PathBuf,
    input: ProjectFileRenameInput,
) -> CommandResult<ProjectFileEntry> {
    let root = authorized_project_directory(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || {
        rename_project_file(&root, &input.path, &input.new_name)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

/// Reports only file openers that the native host can resolve. The renderer
/// receives stable ids and labels, never executable paths or shell authority.
#[tauri::command]
pub async fn project_file_opener_list(
    state: State<'_, AppState>,
    repository: PathBuf,
) -> CommandResult<Vec<ProjectFileOpener>> {
    let _ = authorized_project_directory(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(discover_project_file_openers)
        .await
        .map_err(|_| worker_error())
}

/// Opens one repository-relative file through a closed, native-resolved
/// target. Executable names and arbitrary command arguments never come from
/// the renderer.
#[tauri::command]
pub async fn project_file_open(
    state: State<'_, AppState>,
    repository: PathBuf,
    input: ProjectFileOpenInput,
) -> CommandResult<()> {
    let root = authorized_project_directory(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || {
        open_project_file_external(&root, &input.path, &input.opener_id)
    })
    .await
    .map_err(|_| worker_error())?
}

/// Reveals a repository-relative file in the platform file manager. Deleted
/// Git paths fall back to their nearest existing containing directory.
#[tauri::command]
pub async fn project_file_reveal(
    state: State<'_, AppState>,
    repository: PathBuf,
    input: ProjectFileRevealInput,
) -> CommandResult<()> {
    let root = authorized_project_directory(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || reveal_project_file(&root, &input.path))
        .await
        .map_err(|_| worker_error())?
}

/// Upper bound for inline attachment previews returned to the renderer.
const ATTACHMENT_PREVIEW_MAX_BYTES: u64 = 12 * 1024 * 1024;

/// Maps a lowercase file extension to an image MIME type when the extension
/// names a format we can preview inline. Shared by the composer attachment
/// preview and the in-app project file reader so both accept the same set.
fn image_mime_for_extension(extension: &str) -> Option<&'static str> {
    match extension {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

/// Returns an inline `data:` URL preview for an image the user attached from
/// the native file dialog. Attachment paths are user-picked and therefore not
/// confined to a trusted project; only recognized image types under the size
/// cap are read, and every failure degrades to `None` (no preview) because
/// previews are best-effort decoration, never load-bearing.
#[tauri::command]
pub async fn attachment_preview(path: PathBuf) -> CommandResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        let mime = image_mime_for_extension(&extension)?;
        let metadata = fs::metadata(&path).ok()?;
        if !metadata.is_file() || metadata.len() > ATTACHMENT_PREVIEW_MAX_BYTES {
            return None;
        }
        let bytes = fs::read(&path).ok()?;
        Some(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
    })
    .await
    .map_err(|_| worker_error())
}

/// A clipboard image saved under the local Integrator data directory so the
/// composer can attach a real path (and inline preview) without granting the
/// renderer arbitrary write authority.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PastedImageAttachment {
    path: PathBuf,
    name: String,
    kind: &'static str,
    data_url: String,
}

fn extension_for_image_mime(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        "image/svg+xml" => Some("svg"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("ico"),
        "image/avif" => Some("avif"),
        _ => None,
    }
}

fn save_pasted_image_bytes(
    data_directory: &Path,
    bytes: &[u8],
    mime: &str,
) -> CommandResult<PastedImageAttachment> {
    let extension = extension_for_image_mime(mime).ok_or_else(|| CommandError {
        code: "invalid-input",
        message: format!("Unsupported clipboard image type: {mime}"),
    })?;
    if bytes.is_empty() {
        return Err(CommandError {
            code: "invalid-input",
            message: "Clipboard image was empty.".into(),
        });
    }
    if bytes.len() as u64 > ATTACHMENT_PREVIEW_MAX_BYTES {
        return Err(CommandError {
            code: "invalid-input",
            message: format!(
                "Clipboard image exceeds the {} MB attachment limit.",
                ATTACHMENT_PREVIEW_MAX_BYTES / (1024 * 1024)
            ),
        });
    }
    let directory = data_directory.join("pasted-attachments");
    fs::create_dir_all(&directory).map_err(|error| CommandError {
        code: "io",
        message: format!("Could not create pasted-attachments directory: {error}"),
    })?;
    let name = format!("pasted-image-{}.{}", uuid::Uuid::new_v4(), extension);
    let path = directory.join(&name);
    fs::write(&path, bytes).map_err(|error| CommandError {
        code: "io",
        message: format!("Could not save clipboard image: {error}"),
    })?;
    let mime = image_mime_for_extension(extension).unwrap_or("application/octet-stream");
    Ok(PastedImageAttachment {
        path,
        name,
        kind: "image",
        data_url: format!("data:{mime};base64,{}", BASE64.encode(bytes)),
    })
}

/// Persists a clipboard image under the app data directory and returns a
/// composer-ready attachment (absolute path + inline preview). The renderer
/// only supplies bytes and a MIME type — never a write path.
#[tauri::command]
pub async fn attachment_save_paste(
    state: State<'_, AppState>,
    bytes_base64: String,
    mime_type: String,
) -> CommandResult<PastedImageAttachment> {
    let data_directory = state.data_directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = BASE64
            .decode(bytes_base64.trim())
            .map_err(|_| CommandError {
                code: "invalid-input",
                message: "Clipboard image encoding was invalid.".into(),
            })?;
        save_pasted_image_bytes(&data_directory, &bytes, &mime_type)
    })
    .await
    .map_err(|_| worker_error())?
}

#[tauri::command]
pub async fn git_diff(
    state: State<'_, AppState>,
    repository: PathBuf,
    scope: DiffScope,
    path: Option<PathBuf>,
) -> CommandResult<DiffResult> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.diff(&identity.root, scope, path.as_deref()))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_stage(
    state: State<'_, AppState>,
    repository: PathBuf,
    paths: Vec<PathBuf>,
) -> CommandResult<Vec<FileStatus>> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.stage(&identity.root, &paths))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_unstage(
    state: State<'_, AppState>,
    repository: PathBuf,
    paths: Vec<PathBuf>,
) -> CommandResult<Vec<FileStatus>> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.unstage(&identity.root, &paths))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    repository: PathBuf,
    message: String,
) -> CommandResult<CommitResult> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.commit(&identity.root, &message))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_push_preview(
    state: State<'_, AppState>,
    repository: PathBuf,
) -> CommandResult<PushPreview> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.push_preview(&identity.root))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_push_confirmed(
    state: State<'_, AppState>,
    repository: PathBuf,
    confirmation: PushConfirmation,
) -> CommandResult<PushResult> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.push_confirmed(&identity.root, &confirmation))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

const MAX_TERMINAL_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const TERMINAL_OUTPUT_FRAME_INTERVAL: Duration = Duration::from_millis(16);
const TERMINAL_OUTPUT_EVENT: &str = "terminal://output";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    id: String,
    cwd: String,
    shell: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputPayload {
    session_id: String,
    stream: &'static str,
    data: Option<String>,
    exit_code: Option<u32>,
}

/// Opens an interactive terminal session rooted at an explicitly trusted
/// repository. This is the only place the renderer gains command execution;
/// the shell starts in the trusted root and every byte is user-entered,
/// never a provider or a remote payload.
#[tauri::command]
pub async fn terminal_open(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    repository: PathBuf,
    cols: u16,
    rows: u16,
) -> CommandResult<TerminalSessionInfo> {
    let project_root = authorized_project_directory(&state, repository).await?;
    let root = dunce::canonicalize(&project_root).map_err(|error| CommandError {
        code: "terminal-unavailable",
        message: format!("could not resolve the repository root: {error}"),
    })?;
    let size = terminal_pty_size(cols, rows)?;
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|error| terminal_error("could not open the terminal", error))?;
    let mut command = terminal_shell_command();
    command.cwd(&root);
    apply_terminal_environment(&mut command);
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| terminal_error("could not start the terminal shell", error))?;
    drop(pair.slave);
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            return Err(terminal_error("could not read the terminal", error));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            return Err(terminal_error("could not write to the terminal", error));
        }
    };
    let killer = child.clone_killer();
    let id = uuid::Uuid::new_v4().to_string();
    let info = TerminalSessionInfo {
        id: id.clone(),
        cwd: display_path(&root),
        shell: terminal_shell_label(),
    };
    state.terminals.lock().expect("terminal lock").insert(
        id,
        crate::state::TerminalSession {
            master: pair.master,
            writer,
            killer,
        },
    );
    let session_id = info.id.clone();
    std::thread::spawn(move || {
        pump_terminal_output(&app, &session_id, reader);
        let exit_code = child.wait().ok().map(|status| status.exit_code());
        let state = app.state::<AppState>();
        let removed = state
            .terminals
            .lock()
            .expect("terminal lock")
            .remove(&session_id)
            .is_some();
        if removed {
            let _ = app.emit(
                TERMINAL_OUTPUT_EVENT,
                &TerminalOutputPayload {
                    session_id,
                    stream: "exit",
                    data: None,
                    exit_code,
                },
            );
        }
    });
    Ok(info)
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> CommandResult<()> {
    if data.len() > 16 * 1024 {
        return Err(CommandError {
            code: "invalid-input",
            message: "terminal input is too large".into(),
        });
    }
    let mut sessions = state.terminals.lock().expect("terminal lock");
    let session = sessions.get_mut(&session_id).ok_or_else(unknown_terminal)?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|error| terminal_error("could not send input to the terminal", error))?;
    session
        .writer
        .flush()
        .map_err(|error| terminal_error("could not flush terminal input", error))
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> CommandResult<()> {
    let size = terminal_pty_size(cols, rows)?;
    let sessions = state.terminals.lock().expect("terminal lock");
    let session = sessions.get(&session_id).ok_or_else(unknown_terminal)?;
    session
        .master
        .resize(size)
        .map_err(|error| terminal_error("could not resize the terminal", error))
}

#[tauri::command]
pub fn terminal_interrupt(state: State<'_, AppState>, session_id: String) -> CommandResult<()> {
    let mut sessions = state.terminals.lock().expect("terminal lock");
    let session = sessions.get_mut(&session_id).ok_or_else(unknown_terminal)?;
    session
        .writer
        .write_all(b"\x03")
        .map_err(|error| terminal_error("could not interrupt the terminal", error))?;
    session
        .writer
        .flush()
        .map_err(|error| terminal_error("could not flush terminal interrupt", error))
}

#[tauri::command]
pub fn terminal_close(state: State<'_, AppState>, session_id: String) -> CommandResult<()> {
    let session = state
        .terminals
        .lock()
        .expect("terminal lock")
        .remove(&session_id);
    if let Some(mut session) = session {
        let _ = session.killer.kill();
    }
    Ok(())
}

fn unknown_terminal() -> CommandError {
    CommandError {
        code: "not-found",
        message: "unknown terminal session".into(),
    }
}

fn terminal_error(context: &str, error: impl std::fmt::Display) -> CommandError {
    CommandError {
        code: "terminal-unavailable",
        message: format!("{context}: {error}"),
    }
}

fn terminal_shell_label() -> String {
    #[cfg(windows)]
    {
        "PowerShell".into()
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("SHELL")
            .as_deref()
            .map(Path::new)
            .and_then(Path::file_name)
            .and_then(std::ffi::OsStr::to_str)
            .filter(|name| !name.is_empty())
            .unwrap_or("sh")
            .into()
    }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn terminal_shell_command() -> CommandBuilder {
    #[cfg(windows)]
    let mut builder = CommandBuilder::new("powershell.exe");
    #[cfg(not(windows))]
    let builder = {
        let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
        let mut builder = CommandBuilder::new(shell);
        builder.args(["-i"]);
        builder
    };
    #[cfg(windows)]
    builder.args(["-NoLogo"]);
    builder
}

fn apply_terminal_environment(command: &mut CommandBuilder) {
    // The desktop dev harness may itself run without color. That process-level
    // preference must not leak into a user-owned interactive shell; the user's
    // shell profile can still opt out again if that is their own preference.
    command.env_remove("NO_COLOR");
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "AI Integrator");
    command.env("CLICOLOR", "1");
}

fn terminal_pty_size(cols: u16, rows: u16) -> CommandResult<PtySize> {
    if !(20..=500).contains(&cols) || !(5..=300).contains(&rows) {
        return Err(CommandError {
            code: "invalid-input",
            message: "terminal dimensions are out of range".into(),
        });
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn pump_terminal_output(
    app: &AppHandle<tauri::Wry>,
    session_id: &str,
    mut reader: Box<dyn Read + Send>,
) {
    let mut buffer = [0_u8; 8 * 1024];
    let mut emitted = 0usize;
    let mut truncated = false;
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        if emitted >= MAX_TERMINAL_OUTPUT_BYTES {
            if !truncated {
                truncated = true;
                let _ = emit_terminal_output(
                    app,
                    session_id,
                    "\r\n… terminal output truncated after 2 MB\r\n",
                );
            }
            continue;
        }
        let allowed = read.min(MAX_TERMINAL_OUTPUT_BYTES - emitted);
        emitted += allowed;
        let _ = emit_terminal_output(
            app,
            session_id,
            &String::from_utf8_lossy(&buffer[..allowed]),
        );
        std::thread::sleep(TERMINAL_OUTPUT_FRAME_INTERVAL);
    }
}

fn emit_terminal_output(
    app: &AppHandle<tauri::Wry>,
    session_id: &str,
    data: &str,
) -> tauri::Result<()> {
    app.emit(
        TERMINAL_OUTPUT_EVENT,
        &TerminalOutputPayload {
            session_id: session_id.into(),
            stream: "output",
            data: Some(data.into()),
            exit_code: None,
        },
    )
}

#[tauri::command]
pub async fn codex_connect(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    working_directory: Option<PathBuf>,
    task_id: Option<TaskId>,
) -> CommandResult<()> {
    let statuses = state
        .provider_statuses(false)
        .await
        .map_err(CommandError::from)?;
    let executable =
        provider_executable(&statuses, ProviderKind::Codex).ok_or_else(|| CommandError {
            code: "provider-unavailable",
            message: "Codex CLI is not installed".into(),
        })?;
    let client = adapter_codex::CodexClient::spawn(CodexLaunchOptions {
        executable,
        working_directory,
        client_version: env!("CARGO_PKG_VERSION").into(),
    })
    .await
    .map_err(CommandError::from)?;
    let runtime = CodexRuntime {
        client,
        process_id: uuid::Uuid::new_v4().to_string(),
        alive: Arc::new(AtomicBool::new(true)),
        reconciling: Arc::new(AtomicBool::new(false)),
        binding: Arc::new(std::sync::Mutex::new(None)),
        context_primer: Arc::new(std::sync::Mutex::new(None)),
        pending_user_prompt: Arc::new(std::sync::Mutex::new(None)),
    };
    if let Some(task_id) = task_id {
        let store = Arc::clone(&state.store);
        let process_id = runtime.process_id.clone();
        let binding = tauri::async_runtime::spawn_blocking(move || {
            store.create_runtime_binding(task_id, &process_id, ProviderKind::Codex)
        })
        .await
        .map_err(|_| worker_error())?
        .map_err(CommandError::from)?;
        *runtime.binding.lock().expect("binding lock") = Some(binding);
    }
    spawn_projection_pump(app, Arc::clone(&state.store), runtime.clone());
    // Snapshot subscription quota once per connect; rolling
    // `account/rateLimits/updated` notifications keep it fresh afterwards.
    {
        let client = runtime.client.clone();
        let store = Arc::clone(&state.store);
        tauri::async_runtime::spawn(async move {
            if let Ok(response) = client.read_rate_limits().await {
                store_provider_quota(&store, ProviderKind::Codex, &response);
            }
        });
    }
    let previous = if let Some(task_id) = task_id {
        let mut runtimes = state.codex.lock().await;
        replace_task_runtime(&mut *runtimes, task_id, runtime)
    } else {
        state.codex_catalog.lock().await.replace(runtime)
    };
    if let Some(previous) = previous {
        previous.alive.store(false, Ordering::Release);
        let _ = state.store.expire_process_approvals(&previous.process_id);
        let _ = previous.client.shutdown().await;
    }
    Ok(())
}

/// Forwards adapter events through the reducer into SQLite, then emits the
/// persisted, sequenced projection to the renderer. Events that arrive before
/// a task/thread binding exists cannot be attributed and are dropped.
pub(crate) fn spawn_projection_pump(
    app: AppHandle<tauri::Wry>,
    store: Arc<LocalStore>,
    runtime: CodexRuntime,
) {
    let mut receiver = runtime.client.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            let event = match receiver.recv().await {
                Ok(event) => event,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    begin_codex_reconciliation(
                        app.clone(),
                        Arc::clone(&store),
                        runtime.clone(),
                        "client/receiverLagged",
                        "event stream lagged",
                    );
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            let binding = runtime.binding.lock().expect("binding lock").clone();
            match event {
                CodexEvent::Notification { method, params } => {
                    // Account-level quota has no thread binding and would be
                    // rejected by the task-scoped reducer; persist it directly.
                    if method == "account/rateLimits/updated" {
                        store_provider_quota(&store, ProviderKind::Codex, &params);
                        continue;
                    }
                    if method == "skills/changed" {
                        let _ = app.emit(
                            "provider://native-actions-changed",
                            serde_json::json!({ "provider": "codex" }),
                        );
                        continue;
                    }
                    pump_provider_event(
                        &app,
                        &store,
                        &runtime,
                        binding.as_ref(),
                        method,
                        params,
                        None,
                    );
                }
                CodexEvent::ServerRequest { id, method, params } => {
                    let request_id = transport_from_server_request(&id);
                    pump_provider_event(
                        &app,
                        &store,
                        &runtime,
                        binding.as_ref(),
                        method,
                        params,
                        Some(request_id),
                    );
                }
                CodexEvent::ProtocolViolation { code } => {
                    begin_codex_reconciliation(
                        app.clone(),
                        Arc::clone(&store),
                        runtime.clone(),
                        "client/protocolViolation",
                        &code,
                    );
                }
                CodexEvent::StderrActivity => {}
                CodexEvent::Exited => {
                    let _ = store.expire_process_approvals(&runtime.process_id);
                    pump_connection_event(
                        &app,
                        &store,
                        &runtime,
                        "provider/exited",
                        ConnectionState::Disconnected,
                        Some("Codex app-server exited"),
                    );
                    break;
                }
            }
        }
        runtime.alive.store(false, Ordering::Release);
    });
}

fn begin_codex_reconciliation(
    app: AppHandle<tauri::Wry>,
    store: Arc<LocalStore>,
    runtime: CodexRuntime,
    method: &'static str,
    reason: &str,
) {
    if runtime.reconciling.swap(true, Ordering::AcqRel) {
        return;
    }
    pump_connection_event(
        &app,
        &store,
        &runtime,
        method,
        ConnectionState::Reconciling,
        Some(reason),
    );
    tauri::async_runtime::spawn(async move {
        let thread_id = runtime
            .binding
            .lock()
            .expect("binding lock")
            .as_ref()
            .and_then(|binding| binding.thread_id.clone());
        let result = match thread_id {
            Some(thread_id) => timeout(
                Duration::from_secs(15),
                runtime.client.read_thread(&thread_id, true),
            )
            .await
            .map_err(|_| IntegratorError::Unavailable("Codex recovery timed out".into()))
            .and_then(std::convert::identity),
            None => Err(IntegratorError::Unavailable(
                "Codex thread identity is unavailable".into(),
            )),
        };
        match result {
            Ok(response) => {
                reconcile_thread_response(&app, &store, &runtime, &response);
                pump_connection_event(
                    &app,
                    &store,
                    &runtime,
                    "client/threadReconciled",
                    ConnectionState::Connected,
                    Some("provider thread state restored"),
                );
            }
            Err(error) => {
                pump_connection_event(
                    &app,
                    &store,
                    &runtime,
                    "client/threadReconcileFailed",
                    ConnectionState::Disconnected,
                    Some(&error.to_string()),
                );
                settle_interrupted_turn(
                    &app,
                    &store,
                    runtime
                        .binding
                        .lock()
                        .expect("binding lock")
                        .as_ref()
                        .map(|binding| binding.task_id),
                );
            }
        }
        runtime.reconciling.store(false, Ordering::Release);
    });
}

fn settle_interrupted_turn(
    app: &AppHandle<tauri::Wry>,
    store: &LocalStore,
    task_id: Option<TaskId>,
) {
    let Some(task_id) = task_id else { return };
    if let Ok(Some(event)) = store.settle_interrupted_turn(task_id) {
        let _ = app.emit("runtime://projection", &event);
    }
}

fn pump_provider_event(
    app: &AppHandle<tauri::Wry>,
    store: &LocalStore,
    runtime: &CodexRuntime,
    binding: Option<&RuntimeBinding>,
    method: String,
    params: Value,
    request_id: Option<TransportRequestId>,
) {
    let Some(binding) = binding else { return };
    let Some(reduced) = reduce_codex_provider_event(runtime, binding, method, params, request_id)
    else {
        return;
    };
    persist_codex_provider_event(app, store, binding, &reduced);
}

fn reduce_codex_provider_event(
    runtime: &CodexRuntime,
    binding: &RuntimeBinding,
    method: String,
    params: Value,
    request_id: Option<TransportRequestId>,
) -> Option<ReducedProviderEvent> {
    let raw_user_prompt = raw_codex_user_prompt(&params);
    let mut reduced = match reduce_provider_event(ProviderEventInput {
        method,
        params,
        request_id,
        occurred_at: Utc::now(),
    }) {
        Ok(Some(reduced)) => reduced,
        Ok(None) => return None,
        Err(_) => reduce_connection_event(
            "client/reducerRejected",
            binding.thread_id.as_deref().unwrap_or("unknown"),
            ConnectionState::Gap,
            Some("provider event was rejected; reconciliation required"),
            Utc::now(),
        ),
    };
    annotate_codex_user_prompt(runtime, raw_user_prompt.as_deref(), &mut reduced);
    Some(reduced)
}

fn persist_codex_provider_event(
    app: &AppHandle<tauri::Wry>,
    store: &LocalStore,
    binding: &RuntimeBinding,
    reduced: &ReducedProviderEvent,
) {
    if let Ok(event) = store.apply_reduced_event(binding, reduced) {
        let _ = app.emit("runtime://projection", &event);
    }
}

fn raw_codex_user_prompt(params: &Value) -> Option<String> {
    let item = params.get("item").unwrap_or(params);
    if item.get("type").and_then(Value::as_str) != Some("userMessage") {
        return None;
    }
    Some(
        item.get("content")?
            .as_array()?
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.as_str())
            })
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn annotate_codex_user_prompt(
    runtime: &CodexRuntime,
    raw_prompt: Option<&str>,
    reduced: &mut ReducedProviderEvent,
) {
    let mut pending = runtime
        .pending_user_prompt
        .lock()
        .expect("user prompt lock");
    annotate_pending_user_prompt(&mut pending, raw_prompt, reduced);
}

fn annotate_pending_user_prompt(
    pending: &mut Option<PendingUserPrompt>,
    raw_prompt: Option<&str>,
    reduced: &mut ReducedProviderEvent,
) {
    let item = match &mut reduced.mutation {
        ProjectionMutation::ReplaceItem(item)
        | ProjectionMutation::NeutralItem(item)
        | ProjectionMutation::MergeItem(item) => item,
        _ => return,
    };
    if item.kind != integrator_core::ItemKind::UserMessage {
        return;
    }
    let Some(pending) = pending.as_mut() else {
        return;
    };
    let same_item = pending.provider_item_id.as_deref() == Some(item.provider_item_id.as_str());
    let same_prompt = raw_prompt
        .is_some_and(|body| body == pending.wire_prompt || body == pending.visible_prompt);
    if !same_item && !same_prompt {
        return;
    }
    pending.provider_item_id = Some(item.provider_item_id.clone());
    item.body =
        Some(integrator_runtime::redact_and_bound(&pending.visible_prompt, 2 * 1024 * 1024).0);
    item.native_skill = pending.native_skill.clone();
}

fn pump_connection_event(
    app: &AppHandle<tauri::Wry>,
    store: &LocalStore,
    runtime: &CodexRuntime,
    method: &str,
    connection: ConnectionState,
    reason: Option<&str>,
) {
    let Some(binding) = runtime.binding.lock().expect("binding lock").clone() else {
        return;
    };
    let Some(thread_id) = binding.thread_id.clone() else {
        return;
    };
    let reduced = reduce_connection_event(method, &thread_id, connection, reason, Utc::now());
    if let Ok(event) = store.apply_reduced_event(&binding, &reduced) {
        let _ = app.emit("runtime://projection", &event);
    }
}

fn transport_from_server_request(id: &ServerRequestId) -> TransportRequestId {
    match id.to_protocol_value() {
        Value::Number(number) => TransportRequestId::Number(number),
        Value::String(text) => TransportRequestId::String(text),
        _ => unreachable!("server request ids are numbers or strings"),
    }
}

fn server_request_from_transport(id: &TransportRequestId) -> Result<ServerRequestId, CommandError> {
    let value = match id {
        TransportRequestId::Number(number) => Value::Number(number.clone()),
        TransportRequestId::String(text) => Value::String(text.clone()),
    };
    ServerRequestId::from_protocol_value(&value).map_err(CommandError::from)
}

#[tauri::command]
pub async fn codex_disconnect(state: State<'_, AppState>) -> CommandResult<()> {
    let mut runtimes = state
        .codex
        .lock()
        .await
        .drain()
        .map(|(_, runtime)| runtime)
        .collect::<Vec<_>>();
    if let Some(runtime) = state.codex_catalog.lock().await.take() {
        runtimes.push(runtime);
    }
    for runtime in runtimes {
        runtime.alive.store(false, Ordering::Release);
        let _ = state.store.expire_process_approvals(&runtime.process_id);
        runtime
            .client
            .shutdown()
            .await
            .map_err(CommandError::from)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn codex_list_models(
    state: State<'_, AppState>,
    include_hidden: bool,
) -> CommandResult<Value> {
    codex_client(&state, None)
        .await?
        .list_models(include_hidden)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_list_threads(
    state: State<'_, AppState>,
    cursor: Option<String>,
    limit: u32,
) -> CommandResult<Value> {
    codex_client(&state, None)
        .await?
        .list_threads(cursor, limit)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_read_thread(
    state: State<'_, AppState>,
    thread_id: String,
    include_turns: bool,
) -> CommandResult<Value> {
    codex_client(&state, None)
        .await?
        .read_thread(&thread_id, include_turns)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_start_thread(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    cwd: PathBuf,
    model: Option<String>,
    effort: Option<String>,
    permission: Option<String>,
    delegation: Option<String>,
) -> CommandResult<Value> {
    let cwd = authorized_task_directory(&state, task_id, cwd).await?;
    // Map the UI permission profile onto Codex's approval-policy/sandbox
    // pair. Codex prompts through its own approval requests, so "ask" means
    // prompt for everything and "full access" means never prompt, unsandboxed.
    let (approval_policy, sandbox) = match permission.as_deref() {
        None | Some("project-write") => ("on-request", "workspace-write"),
        Some("read-only") => ("on-request", "read-only"),
        Some("ask") => ("untrusted", "workspace-write"),
        Some("full-access") => ("never", "danger-full-access"),
        Some(_) => {
            return Err(CommandError {
                code: "invalid-input",
                message: "unknown permission profile".into(),
            });
        }
    };
    let runtime = codex_runtime(&state, Some(task_id)).await?;
    let broker = state
        .broker
        .lock()
        .expect("broker lock")
        .clone()
        .ok_or_else(|| CommandError {
            code: "provider-unavailable",
            message: "Integrator local tools are not ready; retry this chat".into(),
        })?;
    let base_config = crate::delegation::codex_mcp_config(
        &broker,
        "orchestrator",
        &task_id.to_string(),
        delegation.as_deref().unwrap_or("off"),
    )
    .map_err(CommandError::from)?;
    let mcp_app = app.clone();
    let mcp_store = Arc::clone(&state.store);
    let codex_config = Some(
        tauri::async_runtime::spawn_blocking(move || {
            let enabled_servers = crate::integrator_mcp::enabled_servers(&mcp_app, &mcp_store);
            crate::integrator_mcp::merge_codex_mcp_config(base_config, &enabled_servers)
        })
        .await
        .map_err(|_| worker_error())?,
    );
    let effective_config = runtime
        .client
        .read_config(&cwd)
        .await
        .map_err(CommandError::from)?;
    let developer_instructions = crate::harness_prompt::codex_developer_instructions(
        &effective_config,
        crate::harness_prompt::LocalToolsProjection::Projected,
    );
    let response = runtime
        .client
        .start_thread_with_policies_and_overrides(
            &cwd,
            model.as_deref(),
            effort.as_deref(),
            approval_policy,
            sandbox,
            CodexThreadOverrides {
                config: codex_config,
                developer_instructions: Some(developer_instructions),
            },
        )
        .await
        .map_err(CommandError::from)?;
    if let Some(thread_id) = extract_thread_id(&response) {
        bind_thread(&state, &runtime, task_id, &thread_id).await?;
        persist_provider_resume_state(
            &state.store,
            task_id,
            ProviderKind::Codex,
            &thread_id,
            &cwd,
            permission.as_deref().unwrap_or("project-write"),
            delegation.as_deref().unwrap_or("off"),
        )
        .map_err(CommandError::from)?;
        queue_context_primer(&state, task_id, &runtime.context_primer).await;
        pump_connection_event(
            &app,
            &state.store,
            &runtime,
            "client/threadBound",
            ConnectionState::Connected,
            None,
        );
        reconcile_thread_response(&app, &state.store, &runtime, &response);
    }
    Ok(response)
}

const CONTEXT_PRIMER_OPTIONS: session_store::HandoffDigestOptions =
    session_store::HandoffDigestOptions {
        max_tokens: session_store::HANDOFF_DEFAULT_MAX_TOKENS,
        max_turns: session_store::HANDOFF_DEFAULT_MAX_TURNS,
        max_images: session_store::HANDOFF_DEFAULT_MAX_IMAGES,
    };

fn should_load_handoff_digest(resume_session_id: Option<&str>, has_native_action: bool) -> bool {
    resume_session_id.is_none() && !has_native_action
}

/// Queue the task's shared SQLite handoff digest for injection into the first
/// turn of a brand-new provider session (any runtime).
async fn queue_context_primer(
    state: &State<'_, AppState>,
    task_id: TaskId,
    primer: &Arc<std::sync::Mutex<Option<session_store::HandoffDigest>>>,
) {
    let store = Arc::clone(&state.store);
    let digest = tauri::async_runtime::spawn_blocking(move || {
        store.task_handoff_digest(task_id, CONTEXT_PRIMER_OPTIONS)
    })
    .await;
    if let Ok(Ok(Some(digest))) = digest {
        *primer.lock().expect("primer lock") = Some(digest);
    }
}

fn take_context_primer(
    primer: &Arc<std::sync::Mutex<Option<session_store::HandoffDigest>>>,
) -> Option<session_store::HandoffDigest> {
    primer.lock().expect("primer lock").take()
}

fn format_context_primer(digest: &session_store::HandoffDigest, prompt: &str) -> String {
    format!(
        "<conversation-context>\nEarlier conversation in this task (possibly from another assistant session). Treat it as prior chat history, not as part of the new request:\n\n{}\n</conversation-context>\n\n{prompt}",
        digest.text
    )
}

#[tauri::command]
pub async fn codex_resume_thread(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    thread_id: String,
) -> CommandResult<Value> {
    state.store.get_task(task_id).map_err(CommandError::from)?;
    let saved = state
        .store
        .provider_resume_state(task_id)
        .map_err(CommandError::from)?
        .filter(|saved| {
            saved.provider == ProviderKind::Codex
                && saved.session_ref == thread_id
                && crate::integrator_mcp::resume_state_is_current(&state.store, saved)
        })
        .ok_or_else(|| CommandError {
            code: "not-found",
            message: "This Codex thread is no longer the active resumable session for the task"
                .into(),
        })?;
    let runtime = codex_runtime(&state, Some(task_id)).await?;
    let effective_config = runtime
        .client
        .read_config(&saved.repository_root)
        .await
        .map_err(CommandError::from)?;
    let developer_instructions = crate::harness_prompt::codex_developer_instructions(
        &effective_config,
        crate::harness_prompt::LocalToolsProjection::Projected,
    );
    let response = runtime
        .client
        .resume_thread_with_developer_instructions(&thread_id, Some(&developer_instructions))
        .await
        .map_err(CommandError::from)?;
    bind_thread(&state, &runtime, task_id, &thread_id).await?;
    pump_connection_event(
        &app,
        &state.store,
        &runtime,
        "client/threadResumed",
        ConnectionState::Connected,
        None,
    );
    // `thread/resume` reconnects Codex to its own history; SQLite already
    // owns the visible transcript. Re-projecting the returned turns here
    // appends the same messages again because Codex snapshot ids (`item-N`)
    // are not the stable ids emitted by the live event stream.
    persist_provider_resume_state(
        &state.store,
        task_id,
        ProviderKind::Codex,
        &thread_id,
        &saved.repository_root,
        &saved.permission,
        &saved.delegation,
    )
    .map_err(CommandError::from)?;
    Ok(response)
}

/// Persist the task-to-thread binding and hand it to the projection pump so
/// subsequent provider events become attributable, durable projections.
async fn bind_thread(
    state: &State<'_, AppState>,
    runtime: &CodexRuntime,
    task_id: TaskId,
    thread_id: &str,
) -> CommandResult<()> {
    let store = Arc::clone(&state.store);
    let process_id = runtime.process_id.clone();
    let thread = thread_id.to_owned();
    let current = runtime.binding.lock().expect("binding lock").clone();
    let binding = tauri::async_runtime::spawn_blocking(move || {
        let binding = match current {
            Some(binding) if binding.task_id == task_id => binding,
            Some(_) => {
                return Err(IntegratorError::Unauthorized(
                    "Codex runtime is already bound to another task".into(),
                ));
            }
            None => store.create_runtime_binding(task_id, &process_id, ProviderKind::Codex)?,
        };
        store.attach_provider_thread(&binding, &thread)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(CommandError::from)?;
    *runtime.binding.lock().expect("binding lock") = Some(binding);
    Ok(())
}

fn persist_provider_resume_state(
    store: &LocalStore,
    task_id: TaskId,
    provider: ProviderKind,
    session_ref: &str,
    repository_root: &Path,
    permission: &str,
    delegation: &str,
) -> integrator_core::Result<()> {
    store.upsert_provider_resume_state(&ProviderResumeState {
        task_id,
        provider,
        session_ref: session_ref.to_owned(),
        repository_root: repository_root.to_path_buf(),
        permission: permission.to_owned(),
        delegation: delegation.to_owned(),
        updated_at: Utc::now(),
    })
}

/// Visible composer/transcript placeholder for interrupted-turn resume.
/// Filtered out of the rendered transcript so resume stays wire-only.
#[cfg(test)]
pub(crate) const INTERRUPTED_RESUME_VISIBLE_PROMPT: &str = "Resume from here";

fn interrupted_resume_wire_prompt(interrupted_at: Option<chrono::DateTime<Utc>>) -> String {
    let resumed_at = Utc::now();
    let interrupted = interrupted_at
        .map(|time| time.to_rfc3339())
        .unwrap_or_else(|| "an unknown time".into());
    format!(
        "You were interrupted at {interrupted}. It is now {} and this session has been resumed.\n\
         Continue what you were doing as seamlessly as possible for the user.\n\
         Complete the task assigned in the last user prompt.\n\
         Do not repeat completed actions. Prefer the current workspace and provider conversation as source of truth if anything changed while you were interrupted.\n\
         If any external or mutating outcome is uncertain, stop and explain before retrying it.",
        resumed_at.to_rfc3339()
    )
}

fn provider_wire_prompt(
    prompt: &str,
    resume_interrupted: Option<bool>,
    interrupted_at: Option<chrono::DateTime<Utc>>,
) -> String {
    if resume_interrupted == Some(true) {
        interrupted_resume_wire_prompt(interrupted_at)
    } else {
        prompt.into()
    }
}

fn interrupted_at_for_task(store: &LocalStore, task_id: TaskId) -> Option<chrono::DateTime<Utc>> {
    store.task_latest_interrupted_at(task_id).ok().flatten()
}

fn validate_interrupted_resume_action(
    native_action_id: Option<&str>,
    resume_interrupted: Option<bool>,
) -> CommandResult<()> {
    if resume_interrupted == Some(true) && native_action_id.is_some() {
        return Err(CommandError {
            code: "invalid-input",
            message: "An interrupted response cannot resume through a new native action".into(),
        });
    }
    Ok(())
}

fn validate_interrupted_resume_for_task(
    store: &LocalStore,
    task_id: TaskId,
    native_action_id: Option<&str>,
    resume_interrupted: Option<bool>,
) -> CommandResult<()> {
    validate_interrupted_resume_action(native_action_id, resume_interrupted)?;
    if resume_interrupted == Some(true) && store.task_tip_stop_requested(task_id).unwrap_or(false) {
        return Err(CommandError {
            code: "invalid-input",
            message: "A stopped turn cannot be resumed as an interruption".into(),
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn codex_start_turn(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    thread_id: String,
    prompt: String,
    repository: PathBuf,
    native_action_id: Option<String>,
    delegation: Option<String>,
    resume_interrupted: Option<bool>,
) -> CommandResult<Value> {
    validate_interrupted_resume_for_task(
        &state.store,
        task_id,
        native_action_id.as_deref(),
        resume_interrupted,
    )?;
    let _launch_guard = state
        .reserve_turn_launch(task_id)
        .ok_or_else(|| CommandError {
            code: "turn-active",
            message: "A turn is already starting for this chat".into(),
        })?;
    if state
        .store
        .task_has_unfinished_turn(task_id)
        .map_err(CommandError::from)?
    {
        return Err(CommandError {
            code: "turn-active",
            message: "A turn is already running for this chat".into(),
        });
    }
    let repository = authorized_task_directory(&state, task_id, repository).await?;
    let runtime = codex_runtime(&state, Some(task_id)).await?;
    let mut goal_objective = None;
    let mut integrator_invocation: Option<(String, String)> = None;
    let skill = if let Some(action_id) = native_action_id.as_deref() {
        let handle =
            resolve_native_action_handle(&state, &ProviderKind::Codex, &repository, action_id)?;
        let rest = native_slash_prompt(&prompt, &handle.name)?;
        if handle.kind == NativeActionKind::Command {
            if handle.name != "goal" {
                return Err(CommandError {
                    code: "provider-protocol",
                    message: "This Codex command has no native app-server route".into(),
                });
            }
            let objective = rest.trim();
            if objective.is_empty() || objective.chars().count() > 4_000 {
                return Err(CommandError {
                    code: "invalid-input",
                    message: "Add a goal after /goal using at most 4,000 characters".into(),
                });
            }
            runtime
                .client
                .set_goal(&thread_id, objective)
                .await
                .map_err(CommandError::from)?;
            goal_objective = Some(objective.to_owned());
            None
        } else if crate::integrator_skills::is_integrator_source(&handle.source) {
            // Integrator-plane skill: not in Codex's catalog, so the bounded
            // skill body rides the wire instead of a `$name` selection.
            let entry =
                crate::integrator_skills::enabled_skill_named(&app, &state.store, &handle.name)
                    .ok_or_else(|| {
                        CommandError {
                code: "stale-native-action",
                message: "This skill changed or was disabled; choose it again from the slash menu"
                    .into(),
            }
                    })?;
            integrator_invocation = Some((
                handle.name.clone(),
                crate::integrator_skills::skill_invocation_block(&entry, rest)?,
            ));
            None
        } else {
            let path = handle.provider_path.clone().ok_or_else(|| CommandError {
                code: "stale-native-action",
                message: "Codex skill path is no longer available; choose the skill again".into(),
            })?;
            let current = runtime
                .client
                .list_skills(&repository, true)
                .await
                .map_err(CommandError::from)?;
            let still_enabled = parse_codex_actions(&current)?.into_iter().any(|candidate| {
                candidate.public.name == handle.name
                    && candidate.provider_path.as_deref() == Some(path.as_path())
            });
            if !still_enabled {
                return Err(CommandError {
                    code: "stale-native-action",
                    message: "This Codex skill changed; choose it again from the slash menu".into(),
                });
            }
            Some((
                CodexSkillSelection {
                    name: handle.name.clone(),
                    path,
                },
                format!("${}{}", handle.name, rest),
            ))
        }
    } else {
        None
    };
    let visible_wire = goal_objective.as_deref().unwrap_or_else(|| {
        skill
            .as_ref()
            .map(|(_, text)| text.as_str())
            .or_else(|| {
                integrator_invocation
                    .as_ref()
                    .map(|(_, wire)| wire.as_str())
            })
            .unwrap_or(prompt.as_str())
    });
    let provider_prompt = provider_wire_prompt(
        visible_wire,
        resume_interrupted,
        resume_interrupted
            .filter(|value| *value)
            .and_then(|_| interrupted_at_for_task(&state.store, task_id)),
    );
    let mut handoff_images = Vec::new();
    let mut wire_prompt = if native_action_id.is_some() {
        // Preserve Codex's recommended `$name` text at byte zero alongside
        // a typed skill item, or the exact goal objective after setting goal
        // state. Native actions must not be silently converted back into a
        // generic prompt by hidden context.
        provider_prompt
    } else if let Some(digest) = take_context_primer(&runtime.context_primer) {
        handoff_images = digest.image_paths.clone();
        format_context_primer(&digest, &provider_prompt)
    } else {
        provider_prompt
    };
    if let Some(mode) = delegation.as_deref().filter(|mode| *mode != "off")
        && native_action_id.is_none()
    {
        let mut preface = crate::delegation::orchestrator_preamble(&state.store, mode);
        if let Some(updates) = crate::delegation::pending_updates_block(&state.store, task_id) {
            preface.push_str(&updates);
        }
        wire_prompt = format!("{preface}{wire_prompt}");
    }
    // Auto-trigger channel: Codex has no verified route to load external
    // skill directories, so the bounded index rides each plain turn.
    if native_action_id.is_none() {
        let skills = crate::integrator_skills::enabled_skills(&app, &state.store);
        if let Some(index) = crate::integrator_skills::skill_index_block(&skills) {
            wire_prompt = format!("{index}{wire_prompt}");
        }
    }
    *runtime
        .pending_user_prompt
        .lock()
        .expect("user prompt lock") =
        (wire_prompt != prompt || skill.is_some()).then(|| PendingUserPrompt {
            wire_prompt: wire_prompt.clone(),
            visible_prompt: prompt.clone(),
            native_skill: skill
                .as_ref()
                .map(|(selection, _)| selection.name.clone())
                .or_else(|| integrator_invocation.as_ref().map(|(name, _)| name.clone())),
            provider_item_id: None,
        });
    let response = runtime
        .client
        .start_turn_with_skill_and_images(
            &thread_id,
            &wire_prompt,
            skill.as_ref().map(|(selection, _)| selection),
            &handoff_images,
        )
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            *runtime
                .pending_user_prompt
                .lock()
                .expect("user prompt lock") = None;
            return Err(CommandError::from(error));
        }
    };
    reconcile_turn_response(&app, &state.store, &runtime, &thread_id, &response);
    Ok(response)
}

#[tauri::command]
pub async fn codex_interrupt_turn(
    state: State<'_, AppState>,
    thread_id: String,
    turn_id: String,
) -> CommandResult<Value> {
    codex_runtime_for_thread(&state, &thread_id)
        .await?
        .client
        .interrupt_turn(&thread_id, &turn_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_steer_turn(
    state: State<'_, AppState>,
    task_id: TaskId,
    expected_turn_id: String,
    prompt: String,
) -> CommandResult<Value> {
    let runtime = codex_runtime(&state, Some(task_id)).await?;
    let thread_id = runtime
        .binding
        .lock()
        .expect("binding lock")
        .clone()
        .filter(|binding| binding.task_id == task_id)
        .and_then(|binding| binding.thread_id)
        .ok_or_else(|| CommandError {
            code: "provider-disconnected",
            message: "Codex thread is not connected for this task".into(),
        })?;
    runtime
        .client
        .steer_turn(&thread_id, &expected_turn_id, &prompt)
        .await
        .map_err(Into::into)
}

/// True when a runtime in this process is currently bound to the task. Only
/// a bound live runtime can still be streaming a turn for it.
async fn task_has_live_runtime(state: &State<'_, AppState>, task_id: TaskId) -> bool {
    fn bound(binding: &std::sync::Mutex<Option<RuntimeBinding>>, task_id: TaskId) -> bool {
        binding
            .lock()
            .expect("binding lock")
            .as_ref()
            .is_some_and(|binding| binding.task_id == task_id)
    }
    if state
        .codex
        .lock()
        .await
        .get(&task_id)
        .is_some_and(|runtime| {
            runtime.alive.load(Ordering::Acquire) && bound(&runtime.binding, task_id)
        })
    {
        return true;
    }
    if state.acp.lock().await.get(&task_id).is_some_and(|runtime| {
        runtime.alive.load(Ordering::Acquire) && bound(&runtime.binding, task_id)
    }) {
        return true;
    }
    if state
        .structured
        .lock()
        .await
        .get(&task_id)
        .is_some_and(|runtime| {
            runtime.alive.load(Ordering::Acquire) && bound(&runtime.binding, task_id)
        })
    {
        return true;
    }
    if state.turn_launch_in_progress(task_id) {
        return true;
    }
    state
        .delegation_children
        .lock()
        .await
        .values()
        .any(|child| child.child_task_id == task_id)
}

#[tauri::command]
pub async fn task_snapshot(
    state: State<'_, AppState>,
    task_id: TaskId,
    known_watermark: Option<i64>,
    known_reset_seq: Option<i64>,
    before_seq: Option<i64>,
    limit: Option<usize>,
    skip_runtime_check: Option<bool>,
) -> CommandResult<TaskSnapshot> {
    let older_page = before_seq.is_some();
    // Snapshot hydration is a read-only view operation. Process-loss recovery
    // runs once during AppState startup, never as a side effect of selecting a
    // chat while other task-owned runtimes are active.
    let runtime_live = if older_page || skip_runtime_check.unwrap_or(false) {
        false
    } else {
        task_has_live_runtime(&state, task_id).await
    };
    let store = Arc::clone(&state.store);
    let query = TaskSnapshotQuery {
        known_watermark,
        known_reset_seq,
        before_seq,
        limit,
    };
    let mut snapshot =
        tauri::async_runtime::spawn_blocking(move || store.task_snapshot_with(task_id, query))
            .await
            .map_err(|_| worker_error())?
            .map_err(CommandError::from)?;
    snapshot.runtime_live = if older_page { false } else { runtime_live };
    Ok(snapshot)
}

#[tauri::command]
pub async fn codex_respond_approval(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    approval_id: String,
    decision: ApprovalDecision,
) -> CommandResult<ApprovalProjection> {
    let store = Arc::clone(&state.store);
    let stored_approval_id = approval_id.clone();
    let stored_decision = decision.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        store.prepare_approval_response(task_id, &stored_approval_id, stored_decision)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(CommandError::from)?;
    let _ = app.emit("runtime://projection", &prepared.event);

    let approval = match &prepared.event.projection {
        RuntimeProjection::ApprovalChanged { approval } => approval.clone(),
        _ => unreachable!("prepared approval emits an approval projection"),
    };
    // Route the wire response to whichever live process issued the request.
    let acp = state
        .acp
        .lock()
        .await
        .values()
        .find(|runtime| runtime.process_id == prepared.process_id)
        .cloned();
    let structured = state
        .structured
        .lock()
        .await
        .values()
        .find(|runtime| runtime.process_id == prepared.process_id)
        .cloned();
    let result = if let Some(acp) = acp {
        let request_id = acp_request_from_transport(&prepared.request_id)?;
        let is_plan_request = acp
            .plan_requests
            .lock()
            .expect("plan lock")
            .remove(&transport_key(&prepared.request_id));
        let outcome = if is_plan_request {
            acp_plan_review_result(decision)
        } else {
            acp_permission_outcome(&acp, &prepared.request_id, decision)
        };
        acp.client
            .respond_to_server_request(&request_id, outcome)
            .await
    } else if let Some(structured) = structured {
        let request_id = match &prepared.request_id {
            TransportRequestId::String(text) => text.clone(),
            TransportRequestId::Number(number) => number.to_string(),
        };
        let pending = structured
            .permission_requests
            .lock()
            .expect("permission lock")
            .remove(&request_id);
        let response = structured_permission_response(decision, pending);
        structured
            .client
            .respond_permission(&request_id, response)
            .await
    } else {
        let runtime = codex_runtime_for_process(&state, &prepared.process_id).await?;
        let request_id = server_request_from_transport(&prepared.request_id)?;
        runtime
            .client
            .respond_to_server_request(
                &request_id,
                serde_json::json!({ "decision": approval.decision.as_ref().map(ApprovalDecision::as_protocol_str) }),
            )
            .await
    };
    if let Err(error) = result {
        let store = Arc::clone(&state.store);
        if let Ok(Ok(event)) = tauri::async_runtime::spawn_blocking(move || {
            store.mark_approval_response_failed(&approval_id)
        })
        .await
        {
            let _ = app.emit("runtime://projection", event);
        }
        return Err(CommandError::from(error));
    }
    Ok(approval)
}

#[tauri::command]
pub async fn codex_stop_turn(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
) -> CommandResult<StopRequestResult> {
    let store = Arc::clone(&state.store);
    let persisted = tauri::async_runtime::spawn_blocking(move || store.request_stop(task_id))
        .await
        .map_err(|_| worker_error())?
        .map_err(CommandError::from)?;
    if let Some(event) = &persisted.event {
        let _ = app.emit("runtime://projection", event);
    }
    if !persisted.result.settled {
        // The persisted stop is provider-neutral; route the wire-level
        // interrupt to whichever runtime owns this task.
        let routed: Result<(), CommandError> = async {
            let acp = state.acp.lock().await.get(&task_id).cloned();
            let acp_session = acp.as_ref().and_then(|runtime| {
                runtime
                    .binding
                    .lock()
                    .expect("binding lock")
                    .clone()
                    .filter(|binding| binding.task_id == task_id)
                    .and_then(|binding| binding.thread_id)
            });
            if let (Some(runtime), Some(session_id)) = (acp, acp_session) {
                runtime
                    .client
                    .cancel(&session_id)
                    .await
                    .map_err(CommandError::from)?;
            } else if let Some(runtime) = state.structured.lock().await.get(&task_id).cloned() {
                let turn_id = runtime
                    .current_turn
                    .lock()
                    .expect("turn lock")
                    .clone()
                    .ok_or_else(|| CommandError {
                        code: "provider-disconnected",
                        message: "structured provider turn is no longer active".into(),
                    })?;
                runtime
                    .client
                    .cancel(&turn_id)
                    .await
                    .map_err(CommandError::from)?;
            } else {
                let runtime = codex_runtime(&state, Some(task_id)).await?;
                let binding = runtime.binding.lock().expect("binding lock").clone();
                let thread_id = binding
                    .filter(|binding| binding.task_id == task_id)
                    .and_then(|binding| binding.thread_id)
                    .ok_or_else(|| CommandError {
                        code: "provider-disconnected",
                        message: "active task is not connected to a provider".into(),
                    })?;
                runtime
                    .client
                    .interrupt_turn(&thread_id, &persisted.result.turn_id)
                    .await
                    .map_err(CommandError::from)?;
            }
            Ok(())
        }
        .await;
        if let Err(error) = routed {
            // The provider never received the interrupt (dead or rebound
            // session). Settle the turn locally so the UI leaves the
            // running state instead of surfacing a not-found error.
            let store = Arc::clone(&state.store);
            let settled =
                tauri::async_runtime::spawn_blocking(move || store.settle_stopped_turn(task_id))
                    .await
                    .map_err(|_| worker_error())?
                    .map_err(CommandError::from)?;
            let Some(event) = settled else {
                return Err(error);
            };
            let _ = app.emit("runtime://projection", &event);
            let mut result = persisted.result;
            result.settled = true;
            return Ok(result);
        }
    }
    Ok(persisted.result)
}

#[tauri::command]
pub async fn acp_connect(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    provider: ProviderKind,
    working_directory: Option<PathBuf>,
    task_id: Option<TaskId>,
) -> CommandResult<()> {
    let working_directory = match working_directory {
        Some(directory) => Some(authorized_project_directory(&state, directory).await?),
        None => None,
    };
    if let Some(task_id) = task_id {
        let runtimes = state.acp.lock().await;
        if runtimes.get(&task_id).is_some_and(|runtime| {
            runtime.provider == provider && runtime.alive.load(Ordering::Acquire)
        }) {
            return Ok(());
        }
    }
    let arguments = acp_launch_arguments(
        &provider,
        Some(crate::harness_prompt::LocalToolsProjection::Projected),
    )?;
    let statuses = state
        .provider_statuses(false)
        .await
        .map_err(CommandError::from)?;
    let executable = provider_executable(&statuses, provider).ok_or_else(|| CommandError {
        code: "provider-unavailable",
        message: format!("{} CLI is not installed", provider.as_str()),
    })?;
    let client = adapter_acp::AcpClient::spawn(adapter_acp::AcpLaunchOptions {
        executable,
        arguments,
        working_directory,
        client_version: env!("CARGO_PKG_VERSION").into(),
    })
    .await
    .map_err(CommandError::from)?;
    if let Err(error) = authenticate_acp_provider(&client, &provider).await {
        let _ = client.shutdown().await;
        return Err(error);
    }
    let (turn_settled, _) = tokio::sync::broadcast::channel(8);
    let runtime = AcpRuntime {
        client,
        provider,
        process_id: uuid::Uuid::new_v4().to_string(),
        alive: Arc::new(AtomicBool::new(true)),
        binding: Arc::new(std::sync::Mutex::new(None)),
        current_turn: Arc::new(std::sync::Mutex::new(None)),
        current_turn_started_at: Arc::new(std::sync::Mutex::new(None)),
        turn_settled,
        permission_options: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        session_modes: Arc::new(std::sync::Mutex::new(None)),
        plan_requests: Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
        available_actions: Arc::new(std::sync::Mutex::new(Vec::new())),
        context_primer: Arc::new(std::sync::Mutex::new(None)),
        delegation_preamble: Arc::new(std::sync::Mutex::new(None)),
        unattended: false,
        read_only: false,
        session_spec: Arc::new(std::sync::Mutex::new(None)),
        replaying_history: Arc::new(AtomicBool::new(false)),
    };
    let mut retained_existing = false;
    let previous = if let Some(task_id) = task_id {
        let mut runtimes = state.acp.lock().await;
        if runtimes.get(&task_id).is_some_and(|existing| {
            existing.provider == provider && existing.alive.load(Ordering::Acquire)
        }) {
            retained_existing = true;
            None
        } else {
            replace_task_runtime(&mut *runtimes, task_id, runtime.clone())
        }
    } else {
        state
            .acp_catalog
            .lock()
            .await
            .insert(provider, runtime.clone())
    };
    if retained_existing {
        runtime.alive.store(false, Ordering::Release);
        let _ = runtime.client.shutdown().await;
        return Ok(());
    }
    spawn_acp_pump(app, Arc::clone(&state.store), runtime);
    if let Some(previous) = previous {
        previous.alive.store(false, Ordering::Release);
        let _ = state.store.expire_process_approvals(&previous.process_id);
        let _ = previous.client.shutdown().await;
    }
    Ok(())
}

pub(crate) fn acp_launch_arguments(
    provider: &ProviderKind,
    harness_tools: Option<crate::harness_prompt::LocalToolsProjection>,
) -> CommandResult<Vec<String>> {
    Ok(match provider {
        ProviderKind::Cursor => vec!["acp".into()],
        // Scripted ACP starts disable implicit self-updates; the vendor CLI
        // and its vendor-owned cached login remain the authority.
        ProviderKind::Grok => {
            let mut arguments = vec!["--no-auto-update".into()];
            if let Some(tools) = harness_tools {
                arguments.extend([
                    "--rules".into(),
                    crate::harness_prompt::instructions(ProviderKind::Grok, tools),
                ]);
            }
            arguments.extend(["agent".into(), "stdio".into()]);
            arguments
        }
        _ => {
            return Err(CommandError {
                code: "provider-unavailable",
                message: format!(
                    "{} does not expose a certified ACP launch route",
                    provider.as_str()
                ),
            });
        }
    })
}

#[tauri::command]
pub async fn acp_start_session(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    cwd: PathBuf,
    delegation: Option<String>,
    permission: Option<String>,
) -> CommandResult<Value> {
    let cwd = authorized_task_directory(&state, task_id, cwd).await?;
    let permission = match permission.as_deref() {
        None | Some("project-write") => "project-write",
        Some("read-only") => "read-only",
        Some("ask") => "ask",
        Some("full-access") => "full-access",
        Some(_) => {
            return Err(CommandError {
                code: "invalid-input",
                message: "unknown permission profile".into(),
            });
        }
    };
    let runtime = acp_runtime(&state, Some(task_id), None).await?;
    let provider = runtime.provider;
    let provider_name = provider.as_str().to_owned();
    // Delegation broker injection: ACP's `session/new` carries MCP servers
    // natively. The tool preamble is queued one-shot for the first turn.
    let mcp_servers =
        acp_session_mcp_servers(&app, &state, &runtime, task_id, &cwd, delegation.as_deref())
            .await?;
    if let Some(mode) = delegation.as_deref().filter(|mode| *mode != "off") {
        *runtime.delegation_preamble.lock().expect("preamble lock") =
            Some(crate::delegation::orchestrator_preamble(&state.store, mode));
    }
    let response = runtime
        .client
        .new_session(&cwd, mcp_servers.clone())
        .await
        .map_err(CommandError::from)?;
    let session_id = response
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| CommandError {
            code: "provider-protocol",
            message: format!("{provider_name} did not return a session identifier"),
        })?
        .to_owned();
    let binding = bind_acp_session(&state, &runtime, task_id, &session_id).await?;
    *runtime.session_spec.lock().expect("session spec lock") = Some(AcpSessionSpec {
        cwd: cwd.clone(),
        mcp_servers,
    });
    persist_provider_resume_state(
        &state.store,
        task_id,
        provider,
        &session_id,
        &cwd,
        permission,
        delegation.as_deref().unwrap_or("off"),
    )
    .map_err(CommandError::from)?;
    let connected = reduce_connection_event(
        "client/acp/connected",
        &session_id,
        ConnectionState::Connected,
        None,
        Utc::now(),
    );
    apply_and_emit(&app, &state.store, &binding, &connected);
    // Agents that support session modes advertise them on session/new; keep
    // the state for later current_mode_update merges and surface it now so
    // the composer can render the mode picker immediately.
    if let Some(mode) = parse_acp_mode_state(&response) {
        *runtime.session_modes.lock().expect("modes lock") = Some(mode.clone());
        let event = acp_mode_event(&session_id, None, mode, Utc::now());
        apply_and_emit(&app, &state.store, &binding, &event);
    }
    queue_context_primer(&state, task_id, &runtime.context_primer).await;
    Ok(response)
}

async fn acp_session_mcp_servers(
    app: &AppHandle<tauri::Wry>,
    state: &AppState,
    runtime: &AcpRuntime,
    task_id: TaskId,
    cwd: &Path,
    delegation: Option<&str>,
) -> CommandResult<Vec<Value>> {
    let broker = state
        .broker
        .lock()
        .expect("broker lock")
        .clone()
        .ok_or_else(|| CommandError {
            code: "provider-unavailable",
            message: "Integrator local tools are not ready; retry this chat".into(),
        })?;
    let harness_instructions = (runtime.provider == ProviderKind::Cursor).then(|| {
        crate::harness_prompt::instructions(
            ProviderKind::Cursor,
            crate::harness_prompt::LocalToolsProjection::Projected,
        )
    });
    let mut entries = vec![
        crate::delegation::acp_mcp_server_entry(
            &broker,
            "orchestrator",
            &task_id.to_string(),
            delegation.unwrap_or("off"),
            harness_instructions.as_deref(),
        )
        .map_err(CommandError::from)?,
    ];
    let mcp_app = app.clone();
    let mcp_store = Arc::clone(&state.store);
    let capabilities = runtime.client.session_capabilities().await;
    let mcp_cwd = cwd.to_path_buf();
    let projected = tauri::async_runtime::spawn_blocking(move || {
        let enabled_servers = crate::integrator_mcp::enabled_servers(&mcp_app, &mcp_store);
        crate::integrator_mcp::acp_mcp_server_entries(&enabled_servers, capabilities, &mcp_cwd)
    })
    .await
    .map_err(|_| worker_error())??;
    entries.extend(projected);
    Ok(entries)
}

async fn bind_acp_session(
    state: &State<'_, AppState>,
    runtime: &AcpRuntime,
    task_id: TaskId,
    session_id: &str,
) -> CommandResult<RuntimeBinding> {
    let store = Arc::clone(&state.store);
    let process_id = runtime.process_id.clone();
    let provider = runtime.provider;
    let provider_name = provider.as_str().to_owned();
    let session = session_id.to_owned();
    let current = runtime.binding.lock().expect("binding lock").clone();
    let binding = tauri::async_runtime::spawn_blocking(move || {
        let binding = match current {
            Some(binding) if binding.task_id == task_id => binding,
            Some(_) => {
                return Err(IntegratorError::Unauthorized(format!(
                    "{provider_name} runtime is already bound to another task"
                )));
            }
            None => store.create_runtime_binding(task_id, &process_id, provider)?,
        };
        store.attach_provider_thread(&binding, &session)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(CommandError::from)?;
    *runtime.binding.lock().expect("binding lock") = Some(binding.clone());
    Ok(binding)
}

#[tauri::command]
pub async fn acp_resume_session(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    cwd: PathBuf,
) -> CommandResult<Value> {
    let cwd = authorized_task_directory(&state, task_id, cwd).await?;
    let saved = state
        .store
        .provider_resume_state(task_id)
        .map_err(CommandError::from)?
        .ok_or_else(|| CommandError {
            code: "not-found",
            message: "This task has no saved provider session to resume".into(),
        })?;
    if !crate::integrator_mcp::resume_state_is_current(&state.store, &saved) {
        return Err(CommandError {
            code: "not-found",
            message: "The saved provider session predates the current MCP configuration".into(),
        });
    }
    let runtime = acp_runtime(&state, Some(task_id), None).await?;
    if saved.provider != runtime.provider || saved.repository_root != cwd {
        return Err(CommandError {
            code: "unauthorized",
            message: "The saved provider session does not match this task and workspace".into(),
        });
    }
    let mcp_servers = acp_session_mcp_servers(
        &app,
        &state,
        &runtime,
        task_id,
        &cwd,
        Some(&saved.delegation),
    )
    .await?;
    let binding = bind_acp_session(&state, &runtime, task_id, &saved.session_ref).await?;
    *runtime.session_spec.lock().expect("session spec lock") = Some(AcpSessionSpec {
        cwd: cwd.clone(),
        mcp_servers: mcp_servers.clone(),
    });
    acp_connection_event(
        &app,
        &state.store,
        &runtime,
        "client/sessionRecovering",
        ConnectionState::Reconciling,
        Some("restoring provider session"),
    );
    let capabilities = runtime.client.session_capabilities().await;
    let result = if capabilities.resume {
        runtime.replaying_history.store(true, Ordering::Release);
        runtime
            .client
            .resume_session(&saved.session_ref, &cwd, mcp_servers)
            .await
    } else if capabilities.load {
        runtime.replaying_history.store(true, Ordering::Release);
        runtime
            .client
            .load_session(&saved.session_ref, &cwd, mcp_servers)
            .await
    } else {
        Err(IntegratorError::Unavailable(format!(
            "{} did not advertise ACP session recovery",
            runtime.provider.as_str()
        )))
    };
    let response = match result {
        Ok(response) => response,
        Err(error) => {
            runtime.replaying_history.store(false, Ordering::Release);
            acp_connection_event(
                &app,
                &state.store,
                &runtime,
                "client/sessionRecoveryFailed",
                ConnectionState::Disconnected,
                Some(&error.to_string()),
            );
            return Err(CommandError::from(error));
        }
    };
    if let Some(mode) = parse_acp_mode_state(&response) {
        *runtime.session_modes.lock().expect("modes lock") = Some(mode.clone());
        let event = acp_mode_event(&saved.session_ref, None, mode, Utc::now());
        apply_and_emit(&app, &state.store, &binding, &event);
    }
    persist_provider_resume_state(
        &state.store,
        task_id,
        saved.provider,
        &saved.session_ref,
        &cwd,
        &saved.permission,
        &saved.delegation,
    )
    .map_err(CommandError::from)?;
    Ok(response)
}

#[tauri::command]
pub async fn acp_send_turn(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    prompt: String,
    delegation: Option<String>,
    native_action_id: Option<String>,
    resume_interrupted: Option<bool>,
) -> CommandResult<Value> {
    validate_interrupted_resume_for_task(
        &state.store,
        task_id,
        native_action_id.as_deref(),
        resume_interrupted,
    )?;
    let _launch_guard = state
        .reserve_turn_launch(task_id)
        .ok_or_else(|| CommandError {
            code: "turn-active",
            message: "A turn is already starting for this chat".into(),
        })?;
    if state
        .store
        .task_has_unfinished_turn(task_id)
        .map_err(CommandError::from)?
    {
        return Err(CommandError {
            code: "turn-active",
            message: "A turn is already running for this chat".into(),
        });
    }
    let runtime = acp_runtime(&state, Some(task_id), None).await?;
    timeout(Duration::from_secs(15), async {
        while runtime.replaying_history.load(Ordering::Acquire)
            && runtime.alive.load(Ordering::Acquire)
        {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| CommandError {
        code: "provider-unavailable",
        message: "Provider session recovery is still in progress; try Resume again shortly".into(),
    })?;
    if !runtime.alive.load(Ordering::Acquire) {
        return Err(CommandError {
            code: "provider-disconnected",
            message: "Provider session recovery failed; reconnect before resuming".into(),
        });
    }
    let provider_name = runtime.provider.as_str();
    let mut integrator_invocation: Option<(String, String)> = None;
    if let Some(action_id) = native_action_id.as_deref() {
        let task = state.store.get_task(task_id).map_err(CommandError::from)?;
        let repository = task
            .worktree_path
            .as_ref()
            .or(task.repository_path.as_ref())
            .ok_or_else(|| CommandError {
                code: "invalid-input",
                message: "task has no explicit repository/worktree identity".into(),
            })?;
        let repository = dunce::canonicalize(repository).map_err(|_| CommandError {
            code: "invalid-input",
            message: "task repository/worktree is unavailable".into(),
        })?;
        let handle =
            resolve_native_action_handle(&state, &runtime.provider, &repository, action_id)?;
        let rest = native_slash_prompt(&prompt, &handle.name)?;
        if crate::integrator_skills::is_integrator_source(&handle.source) {
            // Integrator-plane skill: ACP providers never advertise it, so
            // the bounded skill body rides the wire instead of a `/name`.
            let entry =
                crate::integrator_skills::enabled_skill_named(&app, &state.store, &handle.name)
                    .ok_or_else(|| {
                        CommandError {
                code: "stale-native-action",
                message: "This skill changed or was disabled; choose it again from the slash menu"
                    .into(),
            }
                    })?;
            integrator_invocation = Some((
                handle.name.clone(),
                crate::integrator_skills::skill_invocation_block(&entry, rest)?,
            ));
        } else {
            let mut advertised = false;
            for _ in 0..12 {
                advertised = runtime
                    .available_actions
                    .lock()
                    .expect("action lock")
                    .iter()
                    .any(|action| action.name == handle.name);
                if advertised {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            if !advertised {
                return Err(CommandError {
                    code: "stale-native-action",
                    message: format!(
                        "{provider_name} no longer advertises this command; choose it again"
                    ),
                });
            }
        }
    }
    let binding = runtime
        .binding
        .lock()
        .expect("binding lock")
        .clone()
        .filter(|binding| binding.task_id == task_id)
        .ok_or_else(|| CommandError {
            code: "provider-disconnected",
            message: format!("{provider_name} session is not bound to this task"),
        })?;
    let session_id = binding.thread_id.clone().ok_or_else(|| CommandError {
        code: "provider-disconnected",
        message: format!("{provider_name} session identity is missing"),
    })?;
    let turn_id = uuid::Uuid::new_v4().to_string();
    let started_at = Utc::now();
    *runtime
        .current_turn_started_at
        .lock()
        .expect("turn start lock") = Some(started_at);
    *runtime.current_turn.lock().expect("turn lock") = Some(turn_id.clone());

    // Persist the user message and the in-progress turn before prompting so a
    // restart mid-turn can reconstruct what was asked. Interrupted resume is
    // wire-only — the prior user prompt already owns the transcript slot.
    if resume_interrupted != Some(true) {
        let user_item = ReducedProviderEvent {
            method: "client/acp/userMessage".into(),
            thread_id: session_id.clone(),
            turn_id: Some(turn_id.clone()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::NeutralItem(integrator_core::ItemProjection {
                id: format!("acp:{session_id}:{turn_id}:user"),
                provider_item_id: format!("{turn_id}-user"),
                kind: integrator_core::ItemKind::UserMessage,
                status: integrator_core::ItemStatus::Completed,
                title: None,
                body: Some(integrator_runtime::redact_and_bound(&prompt, 2 * 1024 * 1024).0),
                native_skill: integrator_invocation.as_ref().map(|(name, _)| name.clone()),
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
                updated_at: started_at,
            }),
            occurred_at: started_at,
        };
        apply_and_emit(&app, &state.store, &binding, &user_item);
    }
    let turn_started = ReducedProviderEvent {
        method: "client/acp/turnStarted".into(),
        thread_id: session_id.clone(),
        turn_id: Some(turn_id.clone()),
        audit_json: "{}".into(),
        audit_truncated: false,
        mutation: ProjectionMutation::Turn(acp_turn_projection(
            &turn_id,
            TurnStatus::InProgress,
            None,
            started_at,
            started_at,
        )),
        occurred_at: started_at,
    };
    apply_and_emit(&app, &state.store, &binding, &turn_started);

    // The prompt future keeps the request alive, but it does not settle the
    // turn. The ACP adapter emits an ordered PromptFinished boundary after all
    // preceding session/update notifications; the projection pump owns final
    // persistence and clears current_turn only when it reaches that boundary.
    // The primer rides only on the wire prompt — the persisted user item above
    // keeps the prompt exactly as the user typed it.
    let provider_prompt = provider_wire_prompt(
        &prompt,
        resume_interrupted,
        resume_interrupted
            .filter(|value| *value)
            .and_then(|_| interrupted_at_for_task(&state.store, task_id)),
    );
    let mut handoff_images = Vec::new();
    let mut wire_prompt = if let Some((_, invocation)) = &integrator_invocation {
        // Explicit Integrator-skill invocation: the wire carries the bounded
        // skill body; the persisted user item above keeps the typed `/name`.
        invocation.clone()
    } else if let Some(digest) = take_context_primer(&runtime.context_primer) {
        handoff_images = digest.image_paths.clone();
        format_context_primer(&digest, &provider_prompt)
    } else {
        provider_prompt
    };
    if delegation.as_deref().is_some_and(|mode| mode != "off") {
        let mut preface = runtime
            .delegation_preamble
            .lock()
            .expect("preamble lock")
            .take()
            .unwrap_or_default();
        if let Some(updates) = crate::delegation::pending_updates_block(&state.store, task_id) {
            preface.push_str(&updates);
        }
        if !preface.is_empty() {
            wire_prompt = format!("{preface}{wire_prompt}");
        }
    }
    // Auto-trigger channel: ACP has no skill-loading parameter, so the
    // bounded index rides each plain turn.
    if native_action_id.is_none() {
        let skills = crate::integrator_skills::enabled_skills(&app, &state.store);
        if let Some(index) = crate::integrator_skills::skill_index_block(&skills) {
            wire_prompt = format!("{index}{wire_prompt}");
        }
    }
    let client = runtime.client.clone();
    tauri::async_runtime::spawn(async move {
        let _ = client
            .prompt_with_images(&session_id, &wire_prompt, &handoff_images)
            .await;
    });
    Ok(serde_json::json!({ "turnId": turn_id }))
}

/// Resolve the ACP session bound to `task_id`, or fail as disconnected.
fn acp_bound_session(runtime: &AcpRuntime, task_id: TaskId) -> Result<String, CommandError> {
    runtime
        .binding
        .lock()
        .expect("binding lock")
        .clone()
        .filter(|binding| binding.task_id == task_id)
        .and_then(|binding| binding.thread_id)
        .ok_or_else(|| CommandError {
            code: "provider-disconnected",
            message: format!(
                "{} session is not bound to this task",
                runtime.provider.as_str()
            ),
        })
}

#[tauri::command]
pub async fn acp_set_config_option(
    state: State<'_, AppState>,
    task_id: TaskId,
    config_id: String,
    value: String,
) -> CommandResult<Value> {
    let runtime = acp_runtime(&state, Some(task_id), None).await?;
    let session_id = acp_bound_session(&runtime, task_id)?;
    runtime
        .client
        .set_config_option(&session_id, &config_id, &value)
        .await
        .map_err(Into::into)
}

/// Switch the ACP session's mode (e.g. Cursor Agent/Plan/Ask). The mode must
/// be one the agent advertised at session start. The refreshed mode state is
/// persisted and emitted immediately; agents that also echo a
/// `current_mode_update` produce a harmless duplicate.
#[tauri::command]
pub async fn acp_set_mode(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    mode_id: String,
) -> CommandResult<Value> {
    let runtime = acp_runtime(&state, Some(task_id), None).await?;
    let session_id = acp_bound_session(&runtime, task_id)?;
    let known = runtime
        .session_modes
        .lock()
        .expect("modes lock")
        .as_ref()
        .is_some_and(|modes| modes.available_modes.iter().any(|mode| mode.id == mode_id));
    if !known {
        return Err(CommandError {
            code: "invalid-input",
            message: format!(
                "{} did not advertise a \"{mode_id}\" session mode",
                runtime.provider.as_str()
            ),
        });
    }
    let response = runtime
        .client
        .set_mode(&session_id, &mode_id)
        .await
        .map_err(CommandError::from)?;
    let mode = {
        let mut modes = runtime.session_modes.lock().expect("modes lock");
        let Some(mode_state) = modes.as_mut() else {
            return Ok(response);
        };
        mode_state.current_mode_id = mode_id;
        mode_state.clone()
    };
    if let Some(binding) = runtime
        .binding
        .lock()
        .expect("binding lock")
        .clone()
        .filter(|binding| binding.task_id == task_id)
    {
        let turn_id = runtime.current_turn.lock().expect("turn lock").clone();
        let event = acp_mode_event(&session_id, turn_id.as_deref(), mode, Utc::now());
        apply_and_emit(&app, &state.store, &binding, &event);
    }
    Ok(response)
}

#[tauri::command]
pub async fn acp_list_cursor_models(
    state: State<'_, AppState>,
    task_id: Option<TaskId>,
) -> CommandResult<Value> {
    let runtime = acp_runtime(&state, task_id, Some(ProviderKind::Cursor)).await?;
    if runtime.provider != ProviderKind::Cursor {
        return Err(CommandError {
            code: "invalid-input",
            message: "cursor/list_available_models is a Cursor-only extension".into(),
        });
    }
    runtime
        .client
        .list_cursor_models()
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn acp_session_capabilities(
    state: State<'_, AppState>,
    task_id: TaskId,
) -> CommandResult<adapter_acp::AcpSessionCapabilities> {
    let runtime = acp_runtime(&state, Some(task_id), None).await?;
    Ok(runtime.client.session_capabilities().await)
}

// The argument list is the typed renderer-to-Tauri command protocol.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn structured_cli_start_turn(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    provider: ProviderKind,
    cwd: PathBuf,
    model: Option<String>,
    effort: Option<String>,
    permission: String,
    prompt: String,
    delegation: Option<String>,
    native_action_id: Option<String>,
    resume_interrupted: Option<bool>,
) -> CommandResult<Value> {
    validate_interrupted_resume_for_task(
        &state.store,
        task_id,
        native_action_id.as_deref(),
        resume_interrupted,
    )?;
    let _launch_guard = state
        .reserve_turn_launch(task_id)
        .ok_or_else(|| CommandError {
            code: "turn-active",
            message: "A turn is already starting for this chat".into(),
        })?;
    if state
        .store
        .task_has_unfinished_turn(task_id)
        .map_err(CommandError::from)?
    {
        return Err(CommandError {
            code: "turn-active",
            message: "A turn is already running for this chat".into(),
        });
    }
    let existing_runtime = state.structured.lock().await.get(&task_id).cloned();
    if existing_runtime.as_ref().is_some_and(|runtime| {
        runtime.alive.load(Ordering::Acquire)
            && runtime.current_turn.lock().expect("turn lock").is_some()
    }) {
        return Err(CommandError {
            code: "turn-active",
            message: "A turn is already running for this chat".into(),
        });
    }
    let repository = authorized_task_directory(&state, task_id, cwd.clone()).await?;
    let native_action = native_action_id
        .as_deref()
        .map(|action_id| resolve_native_action_handle(&state, &provider, &repository, action_id))
        .transpose()?;
    let mut integrator_invocation = None;
    if let Some(action) = native_action.as_ref() {
        let rest = native_slash_prompt(&prompt, &action.name)?;
        if crate::integrator_skills::is_integrator_source(&action.source) {
            // Integrator-plane skills are not in the provider's own catalog;
            // re-validate against the Integrator roots. Claude loads the
            // projected bundle natively and parses the `/name` itself; agy
            // has no native route, so the bounded skill body rides the wire.
            let entry =
                crate::integrator_skills::enabled_skill_named(&app, &state.store, &action.name)
                    .ok_or_else(|| {
                        CommandError {
                code: "stale-native-action",
                message: "This skill changed or was disabled; choose it again from the slash menu"
                    .into(),
            }
                    })?;
            if matches!(provider, ProviderKind::Antigravity) {
                integrator_invocation = Some(crate::integrator_skills::skill_invocation_block(
                    &entry, rest,
                )?);
            }
        } else {
            let still_present = discover_file_actions(&provider, &repository)
                .into_iter()
                .any(|candidate| {
                    candidate.name == action.name
                        && candidate.source == action.source
                        && candidate.invocation == NativeActionInvocation::Direct
                });
            if !still_present {
                return Err(CommandError {
                    code: "stale-native-action",
                    message: "This provider skill changed; choose it again from the slash menu"
                        .into(),
                });
            }
        }
    }
    let native_skill = native_action
        .as_ref()
        .filter(|action| action.kind == NativeActionKind::Skill)
        .map(|action| action.name.clone());
    let structured_provider = structured_provider(&provider)?;
    if matches!(structured_provider, StructuredCliProvider::Antigravity)
        && delegation.as_deref().is_some_and(|mode| mode != "off")
    {
        return Err(CommandError {
            code: "provider-unavailable",
            message:
                "Antigravity cannot lead brokered delegation; choose Codex, Claude, Cursor, or Grok"
                    .into(),
        });
    }
    let permission_mode = match permission.as_str() {
        "read-only" => StructuredPermissionMode::ReadOnly,
        "project-write" => StructuredPermissionMode::AcceptEdits,
        // Claude routes prompts over the stdio control channel, so "ask"
        // yields real approval popups. agy's print mode has no channel to
        // answer its request-review prompts, so "ask" cannot be honored there.
        "ask" => match structured_provider {
            StructuredCliProvider::Claude => StructuredPermissionMode::Prompt,
            StructuredCliProvider::Antigravity => {
                return Err(CommandError {
                    code: "invalid-input",
                    message: "the Antigravity CLI cannot prompt for approvals in this mode; \
                              choose Read only, Project write, or Full access"
                        .into(),
                });
            }
        },
        // The user explicitly picked the "Full access" profile; map it onto
        // each vendor's skip-approvals flag.
        "full-access" => StructuredPermissionMode::BypassPermissions,
        _ => {
            return Err(CommandError {
                code: "invalid-input",
                message: "unknown permission profile".into(),
            });
        }
    };
    let statuses = state
        .provider_statuses(false)
        .await
        .map_err(CommandError::from)?;
    let executable = provider_executable(&statuses, provider).ok_or_else(|| CommandError {
        code: "provider-unavailable",
        message: format!("{} CLI is not installed", provider.as_str()),
    })?;

    // A task owns at most one structured provider process, but other tasks keep
    // running independently in the background. Replacing a process is scoped
    // to this task only (for a retry, provider change, or resumed next turn).
    let saved_resume = state
        .store
        .provider_resume_state(task_id)
        .map_err(CommandError::from)?
        .filter(|saved| {
            saved.provider == provider
                && saved.repository_root == repository
                && crate::integrator_mcp::resume_state_is_current(&state.store, saved)
        });
    let mut resume_session_id = None;
    let mut control_overlay = None;
    let previous = {
        let mut runtimes = state.structured.lock().await;
        remove_task_runtime(&mut *runtimes, task_id)
    };
    if let Some(previous) = previous {
        let same_provider = previous
            .binding
            .lock()
            .expect("binding lock")
            .as_ref()
            .is_some_and(|binding| binding.task_id == task_id && binding.provider == provider);
        if same_provider && saved_resume.is_some() {
            resume_session_id = previous.session_ref.lock().expect("session lock").clone();
            control_overlay = previous.control_overlay.clone();
        }
        let turn = { previous.current_turn.lock().expect("turn lock").clone() };
        if let Some(turn) = turn {
            let _ = previous.client.cancel(&turn).await;
        }
        previous.alive.store(false, Ordering::Release);
        let _ = state.store.expire_process_approvals(&previous.process_id);
    }
    if resume_session_id.is_none()
        && let Some(saved) = saved_resume
    {
        resume_session_id = Some(saved.session_ref);
    }

    let digest =
        if should_load_handoff_digest(resume_session_id.as_deref(), native_action.is_some()) {
            let digest_store = Arc::clone(&state.store);
            tauri::async_runtime::spawn_blocking(move || {
                digest_store.task_handoff_digest(task_id, CONTEXT_PRIMER_OPTIONS)
            })
            .await
            .map_err(|_| worker_error())?
            .map_err(CommandError::from)?
        } else {
            None
        };
    let provider_prompt = provider_wire_prompt(
        &prompt,
        resume_interrupted,
        resume_interrupted
            .filter(|value| *value)
            .and_then(|_| interrupted_at_for_task(&state.store, task_id)),
    );
    let mut handoff_images = Vec::new();
    let mut wire_prompt = if let Some(invocation) = integrator_invocation {
        // Explicit Integrator-skill invocation on a runtime without native
        // loading: the wire carries the bounded skill body; the transcript
        // keeps the `/name` the user typed.
        invocation
    } else if native_action.is_some() {
        // Native slash parsing requires `/name` at byte zero. A resumed
        // Claude session already owns its history; on a first native turn we
        // prefer exact provider semantics over silently de-nativizing it.
        provider_prompt
    } else {
        match (resume_session_id.as_ref(), digest) {
            (Some(_), _) => provider_prompt,
            (None, Some(digest)) => {
                handoff_images = digest.image_paths.clone();
                format_context_primer(&digest, &provider_prompt)
            }
            (None, None) => provider_prompt,
        }
    };

    // Delegation broker injection: each structured turn is a fresh provider
    // session, so the tool preamble and any pending subagent updates ride on
    // every wire prompt while delegation is active.
    let delegation_mode = delegation.as_deref().filter(|mode| *mode != "off");
    let mut mcp_config_path = if matches!(structured_provider, StructuredCliProvider::Claude) {
        let broker = state
            .broker
            .lock()
            .expect("broker lock")
            .clone()
            .ok_or_else(|| CommandError {
                code: "provider-unavailable",
                message: "Integrator local tools are not ready; retry this chat".into(),
            })?;
        Some(
            crate::delegation::write_mcp_config(
                &app,
                &broker,
                "orchestrator",
                &task_id.to_string(),
                delegation.as_deref().unwrap_or("off"),
            )
            .map_err(CommandError::from)?,
        )
    } else {
        None
    };
    if let Some(mode) = delegation_mode {
        let store = Arc::clone(&state.store);
        let mut preface = crate::delegation::orchestrator_preamble(&store, mode);
        if let Some(updates) = crate::delegation::pending_updates_block(&store, task_id) {
            preface.push_str(&updates);
        }
        if native_action.is_none() {
            wire_prompt = format!("{preface}{wire_prompt}");
        }
    }

    // Project the enabled Integrator skills into this turn. The overlay is a
    // per-turn copy under app-data, so a SKILL.md edit mid-turn can never
    // split the guidance the running process already loaded. Claude loads
    // the bundles natively (`--plugin-dir`); Antigravity gets sandbox read
    // access (`--add-dir`) plus a prompt-injected index for auto-triggering.
    let mut plugin_dirs = Vec::new();
    {
        let skills_app = app.clone();
        let skills_store = Arc::clone(&state.store);
        let data_directory = state.data_directory.clone();
        let provider_label = match structured_provider {
            StructuredCliProvider::Claude => "claude",
            StructuredCliProvider::Antigravity => "antigravity",
        };
        let projection = tauri::async_runtime::spawn_blocking(move || {
            let skills = crate::integrator_skills::enabled_skills(&skills_app, &skills_store);
            crate::integrator_skills::write_projection(&data_directory, provider_label, &skills)
        })
        .await
        .map_err(|_| worker_error())?;
        if let Ok(projection) = projection {
            plugin_dirs = projection.plugin_dirs;
            if matches!(structured_provider, StructuredCliProvider::Antigravity)
                && native_action.is_none()
                && let Some(index) =
                    crate::integrator_skills::skill_index_block(&projection.entries)
            {
                wire_prompt = format!("{index}{wire_prompt}");
            }
        }
    }

    let mcp_app = app.clone();
    let mcp_store = Arc::clone(&state.store);
    let enabled_mcp_servers = tauri::async_runtime::spawn_blocking(move || {
        crate::integrator_mcp::enabled_servers(&mcp_app, &mcp_store)
    })
    .await
    .map_err(|_| worker_error())?;

    // Claude reads a per-turn `--mcp-config`, merged with the broker config so
    // both local surfaces share one provider-owned configuration input.
    if matches!(structured_provider, StructuredCliProvider::Claude) {
        let data_directory = state.data_directory.clone();
        let base_config = mcp_config_path.clone();
        let servers = enabled_mcp_servers.clone();
        let projected = tauri::async_runtime::spawn_blocking(move || {
            crate::integrator_mcp::write_claude_mcp_config(
                &data_directory,
                &servers,
                base_config.as_deref(),
            )
        })
        .await
        .map_err(|_| worker_error())?;
        match projected {
            Ok(Some(path)) => mcp_config_path = Some(path),
            Ok(None) => {}
            Err(error) => {
                return Err(CommandError {
                    code: "unavailable",
                    message: format!("could not prepare Claude MCP configuration: {error}"),
                });
            }
        }
    }

    let client = integrator_runtime::StructuredCliClient::new();
    let process_id = uuid::Uuid::new_v4().to_string();
    let mut hook_event_log = None;
    if matches!(structured_provider, StructuredCliProvider::Antigravity) {
        let scope = control_overlay
            .as_deref()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .unwrap_or(&process_id);
        let overlay = crate::antigravity_hooks::create_overlay(
            &state.data_directory,
            &repository,
            scope,
            permission_mode,
        )
        .map_err(CommandError::from)?;
        let overlay_root = overlay.root.clone();
        let servers = enabled_mcp_servers.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::integrator_mcp::write_antigravity_mcp_config(&overlay_root, &servers)
        })
        .await
        .map_err(|_| worker_error())?
        .map_err(|error| CommandError {
            code: "unavailable",
            message: format!("could not prepare Antigravity MCP configuration: {error}"),
        })?;
        control_overlay = Some(overlay.root);
        hook_event_log = Some(overlay.event_log);
    }
    let hook_offset = hook_event_log
        .as_deref()
        .map(crate::antigravity_hooks::event_log_offset)
        .unwrap_or(0);
    // Thread ids must pass the projection store's identity charset
    // (alphanumeric plus `-`, `_`, `.`), so no `:` separators here.
    let thread_id = format!("structured.{}.{}", provider.as_str(), uuid::Uuid::new_v4());
    let store = Arc::clone(&state.store);
    let stored_process = process_id.clone();
    let stored_thread = thread_id.clone();
    let stored_provider = provider;
    let binding = tauri::async_runtime::spawn_blocking(move || {
        let binding = store.create_runtime_binding(task_id, &stored_process, stored_provider)?;
        store.attach_provider_thread(&binding, &stored_thread)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(CommandError::from)?;
    let runtime = StructuredRuntime {
        client: client.clone(),
        process_id,
        alive: Arc::new(AtomicBool::new(true)),
        binding: Arc::new(std::sync::Mutex::new(Some(binding.clone()))),
        current_turn: Arc::new(std::sync::Mutex::new(None)),
        last_diagnostic: Arc::new(std::sync::Mutex::new(None)),
        permission_requests: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        session_ref: Arc::new(std::sync::Mutex::new(resume_session_id.clone())),
        control_overlay: control_overlay.clone(),
        hook_event_log: hook_event_log.clone(),
        resume_context: Some(StructuredResumeContext {
            repository: repository.clone(),
            permission: permission.clone(),
            delegation: delegation.clone().unwrap_or_else(|| "off".into()),
        }),
    };
    spawn_structured_cli_pump(app.clone(), Arc::clone(&state.store), runtime.clone());
    let turn_id = client
        .start_turn_with_images(
            StructuredCliLaunchOptions {
                provider: structured_provider,
                executable,
                working_directory: repository,
                model: model.filter(|value| value != "Provider default"),
                effort: effort.filter(|value| !value.is_empty()),
                system_instructions: matches!(structured_provider, StructuredCliProvider::Claude)
                    .then(|| {
                        crate::harness_prompt::instructions(
                            provider,
                            crate::harness_prompt::LocalToolsProjection::Projected,
                        )
                    }),
                resume_session_id,
                permission_mode,
                mcp_config_path,
                control_overlay,
                plugin_dirs,
            },
            wire_prompt,
            handoff_images,
        )
        .await
        .map_err(CommandError::from)?;
    *runtime.current_turn.lock().expect("turn lock") = Some(turn_id.clone());
    if let Some(event_log) = hook_event_log {
        crate::antigravity_hooks::watch_events(
            event_log,
            hook_offset,
            client.clone(),
            turn_id.clone(),
            Arc::clone(&runtime.alive),
        );
    }
    let now = Utc::now();
    if resume_interrupted != Some(true) {
        apply_and_emit(
            &app,
            &state.store,
            &binding,
            &ReducedProviderEvent {
                method: "client/structured/userMessage".into(),
                thread_id: thread_id.clone(),
                turn_id: Some(turn_id.clone()),
                audit_json: "{}".into(),
                audit_truncated: false,
                mutation: ProjectionMutation::NeutralItem(integrator_core::ItemProjection {
                    id: format!("structured:{thread_id}:{turn_id}:user"),
                    provider_item_id: format!("{turn_id}-user"),
                    kind: integrator_core::ItemKind::UserMessage,
                    status: integrator_core::ItemStatus::Completed,
                    title: None,
                    body: Some(integrator_runtime::redact_and_bound(&prompt, 2 * 1024 * 1024).0),
                    phase: None,
                    native_skill,
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
            },
        );
    }
    apply_and_emit(
        &app,
        &state.store,
        &binding,
        &ReducedProviderEvent {
            method: "client/structured/turnStarted".into(),
            thread_id,
            turn_id: Some(turn_id.clone()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::Turn(acp_turn_projection(
                &turn_id,
                TurnStatus::InProgress,
                None,
                now,
                now,
            )),
            occurred_at: now,
        },
    );
    if matches!(structured_provider, StructuredCliProvider::Claude) {
        // Surface the launch permission mode so the composer reflects the
        // session's mode before any status update arrives.
        let mode_id = match permission_mode {
            StructuredPermissionMode::Prompt => "default",
            StructuredPermissionMode::ReadOnly => "plan",
            StructuredPermissionMode::AcceptEdits => "acceptEdits",
            StructuredPermissionMode::BypassPermissions => "bypassPermissions",
        };
        apply_and_emit(
            &app,
            &state.store,
            &binding,
            &ReducedProviderEvent {
                method: "client/structured/permissionMode".into(),
                thread_id: binding.thread_id.clone().unwrap_or_default(),
                turn_id: Some(turn_id.clone()),
                audit_json: "{}".into(),
                audit_truncated: false,
                mutation: ProjectionMutation::Mode(claude_mode_projection(mode_id)),
                occurred_at: now,
            },
        );
    }
    {
        let mut runtimes = state.structured.lock().await;
        replace_task_runtime(&mut *runtimes, task_id, runtime);
    }
    Ok(serde_json::json!({ "turnId": turn_id }))
}

fn structured_provider(provider: &ProviderKind) -> CommandResult<StructuredCliProvider> {
    match provider {
        ProviderKind::Claude => Ok(StructuredCliProvider::Claude),
        ProviderKind::Antigravity => Ok(StructuredCliProvider::Antigravity),
        _ => Err(CommandError {
            code: "provider-unavailable",
            message: format!("{} has no structured CLI route", provider.as_str()),
        }),
    }
}

pub(crate) fn spawn_structured_cli_pump(
    app: AppHandle<tauri::Wry>,
    store: Arc<LocalStore>,
    runtime: StructuredRuntime,
) {
    let mut receiver = runtime.client.subscribe();
    tauri::async_runtime::spawn(async move {
        // Claude can emit text -> tool -> text within one turn. Keep each
        // post-tool text segment in a distinct projected item so the renderer
        // can place one activity stack between the two text blocks.
        let mut agent_segment: u32 = 0;
        let mut segment_has_text = false;
        let mut had_denied_tool = false;
        let mut segment_turn = String::new();
        loop {
            let event = match receiver.recv().await {
                Ok(event) => event,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    // Lagged is recoverable: recv resumes from the oldest
                    // retained event. The turn's terminal Result/Exited events
                    // are the newest in the ring and cannot have been evicted
                    // (nothing is sent after them until this pump settles the
                    // turn), so keep consuming — the turn still completes and
                    // settles normally. Cancelling here killed healthy turns
                    // whenever persistence briefly fell behind a delta burst;
                    // the only true loss is the skipped mid-turn deltas, which
                    // the gap notice below reports.
                    structured_connection_event(
                        &app,
                        &store,
                        &runtime,
                        "client/receiverLagged",
                        ConnectionState::Gap,
                        Some(&format!(
                            "activity stream dropped {skipped} events; some streamed content may be missing from the transcript"
                        )),
                    );
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    structured_connection_event(
                        &app,
                        &store,
                        &runtime,
                        "client/receiverClosed",
                        ConnectionState::Disconnected,
                        Some("activity stream closed"),
                    );
                    break;
                }
            };
            let Some(binding) = runtime.binding.lock().expect("binding lock").clone() else {
                continue;
            };
            let Some(thread_id) = binding.thread_id.clone() else {
                continue;
            };
            if let Some(session_id) = event.session_id.as_ref() {
                let changed = {
                    let mut current = runtime.session_ref.lock().expect("session lock");
                    let changed = current.as_deref() != Some(session_id);
                    *current = Some(session_id.clone());
                    changed
                };
                if changed
                    && let Some(context) = runtime.resume_context.as_ref()
                    && let Err(error) = persist_provider_resume_state(
                        &store,
                        binding.task_id,
                        binding.provider,
                        session_id,
                        &context.repository,
                        &context.permission,
                        &context.delegation,
                    )
                {
                    structured_connection_event(
                        &app,
                        &store,
                        &runtime,
                        "client/resumeStatePersistFailed",
                        ConnectionState::Gap,
                        Some(&format!(
                            "session recovery state could not be saved: {error}"
                        )),
                    );
                }
            }
            let now = Utc::now();
            if segment_turn != event.turn_id {
                segment_turn = event.turn_id.clone();
                agent_segment = 0;
                segment_has_text = false;
                had_denied_tool = false;
            }
            if matches!(
                &event.event,
                StructuredCliEventKind::ToolUse { .. }
                    | StructuredCliEventKind::ToolResult { .. }
                    | StructuredCliEventKind::ToolDenied { .. }
                    | StructuredCliEventKind::PermissionRequest { .. }
            ) && segment_has_text
            {
                agent_segment += 1;
                segment_has_text = false;
            }
            let mutation = match event.event {
                StructuredCliEventKind::Init { .. } => None,
                StructuredCliEventKind::Text { text, delta } => Some(if delta {
                    segment_has_text = true;
                    ProjectionMutation::AppendItem {
                        provider_item_id: format!("{}-agent-{agent_segment}", event.turn_id),
                        item_kind: integrator_core::ItemKind::AgentMessage,
                        field: integrator_runtime::ItemTextField::Body,
                        delta: integrator_runtime::redact_and_bound(&text, 2 * 1024 * 1024).0,
                        updated_at: now,
                    }
                } else {
                    ProjectionMutation::ReplaceItem(structured_item(
                        &thread_id,
                        &event.turn_id,
                        &format!("{}-agent-{agent_segment}", event.turn_id),
                        integrator_core::ItemKind::AgentMessage,
                        None,
                        Some(text),
                        None,
                        None,
                        integrator_core::ItemStatus::Completed,
                        now,
                    ))
                }),
                StructuredCliEventKind::ToolUse { id, name, input } => {
                    Some(ProjectionMutation::ReplaceItem(structured_item(
                        &thread_id,
                        &event.turn_id,
                        &id,
                        integrator_core::ItemKind::McpTool,
                        Some(name),
                        None,
                        None,
                        structured_json_detail(&input),
                        integrator_core::ItemStatus::InProgress,
                        now,
                    )))
                }
                StructuredCliEventKind::ToolResult {
                    id,
                    is_error,
                    content,
                } => Some(ProjectionMutation::MergeItem(structured_item(
                    &thread_id,
                    &event.turn_id,
                    &id,
                    integrator_core::ItemKind::McpTool,
                    None,
                    None,
                    Some(content),
                    None,
                    if is_error {
                        integrator_core::ItemStatus::Failed
                    } else {
                        integrator_core::ItemStatus::Completed
                    },
                    now,
                ))),
                StructuredCliEventKind::ToolDenied { id, content } => {
                    had_denied_tool = true;
                    Some(ProjectionMutation::MergeItem(structured_item(
                        &thread_id,
                        &event.turn_id,
                        &id,
                        integrator_core::ItemKind::McpTool,
                        None,
                        None,
                        Some(content),
                        None,
                        integrator_core::ItemStatus::Declined,
                        now,
                    )))
                }
                StructuredCliEventKind::Result {
                    success,
                    message,
                    usage,
                } => {
                    // Per-turn usage accumulates onto the task projection so
                    // the per-provider summary reflects vendor-reported
                    // numbers instead of staying "unavailable".
                    if let Some(delta) = structured_usage_delta(&usage) {
                        apply_and_emit(
                            &app,
                            &store,
                            &binding,
                            &ReducedProviderEvent {
                                method: "provider/structured/event".into(),
                                thread_id: thread_id.clone(),
                                turn_id: Some(event.turn_id.clone()),
                                audit_json: "{}".into(),
                                audit_truncated: false,
                                mutation: ProjectionMutation::UsageDelta(delta),
                                occurred_at: now,
                            },
                        );
                    }
                    let status = structured_result_status(
                        binding.provider,
                        success,
                        had_denied_tool,
                        segment_has_text,
                    );
                    let recovered_denial = status == TurnStatus::Completed && !success;
                    Some(ProjectionMutation::Turn(acp_turn_projection(
                        &event.turn_id,
                        status,
                        if recovered_denial { None } else { message },
                        now,
                        now,
                    )))
                }
                StructuredCliEventKind::PermissionRequest {
                    request_id,
                    tool_use_id,
                    tool_name,
                    input,
                    description,
                    suggestions,
                } => {
                    let command = input
                        .get("command")
                        .and_then(Value::as_str)
                        .map(|text| integrator_runtime::redact_and_bound(text, 64 * 1024).0);
                    let file_tool = matches!(
                        tool_name.as_str(),
                        "Edit" | "Write" | "MultiEdit" | "NotebookEdit"
                    );
                    // ExitPlanMode is Claude's plan-approval gate: the tool
                    // input carries the finished plan, and allowing the tool
                    // exits plan mode so implementation can start.
                    let plan_review = tool_name == "ExitPlanMode";
                    let plan_markdown = plan_review
                        .then(|| input.get("plan").and_then(Value::as_str))
                        .flatten()
                        .map(|text| integrator_runtime::redact_and_bound(text, 256 * 1024).0);
                    // The CLI sends no suggestions with ExitPlanMode; synthesize
                    // the session-scoped acceptEdits switch so "allow for
                    // session" approves the plan and auto-accepts the edits
                    // that implement it.
                    let suggestions = if plan_review
                        && suggestions.as_array().is_none_or(|list| list.is_empty())
                    {
                        serde_json::json!([
                            { "type": "setMode", "mode": "acceptEdits", "destination": "session" }
                        ])
                    } else {
                        suggestions
                    };
                    runtime
                        .permission_requests
                        .lock()
                        .expect("permission lock")
                        .insert(
                            request_id.clone(),
                            PendingStructuredPermission { input, suggestions },
                        );
                    Some(ProjectionMutation::ApprovalRequested {
                        request_id: integrator_core::TransportRequestId::String(request_id),
                        approval_kind: if plan_review {
                            ApprovalKind::PlanReview
                        } else if file_tool {
                            ApprovalKind::FileChange
                        } else {
                            ApprovalKind::CommandExecution
                        },
                        item_id: tool_use_id,
                        approval_id: None,
                        reason: Some(if plan_review {
                            "The agent finished planning and wants to start implementing.".into()
                        } else {
                            description
                                .filter(|text| !text.is_empty())
                                .unwrap_or_else(|| format!("Use the {tool_name} tool"))
                        }),
                        command,
                        cwd: None,
                        plan_markdown,
                    })
                }
                StructuredCliEventKind::PermissionModeChanged { mode } => {
                    Some(ProjectionMutation::Mode(claude_mode_projection(&mode)))
                }
                StructuredCliEventKind::Diagnostic { message } => {
                    *runtime.last_diagnostic.lock().expect("diagnostic lock") = Some(message);
                    None
                }
                StructuredCliEventKind::Exited { code, cancelled } => {
                    runtime.alive.store(false, Ordering::Release);
                    let diagnostic = runtime
                        .last_diagnostic
                        .lock()
                        .expect("diagnostic lock")
                        .take();
                    *runtime.current_turn.lock().expect("turn lock") = None;
                    // Requests can no longer be answered once the process is
                    // gone; expire them so the UI drops stale popups.
                    runtime
                        .permission_requests
                        .lock()
                        .expect("permission lock")
                        .clear();
                    let _ = store.expire_process_approvals(&runtime.process_id);
                    Some(ProjectionMutation::Turn(acp_turn_projection(
                        &event.turn_id,
                        if cancelled {
                            TurnStatus::Interrupted
                        } else if code == Some(0) {
                            TurnStatus::Completed
                        } else {
                            TurnStatus::Failed
                        },
                        diagnostic,
                        now,
                        now,
                    )))
                }
            };
            if let Some(mutation) = mutation {
                apply_and_emit(
                    &app,
                    &store,
                    &binding,
                    &ReducedProviderEvent {
                        method: "provider/structured/event".into(),
                        thread_id,
                        turn_id: Some(event.turn_id),
                        audit_json: "{}".into(),
                        audit_truncated: false,
                        mutation,
                        occurred_at: now,
                    },
                );
            }
        }
        runtime.alive.store(false, Ordering::Release);
    });
}

fn structured_result_status(
    provider: ProviderKind,
    success: bool,
    had_denied_tool: bool,
    has_answer_text: bool,
) -> TurnStatus {
    if success || (provider == ProviderKind::Antigravity && had_denied_tool && has_answer_text) {
        TurnStatus::Completed
    } else {
        TurnStatus::Failed
    }
}

fn structured_connection_event(
    app: &AppHandle<tauri::Wry>,
    store: &LocalStore,
    runtime: &StructuredRuntime,
    method: &str,
    connection: ConnectionState,
    reason: Option<&str>,
) {
    let Some(binding) = runtime.binding.lock().expect("binding lock").clone() else {
        return;
    };
    let Some(thread_id) = binding.thread_id.clone() else {
        return;
    };
    let reduced = reduce_connection_event(method, &thread_id, connection, reason, Utc::now());
    apply_and_emit(app, store, &binding, &reduced);
}

/// Claude's permission modes as a canonical mode projection. The vocabulary
/// is fixed by the CLI (`--permission-mode`), so unlike ACP agents the
/// available list is synthesized rather than advertised. The CLI reports the
/// launch flag's `manual` back as `default`; both map to the same mode.
pub(crate) fn claude_mode_projection(current: &str) -> ModeProjection {
    let current = if current == "manual" {
        "default"
    } else {
        current
    };
    let mut available = vec![
        ModeOption {
            id: "plan".into(),
            name: "Plan".into(),
            description: Some("Read-only planning; implementation waits for plan approval".into()),
        },
        ModeOption {
            id: "default".into(),
            name: "Ask".into(),
            description: Some("Prompt for approval before edits and commands".into()),
        },
        ModeOption {
            id: "acceptEdits".into(),
            name: "Accept edits".into(),
            description: Some("Auto-accept file edits; still ask for commands".into()),
        },
        ModeOption {
            id: "bypassPermissions".into(),
            name: "Bypass permissions".into(),
            description: Some("Run without permission prompts".into()),
        },
    ];
    if !available.iter().any(|mode| mode.id == current) {
        available.push(ModeOption {
            id: current.into(),
            name: current.into(),
            description: None,
        });
    }
    ModeProjection {
        current_mode_id: current.into(),
        available_modes: available,
    }
}

/// Maps a structured CLI turn's usage onto an accumulating projection delta.
/// Cache-creation tokens are billed as input, so they fold into
/// `input_tokens`; when the provider omits a grand total (Claude does) it is
/// derived from the parts so the summary's "vendor reported" check still
/// fires. Returns `None` when the turn carried no usage at all (e.g. a
/// resume handshake) so an empty delta never overwrites provenance.
fn structured_usage_delta(usage: &StructuredUsage) -> Option<integrator_core::UsageProjection> {
    let input = usage
        .input_tokens
        .unwrap_or(0)
        .saturating_add(usage.cache_creation_input_tokens.unwrap_or(0));
    let cached = usage.cached_input_tokens.unwrap_or(0);
    let output = usage.output_tokens.unwrap_or(0);
    let reasoning = usage.reasoning_output_tokens.unwrap_or(0);
    let total = usage.total_tokens.unwrap_or_else(|| {
        input
            .saturating_add(cached)
            .saturating_add(output)
            .saturating_add(reasoning)
    });
    if total == 0 && usage.cost_micro_usd.is_none() {
        return None;
    }
    Some(integrator_core::UsageProjection {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: total,
        model_context_window: None,
        vendor_cost_micro_usd: usage.cost_micro_usd,
    })
}

#[allow(clippy::too_many_arguments)]
fn structured_item(
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
    kind: integrator_core::ItemKind,
    title: Option<String>,
    body: Option<String>,
    output: Option<String>,
    tool_input: Option<String>,
    status: integrator_core::ItemStatus,
    updated_at: DateTime<Utc>,
) -> integrator_core::ItemProjection {
    integrator_core::ItemProjection {
        id: format!("structured:{thread_id}:{turn_id}:{item_id}"),
        provider_item_id: item_id.to_owned(),
        kind,
        status,
        title: title.map(|value| integrator_runtime::redact_and_bound(&value, 64 * 1024).0),
        body: body.map(|value| integrator_runtime::redact_and_bound(&value, 2 * 1024 * 1024).0),
        native_skill: None,
        phase: None,
        command: None,
        cwd: None,
        output: output.map(|value| integrator_runtime::redact_and_bound(&value, 2 * 1024 * 1024).0),
        exit_code: None,
        file_changes: None,
        mcp_server: None,
        mcp_tool: None,
        tool_input: tool_input
            .map(|value| integrator_runtime::redact_and_bound(&value, 256 * 1024).0),
        truncated: false,
        updated_at,
    }
}

fn structured_json_detail(value: &Value) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let text = serde_json::to_string_pretty(value).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(integrator_runtime::redact_and_bound(trimmed, 256 * 1024).0)
}

/// Forwards ACP agent events through the ACP reducer into SQLite and the
/// renderer, mirroring the Codex pump.
pub(crate) fn spawn_acp_pump(
    app: AppHandle<tauri::Wry>,
    store: Arc<LocalStore>,
    runtime: AcpRuntime,
) {
    let mut receiver = runtime.client.subscribe();
    tauri::async_runtime::spawn(async move {
        // Assistant text segmentation: whenever a tool call lands after text
        // has streamed, later chunks open a new transcript item so the reply
        // interleaves with tool activity in wire order.
        let mut agent_segment: u32 = 0;
        let mut segment_has_text = false;
        let mut segment_turn: Option<String> = None;
        loop {
            let event = match receiver.recv().await {
                Ok(event) => event,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    if runtime.replaying_history.swap(true, Ordering::AcqRel) {
                        runtime.replaying_history.store(false, Ordering::Release);
                        runtime.alive.store(false, Ordering::Release);
                        acp_connection_event(
                            &app,
                            &store,
                            &runtime,
                            "client/recoveryLagged",
                            ConnectionState::Disconnected,
                            Some("provider history replay also overflowed"),
                        );
                        settle_interrupted_turn(
                            &app,
                            &store,
                            runtime
                                .binding
                                .lock()
                                .expect("binding lock")
                                .as_ref()
                                .map(|binding| binding.task_id),
                        );
                    } else {
                        begin_acp_reconciliation(
                            app.clone(),
                            Arc::clone(&store),
                            runtime.clone(),
                            "event stream lagged",
                        );
                    }
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            let binding = runtime.binding.lock().expect("binding lock").clone();
            let turn_id = runtime.current_turn.lock().expect("turn lock").clone();
            match event {
                adapter_acp::AcpEvent::Notification { method, params } => {
                    if method != "session/update" {
                        continue;
                    }
                    if let Some(actions) = params.get("update").and_then(parse_acp_actions) {
                        *runtime.available_actions.lock().expect("action lock") = actions;
                        let _ = app.emit(
                            "provider://native-actions-changed",
                            serde_json::json!({ "provider": runtime.provider.as_str() }),
                        );
                        continue;
                    }
                    let Some(binding) = binding.as_ref() else {
                        continue;
                    };
                    let Some(session_id) = binding.thread_id.as_deref() else {
                        continue;
                    };
                    if params.get("sessionId").and_then(Value::as_str) != Some(session_id) {
                        continue;
                    }
                    let Some(update) = params.get("update") else {
                        continue;
                    };
                    if runtime.replaying_history.load(Ordering::Acquire) {
                        let kind = update
                            .get("sessionUpdate")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if matches!(kind, "tool_call" | "tool_call_update")
                            && let Some(tool_call_id) =
                                update.get("toolCallId").and_then(Value::as_str)
                            && let Ok(Some(original_turn)) = store.turn_for_provider_item(
                                binding.task_id,
                                binding.provider,
                                tool_call_id,
                            )
                            && let Ok(Some(reduced)) =
                                reduce_acp_update(session_id, &original_turn, 0, update, Utc::now())
                        {
                            apply_and_emit(&app, &store, binding, &reduced);
                        }
                        continue;
                    }
                    // Mode changes are session metadata and can land between
                    // turns (e.g. a set_mode echo), so they are handled before
                    // the in-flight-turn guard below.
                    if update.get("sessionUpdate").and_then(Value::as_str)
                        == Some("current_mode_update")
                    {
                        let Some(current) = update.get("currentModeId").and_then(Value::as_str)
                        else {
                            continue;
                        };
                        let mode = {
                            let mut modes = runtime.session_modes.lock().expect("modes lock");
                            let Some(state) = modes.as_mut() else {
                                continue;
                            };
                            state.current_mode_id = current.to_owned();
                            state.clone()
                        };
                        let event =
                            acp_mode_event(session_id, turn_id.as_deref(), mode, Utc::now());
                        apply_and_emit(&app, &store, binding, &event);
                        continue;
                    }
                    let Some(turn_id) = turn_id.as_deref() else {
                        continue;
                    };
                    if segment_turn.as_deref() != Some(turn_id) {
                        segment_turn = Some(turn_id.to_owned());
                        agent_segment = 0;
                        segment_has_text = false;
                    }
                    match update.get("sessionUpdate").and_then(Value::as_str) {
                        Some("agent_message_chunk") => segment_has_text = true,
                        Some("tool_call") if segment_has_text => {
                            agent_segment += 1;
                            segment_has_text = false;
                        }
                        _ => {}
                    }
                    if let Ok(Some(reduced)) =
                        reduce_acp_update(session_id, turn_id, agent_segment, update, Utc::now())
                    {
                        apply_and_emit(&app, &store, binding, &reduced);
                    }
                }
                adapter_acp::AcpEvent::ServerRequest { id, method, params } => {
                    // Delegated children run unattended: resolve blocking
                    // server requests immediately (allow inside the already
                    // trusted worktree, accept plan reviews) instead of
                    // parking an approval card no one is watching. This is
                    // the ACP analog of Codex children's approval "never".
                    if runtime.unattended {
                        let result = if method == "session/request_permission" {
                            if runtime.read_only {
                                serde_json::json!({ "outcome": { "outcome": "cancelled" } })
                            } else {
                                acp_auto_allow_outcome(&params)
                            }
                        } else if method == "cursor/create_plan" {
                            if runtime.read_only {
                                serde_json::json!({ "result": { "error": { "error": "This delegated child is read-only." } } })
                            } else {
                                serde_json::json!({ "result": { "success": {} } })
                            }
                        } else {
                            serde_json::json!({ "error": "unsupported" })
                        };
                        let _ = runtime.client.respond_to_server_request(&id, result).await;
                        continue;
                    }
                    // Cursor's plan-review extension: the agent blocks until
                    // the client accepts or rejects the finished plan. It is
                    // surfaced as a plan-review approval; the response shape
                    // is resolved in `codex_respond_approval`.
                    if method == "cursor/create_plan" {
                        let (Some(binding), Some(turn_id)) = (binding.as_ref(), turn_id.as_deref())
                        else {
                            let _ = runtime
                                .client
                                .respond_to_server_request(
                                    &id,
                                    serde_json::json!({ "result": { "success": {} } }),
                                )
                                .await;
                            continue;
                        };
                        let Some(session_id) = binding.thread_id.as_deref() else {
                            continue;
                        };
                        let request_id = acp_transport_id(&id);
                        runtime
                            .plan_requests
                            .lock()
                            .expect("plan lock")
                            .insert(transport_key(&request_id));
                        let reduced = reduce_acp_plan_review_request(
                            session_id,
                            turn_id,
                            request_id,
                            &params,
                            Utc::now(),
                        );
                        apply_and_emit(&app, &store, binding, &reduced);
                        continue;
                    }
                    if method != "session/request_permission" {
                        // Unsupported client capability; refuse politely.
                        let _ = runtime
                            .client
                            .respond_to_server_request(
                                &id,
                                serde_json::json!({ "error": "unsupported" }),
                            )
                            .await;
                        continue;
                    }
                    let (Some(binding), Some(turn_id)) = (binding.as_ref(), turn_id.as_deref())
                    else {
                        continue;
                    };
                    let Some(session_id) = binding.thread_id.as_deref() else {
                        continue;
                    };
                    let request_id = acp_transport_id(&id);
                    let options = params
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|options| {
                            options
                                .iter()
                                .filter_map(|option| {
                                    Some(AcpPermissionOption {
                                        option_id: option
                                            .get("optionId")
                                            .and_then(Value::as_str)?
                                            .to_owned(),
                                        kind: option
                                            .get("kind")
                                            .and_then(Value::as_str)
                                            .unwrap_or_default()
                                            .to_owned(),
                                    })
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    runtime
                        .permission_options
                        .lock()
                        .expect("permission lock")
                        .insert(transport_key(&request_id), options);
                    let reduced = reduce_acp_permission_request(
                        session_id,
                        turn_id,
                        request_id,
                        &params,
                        Utc::now(),
                    );
                    apply_and_emit(&app, &store, binding, &reduced);
                }
                adapter_acp::AcpEvent::PromptFinished {
                    session_id,
                    outcome,
                } => {
                    let Some(binding) = binding.as_ref() else {
                        continue;
                    };
                    if binding.thread_id.as_deref() != Some(session_id.as_str()) {
                        continue;
                    }
                    let Some(turn_id) = runtime.current_turn.lock().expect("turn lock").take()
                    else {
                        continue;
                    };
                    let now = Utc::now();
                    let started_at = runtime
                        .current_turn_started_at
                        .lock()
                        .expect("turn start lock")
                        .take()
                        .unwrap_or(now);
                    let (status, error, failed) = match outcome {
                        adapter_acp::AcpPromptOutcome::Response {
                            stop_reason: adapter_acp::StopReason::Cancelled,
                        } => (TurnStatus::Interrupted, None, false),
                        adapter_acp::AcpPromptOutcome::Response {
                            stop_reason: adapter_acp::StopReason::Refusal,
                        } => (
                            TurnStatus::Failed,
                            Some("The agent refused the turn".into()),
                            true,
                        ),
                        adapter_acp::AcpPromptOutcome::Response { .. } => {
                            (TurnStatus::Completed, None, false)
                        }
                        adapter_acp::AcpPromptOutcome::Error { message } => {
                            (TurnStatus::Failed, Some(message), true)
                        }
                    };
                    let mut turn = acp_turn_projection(&turn_id, status, error, started_at, now);
                    turn.stop_requested = false;
                    let finished = ReducedProviderEvent {
                        method: if runtime.unattended {
                            "client/delegation/turnFinished".into()
                        } else {
                            "client/acp/turnFinished".into()
                        },
                        thread_id: session_id,
                        turn_id: Some(turn_id),
                        audit_json: "{}".into(),
                        audit_truncated: false,
                        mutation: ProjectionMutation::Turn(turn),
                        occurred_at: now,
                    };
                    apply_and_emit(&app, &store, binding, &finished);
                    let _ = runtime.turn_settled.send(AcpTurnSettlement { failed });
                }
                adapter_acp::AcpEvent::ProtocolViolation { code } => {
                    if !runtime.replaying_history.swap(true, Ordering::AcqRel) {
                        begin_acp_reconciliation(
                            app.clone(),
                            Arc::clone(&store),
                            runtime.clone(),
                            &code,
                        );
                    }
                }
                adapter_acp::AcpEvent::RecoveryBoundary { replayed_history } => {
                    if !runtime.replaying_history.swap(false, Ordering::AcqRel) {
                        continue;
                    }
                    acp_connection_event(
                        &app,
                        &store,
                        &runtime,
                        "client/sessionRecovered",
                        ConnectionState::Connected,
                        Some(if replayed_history {
                            "provider history restored"
                        } else {
                            "provider session resumed"
                        }),
                    );
                }
                adapter_acp::AcpEvent::StderrActivity => {}
                adapter_acp::AcpEvent::Exited => {
                    let _ = store.expire_process_approvals(&runtime.process_id);
                    acp_connection_event(
                        &app,
                        &store,
                        &runtime,
                        "provider/exited",
                        ConnectionState::Disconnected,
                        Some(&format!("{} agent exited", runtime.provider.as_str())),
                    );
                    break;
                }
            }
        }
        runtime.alive.store(false, Ordering::Release);
    });
}

fn begin_acp_reconciliation(
    app: AppHandle<tauri::Wry>,
    store: Arc<LocalStore>,
    runtime: AcpRuntime,
    reason: &str,
) {
    acp_connection_event(
        &app,
        &store,
        &runtime,
        "client/sessionReconciling",
        ConnectionState::Reconciling,
        Some(reason),
    );
    tauri::async_runtime::spawn(async move {
        let binding = runtime.binding.lock().expect("binding lock").clone();
        let spec = runtime
            .session_spec
            .lock()
            .expect("session spec lock")
            .clone();
        let can_load = runtime.client.session_capabilities().await.load;
        let result = match (binding.as_ref(), spec) {
            (Some(binding), Some(spec)) => match binding.thread_id.as_deref() {
                Some(session_id) if can_load => {
                    let _ = runtime.client.cancel(session_id).await;
                    timeout(
                        Duration::from_secs(15),
                        runtime
                            .client
                            .load_session(session_id, &spec.cwd, spec.mcp_servers),
                    )
                    .await
                    .map_err(|_| {
                        IntegratorError::Unavailable("ACP history recovery timed out".into())
                    })
                    .and_then(std::convert::identity)
                }
                Some(_) => Err(IntegratorError::Unavailable(format!(
                    "{} did not advertise session/load for authoritative recovery",
                    runtime.provider.as_str()
                ))),
                None => Err(IntegratorError::Unavailable(
                    "ACP session identity is unavailable".into(),
                )),
            },
            _ => Err(IntegratorError::Unavailable(
                "ACP session recovery parameters are unavailable".into(),
            )),
        };
        if let Err(error) = result {
            runtime.replaying_history.store(false, Ordering::Release);
            runtime.alive.store(false, Ordering::Release);
            acp_connection_event(
                &app,
                &store,
                &runtime,
                "client/sessionReconcileFailed",
                ConnectionState::Disconnected,
                Some(&error.to_string()),
            );
            settle_interrupted_turn(
                &app,
                &store,
                binding.as_ref().map(|binding| binding.task_id),
            );
        }
    });
}

fn acp_connection_event(
    app: &AppHandle<tauri::Wry>,
    store: &LocalStore,
    runtime: &AcpRuntime,
    method: &str,
    connection: ConnectionState,
    reason: Option<&str>,
) {
    let Some(binding) = runtime.binding.lock().expect("binding lock").clone() else {
        return;
    };
    let Some(session_id) = binding.thread_id.clone() else {
        return;
    };
    let reduced = reduce_connection_event(method, &session_id, connection, reason, Utc::now());
    apply_and_emit(app, store, &binding, &reduced);
}

pub(crate) fn apply_and_emit(
    app: &AppHandle<tauri::Wry>,
    store: &LocalStore,
    binding: &RuntimeBinding,
    reduced: &ReducedProviderEvent,
) {
    if let Ok(event) = store.apply_reduced_event(binding, reduced) {
        let _ = app.emit("runtime://projection", &event);
    }
}

fn acp_transport_id(id: &adapter_acp::AcpRequestId) -> TransportRequestId {
    match id.to_protocol_value() {
        Value::Number(number) => TransportRequestId::Number(number),
        Value::String(text) => TransportRequestId::String(text),
        _ => unreachable!("ACP request ids are numbers or strings"),
    }
}

fn acp_request_from_transport(
    id: &TransportRequestId,
) -> Result<adapter_acp::AcpRequestId, CommandError> {
    let value = match id {
        TransportRequestId::Number(number) => Value::Number(number.clone()),
        TransportRequestId::String(text) => Value::String(text.clone()),
    };
    adapter_acp::AcpRequestId::from_protocol_value(&value).map_err(CommandError::from)
}

fn transport_key(id: &TransportRequestId) -> String {
    match id {
        TransportRequestId::Number(number) => format!("n:{number}"),
        TransportRequestId::String(text) => format!("s:{text}"),
    }
}

/// Build the `can_use_tool` control response for a UI approval decision on
/// the structured (stream-json) route. Allow echoes the original tool input;
/// allow-for-session additionally echoes the CLI's own permission
/// suggestions so the vendor persists the rule itself.
fn structured_permission_response(
    decision: ApprovalDecision,
    pending: Option<PendingStructuredPermission>,
) -> Value {
    match decision {
        ApprovalDecision::Accept | ApprovalDecision::AcceptForSession => {
            let mut response = serde_json::json!({ "behavior": "allow" });
            if let Some(pending) = pending {
                if !pending.input.is_null() {
                    response["updatedInput"] = pending.input;
                }
                if matches!(decision, ApprovalDecision::AcceptForSession)
                    && pending
                        .suggestions
                        .as_array()
                        .is_some_and(|s| !s.is_empty())
                {
                    response["updatedPermissions"] = pending.suggestions;
                }
            }
            response
        }
        ApprovalDecision::Decline | ApprovalDecision::Cancel => serde_json::json!({
            "behavior": "deny",
            "message": "The user declined this request.",
        }),
    }
}

/// Build the response for a Cursor `cursor/create_plan` extension request.
/// Success tells the agent the plan was accepted; the error result carries
/// the rejection back so the agent keeps planning instead of building.
/// Select the least-privileged allow option a `session/request_permission`
/// request advertises. Unattended children auto-allow inside the trusted
/// worktree; a request advertising no allow option is cancelled, not guessed.
pub(crate) fn acp_auto_allow_outcome(params: &Value) -> Value {
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let by_kind = |kind: &str| {
        options
            .iter()
            .find(|option| option.get("kind").and_then(Value::as_str) == Some(kind))
    };
    let selected = by_kind("allow_once")
        .or_else(|| by_kind("allow_always"))
        .or_else(|| {
            options.iter().find(|option| {
                option
                    .get("kind")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind.starts_with("allow"))
            })
        });
    match selected.and_then(|option| option.get("optionId").and_then(Value::as_str)) {
        Some(option_id) => serde_json::json!({
            "outcome": { "outcome": "selected", "optionId": option_id }
        }),
        None => serde_json::json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

fn acp_plan_review_result(decision: ApprovalDecision) -> Value {
    match decision {
        ApprovalDecision::Accept | ApprovalDecision::AcceptForSession => {
            serde_json::json!({ "result": { "success": {} } })
        }
        ApprovalDecision::Decline | ApprovalDecision::Cancel => serde_json::json!({
            "result": { "error": { "error": "The user rejected this plan. Stay in plan mode and revise it based on their feedback." } }
        }),
    }
}

/// Map the UI approval decision onto the option set the ACP agent advertised
/// for this request. Options live only as long as the agent process.
fn acp_permission_outcome(
    runtime: &AcpRuntime,
    request_id: &TransportRequestId,
    decision: ApprovalDecision,
) -> Value {
    if matches!(decision, ApprovalDecision::Cancel) {
        return serde_json::json!({ "outcome": { "outcome": "cancelled" } });
    }
    let options = runtime
        .permission_options
        .lock()
        .expect("permission lock")
        .remove(&transport_key(request_id))
        .unwrap_or_default();
    let preferred: &[&str] = match decision {
        ApprovalDecision::Accept => &["allow_once", "allow_always"],
        ApprovalDecision::AcceptForSession => &["allow_always", "allow_once"],
        ApprovalDecision::Decline => &["reject_once", "reject_always"],
        ApprovalDecision::Cancel => &[],
    };
    let selected = preferred
        .iter()
        .find_map(|kind| options.iter().find(|option| option.kind == *kind))
        .or_else(|| {
            let prefix = if matches!(decision, ApprovalDecision::Decline) {
                "reject"
            } else {
                "allow"
            };
            options
                .iter()
                .find(|option| option.kind.starts_with(prefix))
        });
    match selected {
        Some(option) => serde_json::json!({
            "outcome": { "outcome": "selected", "optionId": option.option_id }
        }),
        None => serde_json::json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

async fn acp_runtime(
    state: &State<'_, AppState>,
    task_id: Option<TaskId>,
    provider: Option<ProviderKind>,
) -> CommandResult<AcpRuntime> {
    let runtime = if let Some(task_id) = task_id {
        state.acp.lock().await.get(&task_id).cloned()
    } else if let Some(provider) = provider.as_ref() {
        state.acp_catalog.lock().await.get(provider).cloned()
    } else {
        None
    };
    runtime
        .filter(|runtime| runtime.alive.load(Ordering::Acquire))
        .ok_or_else(|| CommandError {
            code: "provider-disconnected",
            message: provider
                .map(|provider| format!("{} is not connected", provider.as_str()))
                .unwrap_or_else(|| "ACP session is not connected for this task".into()),
        })
}

async fn codex_runtime(
    state: &State<'_, AppState>,
    task_id: Option<TaskId>,
) -> CommandResult<CodexRuntime> {
    let runtime = if let Some(task_id) = task_id {
        state.codex.lock().await.get(&task_id).cloned()
    } else {
        state.codex_catalog.lock().await.clone()
    };
    runtime
        .filter(|runtime| runtime.alive.load(Ordering::Acquire))
        .ok_or_else(|| CommandError {
            code: "provider-disconnected",
            message: "Codex is not connected for this task".into(),
        })
}

async fn codex_runtime_for_thread(
    state: &State<'_, AppState>,
    thread_id: &str,
) -> CommandResult<CodexRuntime> {
    state
        .codex
        .lock()
        .await
        .values()
        .find(|runtime| {
            runtime.alive.load(Ordering::Acquire)
                && runtime
                    .binding
                    .lock()
                    .expect("binding lock")
                    .as_ref()
                    .and_then(|binding| binding.thread_id.as_deref())
                    == Some(thread_id)
        })
        .cloned()
        .ok_or_else(|| CommandError {
            code: "provider-disconnected",
            message: "Codex thread is not connected".into(),
        })
}

async fn codex_runtime_for_process(
    state: &State<'_, AppState>,
    process_id: &str,
) -> CommandResult<CodexRuntime> {
    state
        .codex
        .lock()
        .await
        .values()
        .find(|runtime| runtime.alive.load(Ordering::Acquire) && runtime.process_id == process_id)
        .cloned()
        .ok_or_else(|| CommandError {
            code: "stale-approval",
            message: "approval belongs to an expired provider process".into(),
        })
}

async fn codex_client(
    state: &State<'_, AppState>,
    task_id: Option<TaskId>,
) -> CommandResult<adapter_codex::CodexClient> {
    Ok(codex_runtime(state, task_id).await?.client)
}

fn reconcile_turn_response(
    app: &AppHandle<tauri::Wry>,
    store: &LocalStore,
    runtime: &CodexRuntime,
    thread_id: &str,
    response: &Value,
) {
    let Some(turn) = response.get("turn") else {
        return;
    };
    let binding = runtime.binding.lock().expect("binding lock").clone();
    pump_provider_event(
        app,
        store,
        runtime,
        binding.as_ref(),
        "turn/started".into(),
        serde_json::json!({ "threadId": thread_id, "turn": turn }),
        None,
    );
}

fn reconcile_thread_response(
    app: &AppHandle<tauri::Wry>,
    store: &LocalStore,
    runtime: &CodexRuntime,
    response: &Value,
) {
    let Some(thread) = response.get("thread") else {
        return;
    };
    let Some(thread_id) = thread.get("id").and_then(Value::as_str) else {
        return;
    };
    let binding = runtime.binding.lock().expect("binding lock").clone();
    for turn in thread
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let turn_id = turn.get("id").and_then(Value::as_str).unwrap_or("unknown");
        let turn_in_progress = turn.get("status").and_then(Value::as_str) == Some("inProgress");
        let method = if turn_in_progress {
            "turn/started"
        } else {
            "turn/completed"
        };
        pump_provider_event(
            app,
            store,
            runtime,
            binding.as_ref(),
            method.into(),
            serde_json::json!({ "threadId": thread_id, "turn": turn }),
            None,
        );
        let existing_items = binding
            .as_ref()
            .and_then(|binding| binding.provider_session_id)
            .and_then(|provider_session_id| {
                store.provider_turn_items(provider_session_id, turn_id).ok()
            })
            .unwrap_or_default();
        let mut matched_items = HashSet::new();
        for (ordinal, item) in turn
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let Some(binding) = binding.as_ref() else {
                continue;
            };
            let params = serde_json::json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "item": item
            });
            let Some(mut reduced) = reduce_codex_provider_event(
                runtime,
                binding,
                reconciled_item_method(turn_in_progress, item).into(),
                params,
                None,
            ) else {
                continue;
            };
            reconcile_replayed_item(&existing_items, &mut matched_items, ordinal, &mut reduced);
            persist_codex_provider_event(app, store, binding, &reduced);
        }
    }
}

fn reconciled_item_method(turn_in_progress: bool, item: &Value) -> &'static str {
    match item.get("status").and_then(Value::as_str) {
        Some("completed" | "failed" | "declined") => "item/completed",
        Some("pending" | "inProgress") => "item/started",
        _ if turn_in_progress => "item/started",
        _ => "item/completed",
    }
}

fn reconcile_replayed_item(
    existing_items: &[ItemProjection],
    matched_items: &mut HashSet<String>,
    ordinal: usize,
    reduced: &mut ReducedProviderEvent,
) {
    let incoming = match &mut reduced.mutation {
        ProjectionMutation::ReplaceItem(item)
        | ProjectionMutation::NeutralItem(item)
        | ProjectionMutation::MergeItem(item) => item,
        _ => return,
    };
    let existing = existing_items
        .iter()
        .find(|item| {
            item.provider_item_id == incoming.provider_item_id && !matched_items.contains(&item.id)
        })
        .or_else(|| {
            existing_items
                .get(ordinal)
                .filter(|item| item.kind == incoming.kind && !matched_items.contains(&item.id))
        })
        .or_else(|| {
            existing_items
                .iter()
                .find(|item| item.kind == incoming.kind && !matched_items.contains(&item.id))
        });
    let Some(existing) = existing else {
        return;
    };
    matched_items.insert(existing.id.clone());
    incoming.id = existing.id.clone();
    incoming.provider_item_id = existing.provider_item_id.clone();
    if incoming.kind == ItemKind::UserMessage {
        incoming.body = existing.body.clone();
        incoming.native_skill = existing.native_skill.clone();
    }
    if matches!(
        existing.status,
        ItemStatus::Completed | ItemStatus::Failed | ItemStatus::Declined
    ) && matches!(
        incoming.status,
        ItemStatus::Pending | ItemStatus::InProgress
    ) {
        incoming.status = existing.status.clone();
    }
}

fn extract_thread_id(value: &Value) -> Option<String> {
    value
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .or_else(|| value.get("threadId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

pub(crate) async fn authorized_git(
    state: &State<'_, AppState>,
    repository: PathBuf,
) -> CommandResult<(GitService, RepositoryIdentity)> {
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    let authorization_git = git.clone();
    let store = Arc::clone(&state.store);
    let authorizations = Arc::clone(&state.git_authorizations);
    let identity = tauri::async_runtime::spawn_blocking(move || {
        let mut authorizations = authorizations.lock().expect("git authorization cache lock");
        let projects = store.list_trusted_projects()?;
        authorizations.authorize(&authorization_git, &projects, &repository)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(CommandError::from)?;
    Ok((git, identity))
}

/// Authorize the exact folder the user added, whether or not it currently has
/// Git metadata. Linked worktrees retain the established Git authorization
/// path so existing task/worktree behavior does not broaden silently.
pub(crate) async fn authorized_project_directory(
    state: &State<'_, AppState>,
    candidate: PathBuf,
) -> CommandResult<PathBuf> {
    let selected =
        tauri::async_runtime::spawn_blocking(move || canonical_project_directory(&candidate))
            .await
            .map_err(|_| worker_error())?
            .map_err(CommandError::from)?;
    let store = Arc::clone(&state.store);
    let trusted = selected.clone();
    let exact = tauri::async_runtime::spawn_blocking(move || {
        Ok::<bool, IntegratorError>(store.list_trusted_projects()?.into_iter().any(|project| {
            canonical_project_directory(&project.repository_root).is_ok_and(|root| root == trusted)
        }))
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(CommandError::from)?;
    if exact {
        return Ok(selected);
    }
    let (_, identity) = authorized_git(state, selected).await?;
    Ok(identity.root)
}

async fn authorized_task_directory(
    state: &State<'_, AppState>,
    task_id: TaskId,
    candidate: PathBuf,
) -> CommandResult<PathBuf> {
    let task = state.store.get_task(task_id).map_err(CommandError::from)?;
    let directory = authorized_project_directory(state, candidate).await?;
    let expected = task
        .worktree_path
        .as_ref()
        .or(task.repository_path.as_ref())
        .ok_or_else(|| CommandError {
            code: "invalid-input",
            message: "task has no explicit project/worktree identity".into(),
        })?;
    let expected = canonical_project_directory(expected).map_err(CommandError::from)?;
    if directory != expected {
        return Err(CommandError {
            code: "unauthorized",
            message: "provider working directory does not match this task's project/worktree"
                .into(),
        });
    }
    Ok(directory)
}

fn canonical_project_directory(path: &Path) -> integrator_core::Result<PathBuf> {
    let canonical = dunce::canonicalize(path).map_err(IntegratorError::Io)?;
    if !canonical.is_dir() {
        return Err(IntegratorError::InvalidInput(
            "the selected project must be a directory".into(),
        ));
    }
    Ok(canonical)
}

fn list_project_files(root: &Path) -> integrator_core::Result<Vec<ProjectFileEntry>> {
    let mut files = Vec::new();
    collect_project_files(root, root, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn collect_project_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<ProjectFileEntry>,
) -> integrator_core::Result<()> {
    if files.len() >= MAX_PROJECT_FILE_ENTRIES {
        return Ok(());
    }
    let entries = fs::read_dir(directory).map_err(io_error)?;
    for entry in entries {
        if files.len() >= MAX_PROJECT_FILE_ENTRIES {
            return Ok(());
        }
        let entry = entry.map_err(io_error)?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let file_type = entry.file_type().map_err(io_error)?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            if should_skip_project_directory(&name) {
                continue;
            }
            collect_project_files(root, &path, files)?;
        } else if file_type.is_file() {
            let relative = path.strip_prefix(root).map_err(|_| {
                IntegratorError::Unauthorized("file escaped trusted repository".into())
            })?;
            if is_sensitive_project_file(relative) {
                continue;
            }
            files.push(ProjectFileEntry {
                path: normalized_relative_path(relative),
                size: entry.metadata().map_err(io_error)?.len(),
            });
        }
    }
    Ok(())
}

fn read_project_file(
    root: &Path,
    requested_path: &str,
) -> integrator_core::Result<ProjectFileContent> {
    let relative = validate_project_relative_path(requested_path)?;
    if is_sensitive_project_file(&relative) {
        return Err(IntegratorError::Unauthorized(
            "sensitive project files cannot be previewed".into(),
        ));
    }
    let candidate = root.join(&relative);
    // Keep the same Windows path normalization used by Git authorization. The
    // standard canonicalizer may add a `\\?\` prefix, which would make a valid
    // child path fail the trusted-root containment check below.
    let canonical = dunce::canonicalize(&candidate).map_err(io_error)?;
    if !canonical.starts_with(root) {
        return Err(IntegratorError::Unauthorized(
            "file is outside the trusted repository".into(),
        ));
    }
    let metadata = fs::metadata(&canonical).map_err(io_error)?;
    if !metadata.is_file() {
        return Err(IntegratorError::InvalidInput(
            "requested path is not a file".into(),
        ));
    }
    // Recognized images are previewed inline as data URLs, so they earn the more
    // generous attachment budget rather than the small text-preview limit.
    let image_mime = canonical
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .and_then(|value| image_mime_for_extension(&value));
    let size_limit = if image_mime.is_some() {
        ATTACHMENT_PREVIEW_MAX_BYTES
    } else {
        MAX_PROJECT_FILE_BYTES
    };
    if metadata.len() > size_limit {
        return Err(IntegratorError::Unavailable(format!(
            "file is larger than the {} KB safe preview limit",
            size_limit / 1_000
        )));
    }
    let bytes = fs::read(&canonical).map_err(io_error)?;
    if let Some(mime) = image_mime {
        return Ok(ProjectFileContent {
            path: normalized_relative_path(&relative),
            content: String::new(),
            is_binary: true,
            image_data_url: Some(format!("data:{mime};base64,{}", BASE64.encode(&bytes))),
        });
    }
    match String::from_utf8(bytes) {
        Ok(content) if !content.contains('\0') => Ok(ProjectFileContent {
            path: normalized_relative_path(&relative),
            content,
            is_binary: false,
            image_data_url: None,
        }),
        Ok(_) | Err(_) => Ok(ProjectFileContent {
            path: normalized_relative_path(&relative),
            content: String::new(),
            is_binary: true,
            image_data_url: None,
        }),
    }
}

/// Writes edited text back to one existing file inside an explicitly trusted
/// repository. Reuses the reading boundary (containment, sensitive-file
/// denial, size limit) and additionally refuses binary targets, so the manual
/// editor can only touch files the reader could already show as text.
fn write_project_file(
    root: &Path,
    requested_path: &str,
    content: &str,
) -> integrator_core::Result<ProjectFileContent> {
    let relative = validate_project_relative_path(requested_path)?;
    if is_sensitive_project_file(&relative) {
        return Err(IntegratorError::Unauthorized(
            "sensitive project files cannot be edited".into(),
        ));
    }
    let candidate = root.join(&relative);
    let canonical = dunce::canonicalize(&candidate).map_err(io_error)?;
    if !canonical.starts_with(root) {
        return Err(IntegratorError::Unauthorized(
            "file is outside the trusted repository".into(),
        ));
    }
    let metadata = fs::metadata(&canonical).map_err(io_error)?;
    if !metadata.is_file() {
        return Err(IntegratorError::InvalidInput(
            "requested path is not a file".into(),
        ));
    }
    if content.len() as u64 > MAX_PROJECT_FILE_BYTES {
        return Err(IntegratorError::Unavailable(format!(
            "edited content is larger than the {} KB safe editing limit",
            MAX_PROJECT_FILE_BYTES / 1_000
        )));
    }
    // Refuse to clobber binaries: a text write over a binary file is always a
    // corruption, never an edit the reader could have produced.
    let existing = fs::read(&canonical).map_err(io_error)?;
    if existing.contains(&0) || std::str::from_utf8(&existing).is_err() {
        return Err(IntegratorError::InvalidInput(
            "binary files cannot be edited as text".into(),
        ));
    }
    fs::write(&canonical, content).map_err(io_error)?;
    Ok(ProjectFileContent {
        path: normalized_relative_path(&relative),
        content: content.to_owned(),
        is_binary: false,
        image_data_url: None,
    })
}

/// Renames a file in place inside an explicitly trusted repository. The new
/// name must be a plain file name (no separators), and neither the source nor
/// the resulting name may be a protected sensitive file.
fn rename_project_file(
    root: &Path,
    requested_path: &str,
    new_name: &str,
) -> integrator_core::Result<ProjectFileEntry> {
    let relative = validate_project_relative_path(requested_path)?;
    if is_sensitive_project_file(&relative) {
        return Err(IntegratorError::Unauthorized(
            "sensitive project files cannot be renamed".into(),
        ));
    }
    let trimmed = new_name.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains(['/', '\\', '\0'])
    {
        return Err(IntegratorError::InvalidInput(
            "the new name must be a plain file name without path separators".into(),
        ));
    }
    let source = root.join(&relative);
    let canonical = dunce::canonicalize(&source).map_err(io_error)?;
    if !canonical.starts_with(root) {
        return Err(IntegratorError::Unauthorized(
            "file is outside the trusted repository".into(),
        ));
    }
    if !fs::metadata(&canonical).map_err(io_error)?.is_file() {
        return Err(IntegratorError::InvalidInput(
            "requested path is not a file".into(),
        ));
    }
    let target_relative = match relative.parent() {
        Some(parent) if parent != Path::new("") => parent.join(trimmed),
        _ => PathBuf::from(trimmed),
    };
    if is_sensitive_project_file(&target_relative) {
        return Err(IntegratorError::Unauthorized(
            "files cannot be renamed to protected sensitive names".into(),
        ));
    }
    let target = root.join(&target_relative);
    if target.exists() {
        return Err(IntegratorError::InvalidInput(
            "a file with that name already exists in this folder".into(),
        ));
    }
    fs::rename(&canonical, &target).map_err(io_error)?;
    let size = fs::metadata(&target).map_err(io_error)?.len();
    Ok(ProjectFileEntry {
        path: normalized_relative_path(&target_relative),
        size,
    })
}

fn discover_project_file_openers() -> Vec<ProjectFileOpener> {
    let mut openers = [
        (
            "cursor",
            "Cursor",
            "Open this file in the installed Cursor editor",
        ),
        (
            "codex",
            "Codex (workspace)",
            "Open this repository in the Codex desktop app",
        ),
        (
            "vscode",
            "Visual Studio Code",
            "Open this file in the installed Visual Studio Code editor",
        ),
        (
            "windsurf",
            "Windsurf",
            "Open this file in the installed Windsurf editor",
        ),
        ("zed", "Zed", "Open this file in the installed Zed editor"),
    ]
    .into_iter()
    .filter(|(id, _, _)| project_file_opener_executable(id).is_some())
    .map(|(id, label, description)| ProjectFileOpener {
        id: id.into(),
        label: label.into(),
        description: description.into(),
    })
    .collect::<Vec<_>>();
    openers.push(ProjectFileOpener {
        id: "system".into(),
        label: "System default".into(),
        description: "Open this file with its operating-system default app".into(),
    });
    openers
}

fn open_project_file_external(
    root: &Path,
    requested_path: &str,
    opener_id: &str,
) -> CommandResult<()> {
    let file = resolve_existing_project_file(root, requested_path).map_err(CommandError::from)?;
    if opener_id == "system" {
        return open_with_system_default(&file);
    }
    let executable = project_file_opener_executable(opener_id).ok_or_else(|| CommandError {
        code: "file-opener-unavailable",
        message: "that file opener is no longer available on this computer".into(),
    })?;
    let mut command = Command::new(executable);
    match opener_id {
        "cursor" | "vscode" | "windsurf" | "zed" => {
            command.arg(&file);
        }
        "codex" => {
            // Codex Desktop currently accepts a workspace path, not a file
            // path. The menu describes that distinction instead of implying a
            // line-level editor handoff.
            command.arg("app").arg(root);
        }
        _ => {
            return Err(CommandError {
                code: "invalid-input",
                message: "unknown file opener".into(),
            });
        }
    }
    spawn_quiet(command, "could not open the selected file")
}

fn reveal_project_file(root: &Path, requested_path: &str) -> CommandResult<()> {
    let (path, select_file) =
        resolve_project_file_reveal_target(root, requested_path).map_err(CommandError::from)?;

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer.exe");
        if select_file {
            command.arg(format!("/select,{}", path.display()));
        } else {
            command.arg(path);
        }
        spawn_quiet(command, "could not show the file in File Explorer")
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if select_file {
            command.arg("-R");
        }
        command.arg(path);
        spawn_quiet(command, "could not reveal the file in Finder")
    }
    #[cfg(target_os = "linux")]
    {
        let target = if select_file {
            path.parent().unwrap_or(root).to_path_buf()
        } else {
            path
        };
        let mut command = Command::new("xdg-open");
        command.arg(target);
        spawn_quiet(
            command,
            "could not show the file in the system file manager",
        )
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (path, select_file);
        Err(CommandError {
            code: "file-reveal-unavailable",
            message: "revealing files is not supported on this platform".into(),
        })
    }
}

fn resolve_existing_project_file(
    root: &Path,
    requested_path: &str,
) -> integrator_core::Result<PathBuf> {
    let relative = validate_project_relative_path(requested_path)?;
    let canonical_root = dunce::canonicalize(root).map_err(io_error)?;
    let canonical = dunce::canonicalize(canonical_root.join(relative)).map_err(io_error)?;
    if !canonical.starts_with(&canonical_root) {
        return Err(IntegratorError::Unauthorized(
            "file is outside the trusted repository".into(),
        ));
    }
    if !fs::metadata(&canonical).map_err(io_error)?.is_file() {
        return Err(IntegratorError::InvalidInput(
            "requested path is not a file".into(),
        ));
    }
    Ok(canonical)
}

fn resolve_project_file_reveal_target(
    root: &Path,
    requested_path: &str,
) -> integrator_core::Result<(PathBuf, bool)> {
    let relative = validate_project_relative_path(requested_path)?;
    let canonical_root = dunce::canonicalize(root).map_err(io_error)?;
    let candidate = canonical_root.join(&relative);
    if candidate.exists() {
        let canonical = dunce::canonicalize(&candidate).map_err(io_error)?;
        if !canonical.starts_with(&canonical_root) {
            return Err(IntegratorError::Unauthorized(
                "file is outside the trusted repository".into(),
            ));
        }
        return Ok((canonical.clone(), canonical.is_file()));
    }

    // Deleted or renamed Git entries still get a useful action: reveal the
    // closest directory that still exists, never a path outside the root.
    let mut parent = relative
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .to_path_buf();
    while !canonical_root.join(&parent).exists() && parent.pop() {}
    let canonical = dunce::canonicalize(canonical_root.join(parent)).map_err(io_error)?;
    if !canonical.starts_with(&canonical_root) || !canonical.is_dir() {
        return Err(IntegratorError::Unauthorized(
            "file location is outside the trusted repository".into(),
        ));
    }
    Ok((canonical, false))
}

fn open_with_system_default(file: &Path) -> CommandResult<()> {
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return Err(CommandError {
        code: "file-open-unavailable",
        message: "opening files is not supported on this platform".into(),
    });
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        command.arg(file);
        spawn_quiet(command, "could not open the selected file")
    }
}

fn spawn_quiet(mut command: Command, failure_message: &'static str) -> CommandResult<()> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command.spawn().map(|_| ()).map_err(|error| CommandError {
        code: "external-open-failed",
        message: format!("{failure_message}: {error}"),
    })
}

fn project_file_opener_executable(id: &str) -> Option<PathBuf> {
    let (command, windows_relative, macos_bundle) = match id {
        "cursor" => (
            "cursor",
            Some(Path::new("Programs/Cursor/Cursor.exe")),
            Some(Path::new("/Applications/Cursor.app/Contents/MacOS/Cursor")),
        ),
        "codex" => ("codex", None, None),
        "vscode" => (
            "code",
            Some(Path::new("Programs/Microsoft VS Code/Code.exe")),
            Some(Path::new(
                "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
            )),
        ),
        "windsurf" => (
            "windsurf",
            Some(Path::new("Programs/Windsurf/Windsurf.exe")),
            Some(Path::new(
                "/Applications/Windsurf.app/Contents/MacOS/Windsurf",
            )),
        ),
        "zed" => (
            "zed",
            Some(Path::new("Programs/Zed/Zed.exe")),
            Some(Path::new("/Applications/Zed.app/Contents/MacOS/zed")),
        ),
        _ => return None,
    };

    #[cfg(target_os = "windows")]
    if let Some(relative) = windows_relative {
        if let Some(base) = std::env::var_os("LOCALAPPDATA") {
            let candidate = PathBuf::from(base).join(relative);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        let system_relative = relative.strip_prefix("Programs").unwrap_or(relative);
        for base in [
            std::env::var_os("ProgramFiles"),
            std::env::var_os("ProgramFiles(x86)"),
        ]
        .into_iter()
        .flatten()
        {
            let candidate = PathBuf::from(base).join(system_relative);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(bundle) = macos_bundle
        && bundle.is_file()
    {
        return Some(bundle.to_path_buf());
    }
    let _ = (windows_relative, macos_bundle);
    native_executable_on_path(command)
}

fn native_executable_on_path(command: &str) -> Option<PathBuf> {
    let mut matches = which::which_all(command).ok()?;
    #[cfg(target_os = "windows")]
    {
        matches.find(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        matches.next()
    }
}

fn validate_project_relative_path(value: &str) -> integrator_core::Result<PathBuf> {
    let path = Path::new(value);
    if value.trim().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(IntegratorError::InvalidInput(
            "file path must be a relative project path".into(),
        ));
    }
    Ok(path.to_path_buf())
}

fn normalized_relative_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn should_skip_project_directory(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | "coverage"
            | ".venv"
            | "vendor"
    )
}

fn is_sensitive_project_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return true;
    };
    let normalized = name.to_ascii_lowercase();
    let protected_env = normalized == ".env"
        || (normalized.starts_with(".env.")
            && !normalized.ends_with(".example")
            && !normalized.ends_with(".sample")
            && !normalized.ends_with(".template"));
    protected_env
        || normalized.ends_with(".pem")
        || normalized.ends_with(".p12")
        || normalized.ends_with(".pfx")
        || normalized.ends_with(".key")
        || matches!(
            normalized.as_str(),
            "id_rsa" | "id_ed25519" | "credentials.json" | "service-account.json"
        )
}

fn io_error(error: std::io::Error) -> IntegratorError {
    IntegratorError::Io(error)
}

fn git_unavailable() -> CommandError {
    CommandError {
        code: "git-unavailable",
        message: "Git is not installed".into(),
    }
}
fn worker_error() -> CommandError {
    CommandError {
        code: "worker-failed",
        message: "local worker stopped unexpectedly".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_wav_container_describes_mono_pcm16() {
        let pcm = vec![0u8, 1, 2, 3];
        let wav = pcm16_to_wav(&pcm, 24000);
        assert_eq!(wav.len(), 44 + pcm.len());
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()), 40);
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(wav[16..20].try_into().unwrap()), 16);
        assert_eq!(u16::from_le_bytes(wav[20..22].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 24000);
        assert_eq!(u32::from_le_bytes(wav[28..32].try_into().unwrap()), 48000);
        assert_eq!(u16::from_le_bytes(wav[32..34].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16);
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 4);
        assert_eq!(&wav[44..], &pcm[..]);
    }

    #[test]
    fn interrupted_resume_uses_an_idempotence_guard_without_rewriting_visible_copy() {
        assert_eq!(
            provider_wire_prompt(INTERRUPTED_RESUME_VISIBLE_PROMPT, None, None),
            INTERRUPTED_RESUME_VISIBLE_PROMPT
        );
        let interrupted_at = chrono::DateTime::parse_from_rfc3339("2026-07-15T20:00:00Z")
            .expect("parse")
            .with_timezone(&Utc);
        let wire = provider_wire_prompt(
            INTERRUPTED_RESUME_VISIBLE_PROMPT,
            Some(true),
            Some(interrupted_at),
        );
        assert!(wire.contains("You were interrupted at 2026-07-15T20:00:00"));
        assert!(wire.contains("this session has been resumed"));
        assert!(wire.contains("Continue what you were doing as seamlessly"));
        assert!(wire.contains("Complete the task assigned in the last user prompt"));
        assert!(wire.contains("Do not repeat completed actions"));
        assert!(!wire.contains(INTERRUPTED_RESUME_VISIBLE_PROMPT));
        assert!(validate_interrupted_resume_action(None, Some(true)).is_ok());
        let error = validate_interrupted_resume_action(Some("skill"), Some(true))
            .expect_err("resume must not run a second native action");
        assert_eq!(error.code, "invalid-input");
    }

    #[test]
    fn interrupted_resume_refuses_a_stop_requested_tip() {
        let store = LocalStore::open_in_memory().expect("open store");
        let task = store
            .create_task(NewTask {
                title: "Stopped tip".into(),
                repository_path: None,
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create task");
        let binding = store
            .create_runtime_binding(task.id, "process-stop", ProviderKind::Codex)
            .and_then(|binding| store.attach_provider_thread(&binding, "thread-stop"))
            .expect("bind");
        let at = Utc::now();
        store
            .apply_reduced_event(
                &binding,
                &ReducedProviderEvent {
                    method: "turn/started".into(),
                    thread_id: "thread-stop".into(),
                    turn_id: Some("turn-stop".into()),
                    audit_json: "{}".into(),
                    audit_truncated: false,
                    mutation: ProjectionMutation::Turn(integrator_core::TurnProjection {
                        id: "turn-stop".into(),
                        status: TurnStatus::InProgress,
                        stop_requested: false,
                        error: None,
                        started_at: Some(at),
                        completed_at: None,
                    }),
                    occurred_at: at,
                },
            )
            .expect("start turn");
        store.request_stop(task.id).expect("stop");
        let _ = store.settle_stopped_turn(task.id).expect("settle");
        let error = validate_interrupted_resume_for_task(&store, task.id, None, Some(true))
            .expect_err("stopped tip must not resume as interruption");
        assert_eq!(error.code, "invalid-input");
        assert!(validate_interrupted_resume_for_task(&store, task.id, None, None).is_ok());
    }

    fn codex_item(
        provider_item_id: &str,
        kind: integrator_core::ItemKind,
        status: integrator_core::ItemStatus,
        body: &str,
    ) -> integrator_core::ItemProjection {
        integrator_core::ItemProjection {
            id: format!("codex:{provider_item_id}"),
            provider_item_id: provider_item_id.into(),
            kind,
            status,
            title: None,
            body: Some(body.into()),
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
            updated_at: Utc::now(),
        }
    }

    fn codex_user_item(provider_item_id: &str, body: &str) -> integrator_core::ItemProjection {
        codex_item(
            provider_item_id,
            integrator_core::ItemKind::UserMessage,
            integrator_core::ItemStatus::Completed,
            body,
        )
    }

    #[test]
    fn codex_native_skill_annotation_restores_visible_text_and_tracks_the_provider_item() {
        let mut pending = Some(PendingUserPrompt {
            wire_prompt: "$skill-creator build one".into(),
            visible_prompt: "/skill-creator build one".into(),
            native_skill: Some("skill-creator".into()),
            provider_item_id: None,
        });
        let occurred_at = Utc::now();
        let mut reduced = ReducedProviderEvent {
            method: "item/completed".into(),
            thread_id: "thread-1".into(),
            turn_id: Some("turn-1".into()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::ReplaceItem(codex_user_item(
                "user-1",
                "$skill-creator build one",
            )),
            occurred_at,
        };

        annotate_pending_user_prompt(&mut pending, Some("$skill-creator build one"), &mut reduced);

        let ProjectionMutation::ReplaceItem(item) = &reduced.mutation else {
            panic!("expected replaced user item");
        };
        assert_eq!(item.body.as_deref(), Some("/skill-creator build one"));
        assert_eq!(item.native_skill.as_deref(), Some("skill-creator"));
        assert_eq!(
            pending
                .as_ref()
                .and_then(|value| value.provider_item_id.as_deref()),
            Some("user-1")
        );

        let mut update = ReducedProviderEvent {
            method: "item/updated".into(),
            thread_id: "thread-1".into(),
            turn_id: Some("turn-1".into()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::MergeItem(codex_user_item("user-1", "normalized")),
            occurred_at,
        };
        annotate_pending_user_prompt(&mut pending, None, &mut update);
        let ProjectionMutation::MergeItem(item) = &update.mutation else {
            panic!("expected merged user item");
        };
        assert_eq!(item.body.as_deref(), Some("/skill-creator build one"));
        assert_eq!(item.native_skill.as_deref(), Some("skill-creator"));
    }

    #[test]
    fn codex_user_prompt_annotation_hides_provider_only_context() {
        let visible_prompt = "Review the queue behavior";
        let wire_prompt =
            format!("<delegation>provider-only instructions</delegation>\n\n{visible_prompt}");
        let mut pending = Some(PendingUserPrompt {
            wire_prompt: wire_prompt.clone(),
            visible_prompt: visible_prompt.into(),
            native_skill: None,
            provider_item_id: None,
        });
        let mut reduced = ReducedProviderEvent {
            method: "item/completed".into(),
            thread_id: "thread-1".into(),
            turn_id: Some("turn-1".into()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::ReplaceItem(codex_user_item("user-1", visible_prompt)),
            occurred_at: Utc::now(),
        };

        annotate_pending_user_prompt(&mut pending, Some(&wire_prompt), &mut reduced);

        let ProjectionMutation::ReplaceItem(item) = &reduced.mutation else {
            panic!("expected replaced user item");
        };
        assert_eq!(item.body.as_deref(), Some(visible_prompt));
        assert_eq!(item.native_skill, None);
    }

    #[test]
    fn codex_native_skill_annotation_ignores_unrelated_user_text() {
        let mut pending = Some(PendingUserPrompt {
            wire_prompt: "$skill-creator build one".into(),
            visible_prompt: "/skill-creator build one".into(),
            native_skill: Some("skill-creator".into()),
            provider_item_id: None,
        });
        let mut reduced = ReducedProviderEvent {
            method: "item/completed".into(),
            thread_id: "thread-1".into(),
            turn_id: Some("turn-1".into()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::ReplaceItem(codex_user_item(
                "user-other",
                "/unknown-command leave this plain",
            )),
            occurred_at: Utc::now(),
        };

        annotate_pending_user_prompt(
            &mut pending,
            Some("/unknown-command leave this plain"),
            &mut reduced,
        );

        let ProjectionMutation::ReplaceItem(item) = &reduced.mutation else {
            panic!("expected replaced user item");
        };
        assert_eq!(
            item.body.as_deref(),
            Some("/unknown-command leave this plain")
        );
        assert_eq!(item.native_skill, None);
        assert_eq!(
            pending
                .as_ref()
                .and_then(|value| value.provider_item_id.as_deref()),
            None
        );
    }

    #[test]
    fn thread_id_is_extracted_from_supported_shapes() {
        assert_eq!(
            extract_thread_id(&serde_json::json!({ "thread": { "id": "abc" } })),
            Some("abc".into())
        );
        assert_eq!(
            extract_thread_id(&serde_json::json!({ "threadId": "def" })),
            Some("def".into())
        );
    }

    #[test]
    fn raw_codex_user_prompt_is_captured_before_projection_normalization() {
        let params = serde_json::json!({
            "item": {
                "type": "userMessage",
                "content": [
                    {
                        "type": "input_text",
                        "text": "<integrator-skills>private context</integrator-skills>"
                    },
                    { "type": "input_text", "text": "Review the queue behavior" }
                ]
            }
        });
        assert_eq!(
            raw_codex_user_prompt(&params).as_deref(),
            Some(
                "<integrator-skills>private context</integrator-skills>\nReview the queue behavior"
            )
        );
    }

    #[test]
    fn resumed_items_reuse_durable_ids_and_visible_user_text() {
        let existing = vec![
            codex_user_item("user-live", "do u have EIA/census skills"),
            codex_item(
                "assistant-live",
                integrator_core::ItemKind::AgentMessage,
                integrator_core::ItemStatus::Completed,
                "Yes. I have both enabled.",
            ),
        ];
        let mut matched = HashSet::new();
        let mut replayed_user = ReducedProviderEvent {
            method: "item/started".into(),
            thread_id: "thread-1".into(),
            turn_id: Some("turn-1".into()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::ReplaceItem(codex_item(
                "item-1",
                integrator_core::ItemKind::UserMessage,
                integrator_core::ItemStatus::InProgress,
                "<integrator-skills>private context</integrator-skills>\n\ndo u have EIA/census skills",
            )),
            occurred_at: Utc::now(),
        };
        reconcile_replayed_item(&existing, &mut matched, 0, &mut replayed_user);
        let ProjectionMutation::ReplaceItem(user) = &replayed_user.mutation else {
            panic!("expected replayed user item");
        };
        assert_eq!(user.id, existing[0].id);
        assert_eq!(user.provider_item_id, "user-live");
        assert_eq!(user.body.as_deref(), Some("do u have EIA/census skills"));
        assert_eq!(user.status, integrator_core::ItemStatus::Completed);

        let mut replayed_assistant = ReducedProviderEvent {
            method: "item/started".into(),
            thread_id: "thread-1".into(),
            turn_id: Some("turn-1".into()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::ReplaceItem(codex_item(
                "item-2",
                integrator_core::ItemKind::AgentMessage,
                integrator_core::ItemStatus::InProgress,
                "Yes. I have both enabled.",
            )),
            occurred_at: Utc::now(),
        };
        reconcile_replayed_item(&existing, &mut matched, 1, &mut replayed_assistant);
        let ProjectionMutation::ReplaceItem(assistant) = &replayed_assistant.mutation else {
            panic!("expected replayed assistant item");
        };
        assert_eq!(assistant.id, existing[1].id);
        assert_eq!(assistant.provider_item_id, "assistant-live");
        assert_eq!(assistant.status, integrator_core::ItemStatus::Completed);
    }

    #[test]
    fn completed_thread_snapshot_defaults_items_to_completed() {
        assert_eq!(
            reconciled_item_method(false, &serde_json::json!({ "id": "item-1" })),
            "item/completed"
        );
        assert_eq!(
            reconciled_item_method(
                true,
                &serde_json::json!({ "id": "item-1", "status": "inProgress" })
            ),
            "item/started"
        );
    }

    #[test]
    fn acp_launch_is_provider_aware_and_rejects_non_acp_routes() {
        assert_eq!(
            acp_launch_arguments(&ProviderKind::Cursor, None).expect("Cursor ACP route"),
            vec!["acp"]
        );
        let grok = acp_launch_arguments(
            &ProviderKind::Grok,
            Some(crate::harness_prompt::LocalToolsProjection::Unavailable),
        )
        .expect("Grok ACP route");
        assert_eq!(grok[0], "--no-auto-update");
        assert_eq!(grok[1], "--rules");
        assert!(grok[2].contains("durable harness policy"));
        assert!(grok[2].contains("delegation are unavailable"));
        assert_eq!(&grok[3..], ["agent", "stdio"]);
        assert!(acp_launch_arguments(&ProviderKind::Antigravity, None).is_err());
        assert!(acp_launch_arguments(&ProviderKind::Claude, None).is_err());
    }

    #[test]
    fn unattended_acp_children_prefer_the_narrowest_allow_option() {
        let params = serde_json::json!({ "options": [
            { "optionId": "always", "kind": "allow_always" },
            { "optionId": "once", "kind": "allow_once" },
            { "optionId": "no", "kind": "reject_once" }
        ]});
        let outcome = acp_auto_allow_outcome(&params);
        assert_eq!(outcome["outcome"]["outcome"], "selected");
        assert_eq!(outcome["outcome"]["optionId"], "once");

        // A request advertising no allow option is cancelled, never guessed.
        let reject_only =
            serde_json::json!({ "options": [{ "optionId": "no", "kind": "reject_once" }] });
        assert_eq!(
            acp_auto_allow_outcome(&reject_only)["outcome"]["outcome"],
            "cancelled"
        );
        assert_eq!(
            acp_auto_allow_outcome(&serde_json::json!({}))["outcome"]["outcome"],
            "cancelled"
        );
    }

    #[test]
    fn grok_auth_selects_only_the_vendor_owned_cached_token_method() {
        assert!(acp_has_auth_method(
            &serde_json::json!({ "authMethods": [{ "id": "cached_token" }, { "id": "xai.api_key" }] }),
            "cached_token"
        ));
        assert!(!acp_has_auth_method(
            &serde_json::json!({ "authMethods": [{ "id": "xai.api_key" }] }),
            "cached_token"
        ));
    }

    #[test]
    fn antigravity_denial_with_a_useful_answer_is_not_a_failed_turn() {
        assert_eq!(
            structured_result_status(ProviderKind::Antigravity, false, true, true),
            TurnStatus::Completed
        );
        assert_eq!(
            structured_result_status(ProviderKind::Antigravity, false, true, false),
            TurnStatus::Failed
        );
        assert_eq!(
            structured_result_status(ProviderKind::Claude, false, true, true),
            TurnStatus::Failed
        );
    }

    #[test]
    fn native_slash_selection_must_still_match_the_leading_draft_token() {
        assert_eq!(
            native_slash_prompt("/skill-name do work", "skill-name").expect("matching action"),
            " do work"
        );
        assert!(native_slash_prompt("prefix /skill-name", "skill-name").is_err());
        assert!(native_slash_prompt("/skill-name-forged", "skill-name").is_err());
    }

    #[test]
    fn unchanged_native_actions_keep_their_opaque_handle_across_catalog_refreshes() {
        let repository = PathBuf::from("fixture-repository");
        let skill_path = repository.join(".codex").join("skills").join("openai-docs");
        let action = ResolvedNativeAction {
            public: NativeProviderAction {
                id: String::new(),
                name: "openai-docs".into(),
                description: "Use current OpenAI docs".into(),
                source: "bundled".into(),
                kind: NativeActionKind::Skill,
                invocation: NativeActionInvocation::Direct,
                input_hint: None,
            },
            provider_path: Some(skill_path.clone()),
        };
        let mut handles = std::collections::HashMap::new();

        let first = reconcile_native_action_handles(
            &mut handles,
            ProviderKind::Codex,
            repository.clone(),
            vec![action.clone()],
        );
        let first_id = first[0].id.clone();

        let mut refreshed = action.clone();
        refreshed.public.description = "Updated display copy".into();
        let second = reconcile_native_action_handles(
            &mut handles,
            ProviderKind::Codex,
            repository.clone(),
            vec![refreshed],
        );
        assert_eq!(second[0].id, first_id);
        assert_eq!(handles.len(), 1);

        let mut moved = action;
        moved.provider_path = Some(skill_path.join("moved"));
        let third = reconcile_native_action_handles(
            &mut handles,
            ProviderKind::Codex,
            repository,
            vec![moved],
        );
        assert_ne!(third[0].id, first_id);
        assert!(!handles.contains_key(&first_id));
    }

    #[test]
    fn codex_goal_is_a_pathless_direct_command() {
        let goal = codex_goal_action();
        assert_eq!(goal.public.id, CODEX_GOAL_ACTION_ID);
        assert_eq!(goal.public.name, "goal");
        assert_eq!(goal.public.kind, NativeActionKind::Command);
        assert_eq!(goal.public.invocation, NativeActionInvocation::Direct);
        assert_eq!(
            goal.public.input_hint.as_deref(),
            Some("completion condition")
        );
        assert!(goal.provider_path.is_none());
    }

    #[test]
    fn codex_goal_does_not_depend_on_process_local_action_handles() {
        let repository = PathBuf::from("fixture-repository");
        let mut handles = std::collections::HashMap::new();
        let actions = reconcile_native_action_handles(
            &mut handles,
            ProviderKind::Codex,
            repository,
            vec![codex_goal_action()],
        );

        assert_eq!(actions[0].id, CODEX_GOAL_ACTION_ID);
        assert!(handles.is_empty());
        let resolved = stateless_native_action_handle(
            &ProviderKind::Codex,
            Path::new("."),
            actions[0].id.as_str(),
        )
        .expect("stateless goal handle");
        assert_eq!(resolved.name, "goal");
        assert_eq!(resolved.kind, NativeActionKind::Command);
    }

    #[test]
    fn structured_routes_are_limited_to_preview_cli_providers() {
        assert_eq!(
            structured_provider(&ProviderKind::Claude).expect("Claude structured route"),
            StructuredCliProvider::Claude
        );
        assert_eq!(
            structured_provider(&ProviderKind::Antigravity).expect("Antigravity structured route"),
            StructuredCliProvider::Antigravity
        );
        assert!(structured_provider(&ProviderKind::Cursor).is_err());
    }

    #[test]
    fn structured_handoff_digest_is_only_loaded_for_a_fresh_plain_turn() {
        assert!(should_load_handoff_digest(None, false));
        assert!(!should_load_handoff_digest(Some("session-1"), false));
        assert!(!should_load_handoff_digest(None, true));
    }

    #[test]
    fn claude_modes_normalize_manual_and_keep_unknown_ids_selectable() {
        let mode = claude_mode_projection("manual");
        assert_eq!(mode.current_mode_id, "default");
        assert!(mode.available_modes.iter().any(|m| m.id == "plan"));

        let mode = claude_mode_projection("acceptEdits");
        assert_eq!(mode.current_mode_id, "acceptEdits");

        // A mode id this build does not know about must still render as the
        // current selection instead of leaving the picker inconsistent.
        let mode = claude_mode_projection("dontAsk");
        assert_eq!(mode.current_mode_id, "dontAsk");
        assert!(mode.available_modes.iter().any(|m| m.id == "dontAsk"));
    }

    #[test]
    fn plan_review_decisions_map_to_cursor_create_plan_results() {
        let accepted = acp_plan_review_result(ApprovalDecision::Accept);
        assert!(accepted.pointer("/result/success").is_some());
        let declined = acp_plan_review_result(ApprovalDecision::Decline);
        assert!(
            declined
                .pointer("/result/error/error")
                .and_then(Value::as_str)
                .is_some_and(|text| text.contains("rejected"))
        );
    }

    #[test]
    fn terminal_dimensions_are_bounded_before_opening_a_pty() {
        assert!(terminal_pty_size(80, 24).is_ok());
        assert!(terminal_pty_size(19, 24).is_err());
        assert!(terminal_pty_size(80, 4).is_err());
        assert!(terminal_pty_size(501, 24).is_err());
    }

    #[test]
    fn terminal_environment_advertises_color_without_inheriting_the_harness_opt_out() {
        let mut command = terminal_shell_command();
        apply_terminal_environment(&mut command);
        assert!(command.get_env("NO_COLOR").is_none());
        assert_eq!(
            command.get_env("TERM"),
            Some(std::ffi::OsStr::new("xterm-256color"))
        );
        assert_eq!(
            command.get_env("COLORTERM"),
            Some(std::ffi::OsStr::new("truecolor"))
        );
        assert_eq!(command.get_env("CLICOLOR"), Some(std::ffi::OsStr::new("1")));
    }

    #[test]
    fn native_terminal_round_trips_user_input() {
        let pair = native_pty_system()
            .openpty(terminal_pty_size(80, 24).expect("valid terminal size"))
            .expect("open native PTY");
        let mut command = terminal_shell_command();
        command.cwd(std::env::temp_dir());
        apply_terminal_environment(&mut command);
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("start interactive shell");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("clone PTY reader");
        let mut writer = pair.master.take_writer().expect("take PTY writer");
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut output = Vec::new();
            let _ = reader.read_to_end(&mut output);
            let _ = sender.send(output);
        });

        #[cfg(windows)]
        let input = b"if (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) { $e=[char]27; Write-Output ($e + '[38;5;196m__AI_INTEGRATOR_' + 'PTY_READY__' + $e + '[0m') } else { Write-Output ('__NOT_' + 'A_TTY__') }\r\nexit\r\n";
        #[cfg(not(windows))]
        let input = b"if [ -t 0 ] && [ -t 1 ]; then printf '\\033[38;5;196m__AI_INTEGRATOR_%s__\\033[0m\\n' 'PTY_READY'; else printf '__NOT_%s__\\n' 'A_TTY'; fi\nexit\n";
        writer.write_all(input).expect("write PTY input");
        writer.flush().expect("flush PTY input");

        let output = receiver
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|_| {
                let _ = child.kill();
                panic!("interactive shell did not answer within ten seconds");
            });
        child.wait().expect("wait for interactive shell");
        assert!(
            String::from_utf8_lossy(&output).contains("__AI_INTEGRATOR_PTY_READY__"),
            "interactive shell output did not contain the sentinel"
        );
        assert!(
            output
                .windows(b"\x1b[38;5;196m__AI_INTEGRATOR_PTY_READY__\x1b[0m".len())
                .any(|window| window == b"\x1b[38;5;196m__AI_INTEGRATOR_PTY_READY__\x1b[0m"),
            "interactive shell output did not preserve ANSI color"
        );
        assert!(!String::from_utf8_lossy(&output).contains("__NOT_A_TTY__"));
    }

    #[test]
    fn reads_a_nested_project_file_with_the_trusted_root_normalization() {
        let root = std::env::temp_dir().join(format!("project-files-{}", uuid::Uuid::new_v4()));
        let nested = root.join("src").join("runtime");
        fs::create_dir_all(&nested).expect("create nested project directory");
        fs::write(nested.join("router.ts"), "export const route = true;\n")
            .expect("write project file");
        // Trusted roots reach production callers canonicalized; macOS temp
        // dirs are symlinked (/var -> /private/var), so mirror that here.
        let root = dunce::canonicalize(&root).expect("canonicalize project root");

        let content =
            read_project_file(&root, "src/runtime/router.ts").expect("read nested project file");
        assert_eq!(content.path, "src/runtime/router.ts");
        assert_eq!(content.content, "export const route = true;\n");
        assert!(!content.is_binary);
        assert!(content.image_data_url.is_none());

        fs::remove_dir_all(&root).expect("clean up project directory");
    }

    #[test]
    fn reads_an_image_file_as_an_inline_data_url_preview() {
        let root = std::env::temp_dir().join(format!("project-image-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create project directory");
        // A one-pixel PNG: real image bytes that also contain NUL, proving the
        // image branch bypasses the text/binary heuristic.
        let png = [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        fs::write(root.join("logo.png"), png).expect("write image file");
        let root = dunce::canonicalize(&root).expect("canonicalize project root");

        let content = read_project_file(&root, "logo.png").expect("read image file");
        assert_eq!(content.path, "logo.png");
        assert!(content.content.is_empty());
        assert!(content.is_binary);
        let data_url = content.image_data_url.expect("image preview data url");
        assert!(
            data_url.starts_with("data:image/png;base64,"),
            "unexpected data url prefix: {data_url}"
        );

        fs::remove_dir_all(&root).expect("clean up project directory");
    }

    #[test]
    fn saves_a_pasted_clipboard_image_under_app_data() {
        let root = std::env::temp_dir().join(format!("pasted-image-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create data directory");
        let png = [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];

        let saved = save_pasted_image_bytes(&root, &png, "image/png").expect("save paste");
        assert_eq!(saved.kind, "image");
        assert!(saved.name.ends_with(".png"));
        assert!(saved.path.starts_with(root.join("pasted-attachments")));
        assert_eq!(fs::read(&saved.path).expect("read saved paste"), png);
        assert!(saved.data_url.starts_with("data:image/png;base64,"));

        fs::remove_dir_all(&root).expect("clean up data directory");
    }

    #[test]
    fn rejects_unsupported_clipboard_image_types() {
        let root = std::env::temp_dir().join(format!("pasted-reject-{}", uuid::Uuid::new_v4()));
        let error = save_pasted_image_bytes(&root, b"not-an-image", "application/pdf")
            .expect_err("unsupported mime");
        assert_eq!(error.code, "invalid-input");
    }

    #[test]
    fn reads_a_non_image_binary_without_an_image_preview() {
        let root = std::env::temp_dir().join(format!("project-binary-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create project directory");
        fs::write(root.join("blob.bin"), [0x00, 0x01, 0x02, 0x00]).expect("write binary file");
        let root = dunce::canonicalize(&root).expect("canonicalize project root");

        let content = read_project_file(&root, "blob.bin").expect("read binary file");
        assert!(content.is_binary);
        assert!(content.content.is_empty());
        assert!(content.image_data_url.is_none());

        fs::remove_dir_all(&root).expect("clean up project directory");
    }

    #[test]
    fn project_file_writes_stay_inside_the_safe_utf8_boundary() {
        let root = std::env::temp_dir().join(format!("project-write-{}", uuid::Uuid::new_v4()));
        let nested = root.join("src");
        fs::create_dir_all(&nested).expect("create project directory");
        fs::write(nested.join("main.rs"), "fn main() {}\n").expect("write text fixture");
        fs::write(nested.join("invalid.bin"), [0xff, 0xfe, 0xfd])
            .expect("write invalid utf8 fixture");
        let root = dunce::canonicalize(&root).expect("canonicalize project root");

        let saved = write_project_file(&root, "src/main.rs", "fn main() { println!(\"safe\"); }\n")
            .expect("write safe utf8 text");
        assert_eq!(saved.content, "fn main() { println!(\"safe\"); }\n");
        assert_eq!(
            fs::read_to_string(root.join("src/main.rs")).expect("read saved fixture"),
            saved.content
        );

        assert!(write_project_file(&root, "src/invalid.bin", "replacement").is_err());
        assert!(write_project_file(&root, ".env", "SECRET=exposed").is_err());
        assert!(write_project_file(&root, "../outside.txt", "escape").is_err());

        let binary = read_project_file(&root, "src/invalid.bin").expect("read invalid utf8 file");
        assert!(binary.is_binary);
        assert!(binary.content.is_empty());

        fs::remove_dir_all(&root).expect("clean up project directory");
    }

    #[test]
    fn external_file_paths_stay_project_relative() {
        let root = std::env::temp_dir().join(format!("file-actions-{}", uuid::Uuid::new_v4()));
        let nested = root.join("src");
        fs::create_dir_all(&nested).expect("create file action fixture");
        fs::write(nested.join("main.rs"), "fn main() {}\n").expect("write file action fixture");

        let resolved =
            resolve_existing_project_file(&root, "src/main.rs").expect("resolve nested file");
        assert_eq!(
            resolved,
            dunce::canonicalize(nested.join("main.rs")).expect("canonical fixture file")
        );
        assert!(resolve_existing_project_file(&root, "../outside.txt").is_err());
        assert!(
            resolve_existing_project_file(&root, &root.join("src/main.rs").display().to_string())
                .is_err()
        );

        fs::remove_dir_all(&root).expect("clean up file action fixture");
    }

    #[test]
    fn external_file_opener_inventory_is_closed_and_keeps_system_fallback() {
        let openers = discover_project_file_openers();
        assert_eq!(
            openers.last().map(|opener| opener.id.as_str()),
            Some("system")
        );
        assert!(openers.iter().all(|opener| matches!(
            opener.id.as_str(),
            "cursor" | "codex" | "vscode" | "windsurf" | "zed" | "system"
        )));
    }

    #[test]
    fn reveal_deleted_project_file_stays_inside_the_repository() {
        let root = std::env::temp_dir().join(format!("file-reveal-{}", uuid::Uuid::new_v4()));
        let nested = root.join("src");
        fs::create_dir_all(&nested).expect("create reveal fixture");

        let (target, select_file) = resolve_project_file_reveal_target(&root, "src/deleted.rs")
            .expect("resolve deleted file's parent");
        assert_eq!(
            target,
            dunce::canonicalize(&nested).expect("canonical fixture directory")
        );
        assert!(!select_file);
        assert!(resolve_project_file_reveal_target(&root, "../../outside.rs").is_err());

        fs::remove_dir_all(&root).expect("clean up reveal fixture");
    }
}
