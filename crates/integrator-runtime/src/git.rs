use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Component, Path, PathBuf},
    str,
    time::Duration,
};

use integrator_core::{IntegratorError, ProjectId, Result, TrustedProject};
use serde::{Deserialize, Serialize};

use crate::safe_process::{
    ProcessOutput, ProcessRunOutcome, redact_text, run_bounded_with_limits,
    run_bounded_with_outcome,
};

const MAX_GIT_OUTPUT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_AUTHORIZED_REPOSITORIES: usize = 128;
const MAX_GIT_POINTER_BYTES: u64 = 4 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_COMMIT_TIMEOUT: Duration = Duration::from_secs(120);
const GIT_PUSH_TIMEOUT: Duration = Duration::from_secs(120);
const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryIdentity {
    pub root: PathBuf,
    pub common_directory: PathBuf,
    pub branch: Option<String>,
    pub head: Option<String>,
}

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

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub locked: bool,
    pub prunable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktree {
    pub destination: PathBuf,
    pub branch: String,
    pub base_ref: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub index_status: char,
    pub worktree_status: char,
    pub path: PathBuf,
    /// Added/removed line counts for the row's diff scope. `None` when the
    /// change is binary or the count is unavailable (e.g. plain `status()`).
    #[serde(default)]
    pub additions: Option<u64>,
    #[serde(default)]
    pub deletions: Option<u64>,
    /// Scope-specific counts preserve both sides of a partially staged file.
    #[serde(default)]
    pub staged_additions: Option<u64>,
    #[serde(default)]
    pub staged_deletions: Option<u64>,
    #[serde(default)]
    pub unstaged_additions: Option<u64>,
    #[serde(default)]
    pub unstaged_deletions: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffScope {
    Unstaged,
    Staged,
    Untracked,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub scope: DiffScope,
    pub patch: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub commit: String,
    pub summary: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCommit {
    pub id: String,
    pub subject: String,
    pub relative_time: String,
    pub current: bool,
    /// Abbreviated parent hashes, in `%p` order. Two or more mean a merge.
    #[serde(default)]
    pub parents: Vec<String>,
    /// Branch/tag decorations (`%D`), with `HEAD ->` collapsed to the name.
    #[serde(default)]
    pub refs: Vec<String>,
    /// True when the commit is not reachable from the branch's upstream.
    #[serde(default)]
    pub unpushed: bool,
}

/// Read-only data needed to render the compact Git rail. Building this value
/// never stages, commits, pushes, or otherwise mutates repository state.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOverview {
    pub identity: RepositoryIdentity,
    pub files: Vec<FileStatus>,
    pub history: Vec<HistoryCommit>,
    pub remotes: Vec<GitRemote>,
    pub push_preview: Option<PushPreview>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullMode {
    FastForwardOnly,
    Rebase,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushPreview {
    pub head: String,
    pub branch: String,
    pub remote: Option<String>,
    pub sanitized_remote_url: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub refspec: String,
}

/// Whether a push may rewrite remote history, and how carefully.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PushForce {
    /// Never rewrite. The default, and the only mode that cannot destroy a
    /// commit that is not already in the local history.
    #[default]
    Off,
    /// Rewrite only while the remote is still where the last fetch left it, so
    /// a commit pushed by someone else since then aborts the push instead of
    /// being overwritten. Note the lease is only as fresh as the last fetch:
    /// fetching immediately before a forced push re-arms it against work the
    /// user has still never seen.
    Lease,
    /// Rewrite unconditionally, discarding whatever the remote holds.
    Always,
}

impl PushForce {
    fn flag(self) -> Option<&'static str> {
        match self {
            Self::Off => None,
            Self::Lease => Some("--force-with-lease"),
            Self::Always => Some("--force"),
        }
    }
}

/// Exact repository state presented to the user before a push. The native
/// service recomputes every `expected_*` field immediately before starting Git
/// and never uses these renderer-owned strings as process arguments.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushConfirmation {
    pub expected_head: String,
    pub expected_branch: String,
    pub expected_remote: String,
    pub expected_remote_url: Option<String>,
    pub expected_upstream: String,
    pub expected_refspec: String,
    /// Intent rather than state: the force mode the user confirmed. Unlike the
    /// `expected_*` fields there is no repository value to recompute it
    /// against, so it travels inside the confirmed payload rather than beside
    /// it — a force push is then something the user agreed to, not a flag a
    /// caller can add after the preview they saw. Absent means `Off`.
    #[serde(default)]
    pub force: PushForce,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PushOutcome {
    Pushed,
    UpToDate,
    OutcomeUncertain,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub outcome: PushOutcome,
    pub head: String,
    pub branch: String,
    pub remote: String,
    pub refspec: String,
    pub summary: String,
}

#[derive(Clone, Debug)]
pub struct GitService {
    executable: PathBuf,
}

#[derive(Default)]
struct PorcelainStatus {
    branch: Option<String>,
    head: Option<String>,
    upstream: Option<String>,
    ahead: u64,
    behind: u64,
    files: Vec<FileStatus>,
}

impl GitService {
    pub fn discover() -> Result<Self> {
        let executable = which::which("git")
            .map_err(|_| IntegratorError::Unavailable("git is not installed".into()))?;
        Ok(Self { executable })
    }

    pub fn repository(&self, path: &Path) -> Result<RepositoryIdentity> {
        let selected = canonical_directory(path)?;
        let root = self.required(&selected, &["rev-parse", "--show-toplevel"])?;
        let root = canonical_directory(Path::new(root.trim()))?;
        let common = self.required(&root, &["rev-parse", "--git-common-dir"])?;
        let common = canonical_directory(&absolute_from(&root, Path::new(common.trim())))?;
        let branch = self.optional(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
        let head = self.optional(&root, &["rev-parse", "--verify", "HEAD"])?;
        Ok(RepositoryIdentity {
            root,
            common_directory: common,
            branch: clean_optional(branch),
            head: clean_optional(head),
        })
    }

    /// Detect Git without treating an ordinary folder as an exceptional
    /// operation. A visible `.git` marker that Git cannot read remains an
    /// error so corruption or trust failures are never mistaken for a folder
    /// that is safe to initialize.
    pub fn repository_if_present(&self, path: &Path) -> Result<Option<RepositoryIdentity>> {
        let selected = canonical_directory(path)?;
        if self
            .optional(&selected, &["rev-parse", "--is-inside-work-tree"])?
            .is_some()
        {
            return self.repository(&selected).map(Some);
        }
        if selected
            .ancestors()
            .any(|ancestor| ancestor.join(".git").exists())
        {
            return self.repository(&selected).map(Some);
        }
        Ok(None)
    }

    /// Refresh only volatile repository identity fields after structural
    /// authorization. Porcelain v2 supplies branch and HEAD together in one
    /// read-only Git invocation, including unborn and detached states.
    pub fn refresh_identity(&self, authorized: &RepositoryIdentity) -> Result<RepositoryIdentity> {
        let status = self.read_status(&authorized.root, false)?;
        Ok(RepositoryIdentity {
            root: authorized.root.clone(),
            common_directory: authorized.common_directory.clone(),
            branch: status.branch,
            head: status.head,
        })
    }

    /// Load repository identity, branch/upstream divergence, file status, and
    /// compact history with a bounded set of Git subprocesses. This is the
    /// read-only counterpart to the deliberately separate stage/commit/push
    /// methods below. Callers pass the identity returned by repository
    /// authorization so this read cannot silently pivot to another path.
    pub fn overview(&self, authorized: &RepositoryIdentity) -> Result<GitOverview> {
        let root = &authorized.root;
        let status = self.read_status(root, true)?;
        let identity = RepositoryIdentity {
            root: root.clone(),
            common_directory: authorized.common_directory.clone(),
            branch: status.branch.clone(),
            head: status.head.clone(),
        };
        let mut history = self
            .optional(root, &["log", "-32", &format!("--format={HISTORY_FORMAT}")])?
            .map(|output| parse_history(&output))
            .unwrap_or_default();
        self.annotate_unpushed(root, status.upstream.as_deref(), &mut history);
        let push_preview = match (status.branch.as_deref(), status.head.as_deref()) {
            (Some(branch), Some(head)) => {
                Some(self.push_preview_from_status(root, branch, head, &status)?)
            }
            _ => None,
        };
        let mut files = status.files;
        self.annotate_line_stats(root, &mut files);
        Ok(GitOverview {
            identity,
            files,
            history,
            remotes: self.remotes(root)?,
            push_preview,
        })
    }

    /// Best-effort added/removed line counts for the rail's file rows, from
    /// two bounded `git diff --numstat` calls (worktree and index) plus
    /// direct line counting for untracked files. Failures or binary changes
    /// leave the affected counts as `None` instead of failing the overview.
    fn annotate_line_stats(&self, repository: &Path, files: &mut [FileStatus]) {
        let numstat = |cached: bool| {
            let mut args = vec!["diff", "--numstat", "--no-renames", "-z"];
            if cached {
                args.push("--cached");
            }
            self.optional(repository, &args)
                .ok()
                .flatten()
                .map(|output| parse_numstat(&output))
                .unwrap_or_default()
        };
        let unstaged = numstat(false);
        let staged = numstat(true);
        for file in files {
            if file.index_status == '?' {
                if let Some(lines) = count_untracked_lines(repository, &file.path) {
                    file.additions = Some(lines);
                    file.deletions = Some(0);
                    file.unstaged_additions = Some(lines);
                    file.unstaged_deletions = Some(0);
                }
                continue;
            }
            if file.index_status != ' '
                && let Some((additions, deletions)) = staged.get(&file.path).copied()
            {
                file.staged_additions = additions;
                file.staged_deletions = deletions;
                file.additions = additions;
                file.deletions = deletions;
            }
            if file.worktree_status != ' '
                && let Some((additions, deletions)) = unstaged.get(&file.path).copied()
            {
                file.unstaged_additions = additions;
                file.unstaged_deletions = deletions;
                if file.index_status == ' ' {
                    file.additions = additions;
                    file.deletions = deletions;
                }
            }
        }
    }

    /// Initialize Git in an existing directory without touching its files.
    pub fn init(&self, directory: &Path) -> Result<RepositoryIdentity> {
        let directory = canonical_directory(directory)?;
        if self.repository_if_present(&directory)?.is_some() {
            return Err(IntegratorError::InvalidInput(
                "the selected folder is already inside a Git repository".into(),
            ));
        }
        let configured_branch = self
            .optional(&directory, &["config", "--get", "init.defaultBranch"])?
            .and_then(|value| clean_optional(Some(value)));
        if configured_branch.is_some() {
            self.required(&directory, &["init"])?;
        } else {
            self.required(&directory, &["init", "-b", "main"])?;
        }
        self.repository(&directory)
    }

    pub fn clone_repository(&self, remote: &str, destination: &Path) -> Result<RepositoryIdentity> {
        validate_remote_url(remote)?;
        validate_new_destination(destination)?;
        let parent = destination.parent().ok_or_else(|| {
            IntegratorError::InvalidInput("clone destination must have a parent folder".into())
        })?;
        let parent = canonical_directory(parent)?;
        let destination_name = destination
            .file_name()
            .ok_or_else(|| IntegratorError::InvalidInput("clone folder name is missing".into()))?
            .to_string_lossy()
            .into_owned();
        let output = self.output(
            &parent,
            &["clone", "--", remote.trim(), &destination_name],
            GIT_NETWORK_TIMEOUT,
        )?;
        if !output.success {
            return Err(git_failure(output));
        }
        if output.stdout_truncated || output.stderr_truncated {
            return Err(IntegratorError::Git(
                "clone completed with unexpectedly large output; inspect the destination".into(),
            ));
        }
        self.repository(destination)
    }

    pub fn remotes(&self, repository: &Path) -> Result<Vec<GitRemote>> {
        let names = self.optional(repository, &["remote"])?.unwrap_or_default();
        names
            .lines()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(|name| {
                validate_remote_name(name)?;
                let fetch = self.required(repository, &["remote", "get-url", name])?;
                let push = self
                    .optional(repository, &["remote", "get-url", "--push", name])?
                    .unwrap_or_else(|| fetch.clone());
                Ok(GitRemote {
                    name: name.to_owned(),
                    fetch_url: sanitize_remote_url(fetch.trim()),
                    push_url: sanitize_remote_url(push.trim()),
                })
            })
            .collect()
    }

    pub fn add_remote(&self, repository: &Path, name: &str, url: &str) -> Result<Vec<GitRemote>> {
        validate_remote_name(name)?;
        validate_remote_url(url)?;
        self.required(
            repository,
            &["remote", "add", "--", name.trim(), url.trim()],
        )?;
        self.remotes(repository)
    }

    pub fn update_remote(
        &self,
        repository: &Path,
        name: &str,
        url: &str,
    ) -> Result<Vec<GitRemote>> {
        validate_remote_name(name)?;
        validate_remote_url(url)?;
        self.required(
            repository,
            &["remote", "set-url", "--", name.trim(), url.trim()],
        )?;
        self.remotes(repository)
    }

    pub fn remove_remote(&self, repository: &Path, name: &str) -> Result<Vec<GitRemote>> {
        validate_remote_name(name)?;
        self.required(repository, &["remote", "remove", "--", name.trim()])?;
        self.remotes(repository)
    }

    pub fn fetch(&self, repository: &Path, remote: Option<&str>) -> Result<GitOverview> {
        if let Some(remote) = remote {
            validate_remote_name(remote)?;
            self.required_with_timeout(
                repository,
                &["fetch", "--prune", "--", remote.trim()],
                GIT_NETWORK_TIMEOUT,
            )?;
        } else {
            self.required_with_timeout(
                repository,
                &["fetch", "--all", "--prune"],
                GIT_NETWORK_TIMEOUT,
            )?;
        }
        let identity = self.repository(repository)?;
        self.overview(&identity)
    }

    pub fn pull(&self, repository: &Path, mode: PullMode) -> Result<GitOverview> {
        if !self.status(repository)?.is_empty() {
            return Err(IntegratorError::Git(
                "commit or stash local changes before pulling".into(),
            ));
        }
        if self.push_preview(repository)?.upstream.is_none() {
            return Err(IntegratorError::Git(
                "this branch has no upstream to pull from".into(),
            ));
        }
        let args = match mode {
            PullMode::FastForwardOnly => ["pull", "--ff-only"],
            PullMode::Rebase => ["pull", "--rebase"],
        };
        self.required_with_timeout(repository, &args, GIT_NETWORK_TIMEOUT)?;
        let identity = self.repository(repository)?;
        self.overview(&identity)
    }

    pub fn publish_branch(&self, repository: &Path, remote: &str) -> Result<PushResult> {
        validate_remote_name(remote)?;
        let remote_url = self.required(repository, &["remote", "get-url", remote])?;
        let remote_url = sanitize_remote_url(remote_url.trim());
        let head = self.required(repository, &["rev-parse", "--verify", "HEAD"])?;
        let head = head.trim().to_owned();
        let branch = self.required(repository, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
        let branch = branch.trim().to_owned();
        validate_revision(&branch)?;
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        let outcome = run_bounded_with_outcome(
            &self.executable,
            &[
                "push",
                "--porcelain",
                "--set-upstream",
                "--",
                remote,
                &refspec,
            ],
            Some(repository),
            MAX_GIT_OUTPUT_BYTES,
            GIT_PUSH_TIMEOUT,
        )?;
        match outcome {
            ProcessRunOutcome::TimedOut => Ok(PushResult {
                outcome: PushOutcome::OutcomeUncertain,
                head,
                branch,
                remote: remote.to_owned(),
                refspec,
                summary: format!(
                    "Publishing to {remote} ({remote_url}) timed out. Refresh before retrying."
                ),
            }),
            ProcessRunOutcome::Completed(output) if !output.success => Err(git_failure(output)),
            ProcessRunOutcome::Completed(output)
                if output.stdout_truncated || output.stderr_truncated =>
            {
                Ok(PushResult {
                    outcome: PushOutcome::OutcomeUncertain,
                    head,
                    branch,
                    remote: remote.to_owned(),
                    refspec,
                    summary: "Publish returned unusually large output. Refresh before retrying."
                        .into(),
                })
            }
            ProcessRunOutcome::Completed(output) => Ok(PushResult {
                outcome: PushOutcome::Pushed,
                head,
                branch,
                remote: remote.to_owned(),
                refspec,
                summary: redact_text(&format!("{}\n{}", output.stdout, output.stderr)),
            }),
        }
    }

    pub fn worktrees(&self, repository: &Path) -> Result<Vec<WorktreeInfo>> {
        let output = self.required(repository, &["worktree", "list", "--porcelain"])?;
        Ok(parse_worktrees(&output)
            .into_iter()
            .map(|mut worktree| {
                if let Ok(path) = canonical_directory(&worktree.path) {
                    worktree.path = path;
                }
                worktree
            })
            .collect())
    }

    pub fn create_worktree(
        &self,
        repository: &Path,
        request: &CreateWorktree,
    ) -> Result<Vec<WorktreeInfo>> {
        if !request.destination.is_absolute()
            || request.destination.exists()
            || request
                .destination
                .parent()
                .is_none_or(|parent| !parent.is_dir())
        {
            return Err(IntegratorError::InvalidInput(
                "worktree destination must be a new absolute path with an existing parent".into(),
            ));
        }
        let branch = request.branch.trim();
        if branch.is_empty() || branch.len() > 240 || branch.starts_with('-') {
            return Err(IntegratorError::InvalidInput(
                "invalid worktree branch".into(),
            ));
        }
        self.required(repository, &["check-ref-format", "--branch", branch])?;
        let base = request.base_ref.as_deref().unwrap_or("HEAD");
        validate_revision(base)?;
        let destination = request.destination.to_string_lossy().into_owned();
        self.required(
            repository,
            &["worktree", "add", "-b", branch, "--", &destination, base],
        )?;
        self.worktrees(repository)
    }

    /// The subset of `paths` that Git tracks.
    ///
    /// `status --untracked-files=all` already reports untracked files, so a path
    /// missing from both that and this set is ignored rather than committed.
    /// Callers use the difference to avoid claiming an ignored file was pushed.
    pub fn tracked_paths(&self, repository: &Path, paths: &[String]) -> Result<Vec<String>> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let mut args = vec!["ls-files", "-z", "--"];
        args.extend(paths.iter().map(String::as_str));
        let output = self.required(repository, &args)?;
        Ok(output
            .split('\0')
            .filter(|entry| !entry.is_empty())
            .map(str::to_owned)
            .collect())
    }

    pub fn status(&self, repository: &Path) -> Result<Vec<FileStatus>> {
        let output = self.required(
            repository,
            &["status", "--porcelain=v1", "--untracked-files=all"],
        )?;
        Ok(output
            .lines()
            .filter_map(|line| {
                let mut characters = line.chars();
                let index_status = characters.next()?;
                let worktree_status = characters.next()?;
                let path = line.get(3..)?.split(" -> ").last()?.to_owned();
                Some(FileStatus {
                    index_status,
                    worktree_status,
                    path: PathBuf::from(path),
                    additions: None,
                    deletions: None,
                    staged_additions: None,
                    staged_deletions: None,
                    unstaged_additions: None,
                    unstaged_deletions: None,
                })
            })
            .collect())
    }

    pub fn diff(
        &self,
        repository: &Path,
        scope: DiffScope,
        path: Option<&Path>,
    ) -> Result<DiffResult> {
        if let Some(path) = path {
            validate_relative_path(path)?;
        }
        let path_string;
        let args = if scope == DiffScope::Untracked {
            let path = path.ok_or_else(|| {
                IntegratorError::InvalidInput("an untracked diff requires one file path".into())
            })?;
            let authorized_root = dunce::canonicalize(repository).map_err(IntegratorError::Io)?;
            let canonical =
                dunce::canonicalize(repository.join(path)).map_err(IntegratorError::Io)?;
            if !canonical.starts_with(&authorized_root) || !canonical.is_file() {
                return Err(IntegratorError::Unauthorized(
                    "untracked diff path is outside the authorized repository".into(),
                ));
            }
            path_string = path.to_string_lossy().into_owned();
            vec![
                "diff",
                "--no-index",
                "--no-ext-diff",
                "--no-color",
                "--unified=3",
                "--",
                "/dev/null",
                &path_string,
            ]
        } else {
            let mut args = vec!["diff", "--no-ext-diff", "--no-color", "--unified=3"];
            if scope == DiffScope::Staged {
                args.push("--cached");
            }
            if let Some(path) = path {
                args.push("--");
                path_string = path.to_string_lossy().into_owned();
                args.push(&path_string);
            }
            args
        };
        let output = self.output(repository, &args, GIT_TIMEOUT)?;
        // `git diff --no-index` uses exit 1 to mean "files differ".
        let successful_or_expected_difference =
            output.success || (scope == DiffScope::Untracked && output.exit_code == Some(1));
        if !successful_or_expected_difference {
            return Err(git_failure(output));
        }
        Ok(DiffResult {
            scope,
            patch: output.stdout,
            truncated: output.stdout_truncated,
        })
    }

    pub fn stage(&self, repository: &Path, paths: &[PathBuf]) -> Result<Vec<FileStatus>> {
        if paths.is_empty() || paths.len() > 512 {
            return Err(IntegratorError::InvalidInput(
                "select 1 to 512 paths to stage".into(),
            ));
        }
        paths
            .iter()
            .try_for_each(|path| validate_relative_path(path))?;
        let strings: Vec<String> = paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        let mut args = vec!["add", "--"];
        args.extend(strings.iter().map(String::as_str));
        self.required(repository, &args)?;
        let mut files = self.status(repository)?;
        self.annotate_line_stats(repository, &mut files);
        Ok(files)
    }

    pub fn unstage(&self, repository: &Path, paths: &[PathBuf]) -> Result<Vec<FileStatus>> {
        if paths.is_empty() || paths.len() > 512 {
            return Err(IntegratorError::InvalidInput(
                "select 1 to 512 paths to unstage".into(),
            ));
        }
        paths
            .iter()
            .try_for_each(|path| validate_relative_path(path))?;
        let strings: Vec<String> = paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        let has_head = self
            .optional(repository, &["rev-parse", "--verify", "HEAD"])?
            .is_some();
        let mut args = if has_head {
            vec!["reset", "--quiet", "HEAD", "--"]
        } else {
            vec!["rm", "--cached", "--quiet", "--"]
        };
        args.extend(strings.iter().map(String::as_str));
        self.required(repository, &args)?;
        let mut files = self.status(repository)?;
        self.annotate_line_stats(repository, &mut files);
        Ok(files)
    }

    pub fn commit(&self, repository: &Path, message: &str) -> Result<CommitResult> {
        let message = message.trim();
        if message.is_empty() || message.len() > 10_000 || message.contains('\0') {
            return Err(IntegratorError::InvalidInput(
                "commit message must contain 1 to 10000 bytes".into(),
            ));
        }
        let output = self.output(repository, &["commit", "-m", message], GIT_COMMIT_TIMEOUT)?;
        if !output.success {
            return Err(git_failure(output));
        }
        if output.stdout_truncated || output.stderr_truncated {
            return Err(IntegratorError::Git(
                "commit completed with unexpectedly large output; inspect repository state".into(),
            ));
        }
        let summary = output.stdout;
        let commit = self.required(repository, &["rev-parse", "HEAD"])?;
        Ok(CommitResult {
            commit: commit.trim().into(),
            summary: redact_text(&summary),
        })
    }

    pub fn history(&self, repository: &Path) -> Result<Vec<HistoryCommit>> {
        self.history_page(repository, 0, 32)
    }

    /// Recent commit subjects only (newest first). Empty when the repository
    /// has no commits yet. Used as style context for commit-message drafts.
    pub fn recent_subjects(&self, repository: &Path, limit: u32) -> Result<Vec<String>> {
        let limit = limit.clamp(1, 32);
        let count_arg = format!("-{limit}");
        Ok(self
            .optional(repository, &["log", &count_arg, "--format=%s"])?
            .map(|output| {
                output
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .take(limit as usize)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default())
    }

    /// One page of history for the rail's "Show older commits" control.
    /// `current` is only meaningful on the first page; later pages clear it.
    pub fn history_page(
        &self,
        repository: &Path,
        skip: u32,
        limit: u32,
    ) -> Result<Vec<HistoryCommit>> {
        let limit = limit.clamp(1, 128);
        let count_arg = format!("-{limit}");
        let skip_arg = format!("--skip={skip}");
        let output = self.required(
            repository,
            &[
                "log",
                &count_arg,
                &skip_arg,
                &format!("--format={HISTORY_FORMAT}"),
            ],
        )?;
        let mut history = parse_history(&output);
        if skip > 0 {
            for commit in &mut history {
                commit.current = false;
            }
        }
        let status = self.read_status(repository, false)?;
        self.annotate_unpushed(repository, status.upstream.as_deref(), &mut history);
        Ok(history)
    }

    /// Mark history commits that are not reachable from the branch upstream
    /// so the rail can distinguish shared history from local-only work. With
    /// no upstream configured, fall back to reachability from any
    /// remote-tracking ref: a branch pushed outside this app (so tracking was
    /// never set up) must not read as local-only.
    fn annotate_unpushed(
        &self,
        repository: &Path,
        upstream: Option<&str>,
        history: &mut [HistoryCommit],
    ) {
        let output = if let Some(upstream) = upstream.filter(|name| !name.starts_with('-')) {
            let range = format!("{upstream}..HEAD");
            match self.optional(repository, &["rev-list", "--max-count=256", &range]) {
                Ok(Some(output)) => output,
                _ => return,
            }
        } else {
            match self.optional(
                repository,
                &["rev-list", "--max-count=256", "HEAD", "--not", "--remotes"],
            ) {
                Ok(Some(output)) => output,
                // No usable comparison point: treat everything as local-only,
                // matching a repository that has never been shared.
                _ => {
                    for commit in history.iter_mut() {
                        commit.unpushed = true;
                    }
                    return;
                }
            }
        };
        let local: Vec<&str> = output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        for commit in history.iter_mut() {
            commit.unpushed = local
                .iter()
                .any(|full| full.starts_with(commit.id.as_str()));
        }
    }

    pub fn push_preview(&self, repository: &Path) -> Result<PushPreview> {
        let head = self.required(repository, &["rev-parse", "--verify", "HEAD"])?;
        let head = head.trim().to_owned();
        let branch = self.required(repository, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
        let branch = branch.trim().to_owned();
        if branch.is_empty() {
            return Err(IntegratorError::Git(
                "detached HEAD cannot be pushed without an explicit branch".into(),
            ));
        }
        let upstream = clean_optional(self.optional(
            repository,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        )?);
        let remote = upstream
            .as_ref()
            .and_then(|value| value.split('/').next())
            .map(str::to_owned)
            .or_else(|| {
                clean_optional(
                    self.optional(repository, &["config", &format!("branch.{branch}.remote")])
                        .ok()
                        .flatten(),
                )
            });
        let remote_url = remote
            .as_ref()
            .and_then(|remote| {
                self.optional(repository, &["remote", "get-url", remote])
                    .ok()
                    .flatten()
            })
            .and_then(|url| clean_optional(Some(url)))
            .map(|url| sanitize_remote_url(&url));
        let (ahead, behind) = if upstream.is_some() {
            let counts = self.optional(
                repository,
                &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
            )?;
            counts.as_deref().map(parse_counts).unwrap_or((0, 0))
        } else {
            (0, 0)
        };
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        Ok(PushPreview {
            head,
            branch,
            remote,
            sanitized_remote_url: remote_url,
            upstream,
            ahead,
            behind,
            refspec,
        })
    }

    /// Push the exact local commit and destination the user confirmed. A
    /// changed HEAD, branch, upstream, remote, URL, or refspec invalidates the
    /// confirmation. Implicit branch publication is not part of this command;
    /// force pushing is, but only in the mode the confirmation carries.
    pub fn push_confirmed(
        &self,
        repository: &Path,
        confirmation: &PushConfirmation,
    ) -> Result<PushResult> {
        let current = self.push_preview(repository)?;
        let remote = current.remote.clone().ok_or_else(|| {
            IntegratorError::Git(
                "this branch has no configured remote; publish the branch separately".into(),
            )
        })?;
        let upstream = current.upstream.clone().ok_or_else(|| {
            IntegratorError::Git(
                "this branch has no upstream; publish the branch separately".into(),
            )
        })?;
        let matches_preview = confirmation.expected_head == current.head
            && confirmation.expected_branch == current.branch
            && confirmation.expected_remote == remote
            && confirmation.expected_remote_url == current.sanitized_remote_url
            && confirmation.expected_upstream == upstream
            && confirmation.expected_refspec == current.refspec;
        if !matches_preview {
            return Err(IntegratorError::Git(
                "repository state changed after push confirmation; review the updated push preview"
                    .into(),
            ));
        }

        let mut args = vec!["push", "--porcelain"];
        args.extend(confirmation.force.flag());
        args.extend(["--", remote.as_str(), current.refspec.as_str()]);
        let outcome = run_bounded_with_outcome(
            &self.executable,
            &args,
            Some(repository),
            MAX_GIT_OUTPUT_BYTES,
            GIT_PUSH_TIMEOUT,
        )?;
        match outcome {
            ProcessRunOutcome::TimedOut => Ok(PushResult {
                outcome: PushOutcome::OutcomeUncertain,
                head: current.head,
                branch: current.branch,
                remote,
                refspec: current.refspec,
                summary: "Push timed out. The remote outcome is uncertain; refresh before retrying."
                    .into(),
            }),
            ProcessRunOutcome::Completed(output)
                if output.stdout_truncated || output.stderr_truncated =>
            {
                Ok(PushResult {
                    outcome: PushOutcome::OutcomeUncertain,
                    head: current.head,
                    branch: current.branch,
                    remote,
                    refspec: current.refspec,
                    summary: "Push returned unusually large output. The remote outcome is uncertain; refresh before retrying."
                        .into(),
                })
            }
            ProcessRunOutcome::Completed(output) if !output.success => Err(git_failure(output)),
            ProcessRunOutcome::Completed(output) => {
                let summary = redact_text(&format!("{}\n{}", output.stdout, output.stderr));
                Ok(PushResult {
                    outcome: if current.ahead == 0 {
                        PushOutcome::UpToDate
                    } else {
                        PushOutcome::Pushed
                    },
                    head: current.head,
                    branch: current.branch,
                    remote: remote.clone(),
                    refspec: current.refspec,
                    summary: if summary.trim().is_empty() {
                        format!("Pushed to {remote}.")
                    } else {
                        summary
                    },
                })
            }
        }
    }

    fn read_status(&self, repository: &Path, include_files: bool) -> Result<PorcelainStatus> {
        let untracked = if include_files { "all" } else { "no" };
        let untracked_arg = format!("--untracked-files={untracked}");
        let output = self.required(
            repository,
            &["status", "--porcelain=v2", "--branch", "-z", &untracked_arg],
        )?;
        Ok(parse_porcelain_v2(&output, include_files))
    }

    fn push_preview_from_status(
        &self,
        repository: &Path,
        branch: &str,
        head: &str,
        status: &PorcelainStatus,
    ) -> Result<PushPreview> {
        let upstream = status.upstream.clone();
        let remote = upstream
            .as_ref()
            .and_then(|value| value.split('/').next())
            .map(str::to_owned)
            .or_else(|| {
                clean_optional(
                    self.optional(repository, &["config", &format!("branch.{branch}.remote")])
                        .ok()
                        .flatten(),
                )
            });
        let remote_url = remote
            .as_ref()
            .and_then(|remote| {
                self.optional(repository, &["remote", "get-url", remote])
                    .ok()
                    .flatten()
            })
            .and_then(|url| clean_optional(Some(url)))
            .map(|url| sanitize_remote_url(&url));
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        Ok(PushPreview {
            head: head.to_owned(),
            branch: branch.to_owned(),
            remote,
            sanitized_remote_url: remote_url,
            upstream,
            ahead: status.ahead,
            behind: status.behind,
            refspec,
        })
    }

    fn required(&self, cwd: &Path, args: &[&str]) -> Result<String> {
        self.required_with_timeout(cwd, args, GIT_TIMEOUT)
    }

    fn required_with_timeout(
        &self,
        cwd: &Path,
        args: &[&str],
        timeout: Duration,
    ) -> Result<String> {
        let output = self.output(cwd, args, timeout)?;
        if output.success {
            if output.stdout_truncated || output.stderr_truncated {
                Err(IntegratorError::Git(
                    "Git output exceeded the local safety limit".into(),
                ))
            } else {
                Ok(output.stdout)
            }
        } else {
            Err(git_failure(output))
        }
    }

    fn optional(&self, cwd: &Path, args: &[&str]) -> Result<Option<String>> {
        let output = self.output(cwd, args, GIT_TIMEOUT)?;
        if output.stdout_truncated || output.stderr_truncated {
            return Err(IntegratorError::Git(
                "Git output exceeded the local safety limit".into(),
            ));
        }
        Ok(output.success.then_some(output.stdout))
    }

    fn output(&self, cwd: &Path, args: &[&str], timeout: Duration) -> Result<ProcessOutput> {
        run_bounded_with_limits(
            &self.executable,
            args,
            Some(cwd),
            MAX_GIT_OUTPUT_BYTES,
            timeout,
        )
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

fn canonical_directory(path: &Path) -> Result<PathBuf> {
    if !path.is_dir() {
        return Err(IntegratorError::InvalidInput(
            "path must be an existing directory".into(),
        ));
    }
    dunce::canonicalize(path).map_err(IntegratorError::Io)
}

fn validate_new_destination(path: &Path) -> Result<()> {
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

fn validate_remote_name(name: &str) -> Result<()> {
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

fn validate_remote_url(url: &str) -> Result<()> {
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

fn git_failure(output: ProcessOutput) -> IntegratorError {
    let message = if output.stderr.trim().is_empty() {
        output.stdout
    } else {
        output.stderr
    };
    IntegratorError::Git(redact_text(&message))
}

fn validate_relative_path(path: &Path) -> Result<()> {
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

fn validate_revision(value: &str) -> Result<()> {
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

fn absolute_from(root: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_owned()
    } else {
        root.join(path)
    }
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

fn parse_worktrees(output: &str) -> Vec<WorktreeInfo> {
    output
        .split("\n\n")
        .filter_map(|block| {
            let mut info = WorktreeInfo {
                path: PathBuf::new(),
                head: None,
                branch: None,
                bare: false,
                detached: false,
                locked: false,
                prunable: false,
            };
            for line in block.lines() {
                let (key, value) = line.split_once(' ').unwrap_or((line, ""));
                match key {
                    "worktree" => info.path = PathBuf::from(value),
                    "HEAD" => info.head = Some(value.into()),
                    "branch" => {
                        info.branch =
                            Some(value.strip_prefix("refs/heads/").unwrap_or(value).into())
                    }
                    "bare" => info.bare = true,
                    "detached" => info.detached = true,
                    "locked" => info.locked = true,
                    "prunable" => info.prunable = true,
                    _ => {}
                }
            }
            (!info.path.as_os_str().is_empty()).then_some(info)
        })
        .collect()
}

fn parse_counts(value: &str) -> (u64, u64) {
    let mut parts = value
        .split_whitespace()
        .filter_map(|part| part.parse::<u64>().ok());
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

/// One record per line; fields NUL-separated: abbreviated hash, subject,
/// relative time, abbreviated parent hashes, and ref decorations.
const HISTORY_FORMAT: &str = "%h%x00%s%x00%cr%x00%p%x00%D";

fn parse_history(output: &str) -> Vec<HistoryCommit> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\0');
            let id = fields.next()?.trim();
            let subject = fields.next()?.trim();
            let relative_time = fields.next()?.trim();
            if id.is_empty() || subject.is_empty() || relative_time.is_empty() {
                return None;
            }
            let parents = fields
                .next()
                .map(|value| {
                    value
                        .split_whitespace()
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let refs = fields
                .next()
                .map(|value| {
                    value
                        .split(", ")
                        .map(|name| name.strip_prefix("HEAD -> ").unwrap_or(name).trim())
                        .filter(|name| !name.is_empty() && *name != "HEAD")
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(HistoryCommit {
                id: id.into(),
                subject: subject.into(),
                relative_time: relative_time.into(),
                current: false,
                parents,
                refs,
                unpushed: false,
            })
        })
        .enumerate()
        .map(|(index, mut commit)| {
            commit.current = index == 0;
            commit
        })
        .collect()
}

fn parse_porcelain_v2(output: &str, include_files: bool) -> PorcelainStatus {
    let mut parsed = PorcelainStatus::default();
    let mut records = output.split_terminator('\0');
    while let Some(record) = records.next() {
        if let Some(value) = record.strip_prefix("# branch.oid ") {
            if value != "(initial)" {
                parsed.head = clean_optional(Some(value.into()));
            }
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.head ") {
            if value != "(detached)" {
                parsed.branch = clean_optional(Some(value.into()));
            }
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.upstream ") {
            parsed.upstream = clean_optional(Some(value.into()));
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.ab ") {
            for count in value.split_whitespace() {
                if let Some(ahead) = count.strip_prefix('+').and_then(|v| v.parse().ok()) {
                    parsed.ahead = ahead;
                } else if let Some(behind) = count.strip_prefix('-').and_then(|v| v.parse().ok()) {
                    parsed.behind = behind;
                }
            }
            continue;
        }
        if !include_files {
            continue;
        }
        let file = match record.as_bytes().first().copied() {
            Some(b'1') => parse_v2_tracked(record, 9),
            Some(b'2') => {
                let file = parse_v2_tracked(record, 10);
                // A rename/copy record is followed by the original path. The
                // UI status row intentionally identifies the destination.
                let _ = records.next();
                file
            }
            Some(b'u') => parse_v2_tracked(record, 11),
            Some(b'?') => record.strip_prefix("? ").map(|path| FileStatus {
                index_status: '?',
                worktree_status: '?',
                path: PathBuf::from(path),
                additions: None,
                deletions: None,
                staged_additions: None,
                staged_deletions: None,
                unstaged_additions: None,
                unstaged_deletions: None,
            }),
            _ => None,
        };
        if let Some(file) = file {
            parsed.files.push(file);
        }
    }
    parsed
}

fn parse_v2_tracked(record: &str, fields: usize) -> Option<FileStatus> {
    let mut values = record.splitn(fields, ' ');
    let _kind = values.next()?;
    let status = values.next()?;
    let mut status = status.chars();
    let index_status = normalize_v2_status(status.next()?);
    let worktree_status = normalize_v2_status(status.next()?);
    let path = values.last()?;
    (!path.is_empty()).then(|| FileStatus {
        index_status,
        worktree_status,
        path: PathBuf::from(path),
        additions: None,
        deletions: None,
        staged_additions: None,
        staged_deletions: None,
        unstaged_additions: None,
        unstaged_deletions: None,
    })
}

fn normalize_v2_status(status: char) -> char {
    if status == '.' { ' ' } else { status }
}

/// Parse NUL-terminated `git diff --numstat --no-renames -z` records into
/// per-path line counts. Binary changes report `-` and parse to `None`.
fn parse_numstat(output: &str) -> HashMap<PathBuf, (Option<u64>, Option<u64>)> {
    let mut stats = HashMap::new();
    for record in output.split_terminator('\0') {
        let mut fields = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if path.is_empty() {
            continue;
        }
        stats.insert(
            PathBuf::from(path),
            (added.parse().ok(), removed.parse().ok()),
        );
    }
    stats
}

const MAX_UNTRACKED_STAT_BYTES: u64 = 1_000_000;

/// Line count for an untracked file so its rail row can show `+n` without
/// generating a per-file diff. Returns `None` for binary, oversized, or
/// unreadable files, and for paths that resolve outside the repository.
fn count_untracked_lines(repository: &Path, path: &Path) -> Option<u64> {
    let authorized_root = dunce::canonicalize(repository).ok()?;
    let canonical = dunce::canonicalize(repository.join(path)).ok()?;
    if !canonical.starts_with(&authorized_root) {
        return None;
    }
    let metadata = fs::metadata(&canonical).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_UNTRACKED_STAT_BYTES {
        return None;
    }
    let bytes = fs::read(&canonical).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    if bytes.is_empty() {
        return Some(0);
    }
    let mut lines = bytes.iter().filter(|byte| **byte == b'\n').count() as u64;
    if bytes.last() != Some(&b'\n') {
        lines += 1;
    }
    Some(lines)
}

fn sanitize_remote_url(value: &str) -> String {
    let query = value.find('?');
    let fragment = value.find('#');
    let boundary = query
        .into_iter()
        .chain(fragment)
        .min()
        .unwrap_or(value.len());
    let value = &value[..boundary];
    if (value.starts_with("http://") || value.starts_with("https://"))
        && let Some(scheme_end) = value.find("://")
    {
        let after_scheme = scheme_end + 3;
        let path_start = value[after_scheme..]
            .find('/')
            .map(|index| after_scheme + index)
            .unwrap_or(value.len());
        let authority = &value[after_scheme..path_start];
        if let Some(at) = authority.rfind('@') {
            return format!(
                "{}{}{}",
                &value[..after_scheme],
                &authority[at + 1..],
                &value[path_start..]
            );
        }
    }
    value.to_owned()
}

#[cfg(test)]
mod tests {
    use std::{fs, process::Command};

    use chrono::Utc;
    use integrator_core::ProjectId;

    use super::*;

    fn initialize_repository(root: &Path) {
        assert!(
            Command::new("git")
                .args(["init", "-b", "main"])
                .current_dir(root)
                .status()
                .expect("git init")
                .success()
        );
    }

    fn trusted_project(identity: &RepositoryIdentity) -> TrustedProject {
        let now = Utc::now();
        TrustedProject {
            id: ProjectId::new(),
            display_name: "Trusted".into(),
            repository_root: identity.root.clone(),
            git_repository_root: Some(identity.root.clone()),
            git_common_directory: Some(identity.common_directory.clone()),
            created_at: now,
            last_opened_at: now,
        }
    }

    fn configure_identity(root: &Path) {
        for args in [
            ["config", "user.name", "Test User"],
            ["config", "user.email", "test@example.invalid"],
        ] {
            assert!(
                Command::new("git")
                    .args(args)
                    .current_dir(root)
                    .status()
                    .expect("git config")
                    .success()
            );
        }
    }

    fn confirmation_for(preview: &PushPreview) -> PushConfirmation {
        forced_confirmation_for(preview, PushForce::Off)
    }

    fn forced_confirmation_for(preview: &PushPreview, force: PushForce) -> PushConfirmation {
        PushConfirmation {
            expected_head: preview.head.clone(),
            expected_branch: preview.branch.clone(),
            expected_remote: preview.remote.clone().expect("configured remote"),
            expected_remote_url: preview.sanitized_remote_url.clone(),
            expected_upstream: preview.upstream.clone().expect("configured upstream"),
            expected_refspec: preview.refspec.clone(),
            force,
        }
    }

    #[test]
    fn ordinary_folder_requires_explicit_initialization() {
        let directory = tempfile::tempdir().expect("ordinary folder");
        let git = GitService::discover().expect("discover git");
        assert_eq!(
            git.repository_if_present(directory.path())
                .expect("detect ordinary folder"),
            None
        );

        let initialized = git.init(directory.path()).expect("initialize Git");
        assert_eq!(
            initialized.root,
            dunce::canonicalize(directory.path()).expect("canonical ordinary folder")
        );
        assert_eq!(initialized.branch.as_deref(), Some("main"));
        assert!(
            git.repository_if_present(directory.path())
                .expect("detect initialized repository")
                .is_some()
        );
    }

    #[test]
    fn remotes_can_be_added_updated_and_removed_locally() {
        let directory = tempfile::tempdir().expect("repository");
        let first_remote = tempfile::tempdir().expect("first remote");
        let second_remote = tempfile::tempdir().expect("second remote");
        initialize_repository(directory.path());
        let git = GitService::discover().expect("discover git");

        let remotes = git
            .add_remote(
                directory.path(),
                "origin",
                &first_remote.path().to_string_lossy(),
            )
            .expect("add remote");
        assert_eq!(remotes[0].name, "origin");
        let remotes = git
            .update_remote(
                directory.path(),
                "origin",
                &second_remote.path().to_string_lossy(),
            )
            .expect("update remote");
        assert_eq!(remotes[0].fetch_url, second_remote.path().to_string_lossy());
        assert!(
            git.remove_remote(directory.path(), "origin")
                .expect("remove remote")
                .is_empty()
        );
    }

    #[test]
    fn remote_credentials_are_removed() {
        assert_eq!(
            sanitize_remote_url("https://user:secret@example.test/org/repo.git"),
            "https://example.test/org/repo.git"
        );
        assert_eq!(
            sanitize_remote_url("git@example.test:org/repo.git"),
            "git@example.test:org/repo.git"
        );
        assert_eq!(
            sanitize_remote_url("https://example.test/org/repo.git?access_token=not-real"),
            "https://example.test/org/repo.git"
        );
    }

    #[test]
    fn remote_urls_reject_command_transports_and_embedded_https_credentials() {
        assert!(validate_remote_url("ext::sh -c touch /tmp/unsafe").is_err());
        assert!(validate_remote_url("https://user:secret@example.test/repo.git").is_err());
        assert!(validate_remote_url("ssh://git@example.test/org/repo.git").is_ok());
        assert!(validate_remote_url("git@example.test:org/repo.git").is_ok());
    }

    #[test]
    fn git_status_diff_stage_commit_and_preview() {
        if which::which("git").is_err() {
            return;
        }
        let directory = tempfile::tempdir().expect("temp repo");
        let root = directory.path();
        assert!(
            Command::new("git")
                .args(["init", "-b", "main"])
                .current_dir(root)
                .status()
                .expect("git init")
                .success()
        );
        for args in [
            ["config", "user.name", "Test User"],
            ["config", "user.email", "test@example.invalid"],
        ] {
            assert!(
                Command::new("git")
                    .args(args)
                    .current_dir(root)
                    .status()
                    .expect("git config")
                    .success()
            );
        }
        fs::write(root.join("sample.txt"), "hello\n").expect("write fixture");
        let git = GitService::discover().expect("discover git");
        assert_eq!(git.status(root).expect("status").len(), 1);
        let untracked = git
            .diff(root, DiffScope::Untracked, Some(Path::new("sample.txt")))
            .expect("untracked diff");
        assert!(untracked.patch.contains("+hello"));
        git.stage(root, &[PathBuf::from("sample.txt")])
            .expect("stage");
        let staged = git
            .diff(root, DiffScope::Staged, None)
            .expect("staged diff");
        assert!(staged.patch.contains("+hello"));
        git.commit(root, "Initial fixture").expect("commit");
        let history = git.history(root).expect("history");
        assert_eq!(history[0].subject, "Initial fixture");
        assert!(history[0].current);
        fs::write(root.join("sample.txt"), "hello\nworld\n").expect("modify fixture");
        let identity = git.repository(root).expect("authorized identity");
        let overview = git.overview(&identity).expect("overview");
        assert_eq!(overview.identity.branch.as_deref(), Some("main"));
        assert_eq!(overview.history[0].subject, "Initial fixture");
        assert_eq!(overview.files.len(), 1);
        assert_eq!(overview.files[0].path, PathBuf::from("sample.txt"));
        assert_eq!(overview.files[0].worktree_status, 'M');
        git.stage(root, &[PathBuf::from("sample.txt")])
            .expect("stage first tranche");
        fs::write(root.join("sample.txt"), "hello\nworld\nlater\n")
            .expect("write unstaged remainder");
        let overview = git.overview(&identity).expect("partially staged overview");
        assert_eq!(overview.files[0].index_status, 'M');
        assert_eq!(overview.files[0].worktree_status, 'M');
        assert_eq!(overview.files[0].staged_additions, Some(1));
        assert_eq!(overview.files[0].unstaged_additions, Some(1));
        assert_eq!(
            overview
                .push_preview
                .as_ref()
                .map(|preview| preview.branch.as_str()),
            Some("main")
        );
        let preview = git.push_preview(root).expect("preview");
        assert!(preview.head.starts_with(&history[0].id));
        assert_eq!(preview.branch, "main");
    }

    #[test]
    fn confirmed_push_updates_only_the_previewed_branch_and_head() {
        if which::which("git").is_err() {
            return;
        }
        let local_directory = tempfile::tempdir().expect("local repo");
        let remote_directory = tempfile::tempdir().expect("bare remote");
        let root = local_directory.path();
        initialize_repository(root);
        configure_identity(root);
        assert!(
            Command::new("git")
                .args(["init", "--bare"])
                .current_dir(remote_directory.path())
                .status()
                .expect("bare git init")
                .success()
        );
        let remote_path = remote_directory.path().to_string_lossy().into_owned();
        assert!(
            Command::new("git")
                .args(["remote", "add", "origin", &remote_path])
                .current_dir(root)
                .status()
                .expect("git remote add")
                .success()
        );
        let git = GitService::discover().expect("discover git");
        fs::write(root.join("sample.txt"), "initial\n").expect("write initial fixture");
        git.stage(root, &[PathBuf::from("sample.txt")])
            .expect("stage initial fixture");
        git.commit(root, "Initial fixture").expect("initial commit");
        assert!(
            Command::new("git")
                .args(["push", "-u", "origin", "main"])
                .current_dir(root)
                .status()
                .expect("initial push")
                .success()
        );

        fs::write(root.join("sample.txt"), "initial\nnext\n").expect("write next fixture");
        git.stage(root, &[PathBuf::from("sample.txt")])
            .expect("stage next fixture");
        let commit = git.commit(root, "Next fixture").expect("next commit");
        let preview = git.push_preview(root).expect("push preview");
        assert_eq!(preview.ahead, 1);
        let result = git
            .push_confirmed(root, &confirmation_for(&preview))
            .expect("confirmed push");

        assert_eq!(result.outcome, PushOutcome::Pushed);
        assert_eq!(result.head, commit.commit);
        assert_eq!(
            git.required(remote_directory.path(), &["rev-parse", "refs/heads/main"])
                .expect("remote head")
                .trim(),
            commit.commit
        );
    }

    #[test]
    fn force_modes_map_to_the_flag_they_promise() {
        assert_eq!(PushForce::Off.flag(), None);
        assert_eq!(PushForce::Lease.flag(), Some("--force-with-lease"));
        assert_eq!(PushForce::Always.flag(), Some("--force"));
        // A payload with no force field means the safe mode, never a remembered one.
        assert_eq!(PushForce::default(), PushForce::Off);
    }

    #[test]
    fn a_forced_push_rewrites_remote_history_only_when_the_confirmation_asks_for_it() {
        if which::which("git").is_err() {
            return;
        }
        let local_directory = tempfile::tempdir().expect("local repo");
        let remote_directory = tempfile::tempdir().expect("bare remote");
        let root = local_directory.path();
        initialize_repository(root);
        configure_identity(root);
        assert!(
            Command::new("git")
                .args(["init", "--bare"])
                .current_dir(remote_directory.path())
                .status()
                .expect("bare git init")
                .success()
        );
        let remote_path = remote_directory.path().to_string_lossy().into_owned();
        assert!(
            Command::new("git")
                .args(["remote", "add", "origin", &remote_path])
                .current_dir(root)
                .status()
                .expect("git remote add")
                .success()
        );
        let git = GitService::discover().expect("discover git");
        fs::write(root.join("sample.txt"), "initial\n").expect("write initial fixture");
        git.stage(root, &[PathBuf::from("sample.txt")])
            .expect("stage initial fixture");
        git.commit(root, "Initial fixture").expect("initial commit");
        assert!(
            Command::new("git")
                .args(["push", "-u", "origin", "main"])
                .current_dir(root)
                .status()
                .expect("initial push")
                .success()
        );

        // Rewrite the commit that was already pushed, so the local branch and
        // the remote diverge and only a forced push can reconcile them.
        fs::write(root.join("sample.txt"), "rewritten\n").expect("write rewritten fixture");
        git.stage(root, &[PathBuf::from("sample.txt")])
            .expect("stage rewritten fixture");
        assert!(
            Command::new("git")
                .args(["commit", "--amend", "-m", "Rewritten fixture"])
                .current_dir(root)
                .status()
                .expect("git commit --amend")
                .success()
        );

        let preview = git.push_preview(root).expect("push preview");
        assert_eq!((preview.ahead, preview.behind), (1, 1));
        // The ordinary confirmation carries no force mode, so a diverged push
        // is refused rather than quietly rewriting the remote.
        assert!(git.push_confirmed(root, &confirmation_for(&preview)).is_err());

        let result = git
            .push_confirmed(root, &forced_confirmation_for(&preview, PushForce::Lease))
            .expect("leased force push");
        assert_eq!(result.outcome, PushOutcome::Pushed);
        assert_eq!(
            git.required(remote_directory.path(), &["rev-parse", "refs/heads/main"])
                .expect("remote head")
                .trim(),
            preview.head
        );
    }

    #[test]
    fn confirmed_push_rejects_a_head_changed_after_preview() {
        if which::which("git").is_err() {
            return;
        }
        let local_directory = tempfile::tempdir().expect("local repo");
        let remote_directory = tempfile::tempdir().expect("bare remote");
        let root = local_directory.path();
        initialize_repository(root);
        configure_identity(root);
        assert!(
            Command::new("git")
                .args(["init", "--bare"])
                .current_dir(remote_directory.path())
                .status()
                .expect("bare git init")
                .success()
        );
        let remote_path = remote_directory.path().to_string_lossy().into_owned();
        assert!(
            Command::new("git")
                .args(["remote", "add", "origin", &remote_path])
                .current_dir(root)
                .status()
                .expect("git remote add")
                .success()
        );
        let git = GitService::discover().expect("discover git");
        fs::write(root.join("sample.txt"), "initial\n").expect("write initial fixture");
        git.stage(root, &[PathBuf::from("sample.txt")])
            .expect("stage initial fixture");
        let initial = git.commit(root, "Initial fixture").expect("initial commit");
        assert!(
            Command::new("git")
                .args(["push", "-u", "origin", "main"])
                .current_dir(root)
                .status()
                .expect("initial push")
                .success()
        );

        fs::write(root.join("sample.txt"), "initial\npreviewed\n").expect("write preview fixture");
        git.stage(root, &[PathBuf::from("sample.txt")])
            .expect("stage preview fixture");
        git.commit(root, "Previewed fixture")
            .expect("previewed commit");
        let confirmation = confirmation_for(&git.push_preview(root).expect("push preview"));
        fs::write(root.join("sample.txt"), "initial\npreviewed\nchanged\n")
            .expect("write changed fixture");
        git.stage(root, &[PathBuf::from("sample.txt")])
            .expect("stage changed fixture");
        git.commit(root, "Changed after preview")
            .expect("changed commit");

        let error = git
            .push_confirmed(root, &confirmation)
            .expect_err("stale confirmation must fail");
        assert!(error.to_string().contains("state changed"));
        assert_eq!(
            git.required(remote_directory.path(), &["rev-parse", "refs/heads/main"])
                .expect("remote head")
                .trim(),
            initial.commit
        );
    }

    #[test]
    fn porcelain_v2_overview_preserves_paths_and_branch_counts() {
        let output = concat!(
            "# branch.oid abcdef\0",
            "# branch.head feature/smooth\0",
            "# branch.upstream origin/feature/smooth\0",
            "# branch.ab +3 -2\0",
            "1 .M N... 100644 100644 100644 aaaaaa bbbbbb path with spaces.txt\0",
            "2 R. N... 100644 100644 100644 aaaaaa bbbbbb R100 renamed file.txt\0",
            "old file.txt\0",
            "? untracked file.txt\0",
        );
        let parsed = parse_porcelain_v2(output, true);
        assert_eq!(parsed.head.as_deref(), Some("abcdef"));
        assert_eq!(parsed.branch.as_deref(), Some("feature/smooth"));
        assert_eq!(parsed.upstream.as_deref(), Some("origin/feature/smooth"));
        assert_eq!((parsed.ahead, parsed.behind), (3, 2));
        assert_eq!(parsed.files.len(), 3);
        assert_eq!(parsed.files[0].path, PathBuf::from("path with spaces.txt"));
        assert_eq!(parsed.files[0].index_status, ' ');
        assert_eq!(parsed.files[0].worktree_status, 'M');
        assert_eq!(parsed.files[1].path, PathBuf::from("renamed file.txt"));
        assert_eq!(parsed.files[1].index_status, 'R');
        assert_eq!(parsed.files[2].path, PathBuf::from("untracked file.txt"));
    }

    #[test]
    fn paths_cannot_escape_repository() {
        assert!(validate_relative_path(Path::new("../secret")).is_err());
        assert!(validate_relative_path(Path::new("src/lib.rs")).is_ok());
    }

    #[test]
    fn revision_cannot_be_interpreted_as_an_option() {
        assert!(validate_revision("main").is_ok());
        assert!(validate_revision("HEAD~2").is_ok());
        assert!(validate_revision("--force").is_err());
    }

    #[test]
    fn repository_identity_is_canonical_from_nested_directory() {
        if which::which("git").is_err() {
            return;
        }
        let directory = tempfile::tempdir().expect("temp repo");
        initialize_repository(directory.path());
        let nested = directory.path().join("nested").join("child");
        fs::create_dir_all(&nested).expect("nested fixture");
        let identity = GitService::discover()
            .expect("discover git")
            .repository(&nested)
            .expect("repository identity");
        assert_eq!(
            identity.root,
            dunce::canonicalize(directory.path()).expect("canonical root")
        );
        assert_eq!(
            identity.common_directory,
            dunce::canonicalize(directory.path().join(".git")).expect("canonical git directory")
        );
    }

    #[test]
    fn untrusted_repository_is_rejected() {
        if which::which("git").is_err() {
            return;
        }
        let trusted_directory = tempfile::tempdir().expect("trusted repo");
        let untrusted_directory = tempfile::tempdir().expect("untrusted repo");
        initialize_repository(trusted_directory.path());
        initialize_repository(untrusted_directory.path());
        let git = GitService::discover().expect("discover git");
        let identity = git
            .repository(trusted_directory.path())
            .expect("trusted identity");
        let now = Utc::now();
        let projects = vec![TrustedProject {
            id: ProjectId::new(),
            display_name: "Trusted".into(),
            repository_root: identity.root.clone(),
            git_repository_root: Some(identity.root),
            git_common_directory: Some(identity.common_directory),
            created_at: now,
            last_opened_at: now,
        }];
        let error = authorize_repository(&git, &projects, untrusted_directory.path())
            .expect_err("untrusted repository must fail");
        assert!(error.to_string().contains("trusted project"));
    }

    #[test]
    fn listed_worktree_of_trusted_project_is_authorized() {
        if which::which("git").is_err() {
            return;
        }
        let directory = tempfile::tempdir().expect("trusted repo");
        let worktree_parent = tempfile::tempdir().expect("worktree parent");
        let worktree_path = worktree_parent.path().join("agent-worktree");
        initialize_repository(directory.path());
        for args in [
            ["config", "user.name", "Test User"],
            ["config", "user.email", "test@example.invalid"],
        ] {
            assert!(
                Command::new("git")
                    .args(args)
                    .current_dir(directory.path())
                    .status()
                    .expect("git config")
                    .success()
            );
        }
        fs::write(directory.path().join("fixture.txt"), "fixture\n").expect("write fixture");
        let git = GitService::discover().expect("discover git");
        git.stage(directory.path(), &[PathBuf::from("fixture.txt")])
            .expect("stage fixture");
        git.commit(directory.path(), "Initial fixture")
            .expect("commit fixture");
        let identity = git.repository(directory.path()).expect("trusted identity");
        let now = Utc::now();
        let projects = vec![TrustedProject {
            id: ProjectId::new(),
            display_name: "Trusted".into(),
            repository_root: identity.root.clone(),
            git_repository_root: Some(identity.root.clone()),
            git_common_directory: Some(identity.common_directory.clone()),
            created_at: now,
            last_opened_at: now,
        }];
        git.create_worktree(
            &identity.root,
            &CreateWorktree {
                destination: worktree_path.clone(),
                branch: "agent/fixture".into(),
                base_ref: Some("HEAD".into()),
            },
        )
        .expect("create worktree");

        let authorized = authorize_repository(&git, &projects, &worktree_path)
            .expect("listed worktree must be authorized");
        assert_eq!(
            authorized.root,
            dunce::canonicalize(&worktree_path).expect("canonical worktree")
        );
        let mut cache = AuthorizedRepositoryCache::default();
        cache
            .authorize(&git, &projects, &worktree_path)
            .expect("cache linked worktree");
        let unavailable_git = GitService {
            executable: directory.path().join("missing-git-executable"),
        };
        let cached = cache
            .authorize(&unavailable_git, &projects, &worktree_path)
            .expect("linked worktree cache hit must not spawn Git");
        assert_eq!(cached.root, authorized.root);
    }

    #[test]
    fn cached_authorization_is_revoked_when_project_is_removed() {
        if which::which("git").is_err() {
            return;
        }
        let directory = tempfile::tempdir().expect("trusted repo");
        initialize_repository(directory.path());
        let git = GitService::discover().expect("discover git");
        let identity = git
            .repository(directory.path())
            .expect("repository identity");
        let mut projects = vec![trusted_project(&identity)];
        let mut cache = AuthorizedRepositoryCache::default();

        let authorized = cache
            .authorize(&git, &projects, directory.path())
            .expect("first authorization");
        assert_eq!(authorized.root, identity.root);
        assert_eq!(cache.entries.len(), 1);

        projects.clear();
        let error = cache
            .authorize(&git, &projects, directory.path())
            .expect_err("removed project must revoke cached trust");
        assert!(error.to_string().contains("trusted project"));
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn cached_authorization_requires_the_original_git_layout() {
        if which::which("git").is_err() {
            return;
        }
        let directory = tempfile::tempdir().expect("trusted repo");
        initialize_repository(directory.path());
        let git = GitService::discover().expect("discover git");
        let identity = git
            .repository(directory.path())
            .expect("repository identity");
        let projects = vec![trusted_project(&identity)];
        let mut cache = AuthorizedRepositoryCache::default();
        cache
            .authorize(&git, &projects, directory.path())
            .expect("first authorization");

        let git_directory = directory.path().join(".git");
        let moved_git_directory = directory.path().join(".git-away");
        fs::rename(&git_directory, &moved_git_directory).expect("move git directory");
        let error = cache
            .authorize(&git, &projects, directory.path())
            .expect_err("changed Git layout must invalidate cache");
        fs::rename(&moved_git_directory, &git_directory).expect("restore git directory");

        assert!(!error.to_string().is_empty());
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn refreshed_identity_observes_branch_changes_after_cache_hits() {
        if which::which("git").is_err() {
            return;
        }
        let directory = tempfile::tempdir().expect("trusted repo");
        initialize_repository(directory.path());
        let git = GitService::discover().expect("discover git");
        let identity = git
            .repository(directory.path())
            .expect("repository identity");
        let projects = vec![trusted_project(&identity)];
        let mut cache = AuthorizedRepositoryCache::default();
        cache
            .authorize(&git, &projects, directory.path())
            .expect("first authorization");
        assert!(
            Command::new("git")
                .args(["checkout", "-b", "feature/cache-refresh"])
                .current_dir(directory.path())
                .status()
                .expect("create branch")
                .success()
        );

        let unavailable_git = GitService {
            executable: directory.path().join("missing-git-executable"),
        };
        let structural = cache
            .authorize(&unavailable_git, &projects, directory.path())
            .expect("cached authorization");
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(structural.branch, None);
        assert_eq!(structural.head, None);
        let refreshed = git
            .refresh_identity(&structural)
            .expect("refresh volatile identity");
        assert_eq!(refreshed.branch.as_deref(), Some("feature/cache-refresh"));
        assert_eq!(refreshed.head, None);
    }
}
