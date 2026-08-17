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

use crate::command_api::{CommandError, CommandResult};

mod agent;
mod capture;
mod popout;
mod remember;
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
/// What a tab measures while it is parked off screen. Wide enough that sites
/// serve their desktop layout, so a background tab and a visible one agree.
const OFFSCREEN_SIZE: (f64, f64) = (1280.0, 800.0);
const EVAL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_EVAL_BYTES: usize = 96 * 1024;

/// A tab with no page: the start page shows instead of a native surface.
pub(super) fn is_blank(url: &Url) -> bool {
    url.scheme() == "about" || url.as_str() == "about:blank"
}

pub(super) fn invalid(message: impl Into<String>) -> CommandError {
    CommandError {
        code: "invalid-input",
        message: message.into(),
    }
}

pub(super) fn unavailable(message: impl Into<String>) -> CommandError {
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
    /// Set while an agent is driving this tab, so a second one can see that
    /// someone is mid-flow here and open its own rather than take the wheel.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub held_by: Option<String>,
    /// Remembered from a previous session and not yet loaded. It has an address
    /// and a title but no webview, so a chat can come back with a dozen tabs
    /// without fetching a dozen pages.
    pub sleeping: bool,
}

struct Tab {
    state: BrowserTab,
    /// Label of the webview; also the pop-out window label when popped out.
    label: String,
    /// Who last drove this tab through the broker, and when. A page can only
    /// be in one state at a time, so two agents taking turns on one tab undo
    /// each other's work; this is what lets the second one notice.
    held: Option<(String, std::time::Instant)>,
    /// How many documents this tab has loaded. The guest is rebuilt per
    /// document and cannot count them itself, so the host does and pushes the
    /// number in; refs carry it, and one from an earlier page reads as stale.
    generation: u64,
}

/// How long after an agent's last action the tab still reads as theirs.
const HOLD_TTL: Duration = Duration::from_secs(45);

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
            .map(|tab| {
                let mut state = tab.state.clone();
                // A hold is reported only while it is fresh, so nothing has to
                // remember to release one when a run ends or an agent dies.
                state.held_by = tab
                    .held
                    .as_ref()
                    .filter(|(_, at)| at.elapsed() < HOLD_TTL)
                    .map(|(who, _)| who.clone());
                state
            })
            .collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    /// Counts a fresh document and returns the new generation.
    fn bump_generation(&self, id: &str) -> Option<u64> {
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let tab = tabs.get_mut(id)?;
        tab.generation += 1;
        Some(tab.generation)
    }

    /// Records that `holder` just drove this tab.
    pub(super) fn mark_held(&self, id: &str, holder: &str) {
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(tab) = tabs.get_mut(id) {
            tab.held = Some((holder.to_string(), std::time::Instant::now()));
        }
    }

    /// Who is driving this tab right now, if anyone other than `asker`.
    pub(super) fn held_by_other(&self, id: &str, asker: &str) -> Option<String> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.get(id)
            .and_then(|tab| tab.held.as_ref())
            .filter(|(who, at)| who != asker && at.elapsed() < HOLD_TTL)
            .map(|(who, _)| who.clone())
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

pub(super) fn emit_changed<R: Runtime>(app: &AppHandle<R>, tabs: &BrowserTabs) {
    let _ = app.emit(BROWSER_EVENT, json!({ "tabs": tabs.snapshot(None) }));
}

/// Accepts only http(s); a bare host defaults to https, loopback to http.
pub(super) fn normalize_url(input: &str) -> Result<Url, CommandError> {
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

pub(super) fn webview_of<R: Runtime>(
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
pub(super) async fn eval_json<R: Runtime>(
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
pub(super) fn setting_enabled<R: Runtime>(app: &AppHandle<R>, key: &str) -> bool {
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

/// The one place a tab's webview is described. A tab that pops out and comes
/// back has to arrive with the same runtime, profile and reporting it left
/// with, or it returns as a page that never updates its address or title.
pub(super) fn tab_webview_builder(
    app: &AppHandle,
    state: &Arc<BrowserTabs>,
    id: &str,
    label: &str,
    target: &Url,
) -> WebviewBuilder<tauri::Wry> {
    let tabs = Arc::clone(state);
    let load_app = app.clone();
    let load_id = id.to_string();
    let title_tabs = Arc::clone(state);
    let title_app = app.clone();
    let title_id = id.to_string();

    let mut builder = WebviewBuilder::new(label, WebviewUrl::External(target.clone()))
        .initialization_script(guest_runtime(app))
        .on_page_load(move |webview, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            let url = payload.url().to_string();
            // A finished load is a new document with a fresh guest that starts
            // at generation zero. Tell it which document it is, so refs handed
            // out before the navigation can be recognised as stale rather than
            // reported as elements that simply went away.
            if !loading && let Some(generation) = tabs.bump_generation(&load_id) {
                let _ = webview.eval(format!(
                    "window.__integrator?.setGeneration?.({generation})"
                ));
            }
            if tabs
                .update(&load_id, |tab| {
                    tab.loading = loading;
                    tab.url = url.clone();
                })
                .is_some()
            {
                emit_changed(&load_app, &tabs);
                if !loading && let Some(task) = tabs.task_of(&load_id) {
                    remember::remember(&load_app, &tabs, &task);
                }
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
    builder
}

/// Puts a tab's webview back inside the main window. Shared by the dock
/// control and by a pop-out window closing, so both land in the same state.
pub(super) fn dock_tab(
    app: &AppHandle,
    state: &Arc<BrowserTabs>,
    id: &str,
    label: &str,
    target: &Url,
) -> Result<(), CommandError> {
    let window = app
        .get_window("main")
        .ok_or_else(|| unavailable("the main window is not available"))?;
    window
        .add_child(
            tab_webview_builder(app, state, id, label, target),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| unavailable(format!("could not dock the tab: {error}")))?;
    state.update(id, |tab| {
        tab.popped_out = false;
        // The renderer re-places it as soon as it sees the change; until then
        // a one-pixel webview in the corner is better than a stale rectangle.
        tab.hidden = true;
    });
    emit_changed(app, state);
    Ok(())
}

/// Creates a tab and registers it. Child webviews must be built off the main
/// thread on Windows, so every caller is async.
pub(super) async fn create_tab(
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

    let builder = tab_webview_builder(app, state, &id, &label, &target);

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
        held_by: None,
        sleeping: false,
    };
    {
        let mut tabs = state.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.insert(
            id.clone(),
            Tab {
                state: tab.clone(),
                label,
                held: None,
                generation: 0,
            },
        );
    }
    emit_changed(app, state);
    remember::remember(app, state, &tab.task_id);
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

/// Brings back the tabs this chat had open, asleep. Called when a task becomes
/// active; a task that already has tabs in this session is left alone.
#[tauri::command]
pub async fn browser_tabs_restore(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    task_id: String,
) -> CommandResult<Vec<BrowserTab>> {
    remember::restore(&app, &state, &task_id);
    Ok(state.snapshot(Some(&task_id)))
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
pub(super) fn close_tab(
    app: &AppHandle,
    state: &Arc<BrowserTabs>,
    tab_id: &str,
) -> Result<(), CommandError> {
    let label = state
        .label_for(tab_id)
        .ok_or_else(|| unavailable("that browser tab is already closed"))?;
    if let Ok(webview) = webview_of(app, &label) {
        let _ = webview.close();
    }
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.close();
    }
    let task = state.task_of(tab_id);
    {
        let mut tabs = state.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.remove(tab_id);
    }
    emit_changed(app, state);
    if let Some(task) = task {
        remember::remember(app, state, &task);
    }
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
    remember::ensure_awake(&app, &state, &tab_id).await;
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
    if state.sleeping_target(&tab_id).is_some() {
        // The renderer only reports a rectangle for a tab it is showing, so this
        // is the moment a remembered tab is actually wanted.
        if bounds.is_some() {
            let _ = remember::wake(&app, &state, &tab_id).await;
        } else {
            return Ok(());
        }
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
            // Parked, not shrunk. A tab the pane is not showing used to be left
            // at one pixel, and the page went on answering: a snapshot reported
            // a 2×2 viewport, every element measured at x=0, and nothing in the
            // reply said the geometry was meaningless. Off to the side at a real
            // size means an agent working a background tab gets numbers that
            // are true, and `pageState().offscreen` says it cannot be seen.
            webview
                .set_bounds(tauri::Rect {
                    position: LogicalPosition::new(-(OFFSCREEN_SIZE.0 + 200.0), 0.0).into(),
                    size: LogicalSize::new(OFFSCREEN_SIZE.0, OFFSCREEN_SIZE.1).into(),
                })
                .map_err(|error| unavailable(error.to_string()))?;
            let _ = webview.show();
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
    remember::ensure_awake(&app, &state, &tab_id).await;
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
    remember::ensure_awake(&app, &state, &tab_id).await;
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
        "setGeneration",
        "hover",
        "click",
        "type",
        "press",
        "scroll",
        "drag",
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
    remember::ensure_awake(&app, &state, &tab_id).await;
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
    remember::ensure_awake(&app, &state, &tab_id).await;
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
    if popped_out {
        popout::adopt(&app, &state, &tab_id, &label, &target)?;
        let loading = !is_blank(&target);
        let tab = state
            .update(&tab_id, |tab| {
                tab.url = url;
                tab.loading = loading;
            })
            .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
        emit_changed(&app, &state);
        return Ok(tab);
    }

    dock_tab(&app, &state, &tab_id, &label, &target)?;
    let loading = !is_blank(&target);
    let tab = state
        .update(&tab_id, |tab| {
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
pub use agent::{agent_invoke, close_for_agent, navigate_for_agent, open_for_agent, tabs_for_task};

#[cfg(test)]
mod tests;
