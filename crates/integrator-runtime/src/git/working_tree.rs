use super::*;

impl GitService {
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
        // Tracked files that live under an ignored directory (rule added after
        // the files were committed) make plain `git add <path>` fail with
        // "paths are ignored". `add --update` walks the index instead of the
        // working tree, so it stages those without `--force`. Untracked paths
        // still go through plain `add`, which keeps ignored files out.
        let mut ls_args = vec!["ls-files", "-z", "--"];
        ls_args.extend(strings.iter().map(String::as_str));
        let tracked_listing = self.required(repository, &ls_args)?;
        let tracked: std::collections::HashSet<&str> = tracked_listing
            .split('\0')
            .filter(|entry| !entry.is_empty())
            .collect();
        let (tracked_paths, other_paths): (Vec<&str>, Vec<&str>) =
            strings.iter().map(String::as_str).partition(|path| {
                let path = path.replace('\\', "/");
                let path = path.trim_end_matches('/');
                tracked.contains(path)
                    || tracked.iter().any(|entry| {
                        entry
                            .strip_prefix(path)
                            .is_some_and(|rest| rest.starts_with('/'))
                    })
            });
        if !tracked_paths.is_empty() {
            let mut args = vec!["add", "--update", "--"];
            args.extend(tracked_paths.iter().copied());
            self.required(repository, &args)?;
        }
        if !other_paths.is_empty() {
            let mut args = vec!["add", "--"];
            args.extend(other_paths.iter().copied());
            self.required(repository, &args)?;
        }
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
}
