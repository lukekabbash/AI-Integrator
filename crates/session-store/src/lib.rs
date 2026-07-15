#![forbid(unsafe_code)]

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    str::FromStr,
};

use chrono::{DateTime, Utc};
use integrator_core::{
    ComposerDraft, ComposerDraftAttachment, ComposerDraftOwner, IntegratorError, LocalExport,
    NewQueuedMessage, NewTask, ProjectId, ProviderKind, ProviderSession, ProviderSessionId,
    QueuedMessage, QueuedMessageId, QueuedMessageState, Result, RuntimeSession, RuntimeSessionId,
    Setting, Task, TaskId, TaskState, TrustedProject, UsageProjection,
};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

mod delegation_store;
mod projection_store;
pub use delegation_store::NewDelegation;
pub use projection_store::{PersistedStopRequest, PreparedApprovalResponse};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommitMessageGenerationClaim {
    Claimed,
    Cached(String),
    InProgress,
}

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
    (
        7,
        r#"
        CREATE VIRTUAL TABLE codex_items_fts USING fts5(
            body,
            task_id UNINDEXED,
            item_id UNINDEXED,
            content='codex_items',
            content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
        );
        INSERT INTO codex_items_fts(rowid, body, task_id, item_id)
            SELECT rowid, body, task_id, item_id
            FROM codex_items
            WHERE kind IN ('user_message', 'agent_message')
              AND status IN ('completed', 'failed', 'declined')
              AND body IS NOT NULL
              AND trim(body) <> '';

        CREATE TRIGGER codex_items_fts_insert AFTER INSERT ON codex_items
        WHEN new.kind IN ('user_message', 'agent_message')
          AND new.status IN ('completed', 'failed', 'declined')
          AND new.body IS NOT NULL
          AND trim(new.body) <> ''
        BEGIN
            INSERT INTO codex_items_fts(rowid, body, task_id, item_id)
            VALUES (new.rowid, new.body, new.task_id, new.item_id);
        END;

        CREATE TRIGGER codex_items_fts_delete AFTER DELETE ON codex_items
        WHEN old.kind IN ('user_message', 'agent_message')
          AND old.status IN ('completed', 'failed', 'declined')
          AND old.body IS NOT NULL
          AND trim(old.body) <> ''
        BEGIN
            INSERT INTO codex_items_fts(codex_items_fts, rowid, body, task_id, item_id)
            VALUES ('delete', old.rowid, old.body, old.task_id, old.item_id);
        END;

        CREATE TRIGGER codex_items_fts_update_delete AFTER UPDATE ON codex_items
        WHEN old.kind IN ('user_message', 'agent_message')
          AND old.status IN ('completed', 'failed', 'declined')
          AND old.body IS NOT NULL
          AND trim(old.body) <> ''
        BEGIN
            INSERT INTO codex_items_fts(codex_items_fts, rowid, body, task_id, item_id)
            VALUES ('delete', old.rowid, old.body, old.task_id, old.item_id);
        END;

        CREATE TRIGGER codex_items_fts_update_insert AFTER UPDATE ON codex_items
        WHEN new.kind IN ('user_message', 'agent_message')
          AND new.status IN ('completed', 'failed', 'declined')
          AND new.body IS NOT NULL
          AND trim(new.body) <> ''
        BEGIN
            INSERT INTO codex_items_fts(rowid, body, task_id, item_id)
            VALUES (new.rowid, new.body, new.task_id, new.item_id);
        END;
        "#,
    ),
    (
        8,
        r#"
        ALTER TABLE codex_turns ADD COLUMN first_event_seq INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE codex_turns ADD COLUMN first_occurred_at TEXT;
        ALTER TABLE codex_turns ADD COLUMN snapshot_event_json TEXT;

        ALTER TABLE codex_items ADD COLUMN first_event_seq INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE codex_items ADD COLUMN first_occurred_at TEXT;
        ALTER TABLE codex_items ADD COLUMN snapshot_event_json TEXT;

        ALTER TABLE codex_approvals ADD COLUMN first_event_seq INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE codex_approvals ADD COLUMN first_occurred_at TEXT;
        ALTER TABLE codex_approvals ADD COLUMN snapshot_event_json TEXT;

        DROP TRIGGER codex_items_fts_update_delete;
        DROP TRIGGER codex_items_fts_update_insert;
        CREATE TRIGGER codex_items_fts_update_delete BEFORE UPDATE ON codex_items
        WHEN old.kind IN ('user_message', 'agent_message')
          AND old.status IN ('completed', 'failed', 'declined')
          AND old.body IS NOT NULL
          AND trim(old.body) <> ''
        BEGIN
            INSERT INTO codex_items_fts(codex_items_fts, rowid, body, task_id, item_id)
            VALUES ('delete', old.rowid, old.body, old.task_id, old.item_id);
        END;
        CREATE TRIGGER codex_items_fts_update_insert AFTER UPDATE ON codex_items
        WHEN new.kind IN ('user_message', 'agent_message')
          AND new.status IN ('completed', 'failed', 'declined')
          AND new.body IS NOT NULL
          AND trim(new.body) <> ''
        BEGIN
            INSERT INTO codex_items_fts(rowid, body, task_id, item_id)
            VALUES (new.rowid, new.body, new.task_id, new.item_id);
        END;

        ALTER TABLE codex_task_projection ADD COLUMN plan_event_json TEXT;
        ALTER TABLE codex_task_projection ADD COLUMN turn_seq INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE codex_task_projection ADD COLUMN turn_event_json TEXT;
        ALTER TABLE codex_task_projection ADD COLUMN diff_event_json TEXT;
        ALTER TABLE codex_task_projection ADD COLUMN usage_event_json TEXT;
        ALTER TABLE codex_task_projection ADD COLUMN mode_seq INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE codex_task_projection ADD COLUMN mode_event_json TEXT;
        ALTER TABLE codex_task_projection ADD COLUMN error_seq INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE codex_task_projection ADD COLUMN error_event_json TEXT;
        ALTER TABLE codex_task_projection ADD COLUMN connection_event_json TEXT;
        ALTER TABLE codex_task_projection ADD COLUMN reset_seq INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE codex_task_projection ADD COLUMN reset_event_json TEXT;

        CREATE INDEX codex_turns_task_snapshot_idx
            ON codex_turns(task_id, last_event_seq);
        CREATE INDEX codex_items_task_snapshot_idx
            ON codex_items(task_id, last_event_seq);
        CREATE INDEX codex_approvals_task_snapshot_idx
            ON codex_approvals(task_id, last_event_seq);

        -- Normalize the append-only projection history once for this migration.
        -- The previous backfill repeatedly parsed JSON while scanning the same
        -- task history once per materialized row, making startup quadratic.
        CREATE TEMP TABLE integrator_projection_event_backfill (
            seq INTEGER PRIMARY KEY,
            task_id TEXT NOT NULL,
            provider_session_id TEXT NOT NULL,
            turn_id TEXT,
            occurred_at TEXT NOT NULL,
            event_kind TEXT,
            item_id TEXT,
            approval_id TEXT
        );
        INSERT INTO integrator_projection_event_backfill(
            seq,task_id,provider_session_id,turn_id,occurred_at,
            event_kind,item_id,approval_id
        )
        SELECT seq,task_id,provider_session_id,turn_id,occurred_at,
               json_extract(projection_json, '$.projection.kind'),
               json_extract(projection_json, '$.projection.item.id'),
               json_extract(projection_json, '$.projection.approval.id')
        FROM codex_event_log
        WHERE projection_json IS NOT NULL;
        CREATE INDEX integrator_projection_event_task_kind_idx
            ON integrator_projection_event_backfill(task_id,event_kind,seq);
        CREATE INDEX integrator_projection_event_turn_idx
            ON integrator_projection_event_backfill(provider_session_id,event_kind,turn_id,seq);
        CREATE INDEX integrator_projection_event_item_idx
            ON integrator_projection_event_backfill(provider_session_id,event_kind,item_id,seq);
        CREATE INDEX integrator_projection_event_approval_idx
            ON integrator_projection_event_backfill(task_id,event_kind,approval_id,seq);

        UPDATE codex_task_projection
        SET reset_seq = COALESCE((
                SELECT MAX(e.seq)
                FROM integrator_projection_event_backfill e
                WHERE e.task_id = codex_task_projection.task_id
                  AND e.event_kind = 'projectionReset'
            ), 0);
        UPDATE codex_task_projection
        SET reset_event_json = (
                SELECT e.projection_json
                FROM codex_event_log e
                WHERE e.seq = codex_task_projection.reset_seq
            )
        WHERE reset_seq > 0;

        DELETE FROM codex_turns
        WHERE last_event_seq <= COALESCE((
            SELECT p.reset_seq FROM codex_task_projection p
            WHERE p.task_id = codex_turns.task_id
        ), 0);
        DELETE FROM codex_items
        WHERE last_event_seq <= COALESCE((
            SELECT p.reset_seq FROM codex_task_projection p
            WHERE p.task_id = codex_items.task_id
        ), 0);
        DELETE FROM codex_approvals
        WHERE last_event_seq <= COALESCE((
            SELECT p.reset_seq FROM codex_task_projection p
            WHERE p.task_id = codex_approvals.task_id
        ), 0);

        UPDATE codex_turns
        SET first_event_seq = COALESCE((
                SELECT MIN(e.seq)
                FROM integrator_projection_event_backfill e
                WHERE e.task_id = codex_turns.task_id
                  AND e.provider_session_id = codex_turns.provider_session_id
                  AND e.turn_id = codex_turns.turn_id
                  AND e.seq > COALESCE((
                      SELECT p.reset_seq FROM codex_task_projection p
                      WHERE p.task_id = codex_turns.task_id
                  ), 0)
                  AND e.event_kind = 'turnChanged'
            ), last_event_seq),
            first_occurred_at = COALESCE((
                SELECT e.occurred_at
                FROM integrator_projection_event_backfill e
                WHERE e.task_id = codex_turns.task_id
                  AND e.provider_session_id = codex_turns.provider_session_id
                  AND e.turn_id = codex_turns.turn_id
                  AND e.seq > COALESCE((
                      SELECT p.reset_seq FROM codex_task_projection p
                      WHERE p.task_id = codex_turns.task_id
                  ), 0)
                  AND e.event_kind = 'turnChanged'
                ORDER BY e.seq LIMIT 1
            ), started_at, completed_at),
            snapshot_event_json = (
                SELECT e.projection_json FROM codex_event_log e
                WHERE e.seq = codex_turns.last_event_seq
            );

        UPDATE codex_items
        SET first_event_seq = COALESCE((
                SELECT MIN(e.seq)
                FROM integrator_projection_event_backfill e
                WHERE e.task_id = codex_items.task_id
                  AND e.provider_session_id = codex_items.provider_session_id
                  AND e.seq > COALESCE((
                      SELECT p.reset_seq FROM codex_task_projection p
                      WHERE p.task_id = codex_items.task_id
                  ), 0)
                  AND e.event_kind = 'itemChanged'
                  AND e.item_id = codex_items.stable_id
            ), last_event_seq),
            first_occurred_at = COALESCE((
                SELECT e.occurred_at
                FROM integrator_projection_event_backfill e
                WHERE e.task_id = codex_items.task_id
                  AND e.provider_session_id = codex_items.provider_session_id
                  AND e.seq > COALESCE((
                      SELECT p.reset_seq FROM codex_task_projection p
                      WHERE p.task_id = codex_items.task_id
                  ), 0)
                  AND e.event_kind = 'itemChanged'
                  AND e.item_id = codex_items.stable_id
                ORDER BY e.seq LIMIT 1
            ), updated_at),
            snapshot_event_json = json_set((
                SELECT e.projection_json FROM codex_event_log e
                WHERE e.seq = codex_items.last_event_seq
            ), '$.occurredAt', COALESCE((
                SELECT e.occurred_at
                FROM integrator_projection_event_backfill e
                WHERE e.task_id = codex_items.task_id
                  AND e.provider_session_id = codex_items.provider_session_id
                  AND e.seq > COALESCE((
                      SELECT p.reset_seq FROM codex_task_projection p
                      WHERE p.task_id = codex_items.task_id
                  ), 0)
                  AND e.event_kind = 'itemChanged'
                  AND e.item_id = codex_items.stable_id
                ORDER BY e.seq LIMIT 1
            ), updated_at));

        UPDATE codex_approvals
        SET first_event_seq = COALESCE((
                SELECT MIN(e.seq)
                FROM integrator_projection_event_backfill e
                WHERE e.task_id = codex_approvals.task_id
                  AND e.seq > COALESCE((
                      SELECT p.reset_seq FROM codex_task_projection p
                      WHERE p.task_id = codex_approvals.task_id
                  ), 0)
                  AND e.event_kind = 'approvalChanged'
                  AND e.approval_id = codex_approvals.id
            ), last_event_seq),
            first_occurred_at = COALESCE((
                SELECT e.occurred_at
                FROM integrator_projection_event_backfill e
                WHERE e.task_id = codex_approvals.task_id
                  AND e.seq > COALESCE((
                      SELECT p.reset_seq FROM codex_task_projection p
                      WHERE p.task_id = codex_approvals.task_id
                  ), 0)
                  AND e.event_kind = 'approvalChanged'
                  AND e.approval_id = codex_approvals.id
                ORDER BY e.seq LIMIT 1
            ), updated_at),
            snapshot_event_json = json_set((
                SELECT e.projection_json FROM codex_event_log e
                WHERE e.seq = codex_approvals.last_event_seq
            ), '$.occurredAt', COALESCE((
                SELECT e.occurred_at
                FROM integrator_projection_event_backfill e
                WHERE e.task_id = codex_approvals.task_id
                  AND e.seq > COALESCE((
                      SELECT p.reset_seq FROM codex_task_projection p
                      WHERE p.task_id = codex_approvals.task_id
                  ), 0)
                  AND e.event_kind = 'approvalChanged'
                  AND e.approval_id = codex_approvals.id
                ORDER BY e.seq LIMIT 1
            ), updated_at));

        UPDATE codex_task_projection
        SET turn_seq = COALESCE((
                SELECT MAX(e.seq) FROM integrator_projection_event_backfill e
                WHERE e.task_id = codex_task_projection.task_id
                  AND e.seq > codex_task_projection.reset_seq
                  AND e.event_kind = 'turnChanged'
            ), 0),
            plan_event_json = (SELECT projection_json FROM codex_event_log WHERE seq = plan_seq),
            diff_event_json = (SELECT projection_json FROM codex_event_log WHERE seq = diff_seq),
            usage_event_json = (SELECT projection_json FROM codex_event_log WHERE seq = usage_seq),
            connection_event_json = (SELECT projection_json FROM codex_event_log WHERE seq = connection_seq),
            mode_seq = COALESCE((
                SELECT MAX(e.seq) FROM integrator_projection_event_backfill e
                WHERE e.task_id = codex_task_projection.task_id
                  AND e.seq > codex_task_projection.reset_seq
                  AND e.event_kind = 'modeChanged'
            ), 0),
            error_seq = COALESCE((
                SELECT MAX(e.seq) FROM integrator_projection_event_backfill e
                WHERE e.task_id = codex_task_projection.task_id
                  AND e.seq > codex_task_projection.reset_seq
                  AND e.event_kind = 'turnError'
            ), 0);
        UPDATE codex_task_projection
        SET turn_event_json = (SELECT projection_json FROM codex_event_log WHERE seq = turn_seq),
            mode_event_json = (SELECT projection_json FROM codex_event_log WHERE seq = mode_seq),
            error_event_json = (SELECT projection_json FROM codex_event_log WHERE seq = error_seq);
        DROP TABLE integrator_projection_event_backfill;
        "#,
    ),
    (
        9,
        r#"
        CREATE INDEX codex_items_provider_stable_seq_idx
            ON codex_items(provider_session_id, stable_id, last_event_seq DESC);
        CREATE INDEX codex_approvals_active_process_idx
            ON codex_approvals(process_id)
            WHERE state IN ('pending', 'responding', 'response_failed');
        "#,
    ),
    (
        10,
        r#"
        CREATE TABLE task_title_jobs (
            task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
            started_at TEXT NOT NULL
        );
        "#,
    ),
    (
        11,
        r#"
        CREATE TABLE commit_message_jobs (
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            diff_fingerprint TEXT NOT NULL,
            message TEXT,
            started_at TEXT NOT NULL,
            PRIMARY KEY(task_id, provider, diff_fingerprint)
        );
        "#,
    ),
    (
        12,
        r#"
        CREATE TABLE composer_drafts (
            draft_key TEXT PRIMARY KEY,
            project_id TEXT REFERENCES trusted_projects(id) ON DELETE CASCADE,
            task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
            prompt TEXT NOT NULL,
            attachments_json TEXT NOT NULL,
            runtime TEXT NOT NULL,
            model TEXT NOT NULL,
            effort TEXT,
            permission TEXT NOT NULL,
            delegation TEXT NOT NULL,
            selection_start INTEGER NOT NULL,
            selection_end INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK ((project_id IS NOT NULL AND task_id IS NULL) OR
                   (project_id IS NULL AND task_id IS NOT NULL))
        );
        CREATE UNIQUE INDEX composer_drafts_project_idx
            ON composer_drafts(project_id) WHERE project_id IS NOT NULL;
        CREATE UNIQUE INDEX composer_drafts_task_idx
            ON composer_drafts(task_id) WHERE task_id IS NOT NULL;
        "#,
    ),
    (
        13,
        r#"
        CREATE TABLE project_git_repositories (
            project_id TEXT PRIMARY KEY REFERENCES trusted_projects(id) ON DELETE CASCADE,
            repository_root TEXT NOT NULL,
            git_common_directory TEXT NOT NULL
        );
        INSERT INTO project_git_repositories(project_id, repository_root, git_common_directory)
            SELECT id, repository_root, git_common_directory FROM trusted_projects;
        CREATE INDEX project_git_repositories_common_dir_idx
            ON project_git_repositories(git_common_directory);
        "#,
    ),
    (
        14,
        r#"
        CREATE TABLE queued_messages (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            prompt TEXT NOT NULL,
            attachments_json TEXT NOT NULL,
            runtime TEXT NOT NULL,
            model TEXT NOT NULL,
            effort TEXT,
            permission TEXT NOT NULL,
            delegation TEXT NOT NULL,
            native_action_id TEXT,
            position INTEGER NOT NULL,
            state TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(task_id, position)
        );
        CREATE INDEX queued_messages_task_state_position_idx
            ON queued_messages(task_id, state, position);
        "#,
    ),
    (
        15,
        r#"
        ALTER TABLE delegations ADD COLUMN permission TEXT NOT NULL DEFAULT 'project-write'
            CHECK (permission IN ('read-only', 'project-write'));
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
                "DELETE FROM queued_messages;
                 DELETE FROM composer_drafts;
                 DELETE FROM delegation_messages;
                 DELETE FROM delegations;
                 DELETE FROM codex_event_log;
                 DELETE FROM codex_approvals;
                 DELETE FROM codex_items;
                 DELETE FROM codex_turns;
                 DELETE FROM codex_task_projection;
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
                    (current, next) => Some(current.unwrap_or(0).saturating_add(next.unwrap_or(0))),
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
        let task = build_task(input)?;
        insert_task_row(&self.connection.lock(), &task)?;
        Ok(task)
    }

    /// Creates the first durable task and moves its project-level new-chat
    /// draft in the same transaction. A crash can therefore leave the draft
    /// on either side of this boundary, but never detached from both owners.
    pub fn create_task_with_project_draft(
        &self,
        input: NewTask,
        draft: ComposerDraft,
    ) -> Result<Task> {
        let task = build_task(input)?;
        let draft = normalize_composer_draft(draft)?;
        let project_id = match draft.owner {
            ComposerDraftOwner::NewChat { project_id } => project_id,
            ComposerDraftOwner::Task { .. } => {
                return Err(IntegratorError::InvalidInput(
                    "only a new-chat draft can be promoted while creating a task".into(),
                ));
            }
        };
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let project_root = transaction
            .query_row(
                "SELECT repository_root FROM trusted_projects WHERE id = ?1",
                [project_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| IntegratorError::NotFound(format!("project {project_id}")))?;
        if task.repository_path.as_deref() != Some(Path::new(&project_root)) {
            return Err(IntegratorError::InvalidInput(
                "new-chat draft project does not own the task repository".into(),
            ));
        }
        insert_task_row(&transaction, &task)?;

        let mut task_draft = draft.clone();
        task_draft.owner = ComposerDraftOwner::Task { task_id: task.id };
        write_composer_draft(&transaction, &task_draft)?;

        let mut project_tombstone = draft;
        project_tombstone.prompt.clear();
        project_tombstone.attachments.clear();
        project_tombstone.selection_start = 0;
        project_tombstone.selection_end = 0;
        let (project_draft_key, _, _) = draft_identity(&project_tombstone.owner);
        transaction
            .execute(
                "DELETE FROM composer_drafts WHERE draft_key = ?1 AND revision <= ?2",
                params![project_draft_key, project_tombstone.revision as i64],
            )
            .map_err(storage_error)?;
        write_composer_draft(&transaction, &project_tombstone)?;
        transaction.commit().map_err(storage_error)?;
        Ok(task)
    }

    pub fn upsert_composer_draft(&self, draft: ComposerDraft) -> Result<()> {
        let draft = normalize_composer_draft(draft)?;
        let connection = self.connection.lock();
        ensure_draft_owner(&connection, &draft.owner)?;
        write_composer_draft(&connection, &draft)?;
        Ok(())
    }

    pub fn list_composer_drafts(&self) -> Result<Vec<ComposerDraft>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT project_id, task_id, prompt, attachments_json, runtime, model, effort, permission, delegation, selection_start, selection_end, revision, updated_at FROM composer_drafts ORDER BY updated_at DESC",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, String>(12)?,
                ))
            })
            .map_err(storage_error)?;
        rows.map(|row| {
            let (
                project_id,
                task_id,
                prompt,
                attachments,
                runtime,
                model,
                effort,
                permission,
                delegation,
                selection_start,
                selection_end,
                revision,
                updated_at,
            ) = row.map_err(storage_error)?;
            let owner = match (project_id, task_id) {
                (Some(project_id), None) => ComposerDraftOwner::NewChat {
                    project_id: ProjectId::from_str(&project_id).map_err(invalid_stored)?,
                },
                (None, Some(task_id)) => ComposerDraftOwner::Task {
                    task_id: TaskId::from_str(&task_id).map_err(invalid_stored)?,
                },
                _ => return Err(invalid_stored("composer draft has invalid ownership")),
            };
            Ok(ComposerDraft {
                owner,
                prompt,
                attachments: serde_json::from_str::<Vec<ComposerDraftAttachment>>(&attachments)
                    .map_err(invalid_stored)?,
                runtime,
                model,
                effort,
                permission,
                delegation,
                selection_start: u32::try_from(selection_start).map_err(invalid_stored)?,
                selection_end: u32::try_from(selection_end).map_err(invalid_stored)?,
                revision: u64::try_from(revision).map_err(invalid_stored)?,
                updated_at: parse_time(&updated_at)?,
            })
        })
        .collect()
    }

    pub fn upsert_trusted_project(
        &self,
        display_name: &str,
        project_root: &Path,
        git_repository: Option<(&Path, &Path)>,
    ) -> Result<TrustedProject> {
        let display_name = display_name.trim();
        if display_name.is_empty() || display_name.chars().count() > 120 {
            return Err(IntegratorError::InvalidInput(
                "project display name must contain 1 to 120 characters".into(),
            ));
        }
        if !project_root.is_absolute()
            || git_repository
                .is_some_and(|(root, common)| !root.is_absolute() || !common.is_absolute())
        {
            return Err(IntegratorError::InvalidInput(
                "trusted project paths must be canonical absolute paths".into(),
            ));
        }
        let project_root = project_root.to_string_lossy().into_owned();
        let git_repository = git_repository.map(|(root, common)| {
            (
                root.to_string_lossy().into_owned(),
                common.to_string_lossy().into_owned(),
            )
        });
        let now = Utc::now();
        let connection = self.connection.lock();
        let existing = connection
            .query_row(
                "SELECT id, created_at FROM trusted_projects WHERE repository_root = ?1",
                [&project_root],
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
        let transaction = connection.unchecked_transaction().map_err(storage_error)?;
        // `git_common_directory` remains populated for compatibility with the
        // original table constraint. Authoritative optional Git identity lives
        // in `project_git_repositories` from migration 13 onward.
        let legacy_common = git_repository
            .as_ref()
            .map_or(project_root.as_str(), |(_, common)| common.as_str());
        transaction
            .execute(
                "INSERT INTO trusted_projects(id, display_name, repository_root, git_common_directory, created_at, last_opened_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(repository_root) DO UPDATE SET display_name = excluded.display_name, git_common_directory = excluded.git_common_directory, last_opened_at = excluded.last_opened_at",
                params![id.to_string(), display_name, project_root, legacy_common, created_at.to_rfc3339(), now.to_rfc3339()],
            )
            .map_err(storage_error)?;
        transaction
            .execute(
                "DELETE FROM project_git_repositories WHERE project_id = ?1",
                [id.to_string()],
            )
            .map_err(storage_error)?;
        if let Some((root, common)) = &git_repository {
            transaction
                .execute(
                    "INSERT INTO project_git_repositories(project_id, repository_root, git_common_directory) VALUES (?1, ?2, ?3)",
                    params![id.to_string(), root, common],
                )
                .map_err(storage_error)?;
        }
        transaction.commit().map_err(storage_error)?;
        Ok(TrustedProject {
            id,
            display_name: display_name.to_owned(),
            repository_root: PathBuf::from(project_root),
            git_repository_root: git_repository.as_ref().map(|(root, _)| PathBuf::from(root)),
            git_common_directory: git_repository
                .as_ref()
                .map(|(_, common)| PathBuf::from(common)),
            created_at,
            last_opened_at: now,
        })
    }

    pub fn list_trusted_projects(&self) -> Result<Vec<TrustedProject>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT p.id, p.display_name, p.repository_root, g.repository_root, g.git_common_directory, p.created_at, p.last_opened_at FROM trusted_projects p LEFT JOIN project_git_repositories g ON g.project_id = p.id ORDER BY p.last_opened_at DESC",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(storage_error)?;
        rows.map(|row| {
            let (id, display_name, root, git_root, common, created, opened) =
                row.map_err(storage_error)?;
            Ok(TrustedProject {
                id: ProjectId::from_str(&id).map_err(invalid_stored)?,
                display_name,
                repository_root: PathBuf::from(root),
                git_repository_root: git_root.map(PathBuf::from),
                git_common_directory: common.map(PathBuf::from),
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

    pub fn enqueue_message(&self, input: NewQueuedMessage) -> Result<QueuedMessage> {
        const QUEUE_LIMIT: i64 = 100;
        let input = normalize_queued_message(input)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        ensure_task_exists(&transaction, input.task_id)?;
        let count = transaction
            .query_row(
                "SELECT COUNT(*) FROM queued_messages WHERE task_id = ?1",
                [input.task_id.to_string()],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)?;
        if count >= QUEUE_LIMIT {
            return Err(IntegratorError::Unavailable(
                "a task cannot queue more than 100 messages".into(),
            ));
        }
        let position = transaction
            .query_row(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM queued_messages WHERE task_id = ?1",
                [input.task_id.to_string()],
                |row| row.get::<_, u32>(0),
            )
            .map_err(storage_error)?;
        let now = Utc::now();
        let message = QueuedMessage {
            id: QueuedMessageId::new(),
            task_id: input.task_id,
            prompt: input.prompt,
            attachments: input.attachments,
            runtime: input.runtime,
            model: input.model,
            effort: input.effort,
            permission: input.permission,
            delegation: input.delegation,
            native_action_id: input.native_action_id,
            position,
            state: QueuedMessageState::Queued,
            created_at: now,
            updated_at: now,
        };
        insert_queued_message(&transaction, &message)?;
        transaction.commit().map_err(storage_error)?;
        Ok(message)
    }

    pub fn list_queued_messages(&self, task_id: TaskId) -> Result<Vec<QueuedMessage>> {
        let connection = self.connection.lock();
        ensure_task_exists(&connection, task_id)?;
        let mut statement = connection
            .prepare(
                "SELECT id, task_id, prompt, attachments_json, runtime, model, effort, permission, delegation, native_action_id, position, state, created_at, updated_at FROM queued_messages WHERE task_id = ?1 ORDER BY position, created_at",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([task_id.to_string()], parse_queued_message_row)
            .map_err(storage_error)?;
        rows.map(|row| parse_queued_message(row.map_err(storage_error)?))
            .collect()
    }

    pub fn reorder_queued_messages(
        &self,
        task_id: TaskId,
        ordered_ids: &[QueuedMessageId],
    ) -> Result<Vec<QueuedMessage>> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        ensure_task_exists(&transaction, task_id)?;
        let mut statement = transaction
            .prepare("SELECT id FROM queued_messages WHERE task_id = ?1 ORDER BY position")
            .map_err(storage_error)?;
        let stored_ids = statement
            .query_map([task_id.to_string()], |row| row.get::<_, String>(0))
            .map_err(storage_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        drop(statement);
        let requested_ids = ordered_ids
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let mut stored_set = stored_ids.clone();
        let mut requested_set = requested_ids.clone();
        stored_set.sort_unstable();
        requested_set.sort_unstable();
        requested_set.dedup();
        if stored_set != requested_set || requested_ids.len() != requested_set.len() {
            return Err(IntegratorError::InvalidInput(
                "queued message reorder must contain every task message exactly once".into(),
            ));
        }
        let offset = i64::try_from(stored_ids.len()).unwrap_or(100) + 1;
        transaction
            .execute(
                "UPDATE queued_messages SET position = position + ?1 WHERE task_id = ?2",
                params![offset, task_id.to_string()],
            )
            .map_err(storage_error)?;
        let now = Utc::now().to_rfc3339();
        for (position, id) in ordered_ids.iter().enumerate() {
            transaction
                .execute(
                    "UPDATE queued_messages SET position = ?1, updated_at = ?2 WHERE id = ?3 AND task_id = ?4",
                    params![position as i64, now, id.to_string(), task_id.to_string()],
                )
                .map_err(storage_error)?;
        }
        transaction.commit().map_err(storage_error)?;
        drop(connection);
        self.list_queued_messages(task_id)
    }

    pub fn take_queued_message(
        &self,
        task_id: TaskId,
        message_id: QueuedMessageId,
    ) -> Result<QueuedMessage> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let row = transaction
            .query_row(
                "SELECT id, task_id, prompt, attachments_json, runtime, model, effort, permission, delegation, native_action_id, position, state, created_at, updated_at FROM queued_messages WHERE task_id = ?1 AND id = ?2",
                params![task_id.to_string(), message_id.to_string()],
                parse_queued_message_row,
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| IntegratorError::NotFound(format!("queued message {message_id}")))?;
        let message = parse_queued_message(row)?;
        transaction
            .execute(
                "DELETE FROM queued_messages WHERE task_id = ?1 AND id = ?2",
                params![task_id.to_string(), message_id.to_string()],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(message)
    }

    pub fn set_queued_message_state(
        &self,
        task_id: TaskId,
        message_id: QueuedMessageId,
        state: QueuedMessageState,
    ) -> Result<QueuedMessage> {
        let connection = self.connection.lock();
        let changed = connection
            .execute(
                "UPDATE queued_messages SET state = ?1, updated_at = ?2 WHERE task_id = ?3 AND id = ?4",
                params![
                    state.as_str(),
                    Utc::now().to_rfc3339(),
                    task_id.to_string(),
                    message_id.to_string()
                ],
            )
            .map_err(storage_error)?;
        if changed != 1 {
            return Err(IntegratorError::NotFound(format!(
                "queued message {message_id}"
            )));
        }
        let row = connection
            .query_row(
                "SELECT id, task_id, prompt, attachments_json, runtime, model, effort, permission, delegation, native_action_id, position, state, created_at, updated_at FROM queued_messages WHERE task_id = ?1 AND id = ?2",
                params![task_id.to_string(), message_id.to_string()],
                parse_queued_message_row,
            )
            .map_err(storage_error)?;
        parse_queued_message(row)
    }

    pub fn recover_dispatching_queued_messages(&self) -> Result<usize> {
        self.connection
            .lock()
            .execute(
                "UPDATE queued_messages SET state = 'queued', updated_at = ?1 WHERE state = 'dispatching'",
                [Utc::now().to_rfc3339()],
            )
            .map_err(storage_error)
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

    /// Replace a temporary title only while it still has the expected value.
    /// A concurrent manual rename therefore always wins over background naming.
    pub fn compare_and_set_task_title(
        &self,
        task_id: TaskId,
        expected_title: &str,
        title: &str,
    ) -> Result<Option<Task>> {
        let expected_title = expected_title.trim();
        let title = title.trim();
        if expected_title.is_empty() || expected_title.chars().count() > 240 {
            return Err(IntegratorError::InvalidInput(
                "expected task title must contain 1 to 240 characters".into(),
            ));
        }
        if title.is_empty() || title.chars().count() > 240 {
            return Err(IntegratorError::InvalidInput(
                "task title must contain 1 to 240 characters".into(),
            ));
        }
        let now = Utc::now();
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE tasks SET title = ?1, updated_at = ?2 WHERE id = ?3 AND title = ?4",
                params![title, now.to_rfc3339(), task_id.to_string(), expected_title],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            self.get_task(task_id)?;
            return Ok(None);
        }
        self.get_task(task_id).map(Some)
    }

    /// Persistently claim the one automatic naming attempt allowed for a task.
    /// The insert is conditional on the placeholder still being present, so a
    /// renderer retry, app restart, or concurrent manual rename cannot spend a
    /// second provider call.
    pub fn claim_task_title_generation(
        &self,
        task_id: TaskId,
        expected_title: &str,
    ) -> Result<bool> {
        let expected_title = expected_title.trim();
        if expected_title.is_empty() || expected_title.chars().count() > 240 {
            return Err(IntegratorError::InvalidInput(
                "expected task title must contain 1 to 240 characters".into(),
            ));
        }
        let changed = self
            .connection
            .lock()
            .execute(
                "INSERT OR IGNORE INTO task_title_jobs(task_id, started_at) SELECT id, ?1 FROM tasks WHERE id = ?2 AND title = ?3",
                params![Utc::now().to_rfc3339(), task_id.to_string(), expected_title],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            self.get_task(task_id)?;
        }
        Ok(changed == 1)
    }

    /// Claim one provider call for a specific staged-diff snapshot. Completed
    /// results are reused, while an unfinished claim fails closed so retries or
    /// concurrent clicks cannot multiply provider spend.
    pub fn claim_commit_message_generation(
        &self,
        task_id: TaskId,
        provider: &str,
        diff_fingerprint: &str,
    ) -> Result<CommitMessageGenerationClaim> {
        let provider = provider.trim();
        let diff_fingerprint = diff_fingerprint.trim();
        if provider.is_empty() || provider.chars().count() > 64 {
            return Err(IntegratorError::InvalidInput(
                "commit-message provider must contain 1 to 64 characters".into(),
            ));
        }
        if diff_fingerprint.is_empty() || diff_fingerprint.chars().count() > 128 {
            return Err(IntegratorError::InvalidInput(
                "commit-message fingerprint must contain 1 to 128 characters".into(),
            ));
        }

        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let existing = transaction
            .query_row(
                "SELECT message FROM commit_message_jobs WHERE task_id = ?1 AND provider = ?2 AND diff_fingerprint = ?3",
                params![task_id.to_string(), provider, diff_fingerprint],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(storage_error)?;
        if let Some(message) = existing {
            transaction.commit().map_err(storage_error)?;
            return Ok(match message {
                Some(message) => CommitMessageGenerationClaim::Cached(message),
                None => CommitMessageGenerationClaim::InProgress,
            });
        }
        let changed = transaction
            .execute(
                "INSERT INTO commit_message_jobs(task_id, provider, diff_fingerprint, message, started_at) SELECT id, ?1, ?2, NULL, ?3 FROM tasks WHERE id = ?4",
                params![provider, diff_fingerprint, Utc::now().to_rfc3339(), task_id.to_string()],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        if changed == 0 {
            drop(connection);
            self.get_task(task_id)?;
        }
        Ok(CommitMessageGenerationClaim::Claimed)
    }

    pub fn complete_commit_message_generation(
        &self,
        task_id: TaskId,
        provider: &str,
        diff_fingerprint: &str,
        message: &str,
    ) -> Result<()> {
        let message = message.trim();
        if message.is_empty()
            || message.chars().count() > 72
            || message.chars().any(char::is_control)
        {
            return Err(IntegratorError::InvalidInput(
                "commit message must contain 1 to 72 printable characters".into(),
            ));
        }
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE commit_message_jobs SET message = ?1 WHERE task_id = ?2 AND provider = ?3 AND diff_fingerprint = ?4 AND message IS NULL",
                params![message, task_id.to_string(), provider, diff_fingerprint],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::InvalidInput(
                "commit-message generation was not claimed".into(),
            ));
        }
        Ok(())
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

    pub fn get_setting(&self, key: &str) -> Result<Option<Setting>> {
        validate_setting_key(key)?;
        let row = self
            .connection
            .lock()
            .query_row(
                "SELECT key, value_json, updated_at FROM settings WHERE key=?1",
                [key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?;
        row.map(|(key, json, updated_at)| {
            Ok(Setting {
                key,
                value: serde_json::from_str(&json)?,
                updated_at: parse_time(&updated_at)?,
            })
        })
        .transpose()
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

    /// Reconcile process-owned sessions left unfinished by a prior app exit.
    /// App startup calls this only after single-instance ownership is acquired,
    /// so a secondary database reader cannot interrupt a live process record.
    pub fn interrupt_unfinished_runtime_sessions(&self) -> Result<usize> {
        self.connection
            .lock()
            .execute(
                "UPDATE runtime_sessions SET status='interrupted',ended_at=?1 WHERE ended_at IS NULL",
                [Utc::now().to_rfc3339()],
            )
            .map_err(storage_error)
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
            composer_drafts: self.list_composer_drafts()?,
            queued_messages: self.list_all_queued_messages()?,
        })
    }

    fn list_all_queued_messages(&self) -> Result<Vec<QueuedMessage>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT id, task_id, prompt, attachments_json, runtime, model, effort, permission, delegation, native_action_id, position, state, created_at, updated_at FROM queued_messages ORDER BY task_id, position, created_at",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], parse_queued_message_row)
            .map_err(storage_error)?;
        rows.map(|row| parse_queued_message(row.map_err(storage_error)?))
            .collect()
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

fn build_task(input: NewTask) -> Result<Task> {
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > 240 {
        return Err(IntegratorError::InvalidInput(
            "task title must contain 1 to 240 characters".into(),
        ));
    }
    let now = Utc::now();
    Ok(Task {
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
    })
}

fn insert_task_row(connection: &Connection, task: &Task) -> Result<()> {
    connection
        .execute(
            "INSERT INTO tasks(id, title, repository_path, worktree_path, state, pinned, archived, runtime, model, effort, parent_task_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                task.id.to_string(),
                &task.title,
                path_text(task.repository_path.as_deref()),
                path_text(task.worktree_path.as_deref()),
                task.state.as_str(),
                task.pinned,
                task.archived,
                &task.runtime,
                &task.model,
                &task.effort,
                task.parent_task_id.map(|id| id.to_string()),
                task.created_at.to_rfc3339(),
                task.updated_at.to_rfc3339(),
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn normalize_composer_draft(mut draft: ComposerDraft) -> Result<ComposerDraft> {
    const PROMPT_LIMIT: usize = 2 * 1024 * 1024;
    const ATTACHMENT_LIMIT: usize = 64;
    if draft.prompt.len() > PROMPT_LIMIT {
        return Err(IntegratorError::InvalidInput(
            "composer draft must not exceed 2 MiB".into(),
        ));
    }
    if draft.attachments.len() > ATTACHMENT_LIMIT {
        return Err(IntegratorError::InvalidInput(format!(
            "composer draft must not contain more than {ATTACHMENT_LIMIT} attachments"
        )));
    }
    for attachment in &draft.attachments {
        if attachment.path.is_empty()
            || attachment.path.chars().count() > 32_768
            || attachment.path.contains('\0')
            || attachment.name.is_empty()
            || attachment.name.chars().count() > 512
            || !matches!(attachment.kind.as_str(), "file" | "image")
            || attachment
                .entry
                .as_deref()
                .is_some_and(|entry| !matches!(entry, "file" | "folder"))
        {
            return Err(IntegratorError::InvalidInput(
                "composer draft contains an invalid attachment reference".into(),
            ));
        }
    }
    let runtime = draft.runtime.trim();
    if runtime.is_empty() || runtime.chars().count() > 64 {
        return Err(IntegratorError::InvalidInput(
            "composer runtime must contain 1 to 64 characters".into(),
        ));
    }
    let model = draft.model.trim();
    if model.is_empty() || model.chars().count() > 120 {
        return Err(IntegratorError::InvalidInput(
            "composer model must contain 1 to 120 characters".into(),
        ));
    }
    draft.runtime = runtime.to_owned();
    draft.model = model.to_owned();
    draft.effort = normalize_optional_text(draft.effort, 64)?;
    if !matches!(
        draft.permission.as_str(),
        "read-only" | "project-write" | "ask" | "full-access"
    ) {
        return Err(IntegratorError::InvalidInput(
            "invalid composer permission profile".into(),
        ));
    }
    if !matches!(
        draft.delegation.as_str(),
        "off" | "manual" | "balanced" | "budget-first"
    ) {
        return Err(IntegratorError::InvalidInput(
            "invalid composer delegation mode".into(),
        ));
    }
    let prompt_units = draft.prompt.encode_utf16().count();
    if draft.selection_start as usize > prompt_units
        || draft.selection_end as usize > prompt_units
        || draft.selection_start > draft.selection_end
    {
        return Err(IntegratorError::InvalidInput(
            "composer selection is outside the draft".into(),
        ));
    }
    if draft.revision == 0 || draft.revision >= i64::MAX as u64 {
        return Err(IntegratorError::InvalidInput(
            "composer draft revision is outside the supported range".into(),
        ));
    }
    draft.updated_at = Utc::now();
    Ok(draft)
}

fn normalize_queued_message(mut input: NewQueuedMessage) -> Result<NewQueuedMessage> {
    const PROMPT_LIMIT: usize = 2 * 1024 * 1024;
    const ATTACHMENT_LIMIT: usize = 64;
    if input.prompt.trim().is_empty() && input.attachments.is_empty() {
        return Err(IntegratorError::InvalidInput(
            "queued message must contain text or an attachment".into(),
        ));
    }
    if input.prompt.len() > PROMPT_LIMIT {
        return Err(IntegratorError::InvalidInput(
            "queued message must not exceed 2 MiB".into(),
        ));
    }
    if input.attachments.len() > ATTACHMENT_LIMIT {
        return Err(IntegratorError::InvalidInput(format!(
            "queued message must not contain more than {ATTACHMENT_LIMIT} attachments"
        )));
    }
    for attachment in &input.attachments {
        if attachment.path.is_empty()
            || attachment.path.chars().count() > 32_768
            || attachment.path.contains('\0')
            || attachment.name.is_empty()
            || attachment.name.chars().count() > 512
            || !matches!(attachment.kind.as_str(), "file" | "image")
            || attachment
                .entry
                .as_deref()
                .is_some_and(|entry| !matches!(entry, "file" | "folder"))
        {
            return Err(IntegratorError::InvalidInput(
                "queued message contains an invalid attachment reference".into(),
            ));
        }
    }
    input.runtime = normalize_required_text(input.runtime, 64, "queued runtime")?;
    input.model = normalize_required_text(input.model, 120, "queued model")?;
    input.effort = normalize_optional_text(input.effort, 64)?;
    input.native_action_id = normalize_optional_text(input.native_action_id, 512)?;
    if !matches!(
        input.permission.as_str(),
        "read-only" | "project-write" | "ask" | "full-access"
    ) {
        return Err(IntegratorError::InvalidInput(
            "invalid queued permission profile".into(),
        ));
    }
    if !matches!(
        input.delegation.as_str(),
        "off" | "manual" | "balanced" | "budget-first"
    ) {
        return Err(IntegratorError::InvalidInput(
            "invalid queued delegation mode".into(),
        ));
    }
    Ok(input)
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

fn insert_queued_message(connection: &Connection, message: &QueuedMessage) -> Result<()> {
    let attachments = serde_json::to_string(&message.attachments)?;
    connection
        .execute(
            "INSERT INTO queued_messages(id, task_id, prompt, attachments_json, runtime, model, effort, permission, delegation, native_action_id, position, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                message.id.to_string(),
                message.task_id.to_string(),
                &message.prompt,
                attachments,
                &message.runtime,
                &message.model,
                &message.effort,
                &message.permission,
                &message.delegation,
                &message.native_action_id,
                i64::from(message.position),
                message.state.as_str(),
                message.created_at.to_rfc3339(),
                message.updated_at.to_rfc3339(),
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

type QueuedMessageRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    String,
    Option<String>,
    i64,
    String,
    String,
    String,
);

fn parse_queued_message_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<QueuedMessageRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
        row.get(12)?,
        row.get(13)?,
    ))
}

fn parse_queued_message(row: QueuedMessageRow) -> Result<QueuedMessage> {
    let (
        id,
        task_id,
        prompt,
        attachments,
        runtime,
        model,
        effort,
        permission,
        delegation,
        native_action_id,
        position,
        state,
        created_at,
        updated_at,
    ) = row;
    Ok(QueuedMessage {
        id: QueuedMessageId::from_str(&id).map_err(invalid_stored)?,
        task_id: TaskId::from_str(&task_id).map_err(invalid_stored)?,
        prompt,
        attachments: serde_json::from_str(&attachments)?,
        runtime,
        model,
        effort,
        permission,
        delegation,
        native_action_id,
        position: u32::try_from(position)
            .map_err(|_| IntegratorError::Storage("invalid queued message position".into()))?,
        state: QueuedMessageState::from_str(&state)?,
        created_at: parse_time(&created_at)?,
        updated_at: parse_time(&updated_at)?,
    })
}

fn draft_identity(owner: &ComposerDraftOwner) -> (String, Option<String>, Option<String>) {
    match owner {
        ComposerDraftOwner::NewChat { project_id } => (
            format!("project:{project_id}"),
            Some(project_id.to_string()),
            None,
        ),
        ComposerDraftOwner::Task { task_id } => {
            (format!("task:{task_id}"), None, Some(task_id.to_string()))
        }
    }
}

fn ensure_draft_owner(connection: &Connection, owner: &ComposerDraftOwner) -> Result<()> {
    let exists = match owner {
        ComposerDraftOwner::NewChat { project_id } => connection
            .query_row(
                "SELECT 1 FROM trusted_projects WHERE id = ?1",
                [project_id.to_string()],
                |_| Ok(()),
            )
            .optional()
            .map_err(storage_error)?
            .is_some(),
        ComposerDraftOwner::Task { task_id } => connection
            .query_row(
                "SELECT 1 FROM tasks WHERE id = ?1",
                [task_id.to_string()],
                |_| Ok(()),
            )
            .optional()
            .map_err(storage_error)?
            .is_some(),
    };
    if exists {
        Ok(())
    } else {
        Err(IntegratorError::NotFound("composer draft owner".into()))
    }
}

fn write_composer_draft(connection: &Connection, draft: &ComposerDraft) -> Result<()> {
    let (draft_key, project_id, task_id) = draft_identity(&draft.owner);
    let attachments = serde_json::to_string(&draft.attachments)?;
    connection
        .execute(
            r#"
            INSERT INTO composer_drafts(
                draft_key, project_id, task_id, prompt, attachments_json, runtime, model,
                effort, permission, delegation, selection_start, selection_end, revision, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            ON CONFLICT(draft_key) DO UPDATE SET
                project_id=excluded.project_id,
                task_id=excluded.task_id,
                prompt=excluded.prompt,
                attachments_json=excluded.attachments_json,
                runtime=excluded.runtime,
                model=excluded.model,
                effort=excluded.effort,
                permission=excluded.permission,
                delegation=excluded.delegation,
                selection_start=excluded.selection_start,
                selection_end=excluded.selection_end,
                revision=excluded.revision,
                updated_at=excluded.updated_at
            WHERE excluded.revision > composer_drafts.revision
            "#,
            params![
                draft_key,
                project_id,
                task_id,
                &draft.prompt,
                attachments,
                &draft.runtime,
                &draft.model,
                &draft.effort,
                &draft.permission,
                &draft.delegation,
                i64::from(draft.selection_start),
                i64::from(draft.selection_end),
                draft.revision as i64,
                draft.updated_at.to_rfc3339(),
            ],
        )
        .map_err(storage_error)?;
    Ok(())
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
    use integrator_core::{
        ItemKind, ItemProjection, ItemStatus, RuntimeBinding, RuntimeProjection,
        RuntimeProjectionEvent,
    };
    use integrator_runtime::{ProjectionMutation, ReducedProviderEvent};

    fn create_naming_task(store: &LocalStore) -> Task {
        store
            .create_task(NewTask {
                title: "Coding session".into(),
                repository_path: None,
                worktree_path: None,
                runtime: Some("codex".into()),
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create naming task")
    }

    #[test]
    fn title_generation_claim_is_one_shot_and_manual_rename_wins() {
        let store = LocalStore::open_in_memory().expect("open store");
        let task = create_naming_task(&store);
        assert!(
            store
                .claim_task_title_generation(task.id, "Coding session")
                .expect("first claim")
        );
        assert!(
            !store
                .claim_task_title_generation(task.id, "Coding session")
                .expect("duplicate claim")
        );
        store
            .update_task_metadata(task.id, Some("My own title".into()), None, None)
            .expect("manual rename");
        assert_eq!(
            store
                .compare_and_set_task_title(task.id, "Coding session", "Generated title")
                .expect("late generated title"),
            None
        );
        assert_eq!(store.get_task(task.id).expect("task").title, "My own title");
    }

    #[test]
    fn title_generation_claim_survives_restart() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = directory.path().join("title-claim.sqlite3");
        let task_id = {
            let store = LocalStore::open(&database).expect("open store");
            let task = create_naming_task(&store);
            assert!(
                store
                    .claim_task_title_generation(task.id, "Coding session")
                    .expect("claim")
            );
            task.id
        };
        let reopened = LocalStore::open(&database).expect("reopen store");
        assert!(
            !reopened
                .claim_task_title_generation(task_id, "Coding session")
                .expect("persistent claim")
        );
    }

    #[test]
    fn commit_message_generation_reuses_completed_diff_and_blocks_duplicate_spend() {
        let store = LocalStore::open_in_memory().expect("open store");
        let task = create_naming_task(&store);
        assert_eq!(
            store
                .claim_commit_message_generation(task.id, "codex", "diff-a")
                .expect("claim"),
            CommitMessageGenerationClaim::Claimed
        );
        assert_eq!(
            store
                .claim_commit_message_generation(task.id, "codex", "diff-a")
                .expect("pending claim"),
            CommitMessageGenerationClaim::InProgress
        );
        store
            .complete_commit_message_generation(
                task.id,
                "codex",
                "diff-a",
                "feat: generate commit subjects",
            )
            .expect("complete");
        assert_eq!(
            store
                .claim_commit_message_generation(task.id, "codex", "diff-a")
                .expect("cached claim"),
            CommitMessageGenerationClaim::Cached("feat: generate commit subjects".into())
        );
        assert_eq!(
            store
                .claim_commit_message_generation(task.id, "codex", "diff-b")
                .expect("changed diff"),
            CommitMessageGenerationClaim::Claimed
        );
    }

    #[test]
    fn commit_message_generation_cache_survives_restart() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = directory.path().join("commit-message-cache.sqlite3");
        let task_id = {
            let store = LocalStore::open(&database).expect("open store");
            let task = create_naming_task(&store);
            store
                .claim_commit_message_generation(task.id, "claude", "diff-a")
                .expect("claim");
            store
                .complete_commit_message_generation(
                    task.id,
                    "claude",
                    "diff-a",
                    "fix: preserve staged changes",
                )
                .expect("complete");
            task.id
        };
        let reopened = LocalStore::open(&database).expect("reopen store");
        assert_eq!(
            reopened
                .claim_commit_message_generation(task_id, "claude", "diff-a")
                .expect("cached after restart"),
            CommitMessageGenerationClaim::Cached("fix: preserve staged changes".into())
        );
    }

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
        let common = directory.path().join(".git");
        store
            .upsert_trusted_project(
                "Clearable project",
                directory.path(),
                Some((directory.path(), &common)),
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
    fn materialized_snapshot_schema_migration_is_idempotent() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("snapshot.sqlite3");
        let store = LocalStore::open(&path).expect("first open");
        {
            let connection = store.connection.lock();
            let columns = connection
                .prepare("PRAGMA table_info(codex_task_projection)")
                .expect("projection columns")
                .query_map([], |row| row.get::<_, String>(1))
                .expect("query columns")
                .collect::<std::result::Result<std::collections::HashSet<_>, _>>()
                .expect("collect columns");
            for column in [
                "turn_event_json",
                "mode_seq",
                "mode_event_json",
                "error_seq",
                "error_event_json",
                "reset_seq",
                "reset_event_json",
            ] {
                assert!(columns.contains(column), "missing {column}");
            }
            let item_indexes = connection
                .prepare("PRAGMA index_list(codex_items)")
                .expect("item indexes")
                .query_map([], |row| row.get::<_, String>(1))
                .expect("query indexes")
                .collect::<std::result::Result<std::collections::HashSet<_>, _>>()
                .expect("collect indexes");
            assert!(item_indexes.contains("codex_items_task_snapshot_idx"));
            assert!(item_indexes.contains("codex_items_provider_stable_seq_idx"));
            let approval_indexes = connection
                .prepare("PRAGMA index_list(codex_approvals)")
                .expect("approval indexes")
                .query_map([], |row| row.get::<_, String>(1))
                .expect("query approval indexes")
                .collect::<std::result::Result<std::collections::HashSet<_>, _>>()
                .expect("collect approval indexes");
            assert!(approval_indexes.contains("codex_approvals_active_process_idx"));
        }
        drop(store);
        LocalStore::open(&path).expect("idempotent reopen");
    }

    #[test]
    fn legacy_projection_rows_migrate_before_new_audit_rows_omit_the_copy() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("legacy-snapshot.sqlite3");
        let task_id = TaskId::new();
        let provider_session_id = ProviderSessionId::new();
        let runtime_session_id = RuntimeSessionId::new();
        let occurred_at = Utc::now();
        let legacy_item = ItemProjection {
            id: "legacy-stable-item".into(),
            provider_item_id: "legacy-provider-item".into(),
            kind: ItemKind::AgentMessage,
            status: ItemStatus::Completed,
            title: None,
            body: Some("legacy materialized message".into()),
            native_skill: None,
            command: None,
            cwd: None,
            output: None,
            exit_code: None,
            file_changes: None,
            mcp_server: None,
            mcp_tool: None,
            tool_input: None,
            truncated: false,
            updated_at: occurred_at,
        };
        let legacy_event = RuntimeProjectionEvent {
            seq: 1,
            task_id,
            provider_session_id,
            provider: "codex".into(),
            thread_id: "legacy-thread".into(),
            turn_id: Some("legacy-turn".into()),
            occurred_at,
            projection: RuntimeProjection::ItemChanged {
                item: legacy_item.clone(),
            },
        };

        {
            let mut connection = Connection::open(&path).expect("open v7 fixture");
            LocalStore::configure(&connection).expect("configure v7 fixture");
            connection
                .execute(
                    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
                    [],
                )
                .expect("create migration ledger");
            for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version < 8) {
                let transaction = connection.transaction().expect("v7 migration transaction");
                transaction
                    .execute_batch(sql)
                    .expect("apply pre-snapshot migration");
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?1,?2)",
                        params![version, occurred_at.to_rfc3339()],
                    )
                    .expect("record pre-snapshot migration");
                transaction.commit().expect("commit pre-snapshot migration");
            }
            connection.execute("INSERT INTO tasks(id,title,state,created_at,updated_at) VALUES (?1,'Legacy fixture','ready',?2,?2)", params![task_id.to_string(), occurred_at.to_rfc3339()]).expect("insert legacy task");
            connection.execute("INSERT INTO provider_sessions(id,task_id,provider,provider_thread_id,created_at,updated_at) VALUES (?1,?2,'codex','legacy-thread',?3,?3)", params![provider_session_id.to_string(), task_id.to_string(), occurred_at.to_rfc3339()]).expect("insert legacy provider session");
            connection.execute("INSERT INTO runtime_sessions(id,task_id,provider_session_id,status,started_at,process_id) VALUES (?1,?2,?3,'running',?4,'legacy-process')", params![runtime_session_id.to_string(), task_id.to_string(), provider_session_id.to_string(), occurred_at.to_rfc3339()]).expect("insert legacy runtime session");
            connection.execute("INSERT INTO codex_task_projection(task_id,provider_session_id,thread_id,process_id,last_event_seq) VALUES (?1,?2,'legacy-thread','legacy-process',1)", params![task_id.to_string(), provider_session_id.to_string()]).expect("insert legacy task projection");
            connection.execute("INSERT INTO codex_items(provider_session_id,task_id,thread_id,turn_id,item_id,stable_id,kind,status,body,updated_at,projection_json,last_event_seq) VALUES (?1,?2,'legacy-thread','legacy-turn',?3,?4,'agent_message','completed',?5,?6,?7,1)", params![provider_session_id.to_string(), task_id.to_string(), legacy_item.provider_item_id, legacy_item.id, legacy_item.body, occurred_at.to_rfc3339(), serde_json::to_string(&legacy_item).expect("serialize legacy item")]).expect("insert legacy current item");
            connection.execute("INSERT INTO codex_event_log(seq,task_id,provider_session_id,runtime_session_id,process_id,thread_id,turn_id,method,audit_json,audit_truncated,projection_json,occurred_at) VALUES (1,?1,?2,?3,'legacy-process','legacy-thread','legacy-turn','item/completed','{}',0,?4,?5)", params![task_id.to_string(), provider_session_id.to_string(), runtime_session_id.to_string(), serde_json::to_string(&legacy_event).expect("serialize legacy event"), occurred_at.to_rfc3339()]).expect("insert legacy event projection");
        }

        let migrated = LocalStore::open(&path).expect("migrate v7 fixture");
        let migrated_snapshot = migrated
            .task_snapshot(task_id)
            .expect("hydrate migrated legacy snapshot");
        assert_eq!(migrated_snapshot.events, vec![legacy_event]);

        let binding = RuntimeBinding {
            task_id,
            provider: ProviderKind::Codex,
            provider_session_id: Some(provider_session_id),
            runtime_session_id,
            process_id: "legacy-process".into(),
            thread_id: Some("legacy-thread".into()),
        };
        let new_item = ItemProjection {
            id: "new-stable-item".into(),
            provider_item_id: "new-provider-item".into(),
            kind: ItemKind::AgentMessage,
            status: ItemStatus::Completed,
            title: None,
            body: Some("post-migration message".into()),
            native_skill: None,
            command: None,
            cwd: None,
            output: None,
            exit_code: None,
            file_changes: None,
            mcp_server: None,
            mcp_tool: None,
            tool_input: None,
            truncated: false,
            updated_at: occurred_at + chrono::Duration::seconds(1),
        };
        let appended = migrated
            .apply_reduced_event(
                &binding,
                &ReducedProviderEvent {
                    method: "item/completed".into(),
                    thread_id: "legacy-thread".into(),
                    turn_id: Some("legacy-turn".into()),
                    audit_json: "{}".into(),
                    audit_truncated: false,
                    mutation: ProjectionMutation::ReplaceItem(new_item),
                    occurred_at: occurred_at + chrono::Duration::seconds(1),
                },
            )
            .expect("append post-migration event");
        {
            let connection = migrated.connection.lock();
            let projection_copy: Option<String> = connection
                .query_row(
                    "SELECT projection_json FROM codex_event_log WHERE seq=?1",
                    [appended.seq],
                    |row| row.get(0),
                )
                .expect("read post-migration audit row");
            assert!(projection_copy.is_none());
        }
        drop(migrated);

        let reopened = LocalStore::open(&path).expect("reopen migrated fixture");
        let snapshot = reopened
            .task_snapshot(task_id)
            .expect("hydrate after reopen");
        assert_eq!(snapshot.watermark_seq, appended.seq);
        assert_eq!(snapshot.events.len(), 2);
        assert!(snapshot.events.iter().any(|event| matches!(
            &event.projection,
            RuntimeProjection::ItemChanged { item }
                if item.body.as_deref() == Some("legacy materialized message")
        )));
        assert!(snapshot.events.iter().any(|event| matches!(
            &event.projection,
            RuntimeProjection::ItemChanged { item }
                if item.body.as_deref() == Some("post-migration message")
        )));
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
    fn setting_lookup_uses_the_primary_key_and_distinguishes_missing_values() {
        let store = LocalStore::open_in_memory().expect("open store");
        let expected = serde_json::json!({"primary": {"usedPercent": 42}});
        store
            .set_setting("provider-quota.codex", expected.clone())
            .expect("set quota");

        assert_eq!(
            store
                .get_setting("provider-quota.codex")
                .expect("get quota")
                .expect("stored quota")
                .value,
            expected
        );
        assert!(
            store
                .get_setting("provider-quota.cursor")
                .expect("get missing quota")
                .is_none()
        );
    }

    #[test]
    fn startup_reconciliation_interrupts_only_unfinished_runtime_sessions_once() {
        let store = LocalStore::open_in_memory().expect("open store");
        let task = store
            .create_task(NewTask {
                title: "Runtime reconciliation".into(),
                repository_path: None,
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create task");
        let now = Utc::now();
        let running_id = RuntimeSessionId::new();
        let completed_id = RuntimeSessionId::new();
        store
            .insert_runtime_session(&RuntimeSession {
                id: running_id,
                task_id: task.id,
                provider_session_id: None,
                process_id: Some("startup-running".into()),
                status: "running".into(),
                started_at: now,
                ended_at: None,
            })
            .expect("insert unfinished session");
        store
            .insert_runtime_session(&RuntimeSession {
                id: completed_id,
                task_id: task.id,
                provider_session_id: None,
                process_id: Some("startup-completed".into()),
                status: "completed".into(),
                started_at: now,
                ended_at: Some(now),
            })
            .expect("insert completed session");

        assert_eq!(
            store
                .interrupt_unfinished_runtime_sessions()
                .expect("first reconciliation"),
            1
        );
        assert_eq!(
            store
                .interrupt_unfinished_runtime_sessions()
                .expect("idempotent reconciliation"),
            0
        );
        let sessions = store.list_runtime_sessions().expect("list sessions");
        let running = sessions
            .iter()
            .find(|session| session.id == running_id)
            .expect("reconciled session");
        assert_eq!(running.status, "interrupted");
        assert!(running.ended_at.is_some());
        let completed = sessions
            .iter()
            .find(|session| session.id == completed_id)
            .expect("completed session");
        assert_eq!(completed.status, "completed");
        assert_eq!(completed.ended_at, Some(now));
    }

    fn draft_fixture(owner: ComposerDraftOwner, prompt: &str, revision: u64) -> ComposerDraft {
        let selection = prompt.encode_utf16().count() as u32;
        ComposerDraft {
            owner,
            prompt: prompt.into(),
            attachments: Vec::new(),
            runtime: "codex".into(),
            model: "gpt-5.6-luna".into(),
            effort: Some("high".into()),
            permission: "project-write".into(),
            delegation: "off".into(),
            selection_start: selection,
            selection_end: selection,
            revision,
            updated_at: Utc::now(),
        }
    }

    fn queued_fixture(task_id: TaskId, prompt: &str) -> NewQueuedMessage {
        NewQueuedMessage {
            task_id,
            prompt: prompt.into(),
            attachments: Vec::new(),
            runtime: "codex".into(),
            model: "gpt-5.6-luna".into(),
            effort: Some("high".into()),
            permission: "project-write".into(),
            delegation: "off".into(),
            native_action_id: None,
        }
    }

    fn register_draft_project(store: &LocalStore, directory: &tempfile::TempDir) -> TrustedProject {
        let repository = directory.path().join("repository");
        let common = repository.join(".git");
        std::fs::create_dir_all(&common).expect("fixture repository");
        store
            .upsert_trusted_project("Draft fixture", &repository, Some((&repository, &common)))
            .expect("register draft project")
    }

    #[test]
    fn happy_project_and_task_drafts_remain_isolated() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::open_in_memory().expect("open store");
        let project = register_draft_project(&store, &directory);
        let task = store
            .create_task(NewTask {
                title: "Existing conversation".into(),
                repository_path: Some(project.repository_root.clone()),
                worktree_path: None,
                runtime: Some("codex".into()),
                model: Some("gpt-5.6-luna".into()),
                effort: Some("high".into()),
                parent_task_id: None,
            })
            .expect("create task");
        store
            .upsert_composer_draft(draft_fixture(
                ComposerDraftOwner::NewChat {
                    project_id: project.id,
                },
                "A new chat thought",
                1,
            ))
            .expect("save project draft");
        store
            .upsert_composer_draft(draft_fixture(
                ComposerDraftOwner::Task { task_id: task.id },
                "A reply for the existing chat",
                1,
            ))
            .expect("save task draft");

        let drafts = store.list_composer_drafts().expect("list drafts");
        assert_eq!(drafts.len(), 2);
        assert!(
            drafts
                .iter()
                .any(|draft| draft.prompt == "A new chat thought")
        );
        assert!(
            drafts
                .iter()
                .any(|draft| draft.prompt == "A reply for the existing chat")
        );
    }

    #[test]
    fn degraded_out_of_order_write_cannot_replace_a_newer_revision() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::open_in_memory().expect("open store");
        let project = register_draft_project(&store, &directory);
        let owner = ComposerDraftOwner::NewChat {
            project_id: project.id,
        };
        store
            .upsert_composer_draft(draft_fixture(owner.clone(), "newest", 4))
            .expect("save newest");
        store
            .upsert_composer_draft(draft_fixture(owner, "stale", 3))
            .expect("ignore stale");

        let drafts = store.list_composer_drafts().expect("list drafts");
        assert_eq!(drafts[0].prompt, "newest");
        assert_eq!(drafts[0].revision, 4);
    }

    #[test]
    fn restart_reopens_the_durable_draft() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = directory.path().join("draft-restart.sqlite3");
        let expected_project = {
            let store = LocalStore::open(&database).expect("first open");
            let project = register_draft_project(&store, &directory);
            store
                .upsert_composer_draft(draft_fixture(
                    ComposerDraftOwner::NewChat {
                        project_id: project.id,
                    },
                    "Survive a hard restart",
                    7,
                ))
                .expect("save draft");
            project.id
        };

        let reopened = LocalStore::open(&database).expect("reopen store");
        let drafts = reopened.list_composer_drafts().expect("restore drafts");
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].prompt, "Survive a hard restart");
        assert_eq!(
            drafts[0].owner,
            ComposerDraftOwner::NewChat {
                project_id: expected_project
            }
        );
    }

    #[test]
    fn new_chat_promotion_atomically_rekeys_the_draft_to_the_created_task() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::open_in_memory().expect("open store");
        let project = register_draft_project(&store, &directory);
        let draft = draft_fixture(
            ComposerDraftOwner::NewChat {
                project_id: project.id,
            },
            "Create the task without losing me",
            5,
        );
        store
            .upsert_composer_draft(draft.clone())
            .expect("save new-chat draft");
        let task = store
            .create_task_with_project_draft(
                NewTask {
                    title: "Promoted chat".into(),
                    repository_path: Some(project.repository_root),
                    worktree_path: None,
                    runtime: Some("codex".into()),
                    model: Some("gpt-5.6-luna".into()),
                    effort: Some("high".into()),
                    parent_task_id: None,
                },
                draft,
            )
            .expect("create task and promote draft");

        let drafts = store.list_composer_drafts().expect("list promoted drafts");
        let task_draft = drafts
            .iter()
            .find(|candidate| candidate.owner == ComposerDraftOwner::Task { task_id: task.id })
            .expect("task draft");
        let project_draft = drafts
            .iter()
            .find(|candidate| {
                candidate.owner
                    == ComposerDraftOwner::NewChat {
                        project_id: project.id,
                    }
            })
            .expect("project tombstone");
        assert_eq!(task_draft.prompt, "Create the task without losing me");
        assert!(project_draft.prompt.is_empty());
        assert_eq!(project_draft.revision, task_draft.revision);
    }

    #[test]
    fn cancellation_race_keeps_new_text_when_an_older_clear_arrives() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::open_in_memory().expect("open store");
        let project = register_draft_project(&store, &directory);
        let task = store
            .create_task(NewTask {
                title: "Cancellation race".into(),
                repository_path: Some(project.repository_root),
                worktree_path: None,
                runtime: Some("codex".into()),
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create task");
        let owner = ComposerDraftOwner::Task { task_id: task.id };
        store
            .upsert_composer_draft(draft_fixture(
                owner.clone(),
                "Typed while the send was settling",
                12,
            ))
            .expect("save next draft");
        store
            .upsert_composer_draft(draft_fixture(owner, "", 11))
            .expect("ignore stale clear");

        let draft = store.list_composer_drafts().expect("list drafts").remove(0);
        assert_eq!(draft.prompt, "Typed while the send was settling");
        assert_eq!(draft.revision, 12);
    }

    #[test]
    fn adversarial_unknown_owner_and_oversized_body_fail_closed() {
        let store = LocalStore::open_in_memory().expect("open store");
        let unknown = draft_fixture(
            ComposerDraftOwner::NewChat {
                project_id: ProjectId::new(),
            },
            "Untrusted owner",
            1,
        );
        assert!(matches!(
            store.upsert_composer_draft(unknown),
            Err(IntegratorError::NotFound(_))
        ));

        let directory = tempfile::tempdir().expect("temporary directory");
        let project = register_draft_project(&store, &directory);
        let oversized = draft_fixture(
            ComposerDraftOwner::NewChat {
                project_id: project.id,
            },
            &"x".repeat(2 * 1024 * 1024 + 1),
            1,
        );
        assert!(matches!(
            store.upsert_composer_draft(oversized),
            Err(IntegratorError::InvalidInput(_))
        ));
    }

    #[test]
    fn queued_messages_persist_reorder_and_return_without_crossing_tasks() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = directory.path().join("queue.sqlite3");
        let (task_id, other_task_id, first_id, third_id) = {
            let store = LocalStore::open(&database).expect("open store");
            let task = store
                .create_task(NewTask {
                    title: "Queued conversation".into(),
                    repository_path: None,
                    worktree_path: None,
                    runtime: Some("codex".into()),
                    model: None,
                    effort: None,
                    parent_task_id: None,
                })
                .expect("create task");
            let other = store
                .create_task(NewTask {
                    title: "Other conversation".into(),
                    repository_path: None,
                    worktree_path: None,
                    runtime: Some("cursor".into()),
                    model: None,
                    effort: None,
                    parent_task_id: None,
                })
                .expect("create other task");
            let first = store
                .enqueue_message(queued_fixture(task.id, "First"))
                .expect("queue first");
            let second = store
                .enqueue_message(queued_fixture(task.id, "Second"))
                .expect("queue second");
            let third = store
                .enqueue_message(queued_fixture(task.id, "Third"))
                .expect("queue third");
            store
                .enqueue_message(queued_fixture(other.id, "Other task"))
                .expect("queue other task");
            let reordered = store
                .reorder_queued_messages(task.id, &[third.id, first.id, second.id])
                .expect("reorder");
            assert_eq!(
                reordered
                    .iter()
                    .map(|message| message.prompt.as_str())
                    .collect::<Vec<_>>(),
                ["Third", "First", "Second"]
            );
            (task.id, other.id, first.id, third.id)
        };

        let reopened = LocalStore::open(&database).expect("reopen store");
        let restored = reopened
            .list_queued_messages(task_id)
            .expect("restore queue");
        assert_eq!(restored.len(), 3);
        assert_eq!(restored[0].id, third_id);
        let returned = reopened
            .take_queued_message(task_id, first_id)
            .expect("return to composer");
        assert_eq!(returned.prompt, "First");
        assert_eq!(
            reopened
                .list_queued_messages(task_id)
                .expect("remaining queue")
                .len(),
            2
        );
        assert_eq!(
            reopened
                .list_queued_messages(other_task_id)
                .expect("other queue")
                .len(),
            1
        );
        assert_eq!(reopened.export().expect("export").queued_messages.len(), 3);
    }

    #[test]
    fn queued_message_dispatch_recovery_and_adversarial_boundaries_fail_closed() {
        let store = LocalStore::open_in_memory().expect("open store");
        let task = store
            .create_task(NewTask {
                title: "Queue recovery".into(),
                repository_path: None,
                worktree_path: None,
                runtime: Some("claude".into()),
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create task");
        let message = store
            .enqueue_message(queued_fixture(task.id, "Recover me"))
            .expect("queue message");
        store
            .set_queued_message_state(task.id, message.id, QueuedMessageState::Dispatching)
            .expect("mark dispatching");
        assert_eq!(
            store
                .recover_dispatching_queued_messages()
                .expect("recover dispatch"),
            1
        );
        assert_eq!(
            store.list_queued_messages(task.id).expect("list queue")[0].state,
            QueuedMessageState::Queued
        );
        assert!(matches!(
            store.enqueue_message(queued_fixture(TaskId::new(), "Unknown task")),
            Err(IntegratorError::NotFound(_))
        ));
        let mut empty = queued_fixture(task.id, "");
        empty.attachments.clear();
        assert!(matches!(
            store.enqueue_message(empty),
            Err(IntegratorError::InvalidInput(_))
        ));
        let oversized = queued_fixture(task.id, &"x".repeat(2 * 1024 * 1024 + 1));
        assert!(matches!(
            store.enqueue_message(oversized),
            Err(IntegratorError::InvalidInput(_))
        ));
        assert!(matches!(
            store.reorder_queued_messages(task.id, &[message.id, message.id]),
            Err(IntegratorError::InvalidInput(_))
        ));
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
            .upsert_trusted_project("Repository", &repository, Some((&repository, &common)))
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

    #[test]
    fn ordinary_project_folder_persists_without_git_identity() {
        let directory = tempfile::tempdir().expect("temp directory");
        let database = directory.path().join("integrator.sqlite3");
        let project_root = directory.path().join("notes");
        std::fs::create_dir(&project_root).expect("project folder");
        let store = LocalStore::open(&database).expect("open store");

        let project = store
            .upsert_trusted_project("Notes", &project_root, None)
            .expect("register ordinary folder");
        assert_eq!(project.repository_root, project_root);
        assert_eq!(project.git_repository_root, None);
        assert_eq!(project.git_common_directory, None);
        assert_eq!(
            store.list_trusted_projects().expect("list projects"),
            vec![project]
        );
    }
}
