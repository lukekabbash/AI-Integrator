use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    str::FromStr,
};

use chrono::{DateTime, Utc};
use integrator_core::{
    ApprovalDecision, ApprovalKind, ApprovalProjection, ApprovalState, IntegratorError,
    ItemProjection, ItemStatus, NewTask, ProviderKind, ProviderSession, ProviderSessionId, Result,
    RuntimeBinding, RuntimeProjection, RuntimeProjectionEvent, RuntimeSession, RuntimeSessionId,
    StopRequestResult, TASK_PROJECTION_HYDRATE_TAIL, Task, TaskId,
    TaskProjectionConnectionHydrate, TaskProjectionDiffHydrate, TaskProjectionErrorHydrate,
    TaskProjectionHydrate, TaskSnapshot, TaskSnapshotQuery, TransportRequestId, TurnProjection,
    TurnStatus, UsageProjection,
};
use integrator_runtime::{
    ItemTextField, ProjectionMutation, ReducedProviderEvent, redact_and_bound,
};
use rusqlite::{OptionalExtension, Transaction, params};

use super::{LocalStore, build_task, insert_task_row, invalid_stored, parse_time, storage_error};

const RENDERER_CONTENT_LIMIT: usize = 480 * 1024;
const ITEM_BODY_LIMIT: usize = 2 * 1024 * 1024;
const COMMAND_OUTPUT_LIMIT: usize = 1024 * 1024;
const COMMAND_OUTPUT_HEAD: usize = 128 * 1024;

/// Default handoff window: last N turns from shared task projections.
pub const HANDOFF_DEFAULT_MAX_TURNS: usize = 10;
/// ~50k tokens at chars/4 for fresh-session primers across any provider.
pub const HANDOFF_DEFAULT_MAX_TOKENS: usize = 50_000;
/// Bound vision reattachment cost on the primed turn.
pub const HANDOFF_DEFAULT_MAX_IMAGES: usize = 4;
/// Child/orchestrator digests stay tighter so briefs remain focused.
pub const HANDOFF_CHILD_MAX_TOKENS: usize = 8_000;

const HANDOFF_USER_CLIP: usize = 3_000;
const HANDOFF_ASSISTANT_CLIP: usize = 4_000;
const HANDOFF_READ_CLIP: usize = 4_000;
const HANDOFF_COMMAND_OUTPUT_CLIP: usize = 1_024;
const HANDOFF_NOISY_OUTPUT_THRESHOLD: usize = 8_192;

/// Options for [`LocalStore::task_handoff_digest`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HandoffDigestOptions {
    pub max_tokens: usize,
    pub max_turns: usize,
    pub max_images: usize,
}

impl Default for HandoffDigestOptions {
    fn default() -> Self {
        Self {
            max_tokens: HANDOFF_DEFAULT_MAX_TOKENS,
            max_turns: HANDOFF_DEFAULT_MAX_TURNS,
            max_images: HANDOFF_DEFAULT_MAX_IMAGES,
        }
    }
}

impl HandoffDigestOptions {
    #[must_use]
    pub fn for_child() -> Self {
        Self {
            max_tokens: HANDOFF_CHILD_MAX_TOKENS,
            max_turns: HANDOFF_DEFAULT_MAX_TURNS,
            max_images: HANDOFF_DEFAULT_MAX_IMAGES,
        }
    }

    /// Legacy byte-budget callers: treat bytes as an approximate char budget.
    #[must_use]
    pub fn from_max_bytes(max_bytes: usize) -> Self {
        Self {
            max_tokens: (max_bytes / 4).max(1),
            ..Self::default()
        }
    }
}

/// Provider-neutral handoff package built from shared SQLite task projections.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HandoffDigest {
    pub text: String,
    pub image_paths: Vec<PathBuf>,
}

#[derive(Debug)]
pub struct PreparedApprovalResponse {
    pub event: RuntimeProjectionEvent,
    pub request_id: TransportRequestId,
    pub process_id: String,
}

pub struct PersistedStopRequest {
    pub result: StopRequestResult,
    /// Absent when a dead session was settled without any turn left to update.
    pub event: Option<RuntimeProjectionEvent>,
}

impl LocalStore {
    /// Locate the durable turn that owns one provider tool-call identity.
    /// ACP session/load replays old notifications without a turn id, so the
    /// pump binds only already-known tool calls back to their original turn
    /// instead of duplicating transcript text into the current turn.
    pub fn turn_for_provider_item(
        &self,
        task_id: TaskId,
        provider: ProviderKind,
        provider_item_id: &str,
    ) -> Result<Option<String>> {
        self.connection
            .lock()
            .query_row(
                "SELECT i.turn_id FROM codex_items i JOIN provider_sessions p ON p.id=i.provider_session_id WHERE i.task_id=?1 AND p.provider=?2 AND i.item_id=?3 ORDER BY i.last_event_seq DESC LIMIT 1",
                params![task_id.to_string(), provider.as_str(), provider_item_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)
    }

    /// Materialized items for one provider turn in their original display
    /// order. Codex thread snapshots can replace live item ids with temporary
    /// `item-N` ids; reconciliation uses these rows to preserve the durable
    /// identity and visible user text already owned by the local projection.
    pub fn provider_turn_items(
        &self,
        provider_session_id: ProviderSessionId,
        turn_id: &str,
    ) -> Result<Vec<ItemProjection>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT projection_json FROM codex_items
                 WHERE provider_session_id = ?1 AND turn_id = ?2
                 ORDER BY CASE WHEN first_event_seq = 0 THEN last_event_seq ELSE first_event_seq END,
                          last_event_seq,
                          item_id",
            )
            .map_err(storage_error)?;
        statement
            .query_map(params![provider_session_id.to_string(), turn_id], |row| {
                row.get::<_, String>(0)
            })
            .map_err(storage_error)?
            .map(|row| {
                let json = row.map_err(storage_error)?;
                serde_json::from_str(&json).map_err(Into::into)
            })
            .collect()
    }

    pub fn create_runtime_binding(
        &self,
        task_id: TaskId,
        process_id: &str,
        provider: ProviderKind,
    ) -> Result<RuntimeBinding> {
        self.get_task(task_id)?;
        if process_id.is_empty() || process_id.len() > 512 {
            return Err(IntegratorError::InvalidInput(
                "invalid process identity".into(),
            ));
        }
        let session = RuntimeSession {
            id: RuntimeSessionId::new(),
            task_id,
            provider_session_id: None,
            process_id: Some(process_id.into()),
            status: "running".into(),
            started_at: Utc::now(),
            ended_at: None,
        };
        self.insert_runtime_session(&session)?;
        Ok(RuntimeBinding {
            task_id,
            provider,
            provider_session_id: None,
            runtime_session_id: session.id,
            process_id: process_id.into(),
            thread_id: None,
        })
    }

    pub fn attach_provider_thread(
        &self,
        binding: &RuntimeBinding,
        thread_id: &str,
    ) -> Result<RuntimeBinding> {
        validate_identity(thread_id, "thread")?;
        let provider_session =
            self.get_or_create_provider_session(binding.task_id, binding.provider, thread_id)?;
        let updated = self.connection
            .lock()
            .execute(
                "UPDATE runtime_sessions SET provider_session_id = ?1 WHERE id = ?2 AND process_id = ?3",
                params![provider_session.id.to_string(), binding.runtime_session_id.to_string(), binding.process_id],
            )
            .map_err(storage_error)?;
        if updated != 1 {
            return Err(IntegratorError::Unauthorized(
                "runtime binding no longer owns this process".into(),
            ));
        }
        Ok(RuntimeBinding {
            task_id: binding.task_id,
            provider: binding.provider,
            provider_session_id: Some(provider_session.id),
            runtime_session_id: binding.runtime_session_id,
            process_id: binding.process_id.clone(),
            thread_id: Some(thread_id.into()),
        })
    }

    fn get_or_create_provider_session(
        &self,
        task_id: TaskId,
        provider: ProviderKind,
        thread_id: &str,
    ) -> Result<ProviderSession> {
        let connection = self.connection.lock();
        let existing = connection
            .query_row(
                "SELECT id, created_at, updated_at FROM provider_sessions WHERE provider = ?2 AND provider_thread_id = ?1",
                params![thread_id, provider.as_str()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
            )
            .optional()
            .map_err(storage_error)?;
        let now = Utc::now();
        if let Some((id, created, _)) = existing {
            let stored_task_id = connection
                .query_row(
                    "SELECT task_id FROM provider_sessions WHERE id = ?1",
                    [&id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(storage_error)?;
            if stored_task_id != task_id.to_string() {
                return Err(IntegratorError::Unauthorized(
                    "provider thread is already attached to another task".into(),
                ));
            }
            let session = ProviderSession {
                id: ProviderSessionId::from_str(&id).map_err(invalid_stored)?,
                task_id,
                provider,
                provider_thread_id: thread_id.into(),
                created_at: parse_time(&created)?,
                updated_at: now,
            };
            connection
                .execute(
                    "UPDATE provider_sessions SET updated_at = ?1 WHERE id = ?2",
                    params![now.to_rfc3339(), id],
                )
                .map_err(storage_error)?;
            return Ok(session);
        }
        drop(connection);
        let session = ProviderSession {
            id: ProviderSessionId::new(),
            task_id,
            provider,
            provider_thread_id: thread_id.into(),
            created_at: now,
            updated_at: now,
        };
        self.upsert_provider_session(&session)?;
        Ok(session)
    }

    pub fn apply_reduced_event(
        &self,
        binding: &RuntimeBinding,
        reduced: &ReducedProviderEvent,
    ) -> Result<RuntimeProjectionEvent> {
        let provider_session_id = binding.provider_session_id.ok_or_else(|| {
            IntegratorError::Storage("runtime is not attached to a provider thread".into())
        })?;
        let thread_id = binding
            .thread_id
            .as_deref()
            .ok_or_else(|| IntegratorError::Storage("runtime thread identity is missing".into()))?;
        if thread_id != reduced.thread_id {
            return Err(IntegratorError::Unauthorized(
                "provider event belongs to a different thread".into(),
            ));
        }
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        validate_runtime_binding(&transaction, binding, provider_session_id, thread_id)?;
        transaction.execute(
            "INSERT INTO codex_event_log(task_id, provider_session_id, runtime_session_id, process_id, thread_id, turn_id, method, audit_json, audit_truncated, occurred_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![binding.task_id.to_string(), provider_session_id.to_string(), binding.runtime_session_id.to_string(), binding.process_id, thread_id, reduced.turn_id, reduced.method, reduced.audit_json, reduced.audit_truncated, reduced.occurred_at.to_rfc3339()],
        ).map_err(storage_error)?;
        let seq = transaction.last_insert_rowid();
        let projection = apply_mutation(&transaction, binding, reduced, seq)?;
        let projection = renderer_safe_projection(projection);
        let event = RuntimeProjectionEvent {
            seq,
            task_id: binding.task_id,
            provider_session_id,
            provider: binding.provider.as_str().into(),
            thread_id: thread_id.into(),
            turn_id: reduced.turn_id.clone(),
            occurred_at: reduced.occurred_at,
            projection,
        };
        persist_snapshot_event(&transaction, &event)?;
        // Migration 8 consumes legacy projection_json values once to seed the
        // materialized snapshot tables. New audit rows intentionally omit that
        // duplicate full-event payload: task_snapshot reads the materialized
        // rows above, while the append-only log retains identity, ordering,
        // method, time, and the provider's bounded audit payload.
        transaction.commit().map_err(storage_error)?;
        Ok(event)
    }

    pub fn task_snapshot(&self, task_id: TaskId) -> Result<TaskSnapshot> {
        self.task_snapshot_with(task_id, TaskSnapshotQuery::default())
    }

    /// Compact UI hydrate with optional watermark/reset if-match and tail windowing.
    ///
    /// Display-only: does not change what is persisted or what
    /// `task_handoff_digest` returns for agent seeding.
    pub fn task_snapshot_with(
        &self,
        task_id: TaskId,
        query: TaskSnapshotQuery,
    ) -> Result<TaskSnapshot> {
        let task = self.get_task(task_id)?;
        let connection = self.connection.lock();
        let task_key = task_id.to_string();
        // A forked task owns copied projection rows but none of the source's
        // audit log, so the log alone would report a zero watermark and clamp
        // the entire copied transcript out of the result below. A task that
        // recorded its own events can never have a projection seq above its
        // log's, so widening the watermark this way leaves those unchanged.
        let watermark = connection
            .query_row(
                "SELECT MAX(
                    (SELECT COALESCE(MAX(seq), 0) FROM codex_event_log WHERE task_id = ?1),
                    (SELECT COALESCE(MAX(last_event_seq), 0) FROM codex_items WHERE task_id = ?1),
                    (SELECT COALESCE(MAX(last_event_seq), 0) FROM codex_turns WHERE task_id = ?1)
                )",
                [&task_key],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)?;
        let reset_seq = connection
            .query_row(
                "SELECT COALESCE(reset_seq, 0) FROM codex_task_projection WHERE task_id = ?1",
                [&task_key],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(storage_error)?
            .unwrap_or(0);

        // Older pages only need the item/approval window; skip singleton work.
        let older_page = query.before_seq.is_some();
        if !older_page
            && query.known_watermark == Some(watermark)
            && query.known_reset_seq == Some(reset_seq)
        {
            return Ok(TaskSnapshot {
                task,
                watermark_seq: watermark,
                reset_seq,
                runtime_live: false,
                cache_matched: true,
                hydrate: None,
            });
        }

        let limit = query.limit.unwrap_or(TASK_PROJECTION_HYDRATE_TAIL).max(1);
        let before_seq = query.before_seq.unwrap_or(i64::MAX);

        let mut statement = connection
            .prepare(
                r#"
            SELECT last_event_seq, snapshot_event_json FROM (
                SELECT last_event_seq, snapshot_event_json FROM codex_items
                    WHERE task_id = ?1
                      AND last_event_seq > ?2
                      AND last_event_seq <= ?3
                      AND last_event_seq < ?4
                      AND snapshot_event_json IS NOT NULL
                UNION ALL
                SELECT last_event_seq, snapshot_event_json FROM codex_approvals
                    WHERE task_id = ?1
                      AND last_event_seq > ?2
                      AND last_event_seq <= ?3
                      AND last_event_seq < ?4
                      AND snapshot_event_json IS NOT NULL
            )
            ORDER BY last_event_seq DESC
            LIMIT ?5
            "#,
            )
            .map_err(storage_error)?;
        let mut window_rows = statement
            .query_map(
                params![task_key, reset_seq, watermark, before_seq, limit as i64],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(storage_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        let fetched = window_rows.len();
        // Reverse to ascending last_event_seq so item/approval array order
        // matches the historical event-stream hydrate path.
        window_rows.reverse();

        let oldest_loaded = window_rows.first().map(|(seq, _)| *seq);
        let has_more_older = match oldest_loaded {
            Some(oldest) if fetched >= limit => {
                connection
                    .query_row(
                        "SELECT EXISTS(
                        SELECT 1 FROM codex_items
                            WHERE task_id = ?1 AND last_event_seq > ?2 AND last_event_seq < ?3
                              AND last_event_seq <= ?4 AND snapshot_event_json IS NOT NULL
                        UNION ALL
                        SELECT 1 FROM codex_approvals
                            WHERE task_id = ?1 AND last_event_seq > ?2 AND last_event_seq < ?3
                              AND last_event_seq <= ?4 AND snapshot_event_json IS NOT NULL
                    )",
                        params![task_key, reset_seq, oldest, watermark],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(storage_error)?
                    > 0
            }
            _ => false,
        };

        let mut items = Vec::new();
        let mut approvals = Vec::new();
        let mut first_seen = BTreeMap::new();
        for (_seq, event_json) in &window_rows {
            let event: RuntimeProjectionEvent = serde_json::from_str(event_json)?;
            match event.projection {
                RuntimeProjection::ItemChanged { item } => {
                    first_seen.insert(item.id.clone(), event.occurred_at);
                    items.push(item);
                }
                RuntimeProjection::ApprovalChanged { approval } => {
                    first_seen.insert(approval.id.clone(), event.occurred_at);
                    approvals.push(approval);
                }
                _ => {}
            }
        }

        if older_page {
            return Ok(TaskSnapshot {
                task,
                watermark_seq: watermark,
                reset_seq,
                runtime_live: false,
                cache_matched: false,
                hydrate: Some(TaskProjectionHydrate {
                    turn: None,
                    items,
                    plan: Vec::new(),
                    plan_truncated: false,
                    diff: None,
                    usage: None,
                    approvals,
                    mode: None,
                    connection: None,
                    error: None,
                    first_seen,
                    has_more_older,
                    before_seq: oldest_loaded,
                }),
            });
        }

        let mut hydrate = TaskProjectionHydrate {
            turn: None,
            items,
            plan: Vec::new(),
            plan_truncated: false,
            diff: None,
            usage: None,
            approvals,
            mode: None,
            connection: None,
            error: None,
            first_seen,
            has_more_older,
            before_seq: oldest_loaded,
        };

        // Singletons always hydrate fully (tiny); reset itself is baked into
        // reset_seq rather than replaying a ProjectionReset wipe on the client.
        let mut singleton_statement = connection
            .prepare(
                r#"
            WITH boundary AS (
                SELECT COALESCE(reset_seq, 0) AS reset_seq
                FROM codex_task_projection WHERE task_id = ?1
            )
            SELECT seq, event_json FROM (
                SELECT turn_seq AS seq, turn_event_json AS event_json FROM codex_task_projection
                    WHERE task_id=?1 AND turn_seq > (SELECT reset_seq FROM boundary)
                UNION ALL SELECT plan_seq, plan_event_json FROM codex_task_projection
                    WHERE task_id=?1 AND plan_seq > (SELECT reset_seq FROM boundary)
                UNION ALL SELECT diff_seq, diff_event_json FROM codex_task_projection
                    WHERE task_id=?1 AND diff_seq > (SELECT reset_seq FROM boundary)
                UNION ALL SELECT usage_seq, usage_event_json FROM codex_task_projection
                    WHERE task_id=?1 AND usage_seq > (SELECT reset_seq FROM boundary)
                UNION ALL SELECT mode_seq, mode_event_json FROM codex_task_projection
                    WHERE task_id=?1 AND mode_seq > (SELECT reset_seq FROM boundary)
                UNION ALL SELECT error_seq, error_event_json FROM codex_task_projection
                    WHERE task_id=?1 AND error_seq > (SELECT reset_seq FROM boundary)
                UNION ALL SELECT connection_seq, connection_event_json FROM codex_task_projection
                    WHERE task_id=?1 AND connection_seq > (SELECT reset_seq FROM boundary)
            )
            WHERE event_json IS NOT NULL AND seq <= ?2
            ORDER BY seq
            "#,
            )
            .map_err(storage_error)?;
        let singleton_jsons = singleton_statement
            .query_map(params![task_key, watermark], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(storage_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage_error)?;

        for (_seq, event_json) in singleton_jsons {
            let event: RuntimeProjectionEvent = serde_json::from_str(&event_json)?;
            match event.projection {
                RuntimeProjection::TurnChanged { turn } => hydrate.turn = Some(turn),
                RuntimeProjection::PlanChanged { steps, truncated } => {
                    hydrate.plan = steps;
                    hydrate.plan_truncated = truncated;
                }
                RuntimeProjection::DiffChanged { diff, truncated } => {
                    hydrate.diff = Some(TaskProjectionDiffHydrate {
                        body: diff,
                        truncated,
                        seq: event.seq,
                        occurred_at: event.occurred_at,
                    });
                }
                RuntimeProjection::UsageChanged { usage } => hydrate.usage = Some(usage),
                RuntimeProjection::ModeChanged { mode } => hydrate.mode = Some(mode),
                RuntimeProjection::TurnError { message, retryable } => {
                    hydrate.error = Some(TaskProjectionErrorHydrate {
                        message,
                        retryable,
                        seq: event.seq,
                        occurred_at: event.occurred_at,
                    });
                }
                RuntimeProjection::ConnectionChanged {
                    state,
                    reason,
                    process_id,
                } => {
                    hydrate.connection = Some(TaskProjectionConnectionHydrate {
                        state,
                        reason,
                        process_id,
                    });
                }
                _ => {}
            }
        }

        Ok(TaskSnapshot {
            task,
            watermark_seq: watermark,
            reset_seq,
            runtime_live: false,
            cache_matched: false,
            hydrate: Some(hydrate),
        })
    }

    /// Copies a task's persisted conversation into a new task, keeping every
    /// settled item up to and including `through_stable_id`, or every settled
    /// turn when it is `None`. An unfinished source turn stays exclusively in
    /// the source task. Returns the new task.
    ///
    /// The fork deliberately gets no `provider_resume_states` row. Resuming
    /// makes the provider reload its own transcript and ignore this store
    /// entirely, which would both silently undo the truncation and leave two
    /// tasks writing into one provider thread. Without a resume state the
    /// fork's next prompt opens a fresh provider session that is seeded from
    /// the copied rows via `task_conversation_digest`.
    ///
    /// Approvals and the audit log are not copied: a pending approval in a
    /// fork would try to answer a process that no longer owns the thread, and
    /// the log records events this task never received.
    pub fn fork_task(
        &self,
        task_id: TaskId,
        through_stable_id: Option<&str>,
        title: String,
    ) -> Result<Task> {
        let source = self.get_task(task_id)?;
        let fork = build_task(NewTask {
            title,
            repository_path: source.repository_path.clone(),
            worktree_path: source.worktree_path.clone(),
            runtime: source.runtime.clone(),
            model: source.model.clone(),
            effort: source.effort.clone(),
            // Keeps a fork of a delegated child inside the same lineage, and a
            // fork of a top-level chat top-level.
            parent_task_id: source.parent_task_id,
        })?;
        let now = Utc::now();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;

        let cutoff = match through_stable_id {
            Some(stable_id) => {
                let (cutoff, turn_status) = transaction
                    .query_row(
                        "SELECT item.last_event_seq, turn.status
                         FROM codex_items item
                         LEFT JOIN codex_turns turn
                           ON turn.provider_session_id = item.provider_session_id
                          AND turn.turn_id = item.turn_id
                         WHERE item.task_id = ?1 AND item.stable_id = ?2
                         ORDER BY item.last_event_seq DESC
                         LIMIT 1",
                        params![task_id.to_string(), stable_id],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
                    )
                    .optional()
                    .map_err(storage_error)?
                    .ok_or_else(|| {
                        IntegratorError::NotFound(format!("transcript item {stable_id}"))
                    })?;
                if turn_status.as_deref().is_some_and(|status| {
                    status == TurnStatus::Pending.as_str()
                        || status == TurnStatus::InProgress.as_str()
                }) {
                    return Err(IntegratorError::InvalidInput(
                        "cannot branch from a response while it is still running".into(),
                    ));
                }
                cutoff
            }
            None => i64::MAX,
        };

        insert_task_row(&transaction, &fork)?;

        let sessions = {
            let mut statement = transaction
                .prepare(
                    "SELECT id, provider, provider_thread_id, created_at FROM provider_sessions WHERE task_id = ?1 ORDER BY created_at",
                )
                .map_err(storage_error)?;
            let rows = statement
                .query_map([task_id.to_string()], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(storage_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(storage_error)?;
            rows
        };

        // One fork session per source session, rather than collapsing them,
        // so the (provider_session_id, turn_id, item_id) primary key stays as
        // unique in the fork as it was in the source.
        let mut session_map: HashMap<String, String> = HashMap::new();
        for (old_session_id, provider, old_thread_id, created_at) in &sessions {
            let new_session_id = ProviderSessionId::new().to_string();
            // provider_sessions is UNIQUE(provider, provider_thread_id), and
            // reusing the source's thread id would collide. This synthetic id
            // is unique per fork and matches no real provider thread, so
            // get_or_create_provider_session can never route live events here:
            // the session exists only to own copied history.
            transaction
                .execute(
                    "INSERT INTO provider_sessions(id, task_id, provider, provider_thread_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        new_session_id,
                        fork.id.to_string(),
                        provider,
                        format!("integrator-fork:{}:{old_thread_id}", fork.id),
                        created_at,
                        now.to_rfc3339()
                    ],
                )
                .map_err(storage_error)?;
            // snapshot_event_json is a serialized RuntimeProjectionEvent whose
            // taskId/providerSessionId would otherwise still name the source,
            // sending the fork's hydrated events to the wrong task. json_set
            // leaves the NULL rows NULL, which task_snapshot already skips.
            transaction
                .execute(
                    "INSERT INTO codex_turns(provider_session_id, task_id, thread_id, turn_id, status, stop_requested, error, started_at, completed_at, projection_json, last_event_seq, first_event_seq, first_occurred_at, snapshot_event_json)
                     SELECT ?1, ?2, thread_id, turn_id, status, 0, error, started_at, completed_at, projection_json, last_event_seq, first_event_seq, first_occurred_at,
                            json_set(snapshot_event_json, '$.taskId', ?2, '$.providerSessionId', ?1)
                     FROM codex_turns
                     WHERE provider_session_id = ?3
                       AND last_event_seq <= ?4
                       AND status NOT IN (?5, ?6)",
                    params![
                        new_session_id,
                        fork.id.to_string(),
                        old_session_id,
                        cutoff,
                        TurnStatus::Pending.as_str(),
                        TurnStatus::InProgress.as_str()
                    ],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "INSERT INTO codex_items(provider_session_id, task_id, thread_id, turn_id, item_id, stable_id, kind, status, title, body, command_text, cwd, output, exit_code, file_changes_json, mcp_server, mcp_tool, truncated, updated_at, projection_json, last_event_seq, first_event_seq, first_occurred_at, snapshot_event_json, native_skill)
                     SELECT ?1, ?2, thread_id, turn_id, item_id, stable_id, kind, status, title, body, command_text, cwd, output, exit_code, file_changes_json, mcp_server, mcp_tool, truncated, updated_at, projection_json, last_event_seq, first_event_seq, first_occurred_at,
                            json_set(snapshot_event_json, '$.taskId', ?2, '$.providerSessionId', ?1)
                            , native_skill
                     FROM codex_items item
                     WHERE item.provider_session_id = ?3
                       AND item.last_event_seq <= ?4
                       AND NOT EXISTS (
                           SELECT 1
                           FROM codex_turns turn
                           WHERE turn.provider_session_id = item.provider_session_id
                             AND turn.turn_id = item.turn_id
                             AND turn.status IN (?5, ?6)
                       )",
                    params![
                        new_session_id,
                        fork.id.to_string(),
                        old_session_id,
                        cutoff,
                        TurnStatus::Pending.as_str(),
                        TurnStatus::InProgress.as_str()
                    ],
                )
                .map_err(storage_error)?;
            session_map.insert(old_session_id.clone(), new_session_id);
        }

        let source_projection = transaction
            .query_row(
                "SELECT provider_session_id, thread_id FROM codex_task_projection WHERE task_id = ?1",
                [task_id.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(storage_error)?;
        if let Some((old_session_id, thread_id)) = source_projection
            && let Some(new_session_id) = session_map.get(&old_session_id)
        {
            // task_snapshot reads reset_seq from this row through a scalar
            // subquery, and a missing row makes that NULL, which turns every
            // seq comparison NULL and hides the whole transcript. The fork
            // needs the row to exist, but inherits none of the source's
            // plan/diff/usage: those describe work the fork has not done, and
            // for a truncated fork they describe work past the branch point.
            transaction
                .execute(
                    "INSERT INTO codex_task_projection(task_id, provider_session_id, thread_id) VALUES (?1, ?2, ?3)",
                    params![fork.id.to_string(), new_session_id, thread_id],
                )
                .map_err(storage_error)?;
        }

        transaction.commit().map_err(storage_error)?;
        Ok(fork)
    }

    pub fn prepare_approval_response(
        &self,
        task_id: TaskId,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> Result<PreparedApprovalResponse> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let row = transaction.query_row(
            "SELECT projection_json, request_kind, request_value, process_id, provider_session_id, runtime_session_id, thread_id, turn_id FROM codex_approvals WHERE id = ?1 AND task_id = ?2",
            params![approval_id, task_id.to_string()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, Option<String>>(7)?)),
        ).optional().map_err(storage_error)?.ok_or_else(|| IntegratorError::NotFound(format!("approval {approval_id}")))?;
        let mut approval: ApprovalProjection = serde_json::from_str(&row.0)?;
        if approval.state != ApprovalState::Pending
            && approval.state != ApprovalState::ResponseFailed
        {
            return Err(IntegratorError::InvalidInput(
                "approval is no longer pending".into(),
            ));
        }
        approval.state = ApprovalState::Responding;
        approval.decision = Some(decision);
        approval.updated_at = Utc::now();
        let request_id = request_id_from_parts(&row.1, &row.2)?;
        let audit_json = serde_json::json!({
            "approvalId": approval.id.as_str(),
            "decision": approval
                .decision
                .as_ref()
                .map(ApprovalDecision::as_protocol_str),
            "state": approval.state.as_str(),
        })
        .to_string();
        transaction.execute("INSERT INTO codex_event_log(task_id, provider_session_id, runtime_session_id, process_id, thread_id, turn_id, method, audit_json, audit_truncated, occurred_at) VALUES (?1,?2,?3,?4,?5,?6,'client/approval/responding',?7,0,?8)", params![task_id.to_string(), row.4, row.5, row.3, row.6, row.7, audit_json, approval.updated_at.to_rfc3339()]).map_err(storage_error)?;
        let seq = transaction.last_insert_rowid();
        let event = RuntimeProjectionEvent {
            seq,
            task_id,
            provider_session_id: ProviderSessionId::from_str(&row.4).map_err(invalid_stored)?,
            provider: provider_for_session(&transaction, &row.4)?,
            thread_id: row.6,
            turn_id: row.7,
            occurred_at: approval.updated_at,
            projection: RuntimeProjection::ApprovalChanged {
                approval: approval.clone(),
            },
        };
        persist_snapshot_event(&transaction, &event)?;
        transaction.execute("UPDATE codex_approvals SET state='responding', decision=?1, updated_at=?2, last_event_seq=?3, projection_json=?4 WHERE id=?5", params![approval.decision.as_ref().map(ApprovalDecision::as_protocol_str), approval.updated_at.to_rfc3339(), seq, serde_json::to_string(&approval)?, approval_id]).map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(PreparedApprovalResponse {
            event,
            request_id,
            process_id: row.3,
        })
    }

    /// Answer a `Question` approval with one of its offered options. Kept
    /// separate from `prepare_approval_response` because the caller already
    /// knows exactly which choice the user made — there is no accept/decline
    /// axis to infer it from, and the chosen `optionId` must be validated
    /// against what the agent actually offered before it rides back to the
    /// agent as the permission outcome.
    pub fn prepare_question_response(
        &self,
        task_id: TaskId,
        approval_id: &str,
        option_id: &str,
    ) -> Result<PreparedApprovalResponse> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let row = transaction.query_row(
            "SELECT projection_json, request_kind, request_value, process_id, provider_session_id, runtime_session_id, thread_id, turn_id FROM codex_approvals WHERE id = ?1 AND task_id = ?2",
            params![approval_id, task_id.to_string()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, Option<String>>(7)?)),
        ).optional().map_err(storage_error)?.ok_or_else(|| IntegratorError::NotFound(format!("approval {approval_id}")))?;
        let mut approval: ApprovalProjection = serde_json::from_str(&row.0)?;
        if approval.state != ApprovalState::Pending
            && approval.state != ApprovalState::ResponseFailed
        {
            return Err(IntegratorError::InvalidInput(
                "approval is no longer pending".into(),
            ));
        }
        if approval.approval_kind != ApprovalKind::Question {
            return Err(IntegratorError::InvalidInput(
                "this approval is not a question".into(),
            ));
        }
        if !approval.options.iter().any(|option| option.option_id == option_id) {
            return Err(IntegratorError::InvalidInput(
                "that option was not offered for this question".into(),
            ));
        }
        approval.state = ApprovalState::Responding;
        approval.decision = Some(ApprovalDecision::Select);
        approval.selected_option_id = Some(option_id.to_owned());
        approval.updated_at = Utc::now();
        let request_id = request_id_from_parts(&row.1, &row.2)?;
        let audit_json = serde_json::json!({
            "approvalId": approval.id.as_str(),
            "decision": approval
                .decision
                .as_ref()
                .map(ApprovalDecision::as_protocol_str),
            "selectedOptionId": approval.selected_option_id.as_deref(),
            "state": approval.state.as_str(),
        })
        .to_string();
        transaction.execute("INSERT INTO codex_event_log(task_id, provider_session_id, runtime_session_id, process_id, thread_id, turn_id, method, audit_json, audit_truncated, occurred_at) VALUES (?1,?2,?3,?4,?5,?6,'client/approval/responding',?7,0,?8)", params![task_id.to_string(), row.4, row.5, row.3, row.6, row.7, audit_json, approval.updated_at.to_rfc3339()]).map_err(storage_error)?;
        let seq = transaction.last_insert_rowid();
        let event = RuntimeProjectionEvent {
            seq,
            task_id,
            provider_session_id: ProviderSessionId::from_str(&row.4).map_err(invalid_stored)?,
            provider: provider_for_session(&transaction, &row.4)?,
            thread_id: row.6,
            turn_id: row.7,
            occurred_at: approval.updated_at,
            projection: RuntimeProjection::ApprovalChanged {
                approval: approval.clone(),
            },
        };
        persist_snapshot_event(&transaction, &event)?;
        transaction.execute("UPDATE codex_approvals SET state='responding', decision=?1, updated_at=?2, last_event_seq=?3, projection_json=?4 WHERE id=?5", params![approval.decision.as_ref().map(ApprovalDecision::as_protocol_str), approval.updated_at.to_rfc3339(), seq, serde_json::to_string(&approval)?, approval_id]).map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(PreparedApprovalResponse {
            event,
            request_id,
            process_id: row.3,
        })
    }

    pub fn mark_approval_response_failed(
        &self,
        approval_id: &str,
    ) -> Result<RuntimeProjectionEvent> {
        self.transition_approval(approval_id, ApprovalState::ResponseFailed)
    }

    pub fn mark_approval_response_resolved(
        &self,
        approval_id: &str,
    ) -> Result<RuntimeProjectionEvent> {
        self.transition_approval(approval_id, ApprovalState::Resolved)
    }

    /// True when the task tip was cancelled by Stop (user or orchestrator).
    /// Resume-from-interrupt must refuse these tips.
    pub fn task_tip_stop_requested(&self, task_id: TaskId) -> Result<bool> {
        let connection = self.connection.lock();
        let stop_requested = connection
            .query_row(
                "SELECT t.stop_requested FROM codex_task_projection p JOIN codex_turns t ON t.provider_session_id=p.provider_session_id AND t.turn_id=p.current_turn_id WHERE p.task_id=?1",
                [task_id.to_string()],
                |row| row.get::<_, bool>(0),
            )
            .optional()
            .map_err(storage_error)?;
        Ok(stop_requested.unwrap_or(false))
    }

    pub fn request_stop(&self, task_id: TaskId) -> Result<PersistedStopRequest> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let row = transaction.query_row(
            "SELECT t.projection_json, p.provider_session_id, p.thread_id, p.current_turn_id FROM codex_task_projection p JOIN codex_turns t ON t.provider_session_id=p.provider_session_id AND t.turn_id=p.current_turn_id WHERE p.task_id=?1",
            [task_id.to_string()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
        ).optional().map_err(storage_error)?;
        let Some(row) = row else {
            // No current turn is bound to this task: the session is dead or
            // was never fully attached. Settle any unfinished turn so the
            // stop button always lands instead of erroring with not-found.
            let event = settle_stale_turn(&transaction, task_id, true)?;
            transaction.commit().map_err(storage_error)?;
            let turn_id = event
                .as_ref()
                .and_then(|event| event.turn_id.clone())
                .unwrap_or_default();
            return Ok(PersistedStopRequest {
                result: StopRequestResult {
                    turn_id,
                    stop_requested: true,
                    already_requested: false,
                    settled: true,
                },
                event,
            });
        };
        let mut turn: TurnProjection = serde_json::from_str(&row.0)?;
        let already_requested = turn.stop_requested;
        turn.stop_requested = true;
        let occurred_at = Utc::now();
        let inserted = transaction.execute("INSERT INTO codex_event_log(task_id,provider_session_id,runtime_session_id,process_id,thread_id,turn_id,method,audit_json,audit_truncated,occurred_at) SELECT ?1,?2,id,process_id,?3,?4,'client/turn/stopRequested','{}',0,?5 FROM runtime_sessions WHERE task_id=?1 AND provider_session_id=?2 AND process_id IS NOT NULL ORDER BY started_at DESC LIMIT 1", params![task_id.to_string(), row.1, row.2, row.3, occurred_at.to_rfc3339()]).map_err(storage_error)?;
        if inserted != 1 {
            // Same dead-session path: no live runtime session can carry the
            // stop, so settle the turn locally instead of failing.
            let event = settle_stale_turn(&transaction, task_id, true)?;
            transaction.commit().map_err(storage_error)?;
            return Ok(PersistedStopRequest {
                result: StopRequestResult {
                    turn_id: row.3,
                    stop_requested: true,
                    already_requested: false,
                    settled: true,
                },
                event,
            });
        }
        let seq = transaction.last_insert_rowid();
        transaction.execute("UPDATE codex_turns SET stop_requested=1,last_event_seq=?1,projection_json=?2 WHERE provider_session_id=?3 AND turn_id=?4", params![seq, serde_json::to_string(&turn)?, row.1, row.3]).map_err(storage_error)?;
        let event = RuntimeProjectionEvent {
            seq,
            task_id,
            provider_session_id: ProviderSessionId::from_str(&row.1).map_err(invalid_stored)?,
            provider: provider_for_session(&transaction, &row.1)?,
            thread_id: row.2,
            turn_id: Some(row.3.clone()),
            occurred_at,
            projection: RuntimeProjection::TurnChanged { turn },
        };
        persist_snapshot_event(&transaction, &event)?;
        transaction.commit().map_err(storage_error)?;
        Ok(PersistedStopRequest {
            result: StopRequestResult {
                turn_id: row.3,
                stop_requested: true,
                already_requested,
                settled: false,
            },
            event: Some(event),
        })
    }

    /// Force-mark the task's newest unfinished turn as interrupted. Used when
    /// a stop cannot reach a live provider so the UI still leaves the running
    /// state.
    pub fn settle_stopped_turn(&self, task_id: TaskId) -> Result<Option<RuntimeProjectionEvent>> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let event = settle_stale_turn(&transaction, task_id, true)?;
        transaction.commit().map_err(storage_error)?;
        Ok(event)
    }

    /// Completed-at for the newest interrupted tip turn, used to stamp resume
    /// wire prompts with when the prior attempt stopped.
    pub fn task_latest_interrupted_at(
        &self,
        task_id: TaskId,
    ) -> Result<Option<chrono::DateTime<Utc>>> {
        let connection = self.connection.lock();
        let json = connection
            .query_row(
                "SELECT projection_json FROM codex_turns WHERE task_id=?1 AND status='interrupted' ORDER BY last_event_seq DESC LIMIT 1",
                [task_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?;
        let Some(json) = json else {
            return Ok(None);
        };
        let turn: TurnProjection = serde_json::from_str(&json).map_err(invalid_stored)?;
        Ok(turn.completed_at.or(turn.started_at))
    }

    /// Mark a turn interrupted by transport/process loss without pretending
    /// the user pressed Stop. The distinction keeps opt-in auto-resume from
    /// undoing an intentional cancellation.
    pub fn settle_interrupted_turn(
        &self,
        task_id: TaskId,
    ) -> Result<Option<RuntimeProjectionEvent>> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let event = settle_stale_turn(&transaction, task_id, false)?;
        transaction.commit().map_err(storage_error)?;
        Ok(event)
    }

    pub fn task_has_unfinished_turn(&self, task_id: TaskId) -> Result<bool> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM codex_turns WHERE task_id=?1 AND status IN ('pending','in_progress'))",
                [task_id.to_string()],
                |row| row.get::<_, bool>(0),
            )
            .map_err(storage_error)
    }

    /// Provider processes belong to this app process and cannot survive a
    /// restart. Reconcile every unfinished task once during startup so merely
    /// opening a chat remains a read-only operation.
    pub fn settle_unfinished_turns_after_restart(&self) -> Result<usize> {
        let task_ids = {
            let connection = self.connection.lock();
            let mut statement = connection
                .prepare(
                    "SELECT DISTINCT task_id FROM codex_turns WHERE status IN ('pending','in_progress')",
                )
                .map_err(storage_error)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(storage_error)?;
            let mut task_ids = Vec::new();
            for row in rows {
                task_ids
                    .push(TaskId::from_str(&row.map_err(storage_error)?).map_err(invalid_stored)?);
            }
            task_ids
        };
        let mut settled = 0;
        for task_id in task_ids {
            while self.settle_interrupted_turn(task_id)?.is_some() {
                settled += 1;
            }
        }
        Ok(settled)
    }

    /// Render the task's shared SQLite projections (any provider) as a bounded
    /// handoff package for a freshly created native session.
    pub fn task_handoff_digest(
        &self,
        task_id: TaskId,
        options: HandoffDigestOptions,
    ) -> Result<Option<HandoffDigest>> {
        let connection = self.connection.lock();
        let edit_context = connection
            .query_row(
                "SELECT body FROM task_edit_context WHERE task_id = ?1",
                [task_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?;

        let max_turns = options.max_turns.max(1);
        let mut turn_statement = connection
            .prepare(
                "SELECT turn_id, MAX(last_event_seq) AS tip
                 FROM codex_items
                 WHERE task_id = ?1
                 GROUP BY turn_id
                 ORDER BY tip DESC
                 LIMIT ?2",
            )
            .map_err(storage_error)?;
        let turn_ids: Vec<String> = turn_statement
            .query_map(params![task_id.to_string(), max_turns as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(storage_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        let turn_set: HashSet<&str> = turn_ids.iter().map(String::as_str).collect();

        let mut item_statement = connection
            .prepare(
                "SELECT turn_id, kind, title, body, command_text, output, exit_code,
                        file_changes_json, mcp_server, mcp_tool, projection_json, last_event_seq
                 FROM codex_items
                 WHERE task_id = ?1
                 ORDER BY last_event_seq ASC",
            )
            .map_err(storage_error)?;
        let item_rows: Vec<DigestItemRow> = item_statement
            .query_map([task_id.to_string()], |row| {
                Ok(DigestItemRow {
                    turn_id: row.get(0)?,
                    kind: row.get(1)?,
                    title: row.get(2)?,
                    body: row.get(3)?,
                    command_text: row.get(4)?,
                    output: row.get(5)?,
                    exit_code: row.get(6)?,
                    file_changes_json: row.get(7)?,
                    mcp_server: row.get(8)?,
                    mcp_tool: row.get(9)?,
                    projection_json: row.get(10)?,
                    last_event_seq: row.get(11)?,
                })
            })
            .map_err(storage_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage_error)?
            .into_iter()
            .filter(|row| turn_set.contains(row.turn_id.as_str()))
            .collect();

        drop(turn_statement);
        drop(item_statement);
        drop(connection);

        if item_rows.is_empty()
            && edit_context
                .as_ref()
                .is_none_or(|body| body.trim().is_empty())
        {
            return Ok(None);
        }

        // Newest turns first for budget fill; turn_ids came DESC by tip.
        let turn_rank: HashMap<String, usize> = turn_ids
            .iter()
            .enumerate()
            .map(|(index, id)| (id.clone(), index))
            .collect();

        let mut by_turn: BTreeMap<usize, Vec<DigestItemRow>> = BTreeMap::new();
        for row in item_rows {
            let rank = turn_rank.get(&row.turn_id).copied().unwrap_or(usize::MAX);
            by_turn.entry(rank).or_default().push(row);
        }

        let max_chars = options.max_tokens.saturating_mul(4).max(1);
        let mut packed_turns: Vec<Vec<String>> = Vec::new();
        let mut used = 0_usize;
        let mut image_candidates: Vec<(i64, PathBuf)> = Vec::new();
        let mut missing_images: Vec<String> = Vec::new();

        // Fill newest-first (rank 0 first), then reverse for chronological text.
        for (_rank, rows) in by_turn {
            let mut turn_lines = Vec::new();
            for row in rows {
                if row.kind == "user_message" {
                    let body = row.body.as_deref().unwrap_or("");
                    for path in extract_attachment_paths(body) {
                        if is_image_path(&path) {
                            if path.is_file() {
                                image_candidates.push((row.last_event_seq, path));
                            } else {
                                missing_images.push(path.display().to_string());
                            }
                        }
                    }
                }
                if let Some(line) = format_digest_line(&row) {
                    turn_lines.push(line);
                }
            }
            if turn_lines.is_empty() {
                continue;
            }
            let block = turn_lines.join("\n\n");
            if used + block.len() > max_chars {
                if packed_turns.is_empty() {
                    // Always keep a clipped slice of the newest turn.
                    let clipped = clip_chars(&block, max_chars);
                    if !clipped.is_empty() {
                        packed_turns.push(vec![clipped]);
                        used = max_chars;
                    }
                }
                break;
            }
            used += block.len() + if packed_turns.is_empty() { 0 } else { 2 };
            packed_turns.push(turn_lines);
        }

        packed_turns.reverse();
        let mut lines: Vec<String> = packed_turns.into_iter().flatten().collect();

        if let Some(salvage) = edit_context {
            let salvage = salvage.trim();
            if !salvage.is_empty() {
                let header = "Assistant replies discarded by a later edit (kept as context):";
                let block = format!("{header}\n\n{salvage}");
                if used + block.len() <= max_chars {
                    used += block.len();
                    lines.push(block);
                } else if used < max_chars {
                    let budget = max_chars.saturating_sub(used + header.len() + 4);
                    if budget > 0 {
                        let clipped = clip_chars(salvage, budget);
                        if !clipped.is_empty() {
                            lines.push(format!("{header}\n\n{clipped}…"));
                        }
                    }
                }
            }
        }

        // Dedupe images newest-last, keep last N existing files.
        image_candidates.sort_by_key(|(seq, _)| *seq);
        let mut seen = HashSet::new();
        let mut image_paths = Vec::new();
        for (_, path) in image_candidates.into_iter().rev() {
            let key = path.to_string_lossy().to_string();
            if !seen.insert(key) {
                continue;
            }
            image_paths.push(path);
            if image_paths.len() >= options.max_images {
                break;
            }
        }
        image_paths.reverse();

        missing_images.sort();
        missing_images.dedup();
        if !missing_images.is_empty() {
            let note = format!(
                "Images referenced but missing on disk: {}",
                missing_images.join(", ")
            );
            if used + note.len() <= max_chars {
                lines.push(note);
            }
        }

        if lines.is_empty() && image_paths.is_empty() {
            return Ok(None);
        }
        if lines.is_empty() {
            lines.push("Prior turns included image attachments only.".into());
        }
        Ok(Some(HandoffDigest {
            text: lines.join("\n\n"),
            image_paths,
        }))
    }

    /// Backward-compatible text-only digest (char budget approximated as tokens).
    pub fn task_conversation_digest(
        &self,
        task_id: TaskId,
        max_bytes: usize,
    ) -> Result<Option<String>> {
        Ok(self
            .task_handoff_digest(task_id, HandoffDigestOptions::from_max_bytes(max_bytes))?
            .map(|digest| digest.text))
    }

    /// Drops the transcript from `from_stable_id` onward so a re-sent edit can
    /// become the new tip. Clears provider resume state so the next turn opens
    /// a fresh session seeded from the remaining rows (plus optional salvage).
    ///
    /// When `save_context` is true, assistant replies that sat below the edit
    /// point are kept in `task_edit_context` and re-injected via the digest.
    pub fn truncate_task_from(
        &self,
        task_id: TaskId,
        from_stable_id: &str,
        save_context: bool,
    ) -> Result<()> {
        let _ = self.get_task(task_id)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;

        let in_flight = transaction
            .query_row(
                "SELECT COUNT(*) FROM codex_turns WHERE task_id = ?1 AND status IN (?2, ?3)",
                params![
                    task_id.to_string(),
                    TurnStatus::Pending.as_str(),
                    TurnStatus::InProgress.as_str()
                ],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)?;
        if in_flight > 0 {
            return Err(IntegratorError::InvalidInput(
                "cannot edit a chat while it is still running".into(),
            ));
        }

        let cutoff = transaction
            .query_row(
                "SELECT last_event_seq FROM codex_items WHERE task_id = ?1 AND stable_id = ?2 ORDER BY last_event_seq DESC LIMIT 1",
                params![task_id.to_string(), from_stable_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| {
                IntegratorError::NotFound(format!("transcript item {from_stable_id}"))
            })?;

        if save_context {
            let mut statement = transaction
                .prepare(
                    "SELECT body FROM codex_items WHERE task_id = ?1 AND kind = 'agent_message' AND body IS NOT NULL AND last_event_seq > ?2 ORDER BY last_event_seq ASC LIMIT 40",
                )
                .map_err(storage_error)?;
            let bodies = statement
                .query_map(params![task_id.to_string(), cutoff], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(storage_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(storage_error)?;
            drop(statement);
            let salvage = bodies
                .into_iter()
                .map(|body| body.trim().to_owned())
                .filter(|body| !body.is_empty())
                .map(|body| format!("Assistant: {body}"))
                .collect::<Vec<_>>()
                .join("\n\n");
            if salvage.is_empty() {
                transaction
                    .execute(
                        "DELETE FROM task_edit_context WHERE task_id = ?1",
                        [task_id.to_string()],
                    )
                    .map_err(storage_error)?;
            } else {
                transaction
                    .execute(
                        "INSERT INTO task_edit_context(task_id, body, updated_at) VALUES (?1, ?2, ?3)
                         ON CONFLICT(task_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
                        params![task_id.to_string(), salvage, Utc::now().to_rfc3339()],
                    )
                    .map_err(storage_error)?;
            }
        } else {
            transaction
                .execute(
                    "DELETE FROM task_edit_context WHERE task_id = ?1",
                    [task_id.to_string()],
                )
                .map_err(storage_error)?;
        }

        transaction
            .execute(
                "DELETE FROM codex_items WHERE task_id = ?1 AND last_event_seq >= ?2",
                params![task_id.to_string(), cutoff],
            )
            .map_err(storage_error)?;
        transaction
            .execute(
                "DELETE FROM codex_turns WHERE task_id = ?1 AND last_event_seq >= ?2",
                params![task_id.to_string(), cutoff],
            )
            .map_err(storage_error)?;
        transaction
            .execute(
                "DELETE FROM codex_approvals WHERE task_id = ?1 AND last_event_seq >= ?2",
                params![task_id.to_string(), cutoff],
            )
            .map_err(storage_error)?;
        // Resume would reload the provider's untruncated transcript and undo
        // the cut; the next prompt must open a digest-seeded session instead.
        transaction
            .execute(
                "DELETE FROM provider_resume_states WHERE task_id = ?1",
                [task_id.to_string()],
            )
            .map_err(storage_error)?;
        // Plan/diff/usage describe work past the edit point; clear them so the
        // right rail does not keep advertising discarded results.
        transaction
            .execute(
                "UPDATE codex_task_projection SET current_turn_id=NULL, plan_json=NULL, plan_truncated=0, plan_seq=0, plan_event_json=NULL, diff=NULL, diff_truncated=0, diff_seq=0, diff_event_json=NULL, usage_json=NULL, usage_seq=0, usage_event_json=NULL, turn_seq=0, turn_event_json=NULL, mode_seq=0, mode_event_json=NULL, error_seq=0, error_event_json=NULL WHERE task_id=?1",
                [task_id.to_string()],
            )
            .map_err(storage_error)?;
        transaction
            .execute(
                "UPDATE tasks SET updated_at = ?1 WHERE id = ?2",
                params![Utc::now().to_rfc3339(), task_id.to_string()],
            )
            .map_err(storage_error)?;

        transaction.commit().map_err(storage_error)?;
        Ok(())
    }

    /// Newest persisted transcript item seq for a task, or 0 when the task
    /// has no items yet.
    pub fn latest_item_seq(&self, task_id: TaskId) -> Result<i64> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT COALESCE(MAX(last_event_seq), 0) FROM codex_items WHERE task_id = ?1",
                [task_id.to_string()],
                |row| row.get(0),
            )
            .map_err(storage_error)
    }

    /// Assistant message bodies persisted after `after_seq`, oldest first.
    /// The delegation sentinel scanner uses this to route `<integrator:…>`
    /// blocks from children whose provider has no MCP injection surface.
    pub fn assistant_messages_since(
        &self,
        task_id: TaskId,
        after_seq: i64,
    ) -> Result<Vec<(i64, String)>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT last_event_seq, body FROM codex_items WHERE task_id = ?1 AND kind = 'agent_message' AND body IS NOT NULL AND last_event_seq > ?2 ORDER BY last_event_seq ASC LIMIT 100",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map(params![task_id.to_string(), after_seq], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(storage_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        Ok(rows)
    }

    /// Search locally materialized user/assistant messages without loading
    /// task snapshots or waking a provider session. Results are bounded and
    /// deduplicated to one representative snippet per task.
    ///
    /// Archived chats are excluded unless `include_archived` is true so the
    /// live sidebar search stays on the hot set.
    pub fn search_task_messages(
        &self,
        query: &str,
        limit: usize,
        include_archived: bool,
    ) -> Result<Vec<(TaskId, String)>> {
        let Some(expression) = message_search_expression(query) else {
            return Ok(Vec::new());
        };
        let limit = limit.clamp(1, 50);
        let candidate_limit = (limit * 8).clamp(limit, 400) as i64;
        let connection = self.connection.lock();
        let sql = if include_archived {
            r#"
                SELECT task_id,
                       snippet(codex_items_fts, 0, '', '', ' ... ', 22)
                FROM codex_items_fts
                WHERE codex_items_fts MATCH ?1
                ORDER BY bm25(codex_items_fts), rowid DESC
                LIMIT ?2
                "#
        } else {
            r#"
                SELECT codex_items_fts.task_id,
                       snippet(codex_items_fts, 0, '', '', ' ... ', 22)
                FROM codex_items_fts
                INNER JOIN tasks ON tasks.id = codex_items_fts.task_id
                WHERE codex_items_fts MATCH ?1 AND tasks.archived = 0
                ORDER BY bm25(codex_items_fts), codex_items_fts.rowid DESC
                LIMIT ?2
                "#
        };
        let mut statement = connection.prepare(sql).map_err(storage_error)?;
        let candidates = statement
            .query_map(params![expression, candidate_limit], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(storage_error)?;

        let mut seen = HashSet::with_capacity(limit);
        let mut results = Vec::with_capacity(limit);
        for candidate in candidates {
            let (task_id, snippet) = candidate.map_err(storage_error)?;
            if !seen.insert(task_id.clone()) {
                continue;
            }
            results.push((TaskId::from_str(&task_id).map_err(invalid_stored)?, snippet));
            if results.len() == limit {
                break;
            }
        }
        Ok(results)
    }

    pub fn expire_process_approvals(&self, process_id: &str) -> Result<usize> {
        let approval_ids = {
            let connection = self.connection.lock();
            let mut statement = connection
                .prepare("SELECT id FROM codex_approvals WHERE process_id=?1 AND state IN ('pending','responding','response_failed')")
                .map_err(storage_error)?;
            statement
                .query_map([process_id], |row| row.get::<_, String>(0))
                .map_err(storage_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(storage_error)?
        };
        for approval_id in &approval_ids {
            self.transition_approval(approval_id, ApprovalState::Expired)?;
        }
        Ok(approval_ids.len())
    }

    fn transition_approval(
        &self,
        approval_id: &str,
        target: ApprovalState,
    ) -> Result<RuntimeProjectionEvent> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let row = transaction
            .query_row(
                "SELECT projection_json, task_id, provider_session_id, runtime_session_id, process_id, thread_id, turn_id, state FROM codex_approvals WHERE id=?1",
                [approval_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, String>(7)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| IntegratorError::NotFound(format!("approval {approval_id}")))?;
        let allowed = match &target {
            ApprovalState::Resolved => row.7 == "responding",
            ApprovalState::ResponseFailed => row.7 == "responding",
            ApprovalState::Expired => {
                matches!(row.7.as_str(), "pending" | "responding" | "response_failed")
            }
            _ => false,
        };
        if !allowed {
            return Err(IntegratorError::InvalidInput(format!(
                "approval cannot transition from {} to {}",
                row.7,
                target.as_str()
            )));
        }
        let mut approval: ApprovalProjection = serde_json::from_str(&row.0)?;
        approval.state = target;
        approval.updated_at = Utc::now();
        let method = format!("client/approval/{}", approval.state.as_str());
        let audit_json = serde_json::json!({
            "approvalId": approval.id.as_str(),
            "decision": approval
                .decision
                .as_ref()
                .map(ApprovalDecision::as_protocol_str),
            "state": approval.state.as_str(),
        })
        .to_string();
        transaction
            .execute(
                "INSERT INTO codex_event_log(task_id,provider_session_id,runtime_session_id,process_id,thread_id,turn_id,method,audit_json,audit_truncated,occurred_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,?9)",
                params![row.1, row.2, row.3, row.4, row.5, row.6, method, audit_json, approval.updated_at.to_rfc3339()],
            )
            .map_err(storage_error)?;
        let seq = transaction.last_insert_rowid();
        let event = RuntimeProjectionEvent {
            seq,
            task_id: TaskId::from_str(&row.1).map_err(invalid_stored)?,
            provider_session_id: ProviderSessionId::from_str(&row.2).map_err(invalid_stored)?,
            provider: provider_for_session(&transaction, &row.2)?,
            thread_id: row.5,
            turn_id: row.6,
            occurred_at: approval.updated_at,
            projection: RuntimeProjection::ApprovalChanged {
                approval: approval.clone(),
            },
        };
        persist_snapshot_event(&transaction, &event)?;
        transaction
            .execute(
                "UPDATE codex_approvals SET state=?1,updated_at=?2,projection_json=?3,last_event_seq=?4 WHERE id=?5",
                params![approval.state.as_str(), approval.updated_at.to_rfc3339(), serde_json::to_string(&approval)?, seq, approval_id],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(event)
    }
}

/// Mark the newest unfinished turn for a task as failed after the provider
/// reported an error it will not retry (a usage limit, most often). Providers
/// do not reliably close such a turn with `turn/completed`, so without this the
/// stored turn stays unfinished: it rehydrates as running after a reload, and
/// the stale-turn sweep later settles it as `interrupted` long after the fact.
///
/// Deliberately emits no projection of its own. The caller's `TurnError` is
/// already broadcast, and the renderer settles its own copy of the turn from
/// that same event — on both the live and hydration paths.
fn settle_failed_turn(
    transaction: &Transaction<'_>,
    task_id: TaskId,
    message: &str,
    occurred_at: DateTime<Utc>,
    seq: i64,
) -> Result<()> {
    let row = transaction
        .query_row(
            "SELECT projection_json, provider_session_id, turn_id FROM codex_turns WHERE task_id=?1 AND status IN ('pending','in_progress') ORDER BY last_event_seq DESC LIMIT 1",
            [task_id.to_string()],
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
    let Some(row) = row else {
        return Ok(());
    };
    let mut turn: TurnProjection = serde_json::from_str(&row.0)?;
    turn.status = TurnStatus::Failed;
    turn.error = Some(message.to_string());
    turn.completed_at = Some(occurred_at);
    transaction
        .execute(
            "UPDATE codex_turns SET status='failed',error=?1,completed_at=?2,projection_json=?3,last_event_seq=?4 WHERE provider_session_id=?5 AND turn_id=?6",
            params![
                message,
                occurred_at.to_rfc3339(),
                serde_json::to_string(&turn)?,
                seq,
                row.1,
                row.2
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

/// Mark the newest unfinished turn for a task as interrupted and log the
/// settlement. Returns the projection event to broadcast, or None when the
/// task has no unfinished turn (or no session history to attribute it to).
///
/// When `stop_requested` is true and the tip already settled as a plain
/// interrupt (cancel raced ahead of Stop), latch Stop onto that tip instead
/// of leaving it resumeable.
fn settle_stale_turn(
    transaction: &Transaction<'_>,
    task_id: TaskId,
    stop_requested: bool,
) -> Result<Option<RuntimeProjectionEvent>> {
    let unfinished = transaction.query_row(
        "SELECT projection_json, provider_session_id, thread_id, turn_id FROM codex_turns WHERE task_id=?1 AND status IN ('pending','in_progress') ORDER BY last_event_seq DESC LIMIT 1",
        [task_id.to_string()],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
    ).optional().map_err(storage_error)?;
    let row = if let Some(row) = unfinished {
        Some(row)
    } else if stop_requested {
        transaction
            .query_row(
                "SELECT projection_json, provider_session_id, thread_id, turn_id FROM codex_turns WHERE task_id=?1 AND status='interrupted' AND stop_requested=0 ORDER BY last_event_seq DESC LIMIT 1",
                [task_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?
    } else {
        None
    };
    let Some(row) = row else {
        return Ok(None);
    };
    let mut turn: TurnProjection = serde_json::from_str(&row.0)?;
    let occurred_at = Utc::now();
    turn.status = TurnStatus::Interrupted;
    // A later transport/process settlement must not clear an intentional Stop.
    // Opt-in auto-resume keys off this flag; overwriting it would undo cancel.
    turn.stop_requested = stop_requested || turn.stop_requested;
    turn.completed_at = turn.completed_at.or(Some(occurred_at));
    let method = if stop_requested {
        "client/turn/stopSettled"
    } else {
        "client/turn/interruptedSettled"
    };
    let inserted = transaction.execute(
        "INSERT INTO codex_event_log(task_id,provider_session_id,runtime_session_id,process_id,thread_id,turn_id,method,audit_json,audit_truncated,occurred_at) SELECT ?1,?2,id,COALESCE(process_id,'expired'),?3,?4,?5,'{}',0,?6 FROM runtime_sessions WHERE task_id=?1 AND provider_session_id=?2 ORDER BY started_at DESC LIMIT 1",
        params![task_id.to_string(), row.1, row.2, row.3, method, occurred_at.to_rfc3339()],
    ).map_err(storage_error)?;
    if inserted != 1 {
        return Ok(None);
    }
    let seq = transaction.last_insert_rowid();
    transaction.execute(
        "UPDATE codex_turns SET status='interrupted',stop_requested=?1,completed_at=?2,projection_json=?3,last_event_seq=?4 WHERE provider_session_id=?5 AND turn_id=?6",
        params![turn.stop_requested, turn.completed_at.map(|v| v.to_rfc3339()), serde_json::to_string(&turn)?, seq, row.1, row.3],
    ).map_err(storage_error)?;
    let event = RuntimeProjectionEvent {
        seq,
        task_id,
        provider_session_id: ProviderSessionId::from_str(&row.1).map_err(invalid_stored)?,
        provider: provider_for_session(transaction, &row.1)?,
        thread_id: row.2,
        turn_id: Some(row.3),
        occurred_at,
        projection: RuntimeProjection::TurnChanged { turn },
    };
    persist_snapshot_event(transaction, &event)?;
    Ok(Some(event))
}

fn apply_mutation(
    transaction: &Transaction<'_>,
    binding: &RuntimeBinding,
    reduced: &ReducedProviderEvent,
    seq: i64,
) -> Result<RuntimeProjection> {
    let provider_session_id = binding.provider_session_id.ok_or_else(|| {
        IntegratorError::Storage("runtime is not attached to a provider session".into())
    })?;
    let thread_id = binding
        .thread_id
        .as_deref()
        .ok_or_else(|| IntegratorError::Storage("runtime thread identity is missing".into()))?;
    ensure_task_projection(transaction, binding, seq)?;
    match &reduced.mutation {
        ProjectionMutation::Turn(turn) => {
            let stop_requested = transaction.query_row("SELECT stop_requested FROM codex_turns WHERE provider_session_id=?1 AND turn_id=?2", params![provider_session_id.to_string(), turn.id], |row| row.get::<_, bool>(0)).optional().map_err(storage_error)?.unwrap_or(false);
            let mut turn = turn.clone();
            turn.stop_requested |= stop_requested;
            transaction.execute("INSERT INTO codex_turns(provider_session_id,task_id,thread_id,turn_id,status,stop_requested,error,started_at,completed_at,projection_json,last_event_seq,first_event_seq,first_occurred_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,?12) ON CONFLICT(provider_session_id,turn_id) DO UPDATE SET status=excluded.status,stop_requested=excluded.stop_requested,error=excluded.error,started_at=excluded.started_at,completed_at=excluded.completed_at,projection_json=excluded.projection_json,last_event_seq=excluded.last_event_seq", params![provider_session_id.to_string(),binding.task_id.to_string(),thread_id,turn.id,turn.status.as_str(),turn.stop_requested,turn.error,turn.started_at.map(|v|v.to_rfc3339()),turn.completed_at.map(|v|v.to_rfc3339()),serde_json::to_string(&turn)?,seq,reduced.occurred_at.to_rfc3339()]).map_err(storage_error)?;
            transaction.execute("UPDATE codex_task_projection SET current_turn_id=?1,last_event_seq=?2 WHERE task_id=?3", params![turn.id,seq,binding.task_id.to_string()]).map_err(storage_error)?;
            Ok(RuntimeProjection::TurnChanged { turn })
        }
        ProjectionMutation::ReplaceItem(item) | ProjectionMutation::NeutralItem(item) => {
            upsert_item(transaction, binding, reduced, item, seq)?;
            Ok(RuntimeProjection::ItemChanged { item: item.clone() })
        }
        ProjectionMutation::MergeItem(update) => {
            let mut item = load_item(
                transaction,
                provider_session_id,
                reduced.turn_id.as_deref().unwrap_or("unknown"),
                &update.provider_item_id,
            )?
            .unwrap_or_else(|| update.clone());
            item.status = update.status.clone();
            item.updated_at = update.updated_at;
            if update.title.is_some() {
                item.title = update.title.clone();
            }
            if update.body.is_some() {
                item.body = update.body.clone();
            }
            if update.native_skill.is_some() {
                item.native_skill = update.native_skill.clone();
            }
            if update.phase.is_some() {
                item.phase = update.phase.clone();
            }
            if update.output.is_some() {
                item.output = update.output.clone();
            }
            if update.tool_input.is_some() {
                item.tool_input = update.tool_input.clone();
            }
            if update.file_changes.is_some() {
                item.file_changes = update.file_changes.clone();
            }
            if update.mcp_server.is_some() {
                item.mcp_server = update.mcp_server.clone();
            }
            if update.mcp_tool.is_some() {
                item.mcp_tool = update.mcp_tool.clone();
            }
            upsert_item(transaction, binding, reduced, &item, seq)?;
            Ok(RuntimeProjection::ItemChanged { item })
        }
        ProjectionMutation::AppendItem {
            provider_item_id,
            item_kind,
            field,
            delta,
            updated_at,
        } => {
            let mut item = load_item(
                transaction,
                provider_session_id,
                reduced.turn_id.as_deref().unwrap_or("unknown"),
                provider_item_id,
            )?
            .unwrap_or_else(|| ItemProjection {
                id: format!(
                    "codex:{thread_id}:{}:{provider_item_id}",
                    reduced.turn_id.as_deref().unwrap_or("unknown")
                ),
                provider_item_id: provider_item_id.clone(),
                kind: item_kind.clone(),
                status: ItemStatus::InProgress,
                title: None,
                body: None,
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
                updated_at: *updated_at,
            });
            match field {
                ItemTextField::Body => {
                    let combined = format!("{}{}", item.body.as_deref().unwrap_or_default(), delta);
                    let (value, truncated) = redact_and_bound(&combined, ITEM_BODY_LIMIT);
                    item.body = Some(value);
                    item.truncated |= truncated;
                }
                ItemTextField::Output => {
                    let combined =
                        format!("{}{}", item.output.as_deref().unwrap_or_default(), delta);
                    let (value, truncated) = bound_command_output(&combined);
                    item.output = Some(value);
                    item.truncated |= truncated;
                }
            }
            item.updated_at = *updated_at;
            upsert_item(transaction, binding, reduced, &item, seq)?;
            Ok(RuntimeProjection::ItemChanged { item })
        }
        ProjectionMutation::Plan { steps, truncated } => {
            transaction.execute("UPDATE codex_task_projection SET plan_json=?1,plan_truncated=?2,plan_seq=?3,last_event_seq=?3 WHERE task_id=?4",params![serde_json::to_string(steps)?,truncated,seq,binding.task_id.to_string()]).map_err(storage_error)?;
            Ok(RuntimeProjection::PlanChanged {
                steps: steps.clone(),
                truncated: *truncated,
            })
        }
        ProjectionMutation::Diff { diff, truncated } => {
            transaction.execute("UPDATE codex_task_projection SET diff=?1,diff_truncated=?2,diff_seq=?3,last_event_seq=?3 WHERE task_id=?4",params![diff,truncated,seq,binding.task_id.to_string()]).map_err(storage_error)?;
            Ok(RuntimeProjection::DiffChanged {
                diff: diff.clone(),
                truncated: *truncated,
            })
        }
        ProjectionMutation::Usage(usage) => {
            transaction.execute("UPDATE codex_task_projection SET usage_json=?1,usage_seq=?2,last_event_seq=?2 WHERE task_id=?3",params![serde_json::to_string(usage)?,seq,binding.task_id.to_string()]).map_err(storage_error)?;
            Ok(RuntimeProjection::UsageChanged {
                usage: usage.clone(),
            })
        }
        ProjectionMutation::UsageDelta(delta) => {
            let existing = transaction
                .query_row(
                    "SELECT usage_json FROM codex_task_projection WHERE task_id=?1",
                    params![binding.task_id.to_string()],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(storage_error)?
                .flatten()
                .and_then(|json| serde_json::from_str::<UsageProjection>(&json).ok())
                .unwrap_or_default();
            let add_cost = |lhs: Option<u64>, rhs: Option<u64>| match (lhs, rhs) {
                (None, None) => None,
                (lhs, rhs) => Some(lhs.unwrap_or(0).saturating_add(rhs.unwrap_or(0))),
            };
            let usage = UsageProjection {
                input_tokens: existing.input_tokens.saturating_add(delta.input_tokens),
                cached_input_tokens: existing
                    .cached_input_tokens
                    .saturating_add(delta.cached_input_tokens),
                output_tokens: existing.output_tokens.saturating_add(delta.output_tokens),
                reasoning_output_tokens: existing
                    .reasoning_output_tokens
                    .saturating_add(delta.reasoning_output_tokens),
                total_tokens: existing.total_tokens.saturating_add(delta.total_tokens),
                model_context_window: delta.model_context_window.or(existing.model_context_window),
                vendor_cost_micro_usd: add_cost(
                    existing.vendor_cost_micro_usd,
                    delta.vendor_cost_micro_usd,
                ),
            };
            transaction.execute("UPDATE codex_task_projection SET usage_json=?1,usage_seq=?2,last_event_seq=?2 WHERE task_id=?3",params![serde_json::to_string(&usage)?,seq,binding.task_id.to_string()]).map_err(storage_error)?;
            Ok(RuntimeProjection::UsageChanged { usage })
        }
        ProjectionMutation::Mode(mode) => {
            transaction
                .execute(
                    "UPDATE codex_task_projection SET last_event_seq=?1 WHERE task_id=?2",
                    params![seq, binding.task_id.to_string()],
                )
                .map_err(storage_error)?;
            Ok(RuntimeProjection::ModeChanged { mode: mode.clone() })
        }
        ProjectionMutation::ApprovalRequested {
            request_id,
            approval_kind,
            item_id,
            approval_id,
            reason,
            command,
            cwd,
            plan_markdown,
            options,
        } => {
            let (request_kind, request_value) = request_id_parts(request_id);
            let existing=transaction.query_row("SELECT projection_json FROM codex_approvals WHERE runtime_session_id=?1 AND request_kind=?2 AND request_value=?3 AND approval_kind=?4 AND COALESCE(approval_id,'')=COALESCE(?5,'') ORDER BY updated_at DESC LIMIT 1",params![binding.runtime_session_id.to_string(),request_kind,request_value,approval_kind.as_str(),approval_id],|row|row.get::<_,String>(0)).optional().map_err(storage_error)?;
            let mut approval = if let Some(json) = existing {
                serde_json::from_str::<ApprovalProjection>(&json)?
            } else {
                ApprovalProjection {
                    id: uuid::Uuid::new_v4().to_string(),
                    request_id: request_id.clone(),
                    approval_kind: approval_kind.clone(),
                    state: ApprovalState::Pending,
                    decision: None,
                    item_id: Some(item_id.clone()),
                    approval_id: approval_id.clone(),
                    reason: reason.clone(),
                    command: command.clone(),
                    cwd: cwd.clone(),
                    file_changes: load_item(
                        transaction,
                        provider_session_id,
                        reduced.turn_id.as_deref().unwrap_or("unknown"),
                        item_id,
                    )?
                    .and_then(|item| item.file_changes),
                    plan_markdown: plan_markdown.clone(),
                    options: options.clone(),
                    selected_option_id: None,
                    updated_at: reduced.occurred_at,
                }
            };
            approval.state = ApprovalState::Pending;
            approval.plan_markdown = plan_markdown.clone().or(approval.plan_markdown);
            // A fresh request event supersedes whatever answer choices (and
            // any prior answer) an earlier cycle for this same approval had.
            if !options.is_empty() {
                approval.options = options.clone();
            }
            approval.selected_option_id = None;
            approval.updated_at = reduced.occurred_at;
            let file_changes_json = approval
                .file_changes
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            transaction.execute("INSERT INTO codex_approvals(id,provider_session_id,runtime_session_id,task_id,process_id,thread_id,turn_id,item_id,approval_id,request_kind,request_value,approval_kind,state,decision,reason,command_text,cwd,file_changes_json,updated_at,projection_json,last_event_seq,first_event_seq,first_occurred_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'pending',NULL,?13,?14,?15,?16,?17,?18,?19,?19,?17) ON CONFLICT(id) DO UPDATE SET state='pending',reason=excluded.reason,command_text=excluded.command_text,cwd=excluded.cwd,file_changes_json=excluded.file_changes_json,updated_at=excluded.updated_at,projection_json=excluded.projection_json,last_event_seq=excluded.last_event_seq",params![approval.id,provider_session_id.to_string(),binding.runtime_session_id.to_string(),binding.task_id.to_string(),binding.process_id,thread_id,reduced.turn_id,item_id,approval_id,request_kind,request_value,approval_kind.as_str(),reason,command,cwd,file_changes_json,reduced.occurred_at.to_rfc3339(),serde_json::to_string(&approval)?,seq]).map_err(storage_error)?;
            Ok(RuntimeProjection::ApprovalChanged { approval })
        }
        ProjectionMutation::ApprovalResolved { request_id } => {
            let (kind, value) = request_id_parts(request_id);
            let json=transaction.query_row("SELECT projection_json FROM codex_approvals WHERE runtime_session_id=?1 AND request_kind=?2 AND request_value=?3 ORDER BY updated_at DESC LIMIT 1",params![binding.runtime_session_id.to_string(),kind,value],|row|row.get::<_,String>(0)).optional().map_err(storage_error)?.ok_or_else(||IntegratorError::NotFound("resolved approval".into()))?;
            let mut approval: ApprovalProjection = serde_json::from_str(&json)?;
            approval.state = ApprovalState::Resolved;
            approval.updated_at = reduced.occurred_at;
            transaction.execute("UPDATE codex_approvals SET state='resolved',updated_at=?1,projection_json=?2,last_event_seq=?3 WHERE id=?4",params![approval.updated_at.to_rfc3339(),serde_json::to_string(&approval)?,seq,approval.id]).map_err(storage_error)?;
            Ok(RuntimeProjection::ApprovalChanged { approval })
        }
        ProjectionMutation::TurnError { message, retryable } => {
            if !*retryable {
                settle_failed_turn(
                    transaction,
                    binding.task_id,
                    message,
                    reduced.occurred_at,
                    seq,
                )?;
            }
            Ok(RuntimeProjection::TurnError {
                message: message.clone(),
                retryable: *retryable,
            })
        }
        ProjectionMutation::Connection { state, reason } => {
            transaction.execute("UPDATE codex_task_projection SET connection_state=?1,connection_reason=?2,process_id=?3,connection_seq=?4,last_event_seq=?4 WHERE task_id=?5",params![state.as_str(),reason,binding.process_id,seq,binding.task_id.to_string()]).map_err(storage_error)?;
            Ok(RuntimeProjection::ConnectionChanged {
                state: state.clone(),
                reason: reason.clone(),
                process_id: Some(binding.process_id.clone()),
            })
        }
    }
}

/// Store one renderer-safe current event alongside the materialized row it
/// describes. The audit event remains untouched; item and approval snapshots
/// retain the timestamp of their first appearance in the current reset epoch.
fn persist_snapshot_event(
    transaction: &Transaction<'_>,
    event: &RuntimeProjectionEvent,
) -> Result<()> {
    let mut snapshot = event.clone();
    snapshot.projection = renderer_safe_projection(snapshot.projection);
    let task_id = event.task_id.to_string();
    let provider_session_id = event.provider_session_id.to_string();
    match &event.projection {
        RuntimeProjection::ItemChanged { item } => {
            let (first_seq, first_at, reset_seq) = transaction.query_row(
                "SELECT i.first_event_seq,i.first_occurred_at,COALESCE(p.reset_seq,0) FROM codex_items i JOIN codex_task_projection p ON p.task_id=i.task_id WHERE i.provider_session_id=?1 AND i.stable_id=?2 ORDER BY i.last_event_seq DESC LIMIT 1",
                params![provider_session_id, item.id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)?)),
            ).map_err(storage_error)?;
            let (first_seq, first_at) = if first_seq == 0 || first_seq <= reset_seq {
                (event.seq, event.occurred_at)
            } else {
                (
                    first_seq,
                    first_at
                        .as_deref()
                        .map(parse_time)
                        .transpose()?
                        .unwrap_or(event.occurred_at),
                )
            };
            snapshot.occurred_at = first_at;
            transaction.execute(
                "UPDATE codex_items SET first_event_seq=?1,first_occurred_at=?2,snapshot_event_json=?3 WHERE provider_session_id=?4 AND stable_id=?5",
                params![first_seq, first_at.to_rfc3339(), serde_json::to_string(&snapshot)?, provider_session_id, item.id],
            ).map_err(storage_error)?;
        }
        RuntimeProjection::ApprovalChanged { approval } => {
            let (first_seq, first_at, reset_seq) = transaction.query_row(
                "SELECT a.first_event_seq,a.first_occurred_at,COALESCE(p.reset_seq,0) FROM codex_approvals a JOIN codex_task_projection p ON p.task_id=a.task_id WHERE a.id=?1",
                [approval.id.as_str()],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)?)),
            ).map_err(storage_error)?;
            let (first_seq, first_at) = if first_seq == 0 || first_seq <= reset_seq {
                (event.seq, event.occurred_at)
            } else {
                (
                    first_seq,
                    first_at
                        .as_deref()
                        .map(parse_time)
                        .transpose()?
                        .unwrap_or(event.occurred_at),
                )
            };
            snapshot.occurred_at = first_at;
            transaction.execute(
                "UPDATE codex_approvals SET first_event_seq=?1,first_occurred_at=?2,snapshot_event_json=?3 WHERE id=?4",
                params![first_seq, first_at.to_rfc3339(), serde_json::to_string(&snapshot)?, approval.id],
            ).map_err(storage_error)?;
        }
        RuntimeProjection::TurnChanged { turn } => {
            let json = serde_json::to_string(&snapshot)?;
            transaction.execute(
                "UPDATE codex_turns SET first_event_seq=CASE WHEN first_event_seq=0 THEN ?1 ELSE first_event_seq END,first_occurred_at=COALESCE(first_occurred_at,?2),snapshot_event_json=?3 WHERE provider_session_id=?4 AND turn_id=?5",
                params![event.seq, event.occurred_at.to_rfc3339(), json, provider_session_id, turn.id],
            ).map_err(storage_error)?;
            transaction.execute(
                "UPDATE codex_task_projection SET turn_seq=?1,turn_event_json=?2 WHERE task_id=?3",
                params![event.seq, serde_json::to_string(&snapshot)?, task_id],
            ).map_err(storage_error)?;
        }
        RuntimeProjection::PlanChanged { .. } => update_singleton_snapshot(
            transaction,
            &task_id,
            "plan_seq",
            "plan_event_json",
            &snapshot,
        )?,
        RuntimeProjection::DiffChanged { .. } => update_singleton_snapshot(
            transaction,
            &task_id,
            "diff_seq",
            "diff_event_json",
            &snapshot,
        )?,
        RuntimeProjection::UsageChanged { .. } => update_singleton_snapshot(
            transaction,
            &task_id,
            "usage_seq",
            "usage_event_json",
            &snapshot,
        )?,
        RuntimeProjection::ModeChanged { .. } => update_singleton_snapshot(
            transaction,
            &task_id,
            "mode_seq",
            "mode_event_json",
            &snapshot,
        )?,
        RuntimeProjection::TurnError { .. } => update_singleton_snapshot(
            transaction,
            &task_id,
            "error_seq",
            "error_event_json",
            &snapshot,
        )?,
        RuntimeProjection::ConnectionChanged { .. } => update_singleton_snapshot(
            transaction,
            &task_id,
            "connection_seq",
            "connection_event_json",
            &snapshot,
        )?,
        RuntimeProjection::ProjectionReset { .. } => {
            transaction
                .execute(
                    "DELETE FROM codex_turns WHERE task_id=?1",
                    [task_id.as_str()],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "DELETE FROM codex_items WHERE task_id=?1",
                    [task_id.as_str()],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "DELETE FROM codex_approvals WHERE task_id=?1",
                    [task_id.as_str()],
                )
                .map_err(storage_error)?;
            transaction.execute(
                "UPDATE codex_task_projection SET current_turn_id=NULL,plan_json=NULL,plan_truncated=0,plan_seq=0,plan_event_json=NULL,diff=NULL,diff_truncated=0,diff_seq=0,diff_event_json=NULL,usage_json=NULL,usage_seq=0,usage_event_json=NULL,turn_seq=0,turn_event_json=NULL,mode_seq=0,mode_event_json=NULL,error_seq=0,error_event_json=NULL,connection_seq=0,connection_event_json=NULL,reset_seq=?1,reset_event_json=?2,last_event_seq=?1 WHERE task_id=?3",
                params![event.seq, serde_json::to_string(&snapshot)?, task_id],
            ).map_err(storage_error)?;
        }
    }
    Ok(())
}

fn update_singleton_snapshot(
    transaction: &Transaction<'_>,
    task_id: &str,
    seq_column: &str,
    json_column: &str,
    event: &RuntimeProjectionEvent,
) -> Result<()> {
    // Column names are closed over at compile time by the match above; no
    // provider- or renderer-controlled identifier reaches this statement.
    let sql = format!(
        "UPDATE codex_task_projection SET {seq_column}=?1,{json_column}=?2 WHERE task_id=?3"
    );
    transaction
        .execute(
            &sql,
            params![event.seq, serde_json::to_string(event)?, task_id],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn provider_for_session(
    transaction: &Transaction<'_>,
    provider_session_id: &str,
) -> Result<String> {
    transaction
        .query_row(
            "SELECT provider FROM provider_sessions WHERE id = ?1",
            [provider_session_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(storage_error)
}

fn validate_runtime_binding(
    transaction: &Transaction<'_>,
    binding: &RuntimeBinding,
    provider_session_id: ProviderSessionId,
    thread_id: &str,
) -> Result<()> {
    let valid = transaction
        .query_row(
            "SELECT 1 FROM runtime_sessions r JOIN provider_sessions p ON p.id=r.provider_session_id WHERE r.id=?1 AND r.task_id=?2 AND r.provider_session_id=?3 AND r.process_id=?4 AND p.provider=?6 AND p.provider_thread_id=?5",
            params![
                binding.runtime_session_id.to_string(),
                binding.task_id.to_string(),
                provider_session_id.to_string(),
                binding.process_id,
                thread_id,
                binding.provider.as_str(),
            ],
            |_| Ok(()),
        )
        .optional()
        .map_err(storage_error)?
        .is_some();
    if !valid {
        return Err(IntegratorError::Unauthorized(
            "runtime binding identity no longer matches persisted state".into(),
        ));
    }
    Ok(())
}

fn ensure_task_projection(
    transaction: &Transaction<'_>,
    binding: &RuntimeBinding,
    seq: i64,
) -> Result<()> {
    let provider_session_id = binding.provider_session_id.ok_or_else(|| {
        IntegratorError::Storage("runtime is not attached to a provider session".into())
    })?;
    let thread_id = binding
        .thread_id
        .as_deref()
        .ok_or_else(|| IntegratorError::Storage("runtime thread identity is missing".into()))?;
    transaction.execute("INSERT INTO codex_task_projection(task_id,provider_session_id,thread_id,process_id,last_event_seq) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(task_id) DO UPDATE SET provider_session_id=excluded.provider_session_id,thread_id=excluded.thread_id,process_id=excluded.process_id,last_event_seq=excluded.last_event_seq",params![binding.task_id.to_string(),provider_session_id.to_string(),thread_id,binding.process_id,seq]).map_err(storage_error)?;
    Ok(())
}
fn upsert_item(
    transaction: &Transaction<'_>,
    binding: &RuntimeBinding,
    reduced: &ReducedProviderEvent,
    item: &ItemProjection,
    seq: i64,
) -> Result<()> {
    let provider_session_id = binding.provider_session_id.ok_or_else(|| {
        IntegratorError::Storage("runtime is not attached to a provider session".into())
    })?;
    let thread_id = binding
        .thread_id
        .as_deref()
        .ok_or_else(|| IntegratorError::Storage("runtime thread identity is missing".into()))?;
    transaction.execute("INSERT INTO codex_items(provider_session_id,task_id,thread_id,turn_id,item_id,stable_id,kind,status,title,body,command_text,cwd,output,exit_code,file_changes_json,mcp_server,mcp_tool,truncated,updated_at,projection_json,last_event_seq,first_event_seq,first_occurred_at,native_skill) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?21,?22,?23) ON CONFLICT(provider_session_id,turn_id,item_id) DO UPDATE SET stable_id=excluded.stable_id,kind=excluded.kind,status=excluded.status,title=excluded.title,body=excluded.body,command_text=excluded.command_text,cwd=excluded.cwd,output=excluded.output,exit_code=excluded.exit_code,file_changes_json=excluded.file_changes_json,mcp_server=excluded.mcp_server,mcp_tool=excluded.mcp_tool,truncated=excluded.truncated,updated_at=excluded.updated_at,projection_json=excluded.projection_json,last_event_seq=excluded.last_event_seq,native_skill=excluded.native_skill",params![provider_session_id.to_string(),binding.task_id.to_string(),thread_id,reduced.turn_id,item.provider_item_id,item.id,item.kind.as_str(),item.status.as_str(),item.title,item.body,item.command,item.cwd,item.output,item.exit_code,item.file_changes.as_ref().map(serde_json::to_string).transpose()?,item.mcp_server,item.mcp_tool,item.truncated,item.updated_at.to_rfc3339(),serde_json::to_string(item)?,seq,reduced.occurred_at.to_rfc3339(),item.native_skill]).map_err(storage_error)?;
    Ok(())
}
fn load_item(
    transaction: &Transaction<'_>,
    provider_session_id: ProviderSessionId,
    turn_id: &str,
    item_id: &str,
) -> Result<Option<ItemProjection>> {
    transaction.query_row("SELECT projection_json FROM codex_items WHERE provider_session_id=?1 AND turn_id=?2 AND item_id=?3",params![provider_session_id.to_string(),turn_id,item_id],|row|row.get::<_,String>(0)).optional().map_err(storage_error)?.map(|json|serde_json::from_str(&json).map_err(Into::into)).transpose()
}
fn request_id_parts(id: &TransportRequestId) -> (&'static str, String) {
    match id {
        TransportRequestId::Number(number) => ("number", number.to_string()),
        TransportRequestId::String(value) => ("string", value.clone()),
    }
}
fn request_id_from_parts(kind: &str, value: &str) -> Result<TransportRequestId> {
    match kind {
        "number" => Ok(TransportRequestId::Number(
            serde_json::from_str::<serde_json::Number>(value)
                .map_err(|_| invalid_stored("invalid request number"))?,
        )),
        "string" => Ok(TransportRequestId::String(value.into())),
        _ => Err(invalid_stored("invalid request kind")),
    }
}
fn bound_command_output(value: &str) -> (String, bool) {
    let (redacted, _) = redact_and_bound(value, usize::MAX);
    if redacted.len() <= COMMAND_OUTPUT_LIMIT {
        return (redacted, false);
    }
    let tail_len = COMMAND_OUTPUT_LIMIT - COMMAND_OUTPUT_HEAD;
    let head = boundary_at_or_before(&redacted, COMMAND_OUTPUT_HEAD);
    let tail_start = boundary_at_or_after(&redacted, redacted.len() - tail_len);
    (
        format!(
            "{}\n[truncated]\n{}",
            &redacted[..head],
            &redacted[tail_start..]
        ),
        true,
    )
}

struct DigestItemRow {
    turn_id: String,
    kind: String,
    title: Option<String>,
    body: Option<String>,
    command_text: Option<String>,
    output: Option<String>,
    exit_code: Option<i64>,
    file_changes_json: Option<String>,
    mcp_server: Option<String>,
    mcp_tool: Option<String>,
    projection_json: Option<String>,
    last_event_seq: i64,
}

fn strip_handoff_primer(text: &str) -> &str {
    const OPEN: &str = "<conversation-context>";
    const CLOSE: &str = "</conversation-context>";
    let trimmed = text.trim_start();
    if let Some(rest) = trimmed.strip_prefix(OPEN)
        && let Some(end) = rest.find(CLOSE)
    {
        return rest[end + CLOSE.len()..].trim_start();
    }
    text
}

fn clip_chars(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_owned();
    }
    let mut boundary = max.min(value.len());
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    let mut clipped = value[..boundary].to_owned();
    if !clipped.is_empty() {
        clipped.push('…');
    }
    clipped
}

fn clip_head_tail(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_owned();
    }
    let head = max / 2;
    let tail = max.saturating_sub(head + 16);
    let head_end = boundary_at_or_before(value, head);
    let tail_start = boundary_at_or_after(value, value.len().saturating_sub(tail));
    format!(
        "{}\n…[truncated {} chars]…\n{}",
        &value[..head_end],
        value
            .len()
            .saturating_sub(head_end + (value.len() - tail_start)),
        &value[tail_start..]
    )
}

fn tool_input_from_projection(projection_json: &Option<String>) -> Option<String> {
    let json = projection_json.as_deref()?;
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    value
        .get("toolInput")
        .or_else(|| value.get("tool_input"))
        .and_then(|v| {
            v.as_str()
                .map(str::to_owned)
                .or_else(|| serde_json::to_string(v).ok())
        })
}

fn looks_like_web_or_browse(label: &str) -> bool {
    let lower = label.to_ascii_lowercase();
    [
        "websearch",
        "web_search",
        "webfetch",
        "web_fetch",
        "browser",
        "search_web",
        "googlesearch",
        "duckduckgo",
        "fetch_url",
        "open_url",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn looks_like_file_read(label: &str, input: &str) -> bool {
    let hay = format!("{label} {input}").to_ascii_lowercase();
    [
        "read",
        "read_file",
        "readfile",
        "view",
        "cat ",
        "file_view",
        "open_file",
        "get_file",
        "preview",
    ]
    .iter()
    .any(|needle| hay.contains(needle))
}

fn extract_attachment_paths(body: &str) -> Vec<PathBuf> {
    let Some(index) = body.rfind("Attached files:\n") else {
        return Vec::new();
    };
    // Require start-of-body or blank line before the marker (matches UI parser).
    if index > 0 && !body[..index].ends_with("\n\n") {
        return Vec::new();
    }
    body[index + "Attached files:\n".len()..]
        .lines()
        .filter_map(|line| {
            let path = line.strip_prefix("- ")?.trim();
            (!path.is_empty()).then(|| PathBuf::from(path))
        })
        .collect()
}

fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico" | "avif"
            )
        })
        .unwrap_or(false)
}

fn format_file_changes(json: &str) -> Option<String> {
    let changes: Vec<serde_json::Value> = serde_json::from_str(json).ok()?;
    if changes.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for change in changes.iter().take(24) {
        let path = change.get("path").and_then(|v| v.as_str()).unwrap_or("?");
        let kind = change
            .get("changeKind")
            .or_else(|| change.get("change_kind"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        parts.push(format!("{kind} {path}"));
    }
    if changes.len() > 24 {
        parts.push(format!("…+{} more", changes.len() - 24));
    }
    Some(format!("File changes: {}", parts.join("; ")))
}

fn format_digest_line(row: &DigestItemRow) -> Option<String> {
    match row.kind.as_str() {
        "reasoning_summary" | "unknown" => None,
        "user_message" => {
            let text = strip_handoff_primer(row.body.as_deref().unwrap_or("")).trim();
            if text.is_empty() {
                return None;
            }
            Some(format!("User: {}", clip_chars(text, HANDOFF_USER_CLIP)))
        }
        "agent_message" => {
            let text = row
                .body
                .as_deref()
                .or(row.title.as_deref())
                .unwrap_or("")
                .trim();
            if text.is_empty() {
                return None;
            }
            Some(format!(
                "Assistant: {}",
                clip_chars(text, HANDOFF_ASSISTANT_CLIP)
            ))
        }
        "file_change" => row
            .file_changes_json
            .as_deref()
            .and_then(format_file_changes),
        "command_execution" => {
            let command = row.command_text.as_deref().unwrap_or("command").trim();
            let exit = row
                .exit_code
                .map(|code| format!(" exit={code}"))
                .unwrap_or_default();
            let output = row.output.as_deref().unwrap_or("").trim();
            if output.is_empty() {
                Some(format!("Command: `{command}`{exit}"))
            } else if output.len() > HANDOFF_NOISY_OUTPUT_THRESHOLD {
                Some(format!(
                    "Command: `{command}`{exit} → {} chars truncated",
                    output.len()
                ))
            } else {
                Some(format!(
                    "Command: `{command}`{exit}\n{}",
                    clip_chars(output, HANDOFF_COMMAND_OUTPUT_CLIP)
                ))
            }
        }
        "mcp_tool" => {
            let tool = row
                .mcp_tool
                .as_deref()
                .or(row.title.as_deref())
                .unwrap_or("tool");
            let server = row.mcp_server.as_deref().unwrap_or("");
            let label = if server.is_empty() {
                tool.to_owned()
            } else {
                format!("{server} · {tool}")
            };
            let input = tool_input_from_projection(&row.projection_json).unwrap_or_default();
            let output = row
                .output
                .as_deref()
                .or(row.body.as_deref())
                .unwrap_or("")
                .trim();

            if looks_like_web_or_browse(&label) || looks_like_web_or_browse(&input) {
                let query = clip_chars(input.trim(), 120);
                let query = if query.is_empty() {
                    "…".into()
                } else {
                    query
                };
                return Some(format!(
                    "WebSearch/browse ({label}): \"{query}\" → {} chars truncated",
                    output.len()
                ));
            }

            if looks_like_file_read(&label, &input) {
                let path_hint = clip_chars(input.trim(), 200);
                let meat = if output.is_empty() {
                    "(empty)".into()
                } else {
                    clip_head_tail(output, HANDOFF_READ_CLIP)
                };
                return Some(if path_hint.is_empty() {
                    format!("Read ({label}):\n{meat}")
                } else {
                    format!("Read ({label}): {path_hint}\n{meat}")
                });
            }

            if output.len() > HANDOFF_NOISY_OUTPUT_THRESHOLD {
                return Some(format!("Tool ({label}): {} chars truncated", output.len()));
            }
            if output.is_empty() {
                let input_clip = clip_chars(input.trim(), 200);
                return Some(if input_clip.is_empty() {
                    format!("Tool ({label})")
                } else {
                    format!("Tool ({label}): {input_clip}")
                });
            }
            Some(format!(
                "Tool ({label}):\n{}",
                clip_chars(output, HANDOFF_COMMAND_OUTPUT_CLIP)
            ))
        }
        _ => {
            let text = row
                .body
                .as_deref()
                .or(row.output.as_deref())
                .or(row.title.as_deref())
                .unwrap_or("")
                .trim();
            if text.is_empty() {
                None
            } else {
                Some(format!("{}: {}", row.kind, clip_chars(text, 700)))
            }
        }
    }
}

fn boundary_at_or_before(value: &str, mut index: usize) -> usize {
    while !value.is_char_boundary(index) {
        index -= 1
    }
    index
}
fn boundary_at_or_after(value: &str, mut index: usize) -> usize {
    while !value.is_char_boundary(index) {
        index += 1
    }
    index
}
fn renderer_safe_projection(mut projection: RuntimeProjection) -> RuntimeProjection {
    match &mut projection {
        RuntimeProjection::ItemChanged { item } => {
            if let Some(body) = item.body.take() {
                let (value, truncated) = redact_and_bound(&body, RENDERER_CONTENT_LIMIT);
                item.body = Some(value);
                item.truncated |= truncated
            }
            if let Some(output) = item.output.take() {
                let (value, truncated) = redact_and_bound(&output, RENDERER_CONTENT_LIMIT);
                item.output = Some(value);
                item.truncated |= truncated
            }
        }
        RuntimeProjection::DiffChanged { diff, truncated } => {
            let (value, was) = redact_and_bound(diff, RENDERER_CONTENT_LIMIT);
            *diff = value;
            *truncated |= was
        }
        RuntimeProjection::ApprovalChanged { approval } => {
            if let Some(changes) = approval.file_changes.as_mut() {
                for change in changes {
                    if let Some(patch) = change.patch.take() {
                        change.patch = Some(redact_and_bound(&patch, 32 * 1024).0)
                    }
                }
            }
            if let Some(plan) = approval.plan_markdown.take() {
                approval.plan_markdown = Some(redact_and_bound(&plan, RENDERER_CONTENT_LIMIT).0)
            }
        }
        _ => {}
    }
    projection
}
fn validate_identity(value: &str, label: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 512
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(IntegratorError::InvalidInput(format!(
            "invalid {label} identity"
        )));
    }
    Ok(())
}

fn message_search_expression(query: &str) -> Option<String> {
    if query.trim().chars().count() < 2 {
        return None;
    }
    let normalized = query
        .chars()
        .take(200)
        .map(|character| {
            if character.is_alphanumeric() || character == '_' {
                character
            } else {
                ' '
            }
        })
        .collect::<String>();
    let terms = normalized
        .split_whitespace()
        .take(8)
        .map(|term| format!(r#""{term}"*"#))
        .collect::<Vec<_>>();
    (!terms.is_empty()).then(|| terms.join(" AND "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::DateTime;
    use integrator_core::{
        ApprovalKind, ConnectionState, ItemKind, ModeOption, ModeProjection, NewTask,
        TaskSnapshotQuery, TransportRequestId, TurnStatus,
    };

    fn bound_store(provider: ProviderKind) -> (LocalStore, RuntimeBinding) {
        let store = LocalStore::open_in_memory().expect("open store");
        let task = store
            .create_task(NewTask {
                title: "Projection fixture".into(),
                repository_path: None,
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create task");
        let binding = store
            .create_runtime_binding(task.id, "process-fixture", provider)
            .expect("create runtime binding");
        let binding = store
            .attach_provider_thread(&binding, "thread-fixture")
            .expect("attach thread");
        (store, binding)
    }

    fn redundant_event_projection_count(store: &LocalStore, task_id: TaskId) -> i64 {
        let connection = store.connection.lock();
        connection
            .query_row(
                "SELECT COUNT(*) FROM codex_event_log WHERE task_id=?1 AND projection_json IS NOT NULL",
                [task_id.to_string()],
                |row| row.get(0),
            )
            .expect("count redundant event projections")
    }

    fn request_command_approval(
        store: &LocalStore,
        binding: &RuntimeBinding,
        request_id: &str,
    ) -> ApprovalProjection {
        let requested = store
            .apply_reduced_event(
                binding,
                &ReducedProviderEvent {
                    method: "item/commandExecution/requestApproval".into(),
                    thread_id: "thread-fixture".into(),
                    turn_id: Some("turn-approval".into()),
                    audit_json: "{}".into(),
                    audit_truncated: false,
                    mutation: ProjectionMutation::ApprovalRequested {
                        request_id: TransportRequestId::String(request_id.into()),
                        approval_kind: ApprovalKind::CommandExecution,
                        item_id: format!("command-{request_id}"),
                        approval_id: Some(format!("provider-{request_id}")),
                        reason: Some("run focused tests".into()),
                        command: Some("cargo test -p session-store".into()),
                        cwd: Some("fixture/integrator-3".into()),
                        plan_markdown: None,
                        options: Vec::new(),
                    },
                    occurred_at: Utc::now(),
                },
            )
            .expect("persist approval request");
        let RuntimeProjection::ApprovalChanged { approval } = requested.projection else {
            panic!("expected approval projection");
        };
        approval
    }

    fn request_question_approval(
        store: &LocalStore,
        binding: &RuntimeBinding,
        request_id: &str,
    ) -> ApprovalProjection {
        let requested = store
            .apply_reduced_event(
                binding,
                &ReducedProviderEvent {
                    method: "session/request_permission".into(),
                    thread_id: "thread-fixture".into(),
                    turn_id: Some("turn-approval".into()),
                    audit_json: "{}".into(),
                    audit_truncated: false,
                    mutation: ProjectionMutation::ApprovalRequested {
                        request_id: TransportRequestId::String(request_id.into()),
                        approval_kind: ApprovalKind::Question,
                        item_id: format!("question-{request_id}"),
                        approval_id: Some(format!("provider-{request_id}")),
                        reason: Some("Which frequency should I use?".into()),
                        command: None,
                        cwd: None,
                        plan_markdown: None,
                        options: vec![
                            integrator_core::QuestionOption {
                                option_id: "opt-monthly".into(),
                                label: "Monthly".into(),
                            },
                            integrator_core::QuestionOption {
                                option_id: "opt-quarterly".into(),
                                label: "Quarterly".into(),
                            },
                        ],
                    },
                    occurred_at: Utc::now(),
                },
            )
            .expect("persist question approval request");
        let RuntimeProjection::ApprovalChanged { approval } = requested.projection else {
            panic!("expected approval projection");
        };
        approval
    }

    fn completed_message(
        provider_item_id: &str,
        kind: ItemKind,
        body: &str,
    ) -> ReducedProviderEvent {
        let occurred_at = Utc::now();
        ReducedProviderEvent {
            method: "item/completed".into(),
            thread_id: "thread-fixture".into(),
            turn_id: Some("turn-search".into()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::ReplaceItem(ItemProjection {
                id: format!("fixture:{provider_item_id}"),
                provider_item_id: provider_item_id.into(),
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
                updated_at: occurred_at,
            }),
            occurred_at,
        }
    }

    fn append_message(
        provider_item_id: &str,
        delta: &str,
        item_updated_at: DateTime<Utc>,
        occurred_at: DateTime<Utc>,
    ) -> ReducedProviderEvent {
        ReducedProviderEvent {
            method: "item/agentMessage/delta".into(),
            thread_id: "thread-fixture".into(),
            turn_id: Some("turn-1".into()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::AppendItem {
                provider_item_id: provider_item_id.into(),
                item_kind: ItemKind::AgentMessage,
                field: ItemTextField::Body,
                delta: delta.into(),
                updated_at: item_updated_at,
            },
            occurred_at,
        }
    }

    fn append_command_output(provider_item_id: &str, delta: &str) -> ReducedProviderEvent {
        let occurred_at = Utc::now();
        ReducedProviderEvent {
            method: "item/commandExecution/outputDelta".into(),
            thread_id: "thread-fixture".into(),
            turn_id: Some("turn-command".into()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::AppendItem {
                provider_item_id: provider_item_id.into(),
                item_kind: ItemKind::CommandExecution,
                field: ItemTextField::Output,
                delta: delta.into(),
                updated_at: occurred_at,
            },
            occurred_at,
        }
    }

    fn persist_reset(
        store: &LocalStore,
        binding: &RuntimeBinding,
        occurred_at: DateTime<Utc>,
    ) -> RuntimeProjectionEvent {
        let provider_session_id = binding
            .provider_session_id
            .expect("attached provider session");
        let thread_id = binding.thread_id.as_deref().expect("attached thread");
        let mut connection = store.connection.lock();
        let transaction = connection.transaction().expect("reset transaction");
        transaction
            .execute(
                "INSERT INTO codex_event_log(task_id,provider_session_id,runtime_session_id,process_id,thread_id,turn_id,method,audit_json,audit_truncated,occurred_at) VALUES (?1,?2,?3,?4,?5,NULL,'client/projection/reset','{}',0,?6)",
                params![
                    binding.task_id.to_string(),
                    provider_session_id.to_string(),
                    binding.runtime_session_id.to_string(),
                    binding.process_id,
                    thread_id,
                    occurred_at.to_rfc3339()
                ],
            )
            .expect("insert reset audit event");
        let seq = transaction.last_insert_rowid();
        ensure_task_projection(&transaction, binding, seq).expect("ensure task projection");
        let event = RuntimeProjectionEvent {
            seq,
            task_id: binding.task_id,
            provider_session_id,
            provider: binding.provider.as_str().into(),
            thread_id: thread_id.into(),
            turn_id: None,
            occurred_at,
            projection: RuntimeProjection::ProjectionReset {
                reason: "test reset".into(),
            },
        };
        persist_snapshot_event(&transaction, &event).expect("materialize reset");
        transaction.commit().expect("commit reset");
        event
    }

    #[test]
    fn message_search_is_indexed_bounded_and_provider_independent() {
        let (store, binding) = bound_store(ProviderKind::Codex);
        store
            .apply_reduced_event(
                &binding,
                &completed_message(
                    "user-search",
                    ItemKind::UserMessage,
                    "Please retry the SQLite migration safely",
                ),
            )
            .expect("persist user message");
        store
            .apply_reduced_event(
                &binding,
                &completed_message(
                    "agent-search",
                    ItemKind::AgentMessage,
                    "The retry now keeps every local projection intact",
                ),
            )
            .expect("persist agent message");
        store
            .apply_reduced_event(
                &binding,
                &completed_message(
                    "tool-search",
                    ItemKind::CommandExecution,
                    "secret-tool-only-needle",
                ),
            )
            .expect("persist tool output");

        let matches = store
            .search_task_messages("retry SQLite", 20, false)
            .expect("search messages");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].0, binding.task_id);
        assert!(matches[0].1.to_lowercase().contains("retry"));
        assert!(
            store
                .search_task_messages("secret-tool-only-needle", 20, false)
                .expect("search tool-only text")
                .is_empty()
        );
        assert!(
            store
                .search_task_messages("retry OR \\\"migration", 20, false)
                .expect("sanitize FTS syntax")
                .len()
                <= 1
        );
    }

    #[test]
    fn message_search_excludes_archived_tasks_unless_requested() {
        let (store, binding) = bound_store(ProviderKind::Codex);
        store
            .apply_reduced_event(
                &binding,
                &completed_message(
                    "archived-user",
                    ItemKind::UserMessage,
                    "Archive needle stays cold until requested",
                ),
            )
            .expect("persist user message");
        store
            .update_task_metadata(binding.task_id, None, None, Some(true))
            .expect("archive task");

        assert!(
            store
                .search_task_messages("Archive needle", 20, false)
                .expect("live search")
                .is_empty(),
            "archived chats must stay out of the live search hot path"
        );
        let included = store
            .search_task_messages("Archive needle", 20, true)
            .expect("archive-inclusive search");
        assert_eq!(included.len(), 1);
        assert_eq!(included[0].0, binding.task_id);
    }

    #[test]
    fn reduced_events_are_sequenced_and_snapshot_at_a_watermark() {
        let (store, binding) = bound_store(ProviderKind::Codex);
        let occurred_at = Utc::now();
        let turn = ReducedProviderEvent {
            method: "turn/started".into(),
            thread_id: "thread-fixture".into(),
            turn_id: Some("turn-1".into()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::Turn(TurnProjection {
                id: "turn-1".into(),
                status: TurnStatus::InProgress,
                stop_requested: false,
                error: None,
                started_at: Some(occurred_at),
                completed_at: None,
            }),
            occurred_at,
        };
        let event = store
            .apply_reduced_event(&binding, &turn)
            .expect("persist turn");
        let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
        assert_eq!(snapshot.watermark_seq, event.seq);
        assert_eq!(snapshot.reset_seq, 0);
        assert!(!snapshot.cache_matched);
        let hydrate = snapshot.hydrate.expect("compact hydrate");
        let RuntimeProjection::TurnChanged { turn } = event.projection else {
            panic!("expected turn event");
        };
        assert_eq!(hydrate.turn.as_ref(), Some(&turn));
        assert!(hydrate.items.is_empty());
    }

    #[test]
    fn non_retryable_error_settles_the_stored_turn_but_a_retryable_one_does_not() {
        fn started_turn(occurred_at: DateTime<Utc>) -> ReducedProviderEvent {
            ReducedProviderEvent {
                method: "turn/started".into(),
                thread_id: "thread-fixture".into(),
                turn_id: Some("turn-1".into()),
                audit_json: "{}".into(),
                audit_truncated: false,
                mutation: ProjectionMutation::Turn(TurnProjection {
                    id: "turn-1".into(),
                    status: TurnStatus::InProgress,
                    stop_requested: false,
                    error: None,
                    started_at: Some(occurred_at),
                    completed_at: None,
                }),
                occurred_at,
            }
        }
        fn error_event(
            occurred_at: DateTime<Utc>,
            message: &str,
            retryable: bool,
        ) -> ReducedProviderEvent {
            ReducedProviderEvent {
                method: "error".into(),
                thread_id: "thread-fixture".into(),
                turn_id: Some("turn-1".into()),
                audit_json: "{}".into(),
                audit_truncated: false,
                mutation: ProjectionMutation::TurnError {
                    message: message.into(),
                    retryable,
                },
                occurred_at,
            }
        }
        fn stored_turn_status(store: &LocalStore) -> String {
            store
                .connection
                .lock()
                .query_row(
                    "SELECT status FROM codex_turns WHERE turn_id='turn-1'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .expect("read stored turn")
        }

        let occurred_at = Utc::now();

        // A provider that is still retrying keeps the turn open.
        let (retrying, retrying_binding) = bound_store(ProviderKind::Codex);
        retrying
            .apply_reduced_event(&retrying_binding, &started_turn(occurred_at))
            .expect("persist turn");
        retrying
            .apply_reduced_event(
                &retrying_binding,
                &error_event(occurred_at, "stream disconnected", true),
            )
            .expect("persist retryable error");
        assert_eq!(stored_turn_status(&retrying), "in_progress");

        // A provider that will not retry has abandoned the turn, so the stored
        // row settles rather than rehydrating as running after a reload.
        let (limited, limited_binding) = bound_store(ProviderKind::Codex);
        limited
            .apply_reduced_event(&limited_binding, &started_turn(occurred_at))
            .expect("persist turn");
        limited
            .apply_reduced_event(
                &limited_binding,
                &error_event(occurred_at, "usage limit reached", false),
            )
            .expect("persist non-retryable error");
        assert_eq!(stored_turn_status(&limited), "failed");

        // The settled turn is no longer unfinished work for the stale sweep, so
        // closing the session cannot relabel it `interrupted` after the fact.
        let connection = limited.connection.lock();
        let transaction = connection.unchecked_transaction().expect("transaction");
        assert!(
            settle_stale_turn(&transaction, limited_binding.task_id, false)
                .expect("sweep settled turn")
                .is_none()
        );
    }

    #[test]
    fn verified_native_skill_survives_snapshot_persistence() {
        let (store, binding) = bound_store(ProviderKind::Codex);
        let mut event = completed_message(
            "user-native-skill",
            ItemKind::UserMessage,
            "/skill-creator build one",
        );
        let ProjectionMutation::ReplaceItem(item) = &mut event.mutation else {
            panic!("expected completed message replacement");
        };
        item.native_skill = Some("skill-creator".into());

        store
            .apply_reduced_event(&binding, &event)
            .expect("persist verified native skill");

        let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
        let item = &snapshot.hydrate.expect("hydrate").items[0];
        assert_eq!(item.body.as_deref(), Some("/skill-creator build one"));
        assert_eq!(item.native_skill.as_deref(), Some("skill-creator"));
        assert_eq!(
            store
                .skill_invocation_counts()
                .expect("count verified skill")
                .get("skill-creator"),
            Some(&1)
        );
    }

    #[test]
    fn snapshot_collapses_streaming_item_deltas_to_the_latest_projection() {
        let (store, binding) = bound_store(ProviderKind::Codex);
        let occurred_at = Utc::now();

        store
            .apply_reduced_event(
                &binding,
                &append_message("message-1", "hello ", occurred_at, occurred_at),
            )
            .expect("persist first delta");
        let latest = store
            .apply_reduced_event(
                &binding,
                &append_message(
                    "message-1",
                    "world",
                    occurred_at,
                    occurred_at + chrono::Duration::milliseconds(10),
                ),
            )
            .expect("persist second delta");
        let other = store
            .apply_reduced_event(
                &binding,
                &append_message(
                    "message-2",
                    "another item",
                    occurred_at,
                    occurred_at + chrono::Duration::milliseconds(20),
                ),
            )
            .expect("persist other item");

        let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
        assert_eq!(snapshot.watermark_seq, other.seq);
        let hydrate = snapshot.hydrate.expect("hydrate");
        assert_eq!(hydrate.items.len(), 2);
        assert_eq!(hydrate.items[0].body.as_deref(), Some("hello world"));
        assert_eq!(
            hydrate.first_seen.get(&hydrate.items[0].id),
            Some(&occurred_at)
        );
        assert_eq!(hydrate.before_seq, Some(latest.seq));
        assert!(!hydrate.has_more_older);
    }

    #[test]
    fn streamed_command_output_preserves_model_visible_json() {
        let (store, binding) = bound_store(ProviderKind::Codex);
        let output = r#"{"id":1,"jsonrpc":"2.0","result":{"capabilities":{"tools":{}},"protocolVersion":"2024-11-05","serverInfo":{"name":"integrator-local-tools","version":"0.1.0"}}}"#;
        store
            .apply_reduced_event(&binding, &append_command_output("command-1", output))
            .expect("persist command output");

        let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
        let hydrate = snapshot.hydrate.expect("hydrate");
        assert_eq!(hydrate.items.len(), 1);
        assert_eq!(hydrate.items[0].output.as_deref(), Some(output));
    }

    #[test]
    fn snapshot_keeps_singletons_and_approval_current_without_replaying_audit_json() {
        let (store, binding) = bound_store(ProviderKind::Cursor);
        let at = Utc::now();
        let mutations = [
            ProjectionMutation::Connection {
                state: ConnectionState::Connected,
                reason: None,
            },
            ProjectionMutation::Mode(ModeProjection {
                current_mode_id: "agent".into(),
                available_modes: vec![ModeOption {
                    id: "agent".into(),
                    name: "Agent".into(),
                    description: Some("Provider-owned mode".into()),
                }],
            }),
            ProjectionMutation::ApprovalRequested {
                request_id: TransportRequestId::String("approval-request".into()),
                approval_kind: ApprovalKind::CommandExecution,
                item_id: "command-1".into(),
                approval_id: Some("provider-approval-1".into()),
                reason: Some("run tests".into()),
                command: Some("cargo test".into()),
                cwd: Some("fixture/integrator-3".into()),
                plan_markdown: None,
                options: Vec::new(),
            },
            ProjectionMutation::TurnError {
                message: "provider disconnected".into(),
                retryable: true,
            },
        ];
        for (offset, mutation) in mutations.into_iter().enumerate() {
            store
                .apply_reduced_event(
                    &binding,
                    &ReducedProviderEvent {
                        method: format!("fixture/{offset}"),
                        thread_id: "thread-fixture".into(),
                        turn_id: Some("turn-1".into()),
                        audit_json: format!(r#"{{"offset":{offset}}}"#),
                        audit_truncated: false,
                        mutation,
                        occurred_at: at + chrono::Duration::milliseconds(offset as i64),
                    },
                )
                .expect("persist projection");
        }

        let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
        let hydrate = snapshot.hydrate.expect("hydrate");
        assert!(matches!(
            hydrate.connection.as_ref(),
            Some(connection) if connection.state == ConnectionState::Connected
        ));
        assert_eq!(
            hydrate
                .mode
                .as_ref()
                .map(|mode| mode.current_mode_id.as_str()),
            Some("agent")
        );
        assert_eq!(hydrate.approvals.len(), 1);
        assert_eq!(hydrate.approvals[0].state, ApprovalState::Pending);
        assert!(matches!(
            hydrate.error.as_ref(),
            Some(error) if error.retryable
        ));
        let connection = store.connection.lock();
        let audit_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM codex_event_log WHERE task_id=?1",
                [binding.task_id.to_string()],
                |row| row.get(0),
            )
            .expect("audit count");
        assert_eq!(
            audit_count, 4,
            "every accepted event remains in the audit log"
        );
        drop(connection);
        assert_eq!(
            redundant_event_projection_count(&store, binding.task_id),
            0,
            "current snapshots must not be copied into the append-only audit log"
        );
    }

    #[test]
    fn approval_client_events_keep_compact_audit_identity_without_projection_copies() {
        let (store, binding) = bound_store(ProviderKind::Codex);
        let approval = request_command_approval(&store, &binding, "request-approval");

        store
            .prepare_approval_response(binding.task_id, &approval.id, ApprovalDecision::Accept)
            .expect("prepare approval response");
        store
            .mark_approval_response_failed(&approval.id)
            .expect("record provider response failure");

        let audit_rows = {
            let connection = store.connection.lock();
            let mut statement = connection
                .prepare(
                    "SELECT method,audit_json FROM codex_event_log WHERE task_id=?1 AND method LIKE 'client/approval/%' ORDER BY seq",
                )
                .expect("prepare compact audit query");
            statement
                .query_map([binding.task_id.to_string()], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .expect("query compact audit rows")
                .collect::<std::result::Result<Vec<_>, _>>()
                .expect("collect compact audit rows")
        };
        assert_eq!(audit_rows.len(), 2);
        assert_eq!(audit_rows[0].0, "client/approval/responding");
        assert_eq!(audit_rows[1].0, "client/approval/response_failed");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&audit_rows[0].1)
                .expect("parse responding audit"),
            serde_json::json!({
                "approvalId": approval.id,
                "decision": "accept",
                "state": "responding",
            })
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&audit_rows[1].1)
                .expect("parse response-failed audit"),
            serde_json::json!({
                "approvalId": approval.id,
                "decision": "accept",
                "state": "response_failed",
            })
        );
        assert_eq!(redundant_event_projection_count(&store, binding.task_id), 0);
    }

    #[test]
    fn successful_client_approval_response_resolves_durable_projection() {
        let (store, binding) = bound_store(ProviderKind::Cursor);
        let approval = request_command_approval(&store, &binding, "request-success");

        store
            .prepare_approval_response(
                binding.task_id,
                &approval.id,
                ApprovalDecision::AcceptForSession,
            )
            .expect("prepare approval response");
        let resolved = store
            .mark_approval_response_resolved(&approval.id)
            .expect("record successful provider response");

        let RuntimeProjection::ApprovalChanged { approval: resolved } = resolved.projection else {
            panic!("expected resolved approval projection");
        };
        assert_eq!(resolved.state, ApprovalState::Resolved);
        assert_eq!(resolved.decision, Some(ApprovalDecision::AcceptForSession));

        let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
        let hydrated = snapshot.hydrate.expect("hydrate snapshot");
        assert_eq!(hydrated.approvals.len(), 1);
        assert_eq!(hydrated.approvals[0].state, ApprovalState::Resolved);

        let methods = {
            let connection = store.connection.lock();
            let mut statement = connection
                .prepare(
                    "SELECT method FROM codex_event_log WHERE task_id=?1 AND method LIKE 'client/approval/%' ORDER BY seq",
                )
                .expect("prepare approval audit query");
            statement
                .query_map([binding.task_id.to_string()], |row| row.get::<_, String>(0))
                .expect("query approval audit")
                .collect::<std::result::Result<Vec<_>, _>>()
                .expect("collect approval audit")
        };
        assert_eq!(
            methods,
            vec!["client/approval/responding", "client/approval/resolved"]
        );
        assert_eq!(redundant_event_projection_count(&store, binding.task_id), 0);
    }

    #[test]
    fn question_approval_carries_its_offered_options() {
        let (store, binding) = bound_store(ProviderKind::Kimi);
        let approval = request_question_approval(&store, &binding, "request-question");
        assert_eq!(approval.approval_kind, ApprovalKind::Question);
        assert_eq!(approval.options.len(), 2);
        assert_eq!(approval.options[0].label, "Monthly");
        assert_eq!(approval.selected_option_id, None);
    }

    #[test]
    fn answering_a_question_records_the_chosen_option_and_selects_it_over_acp() {
        let (store, binding) = bound_store(ProviderKind::Kimi);
        let approval = request_question_approval(&store, &binding, "request-answer");

        let prepared = store
            .prepare_question_response(binding.task_id, &approval.id, "opt-quarterly")
            .expect("prepare question response");
        let RuntimeProjection::ApprovalChanged { approval: responding } =
            prepared.event.projection
        else {
            panic!("expected approval projection");
        };
        assert_eq!(responding.state, ApprovalState::Responding);
        assert_eq!(responding.decision, Some(ApprovalDecision::Select));
        assert_eq!(
            responding.selected_option_id.as_deref(),
            Some("opt-quarterly")
        );

        let resolved = store
            .mark_approval_response_resolved(&approval.id)
            .expect("record successful provider response");
        let RuntimeProjection::ApprovalChanged { approval: resolved } = resolved.projection else {
            panic!("expected resolved approval projection");
        };
        assert_eq!(resolved.state, ApprovalState::Resolved);
        assert_eq!(
            resolved.selected_option_id.as_deref(),
            Some("opt-quarterly")
        );
    }

    #[test]
    fn answering_a_question_rejects_an_option_that_was_never_offered() {
        let (store, binding) = bound_store(ProviderKind::Kimi);
        let approval = request_question_approval(&store, &binding, "request-bad-option");

        let error = store
            .prepare_question_response(binding.task_id, &approval.id, "opt-annually")
            .expect_err("an unoffered option must be rejected");
        assert!(matches!(error, IntegratorError::InvalidInput(_)));
    }

    #[test]
    fn answering_a_question_rejects_non_question_approvals() {
        let (store, binding) = bound_store(ProviderKind::Kimi);
        let approval = request_command_approval(&store, &binding, "request-not-a-question");

        let error = store
            .prepare_question_response(binding.task_id, &approval.id, "allow")
            .expect_err("a command-execution approval has no options to select");
        assert!(matches!(error, IntegratorError::InvalidInput(_)));
    }

    #[test]
    fn reset_excludes_old_rows_and_restarts_first_seen_ordering() {
        let (store, binding) = bound_store(ProviderKind::Codex);
        let at = Utc::now();
        store
            .apply_reduced_event(&binding, &append_message("old-only", "old", at, at))
            .expect("persist old-only item");
        store
            .apply_reduced_event(
                &binding,
                &append_message(
                    "reused",
                    "before reset",
                    at,
                    at + chrono::Duration::milliseconds(1),
                ),
            )
            .expect("persist reused item");
        let reset_at = at + chrono::Duration::milliseconds(2);
        let reset = persist_reset(&store, &binding, reset_at);
        let after_at = at + chrono::Duration::milliseconds(3);
        let reused = store
            .apply_reduced_event(
                &binding,
                &append_message("reused", " after reset", after_at, after_at),
            )
            .expect("persist post-reset item");

        let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
        assert_eq!(snapshot.reset_seq, reset.seq);
        let hydrate = snapshot.hydrate.expect("hydrate");
        assert_eq!(hydrate.items.len(), 1);
        assert_eq!(hydrate.items[0].body.as_deref(), Some(" after reset"));
        assert_eq!(
            hydrate.first_seen.get(&hydrate.items[0].id),
            Some(&after_at)
        );
        assert_eq!(hydrate.before_seq, Some(reused.seq));
    }

    #[test]
    fn duplicate_deltas_are_audited_and_current_rows_follow_latest_seq_order() {
        let (store, binding) = bound_store(ProviderKind::Codex);
        let at = Utc::now();
        store
            .apply_reduced_event(&binding, &append_message("a", "same", at, at))
            .expect("persist first delta");
        let b = store
            .apply_reduced_event(
                &binding,
                &append_message("b", "middle", at, at + chrono::Duration::milliseconds(1)),
            )
            .expect("persist second item");
        let a_latest = store
            .apply_reduced_event(
                &binding,
                &append_message("a", "same", at, at + chrono::Duration::milliseconds(2)),
            )
            .expect("persist duplicate delta");

        let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
        let hydrate = snapshot.hydrate.expect("hydrate");
        assert_eq!(hydrate.items.len(), 2);
        // Ascending last_event_seq: b then a_latest.
        assert_eq!(hydrate.items[0].provider_item_id, "b");
        assert_eq!(hydrate.items[1].provider_item_id, "a");
        assert_eq!(hydrate.items[1].body.as_deref(), Some("samesame"));
        assert_eq!(hydrate.first_seen.get(&hydrate.items[1].id), Some(&at));
        assert_eq!(hydrate.before_seq, Some(b.seq));
        assert_eq!(snapshot.watermark_seq, a_latest.seq);
        let connection = store.connection.lock();
        let audit_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM codex_event_log WHERE task_id=?1",
                [binding.task_id.to_string()],
                |row| row.get(0),
            )
            .expect("audit count");
        assert_eq!(audit_count, 3);
    }

    #[test]
    fn stale_turn_settlement_survives_snapshot_restart() {
        let directory = tempfile::tempdir().expect("temp directory");
        let database = directory.path().join("projection.sqlite3");
        let store = LocalStore::open(&database).expect("open store");
        let task = store
            .create_task(NewTask {
                title: "Restart fixture".into(),
                repository_path: None,
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create task");
        let binding = store
            .create_runtime_binding(task.id, "restart-process", ProviderKind::Codex)
            .and_then(|binding| store.attach_provider_thread(&binding, "restart-thread"))
            .expect("attach runtime");
        let at = Utc::now();
        store
            .apply_reduced_event(
                &binding,
                &ReducedProviderEvent {
                    method: "turn/started".into(),
                    thread_id: "restart-thread".into(),
                    turn_id: Some("restart-turn".into()),
                    audit_json: "{}".into(),
                    audit_truncated: false,
                    mutation: ProjectionMutation::Turn(TurnProjection {
                        id: "restart-turn".into(),
                        status: TurnStatus::InProgress,
                        stop_requested: false,
                        error: None,
                        started_at: Some(at),
                        completed_at: None,
                    }),
                    occurred_at: at,
                },
            )
            .expect("persist running turn");
        let settled = store
            .settle_interrupted_turn(task.id)
            .expect("settle stale turn")
            .expect("settlement event");
        drop(store);

        let reopened = LocalStore::open(&database).expect("reopen store");
        let snapshot = reopened.task_snapshot(task.id).expect("load snapshot");
        assert_eq!(snapshot.watermark_seq, settled.seq);
        let hydrate = snapshot.hydrate.expect("hydrate");
        assert!(matches!(
            hydrate.turn.as_ref(),
            Some(TurnProjection {
                status: TurnStatus::Interrupted,
                stop_requested: false,
                ..
            })
        ));
        assert!(matches!(
            settled.projection,
            RuntimeProjection::TurnChanged {
                turn: TurnProjection {
                    status: TurnStatus::Interrupted,
                    stop_requested: false,
                    ..
                }
            }
        ));
        assert_eq!(redundant_event_projection_count(&reopened, task.id), 0);
    }

    #[test]
    fn startup_settlement_reconciles_every_unfinished_chat_once() {
        let store = LocalStore::open_in_memory().expect("open store");
        let mut task_ids = Vec::new();
        for index in 0..2 {
            let task = store
                .create_task(NewTask {
                    title: format!("Restart fixture {index}"),
                    repository_path: None,
                    worktree_path: None,
                    runtime: None,
                    model: None,
                    effort: None,
                    parent_task_id: None,
                })
                .expect("create task");
            let thread_id = format!("restart-thread-{index}");
            let turn_id = format!("restart-turn-{index}");
            let binding = store
                .create_runtime_binding(
                    task.id,
                    &format!("restart-process-{index}"),
                    ProviderKind::Codex,
                )
                .and_then(|binding| store.attach_provider_thread(&binding, &thread_id))
                .expect("attach runtime");
            let at = Utc::now();
            store
                .apply_reduced_event(
                    &binding,
                    &ReducedProviderEvent {
                        method: "turn/started".into(),
                        thread_id,
                        turn_id: Some(turn_id.clone()),
                        audit_json: "{}".into(),
                        audit_truncated: false,
                        mutation: ProjectionMutation::Turn(TurnProjection {
                            id: turn_id,
                            status: TurnStatus::InProgress,
                            stop_requested: false,
                            error: None,
                            started_at: Some(at),
                            completed_at: None,
                        }),
                        occurred_at: at,
                    },
                )
                .expect("persist running turn");
            task_ids.push(task.id);
        }

        for task_id in &task_ids {
            assert!(
                store
                    .task_has_unfinished_turn(*task_id)
                    .expect("unfinished turn before startup settlement")
            );
        }

        assert_eq!(
            store
                .settle_unfinished_turns_after_restart()
                .expect("settle startup turns"),
            2
        );
        assert_eq!(
            store
                .settle_unfinished_turns_after_restart()
                .expect("idempotent startup settlement"),
            0
        );
        for task_id in task_ids {
            assert!(
                !store
                    .task_has_unfinished_turn(task_id)
                    .expect("no unfinished turn after startup settlement")
            );
            let snapshot = store.task_snapshot(task_id).expect("load settled task");
            assert!(matches!(
                snapshot.hydrate.expect("hydrate").turn.as_ref(),
                Some(TurnProjection {
                    status: TurnStatus::Interrupted,
                    stop_requested: false,
                    ..
                })
            ));
        }
    }

    #[test]
    fn task_tip_stop_requested_tracks_stop_latch() {
        let (store, binding) = bound_store(ProviderKind::Codex);
        let at = Utc::now();
        store
            .apply_reduced_event(
                &binding,
                &ReducedProviderEvent {
                    method: "turn/started".into(),
                    thread_id: binding.thread_id.clone().expect("thread"),
                    turn_id: Some("tip-turn".into()),
                    audit_json: "{}".into(),
                    audit_truncated: false,
                    mutation: ProjectionMutation::Turn(TurnProjection {
                        id: "tip-turn".into(),
                        status: TurnStatus::InProgress,
                        stop_requested: false,
                        error: None,
                        started_at: Some(at),
                        completed_at: None,
                    }),
                    occurred_at: at,
                },
            )
            .expect("persist running turn");
        assert!(
            !store
                .task_tip_stop_requested(binding.task_id)
                .expect("query before stop")
        );
        store.request_stop(binding.task_id).expect("request stop");
        assert!(
            store
                .task_tip_stop_requested(binding.task_id)
                .expect("query after stop")
        );
    }

    #[test]
    fn settle_interrupted_preserves_user_stop_request() {
        let (store, binding) = bound_store(ProviderKind::Cursor);
        let at = Utc::now();
        store
            .apply_reduced_event(
                &binding,
                &ReducedProviderEvent {
                    method: "client/acp/turnStarted".into(),
                    thread_id: "thread-fixture".into(),
                    turn_id: Some("stop-turn".into()),
                    audit_json: "{}".into(),
                    audit_truncated: false,
                    mutation: ProjectionMutation::Turn(TurnProjection {
                        id: "stop-turn".into(),
                        status: TurnStatus::InProgress,
                        stop_requested: false,
                        error: None,
                        started_at: Some(at),
                        completed_at: None,
                    }),
                    occurred_at: at,
                },
            )
            .expect("persist running turn");
        let stopped = store.request_stop(binding.task_id).expect("request stop");
        assert!(stopped.result.stop_requested);
        assert!(!stopped.result.settled);

        let settled = store
            .settle_interrupted_turn(binding.task_id)
            .expect("settle after stop")
            .expect("settlement event");
        assert!(matches!(
            settled.projection,
            RuntimeProjection::TurnChanged {
                turn: TurnProjection {
                    status: TurnStatus::Interrupted,
                    stop_requested: true,
                    ..
                }
            }
        ));
        let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
        assert!(matches!(
            snapshot.hydrate.expect("hydrate").turn.as_ref(),
            Some(TurnProjection {
                status: TurnStatus::Interrupted,
                stop_requested: true,
                ..
            })
        ));
    }

    #[test]
    fn settle_stopped_latches_stop_onto_already_interrupted_tip() {
        let (store, binding) = bound_store(ProviderKind::Cursor);
        let at = Utc::now();
        store
            .apply_reduced_event(
                &binding,
                &ReducedProviderEvent {
                    method: "client/acp/turnStarted".into(),
                    thread_id: "thread-fixture".into(),
                    turn_id: Some("raced-turn".into()),
                    audit_json: "{}".into(),
                    audit_truncated: false,
                    mutation: ProjectionMutation::Turn(TurnProjection {
                        id: "raced-turn".into(),
                        status: TurnStatus::InProgress,
                        stop_requested: false,
                        error: None,
                        started_at: Some(at),
                        completed_at: None,
                    }),
                    occurred_at: at,
                },
            )
            .expect("persist running turn");
        store
            .settle_interrupted_turn(binding.task_id)
            .expect("provider cancel settled first")
            .expect("interrupted event");

        let latched = store
            .settle_stopped_turn(binding.task_id)
            .expect("latch stop")
            .expect("stop event");
        assert!(matches!(
            latched.projection,
            RuntimeProjection::TurnChanged {
                turn: TurnProjection {
                    status: TurnStatus::Interrupted,
                    stop_requested: true,
                    ..
                }
            }
        ));
    }

    #[test]
    fn snapshot_watermark_and_reset_short_circuit_skips_hydrate() {
        let (store, binding) = bound_store(ProviderKind::Codex);
        let at = Utc::now();
        store
            .apply_reduced_event(&binding, &append_message("keep", "body", at, at))
            .expect("persist item");
        let full = store.task_snapshot(binding.task_id).expect("full hydrate");
        assert!(full.hydrate.is_some());
        assert!(!full.cache_matched);

        let matched = store
            .task_snapshot_with(
                binding.task_id,
                TaskSnapshotQuery {
                    known_watermark: Some(full.watermark_seq),
                    known_reset_seq: Some(full.reset_seq),
                    ..TaskSnapshotQuery::default()
                },
            )
            .expect("if-match hydrate");
        assert!(matched.cache_matched);
        assert!(matched.hydrate.is_none());
        assert_eq!(matched.watermark_seq, full.watermark_seq);
        assert_eq!(matched.reset_seq, full.reset_seq);

        // Watermark alone is insufficient after a projection reset.
        let reset = persist_reset(&store, &binding, at + chrono::Duration::milliseconds(1));
        store
            .apply_reduced_event(
                &binding,
                &append_message(
                    "after",
                    "new",
                    at + chrono::Duration::milliseconds(2),
                    at + chrono::Duration::milliseconds(2),
                ),
            )
            .expect("persist post-reset item");
        let stale_match = store
            .task_snapshot_with(
                binding.task_id,
                TaskSnapshotQuery {
                    known_watermark: Some(full.watermark_seq),
                    known_reset_seq: Some(full.reset_seq),
                    ..TaskSnapshotQuery::default()
                },
            )
            .expect("stale if-match after reset");
        assert!(!stale_match.cache_matched);
        assert_eq!(stale_match.reset_seq, reset.seq);
        assert_eq!(
            stale_match
                .hydrate
                .expect("full hydrate after reset mismatch")
                .items
                .len(),
            1
        );
    }

    #[test]
    fn snapshot_tail_window_reports_has_more_older_and_loads_prior_page() {
        let (store, binding) = bound_store(ProviderKind::Codex);
        let at = Utc::now();
        for index in 0..5 {
            store
                .apply_reduced_event(
                    &binding,
                    &append_message(
                        &format!("item-{index}"),
                        &format!("body-{index}"),
                        at + chrono::Duration::milliseconds(index),
                        at + chrono::Duration::milliseconds(index),
                    ),
                )
                .expect("persist item");
        }

        let tail = store
            .task_snapshot_with(
                binding.task_id,
                TaskSnapshotQuery {
                    limit: Some(2),
                    ..TaskSnapshotQuery::default()
                },
            )
            .expect("tail hydrate");
        let hydrate = tail.hydrate.expect("hydrate");
        assert_eq!(hydrate.items.len(), 2);
        assert!(hydrate.has_more_older);
        assert_eq!(
            hydrate
                .items
                .iter()
                .map(|item| item.provider_item_id.as_str())
                .collect::<Vec<_>>(),
            vec!["item-3", "item-4"]
        );
        let before_seq = hydrate.before_seq.expect("before_seq cursor");

        let older = store
            .task_snapshot_with(
                binding.task_id,
                TaskSnapshotQuery {
                    before_seq: Some(before_seq),
                    limit: Some(2),
                    ..TaskSnapshotQuery::default()
                },
            )
            .expect("older page");
        let older_hydrate = older.hydrate.expect("older hydrate");
        assert_eq!(older_hydrate.items.len(), 2);
        assert!(older_hydrate.has_more_older);
        assert_eq!(
            older_hydrate
                .items
                .iter()
                .map(|item| item.provider_item_id.as_str())
                .collect::<Vec<_>>(),
            vec!["item-1", "item-2"]
        );

        let oldest = store
            .task_snapshot_with(
                binding.task_id,
                TaskSnapshotQuery {
                    before_seq: older_hydrate.before_seq,
                    limit: Some(2),
                    ..TaskSnapshotQuery::default()
                },
            )
            .expect("oldest page");
        let oldest_hydrate = oldest.hydrate.expect("oldest hydrate");
        assert_eq!(oldest_hydrate.items.len(), 1);
        assert!(!oldest_hydrate.has_more_older);
        assert_eq!(oldest_hydrate.items[0].provider_item_id, "item-0");
    }

    #[test]
    fn snapshot_empty_task_returns_empty_compact_hydrate() {
        let (store, binding) = bound_store(ProviderKind::Codex);
        let snapshot = store.task_snapshot(binding.task_id).expect("empty hydrate");
        assert_eq!(snapshot.watermark_seq, 0);
        assert_eq!(snapshot.reset_seq, 0);
        assert!(!snapshot.cache_matched);
        let hydrate = snapshot.hydrate.expect("hydrate");
        assert!(hydrate.items.is_empty());
        assert!(hydrate.approvals.is_empty());
        assert!(!hydrate.has_more_older);
        assert!(hydrate.before_seq.is_none());
    }

    #[test]
    fn snapshot_does_not_parse_unmaterialized_adversarial_audit_rows() {
        let (store, binding) = bound_store(ProviderKind::Codex);
        let event = store
            .apply_reduced_event(
                &binding,
                &append_message("message", "safe", Utc::now(), Utc::now()),
            )
            .expect("persist item");
        let watermark = {
            let connection = store.connection.lock();
            connection
                .execute(
                    "INSERT INTO codex_event_log(task_id,provider_session_id,runtime_session_id,process_id,thread_id,turn_id,method,audit_json,audit_truncated,occurred_at,projection_json) VALUES (?1,?2,?3,?4,?5,NULL,'fixture/adversarial','not-json',1,?6,'{')",
                    params![
                        binding.task_id.to_string(),
                        binding.provider_session_id.expect("provider session").to_string(),
                        binding.runtime_session_id.to_string(),
                        binding.process_id,
                        binding.thread_id.as_deref().expect("thread"),
                        Utc::now().to_rfc3339()
                    ],
                )
                .expect("insert adversarial audit row");
            connection.last_insert_rowid()
        };
        let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
        assert_eq!(snapshot.watermark_seq, watermark);
        let hydrate = snapshot.hydrate.expect("hydrate");
        assert_eq!(hydrate.items.len(), 1);
        let RuntimeProjection::ItemChanged { item } = event.projection else {
            panic!("expected item event");
        };
        assert_eq!(hydrate.items[0].id, item.id);
        assert_eq!(
            redundant_event_projection_count(&store, binding.task_id),
            1,
            "only the deliberately malformed legacy fixture carries projection_json"
        );
    }

    #[test]
    fn stop_request_is_state_idempotent_for_acp_sessions() {
        let (store, binding) = bound_store(ProviderKind::Cursor);
        let occurred_at = Utc::now();
        store
            .apply_reduced_event(
                &binding,
                &ReducedProviderEvent {
                    method: "client/acp/turnStarted".into(),
                    thread_id: "thread-fixture".into(),
                    turn_id: Some("turn-1".into()),
                    audit_json: "{}".into(),
                    audit_truncated: false,
                    mutation: ProjectionMutation::Turn(TurnProjection {
                        id: "turn-1".into(),
                        status: TurnStatus::InProgress,
                        stop_requested: false,
                        error: None,
                        started_at: Some(occurred_at),
                        completed_at: None,
                    }),
                    occurred_at,
                },
            )
            .expect("persist turn");
        let first = store.request_stop(binding.task_id).expect("first stop");
        let second = store.request_stop(binding.task_id).expect("second stop");
        assert!(!first.result.already_requested);
        assert!(second.result.already_requested);
        assert_eq!(second.event.expect("stop event").provider, "cursor");
        assert_eq!(redundant_event_projection_count(&store, binding.task_id), 0);
    }

    fn persist_item(
        store: &LocalStore,
        binding: &RuntimeBinding,
        turn_id: &str,
        item: ItemProjection,
    ) {
        let occurred_at = item.updated_at;
        store
            .apply_reduced_event(
                binding,
                &ReducedProviderEvent {
                    method: "item/completed".into(),
                    thread_id: binding.thread_id.clone().unwrap_or_default(),
                    turn_id: Some(turn_id.into()),
                    audit_json: "{}".into(),
                    audit_truncated: false,
                    mutation: ProjectionMutation::ReplaceItem(item),
                    occurred_at,
                },
            )
            .expect("persist handoff fixture item");
    }

    fn base_item(id: &str, kind: ItemKind, turn_offset_secs: i64) -> ItemProjection {
        let updated_at = Utc::now() + chrono::Duration::seconds(turn_offset_secs);
        ItemProjection {
            id: format!("fixture:{id}"),
            provider_item_id: id.into(),
            kind,
            status: ItemStatus::Completed,
            title: None,
            body: None,
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
            updated_at,
        }
    }

    #[test]
    fn handoff_digest_happy_packs_read_meat_and_chat() {
        let (store, binding) = bound_store(ProviderKind::Claude);
        let mut user = base_item("u1", ItemKind::UserMessage, 1);
        user.body = Some("fix the overflow menu".into());
        persist_item(&store, &binding, "turn-1", user);

        let mut read = base_item("r1", ItemKind::McpTool, 2);
        read.title = Some("Read".into());
        read.mcp_tool = Some("Read".into());
        read.tool_input = Some(r#"{"path":"apps/desktop/src/components/TaskSidebar.tsx"}"#.into());
        read.output = Some("export function TaskSidebar() {\n  return null;\n}".into());
        persist_item(&store, &binding, "turn-1", read);

        let mut assistant = base_item("a1", ItemKind::AgentMessage, 3);
        assistant.body = Some("Menus are right-anchored so they open left.".into());
        persist_item(&store, &binding, "turn-1", assistant);

        let digest = store
            .task_handoff_digest(binding.task_id, HandoffDigestOptions::default())
            .expect("digest")
            .expect("present");
        assert!(digest.text.contains("fix the overflow menu"));
        assert!(digest.text.contains("Read"));
        assert!(digest.text.contains("TaskSidebar"));
        assert!(digest.text.contains("right-anchored"));
        assert!(digest.image_paths.is_empty());
    }

    #[test]
    fn handoff_digest_degraded_drops_oldest_turns_and_stubs_web_search() {
        let (store, binding) = bound_store(ProviderKind::Codex);
        for index in 0..12 {
            let mut user = base_item(&format!("u{index}"), ItemKind::UserMessage, index * 3);
            user.body = Some(format!("turn-{index}-user-marker"));
            persist_item(&store, &binding, &format!("turn-{index}"), user);

            let mut search = base_item(&format!("s{index}"), ItemKind::McpTool, index * 3 + 1);
            search.mcp_tool = Some("WebSearch".into());
            search.title = Some("WebSearch".into());
            search.tool_input = Some(r#"{"query":"overflow menus"}"#.into());
            search.output = Some("x".repeat(20_000));
            persist_item(&store, &binding, &format!("turn-{index}"), search);

            let mut assistant =
                base_item(&format!("a{index}"), ItemKind::AgentMessage, index * 3 + 2);
            assistant.body = Some(format!("turn-{index}-assistant"));
            persist_item(&store, &binding, &format!("turn-{index}"), assistant);
        }

        let digest = store
            .task_handoff_digest(
                binding.task_id,
                HandoffDigestOptions {
                    max_turns: 10,
                    max_tokens: 50_000,
                    max_images: 4,
                },
            )
            .expect("digest")
            .expect("present");
        assert!(
            !digest.text.contains("turn-0-user-marker"),
            "oldest turn should drop: {}",
            digest.text
        );
        assert!(digest.text.contains("turn-11-user-marker"));
        assert!(digest.text.contains("chars truncated"));
        assert!(
            !digest.text.contains(&"x".repeat(500)),
            "web search body must not dump into the digest"
        );
    }

    #[test]
    fn handoff_digest_images_reattach_existing_and_note_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let existing = dir.path().join("shot.png");
        std::fs::write(&existing, [0x89, 0x50, 0x4E, 0x47]).expect("write png");
        let missing = dir.path().join("gone.png");

        let (store, binding) = bound_store(ProviderKind::Cursor);
        let mut user = base_item("u-img", ItemKind::UserMessage, 1);
        user.body = Some(format!(
            "what is this?\n\nAttached files:\n- {}\n- {}",
            existing.display(),
            missing.display()
        ));
        persist_item(&store, &binding, "turn-img", user);

        let digest = store
            .task_handoff_digest(binding.task_id, HandoffDigestOptions::default())
            .expect("digest")
            .expect("present");
        assert_eq!(digest.image_paths, vec![existing]);
        assert!(digest.text.contains("missing on disk"));
        assert!(digest.text.contains("gone.png"));
    }

    #[test]
    fn handoff_digest_adversarial_truncates_huge_command_dumps() {
        let (store, binding) = bound_store(ProviderKind::Antigravity);
        let mut command = base_item("cmd", ItemKind::CommandExecution, 1);
        command.command = Some("cat /dev/urandom | head -c 50000".into());
        command.exit_code = Some(0);
        command.output = Some("\u{0000}".repeat(50_000));
        persist_item(&store, &binding, "turn-cmd", command);

        let digest = store
            .task_handoff_digest(binding.task_id, HandoffDigestOptions::default())
            .expect("digest")
            .expect("present");
        assert!(digest.text.contains("chars truncated"));
        assert!(digest.text.len() < 5_000);
    }

    #[test]
    fn handoff_digest_restart_rebuilds_from_sqlite() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("handoff.sqlite3");
        let task_id = {
            let store = LocalStore::open(&db).expect("open store");
            let (store_ref, binding) = {
                let task = store
                    .create_task(NewTask {
                        title: "Restart handoff".into(),
                        repository_path: None,
                        worktree_path: None,
                        runtime: None,
                        model: None,
                        effort: None,
                        parent_task_id: None,
                    })
                    .expect("task");
                let binding = store
                    .create_runtime_binding(task.id, "proc", ProviderKind::Grok)
                    .expect("binding");
                let binding = store
                    .attach_provider_thread(&binding, "thread-grok")
                    .expect("thread");
                (store, binding)
            };
            let mut user = base_item("u", ItemKind::UserMessage, 1);
            user.body = Some("survive restart marker".into());
            persist_item(&store_ref, &binding, "turn-1", user);
            binding.task_id
        };

        let reopened = LocalStore::open(&db).expect("reopen");
        let digest = reopened
            .task_handoff_digest(task_id, HandoffDigestOptions::default())
            .expect("digest")
            .expect("present");
        assert!(digest.text.contains("survive restart marker"));
    }

    #[test]
    fn handoff_digest_is_provider_neutral_across_mixed_history() {
        let store = LocalStore::open_in_memory().expect("open");
        let task = store
            .create_task(NewTask {
                title: "Mixed providers".into(),
                repository_path: None,
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("task");

        let claude = store
            .create_runtime_binding(task.id, "claude-proc", ProviderKind::Claude)
            .expect("claude binding");
        let claude = store
            .attach_provider_thread(&claude, "claude-thread")
            .expect("claude thread");
        let mut claude_user = base_item("cu", ItemKind::UserMessage, 1);
        claude_user.body = Some("claude said look at styles".into());
        persist_item(&store, &claude, "turn-claude", claude_user);

        let codex = store
            .create_runtime_binding(task.id, "codex-proc", ProviderKind::Codex)
            .expect("codex binding");
        let codex = store
            .attach_provider_thread(&codex, "codex-thread")
            .expect("codex thread");
        let mut codex_assistant = base_item("ca", ItemKind::AgentMessage, 2);
        codex_assistant.body = Some("codex found right: 3px".into());
        persist_item(&store, &codex, "turn-codex", codex_assistant);

        let digest = store
            .task_handoff_digest(task.id, HandoffDigestOptions::default())
            .expect("digest")
            .expect("present");
        assert!(digest.text.contains("claude said look at styles"));
        assert!(digest.text.contains("codex found right: 3px"));
    }
}
