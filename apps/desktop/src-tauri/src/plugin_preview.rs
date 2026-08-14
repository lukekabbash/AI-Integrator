//! Remote preview for curated plugin installs.
//!
//! Fetches the real skill list from GitHub (via the same `gh` CLI path
//! installs already use) before the user commits to anything, so "View &
//! install" shows the actual catalog — names, descriptions — rather than a
//! marketing summary. Bounded and read-only: no clone, nothing written.

use std::sync::{Mutex, mpsc};

use integrator_runtime::GithubCliService;
use serde::Serialize;

use crate::command_api::{CommandError, CommandResult};
use crate::native_actions::parse_frontmatter;

/// A defensive backstop, not a practical limit — every catalog seen so far
/// (the largest is nvidia/skills at 242) fits comfortably under this. The
/// point is showing the user the real, complete list before they install,
/// not a curated sample of it.
const MAX_PREVIEW_SKILLS: usize = 600;
const PREVIEW_WORKERS: usize = 10;
const MAX_DESCRIPTION_CHARS: usize = 220;
/// A single skill body fetched on demand ("view full prompt"); the same
/// generous, defensive-only bound as the local skill-body reader.
const MAX_SKILL_BODY_CHARS: usize = 256 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkillPreview {
    pub name: String,
    pub description: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkillsPreview {
    pub skills: Vec<RemoteSkillPreview>,
    pub total_found: usize,
    pub truncated: bool,
}

#[tauri::command]
pub async fn integrator_skills_preview(repository: String) -> CommandResult<RemoteSkillsPreview> {
    tauri::async_runtime::spawn_blocking(move || preview_repository(&repository))
        .await
        .map_err(|_| CommandError {
            code: "unavailable",
            message: "plugin preview worker failed".into(),
        })?
}

fn preview_repository(repository: &str) -> CommandResult<RemoteSkillsPreview> {
    let github = GithubCliService::discover().ok_or_else(|| CommandError {
        code: "provider-unavailable",
        message: "GitHub CLI is not installed; install gh to preview plugins".into(),
    })?;
    let mut paths = github
        .repository_skill_paths(repository)
        .map_err(CommandError::from)?;
    let total_found = paths.len();
    let truncated = total_found > MAX_PREVIEW_SKILLS;
    paths.truncate(MAX_PREVIEW_SKILLS);
    let batch_len = paths.len();

    let queue = Mutex::new(paths.into_iter());
    let (sender, receiver) = mpsc::channel();
    std::thread::scope(|scope| {
        for _ in 0..PREVIEW_WORKERS.min(batch_len) {
            let queue = &queue;
            let sender = sender.clone();
            let github = &github;
            scope.spawn(move || {
                loop {
                    let path = { queue.lock().expect("preview queue lock").next() };
                    let Some(path) = path else { break };
                    let result = github.raw_file_content(repository, &path);
                    let _ = sender.send((path, result));
                }
            });
        }
        drop(sender);
    });

    let mut skills: Vec<RemoteSkillPreview> = receiver
        .into_iter()
        .filter_map(|(path, result)| {
            let content = result.ok()?;
            let frontmatter = parse_frontmatter(&content);
            let fallback = std::path::Path::new(&path)
                .parent()
                .and_then(std::path::Path::file_name)
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            let name = frontmatter.get("name").cloned().unwrap_or(fallback);
            let description = frontmatter
                .get("description")
                .map(|value| value.chars().take(MAX_DESCRIPTION_CHARS).collect())
                .unwrap_or_else(|| "No description provided.".into());
            Some(RemoteSkillPreview {
                name,
                description,
                path,
            })
        })
        .collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));

    if skills.is_empty() && batch_len > 0 {
        return Err(CommandError {
            code: "unavailable",
            message: "Could not read any skill files from GitHub; check your connection or run \
                       gh auth login."
                .into(),
        });
    }

    Ok(RemoteSkillsPreview {
        skills,
        total_found,
        truncated,
    })
}

/// One remote skill's full raw SKILL.md content, fetched on demand when the
/// user explicitly opens it — never fetched in bulk during the list preview.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkillBody {
    pub name: String,
    pub body: String,
    pub truncated: bool,
}

#[tauri::command]
pub async fn integrator_skill_preview_body(
    repository: String,
    path: String,
) -> CommandResult<RemoteSkillBody> {
    tauri::async_runtime::spawn_blocking(move || {
        if !path.ends_with("SKILL.md") {
            return Err(CommandError {
                code: "invalid-input",
                message: "Only SKILL.md files can be previewed.".into(),
            });
        }
        let github = GithubCliService::discover().ok_or_else(|| CommandError {
            code: "provider-unavailable",
            message: "GitHub CLI is not installed; install gh to preview plugins".into(),
        })?;
        let content = github
            .raw_file_content(&repository, &path)
            .map_err(CommandError::from)?;
        let frontmatter = parse_frontmatter(&content);
        let fallback = std::path::Path::new(&path)
            .parent()
            .and_then(std::path::Path::file_name)
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        let name = frontmatter.get("name").cloned().unwrap_or(fallback);
        let truncated = content.len() > MAX_SKILL_BODY_CHARS;
        let body = if truncated {
            content.chars().take(MAX_SKILL_BODY_CHARS).collect()
        } else {
            content
        };
        Ok(RemoteSkillBody {
            name,
            body,
            truncated,
        })
    })
    .await
    .map_err(|_| CommandError {
        code: "unavailable",
        message: "skill preview worker failed".into(),
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exercises the real pipeline against a live repository: tree listing,
    /// concurrent raw-content fetch, and frontmatter parsing. Network- and
    /// `gh`-auth-dependent, so it stays out of the default test run.
    #[test]
    #[ignore = "hits the live GitHub API via gh; run explicitly with --ignored"]
    fn preview_reads_real_skills_from_github() {
        let preview = preview_repository("openai/skills").expect("preview should succeed");
        assert!(preview.total_found > 0, "expected at least one SKILL.md");
        assert!(
            !preview.skills.is_empty(),
            "expected at least one skill to be fetched and parsed"
        );
        for skill in &preview.skills {
            assert!(!skill.name.is_empty());
            assert!(!skill.description.is_empty());
            assert!(skill.path.ends_with("SKILL.md"));
        }
        // Sorted by name.
        let mut sorted = preview.skills.clone();
        sorted.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(
            preview.skills.iter().map(|s| &s.name).collect::<Vec<_>>(),
            sorted.iter().map(|s| &s.name).collect::<Vec<_>>()
        );
    }
}
