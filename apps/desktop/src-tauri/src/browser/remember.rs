//! Tabs a chat keeps between sessions.
//!
//! Coming back to a chat should not mean looking every page up again, so the
//! addresses a task had open are written to the store as they change and read
//! back when the task is opened. Only the address, the title and the site's
//! small icon travel: page state belongs to the site and its cookies, which the
//! browser profile already keeps.
//!
//! Restored tabs arrive asleep. Nothing is fetched and no webview exists until
//! the tab is looked at or an agent addresses it, so opening a chat with a dozen
//! remembered pages costs nothing but a row each.

use std::sync::Arc;

use session_store::{StoredBrowserTab, StoredRecentTab};
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager};
use url::Url;

use integrator_core::TaskId;

use crate::command_api::CommandError;

use std::collections::HashMap;

use super::{
    BrowserTab, BrowserTabs, Group, Tab, emit_changed, is_blank, tab_webview_builder, unavailable,
};

/// Writes this task's current tabs over whatever was remembered before.
pub fn remember(app: &AppHandle, tabs: &BrowserTabs, task_id: &str) {
    let Ok(task) = task_id.parse::<TaskId>() else {
        return;
    };
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return;
    };
    let (stored, touched) = tabs.stored_rows(task_id);
    // Best effort: forgetting a tab list is a smaller problem than failing the
    // action the user actually asked for.
    if state.store.set_browser_tabs(task, &stored).is_ok() {
        let mut written = tabs
            .last_written_touch
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for (id, at) in touched {
            written.insert(id, at);
        }
    }
}

/// Writes every task that has a tab in this window: a reorder or a move
/// shifts strip positions for all of them, not just the tab that moved.
pub(super) fn remember_window(app: &AppHandle, tabs: &BrowserTabs, label: &str) {
    let mut tasks: Vec<String> = tabs
        .snapshot_window(label)
        .into_iter()
        .map(|tab| tab.task_id)
        .collect();
    tasks.sort();
    tasks.dedup();
    for task in tasks {
        remember(app, tabs, &task);
    }
}

/// Records a popped-out tab the person closed, so it can be reopened from
/// "Recently closed" after a restart as well as before one. A pane tab is
/// not recorded: its chat is the place it lived, and blank tabs have nothing
/// to reopen.
pub(super) fn note_closed(app: &AppHandle, closing: &BrowserTab) {
    if !closing.popped_out || closing.url.starts_with("about:") {
        return;
    }
    let Ok(task) = closing.task_id.parse::<TaskId>() else {
        return;
    };
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return;
    };
    let _ = state.store.push_recent_tabs(&[StoredRecentTab {
        task_id: task,
        group_id: closing.group_id.clone(),
        url: closing.url.clone(),
        title: closing.title.clone(),
        favicon: closing
            .favicon
            .clone()
            .filter(|icon| icon.len() <= super::favicon::MAX_ICON_BYTES),
        closed_at: chrono::Utc::now(),
        reason: "closed".to_string(),
    }]);
}

/// Registers remembered pane tabs for a task as sleeping entries. Returns
/// how many were added. Existing tabs for the task mean the session already
/// has them, so nothing is restored twice. Rows that live in a pop-out window
/// are the window path's (`restore::restore_windows`), not this one's.
pub fn restore(app: &AppHandle, tabs: &Arc<BrowserTabs>, task_id: &str) -> usize {
    let Ok(task) = task_id.parse::<TaskId>() else {
        return 0;
    };
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return 0;
    };
    // Popped-out tabs the window path already brought back do not count: the
    // pane's rows are still waiting.
    if tabs
        .snapshot(Some(task_id))
        .iter()
        .any(|tab| !tab.popped_out)
    {
        return 0;
    }
    let Ok(remembered) = state.store.browser_tabs(task) else {
        return 0;
    };
    let group = super::groups::group_for_task(app, tabs, task_id);
    let mut added = 0;
    for stored in remembered {
        if stored.window_id.is_some() || Url::parse(&stored.url).is_err() {
            continue;
        }
        let favicon = stored
            .favicon
            .clone()
            .or_else(|| super::favicon::cached_for_url(&stored.url));
        let place = SleepingPlace {
            touched_at: stored.last_touched_at,
            ..SleepingPlace::default()
        };
        if tabs.insert_sleeping(task_id, &group, &stored.url, &stored.title, favicon, place) {
            added += 1;
        }
    }
    if added > 0 {
        emit_changed(app, tabs);
    }
    added
}

/// How many tabs one group keeps loaded at once. Each live tab is a WebView2
/// process holding a full-size page, so a run that opens twenty of them would
/// cost more than the machine can spare. Past the cap the least-recently
/// touched one goes back to sleep, keeping its place in the strip and its
/// address; addressing it wakes it again. The cap is per group rather than per
/// task so a project with many tasks does not multiply webviews.
pub(crate) const LIVE_TAB_CAP_PER_GROUP: usize = 8;

/// How many tabs the whole app keeps loaded, across every group.
pub(crate) const LIVE_TAB_CAP_TOTAL: usize = 24;

/// Puts a loaded tab back to sleep: the webview goes, the row stays.
pub(super) fn sleep(app: &AppHandle, tabs: &Arc<BrowserTabs>, tab_id: &str) {
    let Some(label) = tabs.label_for(tab_id) else {
        return;
    };
    if let Ok(webview) = super::webview_of(app, &label) {
        let _ = webview.close();
    }
    tabs.update(tab_id, |tab| {
        tab.sleeping = true;
        tab.loading = false;
        tab.hidden = true;
    });
}

/// Sleeps this group's oldest loaded tabs until it is back under its cap, then
/// the oldest anywhere until the app is under the total.
///
/// Only tabs nothing is looking at are candidates: whatever is on screen, was
/// driven inside the hold window, or is the tab that just opened stays loaded
/// however old it is — a cap that closed the page the user was reading would
/// be worse than no cap at all. A parked popped-out tab is fair game.
pub(super) fn enforce_cap(app: &AppHandle, tabs: &Arc<BrowserTabs>, group_id: &str, keep: &str) {
    let mut slept = 0;
    for (scope, cap) in [
        (Some(group_id), LIVE_TAB_CAP_PER_GROUP),
        (None, LIVE_TAB_CAP_TOTAL),
    ] {
        let over = tabs.live_count(scope).saturating_sub(cap);
        if over == 0 {
            continue;
        }
        for id in tabs.sleepable(scope, keep).into_iter().take(over) {
            sleep(app, tabs, &id);
            slept += 1;
        }
    }
    if slept > 0 {
        emit_changed(app, tabs);
    }
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
    let tab = adopt_sleeping(app, tabs, tab_id, &target).await?;
    // One more live tab may be one too many: the woken tab is spared, an older
    // parked one goes back to sleep in its place.
    enforce_cap(app, tabs, &tab.group_id, tab_id);
    Ok(tab)
}

/// Where a sleeping tab is registered: the pane (`window: None`), or a
/// pop-out window at a strip position; and the touch time its row carried,
/// so it comes back exactly as old as it was.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct SleepingPlace<'a> {
    pub(super) window: Option<&'a str>,
    pub(super) order: u32,
    pub(super) touched_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl BrowserTabs {
    /// This task's tabs as the store keeps them, in id order, plus the touch
    /// time each row carries so the caller can record what it wrote.
    pub(super) fn stored_rows(
        &self,
        task_id: &str,
    ) -> (
        Vec<StoredBrowserTab>,
        Vec<(String, chrono::DateTime<chrono::Utc>)>,
    ) {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let mut rows: Vec<&Tab> = tabs
            .values()
            .filter(|tab| tab.state.task_id == task_id)
            .collect();
        rows.sort_by(|a, b| a.state.id.cmp(&b.state.id));
        let touched = rows
            .iter()
            .map(|tab| (tab.state.id.clone(), tab.touched_at))
            .collect();
        let stored = rows
            .into_iter()
            .map(|tab| StoredBrowserTab {
                url: tab.state.url.clone(),
                title: tab.state.title.clone(),
                // Icons are already bounded when resolved; the check is belt
                // and braces against a row that would bloat the store.
                favicon: tab
                    .state
                    .favicon
                    .clone()
                    .filter(|icon| icon.len() <= super::favicon::MAX_ICON_BYTES),
                window_id: tab.window.clone(),
                window_order: tab.window.is_some().then_some(tab.order),
                last_touched_at: Some(tab.touched_at),
            })
            .collect();
        (stored, touched)
    }

    /// Registers a remembered tab with no webview behind it, where `place`
    /// says. Returns false when the same address is already present, so
    /// restoring twice is harmless.
    pub(super) fn insert_sleeping(
        &self,
        task_id: &str,
        group: &Group,
        url: &str,
        title: &str,
        favicon: Option<String>,
        place: SleepingPlace<'_>,
    ) -> bool {
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        if tabs
            .values()
            .any(|tab| tab.state.task_id == task_id && tab.state.url == url)
        {
            return false;
        }
        let id = format!("tab-{}", self.sequence.fetch_add(1, Ordering::Relaxed) + 1);
        let label = format!("browser-{id}");
        let SleepingPlace {
            window,
            order,
            touched_at,
        } = place;
        // The touch the row carries, not now: a tab that came back asleep was
        // not touched by coming back, and cleanup measures from here.
        let touched_at = touched_at.unwrap_or_else(chrono::Utc::now);
        let touched = (chrono::Utc::now() - touched_at)
            .to_std()
            .ok()
            .and_then(|ago| std::time::Instant::now().checked_sub(ago))
            .unwrap_or_else(std::time::Instant::now);
        tabs.insert(
            id.clone(),
            Tab {
                state: BrowserTab {
                    id,
                    task_id: task_id.to_string(),
                    group_id: group.id.clone(),
                    group_name: group.name.clone(),
                    group_kind: group.kind,
                    url: url.to_string(),
                    title: title.to_string(),
                    favicon,
                    loading: false,
                    popped_out: window.is_some(),
                    hidden: true,
                    held_by: None,
                    agent_protected_until: None,
                    sleeping: true,
                    delegation_id: None,
                },
                label,
                window: window.map(str::to_owned),
                order,
                placement_slot: None,
                held: None,
                held_task: None,
                user_at: None,
                grants: HashMap::new(),
                generation: 0,
                touched,
                touched_at,
                credential_at: None,
                poster: None,
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
    // A tab that sleeps in a pop-out window wakes there, not in main: the
    // window's renderer is the one about to place it, and a bounce through
    // main would need a reparent on the way.
    let window = match state.window_of(tab_id) {
        Some(label) => super::popout::ensure_window(app, Some(&label), None)?,
        None => app
            .get_window("main")
            .ok_or_else(|| unavailable("the main window is not available"))?,
    };
    let task_id = state
        .task_of(tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let webview = window
        .add_child(
            tab_webview_builder(app, state, tab_id, &label, target, &task_id),
            super::parked().0,
            super::parked().1,
        )
        .map_err(|error| unavailable(format!("could not open that tab: {error}")))?;
    // A sleeping tab may be woken by an agent while another chat is visible.
    // Keep the live document hidden until its owning renderer claims a slot.
    if let Err(error) = webview.hide() {
        let _ = webview.close();
        return Err(unavailable(format!(
            "could not hide the restored browser tab: {error}"
        )));
    }
    let tab = state
        .update(tab_id, |tab| {
            tab.sleeping = false;
            tab.loading = !is_blank(target);
        })
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    emit_changed(app, state);
    Ok(tab)
}
