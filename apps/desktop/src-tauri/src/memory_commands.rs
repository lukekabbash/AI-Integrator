use std::sync::Arc;

use integrator_core::{MemoryCreator, MemoryEntry, MemoryId, MemoryState, NewMemoryEntry};
use tauri::State;

use crate::{
    command_api::{CommandResult, worker_error},
    state::AppState,
};

#[tauri::command]
pub async fn memory_list(state: State<'_, AppState>) -> CommandResult<Vec<MemoryEntry>> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.list_memories())
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn memory_create(state: State<'_, AppState>, text: String) -> CommandResult<MemoryEntry> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        store.create_memory(NewMemoryEntry {
            text,
            creator: MemoryCreator::User,
            source_task_id: None,
            source_item_id: None,
        })
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn memory_update(
    state: State<'_, AppState>,
    memory_id: MemoryId,
    text: String,
) -> CommandResult<MemoryEntry> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.update_memory_text(memory_id, &text))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn memory_set_enabled(
    state: State<'_, AppState>,
    memory_id: MemoryId,
    enabled: bool,
) -> CommandResult<MemoryEntry> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        store.set_memory_state(
            memory_id,
            if enabled {
                MemoryState::Active
            } else {
                MemoryState::Disabled
            },
        )
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn memory_delete(state: State<'_, AppState>, memory_id: MemoryId) -> CommandResult<()> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.delete_memory(memory_id))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}
