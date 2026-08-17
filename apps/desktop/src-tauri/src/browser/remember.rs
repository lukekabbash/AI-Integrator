//! Tabs a chat keeps between sessions.
//!
//! Coming back to a chat should not mean looking every page up again, so the
//! addresses a task had open are written to the store as they change and read
//! back when the task is opened. Only the address and the title travel: page
//! state belongs to the site and its cookies, which the browser profile already
//! keeps.
//!
//! Restored tabs arrive asleep. Nothing is fetched and no webview exists until
//! the tab is looked at or an agent addresses it, so opening a chat with a dozen
//! remembered pages costs nothing but a row each.

use std::sync::Arc;

use session_store::StoredBrowserTab;
use std::sync::atomic::Ordering;

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager};
use url::Url;

use integrator_core::TaskId;

use crate::command_api::CommandError;

use super::{
    BrowserTab, BrowserTabs, Tab, emit_changed, is_blank, tab_webview_builder, unavailable,
};

/// Writes this task's current tabs over whatever was remembered before.
pub fn remember(app: &AppHandle, tabs: &BrowserTabs, task_id: &str) {
    let Ok(task) = task_id.parse::<TaskId>() else {
        return;
    };
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return;
    };
    let stored: Vec<StoredBrowserTab> = tabs
        .snapshot(Some(task_id))
        .into_iter()
        .map(|tab| StoredBrowserTab {
            url: tab.url,
            title: tab.title,
        })
        .collect();
    // Best effort: forgetting a tab list is a smaller problem than failing the
    // action the user actually asked for.
    let _ = state.store.set_browser_tabs(task, &stored);
}

/// Registers remembered tabs for a task as sleeping entries. Returns how many
/// were added. Existing tabs for the task mean the session already has them, so
/// nothing is restored twice.
pub fn restore(app: &AppHandle, tabs: &Arc<BrowserTabs>, task_id: &str) -> usize {
    let Ok(task) = task_id.parse::<TaskId>() else {
        return 0;
    };
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return 0;
    };
    if !tabs.snapshot(Some(task_id)).is_empty() {
        return 0;
    }
    let Ok(remembered) = state.store.browser_tabs(task) else {
        return 0;
    };
    let mut added = 0;
    for stored in remembered {
        if Url::parse(&stored.url).is_err() {
            continue;
        }
        if tabs.insert_sleeping(task_id, &stored.url, &stored.title) {
            added += 1;
        }
    }
    if added > 0 {
        emit_changed(app, tabs);
    }
    added
}

/// Loads a tab if it is still asleep, then hands back nothing: callers only
/// need to know the webview exists before they reach for it. Anything that
/// drives a page — history, navigation, a guest call, a capture — goes through
/// here first, so a remembered tab behaves like any other the moment it is
/// addressed rather than reporting itself as gone.
pub async fn ensure_awake(app: &AppHandle, tabs: &Arc<BrowserTabs>, tab_id: &str) {
    if tabs.sleeping_target(tab_id).is_some() {
        let _ = wake(app, tabs, tab_id).await;
    }
}

/// Gives a sleeping tab its webview, at the address it was remembered with.
/// Called when the tab is first shown or an agent addresses it.
pub async fn wake(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    tab_id: &str,
) -> Result<BrowserTab, CommandError> {
    let Some(sleeping) = tabs.sleeping_target(tab_id) else {
        return tabs
            .snapshot(None)
            .into_iter()
            .find(|tab| tab.id == tab_id)
            .ok_or_else(|| unavailable("that browser tab is no longer open"));
    };
    let target = Url::parse(&sleeping.url).map_err(|_| unavailable("that tab has no address"))?;
    adopt_sleeping(app, tabs, tab_id, &target).await
}

impl BrowserTabs {
    /// Registers a remembered tab with no webview behind it. Returns false when
    /// the same address is already present, so restoring twice is harmless.
    pub(super) fn insert_sleeping(&self, task_id: &str, url: &str, title: &str) -> bool {
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        if tabs
            .values()
            .any(|tab| tab.state.task_id == task_id && tab.state.url == url)
        {
            return false;
        }
        let id = format!("tab-{}", self.sequence.fetch_add(1, Ordering::Relaxed) + 1);
        let label = format!("browser-{id}");
        tabs.insert(
            id.clone(),
            Tab {
                state: BrowserTab {
                    id,
                    task_id: task_id.to_string(),
                    url: url.to_string(),
                    title: title.to_string(),
                    loading: false,
                    popped_out: false,
                    hidden: true,
                    held_by: None,
                    sleeping: true,
                },
                label,
                held: None,
                generation: 0,
            },
        );
        true
    }

    /// The address a sleeping tab is waiting on, if it is asleep.
    pub(super) fn sleeping_target(&self, id: &str) -> Option<BrowserTab> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.get(id)
            .filter(|tab| tab.state.sleeping)
            .map(|tab| tab.state.clone())
    }
}

/// Gives a remembered tab the webview it never had. The registry entry, its id
/// and its place in the strip all stay as they were, so waking a tab is
/// invisible to anything holding a reference to it.
pub(super) async fn adopt_sleeping(
    app: &AppHandle,
    state: &Arc<BrowserTabs>,
    tab_id: &str,
    target: &Url,
) -> Result<BrowserTab, CommandError> {
    let label = state
        .label_for(tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let window = app
        .get_window("main")
        .ok_or_else(|| unavailable("the main window is not available"))?;
    window
        .add_child(
            tab_webview_builder(app, state, tab_id, &label, target),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| unavailable(format!("could not open that tab: {error}")))?;
    let tab = state
        .update(tab_id, |tab| {
            tab.sleeping = false;
            tab.loading = !is_blank(target);
        })
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    emit_changed(app, state);
    Ok(tab)
}
