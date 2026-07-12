use std::str::FromStr;

use chrono::Utc;
use integrator_core::{
    ApprovalDecision, ApprovalProjection, ApprovalState, IntegratorError, ItemProjection,
    ItemStatus, ProviderKind, ProviderSession, ProviderSessionId, Result, RuntimeBinding,
    RuntimeProjection, RuntimeProjectionEvent, RuntimeSession, RuntimeSessionId, StopRequestResult,
    TaskId, TaskSnapshot, TransportRequestId, TurnProjection, TurnStatus, UsageProjection,
};
use integrator_runtime::{
    ItemTextField, ProjectionMutation, ReducedProviderEvent, redact_and_bound,
};
use rusqlite::{OptionalExtension, Transaction, params};

use super::{LocalStore, invalid_stored, parse_time, storage_error};

const RENDERER_CONTENT_LIMIT: usize = 480 * 1024;
const ITEM_BODY_LIMIT: usize = 2 * 1024 * 1024;
const COMMAND_OUTPUT_LIMIT: usize = 1024 * 1024;
const COMMAND_OUTPUT_HEAD: usize = 128 * 1024;

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
        transaction
            .execute(
                "UPDATE codex_event_log SET projection_json = ?1 WHERE seq = ?2",
                params![serde_json::to_string(&event)?, seq],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(event)
    }

    pub fn task_snapshot(&self, task_id: TaskId) -> Result<TaskSnapshot> {
        let task = self.get_task(task_id)?;
        let connection = self.connection.lock();
        let watermark = connection
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM codex_event_log WHERE task_id = ?1",
                [task_id.to_string()],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)?;
        let mut statement = connection.prepare(
            "SELECT projection_json FROM codex_event_log WHERE task_id = ?1 AND projection_json IS NOT NULL AND seq <= ?2 ORDER BY seq",
        ).map_err(storage_error)?;
        let events = statement
            .query_map(params![task_id.to_string(), watermark], |row| {
                row.get::<_, String>(0)
            })
            .map_err(storage_error)?
            .map(|row| {
                Ok(serde_json::from_str::<RuntimeProjectionEvent>(
                    &row.map_err(storage_error)?,
                )?)
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(TaskSnapshot {
            task,
            events,
            watermark_seq: watermark,
        })
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
        transaction.execute("INSERT INTO codex_event_log(task_id, provider_session_id, runtime_session_id, process_id, thread_id, turn_id, method, audit_json, audit_truncated, occurred_at) VALUES (?1,?2,?3,?4,?5,?6,'client/approval/responding','{}',0,?7)", params![task_id.to_string(), row.4, row.5, row.3, row.6, row.7, approval.updated_at.to_rfc3339()]).map_err(storage_error)?;
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
        transaction.execute("UPDATE codex_approvals SET state='responding', decision=?1, updated_at=?2, last_event_seq=?3, projection_json=?4 WHERE id=?5", params![approval.decision.as_ref().map(ApprovalDecision::as_protocol_str), approval.updated_at.to_rfc3339(), seq, serde_json::to_string(&approval)?, approval_id]).map_err(storage_error)?;
        transaction
            .execute(
                "UPDATE codex_event_log SET projection_json=?1 WHERE seq=?2",
                params![serde_json::to_string(&event)?, seq],
            )
            .map_err(storage_error)?;
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
            let event = settle_stale_turn(&transaction, task_id)?;
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
            let event = settle_stale_turn(&transaction, task_id)?;
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
        transaction
            .execute(
                "UPDATE codex_event_log SET projection_json=?1 WHERE seq=?2",
                params![serde_json::to_string(&event)?, seq],
            )
            .map_err(storage_error)?;
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
        let event = settle_stale_turn(&transaction, task_id)?;
        transaction.commit().map_err(storage_error)?;
        Ok(event)
    }

    /// Render the task's persisted conversation (across all provider
    /// sessions) as a bounded plain-text digest, newest-biased. Used to hand
    /// context to a freshly created provider session so switching providers
    /// or losing a thread does not lose the conversation.
    pub fn task_conversation_digest(
        &self,
        task_id: TaskId,
        max_bytes: usize,
    ) -> Result<Option<String>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT kind, body, title FROM codex_items WHERE task_id = ?1 AND kind IN ('user_message', 'agent_message') AND body IS NOT NULL ORDER BY last_event_seq DESC LIMIT 40",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([task_id.to_string()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(storage_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        if rows.is_empty() {
            return Ok(None);
        }
        const MESSAGE_LIMIT: usize = 700;
        let mut lines = Vec::new();
        let mut used = 0_usize;
        for (kind, body, title) in rows {
            let text = body.or(title).unwrap_or_default();
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            let speaker = if kind == "user_message" {
                "User"
            } else {
                "Assistant"
            };
            let mut snippet = text.to_owned();
            if snippet.len() > MESSAGE_LIMIT {
                let mut boundary = MESSAGE_LIMIT;
                while !snippet.is_char_boundary(boundary) {
                    boundary -= 1;
                }
                snippet.truncate(boundary);
                snippet.push('…');
            }
            let line = format!("{speaker}: {snippet}");
            if used + line.len() > max_bytes {
                break;
            }
            used += line.len();
            lines.push(line);
        }
        if lines.is_empty() {
            return Ok(None);
        }
        lines.reverse();
        Ok(Some(lines.join("\n\n")))
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
        transaction
            .execute(
                "INSERT INTO codex_event_log(task_id,provider_session_id,runtime_session_id,process_id,thread_id,turn_id,method,audit_json,audit_truncated,occurred_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'{}',0,?8)",
                params![row.1, row.2, row.3, row.4, row.5, row.6, method, approval.updated_at.to_rfc3339()],
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
        transaction
            .execute(
                "UPDATE codex_approvals SET state=?1,updated_at=?2,projection_json=?3,last_event_seq=?4 WHERE id=?5",
                params![approval.state.as_str(), approval.updated_at.to_rfc3339(), serde_json::to_string(&approval)?, seq, approval_id],
            )
            .map_err(storage_error)?;
        transaction
            .execute(
                "UPDATE codex_event_log SET projection_json=?1 WHERE seq=?2",
                params![serde_json::to_string(&event)?, seq],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(event)
    }
}

/// Mark the newest unfinished turn for a task as interrupted and log the
/// settlement. Returns the projection event to broadcast, or None when the
/// task has no unfinished turn (or no session history to attribute it to).
fn settle_stale_turn(
    transaction: &Transaction<'_>,
    task_id: TaskId,
) -> Result<Option<RuntimeProjectionEvent>> {
    let row = transaction.query_row(
        "SELECT projection_json, provider_session_id, thread_id, turn_id FROM codex_turns WHERE task_id=?1 AND status IN ('pending','in_progress') ORDER BY last_event_seq DESC LIMIT 1",
        [task_id.to_string()],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
    ).optional().map_err(storage_error)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let mut turn: TurnProjection = serde_json::from_str(&row.0)?;
    let occurred_at = Utc::now();
    turn.status = TurnStatus::Interrupted;
    turn.stop_requested = true;
    turn.completed_at = Some(occurred_at);
    let inserted = transaction.execute(
        "INSERT INTO codex_event_log(task_id,provider_session_id,runtime_session_id,process_id,thread_id,turn_id,method,audit_json,audit_truncated,occurred_at) SELECT ?1,?2,id,COALESCE(process_id,'expired'),?3,?4,'client/turn/stopSettled','{}',0,?5 FROM runtime_sessions WHERE task_id=?1 AND provider_session_id=?2 ORDER BY started_at DESC LIMIT 1",
        params![task_id.to_string(), row.1, row.2, row.3, occurred_at.to_rfc3339()],
    ).map_err(storage_error)?;
    if inserted != 1 {
        return Ok(None);
    }
    let seq = transaction.last_insert_rowid();
    transaction.execute(
        "UPDATE codex_turns SET status='interrupted',stop_requested=1,completed_at=?1,projection_json=?2,last_event_seq=?3 WHERE provider_session_id=?4 AND turn_id=?5",
        params![occurred_at.to_rfc3339(), serde_json::to_string(&turn)?, seq, row.1, row.3],
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
    transaction
        .execute(
            "UPDATE codex_event_log SET projection_json=?1 WHERE seq=?2",
            params![serde_json::to_string(&event)?, seq],
        )
        .map_err(storage_error)?;
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
            transaction.execute("INSERT INTO codex_turns(provider_session_id,task_id,thread_id,turn_id,status,stop_requested,error,started_at,completed_at,projection_json,last_event_seq) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(provider_session_id,turn_id) DO UPDATE SET status=excluded.status,stop_requested=excluded.stop_requested,error=excluded.error,started_at=excluded.started_at,completed_at=excluded.completed_at,projection_json=excluded.projection_json,last_event_seq=excluded.last_event_seq", params![provider_session_id.to_string(),binding.task_id.to_string(),thread_id,turn.id,turn.status.as_str(),turn.stop_requested,turn.error,turn.started_at.map(|v|v.to_rfc3339()),turn.completed_at.map(|v|v.to_rfc3339()),serde_json::to_string(&turn)?,seq]).map_err(storage_error)?;
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
            if update.output.is_some() {
                item.output = update.output.clone();
            }
            if update.tool_input.is_some() {
                item.tool_input = update.tool_input.clone();
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
        ProjectionMutation::ApprovalRequested {
            request_id,
            approval_kind,
            item_id,
            approval_id,
            reason,
            command,
            cwd,
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
                    updated_at: reduced.occurred_at,
                }
            };
            approval.state = ApprovalState::Pending;
            approval.updated_at = reduced.occurred_at;
            let file_changes_json = approval
                .file_changes
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            transaction.execute("INSERT INTO codex_approvals(id,provider_session_id,runtime_session_id,task_id,process_id,thread_id,turn_id,item_id,approval_id,request_kind,request_value,approval_kind,state,decision,reason,command_text,cwd,file_changes_json,updated_at,projection_json,last_event_seq) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'pending',NULL,?13,?14,?15,?16,?17,?18,?19) ON CONFLICT(id) DO UPDATE SET state='pending',reason=excluded.reason,command_text=excluded.command_text,cwd=excluded.cwd,file_changes_json=excluded.file_changes_json,updated_at=excluded.updated_at,projection_json=excluded.projection_json,last_event_seq=excluded.last_event_seq",params![approval.id,provider_session_id.to_string(),binding.runtime_session_id.to_string(),binding.task_id.to_string(),binding.process_id,thread_id,reduced.turn_id,item_id,approval_id,request_kind,request_value,approval_kind.as_str(),reason,command,cwd,file_changes_json,reduced.occurred_at.to_rfc3339(),serde_json::to_string(&approval)?,seq]).map_err(storage_error)?;
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
        ProjectionMutation::TurnError { message, retryable } => Ok(RuntimeProjection::TurnError {
            message: message.clone(),
            retryable: *retryable,
        }),
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
    transaction.execute("INSERT INTO codex_items(provider_session_id,task_id,thread_id,turn_id,item_id,stable_id,kind,status,title,body,command_text,cwd,output,exit_code,file_changes_json,mcp_server,mcp_tool,truncated,updated_at,projection_json,last_event_seq) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21) ON CONFLICT(provider_session_id,turn_id,item_id) DO UPDATE SET stable_id=excluded.stable_id,kind=excluded.kind,status=excluded.status,title=excluded.title,body=excluded.body,command_text=excluded.command_text,cwd=excluded.cwd,output=excluded.output,exit_code=excluded.exit_code,file_changes_json=excluded.file_changes_json,mcp_server=excluded.mcp_server,mcp_tool=excluded.mcp_tool,truncated=excluded.truncated,updated_at=excluded.updated_at,projection_json=excluded.projection_json,last_event_seq=excluded.last_event_seq",params![provider_session_id.to_string(),binding.task_id.to_string(),thread_id,reduced.turn_id,item.provider_item_id,item.id,item.kind.as_str(),item.status.as_str(),item.title,item.body,item.command,item.cwd,item.output,item.exit_code,item.file_changes.as_ref().map(serde_json::to_string).transpose()?,item.mcp_server,item.mcp_tool,item.truncated,item.updated_at.to_rfc3339(),serde_json::to_string(item)?,seq]).map_err(storage_error)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use integrator_core::{NewTask, TurnStatus};

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
        assert_eq!(snapshot.events, vec![event]);
        assert_eq!(snapshot.events[0].provider, "codex");
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
    }
}
