//! Retiring popped-out tabs while the app runs.
//!
//! Once an hour the store retires popped-out rows that went untouched past
//! the stale window, or that lie beyond the cap: they move to "Recently
//! closed". A row the store retires may still be a live tab here. One that is
//! asleep or parked with no one driving it is closed to match; one that is on
//! screen, or that an agent drove inside the hold window, is kept and its row
//! written straight back — the person is looking at it, and cleanup exists to
//! tidy behind them, not in front of them.

use std::sync::Arc;

use chrono::Utc;
use integrator_core::TaskId;
use session_store::StoredRecentTab;
use tauri::{AppHandle, Manager};

use super::{
    BrowserTabs, groups,
    restore::{
        DEFAULT_POPOUT_MAX_TABS, DEFAULT_POPOUT_STALE_DAYS, POPOUT_MAX_TABS_SETTING,
        POPOUT_STALE_DAYS_SETTING,
    },
    setting_u64,
};

/// What to do about the rows the store retired: close these tabs, and write
/// these tasks back because a retired row of theirs is still in use. Pure
/// over the registry so the split can be checked with a fixture.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Plan {
    pub(crate) close: Vec<String>,
    pub(crate) rewrite: Vec<String>,
}

pub(crate) fn plan(tabs: &BrowserTabs, retired: &[StoredRecentTab]) -> Plan {
    let mut plan = Plan::default();
    for row in retired {
        let task = row.task_id.to_string();
        let Some(id) = tabs.find_by_url(&task, &row.url) else {
            continue;
        };
        if tabs.retirable(&id) {
            plan.close.push(id);
        } else if !plan.rewrite.contains(&task) {
            plan.rewrite.push(task);
        }
    }
    plan
}

/// One cleanup pass. Touch times are flushed first so the store's view of
/// "untouched" is the live one.
pub(super) fn run(app: &AppHandle) {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return;
    };
    let Some(tabs) = app.try_state::<Arc<BrowserTabs>>() else {
        return;
    };
    let tabs = Arc::clone(&tabs);
    super::persist::flush_touches(app, &tabs);

    let now = Utc::now();
    let stale_days = setting_u64(app, POPOUT_STALE_DAYS_SETTING, DEFAULT_POPOUT_STALE_DAYS);
    let max_tabs = setting_u64(app, POPOUT_MAX_TABS_SETTING, DEFAULT_POPOUT_MAX_TABS);
    let before = now - chrono::Duration::days(i64::try_from(stale_days).unwrap_or(i64::MAX));
    let store = Arc::clone(&state.store);
    let group_of = move |task: TaskId| groups::resolve_group(&store, &task.to_string()).id;
    let Ok(retired) = state.store.retire_stale_browser_tabs(
        before,
        usize::try_from(max_tabs).unwrap_or(usize::MAX),
        now,
        &group_of,
    ) else {
        return;
    };
    let plan = plan(&tabs, &retired);
    for id in plan.close {
        // The store already recorded why the row went; no second entry.
        let _ = super::close_tab_with(app, &tabs, &id, false);
    }
    for task in plan.rewrite {
        super::remember::remember(app, &tabs, &task);
    }
}
