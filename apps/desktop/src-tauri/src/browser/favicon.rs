//! Site icons for tabs.
//!
//! A strip of tabs that all wear the same globe is a strip you have to read
//! word by word. The page names its own icon, so the guest resolves that
//! declaration and the host fetches it — the renderer's content policy allows
//! `data:` images and nothing remote, which is also the answer that keeps a
//! page from learning anything about the app window: the request comes from
//! the process, carries no cookies, and its bytes never leave the tab list.
//!
//! Everything here is best effort. A site with no icon, a slow host, an
//! oversized file or a reply that is not an image simply leaves the tab with
//! the glyph it already had.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::Value;
use tauri::AppHandle;

use super::{BrowserTabs, emit_changed, eval_json};

const FETCH_TIMEOUT: Duration = Duration::from_secs(6);
/// Icons are decoration; one that costs more than this is not worth carrying
/// through every tab-list event.
const MAX_ICON_BYTES: usize = 32 * 1024;
/// Sites share icons across their pages, so the same handful of addresses come
/// back on every navigation. Remembering them keeps browsing off the network.
const MAX_CACHED: usize = 64;

/// Reads the page's own icon declaration and hands back an absolute address.
/// `link.href` is already resolved against the document, so relative paths and
/// `//host` forms arrive whole. Larger declared sizes win; a site that declares
/// none still has `/favicon.ico` more often than not.
const RESOLVE: &str = r#"(() => {
  const links = Array.from(document.querySelectorAll('link[rel]'))
    .filter((link) => /(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(link.getAttribute('rel') || ''))
    .map((link) => ({
      href: link.href || '',
      size: Math.max(0, ...String(link.getAttribute('sizes') || '').split(/\s+/).map((value) => parseInt(value, 10) || 0)),
    }))
    .filter((link) => /^(https?:|data:)/i.test(link.href));
  links.sort((a, b) => b.size - a.size);
  const best = links[0]?.href
    || (location.protocol === 'http:' || location.protocol === 'https:'
      ? new URL('/favicon.ico', location.href).href
      : '');
  return { ok: true, value: best };
})()"#;

fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached(source: &str) -> Option<Option<String>> {
    cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(source)
        .cloned()
}

fn remember(source: String, icon: Option<String>) {
    let mut map = cache().lock().unwrap_or_else(|error| error.into_inner());
    // A flat cap rather than a real eviction order: this is a decoration
    // cache, and starting it over costs one fetch per site still open.
    if map.len() >= MAX_CACHED {
        map.clear();
    }
    map.insert(source, icon);
}

/// Fetches one icon and encodes it for the renderer. Blocking, so callers hand
/// it to a blocking task.
fn fetch(source: &str) -> Option<String> {
    if source.starts_with("data:") {
        return (source.len() <= MAX_ICON_BYTES).then(|| source.to_owned());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(super::BROWSER_USER_AGENT)
        .build()
        .ok()?;
    let response = client.get(source).send().ok()?;
    if !response.status().is_success() {
        return None;
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or(value).trim().to_owned())
        .filter(|value| value.starts_with("image/"))
        // `.ico` is served as everything under the sun; trust the extension
        // when the header is not an image type but the address looks like one.
        .or_else(|| source.contains(".ico").then(|| "image/x-icon".to_owned()))?;
    let bytes = response.bytes().ok()?;
    if bytes.is_empty() || bytes.len() > MAX_ICON_BYTES {
        return None;
    }
    Some(format!("data:{mime};base64,{}", STANDARD.encode(&bytes)))
}

/// Asks a settled page for its icon and puts it on the tab. Runs detached: a
/// page load never waits on an icon, and a failure leaves the tab as it was.
pub(super) fn refresh(app: &AppHandle, tabs: &Arc<BrowserTabs>, id: &str, label: &str) {
    let app = app.clone();
    let tabs = Arc::clone(tabs);
    let id = id.to_string();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        let Ok(value) = eval_json(&app, &label, RESOLVE.to_owned()).await else {
            return;
        };
        let source = match value {
            Value::String(href) if !href.is_empty() => href,
            _ => return,
        };
        let icon = match cached(&source) {
            Some(icon) => icon,
            None => {
                let fetched = {
                    let source = source.clone();
                    tauri::async_runtime::spawn_blocking(move || fetch(&source))
                        .await
                        .unwrap_or(None)
                };
                remember(source, fetched.clone());
                fetched
            }
        };
        let Some(icon) = icon else { return };
        // The same icon arriving again is the common case — every navigation
        // inside a site reports it — and re-emitting would redraw every tab
        // list in the app for nothing.
        let changed = std::cell::Cell::new(false);
        let found = tabs.update(&id, |tab| {
            if tab.favicon.as_deref() != Some(icon.as_str()) {
                tab.favicon = Some(icon.clone());
                changed.set(true);
            }
        });
        if found.is_some() && changed.get() {
            emit_changed(&app, &tabs);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_icons_are_passed_through_and_oversized_ones_are_not() {
        let small = "data:image/svg+xml,<svg/>";
        assert_eq!(fetch(small).as_deref(), Some(small));
        let huge = format!("data:image/png;base64,{}", "A".repeat(MAX_ICON_BYTES));
        assert!(fetch(&huge).is_none());
    }

    #[test]
    fn the_cache_answers_for_a_source_it_has_seen() {
        remember("https://example.test/favicon.ico".into(), Some("data:x".into()));
        assert_eq!(
            cached("https://example.test/favicon.ico"),
            Some(Some("data:x".into()))
        );
        assert_eq!(cached("https://other.test/favicon.ico"), None);
    }

    #[test]
    fn the_resolver_prefers_a_declared_icon_and_falls_back_to_the_root() {
        assert!(RESOLVE.contains("apple-touch-icon"));
        assert!(RESOLVE.contains("/favicon.ico"));
        // The reply travels through `eval_json`, which reads `value`.
        assert!(RESOLVE.contains("ok: true, value: best"));
    }
}
