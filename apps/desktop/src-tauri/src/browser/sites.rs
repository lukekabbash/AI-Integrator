//! What the browser profile is holding: which sites have cookies, and the
//! control that throws all of it away.
//!
//! Separate from the tab registry on purpose — this is about the profile
//! directory on disk, which outlives every tab in it.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    path::PathBuf,
    sync::Arc,
};

use integrator_core::TaskKind;
use serde::Serialize;
use tauri::{
    AppHandle, Manager, WebviewUrl,
    webview::{Cookie, WebviewBuilder},
};
use url::Url;

use crate::command_api::CommandResult;

use super::{BrowserTabs, KEEP_SIGNED_IN_SETTING, setting_enabled, unavailable, webview_of};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserIdentityBucket {
    pub id: String,
    pub label: String,
    /// `task` | `chat` | `shared` | `orphan`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub archived: bool,
    pub updated_at: String,
    pub profile_present: bool,
    pub saved_logins: usize,
    pub active: bool,
    #[serde(skip)]
    merge_recency: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserIdentityOverview {
    pub active_scope: super::BrowserIdentityScope,
    pub configured_scope: super::BrowserIdentityScope,
    pub restart_required: bool,
    pub buckets: Vec<BrowserIdentityBucket>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserIdentitySwitchResult {
    pub active_scope: super::BrowserIdentityScope,
    pub configured_scope: super::BrowserIdentityScope,
    pub restart_required: bool,
    pub merged_cookies: usize,
    pub cookie_conflicts: usize,
    pub skipped_partitioned_cookies: usize,
    pub merged_logins: usize,
    pub login_conflicts: usize,
    pub sources_retained: bool,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct CookieKey {
    domain: String,
    path: String,
    name: String,
}

fn cookie_key(cookie: &Cookie<'_>) -> Option<CookieKey> {
    let domain = cookie
        .domain()?
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if domain.is_empty() {
        return None;
    }
    Some(CookieKey {
        domain,
        path: cookie.path().unwrap_or("/").to_string(),
        name: cookie.name().to_string(),
    })
}

fn cookies_match(left: &Cookie<'_>, right: &Cookie<'_>) -> bool {
    left.name() == right.name()
        && left.value() == right.value()
        && left.domain() == right.domain()
        && left.path() == right.path()
        && left.expires() == right.expires()
        && left.max_age() == right.max_age()
        && left.secure() == right.secure()
        && left.http_only() == right.http_only()
        && left.same_site() == right.same_site()
        && left.partitioned() == right.partitioned()
}

struct ProfileWebview {
    webview: tauri::Webview<tauri::Wry>,
    temporary: bool,
}

impl Drop for ProfileWebview {
    fn drop(&mut self) {
        if self.temporary {
            let _ = self.webview.close();
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct CookieMergeSummary {
    merged: usize,
    conflicts: usize,
    skipped_partitioned: usize,
}

struct SharedCookieMerge {
    target: ProfileWebview,
    rollback: Vec<(Option<Cookie<'static>>, Cookie<'static>)>,
    summary: CookieMergeSummary,
}

type CookieSource = (i64, bool, String, Vec<Cookie<'static>>);

fn cookie_winners(
    mut sources: Vec<CookieSource>,
) -> (BTreeMap<CookieKey, (String, Cookie<'static>)>, usize) {
    // Oldest to newest. Shared wins an exact recency tie so a repeat merge is
    // stable instead of rewriting the target on every confirmation.
    sources.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.cmp(&right.2))
    });
    let mut winners = BTreeMap::<CookieKey, (String, Cookie<'static>)>::new();
    let mut conflicts = BTreeSet::<CookieKey>::new();
    for (_, _, bucket_id, cookies) in sources {
        for cookie in cookies {
            // CHIPS partition keys are not exposed by the webview cookie API.
            // Merging one would collapse or broaden a boundary we cannot name.
            if cookie.partitioned() == Some(true) {
                continue;
            }
            let Some(key) = cookie_key(&cookie) else {
                continue;
            };
            if let Some((previous_bucket, previous_cookie)) = winners.get(&key)
                && previous_bucket != &bucket_id
                && !cookies_match(previous_cookie, &cookie)
            {
                conflicts.insert(key.clone());
            }
            winners.insert(key, (bucket_id.clone(), cookie));
        }
    }
    (winners, conflicts.len())
}

impl SharedCookieMerge {
    fn rollback(self) -> Result<(), crate::command_api::CommandError> {
        let SharedCookieMerge {
            target, rollback, ..
        } = self;
        if !restore_cookie_writes(&target, rollback) {
            Err(unavailable(
                "the Shared browser cookie rollback did not finish",
            ))
        } else {
            Ok(())
        }
    }
}

fn profile_present(data_directory: &std::path::Path, bucket_id: &str, persistent: bool) -> bool {
    let scope = scope_for_bucket(bucket_id);
    super::identity::existing_profile_directory(data_directory, scope, bucket_id, persistent)
        .is_ok_and(|path| path.is_some())
        || (!persistent
            && super::identity::existing_profile_directory(data_directory, scope, bucket_id, true)
                .is_ok_and(|path| path.is_some()))
}

fn profile_recency_millis(data_directory: &std::path::Path, bucket_id: &str) -> i64 {
    let Ok(Some(path)) = super::identity::existing_profile_directory(
        data_directory,
        scope_for_bucket(bucket_id),
        bucket_id,
        true,
    ) else {
        return 0;
    };
    path.metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}

fn scope_for_bucket(bucket_id: &str) -> super::BrowserIdentityScope {
    if bucket_id == super::identity::SHARED_BUCKET_ID {
        super::BrowserIdentityScope::Shared
    } else {
        super::BrowserIdentityScope::Task
    }
}

fn bucket_catalog(app: &AppHandle, tabs: &BrowserTabs) -> Vec<BrowserIdentityBucket> {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return Vec::new();
    };
    let active_scope = tabs.identity_scope();
    let persistent = setting_enabled(app, KEEP_SIGNED_IN_SETTING);
    let logins = super::vault::all(app);
    let mut login_counts = HashMap::<String, usize>::new();
    for login in &logins {
        *login_counts.entry(login.bucket_id.clone()).or_default() += 1;
    }

    let mut buckets = Vec::new();
    let mut known = HashSet::new();
    let mut chat_updated_at = String::new();
    let mut chat_recency = 0;
    for task in state.store.list_all_tasks().unwrap_or_default() {
        if task.kind == TaskKind::Chat {
            chat_updated_at = chat_updated_at.max(task.updated_at.to_rfc3339());
            chat_recency = chat_recency.max(task.updated_at.timestamp_millis());
            continue;
        }
        let id = super::identity::task_bucket_id(task.id);
        known.insert(id.clone());
        buckets.push(BrowserIdentityBucket {
            profile_present: profile_present(&state.data_directory, &id, persistent),
            saved_logins: login_counts.get(&id).copied().unwrap_or_default(),
            active: active_scope == super::BrowserIdentityScope::Task,
            merge_recency: task
                .updated_at
                .timestamp_millis()
                .max(profile_recency_millis(&state.data_directory, &id)),
            id,
            label: task.title,
            kind: "task".into(),
            task_id: Some(task.id.to_string()),
            archived: task.archived,
            updated_at: task.updated_at.to_rfc3339(),
        });
    }
    buckets.sort_by(|a, b| {
        a.archived
            .cmp(&b.archived)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.label.cmp(&b.label))
    });

    known.insert(super::identity::CHAT_BUCKET_ID.to_string());
    buckets.push(BrowserIdentityBucket {
        id: super::identity::CHAT_BUCKET_ID.into(),
        label: "Chat/Main Browser".into(),
        kind: "chat".into(),
        task_id: None,
        archived: false,
        updated_at: chat_updated_at,
        profile_present: profile_present(
            &state.data_directory,
            super::identity::CHAT_BUCKET_ID,
            persistent,
        ),
        saved_logins: login_counts
            .get(super::identity::CHAT_BUCKET_ID)
            .copied()
            .unwrap_or_default(),
        active: active_scope == super::BrowserIdentityScope::Task,
        merge_recency: chat_recency.max(profile_recency_millis(
            &state.data_directory,
            super::identity::CHAT_BUCKET_ID,
        )),
    });

    known.insert(super::identity::SHARED_BUCKET_ID.to_string());
    buckets.push(BrowserIdentityBucket {
        id: super::identity::SHARED_BUCKET_ID.into(),
        label: "Shared Browser".into(),
        kind: "shared".into(),
        task_id: None,
        archived: false,
        updated_at: String::new(),
        profile_present: profile_present(
            &state.data_directory,
            super::identity::SHARED_BUCKET_ID,
            persistent,
        ),
        saved_logins: login_counts
            .get(super::identity::SHARED_BUCKET_ID)
            .copied()
            .unwrap_or_default(),
        active: active_scope == super::BrowserIdentityScope::Shared,
        merge_recency: profile_recency_millis(
            &state.data_directory,
            super::identity::SHARED_BUCKET_ID,
        ),
    });

    if let Ok(Some(root)) = super::identity::persistent_profiles_root(&state.data_directory)
        && let Ok(entries) = fs::read_dir(root)
    {
        for entry in entries.flatten() {
            let Some(segment) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Some(id) = super::identity::bucket_id_from_profile_segment(&segment) else {
                continue;
            };
            if known.insert(id.clone()) {
                buckets.push(BrowserIdentityBucket {
                    id: id.clone(),
                    label: "Deleted task browser data".into(),
                    kind: "orphan".into(),
                    task_id: id.strip_prefix("task:").map(str::to_owned),
                    archived: true,
                    updated_at: String::new(),
                    profile_present: true,
                    saved_logins: login_counts.get(&id).copied().unwrap_or_default(),
                    active: active_scope == super::BrowserIdentityScope::Task,
                    merge_recency: profile_recency_millis(&state.data_directory, &id),
                });
            }
        }
    }
    for (id, count) in login_counts {
        if known.insert(id.clone()) {
            buckets.push(BrowserIdentityBucket {
                id,
                label: "Legacy browser login data".into(),
                kind: "orphan".into(),
                task_id: None,
                archived: true,
                updated_at: String::new(),
                profile_present: false,
                saved_logins: count,
                active: false,
                merge_recency: 0,
            });
        }
    }
    buckets
}

#[tauri::command]
pub async fn browser_identity_overview(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
) -> CommandResult<BrowserIdentityOverview> {
    let app_state = app
        .try_state::<crate::state::AppState>()
        .ok_or_else(|| unavailable("the app is not ready"))?;
    let configured_scope = super::identity::configured_scope(&app_state.store);
    Ok(BrowserIdentityOverview {
        active_scope: state.identity_scope(),
        configured_scope,
        restart_required: configured_scope != state.identity_scope(),
        buckets: bucket_catalog(&app, &state),
    })
}

pub(super) fn bucket_allowed(app: &AppHandle, tabs: &BrowserTabs, bucket_id: &str) -> bool {
    bucket_catalog(app, tabs)
        .iter()
        .any(|bucket| bucket.id == bucket_id)
}

fn live_profile_label(app: &AppHandle, tabs: &BrowserTabs, bucket_id: &str) -> Option<String> {
    let app_state = app.try_state::<crate::state::AppState>()?;
    let scope = tabs.identity_scope();
    let guard = tabs.tabs.lock().unwrap_or_else(|error| error.into_inner());
    guard.values().find_map(|tab| {
        (!tab.state.sleeping
            && super::identity::bucket_for_task(&app_state.store, scope, &tab.state.task_id)
                == bucket_id)
            .then(|| tab.label.clone())
    })
}

fn profile_path_for_bucket(
    app: &AppHandle,
    bucket_id: &str,
    persistent: bool,
) -> Result<PathBuf, crate::command_api::CommandError> {
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or_else(|| unavailable("the app is not ready"))?;
    let scope = scope_for_bucket(bucket_id);
    super::identity::profile_directory(&state.data_directory, scope, bucket_id, persistent)
        .map_err(|_| unavailable("that browser identity has no usable profile"))
}

fn existing_profile_path_for_bucket(
    app: &AppHandle,
    bucket_id: &str,
    persistent: bool,
) -> Result<Option<PathBuf>, crate::command_api::CommandError> {
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or_else(|| unavailable("the app is not ready"))?;
    super::identity::existing_profile_directory(
        &state.data_directory,
        scope_for_bucket(bucket_id),
        bucket_id,
        persistent,
    )
    .map_err(|_| unavailable("that browser identity has no usable profile"))
}

fn open_profile_probe(
    app: &AppHandle,
    profile: PathBuf,
) -> Result<tauri::Webview<tauri::Wry>, crate::command_api::CommandError> {
    let label = format!("browser-profile-probe-{}", uuid::Uuid::new_v4());
    let window = app
        .get_window("main")
        .ok_or_else(|| unavailable("the main window is not available"))?;
    let target = Url::parse("about:blank").expect("about:blank parses");
    let webview = window
        .add_child(
            WebviewBuilder::new(&label, WebviewUrl::External(target))
                .general_autofill_enabled(false)
                .data_directory(profile),
            super::parked().0,
            super::parked().1,
        )
        .map_err(|error| unavailable(format!("could not inspect that browser profile: {error}")))?;
    if let Err(error) = webview.hide() {
        let _ = webview.close();
        return Err(unavailable(format!(
            "could not hide the browser profile inspector: {error}"
        )));
    }
    Ok(webview)
}

fn profile_webview_known(
    app: &AppHandle,
    tabs: &BrowserTabs,
    bucket_id: &str,
    persistent: bool,
    create: bool,
) -> Result<Option<ProfileWebview>, crate::command_api::CommandError> {
    if persistent == setting_enabled(app, KEEP_SIGNED_IN_SETTING)
        && let Some(label) = live_profile_label(app, tabs, bucket_id)
    {
        return Ok(Some(ProfileWebview {
            webview: webview_of(app, &label)?,
            temporary: false,
        }));
    }
    let profile = if create {
        profile_path_for_bucket(app, bucket_id, persistent)?
    } else {
        let Some(profile) = existing_profile_path_for_bucket(app, bucket_id, persistent)? else {
            return Ok(None);
        };
        profile
    };
    Ok(Some(ProfileWebview {
        webview: open_profile_probe(app, profile)?,
        temporary: true,
    }))
}

fn profile_webview(
    app: &AppHandle,
    tabs: &BrowserTabs,
    bucket_id: &str,
    persistent: bool,
    create: bool,
) -> Result<Option<ProfileWebview>, crate::command_api::CommandError> {
    if !bucket_allowed(app, tabs, bucket_id) {
        return Err(unavailable("that browser identity does not exist"));
    }
    profile_webview_known(app, tabs, bucket_id, persistent, create)
}

fn cookies_for_known_identity_bucket(
    app: &AppHandle,
    tabs: &BrowserTabs,
    bucket_id: &str,
    persistent: bool,
) -> CommandResult<Vec<Cookie<'static>>> {
    let Some(profile) = profile_webview_known(app, tabs, bucket_id, persistent, false)? else {
        return Ok(Vec::new());
    };
    profile
        .webview
        .cookies()
        .map_err(|error| unavailable(error.to_string()))
}

pub(super) fn cookies_for_identity_bucket(
    app: &AppHandle,
    tabs: &BrowserTabs,
    bucket_id: &str,
    persistent: bool,
) -> CommandResult<Vec<Cookie<'static>>> {
    if !bucket_allowed(app, tabs, bucket_id) {
        return Err(unavailable("that browser identity does not exist"));
    }
    cookies_for_known_identity_bucket(app, tabs, bucket_id, persistent)
}

fn restore_cookie_writes(
    target: &ProfileWebview,
    rollback: Vec<(Option<Cookie<'static>>, Cookie<'static>)>,
) -> bool {
    let mut failed = false;
    for (previous, applied) in rollback.into_iter().rev() {
        let result = match previous {
            Some(previous) => target.webview.set_cookie(previous),
            None => target.webview.delete_cookie(applied),
        };
        failed |= result.is_err();
    }
    !failed
}

fn merge_cookies_into_shared(
    app: &AppHandle,
    tabs: &BrowserTabs,
) -> CommandResult<SharedCookieMerge> {
    let catalog = bucket_catalog(app, tabs);
    let target = profile_webview_known(app, tabs, super::identity::SHARED_BUCKET_ID, true, true)?
        .expect("creating the Shared profile returns a webview");
    let target_cookies = target
        .webview
        .cookies()
        .map_err(|error| unavailable(error.to_string()))?;

    let shared_recency = catalog
        .iter()
        .find(|bucket| bucket.id == super::identity::SHARED_BUCKET_ID)
        .map(|bucket| bucket.merge_recency)
        .unwrap_or_default();
    let mut sources = vec![(
        shared_recency,
        true,
        super::identity::SHARED_BUCKET_ID.to_string(),
        target_cookies
            .iter()
            .filter(|cookie| cookie.partitioned() != Some(true))
            .cloned()
            .collect(),
    )];
    let mut skipped_partitioned = 0;
    for bucket in catalog
        .iter()
        .filter(|bucket| bucket.id != super::identity::SHARED_BUCKET_ID && bucket.profile_present)
    {
        let mut cookies = cookies_for_known_identity_bucket(app, tabs, &bucket.id, true)?;
        skipped_partitioned += cookies
            .iter()
            .filter(|cookie| cookie.partitioned() == Some(true))
            .count();
        cookies.retain(|cookie| cookie.partitioned() != Some(true));
        sources.push((bucket.merge_recency, false, bucket.id.clone(), cookies));
    }
    let (winners, conflicts) = cookie_winners(sources);

    let originals: BTreeMap<CookieKey, Cookie<'static>> = target_cookies
        .into_iter()
        .filter(|cookie| cookie.partitioned() != Some(true))
        .filter_map(|cookie| cookie_key(&cookie).map(|key| (key, cookie)))
        .collect();
    let mut rollback = Vec::new();
    let mut merged = 0;
    for (key, (source_bucket, winner)) in winners {
        let previous = originals.get(&key).cloned();
        if previous
            .as_ref()
            .is_some_and(|cookie| cookies_match(cookie, &winner))
        {
            continue;
        }
        rollback.push((previous, winner.clone()));
        if let Err(_error) = target.webview.set_cookie(winner.clone()) {
            let restored = restore_cookie_writes(&target, rollback);
            return Err(unavailable(if restored {
                "a cookie could not be merged into the Shared browser"
            } else {
                "a Shared browser cookie write and its rollback did not finish"
            }));
        }
        if source_bucket != super::identity::SHARED_BUCKET_ID {
            merged += 1;
        }
    }

    Ok(SharedCookieMerge {
        target,
        rollback,
        summary: CookieMergeSummary {
            merged,
            conflicts,
            skipped_partitioned,
        },
    })
}

#[tauri::command]
pub async fn browser_set_identity_scope(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    scope: super::BrowserIdentityScope,
) -> CommandResult<BrowserIdentitySwitchResult> {
    let _change = state
        .identity_change
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let app_state = app
        .try_state::<crate::state::AppState>()
        .ok_or_else(|| unavailable("the app is not ready"))?;
    let configured = super::identity::configured_scope(&app_state.store);
    if configured == scope {
        return Ok(BrowserIdentitySwitchResult {
            active_scope: state.identity_scope(),
            configured_scope: scope,
            restart_required: state.identity_scope() != scope,
            merged_cookies: 0,
            cookie_conflicts: 0,
            skipped_partitioned_cookies: 0,
            merged_logins: 0,
            login_conflicts: 0,
            sources_retained: true,
        });
    }

    if scope == super::BrowserIdentityScope::Task {
        app_state
            .store
            .set_setting(
                super::IDENTITY_SCOPE_SETTING,
                serde_json::json!(scope.as_str()),
            )
            .map_err(|error| unavailable(error.to_string()))?;
        return Ok(BrowserIdentitySwitchResult {
            active_scope: state.identity_scope(),
            configured_scope: scope,
            restart_required: state.identity_scope() != scope,
            merged_cookies: 0,
            cookie_conflicts: 0,
            skipped_partitioned_cookies: 0,
            merged_logins: 0,
            login_conflicts: 0,
            sources_retained: true,
        });
    }

    let cookie_merge = merge_cookies_into_shared(&app, &state)?;
    let cookie_summary = cookie_merge.summary;
    // Hold saved-login mutations through commit or rollback. Without this, a
    // simultaneous save could be overwritten if the scope setting failed.
    let vault_mutation = super::vault::lock_mutations();
    let login_merge = match super::vault::merge_into_shared(&app, &vault_mutation) {
        Ok(merge) => merge,
        Err(error) => {
            if cookie_merge.rollback().is_err() {
                return Err(unavailable(
                    "the Shared login merge failed and the cookie rollback needs attention",
                ));
            }
            return Err(error);
        }
    };
    let login_summary = login_merge.summary;
    if let Err(error) = app_state.store.set_setting(
        super::IDENTITY_SCOPE_SETTING,
        serde_json::json!(scope.as_str()),
    ) {
        let login_rollback = login_merge.rollback(&app, &vault_mutation);
        let cookie_rollback = cookie_merge.rollback();
        return Err(unavailable(
            if login_rollback.is_ok() && cookie_rollback.is_ok() {
                format!("the browser scope was not changed: {error}")
            } else {
                "the browser scope was not changed and a Shared-data rollback needs attention"
                    .to_string()
            },
        ));
    }

    Ok(BrowserIdentitySwitchResult {
        active_scope: state.identity_scope(),
        configured_scope: scope,
        restart_required: state.identity_scope() != scope,
        merged_cookies: cookie_summary.merged,
        cookie_conflicts: cookie_summary.conflicts,
        skipped_partitioned_cookies: cookie_summary.skipped_partitioned,
        merged_logins: login_summary.merged,
        login_conflicts: login_summary.conflicts,
        sources_retained: true,
    })
}

fn sites_from_cookies(cookies: Vec<Cookie<'static>>, persistent: bool) -> Vec<BrowserSite> {
    let mut by_origin: HashMap<String, usize> = HashMap::new();
    for cookie in cookies {
        let domain = cookie
            .domain()
            .map(|domain| domain.trim_start_matches('.').to_string())
            .unwrap_or_default();
        if !domain.is_empty() {
            *by_origin.entry(domain).or_default() += 1;
        }
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
    sites
}

#[tauri::command]
pub async fn browser_bucket_sites(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    bucket_id: String,
) -> CommandResult<Vec<BrowserSite>> {
    let persistent = setting_enabled(&app, KEEP_SIGNED_IN_SETTING);
    let cookies = cookies_for_identity_bucket(&app, &state, &bucket_id, persistent)?;
    let mut sites = sites_from_cookies(cookies, persistent);
    // Turning persistence off does not hide data retained from an earlier
    // session; Settings must still show and be able to clear it.
    if !persistent {
        sites.extend(sites_from_cookies(
            cookies_for_identity_bucket(&app, &state, &bucket_id, true)?,
            true,
        ));
    }
    sites.sort_by(|left, right| {
        left.origin
            .cmp(&right.origin)
            .then_with(|| right.persistent.cmp(&left.persistent))
    });
    Ok(sites)
}

#[tauri::command]
pub async fn browser_clear_bucket(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserTabs>>,
    bucket_id: String,
) -> CommandResult<()> {
    if !bucket_allowed(&app, &state, &bucket_id) {
        return Err(unavailable("that browser identity does not exist"));
    }
    let persistent = setting_enabled(&app, KEEP_SIGNED_IN_SETTING);
    if let Some(profile) = profile_webview(&app, &state, &bucket_id, persistent, false)? {
        profile
            .webview
            .clear_all_browsing_data()
            .map_err(|error| unavailable(error.to_string()))?;
    }
    if !persistent && let Some(profile) = profile_webview(&app, &state, &bucket_id, true, false)? {
        profile
            .webview
            .clear_all_browsing_data()
            .map_err(|error| unavailable(error.to_string()))?;
    }
    Ok(())
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
const MAX_COOKIE_FACTS: usize = 256;
const MAX_COOKIE_FIELD_CHARS: usize = 1_024;

fn bounded_cookie_field(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_COOKIE_FIELD_CHARS)
        .collect()
}

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
/// This is deliberately metadata-only. Arbitrary page evaluation is not an
/// agent capability, so neither HttpOnly nor script-readable values cross the
/// broker boundary.
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
            let raw_name = cookie.name();
            let name = bounded_cookie_field(raw_name);
            let http_only = cookie.http_only().unwrap_or(false);
            Some(CookieFact {
                domain: bounded_cookie_field(&domain),
                session_like: session_like(raw_name, http_only),
                name,
                path: bounded_cookie_field(cookie.path().unwrap_or("/")),
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
    facts.truncate(MAX_COOKIE_FACTS);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn session_cookie(value: &str) -> Cookie<'static> {
        Cookie::build(("sid".to_string(), value.to_string()))
            .domain("example.com")
            .path("/")
            .secure(true)
            .http_only(true)
            .build()
    }

    #[test]
    fn newest_identity_wins_cookie_conflicts() {
        let (winners, conflicts) = cookie_winners(vec![
            (
                8,
                true,
                super::super::identity::SHARED_BUCKET_ID.into(),
                vec![session_cookie("shared-old")],
            ),
            (
                12,
                false,
                "task:new".into(),
                vec![session_cookie("task-new")],
            ),
        ]);
        let (bucket, cookie) = winners.values().next().expect("one cookie");
        assert_eq!(bucket, "task:new");
        assert_eq!(cookie.value(), "task-new");
        assert_eq!(conflicts, 1);
    }

    #[test]
    fn shared_is_stable_when_recency_ties() {
        let at = 12;
        let (winners, conflicts) = cookie_winners(vec![
            (
                at,
                true,
                super::super::identity::SHARED_BUCKET_ID.into(),
                vec![session_cookie("shared")],
            ),
            (at, false, "task:one".into(), vec![session_cookie("task")]),
        ]);
        let (bucket, cookie) = winners.values().next().expect("one cookie");
        assert_eq!(bucket, super::super::identity::SHARED_BUCKET_ID);
        assert_eq!(cookie.value(), "shared");
        assert_eq!(conflicts, 1);
    }

    #[test]
    fn identical_cookie_values_are_not_reported_as_conflicts() {
        let cookie = session_cookie("same");
        let (_, conflicts) = cookie_winners(vec![
            (1, false, "task:one".into(), vec![cookie.clone()]),
            (2, false, "task:two".into(), vec![cookie]),
        ]);
        assert_eq!(conflicts, 0);
    }

    #[test]
    fn partitioned_cookies_are_never_selected_for_cross_identity_merge() {
        let partitioned = Cookie::build(("sid".to_string(), "secret".to_string()))
            .domain("example.com")
            .path("/")
            .secure(true)
            .partitioned(true)
            .build();
        let (winners, conflicts) =
            cookie_winners(vec![(1, false, "task:one".into(), vec![partitioned])]);

        assert!(winners.is_empty());
        assert_eq!(conflicts, 0);
    }

    #[test]
    fn cookie_metadata_fields_are_bounded_and_strip_controls() {
        let value = format!("name\r\n{}", "x".repeat(MAX_COOKIE_FIELD_CHARS + 10));
        let bounded = bounded_cookie_field(&value);

        assert!(!bounded.contains('\r') && !bounded.contains('\n'));
        assert_eq!(bounded.chars().count(), MAX_COOKIE_FIELD_CHARS);
    }
}
