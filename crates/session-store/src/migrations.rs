pub(super) const MIGRATIONS: &[(i64, &str)] = &[
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
    (
        25,
        r#"
        -- Browser tabs a chat had open, so returning to it does not mean
        -- looking every page up again. Only the address and title are kept:
        -- page state belongs to the site and its cookies, not to us. Rows die
        -- with their task.
        CREATE TABLE browser_tabs (
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (task_id, ordinal)
        );
        "#,
    ),
    (
        26,
        r#"
        -- A remembered tab keeps its site icon (a small data: URL) so the
        -- strip shows icons before any page has loaded. Nullable: older rows
        -- and sites without an icon have none.
        ALTER TABLE browser_tabs ADD COLUMN favicon TEXT;
        "#,
    ),
    (
        27,
        r#"
        -- Popped-out browser windows outlive the app: closing Integrator with
        -- three windows on screen and getting one back is a loss nobody asked
        -- for. A window row is the frame — where it was, how big, which groups
        -- were collapsed inside it — while the tabs that lived in it stay in
        -- `browser_tabs`, now tagged with their window, their order within it,
        -- and when they were last touched (cleanup needs an age). A tab whose
        -- window row goes away falls back to the pane rather than vanishing:
        -- hence SET NULL rather than a cascade.
        CREATE TABLE browser_windows (
            id TEXT PRIMARY KEY,
            x INTEGER,
            y INTEGER,
            width INTEGER,
            height INTEGER,
            maximized INTEGER NOT NULL DEFAULT 0,
            monitor TEXT,
            collapsed_groups TEXT NOT NULL DEFAULT '[]',
            last_focused_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        ALTER TABLE browser_tabs ADD COLUMN window_id TEXT
            REFERENCES browser_windows(id) ON DELETE SET NULL;
        ALTER TABLE browser_tabs ADD COLUMN window_order INTEGER;
        ALTER TABLE browser_tabs ADD COLUMN last_touched_at TEXT;

        -- Cleanup retires tabs nobody has touched in days, and tabs past the
        -- cap. Retiring is not deleting: the address lands here so "recently
        -- closed" can bring it back. Capped globally, indexed by the group
        -- that asks for it, and dying with its task like the tab it came from.
        CREATE TABLE browser_recent_tabs (
            id INTEGER PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            group_id TEXT NOT NULL,
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            favicon TEXT,
            closed_at TEXT NOT NULL,
            reason TEXT NOT NULL
        );
        CREATE INDEX browser_recent_tabs_group
            ON browser_recent_tabs(group_id, closed_at);

        -- To reverse: drop the two tables and the three added `browser_tabs`
        -- columns. All of it is additive, so an older build still reads them.
        "#,
    ),
];
