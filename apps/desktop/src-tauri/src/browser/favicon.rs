//! Site icons for tabs.
//!
//! A strip of tabs that all wear the same globe is a strip you have to read
//! word by word. The page names its own icon, so the guest resolves that
//! declaration and the host fetches it — the renderer's content policy allows
//! `data:` images and nothing remote, which is also the answer that keeps a
//! page from learning anything about the app window: the request comes from
//! the process, carries no cookies, and its bytes never leave the tab list.
//!
//! Icons arrive as early as they can. A host seen before gets its icon the
//! moment a navigation starts, and a fresh page is asked for its declaration
//! several times while it is still loading, because `<link rel=icon>` is in
//! the head and the head is there long before the page has finished.
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
use url::Url;

use super::{BrowserTabs, emit_changed, eval_json};

const FETCH_TIMEOUT: Duration = Duration::from_secs(6);
/// Icons are decoration; one that costs more than this is not worth carrying
/// through every tab-list event.
pub(super) const MAX_ICON_BYTES: usize = 96 * 1024;
/// Sites share icons across their pages, so the same handful of addresses come
/// back on every navigation. Remembering them keeps browsing off the network.
const MAX_CACHED: usize = 64;
/// When, after a load starts, the page is asked for its icon. The head is
/// usually parsed within the first of these; the rest cover slow sites and
/// icons declared by script. The finished load is the final attempt.
const EARLY_ATTEMPTS: [Duration; 4] = [
    Duration::from_millis(150),
    Duration::from_millis(500),
    Duration::from_millis(1200),
    Duration::from_millis(3000),
];

/// Reads the page's icon declarations and hands back absolute addresses,
/// best first. `link.href` is already resolved against the document, so
/// relative paths and `//host` forms arrive whole.
///
/// "Best" is the icon nearest the size a tab draws it at: a 16–48px `icon`
/// beats a 180px `apple-touch-icon` or a 512px manifest icon, which are big
/// files the strip would have to carry on every event and which used to be
/// picked (largest first) and then dropped for being oversized, leaving the
/// tab with the globe. `/favicon.ico` closes the list whether or not the page
/// named anything, since it exists more often than not. `declared` says whether
/// the page named an icon itself, so an early attempt can tell a real answer
/// from the fallback guess and keep asking.
const RESOLVE: &str = r#"(() => {
  const rank = (link) => {
    const rel = (link.getAttribute('rel') || '').toLowerCase();
    const type = (link.getAttribute('type') || '').toLowerCase();
    const sizes = String(link.getAttribute('sizes') || '').toLowerCase();
    const size = Math.max(0, ...sizes.split(/\s+/).map((value) => parseInt(value, 10) || 0));
    const svg = type.includes('svg') || /\.svg(\?|#|$)/i.test(link.href);
    let score = 0;
    if (/apple-touch-icon/.test(rel)) score += 40;
    if (svg) score += 5;
    else if (size === 0 || sizes === 'any') score += 3;
    else score += Math.min(30, Math.abs(size - 32) / 4);
    return score;
  };
  const links = Array.from(document.querySelectorAll('link[rel]'))
    .filter((link) => /(^|\s)(icon|shortcut icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/i.test(link.getAttribute('rel') || ''))
    .filter((link) => /^(https?:|data:)/i.test(link.href || ''))
    .map((link) => ({ href: link.href, score: rank(link) }))
    .sort((a, b) => a.score - b.score);
  const candidates = [];
  for (const link of links) if (!candidates.includes(link.href)) candidates.push(link.href);
  const declared = candidates.length > 0;
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    const root = new URL('/favicon.ico', location.href).href;
    if (!candidates.includes(root)) candidates.push(root);
  }
  return { ok: true, value: { candidates, declared, page: location.href } };
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

/// Icons by page host. A site's pages share an icon, so the host a navigation
/// is heading to is enough to show one before the page has rendered a byte.
fn host_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn host_of(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    parsed.host_str().map(|host| host.to_ascii_lowercase())
}

/// The icon last seen on this page's host, if any.
pub(super) fn cached_for_url(url: &str) -> Option<String> {
    let host = host_of(url)?;
    host_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&host)
        .cloned()
}

fn remember_host(url: &str, icon: &str) {
    let Some(host) = host_of(url) else {
        return;
    };
    let mut map = host_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if map.len() >= MAX_CACHED {
        map.clear();
    }
    map.insert(host, icon.to_owned());
}

/// Which start of a page load each tab's early loop belongs to. A newer load
/// bumps the number and the older loop notices and stops, so a tab that hops
/// between pages never has two loops racing to paint it.
fn generations() -> &'static Mutex<HashMap<String, u64>> {
    static GENERATIONS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    GENERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn bump_generation(id: &str) -> u64 {
    let mut map = generations()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if map.len() >= 256 && !map.contains_key(id) {
        // Closed tabs leave their entry behind; start over rather than grow.
        map.clear();
    }
    let next = map.get(id).copied().unwrap_or(0) + 1;
    map.insert(id.to_owned(), next);
    next
}

fn generation(id: &str) -> Option<u64> {
    generations()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(id)
        .copied()
}

/// Puts an icon on a tab, telling the renderer only when it changed. The same
/// icon arriving again is the common case — every navigation inside a site
/// reports it — and re-emitting would redraw every tab list for nothing.
fn apply(app: &AppHandle, tabs: &BrowserTabs, id: &str, icon: &str) -> bool {
    let changed = std::cell::Cell::new(false);
    let found = tabs.update(id, |tab| {
        if tab.favicon.as_deref() != Some(icon) {
            tab.favicon = Some(icon.to_owned());
            changed.set(true);
        }
    });
    if found.is_some() && changed.get() {
        emit_changed(app, tabs);
        true
    } else {
        false
    }
}

/// Gives a tab whose page has just started loading the icon its host wore
/// last time, so the strip is legible before the page is. Best effort.
pub(super) fn apply_known(app: &AppHandle, tabs: &BrowserTabs, id: &str, url: &str) {
    if let Some(icon) = cached_for_url(url) {
        apply(app, tabs, id, &icon);
    }
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
    let header = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or(value)
                .trim()
                .to_ascii_lowercase()
        });
    let mime = icon_mime(source, header.as_deref())?;
    let bytes = response.bytes().ok()?;
    if bytes.is_empty() || bytes.len() > MAX_ICON_BYTES {
        return None;
    }
    // A reply that is HTML (a soft 404, a login wall) is not an icon whatever
    // the header claims.
    if bytes.starts_with(b"<!") || bytes.starts_with(b"<html") || bytes.starts_with(b"<HTML") {
        return None;
    }
    Some(format!("data:{mime};base64,{}", STANDARD.encode(&bytes)))
}

/// The type an icon reply is drawn as. Servers label icons carelessly —
/// `.ico` arrives as octet-stream or text/plain, SVGs as text/xml — so an
/// image header wins, and otherwise the address's extension decides.
fn icon_mime(source: &str, header: Option<&str>) -> Option<String> {
    if let Some(header) = header
        && header.starts_with("image/")
    {
        return Some(header.to_owned());
    }
    let path = source
        .split(['?', '#'])
        .next()
        .unwrap_or(source)
        .to_ascii_lowercase();
    let by_extension = if path.ends_with(".ico") {
        "image/x-icon"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".gif") {
        "image/gif"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else {
        return None;
    };
    // Only when the header is missing or generic; a header that names some
    // other real type (text/html) is a page, not an icon.
    match header {
        None => Some(by_extension.to_owned()),
        Some(header)
            if header.is_empty()
                || matches!(
                    header,
                    "application/octet-stream"
                        | "binary/octet-stream"
                        | "text/plain"
                        | "application/x-icon"
                        | "text/xml"
                        | "application/xml"
                ) =>
        {
            Some(by_extension.to_owned())
        }
        Some(_) => None,
    }
}

/// What one round of asking the page produced.
enum Attempt {
    /// The page named an icon (or the fallback fetched): done.
    Found,
    /// Nothing usable yet; worth asking again once the page has grown.
    Retry,
    /// The tab is gone or on another page: stop.
    Stop,
}

/// Asks the page once and applies what it says. `early` attempts accept only
/// an icon the page declared or a fallback that fetched, and report `Retry`
/// otherwise; the final attempt takes whatever there is.
async fn attempt(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    id: &str,
    label: &str,
    early: bool,
) -> Attempt {
    let Ok(value) = eval_json(app, label, RESOLVE.to_owned()).await else {
        return Attempt::Stop;
    };
    let candidates: Vec<String> = value
        .get("candidates")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .filter(|href| !href.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let declared = value
        .get("declared")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let page = value
        .get("page")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_default();
    if candidates.is_empty() {
        return if early { Attempt::Retry } else { Attempt::Stop };
    }
    // Best first, and the first that fetches wins. A source known to fail is
    // skipped rather than asked again.
    let mut icon: Option<String> = None;
    for source in candidates {
        let result = match cached(&source) {
            Some(known) => known,
            None => {
                let fetched = {
                    let source = source.clone();
                    tauri::async_runtime::spawn_blocking(move || fetch(&source))
                        .await
                        .unwrap_or(None)
                };
                // An undeclared `/favicon.ico` that failed is not the page's
                // final word while it is still loading; only remember a miss
                // once the page has settled or actually named the icon.
                if fetched.is_some() || declared || !early {
                    remember(source, fetched.clone());
                }
                fetched
            }
        };
        if result.is_some() {
            icon = result;
            break;
        }
    }
    let Some(icon) = icon else {
        return if early { Attempt::Retry } else { Attempt::Stop };
    };
    // The page may have moved on while the icon was fetched; an icon for the
    // old page belongs to the old page.
    let current = tabs.snapshot(None).into_iter().find(|tab| tab.id == id);
    let Some(current) = current else {
        return Attempt::Stop;
    };
    if !page.is_empty() && host_of(&current.url) != host_of(&page) {
        return Attempt::Stop;
    }
    remember_host(&current.url, &icon);
    apply(app, tabs, id, &icon);
    Attempt::Found
}

/// Starts looking for the icon of a page that has just begun loading, retrying
/// while the page grows. Detached; the load never waits on it. Only the latest
/// start for a tab keeps going: a newer navigation supersedes an older loop.
pub(super) fn resolve_early(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    id: &str,
    label: &str,
    url: &str,
) {
    apply_known(app, tabs, id, url);
    let generation = bump_generation(id);
    let app = app.clone();
    let tabs = Arc::clone(tabs);
    let id = id.to_string();
    let label = label.to_string();
    let url = url.to_string();
    tauri::async_runtime::spawn(async move {
        for delay in EARLY_ATTEMPTS {
            tokio::time::sleep(delay).await;
            if self::generation(&id) != Some(generation) {
                return;
            }
            // Navigated elsewhere before this attempt: the newer load has its
            // own loop, or the finished-load refresh will cover it.
            let same_page = tabs
                .snapshot(None)
                .into_iter()
                .find(|tab| tab.id == id)
                .is_some_and(|tab| host_of(&tab.url) == host_of(&url));
            if !same_page {
                return;
            }
            match attempt(&app, &tabs, &id, &label, true).await {
                Attempt::Found | Attempt::Stop => return,
                Attempt::Retry => {}
            }
        }
    });
}

/// Asks a settled page for its icon and puts it on the tab. Runs detached: a
/// page load never waits on an icon, and a failure leaves the tab as it was.
pub(super) fn refresh(app: &AppHandle, tabs: &Arc<BrowserTabs>, id: &str, label: &str) {
    // The finished load is the final word; any early loop still running for
    // this tab is superseded.
    bump_generation(id);
    let app = app.clone();
    let tabs = Arc::clone(tabs);
    let id = id.to_string();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        let _ = attempt(&app, &tabs, &id, &label, false).await;
    });
}

/// Looks again without superseding a load's early loop: a title change is a
/// hint the page moved on (single-page apps swap title and icon together with
/// no load event), not a new load. Best effort, cache-first.
pub(super) fn refresh_gently(app: &AppHandle, tabs: &Arc<BrowserTabs>, id: &str, label: &str) {
    let app = app.clone();
    let tabs = Arc::clone(tabs);
    let id = id.to_string();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        let _ = attempt(&app, &tabs, &id, &label, true).await;
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
        remember(
            "https://example.test/favicon.ico".into(),
            Some("data:x".into()),
        );
        assert_eq!(
            cached("https://example.test/favicon.ico"),
            Some(Some("data:x".into()))
        );
        assert_eq!(cached("https://other.test/favicon.ico"), None);
    }

    #[test]
    fn the_host_cache_answers_for_any_page_on_a_host_it_has_seen() {
        remember_host("https://Docs.Example.test/a/b?c", "data:host-icon");
        assert_eq!(
            cached_for_url("https://docs.example.test/other").as_deref(),
            Some("data:host-icon")
        );
        assert_eq!(cached_for_url("https://example.test/"), None);
        assert_eq!(cached_for_url("about:blank"), None);
        // Only web pages carry a host icon.
        remember_host("about:blank", "data:nope");
        assert_eq!(cached_for_url("about:blank"), None);
    }

    #[test]
    fn the_resolver_lists_candidates_small_first_and_ends_at_the_root() {
        assert!(RESOLVE.contains("apple-touch-icon"));
        assert!(RESOLVE.contains("/favicon.ico"));
        // Nearness to the strip's size ranks a declared icon; touch icons sink.
        assert!(RESOLVE.contains("Math.abs(size - 32)"));
        assert!(RESOLVE.contains("if (/apple-touch-icon/.test(rel)) score += 40"));
        // The reply travels through `eval_json`, which reads `value`; the loop
        // reads the ordered list and whether the page declared any of it.
        assert!(RESOLVE.contains("ok: true, value: { candidates, declared,"));
    }

    #[test]
    fn icon_types_come_from_the_header_or_else_the_extension() {
        assert_eq!(
            icon_mime(
                "https://a.test/favicon.ico",
                Some("image/vnd.microsoft.icon")
            )
            .as_deref(),
            Some("image/vnd.microsoft.icon")
        );
        assert_eq!(
            icon_mime(
                "https://a.test/favicon.ico",
                Some("application/octet-stream")
            )
            .as_deref(),
            Some("image/x-icon")
        );
        assert_eq!(
            icon_mime("https://a.test/icon.svg?v=2", Some("text/xml")).as_deref(),
            Some("image/svg+xml")
        );
        assert_eq!(
            icon_mime("https://a.test/logo.png", None).as_deref(),
            Some("image/png")
        );
        // A page is not an icon, whatever its name.
        assert_eq!(
            icon_mime("https://a.test/favicon.ico", Some("text/html")),
            None
        );
        assert_eq!(
            icon_mime("https://a.test/thing", Some("application/octet-stream")),
            None
        );
    }
}

#[cfg(test)]
mod generation_tests {
    use super::*;

    #[test]
    fn a_newer_load_supersedes_an_older_loop() {
        let first = bump_generation("tab-gen-test");
        assert_eq!(generation("tab-gen-test"), Some(first));
        let second = bump_generation("tab-gen-test");
        assert!(second > first);
        assert_ne!(generation("tab-gen-test"), Some(first));
        assert_eq!(generation("tab-never"), None);
    }
}
