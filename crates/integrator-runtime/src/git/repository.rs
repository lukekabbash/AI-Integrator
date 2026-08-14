use super::*;

impl GitService {
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
    pub(super) fn annotate_line_stats(&self, repository: &Path, files: &mut [FileStatus]) {
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
}
