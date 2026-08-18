//! WebView2 `CapturePreview`.
//!
//! The controller renders its own content into a stream we hand it. Nothing
//! about the call reads the screen, so a window that is behind another window,
//! unfocused, or on a monitor that is switched off photographs exactly the
//! same as one in front.

use webview2_com::{
    CapturePreviewCompletedHandler,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, ICoreWebView2Controller,
    },
};
use windows::Win32::{
    System::Com::{IStream, STREAM_SEEK_SET},
    UI::Shell::SHCreateMemStream,
};

use crate::{CaptureError, CaptureResult};

/// How much of the stream is read at a time. A viewport-sized PNG is a few
/// hundred kilobytes, so this is two or three trips rather than a guess at a
/// single allocation large enough for anything.
const CHUNK: usize = 64 * 1024;

/// Photographs the webview and hands the PNG to `done`.
///
/// `done` runs on the thread that owns the controller — the main thread —
/// once WebView2 reports the capture finished. It is called exactly once,
/// including on the failure paths that never reach WebView2 at all.
pub fn capture_png(
    controller: &ICoreWebView2Controller,
    done: impl FnOnce(CaptureResult) + 'static,
) {
    let webview = match unsafe { controller.CoreWebView2() } {
        Ok(webview) => webview,
        Err(error) => {
            done(Err(CaptureError::new(format!(
                "the tab has no WebView2 to photograph: {error}"
            ))));
            return;
        }
    };
    // A memory stream rather than a temp file: the bytes are going straight
    // into a base64 string, and a file would only add a path to clean up.
    let Some(stream) = (unsafe { SHCreateMemStream(None) }) else {
        done(Err(CaptureError::new(
            "could not allocate a buffer for the capture",
        )));
        return;
    };
    let sink = stream.clone();
    let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
        done(match result {
            Ok(()) => read_stream(&sink),
            Err(error) => Err(CaptureError::new(format!(
                "WebView2 could not photograph the tab: {error}"
            ))),
        });
        Ok(())
    }));
    if let Err(error) = unsafe {
        webview.CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            &stream,
            &handler,
        )
    } {
        // The handler owns `done` and will never run now, so this path cannot
        // report the failure through it. Callers time out rather than hang;
        // see the note on `capture_webview_png` in the desktop crate.
        let _ = error;
    }
}

/// Whether the controller is currently rendering.
///
/// A parked tab is hidden as well as moved off screen, and a compositor that
/// is not drawing has nothing to photograph. The caller decides what to do
/// about that; this crate only reports it.
pub fn is_visible(controller: &ICoreWebView2Controller) -> bool {
    let mut visible = windows::core::BOOL::default();
    unsafe { controller.IsVisible(&mut visible) }
        .map(|()| visible.as_bool())
        .unwrap_or(false)
}

/// Turns rendering on or off for this controller.
pub fn set_visible(
    controller: &ICoreWebView2Controller,
    visible: bool,
) -> Result<(), CaptureError> {
    unsafe { controller.SetIsVisible(visible) }
        .map_err(|error| CaptureError::new(format!("could not change tab visibility: {error}")))
}

fn read_stream(stream: &IStream) -> CaptureResult {
    unsafe { stream.Seek(0, STREAM_SEEK_SET, None) }
        .map_err(|error| CaptureError::new(format!("could not rewind the capture: {error}")))?;
    let mut png = Vec::new();
    let mut chunk = [0u8; CHUNK];
    loop {
        let mut read = 0u32;
        let outcome = unsafe {
            stream.Read(
                chunk.as_mut_ptr().cast(),
                chunk.len() as u32,
                Some(&mut read),
            )
        };
        if outcome.is_err() {
            return Err(CaptureError::new("could not read the capture back"));
        }
        if read == 0 {
            break;
        }
        png.extend_from_slice(&chunk[..read as usize]);
    }
    if png.is_empty() {
        return Err(CaptureError::new("the capture came back empty"));
    }
    Ok(png)
}
