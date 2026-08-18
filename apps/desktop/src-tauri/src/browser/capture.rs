//! Viewport capture for a browser tab.
//!
//! The workspace forbids `unsafe`, so the platform capture APIs that read a
//! webview's own surface (WebView2 `CapturePreview`, WKWebView `takeSnapshot`)
//! are out of reach here. Instead the screen is captured through `xcap` and
//! cropped to the tab's rectangle.
//!
//! The screen, not the window: `xcap::Window::all()` deliberately leaves out
//! every window owned by the calling process (its Windows enumerator skips
//! them to dodge a `GetWindowText` deadlock), so asking it for our own window
//! by title can never succeed. The monitor under the tab has no such filter.
//! The trade is that this is occlusion-sensitive — the tab must be on screen
//! and unobstructed — and callers are told so rather than handed a wrong image.
//! On macOS the first capture also triggers the Screen Recording permission
//! prompt; until it is granted the system hands back a picture of the desktop
//! wallpaper without an error, which is the OS's behaviour and not ours to fix.

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

/// The longest edge a still is kept at. A poster is painted under a live page
/// at card or pane size and never studied, so full resolution would only buy
/// encode time on the very switch the still exists to hide.
const POSTER_MAX_EDGE: u32 = 640;

/// A capture of one tab's viewport, base64 PNG plus the pixel size it was
/// taken at so a caller can relate what it sees to the page's coordinates.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
}

pub async fn capture_png<R: Runtime>(webview: &tauri::Webview<R>) -> Result<String, CommandError> {
    capture(webview, None).await.map(|shot| shot.png_base64)
}

/// A capture with its dimensions, for callers that will read the picture.
pub async fn capture_full<R: Runtime>(
    webview: &tauri::Webview<R>,
) -> Result<Capture, CommandError> {
    capture(webview, None).await
}

/// The same picture, scaled down and encoded for speed: this one is taken on
/// the path a tab leaves the screen by, so it may not cost the user a pause.
pub async fn capture_poster_png<R: Runtime>(
    webview: &tauri::Webview<R>,
) -> Result<String, CommandError> {
    capture(webview, Some(POSTER_MAX_EDGE))
        .await
        .map(|shot| shot.png_base64)
}

async fn capture<R: Runtime>(
    webview: &tauri::Webview<R>,
    max_edge: Option<u32>,
) -> Result<Capture, CommandError> {
    let window = webview.window();
    if window.is_minimized().unwrap_or(false) {
        return Err(unavailable(
            "the app window is minimized — restore it so the tab is on screen, then try again",
        ));
    }
    if !window.is_visible().unwrap_or(true) {
        return Err(unavailable(
            "the app window is hidden, so the tab cannot be captured",
        ));
    }
    // The webview's position is relative to the window's client area, and
    // `inner_position` is where that client area sits on the screen. Adding
    // them gives the tab's rectangle on the screen, which is what a monitor
    // capture is cropped by. Tauri reports all three in physical pixels;
    // xcap's monitor geometry is physical on Windows and Linux but in points
    // on macOS (`CGDisplayBounds`), so there the rectangle is scaled down by
    // the window's scale factor before it is handed over.
    let position = webview
        .position()
        .map_err(|error| unavailable(error.to_string()))?;
    let size = webview
        .size()
        .map_err(|error| unavailable(error.to_string()))?;
    let client_origin = window
        .inner_position()
        .map_err(|error| unavailable(error.to_string()))?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let (client_origin, position, size) = to_monitor_units(client_origin, position, size, scale);
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        capture_region(client_origin, position, size, max_edge)
    })
    .await
    .map_err(|_| unavailable("the screenshot worker stopped"))??;
    Ok(Capture {
        png_base64: STANDARD.encode(&bytes.png),
        width: bytes.width,
        height: bytes.height,
    })
}

/// Physical-pixel geometry from Tauri, expressed in the units xcap measures
/// monitors in on this platform: points on macOS, pixels elsewhere.
fn to_monitor_units(
    client_origin: PhysicalPosition<i32>,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    scale: f64,
) -> (
    PhysicalPosition<i32>,
    PhysicalPosition<i32>,
    PhysicalSize<u32>,
) {
    if !cfg!(target_os = "macos") || scale <= 0.0 || (scale - 1.0).abs() < f64::EPSILON {
        return (client_origin, position, size);
    }
    let down = |value: i32| (f64::from(value) / scale).round() as i32;
    let down_u = |value: u32| (f64::from(value) / scale).round() as u32;
    (
        PhysicalPosition::new(down(client_origin.x), down(client_origin.y)),
        PhysicalPosition::new(down(position.x), down(position.y)),
        PhysicalSize::new(down_u(size.width), down_u(size.height)),
    )
}

struct Encoded {
    png: Vec<u8>,
    width: u32,
    height: u32,
}

/// The tab's rectangle on the screen, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ScreenRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Where the tab sits on the screen, from the client-area origin and the
/// webview's placement inside it. A parked tab is placed off screen by the
/// renderer, which this reports faithfully rather than clamping into view.
fn tab_screen_rect(
    client_origin: PhysicalPosition<i32>,
    webview_position: PhysicalPosition<i32>,
    webview_size: PhysicalSize<u32>,
) -> ScreenRect {
    ScreenRect {
        x: client_origin.x.saturating_add(webview_position.x),
        y: client_origin.y.saturating_add(webview_position.y),
        width: webview_size.width,
        height: webview_size.height,
    }
}

/// The part of the tab that lies on a monitor, as a region relative to that
/// monitor's own origin — the shape `Monitor::capture_region` takes. `None`
/// when the two do not overlap at all.
fn monitor_region(
    tab: ScreenRect,
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: u32,
    monitor_height: u32,
) -> Option<(u32, u32, u32, u32)> {
    let left = i64::from(tab.x).max(i64::from(monitor_x));
    let top = i64::from(tab.y).max(i64::from(monitor_y));
    let right = (i64::from(tab.x) + i64::from(tab.width))
        .min(i64::from(monitor_x) + i64::from(monitor_width));
    let bottom = (i64::from(tab.y) + i64::from(tab.height))
        .min(i64::from(monitor_y) + i64::from(monitor_height));
    if right <= left || bottom <= top {
        return None;
    }
    Some((
        (left - i64::from(monitor_x)) as u32,
        (top - i64::from(monitor_y)) as u32,
        (right - left) as u32,
        (bottom - top) as u32,
    ))
}

/// Grabs the monitor under the tab and crops to the tab's rectangle.
fn capture_region(
    client_origin: PhysicalPosition<i32>,
    webview_position: PhysicalPosition<i32>,
    webview_size: PhysicalSize<u32>,
    max_edge: Option<u32>,
) -> Result<Encoded, CommandError> {
    let tab = tab_screen_rect(client_origin, webview_position, webview_size);
    if tab.width == 0 || tab.height == 0 {
        return Err(unavailable("that tab is not on screen right now"));
    }
    // The monitor under the tab's centre. A tab straddling two monitors is
    // cropped to the one holding most of it, which is what a person looking
    // at the screen would call "the" picture of it.
    let centre_x = tab.x.saturating_add((tab.width / 2) as i32);
    let centre_y = tab.y.saturating_add((tab.height / 2) as i32);
    let monitor = xcap::Monitor::from_point(centre_x, centre_y).map_err(|_| {
        unavailable(
            "that tab is not on screen right now — bring the browser pane into view and try again",
        )
    })?;
    let bounds = |value: Result<i32, xcap::XCapError>| {
        value.map_err(|error| unavailable(format!("could not read the monitor: {error}")))
    };
    let extent = |value: Result<u32, xcap::XCapError>| {
        value.map_err(|error| unavailable(format!("could not read the monitor: {error}")))
    };
    let (mx, my) = (bounds(monitor.x())?, bounds(monitor.y())?);
    let (mw, mh) = (extent(monitor.width())?, extent(monitor.height())?);
    let (x, y, width, height) = monitor_region(tab, mx, my, mw, mh)
        .ok_or_else(|| unavailable("that tab is not on screen right now"))?;
    let cropped = monitor
        .capture_region(x, y, width, height)
        .map_err(|error| unavailable(format!("could not capture the screen: {error}")))?;

    let cropped = match max_edge.filter(|edge| width.max(height) > *edge) {
        Some(edge) => {
            let scale = f64::from(edge) / f64::from(width.max(height));
            image::imageops::resize(
                &cropped,
                scaled(width, scale),
                scaled(height, scale),
                image::imageops::FilterType::Triangle,
            )
        }
        None => cropped,
    };

    let mut png = Vec::new();
    // A scaled still is encoded for speed rather than size: it is taken while
    // the user is waiting for a tab to move, and it is thrown away this
    // session. A full-size capture keeps the default, which is what a
    // screenshot heading for the composer deserves.
    let encoder = match max_edge {
        Some(_) => image::codecs::png::PngEncoder::new_with_quality(
            &mut png,
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::NoFilter,
        ),
        None => image::codecs::png::PngEncoder::new(&mut png),
    };
    encoder
        .write_image(
            cropped.as_raw(),
            cropped.width(),
            cropped.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| unavailable(format!("could not encode the screenshot: {error}")))?;
    Ok(Encoded {
        png,
        width: cropped.width(),
        height: cropped.height(),
    })
}

/// One edge of a scaled still, never smaller than a pixel.
fn scaled(edge: u32, scale: f64) -> u32 {
    ((f64::from(edge) * scale).round() as u32).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tab_rect_adds_client_origin_to_webview_placement() {
        let rect = tab_screen_rect(
            PhysicalPosition::new(100, 50),
            PhysicalPosition::new(300, 40),
            PhysicalSize::new(1280, 800),
        );
        assert_eq!(
            rect,
            ScreenRect {
                x: 400,
                y: 90,
                width: 1280,
                height: 800
            }
        );
    }

    #[test]
    fn region_is_relative_to_the_monitor_origin() {
        let tab = ScreenRect {
            x: 2320,
            y: 100,
            width: 800,
            height: 600,
        };
        // Second monitor to the right of a 1920-wide primary.
        assert_eq!(
            monitor_region(tab, 1920, 0, 2560, 1440),
            Some((400, 100, 800, 600))
        );
    }

    #[test]
    fn region_is_clipped_to_the_monitor() {
        let tab = ScreenRect {
            x: -200,
            y: -50,
            width: 800,
            height: 600,
        };
        assert_eq!(
            monitor_region(tab, 0, 0, 1920, 1080),
            Some((0, 0, 600, 550))
        );
        let far_right = ScreenRect {
            x: 1800,
            y: 900,
            width: 800,
            height: 600,
        };
        assert_eq!(
            monitor_region(far_right, 0, 0, 1920, 1080),
            Some((1800, 900, 120, 180))
        );
    }

    #[test]
    fn parked_tab_has_no_region() {
        let parked = ScreenRect {
            x: -20000,
            y: -20000,
            width: 1280,
            height: 800,
        };
        assert_eq!(monitor_region(parked, 0, 0, 1920, 1080), None);
    }
}
