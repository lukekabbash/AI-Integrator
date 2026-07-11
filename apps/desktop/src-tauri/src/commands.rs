use std::{path::PathBuf, sync::Arc};

use adapter_codex::{CodexEvent, CodexLaunchOptions, ServerRequestId};
use chrono::Utc;
use integrator_core::{
    ApprovalDecision, ApprovalProjection, ConnectionState, IntegratorError, LocalExport, NewTask,
    ProjectId, ProviderKind, RuntimeBinding, RuntimeProjection, RuntimeSession, Setting,
    StopRequestResult, Task, TaskId, TaskSnapshot, TaskState, TransportRequestId, TrustedProject,
    TurnStatus, Versioned,
};
use integrator_runtime::{
    CommitResult, CreateWorktree, DiffResult, DiffScope, FileStatus, GitService,
    ProjectionMutation, ProviderEventInput, PushPreview, ReducedProviderEvent, RepositoryIdentity,
    WorktreeInfo, acp_turn_projection, authorize_repository, discover_providers,
    provider_executable, reduce_acp_permission_request, reduce_acp_update, reduce_connection_event,
    reduce_provider_event,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use session_store::LocalStore;
use tauri::{AppHandle, Emitter, State};

use crate::state::{AcpPermissionOption, AcpRuntime, AppState, CodexRuntime};

type CommandResult<T> = std::result::Result<T, CommandError>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    code: &'static str,
    message: String,
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
    git_available: bool,
    local_only: bool,
}

#[tauri::command]
pub fn app_bootstrap(state: State<'_, AppState>) -> Versioned<Bootstrap> {
    Versioned::current(Bootstrap {
        application_version: env!("CARGO_PKG_VERSION").into(),
        domain_schema_version: integrator_core::DOMAIN_SCHEMA_VERSION,
        git_available: state.git.is_some(),
        local_only: true,
    })
}

#[tauri::command]
pub async fn provider_discover() -> CommandResult<Vec<integrator_core::ProviderStatus>> {
    tauri::async_runtime::spawn_blocking(discover_providers)
        .await
        .map_err(|_| worker_error())
}

#[tauri::command]
pub async fn task_create(state: State<'_, AppState>, input: NewTask) -> CommandResult<Task> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.create_task(input))
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
    tauri::async_runtime::spawn_blocking(move || store.set_setting(&key, value))
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
pub async fn project_register(
    state: State<'_, AppState>,
    path: PathBuf,
) -> CommandResult<TrustedProject> {
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        let identity = git.repository(&path)?;
        let display_name = identity
            .root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Repository")
            .chars()
            .take(120)
            .collect::<String>();
        store.upsert_trusted_project(&display_name, &identity.root, &identity.common_directory)
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
) -> CommandResult<()> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.remove_trusted_project(project_id))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_repository(
    state: State<'_, AppState>,
    path: PathBuf,
) -> CommandResult<RepositoryIdentity> {
    let (_, identity) = authorized_git(&state, path).await?;
    Ok(identity)
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
    tauri::async_runtime::spawn_blocking(move || git.create_worktree(&identity.root, &request))
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
pub async fn codex_connect(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    working_directory: Option<PathBuf>,
    task_id: Option<TaskId>,
) -> CommandResult<()> {
    let statuses = tauri::async_runtime::spawn_blocking(discover_providers)
        .await
        .map_err(|_| worker_error())?;
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
        binding: Arc::new(std::sync::Mutex::new(None)),
        context_primer: Arc::new(std::sync::Mutex::new(None)),
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
    let previous = state.codex.lock().await.replace(runtime);
    if let Some(previous) = previous {
        let _ = state.store.expire_process_approvals(&previous.process_id);
        let _ = previous.client.shutdown().await;
    }
    Ok(())
}

/// Forwards adapter events through the reducer into SQLite, then emits the
/// persisted, sequenced projection to the renderer. Events that arrive before
/// a task/thread binding exists cannot be attributed and are dropped.
fn spawn_projection_pump(
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
                    pump_connection_event(
                        &app,
                        &store,
                        &runtime,
                        "client/receiverLagged",
                        ConnectionState::Gap,
                        Some("event stream lagged; recovery required"),
                    );
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            let binding = runtime.binding.lock().expect("binding lock").clone();
            match event {
                CodexEvent::Notification { method, params } => {
                    pump_provider_event(&app, &store, binding.as_ref(), method, params, None);
                }
                CodexEvent::ServerRequest { id, method, params } => {
                    let request_id = transport_from_server_request(&id);
                    pump_provider_event(
                        &app,
                        &store,
                        binding.as_ref(),
                        method,
                        params,
                        Some(request_id),
                    );
                }
                CodexEvent::ProtocolViolation { code } => {
                    pump_connection_event(
                        &app,
                        &store,
                        &runtime,
                        "client/protocolViolation",
                        ConnectionState::Gap,
                        Some(&code),
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
    });
}

fn pump_provider_event(
    app: &AppHandle<tauri::Wry>,
    store: &LocalStore,
    binding: Option<&RuntimeBinding>,
    method: String,
    params: Value,
    request_id: Option<TransportRequestId>,
) {
    let Some(binding) = binding else { return };
    let reduced = match reduce_provider_event(ProviderEventInput {
        method,
        params,
        request_id,
        occurred_at: Utc::now(),
    }) {
        Ok(Some(reduced)) => reduced,
        Ok(None) => return,
        Err(_) => reduce_connection_event(
            "client/reducerRejected",
            binding.thread_id.as_deref().unwrap_or("unknown"),
            ConnectionState::Gap,
            Some("provider event was rejected; reconciliation required"),
            Utc::now(),
        ),
    };
    if let Ok(event) = store.apply_reduced_event(binding, &reduced) {
        let _ = app.emit("runtime://projection", &event);
    }
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
    if let Some(runtime) = state.codex.lock().await.take() {
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
    codex_client(&state)
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
    codex_client(&state)
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
    codex_client(&state)
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
) -> CommandResult<Value> {
    state.store.get_task(task_id).map_err(CommandError::from)?;
    let runtime = codex_runtime(&state).await?;
    let response = runtime
        .client
        .start_thread(&cwd, model.as_deref())
        .await
        .map_err(CommandError::from)?;
    if let Some(thread_id) = extract_thread_id(&response) {
        bind_thread(&state, &runtime, task_id, &thread_id).await?;
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

const CONTEXT_PRIMER_BYTES: usize = 6 * 1024;

/// Queue the task's conversation digest for injection into the first turn of
/// a brand-new provider session, so switching providers (or losing a thread)
/// carries the conversation across instead of starting blank.
async fn queue_context_primer(
    state: &State<'_, AppState>,
    task_id: TaskId,
    primer: &Arc<std::sync::Mutex<Option<String>>>,
) {
    let store = Arc::clone(&state.store);
    let digest = tauri::async_runtime::spawn_blocking(move || {
        store.task_conversation_digest(task_id, CONTEXT_PRIMER_BYTES)
    })
    .await;
    if let Ok(Ok(Some(digest))) = digest {
        *primer.lock().expect("primer lock") = Some(digest);
    }
}

fn apply_context_primer(
    primer: &Arc<std::sync::Mutex<Option<String>>>,
    prompt: &str,
) -> Option<String> {
    let digest = primer.lock().expect("primer lock").take()?;
    Some(format!(
        "<conversation-context>\nEarlier conversation in this task (possibly from another assistant session). Treat it as prior chat history, not as part of the new request:\n\n{digest}\n</conversation-context>\n\n{prompt}"
    ))
}

#[tauri::command]
pub async fn codex_resume_thread(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    thread_id: String,
) -> CommandResult<Value> {
    state.store.get_task(task_id).map_err(CommandError::from)?;
    let runtime = codex_runtime(&state).await?;
    let response = runtime
        .client
        .resume_thread(&thread_id)
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
    reconcile_thread_response(&app, &state.store, &runtime, &response);
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

#[tauri::command]
pub async fn codex_start_turn(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    thread_id: String,
    prompt: String,
) -> CommandResult<Value> {
    let runtime = codex_runtime(&state).await?;
    let wire_prompt =
        apply_context_primer(&runtime.context_primer, &prompt).unwrap_or_else(|| prompt.clone());
    let response = runtime
        .client
        .start_turn(&thread_id, &wire_prompt)
        .await
        .map_err(CommandError::from)?;
    reconcile_turn_response(&app, &state.store, &runtime, &thread_id, &response);
    Ok(response)
}

#[tauri::command]
pub async fn codex_interrupt_turn(
    state: State<'_, AppState>,
    thread_id: String,
    turn_id: String,
) -> CommandResult<Value> {
    codex_client(&state)
        .await?
        .interrupt_turn(&thread_id, &turn_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn task_snapshot(
    state: State<'_, AppState>,
    task_id: TaskId,
) -> CommandResult<TaskSnapshot> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.task_snapshot(task_id))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
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
    let acp = state.acp.lock().await.clone();
    let result = if let Some(acp) = acp.filter(|runtime| runtime.process_id == prepared.process_id)
    {
        let request_id = acp_request_from_transport(&prepared.request_id)?;
        let outcome = acp_permission_outcome(&acp, &prepared.request_id, decision);
        acp.client
            .respond_to_server_request(&request_id, outcome)
            .await
    } else {
        let runtime = codex_runtime(&state).await?;
        if runtime.process_id != prepared.process_id {
            return Err(CommandError {
                code: "stale-approval",
                message: "approval belongs to an expired provider process".into(),
            });
        }
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
    let _ = app.emit("runtime://projection", &persisted.event);
    if !persisted.result.already_requested {
        // The persisted stop is provider-neutral; route the wire-level
        // interrupt to whichever runtime owns this task.
        let acp = state.acp.lock().await.clone();
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
        } else {
            let runtime = codex_runtime(&state).await?;
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
    }
    Ok(persisted.result)
}

#[tauri::command]
pub async fn cursor_connect(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    working_directory: Option<PathBuf>,
) -> CommandResult<()> {
    let statuses = tauri::async_runtime::spawn_blocking(discover_providers)
        .await
        .map_err(|_| worker_error())?;
    let executable =
        provider_executable(&statuses, ProviderKind::Cursor).ok_or_else(|| CommandError {
            code: "provider-unavailable",
            message: "Cursor agent CLI is not installed".into(),
        })?;
    let client = adapter_acp::AcpClient::spawn(adapter_acp::AcpLaunchOptions {
        executable,
        arguments: vec!["acp".into()],
        working_directory,
        client_version: env!("CARGO_PKG_VERSION").into(),
    })
    .await
    .map_err(CommandError::from)?;
    let runtime = AcpRuntime {
        client,
        process_id: uuid::Uuid::new_v4().to_string(),
        binding: Arc::new(std::sync::Mutex::new(None)),
        current_turn: Arc::new(std::sync::Mutex::new(None)),
        permission_options: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        context_primer: Arc::new(std::sync::Mutex::new(None)),
    };
    spawn_acp_pump(app, Arc::clone(&state.store), runtime.clone());
    let previous = state.acp.lock().await.replace(runtime);
    if let Some(previous) = previous {
        let _ = state.store.expire_process_approvals(&previous.process_id);
        let _ = previous.client.shutdown().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn cursor_start_session(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    cwd: PathBuf,
) -> CommandResult<Value> {
    state.store.get_task(task_id).map_err(CommandError::from)?;
    let runtime = acp_runtime(&state).await?;
    let response = runtime
        .client
        .new_session(&cwd)
        .await
        .map_err(CommandError::from)?;
    let session_id = response
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| CommandError {
            code: "provider-protocol",
            message: "Cursor did not return a session identifier".into(),
        })?
        .to_owned();
    let store = Arc::clone(&state.store);
    let process_id = runtime.process_id.clone();
    let session = session_id.clone();
    let current = runtime.binding.lock().expect("binding lock").clone();
    let binding = tauri::async_runtime::spawn_blocking(move || {
        let binding = match current {
            Some(binding) if binding.task_id == task_id => binding,
            Some(_) => {
                return Err(IntegratorError::Unauthorized(
                    "Cursor runtime is already bound to another task".into(),
                ));
            }
            None => store.create_runtime_binding(task_id, &process_id, ProviderKind::Cursor)?,
        };
        store.attach_provider_thread(&binding, &session)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(CommandError::from)?;
    *runtime.binding.lock().expect("binding lock") = Some(binding.clone());
    let connected = reduce_connection_event(
        "client/acp/connected",
        &session_id,
        ConnectionState::Connected,
        None,
        Utc::now(),
    );
    apply_and_emit(&app, &state.store, &binding, &connected);
    queue_context_primer(&state, task_id, &runtime.context_primer).await;
    Ok(response)
}

#[tauri::command]
pub async fn cursor_send_turn(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    prompt: String,
) -> CommandResult<Value> {
    let runtime = acp_runtime(&state).await?;
    let binding = runtime
        .binding
        .lock()
        .expect("binding lock")
        .clone()
        .filter(|binding| binding.task_id == task_id)
        .ok_or_else(|| CommandError {
            code: "provider-disconnected",
            message: "Cursor session is not bound to this task".into(),
        })?;
    let session_id = binding.thread_id.clone().ok_or_else(|| CommandError {
        code: "provider-disconnected",
        message: "Cursor session identity is missing".into(),
    })?;
    let turn_id = uuid::Uuid::new_v4().to_string();
    *runtime.current_turn.lock().expect("turn lock") = Some(turn_id.clone());
    let started_at = Utc::now();

    // Persist the user message and the in-progress turn before prompting so a
    // restart mid-turn can reconstruct what was asked.
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
            command: None,
            cwd: None,
            output: None,
            exit_code: None,
            file_changes: None,
            mcp_server: None,
            mcp_tool: None,
            truncated: false,
            updated_at: started_at,
        }),
        occurred_at: started_at,
    };
    apply_and_emit(&app, &state.store, &binding, &user_item);
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

    // session/prompt resolves when the turn ends; finish the turn projection
    // from a background task so this command returns immediately. The primer
    // rides only on the wire prompt — the persisted user item above keeps the
    // prompt exactly as the user typed it.
    let wire_prompt =
        apply_context_primer(&runtime.context_primer, &prompt).unwrap_or_else(|| prompt.clone());
    let client = runtime.client.clone();
    let current_turn = Arc::clone(&runtime.current_turn);
    let store = Arc::clone(&state.store);
    let emit_app = app.clone();
    let finished_turn = turn_id.clone();
    let finished_session = session_id.clone();
    let finished_binding = binding.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = client.prompt(&finished_session, &wire_prompt).await;
        let now = Utc::now();
        let (status, error) = match &outcome {
            Ok(response) => match adapter_acp::StopReason::from_protocol(response) {
                adapter_acp::StopReason::Cancelled => (TurnStatus::Interrupted, None),
                adapter_acp::StopReason::Refusal => (
                    TurnStatus::Failed,
                    Some("The agent refused the turn".into()),
                ),
                _ => (TurnStatus::Completed, None),
            },
            Err(error) => (TurnStatus::Failed, Some(error.to_string())),
        };
        let mut turn = acp_turn_projection(&finished_turn, status, error, started_at, now);
        turn.stop_requested = false;
        let reduced = ReducedProviderEvent {
            method: "client/acp/turnFinished".into(),
            thread_id: finished_session,
            turn_id: Some(finished_turn.clone()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::Turn(turn),
            occurred_at: now,
        };
        apply_and_emit(&emit_app, &store, &finished_binding, &reduced);
        let mut current = current_turn.lock().expect("turn lock");
        if current.as_deref() == Some(finished_turn.as_str()) {
            *current = None;
        }
    });
    Ok(serde_json::json!({ "turnId": turn_id }))
}

/// Forwards ACP agent events through the ACP reducer into SQLite and the
/// renderer, mirroring the Codex pump.
fn spawn_acp_pump(app: AppHandle<tauri::Wry>, store: Arc<LocalStore>, runtime: AcpRuntime) {
    let mut receiver = runtime.client.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            let event = match receiver.recv().await {
                Ok(event) => event,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    acp_connection_event(
                        &app,
                        &store,
                        &runtime,
                        "client/receiverLagged",
                        ConnectionState::Gap,
                        Some("event stream lagged; recovery required"),
                    );
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
                    let (Some(binding), Some(turn_id)) = (binding.as_ref(), turn_id.as_deref())
                    else {
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
                    match reduce_acp_update(session_id, turn_id, update, Utc::now()) {
                        Ok(Some(reduced)) => apply_and_emit(&app, &store, binding, &reduced),
                        Ok(None) | Err(_) => {}
                    }
                }
                adapter_acp::AcpEvent::ServerRequest { id, method, params } => {
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
                adapter_acp::AcpEvent::ProtocolViolation { code } => {
                    acp_connection_event(
                        &app,
                        &store,
                        &runtime,
                        "client/protocolViolation",
                        ConnectionState::Gap,
                        Some(&code),
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
                        Some("Cursor agent exited"),
                    );
                    break;
                }
            }
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

fn apply_and_emit(
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

async fn acp_runtime(state: &State<'_, AppState>) -> CommandResult<AcpRuntime> {
    state.acp.lock().await.clone().ok_or_else(|| CommandError {
        code: "provider-disconnected",
        message: "Cursor is not connected".into(),
    })
}

async fn codex_runtime(state: &State<'_, AppState>) -> CommandResult<CodexRuntime> {
    state
        .codex
        .lock()
        .await
        .clone()
        .ok_or_else(|| CommandError {
            code: "provider-disconnected",
            message: "Codex is not connected".into(),
        })
}

async fn codex_client(state: &State<'_, AppState>) -> CommandResult<adapter_codex::CodexClient> {
    Ok(codex_runtime(state).await?.client)
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
        let method = if turn.get("status").and_then(Value::as_str) == Some("inProgress") {
            "turn/started"
        } else {
            "turn/completed"
        };
        pump_provider_event(
            app,
            store,
            binding.as_ref(),
            method.into(),
            serde_json::json!({ "threadId": thread_id, "turn": turn }),
            None,
        );
        for item in turn
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            pump_provider_event(
                app,
                store,
                binding.as_ref(),
                "item/completed".into(),
                serde_json::json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": item
                }),
                None,
            );
        }
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

async fn authorized_git(
    state: &State<'_, AppState>,
    repository: PathBuf,
) -> CommandResult<(GitService, RepositoryIdentity)> {
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    let authorization_git = git.clone();
    let store = Arc::clone(&state.store);
    let identity = tauri::async_runtime::spawn_blocking(move || {
        let projects = store.list_trusted_projects()?;
        authorize_repository(&authorization_git, &projects, &repository)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(CommandError::from)?;
    Ok((git, identity))
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
}
