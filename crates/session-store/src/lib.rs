#![forbid(unsafe_code)]

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    str::FromStr,
};

use chrono::{DateTime, Utc};
use integrator_core::{
    ArchivedTaskPage, ChatContextReference, ComposerDraft, ComposerDraftAttachment,
    ComposerDraftOwner, ContextReferenceId, IntegratorError, LocalExport, MemoryCreator,
    MemoryEntry, MemoryId, MemoryState, NewMemoryEntry, NewQueuedMessage, NewTask, ProjectId,
    ProviderKind, ProviderResumeState, ProviderSession, ProviderSessionId, QueuedMessage,
    QueuedMessageId, QueuedMessageState, Result, RuntimeSession, RuntimeSessionId, Setting, Task,
    TaskContextReference, TaskId, TaskKind, TaskState, TrustedProject, UsageProjection,
};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use sha2::{Digest, Sha256};

mod automation_store;
mod browser_store;
mod context_store;
mod delegation_store;
mod draft_store;
mod memory_store;
mod migrations;
mod project_store;
mod projection_store;
mod queue_store;
mod sessions_store;
mod settings_store;
mod task_store;
mod usage_store;
pub use automation_store::{NewAutomation, UpdateAutomation};
pub use browser_store::{StoredBrowserTab, StoredBrowserWindow, StoredRecentTab};
pub use delegation_store::NewDelegation;
pub use projection_store::{
    HANDOFF_CHILD_MAX_TOKENS, HANDOFF_DEFAULT_MAX_IMAGES, HANDOFF_DEFAULT_MAX_TOKENS,
    HANDOFF_DEFAULT_MAX_TURNS, HandoffDigest, HandoffDigestOptions, PersistedStopRequest,
    PreparedApprovalResponse,
};

use context_store::{
    parse_context_reference, parse_context_reference_row, validate_context_references,
};
use migrations::MIGRATIONS;
use queue_store::{parse_queued_message, parse_queued_message_row};
pub(crate) use task_store::{build_task, insert_task_row};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommitMessageGenerationClaim {
    Claimed,
    Cached(String),
    InProgress,
}

/// Unfinished commit-message claims older than this are treated as orphaned
/// (e.g. the app crashed mid-generation) and re-claimable. Generation callers
/// enforce a 30-second provider timeout, so a live claim never reaches it.
const COMMIT_MESSAGE_CLAIM_TTL_SECONDS: i64 = 120;

pub struct LocalStore {
    connection: Mutex<Connection>,
}

impl LocalStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let connection = Connection::open(path).map_err(storage_error)?;
        Self::configure(&connection)?;
        let store = Self {
            connection: Mutex::new(connection),
        };
        store.migrate()?;
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self> {
        let connection = Connection::open_in_memory().map_err(storage_error)?;
        Self::configure(&connection)?;
        let store = Self {
            connection: Mutex::new(connection),
        };
        store.migrate()?;
        Ok(store)
    }

    fn configure(connection: &Connection) -> Result<()> {
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
            )
            .map_err(storage_error)
    }

    fn migrate(&self) -> Result<()> {
        let mut connection = self.connection.lock();
        connection
            .execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
                [],
            )
            .map_err(storage_error)?;

        for (version, sql) in MIGRATIONS {
            let applied = connection
                .query_row(
                    "SELECT 1 FROM schema_migrations WHERE version = ?1",
                    [version],
                    |_| Ok(()),
                )
                .optional()
                .map_err(storage_error)?
                .is_some();
            if applied {
                continue;
            }
            let transaction = connection.transaction().map_err(storage_error)?;
            transaction.execute_batch(sql).map_err(storage_error)?;
            transaction
                .execute(
                    "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                    params![version, Utc::now().to_rfc3339()],
                )
                .map_err(storage_error)?;
            transaction.commit().map_err(storage_error)?;
        }
        Ok(())
    }

    /// Delete all user-owned local records while retaining the schema and its
    /// migration history. The order is intentional: child projection and
    /// session records are removed before their task and provider parents,
    /// while foreign-key enforcement remains enabled for the transaction.
    pub fn clear_all_data(&self) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        transaction
            .execute_batch(
                "DELETE FROM automation_runs;
                 DELETE FROM automations;
                 DELETE FROM browser_recent_tabs;
                 DELETE FROM browser_tabs;
                 DELETE FROM browser_windows;
                 DELETE FROM task_context_references;
                 DELETE FROM memories;
                 DELETE FROM queued_messages;
                 DELETE FROM composer_drafts;
                 DELETE FROM delegation_messages;
                 DELETE FROM delegations;
                 DELETE FROM integrator_event_log;
                 DELETE FROM integrator_approvals;
                 DELETE FROM integrator_items;
                 DELETE FROM integrator_turns;
                 DELETE FROM integrator_task_projection;
                 DELETE FROM commit_message_jobs;
                 DELETE FROM task_title_jobs;
                 DELETE FROM runtime_sessions;
                 DELETE FROM provider_sessions;
                 DELETE FROM tasks;
                 DELETE FROM settings;
                 DELETE FROM trusted_projects;",
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)
    }
}

fn normalize_required_text(value: String, max_chars: usize, label: &str) -> Result<String> {
    let normalized = value.trim();
    if normalized.is_empty() || normalized.chars().count() > max_chars || normalized.contains('\0')
    {
        return Err(IntegratorError::InvalidInput(format!(
            "{label} must contain 1 to {max_chars} characters"
        )));
    }
    Ok(normalized.to_owned())
}

fn ensure_task_exists(connection: &Connection, task_id: TaskId) -> Result<()> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM tasks WHERE id = ?1",
            [task_id.to_string()],
            |_| Ok(()),
        )
        .optional()
        .map_err(storage_error)?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(IntegratorError::NotFound(format!("task {task_id}")))
    }
}

fn normalize_optional_text(value: Option<String>, max_chars: usize) -> Result<Option<String>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > max_chars {
        return Err(IntegratorError::InvalidInput(format!(
            "value must contain at most {max_chars} characters"
        )));
    }
    Ok(Some(trimmed.to_owned()))
}

fn path_text(path: Option<&Path>) -> Option<String> {
    path.map(|value| value.to_string_lossy().into_owned())
}

fn parse_time(value: &str) -> Result<DateTime<Utc>> {
    if let Ok(time) = DateTime::parse_from_rfc3339(value) {
        return Ok(time.with_timezone(&Utc));
    }
    // Tolerate accidental SQLite `datetime('now')` shapes so one bad row
    // cannot blank the whole workspace export.
    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S") {
        return Ok(naive.and_utc());
    }
    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f") {
        return Ok(naive.and_utc());
    }
    DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Utc))
        .map_err(invalid_stored)
}

fn invalid_stored(error: impl std::fmt::Display) -> IntegratorError {
    IntegratorError::Storage(format!("invalid stored data: {error}"))
}

fn storage_error(error: rusqlite::Error) -> IntegratorError {
    IntegratorError::Storage(error.to_string())
}

#[cfg(test)]
mod tests;
