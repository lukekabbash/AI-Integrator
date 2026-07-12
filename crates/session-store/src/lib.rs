#![forbid(unsafe_code)]

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    str::FromStr,
};

use chrono::{DateTime, Utc};
use integrator_core::{
    IntegratorError, LocalExport, NewTask, ProjectId, ProviderKind, ProviderSession,
    ProviderSessionId, Result, RuntimeSession, RuntimeSessionId, Setting, Task, TaskId, TaskState,
    TrustedProject, UsageProjection,
};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

mod delegation_store;
mod projection_store;
pub use delegation_store::NewDelegation;
pub use projection_store::{PersistedStopRequest, PreparedApprovalResponse};

const MIGRATIONS: &[(i64, &str)] = &[
    (
        1,
        r#"
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            repository_path TEXT,
            worktree_path TEXT,
            state TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS tasks_updated_at_idx ON tasks(updated_at DESC);
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS provider_sessions (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            provider_thread_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(provider, provider_thread_id)
        );
        CREATE INDEX IF NOT EXISTS provider_sessions_task_idx ON provider_sessions(task_id);
        CREATE TABLE IF NOT EXISTS runtime_sessions (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            provider_session_id TEXT REFERENCES provider_sessions(id) ON DELETE SET NULL,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            ended_at TEXT
        );
        CREATE INDEX IF NOT EXISTS runtime_sessions_task_idx ON runtime_sessions(task_id, started_at DESC);
        "#,
    ),
    (
        2,
        r#"
        CREATE TABLE IF NOT EXISTS trusted_projects (
            id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            repository_root TEXT NOT NULL UNIQUE,
            git_common_directory TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_opened_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS trusted_projects_last_opened_idx
            ON trusted_projects(last_opened_at DESC);
        CREATE INDEX IF NOT EXISTS trusted_projects_common_dir_idx
            ON trusted_projects(git_common_directory);
        "#,
    ),
    (
        3,
        r#"
        ALTER TABLE runtime_sessions ADD COLUMN process_id TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS runtime_sessions_process_idx
            ON runtime_sessions(process_id) WHERE process_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS codex_turns (
            provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            thread_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            status TEXT NOT NULL,
            stop_requested INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            started_at TEXT,
            completed_at TEXT,
            projection_json TEXT NOT NULL,
            last_event_seq INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(provider_session_id, turn_id)
        );
        CREATE TABLE IF NOT EXISTS codex_items (
            provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            thread_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            stable_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            title TEXT,
            body TEXT,
            command_text TEXT,
            cwd TEXT,
            output TEXT,
            exit_code INTEGER,
            file_changes_json TEXT,
            mcp_server TEXT,
            mcp_tool TEXT,
            truncated INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            projection_json TEXT NOT NULL,
            last_event_seq INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(provider_session_id, turn_id, item_id)
        );
        CREATE TABLE IF NOT EXISTS codex_approvals (
            id TEXT PRIMARY KEY,
            provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id) ON DELETE CASCADE,
            runtime_session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            process_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            turn_id TEXT,
            item_id TEXT,
            approval_id TEXT,
            request_kind TEXT NOT NULL,
            request_value TEXT NOT NULL,
            approval_kind TEXT NOT NULL,
            state TEXT NOT NULL,
            decision TEXT,
            reason TEXT,
            command_text TEXT,
            cwd TEXT,
            file_changes_json TEXT,
            updated_at TEXT NOT NULL,
            projection_json TEXT NOT NULL,
            last_event_seq INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS codex_approvals_transport_idx
            ON codex_approvals(runtime_session_id, request_kind, request_value);
        CREATE TABLE IF NOT EXISTS codex_task_projection (
            task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
            provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id) ON DELETE CASCADE,
            thread_id TEXT NOT NULL,
            current_turn_id TEXT,
            plan_json TEXT,
            plan_truncated INTEGER NOT NULL DEFAULT 0,
            diff TEXT,
            diff_truncated INTEGER NOT NULL DEFAULT 0,
            usage_json TEXT,
            connection_state TEXT NOT NULL DEFAULT 'disconnected',
            connection_reason TEXT,
            process_id TEXT,
            plan_seq INTEGER NOT NULL DEFAULT 0,
            diff_seq INTEGER NOT NULL DEFAULT 0,
            usage_seq INTEGER NOT NULL DEFAULT 0,
            connection_seq INTEGER NOT NULL DEFAULT 0,
            last_event_seq INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS codex_event_log (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id) ON DELETE CASCADE,
            runtime_session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
            process_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            turn_id TEXT,
            method TEXT NOT NULL,
            audit_json TEXT NOT NULL,
            audit_truncated INTEGER NOT NULL DEFAULT 0,
            projection_json TEXT,
            occurred_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS codex_event_task_seq_idx ON codex_event_log(task_id, seq);
        "#,
    ),
    (
        4,
        r#"
        ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS tasks_navigation_idx
            ON tasks(archived, pinned DESC, updated_at DESC);
        "#,
    ),
    (
        5,
        r#"
        ALTER TABLE tasks ADD COLUMN runtime TEXT;
        ALTER TABLE tasks ADD COLUMN model TEXT;
        ALTER TABLE tasks ADD COLUMN effort TEXT;
        "#,
    ),
    (
        6,
        r#"
        ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
        CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks(parent_task_id);
        CREATE TABLE IF NOT EXISTS delegations (
            id TEXT PRIMARY KEY,
            parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            child_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
            profile_id TEXT NOT NULL,
            profile_label TEXT NOT NULL,
            runtime TEXT NOT NULL,
            model TEXT,
            effort TEXT,
            title TEXT NOT NULL,
            brief TEXT NOT NULL,
            status TEXT NOT NULL,
            result TEXT,
            child_session_ref TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS delegations_parent_idx
            ON delegations(parent_task_id, created_at);
        CREATE TABLE IF NOT EXISTS delegation_messages (
            id TEXT PRIMARY KEY,
            delegation_id TEXT NOT NULL REFERENCES delegations(id) ON DELETE CASCADE,
            sender TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            delivered_at TEXT
        );
        CREATE INDEX IF NOT EXISTS delegation_messages_queue_idx
            ON delegation_messages(delegation_id, delivered_at, created_at);
        "#,
    ),
];

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
                "DELETE FROM delegation_messages;
                 DELETE FROM delegations;
                 DELETE FROM codex_event_log;
                 DELETE FROM codex_approvals;
                 DELETE FROM codex_items;
                 DELETE FROM codex_turns;
                 DELETE FROM codex_task_projection;
                 DELETE FROM runtime_sessions;
                 DELETE FROM provider_sessions;
                 DELETE FROM tasks;
                 DELETE FROM settings;
                 DELETE FROM trusted_projects;",
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)
    }

    /// Returns the persisted provider usage projections grouped by the runtime
    /// selected for each task. Missing provider usage remains a zero-valued
    /// projection so callers can label it as unavailable rather than infer it.
    pub fn provider_usage_rows(&self) -> Result<Vec<(String, u64, u64, UsageProjection)>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                r#"
                SELECT COALESCE(tasks.runtime, 'unknown'),
                       COUNT(DISTINCT codex_turns.turn_id),
                       codex_task_projection.usage_json
                FROM tasks
                LEFT JOIN codex_turns ON codex_turns.task_id = tasks.id
                LEFT JOIN codex_task_projection ON codex_task_projection.task_id = tasks.id
                GROUP BY tasks.id, tasks.runtime, codex_task_projection.usage_json
                "#,
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                let provider = row.get::<_, String>(0)?;
                let turn_count = row.get::<_, u64>(1)?;
                let usage_json = row.get::<_, Option<String>>(2)?;
                let usage = usage_json
                    .as_deref()
                    .and_then(|value| serde_json::from_str::<UsageProjection>(value).ok())
                    .unwrap_or_default();
                Ok((provider, turn_count, usage))
            })
            .map_err(storage_error)?;
        let mut grouped: BTreeMap<String, (u64, u64, UsageProjection)> = BTreeMap::new();
        for row in rows {
            let (provider, turn_count, usage) = row.map_err(storage_error)?;
            let entry = grouped
                .entry(provider)
                .or_insert_with(|| (0, 0, UsageProjection::default()));
            entry.0 += 1;
            entry.1 += turn_count;
            entry.2.input_tokens += usage.input_tokens;
            entry.2.cached_input_tokens += usage.cached_input_tokens;
            entry.2.output_tokens += usage.output_tokens;
            entry.2.reasoning_output_tokens += usage.reasoning_output_tokens;
            entry.2.total_tokens += usage.total_tokens;
            entry.2.model_context_window =
                match (entry.2.model_context_window, usage.model_context_window) {
                    (Some(current), Some(next)) => Some(current.max(next)),
                    (current, next) => current.or(next),
                };
            entry.2.vendor_cost_micro_usd =
                match (entry.2.vendor_cost_micro_usd, usage.vendor_cost_micro_usd) {
                    (None, None) => None,
                    (current, next) => {
                        Some(current.unwrap_or(0).saturating_add(next.unwrap_or(0)))
                    }
                };
        }
        Ok(grouped
            .into_iter()
            .map(|(provider, (task_count, turn_count, usage))| {
                (provider, task_count, turn_count, usage)
            })
            .collect())
    }

    pub fn create_task(&self, input: NewTask) -> Result<Task> {
        let title = input.title.trim();
        if title.is_empty() || title.chars().count() > 240 {
            return Err(IntegratorError::InvalidInput(
                "task title must contain 1 to 240 characters".into(),
            ));
        }
        let now = Utc::now();
        let task = Task {
            id: TaskId::new(),
            title: title.to_owned(),
            repository_path: input.repository_path,
            worktree_path: input.worktree_path,
            state: TaskState::Draft,
            pinned: false,
            archived: false,
            runtime: normalize_optional_text(input.runtime, 64)?,
            model: normalize_optional_text(input.model, 120)?,
            effort: normalize_optional_text(input.effort, 64)?,
            parent_task_id: input.parent_task_id,
            created_at: now,
            updated_at: now,
        };
        self.connection
            .lock()
            .execute(
                "INSERT INTO tasks(id, title, repository_path, worktree_path, state, pinned, archived, runtime, model, effort, parent_task_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    task.id.to_string(),
                    task.title,
                    path_text(task.repository_path.as_deref()),
                    path_text(task.worktree_path.as_deref()),
                    task.state.as_str(),
                    task.pinned,
                    task.archived,
                    task.runtime,
                    task.model,
                    task.effort,
                    task.parent_task_id.map(|id| id.to_string()),
                    task.created_at.to_rfc3339(),
                    task.updated_at.to_rfc3339(),
                ],
            )
            .map_err(storage_error)?;
        Ok(task)
    }

    pub fn upsert_trusted_project(
        &self,
        display_name: &str,
        repository_root: &Path,
        git_common_directory: &Path,
    ) -> Result<TrustedProject> {
        let display_name = display_name.trim();
        if display_name.is_empty() || display_name.chars().count() > 120 {
            return Err(IntegratorError::InvalidInput(
                "project display name must contain 1 to 120 characters".into(),
            ));
        }
        if !repository_root.is_absolute() || !git_common_directory.is_absolute() {
            return Err(IntegratorError::InvalidInput(
                "trusted project paths must be canonical absolute paths".into(),
            ));
        }
        let repository_root = repository_root.to_string_lossy().into_owned();
        let git_common_directory = git_common_directory.to_string_lossy().into_owned();
        let now = Utc::now();
        let connection = self.connection.lock();
        let existing = connection
            .query_row(
                "SELECT id, created_at FROM trusted_projects WHERE repository_root = ?1",
                [&repository_root],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(storage_error)?;
        let (id, created_at) = match existing {
            Some((id, created_at)) => (
                ProjectId::from_str(&id).map_err(invalid_stored)?,
                parse_time(&created_at)?,
            ),
            None => (ProjectId::new(), now),
        };
        connection
            .execute(
                "INSERT INTO trusted_projects(id, display_name, repository_root, git_common_directory, created_at, last_opened_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(repository_root) DO UPDATE SET display_name = excluded.display_name, git_common_directory = excluded.git_common_directory, last_opened_at = excluded.last_opened_at",
                params![id.to_string(), display_name, repository_root, git_common_directory, created_at.to_rfc3339(), now.to_rfc3339()],
            )
            .map_err(storage_error)?;
        Ok(TrustedProject {
            id,
            display_name: display_name.to_owned(),
            repository_root: PathBuf::from(repository_root),
            git_common_directory: PathBuf::from(git_common_directory),
            created_at,
            last_opened_at: now,
        })
    }

    pub fn list_trusted_projects(&self) -> Result<Vec<TrustedProject>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare("SELECT id, display_name, repository_root, git_common_directory, created_at, last_opened_at FROM trusted_projects ORDER BY last_opened_at DESC")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(storage_error)?;
        rows.map(|row| {
            let (id, display_name, root, common, created, opened) = row.map_err(storage_error)?;
            Ok(TrustedProject {
                id: ProjectId::from_str(&id).map_err(invalid_stored)?,
                display_name,
                repository_root: PathBuf::from(root),
                git_common_directory: PathBuf::from(common),
                created_at: parse_time(&created)?,
                last_opened_at: parse_time(&opened)?,
            })
        })
        .collect()
    }

    pub fn remove_trusted_project(&self, project_id: ProjectId) -> Result<()> {
        let changed = self
            .connection
            .lock()
            .execute(
                "DELETE FROM trusted_projects WHERE id = ?1",
                [project_id.to_string()],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("project {project_id}")));
        }
        Ok(())
    }

    pub fn list_tasks(&self) -> Result<Vec<Task>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare("SELECT id, title, repository_path, worktree_path, state, pinned, archived, runtime, model, effort, parent_task_id, created_at, updated_at FROM tasks ORDER BY pinned DESC, updated_at DESC")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, bool>(5)?,
                    row.get::<_, bool>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, String>(12)?,
                ))
            })
            .map_err(storage_error)?;
        rows.map(|row| parse_task_row(row.map_err(storage_error)?))
            .collect()
    }

    pub fn update_task_state(&self, task_id: TaskId, state: TaskState) -> Result<Task> {
        let now = Utc::now();
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE tasks SET state = ?1, updated_at = ?2 WHERE id = ?3",
                params![state.as_str(), now.to_rfc3339(), task_id.to_string()],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("task {task_id}")));
        }
        self.get_task(task_id)
    }

    pub fn update_task_metadata(
        &self,
        task_id: TaskId,
        title: Option<String>,
        pinned: Option<bool>,
        archived: Option<bool>,
    ) -> Result<Task> {
        let title = title.map(|value| value.trim().to_owned());
        if title
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.chars().count() > 240)
        {
            return Err(IntegratorError::InvalidInput(
                "task title must contain 1 to 240 characters".into(),
            ));
        }
        let now = Utc::now();
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE tasks SET title = COALESCE(?1, title), pinned = COALESCE(?2, pinned), archived = COALESCE(?3, archived), updated_at = ?4 WHERE id = ?5",
                params![title, pinned, archived, now.to_rfc3339(), task_id.to_string()],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("task {task_id}")));
        }
        self.get_task(task_id)
    }

    /// Persist the composer's last provider/model/effort selection for this chat.
    pub fn update_task_routing(
        &self,
        task_id: TaskId,
        runtime: &str,
        model: &str,
        effort: Option<&str>,
    ) -> Result<Task> {
        let runtime = normalize_optional_text(Some(runtime.to_owned()), 64)?
            .ok_or_else(|| IntegratorError::InvalidInput("runtime is required".into()))?;
        let model = normalize_optional_text(Some(model.to_owned()), 120)?
            .ok_or_else(|| IntegratorError::InvalidInput("model is required".into()))?;
        let effort = normalize_optional_text(effort.map(str::to_owned), 64)?;
        let now = Utc::now();
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE tasks SET runtime = ?1, model = ?2, effort = ?3, updated_at = ?4 WHERE id = ?5",
                params![
                    runtime,
                    model,
                    effort,
                    now.to_rfc3339(),
                    task_id.to_string()
                ],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("task {task_id}")));
        }
        self.get_task(task_id)
    }

    pub fn get_task(&self, task_id: TaskId) -> Result<Task> {
        let connection = self.connection.lock();
        let row = connection
            .query_row(
                "SELECT id, title, repository_path, worktree_path, state, pinned, archived, runtime, model, effort, parent_task_id, created_at, updated_at FROM tasks WHERE id = ?1",
                [task_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, bool>(5)?,
                        row.get::<_, bool>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, String>(11)?,
                        row.get::<_, String>(12)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| IntegratorError::NotFound(format!("task {task_id}")))?;
        parse_task_row(row)
    }

    pub fn set_setting(&self, key: &str, value: Value) -> Result<Setting> {
        validate_setting_key(key)?;
        let setting = Setting {
            key: key.to_owned(),
            value,
            updated_at: Utc::now(),
        };
        let value_json = serde_json::to_string(&setting.value)?;
        self.connection
            .lock()
            .execute(
                "INSERT INTO settings(key, value_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
                params![setting.key, value_json, setting.updated_at.to_rfc3339()],
            )
            .map_err(storage_error)?;
        Ok(setting)
    }

    pub fn list_settings(&self) -> Result<Vec<Setting>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare("SELECT key, value_json, updated_at FROM settings ORDER BY key")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(storage_error)?;
        rows.map(|row| {
            let (key, json, updated_at) = row.map_err(storage_error)?;
            Ok(Setting {
                key,
                value: serde_json::from_str(&json)?,
                updated_at: parse_time(&updated_at)?,
            })
        })
        .collect()
    }

    pub fn upsert_provider_session(&self, session: &ProviderSession) -> Result<()> {
        if session.provider_thread_id.trim().is_empty() {
            return Err(IntegratorError::InvalidInput(
                "provider thread id cannot be empty".into(),
            ));
        }
        self.connection
            .lock()
            .execute(
                "INSERT INTO provider_sessions(id, task_id, provider, provider_thread_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(provider, provider_thread_id) DO UPDATE SET task_id = excluded.task_id, updated_at = excluded.updated_at",
                params![
                    session.id.to_string(), session.task_id.to_string(), session.provider.as_str(),
                    session.provider_thread_id, session.created_at.to_rfc3339(), session.updated_at.to_rfc3339(),
                ],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    pub fn insert_runtime_session(&self, session: &RuntimeSession) -> Result<()> {
        self.connection
            .lock()
            .execute(
                "INSERT INTO runtime_sessions(id, task_id, provider_session_id, process_id, status, started_at, ended_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    session.id.to_string(), session.task_id.to_string(), session.provider_session_id.map(|id| id.to_string()),
                    session.process_id, session.status, session.started_at.to_rfc3339(), session.ended_at.map(|time| time.to_rfc3339()),
                ],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    pub fn export(&self) -> Result<LocalExport> {
        Ok(LocalExport {
            schema_version: integrator_core::DOMAIN_SCHEMA_VERSION,
            exported_at: Utc::now(),
            projects: self.list_trusted_projects()?,
            tasks: self.list_tasks()?,
            settings: self.list_settings()?,
            provider_sessions: self.list_provider_sessions()?,
            runtime_sessions: self.list_runtime_sessions()?,
        })
    }

    pub fn list_provider_sessions(&self) -> Result<Vec<ProviderSession>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare("SELECT id, task_id, provider, provider_thread_id, created_at, updated_at FROM provider_sessions ORDER BY updated_at DESC")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(storage_error)?;
        rows.map(|row| {
            let (id, task_id, provider, thread, created, updated) = row.map_err(storage_error)?;
            Ok(ProviderSession {
                id: ProviderSessionId::from_str(&id).map_err(invalid_stored)?,
                task_id: TaskId::from_str(&task_id).map_err(invalid_stored)?,
                provider: ProviderKind::from_str(&provider)?,
                provider_thread_id: thread,
                created_at: parse_time(&created)?,
                updated_at: parse_time(&updated)?,
            })
        })
        .collect()
    }

    pub fn list_runtime_sessions(&self) -> Result<Vec<RuntimeSession>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare("SELECT id, task_id, provider_session_id, process_id, status, started_at, ended_at FROM runtime_sessions ORDER BY started_at DESC")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(storage_error)?;
        rows.map(|row| {
            let (id, task_id, provider_session_id, process_id, status, started, ended) =
                row.map_err(storage_error)?;
            Ok(RuntimeSession {
                id: RuntimeSessionId::from_str(&id).map_err(invalid_stored)?,
                task_id: TaskId::from_str(&task_id).map_err(invalid_stored)?,
                provider_session_id: provider_session_id
                    .map(|id| ProviderSessionId::from_str(&id).map_err(invalid_stored))
                    .transpose()?,
                process_id,
                status,
                started_at: parse_time(&started)?,
                ended_at: ended.map(|time| parse_time(&time)).transpose()?,
            })
        })
        .collect()
    }
}

#[allow(clippy::type_complexity)]
fn parse_task_row(
    row: (
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        bool,
        bool,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
    ),
) -> Result<Task> {
    let (
        id,
        title,
        repository,
        worktree,
        state,
        pinned,
        archived,
        runtime,
        model,
        effort,
        parent_task_id,
        created,
        updated,
    ) = row;
    Ok(Task {
        id: TaskId::from_str(&id).map_err(invalid_stored)?,
        title,
        repository_path: repository.map(Into::into),
        worktree_path: worktree.map(Into::into),
        state: TaskState::from_str(&state)?,
        pinned,
        archived,
        runtime,
        model,
        effort,
        parent_task_id: parent_task_id
            .as_deref()
            .map(TaskId::from_str)
            .transpose()
            .map_err(invalid_stored)?,
        created_at: parse_time(&created)?,
        updated_at: parse_time(&updated)?,
    })
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

fn validate_setting_key(key: &str) -> Result<()> {
    let normalized = key.trim().to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.len() > 120
        || !normalized.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err(IntegratorError::InvalidInput("invalid setting key".into()));
    }
    if [
        "secret",
        "token",
        "password",
        "credential",
        "api_key",
        "apikey",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
    {
        return Err(IntegratorError::InvalidInput(
            "credentials cannot be stored as application settings".into(),
        ));
    }
    Ok(())
}

fn path_text(path: Option<&Path>) -> Option<String> {
    path.map(|value| value.to_string_lossy().into_owned())
}

fn parse_time(value: &str) -> Result<DateTime<Utc>> {
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
mod tests {
    use super::*;

    #[test]
    fn migration_and_local_round_trip() {
        let store = LocalStore::open_in_memory().expect("open store");
        let task = store
            .create_task(NewTask {
                title: "Implement adapter".into(),
                repository_path: Some("C:/repo".into()),
                worktree_path: Some("C:/worktree".into()),
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create task");
        store
            .update_task_state(task.id, TaskState::Running)
            .expect("update task");
        store
            .update_task_metadata(
                task.id,
                Some("Renamed chat".into()),
                Some(true),
                Some(false),
            )
            .expect("update task metadata");
        store
            .update_task_routing(task.id, "cursor", "composer-2.5", Some("high"))
            .expect("update task routing");
        store
            .set_setting("appearance.theme", Value::String("graphite".into()))
            .expect("set setting");
        let exported = store.export().expect("export");
        assert_eq!(exported.tasks.len(), 1);
        assert_eq!(exported.tasks[0].state, TaskState::Running);
        assert_eq!(exported.tasks[0].title, "Renamed chat");
        assert_eq!(exported.tasks[0].runtime.as_deref(), Some("cursor"));
        assert_eq!(exported.tasks[0].model.as_deref(), Some("composer-2.5"));
        assert_eq!(exported.tasks[0].effort.as_deref(), Some("high"));
        assert!(exported.tasks[0].pinned);
        assert!(!exported.tasks[0].archived);
        assert_eq!(exported.settings.len(), 1);

        let usage_rows = store.provider_usage_rows().expect("provider usage rows");
        assert_eq!(usage_rows.len(), 1);
        assert_eq!(usage_rows[0].0, "cursor");
        assert_eq!(usage_rows[0].1, 1);
        assert_eq!(usage_rows[0].2, 0);
        assert_eq!(usage_rows[0].3.total_tokens, 0);
    }

    #[test]
    fn clear_all_data_preserves_schema_and_migration_history() {
        let store = LocalStore::open_in_memory().expect("open store");
        let task = store
            .create_task(NewTask {
                title: "Clearable task".into(),
                repository_path: None,
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create task");
        store
            .set_setting("appearance.theme", Value::String("graphite".into()))
            .expect("set setting");
        let directory = tempfile::tempdir().expect("temp directory");
        store
            .upsert_trusted_project(
                "Clearable project",
                directory.path(),
                &directory.path().join(".git"),
            )
            .expect("register project");
        let now = Utc::now();
        let provider_session = ProviderSession {
            id: ProviderSessionId::new(),
            task_id: task.id,
            provider: ProviderKind::Codex,
            provider_thread_id: "clearable-thread".into(),
            created_at: now,
            updated_at: now,
        };
        store
            .upsert_provider_session(&provider_session)
            .expect("provider session");
        store
            .insert_runtime_session(&RuntimeSession {
                id: RuntimeSessionId::new(),
                task_id: task.id,
                provider_session_id: Some(provider_session.id),
                process_id: Some("clearable-process".into()),
                status: "completed".into(),
                started_at: now,
                ended_at: Some(now),
            })
            .expect("runtime session");

        store.clear_all_data().expect("clear local data");

        let export = store.export().expect("export after clear");
        assert!(export.projects.is_empty());
        assert!(export.tasks.is_empty());
        assert!(export.settings.is_empty());
        assert!(export.provider_sessions.is_empty());
        assert!(export.runtime_sessions.is_empty());

        let connection = store.connection.lock();
        let migration_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .expect("migration history");
        assert_eq!(migration_count, MIGRATIONS.len() as i64);
        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign key setting");
        assert_eq!(foreign_keys, 1);
        drop(connection);

        store
            .create_task(NewTask {
                title: "Schema remains usable".into(),
                repository_path: None,
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create task after clear");
    }

    #[test]
    fn credentials_are_rejected_from_settings() {
        let store = LocalStore::open_in_memory().expect("open store");
        let error = store
            .set_setting(
                "provider.api_token",
                Value::String("not-a-real-token".into()),
            )
            .expect_err("credential key must fail");
        assert!(error.to_string().contains("credentials"));
    }

    #[test]
    fn database_reopens_after_migration() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("integrator.sqlite3");
        LocalStore::open(&path).expect("first open");
        LocalStore::open(&path).expect("second open");
    }

    #[test]
    fn provider_and_runtime_sessions_are_exported() {
        let store = LocalStore::open_in_memory().expect("open store");
        let task = store
            .create_task(NewTask {
                title: "Persist a provider session".into(),
                repository_path: None,
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create task");
        let now = Utc::now();
        let provider_session = ProviderSession {
            id: ProviderSessionId::new(),
            task_id: task.id,
            provider: ProviderKind::Codex,
            provider_thread_id: "thread-fixture".into(),
            created_at: now,
            updated_at: now,
        };
        store
            .upsert_provider_session(&provider_session)
            .expect("provider session");
        store
            .insert_runtime_session(&RuntimeSession {
                id: RuntimeSessionId::new(),
                task_id: task.id,
                provider_session_id: Some(provider_session.id),
                process_id: Some("process-fixture".into()),
                status: "completed".into(),
                started_at: now,
                ended_at: Some(now),
            })
            .expect("runtime session");

        let export = store.export().expect("export");
        assert_eq!(export.provider_sessions.len(), 1);
        assert_eq!(export.runtime_sessions.len(), 1);
    }

    #[test]
    fn trusted_projects_persist_across_reopen_and_export() {
        let directory = tempfile::tempdir().expect("temp directory");
        let database = directory.path().join("integrator.sqlite3");
        let repository = directory.path().join("repository");
        let common = repository.join(".git");
        std::fs::create_dir_all(&common).expect("fixture directories");

        let first = LocalStore::open(&database).expect("first open");
        let registered = first
            .upsert_trusted_project("Repository", &repository, &common)
            .expect("register project");
        drop(first);

        let reopened = LocalStore::open(&database).expect("reopen");
        let projects = reopened.list_trusted_projects().expect("list projects");
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, registered.id);
        assert_eq!(projects[0].repository_root, repository);
        assert_eq!(reopened.export().expect("export").projects, projects);
        reopened
            .remove_trusted_project(registered.id)
            .expect("remove trust record");
        assert!(
            reopened
                .list_trusted_projects()
                .expect("list after removal")
                .is_empty()
        );
        assert!(
            repository.exists(),
            "removal must never delete repository data"
        );
    }
}
