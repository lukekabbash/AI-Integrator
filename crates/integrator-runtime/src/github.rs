use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use integrator_core::{IntegratorError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::safe_process::{redact_text, run_bounded_with_limits};

const MAX_GITHUB_OUTPUT_BYTES: u64 = 4 * 1024 * 1024;
const GITHUB_TIMEOUT: Duration = Duration::from_secs(60);
const GITHUB_NETWORK_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepository {
    pub name: String,
    pub name_with_owner: String,
    pub owner: String,
    pub description: Option<String>,
    pub private: bool,
    pub archived: bool,
    pub pushed_at: Option<String>,
    pub url: String,
    pub ssh_url: String,
    pub default_branch: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepositoryCatalog {
    pub installed: bool,
    pub authenticated: bool,
    pub account: Option<String>,
    pub hostname: Option<String>,
    pub repositories: Vec<GithubRepository>,
    pub detail: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GithubVisibility {
    Private,
    Public,
    Internal,
}

#[derive(Clone, Debug)]
pub struct GithubCliService {
    executable: PathBuf,
}

impl GithubCliService {
    pub fn discover() -> Option<Self> {
        which::which("gh")
            .ok()
            .map(|executable| Self { executable })
    }

    pub fn catalog(&self) -> Result<GithubRepositoryCatalog> {
        let auth = self.output(
            &["auth", "status", "--active", "--json", "hosts"],
            GITHUB_TIMEOUT,
        )?;
        if !auth.success {
            return Ok(GithubRepositoryCatalog {
                installed: true,
                authenticated: false,
                account: None,
                hostname: None,
                repositories: Vec::new(),
                detail: Some("GitHub CLI is installed but is not signed in.".into()),
            });
        }
        let auth_json: Value = serde_json::from_str(&auth.stdout)?;
        let active = auth_json
            .get("hosts")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|hosts| hosts.iter())
            .flat_map(|(host, accounts)| {
                accounts
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(move |account| (host, account))
            })
            .find(|(_, account)| {
                account.get("active").and_then(Value::as_bool) == Some(true)
                    && account.get("state").and_then(Value::as_str) == Some("success")
            });
        let Some((hostname, account)) = active else {
            return Ok(GithubRepositoryCatalog {
                installed: true,
                authenticated: false,
                account: None,
                hostname: None,
                repositories: Vec::new(),
                detail: Some("GitHub CLI has no active authenticated account.".into()),
            });
        };
        let login = account
            .get("login")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let host = hostname.to_owned();
        let repos = self.output(
            &[
                "api",
                "--hostname",
                &host,
                "--method",
                "GET",
                "user/repos",
                "-f",
                "per_page=100",
                "-f",
                "sort=pushed",
                "-f",
                "affiliation=owner,collaborator,organization_member",
            ],
            GITHUB_NETWORK_TIMEOUT,
        )?;
        if !repos.success {
            return Ok(GithubRepositoryCatalog {
                installed: true,
                authenticated: true,
                account: login,
                hostname: Some(host),
                repositories: Vec::new(),
                detail: Some(redact_text(&repos.stderr)),
            });
        }
        let values: Vec<Value> = serde_json::from_str(&repos.stdout)?;
        let repositories = values
            .into_iter()
            .filter_map(parse_repository)
            .filter(|repository| !repository.archived)
            .collect();
        Ok(GithubRepositoryCatalog {
            installed: true,
            authenticated: true,
            account: login,
            hostname: Some(host),
            repositories,
            detail: None,
        })
    }

    pub fn clone_repository(&self, repository: &str, destination: &Path) -> Result<()> {
        validate_repository_name(repository)?;
        validate_destination(destination)?;
        let parent = destination.parent().expect("validated clone parent");
        let folder = destination
            .file_name()
            .expect("validated clone folder")
            .to_string_lossy()
            .into_owned();
        self.required(
            &["repo", "clone", repository.trim(), &folder],
            parent,
            GITHUB_NETWORK_TIMEOUT,
        )?;
        Ok(())
    }

    pub fn publish_repository(
        &self,
        repository: &Path,
        name_with_owner: &str,
        visibility: GithubVisibility,
        remote: &str,
    ) -> Result<()> {
        validate_repository_name(name_with_owner)?;
        validate_remote_name(remote)?;
        let source = repository.to_string_lossy().into_owned();
        let visibility = match visibility {
            GithubVisibility::Private => "--private",
            GithubVisibility::Public => "--public",
            GithubVisibility::Internal => "--internal",
        };
        self.required(
            &[
                "repo",
                "create",
                name_with_owner.trim(),
                visibility,
                "--source",
                &source,
                "--remote",
                remote.trim(),
            ],
            repository,
            GITHUB_NETWORK_TIMEOUT,
        )?;
        Ok(())
    }

    /// Every `SKILL.md` path in a repository's default branch, sorted. Used
    /// to preview a plugin's real catalog before installing anything.
    pub fn repository_skill_paths(&self, repository: &str) -> Result<Vec<String>> {
        validate_repository_name(repository)?;
        let url = format!("repos/{}/git/trees/HEAD?recursive=1", repository.trim());
        let output = self.output(&["api", &url], GITHUB_NETWORK_TIMEOUT)?;
        if !output.success {
            return Err(IntegratorError::Unavailable(redact_text(&output.stderr)));
        }
        let parsed: Value = serde_json::from_str(&output.stdout)?;
        let tree = parsed
            .get("tree")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut paths: Vec<String> = tree
            .into_iter()
            .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("blob"))
            .filter_map(|entry| entry.get("path").and_then(Value::as_str).map(str::to_owned))
            .filter(|path| path.ends_with("SKILL.md"))
            .collect();
        paths.sort();
        paths.truncate(2_000);
        Ok(paths)
    }

    /// One file's raw text content via the Contents API's raw media type
    /// (no base64 decoding needed). `path` must come from a trusted listing
    /// such as [`Self::repository_skill_paths`].
    pub fn raw_file_content(&self, repository: &str, path: &str) -> Result<String> {
        validate_repository_name(repository)?;
        if path.is_empty() || path.len() > 500 || path.contains("..") || path.contains('\0') {
            return Err(IntegratorError::InvalidInput("invalid file path".into()));
        }
        let url = format!("repos/{}/contents/{path}", repository.trim());
        let output = self.output(
            &["api", "-H", "Accept: application/vnd.github.raw", &url],
            GITHUB_TIMEOUT,
        )?;
        if !output.success {
            return Err(IntegratorError::Unavailable(redact_text(&output.stderr)));
        }
        Ok(output.stdout)
    }

    fn required(&self, args: &[&str], cwd: &Path, timeout: Duration) -> Result<String> {
        let output = run_bounded_with_limits(
            &self.executable,
            args,
            Some(cwd),
            MAX_GITHUB_OUTPUT_BYTES,
            timeout,
        )?;
        if output.stdout_truncated || output.stderr_truncated {
            return Err(IntegratorError::Unavailable(
                "GitHub CLI output exceeded the local safety limit".into(),
            ));
        }
        if !output.success {
            return Err(IntegratorError::Unavailable(redact_text(
                if output.stderr.trim().is_empty() {
                    &output.stdout
                } else {
                    &output.stderr
                },
            )));
        }
        Ok(output.stdout)
    }

    fn output(
        &self,
        args: &[&str],
        timeout: Duration,
    ) -> Result<crate::safe_process::ProcessOutput> {
        let cwd = std::env::current_dir().map_err(IntegratorError::Io)?;
        run_bounded_with_limits(
            &self.executable,
            args,
            Some(&cwd),
            MAX_GITHUB_OUTPUT_BYTES,
            timeout,
        )
    }
}

fn parse_repository(value: Value) -> Option<GithubRepository> {
    Some(GithubRepository {
        name: value.get("name")?.as_str()?.to_owned(),
        name_with_owner: value.get("full_name")?.as_str()?.to_owned(),
        owner: value.get("owner")?.get("login")?.as_str()?.to_owned(),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned),
        private: value.get("private")?.as_bool()?,
        archived: value.get("archived")?.as_bool()?,
        pushed_at: value
            .get("pushed_at")
            .and_then(Value::as_str)
            .map(str::to_owned),
        url: value.get("html_url")?.as_str()?.to_owned(),
        ssh_url: value.get("ssh_url")?.as_str()?.to_owned(),
        default_branch: value
            .get("default_branch")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn validate_repository_name(value: &str) -> Result<()> {
    let mut parts = value.trim().split('/');
    let valid_part = |part: &str| {
        !part.is_empty()
            && part.len() <= 100
            && !part.starts_with('-')
            && part
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    };
    if !parts.next().is_some_and(valid_part)
        || !parts.next().is_some_and(valid_part)
        || parts.next().is_some()
    {
        return Err(IntegratorError::InvalidInput(
            "GitHub repository must use owner/name format".into(),
        ));
    }
    Ok(())
}

fn validate_remote_name(value: &str) -> Result<()> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 240
        || value.starts_with('-')
        || value.chars().any(char::is_whitespace)
    {
        return Err(IntegratorError::InvalidInput(
            "invalid Git remote name".into(),
        ));
    }
    Ok(())
}

fn validate_destination(path: &Path) -> Result<()> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_names_are_narrowly_valid() {
        assert!(validate_repository_name("openai/codex").is_ok());
        assert!(validate_repository_name("-danger/codex").is_err());
        assert!(validate_repository_name("openai/codex/extra").is_err());
        assert!(validate_repository_name("https://github.com/openai/codex").is_err());
    }

    #[test]
    fn repository_json_is_reduced_to_safe_display_metadata() {
        let repository = parse_repository(serde_json::json!({
            "name": "codex",
            "full_name": "openai/codex",
            "owner": { "login": "openai" },
            "description": "Agent",
            "private": false,
            "archived": false,
            "pushed_at": "2026-07-14T12:00:00Z",
            "html_url": "https://github.com/openai/codex",
            "ssh_url": "git@github.com:openai/codex.git",
            "default_branch": "main",
            "token": "must-not-cross"
        }))
        .expect("repository metadata");
        assert_eq!(repository.name_with_owner, "openai/codex");
        assert_eq!(repository.default_branch.as_deref(), Some("main"));
    }
}
