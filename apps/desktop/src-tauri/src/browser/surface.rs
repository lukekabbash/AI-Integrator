//! How a tab presents itself to the sites it loads.
//!
//! WebView2 and WKWebView advertise an embedded-control product token, and a
//! frozen Chrome major is read as an abandoned browser. Either is enough for
//! Google to refuse sign-in. A tab the user opened is the same current engine,
//! described the way the desktop browser describes itself.

use std::sync::OnceLock;

use tauri::{Runtime, webview::WebviewBuilder};

const IDENTITY_SURFACE: &str = include_str!("identity_surface.js");
/// Used only when the installed engine cannot be asked. Keep this inside the
/// current Chrome stable range so a missing version is not advertised as an
/// abandoned build.
pub(super) const FALLBACK_CHROME_MAJOR: u32 = 151;
const MIN_CHROME_MAJOR: u32 = 120;
const MAX_CHROME_MAJOR: u32 = 200;
const FALLBACK_SAFARI_MAJOR: u32 = 19;
/// wry already disables the first three. `UserAgentClientHint` is the header
/// set that still names WebView2 after `user_agent` is replaced.
pub(super) const WINDOWS_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,UserAgentClientHint \
     --disable-blink-features=AutomationControlled";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SurfaceOs {
    Windows,
    Mac,
}

struct Surface {
    user_agent: String,
    script: String,
}

fn current_os() -> SurfaceOs {
    if cfg!(target_os = "macos") {
        SurfaceOs::Mac
    } else {
        SurfaceOs::Windows
    }
}

fn parse_major(version: &str) -> Option<u32> {
    version
        .split(|character: char| !character.is_ascii_digit())
        .find(|part| !part.is_empty())
        .and_then(|part| part.parse().ok())
}

pub(super) fn chrome_major(webview_version: Option<&str>) -> u32 {
    webview_version
        .and_then(parse_major)
        .filter(|major| (MIN_CHROME_MAJOR..=MAX_CHROME_MAJOR).contains(major))
        .unwrap_or(FALLBACK_CHROME_MAJOR)
}

pub(super) fn user_agent(os: SurfaceOs, webview_version: Option<&str>) -> String {
    match os {
        SurfaceOs::Windows => {
            let major = chrome_major(webview_version);
            let arch = if cfg!(target_arch = "aarch64") {
                "ARM64"
            } else {
                "Win64; x64"
            };
            format!(
                "Mozilla/5.0 (Windows NT 10.0; {arch}) AppleWebKit/537.36 (KHTML, like Gecko) \
                 Chrome/{major}.0.0.0 Safari/537.36"
            )
        }
        SurfaceOs::Mac => {
            // WKWebView's default string omits Version/Safari and is read as
            // an iOS/embedded control. The AppleWebKit token is frozen;
            // Version is what the allow-list looks at. WebKit's bundle
            // version is not Safari's marketing major, so it is not used.
            format!(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
                 (KHTML, like Gecko) Version/{FALLBACK_SAFARI_MAJOR}.0 Safari/605.1.15"
            )
        }
    }
}

fn identity_script(os: SurfaceOs, webview_version: Option<&str>) -> String {
    let major = chrome_major(webview_version);
    let platform = match os {
        SurfaceOs::Windows => "Windows",
        SurfaceOs::Mac => "macOS",
    };
    format!("window.__integratorSurface={{major:{major},platform:{platform:?}}};{IDENTITY_SURFACE}")
}

fn current() -> &'static Surface {
    static SURFACE: OnceLock<Surface> = OnceLock::new();
    SURFACE.get_or_init(|| {
        let version = tauri::webview_version().ok();
        let os = current_os();
        Surface {
            user_agent: user_agent(os, version.as_deref()),
            script: identity_script(os, version.as_deref()),
        }
    })
}

pub(super) fn browser_user_agent() -> &'static str {
    current().user_agent.as_str()
}

/// Applies the desktop-browser surface every profile webview must share.
/// The first webview to open a profile owns the WebView2 environment, so a
/// cookie probe and a real tab have to agree or Client Hints stay on.
pub(super) fn apply<R: Runtime>(builder: WebviewBuilder<R>) -> WebviewBuilder<R> {
    builder
        .initialization_script_for_all_frames(current().script.clone())
        .user_agent(browser_user_agent())
        .additional_browser_args(WINDOWS_BROWSER_ARGS)
}
