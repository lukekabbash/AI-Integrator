//! What an agent may do with a browser tab.
//!
//! Every entry point here is reached through the broker, never from the
//! renderer, and each one answers the same two questions before touching a
//! tab: whether this installation allows agent access at all, and whether this
//! caller may address this tab.
//!
//! Reach has three layers, from durable to momentary:
//!
//! - **Task** — a tab belongs to one task, and nothing outside it can see the
//!   tab at all. This boundary is not negotiable and has no grant.
//! - **Owner** — inside a task, a tab opened by a delegated child belongs to
//!   that child. Siblings cannot see it; the orchestrator can. The
//!   orchestrator may hand a tab to a child, read-only or to drive.
//! - **Hold** — whoever last drove a tab holds it briefly, so two agents do
//!   not undo each other mid-flow. Advisory, expires on its own. A recent
//!   keystroke from the person using the app is only an exclusive hold when
//!   Settings → Browser “Lock agents out of the tab you are using” is on.
//!
//! Tabs are shared with the *user* by design — that is the point of the
//! surface — so none of this hides a page from the person watching it.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use url::Url;

use integrator_core::IntegratorError;

use crate::command_api::CommandError;

use super::{
    AGENT_ACCESS_SETTING, BrowserTab, BrowserTabs, Caller, GrantMode, close_tab, create_tab,
    emit_changed, eval_json, invalid, is_blank, lock_active_tab, normalize_url, setting_enabled,
    unavailable, webview_of,
};

/// Guest actions that change the page rather than read it. `guest.js` keeps
/// the same list for its own half of the hold; the drift test holds them level.
pub(super) const WRITES: &[&str] = &["click", "type", "press", "scroll", "drag"];

/// Gestures that draw the agent pointer. These are brought on screen so the
/// person can watch the glide, even when the tab was parked or in the deck.
const CURSOR_METHODS: &[&str] = &["click", "type", "press", "scroll", "drag", "hover"];

/// Guest replies that can expose page text. This native guard mirrors the
/// guest's refusal so an untrusted page cannot bypass it by replacing JS.
const CREDENTIAL_READS: &[&str] = &["snapshot"];

pub fn ensure_agent_access<R: Runtime>(app: &AppHandle<R>) -> Result<(), CommandError> {
    if setting_enabled(app, AGENT_ACCESS_SETTING) {
        return Ok(());
    }
    Err(CommandError {
        code: "unauthorized",
        message: "browser access for agents is turned off in Settings → Browser".into(),
    })
}

/// Refuses a caller that cannot reach this tab, and refuses a read-only grant
/// the moment the action would change the page.
fn reach_for(
    tabs: &BrowserTabs,
    caller: &Caller,
    tab_id: &str,
    writing: bool,
) -> Result<(), CommandError> {
    match tabs.reach(tab_id, caller) {
        Some(GrantMode::Read) if writing => Err(unavailable(
            "that tab was shared with you read-only — snapshots are fine, changing the page is not",
        )),
        Some(_) => Ok(()),
        // Distinguishing these two is worth the branch: one means "ask whoever
        // owns it", the other means "it is gone, open your own".
        None if tabs.task_of(tab_id).is_some() => {
            Err(unavailable("that browser tab belongs to another agent"))
        }
        None => Err(unavailable("that browser tab is no longer open")),
    }
}

/// The reach check on its own, for callers that are not a guest action —
/// filling a login writes to the page, so it needs a drive-level grant.
pub(super) fn ensure_reach(
    tabs: &BrowserTabs,
    caller: &Caller,
    tab_id: &str,
) -> Result<(), CommandError> {
    reach_for(tabs, caller, tab_id, true)
}

pub(super) fn ensure_credential_read_safe(
    tabs: &BrowserTabs,
    tab_id: &str,
    method: &str,
) -> Result<(), CommandError> {
    if CREDENTIAL_READS.contains(&method) && tabs.credential_in_flight(tab_id) {
        return Err(unavailable(
            "a saved password is filled in on this page, so reading it is refused until the tab navigates",
        ));
    }
    Ok(())
}

/// Runs a guest action for an agent.
pub async fn agent_invoke(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    caller: &Caller,
    tab_id: &str,
    method: &str,
    args: Vec<Value>,
) -> Result<Value, CommandError> {
    ensure_agent_access(app)?;
    let writing = WRITES.contains(&method);
    reach_for(tabs, caller, tab_id, writing)?;
    ensure_credential_read_safe(tabs, tab_id, method)?;
    let who = caller.label();
    // Reading a page is harmless when someone else is mid-flow; changing it is
    // not. A tab another agent is working in refuses writes rather than letting
    // two runs undo each other, and says who has it. The person using the app
    // is only an exclusive holder when they asked for that lock.
    let user_hold = lock_active_tab(app);
    if writing && let Some(holder) = tabs.held_by_other(tab_id, &who, user_hold) {
        return Err(unavailable(stood_off(&holder)));
    }
    super::remember::ensure_awake(app, tabs, tab_id).await;
    if CURSOR_METHODS.contains(&method) {
        let _ = bring_on_screen(app, tabs, caller, tab_id).await;
    }
    let label = tabs
        .label_for(tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    tabs.mark_held(tab_id, &who);
    let args = serde_json::to_string(&args).map_err(|error| invalid(error.to_string()))?;
    // The guest gets the last word on whether this lands. Only the page can see
    // the person's own clicks and keys, so the veto has to be asked there —
    // `blocked` answers null when the way is clear, which lets the call through.
    // The lock flag is passed live so toggling the setting applies to the open
    // document, not only the next navigation.
    let reply = eval_json(
        app,
        &label,
        format!(
            "window.__integrator.blocked?.({method:?}, {user_hold}) || window.__integrator.{method}(...{args})"
        ),
    )
    .await?;
    super::note_user_activity(tabs, tab_id, &reply);
    Ok(reply)
}

/// How a refusal reads depends on who is holding the tab: another agent can be
/// waited out or worked around, the person at the keyboard is simply first.
fn stood_off(holder: &str) -> String {
    if holder == super::USER_HOLDER {
        return "the person is working in that tab right now — wait for them to finish, or open your own with browser_open".into();
    }
    format!(
        "{holder} is working in that tab right now — open your own with browser_open, or wait for it to finish"
    )
}

/// Opens a tab for this caller. A child's tab belongs to the child, so its
/// siblings never see it and never drive it by accident.
pub async fn open_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    caller: &Caller,
    url: Option<String>,
) -> Result<BrowserTab, IntegratorError> {
    ensure_agent_access(app).map_err(|error| IntegratorError::Unauthorized(error.message))?;
    let target = match url.as_deref() {
        Some(raw) if !raw.trim().is_empty() => {
            normalize_url(raw).map_err(|error| IntegratorError::InvalidInput(error.message))?
        }
        _ => Url::parse("about:blank").expect("about:blank parses"),
    };
    let tab = create_tab(app, tabs, caller.task_id.clone(), target)
        .await
        .map_err(|error| IntegratorError::Unavailable(error.message))?;
    tabs.mark_held(&tab.id, &caller.label());
    if let Some(delegation) = caller.delegation_id.clone() {
        tabs.update(&tab.id, |state| state.delegation_id = Some(delegation));
    }
    emit_changed(app, tabs);
    tabs.snapshot(Some(&caller.task_id))
        .into_iter()
        .find(|candidate| candidate.id == tab.id)
        .ok_or_else(|| IntegratorError::NotFound("that browser tab is no longer open".into()))
}

/// Points one reachable tab at a URL.
pub async fn navigate_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    caller: &Caller,
    tab_id: &str,
    url: &str,
) -> Result<BrowserTab, IntegratorError> {
    ensure_agent_access(app).map_err(|error| IntegratorError::Unauthorized(error.message))?;
    reach_for(tabs, caller, tab_id, true).map_err(|error| match error.code {
        "unauthorized" => IntegratorError::Unauthorized(error.message),
        _ => IntegratorError::Unavailable(error.message),
    })?;
    let who = caller.label();
    if let Some(holder) = tabs.held_by_other(tab_id, &who, lock_active_tab(app)) {
        return Err(IntegratorError::Unavailable(stood_off(&holder)));
    }
    tabs.mark_held(tab_id, &who);
    let target =
        normalize_url(url).map_err(|error| IntegratorError::InvalidInput(error.message))?;
    super::remember::ensure_awake(app, tabs, tab_id).await;
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

/// Closes a tab this caller owns. A granted tab is someone else's to close.
pub async fn close_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    caller: &Caller,
    tab_id: &str,
) -> Result<(), IntegratorError> {
    ensure_agent_access(app).map_err(|error| IntegratorError::Unauthorized(error.message))?;
    if !tabs.owns(tab_id, caller) {
        return Err(IntegratorError::Unauthorized(
            "that tab belongs to another agent — it is not yours to close".into(),
        ));
    }
    close_tab(app, tabs, tab_id).map_err(|error| IntegratorError::Unavailable(error.message))
}

/// Hands one of the orchestrator's tabs to a delegated child. Only the
/// orchestrator grants, and a grant never travels onward: a child cannot
/// re-share what it was given.
pub fn grant_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    caller: &Caller,
    tab_id: &str,
    delegation_id: &str,
    mode: GrantMode,
) -> Result<BrowserTab, IntegratorError> {
    ensure_agent_access(app).map_err(|error| IntegratorError::Unauthorized(error.message))?;
    if caller.delegation_id.is_some() {
        return Err(IntegratorError::Unauthorized(
            "a subagent cannot share its tab onward".into(),
        ));
    }
    if !tabs.owns(tab_id, caller) {
        return Err(IntegratorError::Unauthorized(
            "that tab belongs to another agent".into(),
        ));
    }
    if !tabs.grant(tab_id, delegation_id, mode) {
        return Err(IntegratorError::NotFound(
            "that browser tab is no longer open".into(),
        ));
    }
    emit_changed(app, tabs);
    tabs.snapshot(Some(&caller.task_id))
        .into_iter()
        .find(|candidate| candidate.id == tab_id)
        .ok_or_else(|| IntegratorError::NotFound("that browser tab is no longer open".into()))
}

/// Asks the renderer to put this tab on screen, and waits to see whether it
/// really landed. The renderer owns layout — the pane may be closed, the user
/// may be in another chat — so this reports what happened instead of assuming.
pub async fn focus_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    caller: &Caller,
    tab_id: &str,
) -> Result<Value, CommandError> {
    ensure_agent_access(app)?;
    // Showing a page changes nothing on it, so a read-only grant is enough.
    reach_for(tabs, caller, tab_id, false)?;
    super::remember::ensure_awake(app, tabs, tab_id).await;
    let label = tabs
        .label_for(tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    if bring_on_screen(app, tabs, caller, tab_id).await {
        let viewport = eval_json(app, &label, VIEWPORT.into()).await.ok();
        return Ok(json!({ "focused": true, "viewport": viewport }));
    }
    Ok(json!({
        "focused": false,
        "note": "the tab is running but not on screen — the browser pane may be closed, \
                 or the user may be looking at another chat. It is still yours to drive.",
    }))
}

/// Asks the renderer to show the tab and waits briefly to see whether it did.
///
/// A tab parked off screen still measures 1280×800, so its own geometry
/// cannot answer this. What can is the renderer's placement: it reports a
/// rectangle when a tab is on screen and hides it when it is not. Wait
/// briefly for the pane to open and that placement to arrive.
async fn bring_on_screen(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    caller: &Caller,
    tab_id: &str,
) -> bool {
    // Both renderers listen: the work pane opens the tab in its strip, and the
    // pop-out window selects it in its own. A popped tab is not the main
    // window's to show, so without that second listener an agent could never
    // photograph one.
    let _ = app.emit(
        super::BROWSER_FOCUS_EVENT,
        json!({ "taskId": caller.task_id.as_str(), "tabId": tab_id }),
    );
    for attempt in 0..FOCUS_TRIES {
        if attempt > 0 {
            tokio::time::sleep(FOCUS_POLL).await;
        }
        if tabs.on_screen(tab_id) {
            return true;
        }
    }
    false
}

/// Brings the window a tab lives in to the front and waits for the compositor.
///
/// A capture is a crop of the screen, so a window sitting behind another one
/// yields the other one's pixels — which is exactly what a pop-out browser
/// behind the app produced: a picture of the app with the page as a sliver
/// down the side. Raising the host first is the difference between a
/// photograph of the tab and a photograph of whatever covers it.
async fn raise_host_window(app: &AppHandle, label: &str) {
    let Ok(webview) = webview_of(app, label) else {
        return;
    };
    let window = webview.window();
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    if !window.is_visible().unwrap_or(true) {
        let _ = window.show();
    }
    if !window.is_focused().unwrap_or(false) {
        let _ = window.set_focus();
    }
    // One frame is not enough on Windows: the raise is asynchronous and the
    // screen still holds the old stacking order for a beat.
    tokio::time::sleep(RAISE_SETTLE).await;
}

/// Takes a picture of the tab's viewport for an agent.
///
/// The picture is a crop of the screen (see `capture.rs`), so the tab has to
/// be on screen to be captured. A tab that is parked is brought forward first,
/// exactly as `browser_focus` would, and one that still cannot be shown is
/// refused with the reason instead of a blank or a neighbour's pixels. Reading
/// the page is reading, so a read-only grant is enough — the same lockout that
/// guards the user's screenshot button guards this one: no capture while a
/// saved password is filled in.
pub async fn screenshot_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    caller: &Caller,
    tab_id: &str,
) -> Result<Value, CommandError> {
    ensure_agent_access(app)?;
    reach_for(tabs, caller, tab_id, false)?;
    super::remember::ensure_awake(app, tabs, tab_id).await;
    if tabs.credential_in_flight(tab_id) {
        return Err(unavailable(
            "a saved password is filled in on this page — capture is refused until it \
             navigates or the form is submitted",
        ));
    }
    let label = tabs
        .label_for(tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    if !tabs.on_screen(tab_id) && !bring_on_screen(app, tabs, caller, tab_id).await {
        return Err(unavailable(
            "that tab is not on screen, so there is nothing to photograph — the browser pane \
             may be closed or the user may be looking at another chat. browser_snapshot reads \
             the page without needing it on screen.",
        ));
    }
    // The picture is whatever the screen holds over the tab's rectangle, so
    // the window it lives in — the app, or its own pop-out — has to be the
    // window in front before the shutter.
    raise_host_window(app, &label).await;
    let webview = webview_of(app, &label)?;
    let shot = super::capture::capture_full(&webview).await?;
    let viewport = eval_json(app, &label, VIEWPORT.into()).await.ok();
    let mut reply = json!({
        "width": shot.width,
        "height": shot.height,
        "viewport": viewport,
        "note": "a picture of the tab as it is on the user's screen. Anything covering the \
                 browser pane appears in it too. Coordinates in the image are device pixels; \
                 divide by width/viewport.width to get CSS pixels for browser_drag.",
    });
    // Persist a copy the transcript can show later. Codex stores only a
    // short slice of the tool result, so the base64 image block itself
    // never survives as a picture in the chat.
    if let Some(path) = persist_agent_screenshot(app, &caller.task_id, &shot.png_base64) {
        // Saying how to show it is the difference between an agent that can
        // hand the user the picture and one that can only describe it: the
        // transcript draws an app-owned capture inline from this markdown.
        reply["imagePath"] = json!(path);
        reply["showInReply"] = json!(format!("![screenshot]({path})"));
        if let Some(note) = reply["note"].as_str() {
            reply["note"] = json!(format!(
                "{note} To show this picture to the user, put this line in your reply: \
                 ![screenshot]({path})"
            ));
        }
    }
    // The broker turns this into an MCP image block alongside the text.
    reply[super::MCP_CONTENT_KEY] = json!([{
        "type": "image",
        "data": shot.png_base64,
        "mimeType": "image/png",
    }]);
    Ok(reply)
}

/// Reads back a capture this app wrote, as a `data:` URL the transcript can
/// draw. Only files under `browser-captures` are readable, so an agent naming
/// some other path in its reply gets nothing rather than a file read.
///
/// A `data:` URL rather than a file URL because the renderer's content policy
/// allows `data:` images and no remote or file ones, and because the picture
/// is app-owned bytes either way.
#[tauri::command]
pub async fn browser_capture_image(
    state: tauri::State<'_, crate::state::AppState>,
    path: String,
) -> Result<String, CommandError> {
    let (file, mime) = inline_capture_source(&state.data_directory, &path)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || fs::read(&file))
        .await
        .map_err(|_| unavailable("the capture reader stopped"))?
        .map_err(|_| unavailable("that capture is not there any more"))?;
    if bytes.is_empty() || bytes.len() > MAX_INLINE_CAPTURE_BYTES {
        return Err(unavailable("that capture is too large to show inline"));
    }
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(&bytes)))
}

/// Resolves a requested path to a capture this app owns, or refuses it.
///
/// Both sides are canonicalised before they are compared, so neither `..` nor
/// a symlink planted inside the capture folder can point the read somewhere
/// else. An agent is the one naming this path, and a page is what talks to the
/// agent, so the answer to "read this file" has to be no by default.
fn inline_capture_source(
    data_directory: &Path,
    path: &str,
) -> Result<(PathBuf, &'static str), CommandError> {
    let root = data_directory.join("browser-captures");
    let root = root.canonicalize().unwrap_or(root);
    let requested = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| unavailable("that capture is not there any more"))?;
    if !requested.starts_with(&root) {
        return Err(unavailable("that file is not one of this app's captures"));
    }
    let mime = match requested
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => return Err(unavailable("that capture is not an image")),
    };
    Ok((requested, mime))
}

/// The most a single inline picture may carry into the transcript.
const MAX_INLINE_CAPTURE_BYTES: usize = 12 * 1024 * 1024;

/// Writes an agent screenshot under app-owned data. Fail-soft: a missed
/// file still leaves the MCP image for the model.
fn persist_agent_screenshot(app: &AppHandle, task_id: &str, png_base64: &str) -> Option<String> {
    let state = app.try_state::<crate::state::AppState>()?;
    let png = STANDARD.decode(png_base64).ok()?;
    persist_screenshot_png(&state.data_directory, task_id, &png)
        .map(|path| path.to_string_lossy().into_owned())
}

pub(super) fn persist_screenshot_png(
    data_directory: &Path,
    task_id: &str,
    png: &[u8],
) -> Option<PathBuf> {
    let task = capture_task_dir(task_id)?;
    if png.is_empty() {
        return None;
    }
    let directory = data_directory.join("browser-captures").join(task);
    fs::create_dir_all(&directory).ok()?;
    let path = directory.join(format!("screenshot-{}.png", uuid::Uuid::new_v4()));
    if !path.starts_with(&directory) {
        return None;
    }
    fs::write(&path, png).ok()?;
    Some(path)
}

fn capture_task_dir(task_id: &str) -> Option<&str> {
    if task_id.is_empty() || task_id.len() > 80 {
        return None;
    }
    if task_id.contains("..") {
        return None;
    }
    if !task_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return None;
    }
    Some(task_id)
}

/// How long a raised window is given to actually be on top before the screen
/// is read. Long enough for the compositor, short enough not to read as a
/// pause in a tool call.
const RAISE_SETTLE: std::time::Duration = std::time::Duration::from_millis(220);
/// How long `browser_focus` gives the renderer to actually show the tab.
const FOCUS_TRIES: u8 = 10;
const FOCUS_POLL: std::time::Duration = std::time::Duration::from_millis(120);
const VIEWPORT: &str = "({ ok: true, value: { width: innerWidth, height: innerHeight } })";

/// Lists a tab's cookies without their values. Reading is reading, so a
/// read-only grant is enough.
pub async fn cookies_for_agent(
    app: &AppHandle,
    tabs: &Arc<BrowserTabs>,
    caller: &Caller,
    tab_id: &str,
) -> Result<Value, CommandError> {
    ensure_agent_access(app)?;
    reach_for(tabs, caller, tab_id, false)?;
    super::remember::ensure_awake(app, tabs, tab_id).await;
    let cookies = super::sites::cookies_for_tab(app, tabs, tab_id).await?;
    Ok(json!({
        "cookies": cookies,
        "note": "names, flags and expiry only — no cookie value is readable through any tool.",
    }))
}

/// Every tab this caller may address.
pub fn tabs_for_caller<R: Runtime>(
    app: &AppHandle<R>,
    tabs: &BrowserTabs,
    caller: &Caller,
) -> Vec<BrowserTab> {
    tabs.visible_to(caller, lock_active_tab(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_apps_own_captures_may_be_drawn_inline() {
        let root = tempfile::tempdir().expect("temp dir");
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        let capture = persist_screenshot_png(root.path(), "task-1", &png).expect("wrote capture");
        let (file, mime) =
            inline_capture_source(root.path(), &capture.to_string_lossy()).expect("ours");
        assert_eq!(mime, "image/png");
        assert!(file.ends_with(capture.file_name().expect("named")));

        // A file outside the capture folder is refused, by name or by way of a
        // path that walks out of it.
        let outsider = root.path().join("secret.png");
        fs::write(&outsider, png).expect("wrote outsider");
        assert!(inline_capture_source(root.path(), &outsider.to_string_lossy()).is_err());
        let escape = root
            .path()
            .join("browser-captures")
            .join("task-1")
            .join("..")
            .join("..")
            .join("secret.png");
        assert!(inline_capture_source(root.path(), &escape.to_string_lossy()).is_err());

        // Something that is not an image, inside the folder, is still refused.
        let notes = root
            .path()
            .join("browser-captures")
            .join("task-1")
            .join("notes.txt");
        fs::write(&notes, b"hello").expect("wrote notes");
        assert!(inline_capture_source(root.path(), &notes.to_string_lossy()).is_err());
    }

    #[test]
    fn persists_a_png_under_the_task_capture_folder() {
        let root = tempfile::tempdir().expect("temp dir");
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        let path = persist_screenshot_png(root.path(), "task-1", &png).expect("wrote capture");
        assert!(path.starts_with(root.path().join("browser-captures").join("task-1")));
        assert_eq!(fs::read(&path).expect("read capture"), png);
    }

    #[test]
    fn refuses_a_task_id_that_would_leave_the_capture_root() {
        let root = tempfile::tempdir().expect("temp dir");
        assert!(persist_screenshot_png(root.path(), "../escape", &[1, 2, 3]).is_none());
        assert!(persist_screenshot_png(root.path(), "task/evil", &[1, 2, 3]).is_none());
    }
}
