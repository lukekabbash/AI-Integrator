use super::*;

impl GitService {
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
    pub(super) fn annotate_unpushed(
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
}
