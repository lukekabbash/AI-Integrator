use super::*;

impl GitService {
    pub fn discover() -> Result<Self> {
        let executable = which::which("git")
            .map_err(|_| IntegratorError::Unavailable("git is not installed".into()))?;
        Ok(Self { executable })
    }

    pub(super) fn read_status(
        &self,
        repository: &Path,
        include_files: bool,
    ) -> Result<PorcelainStatus> {
        let untracked = if include_files { "all" } else { "no" };
        let untracked_arg = format!("--untracked-files={untracked}");
        let output = self.required(
            repository,
            &["status", "--porcelain=v2", "--branch", "-z", &untracked_arg],
        )?;
        Ok(parse_porcelain_v2(&output, include_files))
    }

    pub(super) fn required(&self, cwd: &Path, args: &[&str]) -> Result<String> {
        self.required_with_timeout(cwd, args, GIT_TIMEOUT)
    }

    pub(super) fn required_with_timeout(
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

    pub(super) fn optional(&self, cwd: &Path, args: &[&str]) -> Result<Option<String>> {
        let output = self.output(cwd, args, GIT_TIMEOUT)?;
        if output.stdout_truncated || output.stderr_truncated {
            return Err(IntegratorError::Git(
                "Git output exceeded the local safety limit".into(),
            ));
        }
        Ok(output.success.then_some(output.stdout))
    }

    pub(super) fn output(
        &self,
        cwd: &Path,
        args: &[&str],
        timeout: Duration,
    ) -> Result<ProcessOutput> {
        run_bounded_with_limits(
            &self.executable,
            args,
            Some(cwd),
            MAX_GIT_OUTPUT_BYTES,
            timeout,
        )
    }
}

pub(super) fn git_failure(output: ProcessOutput) -> IntegratorError {
    let message = if output.stderr.trim().is_empty() {
        output.stdout
    } else {
        output.stderr
    };
    IntegratorError::Git(redact_text(&message))
}
