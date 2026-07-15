use std::str::FromStr;

use chrono::Utc;
use integrator_core::{
    Delegation, DelegationId, DelegationMessage, DelegationSender, DelegationStatus,
    IntegratorError, Result, TaskId,
};
use rusqlite::{OptionalExtension, params};

use super::{LocalStore, invalid_stored, parse_time, storage_error};

const BRIEF_LIMIT: usize = 64 * 1024;
const MESSAGE_LIMIT: usize = 32 * 1024;
const RESULT_LIMIT: usize = 256 * 1024;

pub struct NewDelegation {
    pub parent_task_id: TaskId,
    pub profile_id: String,
    pub profile_label: String,
    pub runtime: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub title: String,
    pub brief: String,
    pub status: DelegationStatus,
}

fn bounded(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let mut end = limit;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated]", &value[..end])
}

const DELEGATION_COLUMNS: &str = "id, parent_task_id, child_task_id, profile_id, profile_label, runtime, model, effort, title, brief, status, result, child_session_ref, created_at, updated_at";

impl LocalStore {
    pub fn create_delegation(&self, input: NewDelegation) -> Result<Delegation> {
        let title = input.title.trim();
        if title.is_empty() || title.chars().count() > 240 {
            return Err(IntegratorError::InvalidInput(
                "delegation title must contain 1 to 240 characters".into(),
            ));
        }
        self.get_task(input.parent_task_id)?;
        let now = Utc::now();
        let delegation = Delegation {
            id: DelegationId::new(),
            parent_task_id: input.parent_task_id,
            child_task_id: None,
            profile_id: input.profile_id,
            profile_label: input.profile_label,
            runtime: input.runtime,
            model: input.model,
            effort: input.effort,
            title: title.to_owned(),
            brief: bounded(input.brief.trim(), BRIEF_LIMIT),
            status: input.status,
            result: None,
            child_session_ref: None,
            created_at: now,
            updated_at: now,
        };
        self.connection
            .lock()
            .execute(
                "INSERT INTO delegations(id, parent_task_id, child_task_id, profile_id, profile_label, runtime, model, effort, title, brief, status, result, child_session_ref, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    delegation.id.to_string(),
                    delegation.parent_task_id.to_string(),
                    Option::<String>::None,
                    delegation.profile_id,
                    delegation.profile_label,
                    delegation.runtime,
                    delegation.model,
                    delegation.effort,
                    delegation.title,
                    delegation.brief,
                    delegation.status.as_str(),
                    Option::<String>::None,
                    Option::<String>::None,
                    delegation.created_at.to_rfc3339(),
                    delegation.updated_at.to_rfc3339(),
                ],
            )
            .map_err(storage_error)?;
        Ok(delegation)
    }

    pub fn get_delegation(&self, id: DelegationId) -> Result<Delegation> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(&format!(
                "SELECT {DELEGATION_COLUMNS} FROM delegations WHERE id = ?1"
            ))
            .map_err(storage_error)?;
        let row = statement
            .query_row([id.to_string()], parse_delegation_row)
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| IntegratorError::NotFound(format!("delegation {id}")))??;
        Ok(row)
    }

    pub fn list_delegations(&self, parent_task_id: TaskId) -> Result<Vec<Delegation>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(&format!(
                "SELECT {DELEGATION_COLUMNS} FROM delegations WHERE parent_task_id = ?1 ORDER BY created_at, id"
            ))
            .map_err(storage_error)?;
        let rows = statement
            .query_map([parent_task_id.to_string()], parse_delegation_row)
            .map_err(storage_error)?;
        rows.map(|row| row.map_err(storage_error)?).collect()
    }

    /// Replace a newly-created provisional delegation title while it still
    /// has the exact value supplied by the caller.
    pub fn compare_and_set_delegation_title(
        &self,
        id: DelegationId,
        expected_title: &str,
        title: &str,
    ) -> Result<Option<Delegation>> {
        let expected_title = expected_title.trim();
        let title = title.trim();
        if expected_title.is_empty()
            || expected_title.chars().count() > 240
            || title.is_empty()
            || title.chars().count() > 240
        {
            return Err(IntegratorError::InvalidInput(
                "delegation titles must contain 1 to 240 characters".into(),
            ));
        }
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE delegations SET title = ?1, updated_at = ?2 WHERE id = ?3 AND title = ?4",
                params![
                    title,
                    Utc::now().to_rfc3339(),
                    id.to_string(),
                    expected_title
                ],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            self.get_delegation(id)?;
            return Ok(None);
        }
        self.get_delegation(id).map(Some)
    }

    /// Count of delegations holding a concurrency slot for this parent.
    pub fn active_delegation_count(&self, parent_task_id: TaskId) -> Result<u32> {
        self.connection
            .lock()
            .query_row(
                "SELECT COUNT(*) FROM delegations WHERE parent_task_id = ?1 AND status IN ('starting', 'running', 'waiting')",
                [parent_task_id.to_string()],
                |row| row.get(0),
            )
            .map_err(storage_error)
    }

    pub fn update_delegation_status(
        &self,
        id: DelegationId,
        status: DelegationStatus,
    ) -> Result<Delegation> {
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE delegations SET status = ?1, updated_at = ?2 WHERE id = ?3",
                params![status.as_str(), Utc::now().to_rfc3339(), id.to_string()],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("delegation {id}")));
        }
        self.get_delegation(id)
    }

    pub fn attach_delegation_child(
        &self,
        id: DelegationId,
        child_task_id: TaskId,
    ) -> Result<Delegation> {
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE delegations SET child_task_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![
                    child_task_id.to_string(),
                    Utc::now().to_rfc3339(),
                    id.to_string()
                ],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("delegation {id}")));
        }
        self.get_delegation(id)
    }

    /// Atomically replace the broker-assigned fallback title on both sides of
    /// a delegation. Stale background naming can never overwrite a later
    /// title or leave the hidden child task and its rail row out of sync.
    pub fn compare_and_set_delegation_child_title(
        &self,
        id: DelegationId,
        child_task_id: TaskId,
        expected_delegation_title: &str,
        expected_task_title: &str,
        title: &str,
    ) -> Result<bool> {
        let expected_delegation_title = expected_delegation_title.trim();
        let expected_task_title = expected_task_title.trim();
        let title = title.trim();
        if expected_delegation_title.is_empty()
            || expected_delegation_title.chars().count() > 240
            || expected_task_title.is_empty()
            || expected_task_title.chars().count() > 240
            || title.is_empty()
            || title.chars().count() > 240
        {
            return Err(IntegratorError::InvalidInput(
                "delegation and task titles must contain 1 to 240 characters".into(),
            ));
        }
        self.get_delegation(id)?;
        self.get_task(child_task_id)?;

        let now = Utc::now().to_rfc3339();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let delegation_changed = transaction
            .execute(
                "UPDATE delegations SET title = ?1, updated_at = ?2 WHERE id = ?3 AND child_task_id = ?4 AND title = ?5",
                params![
                    title,
                    now,
                    id.to_string(),
                    child_task_id.to_string(),
                    expected_delegation_title
                ],
            )
            .map_err(storage_error)?;
        if delegation_changed != 1 {
            transaction.rollback().map_err(storage_error)?;
            return Ok(false);
        }
        let task_changed = transaction
            .execute(
                "UPDATE tasks SET title = ?1, updated_at = ?2 WHERE id = ?3 AND title = ?4",
                params![title, now, child_task_id.to_string(), expected_task_title],
            )
            .map_err(storage_error)?;
        if task_changed != 1 {
            transaction.rollback().map_err(storage_error)?;
            return Ok(false);
        }
        transaction.commit().map_err(storage_error)?;
        Ok(true)
    }

    pub fn set_delegation_session_ref(&self, id: DelegationId, session_ref: &str) -> Result<()> {
        self.connection
            .lock()
            .execute(
                "UPDATE delegations SET child_session_ref = ?1, updated_at = ?2 WHERE id = ?3",
                params![session_ref, Utc::now().to_rfc3339(), id.to_string()],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    /// Changes the route used by the delegation's next turn. A route change
    /// starts a fresh provider session while retaining the child task and its
    /// locally persisted transcript.
    pub fn update_delegation_routing(
        &self,
        id: DelegationId,
        runtime: &str,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<Delegation> {
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE delegations SET runtime = ?1, model = ?2, effort = ?3, child_session_ref = NULL, updated_at = ?4 WHERE id = ?5",
                params![runtime, model, effort, Utc::now().to_rfc3339(), id.to_string()],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("delegation {id}")));
        }
        self.get_delegation(id)
    }

    pub fn reopen_delegation(&self, id: DelegationId) -> Result<Delegation> {
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE delegations SET status = 'running', result = NULL, updated_at = ?1 WHERE id = ?2",
                params![Utc::now().to_rfc3339(), id.to_string()],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("delegation {id}")));
        }
        self.get_delegation(id)
    }

    pub fn set_delegation_result(
        &self,
        id: DelegationId,
        status: DelegationStatus,
        result: &str,
    ) -> Result<Delegation> {
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE delegations SET status = ?1, result = ?2, updated_at = ?3 WHERE id = ?4",
                params![
                    status.as_str(),
                    bounded(result, RESULT_LIMIT),
                    Utc::now().to_rfc3339(),
                    id.to_string()
                ],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("delegation {id}")));
        }
        self.get_delegation(id)
    }

    /// Complete a delegation and enqueue its deliverable for the orchestrator
    /// in one transaction. The next parent turn can receive the result without
    /// polling, while an earlier `delegation_status` call can acknowledge the
    /// same message.
    pub fn complete_delegation(&self, id: DelegationId, result: &str) -> Result<Delegation> {
        let result = result.trim();
        if result.is_empty() {
            return Err(IntegratorError::InvalidInput(
                "delegation result must not be empty".into(),
            ));
        }
        let now = Utc::now();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let current_status = transaction
            .query_row(
                "SELECT status FROM delegations WHERE id = ?1",
                [id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| IntegratorError::NotFound(format!("delegation {id}")))?;
        if current_status == DelegationStatus::Completed.as_str() {
            transaction.commit().map_err(storage_error)?;
            drop(connection);
            return self.get_delegation(id);
        }
        transaction
            .execute(
                "UPDATE delegations SET status = 'completed', result = ?1, updated_at = ?2 WHERE id = ?3",
                params![
                    bounded(result, RESULT_LIMIT),
                    now.to_rfc3339(),
                    id.to_string()
                ],
            )
            .map_err(storage_error)?;
        transaction
            .execute(
                "INSERT INTO delegation_messages(id, delegation_id, sender, body, created_at, delivered_at) VALUES (?1, ?2, 'child', ?3, ?4, NULL)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    id.to_string(),
                    bounded(result, MESSAGE_LIMIT),
                    now.to_rfc3339(),
                ],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        drop(connection);
        self.get_delegation(id)
    }

    pub fn add_delegation_message(
        &self,
        delegation_id: DelegationId,
        sender: DelegationSender,
        body: &str,
    ) -> Result<DelegationMessage> {
        let body = body.trim();
        if body.is_empty() {
            return Err(IntegratorError::InvalidInput(
                "delegation message must not be empty".into(),
            ));
        }
        self.get_delegation(delegation_id)?;
        let message = DelegationMessage {
            id: uuid::Uuid::new_v4().to_string(),
            delegation_id,
            sender,
            body: bounded(body, MESSAGE_LIMIT),
            created_at: Utc::now(),
            delivered_at: None,
        };
        self.connection
            .lock()
            .execute(
                "INSERT INTO delegation_messages(id, delegation_id, sender, body, created_at, delivered_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
                params![
                    message.id,
                    message.delegation_id.to_string(),
                    message.sender.as_str(),
                    message.body,
                    message.created_at.to_rfc3339(),
                ],
            )
            .map_err(storage_error)?;
        Ok(message)
    }

    /// Undelivered messages heading to the given side of the delegation
    /// (`to_child = true` returns orchestrator/user messages, else child
    /// messages). Delivery is marked separately once injection succeeds.
    pub fn undelivered_delegation_messages(
        &self,
        delegation_id: DelegationId,
        to_child: bool,
    ) -> Result<Vec<DelegationMessage>> {
        let connection = self.connection.lock();
        let filter = if to_child {
            "sender IN ('orchestrator', 'user')"
        } else {
            "sender = 'child'"
        };
        let mut statement = connection
            .prepare(&format!(
                "SELECT id, delegation_id, sender, body, created_at, delivered_at FROM delegation_messages WHERE delegation_id = ?1 AND delivered_at IS NULL AND {filter} ORDER BY created_at"
            ))
            .map_err(storage_error)?;
        let rows = statement
            .query_map([delegation_id.to_string()], parse_message_row)
            .map_err(storage_error)?;
        rows.map(|row| row.map_err(storage_error)?).collect()
    }

    pub fn mark_delegation_messages_delivered(&self, message_ids: &[String]) -> Result<()> {
        if message_ids.is_empty() {
            return Ok(());
        }
        let now = Utc::now().to_rfc3339();
        let connection = self.connection.lock();
        for id in message_ids {
            connection
                .execute(
                    "UPDATE delegation_messages SET delivered_at = ?1 WHERE id = ?2 AND delivered_at IS NULL",
                    params![now, id],
                )
                .map_err(storage_error)?;
        }
        Ok(())
    }

    /// Per-delegation count of child messages the orchestrator/user has not
    /// seen yet, for badge rendering.
    pub fn unread_child_message_counts(
        &self,
        parent_task_id: TaskId,
    ) -> Result<Vec<(DelegationId, u32)>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT delegations.id, COUNT(delegation_messages.id)
                 FROM delegations
                 JOIN delegation_messages ON delegation_messages.delegation_id = delegations.id
                 WHERE delegations.parent_task_id = ?1
                   AND delegation_messages.sender = 'child'
                   AND delegation_messages.delivered_at IS NULL
                 GROUP BY delegations.id",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([parent_task_id.to_string()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
            })
            .map_err(storage_error)?;
        rows.map(|row| {
            let (id, count) = row.map_err(storage_error)?;
            Ok((DelegationId::from_str(&id).map_err(invalid_stored)?, count))
        })
        .collect()
    }

    /// All undelivered child messages across every delegation of a parent
    /// task, oldest first, for the orchestrator-turn preamble.
    pub fn undelivered_child_messages_for_parent(
        &self,
        parent_task_id: TaskId,
    ) -> Result<Vec<(Delegation, DelegationMessage)>> {
        let delegations = self.list_delegations(parent_task_id)?;
        let mut result = Vec::new();
        for delegation in delegations {
            for message in self.undelivered_delegation_messages(delegation.id, false)? {
                result.push((delegation.clone(), message));
            }
        }
        result.sort_by_key(|entry| entry.1.created_at);
        Ok(result)
    }
}

type DelegationRow = (
    String,
    String,
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
);

fn parse_delegation_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<Delegation>> {
    let raw: DelegationRow = (
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
    );
    Ok(build_delegation(raw))
}

fn build_delegation(raw: DelegationRow) -> Result<Delegation> {
    let (
        id,
        parent,
        child,
        profile_id,
        profile_label,
        runtime,
        model,
        effort,
        title,
        brief,
        status,
        result,
        session_ref,
        created,
        updated,
    ) = raw;
    Ok(Delegation {
        id: DelegationId::from_str(&id).map_err(invalid_stored)?,
        parent_task_id: TaskId::from_str(&parent).map_err(invalid_stored)?,
        child_task_id: child
            .as_deref()
            .map(TaskId::from_str)
            .transpose()
            .map_err(invalid_stored)?,
        profile_id,
        profile_label,
        runtime,
        model,
        effort,
        title,
        brief,
        status: DelegationStatus::from_str(&status)?,
        result,
        child_session_ref: session_ref,
        created_at: parse_time(&created)?,
        updated_at: parse_time(&updated)?,
    })
}

fn parse_message_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<DelegationMessage>> {
    let id: String = row.get(0)?;
    let delegation: String = row.get(1)?;
    let sender: String = row.get(2)?;
    let body: String = row.get(3)?;
    let created: String = row.get(4)?;
    let delivered: Option<String> = row.get(5)?;
    Ok((|| {
        Ok(DelegationMessage {
            id,
            delegation_id: DelegationId::from_str(&delegation).map_err(invalid_stored)?,
            sender: DelegationSender::from_str(&sender)?,
            body,
            created_at: parse_time(&created)?,
            delivered_at: delivered.as_deref().map(parse_time).transpose()?,
        })
    })())
}

#[cfg(test)]
mod tests {
    use super::*;
    use integrator_core::NewTask;

    fn store_with_task() -> (LocalStore, TaskId) {
        let store = LocalStore::open_in_memory().expect("open store");
        let task = store
            .create_task(NewTask {
                title: "Parent".into(),
                repository_path: None,
                worktree_path: None,
                runtime: Some("claude".into()),
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create task");
        (store, task.id)
    }

    fn new_delegation(parent: TaskId) -> NewDelegation {
        NewDelegation {
            parent_task_id: parent,
            profile_id: "codex-cheap".into(),
            profile_label: "Codex (budget)".into(),
            runtime: "codex".into(),
            model: Some("gpt-5.6-codex".into()),
            effort: Some("low".into()),
            title: "Refactor tests".into(),
            brief: "Move helpers into a shared module".into(),
            status: DelegationStatus::Starting,
        }
    }

    #[test]
    fn delegation_round_trips_with_status_transitions() {
        let (store, parent) = store_with_task();
        let delegation = store
            .create_delegation(new_delegation(parent))
            .expect("create delegation");
        assert_eq!(delegation.status, DelegationStatus::Starting);
        assert_eq!(store.active_delegation_count(parent).expect("count"), 1);
        let delegation = store
            .compare_and_set_delegation_title(
                delegation.id,
                "Refactor tests",
                "Subagent 1 · Refactor tests",
            )
            .expect("apply ordinal title")
            .expect("provisional title still current");

        let child = store
            .create_task(NewTask {
                title: "Subagent: Refactor tests".into(),
                repository_path: None,
                worktree_path: None,
                runtime: Some("codex".into()),
                model: None,
                effort: None,
                parent_task_id: Some(parent),
            })
            .expect("child task");
        assert_eq!(child.parent_task_id, Some(parent));

        store
            .attach_delegation_child(delegation.id, child.id)
            .expect("attach child");
        assert!(
            store
                .compare_and_set_delegation_child_title(
                    delegation.id,
                    child.id,
                    "Subagent 1 · Refactor tests",
                    "Subagent: Refactor tests",
                    "Subagent 1 · Shared Test Helpers",
                )
                .expect("replace fallback title")
        );
        assert_eq!(
            store
                .get_delegation(delegation.id)
                .expect("renamed delegation")
                .title,
            "Subagent 1 · Shared Test Helpers"
        );
        assert_eq!(
            store.get_task(child.id).expect("renamed child task").title,
            "Subagent 1 · Shared Test Helpers"
        );
        assert!(
            !store
                .compare_and_set_delegation_child_title(
                    delegation.id,
                    child.id,
                    "Subagent 1 · Refactor tests",
                    "Subagent: Refactor tests",
                    "Subagent 1 · Stale Rename",
                )
                .expect("reject stale title")
        );
        let updated = store
            .complete_delegation(delegation.id, "done")
            .expect("complete delegation");
        assert_eq!(updated.child_task_id, Some(child.id));
        assert_eq!(updated.status, DelegationStatus::Completed);
        assert_eq!(updated.result.as_deref(), Some("done"));
        assert_eq!(store.active_delegation_count(parent).expect("count"), 0);
        let completion = store
            .undelivered_delegation_messages(delegation.id, false)
            .expect("completion message");
        assert_eq!(completion.len(), 1);
        assert_eq!(completion[0].body, "done");
        store
            .complete_delegation(delegation.id, "duplicate retry")
            .expect("idempotent completion retry");
        assert_eq!(
            store
                .undelivered_delegation_messages(delegation.id, false)
                .expect("one completion message")
                .len(),
            1
        );
        assert_eq!(
            store
                .get_delegation(delegation.id)
                .expect("original result preserved")
                .result
                .as_deref(),
            Some("done")
        );
    }

    #[test]
    fn message_queues_split_by_direction_and_mark_delivered() {
        let (store, parent) = store_with_task();
        let delegation = store
            .create_delegation(new_delegation(parent))
            .expect("create delegation");
        store
            .add_delegation_message(delegation.id, DelegationSender::Orchestrator, "focus on x")
            .expect("orchestrator message");
        store
            .add_delegation_message(delegation.id, DelegationSender::Child, "which branch?")
            .expect("child message");

        let to_child = store
            .undelivered_delegation_messages(delegation.id, true)
            .expect("to child");
        assert_eq!(to_child.len(), 1);
        assert_eq!(to_child[0].body, "focus on x");
        let to_orchestrator = store
            .undelivered_delegation_messages(delegation.id, false)
            .expect("to orchestrator");
        assert_eq!(to_orchestrator.len(), 1);

        let unread = store
            .unread_child_message_counts(parent)
            .expect("unread counts");
        assert_eq!(unread, vec![(delegation.id, 1)]);

        store
            .mark_delegation_messages_delivered(&[to_orchestrator[0].id.clone()])
            .expect("mark delivered");
        assert!(
            store
                .undelivered_delegation_messages(delegation.id, false)
                .expect("after delivery")
                .is_empty()
        );
    }

    #[test]
    fn completed_delegation_can_reroute_and_reopen_without_losing_identity() {
        let (store, parent) = store_with_task();
        let delegation = store
            .create_delegation(new_delegation(parent))
            .expect("create delegation");
        store
            .set_delegation_session_ref(delegation.id, "old-thread")
            .expect("session ref");
        store
            .set_delegation_result(delegation.id, DelegationStatus::Completed, "first result")
            .expect("complete");

        let rerouted = store
            .update_delegation_routing(
                delegation.id,
                "claude",
                Some("claude-fable-5"),
                Some("high"),
            )
            .expect("reroute");
        assert_eq!(rerouted.id, delegation.id);
        assert_eq!(rerouted.runtime, "claude");
        assert_eq!(rerouted.model.as_deref(), Some("claude-fable-5"));
        assert_eq!(rerouted.child_session_ref, None);

        let reopened = store.reopen_delegation(delegation.id).expect("reopen");
        assert_eq!(reopened.status, DelegationStatus::Running);
        assert_eq!(reopened.result, None);
    }
}
