//! Saved logins for the browser.
//!
//! The secret lives in the OS credential store — the same one that already
//! holds provider API keys — and never anywhere else. What lives beside it is a
//! manifest: which origins have a login, under which username, for which
//! project, and when it was last used. Settings enumerates from the manifest,
//! so listing saved logins never reads a password.
//!
//! Two properties define the feature, and every function here exists to keep
//! them true:
//!
//! - **An agent can cause a login to happen; it can never learn a credential.**
//!   The value goes from this module into the page and is never returned
//!   through a tool reply, a log line, an annotation or a capture.
//! - **A page can never choose which credential is used.** Only the origin the
//!   tab is actually on can, and only if that origin already has one saved.
//!   Origin means scheme, host and port — no subdomain widening, no following
//!   a redirect to somewhere else.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Runtime};
use url::Url;
use zeroize::Zeroizing;

use crate::command_api::{CommandError, CommandResult};

use super::{invalid, unavailable};

/// Where saved logins live in the OS credential store.
const SERVICE: &str = "dev.aiintegrator.browser-login";
/// The manifest of what is saved, kept in the app's own settings.
pub const SAVED_LOGINS_SETTING: &str = "settings.browser.savedLogins";
/// Per-origin permission for an agent to sign in without asking. Suffixed with
/// the origin, so it is a decision about one site rather than about agents.
pub const AGENT_SIGN_IN_PREFIX: &str = "settings.browser.agentSignIn.";
/// The project key an entry marked "all projects" is filed under.
const EVERY_PROJECT: &str = "*";

/// One saved login, without its secret. This is what Settings renders and what
/// crosses any boundary; the password is only ever read by `secret`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedLogin {
    /// Project this login belongs to, or `*` when it is offered everywhere.
    pub project_id: String,
    /// Scheme, host and port. Never a path, never a wildcard.
    pub origin: String,
    pub username: String,
    /// ISO-8601, for the Settings list.
    pub saved_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
}

impl SavedLogin {
    fn account(&self) -> String {
        account_key(&self.project_id, &self.origin, &self.username)
    }
}

/// The account a secret is filed under. Project first, so one origin can hold
/// a different login per project without either shadowing the other.
fn account_key(project_id: &str, origin: &str, username: &str) -> String {
    format!("{project_id} {origin} {username}")
}

/// Scheme, host and port — the whole of what a credential is bound to.
pub fn origin_of(url: &str) -> Result<String, CommandError> {
    let parsed = Url::parse(url).map_err(|_| invalid("that tab has no address"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err(invalid("logins are only saved for web pages")),
    }
    let origin = parsed.origin();
    if !origin.is_tuple() {
        return Err(invalid("that page has no origin to bind a login to"));
    }
    Ok(origin.ascii_serialization())
}

fn manifest<R: Runtime>(app: &AppHandle<R>) -> Vec<SavedLogin> {
    app.try_state::<crate::state::AppState>()
        .and_then(|state| state.store.get_setting(SAVED_LOGINS_SETTING).ok().flatten())
        .map(|setting| serde_json::from_value(setting.value).unwrap_or_default())
        .unwrap_or_default()
}

fn write_manifest<R: Runtime>(
    app: &AppHandle<R>,
    entries: &[SavedLogin],
) -> Result<(), CommandError> {
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or_else(|| unavailable("the app is not ready"))?;
    state
        .store
        .set_setting(SAVED_LOGINS_SETTING, json!(entries))
        .map_err(|error| unavailable(error.to_string()))?;
    Ok(())
}

/// Every saved login, for the Settings list. No secret is read.
pub fn all<R: Runtime>(app: &AppHandle<R>) -> Vec<SavedLogin> {
    manifest(app)
}

/// The logins offered on one origin while working in one project: the
/// project's own, plus anything marked for every project.
pub fn for_origin<R: Runtime>(
    app: &AppHandle<R>,
    project_id: &str,
    origin: &str,
) -> Vec<SavedLogin> {
    manifest(app)
        .into_iter()
        .filter(|entry| {
            entry.origin == origin
                && (entry.project_id == project_id || entry.project_id == EVERY_PROJECT)
        })
        .collect()
}

/// Saves or updates one login. Returns the manifest entry, never the secret.
pub fn save<R: Runtime>(
    app: &AppHandle<R>,
    project_id: &str,
    origin: &str,
    username: &str,
    password: &str,
    all_projects: bool,
) -> Result<SavedLogin, CommandError> {
    let origin = origin_of(origin)?;
    let username = username.trim();
    if username.is_empty() {
        return Err(invalid("a saved login needs a username"));
    }
    if password.is_empty() {
        return Err(invalid("a saved login needs a password"));
    }
    let project = if all_projects {
        EVERY_PROJECT.to_string()
    } else {
        project_id.to_string()
    };
    let entry = SavedLogin {
        project_id: project,
        origin,
        username: username.to_string(),
        saved_at: chrono::Utc::now().to_rfc3339(),
        last_used_at: None,
    };
    crate::credential_store::write(SERVICE, &entry.account(), password)
        .map_err(|_| unavailable("the OS credential store refused to save that login"))?;
    let mut entries = manifest(app);
    // Re-saving the same account replaces the password and keeps its history,
    // which is what "update" means here: one entry per account, always.
    match entries.iter_mut().find(|existing| {
        existing.project_id == entry.project_id
            && existing.origin == entry.origin
            && existing.username == entry.username
    }) {
        Some(existing) => existing.saved_at = entry.saved_at.clone(),
        None => entries.push(entry.clone()),
    }
    write_manifest(app, &entries)?;
    Ok(entry)
}

/// Forgets one login: the secret first, then the row that points at it.
pub fn forget<R: Runtime>(
    app: &AppHandle<R>,
    project_id: &str,
    origin: &str,
    username: &str,
) -> Result<(), CommandError> {
    let _ = crate::credential_store::delete(SERVICE, &account_key(project_id, origin, username));
    let entries: Vec<SavedLogin> = manifest(app)
        .into_iter()
        .filter(|entry| {
            !(entry.project_id == project_id
                && entry.origin == origin
                && entry.username == username)
        })
        .collect();
    write_manifest(app, &entries)
}

/// Forgets everything. Used by the "forget all" control in Settings.
pub fn forget_all<R: Runtime>(app: &AppHandle<R>) -> Result<(), CommandError> {
    for entry in manifest(app) {
        let _ = crate::credential_store::delete(SERVICE, &entry.account());
    }
    write_manifest(app, &[])
}

/// Reads one secret. Deliberately the only function that can, and its result
/// is `Zeroizing`: it goes into a page and is wiped, never into a reply.
pub(super) fn secret(entry: &SavedLogin) -> Option<Zeroizing<String>> {
    crate::credential_store::read(SERVICE, &entry.account())
        .ok()
        .flatten()
}

/// Records that a login was used, so Settings can show it.
pub(super) fn mark_used<R: Runtime>(app: &AppHandle<R>, used: &SavedLogin) {
    let mut entries = manifest(app);
    if let Some(entry) = entries.iter_mut().find(|entry| {
        entry.project_id == used.project_id
            && entry.origin == used.origin
            && entry.username == used.username
    }) {
        entry.last_used_at = Some(chrono::Utc::now().to_rfc3339());
    }
    let _ = write_manifest(app, &entries);
}

/// Whether this installation lets agents sign in on one origin without asking.
/// Off unless the user has said otherwise for that exact site.
pub fn agent_may_sign_in<R: Runtime>(app: &AppHandle<R>, origin: &str) -> bool {
    app.try_state::<crate::state::AppState>()
        .and_then(|state| {
            state
                .store
                .get_setting(&format!("{AGENT_SIGN_IN_PREFIX}{origin}"))
                .ok()
                .flatten()
        })
        .and_then(|setting| setting.value.as_bool())
        .unwrap_or(false)
}

/// Remembers the user's answer to "let agents sign in here", per origin.
pub fn set_agent_may_sign_in<R: Runtime>(
    app: &AppHandle<R>,
    origin: &str,
    allowed: bool,
) -> Result<(), CommandError> {
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or_else(|| unavailable("the app is not ready"))?;
    state
        .store
        .set_setting(&format!("{AGENT_SIGN_IN_PREFIX}{origin}"), json!(allowed))
        .map_err(|error| unavailable(error.to_string()))?;
    Ok(())
}

/// Picks the one login to fill, or explains why it cannot.
pub(super) fn choose(
    entries: Vec<SavedLogin>,
    username: Option<&str>,
    origin: &str,
) -> Result<SavedLogin, CommandError> {
    match username {
        Some(wanted) => entries
            .into_iter()
            .find(|entry| entry.username == wanted)
            .ok_or_else(|| invalid(format!("no login saved for {wanted} on {origin}"))),
        None if entries.len() == 1 => Ok(entries.into_iter().next().expect("one entry")),
        None if entries.is_empty() => Err(unavailable(format!(
            "no login is saved for {origin} — the user can save one from the browser after signing in"
        ))),
        None => {
            let names: Vec<&str> = entries
                .iter()
                .map(|entry| entry.username.as_str())
                .collect();
            Err(invalid(format!(
                "{origin} has more than one saved login — name one with username: {}",
                names.join(", ")
            )))
        }
    }
}

/// The project a task's logins belong to.
///
/// A task's repository root is what identifies a project everywhere else in the
/// app, so it identifies one here too — it survives a rename and needs no
/// second table. Chats with no project share one key, which is the honest
/// answer: they have no project to be scoped to.
pub fn project_key<R: Runtime>(app: &AppHandle<R>, task_id: &str) -> String {
    let project = task_id
        .parse::<integrator_core::TaskId>()
        .ok()
        .and_then(|id| app.try_state::<crate::state::AppState>().map(|s| (s, id)))
        .and_then(|(state, id)| state.store.get_task(id).ok())
        .and_then(|task| task.repository_path);
    match project {
        Some(path) => path.to_string_lossy().to_string(),
        None => "chat".to_string(),
    }
}

/// Types a saved login into a tab, on the origin it was saved for.
///
/// `by_agent` is the whole difference between the two callers: the person
/// filling their own login needs no permission, an agent needs the origin to
/// have been allowed. Neither ever receives the value.
pub(super) async fn fill_login(
    app: &AppHandle,
    tabs: &Arc<super::BrowserTabs>,
    task_id: &str,
    tab_id: &str,
    username: Option<&str>,
    by_agent: bool,
) -> Result<Value, CommandError> {
    super::remember::ensure_awake(app, tabs, tab_id).await;
    let tab = tabs
        .snapshot(None)
        .into_iter()
        .find(|tab| tab.id == tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    // The origin comes from the tab's own address, never from the caller: a
    // page that could name the origin could name someone else's.
    let origin = origin_of(&tab.url)?;
    let entry = choose(
        for_origin(app, &project_key(app, task_id), &origin),
        username,
        &origin,
    )?;
    if by_agent && !agent_may_sign_in(app, &origin) {
        let _ = tauri::Emitter::emit(
            app,
            super::BROWSER_FILL_REQUEST_EVENT,
            json!({ "tabId": tab_id, "origin": origin, "username": entry.username }),
        );
        return Ok(json!({
            "filled": false,
            "status": "needs-user-approval",
            "origin": origin,
            "username": entry.username,
            "note": "the user has been asked whether you may sign in to this site. \
                     Carry on with something else and try again once they answer.",
        }));
    }
    let password = secret(&entry).ok_or_else(|| {
        unavailable("that login is listed but its password is not in the OS credential store")
    })?;
    let label = tabs
        .label_for(tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let key = tabs.host_key();
    let username = entry.username.clone();
    let reply = super::eval_json(
        app,
        &label,
        format!(
            "window.__integrator.fillLogin({key:?},{username:?},{:?},true)",
            &*password
        ),
    )
    .await?;
    drop(password);
    // From here until the page navigates, reading this tab is refused. The
    // guest enforces it for page reads; the host enforces it for captures,
    // which the guest cannot see.
    tabs.mark_credential_filled(tab_id);
    mark_used(app, &entry);
    let submitted = reply.get("submitted").and_then(Value::as_bool) == Some(true);
    Ok(filled_reply(&entry, submitted))
}

/// An agent asking to sign in. Same fill, one extra question: has the user
/// allowed agents on this origin? If not, they are asked and the agent is told
/// to come back rather than being made to wait on a person.
pub async fn fill_login_for_agent(
    app: &AppHandle,
    tabs: &Arc<super::BrowserTabs>,
    caller: &super::Caller,
    tab_id: &str,
    username: Option<&str>,
) -> Result<Value, CommandError> {
    super::agent::ensure_agent_access(app)?;
    super::agent::ensure_reach(tabs, caller, tab_id)?;
    fill_login(app, tabs, &caller.task_id, tab_id, username, true).await
}

/// Reads the login the person typed into the page and saves it. The value
/// crosses from the page to the credential store inside the native side and
/// nowhere else — not to the renderer, not into a reply.
pub(super) async fn save_from_page(
    app: &AppHandle,
    tabs: &Arc<super::BrowserTabs>,
    task_id: &str,
    tab_id: &str,
    all_projects: bool,
) -> Result<SavedLogin, CommandError> {
    let label = tabs
        .label_for(tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let key = tabs.host_key();
    let captured = super::eval_json(
        app,
        &label,
        format!("window.__integrator.captureLogin({key:?})"),
    )
    .await?;
    let origin = captured
        .get("origin")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("that page has no origin to bind a login to"))?;
    let username = captured
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let password = Zeroizing::new(
        captured
            .get("password")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    );
    save(
        app,
        &project_key(app, task_id),
        origin,
        username,
        &password,
        all_projects,
    )
}

/// What a caller is told after a fill. The password is not in it, and there is
/// no shape of this reply that could carry one.
pub(super) fn filled_reply(entry: &SavedLogin, submitted: bool) -> Value {
    json!({
        "filled": true,
        "username": entry.username,
        "origin": entry.origin,
        "submitted": submitted,
        "note": "the password was typed by the app and is not readable from here. \
                 Reading this page is refused until it navigates or the form is submitted.",
    })
}

/* ------------------------------------------------------------ saved logins */

/// Every saved login, for the Settings list. Never a password: v1 has no
/// reveal, because a reveal is only meaningful behind an OS re-authentication
/// gate and this workspace forbids the unsafe binding that would need.
#[tauri::command]
pub async fn browser_saved_logins(app: AppHandle) -> CommandResult<Vec<SavedLogin>> {
    Ok(all(&app))
}

/// Saves the login the person has just typed into the page in front of them.
/// The value goes from the page into the OS credential store without passing
/// through the renderer.
#[tauri::command]
pub async fn browser_save_login(
    app: AppHandle,
    state: tauri::State<'_, Arc<super::BrowserTabs>>,
    tab_id: String,
    task_id: String,
    all_projects: Option<bool>,
) -> CommandResult<SavedLogin> {
    save_from_page(
        &app,
        &state,
        &task_id,
        &tab_id,
        all_projects.unwrap_or(false),
    )
    .await
}

/// Fills a saved login because the person asked for it — no permission needed
/// beyond their click.
#[tauri::command]
pub async fn browser_fill_login(
    app: AppHandle,
    state: tauri::State<'_, Arc<super::BrowserTabs>>,
    tab_id: String,
    task_id: String,
    username: Option<String>,
) -> CommandResult<Value> {
    fill_login(&app, &state, &task_id, &tab_id, username.as_deref(), false).await
}

#[tauri::command]
pub async fn browser_forget_login(
    app: AppHandle,
    project_id: String,
    origin: String,
    username: String,
) -> CommandResult<Vec<SavedLogin>> {
    forget(&app, &project_id, &origin, &username)?;
    Ok(all(&app))
}

#[tauri::command]
pub async fn browser_forget_all_logins(app: AppHandle) -> CommandResult<Vec<SavedLogin>> {
    forget_all(&app)?;
    Ok(all(&app))
}

/// Records whether agents may sign in on one origin without asking again.
#[tauri::command]
pub async fn browser_allow_agent_sign_in(
    app: AppHandle,
    origin: String,
    allowed: bool,
) -> CommandResult<()> {
    set_agent_may_sign_in(&app, &origin, allowed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(project: &str, origin: &str, user: &str) -> SavedLogin {
        SavedLogin {
            project_id: project.into(),
            origin: origin.into(),
            username: user.into(),
            saved_at: "2026-08-17T00:00:00Z".into(),
            last_used_at: None,
        }
    }

    #[test]
    fn an_origin_is_scheme_host_and_port_and_nothing_else() {
        assert_eq!(
            origin_of("https://mail.example.com/inbox?x=1").unwrap(),
            "https://mail.example.com"
        );
        assert_eq!(
            origin_of("http://localhost:5173/app").unwrap(),
            "http://localhost:5173"
        );
        // A different port or scheme is a different origin, which is the whole
        // anti-phishing guarantee.
        assert_ne!(
            origin_of("https://example.com").unwrap(),
            origin_of("https://example.com:8443").unwrap()
        );
        assert_ne!(
            origin_of("https://example.com").unwrap(),
            origin_of("http://example.com").unwrap()
        );
        assert!(origin_of("file:///etc/passwd").is_err());
        assert!(origin_of("not a url").is_err());
    }

    #[test]
    fn choosing_is_explicit_when_a_site_has_more_than_one_login() {
        let origin = "https://example.com";
        let two = vec![entry("p1", origin, "ana"), entry("p1", origin, "bo")];
        assert!(choose(two.clone(), None, origin).is_err());
        assert_eq!(
            choose(two.clone(), Some("bo"), origin).unwrap().username,
            "bo"
        );
        assert!(choose(two, Some("nobody"), origin).is_err());
        assert!(choose(vec![], None, origin).is_err());
        assert_eq!(
            choose(vec![entry("p1", origin, "ana")], None, origin)
                .unwrap()
                .username,
            "ana"
        );
    }

    #[test]
    fn a_reply_never_has_room_for_a_password() {
        let reply = filled_reply(&entry("p1", "https://example.com", "ana"), true);
        let text = reply.to_string();
        assert!(text.contains("\"username\":\"ana\""));
        assert!(!text.contains("password\":\""));
        assert_eq!(reply.get("filled").and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn an_account_key_separates_projects_and_origins() {
        assert_eq!(
            account_key("p1", "https://example.com", "ana"),
            "p1 https://example.com ana"
        );
        assert_ne!(
            account_key("p1", "https://example.com", "ana"),
            account_key("p2", "https://example.com", "ana")
        );
    }
}
