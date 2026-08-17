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

use std::sync::Arc;

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use url::Url;

use crate::command_api::CommandError;

use super::{BrowserTabs, dock_tab, tab_webview_builder, unavailable};

/// Label of the window that hosts popped-out tabs. Scoped in
/// `capabilities/default.json` so its renderer reaches the app commands.
pub const POPOUT_WINDOW: &str = "browser-window";

/// Creates the window on first use and returns it. The renderer decides what
/// to draw from the window label, so nothing has to be passed in.
pub fn ensure_window(app: &AppHandle) -> Result<tauri::Window, CommandError> {
    if let Some(window) = app.get_window(POPOUT_WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(window);
    }
    let window =
        // The query tells the renderer which surface to draw before React runs.
        tauri::WebviewWindowBuilder::new(
            app,
            POPOUT_WINDOW,
            WebviewUrl::App("index.html?surface=browser".into()),
        )
            .title("Integrator Browser")
            .inner_size(1180.0, 820.0)
            .min_inner_size(520.0, 360.0)
            .decorations(false)
            .build()
            .map_err(|error| unavailable(format!("could not open the browser window: {error}")))?;

    let close_app = app.clone();
    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::Destroyed) {
            return;
        }
        let app = close_app.clone();
        tauri::async_runtime::spawn(async move {
            dock_all_popped_out(&app);
        });
    });
    Ok(window.as_ref().window())
}

/// Sends every popped-out tab back to the pane. Used when the window closes,
/// by the control that closes it, and on the way out of a session.
pub fn dock_all_popped_out(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<BrowserTabs>>() else {
        return;
    };
    let tabs = Arc::clone(&state);
    for tab in tabs.snapshot(None).into_iter().filter(|tab| tab.popped_out) {
        let Some(label) = tabs.label_for(&tab.id) else {
            continue;
        };
        let Ok(target) = Url::parse(&tab.url) else {
            continue;
        };
        let _ = dock_tab(app, &tabs, &tab.id, &label, &target);
    }
}

/// Moves one tab's webview from the pane into the pop-out window.
pub fn adopt(
    app: &AppHandle,
    state: &Arc<BrowserTabs>,
    id: &str,
    label: &str,
    target: &Url,
) -> Result<(), CommandError> {
    let window = ensure_window(app)?;
    window
        .add_child(
            tab_webview_builder(app, state, id, label, target),
            // The shell reports the real rectangle as soon as it mounts; until
            // then the tab sits out of the way rather than covering the chrome.
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| unavailable(format!("could not move the tab: {error}")))?;
    state.update(id, |tab| {
        tab.popped_out = true;
        tab.hidden = true;
    });
    super::emit_changed(app, state);
    Ok(())
}
