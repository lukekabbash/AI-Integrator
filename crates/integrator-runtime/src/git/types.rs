use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryIdentity {
    pub root: PathBuf,
    pub common_directory: PathBuf,
    pub branch: Option<String>,
    pub head: Option<String>,
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
    pub(super) fn flag(self) -> Option<&'static str> {
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
