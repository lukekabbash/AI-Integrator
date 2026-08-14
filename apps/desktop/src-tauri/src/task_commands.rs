use std::sync::Arc;

use integrator_core::{
    ArchivedTaskPage, ComposerDraft, NewTask, Task, TaskContextReference, TaskId, TaskState,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    command_api::{CommandResult, worker_error},
    state::AppState,
};

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
pub async fn task_context_reference_list(
    state: State<'_, AppState>,
    task_id: TaskId,
) -> CommandResult<Vec<TaskContextReference>> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.list_context_references(task_id))
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

/// Copies settled history through the requested event into a fresh task. Live
/// work and provider resume state remain only on the source task.
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
