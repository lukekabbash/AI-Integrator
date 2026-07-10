#![forbid(unsafe_code)]

use std::{
    path::{Path, PathBuf},
    str::FromStr,
};

use chrono::{DateTime, Utc};
use integrator_core::{
    IntegratorError, LocalExport, NewTask, ProjectId, ProviderKind, ProviderSession,
    ProviderSessionId, Result, RuntimeSession, RuntimeSessionId, Setting, Task, TaskId, TaskState,
    TrustedProject,
};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

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
            created_at: now,
            updated_at: now,
        };
        self.connection
            .lock()
            .execute(
                "INSERT INTO tasks(id, title, repository_path, worktree_path, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    task.id.to_string(),
                    task.title,
                    path_text(task.repository_path.as_deref()),
                    path_text(task.worktree_path.as_deref()),
                    task.state.as_str(),
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
            .prepare("SELECT id, title, repository_path, worktree_path, state, created_at, updated_at FROM tasks ORDER BY updated_at DESC")
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
                    row.get::<_, String>(6)?,
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

    pub fn get_task(&self, task_id: TaskId) -> Result<Task> {
        let connection = self.connection.lock();
        let row = connection
            .query_row(
                "SELECT id, title, repository_path, worktree_path, state, created_at, updated_at FROM tasks WHERE id = ?1",
                [task_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?,
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
                "INSERT INTO runtime_sessions(id, task_id, provider_session_id, status, started_at, ended_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    session.id.to_string(), session.task_id.to_string(), session.provider_session_id.map(|id| id.to_string()),
                    session.status, session.started_at.to_rfc3339(), session.ended_at.map(|time| time.to_rfc3339()),
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
            .prepare("SELECT id, task_id, provider_session_id, status, started_at, ended_at FROM runtime_sessions ORDER BY started_at DESC")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(storage_error)?;
        rows.map(|row| {
            let (id, task_id, provider_session_id, status, started, ended) =
                row.map_err(storage_error)?;
            Ok(RuntimeSession {
                id: RuntimeSessionId::from_str(&id).map_err(invalid_stored)?,
                task_id: TaskId::from_str(&task_id).map_err(invalid_stored)?,
                provider_session_id: provider_session_id
                    .map(|id| ProviderSessionId::from_str(&id).map_err(invalid_stored))
                    .transpose()?,
                status,
                started_at: parse_time(&started)?,
                ended_at: ended.map(|time| parse_time(&time)).transpose()?,
            })
        })
        .collect()
    }
}

fn parse_task_row(
    row: (
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
        String,
    ),
) -> Result<Task> {
    let (id, title, repository, worktree, state, created, updated) = row;
    Ok(Task {
        id: TaskId::from_str(&id).map_err(invalid_stored)?,
        title,
        repository_path: repository.map(Into::into),
        worktree_path: worktree.map(Into::into),
        state: TaskState::from_str(&state)?,
        created_at: parse_time(&created)?,
        updated_at: parse_time(&updated)?,
    })
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
            })
            .expect("create task");
        store
            .update_task_state(task.id, TaskState::Running)
            .expect("update task");
        store
            .set_setting("appearance.theme", Value::String("graphite".into()))
            .expect("set setting");
        let exported = store.export().expect("export");
        assert_eq!(exported.tasks.len(), 1);
        assert_eq!(exported.tasks[0].state, TaskState::Running);
        assert_eq!(exported.settings.len(), 1);
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
