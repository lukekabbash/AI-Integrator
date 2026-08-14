use chrono::{DateTime, Utc};
use integrator_core::TaskId;
use session_store::LocalStore;

use crate::command_api::{CommandError, CommandResult};

/// Visible placeholder persisted by the renderer; providers receive the
/// generated continuation prompt instead.
pub(crate) const INTERRUPTED_RESUME_VISIBLE_PROMPT: &str = "Resume from here";

pub(crate) fn interrupted_resume_wire_prompt(interrupted_at: Option<DateTime<Utc>>) -> String {
    let resumed_at = Utc::now();
    let interrupted = interrupted_at
        .map(|time| time.to_rfc3339())
        .unwrap_or_else(|| "an unknown time".into());
    format!(
        "You were interrupted at {interrupted}. It is now {} and this session has been resumed.\n\
         Continue what you were doing as seamlessly as possible for the user.\n\
         Complete the task assigned in the last user prompt.\n\
         Do not repeat completed actions. Prefer the current workspace and provider conversation as source of truth if anything changed while you were interrupted.\n\
         If any external or mutating outcome is uncertain, stop and explain before retrying it.",
        resumed_at.to_rfc3339()
    )
}

pub(crate) fn provider_wire_prompt(
    prompt: &str,
    resume_interrupted: Option<bool>,
    interrupted_at: Option<DateTime<Utc>>,
) -> String {
    if resume_interrupted == Some(true) {
        interrupted_resume_wire_prompt(interrupted_at)
    } else {
        prompt.into()
    }
}

pub(crate) fn interrupted_at_for_task(
    store: &LocalStore,
    task_id: TaskId,
) -> Option<DateTime<Utc>> {
    store.task_latest_interrupted_at(task_id).ok().flatten()
}

pub(crate) fn validate_interrupted_resume_action(
    native_action_id: Option<&str>,
    resume_interrupted: Option<bool>,
) -> CommandResult<()> {
    if resume_interrupted == Some(true) && native_action_id.is_some() {
        return Err(CommandError {
            code: "invalid-input",
            message: "An interrupted response cannot resume through a new native action".into(),
        });
    }
    Ok(())
}

pub(crate) fn validate_interrupted_resume_for_task(
    store: &LocalStore,
    task_id: TaskId,
    native_action_id: Option<&str>,
    resume_interrupted: Option<bool>,
) -> CommandResult<()> {
    validate_interrupted_resume_action(native_action_id, resume_interrupted)?;
    if resume_interrupted == Some(true) && store.task_tip_stop_requested(task_id).unwrap_or(false) {
        return Err(CommandError {
            code: "invalid-input",
            message: "A stopped turn cannot be resumed as an interruption".into(),
        });
    }
    Ok(())
}
