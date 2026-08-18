//! Which browser window is under the pointer during a tab drag.
//!
//! A drag is driven by the window it started in; that renderer draws the
//! ghost and asks, frame by frame, what is under the pointer. Only the host
//! knows where the other windows are, so it answers here and tells the window
//! under the pointer (`browser://drag-over`) so it can open a gap, and the
//! one the pointer just left (`browser://drag-leave`) so it can close it.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::command_api::CommandResult;

use super::{BrowserTabs, popout::POPOUT_WINDOW_PREFIX};

/// Sent to the window under a dragged tab, every frame it is. `x` is the
/// pointer's horizontal position inside that window, in its logical pixels.
pub const BROWSER_DRAG_OVER_EVENT: &str = "browser://drag-over";
/// Sent once to a window a dragged tab has just left, or was over when the
/// drag ended.
pub const BROWSER_DRAG_LEAVE_EVENT: &str = "browser://drag-leave";

/// The band across the top of a pop-out window that reads as its tab strip,
/// in logical pixels. A drop there takes a strip position; a drop lower down
/// appends.
pub const STRIP_HEIGHT: f64 = 40.0;

/// The label under the pointer as of the last hit-test, so the next one can
/// tell that window the drag has moved on.
static DRAG_OVER: Mutex<Option<String>> = Mutex::new(None);

/// One window as the hit-test sees it: its outer rectangle in physical
/// screen pixels, and the scale that turns logical strip height into them.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WindowRect {
    pub(crate) label: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) scale: f64,
}

/// What is under the pointer.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DragHit {
    /// `"main"`, a pop-out window's label, or nothing.
    pub target: Option<String>,
    /// Over the top band of a pop-out window, where the strip is. Always
    /// false for main and for no window.
    pub strip: bool,
}

/// The first window in `windows` containing the point, in physical screen
/// pixels. The order is the caller's answer to z-order: most recently
/// focused first, main last.
pub(crate) fn hit_test(windows: &[WindowRect], x: f64, y: f64) -> DragHit {
    for window in windows {
        let inside = x >= window.x
            && y >= window.y
            && x < window.x + window.width
            && y < window.y + window.height;
        if !inside {
            continue;
        }
        let strip = window.label != "main" && (y - window.y) < STRIP_HEIGHT * window.scale;
        return DragHit {
            target: Some(window.label.clone()),
            strip,
        };
    }
    DragHit {
        target: None,
        strip: false,
    }
}

/// The pointer's x inside a window, in that window's logical pixels.
fn local_x(window: &WindowRect, x: f64) -> f64 {
    (x - window.x) / window.scale.max(f64::EPSILON)
}

fn window_rect(app: &AppHandle, label: &str) -> Option<WindowRect> {
    let window = app.get_window(label)?;
    if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return None;
    }
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let scale = window.scale_factor().unwrap_or(1.0);
    Some(WindowRect {
        label: label.to_string(),
        x: f64::from(position.x),
        y: f64::from(position.y),
        width: f64::from(size.width),
        height: f64::from(size.height),
        scale,
    })
}

/// Every browser window and main, front-most first as best the host can
/// tell: Tauri has no z-order to ask for, so the focus order stands in for
/// it, then any pop-out never focused, then main.
fn stacked_windows(app: &AppHandle, tabs: &BrowserTabs) -> Vec<WindowRect> {
    let mut labels = tabs.windows_by_focus();
    for label in app.webview_windows().into_keys() {
        if label.starts_with(POPOUT_WINDOW_PREFIX) && !labels.contains(&label) {
            labels.push(label);
        }
    }
    labels.push("main".to_string());
    labels
        .iter()
        .filter_map(|label| window_rect(app, label))
        .collect()
}

fn set_drag_over(app: &AppHandle, next: Option<(String, f64)>) {
    let previous = {
        let mut over = DRAG_OVER.lock().unwrap_or_else(|error| error.into_inner());
        std::mem::replace(&mut *over, next.as_ref().map(|(label, _)| label.clone()))
    };
    if let Some(previous) = previous
        && next.as_ref().is_none_or(|(label, _)| *label != previous)
    {
        let _ = app.emit_to(previous.as_str(), BROWSER_DRAG_LEAVE_EVENT, ());
    }
    if let Some((label, x)) = next {
        let _ = app.emit_to(
            label.as_str(),
            BROWSER_DRAG_OVER_EVENT,
            serde_json::json!({ "label": label, "x": x }),
        );
    }
}

/// Which window a dragged tab is over. `x`, `y` are physical screen pixels:
/// the renderer sends `screenX * devicePixelRatio`. Tells that window, and
/// the one the pointer just left, so each can draw the right thing.
#[tauri::command]
pub fn browser_drag_hit_test(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    x: f64,
    y: f64,
) -> CommandResult<DragHit> {
    let windows = stacked_windows(&app, &state);
    let hit = hit_test(&windows, x, y);
    let over = hit.target.as_ref().and_then(|label| {
        windows
            .iter()
            .find(|window| window.label == *label)
            .map(|window| (label.clone(), local_x(window, x)))
    });
    set_drag_over(&app, over);
    Ok(hit)
}

/// The drag is over (dropped or cancelled): whatever window was under it is
/// told the pointer left.
#[tauri::command]
pub fn browser_drag_end(app: AppHandle) -> CommandResult<()> {
    set_drag_over(&app, None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(label: &str, x: f64, y: f64, width: f64, height: f64, scale: f64) -> WindowRect {
        WindowRect {
            label: label.into(),
            x,
            y,
            width,
            height,
            scale,
        }
    }

    #[test]
    fn the_front_most_window_under_the_pointer_wins() {
        let front = rect("browser-window-a", 100.0, 100.0, 400.0, 300.0, 1.0);
        let behind = rect("browser-window-b", 300.0, 100.0, 400.0, 300.0, 1.0);
        let main = rect("main", 0.0, 0.0, 2000.0, 1200.0, 1.0);
        let stack = [front, behind, main];
        assert_eq!(
            hit_test(&stack, 350.0, 200.0).target.as_deref(),
            Some("browser-window-a")
        );
        assert_eq!(
            hit_test(&stack, 600.0, 200.0).target.as_deref(),
            Some("browser-window-b")
        );
        assert_eq!(hit_test(&stack, 50.0, 50.0).target.as_deref(), Some("main"));
        assert_eq!(hit_test(&stack, 2500.0, 50.0).target, None);
    }

    #[test]
    fn the_strip_band_scales_with_the_window_and_main_has_none() {
        let hidpi = rect("browser-window-a", 0.0, 0.0, 800.0, 600.0, 2.0);
        let main = rect("main", 1000.0, 0.0, 800.0, 600.0, 2.0);
        let stack = [hidpi, main];
        // 40 logical px is 80 physical at 2×.
        assert!(hit_test(&stack, 10.0, 79.0).strip);
        assert!(!hit_test(&stack, 10.0, 80.0).strip);
        assert!(!hit_test(&stack, 1010.0, 10.0).strip);
        assert_eq!(
            hit_test(&stack, 1010.0, 10.0).target.as_deref(),
            Some("main")
        );
    }

    #[test]
    fn a_window_reads_the_pointer_in_its_own_logical_pixels() {
        let window = rect("browser-window-a", 1000.0, 0.0, 800.0, 600.0, 2.0);
        assert_eq!(local_x(&window, 1100.0), 50.0);
    }
}
