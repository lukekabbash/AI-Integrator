use std::{path::PathBuf, sync::Arc};

use adapter_codex::CodexLaunchOptions;
use chrono::Utc;
use integrator_core::{
    IntegratorError, LocalExport, NewTask, ProviderKind, ProviderSession, ProviderSessionId,
    RuntimeSession, Setting, Task, TaskId, TaskState, Versioned,
};
use integrator_runtime::{
    CommitResult, CreateWorktree, DiffResult, DiffScope, FileStatus, PushPreview,
    RepositoryIdentity, WorktreeInfo, discover_providers, provider_executable,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;

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
    Versioned::v1(Bootstrap {
        application_version: env!("CARGO_PKG_VERSION").into(),
        domain_schema_version: integrator_core::DOMAIN_SCHEMA_VERSION,
        git_available: state.git.is_some(),
        local_only: true,
    })
}

#[tauri::command]
pub async fn provider_discover() -> Vec<integrator_core::ProviderStatus> {
    tauri::async_runtime::spawn_blocking(discover_providers)
        .await
        .unwrap_or_default()
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
pub async fn git_repository(
    state: State<'_, AppState>,
    path: PathBuf,
) -> CommandResult<RepositoryIdentity> {
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || git.repository(&path))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_worktrees(
    state: State<'_, AppState>,
    repository: PathBuf,
) -> CommandResult<Vec<WorktreeInfo>> {
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || git.worktrees(&repository))
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
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || git.create_worktree(&repository, &request))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_status(
    state: State<'_, AppState>,
    repository: PathBuf,
) -> CommandResult<Vec<FileStatus>> {
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || git.status(&repository))
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
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || git.diff(&repository, scope, path.as_deref()))
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
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || git.stage(&repository, &paths))
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
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || git.unstage(&repository, &paths))
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
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || git.commit(&repository, &message))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_push_preview(
    state: State<'_, AppState>,
    repository: PathBuf,
) -> CommandResult<PushPreview> {
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || git.push_preview(&repository))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    working_directory: Option<PathBuf>,
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
    let mut receiver = client.subscribe();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = receiver.recv().await {
            if app.emit("runtime://codex-event", event).is_err() {
                break;
            }
        }
    });
    let previous = state.codex.lock().await.replace(client);
    if let Some(previous) = previous {
        let _ = previous.shutdown().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn codex_disconnect(state: State<'_, AppState>) -> CommandResult<()> {
    if let Some(client) = state.codex.lock().await.take() {
        client.shutdown().await.map_err(CommandError::from)?;
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
    state: State<'_, AppState>,
    task_id: TaskId,
    cwd: PathBuf,
    model: Option<String>,
) -> CommandResult<Value> {
    state.store.get_task(task_id).map_err(CommandError::from)?;
    let response = codex_client(&state)
        .await?
        .start_thread(&cwd, model.as_deref())
        .await
        .map_err(CommandError::from)?;
    if let Some(thread_id) = extract_thread_id(&response) {
        let now = Utc::now();
        state
            .store
            .upsert_provider_session(&ProviderSession {
                id: ProviderSessionId::new(),
                task_id,
                provider: ProviderKind::Codex,
                provider_thread_id: thread_id,
                created_at: now,
                updated_at: now,
            })
            .map_err(CommandError::from)?;
    }
    Ok(response)
}

#[tauri::command]
pub async fn codex_resume_thread(
    state: State<'_, AppState>,
    thread_id: String,
) -> CommandResult<Value> {
    codex_client(&state)
        .await?
        .resume_thread(&thread_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_start_turn(
    state: State<'_, AppState>,
    thread_id: String,
    prompt: String,
) -> CommandResult<Value> {
    codex_client(&state)
        .await?
        .start_turn(&thread_id, &prompt)
        .await
        .map_err(Into::into)
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
}

#[tauri::command]
pub async fn codex_resolve_approval(
    state: State<'_, AppState>,
    request_id: u64,
    decision: ApprovalDecision,
) -> CommandResult<()> {
    let decision = match decision {
        ApprovalDecision::Accept => "accept",
        ApprovalDecision::AcceptForSession => "acceptForSession",
        ApprovalDecision::Decline => "decline",
        ApprovalDecision::Cancel => "cancel",
    };
    codex_client(&state)
        .await?
        .respond_to_server_request(request_id, serde_json::json!({ "decision": decision }))
        .await
        .map_err(Into::into)
}

async fn codex_client(state: &State<'_, AppState>) -> CommandResult<adapter_codex::CodexClient> {
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

fn extract_thread_id(value: &Value) -> Option<String> {
    value
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .or_else(|| value.get("threadId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
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
