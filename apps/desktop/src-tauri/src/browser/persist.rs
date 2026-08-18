//! The writes that keep pop-out windows and touch times in the store.
//!
//! Tabs are written by `remember` whenever their list changes. Two things
//! change too often for a write each: where a window sits, and when a tab
//! was last touched. Both are debounced here — geometry half a second after
//! the last move, touches every two seconds and only when the stored time is
//! far enough behind. The strip's collapsed groups live on the window row too,
//! written by the window's own renderer through `browser_window_set_collapsed`.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock, atomic::AtomicBool},
    time::Duration,
};

use chrono::{DateTime, Utc};
use serde::Serialize;
use session_store::StoredBrowserWindow;
use tauri::{AppHandle, Manager};

use crate::command_api::CommandResult;

use super::{BrowserTabs, popout::POPOUT_WINDOW_PREFIX, unavailable};

/// How long after the last move or resize a window's geometry is written.
const GEOMETRY_DEBOUNCE: Duration = Duration::from_millis(500);
/// How often touched tasks are flushed to the store.
const TOUCH_FLUSH_EVERY: Duration = Duration::from_secs(2);
/// A tab whose stored touch time is within this of the live one is not
/// rewritten: a click a minute is not worth a row a minute.
pub(super) const TOUCH_WRITE_SLACK: chrono::Duration = chrono::Duration::seconds(60);
/// How often stale and over-cap popped-out tabs are retired while running.
const CLEANUP_EVERY: Duration = Duration::from_secs(60 * 60);

/// Whether the store row for this window is written at all: only rows for
/// windows that exist. Restore reads windows from the store, so a row is not
/// wanted for a window that was never made.
fn is_popout(label: &str) -> bool {
    label.starts_with(POPOUT_WINDOW_PREFIX)
}

/// One counter per window, bumped on every geometry event. The write that
/// runs after the debounce checks it is still the latest; earlier ones stand
/// down.
fn geometry_ticks() -> &'static Mutex<HashMap<String, u64>> {
    static TICKS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    TICKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A window moved, resized or came to the front: write its geometry once it
/// settles. `focused` also updates the window's last-focused time.
pub(super) fn note_window_geometry(app: &AppHandle, label: &str, focused: bool) {
    if !is_popout(label) {
        return;
    }
    let tick = {
        let mut ticks = geometry_ticks()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let tick = ticks.entry(label.to_string()).or_default();
        *tick += 1;
        *tick
    };
    let app = app.clone();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(GEOMETRY_DEBOUNCE).await;
        let latest = geometry_ticks()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&label)
            .copied();
        if latest != Some(tick) {
            return;
        }
        write_window(&app, &label, focused, None);
    });
}

/// The window is gone for good: drop its row so it is not brought back.
pub(super) fn forget_window(app: &AppHandle, label: &str) {
    if !is_popout(label) {
        return;
    }
    geometry_ticks()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(label);
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        let _ = state.store.remove_browser_window(label);
    }
}

/// The stored row for this window, if there is one.
fn stored_window(app: &AppHandle, label: &str) -> Option<StoredBrowserWindow> {
    let state = app.try_state::<crate::state::AppState>()?;
    state
        .store
        .browser_windows()
        .ok()?
        .into_iter()
        .find(|window| window.id == label)
}

/// Writes the window's current geometry (read from the window itself) over
/// its row, keeping the collapsed groups it had unless new ones are given.
/// A window that cannot be read — mid-destroy, say — is left as it was.
fn write_window(app: &AppHandle, label: &str, focused: bool, collapsed: Option<Vec<String>>) {
    let Some(window) = app.get_window(label) else {
        return;
    };
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return;
    };
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let previous = stored_window(app, label);
    let now = Utc::now();
    let row = StoredBrowserWindow {
        id: label.to_string(),
        x: Some(position.x),
        y: Some(position.y),
        width: Some(size.width),
        height: Some(size.height),
        maximized: window.is_maximized().unwrap_or(false),
        monitor: window
            .current_monitor()
            .ok()
            .flatten()
            .and_then(|monitor| monitor.name().cloned()),
        collapsed_groups: collapsed
            .or_else(|| previous.as_ref().map(|row| row.collapsed_groups.clone()))
            .unwrap_or_default(),
        last_focused_at: if focused {
            now
        } else {
            previous.as_ref().map_or(now, |row| row.last_focused_at)
        },
        updated_at: now,
    };
    let _ = state.store.upsert_browser_window(&row);
}

/// What the strip needs back from the store when a window's renderer starts.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWindowState {
    pub collapsed_groups: Vec<String>,
}

/// Records which groups the calling window's strip has folded. The label is
/// the caller's trusted native one, so a window only writes its own row.
#[tauri::command]
pub fn browser_window_set_collapsed(
    webview: tauri::Webview,
    group_ids: Vec<String>,
) -> CommandResult<()> {
    let label = webview.label();
    if !is_popout(label) {
        return Err(unavailable("only a browser window folds its own strip"));
    }
    write_window(webview.app_handle(), label, false, Some(group_ids));
    Ok(())
}

/// The calling window's remembered strip state. A window with no row, or
/// anything that is not a browser window, sees the default.
#[tauri::command]
pub fn browser_window_state(webview: tauri::Webview) -> CommandResult<BrowserWindowState> {
    let label = webview.label();
    if !is_popout(label) {
        return Ok(BrowserWindowState::default());
    }
    Ok(stored_window(webview.app_handle(), label)
        .map(|row| BrowserWindowState {
            collapsed_groups: row.collapsed_groups,
        })
        .unwrap_or_default())
}

/// A tab cleanup retired or the person closed, as the strip lists it under
/// its group pill. Reopening is an ordinary open at the address.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRecentTab {
    pub task_id: String,
    pub url: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favicon: Option<String>,
    pub closed_at: String,
    pub reason: String,
}

/// The newest recently closed tabs of one group, for a browser window's
/// strip. Any other renderer sees none: the pane has its own memory.
#[tauri::command]
pub fn browser_recent_tabs(
    webview: tauri::Webview,
    group_id: String,
    limit: Option<usize>,
) -> CommandResult<Vec<BrowserRecentTab>> {
    if !is_popout(webview.label()) {
        return Ok(Vec::new());
    }
    let Some(state) = webview.app_handle().try_state::<crate::state::AppState>() else {
        return Ok(Vec::new());
    };
    let rows = state
        .store
        .recent_tabs(&group_id, limit.unwrap_or(10).clamp(1, 50))
        .map_err(|error| unavailable(format!("could not read recently closed tabs: {error}")))?;
    Ok(rows
        .into_iter()
        .map(|row| BrowserRecentTab {
            task_id: row.task_id.to_string(),
            url: row.url,
            title: row.title,
            favicon: row.favicon,
            closed_at: row.closed_at.to_rfc3339(),
            reason: row.reason,
        })
        .collect())
}

/// Forgets one group's recently closed tabs.
#[tauri::command]
pub fn browser_recent_tabs_clear(webview: tauri::Webview, group_id: String) -> CommandResult<()> {
    if !is_popout(webview.label()) {
        return Err(unavailable(
            "only a browser window clears its recently closed tabs",
        ));
    }
    let Some(state) = webview.app_handle().try_state::<crate::state::AppState>() else {
        return Ok(());
    };
    state
        .store
        .clear_recent_tabs(Some(&group_id))
        .map_err(|error| unavailable(format!("could not clear recently closed tabs: {error}")))
}

/// Which touched tasks are worth a write: those with a tab whose live touch
/// time is further than the slack from what was last written for it (or was
/// never written). Pure over the two maps so it can be checked without a
/// registry.
pub(super) fn tasks_due_for_touch_write(
    dirty: &[String],
    live: &[(String, String, DateTime<Utc>)],
    written: &HashMap<String, DateTime<Utc>>,
) -> Vec<String> {
    let mut due: Vec<String> = live
        .iter()
        .filter(|(task, _, _)| dirty.contains(task))
        .filter(|(_, tab, at)| {
            written
                .get(tab)
                .is_none_or(|last| (*at - *last).abs() > TOUCH_WRITE_SLACK)
        })
        .map(|(task, _, _)| task.clone())
        .collect();
    due.sort();
    due.dedup();
    due
}

/// One pass of the touch flush: writes the tasks whose touch times drifted.
pub(super) fn flush_touches(app: &AppHandle, tabs: &BrowserTabs) {
    let dirty = tabs.take_dirty_touch();
    if dirty.is_empty() {
        return;
    }
    let live: Vec<(String, String, DateTime<Utc>)> = {
        let guard = tabs.tabs.lock().unwrap_or_else(|error| error.into_inner());
        guard
            .values()
            .map(|tab| {
                (
                    tab.state.task_id.clone(),
                    tab.state.id.clone(),
                    tab.touched_at,
                )
            })
            .collect()
    };
    let written = tabs
        .last_written_touch
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    for task in tasks_due_for_touch_write(&dirty, &live, &written) {
        super::remember::remember(app, tabs, &task);
    }
}

/// Runs once per launch, the first time the main window is focused. Never at
/// boot: bringing windows back while the app is still drawing its own would
/// put them in front of it.
#[derive(Default)]
pub(super) struct RestoreOnce(AtomicBool);

impl RestoreOnce {
    /// True the first time only.
    pub(super) fn claim(&self) -> bool {
        !self.0.swap(true, std::sync::atomic::Ordering::SeqCst)
    }
}

/// Starts everything the browser does on a clock, and arms the one-shot
/// restore. Called once from setup, after the registry and store are managed.
pub fn start_background_tasks(app: AppHandle) {
    let flush_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(TOUCH_FLUSH_EVERY);
        loop {
            interval.tick().await;
            if let Some(tabs) = flush_app.try_state::<Arc<BrowserTabs>>() {
                flush_touches(&flush_app, &tabs);
            }
        }
    });
    let cleanup_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(CLEANUP_EVERY);
        // The first tick fires at once; restore does that pass itself.
        interval.tick().await;
        loop {
            interval.tick().await;
            super::cleanup::run(&cleanup_app);
        }
    });
    let once = Arc::new(RestoreOnce::default());
    if let Some(main) = app.get_window("main") {
        let restore_app = app.clone();
        main.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Focused(true)) && once.claim() {
                let app = restore_app.clone();
                tauri::async_runtime::spawn(async move {
                    super::restore::restore_windows(&app).await;
                });
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_claims_once() {
        let once = RestoreOnce::default();
        assert!(once.claim());
        assert!(!once.claim());
        assert!(!once.claim());
    }

    #[test]
    fn touch_flush_writes_only_tasks_that_drifted() {
        let now = Utc::now();
        let live = vec![
            ("task-a".to_string(), "tab-1".to_string(), now),
            ("task-b".to_string(), "tab-2".to_string(), now),
            ("task-c".to_string(), "tab-3".to_string(), now),
        ];
        let mut written = HashMap::new();
        // a: written 10 s ago — inside the slack, no write.
        written.insert("tab-1".to_string(), now - chrono::Duration::seconds(10));
        // b: written 5 min ago — due.
        written.insert("tab-2".to_string(), now - chrono::Duration::minutes(5));
        // c: never written — due.
        let dirty = vec!["task-a".into(), "task-b".into(), "task-c".into()];
        assert_eq!(
            tasks_due_for_touch_write(&dirty, &live, &written),
            vec!["task-b".to_string(), "task-c".to_string()]
        );
        // A task nobody touched is never written, however stale its row.
        assert!(tasks_due_for_touch_write(&["task-x".to_string()], &live, &written).is_empty());
    }
}
