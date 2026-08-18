//! The tab's overflow menu, drawn by the OS.
//!
//! A native page is a child webview: it paints above everything the renderer
//! draws, so an HTML menu dropped over it is hidden — or the page has to be
//! parked to make room, which blanks the very thing the person is looking at.
//! An OS context menu sits above child webviews by construction, so the page
//! stays put and the menu opens over it, the way a browser's own menus do.
//!
//! The renderer owns the entries: it says what the menu holds and reads the
//! pick back as an event, so the native side knows nothing about what "reload"
//! or "save this login" mean and cannot be talked into doing either by a page.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{
    Emitter, EventTarget, LogicalPosition, Manager, Position, Runtime,
    menu::{Menu, MenuItemBuilder, PredefinedMenuItem},
};

use crate::command_api::{CommandError, CommandResult};

use super::{BrowserTabs, require_renderer_task, require_task, unavailable};

/// Fired at the renderer that opened the menu, once, with what was picked.
pub const BROWSER_MENU_PICK_EVENT: &str = "browser://menu-pick";
/// Menu item ids carry the tab they were built for, so a stale pick (menu
/// opened on one tab, answered after a switch) can be told from a live one.
const ITEM_PREFIX: &str = "integrator-browser-menu\u{1f}";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserMenuEntry {
    /// The renderer's own name for the entry; handed back verbatim on pick.
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    /// A rule between groups; `id` and `label` are ignored.
    #[serde(default)]
    pub separator: bool,
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserMenuPick {
    pub task_id: String,
    pub tab_id: String,
    pub item_id: String,
}

/// Menu item id → the pick it stands for, if it is one of ours.
fn pick_from_item_id(id: &str) -> Option<BrowserMenuPick> {
    let rest = id.strip_prefix(ITEM_PREFIX)?;
    let mut parts = rest.splitn(3, '\u{1f}');
    let task_id = parts.next()?.to_owned();
    let tab_id = parts.next()?.to_owned();
    let item_id = parts.next()?.to_owned();
    Some(BrowserMenuPick {
        task_id,
        tab_id,
        item_id,
    })
}

fn item_id(task_id: &str, tab_id: &str, entry_id: &str) -> String {
    format!("{ITEM_PREFIX}{task_id}\u{1f}{tab_id}\u{1f}{entry_id}")
}

/// Routes this window's menu picks to the renderer that asked. Registering
/// replaces any earlier handler for the window, so calling it per menu is
/// idempotent rather than cumulative.
fn route_picks_to<R: Runtime>(window: &tauri::Window<R>, renderer_label: String) {
    window.on_menu_event(move |window, event| {
        let Some(pick) = pick_from_item_id(&event.id().0) else {
            return;
        };
        let _ = window.app_handle().emit_to(
            EventTarget::webview(renderer_label.clone()),
            BROWSER_MENU_PICK_EVENT,
            pick,
        );
    });
}

/// Opens the tab's overflow menu at a point in the window, in logical pixels
/// from the window's top-left. Returns once the menu has closed; the pick, if
/// any, arrives separately as an event.
#[tauri::command]
pub async fn browser_tab_menu(
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    task_id: String,
    tab_id: String,
    x: f64,
    y: f64,
    items: Vec<BrowserMenuEntry>,
) -> CommandResult<()> {
    require_task(&state, &task_id, &tab_id)?;
    require_renderer_task(&webview, &task_id)?;
    if items.is_empty() || items.len() > 32 {
        return Err(unavailable("that menu has nothing to show"));
    }
    let app = webview.app_handle().clone();
    let window = webview.window();
    let menu = Menu::new(&app).map_err(menu_error)?;
    for entry in items {
        if entry.separator {
            let rule = PredefinedMenuItem::separator(&app).map_err(menu_error)?;
            menu.append(&rule).map_err(menu_error)?;
            continue;
        }
        let label: String = entry.label.chars().take(80).collect();
        let entry_id: String = entry.id.chars().take(64).collect();
        if label.is_empty() || entry_id.is_empty() {
            continue;
        }
        let item = MenuItemBuilder::with_id(item_id(&task_id, &tab_id, &entry_id), label)
            .enabled(entry.enabled)
            .build(&app)
            .map_err(menu_error)?;
        menu.append(&item).map_err(menu_error)?;
    }
    route_picks_to(&window, webview.label().to_owned());
    // Blocks this task, not the UI: the OS runs the menu's own loop on the
    // main thread and the page keeps painting under it.
    window
        .popup_menu_at(&menu, Position::Logical(LogicalPosition::new(x, y)))
        .map_err(menu_error)?;
    Ok(())
}

fn menu_error(error: tauri::Error) -> CommandError {
    unavailable(format!("could not open the tab menu: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_round_trip_through_item_ids() {
        let id = item_id("task-1", "tab-9", "reload");
        let pick = pick_from_item_id(&id).expect("ours");
        assert_eq!(pick.task_id, "task-1");
        assert_eq!(pick.tab_id, "tab-9");
        assert_eq!(pick.item_id, "reload");
        assert!(pick_from_item_id("something-else").is_none());
        // A renderer id may carry the separator character; it stays whole.
        let odd = item_id("t", "b", "a\u{1f}b");
        assert_eq!(pick_from_item_id(&odd).expect("ours").item_id, "a\u{1f}b");
    }

    #[test]
    fn entries_default_to_enabled() {
        let entry: BrowserMenuEntry =
            serde_json::from_str(r#"{"id":"copy","label":"Copy address"}"#).expect("parses");
        assert!(entry.enabled);
        assert!(!entry.separator);
        let rule: BrowserMenuEntry = serde_json::from_str(r#"{"separator":true}"#).expect("parses");
        assert!(rule.separator);
    }
}
