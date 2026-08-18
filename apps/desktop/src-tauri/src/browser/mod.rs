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
    sync::{Arc, Mutex, OnceLock, atomic::Ordering},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    Runtime, WebviewUrl,
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
};
use tokio::sync::oneshot;
use url::Url;
use zeroize::Zeroizing;

use crate::command_api::{CommandError, CommandResult};

mod agent;
mod capture;
mod cleanup;
mod direct_capture;
mod favicon;
pub mod groups;
mod identity;
mod identity_migration;
mod menu;
mod persist;
mod popout;
mod registry;
mod remember;
mod restore;
mod servers;
pub(crate) mod sites;
mod surface;
mod vault;
mod windows;

pub use groups::Group;
pub use identity::BrowserIdentityScope;
pub(crate) use identity::{configured_scope, prepare_profile_layout, prune_ephemeral_profiles};
pub(crate) use identity_migration::migrate_task_buckets_to_groups;
pub use menu::browser_tab_menu;
pub use persist::{
    browser_recent_tabs, browser_recent_tabs_clear, browser_window_set_collapsed,
    browser_window_state, start_background_tasks,
};
pub use popout::{
    browser_popout_tabs, browser_tab_move, browser_tab_set_popped_out, browser_window_reorder,
};
pub use registry::{BrowserTab, BrowserTabs, Caller, GrantMode};
pub(crate) use registry::{PlacementSlot, Tab, USER_HOLDER, note_user_activity};
pub use servers::browser_local_servers;
pub use sites::{
    browser_bucket_sites, browser_clear_bucket, browser_clear_data, browser_identity_overview,
    browser_set_identity_scope, browser_sites,
};
pub(crate) use vault::migrate_legacy_logins;
pub use windows::{browser_drag_end, browser_drag_hit_test};

pub const BROWSER_EVENT: &str = "browser://changed";
/// An agent asking the renderer to bring one tab to the front. The renderer
/// owns layout, so this is a request, and `browser_focus` reports what came of
/// it rather than pretending it landed.
pub const BROWSER_FOCUS_EVENT: &str = "browser://focus";
/// A tool reply may carry extra MCP content blocks — an image, say — under
/// this key. The broker lifts them out and sends them beside the JSON text,
/// which is the only way a picture reaches a model through MCP; left in the
/// text they would be a base64 blob the model reads as characters.
pub const MCP_CONTENT_KEY: &str = "$mcpContent";
/// An agent asking to sign in on a site the user has not allowed it to. The
/// app asks; the agent is told to try again rather than being made to wait.
pub const BROWSER_FILL_REQUEST_EVENT: &str = "browser://fill-request";
/// A trusted click in the guest's closed-shadow context menu. The main
/// renderer performs the task-scoped action; remote page code cannot emit one
/// because the command also requires the per-launch host key.
pub const BROWSER_CONTEXT_ACTION_EVENT: &str = "browser://context-action";
/// Sites stay signed in between runs unless the user turns this off.
pub const KEEP_SIGNED_IN_SETTING: &str = "settings.browser.keepSignedIn";
pub const IDENTITY_SCOPE_SETTING: &str = identity::IDENTITY_SCOPE_SETTING;
/// Whether agents may open and drive browser tabs for this installation.
pub const AGENT_ACCESS_SETTING: &str = "settings.browser.agentAccess";
/// When on, a recent real keystroke in a tab stands agents off that page.
/// Off by default: agents work the same tab alongside the person using it.
pub const LOCK_ACTIVE_TAB_SETTING: &str = "settings.browser.lockActiveTab";
/// Whether a page's `window.open` becomes a navigation in the same tab.
pub const KEEP_POPUPS_INSIDE_SETTING: &str = "settings.browser.blockNewWindows";
/// Whether the UI may hand a tab to the system browser. Off also forbids
/// agents from using any browser surface other than Integrator's `browser_*`.
pub const EXTERNAL_OPEN_SETTING: &str = "settings.browser.externalOpen";
/// Whether a recognised cookie-consent dialog is declined automatically. Off
/// unless asked for: it is a preference, and both answers are legitimate.
pub const DISMISS_CONSENT_SETTING: &str = "settings.browser.dismissConsent";
const GUEST_RUNTIME: &str = include_str!("guest.js");
/// What a tab measures while it is parked off screen. Wide enough that sites
/// serve their desktop layout, so a background tab and a visible one agree.
const OFFSCREEN_SIZE: (f64, f64) = (1280.0, 800.0);
const EVAL_TIMEOUT: Duration = Duration::from_secs(15);
/// How often the host asks the guest whether a deferred reply has settled.
const EVAL_SETTLE_POLL: Duration = Duration::from_millis(30);
/// The key a wrapper reply carries when the guest parked a Promise. Distinct
/// enough that no guest method's own reply can be mistaken for it.
const EVAL_TICKET_KEY: &str = "__integratorTicket";
const MAX_EVAL_BYTES: usize = 96 * 1024;
const MAX_CONTEXT_TEXT_CHARS: usize = 4_000;
const MAX_NAVIGATION_URL_BYTES: usize = 16 * 1024;
const BROWSER_CONTEXT_SCHEME: &str = "integrator-browser-context";

pub(crate) fn requires_dedicated_setting_command(key: &str) -> bool {
    key == IDENTITY_SCOPE_SETTING || setting_is_internal(key)
}

pub(crate) fn setting_is_internal(key: &str) -> bool {
    key == vault::SAVED_LOGINS_SETTING || key.starts_with(vault::AGENT_SIGN_IN_PREFIX)
}

/// Where a tab waits when nothing is showing it: outside the window's client
/// area, at a size a site serves its desktop layout to. A new tab starts here
/// rather than as a pixel in the corner, so a page that loads before the
/// renderer has placed it still measures itself honestly — an agent working
/// with the pane closed is the normal case, not the exception.
pub(super) fn parked() -> (LogicalPosition<f64>, LogicalSize<f64>) {
    (
        LogicalPosition::new(-(OFFSCREEN_SIZE.0 + 200.0), 0.0),
        LogicalSize::new(OFFSCREEN_SIZE.0, OFFSCREEN_SIZE.1),
    )
}

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

pub(super) fn emit_changed<R: Runtime>(app: &AppHandle<R>, _tabs: &BrowserTabs) {
    let _ = app.emit(BROWSER_EVENT, ());
}

/// The renderer must name the task it is displaying for every tab operation.
/// A mismatched tab is reported as absent so one window cannot probe another
/// chat's browser state by id.
pub(super) fn require_task(
    tabs: &BrowserTabs,
    task_id: &str,
    tab_id: &str,
) -> Result<(), CommandError> {
    if tabs.task_of(tab_id).as_deref() == Some(task_id) {
        return Ok(());
    }
    Err(unavailable("that browser tab is no longer open"))
}

/// Main may address every task; a task window the task in its label; a
/// browser window any task it holds a tab of.
fn renderer_may_address_task(tabs: &BrowserTabs, label: &str, task_id: &str) -> bool {
    label == "main"
        || label == format!("task-{task_id}")
        || popout::window_holds_task(tabs, label, task_id)
}

/// Main may coordinate every task; a secondary task or browser window may
/// address only the tasks its own trusted native label reaches.
pub(super) fn require_renderer_task<R: Runtime>(
    webview: &tauri::Webview<R>,
    task_id: &str,
) -> Result<(), CommandError> {
    let label = webview.label();
    let holds = webview
        .app_handle()
        .try_state::<Arc<BrowserTabs>>()
        .is_some_and(|tabs| renderer_may_address_task(&tabs, label, task_id));
    if holds {
        Ok(())
    } else {
        Err(unavailable("that browser tab is no longer open"))
    }
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
    // The blank page has no host to prefix. Read as a bare host, "about:blank"
    // became "https://about:blank" — a port of "blank" — so pointing a tab back
    // at the very page `browser_open` starts it on was refused as junk.
    if let Ok(url) = Url::parse(trimmed)
        && url.as_str() == "about:blank"
    {
        return Ok(url);
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
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid("browser URLs cannot contain embedded credentials"));
    }
    if browser_navigation_allowed(&url) {
        Ok(url)
    } else {
        Err(invalid(format!(
            "{} links do not open in a browser tab",
            url.scheme()
        )))
    }
}

fn browser_navigation_allowed(url: &Url) -> bool {
    url.as_str().len() <= MAX_NAVIGATION_URL_BYTES
        && url.username().is_empty()
        && url.password().is_none()
        && (matches!(url.scheme(), "http" | "https") || is_blank(url))
}

fn bounded_page_title(title: &str) -> String {
    title
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(512)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn bounded_guest_message(message: &str) -> String {
    message
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(500)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
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
/// One round trip: run a script that returns a JSON string, and parse it. The
/// deadline is shared across the polls of one `eval_json` call.
async fn eval_once<R: Runtime>(
    webview: &tauri::Webview<R>,
    script: &str,
    deadline: tokio::time::Instant,
) -> Result<Value, CommandError> {
    let (tx, rx) = oneshot::channel();
    let sender = Mutex::new(Some(tx));
    webview
        .eval_with_callback(script, move |payload| {
            if let Some(tx) = sender.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = tx.send(payload);
            }
        })
        .map_err(|error| unavailable(error.to_string()))?;
    let raw = Zeroizing::new(
        tokio::time::timeout_at(deadline, rx)
            .await
            .map_err(|_| CommandError {
                code: "provider-timeout",
                message: "the page did not answer in time".into(),
            })?
            .map_err(|_| unavailable("the browser tab closed while working"))?,
    );
    if raw.len() > MAX_EVAL_BYTES {
        return Err(invalid("the page returned too much data"));
    }
    // eval_with_callback hands back a JSON-encoded string; unwrap one layer.
    let inner = serde_json::from_str::<String>(&raw)
        .ok()
        .map(Zeroizing::new);
    let encoded = inner
        .as_ref()
        .map(|value| value.as_str())
        .unwrap_or_else(|| raw.as_str());
    serde_json::from_str(encoded).map_err(|_| unavailable("the page returned a malformed reply"))
}

/// Wraps an expression that reaches into the guest runtime.
///
/// A document part-way through a navigation has no `window.__integrator` yet:
/// reading a method off it threw, the wrapper reported that as `guest-failed`,
/// and a `browser_wait_for` polling a loading page gave up on its first poll
/// with "Cannot read properties of undefined". A missing runtime is a *not
/// yet*, so it answers in a code a caller can wait out rather than an error
/// that reads like a broken page.
pub(super) fn guest_call(expression: String) -> String {
    format!(
        "(window.__integrator ? ({expression}) : {{ ok: false, error: {{ code: {NOT_READY:?}, \
         message: 'this tab is between pages, so its runtime is not injected yet — try again' }} }})"
    )
}

const NOT_READY: &str = "guest-not-ready";
/// The guest answered for a document this tab has since left. See `settle`.
const NAVIGATED: &str = "page-navigated";

/// One guest call at a time per webview.
///
/// A deferred reply is two round trips — park a ticket, then poll `settle` —
/// and the guest runs a still-pending gesture early the moment a second action
/// arrives (see `schedule` in guest.js), so two calls in flight on one tab
/// interleave. Worse, a navigation between the pair rebuilds the guest with its
/// ticket counter back at zero, which is how one action came to read another's
/// reply. Held across the pair, this keeps every reply with the call that asked
/// for it.
fn eval_lock_for(label: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    // Tabs come and go; drop the locks nothing is waiting on rather than
    // keeping an entry per label this app has ever opened.
    if locks.len() > 64 {
        locks.retain(|_, lock| Arc::strong_count(lock) > 1);
    }
    Arc::clone(locks.entry(label.to_string()).or_default())
}

/// A ticket is the guest's own text; it is put back into a script, so nothing
/// but the shape the guest issues may travel there.
fn ticket_is_well_formed(ticket: &str) -> bool {
    !ticket.is_empty()
        && ticket.len() <= 64
        && ticket
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | ':'))
}

pub(super) async fn eval_json<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    script: String,
) -> Result<Value, CommandError> {
    let script = Zeroizing::new(script);
    let webview = webview_of(app, label)?;
    let lock = eval_lock_for(label);
    let _turn = lock.lock().await;
    // The guest runtime never throws; the wrapper still catches so a hostile
    // page cannot break the channel by redefining globals.
    //
    // The wrapper is synchronous on purpose. WebView2's ExecuteScript reports
    // the value of the expression as it stands and serialises a Promise as
    // `{}` — an `async` wrapper here made every reply read as null. An action
    // that finishes later (a click waits for the pointer to arrive, so the
    // reply is the page after the gesture) is parked in the guest under a
    // ticket, and the host polls `settle` until it has resolved.
    let wrapped = Zeroizing::new(format!(
        "(() => {{ try {{ const value = ({script}); \
         if (value && typeof value.then === 'function') {{ \
         const guest = window.__integrator; \
         if (!guest) return JSON.stringify({{ ok: false, error: {{ code: {NOT_READY:?}, message: 'this tab is between pages, so its runtime is not injected yet — try again' }} }}); \
         return JSON.stringify({{ {ticket}: guest.defer(value) }}); }} \
         return JSON.stringify(value); }} \
         catch (error) {{ return JSON.stringify({{ ok: false, error: {{ code: 'guest-failed', message: String(error) }} }}); }} }})()",
        script = script.as_str(),
        ticket = EVAL_TICKET_KEY,
    ));
    let deadline = tokio::time::Instant::now() + EVAL_TIMEOUT;
    let mut value = eval_once(&webview, wrapped.as_str(), deadline).await?;
    if let Some(ticket) = value.get(EVAL_TICKET_KEY).and_then(Value::as_str) {
        if !ticket_is_well_formed(ticket) {
            return Err(unavailable("the page returned a malformed reply"));
        }
        // A guest that is not there yet answers `done: false`, so a navigation
        // in the middle of a gesture keeps polling until the new document can
        // say what became of it rather than failing on the gap between the two.
        let settle = format!(
            "(() => {{ try {{ const guest = window.__integrator; \
             if (!guest) return JSON.stringify({{ done: false }}); \
             return JSON.stringify(guest.settle({ticket:?})); }} \
             catch (error) {{ return JSON.stringify({{ done: true, value: {{ ok: false, error: {{ code: 'guest-failed', message: String(error) }} }} }}); }} }})()"
        );
        loop {
            tokio::time::sleep(EVAL_SETTLE_POLL).await;
            let entry = eval_once(&webview, &settle, deadline).await?;
            if entry.get("done").and_then(Value::as_bool) == Some(true) {
                value = entry.get("value").cloned().unwrap_or(Value::Null);
                break;
            }
        }
    }
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        let error = value.get("error").cloned().unwrap_or_default();
        return Err(CommandError {
            // Most guest refusals are protocol-shaped, but "someone else has
            // this page" is the same answer the host gives for an agent hold
            // and deserves the same code, so a caller can treat it as one case.
            code: match error.get("code").and_then(Value::as_str) {
                Some("user-holding") => "unavailable",
                // Both of these are momentary rather than wrong, and a caller
                // that can wait — `browser_wait_for` — needs to tell them from
                // a page that genuinely refused the action.
                Some(NOT_READY) => NOT_READY,
                Some(NAVIGATED) => NAVIGATED,
                _ => "provider-protocol",
            },
            message: bounded_guest_message(
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("the page rejected that action"),
            ),
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
/// One boolean setting, with the default to fall back on when it is unset.
pub(super) fn setting_is<R: Runtime>(app: &AppHandle<R>, key: &str, default: bool) -> bool {
    app.try_state::<crate::state::AppState>()
        .and_then(|state| state.store.get_setting(key).ok().flatten())
        .and_then(|setting| setting.value.as_bool())
        .unwrap_or(default)
}

/// One whole-number setting, with the default for when it is unset or not a
/// number. Negative values read as the default.
pub(super) fn setting_u64<R: Runtime>(app: &AppHandle<R>, key: &str, default: u64) -> u64 {
    app.try_state::<crate::state::AppState>()
        .and_then(|state| state.store.get_setting(key).ok().flatten())
        .and_then(|setting| {
            setting
                .value
                .as_u64()
                .or_else(|| setting.value.as_str()?.trim().parse().ok())
        })
        .unwrap_or(default)
}

pub(super) fn setting_enabled<R: Runtime>(app: &AppHandle<R>, key: &str) -> bool {
    app.try_state::<crate::state::AppState>()
        .and_then(|state| state.store.get_setting(key).ok().flatten())
        .and_then(|setting| setting.value.as_bool())
        .unwrap_or(true)
}

/// Off unless the user turned on exclusive use of the tab they are in.
pub(super) fn lock_active_tab<R: Runtime>(app: &AppHandle<R>) -> bool {
    setting_is(app, LOCK_ACTIVE_TAB_SETTING, false)
}

/// The injected runtime, prefixed with the per-launch settings it reads. The
/// prelude runs before page scripts, so a page cannot see it change.
fn guest_runtime<R: Runtime>(app: &AppHandle<R>, tabs: &BrowserTabs) -> String {
    let keep_popups_inside = setting_enabled(app, KEEP_POPUPS_INSIDE_SETTING);
    // Default off, unlike the other two: nothing should be clicked on the
    // user's behalf unless they asked for it.
    let dismiss_consent = setting_is(app, DISMISS_CONSENT_SETTING, false);
    let host_key = tabs.host_key();
    format!(
        "window.__integratorBrowser={{keepPopupsInside:{keep_popups_inside},\
         dismissConsent:{dismiss_consent},hostKey:{host_key:?}}};{GUEST_RUNTIME}"
    )
}

/// Where cookies and local storage live. One shared profile keeps sites signed
/// in across runs; turning that off uses a fresh directory per launch, so
/// nothing survives the session.
fn profile_directory<R: Runtime>(
    app: &AppHandle<R>,
    tabs: &BrowserTabs,
    task_id: &str,
) -> Option<std::path::PathBuf> {
    let state = app.try_state::<crate::state::AppState>()?;
    let scope = tabs.identity_scope();
    let bucket = identity::bucket_for_task(app, tabs, scope, task_id);
    identity::profile_directory(
        &state.data_directory,
        scope,
        &bucket,
        setting_enabled(app, KEEP_SIGNED_IN_SETTING),
    )
    .ok()
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
    task_id: &str,
) -> WebviewBuilder<tauri::Wry> {
    let tabs = Arc::clone(state);
    let load_app = app.clone();
    let load_id = id.to_string();
    let title_tabs = Arc::clone(state);
    let title_app = app.clone();
    let title_id = id.to_string();
    let load_label = label.to_string();
    let context_tabs = Arc::clone(state);
    let context_app = app.clone();
    let context_id = id.to_string();
    let context_task_id = task_id.to_string();

    let builder = WebviewBuilder::new(label, WebviewUrl::External(target.clone()))
        // Keep addresses and other ambient WebView profile data out of task
        // identities. Password autofill is separate and remains vendor-owned.
        .general_autofill_enabled(false)
        .initialization_script(guest_runtime(app, state))
        .on_page_load(move |webview, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            let url = payload.url().to_string();
            // Leaving the page ends the secret being on it: the form is gone
            // and the new document's guest has nothing filled in.
            tabs.clear_credential(&load_id);
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
            if loading {
                // Show the host's known icon at once and start asking the page
                // for its own while it is still loading.
                favicon::resolve_early(&load_app, &tabs, &load_id, &load_label, &url);
            } else {
                poster_when_settled(&load_app, &tabs, &load_id);
                favicon::refresh(&load_app, &tabs, &load_id, &load_label);
            }
        })
        .on_document_title_changed(move |webview, title| {
            let title = bounded_page_title(&title);
            if title_tabs
                .update(&title_id, |tab| tab.title = title.clone())
                .is_some()
            {
                emit_changed(&title_app, &title_tabs);
                if let Some(task) = title_tabs.task_of(&title_id) {
                    remember::remember(&title_app, &title_tabs, &task);
                }
                // A single-page app changes title and icon together without a
                // load event in sight, so a new title is a cue to look again.
                favicon::refresh_gently(&title_app, &title_tabs, &title_id, webview.label());
            }
        })
        .on_new_window(move |url, _| {
            if url.scheme() != BROWSER_CONTEXT_SCHEME {
                return if browser_navigation_allowed(&url) {
                    NewWindowResponse::Allow
                } else {
                    NewWindowResponse::Deny
                };
            }
            if let Some(payload) =
                context_action_from_url(&context_tabs, &context_task_id, &context_id, &url)
            {
                let _ = context_app.emit(BROWSER_CONTEXT_ACTION_EVENT, payload);
            }
            // This is a signal, never a browser window.
            NewWindowResponse::Deny
        })
        .on_navigation(browser_navigation_allowed);
    let mut builder = surface::apply(builder);
    if let Some(profile) = profile_directory(app, state, task_id) {
        builder = builder.data_directory(profile);
    }
    builder
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

    let builder = tab_webview_builder(app, state, &id, &label, &target, &task_id);

    let webview = window
        .add_child(builder, parked().0, parked().1)
        .map_err(|error| unavailable(format!("could not open a browser tab: {error}")))?;
    // Off-screen geometry preserves a useful desktop viewport for an agent,
    // but geometry alone still exposes this page to Windows accessibility in
    // whichever chat owns the host window. Keep it genuinely hidden until a
    // pane, deck, or popout claims it.
    if let Err(error) = webview.hide() {
        let _ = webview.close();
        return Err(unavailable(format!(
            "could not hide the new browser tab: {error}"
        )));
    }

    let group = groups::group_for_task(app, state, &task_id);
    let tab = BrowserTab {
        id: id.clone(),
        task_id,
        group_id: group.id,
        group_name: group.name,
        group_kind: group.kind,
        url: target.to_string(),
        title: String::new(),
        favicon: favicon::cached_for_url(target.as_str()),
        // about:blank has nothing to fetch and never reports a page load, so
        // calling it "loading" leaves the reload control spinning forever on
        // a tab that is simply waiting for an address.
        loading: !is_blank(&target),
        popped_out: false,
        hidden: true,
        held_by: None,
        agent_protected_until: None,
        sleeping: false,
        delegation_id: None,
    };
    {
        let mut tabs = state.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.insert(
            id.clone(),
            Tab {
                state: tab.clone(),
                label,
                window: None,
                order: 0,
                placement_slot: None,
                held: None,
                held_task: None,
                user_at: None,
                grants: HashMap::new(),
                generation: 0,
                touched: std::time::Instant::now(),
                touched_at: chrono::Utc::now(),
                credential_at: None,
                poster: None,
            },
        );
    }
    // One more tab may be one too many: put the group back under its live cap
    // before telling anyone the new tab exists.
    remember::enforce_cap(app, state, &tab.group_id, &tab.id);
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
    Ok(state.snapshot_held(Some(&task_id), lock_active_tab(&app)))
}

#[tauri::command]
pub async fn browser_tab_list(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    task_id: String,
) -> CommandResult<Vec<BrowserTab>> {
    Ok(state.snapshot_held(Some(&task_id), lock_active_tab(&app)))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserContextAction {
    task_id: String,
    tab_id: String,
    action: String,
    page_url: String,
    page_title: String,
    target_url: Option<String>,
    text: Option<String>,
}

fn bounded_context_text(value: Option<String>, limit: usize) -> Option<String> {
    let value = value?.trim().to_string();
    if value.is_empty() {
        return None;
    }
    Some(value.chars().take(limit).collect())
}

/// Parses the closed-shadow menu's intercepted `window.open`. The captured
/// native function carries the launch key straight to this handler; no real
/// window opens and no remote IPC permission is granted to the page.
fn context_action_from_url(
    state: &BrowserTabs,
    task_id: &str,
    tab_id: &str,
    url: &Url,
) -> Option<BrowserContextAction> {
    if url.scheme() != BROWSER_CONTEXT_SCHEME {
        return None;
    }
    let values: HashMap<_, _> = url.query_pairs().into_owned().collect();
    if values.get("key")? != &state.host_key() {
        return None;
    }
    let action = values.get("action")?.to_string();
    let target_url = values
        .get("url")
        .filter(|raw| !raw.trim().is_empty())
        .and_then(|raw| normalize_url(raw).ok())
        .map(|url| url.to_string());
    match action.as_str() {
        "open-tab" if target_url.is_none() => return None,
        "open-tab" | "send-chat" => {}
        _ => return None,
    }

    let tab = state
        .snapshot(Some(task_id))
        .into_iter()
        .find(|tab| tab.id == tab_id)?;
    Some(BrowserContextAction {
        task_id: task_id.to_string(),
        tab_id: tab_id.to_string(),
        action,
        page_url: tab.url,
        page_title: tab.title.chars().take(300).collect(),
        target_url,
        text: bounded_context_text(values.get("text").cloned(), MAX_CONTEXT_TEXT_CHARS),
    })
}

#[tauri::command]
pub async fn browser_tab_close(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    task_id: String,
    tab_id: String,
    force: Option<bool>,
) -> CommandResult<bool> {
    require_task(&state, &task_id, &tab_id)?;
    // The recent-agent-work guard turns an X into a minimize; `force` is the
    // person saying they meant close. The strips always mean close.
    if !force.unwrap_or(false) && state.agent_recently_used(&tab_id) {
        return Ok(false);
    }
    close_tab(&app, &state, &tab_id)?;
    Ok(true)
}

/// Tears down a tab's webview (or its pop-out window) and forgets it. Shared
/// so a tab the user closes and one an agent closes end the same way.
pub(super) fn close_tab(
    app: &AppHandle,
    state: &Arc<BrowserTabs>,
    tab_id: &str,
) -> Result<(), CommandError> {
    close_tab_with(app, state, tab_id, true)
}

/// `close_tab`, choosing whether a popped-out tab goes on the "Recently
/// closed" list. Cleanup passes false: the store has already recorded why
/// the row went, and one entry per tab is enough.
pub(super) fn close_tab_with(
    app: &AppHandle,
    state: &Arc<BrowserTabs>,
    tab_id: &str,
    note_recent: bool,
) -> Result<(), CommandError> {
    let closing = state
        .snapshot(None)
        .into_iter()
        .find(|tab| tab.id == tab_id)
        .ok_or_else(|| unavailable("that browser tab is already closed"))?;
    let label = state
        .label_for(tab_id)
        .ok_or_else(|| unavailable("that browser tab is already closed"))?;
    let window = state.window_of(tab_id);
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
    remember::remember(app, state, &closing.task_id);
    if note_recent {
        remember::note_closed(app, &closing);
    }
    if let Some(window) = window {
        popout::hide_window_if_empty(app, state, &window);
    }
    Ok(())
}

/// Keeps a still of a page that is on screen right now.
///
/// Silent on every failure: the window can be covered, minimised or on another
/// desktop, and a missing poster costs a card its picture rather than the user
/// an error. A filled password is on the page as pixels, so the refusal that
/// guards `browser_tab_screenshot` guards what is cached here too.
async fn capture_poster<R: Runtime>(
    state: &BrowserTabs,
    webview: &tauri::Webview<R>,
    tab_id: &str,
) {
    if !state.on_screen(tab_id) || state.credential_in_flight(tab_id) {
        return;
    }
    if let Ok(png) = capture::capture_poster_png(webview).await {
        state.set_poster(tab_id, png);
    }
}

/// How long after a page settles its still is taken. Long enough for the first
/// paint and the layout that follows it, short enough that the picture is of
/// the page the person is actually looking at.
///
/// Two moments qualify, and neither is a timer: a load finishing, and a tab
/// arriving in a slot. Not parking — parking is the tab-switch path, and
/// waiting on a desktop grab before exposing the replacement would be exactly
/// the hitch the still exists to hide. By the time a tab is parked its picture
/// has already been taken.
const POSTER_SETTLE: Duration = Duration::from_millis(700);

/// Queues that one capture. The caller may be the webview's own load handler,
/// which must not wait for a window grab, so this leaves with the tab id and
/// looks the webview up again when it comes back.
fn poster_when_settled(app: &AppHandle, state: &Arc<BrowserTabs>, tab_id: &str) {
    let app = app.clone();
    let state = Arc::clone(state);
    let tab_id = tab_id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(POSTER_SETTLE).await;
        let Some(label) = state.label_for(&tab_id) else {
            return;
        };
        let Ok(webview) = webview_of(&app, &label) else {
            return;
        };
        capture_poster(&state, &webview, &tab_id).await;
    });
}

/// Puts the corner deck's page back on top of its siblings.
///
/// Sibling child webviews order by creation, not by CSS, so the pane's larger
/// page paints over a deck card whenever the pane's tab was opened later.
/// Nothing in Tauri reorders a child webview directly, but reparenting one to
/// the window it is already in does: that is a `SetParent` call, and `SetParent`
/// moves a child to the head of its parent's z-order. Hiding and re-showing
/// does not — `ShowWindow` leaves the order alone, so it would only flicker.
///
/// Called when a tab enters a slot, never on the geometry updates a pane drag
/// produces: the order changes when a page moves hosts, not when it resizes.
/// Reparenting is a blocking round trip to the window's own message loop, and
/// `SetParent` on a WebView2 host is not cheap. Raising every card on every
/// placement meant a stack of cards paid that cost several times per frame
/// while the pane was being dragged, which is how the UI thread came to stop
/// answering. A raise is only worth making when the order can actually have
/// changed, and never twice inside one frame's worth of placements.
const DECK_RAISE_QUIET: std::time::Duration = std::time::Duration::from_millis(250);

fn deck_raised_at() -> &'static Mutex<HashMap<String, std::time::Instant>> {
    static RAISED: OnceLock<Mutex<HashMap<String, std::time::Instant>>> = OnceLock::new();
    RAISED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// True when this task's deck has not been raised inside the quiet window.
fn deck_raise_is_due(task_id: &str) -> bool {
    let mut raised = deck_raised_at()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let now = std::time::Instant::now();
    if let Some(last) = raised.get(task_id)
        && now.duration_since(*last) < DECK_RAISE_QUIET
    {
        return false;
    }
    if raised.len() > 64 {
        raised.clear();
    }
    raised.insert(task_id.to_string(), now);
    true
}

fn raise_deck(app: &AppHandle, state: &BrowserTabs, task_id: &str) {
    let Some(window) = app.get_window("main") else {
        return;
    };
    let cards = state.visible_in_slot(task_id, PlacementSlot::Deck);
    if cards.is_empty() || !deck_raise_is_due(task_id) {
        return;
    }
    for deck_id in cards {
        let Some(label) = state.label_for(&deck_id) else {
            continue;
        };
        if let Ok(webview) = webview_of(app, &label) {
            let _ = webview.reparent(&window);
        }
    }
}

fn park_tab(app: &AppHandle, state: &BrowserTabs, tab_id: &str) -> Result<(), CommandError> {
    let label = state
        .label_for(tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let webview = webview_of(app, &label)?;
    // Never capture here. Parking is on the tab-switch path, and waiting for a
    // desktop grab before exposing the replacement is exactly the kind of
    // avoidable hitch the cached poster is meant to hide. Loads refresh the
    // poster independently after first paint.
    let (position, size) = parked();
    webview
        .set_bounds(tauri::Rect {
            position: position.into(),
            size: size.into(),
        })
        .map_err(|error| unavailable(error.to_string()))?;
    // A shown child remains in UI Automation even outside the client area.
    // Hiding it prevents another chat (and its screen reader) from inheriting
    // this page while WebView2 keeps the document and full-size layout alive.
    webview
        .hide()
        .map_err(|error| unavailable(format!("could not hide that browser tab: {error}")))?;
    state.set_placement(tab_id, None);
    Ok(())
}

/// Positions the tab over the renderer's slot. Bounds arrive in physical
/// pixels so the scale factor never has to be reconciled twice.
#[tauri::command]
pub async fn browser_tab_set_bounds(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    task_id: String,
    tab_id: String,
    bounds: Option<TabBounds>,
    placement_slot: PlacementSlot,
    popped_out_host: bool,
    placement_session: u64,
    placement_revision: u64,
) -> CommandResult<()> {
    require_task(&state, &task_id, &tab_id)?;
    if !state.claim_placement(
        &task_id,
        &tab_id,
        popped_out_host,
        placement_slot,
        placement_session,
        placement_revision,
    ) {
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
    // Waking yields to every newer tab/chat switch. The claim made above is
    // what lets the winner invalidate this request before it can resurface an
    // old chat after the await completes.
    if !state.placement_is_current(
        &task_id,
        &tab_id,
        popped_out_host,
        placement_slot,
        placement_session,
        placement_revision,
    ) {
        return Ok(());
    }
    let popped_out = state
        .tabs
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&tab_id)
        .is_some_and(|tab| tab.state.popped_out);
    // Re-check after a possible wake: pop-out may have moved the webview while
    // that await was yielding. A late resize from the old host must be inert.
    if popped_out != popped_out_host {
        return Ok(());
    }
    let label = state
        .label_for(&tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let webview = webview_of(&app, &label)?;
    match bounds {
        Some(bounds) if bounds.width >= 1.0 && bounds.height >= 1.0 => {
            // React can retire one surface while mounting the next. Park the
            // old visible sibling natively before exposing the new one, even
            // if an earlier renderer promise completed late. The deck is the
            // exception: its cards each have their own rectangle and all show.
            if placement_slot != PlacementSlot::Deck {
                for peer_id in
                    state.visible_peers(&task_id, &tab_id, popped_out_host, placement_slot)
                {
                    park_tab(&app, &state, &peer_id)?;
                }
            }
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
            webview.show().map_err(|error| {
                unavailable(format!("could not show that browser tab: {error}"))
            })?;
            // Being on screen counts as being reached for: the cap must never
            // sleep the page the user is looking at.
            state.touch(&tab_id);
            if state.set_placement(&tab_id, Some(placement_slot)) {
                // A pane page opened after the deck's would otherwise paint
                // over the corner card, and a card that has just arrived may
                // itself be the older of the two. Either way the deck goes
                // back on top.
                if !popped_out_host {
                    raise_deck(&app, &state, &task_id);
                }
                // A tab that has just been given a rectangle is about to be
                // worth a picture. Taking it now rather than on the way out
                // keeps the capture off the switch the picture is for.
                poster_when_settled(&app, &state, &tab_id);
            }
        }
        _ => {
            // Parked, not shrunk. A tab the pane is not showing used to be left
            // at one pixel, and the page went on answering: a snapshot reported
            // a 2×2 viewport, every element measured at x=0, and nothing in the
            // reply said the geometry was meaningless. Off to the side at a real
            // size means an agent working a background tab gets numbers that
            // are true, and `pageState().offscreen` says it cannot be seen.
            park_tab(&app, &state, &tab_id)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_tab_navigate(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    task_id: String,
    tab_id: String,
    url: String,
) -> CommandResult<BrowserTab> {
    require_task(&state, &task_id, &tab_id)?;
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
    task_id: String,
    tab_id: String,
    action: String,
) -> CommandResult<()> {
    require_task(&state, &task_id, &tab_id)?;
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
    task_id: String,
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
        "highlight",
        "startPick",
        "pickResult",
        "cancelPick",
        "annotate",
        "clearAnnotations",
        "dismissConsent",
    ];
    if !ALLOWED.contains(&method.as_str()) {
        return Err(invalid(format!("unknown browser action '{method}'")));
    }
    require_task(&state, &task_id, &tab_id)?;
    remember::ensure_awake(&app, &state, &tab_id).await;
    let label = state
        .label_for(&tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let args = serde_json::to_string(&args.unwrap_or_default())
        .map_err(|error| invalid(error.to_string()))?;
    let reply = eval_json(
        &app,
        &label,
        guest_call(format!("window.__integrator.{method}(...{args})")),
    )
    .await?;
    // The renderer's replies carry the same `userIdleMs` an agent's do, so the
    // pane's own polling keeps the host's picture of who has the tab fresh even
    // while no agent is calling.
    note_user_activity(&state, &tab_id, &reply);
    Ok(reply)
}

/// Captures the tab's viewport as PNG bytes, base64 for the renderer.
#[tauri::command]
pub async fn browser_tab_screenshot(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    task_id: String,
    tab_id: String,
) -> CommandResult<String> {
    require_task(&state, &task_id, &tab_id)?;
    remember::ensure_awake(&app, &state, &tab_id).await;
    // A password field renders as dots; a "show password" toggle does not, and
    // the page owns that toggle. So the lockout is keyed on a credential having
    // been filled here, never on what the field currently says it is.
    if state.credential_in_flight(&tab_id) {
        return Err(CommandError {
            code: "unavailable",
            message: "a saved password is filled in on this page — capture is refused until it \
                      navigates or the form is submitted"
                .into(),
        });
    }
    let label = state
        .label_for(&tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let webview = webview_of(&app, &label)?;
    capture::capture_png(&webview).await
}

/// This tab's last still, base64 PNG, or nothing if none is held.
///
/// Deliberately its own call rather than a field on the tab snapshot: that
/// snapshot streams on every tab event, and a PNG per tab inside it would put
/// megabytes through IPC every time a title changed. The renderer asks once
/// and keeps what it gets. Never wakes a sleeping tab — a still is what it has
/// instead of a page, not a reason to fetch one.
#[tauri::command]
pub async fn browser_tab_poster(
    state: tauri::State<'_, Arc<BrowserTabs>>,
    task_id: String,
    tab_id: String,
) -> CommandResult<Option<String>> {
    require_task(&state, &task_id, &tab_id)?;
    Ok(state.poster(&tab_id))
}

/// Takes a fresh still of a tab now — parked or not — and hands it back.
///
/// The still under a parked page is what the person sees while an overlay
/// (the compact deck, the address field's suggestions, a dialog) has to be
/// drawn over that slot; the load-time picture goes stale as they browse.
/// The tab's own camera captures a hidden webview, so this can run while the
/// page is parked; where only the screen crop exists it answers with the
/// cached picture instead. Never a still of a filled password.
#[tauri::command]
pub async fn browser_tab_poster_refresh(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    task_id: String,
    tab_id: String,
) -> CommandResult<Option<String>> {
    require_task(&state, &task_id, &tab_id)?;
    if state.credential_in_flight(&tab_id) {
        return Ok(state.poster(&tab_id));
    }
    let sleeping = state
        .snapshot(None)
        .into_iter()
        .find(|tab| tab.id == tab_id)
        .is_some_and(|tab| tab.sleeping);
    if sleeping {
        return Ok(state.poster(&tab_id));
    }
    let label = state
        .label_for(&tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let webview = webview_of(&app, &label)?;
    if let Ok(png) = capture::capture_poster_png(&webview).await {
        state.set_poster(&tab_id, png);
    }
    Ok(state.poster(&tab_id))
}

pub use agent::{
    agent_invoke, browser_capture_image, close_for_agent, cookies_for_agent, focus_for_agent,
    grant_for_agent, navigate_for_agent, open_for_agent, recent_for_caller, row_for_agent,
    screenshot_for_agent, set_popped_out_for_agent, tabs_for_caller,
};
pub use vault::{
    browser_allow_agent_sign_in, browser_fill_login, browser_forget_all_logins,
    browser_forget_bucket_logins, browser_forget_login, browser_save_login, browser_saved_logins,
    fill_login_for_agent,
};

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_windows;
