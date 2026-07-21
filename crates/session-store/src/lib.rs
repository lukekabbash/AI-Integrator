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
mod delegation_store;
mod projection_store;
pub use automation_store::{NewAutomation, UpdateAutomation};
pub use delegation_store::NewDelegation;
pub use projection_store::{
    HANDOFF_CHILD_MAX_TOKENS, HANDOFF_DEFAULT_MAX_IMAGES, HANDOFF_DEFAULT_MAX_TOKENS,
    HANDOFF_DEFAULT_MAX_TURNS, HandoffDigest, HandoffDigestOptions, PersistedStopRequest,
    PreparedApprovalResponse,
};

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
    (
        16,
        r#"
        CREATE TABLE provider_resume_states (
            task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            session_ref TEXT NOT NULL,
            repository_root TEXT NOT NULL,
            permission TEXT NOT NULL,
            delegation TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#,
    ),
    (
        17,
        r#"
        CREATE TABLE task_edit_context (
            task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
            body TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#,
    ),
    (
        18,
        r#"
        ALTER TABLE codex_items ADD COLUMN native_skill TEXT;
        UPDATE codex_items
        SET native_skill = json_extract(projection_json, '$.nativeSkill')
        WHERE kind = 'user_message'
          AND json_extract(projection_json, '$.nativeSkill') IS NOT NULL;
        CREATE INDEX codex_items_native_skill_idx
            ON codex_items(native_skill)
            WHERE native_skill IS NOT NULL;
        "#,
    ),
    (
        19,
        r#"
        DELETE FROM codex_items
        WHERE item_id GLOB 'item-[0-9]*'
          AND substr(item_id, 6) NOT GLOB '*[^0-9]*'
          AND kind IN ('user_message', 'agent_message')
          AND EXISTS (
              SELECT 1
              FROM codex_items AS original
              WHERE original.provider_session_id = codex_items.provider_session_id
                AND original.turn_id = codex_items.turn_id
                AND original.kind = codex_items.kind
                AND original.item_id NOT GLOB 'item-[0-9]*'
                AND original.first_event_seq < codex_items.first_event_seq
                AND (
                    codex_items.kind = 'user_message'
                    OR COALESCE(original.body, '') = COALESCE(codex_items.body, '')
                )
          );
        "#,
    ),
    (
        20,
        r#"
        ALTER TABLE delegations ADD COLUMN service_level TEXT NOT NULL DEFAULT 'standard'
            CHECK (service_level IN ('budget', 'standard', 'premium'));
        ALTER TABLE delegations ADD COLUMN capability_snapshot_json TEXT NOT NULL DEFAULT '{}';
        UPDATE delegations
        SET capability_snapshot_json = json_object(
            'version', 0,
            'profileId', profile_id,
            'profileLabel', profile_label,
            'bestFor', '',
            'workingGuidance', '',
            'accessCeiling', permission,
            'serviceLevel', 'standard',
            'routes', json_array(json_object(
                'runtime', runtime,
                'model', model,
                'effort', effort
            )),
            'skillIds', json_array(),
            'mcpServerIds', json_array(),
            'createdAt', created_at
        );
        "#,
    ),
    (
        21,
        r#"
        CREATE TABLE automations (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            prompt TEXT NOT NULL,
            target_json TEXT NOT NULL,
            trigger_json TEXT NOT NULL,
            route_json TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('user', 'agent')),
            recurrence_user_request TEXT,
            status TEXT NOT NULL CHECK (status IN (
                'active', 'paused', 'running', 'completed', 'needs-attention', 'cancelled'
            )),
            next_run_at TEXT,
            last_run_at TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX automations_task_idx ON automations(task_id, created_at DESC);
        CREATE INDEX automations_pending_idx ON automations(status, next_run_at)
            WHERE status = 'active';

        CREATE TABLE automation_runs (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            scheduled_for TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('claimed', 'dispatched', 'failed')),
            dispatch_ref TEXT,
            error TEXT,
            claimed_at TEXT NOT NULL,
            finished_at TEXT
        );
        CREATE INDEX automation_runs_automation_idx
            ON automation_runs(automation_id, claimed_at DESC);
        "#,
    ),
    (
        22,
        r#"
        DROP TRIGGER codex_items_fts_insert;
        DROP TRIGGER codex_items_fts_delete;
        DROP TRIGGER codex_items_fts_update_delete;
        DROP TRIGGER codex_items_fts_update_insert;
        DROP TABLE codex_items_fts;

        DROP INDEX codex_approvals_transport_idx;
        DROP INDEX codex_event_task_seq_idx;
        DROP INDEX codex_turns_task_snapshot_idx;
        DROP INDEX codex_items_task_snapshot_idx;
        DROP INDEX codex_approvals_task_snapshot_idx;
        DROP INDEX codex_items_provider_stable_seq_idx;
        DROP INDEX codex_approvals_active_process_idx;
        DROP INDEX codex_items_native_skill_idx;

        ALTER TABLE codex_turns RENAME TO integrator_turns;
        ALTER TABLE codex_items RENAME TO integrator_items;
        ALTER TABLE codex_approvals RENAME TO integrator_approvals;
        ALTER TABLE codex_task_projection RENAME TO integrator_task_projection;
        ALTER TABLE codex_event_log RENAME TO integrator_event_log;

        CREATE INDEX integrator_approvals_transport_idx
            ON integrator_approvals(runtime_session_id, request_kind, request_value);
        CREATE INDEX integrator_event_task_seq_idx
            ON integrator_event_log(task_id, seq);
        CREATE INDEX integrator_turns_task_snapshot_idx
            ON integrator_turns(task_id, last_event_seq);
        CREATE INDEX integrator_items_task_snapshot_idx
            ON integrator_items(task_id, last_event_seq);
        CREATE INDEX integrator_approvals_task_snapshot_idx
            ON integrator_approvals(task_id, last_event_seq);
        CREATE INDEX integrator_items_provider_stable_seq_idx
            ON integrator_items(provider_session_id, stable_id, last_event_seq DESC);
        CREATE INDEX integrator_approvals_active_process_idx
            ON integrator_approvals(process_id)
            WHERE state IN ('pending', 'responding', 'response_failed');
        CREATE INDEX integrator_items_native_skill_idx
            ON integrator_items(native_skill)
            WHERE native_skill IS NOT NULL;

        CREATE VIRTUAL TABLE integrator_items_fts USING fts5(
            body,
            task_id UNINDEXED,
            item_id UNINDEXED,
            content='integrator_items',
            content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
        );
        INSERT INTO integrator_items_fts(rowid, body, task_id, item_id)
            SELECT rowid, body, task_id, item_id
            FROM integrator_items
            WHERE kind IN ('user_message', 'agent_message')
              AND status IN ('completed', 'failed', 'declined')
              AND body IS NOT NULL
              AND trim(body) <> '';

        CREATE TRIGGER integrator_items_fts_insert AFTER INSERT ON integrator_items
        WHEN new.kind IN ('user_message', 'agent_message')
          AND new.status IN ('completed', 'failed', 'declined')
          AND new.body IS NOT NULL
          AND trim(new.body) <> ''
        BEGIN
            INSERT INTO integrator_items_fts(rowid, body, task_id, item_id)
            VALUES (new.rowid, new.body, new.task_id, new.item_id);
        END;

        CREATE TRIGGER integrator_items_fts_delete AFTER DELETE ON integrator_items
        WHEN old.kind IN ('user_message', 'agent_message')
          AND old.status IN ('completed', 'failed', 'declined')
          AND old.body IS NOT NULL
          AND trim(old.body) <> ''
        BEGIN
            INSERT INTO integrator_items_fts(integrator_items_fts, rowid, body, task_id, item_id)
            VALUES ('delete', old.rowid, old.body, old.task_id, old.item_id);
        END;

        CREATE TRIGGER integrator_items_fts_update_delete BEFORE UPDATE ON integrator_items
        WHEN old.kind IN ('user_message', 'agent_message')
          AND old.status IN ('completed', 'failed', 'declined')
          AND old.body IS NOT NULL
          AND trim(old.body) <> ''
        BEGIN
            INSERT INTO integrator_items_fts(integrator_items_fts, rowid, body, task_id, item_id)
            VALUES ('delete', old.rowid, old.body, old.task_id, old.item_id);
        END;

        CREATE TRIGGER integrator_items_fts_update_insert AFTER UPDATE ON integrator_items
        WHEN new.kind IN ('user_message', 'agent_message')
          AND new.status IN ('completed', 'failed', 'declined')
          AND new.body IS NOT NULL
          AND trim(new.body) <> ''
        BEGIN
            INSERT INTO integrator_items_fts(rowid, body, task_id, item_id)
            VALUES (new.rowid, new.body, new.task_id, new.item_id);
        END;
        "#,
    ),
    (
        23,
        r#"
        ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'code'
            CHECK (kind IN ('code', 'chat'));
        CREATE INDEX tasks_kind_updated_at_idx
            ON tasks(kind, archived, pinned DESC, updated_at DESC);

        ALTER TABLE composer_drafts ADD COLUMN context_references_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE queued_messages ADD COLUMN context_references_json TEXT NOT NULL DEFAULT '[]';

        CREATE TABLE task_context_references (
            id TEXT PRIMARY KEY,
            target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            source_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
            source_title TEXT NOT NULL,
            source_watermark INTEGER NOT NULL,
            message_count INTEGER NOT NULL,
            rendered_chars INTEGER NOT NULL,
            rendered_sha256 TEXT NOT NULL,
            rendered_markdown TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX task_context_references_target_idx
            ON task_context_references(target_task_id, created_at DESC);
        CREATE INDEX task_context_references_source_idx
            ON task_context_references(source_task_id)
            WHERE source_task_id IS NOT NULL;

        CREATE TABLE memories (
            id TEXT PRIMARY KEY,
            text TEXT NOT NULL,
            normalized_text TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL CHECK (state IN ('active', 'disabled')),
            creator TEXT NOT NULL CHECK (creator IN ('user', 'agent')),
            source_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
            source_item_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_used_at TEXT
        );
        CREATE INDEX memories_state_updated_at_idx
            ON memories(state, updated_at DESC, id);
        "#,
    ),
    (
        24,
        r#"
        ALTER TABLE automations ADD COLUMN iteration_notes INTEGER NOT NULL DEFAULT 0
            CHECK (iteration_notes IN (0, 1));
        ALTER TABLE automations ADD COLUMN next_run_note TEXT;
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
                "DELETE FROM automation_runs;
                 DELETE FROM automations;
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

    /// Returns the persisted provider usage projections grouped by the runtime
    /// selected for each task. Missing provider usage remains a zero-valued
    /// projection so callers can label it as unavailable rather than infer it.
    pub fn provider_usage_rows(&self) -> Result<Vec<(String, u64, u64, UsageProjection)>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                r#"
                SELECT COALESCE(tasks.runtime, 'unknown'),
                       COUNT(DISTINCT integrator_turns.turn_id),
                       integrator_task_projection.usage_json
                FROM tasks
                LEFT JOIN integrator_turns ON integrator_turns.task_id = tasks.id
                LEFT JOIN integrator_task_projection ON integrator_task_projection.task_id = tasks.id
                GROUP BY tasks.id, tasks.runtime, integrator_task_projection.usage_json
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

    /// Verified skill invocations are persisted on the provider-backed user
    /// item itself. Distinct stable ids keep retries, snapshot updates, and
    /// copied fork history from inflating the count.
    pub fn skill_invocation_counts(&self) -> Result<BTreeMap<String, u64>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT native_skill, COUNT(DISTINCT stable_id) FROM integrator_items \
                 WHERE native_skill IS NOT NULL GROUP BY native_skill",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
            })
            .map_err(storage_error)?;
        let mut counts = BTreeMap::new();
        for row in rows {
            let (skill, count) = row.map_err(storage_error)?;
            counts.insert(skill, count);
        }
        Ok(counts)
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
        project_tombstone.context_references.clear();
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
                "SELECT project_id, task_id, prompt, attachments_json, context_references_json, runtime, model, effort, permission, delegation, selection_start, selection_end, revision, updated_at FROM composer_drafts ORDER BY updated_at DESC",
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
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, String>(13)?,
                ))
            })
            .map_err(storage_error)?;
        rows.map(|row| {
            let (
                project_id,
                task_id,
                prompt,
                attachments,
                context_references,
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
                context_references: serde_json::from_str::<Vec<ChatContextReference>>(
                    &context_references,
                )
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

    /// Detaches a trusted project and deletes Integrator-owned history for it
    /// (tasks and cascaded session/projection rows). Never touches the folder
    /// on disk — filesystem deletion is an explicit host-layer choice.
    pub fn remove_trusted_project(&self, project_id: ProjectId) -> Result<TrustedProject> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let project = {
            let mut statement = transaction
                .prepare(
                    "SELECT p.id, p.display_name, p.repository_root, g.repository_root, g.git_common_directory, p.created_at, p.last_opened_at FROM trusted_projects p LEFT JOIN project_git_repositories g ON g.project_id = p.id WHERE p.id = ?1",
                )
                .map_err(storage_error)?;
            statement
                .query_row([project_id.to_string()], |row| {
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
                .optional()
                .map_err(storage_error)?
                .ok_or_else(|| IntegratorError::NotFound(format!("project {project_id}")))
                .and_then(
                    |(id, display_name, root, git_root, common, created, opened)| {
                        Ok(TrustedProject {
                            id: ProjectId::from_str(&id).map_err(invalid_stored)?,
                            display_name,
                            repository_root: PathBuf::from(root),
                            git_repository_root: git_root.map(PathBuf::from),
                            git_common_directory: common.map(PathBuf::from),
                            created_at: parse_time(&created)?,
                            last_opened_at: parse_time(&opened)?,
                        })
                    },
                )?
        };
        let project_root = project.repository_root.to_string_lossy().into_owned();
        // Tasks are path-linked rather than FK-linked; wipe them explicitly so
        // chat history leaves with the project instead of becoming orphaned.
        transaction
            .execute(
                "DELETE FROM tasks WHERE repository_path = ?1",
                [&project_root],
            )
            .map_err(storage_error)?;
        let changed = transaction
            .execute(
                "DELETE FROM trusted_projects WHERE id = ?1",
                [project_id.to_string()],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("project {project_id}")));
        }
        transaction.commit().map_err(storage_error)?;
        Ok(project)
    }

    /// Deletes Integrator-owned code-task history for an exact legacy
    /// repository path that has no trusted-project row. This never grants
    /// filesystem authority or removes the path itself.
    pub fn remove_project_history_by_repository_path(
        &self,
        repository_path: &Path,
    ) -> Result<usize> {
        let repository_path = repository_path.to_string_lossy();
        if repository_path.trim().is_empty() || repository_path.chars().count() > 4_096 {
            return Err(IntegratorError::InvalidInput(
                "legacy project repository path is invalid".into(),
            ));
        }
        self.connection
            .lock()
            .execute(
                "DELETE FROM tasks WHERE kind = 'code' AND repository_path = ?1",
                [repository_path.as_ref()],
            )
            .map_err(storage_error)
    }

    /// Live navigation set: non-archived tasks ordered for the sidebar.
    pub fn list_tasks(&self) -> Result<Vec<Task>> {
        self.query_tasks(
            "SELECT id, kind, title, repository_path, worktree_path, state, pinned, archived, runtime, model, effort, parent_task_id, created_at, updated_at FROM tasks WHERE archived = 0 ORDER BY pinned DESC, updated_at DESC",
            [],
        )
    }

    /// Every task including archived rows. Used for full local backups only —
    /// workspace bootstrap and `task_list` stay on [`Self::list_tasks`].
    pub fn list_all_tasks(&self) -> Result<Vec<Task>> {
        self.query_tasks(
            "SELECT id, kind, title, repository_path, worktree_path, state, pinned, archived, runtime, model, effort, parent_task_id, created_at, updated_at FROM tasks ORDER BY pinned DESC, updated_at DESC",
            [],
        )
    }

    /// Paginated archived root chats for Archive UI. Cursor is opaque
    /// `updated_at\\tid` keyset pagination (newest first).
    pub fn list_archived_tasks(
        &self,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ArchivedTaskPage> {
        let limit = limit.clamp(1, 100);
        let connection = self.connection.lock();
        let total = connection
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE archived = 1 AND parent_task_id IS NULL",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)? as u64;
        let fetch_limit = (limit + 1) as i64;
        let rows = if let Some(cursor) = cursor {
            let (updated_at, id) = parse_archived_cursor(cursor)?;
            let mut statement = connection
                .prepare(
                    "SELECT id, kind, title, repository_path, worktree_path, state, pinned, archived, runtime, model, effort, parent_task_id, created_at, updated_at FROM tasks WHERE archived = 1 AND parent_task_id IS NULL AND (updated_at < ?1 OR (updated_at = ?1 AND id < ?2)) ORDER BY updated_at DESC, id DESC LIMIT ?3",
                )
                .map_err(storage_error)?;
            let mapped = statement
                .query_map(params![updated_at, id, fetch_limit], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, bool>(6)?,
                        row.get::<_, bool>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, Option<String>>(11)?,
                        row.get::<_, String>(12)?,
                        row.get::<_, String>(13)?,
                    ))
                })
                .map_err(storage_error)?;
            mapped
                .map(|row| parse_task_row(row.map_err(storage_error)?))
                .collect::<Result<Vec<_>>>()?
        } else {
            let mut statement = connection
                .prepare(
                    "SELECT id, kind, title, repository_path, worktree_path, state, pinned, archived, runtime, model, effort, parent_task_id, created_at, updated_at FROM tasks WHERE archived = 1 AND parent_task_id IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?1",
                )
                .map_err(storage_error)?;
            let mapped = statement
                .query_map(params![fetch_limit], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, bool>(6)?,
                        row.get::<_, bool>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, Option<String>>(11)?,
                        row.get::<_, String>(12)?,
                        row.get::<_, String>(13)?,
                    ))
                })
                .map_err(storage_error)?;
            mapped
                .map(|row| parse_task_row(row.map_err(storage_error)?))
                .collect::<Result<Vec<_>>>()?
        };
        let next_cursor = if rows.len() > limit {
            rows.get(limit - 1).map(|task| {
                format_archived_cursor(&task.updated_at.to_rfc3339(), &task.id.to_string())
            })
        } else {
            None
        };
        Ok(ArchivedTaskPage {
            tasks: rows.into_iter().take(limit).collect(),
            next_cursor,
            total,
        })
    }

    fn query_tasks(&self, sql: &str, params: impl rusqlite::Params) -> Result<Vec<Task>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(sql).map_err(storage_error)?;
        let rows = statement
            .query_map(params, |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, bool>(6)?,
                    row.get::<_, bool>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, String>(13)?,
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
            context_references: input.context_references,
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
                "SELECT id, task_id, prompt, attachments_json, context_references_json, runtime, model, effort, permission, delegation, native_action_id, position, state, created_at, updated_at FROM queued_messages WHERE task_id = ?1 ORDER BY position, created_at",
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
                "SELECT id, task_id, prompt, attachments_json, context_references_json, runtime, model, effort, permission, delegation, native_action_id, position, state, created_at, updated_at FROM queued_messages WHERE task_id = ?1 AND id = ?2",
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
                "SELECT id, task_id, prompt, attachments_json, context_references_json, runtime, model, effort, permission, delegation, native_action_id, position, state, created_at, updated_at FROM queued_messages WHERE task_id = ?1 AND id = ?2",
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

    /// Permanently deletes one chat and cascaded Integrator-owned rows
    /// (sessions, projections, queue, drafts). Never touches the project folder.
    pub fn remove_task(&self, task_id: TaskId) -> Result<Task> {
        let task = self.get_task(task_id)?;
        let changed = self
            .connection
            .lock()
            .execute("DELETE FROM tasks WHERE id = ?1", [task_id.to_string()])
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("task {task_id}")));
        }
        Ok(task)
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
                "SELECT message, started_at FROM commit_message_jobs WHERE task_id = ?1 AND provider = ?2 AND diff_fingerprint = ?3",
                params![task_id.to_string(), provider, diff_fingerprint],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, String>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?;
        if let Some((message, started_at)) = existing {
            if let Some(message) = message {
                transaction.commit().map_err(storage_error)?;
                return Ok(CommitMessageGenerationClaim::Cached(message));
            }
            // Failed generations release their claim explicitly, but a crash
            // mid-generation would otherwise pin InProgress forever. Callers
            // time out well within this window, so an old unfinished claim is
            // orphaned, not racing.
            let stale = DateTime::parse_from_rfc3339(&started_at)
                .map(|started| {
                    Utc::now().signed_duration_since(started.with_timezone(&Utc))
                        > chrono::Duration::seconds(COMMIT_MESSAGE_CLAIM_TTL_SECONDS)
                })
                .unwrap_or(true);
            if !stale {
                transaction.commit().map_err(storage_error)?;
                return Ok(CommitMessageGenerationClaim::InProgress);
            }
            transaction
                .execute(
                    "DELETE FROM commit_message_jobs WHERE task_id = ?1 AND provider = ?2 AND diff_fingerprint = ?3 AND message IS NULL",
                    params![task_id.to_string(), provider, diff_fingerprint],
                )
                .map_err(storage_error)?;
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

    /// Release an unfinished claim so a failed generation can be retried
    /// immediately instead of waiting out the stale-claim window. Completed
    /// (cached) results are never removed.
    pub fn abandon_commit_message_generation(
        &self,
        task_id: TaskId,
        provider: &str,
        diff_fingerprint: &str,
    ) -> Result<()> {
        self.connection
            .lock()
            .execute(
                "DELETE FROM commit_message_jobs WHERE task_id = ?1 AND provider = ?2 AND diff_fingerprint = ?3 AND message IS NULL",
                params![task_id.to_string(), provider, diff_fingerprint],
            )
            .map_err(storage_error)?;
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
        let connection = self.connection.lock();
        let changed = connection
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
        drop(connection);
        self.get_task(task_id)
    }

    pub fn get_task(&self, task_id: TaskId) -> Result<Task> {
        let connection = self.connection.lock();
        let row = connection
            .query_row(
                "SELECT id, kind, title, repository_path, worktree_path, state, pinned, archived, runtime, model, effort, parent_task_id, created_at, updated_at FROM tasks WHERE id = ?1",
                [task_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, bool>(6)?,
                        row.get::<_, bool>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, Option<String>>(11)?,
                        row.get::<_, String>(12)?,
                        row.get::<_, String>(13)?,
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

    /// Resolve one renderer-selected Chat reference inside the native store
    /// and persist the exact bounded Markdown snapshot supplied to the target.
    pub fn resolve_chat_context_reference(
        &self,
        target_task_id: TaskId,
        reference: &ChatContextReference,
    ) -> Result<TaskContextReference> {
        const MAX_RENDERED_CHARS: usize = 64 * 1024;
        const MAX_MESSAGES: usize = 500;

        if target_task_id == reference.source_task_id {
            return Err(IntegratorError::InvalidInput(
                "a chat cannot reference itself".into(),
            ));
        }
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        ensure_task_exists(&transaction, target_task_id)?;
        let (source_kind, source_title) = transaction
            .query_row(
                "SELECT kind, title FROM tasks WHERE id = ?1",
                [reference.source_task_id.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| {
                IntegratorError::NotFound(format!("task {}", reference.source_task_id))
            })?;
        if TaskKind::from_str(&source_kind)? != TaskKind::Chat {
            return Err(IntegratorError::InvalidInput(
                "only Chat tasks can be used as chat context".into(),
            ));
        }

        let mut statement = transaction
            .prepare(
                "SELECT kind, body, last_event_seq FROM integrator_items \
                 WHERE task_id = ?1 AND kind IN ('user_message', 'agent_message') \
                   AND status = 'completed' AND body IS NOT NULL AND trim(body) <> '' \
                 ORDER BY CASE WHEN first_event_seq = 0 THEN last_event_seq ELSE first_event_seq END, last_event_seq",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([reference.source_task_id.to_string()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(storage_error)?;
        let mut messages = Vec::new();
        for row in rows {
            if messages.len() == MAX_MESSAGES {
                return Err(IntegratorError::InvalidInput(
                    "chat context is too large; select a smaller chat or wait for range controls"
                        .into(),
                ));
            }
            messages.push(row.map_err(storage_error)?);
        }
        drop(statement);
        if messages.is_empty() {
            return Err(IntegratorError::InvalidInput(
                "chat context has no completed messages".into(),
            ));
        }

        let mut markdown = format!("# Chat: {}\n", source_title.trim());
        let mut watermark = 0_i64;
        for (kind, body, seq) in &messages {
            let speaker = if kind == "user_message" {
                "User"
            } else {
                "Assistant"
            };
            markdown.push_str("\n## ");
            markdown.push_str(speaker);
            markdown.push_str("\n\n");
            markdown.push_str(body.trim());
            markdown.push('\n');
            watermark = watermark.max(*seq);
            if markdown.chars().count() > MAX_RENDERED_CHARS {
                return Err(IntegratorError::InvalidInput(
                    "chat context is too large; select a smaller chat or wait for range controls"
                        .into(),
                ));
            }
        }
        let rendered_chars = markdown.chars().count();
        let digest = format!("{:x}", Sha256::digest(markdown.as_bytes()));
        let created_at = Utc::now();
        transaction
            .execute(
                "INSERT INTO task_context_references(id, target_task_id, source_task_id, source_title, source_watermark, message_count, rendered_chars, rendered_sha256, rendered_markdown, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT(id) DO NOTHING",
                params![
                    reference.id.to_string(),
                    target_task_id.to_string(),
                    reference.source_task_id.to_string(),
                    source_title,
                    watermark,
                    messages.len() as i64,
                    rendered_chars as i64,
                    digest,
                    markdown,
                    created_at.to_rfc3339(),
                ],
            )
            .map_err(storage_error)?;
        let stored = query_context_reference(&transaction, reference.id)?;
        if stored.target_task_id != target_task_id
            || stored.source_task_id != Some(reference.source_task_id)
        {
            return Err(IntegratorError::InvalidInput(
                "context reference id is already bound to another task".into(),
            ));
        }
        transaction.commit().map_err(storage_error)?;
        Ok(stored)
    }

    pub fn list_context_references(
        &self,
        target_task_id: TaskId,
    ) -> Result<Vec<TaskContextReference>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT id, target_task_id, source_task_id, source_title, source_watermark, message_count, rendered_chars, rendered_sha256, rendered_markdown, created_at \
                 FROM task_context_references WHERE target_task_id = ?1 ORDER BY created_at, id",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([target_task_id.to_string()], parse_context_reference_row)
            .map_err(storage_error)?;
        rows.map(|row| parse_context_reference(row.map_err(storage_error)?))
            .collect()
    }

    pub fn create_memory(&self, input: NewMemoryEntry) -> Result<MemoryEntry> {
        let text = normalize_memory_text(&input.text)?;
        let normalized = normalized_memory_key(&text);
        let source_item_id = normalize_optional_text(input.source_item_id, 512)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        if let Some(task_id) = input.source_task_id {
            ensure_task_exists(&transaction, task_id)?;
        }
        ensure_memory_capacity(&transaction, None)?;
        let now = Utc::now();
        let memory = MemoryEntry {
            id: MemoryId::new(),
            text,
            state: MemoryState::Active,
            creator: input.creator,
            source_task_id: input.source_task_id,
            source_item_id,
            created_at: now,
            updated_at: now,
            last_used_at: None,
        };
        transaction
            .execute(
                "INSERT INTO memories(id, text, normalized_text, state, creator, source_task_id, source_item_id, created_at, updated_at, last_used_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
                params![
                    memory.id.to_string(),
                    &memory.text,
                    normalized,
                    memory.state.as_str(),
                    memory.creator.as_str(),
                    memory.source_task_id.map(|id| id.to_string()),
                    &memory.source_item_id,
                    memory.created_at.to_rfc3339(),
                    memory.updated_at.to_rfc3339(),
                ],
            )
            .map_err(|error| map_memory_write_error(error, "memory already exists"))?;
        transaction.commit().map_err(storage_error)?;
        Ok(memory)
    }

    pub fn list_memories(&self) -> Result<Vec<MemoryEntry>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT id, text, state, creator, source_task_id, source_item_id, created_at, updated_at, last_used_at \
                 FROM memories ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC, id",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], parse_memory_row)
            .map_err(storage_error)?;
        rows.map(|row| parse_memory(row.map_err(storage_error)?))
            .collect()
    }

    pub fn update_memory_text(&self, memory_id: MemoryId, text: &str) -> Result<MemoryEntry> {
        let text = normalize_memory_text(text)?;
        let normalized = normalized_memory_key(&text);
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE memories SET text = ?1, normalized_text = ?2, updated_at = ?3 WHERE id = ?4",
                params![text, normalized, Utc::now().to_rfc3339(), memory_id.to_string()],
            )
            .map_err(|error| map_memory_write_error(error, "memory already exists"))?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("memory {memory_id}")));
        }
        self.get_memory(memory_id)
    }

    pub fn set_memory_state(&self, memory_id: MemoryId, state: MemoryState) -> Result<MemoryEntry> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        if state == MemoryState::Active {
            ensure_memory_capacity(&transaction, Some(memory_id))?;
        }
        let changed = transaction
            .execute(
                "UPDATE memories SET state = ?1, updated_at = ?2 WHERE id = ?3",
                params![
                    state.as_str(),
                    Utc::now().to_rfc3339(),
                    memory_id.to_string()
                ],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("memory {memory_id}")));
        }
        let memory = query_memory(&transaction, memory_id)?;
        transaction.commit().map_err(storage_error)?;
        Ok(memory)
    }

    pub fn delete_memory(&self, memory_id: MemoryId) -> Result<()> {
        let changed = self
            .connection
            .lock()
            .execute(
                "DELETE FROM memories WHERE id = ?1",
                [memory_id.to_string()],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("memory {memory_id}")));
        }
        Ok(())
    }

    pub fn active_memories_for_injection(&self) -> Result<Vec<MemoryEntry>> {
        const TOTAL_CHAR_LIMIT: usize = 8_000;
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT id, text, state, creator, source_task_id, source_item_id, created_at, updated_at, last_used_at \
                 FROM memories WHERE state = 'active' ORDER BY updated_at DESC, id LIMIT 20",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], parse_memory_row)
            .map_err(storage_error)?;
        let mut included = Vec::new();
        let mut used = 0;
        for row in rows {
            let memory = parse_memory(row.map_err(storage_error)?)?;
            let chars = memory.text.chars().count();
            if used + chars > TOTAL_CHAR_LIMIT {
                break;
            }
            used += chars;
            included.push(memory);
        }
        Ok(included)
    }

    pub fn mark_memories_used(&self, memory_ids: &[MemoryId]) -> Result<()> {
        if memory_ids.is_empty() {
            return Ok(());
        }
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let now = Utc::now().to_rfc3339();
        for memory_id in memory_ids {
            transaction
                .execute(
                    "UPDATE memories SET last_used_at = ?1 WHERE id = ?2 AND state = 'active'",
                    params![&now, memory_id.to_string()],
                )
                .map_err(storage_error)?;
        }
        transaction.commit().map_err(storage_error)
    }

    fn get_memory(&self, memory_id: MemoryId) -> Result<MemoryEntry> {
        query_memory(&self.connection.lock(), memory_id)
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
            provider_resume_states: self.list_provider_resume_states()?,
            composer_drafts: self.list_composer_drafts()?,
            queued_messages: self.list_all_queued_messages()?,
            context_references: self.list_all_context_references()?,
            memories: self.list_memories()?,
        })
    }

    pub fn upsert_provider_resume_state(&self, state: &ProviderResumeState) -> Result<()> {
        if state.session_ref.trim().is_empty() || state.session_ref.len() > 512 {
            return Err(IntegratorError::InvalidInput(
                "provider resume identity is invalid".into(),
            ));
        }
        if !state.repository_root.is_absolute() {
            return Err(IntegratorError::InvalidInput(
                "provider resume repository must be absolute".into(),
            ));
        }
        self.connection
            .lock()
            .execute(
                "INSERT INTO provider_resume_states(task_id,provider,session_ref,repository_root,permission,delegation,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(task_id) DO UPDATE SET provider=excluded.provider,session_ref=excluded.session_ref,repository_root=excluded.repository_root,permission=excluded.permission,delegation=excluded.delegation,updated_at=excluded.updated_at",
                params![
                    state.task_id.to_string(),
                    state.provider.as_str(),
                    state.session_ref,
                    state.repository_root.to_string_lossy(),
                    state.permission,
                    state.delegation,
                    state.updated_at.to_rfc3339(),
                ],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    pub fn clear_provider_resume_state(&self, task_id: TaskId) -> Result<()> {
        let connection = self.connection.lock();
        connection
            .execute(
                "DELETE FROM provider_resume_states WHERE task_id = ?1",
                [task_id.to_string()],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    pub fn provider_resume_state(&self, task_id: TaskId) -> Result<Option<ProviderResumeState>> {
        let row = self
            .connection
            .lock()
            .query_row(
                "SELECT provider,session_ref,repository_root,permission,delegation,updated_at FROM provider_resume_states WHERE task_id=?1",
                [task_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?;
        row.map(
            |(provider, session_ref, repository_root, permission, delegation, updated_at)| {
                Ok(ProviderResumeState {
                    task_id,
                    provider: ProviderKind::from_str(&provider)?,
                    session_ref,
                    repository_root: PathBuf::from(repository_root),
                    permission,
                    delegation,
                    updated_at: parse_time(&updated_at)?,
                })
            },
        )
        .transpose()
    }

    pub fn list_provider_resume_states(&self) -> Result<Vec<ProviderResumeState>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT task_id,provider,session_ref,repository_root,permission,delegation,updated_at FROM provider_resume_states ORDER BY updated_at DESC",
            )
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
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(storage_error)?;
        rows.map(|row| {
            let (
                task_id,
                provider,
                session_ref,
                repository_root,
                permission,
                delegation,
                updated_at,
            ) = row.map_err(storage_error)?;
            Ok(ProviderResumeState {
                task_id: TaskId::from_str(&task_id).map_err(invalid_stored)?,
                provider: ProviderKind::from_str(&provider)?,
                session_ref,
                repository_root: PathBuf::from(repository_root),
                permission,
                delegation,
                updated_at: parse_time(&updated_at)?,
            })
        })
        .collect()
    }

    fn list_all_queued_messages(&self) -> Result<Vec<QueuedMessage>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT id, task_id, prompt, attachments_json, context_references_json, runtime, model, effort, permission, delegation, native_action_id, position, state, created_at, updated_at FROM queued_messages ORDER BY task_id, position, created_at",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], parse_queued_message_row)
            .map_err(storage_error)?;
        rows.map(|row| parse_queued_message(row.map_err(storage_error)?))
            .collect()
    }

    fn list_all_context_references(&self) -> Result<Vec<TaskContextReference>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT id, target_task_id, source_task_id, source_title, source_watermark, message_count, rendered_chars, rendered_sha256, rendered_markdown, created_at FROM task_context_references ORDER BY created_at, id",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], parse_context_reference_row)
            .map_err(storage_error)?;
        rows.map(|row| parse_context_reference(row.map_err(storage_error)?))
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
fn format_archived_cursor(updated_at: &str, id: &str) -> String {
    format!("{updated_at}\t{id}")
}

fn parse_archived_cursor(cursor: &str) -> Result<(String, String)> {
    let (updated_at, id) = cursor
        .split_once('\t')
        .ok_or_else(|| IntegratorError::InvalidInput("archived task cursor is invalid".into()))?;
    if updated_at.is_empty() || id.is_empty() {
        return Err(IntegratorError::InvalidInput(
            "archived task cursor is invalid".into(),
        ));
    }
    Ok((updated_at.to_owned(), id.to_owned()))
}

fn parse_task_row(
    row: (
        String,
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
        kind,
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
        kind: TaskKind::from_str(&kind)?,
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
    if input.kind == TaskKind::Chat {
        if input.repository_path.is_some()
            || input.worktree_path.is_some()
            || input.parent_task_id.is_some()
        {
            return Err(IntegratorError::InvalidInput(
                "Chat tasks cannot own a repository, worktree, or parent task".into(),
            ));
        }
    }
    let now = Utc::now();
    Ok(Task {
        id: TaskId::new(),
        kind: input.kind,
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
            "INSERT INTO tasks(id, kind, title, repository_path, worktree_path, state, pinned, archived, runtime, model, effort, parent_task_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                task.id.to_string(),
                task.kind.as_str(),
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
    validate_context_references(&draft.context_references)?;
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
    validate_context_references(&input.context_references)?;
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

fn validate_context_references(references: &[ChatContextReference]) -> Result<()> {
    const REFERENCE_LIMIT: usize = 8;
    if references.len() > REFERENCE_LIMIT {
        return Err(IntegratorError::InvalidInput(format!(
            "a message cannot contain more than {REFERENCE_LIMIT} chat references"
        )));
    }
    let mut ids = references
        .iter()
        .map(|reference| reference.id)
        .collect::<Vec<_>>();
    ids.sort_unstable_by_key(ToString::to_string);
    ids.dedup();
    if ids.len() != references.len()
        || references.iter().any(|reference| {
            reference.source_title.trim().is_empty()
                || reference.source_title.chars().count() > 240
                || reference.source_title.contains('\0')
        })
    {
        return Err(IntegratorError::InvalidInput(
            "message contains an invalid chat reference".into(),
        ));
    }
    Ok(())
}

fn insert_queued_message(connection: &Connection, message: &QueuedMessage) -> Result<()> {
    let attachments = serde_json::to_string(&message.attachments)?;
    let context_references = serde_json::to_string(&message.context_references)?;
    connection
        .execute(
            "INSERT INTO queued_messages(id, task_id, prompt, attachments_json, context_references_json, runtime, model, effort, permission, delegation, native_action_id, position, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                message.id.to_string(),
                message.task_id.to_string(),
                &message.prompt,
                attachments,
                context_references,
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
        row.get(14)?,
    ))
}

fn parse_queued_message(row: QueuedMessageRow) -> Result<QueuedMessage> {
    let (
        id,
        task_id,
        prompt,
        attachments,
        context_references,
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
        context_references: serde_json::from_str(&context_references)?,
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
    let context_references = serde_json::to_string(&draft.context_references)?;
    connection
        .execute(
            r#"
            INSERT INTO composer_drafts(
                draft_key, project_id, task_id, prompt, attachments_json, context_references_json,
                runtime, model, effort, permission, delegation, selection_start, selection_end,
                revision, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            ON CONFLICT(draft_key) DO UPDATE SET
                project_id=excluded.project_id,
                task_id=excluded.task_id,
                prompt=excluded.prompt,
                attachments_json=excluded.attachments_json,
                context_references_json=excluded.context_references_json,
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
                context_references,
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

type ContextReferenceRow = (
    String,
    String,
    Option<String>,
    String,
    i64,
    i64,
    i64,
    String,
    String,
    String,
);

fn parse_context_reference_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ContextReferenceRow> {
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
    ))
}

fn parse_context_reference(row: ContextReferenceRow) -> Result<TaskContextReference> {
    let (
        id,
        target_task_id,
        source_task_id,
        source_title,
        source_watermark,
        message_count,
        rendered_chars,
        rendered_sha256,
        rendered_markdown,
        created_at,
    ) = row;
    Ok(TaskContextReference {
        id: ContextReferenceId::from_str(&id).map_err(invalid_stored)?,
        target_task_id: TaskId::from_str(&target_task_id).map_err(invalid_stored)?,
        source_task_id: source_task_id
            .as_deref()
            .map(TaskId::from_str)
            .transpose()
            .map_err(invalid_stored)?,
        source_title,
        source_watermark: u64::try_from(source_watermark).map_err(invalid_stored)?,
        message_count: u32::try_from(message_count).map_err(invalid_stored)?,
        rendered_chars: u32::try_from(rendered_chars).map_err(invalid_stored)?,
        rendered_sha256,
        rendered_markdown,
        created_at: parse_time(&created_at)?,
    })
}

fn query_context_reference(
    connection: &Connection,
    reference_id: ContextReferenceId,
) -> Result<TaskContextReference> {
    let row = connection
        .query_row(
            "SELECT id, target_task_id, source_task_id, source_title, source_watermark, message_count, rendered_chars, rendered_sha256, rendered_markdown, created_at \
             FROM task_context_references WHERE id = ?1",
            [reference_id.to_string()],
            parse_context_reference_row,
        )
        .optional()
        .map_err(storage_error)?
        .ok_or_else(|| IntegratorError::NotFound(format!("context reference {reference_id}")))?;
    parse_context_reference(row)
}

type MemoryRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    Option<String>,
);

fn parse_memory_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRow> {
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
    ))
}

fn parse_memory(row: MemoryRow) -> Result<MemoryEntry> {
    let (
        id,
        text,
        state,
        creator,
        source_task_id,
        source_item_id,
        created_at,
        updated_at,
        last_used_at,
    ) = row;
    Ok(MemoryEntry {
        id: MemoryId::from_str(&id).map_err(invalid_stored)?,
        text,
        state: MemoryState::from_str(&state)?,
        creator: MemoryCreator::from_str(&creator)?,
        source_task_id: source_task_id
            .as_deref()
            .map(TaskId::from_str)
            .transpose()
            .map_err(invalid_stored)?,
        source_item_id,
        created_at: parse_time(&created_at)?,
        updated_at: parse_time(&updated_at)?,
        last_used_at: last_used_at.map(|value| parse_time(&value)).transpose()?,
    })
}

fn query_memory(connection: &Connection, memory_id: MemoryId) -> Result<MemoryEntry> {
    let row = connection
        .query_row(
            "SELECT id, text, state, creator, source_task_id, source_item_id, created_at, updated_at, last_used_at FROM memories WHERE id = ?1",
            [memory_id.to_string()],
            parse_memory_row,
        )
        .optional()
        .map_err(storage_error)?
        .ok_or_else(|| IntegratorError::NotFound(format!("memory {memory_id}")))?;
    parse_memory(row)
}

fn normalize_memory_text(value: &str) -> Result<String> {
    let text = value.trim();
    if text.is_empty() || text.chars().count() > 500 || text.contains('\0') {
        return Err(IntegratorError::InvalidInput(
            "memory must contain 1 to 500 characters".into(),
        ));
    }
    if looks_like_memory_secret(text) {
        return Err(IntegratorError::InvalidInput(
            "memory looks like a credential or secret and was not saved".into(),
        ));
    }
    Ok(text.to_owned())
}

fn normalized_memory_key(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn looks_like_memory_secret(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let labeled_secret = [
        "api_key",
        "api key:",
        "apikey=",
        "password:",
        "password=",
        "secret:",
        "secret=",
        "access_token",
        "refresh_token",
        "authorization: bearer",
        "-----begin private key-----",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    let openai_style_key = lower.split_whitespace().any(|word| {
        let token = word.trim_matches(|character: char| {
            !character.is_ascii_alphanumeric() && character != '-' && character != '_'
        });
        token
            .strip_prefix("sk-")
            .is_some_and(|suffix| suffix.len() >= 16)
    });
    labeled_secret || openai_style_key
}

fn ensure_memory_capacity(connection: &Connection, excluding: Option<MemoryId>) -> Result<()> {
    let count = match excluding {
        Some(memory_id) => connection
            .query_row(
                "SELECT COUNT(*) FROM memories WHERE state = 'active' AND id <> ?1",
                [memory_id.to_string()],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)?,
        None => connection
            .query_row(
                "SELECT COUNT(*) FROM memories WHERE state = 'active'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)?,
    };
    if count >= 20 {
        return Err(IntegratorError::InvalidInput(
            "memory is full; disable or delete an entry before saving another".into(),
        ));
    }
    Ok(())
}

fn map_memory_write_error(error: rusqlite::Error, duplicate_message: &str) -> IntegratorError {
    if matches!(
        error,
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ErrorCode::ConstraintViolation,
                ..
            },
            _
        )
    ) {
        IntegratorError::InvalidInput(duplicate_message.into())
    } else {
        storage_error(error)
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
mod tests {
    use super::*;
    use integrator_core::{
        ItemKind, ItemProjection, ItemStatus, RuntimeBinding, RuntimeProjection,
        RuntimeProjectionEvent, TurnProjection, TurnStatus,
    };
    use integrator_runtime::{ProjectionMutation, ReducedProviderEvent};

    /// Drives the real ingest path so the forked rows under test are the ones
    /// a live provider would actually have written.
    fn seed_conversation(store: &LocalStore, task_id: TaskId) -> Vec<RuntimeProjectionEvent> {
        let binding = store
            .create_runtime_binding(task_id, "fork-process", ProviderKind::Codex)
            .expect("create runtime binding");
        let binding = store
            .attach_provider_thread(&binding, "fork-thread")
            .expect("attach provider thread");
        let started = Utc::now();
        [
            (ItemKind::UserMessage, "port the parser to the new lexer"),
            (ItemKind::AgentMessage, "here is the port"),
            (ItemKind::UserMessage, "now delete the old lexer"),
            (ItemKind::AgentMessage, "deleted"),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (kind, body))| {
            let item = ItemProjection {
                id: format!("codex:fork-thread:turn-1:item-{index}"),
                provider_item_id: format!("item-{index}"),
                kind,
                status: ItemStatus::Completed,
                title: None,
                body: Some(body.into()),
                native_skill: None,
                phase: None,
                command: None,
                cwd: None,
                output: None,
                exit_code: None,
                file_changes: None,
                mcp_server: None,
                mcp_tool: None,
                tool_input: None,
                truncated: false,
                updated_at: started + chrono::Duration::seconds(index as i64),
            };
            store
                .apply_reduced_event(
                    &binding,
                    &ReducedProviderEvent {
                        method: "item/completed".into(),
                        thread_id: "fork-thread".into(),
                        turn_id: Some("turn-1".into()),
                        audit_json: "{}".into(),
                        audit_truncated: false,
                        mutation: ProjectionMutation::ReplaceItem(item),
                        occurred_at: started + chrono::Duration::seconds(index as i64),
                    },
                )
                .expect("apply seeded event")
        })
        .collect()
    }

    fn item_bodies(store: &LocalStore, task_id: TaskId) -> Vec<String> {
        store
            .task_snapshot(task_id)
            .expect("hydrate snapshot")
            .hydrate
            .expect("compact hydrate")
            .items
            .into_iter()
            .filter_map(|item| item.body)
            .collect()
    }

    fn legacy_database_before(path: &Path, next_version: i64) -> Connection {
        let mut connection = Connection::open(path).expect("open legacy fixture");
        LocalStore::configure(&connection).expect("configure legacy fixture");
        connection
            .execute(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
                [],
            )
            .expect("create migration ledger");
        let applied_at = Utc::now().to_rfc3339();
        for (version, sql) in MIGRATIONS
            .iter()
            .filter(|(version, _)| *version < next_version)
        {
            let transaction = connection.transaction().expect("migration transaction");
            transaction
                .execute_batch(sql)
                .expect("apply legacy migration");
            transaction
                .execute(
                    "INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?1,?2)",
                    params![version, applied_at],
                )
                .expect("record legacy migration");
            transaction.commit().expect("commit legacy migration");
        }
        connection
    }

    fn fork_source(store: &LocalStore) -> Task {
        store
            .create_task(NewTask {
                kind: TaskKind::Code,
                title: "Port the parser".into(),
                repository_path: Some(PathBuf::from("/repo")),
                worktree_path: None,
                runtime: Some("codex".into()),
                model: Some("gpt-5-codex".into()),
                effort: Some("high".into()),
                parent_task_id: None,
            })
            .expect("create fork source")
    }

    #[test]
    fn whole_fork_copies_the_transcript_and_leaves_the_source_untouched() {
        let store = LocalStore::open_in_memory().expect("open store");
        let source = fork_source(&store);
        seed_conversation(&store, source.id);

        let fork = store
            .fork_task(source.id, None, "Port the parser: Copy 1".into())
            .expect("fork whole task");

        assert_ne!(fork.id, source.id);
        assert_eq!(fork.title, "Port the parser: Copy 1");
        // Routing settings must survive or the copy answers with a different
        // model than the conversation it continues.
        assert_eq!(fork.runtime, source.runtime);
        assert_eq!(fork.model, source.model);
        assert_eq!(fork.effort, source.effort);
        assert_eq!(fork.repository_path, source.repository_path);

        assert_eq!(
            item_bodies(&store, fork.id),
            vec![
                "port the parser to the new lexer",
                "here is the port",
                "now delete the old lexer",
                "deleted",
            ]
        );
        assert_eq!(item_bodies(&store, source.id), item_bodies(&store, fork.id));

        // Renaming or deleting a fork must not reach back into the source.
        store
            .update_task_metadata(fork.id, Some("Renamed fork".into()), None, None)
            .expect("rename fork");
        assert_eq!(
            store.get_task(source.id).expect("reread source").title,
            "Port the parser"
        );
        store.remove_task(fork.id).expect("remove fork");
        assert_eq!(item_bodies(&store, source.id).len(), 4);
    }

    #[test]
    fn branch_truncates_at_the_chosen_item_and_digests_only_the_kept_history() {
        let store = LocalStore::open_in_memory().expect("open store");
        let source = fork_source(&store);
        seed_conversation(&store, source.id);

        let branch = store
            .fork_task(
                source.id,
                Some("codex:fork-thread:turn-1:item-1"),
                "Port the parser: Branch 1".into(),
            )
            .expect("branch at the first reply");

        assert_eq!(
            item_bodies(&store, branch.id),
            vec!["port the parser to the new lexer", "here is the port"]
        );

        // The digest is what the branch's first prompt actually carries to a
        // fresh provider session, so truncation has to hold there too.
        let digest = store
            .task_conversation_digest(branch.id, 6 * 1024)
            .expect("branch digest")
            .expect("branch has history");
        assert!(digest.contains("here is the port"));
        assert!(
            !digest.contains("now delete the old lexer"),
            "history past the branch point leaked into the digest: {digest}"
        );

        // Resuming would make the provider replay its own untruncated
        // transcript and ignore every row copied above.
        assert!(
            store
                .provider_resume_state(branch.id)
                .expect("read branch resume state")
                .is_none()
        );
        assert!(
            !store
                .list_provider_sessions()
                .expect("list sessions")
                .iter()
                .any(|session| session.task_id == branch.id
                    && session.provider_thread_id == "fork-thread"),
            "the branch must not claim the source's provider thread"
        );
    }

    #[test]
    fn truncate_from_edit_clears_the_tip_and_drops_resume_state() {
        let store = LocalStore::open_in_memory().expect("open store");
        let source = fork_source(&store);
        seed_conversation(&store, source.id);
        store
            .upsert_provider_resume_state(&ProviderResumeState {
                task_id: source.id,
                provider: ProviderKind::Codex,
                session_ref: "resume-thread".into(),
                repository_root: PathBuf::from("/repo"),
                permission: "project-write".into(),
                delegation: "off".into(),
                updated_at: Utc::now(),
            })
            .expect("seed resume state");

        // item-2 is the second user message ("now delete…"); cutting there
        // keeps the first exchange and drops that prompt plus its reply.
        store
            .truncate_task_from(source.id, "codex:fork-thread:turn-1:item-2", false)
            .expect("truncate without salvage");
        assert_eq!(
            item_bodies(&store, source.id),
            vec!["port the parser to the new lexer", "here is the port"]
        );
        assert!(
            store
                .provider_resume_state(source.id)
                .expect("read resume")
                .is_none()
        );
        let digest = store
            .task_conversation_digest(source.id, 6 * 1024)
            .expect("digest")
            .expect("history");
        assert!(!digest.contains("deleted"));
        assert!(!digest.contains("discarded by a later edit"));
    }

    #[test]
    fn truncate_with_save_context_keeps_discarded_replies_in_the_digest() {
        let store = LocalStore::open_in_memory().expect("open store");
        let source = fork_source(&store);
        seed_conversation(&store, source.id);

        store
            .truncate_task_from(source.id, "codex:fork-thread:turn-1:item-2", true)
            .expect("truncate with salvage");

        assert_eq!(
            item_bodies(&store, source.id),
            vec!["port the parser to the new lexer", "here is the port"]
        );
        let digest = store
            .task_conversation_digest(source.id, 6 * 1024)
            .expect("digest")
            .expect("history");
        assert!(
            digest.contains("deleted"),
            "salvaged assistant reply missing from digest: {digest}"
        );
        assert!(digest.contains("discarded by a later edit"));
    }

    #[test]
    fn fork_while_running_excludes_the_live_turn_and_keeps_earlier_branching_available() {
        let store = LocalStore::open_in_memory().expect("open store");
        let source = fork_source(&store);
        seed_conversation(&store, source.id);

        assert!(matches!(
            store.fork_task(
                source.id,
                Some("codex:fork-thread:turn-1:item-99"),
                "x".into()
            ),
            Err(IntegratorError::NotFound(_))
        ));

        let binding = store
            .create_runtime_binding(source.id, "running-process", ProviderKind::Codex)
            .expect("create runtime binding");
        let binding = store
            .attach_provider_thread(&binding, "fork-thread")
            .expect("attach provider thread");
        store
            .apply_reduced_event(
                &binding,
                &ReducedProviderEvent {
                    method: "turn/started".into(),
                    thread_id: "fork-thread".into(),
                    turn_id: Some("turn-2".into()),
                    audit_json: "{}".into(),
                    audit_truncated: false,
                    mutation: ProjectionMutation::Turn(TurnProjection {
                        id: "turn-2".into(),
                        status: TurnStatus::InProgress,
                        stop_requested: false,
                        error: None,
                        started_at: Some(Utc::now()),
                        completed_at: None,
                    }),
                    occurred_at: Utc::now(),
                },
            )
            .expect("start a turn");

        for (provider_item_id, kind, status, body) in [
            (
                "live-user",
                ItemKind::UserMessage,
                ItemStatus::Completed,
                "unfinished request",
            ),
            (
                "live-assistant",
                ItemKind::AgentMessage,
                ItemStatus::InProgress,
                "partial reply",
            ),
        ] {
            store
                .apply_reduced_event(
                    &binding,
                    &ReducedProviderEvent {
                        method: "item/updated".into(),
                        thread_id: "fork-thread".into(),
                        turn_id: Some("turn-2".into()),
                        audit_json: "{}".into(),
                        audit_truncated: false,
                        mutation: ProjectionMutation::ReplaceItem(ItemProjection {
                            id: format!("codex:fork-thread:turn-2:{provider_item_id}"),
                            provider_item_id: provider_item_id.into(),
                            kind,
                            status,
                            title: None,
                            body: Some(body.into()),
                            native_skill: None,
                            phase: None,
                            command: None,
                            cwd: None,
                            output: None,
                            exit_code: None,
                            file_changes: None,
                            mcp_server: None,
                            mcp_tool: None,
                            tool_input: None,
                            truncated: false,
                            updated_at: Utc::now(),
                        }),
                        occurred_at: Utc::now(),
                    },
                )
                .expect("append live item");
        }

        let copy = store
            .fork_task(source.id, None, "Port the parser: Copy 1".into())
            .expect("copy settled history while source runs");
        assert_eq!(
            item_bodies(&store, copy.id),
            vec![
                "port the parser to the new lexer",
                "here is the port",
                "now delete the old lexer",
                "deleted",
            ]
        );
        assert_eq!(
            item_bodies(&store, source.id),
            vec![
                "port the parser to the new lexer",
                "here is the port",
                "now delete the old lexer",
                "deleted",
                "unfinished request",
                "partial reply",
            ]
        );
        assert!(
            store
                .task_has_unfinished_turn(source.id)
                .expect("source turn remains live")
        );
        assert!(
            !store
                .task_has_unfinished_turn(copy.id)
                .expect("copy contains settled history only")
        );

        let branch = store
            .fork_task(
                source.id,
                Some("codex:fork-thread:turn-1:item-1"),
                "Port the parser: Branch 1".into(),
            )
            .expect("branch above the live turn");
        assert_eq!(
            item_bodies(&store, branch.id),
            vec!["port the parser to the new lexer", "here is the port"]
        );

        assert!(matches!(
            store.fork_task(
                source.id,
                Some("codex:fork-thread:turn-2:live-assistant"),
                "x".into()
            ),
            Err(IntegratorError::InvalidInput(_))
        ));
        assert!(
            !store
                .list_tasks()
                .expect("list tasks")
                .iter()
                .any(|task| task.title == "x")
        );
    }

    fn create_naming_task(store: &LocalStore) -> Task {
        store
            .create_task(NewTask {
                kind: TaskKind::Code,
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
    fn abandoned_commit_message_claims_are_retryable_but_cached_results_stay() {
        let store = LocalStore::open_in_memory().expect("open store");
        let task = create_naming_task(&store);
        assert_eq!(
            store
                .claim_commit_message_generation(task.id, "antigravity", "diff-a")
                .expect("claim"),
            CommitMessageGenerationClaim::Claimed
        );
        store
            .abandon_commit_message_generation(task.id, "antigravity", "diff-a")
            .expect("release failed generation");
        assert_eq!(
            store
                .claim_commit_message_generation(task.id, "antigravity", "diff-a")
                .expect("re-claim"),
            CommitMessageGenerationClaim::Claimed
        );
        store
            .complete_commit_message_generation(task.id, "antigravity", "diff-a", "fix: retry")
            .expect("complete");
        store
            .abandon_commit_message_generation(task.id, "antigravity", "diff-a")
            .expect("abandon is a no-op once cached");
        assert_eq!(
            store
                .claim_commit_message_generation(task.id, "antigravity", "diff-a")
                .expect("cached claim"),
            CommitMessageGenerationClaim::Cached("fix: retry".into())
        );
    }

    #[test]
    fn stale_unfinished_commit_message_claims_expire() {
        let store = LocalStore::open_in_memory().expect("open store");
        let task = create_naming_task(&store);
        assert_eq!(
            store
                .claim_commit_message_generation(task.id, "antigravity", "diff-a")
                .expect("claim"),
            CommitMessageGenerationClaim::Claimed
        );
        // Age the claim past the TTL as if the app crashed mid-generation.
        let started = (Utc::now()
            - chrono::Duration::seconds(COMMIT_MESSAGE_CLAIM_TTL_SECONDS + 5))
        .to_rfc3339();
        store
            .connection
            .lock()
            .execute(
                "UPDATE commit_message_jobs SET started_at = ?1 WHERE task_id = ?2",
                params![started, task.id.to_string()],
            )
            .expect("age claim");
        assert_eq!(
            store
                .claim_commit_message_generation(task.id, "antigravity", "diff-a")
                .expect("expired claim is re-claimable"),
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
                kind: TaskKind::Code,
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
    fn provider_resume_state_round_trips_without_provider_credentials() {
        let store = LocalStore::open_in_memory().expect("open store");
        let task = create_naming_task(&store);
        let repository = std::env::temp_dir().join("integrator-resume-fixture");
        let state = ProviderResumeState {
            task_id: task.id,
            provider: ProviderKind::Antigravity,
            session_ref: "conversation-fixture".into(),
            repository_root: repository.clone(),
            permission: "project-write".into(),
            delegation: "off".into(),
            updated_at: Utc::now(),
        };
        store
            .upsert_provider_resume_state(&state)
            .expect("persist resume state");

        let restored = store
            .provider_resume_state(task.id)
            .expect("read resume state")
            .expect("resume state");
        assert_eq!(restored.provider, ProviderKind::Antigravity);
        assert_eq!(restored.session_ref, "conversation-fixture");
        assert_eq!(restored.repository_root, repository);
        assert_eq!(
            store.export().expect("export").provider_resume_states,
            vec![restored]
        );
    }

    #[test]
    fn clear_all_data_preserves_schema_and_migration_history() {
        let store = LocalStore::open_in_memory().expect("open store");
        let task = store
            .create_task(NewTask {
                kind: TaskKind::Code,
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
                kind: TaskKind::Code,
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
    fn provider_neutral_schema_migration_preserves_legacy_projects_and_transcripts() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("legacy-v21.sqlite3");
        let repository = directory.path().join("legacy-project");
        std::fs::create_dir(&repository).expect("create legacy project folder");
        let project_id = ProjectId::new();
        let task_id = TaskId::new();
        let provider_session_id = ProviderSessionId::new();
        let runtime_session_id = RuntimeSessionId::new();
        let now = Utc::now();
        let item = ItemProjection {
            id: "legacy-stable-message".into(),
            provider_item_id: "legacy-provider-message".into(),
            kind: ItemKind::UserMessage,
            status: ItemStatus::Completed,
            title: None,
            body: Some("migrationkeepsproject transcript survives".into()),
            native_skill: None,
            phase: None,
            command: None,
            cwd: None,
            output: None,
            exit_code: None,
            file_changes: None,
            mcp_server: None,
            mcp_tool: None,
            tool_input: None,
            truncated: false,
            updated_at: now,
        };
        let snapshot_event = RuntimeProjectionEvent {
            seq: 1,
            task_id,
            provider_session_id,
            provider: "codex".into(),
            thread_id: "legacy-thread".into(),
            turn_id: Some("legacy-turn".into()),
            occurred_at: now,
            projection: RuntimeProjection::ItemChanged { item: item.clone() },
        };

        {
            let connection = legacy_database_before(&path, 22);
            connection.execute(
                "INSERT INTO trusted_projects(id,display_name,repository_root,git_common_directory,created_at,last_opened_at) VALUES (?1,'Legacy project',?2,?3,?4,?4)",
                params![project_id.to_string(), repository.to_string_lossy(), repository.join(".git").to_string_lossy(), now.to_rfc3339()],
            ).expect("insert legacy project");
            connection.execute(
                "INSERT INTO project_git_repositories(project_id,repository_root,git_common_directory) VALUES (?1,?2,?3)",
                params![project_id.to_string(), repository.to_string_lossy(), repository.join(".git").to_string_lossy()],
            ).expect("insert legacy project git identity");
            connection.execute(
                "INSERT INTO tasks(id,title,repository_path,state,runtime,created_at,updated_at) VALUES (?1,'Legacy research',?2,'ready','codex',?3,?3)",
                params![task_id.to_string(), repository.to_string_lossy(), now.to_rfc3339()],
            ).expect("insert legacy task");
            connection.execute(
                "INSERT INTO provider_sessions(id,task_id,provider,provider_thread_id,created_at,updated_at) VALUES (?1,?2,'codex','legacy-thread',?3,?3)",
                params![provider_session_id.to_string(), task_id.to_string(), now.to_rfc3339()],
            ).expect("insert legacy provider session");
            connection.execute(
                "INSERT INTO runtime_sessions(id,task_id,provider_session_id,status,started_at,ended_at,process_id) VALUES (?1,?2,?3,'completed',?4,?4,'legacy-process')",
                params![runtime_session_id.to_string(), task_id.to_string(), provider_session_id.to_string(), now.to_rfc3339()],
            ).expect("insert legacy runtime session");
            connection.execute(
                "INSERT INTO codex_task_projection(task_id,provider_session_id,thread_id,current_turn_id,process_id,last_event_seq) VALUES (?1,?2,'legacy-thread','legacy-turn','legacy-process',1)",
                params![task_id.to_string(), provider_session_id.to_string()],
            ).expect("insert legacy task projection");
            connection.execute(
                "INSERT INTO codex_items(provider_session_id,task_id,thread_id,turn_id,item_id,stable_id,kind,status,body,updated_at,projection_json,last_event_seq,first_event_seq,first_occurred_at,snapshot_event_json) VALUES (?1,?2,'legacy-thread','legacy-turn',?3,?4,'user_message','completed',?5,?6,?7,1,1,?6,?8)",
                params![provider_session_id.to_string(), task_id.to_string(), item.provider_item_id, item.id, item.body, now.to_rfc3339(), serde_json::to_string(&item).expect("serialize item"), serde_json::to_string(&snapshot_event).expect("serialize snapshot event")],
            ).expect("insert legacy transcript item");
            connection.execute(
                "INSERT INTO codex_event_log(seq,task_id,provider_session_id,runtime_session_id,process_id,thread_id,turn_id,method,audit_json,audit_truncated,projection_json,occurred_at) VALUES (1,?1,?2,?3,'legacy-process','legacy-thread','legacy-turn','item/completed','{}',0,?4,?5)",
                params![task_id.to_string(), provider_session_id.to_string(), runtime_session_id.to_string(), serde_json::to_string(&snapshot_event).expect("serialize event"), now.to_rfc3339()],
            ).expect("insert legacy event");
        }

        let store = LocalStore::open(&path).expect("migrate populated legacy database");
        let connection = store.connection.lock();
        for old_name in [
            "codex_turns",
            "codex_items",
            "codex_approvals",
            "codex_task_projection",
            "codex_event_log",
            "codex_items_fts",
        ] {
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name=?1",
                    [old_name],
                    |row| row.get(0),
                )
                .expect("inspect legacy schema name");
            assert_eq!(count, 0, "legacy schema object remains: {old_name}");
        }
        let foreign_key_failures: i64 = connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .expect("check migrated foreign keys");
        assert_eq!(foreign_key_failures, 0);
        drop(connection);

        assert_eq!(
            store.list_trusted_projects().expect("list projects").len(),
            1
        );
        assert_eq!(store.list_tasks().expect("list tasks")[0].id, task_id);
        assert_eq!(
            store
                .list_provider_sessions()
                .expect("list providers")
                .len(),
            1
        );
        assert_eq!(
            store.list_runtime_sessions().expect("list runtimes").len(),
            1
        );
        assert_eq!(
            item_bodies(&store, task_id),
            vec!["migrationkeepsproject transcript survives"]
        );
        let search = store
            .search_task_messages("migrationkeepsproject", 10, false)
            .expect("search migrated transcript");
        assert_eq!(search.len(), 1);
        assert_eq!(search[0].0, task_id);
        drop(store);

        let reopened = LocalStore::open(&path).expect("reopen migrated database");
        assert_eq!(
            reopened.list_tasks().expect("list reopened tasks")[0].id,
            task_id
        );
        reopened.remove_task(task_id).expect("remove migrated task");
        let connection = reopened.connection.lock();
        for table in [
            "integrator_turns",
            "integrator_items",
            "integrator_approvals",
            "integrator_task_projection",
            "integrator_event_log",
        ] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .expect("check task cascade");
            assert_eq!(count, 0, "task rows remain in {table}");
        }
        drop(connection);
        assert_eq!(
            reopened
                .list_trusted_projects()
                .expect("project survives task removal")
                .len(),
            1
        );
    }

    #[test]
    fn provider_neutral_schema_migration_rolls_back_as_one_unit() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("blocked-v21.sqlite3");
        let task_id = TaskId::new();
        let provider_session_id = ProviderSessionId::new();
        let now = Utc::now().to_rfc3339();
        {
            let connection = legacy_database_before(&path, 22);
            connection.execute(
                "INSERT INTO tasks(id,title,state,created_at,updated_at) VALUES (?1,'Rollback fixture','ready',?2,?2)",
                params![task_id.to_string(), now],
            ).expect("insert rollback task");
            connection.execute(
                "INSERT INTO provider_sessions(id,task_id,provider,provider_thread_id,created_at,updated_at) VALUES (?1,?2,'codex','rollback-thread',?3,?3)",
                params![provider_session_id.to_string(), task_id.to_string(), now],
            ).expect("insert rollback provider session");
            connection.execute(
                "INSERT INTO codex_items(provider_session_id,task_id,thread_id,turn_id,item_id,stable_id,kind,status,body,updated_at,projection_json,last_event_seq) VALUES (?1,?2,'rollback-thread','rollback-turn','rollback-item','rollback-stable','user_message','completed','rollback needle',?3,'{}',1)",
                params![provider_session_id.to_string(), task_id.to_string(), now],
            ).expect("insert rollback item");
            connection
                .execute("CREATE TABLE integrator_items(blocker TEXT)", [])
                .expect("create deliberate rename conflict");
        }

        assert!(
            LocalStore::open(&path).is_err(),
            "the deliberate schema conflict must reject migration 22"
        );
        let connection = Connection::open(&path).expect("inspect rolled-back database");
        let migration_recorded: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version=22",
                [],
                |row| row.get(0),
            )
            .expect("read migration ledger");
        assert_eq!(migration_recorded, 0);
        for old_name in ["codex_turns", "codex_items", "codex_items_fts"] {
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name=?1",
                    [old_name],
                    |row| row.get(0),
                )
                .expect("inspect rolled-back object");
            assert_eq!(count, 1, "migration partially removed {old_name}");
        }
        let trigger_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='codex_items_fts_insert'",
                [],
                |row| row.get(0),
            )
            .expect("inspect rolled-back trigger");
        assert_eq!(trigger_count, 1);
        let item_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM codex_items", [], |row| row.get(0))
            .expect("read rolled-back item");
        assert_eq!(item_count, 1);
    }

    #[test]
    fn legacy_delegations_gain_a_frozen_standard_snapshot() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("legacy-delegation.sqlite3");
        let task_id = TaskId::new();
        let delegation_id = integrator_core::DelegationId::new();
        let now = Utc::now();
        {
            let mut connection = Connection::open(&path).expect("open v19 fixture");
            LocalStore::configure(&connection).expect("configure fixture");
            connection
                .execute(
                    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
                    [],
                )
                .expect("create migration ledger");
            for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version < 20) {
                let transaction = connection.transaction().expect("migration transaction");
                transaction.execute_batch(sql).expect("apply v19 migration");
                transaction
                    .execute(
                        "INSERT INTO schema_migrations(version,applied_at) VALUES (?1,?2)",
                        params![version, now.to_rfc3339()],
                    )
                    .expect("record migration");
                transaction.commit().expect("commit migration");
            }
            connection
                .execute(
                    "INSERT INTO tasks(id,title,state,created_at,updated_at) VALUES (?1,'Legacy parent','ready',?2,?2)",
                    params![task_id.to_string(), now.to_rfc3339()],
                )
                .expect("insert parent task");
            connection
                .execute(
                    "INSERT INTO delegations(id,parent_task_id,profile_id,profile_label,runtime,model,effort,permission,title,brief,status,created_at,updated_at) VALUES (?1,?2,'legacy-reviewer','Legacy reviewer','claude','sonnet','high','project-write','Review','Review the diff','completed',?3,?3)",
                    params![delegation_id.to_string(), task_id.to_string(), now.to_rfc3339()],
                )
                .expect("insert legacy delegation");
        }

        let store = LocalStore::open(&path).expect("migrate legacy delegation");
        let delegation = store
            .get_delegation(delegation_id)
            .expect("read migrated delegation");
        assert_eq!(delegation.service_level, "standard");
        assert_eq!(delegation.capability_snapshot.version, 0);
        assert_eq!(delegation.capability_snapshot.profile_id, "legacy-reviewer");
        assert_eq!(delegation.capability_snapshot.routes.len(), 1);
        assert_eq!(delegation.capability_snapshot.routes[0].runtime, "claude");
        assert_eq!(
            delegation.capability_snapshot.access_ceiling,
            integrator_core::DelegationPermission::ProjectWrite
        );
    }

    #[test]
    fn resume_replay_migration_removes_only_shadow_message_rows() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("resume-replay.sqlite3");
        let task_id = TaskId::new();
        let provider_session_id = ProviderSessionId::new();
        let now = Utc::now();
        {
            let mut connection = Connection::open(&path).expect("open v18 fixture");
            LocalStore::configure(&connection).expect("configure v18 fixture");
            connection
                .execute(
                    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
                    [],
                )
                .expect("create migration ledger");
            for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version < 19) {
                let transaction = connection.transaction().expect("migration transaction");
                transaction
                    .execute_batch(sql)
                    .expect("apply pre-repair migration");
                transaction
                    .execute(
                        "INSERT INTO schema_migrations(version,applied_at) VALUES (?1,?2)",
                        params![version, now.to_rfc3339()],
                    )
                    .expect("record migration");
                transaction.commit().expect("commit migration");
            }
            connection.execute(
                "INSERT INTO tasks(id,title,state,created_at,updated_at) VALUES (?1,'Replay fixture','ready',?2,?2)",
                params![task_id.to_string(), now.to_rfc3339()],
            ).expect("insert task");
            connection.execute(
                "INSERT INTO provider_sessions(id,task_id,provider,provider_thread_id,created_at,updated_at) VALUES (?1,?2,'codex','thread-1',?3,?3)",
                params![provider_session_id.to_string(), task_id.to_string(), now.to_rfc3339()],
            ).expect("insert provider session");

            let rows = [
                (
                    "turn-1",
                    "user-live",
                    "stable-user-live",
                    "user_message",
                    "completed",
                    "visible question",
                    10_i64,
                ),
                (
                    "turn-1",
                    "assistant-live",
                    "stable-assistant-live",
                    "agent_message",
                    "completed",
                    "visible answer",
                    11,
                ),
                (
                    "turn-1",
                    "item-1",
                    "stable-replayed-user",
                    "user_message",
                    "in_progress",
                    "<integrator-skills>private</integrator-skills>\n\nvisible question",
                    20,
                ),
                (
                    "turn-1",
                    "item-2",
                    "stable-replayed-assistant",
                    "agent_message",
                    "in_progress",
                    "visible answer",
                    21,
                ),
                (
                    "turn-1",
                    "item-3",
                    "stable-distinct-assistant",
                    "agent_message",
                    "completed",
                    "a distinct snapshot-only answer",
                    22,
                ),
                (
                    "turn-2",
                    "item-1",
                    "stable-snapshot-only-user",
                    "user_message",
                    "completed",
                    "snapshot-only question",
                    30,
                ),
            ];
            for (turn_id, item_id, stable_id, kind, status, body, seq) in rows {
                let projection = ItemProjection {
                    id: stable_id.into(),
                    provider_item_id: item_id.into(),
                    kind: match kind {
                        "user_message" => ItemKind::UserMessage,
                        _ => ItemKind::AgentMessage,
                    },
                    status: match status {
                        "completed" => ItemStatus::Completed,
                        _ => ItemStatus::InProgress,
                    },
                    title: None,
                    body: Some(body.into()),
                    native_skill: None,
                    phase: None,
                    command: None,
                    cwd: None,
                    output: None,
                    exit_code: None,
                    file_changes: None,
                    mcp_server: None,
                    mcp_tool: None,
                    tool_input: None,
                    truncated: false,
                    updated_at: now,
                };
                connection.execute(
                    "INSERT INTO codex_items(provider_session_id,task_id,thread_id,turn_id,item_id,stable_id,kind,status,body,updated_at,projection_json,last_event_seq,first_event_seq,first_occurred_at)
                     VALUES (?1,?2,'thread-1',?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,?9)",
                    params![
                        provider_session_id.to_string(),
                        task_id.to_string(),
                        turn_id,
                        item_id,
                        stable_id,
                        kind,
                        status,
                        body,
                        now.to_rfc3339(),
                        serde_json::to_string(&projection).expect("serialize projection"),
                        seq,
                    ],
                ).expect("insert item");
            }
        }

        let store = LocalStore::open(&path).expect("apply replay repair");
        let connection = store.connection.lock();
        let remaining = connection
            .prepare(
                "SELECT turn_id,item_id FROM integrator_items
                 WHERE provider_session_id=?1 ORDER BY first_event_seq",
            )
            .expect("prepare remaining items")
            .query_map([provider_session_id.to_string()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .expect("query remaining items")
            .collect::<std::result::Result<Vec<_>, _>>()
            .expect("collect remaining items");
        assert_eq!(
            remaining,
            vec![
                ("turn-1".into(), "user-live".into()),
                ("turn-1".into(), "assistant-live".into()),
                ("turn-1".into(), "item-3".into()),
                ("turn-2".into(), "item-1".into()),
            ]
        );
    }

    #[test]
    fn materialized_snapshot_schema_migration_is_idempotent() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("snapshot.sqlite3");
        let store = LocalStore::open(&path).expect("first open");
        {
            let connection = store.connection.lock();
            let columns = connection
                .prepare("PRAGMA table_info(integrator_task_projection)")
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
                .prepare("PRAGMA index_list(integrator_items)")
                .expect("item indexes")
                .query_map([], |row| row.get::<_, String>(1))
                .expect("query indexes")
                .collect::<std::result::Result<std::collections::HashSet<_>, _>>()
                .expect("collect indexes");
            assert!(item_indexes.contains("integrator_items_task_snapshot_idx"));
            assert!(item_indexes.contains("integrator_items_provider_stable_seq_idx"));
            let approval_indexes = connection
                .prepare("PRAGMA index_list(integrator_approvals)")
                .expect("approval indexes")
                .query_map([], |row| row.get::<_, String>(1))
                .expect("query approval indexes")
                .collect::<std::result::Result<std::collections::HashSet<_>, _>>()
                .expect("collect approval indexes");
            assert!(approval_indexes.contains("integrator_approvals_active_process_idx"));
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
            phase: None,
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
        let migrated_hydrate = migrated_snapshot.hydrate.expect("compact hydrate");
        assert_eq!(migrated_hydrate.items.len(), 1);
        assert_eq!(&migrated_hydrate.items[0], &legacy_item);
        let _ = &legacy_event;

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
            phase: None,
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
                    "SELECT projection_json FROM integrator_event_log WHERE seq=?1",
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
        let hydrate = snapshot.hydrate.expect("compact hydrate");
        assert_eq!(hydrate.items.len(), 2);
        assert!(
            hydrate
                .items
                .iter()
                .any(|item| { item.body.as_deref() == Some("legacy materialized message") })
        );
        assert!(
            hydrate
                .items
                .iter()
                .any(|item| item.body.as_deref() == Some("post-migration message"))
        );
    }

    #[test]
    fn provider_and_runtime_sessions_are_exported() {
        let store = LocalStore::open_in_memory().expect("open store");
        let task = store
            .create_task(NewTask {
                kind: TaskKind::Code,
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
                kind: TaskKind::Code,
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
            context_references: Vec::new(),
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
            context_references: Vec::new(),
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
                kind: TaskKind::Code,
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
                    kind: TaskKind::Code,
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
                kind: TaskKind::Code,
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
                    kind: TaskKind::Code,
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
                    kind: TaskKind::Code,
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
                kind: TaskKind::Code,
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
        let _ = reopened
            .create_task(NewTask {
                kind: TaskKind::Code,
                title: "Project chat".into(),
                repository_path: Some(repository.clone()),
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create project task");
        assert_eq!(reopened.list_tasks().expect("list tasks").len(), 1);

        let removed = reopened
            .remove_trusted_project(registered.id)
            .expect("remove trust record");
        assert_eq!(removed.id, registered.id);
        assert!(
            reopened
                .list_trusted_projects()
                .expect("list after removal")
                .is_empty()
        );
        assert!(
            reopened
                .list_tasks()
                .expect("list tasks after removal")
                .is_empty(),
            "removing a project must delete its Integrator chat history"
        );
        assert!(
            repository.exists(),
            "removal must never delete repository data"
        );
    }

    #[test]
    fn legacy_project_history_can_be_removed_by_its_exact_stored_path() {
        let store = LocalStore::open_in_memory().expect("open store");
        let legacy_path = PathBuf::from("Projects/AI Integrator");
        let other_path = PathBuf::from("Projects/Other");
        for (title, repository_path) in [
            ("Legacy one", legacy_path.clone()),
            ("Legacy two", legacy_path.clone()),
            ("Other project", other_path.clone()),
        ] {
            store
                .create_task(NewTask {
                    kind: TaskKind::Code,
                    title: title.into(),
                    repository_path: Some(repository_path),
                    worktree_path: None,
                    runtime: None,
                    model: None,
                    effort: None,
                    parent_task_id: None,
                })
                .expect("create legacy task");
        }

        assert_eq!(
            store
                .remove_project_history_by_repository_path(&legacy_path)
                .expect("remove legacy project history"),
            2
        );
        let remaining = store.list_all_tasks().expect("list remaining tasks");
        assert_eq!(remaining.len(), 1);
        assert_eq!(
            remaining[0].repository_path.as_deref(),
            Some(other_path.as_path())
        );
    }

    #[test]
    fn list_tasks_keeps_archived_out_of_the_hot_set() {
        let store = LocalStore::open_in_memory().expect("open store");
        let live = store
            .create_task(NewTask {
                kind: TaskKind::Code,
                title: "Live chat".into(),
                repository_path: None,
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create live");
        let archived = store
            .create_task(NewTask {
                kind: TaskKind::Code,
                title: "Archived chat".into(),
                repository_path: None,
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create archived");
        store
            .update_task_metadata(archived.id, None, None, Some(true))
            .expect("archive");

        let hot = store.list_tasks().expect("list live tasks");
        assert_eq!(hot.len(), 1);
        assert_eq!(hot[0].id, live.id);
        assert!(!hot[0].archived);

        let page = store.list_archived_tasks(None, 50).expect("list archived");
        assert_eq!(page.total, 1);
        assert_eq!(page.tasks.len(), 1);
        assert_eq!(page.tasks[0].id, archived.id);
        assert!(page.tasks[0].archived);
        assert!(page.next_cursor.is_none());

        let export = store.export().expect("export");
        assert_eq!(export.tasks.len(), 1);
        assert_eq!(export.tasks[0].id, live.id);

        let all = store.list_all_tasks().expect("list all");
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn remove_task_wipes_chat_history_and_preserves_project_folder() {
        let directory = tempfile::tempdir().expect("temp directory");
        let database = directory.path().join("integrator.sqlite3");
        let repository = directory.path().join("repository");
        std::fs::create_dir_all(&repository).expect("fixture directories");
        let store = LocalStore::open(&database).expect("open store");
        let _project = store
            .upsert_trusted_project("Repository", &repository, None)
            .expect("register project");
        let keep = store
            .create_task(NewTask {
                kind: TaskKind::Code,
                title: "Keep me".into(),
                repository_path: Some(repository.clone()),
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create kept task");
        let remove = store
            .create_task(NewTask {
                kind: TaskKind::Code,
                title: "Delete me".into(),
                repository_path: Some(repository.clone()),
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create removed task");

        let removed = store.remove_task(remove.id).expect("remove task");
        assert_eq!(removed.id, remove.id);
        let tasks = store.list_tasks().expect("list tasks");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, keep.id);
        assert!(
            repository.exists(),
            "removing a chat must never delete the project folder"
        );
        assert!(matches!(
            store.remove_task(remove.id),
            Err(IntegratorError::NotFound(_))
        ));
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

    #[test]
    fn chat_kind_round_trips_without_repository_identity() {
        let store = LocalStore::open_in_memory().expect("open store");
        let task = store
            .create_task(NewTask {
                kind: TaskKind::Chat,
                title: "Research chat".into(),
                repository_path: None,
                worktree_path: None,
                runtime: Some("codex".into()),
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create Chat task");

        assert_eq!(task.kind, TaskKind::Chat);
        assert_eq!(
            store.get_task(task.id).expect("reload Chat").kind,
            TaskKind::Chat
        );
        assert_eq!(
            store.export().expect("export").tasks[0].kind,
            TaskKind::Chat
        );
        let rerouted = store
            .update_task_routing(task.id, "cursor", "composer", None)
            .expect("reroute Chat task");
        assert_eq!(rerouted.runtime.as_deref(), Some("cursor"));
        assert!(matches!(
            store.create_task(NewTask {
                kind: TaskKind::Chat,
                title: "Unsafe Chat".into(),
                repository_path: Some(PathBuf::from("/tmp/project")),
                worktree_path: None,
                runtime: Some("cursor".into()),
                model: None,
                effort: None,
                parent_task_id: None,
            }),
            Err(IntegratorError::InvalidInput(_))
        ));
    }

    #[test]
    fn chat_context_is_a_bounded_native_markdown_snapshot() {
        let store = LocalStore::open_in_memory().expect("open store");
        let source = store
            .create_task(NewTask {
                kind: TaskKind::Chat,
                title: "Parser research".into(),
                repository_path: None,
                worktree_path: None,
                runtime: Some("codex".into()),
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create source Chat");
        let target = store
            .create_task(NewTask {
                kind: TaskKind::Code,
                title: "Implement parser".into(),
                repository_path: None,
                worktree_path: None,
                runtime: Some("codex".into()),
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create target task");
        seed_conversation(&store, source.id);
        let input = ChatContextReference {
            id: ContextReferenceId::new(),
            source_task_id: source.id,
            source_title: "renderer cannot override this".into(),
        };

        let snapshot = store
            .resolve_chat_context_reference(target.id, &input)
            .expect("resolve Chat context");
        assert_eq!(snapshot.source_title, "Parser research");
        assert_eq!(snapshot.message_count, 4);
        assert!(
            snapshot
                .rendered_markdown
                .starts_with("# Chat: Parser research\n")
        );
        assert!(
            snapshot
                .rendered_markdown
                .contains("## User\n\nport the parser")
        );
        assert!(
            snapshot
                .rendered_markdown
                .contains("## Assistant\n\nhere is the port")
        );
        assert_eq!(snapshot.rendered_sha256.len(), 64);

        store.remove_task(source.id).expect("delete source Chat");
        let persisted = store
            .list_context_references(target.id)
            .expect("list target context")
            .pop()
            .expect("persisted reference");
        assert_eq!(persisted.source_task_id, None);
        assert_eq!(persisted.rendered_markdown, snapshot.rendered_markdown);
        assert_eq!(persisted.rendered_sha256, snapshot.rendered_sha256);
    }

    #[test]
    fn chat_context_rejects_code_sources_and_self_references() {
        let store = LocalStore::open_in_memory().expect("open store");
        let code = store
            .create_task(NewTask {
                kind: TaskKind::Code,
                title: "Code task".into(),
                repository_path: None,
                worktree_path: None,
                runtime: Some("codex".into()),
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create code task");
        seed_conversation(&store, code.id);
        let reference = ChatContextReference {
            id: ContextReferenceId::new(),
            source_task_id: code.id,
            source_title: code.title.clone(),
        };
        assert!(matches!(
            store.resolve_chat_context_reference(TaskId::new(), &reference),
            Err(IntegratorError::NotFound(_))
        ));
        assert!(matches!(
            store.resolve_chat_context_reference(code.id, &reference),
            Err(IntegratorError::InvalidInput(_))
        ));

        let target = store
            .create_task(NewTask {
                kind: TaskKind::Chat,
                title: "Target".into(),
                repository_path: None,
                worktree_path: None,
                runtime: Some("codex".into()),
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create target");
        assert!(matches!(
            store.resolve_chat_context_reference(target.id, &reference),
            Err(IntegratorError::InvalidInput(_))
        ));
    }

    #[test]
    fn memory_is_transparent_deduplicated_bounded_and_secret_averse() {
        let store = LocalStore::open_in_memory().expect("open store");
        let first = store
            .create_memory(NewMemoryEntry {
                text: "Prefers concise release notes".into(),
                creator: MemoryCreator::User,
                source_task_id: None,
                source_item_id: None,
            })
            .expect("create memory");
        assert!(matches!(
            store.create_memory(NewMemoryEntry {
                text: "  PREFERS   concise release notes  ".into(),
                creator: MemoryCreator::Agent,
                source_task_id: None,
                source_item_id: None,
            }),
            Err(IntegratorError::InvalidInput(_))
        ));
        assert!(matches!(
            store.create_memory(NewMemoryEntry {
                text: "API key: sk-proj-12345678901234567890".into(),
                creator: MemoryCreator::User,
                source_task_id: None,
                source_item_id: None,
            }),
            Err(IntegratorError::InvalidInput(_))
        ));
        let harmless = store
            .create_memory(NewMemoryEntry {
                text: "Likes task-based, risk-aware plans".into(),
                creator: MemoryCreator::User,
                source_task_id: None,
                source_item_id: None,
            })
            .expect("do not reject ordinary sk- text");

        store
            .set_memory_state(first.id, MemoryState::Disabled)
            .expect("disable memory");
        let injected = store
            .active_memories_for_injection()
            .expect("list injectable memories");
        assert_eq!(
            injected.iter().map(|entry| entry.id).collect::<Vec<_>>(),
            vec![harmless.id]
        );
        store
            .mark_memories_used(&[harmless.id])
            .expect("mark memory used");
        assert!(
            store
                .list_memories()
                .expect("list memories")
                .into_iter()
                .find(|entry| entry.id == harmless.id)
                .expect("used memory")
                .last_used_at
                .is_some()
        );
    }

    #[test]
    fn memory_enforces_twenty_active_entry_limit() {
        let store = LocalStore::open_in_memory().expect("open store");
        let mut memories = Vec::new();
        for index in 0..20 {
            memories.push(
                store
                    .create_memory(NewMemoryEntry {
                        text: format!("Stable preference {index}"),
                        creator: MemoryCreator::User,
                        source_task_id: None,
                        source_item_id: None,
                    })
                    .expect("fill memory"),
            );
        }
        assert!(matches!(
            store.create_memory(NewMemoryEntry {
                text: "One too many".into(),
                creator: MemoryCreator::User,
                source_task_id: None,
                source_item_id: None,
            }),
            Err(IntegratorError::InvalidInput(_))
        ));
        store
            .set_memory_state(memories[0].id, MemoryState::Disabled)
            .expect("free capacity");
        store
            .create_memory(NewMemoryEntry {
                text: "Replacement preference".into(),
                creator: MemoryCreator::User,
                source_task_id: None,
                source_item_id: None,
            })
            .expect("reuse capacity");
    }
}
