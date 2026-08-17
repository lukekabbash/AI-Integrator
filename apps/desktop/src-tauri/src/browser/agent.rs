//! What an agent may do with a browser tab.
//!
//! Every entry point here is reached through the broker, never from the
//! renderer, and every one of them checks two things before touching a tab:
//! that this installation allows agent access at all, and that the tab belongs
//! to the calling task. Tabs are shared with the user by design — the point of
//! the surface is that both can see the same page — but they are never shared
//! across tasks.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Runtime};
use url::Url;

use integrator_core::IntegratorError;

use crate::command_api::CommandError;

use super::{
    AGENT_ACCESS_SETTING, BrowserTab, BrowserTabs, close_tab, create_tab, emit_changed, eval_json,
    invalid, is_blank, normalize_url, setting_enabled, unavailable, webview_of,
};

pub async fn agent_invoke<R: Runtime>(
    app: &AppHandle<R>,
    tabs: &Arc<BrowserTabs>,
    task_id: &str,
    tab_id: &str,
    method: &str,
    args: Vec<Value>,
) -> Result<Value, CommandError> {
    ensure_agent_access(app)?;
    match tabs.task_of(tab_id) {
        Some(owner) if owner == task_id => {}
        Some(_) => return Err(unavailable("that browser tab belongs to another task")),
        None => return Err(unavailable("that browser tab is no longer open")),
    }
    let label = tabs
        .label_for(tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    // Reading a page is harmless when someone else is mid-flow; changing it is
    // not. A tab another agent is working in refuses writes rather than letting
    // two runs undo each other, and says who has it so the caller can open its
    // own tab instead.
    if WRITES.contains(&method)
        && let Some(holder) = tabs.held_by_other(tab_id, task_id)
    {
        return Err(unavailable(format!(
            "{holder} is working in that tab right now — open your own with browser_open, or wait for it to finish"
        )));
    }
    tabs.mark_held(tab_id, task_id);
    let args = serde_json::to_string(&args).map_err(|error| invalid(error.to_string()))?;
    eval_json(
        app,
        &label,
        format!("window.__integrator.{method}(...{args})"),
    )
    .await
}

/// Guest actions that change the page rather than read it.
const WRITES: &[&str] = &["click", "type", "press", "scroll", "evaluate"];

/// Opens a tab on the agent's behalf, owned by its task.
pub fn ensure_agent_access<R: Runtime>(app: &AppHandle<R>) -> Result<(), CommandError> {
    if setting_enabled(app, AGENT_ACCESS_SETTING) {
        return Ok(());
    }
    Err(CommandError {
        code: "unauthorized",
        message: "browser access for agents is turned off in Settings → Browser".into(),
    })
}

pub async fn open_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    task_id: &str,
    url: Option<String>,
) -> Result<BrowserTab, IntegratorError> {
    ensure_agent_access(app).map_err(|error| IntegratorError::Unauthorized(error.message))?;
    let target = match url.as_deref() {
        Some(raw) if !raw.trim().is_empty() => {
            normalize_url(raw).map_err(|error| IntegratorError::InvalidInput(error.message))?
        }
        _ => Url::parse("about:blank").expect("about:blank parses"),
    };
    create_tab(app, tabs, task_id.to_string(), target)
        .await
        .map_err(|error| IntegratorError::Unavailable(error.message))
}

/// Navigates one of the task's own tabs.
pub async fn navigate_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    task_id: &str,
    tab_id: &str,
    url: &str,
) -> Result<BrowserTab, IntegratorError> {
    ensure_agent_access(app).map_err(|error| IntegratorError::Unauthorized(error.message))?;
    match tabs.task_of(tab_id) {
        Some(owner) if owner == task_id => {}
        Some(_) => {
            return Err(IntegratorError::Unauthorized(
                "that browser tab belongs to another task".into(),
            ));
        }
        None => {
            return Err(IntegratorError::NotFound(
                "that browser tab is no longer open".into(),
            ));
        }
    }
    if let Some(holder) = tabs.held_by_other(tab_id, task_id) {
        return Err(IntegratorError::Unavailable(format!(
            "{holder} is working in that tab right now — open your own with browser_open"
        )));
    }
    tabs.mark_held(tab_id, task_id);
    let target =
        normalize_url(url).map_err(|error| IntegratorError::InvalidInput(error.message))?;
    let label = tabs
        .label_for(tab_id)
        .ok_or_else(|| IntegratorError::NotFound("that browser tab is no longer open".into()))?;
    webview_of(app, &label)
        .map_err(|error| IntegratorError::Unavailable(error.message))?
        .navigate(target.clone())
        .map_err(|error| IntegratorError::Unavailable(error.to_string()))?;
    let tab = tabs
        .update(tab_id, |tab| {
            tab.url = target.to_string();
            tab.loading = !is_blank(&target);
        })
        .ok_or_else(|| IntegratorError::NotFound("that browser tab is no longer open".into()))?;
    emit_changed(app, tabs);
    Ok(tab)
}

/// Closes one of this task's tabs. An agent juggling several pages should be
/// able to put one down; without this the only way a tab ever closes is the
/// user closing it by hand.
pub async fn close_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    task_id: &str,
    tab_id: &str,
) -> Result<(), IntegratorError> {
    ensure_agent_access(app).map_err(|error| IntegratorError::Unauthorized(error.message))?;
    match tabs.task_of(tab_id) {
        Some(owner) if owner == task_id => {}
        Some(_) => {
            return Err(IntegratorError::Unauthorized(
                "that browser tab belongs to another task".into(),
            ));
        }
        None => {
            return Err(IntegratorError::NotFound(
                "that browser tab is no longer open".into(),
            ));
        }
    }
    close_tab(app, tabs, tab_id).map_err(|error| IntegratorError::Unavailable(error.message))
}

pub fn tabs_for_task(tabs: &BrowserTabs, task_id: &str) -> Vec<BrowserTab> {
    tabs.snapshot(Some(task_id))
}
