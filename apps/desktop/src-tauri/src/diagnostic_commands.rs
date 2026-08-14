use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use integrator_core::{IntegratorError, Task, TaskId};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::command_api::{CommandError, CommandResult, worker_error};
use crate::state::AppState;

pub(crate) fn log_task_folder_event(
    app: &AppHandle,
    state: &State<'_, AppState>,
    op: &str,
    task_id: TaskId,
    task: Option<&Task>,
    folder_kind: Option<&str>,
    directory: Option<&Path>,
    error: Option<&CommandError>,
) {
    let Ok(documents) = documents_directory(app) else {
        return;
    };
    let detailed = detailed_logging_enabled(&state.store);
    let failed = error.is_some();
    let cause_class = error.map(|entry| match entry.code {
        "invalid-input" => "unpaired-folder",
        "unauthorized" => "unauthorized",
        "not-found" => "not-found",
        _ => "io",
    });
    let mut record = serde_json::json!({
        "level": if failed { "error" } else { "info" },
        "faultId": uuid::Uuid::new_v4().to_string(),
        "layer": "native",
        "op": op,
        "outcome": if failed { "fail" } else { "ok" },
        "code": error.map(|entry| entry.code).unwrap_or("ok"),
        "causeClass": cause_class.unwrap_or("ok"),
        "taskId": task_id.to_string(),
        "taskKind": task.map(|entry| entry.kind.as_str()).unwrap_or("unknown"),
        "folderKind": folder_kind.unwrap_or(""),
        "hasWorktree": task.map(|entry| entry.worktree_path.is_some()).unwrap_or(false),
        "hasRepository": task.map(|entry| entry.repository_path.is_some()).unwrap_or(false),
        "detail": error.map(|entry| entry.message.as_str()).unwrap_or(""),
    });
    if let (true, Some(path), Some(object)) = (detailed, directory, record.as_object_mut()) {
        object.insert(
            "path".into(),
            Value::String(path.to_string_lossy().into_owned()),
        );
    }
    if failed {
        let _ = crate::diagnostic_log::append_incident(&documents, &record);
    }
    let _ = crate::diagnostic_log::append_detail(&documents, &record, detailed);
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsTotalsView {
    bytes: u64,
    file_count: u64,
    incident_files: u64,
    detail_files: u64,
    measured_at: DateTime<Utc>,
    path: String,
}

pub(crate) fn documents_directory(app: &AppHandle) -> CommandResult<PathBuf> {
    app.path().document_dir().map_err(|_| CommandError {
        code: "unavailable",
        message: "Documents folder is unavailable on this machine".into(),
    })
}

pub(crate) fn detailed_logging_enabled(store: &session_store::LocalStore) -> bool {
    store
        .get_setting("settings.diagnostics.detailedLogging")
        .ok()
        .flatten()
        .and_then(|setting| setting.value.as_bool())
        .unwrap_or(false)
}

fn diagnostics_retention(store: &session_store::LocalStore) -> crate::diagnostic_log::Retention {
    let value = store
        .get_setting("settings.diagnostics.retention")
        .ok()
        .flatten()
        .and_then(|setting| setting.value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "7d".into());
    crate::diagnostic_log::parse_retention(&value)
}

#[tauri::command]
pub async fn logs_open_folder(app: AppHandle) -> CommandResult<()> {
    let documents = documents_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::diagnostic_log::open_logs_folder(&documents)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn logs_totals(app: AppHandle) -> CommandResult<LogsTotalsView> {
    let documents = documents_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let totals = crate::diagnostic_log::logs_totals(&documents)?;
        Ok::<LogsTotalsView, IntegratorError>(LogsTotalsView {
            bytes: totals.total_bytes,
            file_count: totals.file_count,
            incident_files: totals.incident_files,
            detail_files: totals.detail_files,
            measured_at: Utc::now(),
            path: crate::diagnostic_log::logs_root(&documents)
                .to_string_lossy()
                .into_owned(),
        })
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn logs_clear(app: AppHandle) -> CommandResult<()> {
    let documents = documents_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || crate::diagnostic_log::clear_logs(&documents))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn logs_prune(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    let documents = documents_directory(&app)?;
    let retention = diagnostics_retention(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        crate::diagnostic_log::prune_logs(&documents, retention).map(|_| ())
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

/// Appends one redacted diagnostic record. `channel` is `incident` (always) or
/// `detail` (only when detailed logging is enabled).
#[tauri::command]
pub async fn diagnostics_report(
    app: AppHandle,
    state: State<'_, AppState>,
    channel: String,
    record: Value,
) -> CommandResult<()> {
    let documents = documents_directory(&app)?;
    let detailed = detailed_logging_enabled(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        let mut envelope = record;
        if let Some(object) = envelope.as_object_mut() {
            object
                .entry("ts".to_string())
                .or_insert_with(|| Value::String(Utc::now().to_rfc3339()));
            object
                .entry("os".to_string())
                .or_insert_with(|| Value::String(std::env::consts::OS.to_string()));
        }
        match channel.as_str() {
            "detail" => crate::diagnostic_log::append_detail(&documents, &envelope, detailed),
            _ => crate::diagnostic_log::append_incident(&documents, &envelope),
        }
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}
