use std::str::FromStr;

use chrono::{DateTime, Duration, Utc};
use integrator_core::{
    Automation, AutomationId, AutomationRoute, AutomationRun, AutomationRunId, AutomationRunStatus,
    AutomationSource, AutomationStatus, AutomationTarget, AutomationTrigger, IntegratorError,
    Result, TaskId,
};
use rusqlite::{OptionalExtension, Row, params};

use super::{LocalStore, invalid_stored, parse_time, storage_error};

const TITLE_LIMIT: usize = 240;
const PROMPT_LIMIT: usize = 64 * 1024;
const ITERATION_NOTE_LIMIT: usize = 4 * 1024;
const ERROR_LIMIT: usize = 8 * 1024;
const AUTOMATION_COLUMNS: &str = "id, task_id, title, prompt, target_json, trigger_json, route_json, source, recurrence_user_request, status, next_run_at, last_run_at, last_error, created_at, updated_at, iteration_notes, next_run_note";
const AUTOMATION_RUN_COLUMNS: &str =
    "id, automation_id, scheduled_for, status, dispatch_ref, error, claimed_at, finished_at";

pub struct NewAutomation {
    pub task_id: TaskId,
    pub title: String,
    pub prompt: String,
    pub target: AutomationTarget,
    pub trigger: AutomationTrigger,
    pub route: AutomationRoute,
    pub source: AutomationSource,
    pub recurrence_user_request: Option<String>,
    pub iteration_notes: bool,
}

pub struct UpdateAutomation {
    pub title: String,
    pub prompt: String,
    pub trigger: AutomationTrigger,
    pub route: AutomationRoute,
    pub recurrence_user_request: Option<String>,
    pub iteration_notes: bool,
}

impl LocalStore {
    pub fn create_automation(&self, input: NewAutomation) -> Result<Automation> {
        let title = input.title.trim();
        let prompt = input.prompt.trim();
        if title.is_empty() || title.chars().count() > TITLE_LIMIT {
            return Err(IntegratorError::InvalidInput(
                "automation title must contain 1 to 240 characters".into(),
            ));
        }
        if prompt.is_empty() || prompt.len() > PROMPT_LIMIT {
            return Err(IntegratorError::InvalidInput(
                "automation prompt must contain 1 to 65,536 bytes".into(),
            ));
        }
        validate_trigger(&input.trigger, input.recurrence_user_request.as_deref())?;
        validate_iteration_notes(&input.trigger, input.iteration_notes)?;
        validate_route(&input.route)?;
        self.get_task(input.task_id)?;
        if let AutomationTarget::Delegation { delegation_id } = input.target {
            let delegation = self.get_delegation(delegation_id)?;
            if delegation.parent_task_id != input.task_id {
                return Err(IntegratorError::Unauthorized(
                    "automation target belongs to another task".into(),
                ));
            }
        }
        if let AutomationTrigger::DelegationsSettled {
            ref delegation_ids, ..
        } = input.trigger
        {
            for delegation_id in delegation_ids {
                let delegation = self.get_delegation(*delegation_id)?;
                if delegation.parent_task_id != input.task_id {
                    return Err(IntegratorError::Unauthorized(
                        "automation trigger includes another task's subagent".into(),
                    ));
                }
            }
        }

        let now = Utc::now();
        let automation = Automation {
            id: AutomationId::new(),
            task_id: input.task_id,
            title: title.to_owned(),
            prompt: prompt.to_owned(),
            target: input.target,
            next_run_at: initial_next_run(&input.trigger),
            trigger: input.trigger,
            route: input.route,
            source: input.source,
            recurrence_user_request: input
                .recurrence_user_request
                .map(|value| bounded(value.trim(), 2_048)),
            iteration_notes: input.iteration_notes,
            next_run_note: None,
            status: AutomationStatus::Active,
            last_run_at: None,
            last_error: None,
            created_at: now,
            updated_at: now,
        };
        self.connection
            .lock()
            .execute(
                "INSERT INTO automations(id, task_id, title, prompt, target_json, trigger_json, route_json, source, recurrence_user_request, status, next_run_at, last_run_at, last_error, created_at, updated_at, iteration_notes, next_run_note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                params![
                    automation.id.to_string(),
                    automation.task_id.to_string(),
                    automation.title,
                    automation.prompt,
                    serde_json::to_string(&automation.target)?,
                    serde_json::to_string(&automation.trigger)?,
                    serde_json::to_string(&automation.route)?,
                    automation.source.as_str(),
                    automation.recurrence_user_request,
                    automation.status.as_str(),
                    automation.next_run_at.map(|value| value.to_rfc3339()),
                    Option::<String>::None,
                    Option::<String>::None,
                    automation.created_at.to_rfc3339(),
                    automation.updated_at.to_rfc3339(),
                    automation.iteration_notes,
                    Option::<String>::None,
                ],
            )
            .map_err(storage_error)?;
        Ok(automation)
    }

    pub fn update_automation(
        &self,
        id: AutomationId,
        input: UpdateAutomation,
    ) -> Result<Automation> {
        let title = input.title.trim();
        let prompt = input.prompt.trim();
        if title.is_empty() || title.chars().count() > TITLE_LIMIT {
            return Err(IntegratorError::InvalidInput(
                "automation title must contain 1 to 240 characters".into(),
            ));
        }
        if prompt.is_empty() || prompt.len() > PROMPT_LIMIT {
            return Err(IntegratorError::InvalidInput(
                "automation prompt must contain 1 to 65,536 bytes".into(),
            ));
        }
        validate_trigger(&input.trigger, input.recurrence_user_request.as_deref())?;
        validate_iteration_notes(&input.trigger, input.iteration_notes)?;
        validate_route(&input.route)?;
        let current = self.get_automation(id)?;
        if let AutomationTrigger::DelegationsSettled {
            ref delegation_ids, ..
        } = input.trigger
        {
            for delegation_id in delegation_ids {
                let delegation = self.get_delegation(*delegation_id)?;
                if delegation.parent_task_id != current.task_id {
                    return Err(IntegratorError::Unauthorized(
                        "automation trigger includes another task's subagent".into(),
                    ));
                }
            }
        }
        if !matches!(
            current.status,
            AutomationStatus::Active | AutomationStatus::Paused | AutomationStatus::NeedsAttention
        ) {
            return Err(IntegratorError::InvalidInput(
                "only active, paused, or attention-needed automations can be edited".into(),
            ));
        }
        let next_run_at = initial_next_run(&input.trigger);
        let status = if current.status == AutomationStatus::Paused {
            AutomationStatus::Paused
        } else {
            AutomationStatus::Active
        };
        let next_run_note = input
            .iteration_notes
            .then_some(current.next_run_note)
            .flatten();
        self.connection
            .lock()
            .execute(
                "UPDATE automations SET title = ?1, prompt = ?2, trigger_json = ?3, route_json = ?4, recurrence_user_request = ?5, status = ?6, next_run_at = ?7, last_error = NULL, updated_at = ?8, iteration_notes = ?9, next_run_note = ?10 WHERE id = ?11",
                params![
                    title,
                    prompt,
                    serde_json::to_string(&input.trigger)?,
                    serde_json::to_string(&input.route)?,
                    input
                        .recurrence_user_request
                        .map(|value| bounded(value.trim(), 2_048)),
                    status.as_str(),
                    next_run_at.map(|value| value.to_rfc3339()),
                    Utc::now().to_rfc3339(),
                    input.iteration_notes,
                    next_run_note,
                    id.to_string(),
                ],
            )
            .map_err(storage_error)?;
        self.get_automation(id)
    }

    pub fn get_automation(&self, id: AutomationId) -> Result<Automation> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(&format!(
                "SELECT {AUTOMATION_COLUMNS} FROM automations WHERE id = ?1"
            ))
            .map_err(storage_error)?;
        statement
            .query_row([id.to_string()], parse_automation_row)
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| IntegratorError::NotFound(format!("automation {id}")))?
    }

    pub fn list_automations(&self, task_id: Option<TaskId>) -> Result<Vec<Automation>> {
        let connection = self.connection.lock();
        let (sql, task): (String, Option<String>) = match task_id {
            Some(task_id) => (
                format!(
                    "SELECT {AUTOMATION_COLUMNS} FROM automations WHERE task_id = ?1 ORDER BY created_at DESC"
                ),
                Some(task_id.to_string()),
            ),
            None => (
                format!("SELECT {AUTOMATION_COLUMNS} FROM automations ORDER BY created_at DESC"),
                None,
            ),
        };
        let mut statement = connection.prepare(&sql).map_err(storage_error)?;
        let rows = if let Some(task) = task.as_deref() {
            statement
                .query_map([task], parse_automation_row)
                .map_err(storage_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(storage_error)?
        } else {
            statement
                .query_map([], parse_automation_row)
                .map_err(storage_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(storage_error)?
        };
        rows.into_iter().collect()
    }

    /// Active records are intentionally loaded as a small typed set. The host
    /// owns one wake timer and evaluates event-driven subagent conditions in
    /// Rust rather than polling SQL or provider processes.
    pub fn active_automations(&self) -> Result<Vec<Automation>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(&format!(
                "SELECT {AUTOMATION_COLUMNS} FROM automations WHERE status = 'active' ORDER BY next_run_at, created_at"
            ))
            .map_err(storage_error)?;
        statement
            .query_map([], parse_automation_row)
            .map_err(storage_error)?
            .map(|row| row.map_err(storage_error)?)
            .collect()
    }

    pub fn list_automation_runs(&self, automation_id: AutomationId) -> Result<Vec<AutomationRun>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(&format!(
                "SELECT {AUTOMATION_RUN_COLUMNS} FROM automation_runs WHERE automation_id = ?1 ORDER BY claimed_at DESC LIMIT 100"
            ))
            .map_err(storage_error)?;
        statement
            .query_map([automation_id.to_string()], parse_automation_run_row)
            .map_err(storage_error)?
            .map(|row| row.map_err(storage_error)?)
            .collect()
    }

    pub fn set_automation_paused(&self, id: AutomationId, paused: bool) -> Result<Automation> {
        let status = if paused { "paused" } else { "active" };
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE automations SET status = ?1, updated_at = ?2 WHERE id = ?3 AND status IN ('active', 'paused', 'needs-attention')",
                params![status, Utc::now().to_rfc3339(), id.to_string()],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::InvalidInput(
                "only active, paused, or attention-needed automations can change pause state"
                    .into(),
            ));
        }
        self.get_automation(id)
    }

    pub fn cancel_automation(&self, id: AutomationId) -> Result<Automation> {
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE automations SET status = 'cancelled', next_run_at = NULL, updated_at = ?1 WHERE id = ?2 AND status != 'cancelled'",
                params![Utc::now().to_rfc3339(), id.to_string()],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            self.get_automation(id)?;
        }
        self.get_automation(id)
    }

    pub fn leave_automation_iteration_note(
        &self,
        id: AutomationId,
        note: &str,
    ) -> Result<Automation> {
        let automation = self.get_automation(id)?;
        if !automation.iteration_notes || !automation.trigger.is_recurring() {
            return Err(IntegratorError::InvalidInput(
                "iteration notes are not enabled for this recurring task".into(),
            ));
        }
        if matches!(
            automation.status,
            AutomationStatus::Completed | AutomationStatus::Cancelled
        ) {
            return Err(IntegratorError::InvalidInput(
                "this recurring task can no longer accept iteration notes".into(),
            ));
        }
        let note = note.trim();
        if note.is_empty() {
            return Err(IntegratorError::InvalidInput(
                "iteration note must not be empty".into(),
            ));
        }
        self.connection
            .lock()
            .execute(
                "UPDATE automations SET next_run_note = ?1, updated_at = ?2 WHERE id = ?3",
                params![
                    bounded(note, ITERATION_NOTE_LIMIT),
                    Utc::now().to_rfc3339(),
                    id.to_string(),
                ],
            )
            .map_err(storage_error)?;
        self.get_automation(id)
    }

    pub fn run_automation_now(&self, id: AutomationId) -> Result<Automation> {
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE automations SET status = 'active', next_run_at = ?1, updated_at = ?1 WHERE id = ?2 AND status IN ('active', 'paused', 'needs-attention')",
                params![Utc::now().to_rfc3339(), id.to_string()],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::InvalidInput(
                "this automation cannot run again".into(),
            ));
        }
        self.get_automation(id)
    }

    /// Atomically claims one occurrence. Multiple renderer windows can never
    /// launch the same wakeup because only the host performs this transition.
    pub fn claim_automation(
        &self,
        id: AutomationId,
        scheduled_for: DateTime<Utc>,
    ) -> Result<Option<AutomationRun>> {
        let now = Utc::now();
        let run = AutomationRun {
            id: AutomationRunId::new(),
            automation_id: id,
            scheduled_for,
            status: AutomationRunStatus::Claimed,
            dispatch_ref: None,
            error: None,
            claimed_at: now,
            finished_at: None,
        };
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let changed = transaction
            .execute(
                "UPDATE automations SET status = 'running', last_run_at = ?1, last_error = NULL, updated_at = ?1 WHERE id = ?2 AND status = 'active'",
                params![now.to_rfc3339(), id.to_string()],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            transaction.commit().map_err(storage_error)?;
            return Ok(None);
        }
        transaction
            .execute(
                "INSERT INTO automation_runs(id, automation_id, scheduled_for, status, dispatch_ref, error, claimed_at, finished_at) VALUES (?1, ?2, ?3, 'claimed', NULL, NULL, ?4, NULL)",
                params![
                    run.id.to_string(),
                    run.automation_id.to_string(),
                    run.scheduled_for.to_rfc3339(),
                    run.claimed_at.to_rfc3339(),
                ],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(Some(run))
    }

    pub fn finish_automation_run(
        &self,
        run_id: AutomationRunId,
        dispatch_ref: Option<&str>,
        error: Option<&str>,
    ) -> Result<Automation> {
        let now = Utc::now();
        let (automation_id, scheduled_for) = {
            let connection = self.connection.lock();
            connection
                .query_row(
                    "SELECT automation_id, scheduled_for FROM automation_runs WHERE id = ?1 AND status = 'claimed'",
                    [run_id.to_string()],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(storage_error)?
                .ok_or_else(|| IntegratorError::NotFound(format!("claimable automation run {run_id}")))?
        };
        let automation_id = AutomationId::from_str(&automation_id).map_err(invalid_stored)?;
        let scheduled_for = parse_time(&scheduled_for).map_err(invalid_stored)?;
        let automation = self.get_automation(automation_id)?;
        let next_run = next_interval_run(&automation.trigger, scheduled_for, now);
        let failed = error.is_some();
        let next_status = if next_run.is_some() {
            AutomationStatus::Active
        } else if failed {
            AutomationStatus::NeedsAttention
        } else {
            AutomationStatus::Completed
        };
        let error = error.map(|value| bounded(value, ERROR_LIMIT));
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        transaction
            .execute(
                "UPDATE automation_runs SET status = ?1, dispatch_ref = ?2, error = ?3, finished_at = ?4 WHERE id = ?5 AND status = 'claimed'",
                params![
                    if failed { "failed" } else { "dispatched" },
                    dispatch_ref,
                    error,
                    now.to_rfc3339(),
                    run_id.to_string(),
                ],
            )
            .map_err(storage_error)?;
        transaction
            .execute(
                "UPDATE automations SET status = ?1, next_run_at = ?2, last_error = ?3, updated_at = ?4 WHERE id = ?5 AND status = 'running'",
                params![
                    next_status.as_str(),
                    next_run.map(|value| value.to_rfc3339()),
                    error,
                    now.to_rfc3339(),
                    automation_id.to_string(),
                ],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        drop(connection);
        self.get_automation(automation_id)
    }

    /// A crash after claim is intentionally not replayed automatically: doing
    /// so could duplicate a write that reached the provider before shutdown.
    pub fn mark_orphaned_automation_claims(&self) -> Result<usize> {
        let now = Utc::now().to_rfc3339();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let changed = transaction
            .execute(
                "UPDATE automations SET status = 'needs-attention', last_error = 'Integrator closed while this run was being dispatched', updated_at = ?1 WHERE status = 'running'",
                [&now],
            )
            .map_err(storage_error)?;
        transaction
            .execute(
                "UPDATE automation_runs SET status = 'failed', error = 'Integrator closed while this run was being dispatched', finished_at = ?1 WHERE status = 'claimed'",
                [&now],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(changed)
    }

    pub fn latest_user_message(&self, task_id: TaskId) -> Result<Option<String>> {
        self.connection
            .lock()
            .query_row(
                "SELECT body FROM integrator_items WHERE task_id = ?1 AND kind = 'user_message' AND body IS NOT NULL AND trim(body) != '' ORDER BY first_event_seq DESC, last_event_seq DESC LIMIT 1",
                [task_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)
    }
}

fn validate_trigger(trigger: &AutomationTrigger, recurrence_request: Option<&str>) -> Result<()> {
    match trigger {
        AutomationTrigger::At { .. } => {
            if recurrence_request.is_some() {
                return Err(IntegratorError::InvalidInput(
                    "one-shot automation cannot carry recurring authorization".into(),
                ));
            }
        }
        AutomationTrigger::Interval { every_seconds, .. } => {
            if !(60..=2_592_000).contains(every_seconds) {
                return Err(IntegratorError::InvalidInput(
                    "recurring interval must be between 60 seconds and 30 days".into(),
                ));
            }
            if recurrence_request.is_none_or(|request| request.trim().is_empty()) {
                return Err(IntegratorError::InvalidInput(
                    "recurring automation requires the user's explicit request".into(),
                ));
            }
        }
        AutomationTrigger::DelegationsSettled { delegation_ids, .. } => {
            if delegation_ids.is_empty() || delegation_ids.len() > 32 {
                return Err(IntegratorError::InvalidInput(
                    "subagent wakeup must watch between 1 and 32 delegations".into(),
                ));
            }
            if recurrence_request.is_some() {
                return Err(IntegratorError::InvalidInput(
                    "subagent-settled automation is one-shot".into(),
                ));
            }
        }
    }
    Ok(())
}

fn validate_iteration_notes(trigger: &AutomationTrigger, enabled: bool) -> Result<()> {
    if enabled && !trigger.is_recurring() {
        return Err(IntegratorError::InvalidInput(
            "iteration notes are available only for recurring tasks".into(),
        ));
    }
    Ok(())
}

fn validate_route(route: &AutomationRoute) -> Result<()> {
    if route.runtime.trim().is_empty() || route.model.trim().is_empty() {
        return Err(IntegratorError::InvalidInput(
            "automation route requires a runtime and model".into(),
        ));
    }
    if !matches!(
        route.permission.as_str(),
        "read-only" | "project-write" | "ask" | "full-access"
    ) {
        return Err(IntegratorError::InvalidInput(
            "unknown automation permission ceiling".into(),
        ));
    }
    if !matches!(
        route.delegation.as_str(),
        "off" | "manual" | "balanced" | "budget-first"
    ) {
        return Err(IntegratorError::InvalidInput(
            "unknown automation delegation policy".into(),
        ));
    }
    if route.fallbacks.len() > 4 {
        return Err(IntegratorError::InvalidInput(
            "automation route supports at most four fallbacks".into(),
        ));
    }
    if let Some(tools) = &route.tools {
        if tools.mcp_servers.len() + tools.skills.len() > 256 {
            return Err(IntegratorError::InvalidInput(
                "automation tool scope names too many tools".into(),
            ));
        }
        if tools
            .mcp_servers
            .iter()
            .chain(tools.skills.iter())
            .any(|name| name.trim().is_empty() || name.len() > 200)
        {
            return Err(IntegratorError::InvalidInput(
                "automation tool scope entries must be non-empty names".into(),
            ));
        }
    }
    if route
        .fallbacks
        .iter()
        .any(|fallback| fallback.runtime.trim().is_empty() || fallback.model.trim().is_empty())
    {
        return Err(IntegratorError::InvalidInput(
            "each automation fallback requires a runtime and model".into(),
        ));
    }
    Ok(())
}

fn initial_next_run(trigger: &AutomationTrigger) -> Option<DateTime<Utc>> {
    match trigger {
        AutomationTrigger::At { run_at } => Some(*run_at),
        AutomationTrigger::Interval { anchor_at, .. } => Some(*anchor_at),
        AutomationTrigger::DelegationsSettled { timeout_at, .. } => *timeout_at,
    }
}

fn next_interval_run(
    trigger: &AutomationTrigger,
    scheduled_for: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let AutomationTrigger::Interval {
        every_seconds,
        end_at,
        ..
    } = trigger
    else {
        return None;
    };
    let seconds = i64::try_from(*every_seconds).ok()?;
    let step = Duration::seconds(seconds);
    let mut next = scheduled_for.checked_add_signed(step)?;
    if next <= now {
        let behind = now.signed_duration_since(next).num_seconds();
        let jumps = behind.div_euclid(seconds) + 1;
        next = next.checked_add_signed(Duration::seconds(seconds.checked_mul(jumps)?))?;
    }
    end_at.is_none_or(|end| next <= end).then_some(next)
}

fn parse_automation_row(row: &Row<'_>) -> rusqlite::Result<Result<Automation>> {
    let id: String = row.get(0)?;
    let task_id: String = row.get(1)?;
    let target_json: String = row.get(4)?;
    let trigger_json: String = row.get(5)?;
    let route_json: String = row.get(6)?;
    let source: String = row.get(7)?;
    let status: String = row.get(9)?;
    let next_run_at: Option<String> = row.get(10)?;
    let last_run_at: Option<String> = row.get(11)?;
    let created_at: String = row.get(13)?;
    let updated_at: String = row.get(14)?;
    Ok((|| {
        Ok(Automation {
            id: AutomationId::from_str(&id).map_err(invalid_stored)?,
            task_id: TaskId::from_str(&task_id).map_err(invalid_stored)?,
            title: row.get(2).map_err(storage_error)?,
            prompt: row.get(3).map_err(storage_error)?,
            target: serde_json::from_str(&target_json)?,
            trigger: serde_json::from_str(&trigger_json)?,
            route: serde_json::from_str(&route_json)?,
            source: AutomationSource::from_str(&source)?,
            recurrence_user_request: row.get(8).map_err(storage_error)?,
            status: AutomationStatus::from_str(&status)?,
            next_run_at: next_run_at
                .as_deref()
                .map(parse_time)
                .transpose()
                .map_err(invalid_stored)?,
            last_run_at: last_run_at
                .as_deref()
                .map(parse_time)
                .transpose()
                .map_err(invalid_stored)?,
            last_error: row.get(12).map_err(storage_error)?,
            created_at: parse_time(&created_at).map_err(invalid_stored)?,
            updated_at: parse_time(&updated_at).map_err(invalid_stored)?,
            iteration_notes: row.get(15).map_err(storage_error)?,
            next_run_note: row.get(16).map_err(storage_error)?,
        })
    })())
}

fn parse_automation_run_row(row: &Row<'_>) -> rusqlite::Result<Result<AutomationRun>> {
    let id: String = row.get(0)?;
    let automation_id: String = row.get(1)?;
    let scheduled_for: String = row.get(2)?;
    let status: String = row.get(3)?;
    let claimed_at: String = row.get(6)?;
    let finished_at: Option<String> = row.get(7)?;
    Ok((|| {
        Ok(AutomationRun {
            id: AutomationRunId::from_str(&id).map_err(invalid_stored)?,
            automation_id: AutomationId::from_str(&automation_id).map_err(invalid_stored)?,
            scheduled_for: parse_time(&scheduled_for).map_err(invalid_stored)?,
            status: AutomationRunStatus::from_str(&status)?,
            dispatch_ref: row.get(4).map_err(storage_error)?,
            error: row.get(5).map_err(storage_error)?,
            claimed_at: parse_time(&claimed_at).map_err(invalid_stored)?,
            finished_at: finished_at
                .as_deref()
                .map(parse_time)
                .transpose()
                .map_err(invalid_stored)?,
        })
    })())
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

#[cfg(test)]
mod tests {
    use super::*;
    use integrator_core::{AutomationFallback, NewTask, TaskKind, TaskState};

    fn task(store: &LocalStore) -> TaskId {
        let task = store
            .create_task(NewTask {
                kind: TaskKind::Code,
                title: "Automation parent".into(),
                repository_path: None,
                worktree_path: None,
                runtime: Some("codex".into()),
                model: Some("gpt-5.6-sol".into()),
                effort: Some("medium".into()),
                parent_task_id: None,
            })
            .expect("create task");
        store
            .update_task_state(task.id, TaskState::Ready)
            .expect("ready task");
        task.id
    }

    fn route() -> AutomationRoute {
        AutomationRoute {
            runtime: "codex".into(),
            model: "gpt-5.6-sol".into(),
            effort: Some("medium".into()),
            fallbacks: Vec::new(),
            permission: "read-only".into(),
            delegation: "balanced".into(),
            tools: None,
        }
    }

    #[test]
    fn one_shot_claim_is_exactly_once_and_completes_after_dispatch() {
        let store = LocalStore::open_in_memory().expect("store");
        let task_id = task(&store);
        let run_at = Utc::now() + Duration::minutes(5);
        let automation = store
            .create_automation(NewAutomation {
                task_id,
                title: "Check again".into(),
                prompt: "Inspect the current result and continue.".into(),
                target: AutomationTarget::Task,
                trigger: AutomationTrigger::At { run_at },
                route: route(),
                source: AutomationSource::Agent,
                recurrence_user_request: None,
                iteration_notes: false,
            })
            .expect("automation");
        let run = store
            .claim_automation(automation.id, run_at)
            .expect("claim")
            .expect("won claim");
        assert!(
            store
                .claim_automation(automation.id, run_at)
                .expect("second claim")
                .is_none()
        );
        let completed = store
            .finish_automation_run(run.id, Some("turn-1"), None)
            .expect("finish");
        assert_eq!(completed.status, AutomationStatus::Completed);
        assert!(completed.next_run_at.is_none());
    }

    #[test]
    fn recurring_automation_requires_user_authorization_and_skips_missed_ticks() {
        let store = LocalStore::open_in_memory().expect("store");
        let task_id = task(&store);
        let anchor = Utc::now() - Duration::minutes(10);
        let missing = store.create_automation(NewAutomation {
            task_id,
            title: "Recurring check".into(),
            prompt: "Check again.".into(),
            target: AutomationTarget::Task,
            trigger: AutomationTrigger::Interval {
                every_seconds: 60,
                anchor_at: anchor,
                end_at: None,
            },
            route: route(),
            source: AutomationSource::Agent,
            recurrence_user_request: None,
            iteration_notes: false,
        });
        assert!(missing.is_err());

        let automation = store
            .create_automation(NewAutomation {
                task_id,
                title: "Recurring check".into(),
                prompt: "Check again.".into(),
                target: AutomationTarget::Task,
                trigger: AutomationTrigger::Interval {
                    every_seconds: 60,
                    anchor_at: anchor,
                    end_at: None,
                },
                route: route(),
                source: AutomationSource::Agent,
                recurrence_user_request: Some("check every minute".into()),
                iteration_notes: true,
            })
            .expect("recurring automation");
        let with_note = store
            .leave_automation_iteration_note(
                automation.id,
                "Verified the baseline; compare only newly changed files next.",
            )
            .expect("leave iteration note");
        assert_eq!(
            with_note.next_run_note.as_deref(),
            Some("Verified the baseline; compare only newly changed files next.")
        );
        let run = store
            .claim_automation(automation.id, anchor)
            .expect("claim")
            .expect("won claim");
        let next = store
            .finish_automation_run(run.id, Some("turn-2"), None)
            .expect("finish");
        assert_eq!(next.status, AutomationStatus::Active);
        assert!(next.next_run_at.is_some_and(|value| value > Utc::now()));
    }

    #[test]
    fn update_persists_an_ordered_fallback_route() {
        let store = LocalStore::open_in_memory().expect("store");
        let task_id = task(&store);
        let run_at = Utc::now() + Duration::minutes(5);
        let automation = store
            .create_automation(NewAutomation {
                task_id,
                title: "Check again".into(),
                prompt: "Inspect the current result.".into(),
                target: AutomationTarget::Task,
                trigger: AutomationTrigger::At { run_at },
                route: route(),
                source: AutomationSource::User,
                recurrence_user_request: None,
                iteration_notes: false,
            })
            .expect("automation");
        let mut updated_route = route();
        updated_route.fallbacks = vec![AutomationFallback {
            runtime: "claude".into(),
            model: "sonnet".into(),
            effort: Some("high".into()),
        }];
        let updated = store
            .update_automation(
                automation.id,
                UpdateAutomation {
                    title: "Check once more".into(),
                    prompt: automation.prompt,
                    trigger: AutomationTrigger::At { run_at },
                    route: updated_route,
                    recurrence_user_request: None,
                    iteration_notes: false,
                },
            )
            .expect("update automation");

        assert_eq!(updated.title, "Check once more");
        assert_eq!(updated.route.fallbacks[0].runtime, "claude");
        assert_eq!(updated.route.fallbacks[0].effort.as_deref(), Some("high"));
    }
}
