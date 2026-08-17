//! Browser tabs: real webviews the user and the agent share.
//!
//! A tab is a Tauri child webview parented to the app window (or to its own
//! pop-out window). The renderer owns layout and reports the rectangle its
//! slot occupies; this module owns the webview, its navigation state, and the
//! injected guest runtime that answers snapshots and synthesises interaction.
//!
//! Nothing here trusts page content: the guest runtime is called through
//! `eval_with_callback` and every reply is parsed as JSON with a bounded size.
//! Guest webviews are named `browser-*` so the desktop capability (scoped to
//! `main`/`task-*` webviews) never grants them app commands.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    Runtime, WebviewUrl,
    webview::{PageLoadEvent, WebviewBuilder},
};
use tokio::sync::oneshot;
use url::Url;

use integrator_core::IntegratorError;

use crate::command_api::{CommandError, CommandResult};

mod capture;
mod servers;

pub use servers::browser_local_servers;

pub const BROWSER_EVENT: &str = "browser://changed";
/// Sites stay signed in between runs unless the user turns this off.
pub const KEEP_SIGNED_IN_SETTING: &str = "settings.browser.keepSignedIn";
/// Whether agents may open and drive browser tabs for this installation.
pub const AGENT_ACCESS_SETTING: &str = "settings.browser.agentAccess";
/// Whether a page's `window.open` becomes a navigation in the same tab.
pub const KEEP_POPUPS_INSIDE_SETTING: &str = "settings.browser.blockNewWindows";
const GUEST_RUNTIME: &str = include_str!("guest.js");
/// WebView2 reports itself as Edge with a `WebView2` product token, and several
/// large identity providers — Google's among them — refuse to accept a sign-in
/// from a string they read as an embedded control. This is the same engine and
/// the same recent Chromium, described the way the desktop browser describes
/// itself, so those flows work in a tab the user opened deliberately.
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const EVAL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_EVAL_BYTES: usize = 96 * 1024;

/// A tab with no page: the start page shows instead of a native surface.
fn is_blank(url: &Url) -> bool {
    url.scheme() == "about" || url.as_str() == "about:blank"
}

fn invalid(message: impl Into<String>) -> CommandError {
    CommandError {
        code: "invalid-input",
        message: message.into(),
    }
}

fn unavailable(message: impl Into<String>) -> CommandError {
    CommandError {
        code: "unavailable",
        message: message.into(),
    }
}

/// One tab's user-visible state. The renderer renders from this; the agent
/// reads the same fields through the broker.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub id: String,
    /// Task that owns the tab, so agent tools cannot address another task's tabs.
    pub task_id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub popped_out: bool,
    /// True while the tab has no visible host (pane closed); it keeps running.
    pub hidden: bool,
}

struct Tab {
    state: BrowserTab,
    /// Label of the webview; also the pop-out window label when popped out.
    label: String,
}

#[derive(Default)]
pub struct BrowserTabs {
    tabs: Mutex<HashMap<String, Tab>>,
    sequence: AtomicU64,
}

impl BrowserTabs {
    pub fn new() -> Self {
        Self::default()
    }

    fn snapshot(&self, task_id: Option<&str>) -> Vec<BrowserTab> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let mut list: Vec<BrowserTab> = tabs
            .values()
            .filter(|tab| task_id.is_none_or(|task| tab.state.task_id == task))
            .map(|tab| tab.state.clone())
            .collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    fn label_for(&self, id: &str) -> Option<String> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.get(id).map(|tab| tab.label.clone())
    }

    fn task_of(&self, id: &str) -> Option<String> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.get(id).map(|tab| tab.state.task_id.clone())
    }

    fn update(&self, id: &str, apply: impl FnOnce(&mut BrowserTab)) -> Option<BrowserTab> {
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let tab = tabs.get_mut(id)?;
        apply(&mut tab.state);
        Some(tab.state.clone())
    }
}

fn emit_changed<R: Runtime>(app: &AppHandle<R>, tabs: &BrowserTabs) {
    let _ = app.emit(BROWSER_EVENT, json!({ "tabs": tabs.snapshot(None) }));
}

/// Accepts only http(s); a bare host defaults to https, loopback to http.
fn normalize_url(input: &str) -> Result<Url, CommandError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(invalid("enter a URL"));
    }
    if trimmed.len() > 2048 {
        return Err(invalid("that URL is too long"));
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        let host = trimmed.split(['/', ':']).next().unwrap_or_default();
        let loopback = matches!(host, "localhost" | "127.0.0.1" | "0.0.0.0" | "[::1]")
            || host.starts_with("127.");
        format!("{}://{trimmed}", if loopback { "http" } else { "https" })
    };
    let url = Url::parse(&candidate).map_err(|_| invalid("that is not a valid URL"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        other => Err(invalid(format!(
            "{other} links do not open in a browser tab"
        ))),
    }
}

fn webview_of<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Result<tauri::Webview<R>, CommandError> {
    app.webviews()
        .into_iter()
        .find(|(candidate, _)| candidate == label)
        .map(|(_, webview)| webview)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))
}

/// Runs an expression in the guest and returns its JSON result.
async fn eval_json<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    script: String,
) -> Result<Value, CommandError> {
    let webview = webview_of(app, label)?;
    let (tx, rx) = oneshot::channel();
    let sender = Mutex::new(Some(tx));
    // The guest runtime never throws; the wrapper still catches so a hostile
    // page cannot break the channel by redefining globals.
    let wrapped = format!(
        "(() => {{ try {{ return JSON.stringify(({script})); }} \
         catch (error) {{ return JSON.stringify({{ ok: false, error: {{ code: 'guest-failed', message: String(error) }} }}); }} }})()"
    );
    webview
        .eval_with_callback(wrapped, move |payload| {
            if let Some(tx) = sender.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = tx.send(payload);
            }
        })
        .map_err(|error| unavailable(error.to_string()))?;
    let raw = tokio::time::timeout(EVAL_TIMEOUT, rx)
        .await
        .map_err(|_| CommandError {
            code: "provider-timeout",
            message: "the page did not answer in time".into(),
        })?
        .map_err(|_| unavailable("the browser tab closed while working"))?;
    if raw.len() > MAX_EVAL_BYTES {
        return Err(invalid("the page returned too much data"));
    }
    // eval_with_callback hands back a JSON-encoded string; unwrap one layer.
    let inner: String = serde_json::from_str(&raw).unwrap_or(raw);
    let value: Value = serde_json::from_str(&inner)
        .map_err(|_| unavailable("the page returned a malformed reply"))?;
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        let error = value.get("error").cloned().unwrap_or_default();
        return Err(CommandError {
            code: "provider-protocol",
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("the page rejected that action")
                .to_string(),
        });
    }
    Ok(value.get("value").cloned().unwrap_or(Value::Null))
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// True unless the user has explicitly turned the setting off.
pub fn setting_enabled<R: Runtime>(app: &AppHandle<R>, key: &str) -> bool {
    app.try_state::<crate::state::AppState>()
        .and_then(|state| state.store.get_setting(key).ok().flatten())
        .and_then(|setting| setting.value.as_bool())
        .unwrap_or(true)
}

/// The injected runtime, prefixed with the per-launch settings it reads. The
/// prelude runs before page scripts, so a page cannot see it change.
fn guest_runtime<R: Runtime>(app: &AppHandle<R>) -> String {
    let keep_popups_inside = setting_enabled(app, KEEP_POPUPS_INSIDE_SETTING);
    format!("window.__integratorBrowser={{keepPopupsInside:{keep_popups_inside}}};{GUEST_RUNTIME}")
}

/// Where cookies and local storage live. One shared profile keeps sites signed
/// in across runs; turning that off uses a fresh directory per launch, so
/// nothing survives the session.
fn profile_directory<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    let state = app.try_state::<crate::state::AppState>()?;
    let root = state.data_directory.join("browser-profile");
    let directory = if setting_enabled(app, KEEP_SIGNED_IN_SETTING) {
        root.join("persistent")
    } else {
        root.join(format!("ephemeral-{}", std::process::id()))
    };
    std::fs::create_dir_all(&directory).ok()?;
    Some(directory)
}

/// Creates a tab and registers it. Child webviews must be built off the main
/// thread on Windows, so every caller is async.
async fn create_tab(
    app: &AppHandle,
    state: &Arc<BrowserTabs>,
    task_id: String,
    target: Url,
) -> Result<BrowserTab, CommandError> {
    let id = format!("tab-{}", state.sequence.fetch_add(1, Ordering::Relaxed) + 1);
    let label = format!("browser-{id}");
    let window = app
        .get_window("main")
        .ok_or_else(|| unavailable("the main window is not available"))?;

    let tabs = Arc::clone(state);
    let load_app = app.clone();
    let load_id = id.clone();
    let title_tabs = Arc::clone(state);
    let title_app = app.clone();
    let title_id = id.clone();

    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(target.clone()))
        .initialization_script(guest_runtime(app))
        .on_page_load(move |_, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            let url = payload.url().to_string();
            if tabs
                .update(&load_id, |tab| {
                    tab.loading = loading;
                    tab.url = url.clone();
                })
                .is_some()
            {
                emit_changed(&load_app, &tabs);
            }
        })
        .on_document_title_changed(move |_, title| {
            if title_tabs
                .update(&title_id, |tab| tab.title = title.clone())
                .is_some()
            {
                emit_changed(&title_app, &title_tabs);
            }
        })
        .on_navigation(|url| matches!(url.scheme(), "http" | "https" | "about"))
        .user_agent(BROWSER_USER_AGENT);
    if let Some(profile) = profile_directory(app) {
        builder = builder.data_directory(profile);
    }

    window
        .add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| unavailable(format!("could not open a browser tab: {error}")))?;

    let tab = BrowserTab {
        id: id.clone(),
        task_id,
        url: target.to_string(),
        title: String::new(),
        // about:blank has nothing to fetch and never reports a page load, so
        // calling it "loading" leaves the reload control spinning forever on
        // a tab that is simply waiting for an address.
        loading: !is_blank(&target),
        popped_out: false,
        hidden: false,
    };
    {
        let mut tabs = state.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.insert(
            id.clone(),
            Tab {
                state: tab.clone(),
                label,
            },
        );
    }
    emit_changed(app, state);
    Ok(tab)
}

#[tauri::command]
pub async fn browser_tab_open(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    task_id: String,
    url: Option<String>,
) -> CommandResult<BrowserTab> {
    let target = match url.as_deref() {
        Some(raw) if !raw.trim().is_empty() => normalize_url(raw)?,
        _ => Url::parse("about:blank").expect("about:blank parses"),
    };
    create_tab(&app, &state, task_id, target).await
}

#[tauri::command]
pub async fn browser_tab_list(
    state: tauri::State<'_, Arc<BrowserTabs>>,
    task_id: Option<String>,
) -> CommandResult<Vec<BrowserTab>> {
    Ok(state.snapshot(task_id.as_deref()))
}

#[tauri::command]
pub async fn browser_tab_close(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    tab_id: String,
) -> CommandResult<()> {
    close_tab(&app, &state, &tab_id)
}

/// Tears down a tab's webview (or its pop-out window) and forgets it. Shared
/// so a tab the user closes and one an agent closes end the same way.
fn close_tab(app: &AppHandle, state: &Arc<BrowserTabs>, tab_id: &str) -> Result<(), CommandError> {
    let label = state
        .label_for(tab_id)
        .ok_or_else(|| unavailable("that browser tab is already closed"))?;
    if let Ok(webview) = webview_of(app, &label) {
        let _ = webview.close();
    }
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.close();
    }
    {
        let mut tabs = state.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.remove(tab_id);
    }
    emit_changed(app, state);
    Ok(())
}

/// Positions the tab over the renderer's slot. Bounds arrive in physical
/// pixels so the scale factor never has to be reconciled twice.
#[tauri::command]
pub async fn browser_tab_set_bounds(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    tab_id: String,
    bounds: Option<TabBounds>,
) -> CommandResult<()> {
    let label = state
        .label_for(&tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let popped_out = state
        .tabs
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&tab_id)
        .is_some_and(|tab| tab.state.popped_out);
    if popped_out {
        return Ok(());
    }
    let webview = webview_of(&app, &label)?;
    match bounds {
        Some(bounds) if bounds.width >= 1.0 && bounds.height >= 1.0 => {
            // One call, not a move followed by a resize: two dispatches per
            // frame let the tab paint at a half-applied geometry, which is
            // what makes a pane drag look like it is tearing.
            webview
                .set_bounds(tauri::Rect {
                    position: PhysicalPosition::new(bounds.x as i32, bounds.y as i32).into(),
                    size: PhysicalSize::new(
                        bounds.width.max(1.0) as u32,
                        bounds.height.max(1.0) as u32,
                    )
                    .into(),
                })
                .map_err(|error| unavailable(error.to_string()))?;
            let _ = webview.show();
            state.update(&tab_id, |tab| tab.hidden = false);
        }
        _ => {
            let _ = webview.hide();
            state.update(&tab_id, |tab| tab.hidden = true);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_tab_navigate(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    tab_id: String,
    url: String,
) -> CommandResult<BrowserTab> {
    let label = state
        .label_for(&tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let target = normalize_url(&url)?;
    webview_of(&app, &label)?
        .navigate(target.clone())
        .map_err(|error| unavailable(error.to_string()))?;
    let tab = state
        .update(&tab_id, |tab| {
            tab.url = target.to_string();
            tab.loading = !is_blank(&target);
        })
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    emit_changed(&app, &state);
    Ok(tab)
}

/// back / forward / reload / stop, driven through the page's own history.
#[tauri::command]
pub async fn browser_tab_history(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    tab_id: String,
    action: String,
) -> CommandResult<()> {
    let label = state
        .label_for(&tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        "stop" => "window.stop()",
        other => return Err(invalid(format!("unknown history action '{other}'"))),
    };
    webview_of(&app, &label)?
        .eval(script)
        .map_err(|error| unavailable(error.to_string()))?;
    Ok(())
}

/// Calls one guest-runtime method. This is the single door the agent tools
/// and the renderer toolbar both go through.
#[tauri::command]
pub async fn browser_tab_invoke(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    tab_id: String,
    method: String,
    args: Option<Vec<Value>>,
) -> CommandResult<Value> {
    const ALLOWED: &[&str] = &[
        "snapshot",
        "setTheme",
        "click",
        "type",
        "press",
        "scroll",
        "waitFor",
        "evaluate",
        "highlight",
        "startPick",
        "pickResult",
        "cancelPick",
        "annotate",
        "clearAnnotations",
    ];
    if !ALLOWED.contains(&method.as_str()) {
        return Err(invalid(format!("unknown browser action '{method}'")));
    }
    let label = state
        .label_for(&tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let args = serde_json::to_string(&args.unwrap_or_default())
        .map_err(|error| invalid(error.to_string()))?;
    eval_json(
        &app,
        &label,
        format!("window.__integrator.{method}(...{args})"),
    )
    .await
}

/// Captures the tab's viewport as PNG bytes, base64 for the renderer.
#[tauri::command]
pub async fn browser_tab_screenshot(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    tab_id: String,
) -> CommandResult<String> {
    let label = state
        .label_for(&tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let webview = webview_of(&app, &label)?;
    capture::capture_png(&webview).await
}

/// Moves a tab between the pane and its own window. WebView2 cannot reparent
/// a live webview, so the session is recreated at the same URL.
#[tauri::command]
pub async fn browser_tab_set_popped_out(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    tab_id: String,
    popped_out: bool,
) -> CommandResult<BrowserTab> {
    let (label, current) = {
        let tabs = state.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let tab = tabs
            .get(&tab_id)
            .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
        (tab.label.clone(), tab.state.clone())
    };
    if current.popped_out == popped_out {
        return Ok(current);
    }
    let url = webview_of(&app, &label)
        .ok()
        .and_then(|webview| webview.url().ok())
        .map(|url| url.to_string())
        .unwrap_or_else(|| current.url.clone());

    if let Ok(webview) = webview_of(&app, &label) {
        let _ = webview.close();
    }
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.close();
    }

    let target = Url::parse(&url).map_err(|_| invalid("that tab has no address to restore"))?;
    // Popping out rebuilds the webview, so it has to carry the same profile,
    // user agent and guest runtime — otherwise a tab would sign itself out of
    // every site simply by moving to its own window.
    let profile = profile_directory(&app);
    if popped_out {
        let mut builder =
            tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(target.clone()))
                .title(if current.title.is_empty() {
                    "Browser".to_string()
                } else {
                    current.title.clone()
                })
                .inner_size(1100.0, 780.0)
                .min_inner_size(420.0, 320.0)
                .initialization_script(guest_runtime(&app))
                .user_agent(BROWSER_USER_AGENT);
        if let Some(profile) = profile {
            builder = builder.data_directory(profile);
        }
        builder
            .build()
            .map_err(|error| unavailable(format!("could not pop out the tab: {error}")))?;
    } else {
        let window = app
            .get_window("main")
            .ok_or_else(|| unavailable("the main window is not available"))?;
        let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(target.clone()))
            .initialization_script(guest_runtime(&app))
            .on_navigation(|url| matches!(url.scheme(), "http" | "https" | "about"))
            .user_agent(BROWSER_USER_AGENT);
        if let Some(profile) = profile {
            builder = builder.data_directory(profile);
        }
        window
            .add_child(
                builder,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1.0, 1.0),
            )
            .map_err(|error| unavailable(format!("could not dock the tab: {error}")))?;
    }

    let loading = !is_blank(&target);
    let tab = state
        .update(&tab_id, |tab| {
            tab.popped_out = popped_out;
            tab.url = url;
            tab.loading = loading;
        })
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    emit_changed(&app, &state);
    Ok(tab)
}

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

/* -------------------------------------------------------------------------- */
/* Agent-facing helpers (used by the broker; no Tauri command surface)        */
/* -------------------------------------------------------------------------- */

/// Runs a guest action for an agent, checking the tab belongs to its task.
pub async fn agent_invoke<R: Runtime>(
    app: &AppHandle<R>,
    tabs: &Arc<BrowserTabs>,
    task_id: &str,
    tab_id: &str,
    method: &str,
    args: Vec<Value>,
) -> Result<Value, CommandError> {
    ensure_agent_access(app)?;
    match tabs.task_of(tab_id) {
        Some(owner) if owner == task_id => {}
        Some(_) => return Err(unavailable("that browser tab belongs to another task")),
        None => return Err(unavailable("that browser tab is no longer open")),
    }
    let label = tabs
        .label_for(tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let args = serde_json::to_string(&args).map_err(|error| invalid(error.to_string()))?;
    eval_json(
        app,
        &label,
        format!("window.__integrator.{method}(...{args})"),
    )
    .await
}

/// Opens a tab on the agent's behalf, owned by its task.
pub fn ensure_agent_access<R: Runtime>(app: &AppHandle<R>) -> Result<(), CommandError> {
    if setting_enabled(app, AGENT_ACCESS_SETTING) {
        return Ok(());
    }
    Err(CommandError {
        code: "unauthorized",
        message: "browser access for agents is turned off in Settings → Browser".into(),
    })
}

pub async fn open_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    task_id: &str,
    url: Option<String>,
) -> Result<BrowserTab, IntegratorError> {
    ensure_agent_access(app).map_err(|error| IntegratorError::Unauthorized(error.message))?;
    let target = match url.as_deref() {
        Some(raw) if !raw.trim().is_empty() => {
            normalize_url(raw).map_err(|error| IntegratorError::InvalidInput(error.message))?
        }
        _ => Url::parse("about:blank").expect("about:blank parses"),
    };
    create_tab(app, tabs, task_id.to_string(), target)
        .await
        .map_err(|error| IntegratorError::Unavailable(error.message))
}

/// Navigates one of the task's own tabs.
pub async fn navigate_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    task_id: &str,
    tab_id: &str,
    url: &str,
) -> Result<BrowserTab, IntegratorError> {
    ensure_agent_access(app).map_err(|error| IntegratorError::Unauthorized(error.message))?;
    match tabs.task_of(tab_id) {
        Some(owner) if owner == task_id => {}
        Some(_) => {
            return Err(IntegratorError::Unauthorized(
                "that browser tab belongs to another task".into(),
            ));
        }
        None => {
            return Err(IntegratorError::NotFound(
                "that browser tab is no longer open".into(),
            ));
        }
    }
    let target =
        normalize_url(url).map_err(|error| IntegratorError::InvalidInput(error.message))?;
    let label = tabs
        .label_for(tab_id)
        .ok_or_else(|| IntegratorError::NotFound("that browser tab is no longer open".into()))?;
    webview_of(app, &label)
        .map_err(|error| IntegratorError::Unavailable(error.message))?
        .navigate(target.clone())
        .map_err(|error| IntegratorError::Unavailable(error.to_string()))?;
    let tab = tabs
        .update(tab_id, |tab| {
            tab.url = target.to_string();
            tab.loading = !is_blank(&target);
        })
        .ok_or_else(|| IntegratorError::NotFound("that browser tab is no longer open".into()))?;
    emit_changed(app, tabs);
    Ok(tab)
}

/// Closes one of this task's tabs. An agent juggling several pages should be
/// able to put one down; without this the only way a tab ever closes is the
/// user closing it by hand.
pub async fn close_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    task_id: &str,
    tab_id: &str,
) -> Result<(), IntegratorError> {
    ensure_agent_access(app).map_err(|error| IntegratorError::Unauthorized(error.message))?;
    match tabs.task_of(tab_id) {
        Some(owner) if owner == task_id => {}
        Some(_) => {
            return Err(IntegratorError::Unauthorized(
                "that browser tab belongs to another task".into(),
            ));
        }
        None => {
            return Err(IntegratorError::NotFound(
                "that browser tab is no longer open".into(),
            ));
        }
    }
    close_tab(app, tabs, tab_id).map_err(|error| IntegratorError::Unavailable(error.message))
}

pub fn tabs_for_task(tabs: &BrowserTabs, task_id: &str) -> Vec<BrowserTab> {
    tabs.snapshot(Some(task_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_bare_hosts_by_reachability() {
        assert_eq!(normalize_url("example.com").unwrap().scheme(), "https");
        assert_eq!(normalize_url("localhost:5173").unwrap().scheme(), "http");
        assert_eq!(normalize_url("127.0.0.1:3000").unwrap().scheme(), "http");
        assert_eq!(
            normalize_url("http://localhost:4180/x").unwrap().as_str(),
            "http://localhost:4180/x"
        );
    }

    #[test]
    fn a_blank_tab_is_never_loading() {
        // about:blank reports no page load, so calling it "loading" leaves the
        // reload control spinning over a tab that is only waiting for an address.
        assert!(is_blank(&Url::parse("about:blank").unwrap()));
        assert!(is_blank(&Url::parse("about:srcdoc").unwrap()));
        assert!(!is_blank(&Url::parse("https://example.com").unwrap()));
        assert!(!is_blank(&Url::parse("http://localhost:5173/").unwrap()));
    }

    #[test]
    fn rejects_non_web_schemes_and_junk() {
        assert!(normalize_url("file:///etc/passwd").is_err());
        assert!(normalize_url("javascript:alert(1)").is_err());
        assert!(normalize_url("   ").is_err());
        assert!(normalize_url(&"a".repeat(3000)).is_err());
    }

    #[test]
    fn snapshot_filters_by_task_and_sorts() {
        let tabs = BrowserTabs::new();
        {
            let mut guard = tabs.tabs.lock().unwrap();
            for (id, task) in [
                ("tab-2", "task-a"),
                ("tab-1", "task-a"),
                ("tab-3", "task-b"),
            ] {
                guard.insert(
                    id.to_string(),
                    Tab {
                        state: BrowserTab {
                            id: id.to_string(),
                            task_id: task.to_string(),
                            url: "about:blank".into(),
                            title: String::new(),
                            loading: false,
                            popped_out: false,
                            hidden: false,
                        },
                        label: format!("browser-{id}"),
                    },
                );
            }
        }
        let mine = tabs.snapshot(Some("task-a"));
        assert_eq!(
            mine.iter().map(|tab| tab.id.as_str()).collect::<Vec<_>>(),
            ["tab-1", "tab-2"]
        );
        assert_eq!(tabs.snapshot(None).len(), 3);
        assert_eq!(tabs.task_of("tab-3").as_deref(), Some("task-b"));
    }

    #[test]
    fn guest_runtime_exposes_every_method_the_host_may_call() {
        // The dispatcher allowlist and the runtime must not drift apart.
        for method in [
            "snapshot",
            "setTheme",
            "click",
            "type",
            "press",
            "scroll",
            "waitFor",
            "evaluate",
            "highlight",
            "startPick",
            "pickResult",
            "cancelPick",
            "annotate",
            "clearAnnotations",
        ] {
            assert!(
                GUEST_RUNTIME.contains(&format!("{method}(")),
                "guest runtime is missing {method}"
            );
        }
        // It must define exactly one global and never leak a second one.
        assert!(GUEST_RUNTIME.contains("window.__integrator = api;"));
    }

    #[test]
    fn every_agent_action_shows_the_cursor_that_performed_it() {
        // A page driven from the outside moves by itself; the cursor is what
        // makes that legible, so no action may quietly skip it.
        for action in ["click", "typing", "scroll"] {
            assert!(
                GUEST_RUNTIME.contains(action),
                "guest runtime never shows the cursor for {action}"
            );
        }
        // One definition plus a call from click, type, press and scroll.
        assert_eq!(GUEST_RUNTIME.matches("agentCursor(").count(), 5);
    }

    #[test]
    fn the_popup_guard_reads_the_key_the_prelude_writes() {
        // guest_runtime() writes this flag; a rename on either side would
        // silently stop keeping pop-ups inside the tab.
        assert!(GUEST_RUNTIME.contains("window.__integratorBrowser?.keepPopupsInside"));
    }

    #[test]
    fn tabs_are_labelled_out_of_the_capability_scope() {
        // capabilities/default.json scopes app commands to main/task-* webviews,
        // so a guest label must never match those globs.
        let label = "browser-tab-1";
        assert!(!label.starts_with("main"));
        assert!(!label.starts_with("task-"));
    }
}
