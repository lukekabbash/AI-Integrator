use std::{
    path::{Component, Path, PathBuf},
    str,
    time::Duration,
};

use integrator_core::{IntegratorError, Result};
use serde::{Deserialize, Serialize};

use crate::safe_process::{ProcessOutput, redact_text, run_bounded_with_limits};

const MAX_GIT_OUTPUT_BYTES: u64 = 8 * 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_COMMIT_TIMEOUT: Duration = Duration::from_secs(120);

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
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffScope {
    Unstaged,
    Staged,
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
pub struct PushPreview {
    pub branch: String,
    pub remote: Option<String>,
    pub sanitized_remote_url: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub refspec: String,
    pub force: bool,
}

#[derive(Clone, Debug)]
pub struct GitService {
    executable: PathBuf,
}

impl GitService {
    pub fn discover() -> Result<Self> {
        let executable = which::which("git")
            .map_err(|_| IntegratorError::Unavailable("git is not installed".into()))?;
        Ok(Self { executable })
    }

    pub fn repository(&self, path: &Path) -> Result<RepositoryIdentity> {
        let root = self.required(path, &["rev-parse", "--show-toplevel"])?;
        let root = PathBuf::from(root.trim());
        let common = self.required(&root, &["rev-parse", "--git-common-dir"])?;
        let common = absolute_from(&root, Path::new(common.trim()));
        let branch = self.optional(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
        let head = self.optional(&root, &["rev-parse", "--verify", "HEAD"])?;
        Ok(RepositoryIdentity {
            root,
            common_directory: common,
            branch: clean_optional(branch),
            head: clean_optional(head),
        })
    }

    pub fn worktrees(&self, repository: &Path) -> Result<Vec<WorktreeInfo>> {
        let output = self.required(repository, &["worktree", "list", "--porcelain"])?;
        Ok(parse_worktrees(&output))
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
        let mut args = vec!["diff", "--no-ext-diff", "--no-color", "--unified=3"];
        if scope == DiffScope::Staged {
            args.push("--cached");
        }
        let path_string;
        if let Some(path) = path {
            args.push("--");
            path_string = path.to_string_lossy().into_owned();
            args.push(&path_string);
        }
        let output = self.output(repository, &args, GIT_TIMEOUT)?;
        if !output.success {
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
        self.status(repository)
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
        self.status(repository)
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

    pub fn push_preview(&self, repository: &Path) -> Result<PushPreview> {
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
            .and_then(clean_optional)
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
            branch,
            remote,
            sanitized_remote_url: remote_url,
            upstream,
            ahead,
            behind,
            refspec,
            force: false,
        })
    }

    fn required(&self, cwd: &Path, args: &[&str]) -> Result<String> {
        let output = self.output(cwd, args, GIT_TIMEOUT)?;
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

fn sanitize_remote_url(value: &str) -> String {
    let query = value.find('?');
    let fragment = value.find('#');
    let boundary = query
        .into_iter()
        .chain(fragment)
        .min()
        .unwrap_or(value.len());
    let value = &value[..boundary];
    if let Some(scheme_end) = value.find("://") {
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
    if let Some(at) = value.find('@') {
        if value[..at].find(':').is_none() {
            return value[at + 1..].to_owned();
        }
    }
    value.to_owned()
}

#[cfg(test)]
mod tests {
    use std::{fs, process::Command};

    use super::*;

    #[test]
    fn remote_credentials_are_removed() {
        assert_eq!(
            sanitize_remote_url("https://user:secret@example.test/org/repo.git"),
            "https://example.test/org/repo.git"
        );
        assert_eq!(
            sanitize_remote_url("git@example.test:org/repo.git"),
            "example.test:org/repo.git"
        );
        assert_eq!(
            sanitize_remote_url("https://example.test/org/repo.git?access_token=not-real"),
            "https://example.test/org/repo.git"
        );
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
        git.stage(root, &[PathBuf::from("sample.txt")])
            .expect("stage");
        let staged = git
            .diff(root, DiffScope::Staged, None)
            .expect("staged diff");
        assert!(staged.patch.contains("+hello"));
        git.commit(root, "Initial fixture").expect("commit");
        let preview = git.push_preview(root).expect("preview");
        assert_eq!(preview.branch, "main");
        assert!(!preview.force);
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
}
