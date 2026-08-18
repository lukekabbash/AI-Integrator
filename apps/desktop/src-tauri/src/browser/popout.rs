//! Pop-out browser windows.
//!
//! A tab that leaves the pane does not become a bare OS window showing a page.
//! It moves into a window that runs Integrator's own renderer — the same
//! chrome, the same theme, the same address field and annotate control — and
//! keeps its webview, its profile and its guest runtime. Several tabs can live
//! there at once, which is what makes it read as a browser window rather than
//! a detached page.
//!
//! A window is a bag: it is not bound to a task or a chat. Each tab records
//! the window it lives in (`Tab.window`), there may be any number of windows,
//! and a tab moves between them — or back to the pane — without losing its
//! page. Closing a window sends every tab it holds back to the pane. Nothing
//! about popping out changes what an agent may do: the tabs keep their ids and
//! their task, so a run in flight carries on across the move.

use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewUrl};
use url::form_urlencoded;

use crate::command_api::{CommandError, CommandResult};

use super::{
    BrowserTab, BrowserTabs, emit_changed, invalid, parked, require_task, unavailable, webview_of,
};

/// Every pop-out window label starts with this. Scoped in
/// `capabilities/default.json` so its renderer reaches the app commands.
pub const POPOUT_WINDOW_PREFIX: &str = "browser-window-";

/// How long an emptied window is kept, hidden, before it is closed. Long
/// enough for a tab that is on its way (a tear-off target, a move that is
/// mid-flight) to land; short enough that labels do not pile up.
const EMPTY_WINDOW_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// A fresh label for a new window. Random rather than derived from anything,
/// because a window is not tied to a task any more.
pub(crate) fn new_window_label() -> String {
    format!("{POPOUT_WINDOW_PREFIX}{}", uuid::Uuid::new_v4().simple())
}

/// Whether a renderer running under this native label may address the task:
/// a pop-out window may, when it holds at least one of the task's tabs. Any
/// other label may not.
pub(crate) fn window_holds_task(tabs: &BrowserTabs, label: &str, task_id: &str) -> bool {
    label.starts_with(POPOUT_WINDOW_PREFIX) && tabs.window_holds_task(label, task_id)
}

fn focus_window(window: &tauri::Window) -> Result<(), CommandError> {
    if window
        .is_minimized()
        .map_err(|error| unavailable(format!("could not inspect the browser window: {error}")))?
    {
        window.unminimize().map_err(|error| {
            unavailable(format!("could not restore the browser window: {error}"))
        })?;
    }
    // An ordinary top-level window: its tabs are child webviews clipped to it,
    // so it may sit behind the app like any other window. Never always-on-top.
    window
        .show()
        .map_err(|error| unavailable(format!("could not show the browser window: {error}")))?;
    window
        .set_focus()
        .map_err(|error| unavailable(format!("could not focus the browser window: {error}")))
}

/// Brings the window with this label forward, creating it if it does not
/// exist. `None` always creates a fresh window. `at` is a screen point in
/// logical pixels for a new window — a tear-off lands under the pointer.
pub fn ensure_window(
    app: &AppHandle,
    label: Option<&str>,
    at: Option<(f64, f64)>,
) -> Result<tauri::Window, CommandError> {
    if let Some(label) = label
        && let Some(window) = app.get_window(label)
    {
        focus_window(&window)?;
        return Ok(window);
    }
    let label = label.map_or_else(new_window_label, str::to_owned);
    // The query tells the renderer which surface to draw before React runs,
    // and which window it is; nothing about a task.
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("surface", "browser")
        .append_pair("window", &label)
        .finish();
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(format!("index.html?{query}").into()),
    )
    .title("Integrator Browser")
    .inner_size(1180.0, 820.0)
    .min_inner_size(520.0, 360.0)
    .decorations(false);
    if let Some((x, y)) = at {
        // The pointer ends up over the strip, roughly where the dragged tab
        // would sit, rather than at the window's corner.
        builder = builder.position(x - 200.0, y - 20.0);
    }
    let window = builder
        .build()
        .map_err(|error| unavailable(format!("could not open the browser window: {error}")))?;

    let event_app = app.clone();
    let event_label = label.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            // Reparent while the source HWND/NSWindow still exists. Destroying
            // the host first also destroys its children and makes docking
            // impossible.
            api.prevent_close();
            let app = event_app.clone();
            let label = event_label.clone();
            tauri::async_runtime::spawn(async move {
                dock_all_in_window(&app, &label);
                let Some(state) = app.try_state::<Arc<BrowserTabs>>() else {
                    return;
                };
                if state.window_is_empty(&label)
                    && let Some(window) = app.get_window(&label)
                {
                    let _ = window.destroy();
                }
            });
        }
        tauri::WindowEvent::Focused(true) => {
            if let Some(state) = event_app.try_state::<Arc<BrowserTabs>>() {
                state.note_window_focus(&event_label);
            }
        }
        tauri::WindowEvent::Destroyed => {
            if let Some(state) = event_app.try_state::<Arc<BrowserTabs>>() {
                state.forget_window(&event_label);
            }
        }
        _ => {}
    });
    let window = window.as_ref().window();
    if let Some(state) = app.try_state::<Arc<BrowserTabs>>() {
        // A window that has just been made is the one the next pop-out should
        // use, whether or not the OS delivers a focus event for it.
        state.note_window_focus(&label);
    }
    focus_window(&window)?;
    Ok(window)
}

/// Sends every tab in a browser window back to the pane, as when that window
/// closes.
pub fn dock_all_in_window(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<Arc<BrowserTabs>>() else {
        return;
    };
    let tabs = Arc::clone(&state);
    for tab in tabs.snapshot_window(label) {
        let _ = move_tab(app, &tabs, &tab.id, MoveTarget::Main, false);
    }
}

/// Hides a window once nothing is left in it, and closes it a little later if
/// it is still empty then. Hidden rather than closed straight away because a
/// tab may be on its way — a tear-off creates the window before the move
/// lands — and closing under it would lose the drop.
pub(super) fn hide_window_if_empty(app: &AppHandle, tabs: &BrowserTabs, label: &str) {
    if !tabs.window_is_empty(label) {
        return;
    }
    let Some(window) = app.get_window(label) else {
        return;
    };
    let _ = window.hide();
    let app = app.clone();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(EMPTY_WINDOW_TTL).await;
        let Some(state) = app.try_state::<Arc<BrowserTabs>>() else {
            return;
        };
        if state.window_is_empty(&label)
            && let Some(window) = app.get_window(&label)
            && !window.is_visible().unwrap_or(true)
        {
            let _ = window.destroy();
        }
    });
}

/// Where a tab is being moved to.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum MoveTarget {
    /// Back to the main window, into its task's pane.
    Main,
    /// Into a pop-out window: the named one, or a new one when `label` is
    /// `None`. `index` is the strip position (appended when absent); `at` is
    /// where a new window opens, in logical screen pixels.
    Window {
        label: Option<String>,
        index: Option<u32>,
        at: Option<(f64, f64)>,
    },
}

/// The window a tab currently lives in, if it still exists.
fn host_window(
    app: &AppHandle,
    tabs: &BrowserTabs,
    id: &str,
) -> Result<tauri::Window, CommandError> {
    let label = tabs.window_of(id).unwrap_or_else(|| "main".to_string());
    app.get_window(&label)
        .ok_or_else(|| unavailable("the browser tab's current window is not available"))
}

/// Moves one live child webview into another window without navigating or
/// rebuilding it. Moving inside its own window only reorders it. If parking
/// fails after reparenting, it is returned to its original host.
pub(super) fn move_tab(
    app: &AppHandle,
    state: &Arc<BrowserTabs>,
    id: &str,
    target: MoveTarget,
    focus: bool,
) -> Result<BrowserTab, CommandError> {
    let current = state
        .tab(id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let source_label = state.window_of(id);
    let (target_label, index, at) = match target {
        MoveTarget::Main => {
            if source_label.is_none() {
                return Ok(current);
            }
            (None, None, None)
        }
        MoveTarget::Window { label, index, at } => {
            (Some(label.unwrap_or_else(new_window_label)), index, at)
        }
    };
    if source_label == target_label {
        // Same window: a reorder at most.
        let Some(label) = target_label else {
            return Ok(current);
        };
        if let Some(index) = index {
            place_at(state, &label, id, index);
            emit_changed(app, state);
        }
        if focus {
            let _ = ensure_window(app, Some(&label), None)?;
        }
        return state
            .tab(id)
            .ok_or_else(|| unavailable("that browser tab is no longer open"));
    }
    let webview_label = state
        .label_for(id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let source = host_window(app, state, id)?;
    let target_window = match &target_label {
        Some(label) => ensure_window(app, Some(label), at)?,
        None => app
            .get_window("main")
            .ok_or_else(|| unavailable("the main window is not available"))?,
    };
    let webview = webview_of(app, &webview_label)?;
    webview
        .reparent(&target_window)
        .map_err(|error| unavailable(format!("could not move the tab: {error}")))?;
    let (position, size) = parked();
    if let Err(error) = webview.set_bounds(tauri::Rect {
        position: position.into(),
        size: size.into(),
    }) {
        let _ = webview.reparent(&source);
        return Err(unavailable(format!(
            "could not park the moved tab: {error}"
        )));
    }
    if let Err(error) = webview.hide() {
        let _ = webview.reparent(&source);
        if !current.hidden {
            let _ = webview.show();
        }
        return Err(unavailable(format!(
            "could not hide the moved tab: {error}"
        )));
    }
    state.set_placement(id, None);
    let tab = state
        .set_window(id, target_label.as_deref(), None)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let tab = match (&target_label, index) {
        (Some(label), Some(index)) => {
            place_at(state, label, id, index);
            state.tab(id).unwrap_or(tab)
        }
        _ => tab,
    };
    emit_changed(app, state);
    if let Some(source_label) = source_label {
        hide_window_if_empty(app, state, &source_label);
    }
    Ok(tab)
}

/// Puts a tab of this window at a strip position, shifting the rest.
fn place_at(state: &BrowserTabs, label: &str, id: &str, index: u32) {
    let mut ids: Vec<String> = state
        .snapshot_window(label)
        .into_iter()
        .map(|tab| tab.id)
        .filter(|candidate| candidate != id)
        .collect();
    let at = (index as usize).min(ids.len());
    ids.insert(at, id.to_string());
    state.reorder_window(label, &ids);
}

/// Where a tab goes when it is popped out without a named window: where it
/// already is, if it is out; else the window most recently in front that
/// already holds one of its group's tabs; else the window most recently in
/// front; else a new one.
pub(crate) fn preferred_target(tabs: &BrowserTabs, tab_id: &str) -> MoveTarget {
    let label = tabs.window_of(tab_id).or_else(|| {
        tabs.tab(tab_id)
            .and_then(|tab| tabs.preferred_window_for(&tab.group_id))
    });
    MoveTarget::Window {
        label,
        index: None,
        at: None,
    }
}

/// Moves a tab without losing history, scroll position, form state, or an
/// in-flight agent interaction. Sugar over `browser_tab_move`: out goes to
/// the preferred window, in goes home.
#[tauri::command]
pub async fn browser_tab_set_popped_out(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    task_id: String,
    tab_id: String,
    popped_out: bool,
) -> CommandResult<BrowserTab> {
    require_task(&state, &task_id, &tab_id)?;
    super::remember::ensure_awake(&app, &state, &tab_id).await;
    let target = if popped_out {
        preferred_target(&state, &tab_id)
    } else {
        MoveTarget::Main
    };
    move_tab(&app, &state, &tab_id, target, true)
}

/// A screen point in logical pixels, as the renderer sends it.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct ScreenPoint {
    pub x: f64,
    pub y: f64,
}

/// The wire form of [`MoveTarget`]: `{kind:"main"}` or
/// `{kind:"window", label?, index?, at?}`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveTargetArg {
    pub kind: String,
    pub label: Option<String>,
    pub index: Option<u32>,
    pub at: Option<ScreenPoint>,
}

impl MoveTargetArg {
    fn into_target(self, app: &AppHandle) -> Result<MoveTarget, CommandError> {
        match self.kind.as_str() {
            "main" => Ok(MoveTarget::Main),
            "window" => {
                if let Some(label) = &self.label {
                    if !label.starts_with(POPOUT_WINDOW_PREFIX) {
                        return Err(invalid("that is not a browser window"));
                    }
                    if app.get_window(label).is_none() {
                        return Err(unavailable("that browser window is no longer open"));
                    }
                }
                Ok(MoveTarget::Window {
                    label: self.label,
                    index: self.index,
                    at: self.at.map(|point| (point.x, point.y)),
                })
            }
            other => Err(invalid(format!("unknown move target '{other}'"))),
        }
    }
}

/// Moves a tab into a window (an existing one, or a new one at a point), or
/// back to the pane. The tab keeps its page either way.
#[tauri::command]
pub async fn browser_tab_move(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    task_id: String,
    tab_id: String,
    target: MoveTargetArg,
) -> CommandResult<BrowserTab> {
    require_task(&state, &task_id, &tab_id)?;
    let target = target.into_target(&app)?;
    super::remember::ensure_awake(&app, &state, &tab_id).await;
    move_tab(&app, &state, &tab_id, target, true)
}

/// Rewrites the strip order of the calling window. The window is the
/// caller's trusted native label, so one window cannot reorder another's.
#[tauri::command]
pub fn browser_window_reorder(
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    tab_ids: Vec<String>,
) -> CommandResult<()> {
    let label = webview.label();
    if !label.starts_with(POPOUT_WINDOW_PREFIX) {
        return Err(unavailable("only a browser window orders its own strip"));
    }
    if !state.reorder_window(label, &tab_ids) {
        return Err(unavailable("one of those tabs is not in this window"));
    }
    emit_changed(webview.app_handle(), &state);
    Ok(())
}

/// The tabs that live in the calling window, judged by its trusted native
/// label, in strip order. Anything that is not a browser window sees none.
#[tauri::command]
pub fn browser_popout_tabs(
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<BrowserTabs>>,
) -> CommandResult<Vec<BrowserTab>> {
    let label = webview.label();
    if !label.starts_with(POPOUT_WINDOW_PREFIX) {
        return Ok(Vec::new());
    }
    Ok(state.snapshot_window(label))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_window_labels_carry_the_prefix_and_never_repeat() {
        let first = new_window_label();
        let second = new_window_label();
        assert!(first.starts_with(POPOUT_WINDOW_PREFIX));
        assert!(second.starts_with(POPOUT_WINDOW_PREFIX));
        assert_ne!(first, second);
        assert!(first.len() > POPOUT_WINDOW_PREFIX.len() + 16);
    }

    #[test]
    fn a_window_addresses_the_tasks_of_the_tabs_it_holds() {
        let tabs = BrowserTabs::new();
        let label = new_window_label();
        assert!(!window_holds_task(&tabs, &label, "task-a"));
        // The registry helper lives in the parent's tests; a bare insert here
        // says exactly what is being asked of the registry.
        tabs.tabs.lock().unwrap().insert(
            "tab-1".into(),
            super::super::tests::fixture_tab("tab-1", "task-a", None),
        );
        assert!(!window_holds_task(&tabs, &label, "task-a"));
        tabs.set_window("tab-1", Some(&label), None);
        assert!(window_holds_task(&tabs, &label, "task-a"));
        assert!(!window_holds_task(&tabs, &label, "task-b"));
        assert!(!window_holds_task(&tabs, &new_window_label(), "task-a"));
        // The prefix is part of the test: a `main` that somehow held a tab
        // is not a browser window.
        assert!(!window_holds_task(&tabs, "main", "task-a"));
    }
}
