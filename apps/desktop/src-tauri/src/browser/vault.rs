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

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Runtime};
use url::{Host, Url};
use zeroize::Zeroizing;

use crate::command_api::{CommandError, CommandResult};
use session_store::LocalStore;

use super::{invalid, unavailable};

/// Where saved logins live in the OS credential store.
const SERVICE: &str = "dev.aiintegrator.browser-login";
/// The manifest of what is saved, kept in the app's own settings.
pub const SAVED_LOGINS_SETTING: &str = "settings.browser.savedLogins";
/// Per-origin permission for an agent to sign in without asking. Suffixed with
/// the origin, so it is a decision about one site rather than about agents.
pub const AGENT_SIGN_IN_PREFIX: &str = "settings.browser.agentSignIn.";
const MAX_SAVED_LOGINS: usize = 512;
const MAX_USERNAME_BYTES: usize = 320;
const MAX_PASSWORD_BYTES: usize = 16 * 1024;
const MAX_ORIGIN_BYTES: usize = 2 * 1024;
static VAULT_MUTATIONS: Mutex<()> = Mutex::new(());

pub(super) struct VaultMutationGuard {
    _guard: MutexGuard<'static, ()>,
}

pub(super) fn lock_mutations() -> VaultMutationGuard {
    VaultMutationGuard {
        _guard: VAULT_MUTATIONS
            .lock()
            .unwrap_or_else(|error| error.into_inner()),
    }
}
/// One saved login, without its secret. This is what Settings renders and what
/// crosses any boundary; the password is only ever read by `secret`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedLogin {
    /// Browser identity bucket. `projectId` is accepted only to migrate the
    /// pre-scope manifest; new values are task/chat/shared bucket ids.
    #[serde(alias = "projectId")]
    pub bucket_id: String,
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
        account_key(&self.bucket_id, &self.origin, &self.username)
    }
}

/// The account a secret is filed under. Bucket first, so one origin can hold a
/// different login per task without either shadowing the other.
fn account_key(bucket_id: &str, origin: &str, username: &str) -> String {
    format!("{bucket_id} {origin} {username}")
}

/// Scheme, host and port — the whole of what a credential is bound to.
pub fn origin_of(url: &str) -> Result<String, CommandError> {
    let parsed = Url::parse(url).map_err(|_| invalid("that tab has no address"))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(invalid(
            "logins are not saved for URLs with embedded credentials",
        ));
    }
    match parsed.scheme() {
        "https" => {}
        "http"
            if matches!(parsed.host(), Some(Host::Ipv4(address)) if address.is_loopback())
                || matches!(parsed.host(), Some(Host::Ipv6(address)) if address.is_loopback())
                || matches!(parsed.host(), Some(Host::Domain(domain)) if domain.eq_ignore_ascii_case("localhost") || domain.to_ascii_lowercase().ends_with(".localhost")) =>
            {}
        "http" => {
            return Err(invalid(
                "saved logins require HTTPS except on this computer's loopback address",
            ));
        }
        _ => return Err(invalid("logins are only saved for web pages")),
    }
    let origin = parsed.origin();
    if !origin.is_tuple() {
        return Err(invalid("that page has no origin to bind a login to"));
    }
    let origin = origin.ascii_serialization();
    if origin.len() > MAX_ORIGIN_BYTES {
        return Err(invalid("that page origin is too long"));
    }
    Ok(origin)
}

fn raw_manifest_at(store: &LocalStore) -> Vec<SavedLogin> {
    store
        .get_setting(SAVED_LOGINS_SETTING)
        .ok()
        .flatten()
        .map(|setting| serde_json::from_value(setting.value).unwrap_or_default())
        .unwrap_or_default()
}

fn valid_timestamp(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

fn valid_login_fields(entry: &SavedLogin) -> bool {
    !entry.username.is_empty()
        && entry.username.len() <= MAX_USERNAME_BYTES
        && !entry.username.chars().any(char::is_control)
        && entry.origin.len() <= MAX_ORIGIN_BYTES
        && origin_of(&entry.origin).is_ok_and(|origin| origin == entry.origin)
        && valid_timestamp(&entry.saved_at)
        && entry.last_used_at.as_deref().is_none_or(valid_timestamp)
}

fn manifest_at(store: &LocalStore) -> Vec<SavedLogin> {
    raw_manifest_at(store)
        .into_iter()
        .take(MAX_SAVED_LOGINS)
        .filter(|entry| {
            valid_login_fields(entry)
                && super::identity::profile_segment(&entry.bucket_id).is_some()
        })
        .collect()
}

fn manifest<R: Runtime>(app: &AppHandle<R>) -> Vec<SavedLogin> {
    app.try_state::<crate::state::AppState>()
        .map(|state| manifest_at(&state.store))
        .unwrap_or_default()
}

fn write_manifest_at(store: &LocalStore, entries: &[SavedLogin]) -> Result<(), CommandError> {
    if entries.len() > MAX_SAVED_LOGINS
        || entries.iter().any(|entry| {
            !valid_login_fields(entry)
                || super::identity::profile_segment(&entry.bucket_id).is_none()
        })
    {
        return Err(invalid("the saved-login manifest is invalid"));
    }
    store
        .set_setting(SAVED_LOGINS_SETTING, json!(entries))
        .map_err(|error| unavailable(error.to_string()))?;
    Ok(())
}

fn write_manifest<R: Runtime>(
    app: &AppHandle<R>,
    entries: &[SavedLogin],
) -> Result<(), CommandError> {
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or_else(|| unavailable("the app is not ready"))?;
    write_manifest_at(&state.store, entries)
}

fn legacy_destination(store: &LocalStore, legacy: &str) -> String {
    if legacy == "chat" {
        return super::identity::CHAT_BUCKET_ID.to_string();
    }
    if legacy == "*" {
        return super::identity::SHARED_BUCKET_ID.to_string();
    }
    store
        .list_all_tasks()
        .unwrap_or_default()
        .into_iter()
        .filter(|task| {
            task.repository_path
                .as_deref()
                .is_some_and(|path| path.to_string_lossy() == legacy)
        })
        .max_by_key(|task| task.updated_at)
        .map(|task| super::identity::task_bucket_id(task.id))
        // Unknown legacy project entries stay recoverable in Shared instead of
        // being silently made available to an arbitrary task.
        .unwrap_or_else(|| super::identity::SHARED_BUCKET_ID.to_string())
}

fn login_recency(entry: &SavedLogin) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(entry.last_used_at.as_deref().unwrap_or(&entry.saved_at))
        .ok()
}

/// Upgrades the pre-scope manifest and credential account keys once. Sources
/// remain authoritative until the new manifest is durable; a failed migration
/// can therefore be retried without losing a password.
pub fn migrate_legacy_logins(store: &LocalStore) -> Result<usize, CommandError> {
    let _mutation = lock_mutations();
    let original: Vec<SavedLogin> = raw_manifest_at(store)
        .into_iter()
        .take(MAX_SAVED_LOGINS)
        .filter(valid_login_fields)
        .collect();
    if original
        .iter()
        .all(|entry| super::identity::profile_segment(&entry.bucket_id).is_some())
    {
        return Ok(0);
    }

    let mut winners = BTreeMap::<(String, String, String), (SavedLogin, Option<String>)>::new();
    let mut legacy_accounts = Vec::<String>::new();
    let mut moved = 0;
    for mut entry in original {
        let old_bucket = entry.bucket_id.clone();
        let mut source_account = None;
        if super::identity::profile_segment(&old_bucket).is_none() {
            entry.bucket_id = legacy_destination(store, &old_bucket);
            moved += 1;
            let old_account = account_key(&old_bucket, &entry.origin, &entry.username);
            source_account = Some(old_account.clone());
            legacy_accounts.push(old_account);
        }
        let key = (
            entry.bucket_id.clone(),
            entry.origin.clone(),
            entry.username.clone(),
        );
        match winners.get(&key) {
            Some((existing, _)) if login_recency(existing) >= login_recency(&entry) => {}
            _ => {
                winners.insert(key, (entry, source_account));
            }
        }
    }
    let mut migrated = Vec::with_capacity(winners.len());
    let mut rollback = Vec::<(String, Option<Zeroizing<String>>)>::new();
    for (_, (entry, source_account)) in winners {
        if let Some(source_account) = source_account {
            let source = match crate::credential_store::read(SERVICE, &source_account) {
                Ok(source) => source,
                Err(_) => {
                    restore_deleted_credentials(&rollback)?;
                    return Err(unavailable(
                        "the legacy browser credential could not be read",
                    ));
                }
            };
            if let Some(secret) = source {
                let target_account = entry.account();
                let previous = match crate::credential_store::read(SERVICE, &target_account) {
                    Ok(previous) => previous,
                    Err(_) => {
                        restore_deleted_credentials(&rollback)?;
                        return Err(unavailable(
                            "the browser credential target could not be read",
                        ));
                    }
                };
                rollback.push((target_account.clone(), previous));
                if crate::credential_store::write(SERVICE, &target_account, &secret).is_err() {
                    let restored = restore_deleted_credentials(&rollback).is_ok();
                    return Err(unavailable(if restored {
                        "the browser credential could not be migrated"
                    } else {
                        "the browser credential migration and its rollback did not finish"
                    }));
                }
            }
        }
        migrated.push(entry);
    }
    if let Err(error) = write_manifest_at(store, &migrated) {
        restore_deleted_credentials(&rollback)?;
        return Err(error);
    }
    legacy_accounts.sort();
    legacy_accounts.dedup();
    for account in legacy_accounts {
        let _ = crate::credential_store::delete(SERVICE, &account);
    }
    Ok(moved)
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct LoginMergeSummary {
    pub merged: usize,
    pub conflicts: usize,
}

pub(super) struct SharedLoginMerge {
    pub summary: LoginMergeSummary,
    original_manifest: Vec<SavedLogin>,
    rollback: Vec<(String, Option<Zeroizing<String>>)>,
}

impl SharedLoginMerge {
    pub fn rollback<R: Runtime>(
        self,
        app: &AppHandle<R>,
        _mutation: &VaultMutationGuard,
    ) -> Result<(), CommandError> {
        restore_deleted_credentials(&self.rollback)?;
        write_manifest(app, &self.original_manifest)
    }
}

fn shared_login_winners(entries: &[SavedLogin]) -> (Vec<SavedLogin>, usize) {
    let mut candidates = BTreeMap::<(String, String), Vec<SavedLogin>>::new();
    for entry in entries {
        candidates
            .entry((entry.origin.clone(), entry.username.clone()))
            .or_default()
            .push(entry.clone());
    }

    let mut winners = Vec::with_capacity(candidates.len());
    let mut conflicts = 0;
    for entries in candidates.values_mut() {
        entries.sort_by(|left, right| {
            login_recency(left)
                .cmp(&login_recency(right))
                // A tie keeps an existing Shared value stable.
                .then_with(|| {
                    (left.bucket_id == super::identity::SHARED_BUCKET_ID)
                        .cmp(&(right.bucket_id == super::identity::SHARED_BUCKET_ID))
                })
        });
        if entries
            .iter()
            .map(|entry| &entry.bucket_id)
            .collect::<std::collections::HashSet<_>>()
            .len()
            > 1
        {
            conflicts += 1;
        }
        if let Some(winner) = entries.last().cloned() {
            winners.push(winner);
        }
    }
    (winners, conflicts)
}

/// Builds the Shared saved-login view without deleting any source bucket. The
/// target writes are rolled back if the manifest cannot be committed.
pub(super) fn merge_into_shared<R: Runtime>(
    app: &AppHandle<R>,
    _mutation: &VaultMutationGuard,
) -> Result<SharedLoginMerge, CommandError> {
    let original = manifest(app);
    let (winners, conflicts) = shared_login_winners(&original);

    let mut rollback = Vec::<(String, Option<Zeroizing<String>>)>::new();
    let mut shared_entries = Vec::with_capacity(winners.len());
    let mut merged = 0;
    for mut winner in winners {
        let source_account = winner.account();
        let target_account = account_key(
            super::identity::SHARED_BUCKET_ID,
            &winner.origin,
            &winner.username,
        );
        if winner.bucket_id != super::identity::SHARED_BUCKET_ID {
            let secret = match crate::credential_store::read(SERVICE, &source_account) {
                Ok(Some(secret)) => secret,
                Ok(None) => {
                    restore_deleted_credentials(&rollback)?;
                    return Err(unavailable(
                        "a saved browser login is missing its credential",
                    ));
                }
                Err(_) => {
                    restore_deleted_credentials(&rollback)?;
                    return Err(unavailable(
                        "a browser credential could not be read for sharing",
                    ));
                }
            };
            let previous = match crate::credential_store::read(SERVICE, &target_account) {
                Ok(previous) => previous,
                Err(_) => {
                    restore_deleted_credentials(&rollback)?;
                    return Err(unavailable(
                        "the Shared browser credential could not be read",
                    ));
                }
            };
            rollback.push((target_account.clone(), previous));
            if let Err(error) = crate::credential_store::write(SERVICE, &target_account, &secret) {
                let restored = restore_deleted_credentials(&rollback).is_ok();
                let _ = error;
                return Err(unavailable(if restored {
                    "the Shared browser credential could not be written"
                } else {
                    "a Shared browser credential write and its rollback did not finish"
                }));
            }
            merged += 1;
        }
        winner.bucket_id = super::identity::SHARED_BUCKET_ID.to_string();
        shared_entries.push(winner);
    }

    let mut next: Vec<SavedLogin> = original
        .iter()
        .filter(|entry| entry.bucket_id != super::identity::SHARED_BUCKET_ID)
        .cloned()
        .collect();
    next.extend(shared_entries);
    if let Err(error) = write_manifest(app, &next) {
        if restore_deleted_credentials(&rollback).is_err() {
            return Err(unavailable(
                "the Shared saved-login manifest and its credential rollback did not finish",
            ));
        }
        return Err(error);
    }
    Ok(SharedLoginMerge {
        summary: LoginMergeSummary { merged, conflicts },
        original_manifest: original,
        rollback,
    })
}

/// Every saved login, for the Settings list. No secret is read.
pub fn all<R: Runtime>(app: &AppHandle<R>) -> Vec<SavedLogin> {
    manifest(app)
}

/// The logins offered on one origin inside exactly one identity bucket.
pub fn for_origin<R: Runtime>(
    app: &AppHandle<R>,
    bucket_id: &str,
    origin: &str,
) -> Vec<SavedLogin> {
    manifest(app)
        .into_iter()
        .filter(|entry| entry.origin == origin && entry.bucket_id == bucket_id)
        .collect()
}

/// Saves or updates one login. Returns the manifest entry, never the secret.
pub fn save<R: Runtime>(
    app: &AppHandle<R>,
    bucket_id: &str,
    origin: &str,
    username: &str,
    password: &str,
) -> Result<SavedLogin, CommandError> {
    let _mutation = lock_mutations();
    if super::identity::profile_segment(bucket_id).is_none() {
        return Err(invalid("that browser identity does not exist"));
    }
    let origin = origin_of(origin)?;
    let username = username.trim();
    if username.is_empty() {
        return Err(invalid("a saved login needs a username"));
    }
    if username.len() > MAX_USERNAME_BYTES {
        return Err(invalid("that username is too long"));
    }
    if username.chars().any(char::is_control) {
        return Err(invalid("that username contains unsupported characters"));
    }
    if password.is_empty() {
        return Err(invalid("a saved login needs a password"));
    }
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(invalid("that password is too long to save safely"));
    }
    let entry = SavedLogin {
        bucket_id: bucket_id.to_string(),
        origin,
        username: username.to_string(),
        saved_at: chrono::Utc::now().to_rfc3339(),
        last_used_at: None,
    };
    let account = entry.account();
    let previous_secret = crate::credential_store::read(SERVICE, &account)
        .map_err(|_| unavailable("the OS credential store refused to read that login"))?;
    let rollback = vec![(account.clone(), previous_secret)];
    if crate::credential_store::write(SERVICE, &account, password).is_err() {
        let restored = restore_deleted_credentials(&rollback).is_ok();
        return Err(unavailable(if restored {
            "the OS credential store refused to save that login"
        } else {
            "the browser credential write and its rollback did not finish"
        }));
    }
    let mut entries = manifest(app);
    // Re-saving the same account replaces the password and keeps its history,
    // which is what "update" means here: one entry per account, always.
    match entries.iter_mut().find(|existing| {
        existing.bucket_id == entry.bucket_id
            && existing.origin == entry.origin
            && existing.username == entry.username
    }) {
        Some(existing) => existing.saved_at = entry.saved_at.clone(),
        None => entries.push(entry.clone()),
    }
    if let Err(error) = write_manifest(app, &entries) {
        if restore_deleted_credentials(&rollback).is_err() {
            return Err(unavailable(
                "the saved-login manifest failed and its credential rollback did not finish",
            ));
        }
        return Err(error);
    }
    Ok(entry)
}

fn restore_deleted_credentials(
    snapshots: &[(String, Option<Zeroizing<String>>)],
) -> Result<(), CommandError> {
    let mut failed = false;
    for (account, value) in snapshots.iter().rev() {
        let result = match value {
            Some(value) => crate::credential_store::write(SERVICE, account, value),
            None => crate::credential_store::delete(SERVICE, account),
        };
        failed |= result.is_err();
    }
    if failed {
        Err(unavailable(
            "the browser credential rollback did not finish",
        ))
    } else {
        Ok(())
    }
}

fn delete_credentials_transactionally(
    accounts: impl IntoIterator<Item = String>,
) -> Result<Vec<(String, Option<Zeroizing<String>>)>, CommandError> {
    let mut snapshots = Vec::new();
    for account in accounts {
        let value = crate::credential_store::read(SERVICE, &account)
            .map_err(|_| unavailable("the OS credential store refused to read a login"))?;
        snapshots.push((account, value));
    }
    for index in 0..snapshots.len() {
        if crate::credential_store::delete(SERVICE, &snapshots[index].0).is_err() {
            restore_deleted_credentials(&snapshots[..=index])?;
            return Err(unavailable(
                "the OS credential store refused to remove a login",
            ));
        }
    }
    Ok(snapshots)
}

/// Forgets one login: the secret first, then the row that points at it.
pub fn forget<R: Runtime>(
    app: &AppHandle<R>,
    bucket_id: &str,
    origin: &str,
    username: &str,
) -> Result<(), CommandError> {
    let _mutation = lock_mutations();
    let current = manifest(app);
    if !current.iter().any(|entry| {
        entry.bucket_id == bucket_id && entry.origin == origin && entry.username == username
    }) {
        return Err(invalid("that saved login no longer exists"));
    }
    let snapshots = delete_credentials_transactionally([account_key(bucket_id, origin, username)])?;
    let entries: Vec<SavedLogin> = current
        .into_iter()
        .filter(|entry| {
            !(entry.bucket_id == bucket_id && entry.origin == origin && entry.username == username)
        })
        .collect();
    if let Err(error) = write_manifest(app, &entries) {
        restore_deleted_credentials(&snapshots)?;
        return Err(error);
    }
    Ok(())
}

/// Forgets everything. Used by the "forget all" control in Settings.
pub fn forget_all<R: Runtime>(app: &AppHandle<R>) -> Result<(), CommandError> {
    let _mutation = lock_mutations();
    let current = manifest(app);
    let snapshots = delete_credentials_transactionally(current.iter().map(SavedLogin::account))?;
    if let Err(error) = write_manifest(app, &[]) {
        restore_deleted_credentials(&snapshots)?;
        return Err(error);
    }
    Ok(())
}

pub fn forget_bucket<R: Runtime>(app: &AppHandle<R>, bucket_id: &str) -> Result<(), CommandError> {
    let _mutation = lock_mutations();
    if super::identity::profile_segment(bucket_id).is_none() {
        return Err(invalid("that browser identity does not exist"));
    }
    let entries = manifest(app);
    let snapshots = delete_credentials_transactionally(
        entries
            .iter()
            .filter(|entry| entry.bucket_id == bucket_id)
            .map(SavedLogin::account),
    )?;
    let kept: Vec<SavedLogin> = entries
        .into_iter()
        .filter(|entry| entry.bucket_id != bucket_id)
        .collect();
    if let Err(error) = write_manifest(app, &kept) {
        restore_deleted_credentials(&snapshots)?;
        return Err(error);
    }
    Ok(())
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
    let _mutation = lock_mutations();
    let mut entries = manifest(app);
    if let Some(entry) = entries.iter_mut().find(|entry| {
        entry.bucket_id == used.bucket_id
            && entry.origin == used.origin
            && entry.username == used.username
    }) {
        entry.last_used_at = Some(chrono::Utc::now().to_rfc3339());
    }
    let _ = write_manifest(app, &entries);
}

/// Whether this installation lets agents sign in on one origin without asking.
/// Off unless the user has said otherwise for that exact site.
fn agent_sign_in_key(bucket_id: &str, origin: &str) -> Option<String> {
    super::identity::profile_segment(bucket_id)?;
    let origin = origin_of(origin).ok()?;
    Some(format!("{AGENT_SIGN_IN_PREFIX}{bucket_id}.{origin}"))
}

pub fn agent_may_sign_in<R: Runtime>(app: &AppHandle<R>, bucket_id: &str, origin: &str) -> bool {
    let Some(key) = agent_sign_in_key(bucket_id, origin) else {
        return false;
    };
    app.try_state::<crate::state::AppState>()
        .and_then(|state| state.store.get_setting(&key).ok().flatten())
        .and_then(|setting| setting.value.as_bool())
        .unwrap_or(false)
}

/// Remembers the user's answer to "let agents sign in here", per origin.
pub fn set_agent_may_sign_in<R: Runtime>(
    app: &AppHandle<R>,
    bucket_id: &str,
    origin: &str,
    allowed: bool,
) -> Result<(), CommandError> {
    let key = agent_sign_in_key(bucket_id, origin)
        .ok_or_else(|| invalid("that browser identity or origin is invalid"))?;
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or_else(|| unavailable("the app is not ready"))?;
    state
        .store
        .set_setting(&key, json!(allowed))
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

fn login_bucket<R: Runtime>(
    app: &AppHandle<R>,
    tabs: &super::BrowserTabs,
    task_id: &str,
) -> Result<String, CommandError> {
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or_else(|| unavailable("the app is not ready"))?;
    Ok(super::identity::bucket_for_task(
        &state.store,
        tabs.identity_scope(),
        task_id,
    ))
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
    super::require_task(tabs, task_id, tab_id)?;
    super::remember::ensure_awake(app, tabs, tab_id).await;
    let tab = tabs
        .snapshot(None)
        .into_iter()
        .find(|tab| tab.id == tab_id && tab.task_id == task_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    // The origin comes from the tab's own address, never from the caller: a
    // page that could name the origin could name someone else's.
    let origin = origin_of(&tab.url)?;
    let bucket_id = login_bucket(app, tabs, task_id)?;
    let entry = choose(for_origin(app, &bucket_id, &origin), username, &origin)?;
    if by_agent && !agent_may_sign_in(app, &bucket_id, &origin) {
        let _ = tauri::Emitter::emit(
            app,
            super::BROWSER_FILL_REQUEST_EVENT,
            json!({
                "taskId": task_id,
                "tabId": tab_id,
                "origin": origin,
                "username": entry.username,
            }),
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
    // Lock host-side captures before the password enters the page; otherwise
    // a concurrent screenshot could win the interval between fill and return.
    tabs.mark_credential_filled(tab_id);
    let reply = match super::eval_json(
        app,
        &label,
        format!(
            "window.__integrator.fillLogin({key:?},{origin:?},{username:?},{:?},true)",
            &*password
        ),
    )
    .await
    {
        Ok(reply) => reply,
        Err(error) => {
            tabs.clear_credential(tab_id);
            return Err(error);
        }
    };
    drop(password);
    // From here until the page navigates, reading this tab is refused. The
    // guest enforces it for page reads; the host enforces it for captures,
    // which the guest cannot see.
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
) -> Result<SavedLogin, CommandError> {
    super::require_task(tabs, task_id, tab_id)?;
    let label = tabs
        .label_for(tab_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let key = tabs.host_key();
    let mut captured = super::eval_json(
        app,
        &label,
        format!("window.__integrator.captureLogin({key:?})"),
    )
    .await?;
    let captured = captured
        .as_object_mut()
        .ok_or_else(|| invalid("that page returned an invalid login"))?;
    // Pull the secret into a zeroizing allocation before validating any other
    // field, so even a malformed guest reply cannot leave it in a dropped JSON
    // value on an early return.
    let password = Zeroizing::new(
        captured
            .remove("password")
            .and_then(|value| match value {
                Value::String(value) => Some(value),
                _ => None,
            })
            .unwrap_or_default(),
    );
    let origin = captured
        .remove("origin")
        .and_then(|value| match value {
            Value::String(value) => Some(value),
            _ => None,
        })
        .ok_or_else(|| invalid("that page has no origin to bind a login to"))?;
    let username = captured
        .remove("username")
        .and_then(|value| match value {
            Value::String(value) => Some(value),
            _ => None,
        })
        .unwrap_or_default();
    save(
        app,
        &login_bucket(app, tabs, task_id)?,
        &origin,
        &username,
        &password,
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
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<super::BrowserTabs>>,
    tab_id: String,
    task_id: String,
) -> CommandResult<SavedLogin> {
    super::require_renderer_task(&webview, &task_id)?;
    save_from_page(&app, &state, &task_id, &tab_id).await
}

/// Fills a saved login because the person asked for it — no permission needed
/// beyond their click.
#[tauri::command]
pub async fn browser_fill_login(
    app: AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<super::BrowserTabs>>,
    tab_id: String,
    task_id: String,
    username: Option<String>,
) -> CommandResult<Value> {
    super::require_renderer_task(&webview, &task_id)?;
    fill_login(&app, &state, &task_id, &tab_id, username.as_deref(), false).await
}

#[tauri::command]
pub async fn browser_forget_login(
    app: AppHandle,
    state: tauri::State<'_, Arc<super::BrowserTabs>>,
    bucket_id: String,
    origin: String,
    username: String,
) -> CommandResult<Vec<SavedLogin>> {
    if !super::sites::bucket_allowed(&app, &state, &bucket_id) {
        return Err(unavailable("that browser identity does not exist"));
    }
    forget(&app, &bucket_id, &origin, &username)?;
    Ok(all(&app))
}

#[tauri::command]
pub async fn browser_forget_all_logins(app: AppHandle) -> CommandResult<Vec<SavedLogin>> {
    forget_all(&app)?;
    Ok(all(&app))
}

#[tauri::command]
pub async fn browser_forget_bucket_logins(
    app: AppHandle,
    state: tauri::State<'_, Arc<super::BrowserTabs>>,
    bucket_id: String,
) -> CommandResult<Vec<SavedLogin>> {
    if !super::sites::bucket_allowed(&app, &state, &bucket_id) {
        return Err(unavailable("that browser identity does not exist"));
    }
    forget_bucket(&app, &bucket_id)?;
    Ok(all(&app))
}

/// Records whether agents may sign in on one origin without asking again.
#[tauri::command]
pub async fn browser_allow_agent_sign_in(
    app: AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<super::BrowserTabs>>,
    task_id: String,
    tab_id: String,
    origin: String,
    allowed: bool,
) -> CommandResult<()> {
    super::require_renderer_task(&webview, &task_id)?;
    super::require_task(&state, &task_id, &tab_id)?;
    let tab = state
        .snapshot(None)
        .into_iter()
        .find(|tab| tab.id == tab_id && tab.task_id == task_id)
        .ok_or_else(|| unavailable("that browser tab is no longer open"))?;
    let current_origin = origin_of(&tab.url)?;
    if origin_of(&origin)? != current_origin {
        return Err(invalid("that sign-in request no longer matches this page"));
    }
    let bucket_id = login_bucket(&app, &state, &task_id)?;
    set_agent_may_sign_in(&app, &bucket_id, &current_origin, allowed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(bucket: &str, origin: &str, user: &str) -> SavedLogin {
        SavedLogin {
            bucket_id: bucket.into(),
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
        assert!(origin_of("http://example.com").is_err());
        assert!(origin_of("https://user:password@example.com").is_err());
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
    fn login_recency_compares_instants_instead_of_timestamp_text() {
        let mut earlier = entry("task:one", "https://example.com", "ana");
        earlier.saved_at = "2026-08-17T01:00:00+14:00".into();
        let mut later = entry("task:two", "https://example.com", "ana");
        later.saved_at = "2026-08-16T23:00:00-12:00".into();

        let (winners, conflicts) = shared_login_winners(&[earlier, later]);
        assert_eq!(winners[0].bucket_id, "task:two");
        assert_eq!(conflicts, 1);
    }

    #[test]
    fn remembered_agent_approval_is_bound_to_one_identity() {
        let origin = "https://example.com";
        assert_ne!(
            agent_sign_in_key(super::super::identity::CHAT_BUCKET_ID, origin),
            agent_sign_in_key("task:one", origin)
        );
        assert!(agent_sign_in_key("../outside", origin).is_none());
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

    #[test]
    fn newest_saved_login_wins_a_shared_merge() {
        let origin = "https://example.com";
        let mut old = entry(super::super::identity::SHARED_BUCKET_ID, origin, "ana");
        old.saved_at = "2026-08-17T08:00:00Z".into();
        let mut recent = entry("task:new", origin, "ana");
        recent.last_used_at = Some("2026-08-17T12:00:00Z".into());

        let (winners, conflicts) = shared_login_winners(&[old, recent]);
        assert_eq!(winners.len(), 1);
        assert_eq!(winners[0].bucket_id, "task:new");
        assert_eq!(conflicts, 1);
    }

    #[test]
    fn existing_shared_login_wins_an_exact_recency_tie() {
        let origin = "https://example.com";
        let shared = entry(super::super::identity::SHARED_BUCKET_ID, origin, "ana");
        let task = entry("task:one", origin, "ana");

        let (winners, conflicts) = shared_login_winners(&[shared, task]);
        assert_eq!(
            winners[0].bucket_id,
            super::super::identity::SHARED_BUCKET_ID
        );
        assert_eq!(conflicts, 1);
    }

    #[test]
    fn legacy_project_id_deserializes_but_new_metadata_uses_bucket_id() {
        let legacy: SavedLogin = serde_json::from_value(json!({
            "projectId": "chat",
            "origin": "https://example.com",
            "username": "ana",
            "savedAt": "2026-08-17T00:00:00Z"
        }))
        .unwrap();
        assert_eq!(legacy.bucket_id, "chat");
        let current = serde_json::to_value(legacy).unwrap();
        assert_eq!(
            current.get("bucketId").and_then(Value::as_str),
            Some("chat")
        );
        assert!(current.get("projectId").is_none());
    }
}
