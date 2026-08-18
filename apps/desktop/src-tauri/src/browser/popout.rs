//! The pop-out browser window.
//!
//! A tab that leaves the pane does not become a bare OS window showing a page.
//! It moves into one window that runs Integrator's own renderer — the same
//! chrome, the same theme, the same address field and annotate control — and
//! keeps its webview, its profile and its guest runtime. Several tabs can live
//! there at once, which is what makes it read as a browser window rather than
//! a detached page.
//!
//! Chats share one window: their tabs already share a cookie profile and a
//! person browsing from several chats wants one strip, not one window per
//! conversation. Every other task keeps a window of its own so two runs never
//! see each other's tabs.
//!
//! Closing a window sends every tab it holds back to the pane. Nothing about
//! popping out changes what an agent may do: the tabs keep their ids and their
//! task, so a run in flight carries on across the move.

use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    sync::Arc,
};

use integrator_core::{TaskId, TaskKind};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl};
use url::form_urlencoded;

use crate::command_api::{CommandError, CommandResult};

use super::{BrowserTab, BrowserTabs, emit_changed, parked, require_task, unavailable, webview_of};

/// Label of the window that hosts popped-out tabs. Scoped in
/// `capabilities/default.json` so its renderer reaches the app commands.
pub const POPOUT_WINDOW_PREFIX: &str = "browser-window-";
/// The one window every chat's popped tabs share.
pub const CHAT_WINDOW_LABEL: &str = "browser-window-chat";

/// The window a non-chat task's popped tabs live in. One window per task
/// prevents two runs from sharing a tab strip.
pub(crate) fn window_label(task_id: &str) -> String {
    let mut hash = DefaultHasher::new();
    task_id.hash(&mut hash);
    format!("{POPOUT_WINDOW_PREFIX}{:016x}", hash.finish())
}

/// Whether the task is a chat, per the store. Unknown tasks are not.
pub(crate) fn task_is_chat<R: Runtime>(app: &AppHandle<R>, task_id: &str) -> bool {
    let Ok(id) = task_id.parse::<TaskId>() else {
        return false;
    };
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return false;
    };
    matches!(
        state.store.get_task(id).ok().map(|task| task.kind),
        Some(TaskKind::Chat)
    )
}

/// The label of the window this task's popped tabs go to: the shared chat
/// window for a chat, a window of its own for anything else.
pub(crate) fn window_label_for<R: Runtime>(app: &AppHandle<R>, task_id: &str) -> String {
    label_for(task_id, task_is_chat(app, task_id))
}

/// Pure form of [`window_label_for`], with the chat lookup already done.
pub(crate) fn label_for(task_id: &str, is_chat: bool) -> String {
    if is_chat {
        CHAT_WINDOW_LABEL.to_string()
    } else {
        window_label(task_id)
    }
}

/// Whether a renderer running under this native label may address the task.
/// The chat window may address any chat; a hashed window only its own task.
pub(crate) fn window_may_address_task(label: &str, task_id: &str, task_is_chat: bool) -> bool {
    if label == CHAT_WINDOW_LABEL {
        task_is_chat
    } else {
        label == window_label(task_id)
    }
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
    let label = window_label_for(app, task_id);
    if let Some(window) = app.get_window(&label) {
        focus_window(&window)?;
        return Ok(window);
    }
    // The query tells the renderer which surface to draw before React runs.
    // The chat window is not bound to one task, so it carries a scope instead.
    let mut query = form_urlencoded::Serializer::new(String::new());
    query.append_pair("surface", "browser");
    if label == CHAT_WINDOW_LABEL {
        query.append_pair("scope", "chat");
    } else {
        query.append_pair("taskId", task_id);
    }
    let query = query.finish();
    let window = tauri::WebviewWindowBuilder::new(
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
    let close_label = label.clone();
    window.on_window_event(move |event| {
        let tauri::WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };
        // Reparent while the source HWND/NSWindow still exists. Destroying the
        // host first also destroys its children and makes docking impossible.
        api.prevent_close();
        let app = close_app.clone();
        let label = close_label.clone();
        tauri::async_runtime::spawn(async move {
            dock_popped_out_in_window(&app, &label);
        });
    });
    let window = window.as_ref().window();
    focus_window(&window)?;
    Ok(window)
}

/// The popped tabs that live in the window with this label.
fn popped_tabs_in_window(app: &AppHandle, tabs: &BrowserTabs, label: &str) -> Vec<BrowserTab> {
    tabs.snapshot(None)
        .into_iter()
        .filter(|tab| tab.popped_out && window_label_for(app, &tab.task_id) == label)
        .collect()
}

/// Sends every popped tab in a browser window back when that window closes.
pub fn dock_popped_out_in_window(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<Arc<BrowserTabs>>() else {
        return;
    };
    let tabs = Arc::clone(&state);
    for tab in popped_tabs_in_window(app, &tabs, label) {
        let _ = move_tab(app, &tabs, &tab.id, false, false);
    }
}

/// Hides the window a task's popped tabs would live in once nothing is left
/// in it. Judged per window: a chat window with another chat's tabs still open
/// stays up.
pub(super) fn hide_window_if_empty(app: &AppHandle, tabs: &BrowserTabs, task_id: &str) {
    let label = window_label_for(app, task_id);
    if popped_tabs_in_window(app, tabs, &label).is_empty()
        && let Some(window) = app.get_window(&label)
    {
        let _ = window.hide();
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
        app.get_window(&window_label_for(app, &current.task_id))
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
    if !popped_out {
        hide_window_if_empty(app, state, &current.task_id);
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

/// The numeric part of a `tab-N` id, so a strip orders by creation and not by
/// string (`tab-10` after `tab-9`).
fn tab_sequence(id: &str) -> u64 {
    id.rsplit('-')
        .next()
        .and_then(|part| part.parse().ok())
        .unwrap_or(u64::MAX)
}

/// The popped-out tabs that belong to the calling window, judged by its
/// trusted native label: the chat window sees every chat's popped tabs, a
/// task window its own task's, and anything else sees none.
#[tauri::command]
pub fn browser_popout_tabs(
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<BrowserTabs>>,
) -> CommandResult<Vec<BrowserTab>> {
    let label = webview.label();
    if !label.starts_with(POPOUT_WINDOW_PREFIX) {
        return Ok(Vec::new());
    }
    let app = webview.app_handle();
    let mut tabs: Vec<BrowserTab> = state
        .snapshot(None)
        .into_iter()
        .filter(|tab| tab.popped_out)
        .filter(|tab| {
            if label == CHAT_WINDOW_LABEL {
                task_is_chat(app, &tab.task_id)
            } else {
                window_label(&tab.task_id) == label
            }
        })
        .collect();
    tabs.sort_by_key(|tab| tab_sequence(&tab.id));
    Ok(tabs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chats_share_one_window_and_other_tasks_get_their_own() {
        assert_eq!(label_for("task-a", true), CHAT_WINDOW_LABEL);
        assert_eq!(label_for("task-b", true), CHAT_WINDOW_LABEL);
        assert_eq!(label_for("task-a", false), window_label("task-a"));
        assert_ne!(label_for("task-a", false), label_for("task-b", false));
        assert!(CHAT_WINDOW_LABEL.starts_with(POPOUT_WINDOW_PREFIX));
    }

    #[test]
    fn the_chat_window_addresses_chats_and_a_task_window_only_its_task() {
        assert!(window_may_address_task(CHAT_WINDOW_LABEL, "task-a", true));
        assert!(!window_may_address_task(CHAT_WINDOW_LABEL, "task-a", false));
        assert!(window_may_address_task(
            &window_label("task-a"),
            "task-a",
            false
        ));
        assert!(!window_may_address_task(
            &window_label("task-b"),
            "task-a",
            false
        ));
        assert!(!window_may_address_task("main", "task-a", true));
    }

    #[test]
    fn popped_tabs_order_by_creation_sequence() {
        let mut ids = vec!["tab-10", "tab-2", "tab-9"];
        ids.sort_by_key(|id| tab_sequence(id));
        assert_eq!(ids, vec!["tab-2", "tab-9", "tab-10"]);
    }
}
