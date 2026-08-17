//! What the browser profile is holding: which sites have cookies, and the
//! control that throws all of it away.
//!
//! Separate from the tab registry on purpose — this is about the profile
//! directory on disk, which outlives every tab in it.

use std::{collections::HashMap, sync::Arc};

use serde::Serialize;
use tauri::AppHandle;

use crate::command_api::CommandResult;

use super::{BrowserTabs, KEEP_SIGNED_IN_SETTING, setting_enabled, unavailable, webview_of};

/// One site the browser profile is holding state for. Derived from cookie
/// presence only: Integrator never reads, stores or shows a password, and the
/// vendor's own sign-in stays between you and that site.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSite {
    pub origin: String,
    pub cookies: usize,
    /// True when the profile survives a restart, i.e. you stay signed in.
    pub persistent: bool,
}

#[tauri::command]
pub async fn browser_sites(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
) -> CommandResult<Vec<BrowserSite>> {
    let persistent = setting_enabled(&app, KEEP_SIGNED_IN_SETTING);
    let label = {
        let tabs = state.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.values().next().map(|tab| tab.label.clone())
    };
    // Cookies are readable through a live webview in the profile; with no tab
    // open there is nothing to ask, which is honest rather than a guess.
    let Some(label) = label else {
        return Ok(Vec::new());
    };
    let webview = webview_of(&app, &label)?;
    let cookies = webview
        .cookies()
        .map_err(|error| unavailable(error.to_string()))?;
    let mut by_origin: HashMap<String, usize> = HashMap::new();
    for cookie in cookies {
        let domain = cookie
            .domain()
            .map(|domain| domain.trim_start_matches('.').to_string())
            .unwrap_or_default();
        if domain.is_empty() {
            continue;
        }
        *by_origin.entry(domain).or_default() += 1;
    }
    let mut sites: Vec<BrowserSite> = by_origin
        .into_iter()
        .map(|(origin, cookies)| BrowserSite {
            origin,
            cookies,
            persistent,
        })
        .collect();
    sites.sort_by(|a, b| b.cookies.cmp(&a.cookies).then(a.origin.cmp(&b.origin)));
    Ok(sites)
}

/// What an agent is told about one cookie: enough to reason about a session,
/// never enough to become one.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieFact {
    pub domain: String,
    pub name: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<String>,
    /// True when the cookie is a session or sign-in token by name or by flag.
    /// It is still listed — knowing a session exists is useful — but nothing
    /// about it beyond this is.
    pub session_like: bool,
}

/// Cookie names that carry a session. Matched loosely and on purpose: the cost
/// of over-matching is a caller learning slightly less, and the cost of
/// under-matching is a token in a transcript.
const SESSION_NAMES: &[&str] = &[
    "session", "sess", "sid", "token", "auth", "login", "jwt", "csrf", "xsrf", "remember",
];

fn session_like(name: &str, http_only: bool) -> bool {
    if http_only {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    SESSION_NAMES.iter().any(|needle| lower.contains(needle))
}

/// Lists the cookies one tab's origin holds — names, flags and expiry, and
/// never a value.
///
/// This exists because the alternative is worse: an agent with
/// `browser_evaluate` already reads `document.cookie`, values included, for
/// every cookie that is not HttpOnly. A narrow tool that cannot return a value
/// is less exposure than the escape hatch it replaces, not more.
pub(super) async fn cookies_for_tab(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    tab_id: &str,
) -> CommandResult<Vec<CookieFact>> {
    let tab = tabs
        .snapshot(None)
        .into_iter()
        .find(|tab| tab.id == tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let host = url::Url::parse(&tab.url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .ok_or_else(|| unavailable("that tab is not on a web page"))?;
    let label = tabs
        .label_for(tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let webview = webview_of(app, &label)?;
    let mut facts: Vec<CookieFact> = webview
        .cookies()
        .map_err(|error| unavailable(error.to_string()))?
        .into_iter()
        .filter_map(|cookie| {
            let domain = cookie.domain()?.trim_start_matches('.').to_string();
            // Only this tab's own site: a list of every cookie in the profile
            // would be a map of everywhere the user is signed in.
            if !(host == domain || host.ends_with(&format!(".{domain}"))) {
                return None;
            }
            let name = cookie.name().to_string();
            let http_only = cookie.http_only().unwrap_or(false);
            Some(CookieFact {
                domain,
                session_like: session_like(&name, http_only),
                name,
                path: cookie.path().unwrap_or("/").to_string(),
                secure: cookie.secure().unwrap_or(false),
                http_only,
                same_site: cookie.same_site().map(|value| format!("{value:?}")),
                // A session cookie has no expiry to report, which is itself
                // the useful fact — it dies with the browser.
                expires: cookie.expires_datetime().map(|at| at.to_string()),
            })
        })
        .collect();
    facts.sort_by(|a, b| a.domain.cmp(&b.domain).then(a.name.cmp(&b.name)));
    Ok(facts)
}

/// Clears everything the browser profile holds: cookies, storage and cache.
#[tauri::command]
pub async fn browser_clear_data(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
) -> CommandResult<()> {
    let labels: Vec<String> = {
        let tabs = state.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.values().map(|tab| tab.label.clone()).collect()
    };
    for label in labels {
        if let Ok(webview) = webview_of(&app, &label) {
            webview
                .clear_all_browsing_data()
                .map_err(|error| unavailable(error.to_string()))?;
        }
    }
    Ok(())
}
