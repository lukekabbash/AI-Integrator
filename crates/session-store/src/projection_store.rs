use integrator_core::{
    ApprovalProjection, ApprovalState, IntegratorError, ItemProjection, ItemStatus,
    ProviderSessionId, Result, RuntimeBinding, RuntimeProjection, RuntimeProjectionEvent,
    TransportRequestId, UsageProjection,
};
use integrator_runtime::{
    ItemTextField, ProjectionMutation, ReducedProviderEvent, redact_and_bound,
};
use rusqlite::{OptionalExtension, Transaction, params};

use super::{LocalStore, invalid_stored, parse_time, storage_error};

mod approval;
mod handoff;
mod lifecycle;
mod runtime;
mod snapshot;
mod transcript;
pub use approval::PreparedApprovalResponse;
pub use handoff::{
    HANDOFF_CHILD_MAX_TOKENS, HANDOFF_DEFAULT_MAX_IMAGES, HANDOFF_DEFAULT_MAX_TOKENS,
    HANDOFF_DEFAULT_MAX_TURNS, HandoffDigest, HandoffDigestOptions,
};
pub use lifecycle::PersistedStopRequest;
use lifecycle::settle_failed_turn;
#[cfg(test)]
use lifecycle::settle_stale_turn;

const RENDERER_CONTENT_LIMIT: usize = 480 * 1024;
const ITEM_BODY_LIMIT: usize = 2 * 1024 * 1024;
const COMMAND_OUTPUT_LIMIT: usize = 1024 * 1024;
const COMMAND_OUTPUT_HEAD: usize = 128 * 1024;

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
            let existing = transaction.query_row("SELECT stop_requested, started_at FROM integrator_turns WHERE provider_session_id=?1 AND turn_id=?2", params![provider_session_id.to_string(), turn.id], |row| Ok((row.get::<_, bool>(0)?, row.get::<_, Option<String>>(1)?))).optional().map_err(storage_error)?;
            let mut turn = turn.clone();
            if let Some((stop_requested, stored_started_at)) = existing {
                turn.stop_requested |= stop_requested;
                // A turn's start time is fixed when it begins. Settlement events
                // restate it — some providers send "now" — and must not move it,
                // or the settled turn's duration collapses to zero.
                if let Some(started) = stored_started_at
                    .as_deref()
                    .and_then(|value| parse_time(value).ok())
                {
                    turn.started_at = Some(
                        turn.started_at
                            .map_or(started, |incoming| incoming.min(started)),
                    );
                }
            }
            transaction.execute("INSERT INTO integrator_turns(provider_session_id,task_id,thread_id,turn_id,status,stop_requested,error,started_at,completed_at,projection_json,last_event_seq,first_event_seq,first_occurred_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,?12) ON CONFLICT(provider_session_id,turn_id) DO UPDATE SET status=excluded.status,stop_requested=excluded.stop_requested,error=excluded.error,started_at=excluded.started_at,completed_at=excluded.completed_at,projection_json=excluded.projection_json,last_event_seq=excluded.last_event_seq", params![provider_session_id.to_string(),binding.task_id.to_string(),thread_id,turn.id,turn.status.as_str(),turn.stop_requested,turn.error,turn.started_at.map(|v|v.to_rfc3339()),turn.completed_at.map(|v|v.to_rfc3339()),serde_json::to_string(&turn)?,seq,reduced.occurred_at.to_rfc3339()]).map_err(storage_error)?;
            transaction.execute("UPDATE integrator_task_projection SET current_turn_id=?1,last_event_seq=?2 WHERE task_id=?3", params![turn.id,seq,binding.task_id.to_string()]).map_err(storage_error)?;
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
            transaction.execute("UPDATE integrator_task_projection SET plan_json=?1,plan_truncated=?2,plan_seq=?3,last_event_seq=?3 WHERE task_id=?4",params![serde_json::to_string(steps)?,truncated,seq,binding.task_id.to_string()]).map_err(storage_error)?;
            Ok(RuntimeProjection::PlanChanged {
                steps: steps.clone(),
                truncated: *truncated,
            })
        }
        ProjectionMutation::Diff { diff, truncated } => {
            transaction.execute("UPDATE integrator_task_projection SET diff=?1,diff_truncated=?2,diff_seq=?3,last_event_seq=?3 WHERE task_id=?4",params![diff,truncated,seq,binding.task_id.to_string()]).map_err(storage_error)?;
            Ok(RuntimeProjection::DiffChanged {
                diff: diff.clone(),
                truncated: *truncated,
            })
        }
        ProjectionMutation::Usage(usage) => {
            transaction.execute("UPDATE integrator_task_projection SET usage_json=?1,usage_seq=?2,last_event_seq=?2 WHERE task_id=?3",params![serde_json::to_string(usage)?,seq,binding.task_id.to_string()]).map_err(storage_error)?;
            Ok(RuntimeProjection::UsageChanged {
                usage: usage.clone(),
            })
        }
        ProjectionMutation::UsageDelta(delta) => {
            let existing = transaction
                .query_row(
                    "SELECT usage_json FROM integrator_task_projection WHERE task_id=?1",
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
            transaction.execute("UPDATE integrator_task_projection SET usage_json=?1,usage_seq=?2,last_event_seq=?2 WHERE task_id=?3",params![serde_json::to_string(&usage)?,seq,binding.task_id.to_string()]).map_err(storage_error)?;
            Ok(RuntimeProjection::UsageChanged { usage })
        }
        ProjectionMutation::Mode(mode) => {
            transaction
                .execute(
                    "UPDATE integrator_task_projection SET last_event_seq=?1 WHERE task_id=?2",
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
            let existing=transaction.query_row("SELECT projection_json FROM integrator_approvals WHERE runtime_session_id=?1 AND request_kind=?2 AND request_value=?3 AND approval_kind=?4 AND COALESCE(approval_id,'')=COALESCE(?5,'') ORDER BY updated_at DESC LIMIT 1",params![binding.runtime_session_id.to_string(),request_kind,request_value,approval_kind.as_str(),approval_id],|row|row.get::<_,String>(0)).optional().map_err(storage_error)?;
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
            transaction.execute("INSERT INTO integrator_approvals(id,provider_session_id,runtime_session_id,task_id,process_id,thread_id,turn_id,item_id,approval_id,request_kind,request_value,approval_kind,state,decision,reason,command_text,cwd,file_changes_json,updated_at,projection_json,last_event_seq,first_event_seq,first_occurred_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'pending',NULL,?13,?14,?15,?16,?17,?18,?19,?19,?17) ON CONFLICT(id) DO UPDATE SET state='pending',reason=excluded.reason,command_text=excluded.command_text,cwd=excluded.cwd,file_changes_json=excluded.file_changes_json,updated_at=excluded.updated_at,projection_json=excluded.projection_json,last_event_seq=excluded.last_event_seq",params![approval.id,provider_session_id.to_string(),binding.runtime_session_id.to_string(),binding.task_id.to_string(),binding.process_id,thread_id,reduced.turn_id,item_id,approval_id,request_kind,request_value,approval_kind.as_str(),reason,command,cwd,file_changes_json,reduced.occurred_at.to_rfc3339(),serde_json::to_string(&approval)?,seq]).map_err(storage_error)?;
            Ok(RuntimeProjection::ApprovalChanged { approval })
        }
        ProjectionMutation::ApprovalResolved { request_id } => {
            let (kind, value) = request_id_parts(request_id);
            let json=transaction.query_row("SELECT projection_json FROM integrator_approvals WHERE runtime_session_id=?1 AND request_kind=?2 AND request_value=?3 ORDER BY updated_at DESC LIMIT 1",params![binding.runtime_session_id.to_string(),kind,value],|row|row.get::<_,String>(0)).optional().map_err(storage_error)?.ok_or_else(||IntegratorError::NotFound("resolved approval".into()))?;
            let mut approval: ApprovalProjection = serde_json::from_str(&json)?;
            approval.state = ApprovalState::Resolved;
            approval.updated_at = reduced.occurred_at;
            transaction.execute("UPDATE integrator_approvals SET state='resolved',updated_at=?1,projection_json=?2,last_event_seq=?3 WHERE id=?4",params![approval.updated_at.to_rfc3339(),serde_json::to_string(&approval)?,seq,approval.id]).map_err(storage_error)?;
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
            transaction.execute("UPDATE integrator_task_projection SET connection_state=?1,connection_reason=?2,process_id=?3,connection_seq=?4,last_event_seq=?4 WHERE task_id=?5",params![state.as_str(),reason,binding.process_id,seq,binding.task_id.to_string()]).map_err(storage_error)?;
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
                "SELECT i.first_event_seq,i.first_occurred_at,COALESCE(p.reset_seq,0) FROM integrator_items i JOIN integrator_task_projection p ON p.task_id=i.task_id WHERE i.provider_session_id=?1 AND i.stable_id=?2 ORDER BY i.last_event_seq DESC LIMIT 1",
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
                "UPDATE integrator_items SET first_event_seq=?1,first_occurred_at=?2,snapshot_event_json=?3 WHERE provider_session_id=?4 AND stable_id=?5",
                params![first_seq, first_at.to_rfc3339(), serde_json::to_string(&snapshot)?, provider_session_id, item.id],
            ).map_err(storage_error)?;
        }
        RuntimeProjection::ApprovalChanged { approval } => {
            let (first_seq, first_at, reset_seq) = transaction.query_row(
                "SELECT a.first_event_seq,a.first_occurred_at,COALESCE(p.reset_seq,0) FROM integrator_approvals a JOIN integrator_task_projection p ON p.task_id=a.task_id WHERE a.id=?1",
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
                "UPDATE integrator_approvals SET first_event_seq=?1,first_occurred_at=?2,snapshot_event_json=?3 WHERE id=?4",
                params![first_seq, first_at.to_rfc3339(), serde_json::to_string(&snapshot)?, approval.id],
            ).map_err(storage_error)?;
        }
        RuntimeProjection::TurnChanged { turn } => {
            let json = serde_json::to_string(&snapshot)?;
            transaction.execute(
                "UPDATE integrator_turns SET first_event_seq=CASE WHEN first_event_seq=0 THEN ?1 ELSE first_event_seq END,first_occurred_at=COALESCE(first_occurred_at,?2),snapshot_event_json=?3 WHERE provider_session_id=?4 AND turn_id=?5",
                params![event.seq, event.occurred_at.to_rfc3339(), json, provider_session_id, turn.id],
            ).map_err(storage_error)?;
            transaction.execute(
                "UPDATE integrator_task_projection SET turn_seq=?1,turn_event_json=?2 WHERE task_id=?3",
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
                    "DELETE FROM integrator_turns WHERE task_id=?1",
                    [task_id.as_str()],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "DELETE FROM integrator_items WHERE task_id=?1",
                    [task_id.as_str()],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "DELETE FROM integrator_approvals WHERE task_id=?1",
                    [task_id.as_str()],
                )
                .map_err(storage_error)?;
            transaction.execute(
                "UPDATE integrator_task_projection SET current_turn_id=NULL,plan_json=NULL,plan_truncated=0,plan_seq=0,plan_event_json=NULL,diff=NULL,diff_truncated=0,diff_seq=0,diff_event_json=NULL,usage_json=NULL,usage_seq=0,usage_event_json=NULL,turn_seq=0,turn_event_json=NULL,mode_seq=0,mode_event_json=NULL,error_seq=0,error_event_json=NULL,connection_seq=0,connection_event_json=NULL,reset_seq=?1,reset_event_json=?2,last_event_seq=?1 WHERE task_id=?3",
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
        "UPDATE integrator_task_projection SET {seq_column}=?1,{json_column}=?2 WHERE task_id=?3"
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
    transaction.execute("INSERT INTO integrator_task_projection(task_id,provider_session_id,thread_id,process_id,last_event_seq) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(task_id) DO UPDATE SET provider_session_id=excluded.provider_session_id,thread_id=excluded.thread_id,process_id=excluded.process_id,last_event_seq=excluded.last_event_seq",params![binding.task_id.to_string(),provider_session_id.to_string(),thread_id,binding.process_id,seq]).map_err(storage_error)?;
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
    transaction.execute("INSERT INTO integrator_items(provider_session_id,task_id,thread_id,turn_id,item_id,stable_id,kind,status,title,body,command_text,cwd,output,exit_code,file_changes_json,mcp_server,mcp_tool,truncated,updated_at,projection_json,last_event_seq,first_event_seq,first_occurred_at,native_skill) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?21,?22,?23) ON CONFLICT(provider_session_id,turn_id,item_id) DO UPDATE SET stable_id=excluded.stable_id,kind=excluded.kind,status=excluded.status,title=excluded.title,body=excluded.body,command_text=excluded.command_text,cwd=excluded.cwd,output=excluded.output,exit_code=excluded.exit_code,file_changes_json=excluded.file_changes_json,mcp_server=excluded.mcp_server,mcp_tool=excluded.mcp_tool,truncated=excluded.truncated,updated_at=excluded.updated_at,projection_json=excluded.projection_json,last_event_seq=excluded.last_event_seq,native_skill=excluded.native_skill",params![provider_session_id.to_string(),binding.task_id.to_string(),thread_id,reduced.turn_id,item.provider_item_id,item.id,item.kind.as_str(),item.status.as_str(),item.title,item.body,item.command,item.cwd,item.output,item.exit_code,item.file_changes.as_ref().map(serde_json::to_string).transpose()?,item.mcp_server,item.mcp_tool,item.truncated,item.updated_at.to_rfc3339(),serde_json::to_string(item)?,seq,reduced.occurred_at.to_rfc3339(),item.native_skill]).map_err(storage_error)?;
    Ok(())
}
fn load_item(
    transaction: &Transaction<'_>,
    provider_session_id: ProviderSessionId,
    turn_id: &str,
    item_id: &str,
) -> Result<Option<ItemProjection>> {
    transaction.query_row("SELECT projection_json FROM integrator_items WHERE provider_session_id=?1 AND turn_id=?2 AND item_id=?3",params![provider_session_id.to_string(),turn_id,item_id],|row|row.get::<_,String>(0)).optional().map_err(storage_error)?.map(|json|serde_json::from_str(&json).map_err(Into::into)).transpose()
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

#[cfg(test)]
mod tests;
