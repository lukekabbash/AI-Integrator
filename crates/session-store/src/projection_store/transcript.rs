use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
};

use chrono::Utc;
use integrator_core::{
    IntegratorError, NewTask, ProviderSessionId, Result, Task, TaskId, TurnStatus,
};
use rusqlite::{OptionalExtension, params};

use crate::{LocalStore, build_task, insert_task_row, invalid_stored, storage_error};

impl LocalStore {
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
            kind: source.kind,
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
                         FROM integrator_items item
                         LEFT JOIN integrator_turns turn
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
            statement
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
                .map_err(storage_error)?
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
                    "INSERT INTO integrator_turns(provider_session_id, task_id, thread_id, turn_id, status, stop_requested, error, started_at, completed_at, projection_json, last_event_seq, first_event_seq, first_occurred_at, snapshot_event_json)
                     SELECT ?1, ?2, thread_id, turn_id, status, 0, error, started_at, completed_at, projection_json, last_event_seq, first_event_seq, first_occurred_at,
                            json_set(snapshot_event_json, '$.taskId', ?2, '$.providerSessionId', ?1)
                     FROM integrator_turns
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
                    "INSERT INTO integrator_items(provider_session_id, task_id, thread_id, turn_id, item_id, stable_id, kind, status, title, body, command_text, cwd, output, exit_code, file_changes_json, mcp_server, mcp_tool, truncated, updated_at, projection_json, last_event_seq, first_event_seq, first_occurred_at, snapshot_event_json, native_skill)
                     SELECT ?1, ?2, thread_id, turn_id, item_id, stable_id, kind, status, title, body, command_text, cwd, output, exit_code, file_changes_json, mcp_server, mcp_tool, truncated, updated_at, projection_json, last_event_seq, first_event_seq, first_occurred_at,
                            json_set(snapshot_event_json, '$.taskId', ?2, '$.providerSessionId', ?1)
                            , native_skill
                     FROM integrator_items item
                     WHERE item.provider_session_id = ?3
                       AND item.last_event_seq <= ?4
                       AND NOT EXISTS (
                           SELECT 1
                           FROM integrator_turns turn
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
                "SELECT provider_session_id, thread_id FROM integrator_task_projection WHERE task_id = ?1",
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
                    "INSERT INTO integrator_task_projection(task_id, provider_session_id, thread_id) VALUES (?1, ?2, ?3)",
                    params![fork.id.to_string(), new_session_id, thread_id],
                )
                .map_err(storage_error)?;
        }

        transaction.commit().map_err(storage_error)?;
        Ok(fork)
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
                "SELECT COUNT(*) FROM integrator_turns WHERE task_id = ?1 AND status IN (?2, ?3)",
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
                "SELECT last_event_seq FROM integrator_items WHERE task_id = ?1 AND stable_id = ?2 ORDER BY last_event_seq DESC LIMIT 1",
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
                    "SELECT body FROM integrator_items WHERE task_id = ?1 AND kind = 'agent_message' AND body IS NOT NULL AND last_event_seq > ?2 ORDER BY last_event_seq ASC LIMIT 40",
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
                "DELETE FROM integrator_items WHERE task_id = ?1 AND last_event_seq >= ?2",
                params![task_id.to_string(), cutoff],
            )
            .map_err(storage_error)?;
        transaction
            .execute(
                "DELETE FROM integrator_turns WHERE task_id = ?1 AND last_event_seq >= ?2",
                params![task_id.to_string(), cutoff],
            )
            .map_err(storage_error)?;
        transaction
            .execute(
                "DELETE FROM integrator_approvals WHERE task_id = ?1 AND last_event_seq >= ?2",
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
                "UPDATE integrator_task_projection SET current_turn_id=NULL, plan_json=NULL, plan_truncated=0, plan_seq=0, plan_event_json=NULL, diff=NULL, diff_truncated=0, diff_seq=0, diff_event_json=NULL, usage_json=NULL, usage_seq=0, usage_event_json=NULL, turn_seq=0, turn_event_json=NULL, mode_seq=0, mode_event_json=NULL, error_seq=0, error_event_json=NULL WHERE task_id=?1",
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
                "SELECT COALESCE(MAX(last_event_seq), 0) FROM integrator_items WHERE task_id = ?1",
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
                "SELECT last_event_seq, body FROM integrator_items WHERE task_id = ?1 AND kind = 'agent_message' AND body IS NOT NULL AND last_event_seq > ?2 ORDER BY last_event_seq ASC LIMIT 100",
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
                       snippet(integrator_items_fts, 0, '', '', ' ... ', 22)
                FROM integrator_items_fts
                WHERE integrator_items_fts MATCH ?1
                ORDER BY bm25(integrator_items_fts), rowid DESC
                LIMIT ?2
                "#
        } else {
            r#"
                SELECT integrator_items_fts.task_id,
                       snippet(integrator_items_fts, 0, '', '', ' ... ', 22)
                FROM integrator_items_fts
                INNER JOIN tasks ON tasks.id = integrator_items_fts.task_id
                WHERE integrator_items_fts MATCH ?1 AND tasks.archived = 0
                ORDER BY bm25(integrator_items_fts), integrator_items_fts.rowid DESC
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
