use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Component, Path, PathBuf},
};

use integrator_core::{IntegratorError, ProjectId, Result, TrustedProject};

use super::{GitService, RepositoryIdentity};

const MAX_AUTHORIZED_REPOSITORIES: usize = 128;
const MAX_GIT_POINTER_BYTES: u64 = 4 * 1024;

/// Process-local cache of repository identities that have already passed the
/// trusted-project/worktree authorization check. The cache intentionally
/// retains only structural identity: callers that expose branch or HEAD must
/// refresh those fields through [`GitService::refresh_identity`].
///
/// Entries are keyed by the exact canonical directory selected by the caller,
/// bounded to prevent a trusted repository with many nested directories from
/// growing native state without limit, and revalidated against both the
/// current trusted-project rows and the repository's on-disk Git pointers on
/// every hit.
#[derive(Debug, Default)]
pub struct AuthorizedRepositoryCache {
    entries: HashMap<PathBuf, CachedAuthorizedRepository>,
    order: VecDeque<PathBuf>,
}

#[derive(Clone, Debug)]
struct CachedAuthorizedRepository {
    identity: RepositoryIdentity,
    project_id: ProjectId,
    project_root: PathBuf,
    project_git_root: PathBuf,
    project_common_directory: PathBuf,
}

#[derive(Debug)]
struct AuthorizedRepositoryMatch {
    identity: RepositoryIdentity,
    project_id: ProjectId,
    project_root: PathBuf,
    project_git_root: PathBuf,
    project_common_directory: PathBuf,
}

impl AuthorizedRepositoryCache {
    #[cfg(test)]
    pub(super) fn cached_entry_count(&self) -> usize {
        self.entries.len()
    }

    /// Remove all cached capabilities. Trust-changing commands call this while
    /// holding the cache mutex so stale entries cannot race back in afterward.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }

    /// Authorize an exact candidate directory, using a previously verified
    /// canonical identity when the trusted-project row and Git layout still
    /// match. Cache misses retain the existing full Git authorization path.
    pub fn authorize(
        &mut self,
        git: &GitService,
        projects: &[TrustedProject],
        candidate: &Path,
    ) -> Result<RepositoryIdentity> {
        let selected = canonical_directory(candidate)?;
        if let Some(entry) = self.entries.get(&selected).cloned() {
            let trust_is_current = projects.iter().any(|project| {
                project.id == entry.project_id
                    && project.repository_root == entry.project_root
                    && project.git_repository_root.as_ref() == Some(&entry.project_git_root)
                    && project.git_common_directory.as_ref()
                        == Some(&entry.project_common_directory)
            });
            if trust_is_current && cached_repository_layout_matches(&entry.identity) {
                self.touch(&selected);
                return Ok(structural_identity(&entry.identity));
            }
            self.remove(&selected);
        }

        let authorized = authorize_repository_match(git, projects, &selected)?;
        let cached = CachedAuthorizedRepository {
            identity: structural_identity(&authorized.identity),
            project_id: authorized.project_id,
            project_root: authorized.project_root,
            project_git_root: authorized.project_git_root,
            project_common_directory: authorized.project_common_directory,
        };
        self.insert(selected.clone(), cached.clone());
        if selected != cached.identity.root {
            self.insert(cached.identity.root.clone(), cached.clone());
        }
        Ok(cached.identity)
    }

    fn insert(&mut self, key: PathBuf, entry: CachedAuthorizedRepository) {
        self.remove(&key);
        self.entries.insert(key.clone(), entry);
        self.order.push_back(key);
        while self.entries.len() > MAX_AUTHORIZED_REPOSITORIES {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
    }

    fn touch(&mut self, key: &Path) {
        if let Some(index) = self.order.iter().position(|candidate| candidate == key) {
            self.order.remove(index);
        }
        self.order.push_back(key.to_path_buf());
    }

    fn remove(&mut self, key: &Path) {
        self.entries.remove(key);
        if let Some(index) = self.order.iter().position(|candidate| candidate == key) {
            self.order.remove(index);
        }
    }
}

pub fn authorize_repository(
    git: &GitService,
    projects: &[TrustedProject],
    candidate: &Path,
) -> Result<RepositoryIdentity> {
    authorize_repository_match(git, projects, candidate).map(|authorized| authorized.identity)
}

fn authorize_repository_match(
    git: &GitService,
    projects: &[TrustedProject],
    candidate: &Path,
) -> Result<AuthorizedRepositoryMatch> {
    let identity = git.repository(candidate)?;
    for project in projects {
        let project_root = match canonical_directory(&project.repository_root) {
            Ok(path) => path,
            Err(_) => continue,
        };
        let Some(git_root) = project.git_repository_root.as_deref() else {
            continue;
        };
        let git_root = match canonical_directory(git_root) {
            Ok(path) => path,
            Err(_) => continue,
        };
        let Some(common_directory) = project.git_common_directory.as_deref() else {
            continue;
        };
        let common_directory = match canonical_directory(common_directory) {
            Ok(path) => path,
            Err(_) => continue,
        };
        if common_directory != identity.common_directory {
            continue;
        }
        if git_root == identity.root {
            return Ok(AuthorizedRepositoryMatch {
                identity,
                project_id: project.id,
                project_root,
                project_git_root: git_root,
                project_common_directory: common_directory,
            });
        }
        if git
            .worktrees(&git_root)?
            .iter()
            .any(|worktree| worktree.path == identity.root)
        {
            return Ok(AuthorizedRepositoryMatch {
                identity,
                project_id: project.id,
                project_root,
                project_git_root: git_root,
                project_common_directory: common_directory,
            });
        }
    }
    Err(IntegratorError::Unauthorized(
        "repository is not registered as a trusted project".into(),
    ))
}

fn structural_identity(identity: &RepositoryIdentity) -> RepositoryIdentity {
    RepositoryIdentity {
        root: identity.root.clone(),
        common_directory: identity.common_directory.clone(),
        branch: None,
        head: None,
    }
}

/// Validate the cheap, structural facts behind a cached authorization without
/// invoking Git. Normal repositories point `.git` directly at the cached
/// common directory. Linked worktrees and submodules use a small `gitdir:`
/// pointer; their optional `commondir` pointer resolves the shared directory.
fn cached_repository_layout_matches(identity: &RepositoryIdentity) -> bool {
    let Ok(root) = canonical_directory(&identity.root) else {
        return false;
    };
    if root != identity.root {
        return false;
    }
    let Ok(expected_common) = canonical_directory(&identity.common_directory) else {
        return false;
    };
    if expected_common != identity.common_directory {
        return false;
    }

    let marker = root.join(".git");
    if marker.is_dir() {
        return canonical_directory(&marker).is_ok_and(|directory| directory == expected_common);
    }
    let Some(git_directory) = read_git_pointer(&marker, "gitdir:", &root) else {
        return false;
    };
    let common_marker = git_directory.join("commondir");
    let actual_common = if common_marker.is_file() {
        let Some(common) = read_path_pointer(&common_marker, &git_directory) else {
            return false;
        };
        common
    } else {
        git_directory
    };
    actual_common == expected_common
}

fn read_git_pointer(marker: &Path, prefix: &str, base: &Path) -> Option<PathBuf> {
    let contents = read_small_text_file(marker)?;
    let target = contents.lines().next()?.trim().strip_prefix(prefix)?.trim();
    (!target.is_empty())
        .then(|| absolute_from(base, Path::new(target)))
        .and_then(|path| canonical_directory(&path).ok())
}

fn read_path_pointer(marker: &Path, base: &Path) -> Option<PathBuf> {
    let contents = read_small_text_file(marker)?;
    let target = contents.lines().next()?.trim();
    (!target.is_empty())
        .then(|| absolute_from(base, Path::new(target)))
        .and_then(|path| canonical_directory(&path).ok())
}

fn read_small_text_file(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_GIT_POINTER_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

pub(super) fn canonical_directory(path: &Path) -> Result<PathBuf> {
    if !path.is_dir() {
        return Err(IntegratorError::InvalidInput(
            "path must be an existing directory".into(),
        ));
    }
    dunce::canonicalize(path).map_err(IntegratorError::Io)
}

pub(super) fn validate_new_destination(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path.exists()
        || path.parent().is_none_or(|parent| !parent.is_dir())
        || path.file_name().is_none_or(|name| name.is_empty())
    {
        return Err(IntegratorError::InvalidInput(
            "clone destination must be a new absolute path inside an existing folder".into(),
        ));
    }
    Ok(())
}

pub(super) fn validate_remote_name(name: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 240
        || name.starts_with('-')
        || name.chars().any(char::is_whitespace)
        || name.contains(['~', '^', ':', '?', '*', '[', '\\'])
        || name.contains("..")
    {
        return Err(IntegratorError::InvalidInput(
            "invalid Git remote name".into(),
        ));
    }
    Ok(())
}

pub(super) fn validate_remote_url(url: &str) -> Result<()> {
    let url = url.trim();
    if url.is_empty()
        || url.len() > 4096
        || url.starts_with('-')
        || url.contains(['\0', '\n', '\r'])
        || url.contains('?')
        || url.contains('#')
    {
        return Err(IntegratorError::InvalidInput(
            "remote URL is invalid or contains unsupported credential parameters".into(),
        ));
    }
    if Path::new(url).is_absolute() {
        return Ok(());
    }
    if let Ok(parsed) = url::Url::parse(url) {
        if !matches!(parsed.scheme(), "http" | "https" | "ssh" | "git" | "file")
            || (parsed.scheme() != "file" && parsed.host_str().is_none())
            || parsed.password().is_some()
            || (matches!(parsed.scheme(), "http" | "https") && !parsed.username().is_empty())
        {
            return Err(IntegratorError::InvalidInput(
                "remote URL uses an unsupported transport or embedded credentials".into(),
            ));
        }
        return Ok(());
    }
    let scp_style = url.split_once(':').is_some_and(|(authority, path)| {
        let Some((user, host)) = authority.split_once('@') else {
            return false;
        };
        !user.is_empty()
            && !host.is_empty()
            && !path.is_empty()
            && user
                .chars()
                .chain(host.chars())
                .all(|character| character.is_ascii_alphanumeric() || "-._".contains(character))
    });
    if !scp_style {
        return Err(IntegratorError::InvalidInput(
            "remote URL must use HTTPS, SSH, Git, file, or an absolute local path".into(),
        ));
    }
    Ok(())
}

pub(super) fn validate_relative_path(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(IntegratorError::InvalidInput(
            "Git paths must be relative and remain inside the repository".into(),
        ));
    }
    Ok(())
}

pub(super) fn validate_revision(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 240
        || value.starts_with('-')
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '/' | '_' | '-' | '.' | '~' | '^')
        })
    {
        return Err(IntegratorError::InvalidInput(
            "invalid Git base reference".into(),
        ));
    }
    Ok(())
}

pub(super) fn absolute_from(root: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_owned()
    } else {
        root.join(path)
    }
}
