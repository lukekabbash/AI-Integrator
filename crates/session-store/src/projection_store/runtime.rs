use std::str::FromStr;

use chrono::Utc;
use integrator_core::{
    IntegratorError, ItemProjection, ProviderKind, ProviderSession, ProviderSessionId, Result,
    RuntimeBinding, RuntimeProjectionEvent, RuntimeSession, RuntimeSessionId, TaskId,
};
use integrator_runtime::ReducedProviderEvent;
use rusqlite::{OptionalExtension, params};

use crate::{LocalStore, invalid_stored, parse_time, storage_error};

use super::{
    apply_mutation, persist_snapshot_event, renderer_safe_projection, validate_identity,
    validate_runtime_binding,
};

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
                "SELECT i.turn_id FROM integrator_items i JOIN provider_sessions p ON p.id=i.provider_session_id WHERE i.task_id=?1 AND p.provider=?2 AND i.item_id=?3 ORDER BY i.last_event_seq DESC LIMIT 1",
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
                "SELECT projection_json FROM integrator_items
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
            "INSERT INTO integrator_event_log(task_id, provider_session_id, runtime_session_id, process_id, thread_id, turn_id, method, audit_json, audit_truncated, occurred_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
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
}
