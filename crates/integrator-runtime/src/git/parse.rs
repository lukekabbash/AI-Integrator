use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use super::{FileStatus, HistoryCommit, PorcelainStatus, WorktreeInfo};

pub(super) fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

pub(super) fn parse_worktrees(output: &str) -> Vec<WorktreeInfo> {
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

pub(super) fn parse_counts(value: &str) -> (u64, u64) {
    let mut parts = value
        .split_whitespace()
        .filter_map(|part| part.parse::<u64>().ok());
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

/// One record per line; fields NUL-separated: abbreviated hash, subject,
/// relative time, abbreviated parent hashes, and ref decorations.
pub(super) const HISTORY_FORMAT: &str = "%h%x00%s%x00%cr%x00%p%x00%D";

pub(super) fn parse_history(output: &str) -> Vec<HistoryCommit> {
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

pub(super) fn parse_porcelain_v2(output: &str, include_files: bool) -> PorcelainStatus {
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
pub(super) fn parse_numstat(output: &str) -> HashMap<PathBuf, (Option<u64>, Option<u64>)> {
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
pub(super) fn count_untracked_lines(repository: &Path, path: &Path) -> Option<u64> {
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

pub(super) fn sanitize_remote_url(value: &str) -> String {
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
