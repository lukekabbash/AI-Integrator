//! Asks a webview to photograph itself.
//!
//! Every other capture in this workspace is a crop of the screen, which makes
//! a picture of a page only as good as the page's luck: a window behind
//! another window yields the other window's pixels, and a tab the renderer has
//! parked yields the desktop. The platforms both offer the thing that actually
//! wants doing — WebView2's `CapturePreview` and WKWebView's `takeSnapshot`
//! render the webview's own content — and neither consults the screen, so
//! focus, stacking order and whatever is covering the window stop mattering.
//!
//! Both are COM/Objective-C calls, so this crate is the one place in the
//! workspace where `unsafe` is allowed. It exists for that reason and holds
//! nothing else: callers hand in a platform handle and get PNG bytes back.
//! `apps/desktop` keeps its `#![forbid(unsafe_code)]` intact, exactly as it
//! does for job objects via `win32job`.
//!
//! The capture is asynchronous on both platforms and completes on the thread
//! that owns the webview, so the API is a callback rather than a return value.
//! Callers bridge that to whatever they use for waiting.

use std::fmt;

#[cfg(windows)]
mod windows_impl;
#[cfg(windows)]
pub use windows_impl::{capture_png, is_visible, set_visible};

#[cfg(target_os = "macos")]
mod macos_impl;
#[cfg(target_os = "macos")]
pub use macos_impl::{capture_png, is_visible, set_visible};

/// Why a webview could not photograph itself.
///
/// Deliberately one flat type with a message rather than a variant per
/// platform error: the caller's only decision is whether to fall back to the
/// screen-crop path, and every failure here means yes.
#[derive(Debug, Clone)]
pub struct CaptureError(String);

impl CaptureError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for CaptureError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for CaptureError {}

/// PNG bytes, or why there are none.
pub type CaptureResult = Result<Vec<u8>, CaptureError>;

/// Whether this platform can photograph a webview directly. Linux cannot:
/// WebKitGTK has no equivalent that does not go back through the screen.
pub const fn supported() -> bool {
    cfg!(any(windows, target_os = "macos"))
}
