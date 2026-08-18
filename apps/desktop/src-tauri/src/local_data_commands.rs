use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use chrono::{DateTime, Utc};
use integrator_core::{LocalExport, RuntimeSession};
use serde::Serialize;
use tauri::State;

use crate::{
    command_api::{CommandResult, worker_error},
    state::AppState,
};

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

fn file_size(path: PathBuf) -> u64 {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

pub(crate) fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| {
            let Ok(file_type) = entry.file_type() else {
                return 0;
            };
            if file_type.is_file() {
                entry.metadata().map(|metadata| metadata.len()).unwrap_or(0)
            } else if file_type.is_dir() {
                directory_size(&entry.path())
            } else {
                0
            }
        })
        .fold(0_u64, u64::saturating_add)
}

#[tauri::command]
pub fn storage_totals(state: State<'_, AppState>) -> CommandResult<StorageTotals> {
    let database_bytes = file_size(state.data_directory.join("integrator.sqlite3"));
    let wal_bytes = file_size(state.data_directory.join("integrator.sqlite3-wal"));
    let shared_memory_bytes = file_size(state.data_directory.join("integrator.sqlite3-shm"));
    let attachment_bytes = directory_size(&state.data_directory.join("chat-attachments"))
        .saturating_add(directory_size(
            &state.data_directory.join("pasted-attachments"),
        ))
        .saturating_add(directory_size(
            &state.data_directory.join("browser-captures"),
        ));
    Ok(StorageTotals {
        total_bytes: database_bytes
            .saturating_add(wal_bytes)
            .saturating_add(shared_memory_bytes)
            .saturating_add(attachment_bytes),
        database_bytes,
        wal_bytes,
        shared_memory_bytes,
        measured_at: Utc::now(),
        kind: "sqlite",
    })
}
