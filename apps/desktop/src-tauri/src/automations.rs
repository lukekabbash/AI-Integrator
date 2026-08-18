use std::time::Duration as StdDuration;

use chrono::{DateTime, Utc};
use integrator_core::{
    Automation, AutomationId, AutomationRoute, AutomationRun, AutomationRunId, AutomationSource,
    AutomationStatus, AutomationTarget, AutomationTrigger, DelegationStatus, TaskId,
};
use serde::Serialize;
use session_store::{NewAutomation, UpdateAutomation};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{command_api::CommandResult, state::AppState};

pub const DUE_EVENT: &str = "automation://due";
pub const CHANGED_EVENT: &str = "automation://changed";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDispatch {
    pub automation: Automation,
    pub run: AutomationRun,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTimelineEntry {
    pub automation: Automation,
    pub runs: Vec<AutomationRun>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationChanged {
    task_id: integrator_core::TaskId,
}

pub fn emit_changed(app: &AppHandle<tauri::Wry>, automation: &Automation) {
    let _ = app.emit(
        CHANGED_EVENT,
        AutomationChanged {
            task_id: automation.task_id,
        },
    );
}

#[tauri::command]
pub fn automation_list(
    state: State<'_, AppState>,
    task_id: Option<integrator_core::TaskId>,
) -> CommandResult<Vec<Automation>> {
    state.store.list_automations(task_id).map_err(Into::into)
}

#[tauri::command]
pub fn automation_create(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    title: String,
    prompt: String,
    target: AutomationTarget,
    trigger: AutomationTrigger,
    route: AutomationRoute,
    recurrence_user_request: Option<String>,
    iteration_notes: bool,
) -> CommandResult<Automation> {
    let automation = state.store.create_automation(NewAutomation {
        task_id,
        title,
        prompt,
        target,
        trigger,
        route,
        source: AutomationSource::User,
        recurrence_user_request,
        iteration_notes,
    })?;
    state.automation_notify.notify_one();
    emit_changed(&app, &automation);
    Ok(automation)
}

#[tauri::command]
pub fn automation_update(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    automation_id: AutomationId,
    task_id: Option<TaskId>,
    title: String,
    prompt: String,
    trigger: AutomationTrigger,
    route: AutomationRoute,
    recurrence_user_request: Option<String>,
    iteration_notes: bool,
) -> CommandResult<Automation> {
    let previous_task_id = state.store.get_automation(automation_id)?.task_id;
    let automation = state.store.update_automation(
        automation_id,
        UpdateAutomation {
            task_id,
            title,
            prompt,
            trigger,
            route,
            recurrence_user_request,
            iteration_notes,
        },
    )?;
    state.automation_notify.notify_one();
    // The chat it left has to refresh its timeline too, or the automation
    // lingers there until something else forces a reload.
    if previous_task_id != automation.task_id {
        let _ = app.emit(
            CHANGED_EVENT,
            AutomationChanged {
                task_id: previous_task_id,
            },
        );
    }
    emit_changed(&app, &automation);
    Ok(automation)
}

#[tauri::command]
pub fn automation_run_list(
    state: State<'_, AppState>,
    automation_id: AutomationId,
) -> CommandResult<Vec<AutomationRun>> {
    state
        .store
        .list_automation_runs(automation_id)
        .map_err(Into::into)
}

#[tauri::command]
pub fn automation_timeline(
    state: State<'_, AppState>,
    task_id: integrator_core::TaskId,
) -> CommandResult<Vec<AutomationTimelineEntry>> {
    state
        .store
        .list_automations(Some(task_id))?
        .into_iter()
        .map(|automation| {
            let runs = state.store.list_automation_runs(automation.id)?;
            Ok(AutomationTimelineEntry { automation, runs })
        })
        .collect::<integrator_core::Result<Vec<_>>>()
        .map_err(Into::into)
}

#[tauri::command]
pub fn automation_pending_dispatches(
    state: State<'_, AppState>,
) -> CommandResult<Vec<AutomationDispatch>> {
    let mut pending = Vec::new();
    for automation in state.store.list_automations(None)? {
        if automation.status != AutomationStatus::Running {
            continue;
        }
        if let Some(run) = state
            .store
            .list_automation_runs(automation.id)?
            .into_iter()
            .find(|run| run.status == integrator_core::AutomationRunStatus::Claimed)
        {
            pending.push(AutomationDispatch { automation, run });
        }
    }
    Ok(pending)
}

#[tauri::command]
pub fn automation_set_paused(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    automation_id: AutomationId,
    paused: bool,
) -> CommandResult<Automation> {
    let automation = state.store.set_automation_paused(automation_id, paused)?;
    state.automation_notify.notify_one();
    emit_changed(&app, &automation);
    Ok(automation)
}

#[tauri::command]
pub fn automation_cancel(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    automation_id: AutomationId,
) -> CommandResult<Automation> {
    let automation = state.store.cancel_automation(automation_id)?;
    state.automation_notify.notify_one();
    emit_changed(&app, &automation);
    Ok(automation)
}

#[tauri::command]
pub fn automation_run_now(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    automation_id: AutomationId,
) -> CommandResult<Automation> {
    let automation = state.store.run_automation_now(automation_id)?;
    state.automation_notify.notify_one();
    emit_changed(&app, &automation);
    Ok(automation)
}

#[tauri::command]
pub fn automation_finish_run(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    run_id: AutomationRunId,
    dispatch_ref: Option<String>,
    error: Option<String>,
) -> CommandResult<Automation> {
    let automation =
        state
            .store
            .finish_automation_run(run_id, dispatch_ref.as_deref(), error.as_deref())?;
    state.automation_notify.notify_one();
    emit_changed(&app, &automation);
    Ok(automation)
}

pub fn start(app: AppHandle<tauri::Wry>) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = app
            .state::<AppState>()
            .store
            .mark_orphaned_automation_claims()
        {
            eprintln!("automation recovery failed: {error}");
        }
        loop {
            if let Err(error) = dispatch_due(&app) {
                eprintln!("automation scheduler failed: {error}");
            }
            let sleep = next_sleep(&app).unwrap_or(StdDuration::from_secs(5));
            let state = app.state::<AppState>();
            tokio::select! {
                () = tokio::time::sleep(sleep) => {}
                () = state.automation_notify.notified() => {}
            }
        }
    });
}

/// Any window can run a due automation: the dispatch carries its own task id
/// and the turn is sent by task, not by whatever chat that window shows. The
/// main window is only preferred so the choice is stable; a popped-out task
/// window keeps the process alive after the main window is closed, and back
/// when this looked up `"main"` alone that left every run failing.
///
/// Emission still targets exactly one window because the listener is global —
/// broadcasting would start the same turn once per open window.
fn dispatch_window(app: &AppHandle<tauri::Wry>) -> Option<tauri::WebviewWindow> {
    if let Some(main) = app.get_webview_window("main") {
        return Some(main);
    }
    let mut labels: Vec<String> = app.webview_windows().into_keys().collect();
    labels.sort();
    labels
        .into_iter()
        .find_map(|label| app.get_webview_window(&label))
}

fn dispatch_due(app: &AppHandle<tauri::Wry>) -> integrator_core::Result<()> {
    let state = app.state::<AppState>();
    let now = Utc::now();
    // Claiming a run with no window to receive it would burn it, so leave the
    // automation due instead. The loop retries within five seconds, and the
    // frontend drains anything already claimed when it mounts.
    let Some(window) = dispatch_window(app) else {
        return Ok(());
    };
    for automation in state.store.active_automations()? {
        let Some(scheduled_for) = due_at(&state, &automation, now)? else {
            continue;
        };
        let Some(run) = state.store.claim_automation(automation.id, scheduled_for)? else {
            continue;
        };
        emit_changed(app, &automation);
        let dispatch = AutomationDispatch { automation, run };
        let emitted = window
            .emit(DUE_EVENT, &dispatch)
            .map_err(|error| error.to_string());
        if let Err(error) = emitted {
            let automation =
                state
                    .store
                    .finish_automation_run(dispatch.run.id, None, Some(&error))?;
            emit_changed(app, &automation);
        }
    }
    Ok(())
}

fn due_at(
    state: &AppState,
    automation: &Automation,
    now: DateTime<Utc>,
) -> integrator_core::Result<Option<DateTime<Utc>>> {
    match &automation.trigger {
        AutomationTrigger::At { .. } | AutomationTrigger::Interval { .. } => {
            Ok(automation.next_run_at.filter(|next| *next <= now))
        }
        AutomationTrigger::DelegationsSettled {
            delegation_ids,
            require_all,
            timeout_at,
        } => {
            if timeout_at.is_some_and(|timeout| timeout <= now) {
                return Ok(Some(now));
            }
            let terminal = delegation_ids
                .iter()
                .map(|id| {
                    state
                        .store
                        .get_delegation(*id)
                        .map(|item| settled(item.status))
                })
                .collect::<integrator_core::Result<Vec<_>>>()?;
            let ready = if *require_all {
                terminal.iter().all(|value| *value)
            } else {
                terminal.iter().any(|value| *value)
            };
            Ok(ready.then_some(now))
        }
    }
}

fn settled(status: DelegationStatus) -> bool {
    matches!(
        status,
        DelegationStatus::Completed
            | DelegationStatus::Failed
            | DelegationStatus::Stopped
            | DelegationStatus::Denied
    )
}

fn next_sleep(app: &AppHandle<tauri::Wry>) -> integrator_core::Result<StdDuration> {
    let now = Utc::now();
    let nearest = app
        .state::<AppState>()
        .store
        .active_automations()?
        .into_iter()
        .filter_map(|automation| automation.next_run_at)
        .min();
    let until = nearest
        .and_then(|next| (next - now).to_std().ok())
        .unwrap_or(StdDuration::from_secs(5));
    Ok(until.min(StdDuration::from_secs(5)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_terminal_delegations_settle_a_wakeup() {
        assert!(settled(DelegationStatus::Completed));
        assert!(settled(DelegationStatus::Failed));
        assert!(!settled(DelegationStatus::Running));
        assert!(!settled(DelegationStatus::Waiting));
    }
}
