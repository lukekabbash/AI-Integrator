//! WKWebView `takeSnapshot`.
//!
//! The counterpart of the WebView2 path: the view renders its own content and
//! hands back an `NSImage`, which is re-encoded here as PNG so both platforms
//! return the same bytes to the same caller. Nothing reads the screen, so the
//! window's stacking order and focus do not enter into it.
//!
//! NOTE: written against the objc2 bindings but not yet compiled or run on a
//! Mac — the machine this was developed on is Windows. Treat the first macOS
//! build as the real test.

use std::{cell::RefCell, ffi::c_void, ptr::NonNull};

use objc2::rc::Retained;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSView};
use objc2_foundation::{NSDictionary, NSError};
use objc2_web_kit::WKWebView;

use crate::{CaptureError, CaptureResult};

/// Photographs the webview and hands the PNG to `done`.
///
/// `webview` is the pointer Tauri's `PlatformWebview::inner()` returns and
/// nothing else. It is dereferenced as a `WKWebView`, so a pointer from
/// anywhere else is undefined behaviour — the reason this is not marked
/// `unsafe` is that the whole crate exists to keep that keyword out of the
/// callers, and the contract is narrow enough to state in one line.
///
/// Must be called on the main thread, which is where Tauri runs the
/// `with_webview` closure. `done` runs there too, once the snapshot lands.
pub fn capture_png(webview: NonNull<c_void>, done: impl FnOnce(CaptureResult) + 'static) {
    let view: &WKWebView = unsafe { webview.cast().as_ref() };
    // The block is `Fn`, not `FnOnce`, so the callback is parked where it can
    // be taken exactly once. WebKit calls the handler a single time, but the
    // type system cannot know that.
    let done = RefCell::new(Some(done));
    let handler = block2::RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
        let Some(done) = done.borrow_mut().take() else {
            return;
        };
        if let Some(error) = NonNull::new(error) {
            let message = unsafe { error.as_ref() }.localizedDescription().to_string();
            done(Err(CaptureError::new(format!(
                "WebKit could not photograph the tab: {message}"
            ))));
            return;
        }
        let Some(image) = NonNull::new(image) else {
            done(Err(CaptureError::new("the capture came back empty")));
            return;
        };
        done(encode_png(unsafe { image.as_ref() }));
    });
    // No configuration: the snapshot is the viewport as it stands, which is
    // what every caller here wants.
    unsafe { view.takeSnapshotWithConfiguration_completionHandler(None, &handler) };
}

/// Whether the view is currently rendering.
pub fn is_visible(webview: NonNull<c_void>) -> bool {
    let view: &NSView = unsafe { webview.cast().as_ref() };
    !view.isHidden()
}

/// Shows or hides the view.
pub fn set_visible(webview: NonNull<c_void>, visible: bool) -> Result<(), CaptureError> {
    let view: &NSView = unsafe { webview.cast().as_ref() };
    view.setHidden(!visible);
    Ok(())
}

fn encode_png(image: &NSImage) -> CaptureResult {
    let tiff = image
        .TIFFRepresentation()
        .ok_or_else(|| CaptureError::new("the capture could not be read back"))?;
    let bitmap: Retained<NSBitmapImageRep> = NSBitmapImageRep::imageRepWithData(&tiff)
        .ok_or_else(|| CaptureError::new("the capture could not be decoded"))?;
    let properties = NSDictionary::new();
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
    }
    .ok_or_else(|| CaptureError::new("the capture could not be encoded as PNG"))?;
    let bytes = png.to_vec();
    if bytes.is_empty() {
        return Err(CaptureError::new("the capture came back empty"));
    }
    Ok(bytes)
}
