use std::sync::Arc;

use integrator_core::{
    NewQueuedMessage, QueuedMessage, QueuedMessageId, QueuedMessageState, TaskId,
};
use tauri::State;

use crate::{
    command_api::{CommandResult, worker_error},
    state::AppState,
};

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
