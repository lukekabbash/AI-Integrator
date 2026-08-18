//! The pop-out browser window.
//!
//! A tab that leaves the pane does not become a bare OS window showing a page.
//! It moves into one window that runs Integrator's own renderer — the same
//! chrome, the same theme, the same address field and annotate control — and
//! keeps its webview, its profile and its guest runtime. Several tabs can live
//! there at once, which is what makes it read as a browser window rather than
//! a detached page.
//!
//! Closing that window sends every tab it holds back to the pane. Nothing about
//! popping out changes what an agent may do: the tabs keep their ids and their
//! task, so a run in flight carries on across the move.

use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    sync::Arc,
};

use tauri::{AppHandle, Manager, WebviewUrl};
use url::form_urlencoded;

use crate::command_api::{CommandError, CommandResult};

use super::{BrowserTab, BrowserTabs, emit_changed, parked, require_task, unavailable, webview_of};

/// Label of the window that hosts popped-out tabs. Scoped in
/// `capabilities/default.json` so its renderer reaches the app commands.
pub const POPOUT_WINDOW_PREFIX: &str = "browser-window-";

/// One popout window per task prevents two chats from sharing a tab strip.
pub(crate) fn window_label(task_id: &str) -> String {
    let mut hash = DefaultHasher::new();
    task_id.hash(&mut hash);
    format!("{POPOUT_WINDOW_PREFIX}{:016x}", hash.finish())
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

/// Creates this task's window on first use and brings an existing one forward.
pub fn ensure_window(app: &AppHandle, task_id: &str) -> Result<tauri::Window, CommandError> {
    let label = window_label(task_id);
    if let Some(window) = app.get_window(&label) {
        focus_window(&window)?;
        return Ok(window);
    }
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("surface", "browser")
        .append_pair("taskId", task_id)
        .finish();
    let window =
        // The query tells the renderer which surface to draw before React runs.
        tauri::WebviewWindowBuilder::new(
            app,
            &label,
            WebviewUrl::App(format!("index.html?{query}").into()),
        )
            .title("Integrator Browser")
            .inner_size(1180.0, 820.0)
            .min_inner_size(520.0, 360.0)
            .decorations(false)
            .build()
            .map_err(|error| unavailable(format!("could not open the browser window: {error}")))?;

    let close_app = app.clone();
    let close_task_id = task_id.to_string();
    window.on_window_event(move |event| {
        let tauri::WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };
        // Reparent while the source HWND/NSWindow still exists. Destroying the
        // host first also destroys its children and makes docking impossible.
        api.prevent_close();
        let app = close_app.clone();
        let task_id = close_task_id.clone();
        tauri::async_runtime::spawn(async move {
            dock_popped_out_for_task(&app, &task_id);
        });
    });
    let window = window.as_ref().window();
    focus_window(&window)?;
    Ok(window)
}

/// Sends this task's popped tabs back when its browser window closes.
pub fn dock_popped_out_for_task(app: &AppHandle, task_id: &str) {
    let Some(state) = app.try_state::<Arc<BrowserTabs>>() else {
        return;
    };
    let tabs = Arc::clone(&state);
    for tab in tabs
        .snapshot(Some(task_id))
        .into_iter()
        .filter(|tab| tab.popped_out)
    {
        let _ = move_tab(app, &tabs, &tab.id, false, false);
    }
}

/// Moves one live child webview without navigating or rebuilding it. If
/// parking fails after reparenting, it is returned to its original host.
fn move_tab(
    app: &AppHandle,
    state: &Arc<BrowserTabs>,
    id: &str,
    popped_out: bool,
    focus: bool,
) -> Result<BrowserTab, CommandError> {
    let current = state
        .snapshot(None)
        .into_iter()
        .find(|tab| tab.id == id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    if current.popped_out == popped_out {
        if popped_out && focus {
            let _ = ensure_window(app, &current.task_id)?;
        }
        return Ok(current);
    }
    let label = state
        .label_for(id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let source = if current.popped_out {
        app.get_window(&window_label(&current.task_id))
    } else {
        app.get_window("main")
    }
    .ok_or_else(|| unavailable("the browser tab's current window is not available"))?;
    let target = if popped_out {
        ensure_window(app, &current.task_id)?
    } else {
        app.get_window("main")
            .ok_or_else(|| unavailable("the main window is not available"))?
    };
    let webview = webview_of(app, &label)?;
    webview
        .reparent(&target)
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
    let tab = state
        .update(id, |tab| {
            tab.popped_out = popped_out;
            tab.hidden = true;
        })
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    emit_changed(app, state);
    if !popped_out
        && !state
            .snapshot(Some(&current.task_id))
            .iter()
            .any(|candidate| candidate.popped_out)
        && let Some(window) = app.get_window(&window_label(&current.task_id))
    {
        let _ = window.hide();
    }
    Ok(tab)
}

/// Moves a tab without losing history, scroll position, form state, or an
/// in-flight agent interaction.
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
    move_tab(&app, &state, &tab_id, popped_out, true)
}
