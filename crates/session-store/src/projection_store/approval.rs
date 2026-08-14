use std::str::FromStr;

use chrono::Utc;
use integrator_core::{
    ApprovalDecision, ApprovalKind, ApprovalProjection, ApprovalState, IntegratorError,
    ProviderSessionId, Result, RuntimeProjection, RuntimeProjectionEvent, TaskId,
    TransportRequestId,
};
use rusqlite::{OptionalExtension, params};

use crate::{LocalStore, invalid_stored, storage_error};

use super::{persist_snapshot_event, provider_for_session, request_id_from_parts};

#[derive(Debug)]
pub struct PreparedApprovalResponse {
    pub event: RuntimeProjectionEvent,
    pub request_id: TransportRequestId,
    pub process_id: String,
}

impl LocalStore {
    pub fn prepare_approval_response(
        &self,
        task_id: TaskId,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> Result<PreparedApprovalResponse> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let row = transaction.query_row(
            "SELECT projection_json, request_kind, request_value, process_id, provider_session_id, runtime_session_id, thread_id, turn_id FROM integrator_approvals WHERE id = ?1 AND task_id = ?2",
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
        transaction.execute("INSERT INTO integrator_event_log(task_id, provider_session_id, runtime_session_id, process_id, thread_id, turn_id, method, audit_json, audit_truncated, occurred_at) VALUES (?1,?2,?3,?4,?5,?6,'client/approval/responding',?7,0,?8)", params![task_id.to_string(), row.4, row.5, row.3, row.6, row.7, audit_json, approval.updated_at.to_rfc3339()]).map_err(storage_error)?;
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
        transaction.execute("UPDATE integrator_approvals SET state='responding', decision=?1, updated_at=?2, last_event_seq=?3, projection_json=?4 WHERE id=?5", params![approval.decision.as_ref().map(ApprovalDecision::as_protocol_str), approval.updated_at.to_rfc3339(), seq, serde_json::to_string(&approval)?, approval_id]).map_err(storage_error)?;
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
            "SELECT projection_json, request_kind, request_value, process_id, provider_session_id, runtime_session_id, thread_id, turn_id FROM integrator_approvals WHERE id = ?1 AND task_id = ?2",
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
        if !approval
            .options
            .iter()
            .any(|option| option.option_id == option_id)
        {
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
        transaction.execute("INSERT INTO integrator_event_log(task_id, provider_session_id, runtime_session_id, process_id, thread_id, turn_id, method, audit_json, audit_truncated, occurred_at) VALUES (?1,?2,?3,?4,?5,?6,'client/approval/responding',?7,0,?8)", params![task_id.to_string(), row.4, row.5, row.3, row.6, row.7, audit_json, approval.updated_at.to_rfc3339()]).map_err(storage_error)?;
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
        transaction.execute("UPDATE integrator_approvals SET state='responding', decision=?1, updated_at=?2, last_event_seq=?3, projection_json=?4 WHERE id=?5", params![approval.decision.as_ref().map(ApprovalDecision::as_protocol_str), approval.updated_at.to_rfc3339(), seq, serde_json::to_string(&approval)?, approval_id]).map_err(storage_error)?;
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

    pub fn expire_process_approvals(&self, process_id: &str) -> Result<usize> {
        let approval_ids = {
            let connection = self.connection.lock();
            let mut statement = connection
                .prepare("SELECT id FROM integrator_approvals WHERE process_id=?1 AND state IN ('pending','responding','response_failed')")
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
                "SELECT projection_json, task_id, provider_session_id, runtime_session_id, process_id, thread_id, turn_id, state FROM integrator_approvals WHERE id=?1",
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
                "INSERT INTO integrator_event_log(task_id,provider_session_id,runtime_session_id,process_id,thread_id,turn_id,method,audit_json,audit_truncated,occurred_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,?9)",
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
                "UPDATE integrator_approvals SET state=?1,updated_at=?2,projection_json=?3,last_event_seq=?4 WHERE id=?5",
                params![approval.state.as_str(), approval.updated_at.to_rfc3339(), serde_json::to_string(&approval)?, seq, approval_id],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(event)
    }
}
