//! Viewport capture for a browser tab.
//!
//! The workspace forbids `unsafe`, so the platform capture APIs that read a
//! webview's own surface (WebView2 `CapturePreview`, WKWebView `takeSnapshot`)
//! are out of reach here. Instead the app window is captured through `xcap`
//! and cropped to the tab's rectangle. That is honest but occlusion-sensitive:
//! the window must be on screen and unobstructed, and callers are told so
//! rather than handed a wrong image.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::ImageEncoder as _;
use tauri::{PhysicalPosition, PhysicalSize, Runtime};

use crate::command_api::CommandError;

fn unavailable(message: impl Into<String>) -> CommandError {
    CommandError {
        code: "unavailable",
        message: message.into(),
    }
}

pub async fn capture_png<R: Runtime>(webview: &tauri::Webview<R>) -> Result<String, CommandError> {
    let position = webview
        .position()
        .map_err(|error| unavailable(error.to_string()))?;
    let size = webview
        .size()
        .map_err(|error| unavailable(error.to_string()))?;
    let window = webview.window();
    let window_position = window
        .outer_position()
        .map_err(|error| unavailable(error.to_string()))?;
    let title = window.title().unwrap_or_default();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        capture_region(&title, window_position, position, size)
    })
    .await
    .map_err(|_| unavailable("the screenshot worker stopped"))??;
    Ok(STANDARD.encode(bytes))
}

/// Grabs the owning window and crops to the webview's client rectangle.
fn capture_region(
    window_title: &str,
    window_position: PhysicalPosition<i32>,
    webview_position: PhysicalPosition<i32>,
    webview_size: PhysicalSize<u32>,
) -> Result<Vec<u8>, CommandError> {
    let windows = xcap::Window::all()
        .map_err(|error| unavailable(format!("could not enumerate windows: {error}")))?;
    let window = windows
        .into_iter()
        .find(|candidate| {
            candidate.title().is_ok_and(|title| title == window_title)
                && candidate.is_minimized().is_ok_and(|minimized| !minimized)
        })
        .ok_or_else(|| unavailable("the app window is not visible to capture"))?;
    let image = window
        .capture_image()
        .map_err(|error| unavailable(format!("could not capture the window: {error}")))?;

    // The webview reports its position relative to the window's client area,
    // which for a decorationless window shares the origin with the frame.
    let _ = window_position;
    let x = webview_position.x.max(0) as u32;
    let y = webview_position.y.max(0) as u32;
    let width = webview_size.width.min(image.width().saturating_sub(x));
    let height = webview_size.height.min(image.height().saturating_sub(y));
    if width == 0 || height == 0 {
        return Err(unavailable("that tab is not on screen right now"));
    }
    let cropped = image::imageops::crop_imm(&image, x, y, width, height).to_image();

    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(
            cropped.as_raw(),
            cropped.width(),
            cropped.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| unavailable(format!("could not encode the screenshot: {error}")))?;
    Ok(png)
}
