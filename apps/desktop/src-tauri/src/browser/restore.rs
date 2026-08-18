//! Pop-out windows coming back after a restart.
//!
//! Runs once, on the first time the main window is focused, never at boot.
//! Stale and over-cap tabs are retired first (they move to "Recently
//! closed"), then each window that still has a tab is made at its old place,
//! clamped into a monitor that exists now, and its tabs are registered asleep
//! in their old order. No page loads until a tab is looked at.

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use chrono::Utc;
use integrator_core::TaskId;
use session_store::{StoredBrowserTab, StoredBrowserWindow};
use tauri::{AppHandle, Manager};
use url::Url;

use super::{
    BrowserTabs, emit_changed,
    groups::{self, Group},
    popout::{self, WindowPlacement},
    remember::SleepingPlace,
    setting_u64,
};

/// Days a popped-out tab may go untouched before it is retired.
pub const POPOUT_STALE_DAYS_SETTING: &str = "settings.browser.popoutStaleDays";
pub const DEFAULT_POPOUT_STALE_DAYS: u64 = 7;
/// How many popped-out tabs are kept across all windows.
pub const POPOUT_MAX_TABS_SETTING: &str = "settings.browser.popoutMaxTabs";
pub const DEFAULT_POPOUT_MAX_TABS: u64 = 100;

/// One window per frame, so a burst of restored windows does not stall the
/// UI thread with a run of window creations.
const WINDOW_SPACING: Duration = Duration::from_millis(16);

/// The size a window gets when its remembered one cannot be used.
const DEFAULT_SIZE: (u32, u32) = (1180, 820);

/// A rectangle in physical screen pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Rect {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

impl Rect {
    fn right(self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }
    fn bottom(self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }
    fn overlap(self, other: Rect) -> i64 {
        let width = self.right().min(other.right()) - i64::from(self.x.max(other.x));
        let height = self.bottom().min(other.bottom()) - i64::from(self.y.max(other.y));
        if width <= 0 || height <= 0 {
            0
        } else {
            width * height
        }
    }
    fn area(self) -> i64 {
        i64::from(self.width) * i64::from(self.height)
    }
}

/// The default size, centred on the first monitor.
fn centred_on(monitor: Rect) -> Rect {
    let width = DEFAULT_SIZE.0.min(monitor.width);
    let height = DEFAULT_SIZE.1.min(monitor.height);
    Rect {
        x: monitor.x + ((monitor.width - width) / 2) as i32,
        y: monitor.y + ((monitor.height - height) / 2) as i32,
        width,
        height,
    }
}

/// Puts a remembered rectangle somewhere visible. A rectangle that mostly
/// overlaps a monitor is kept there, shrunk and shifted to fit it; one that
/// no monitor shows a quarter of (an unplugged screen, a moved dock) comes
/// back at the default size centred on the first monitor. With no monitors
/// to ask about, the rectangle is trusted as it is.
pub(crate) fn clamp_to_monitors(rect: Rect, monitors: &[Rect]) -> Rect {
    let Some(first) = monitors.first().copied() else {
        return rect;
    };
    if rect.width == 0 || rect.height == 0 {
        return centred_on(first);
    }
    let best = monitors
        .iter()
        .copied()
        .map(|monitor| (rect.overlap(monitor), monitor))
        .max_by_key(|(overlap, _)| *overlap)
        // A quarter of the window, or a quarter of the monitor: a window
        // larger than the screen it spans is shrunk to it, not recentred.
        .filter(|(overlap, monitor)| *overlap * 4 >= rect.area().min(monitor.area()))
        .map(|(_, monitor)| monitor);
    let Some(monitor) = best else {
        return centred_on(first);
    };
    let width = rect.width.min(monitor.width);
    let height = rect.height.min(monitor.height);
    let max_x = monitor.right() - i64::from(width);
    let max_y = monitor.bottom() - i64::from(height);
    Rect {
        x: i64::from(rect.x).clamp(i64::from(monitor.x), max_x) as i32,
        y: i64::from(rect.y).clamp(i64::from(monitor.y), max_y) as i32,
        width,
        height,
    }
}

/// A stored window's rectangle, or nothing when it never had one.
fn stored_rect(window: &StoredBrowserWindow) -> Option<Rect> {
    Some(Rect {
        x: window.x?,
        y: window.y?,
        width: window.width?,
        height: window.height?,
    })
}

fn monitors_of(app: &AppHandle) -> Vec<Rect> {
    let mut list: Vec<Rect> = Vec::new();
    // Primary first, so the fallback centres there.
    if let Ok(Some(primary)) = app.primary_monitor() {
        list.push(monitor_rect(&primary));
    }
    if let Ok(monitors) = app.available_monitors() {
        for monitor in monitors {
            let rect = monitor_rect(&monitor);
            if !list.contains(&rect) {
                list.push(rect);
            }
        }
    }
    list
}

fn monitor_rect(monitor: &tauri::Monitor) -> Rect {
    Rect {
        x: monitor.position().x,
        y: monitor.position().y,
        width: monitor.size().width,
        height: monitor.size().height,
    }
}

/// The popped-out rows of every task, grouped by window, each window's rows
/// in strip order. Rows with no window are not here by construction.
pub(crate) fn rows_by_window(
    rows: Vec<(TaskId, StoredBrowserTab)>,
) -> BTreeMap<String, Vec<(TaskId, StoredBrowserTab)>> {
    let mut by_window: BTreeMap<String, Vec<(TaskId, StoredBrowserTab)>> = BTreeMap::new();
    for (task, row) in rows {
        let Some(window) = row.window_id.clone() else {
            continue;
        };
        by_window.entry(window).or_default().push((task, row));
    }
    for rows in by_window.values_mut() {
        rows.sort_by_key(|(_, row)| row.window_order.unwrap_or(u32::MAX));
    }
    by_window
}

/// Registers one window's rows asleep, in order. Returns how many were
/// added; a row whose task already has a tab at that address this session
/// is left alone. `group_of` answers each task's group.
pub(crate) fn insert_window_rows(
    tabs: &BrowserTabs,
    window: &str,
    rows: &[(TaskId, StoredBrowserTab)],
    group_of: &dyn Fn(&str) -> Group,
) -> usize {
    let mut added = 0;
    for (index, (task, row)) in rows.iter().enumerate() {
        if Url::parse(&row.url).is_err() {
            continue;
        }
        let task_id = task.to_string();
        let group = group_of(&task_id);
        let favicon = row
            .favicon
            .clone()
            .or_else(|| super::favicon::cached_for_url(&row.url));
        let order = row
            .window_order
            .unwrap_or(u32::try_from(index).unwrap_or(u32::MAX));
        let place = SleepingPlace {
            window: Some(window),
            order,
            touched_at: row.last_touched_at,
        };
        if tabs.insert_sleeping(&task_id, &group, &row.url, &row.title, favicon, place) {
            added += 1;
        }
    }
    added
}

/// Brings back every remembered window that still has a tab. See the module
/// note for the order of things.
pub(super) async fn restore_windows(app: &AppHandle) {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return;
    };
    let Some(tabs) = app.try_state::<Arc<BrowserTabs>>() else {
        return;
    };
    let tabs = Arc::clone(&tabs);
    let store = Arc::clone(&state.store);

    // Cleanup first, so a window whose every tab is stale is never made.
    let now = Utc::now();
    let stale_days = setting_u64(app, POPOUT_STALE_DAYS_SETTING, DEFAULT_POPOUT_STALE_DAYS);
    let max_tabs = setting_u64(app, POPOUT_MAX_TABS_SETTING, DEFAULT_POPOUT_MAX_TABS);
    let before = now - chrono::Duration::days(i64::try_from(stale_days).unwrap_or(i64::MAX));
    let group_store = Arc::clone(&store);
    let group_of = move |task: TaskId| groups::resolve_group(&group_store, &task.to_string()).id;
    let _ = store.retire_stale_browser_tabs(
        before,
        usize::try_from(max_tabs).unwrap_or(usize::MAX),
        now,
        &group_of,
    );

    // Recents for groups whose project is gone go with it. Chat and path
    // groups have no project to lose; the store keeps those.
    if let Ok(projects) = store.list_trusted_projects() {
        let mut keep: Vec<String> = projects
            .into_iter()
            .map(|project| groups::project_group_id(project.id))
            .collect();
        keep.push(groups::CHAT_GROUP_ID.to_string());
        let _ = store.purge_recent_tabs_for_groups_not_in(&keep);
    }

    let (Ok(windows), Ok(rows)) = (store.browser_windows(), store.browser_tabs_all_popped()) else {
        return;
    };
    let by_window = rows_by_window(rows);
    let monitors = monitors_of(app);
    let group_of = |task: &str| groups::group_for_task(app, &tabs, task);
    let mut restored = 0;
    for window in windows {
        let Some(rows) = by_window.get(&window.id) else {
            // A window with nothing left in it is not brought back; its row
            // would only be dropped again when the empty window closed.
            let _ = store.remove_browser_window(&window.id);
            continue;
        };
        let rect = stored_rect(&window).unwrap_or(Rect {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        });
        let rect = clamp_to_monitors(rect, &monitors);
        let placement = WindowPlacement::Restored {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            maximized: window.maximized,
        };
        if popout::restore_window(app, &window.id, placement).is_err() {
            continue;
        }
        restored += insert_window_rows(&tabs, &window.id, rows, &group_of);
        tokio::time::sleep(WINDOW_SPACING).await;
    }
    if restored > 0 {
        emit_changed(app, &tabs);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    const PRIMARY: Rect = rect(0, 0, 1920, 1080);
    const SECOND: Rect = rect(1920, 0, 2560, 1440);

    #[test]
    fn a_rectangle_inside_a_monitor_is_kept() {
        let r = rect(100, 100, 1180, 820);
        assert_eq!(clamp_to_monitors(r, &[PRIMARY, SECOND]), r);
        let on_second = rect(2000, 200, 1180, 820);
        assert_eq!(clamp_to_monitors(on_second, &[PRIMARY, SECOND]), on_second);
    }

    #[test]
    fn a_rectangle_hanging_off_its_monitor_is_shifted_in() {
        // Mostly on the primary but past its right and bottom edges.
        let r = rect(1500, 800, 1180, 820);
        // Overlap: 420 × 280 = 117600 of 967600 — under a quarter, so it is
        // recentred rather than shifted.
        assert_eq!(clamp_to_monitors(r, &[PRIMARY]), centred_on(PRIMARY));
        // Two thirds visible: shifted so it fits.
        let r = rect(1000, 400, 1180, 820);
        assert_eq!(clamp_to_monitors(r, &[PRIMARY]), rect(740, 260, 1180, 820));
    }

    #[test]
    fn a_rectangle_on_an_unplugged_monitor_comes_back_centred() {
        let r = rect(2000, 200, 1180, 820);
        assert_eq!(clamp_to_monitors(r, &[PRIMARY]), rect(370, 130, 1180, 820));
        // A rectangle larger than any monitor shrinks to fit.
        let big = rect(0, 0, 4000, 3000);
        assert_eq!(clamp_to_monitors(big, &[PRIMARY]), rect(0, 0, 1920, 1080));
    }

    #[test]
    fn no_monitors_and_no_size_are_handled() {
        let r = rect(5, 5, 100, 100);
        assert_eq!(clamp_to_monitors(r, &[]), r);
        assert_eq!(
            clamp_to_monitors(rect(5, 5, 0, 0), &[PRIMARY]),
            centred_on(PRIMARY)
        );
    }

    fn stored(url: &str, window: Option<&str>, order: Option<u32>) -> StoredBrowserTab {
        StoredBrowserTab {
            url: url.to_string(),
            title: url.to_string(),
            favicon: None,
            window_id: window.map(str::to_owned),
            window_order: order,
            last_touched_at: None,
        }
    }

    #[test]
    fn rows_group_by_window_in_strip_order_and_pane_rows_drop_out() {
        let task = TaskId::new();
        let rows = vec![
            (
                task,
                stored("https://b.example/", Some("browser-window-1"), Some(1)),
            ),
            (
                task,
                stored("https://a.example/", Some("browser-window-1"), Some(0)),
            ),
            (
                task,
                stored("https://c.example/", Some("browser-window-2"), None),
            ),
            (task, stored("https://pane.example/", None, None)),
        ];
        let by_window = rows_by_window(rows);
        assert_eq!(by_window.len(), 2);
        let first: Vec<&str> = by_window["browser-window-1"]
            .iter()
            .map(|(_, row)| row.url.as_str())
            .collect();
        assert_eq!(first, vec!["https://a.example/", "https://b.example/"]);
        assert_eq!(by_window["browser-window-2"].len(), 1);
    }

    #[test]
    fn restored_rows_sleep_in_their_window_at_their_order() {
        let tabs = BrowserTabs::new();
        let task = TaskId::new();
        let rows = vec![
            (
                task,
                stored("https://b.example/", Some("browser-window-1"), Some(1)),
            ),
            (
                task,
                stored("https://a.example/", Some("browser-window-1"), Some(0)),
            ),
            (task, stored("not a url", Some("browser-window-1"), Some(2))),
        ];
        let group_of = |_: &str| Group::chat();
        assert_eq!(
            insert_window_rows(&tabs, "browser-window-1", &rows, &group_of),
            2
        );
        // Restoring again adds nothing.
        assert_eq!(
            insert_window_rows(&tabs, "browser-window-1", &rows, &group_of),
            0
        );
        // Strip order follows the stored order, not insertion order.
        let strip = tabs.snapshot_window("browser-window-1");
        let urls: Vec<&str> = strip.iter().map(|tab| tab.url.as_str()).collect();
        assert_eq!(urls, vec!["https://a.example/", "https://b.example/"]);
        assert!(
            strip
                .iter()
                .all(|tab| tab.sleeping && tab.popped_out && tab.hidden)
        );
        assert_eq!(
            tabs.window_of(&strip[0].id).as_deref(),
            Some("browser-window-1")
        );
        assert!(tabs.window_holds_task("browser-window-1", &task.to_string()));
    }
}
