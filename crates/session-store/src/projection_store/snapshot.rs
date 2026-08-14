use std::collections::BTreeMap;

use integrator_core::{
    Result, RuntimeProjection, RuntimeProjectionEvent, TASK_PROJECTION_HYDRATE_MAX_ITEMS,
    TASK_PROJECTION_HYDRATE_TAIL, TASK_PROJECTION_HYDRATE_TAIL_MESSAGES, TaskId,
    TaskProjectionConnectionHydrate, TaskProjectionDiffHydrate, TaskProjectionErrorHydrate,
    TaskProjectionHydrate, TaskSnapshot, TaskSnapshotQuery,
};
use rusqlite::{OptionalExtension, params};

use super::{LocalStore, storage_error};

/// Stops the message-anchored hydrate window from extending past the item
/// floor once the page already carries this much snapshot JSON. Only the
/// extension is budgeted: the first `TASK_PROJECTION_HYDRATE_TAIL` rows load
/// regardless, so worst-case cost never exceeds today's floor plus this.
const HYDRATE_WINDOW_BYTE_BUDGET: usize = 8 * 1024 * 1024;

impl LocalStore {
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
                    (SELECT COALESCE(MAX(seq), 0) FROM integrator_event_log WHERE task_id = ?1),
                    (SELECT COALESCE(MAX(last_event_seq), 0) FROM integrator_items WHERE task_id = ?1),
                    (SELECT COALESCE(MAX(last_event_seq), 0) FROM integrator_turns WHERE task_id = ?1)
                )",
                [&task_key],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)?;
        let reset_seq = connection
            .query_row(
                "SELECT COALESCE(reset_seq, 0) FROM integrator_task_projection WHERE task_id = ?1",
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

        // An explicit `limit` keeps plain item-count paging (tests/tools). The
        // default window is message-anchored: it extends past the item floor
        // until the page holds enough user/agent messages that a tool-heavy
        // chat still hydrates real conversation, bounded by a hard item cap
        // and a byte budget so the extension cost stays predictable.
        let (min_items, message_target, max_items) = match query.limit {
            Some(limit) => (limit.max(1), 0, limit.max(1)),
            None => (
                TASK_PROJECTION_HYDRATE_TAIL,
                TASK_PROJECTION_HYDRATE_TAIL_MESSAGES,
                TASK_PROJECTION_HYDRATE_MAX_ITEMS,
            ),
        };
        let before_seq = query.before_seq.unwrap_or(i64::MAX);

        let mut statement = connection
            .prepare(
                r#"
            SELECT last_event_seq, snapshot_event_json, kind FROM (
                SELECT last_event_seq, snapshot_event_json, kind FROM integrator_items
                    WHERE task_id = ?1
                      AND last_event_seq > ?2
                      AND last_event_seq <= ?3
                      AND last_event_seq < ?4
                      AND snapshot_event_json IS NOT NULL
                UNION ALL
                SELECT last_event_seq, snapshot_event_json, 'approval' AS kind FROM integrator_approvals
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
        let fetched_rows = statement
            .query_map(
                params![task_key, reset_seq, watermark, before_seq, max_items as i64],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .map_err(storage_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        drop(statement);
        let fetched = fetched_rows.len();
        let mut window_rows: Vec<(i64, String)> = Vec::with_capacity(fetched.min(min_items));
        let mut message_count = 0usize;
        let mut window_bytes = 0usize;
        for (seq, event_json, kind) in fetched_rows {
            if window_rows.len() >= min_items
                && (message_count >= message_target || window_bytes >= HYDRATE_WINDOW_BYTE_BUDGET)
            {
                break;
            }
            if kind == "user_message" || kind == "agent_message" {
                message_count += 1;
            }
            window_bytes += event_json.len();
            window_rows.push((seq, event_json));
        }
        let kept = window_rows.len();
        // Reverse to ascending last_event_seq so item/approval array order
        // matches the historical event-stream hydrate path.
        window_rows.reverse();

        let oldest_loaded = window_rows.first().map(|(seq, _)| *seq);
        let has_more_older = if kept < fetched {
            // The trim discarded fetched in-range rows, so older content
            // provably exists without another query.
            true
        } else {
            match oldest_loaded {
                Some(oldest) if fetched >= max_items => {
                    connection
                        .query_row(
                            "SELECT EXISTS(
                            SELECT 1 FROM integrator_items
                                WHERE task_id = ?1 AND last_event_seq > ?2 AND last_event_seq < ?3
                                  AND last_event_seq <= ?4 AND snapshot_event_json IS NOT NULL
                            UNION ALL
                            SELECT 1 FROM integrator_approvals
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
            }
        };

        let singleton_jsons = if older_page {
            Vec::new()
        } else {
            // Singletons always hydrate fully (tiny); reset itself is baked into
            // reset_seq rather than replaying a ProjectionReset wipe on the client.
            let mut singleton_statement = connection
                .prepare(
                    r#"
                WITH boundary AS (
                    SELECT COALESCE(reset_seq, 0) AS reset_seq
                    FROM integrator_task_projection WHERE task_id = ?1
                )
                SELECT seq, event_json FROM (
                    SELECT turn_seq AS seq, turn_event_json AS event_json FROM integrator_task_projection
                        WHERE task_id=?1 AND turn_seq > (SELECT reset_seq FROM boundary)
                    UNION ALL SELECT plan_seq, plan_event_json FROM integrator_task_projection
                        WHERE task_id=?1 AND plan_seq > (SELECT reset_seq FROM boundary)
                    UNION ALL SELECT diff_seq, diff_event_json FROM integrator_task_projection
                        WHERE task_id=?1 AND diff_seq > (SELECT reset_seq FROM boundary)
                    UNION ALL SELECT usage_seq, usage_event_json FROM integrator_task_projection
                        WHERE task_id=?1 AND usage_seq > (SELECT reset_seq FROM boundary)
                    UNION ALL SELECT mode_seq, mode_event_json FROM integrator_task_projection
                        WHERE task_id=?1 AND mode_seq > (SELECT reset_seq FROM boundary)
                    UNION ALL SELECT error_seq, error_event_json FROM integrator_task_projection
                        WHERE task_id=?1 AND error_seq > (SELECT reset_seq FROM boundary)
                    UNION ALL SELECT connection_seq, connection_event_json FROM integrator_task_projection
                        WHERE task_id=?1 AND connection_seq > (SELECT reset_seq FROM boundary)
                )
                WHERE event_json IS NOT NULL AND seq <= ?2
                ORDER BY seq
                "#,
                )
                .map_err(storage_error)?;
            singleton_statement
                .query_map(params![task_key, watermark], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(storage_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(storage_error)?
        };
        drop(connection);

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
}
