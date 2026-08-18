//! Browser identity boundaries: which cookie profile and saved-login bucket a
//! tab belongs to. The renderer may select a declared scope, never a path.

use std::{
    fs, io,
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

use integrator_core::{TaskId, TaskKind};
use serde::{Deserialize, Serialize};
use session_store::LocalStore;
use sha2::{Digest, Sha256};

pub const IDENTITY_SCOPE_SETTING: &str = "settings.browser.identityScope";
pub const CHAT_BUCKET_ID: &str = "chat-main";
pub const SHARED_BUCKET_ID: &str = "shared";

const PROFILE_ROOT: &str = "browser-profile";
const PROFILE_LAYOUT: &str = "profiles-v2";
const EPHEMERAL_LAYOUT: &str = "ephemeral-v2";
static EPHEMERAL_SESSION_ID: OnceLock<String> = OnceLock::new();

fn ephemeral_session_id() -> &'static str {
    EPHEMERAL_SESSION_ID.get_or_init(|| format!("{}-{}", std::process::id(), uuid::Uuid::new_v4()))
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowserIdentityScope {
    #[default]
    Task,
    Shared,
}

impl BrowserIdentityScope {
    pub fn from_setting(value: Option<&str>) -> Self {
        match value {
            Some("shared") => Self::Shared,
            _ => Self::Task,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Task => "task",
            Self::Shared => "shared",
        }
    }
}

pub fn configured_scope(store: &LocalStore) -> BrowserIdentityScope {
    BrowserIdentityScope::from_setting(
        store
            .get_setting(IDENTITY_SCOPE_SETTING)
            .ok()
            .flatten()
            .and_then(|setting| setting.value.as_str().map(str::to_owned))
            .as_deref(),
    )
}

pub fn task_bucket_id(task_id: TaskId) -> String {
    format!("task:{task_id}")
}

fn opaque_task_bucket_id(task_id: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(task_id.as_bytes()));
    format!("task:opaque-{}", &digest[..32])
}

/// Resolves a task to a browser identity. Standalone chats intentionally share
/// one explicit bucket; an unknown task is isolated under a one-way identifier
/// instead of falling into Chat/Main.
pub fn bucket_for_task(store: &LocalStore, scope: BrowserIdentityScope, task_id: &str) -> String {
    if scope == BrowserIdentityScope::Shared {
        return SHARED_BUCKET_ID.to_string();
    }
    let Ok(id) = task_id.parse::<TaskId>() else {
        return opaque_task_bucket_id(task_id);
    };
    match store.get_task(id).ok().map(|task| task.kind) {
        Some(TaskKind::Chat) => CHAT_BUCKET_ID.to_string(),
        _ => task_bucket_id(id),
    }
}

/// Converts an opaque bucket id to a fixed single path component. Any renderer
/// input that is not one of these declared forms is refused before I/O.
pub fn profile_segment(bucket_id: &str) -> Option<String> {
    match bucket_id {
        CHAT_BUCKET_ID => Some(CHAT_BUCKET_ID.to_string()),
        SHARED_BUCKET_ID => Some(SHARED_BUCKET_ID.to_string()),
        _ => {
            let suffix = bucket_id.strip_prefix("task:")?;
            if suffix.is_empty()
                || suffix.len() > 80
                || !suffix
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
            {
                return None;
            }
            Some(format!("task-{suffix}"))
        }
    }
}

pub fn bucket_id_from_profile_segment(segment: &str) -> Option<String> {
    match segment {
        CHAT_BUCKET_ID => Some(CHAT_BUCKET_ID.to_string()),
        SHARED_BUCKET_ID => Some(SHARED_BUCKET_ID.to_string()),
        _ => {
            let suffix = segment.strip_prefix("task-")?;
            profile_segment(&format!("task:{suffix}"))?;
            Some(format!("task:{suffix}"))
        }
    }
}

fn checked_descendant_directory(
    data_directory: &Path,
    relative: &Path,
    create: bool,
) -> io::Result<Option<PathBuf>> {
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "browser profile path is not relative",
        ));
    }
    let canonical_root = fs::canonicalize(data_directory)?;
    if !canonical_root.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "application data path is not a directory",
        ));
    }
    let mut current = data_directory.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            unreachable!("relative path components were validated")
        };
        let candidate = current.join(component);
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "browser profile path contains a link or non-directory",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound && create => {
                fs::create_dir(&candidate)?;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        }
        let canonical = fs::canonicalize(&candidate)?;
        if !canonical.starts_with(&canonical_root) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "browser profile escaped application data",
            ));
        }
        current = candidate;
    }
    Ok(Some(current))
}

#[cfg(test)]
fn legacy_profile(data_directory: &Path) -> PathBuf {
    data_directory.join(PROFILE_ROOT).join("persistent")
}

#[cfg(test)]
pub fn persistent_profile_path(data_directory: &Path, bucket_id: &str) -> io::Result<PathBuf> {
    let segment = profile_segment(bucket_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "unknown browser bucket"))?;
    Ok(data_directory
        .join(PROFILE_ROOT)
        .join(PROFILE_LAYOUT)
        .join(segment))
}

pub fn profile_directory(
    data_directory: &Path,
    scope: BrowserIdentityScope,
    bucket_id: &str,
    persistent: bool,
) -> io::Result<PathBuf> {
    let segment = profile_segment(bucket_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "unknown browser bucket"))?;
    if persistent {
        let target_relative = Path::new(PROFILE_ROOT).join(PROFILE_LAYOUT).join(&segment);
        let target = checked_descendant_directory(data_directory, &target_relative, false)?;
        let legacy_owner = match scope {
            BrowserIdentityScope::Task => CHAT_BUCKET_ID,
            BrowserIdentityScope::Shared => SHARED_BUCKET_ID,
        };
        // If the startup rename was blocked, preserve access to the old profile
        // for its single intended owner rather than silently signing them out.
        if bucket_id == legacy_owner
            && target.is_none()
            && let Some(legacy) = checked_descendant_directory(
                data_directory,
                &Path::new(PROFILE_ROOT).join("persistent"),
                false,
            )?
        {
            return Ok(legacy);
        }
        return checked_descendant_directory(data_directory, &target_relative, true)?
            .ok_or_else(|| io::Error::other("browser profile was not created"));
    }
    checked_descendant_directory(
        data_directory,
        &Path::new(PROFILE_ROOT)
            .join(EPHEMERAL_LAYOUT)
            .join(ephemeral_session_id())
            .join(segment),
        true,
    )?
    .ok_or_else(|| io::Error::other("browser profile was not created"))
}

pub fn existing_profile_directory(
    data_directory: &Path,
    scope: BrowserIdentityScope,
    bucket_id: &str,
    persistent: bool,
) -> io::Result<Option<PathBuf>> {
    let segment = profile_segment(bucket_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "unknown browser bucket"))?;
    if persistent {
        let target = Path::new(PROFILE_ROOT).join(PROFILE_LAYOUT).join(&segment);
        if let Some(target) = checked_descendant_directory(data_directory, &target, false)? {
            return Ok(Some(target));
        }
        let legacy_owner = match scope {
            BrowserIdentityScope::Task => CHAT_BUCKET_ID,
            BrowserIdentityScope::Shared => SHARED_BUCKET_ID,
        };
        if bucket_id == legacy_owner {
            return checked_descendant_directory(
                data_directory,
                &Path::new(PROFILE_ROOT).join("persistent"),
                false,
            );
        }
        return Ok(None);
    }
    checked_descendant_directory(
        data_directory,
        &Path::new(PROFILE_ROOT)
            .join(EPHEMERAL_LAYOUT)
            .join(ephemeral_session_id())
            .join(segment),
        false,
    )
}

/// Ephemeral profiles are per launch and should not survive a clean restart.
/// The app is single-instance, so startup may remove the exact ephemeral root
/// before any browser webview exists. A symlink is refused rather than followed.
pub fn prune_ephemeral_profiles(data_directory: &Path) -> io::Result<()> {
    if let Some(root) = checked_descendant_directory(
        data_directory,
        &Path::new(PROFILE_ROOT).join(EPHEMERAL_LAYOUT),
        false,
    )? {
        fs::remove_dir_all(root)?;
    }
    Ok(())
}

pub fn persistent_profiles_root(data_directory: &Path) -> io::Result<Option<PathBuf>> {
    checked_descendant_directory(
        data_directory,
        &Path::new(PROFILE_ROOT).join(PROFILE_LAYOUT),
        false,
    )
}

/// One-time adoption of the old installation-wide profile. Task-scoped is the
/// new default, so legacy browser state belongs to Chat/Main rather than being
/// copied into every code task.
pub fn prepare_profile_layout(
    data_directory: &Path,
    scope: BrowserIdentityScope,
) -> io::Result<()> {
    let Some(legacy) = checked_descendant_directory(
        data_directory,
        &Path::new(PROFILE_ROOT).join("persistent"),
        false,
    )?
    else {
        return Ok(());
    };
    let owner = match scope {
        BrowserIdentityScope::Task => CHAT_BUCKET_ID,
        BrowserIdentityScope::Shared => SHARED_BUCKET_ID,
    };
    let segment = profile_segment(owner).expect("built-in browser bucket is valid");
    let parent = checked_descendant_directory(
        data_directory,
        &Path::new(PROFILE_ROOT).join(PROFILE_LAYOUT),
        true,
    )?
    .ok_or_else(|| io::Error::other("browser profile parent was not created"))?;
    let target = parent.join(&segment);
    if checked_descendant_directory(
        data_directory,
        &Path::new(PROFILE_ROOT).join(PROFILE_LAYOUT).join(segment),
        false,
    )?
    .is_some()
    {
        return Ok(());
    }
    fs::rename(legacy, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_segments_refuse_paths_and_accept_declared_buckets() {
        assert_eq!(
            profile_segment(CHAT_BUCKET_ID).as_deref(),
            Some("chat-main")
        );
        assert_eq!(profile_segment(SHARED_BUCKET_ID).as_deref(), Some("shared"));
        assert_eq!(
            profile_segment("task:019cbe6a-5fd4-7ca1-9dd4-b51fe78b50b5").as_deref(),
            Some("task-019cbe6a-5fd4-7ca1-9dd4-b51fe78b50b5")
        );
        assert!(profile_segment("task:../shared").is_none());
        assert!(profile_segment("task:").is_none());
        assert!(profile_segment("unknown").is_none());
    }

    #[test]
    fn scope_defaults_to_task_and_only_shared_is_shared() {
        assert_eq!(
            BrowserIdentityScope::from_setting(None),
            BrowserIdentityScope::Task
        );
        assert_eq!(
            BrowserIdentityScope::from_setting(Some("nonsense")),
            BrowserIdentityScope::Task
        );
        assert_eq!(
            BrowserIdentityScope::from_setting(Some("shared")),
            BrowserIdentityScope::Shared
        );
    }

    #[test]
    fn inspecting_a_missing_profile_does_not_create_it() {
        let data = tempfile::tempdir().expect("temporary app data");
        assert_eq!(
            existing_profile_directory(
                data.path(),
                BrowserIdentityScope::Task,
                CHAT_BUCKET_ID,
                true,
            )
            .unwrap(),
            None
        );
        assert!(!data.path().join(PROFILE_ROOT).exists());
    }

    #[test]
    fn startup_prunes_only_the_ephemeral_profile_root() {
        let data = tempfile::tempdir().expect("temporary app data");
        let ephemeral = data.path().join(PROFILE_ROOT).join(EPHEMERAL_LAYOUT);
        let persistent = data.path().join(PROFILE_ROOT).join(PROFILE_LAYOUT);
        fs::create_dir_all(ephemeral.join("old-launch")).unwrap();
        fs::create_dir_all(&persistent).unwrap();
        fs::write(persistent.join("keep"), b"profile").unwrap();

        prune_ephemeral_profiles(data.path()).unwrap();

        assert!(!ephemeral.exists());
        assert!(persistent.join("keep").is_file());
    }

    #[test]
    fn profile_creation_refuses_a_non_directory_parent() {
        let data = tempfile::tempdir().expect("temporary app data");
        fs::write(data.path().join(PROFILE_ROOT), b"not a directory").unwrap();

        assert!(
            profile_directory(
                data.path(),
                BrowserIdentityScope::Task,
                CHAT_BUCKET_ID,
                true,
            )
            .is_err()
        );
    }

    #[test]
    fn legacy_profile_moves_to_the_configured_single_owner() {
        for (scope, owner) in [
            (BrowserIdentityScope::Task, CHAT_BUCKET_ID),
            (BrowserIdentityScope::Shared, SHARED_BUCKET_ID),
        ] {
            let data = tempfile::tempdir().expect("temporary app data");
            let legacy = legacy_profile(data.path());
            fs::create_dir_all(&legacy).unwrap();
            fs::write(legacy.join("Cookies"), b"legacy").unwrap();

            prepare_profile_layout(data.path(), scope).unwrap();

            let target = persistent_profile_path(data.path(), owner).unwrap();
            assert_eq!(fs::read(target.join("Cookies")).unwrap(), b"legacy");
            assert!(!legacy.exists());
        }
    }
}
