//! What an agent may do with a browser tab.
//!
//! Every entry point here is reached through the broker, never from the
//! renderer, and each one answers the same two questions before touching a
//! tab: whether this installation allows agent access at all, and whether this
//! caller may address this tab.
//!
//! Reach has three layers, from durable to momentary:
//!
//! - **Task** — a tab belongs to one task, and nothing outside it can see the
//!   tab at all. This boundary is not negotiable and has no grant.
//! - **Owner** — inside a task, a tab opened by a delegated child belongs to
//!   that child. Siblings cannot see it; the orchestrator can. The
//!   orchestrator may hand a tab to a child, read-only or to drive.
//! - **Hold** — whoever last drove a tab holds it briefly, so two agents do
//!   not undo each other mid-flow. Advisory, expires on its own.
//!
//! Tabs are shared with the *user* by design — that is the point of the
//! surface — so none of this hides a page from the person watching it.

use std::sync::Arc;

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Runtime};
use url::Url;

use integrator_core::IntegratorError;

use crate::command_api::CommandError;

use super::{
    AGENT_ACCESS_SETTING, BrowserTab, BrowserTabs, Caller, GrantMode, close_tab, create_tab,
    emit_changed, eval_json, invalid, is_blank, normalize_url, setting_enabled, unavailable,
    webview_of,
};

/// Guest actions that change the page rather than read it. `guest.js` keeps
/// the same list for its own half of the hold; the drift test holds them level.
pub(super) const WRITES: &[&str] = &["click", "type", "press", "scroll", "drag", "evaluate"];

pub fn ensure_agent_access<R: Runtime>(app: &AppHandle<R>) -> Result<(), CommandError> {
    if setting_enabled(app, AGENT_ACCESS_SETTING) {
        return Ok(());
    }
    Err(CommandError {
        code: "unauthorized",
        message: "browser access for agents is turned off in Settings → Browser".into(),
    })
}

/// Refuses a caller that cannot reach this tab, and refuses a read-only grant
/// the moment the action would change the page.
fn reach_for(
    tabs: &BrowserTabs,
    caller: &Caller,
    tab_id: &str,
    writing: bool,
) -> Result<(), CommandError> {
    match tabs.reach(tab_id, caller) {
        Some(GrantMode::Read) if writing => Err(unavailable(
            "that tab was shared with you read-only — snapshot and evaluate are fine, changing the page is not",
        )),
        Some(_) => Ok(()),
        // Distinguishing these two is worth the branch: one means "ask whoever
        // owns it", the other means "it is gone, open your own".
        None if tabs.task_of(tab_id).is_some() => {
            Err(unavailable("that browser tab belongs to another agent"))
        }
        None => Err(unavailable("that browser tab is no longer open")),
    }
}

/// The reach check on its own, for callers that are not a guest action —
/// filling a login writes to the page, so it needs a drive-level grant.
pub(super) fn ensure_reach(
    tabs: &BrowserTabs,
    caller: &Caller,
    tab_id: &str,
) -> Result<(), CommandError> {
    reach_for(tabs, caller, tab_id, true)
}

/// Runs a guest action for an agent.
pub async fn agent_invoke(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    caller: &Caller,
    tab_id: &str,
    method: &str,
    args: Vec<Value>,
) -> Result<Value, CommandError> {
    ensure_agent_access(app)?;
    let writing = WRITES.contains(&method);
    reach_for(tabs, caller, tab_id, writing)?;
    let who = caller.label();
    // Reading a page is harmless when someone else is mid-flow; changing it is
    // not. A tab someone else is working in refuses writes rather than letting
    // two runs undo each other, and says who has it.
    if writing && let Some(holder) = tabs.held_by_other(tab_id, &who) {
        return Err(unavailable(stood_off(&holder)));
    }
    super::remember::ensure_awake(app, tabs, tab_id).await;
    let label = tabs
        .label_for(tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    tabs.mark_held(tab_id, &who);
    let args = serde_json::to_string(&args).map_err(|error| invalid(error.to_string()))?;
    // The guest gets the last word on whether this lands. Only the page can see
    // the person's own clicks and keys, so the veto has to be asked there —
    // `blocked` answers null when the way is clear, which lets the call through.
    let reply = eval_json(
        app,
        &label,
        format!(
            "window.__integrator.blocked?.({method:?}) || window.__integrator.{method}(...{args})"
        ),
    )
    .await?;
    super::note_user_activity(tabs, tab_id, &reply);
    Ok(reply)
}

/// How a refusal reads depends on who is holding the tab: another agent can be
/// waited out or worked around, the person at the keyboard is simply first.
fn stood_off(holder: &str) -> String {
    if holder == super::USER_HOLDER {
        return "the person is working in that tab right now — wait for them to finish, or open your own with browser_open".into();
    }
    format!(
        "{holder} is working in that tab right now — open your own with browser_open, or wait for it to finish"
    )
}

/// Opens a tab for this caller. A child's tab belongs to the child, so its
/// siblings never see it and never drive it by accident.
pub async fn open_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    caller: &Caller,
    url: Option<String>,
) -> Result<BrowserTab, IntegratorError> {
    ensure_agent_access(app).map_err(|error| IntegratorError::Unauthorized(error.message))?;
    let target = match url.as_deref() {
        Some(raw) if !raw.trim().is_empty() => {
            normalize_url(raw).map_err(|error| IntegratorError::InvalidInput(error.message))?
        }
        _ => Url::parse("about:blank").expect("about:blank parses"),
    };
    let tab = create_tab(app, tabs, caller.task_id.clone(), target)
        .await
        .map_err(|error| IntegratorError::Unavailable(error.message))?;
    if let Some(delegation) = caller.delegation_id.clone() {
        tabs.update(&tab.id, |state| state.delegation_id = Some(delegation));
        emit_changed(app, tabs);
    }
    tabs.snapshot(Some(&caller.task_id))
        .into_iter()
        .find(|candidate| candidate.id == tab.id)
        .ok_or_else(|| IntegratorError::NotFound("that browser tab is no longer open".into()))
}

/// Points one reachable tab at a URL.
pub async fn navigate_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    caller: &Caller,
    tab_id: &str,
    url: &str,
) -> Result<BrowserTab, IntegratorError> {
    ensure_agent_access(app).map_err(|error| IntegratorError::Unauthorized(error.message))?;
    reach_for(tabs, caller, tab_id, true).map_err(|error| match error.code {
        "unauthorized" => IntegratorError::Unauthorized(error.message),
        _ => IntegratorError::Unavailable(error.message),
    })?;
    let who = caller.label();
    if let Some(holder) = tabs.held_by_other(tab_id, &who) {
        return Err(IntegratorError::Unavailable(stood_off(&holder)));
    }
    tabs.mark_held(tab_id, &who);
    let target =
        normalize_url(url).map_err(|error| IntegratorError::InvalidInput(error.message))?;
    super::remember::ensure_awake(app, tabs, tab_id).await;
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

/// Closes a tab this caller owns. A granted tab is someone else's to close.
pub async fn close_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    caller: &Caller,
    tab_id: &str,
) -> Result<(), IntegratorError> {
    ensure_agent_access(app).map_err(|error| IntegratorError::Unauthorized(error.message))?;
    if !tabs.owns(tab_id, caller) {
        return Err(IntegratorError::Unauthorized(
            "that tab belongs to another agent — it is not yours to close".into(),
        ));
    }
    close_tab(app, tabs, tab_id).map_err(|error| IntegratorError::Unavailable(error.message))
}

/// Hands one of the orchestrator's tabs to a delegated child. Only the
/// orchestrator grants, and a grant never travels onward: a child cannot
/// re-share what it was given.
pub fn grant_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    caller: &Caller,
    tab_id: &str,
    delegation_id: &str,
    mode: GrantMode,
) -> Result<BrowserTab, IntegratorError> {
    ensure_agent_access(app).map_err(|error| IntegratorError::Unauthorized(error.message))?;
    if caller.delegation_id.is_some() {
        return Err(IntegratorError::Unauthorized(
            "a subagent cannot share its tab onward".into(),
        ));
    }
    if !tabs.owns(tab_id, caller) {
        return Err(IntegratorError::Unauthorized(
            "that tab belongs to another agent".into(),
        ));
    }
    if !tabs.grant(tab_id, delegation_id, mode) {
        return Err(IntegratorError::NotFound(
            "that browser tab is no longer open".into(),
        ));
    }
    emit_changed(app, tabs);
    tabs.snapshot(Some(&caller.task_id))
        .into_iter()
        .find(|candidate| candidate.id == tab_id)
        .ok_or_else(|| IntegratorError::NotFound("that browser tab is no longer open".into()))
}

/// Asks the renderer to put this tab on screen, and waits to see whether it
/// really landed. The renderer owns layout — the pane may be closed, the user
/// may be in another chat — so this reports what happened instead of assuming.
pub async fn focus_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    caller: &Caller,
    tab_id: &str,
) -> Result<Value, CommandError> {
    ensure_agent_access(app)?;
    // Showing a page changes nothing on it, so a read-only grant is enough.
    reach_for(tabs, caller, tab_id, false)?;
    super::remember::ensure_awake(app, tabs, tab_id).await;
    let label = tabs
        .label_for(tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let _ = app.emit(
        super::BROWSER_FOCUS_EVENT,
        json!({ "taskId": caller.task_id.as_str(), "tabId": tab_id }),
    );
    // A tab parked off screen still measures 1280×800, so its own geometry
    // cannot answer this. What can is the renderer's placement: it reports a
    // rectangle when a tab is on screen and hides it when it is not. Wait
    // briefly for the pane to open and that placement to arrive.
    for attempt in 0..FOCUS_TRIES {
        if attempt > 0 {
            tokio::time::sleep(FOCUS_POLL).await;
        }
        if tabs.on_screen(tab_id) {
            let viewport = eval_json(app, &label, VIEWPORT.into()).await.ok();
            return Ok(json!({ "focused": true, "viewport": viewport }));
        }
    }
    Ok(json!({
        "focused": false,
        "note": "the tab is running but not on screen — the browser pane may be closed, \
                 or the user may be looking at another chat. It is still yours to drive.",
    }))
}

/// How long `browser_focus` gives the renderer to actually show the tab.
const FOCUS_TRIES: u8 = 10;
const FOCUS_POLL: std::time::Duration = std::time::Duration::from_millis(120);
const VIEWPORT: &str = "({ ok: true, value: { width: innerWidth, height: innerHeight } })";

/// Lists a tab's cookies without their values. Reading is reading, so a
/// read-only grant is enough.
pub async fn cookies_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    caller: &Caller,
    tab_id: &str,
) -> Result<Value, CommandError> {
    ensure_agent_access(app)?;
    reach_for(tabs, caller, tab_id, false)?;
    super::remember::ensure_awake(app, tabs, tab_id).await;
    let cookies = super::sites::cookies_for_tab(app, tabs, tab_id).await?;
    Ok(json!({
        "cookies": cookies,
        "note": "names, flags and expiry only — no cookie value is readable through any tool.",
    }))
}

/// Every tab this caller may address.
pub fn tabs_for_caller(tabs: &BrowserTabs, caller: &Caller) -> Vec<BrowserTab> {
    tabs.visible_to(caller)
}
