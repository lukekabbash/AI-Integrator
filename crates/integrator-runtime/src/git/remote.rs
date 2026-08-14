use super::*;

impl GitService {
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

    pub(super) fn push_preview_from_status(
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
}
