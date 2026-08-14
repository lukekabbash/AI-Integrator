use std::str::FromStr;

use chrono::{DateTime, Utc};
use integrator_core::{
    ProviderSessionId, Result, RuntimeProjection, RuntimeProjectionEvent, StopRequestResult,
    TaskId, TurnProjection, TurnStatus,
};
use rusqlite::{OptionalExtension, Transaction, params};

use crate::{LocalStore, invalid_stored, storage_error};

use super::{persist_snapshot_event, provider_for_session};

pub struct PersistedStopRequest {
    pub result: StopRequestResult,
    /// Absent when a dead session was settled without any turn left to update.
    pub event: Option<RuntimeProjectionEvent>,
}

impl LocalStore {
    /// True when the task tip was cancelled by Stop (user or orchestrator).
    /// Resume-from-interrupt must refuse these tips.
    pub fn task_tip_stop_requested(&self, task_id: TaskId) -> Result<bool> {
        let connection = self.connection.lock();
        let stop_requested = connection
            .query_row(
                "SELECT t.stop_requested FROM integrator_task_projection p JOIN integrator_turns t ON t.provider_session_id=p.provider_session_id AND t.turn_id=p.current_turn_id WHERE p.task_id=?1",
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
            "SELECT t.projection_json, p.provider_session_id, p.thread_id, p.current_turn_id FROM integrator_task_projection p JOIN integrator_turns t ON t.provider_session_id=p.provider_session_id AND t.turn_id=p.current_turn_id WHERE p.task_id=?1",
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
        let inserted = transaction.execute("INSERT INTO integrator_event_log(task_id,provider_session_id,runtime_session_id,process_id,thread_id,turn_id,method,audit_json,audit_truncated,occurred_at) SELECT ?1,?2,id,process_id,?3,?4,'client/turn/stopRequested','{}',0,?5 FROM runtime_sessions WHERE task_id=?1 AND provider_session_id=?2 AND process_id IS NOT NULL ORDER BY started_at DESC LIMIT 1", params![task_id.to_string(), row.1, row.2, row.3, occurred_at.to_rfc3339()]).map_err(storage_error)?;
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
        transaction.execute("UPDATE integrator_turns SET stop_requested=1,last_event_seq=?1,projection_json=?2 WHERE provider_session_id=?3 AND turn_id=?4", params![seq, serde_json::to_string(&turn)?, row.1, row.3]).map_err(storage_error)?;
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
                "SELECT projection_json FROM integrator_turns WHERE task_id=?1 AND status='interrupted' ORDER BY last_event_seq DESC LIMIT 1",
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
                "SELECT EXISTS(SELECT 1 FROM integrator_turns WHERE task_id=?1 AND status IN ('pending','in_progress'))",
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
                    "SELECT DISTINCT task_id FROM integrator_turns WHERE status IN ('pending','in_progress')",
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
pub(super) fn settle_failed_turn(
    transaction: &Transaction<'_>,
    task_id: TaskId,
    message: &str,
    occurred_at: DateTime<Utc>,
    seq: i64,
) -> Result<()> {
    let row = transaction
        .query_row(
            "SELECT projection_json, provider_session_id, turn_id FROM integrator_turns WHERE task_id=?1 AND status IN ('pending','in_progress') ORDER BY last_event_seq DESC LIMIT 1",
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
            "UPDATE integrator_turns SET status='failed',error=?1,completed_at=?2,projection_json=?3,last_event_seq=?4 WHERE provider_session_id=?5 AND turn_id=?6",
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
pub(super) fn settle_stale_turn(
    transaction: &Transaction<'_>,
    task_id: TaskId,
    stop_requested: bool,
) -> Result<Option<RuntimeProjectionEvent>> {
    let unfinished = transaction.query_row(
        "SELECT projection_json, provider_session_id, thread_id, turn_id FROM integrator_turns WHERE task_id=?1 AND status IN ('pending','in_progress') ORDER BY last_event_seq DESC LIMIT 1",
        [task_id.to_string()],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
    ).optional().map_err(storage_error)?;
    let row = if let Some(row) = unfinished {
        Some(row)
    } else if stop_requested {
        transaction
            .query_row(
                "SELECT projection_json, provider_session_id, thread_id, turn_id FROM integrator_turns WHERE task_id=?1 AND status='interrupted' AND stop_requested=0 ORDER BY last_event_seq DESC LIMIT 1",
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
        "INSERT INTO integrator_event_log(task_id,provider_session_id,runtime_session_id,process_id,thread_id,turn_id,method,audit_json,audit_truncated,occurred_at) SELECT ?1,?2,id,COALESCE(process_id,'expired'),?3,?4,?5,'{}',0,?6 FROM runtime_sessions WHERE task_id=?1 AND provider_session_id=?2 ORDER BY started_at DESC LIMIT 1",
        params![task_id.to_string(), row.1, row.2, row.3, method, occurred_at.to_rfc3339()],
    ).map_err(storage_error)?;
    if inserted != 1 {
        return Ok(None);
    }
    let seq = transaction.last_insert_rowid();
    transaction.execute(
        "UPDATE integrator_turns SET status='interrupted',stop_requested=?1,completed_at=?2,projection_json=?3,last_event_seq=?4 WHERE provider_session_id=?5 AND turn_id=?6",
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
