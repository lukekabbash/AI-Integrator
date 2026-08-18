//! Asking a tab to photograph itself, rather than photographing the screen.
//!
//! `capture.rs` crops a monitor, which makes a picture only as good as the
//! tab's luck: a window behind another window yields the wrong pixels, and a
//! tab the renderer has parked yields none at all. This path goes to the
//! webview instead — WebView2's `CapturePreview`, WKWebView's `takeSnapshot` —
//! so focus, stacking order and what is covering the window stop mattering.
//! The `unsafe` those APIs need lives in the `webview-capture` crate; this
//! crate keeps its `#![forbid(unsafe_code)]`.
//!
//! `capture_png` returns `None` when the platform cannot do this (Linux) or
//! the attempt failed, which is the caller's signal to fall back to the
//! screen crop rather than to give up.

#[cfg(any(windows, target_os = "macos"))]
use std::time::Duration;

use tauri::Runtime;

/// How long a self-capture may take before the screen crop is used instead.
///
/// The call is a round trip to the webview's own compositor and normally
/// answers in a few tens of milliseconds. The ceiling exists because the
/// Windows path cannot report a failure to start through its completion
/// handler — `CapturePreview` returning an error leaves the handler holding
/// the sender, and this is what collects that case.
#[cfg(any(windows, target_os = "macos"))]
const SELF_CAPTURE_TIMEOUT: Duration = Duration::from_secs(3);

/// PNG bytes of the tab's own content, or `None` to fall back.
///
/// A parked tab is hidden as well as moved off screen, and a compositor that
/// is not drawing has nothing to hand over. Such a tab is shown for the
/// duration of the capture and hidden again afterwards. It is off screen
/// throughout, so nothing appears on the user's display; what does change
/// briefly is UI Automation, which is the same exposure `park_tab` hides the
/// tab to avoid. Restoring is unconditional, including on the failure paths.
#[cfg(windows)]
pub async fn capture_png<R: Runtime>(webview: &tauri::Webview<R>) -> Option<Vec<u8>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let dispatched = webview.with_webview(move |platform| {
        let controller = platform.controller();
        let restore = if webview_capture::is_visible(&controller) {
            None
        } else {
            // A tab that cannot be shown is still worth photographing: the
            // capture may work anyway, and the wait is the same either way.
            webview_capture::set_visible(&controller, true)
                .ok()
                .map(|()| controller.clone())
        };
        webview_capture::capture_png(&controller, move |result| {
            if let Some(restore) = restore {
                let _ = webview_capture::set_visible(&restore, false);
            }
            let _ = tx.send(result);
        });
    });
    if dispatched.is_err() {
        return None;
    }
    settle(rx).await
}

/// See the Windows implementation above; the shape is the same and only the
/// handle differs.
#[cfg(target_os = "macos")]
pub async fn capture_png<R: Runtime>(webview: &tauri::Webview<R>) -> Option<Vec<u8>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let dispatched = webview.with_webview(move |platform| {
        let Some(view) = std::ptr::NonNull::new(platform.inner()) else {
            return;
        };
        let restore = if webview_capture::is_visible(view) {
            None
        } else {
            webview_capture::set_visible(view, true).ok().map(|()| view)
        };
        webview_capture::capture_png(view, move |result| {
            if let Some(restore) = restore {
                let _ = webview_capture::set_visible(restore, false);
            }
            let _ = tx.send(result);
        });
    });
    if dispatched.is_err() {
        return None;
    }
    settle(rx).await
}

/// WebKitGTK has no equivalent that does not go back through the screen, so
/// there the monitor crop is the only path and this always declines.
#[cfg(not(any(windows, target_os = "macos")))]
pub async fn capture_png<R: Runtime>(_webview: &tauri::Webview<R>) -> Option<Vec<u8>> {
    None
}

/// Waits for the capture, treating every failure as "fall back".
///
/// A failure is not worth surfacing on its own: the caller has a working
/// fallback, and the reason the webview gave would only ever reach a user as
/// noise beside a picture that did arrive.
#[cfg(any(windows, target_os = "macos"))]
async fn settle(
    rx: tokio::sync::oneshot::Receiver<webview_capture::CaptureResult>,
) -> Option<Vec<u8>> {
    match tokio::time::timeout(SELF_CAPTURE_TIMEOUT, rx).await {
        Ok(Ok(Ok(png))) => Some(png),
        _ => None,
    }
}
