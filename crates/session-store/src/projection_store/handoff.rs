use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
};

use integrator_core::{Result, TaskId};
use rusqlite::{OptionalExtension, params};

use super::{LocalStore, boundary_at_or_after, boundary_at_or_before, storage_error};

/// Default handoff window: last N turns from shared task projections.
pub const HANDOFF_DEFAULT_MAX_TURNS: usize = 10;
/// ~16k tokens at chars/4 for fresh-session primers across any provider.
/// Deliberately lean: the primer enters the provider's history forever, so
/// every extra token here is re-billed on all later turns of the session.
pub const HANDOFF_DEFAULT_MAX_TOKENS: usize = 16_000;
/// Bound vision reattachment cost on the primed turn.
pub const HANDOFF_DEFAULT_MAX_IMAGES: usize = 4;
/// Child/orchestrator digests stay tighter so briefs remain focused.
pub const HANDOFF_CHILD_MAX_TOKENS: usize = 8_000;

const HANDOFF_USER_CLIP: usize = 3_000;
const HANDOFF_ASSISTANT_CLIP: usize = 4_000;
const HANDOFF_READ_CLIP: usize = 4_000;
const HANDOFF_COMMAND_OUTPUT_CLIP: usize = 1_024;
const HANDOFF_NOISY_OUTPUT_THRESHOLD: usize = 8_192;

/// Options for [`LocalStore::task_handoff_digest`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HandoffDigestOptions {
    pub max_tokens: usize,
    pub max_turns: usize,
    pub max_images: usize,
}

impl Default for HandoffDigestOptions {
    fn default() -> Self {
        Self {
            max_tokens: HANDOFF_DEFAULT_MAX_TOKENS,
            max_turns: HANDOFF_DEFAULT_MAX_TURNS,
            max_images: HANDOFF_DEFAULT_MAX_IMAGES,
        }
    }
}

impl HandoffDigestOptions {
    #[must_use]
    pub fn for_child() -> Self {
        Self {
            max_tokens: HANDOFF_CHILD_MAX_TOKENS,
            max_turns: HANDOFF_DEFAULT_MAX_TURNS,
            max_images: HANDOFF_DEFAULT_MAX_IMAGES,
        }
    }

    /// Legacy byte-budget callers: treat bytes as an approximate char budget.
    #[must_use]
    pub fn from_max_bytes(max_bytes: usize) -> Self {
        Self {
            max_tokens: (max_bytes / 4).max(1),
            ..Self::default()
        }
    }
}

/// Provider-neutral handoff package built from shared SQLite task projections.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HandoffDigest {
    pub text: String,
    pub image_paths: Vec<PathBuf>,
}

impl LocalStore {
    /// Render the task's shared SQLite projections (any provider) as a bounded
    /// handoff package for a freshly created native session.
    pub fn task_handoff_digest(
        &self,
        task_id: TaskId,
        options: HandoffDigestOptions,
    ) -> Result<Option<HandoffDigest>> {
        let connection = self.connection.lock();
        let edit_context = connection
            .query_row(
                "SELECT body FROM task_edit_context WHERE task_id = ?1",
                [task_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?;

        let max_turns = options.max_turns.max(1);
        let mut turn_statement = connection
            .prepare(
                "SELECT turn_id, MAX(last_event_seq) AS tip
                 FROM integrator_items
                 WHERE task_id = ?1
                 GROUP BY turn_id
                 ORDER BY tip DESC
                 LIMIT ?2",
            )
            .map_err(storage_error)?;
        let turn_ids: Vec<String> = turn_statement
            .query_map(params![task_id.to_string(), max_turns as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(storage_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        let turn_set: HashSet<&str> = turn_ids.iter().map(String::as_str).collect();

        let mut item_statement = connection
            .prepare(
                "SELECT turn_id, kind, title, body, command_text, output, exit_code,
                        file_changes_json, mcp_server, mcp_tool, projection_json, last_event_seq
                 FROM integrator_items
                 WHERE task_id = ?1
                 ORDER BY last_event_seq ASC",
            )
            .map_err(storage_error)?;
        let item_rows: Vec<DigestItemRow> = item_statement
            .query_map([task_id.to_string()], |row| {
                Ok(DigestItemRow {
                    turn_id: row.get(0)?,
                    kind: row.get(1)?,
                    title: row.get(2)?,
                    body: row.get(3)?,
                    command_text: row.get(4)?,
                    output: row.get(5)?,
                    exit_code: row.get(6)?,
                    file_changes_json: row.get(7)?,
                    mcp_server: row.get(8)?,
                    mcp_tool: row.get(9)?,
                    projection_json: row.get(10)?,
                    last_event_seq: row.get(11)?,
                })
            })
            .map_err(storage_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage_error)?
            .into_iter()
            .filter(|row| turn_set.contains(row.turn_id.as_str()))
            .collect();

        drop(turn_statement);
        drop(item_statement);
        drop(connection);

        if item_rows.is_empty()
            && edit_context
                .as_ref()
                .is_none_or(|body| body.trim().is_empty())
        {
            return Ok(None);
        }

        // Newest turns first for budget fill; turn_ids came DESC by tip.
        let turn_rank: HashMap<String, usize> = turn_ids
            .iter()
            .enumerate()
            .map(|(index, id)| (id.clone(), index))
            .collect();

        let mut by_turn: BTreeMap<usize, Vec<DigestItemRow>> = BTreeMap::new();
        for row in item_rows {
            let rank = turn_rank.get(&row.turn_id).copied().unwrap_or(usize::MAX);
            by_turn.entry(rank).or_default().push(row);
        }

        let max_chars = options.max_tokens.saturating_mul(4).max(1);
        let mut packed_turns: Vec<Vec<String>> = Vec::new();
        let mut used = 0_usize;
        let mut image_candidates: Vec<(i64, PathBuf)> = Vec::new();
        let mut missing_images: Vec<String> = Vec::new();

        // Fill newest-first (rank 0 first), then reverse for chronological text.
        for (_rank, rows) in by_turn {
            let mut turn_lines = Vec::new();
            for row in rows {
                if row.kind == "user_message" {
                    let body = row.body.as_deref().unwrap_or("");
                    for path in extract_attachment_paths(body) {
                        if is_image_path(&path) {
                            if path.is_file() {
                                image_candidates.push((row.last_event_seq, path));
                            } else {
                                missing_images.push(path.display().to_string());
                            }
                        }
                    }
                }
                if let Some(line) = format_digest_line(&row) {
                    turn_lines.push(line);
                }
            }
            if turn_lines.is_empty() {
                continue;
            }
            let block = turn_lines.join("\n\n");
            if used + block.len() > max_chars {
                if packed_turns.is_empty() {
                    // Always keep a clipped slice of the newest turn.
                    let clipped = clip_chars(&block, max_chars);
                    if !clipped.is_empty() {
                        packed_turns.push(vec![clipped]);
                        used = max_chars;
                    }
                }
                break;
            }
            used += block.len() + if packed_turns.is_empty() { 0 } else { 2 };
            packed_turns.push(turn_lines);
        }

        packed_turns.reverse();
        let mut lines: Vec<String> = packed_turns.into_iter().flatten().collect();

        if let Some(salvage) = edit_context {
            let salvage = salvage.trim();
            if !salvage.is_empty() {
                let header = "Assistant replies discarded by a later edit (kept as context):";
                let block = format!("{header}\n\n{salvage}");
                if used + block.len() <= max_chars {
                    used += block.len();
                    lines.push(block);
                } else if used < max_chars {
                    let budget = max_chars.saturating_sub(used + header.len() + 4);
                    if budget > 0 {
                        let clipped = clip_chars(salvage, budget);
                        if !clipped.is_empty() {
                            lines.push(format!("{header}\n\n{clipped}…"));
                        }
                    }
                }
            }
        }

        // Dedupe images newest-last, keep last N existing files.
        image_candidates.sort_by_key(|(seq, _)| *seq);
        let mut seen = HashSet::new();
        let mut image_paths = Vec::new();
        for (_, path) in image_candidates.into_iter().rev() {
            let key = path.to_string_lossy().to_string();
            if !seen.insert(key) {
                continue;
            }
            image_paths.push(path);
            if image_paths.len() >= options.max_images {
                break;
            }
        }
        image_paths.reverse();

        missing_images.sort();
        missing_images.dedup();
        if !missing_images.is_empty() {
            let note = format!(
                "Images referenced but missing on disk: {}",
                missing_images.join(", ")
            );
            if used + note.len() <= max_chars {
                lines.push(note);
            }
        }

        if lines.is_empty() && image_paths.is_empty() {
            return Ok(None);
        }
        if lines.is_empty() {
            lines.push("Prior turns included image attachments only.".into());
        }
        Ok(Some(HandoffDigest {
            text: lines.join("\n\n"),
            image_paths,
        }))
    }

    /// Backward-compatible text-only digest (char budget approximated as tokens).
    pub fn task_conversation_digest(
        &self,
        task_id: TaskId,
        max_bytes: usize,
    ) -> Result<Option<String>> {
        Ok(self
            .task_handoff_digest(task_id, HandoffDigestOptions::from_max_bytes(max_bytes))?
            .map(|digest| digest.text))
    }
}

struct DigestItemRow {
    turn_id: String,
    kind: String,
    title: Option<String>,
    body: Option<String>,
    command_text: Option<String>,
    output: Option<String>,
    exit_code: Option<i64>,
    file_changes_json: Option<String>,
    mcp_server: Option<String>,
    mcp_tool: Option<String>,
    projection_json: Option<String>,
    last_event_seq: i64,
}

fn strip_handoff_primer(text: &str) -> &str {
    const OPEN: &str = "<conversation-context>";
    const CLOSE: &str = "</conversation-context>";
    let trimmed = text.trim_start();
    if let Some(rest) = trimmed.strip_prefix(OPEN)
        && let Some(end) = rest.find(CLOSE)
    {
        return rest[end + CLOSE.len()..].trim_start();
    }
    text
}

fn clip_chars(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_owned();
    }
    let mut boundary = max.min(value.len());
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    let mut clipped = value[..boundary].to_owned();
    if !clipped.is_empty() {
        clipped.push('…');
    }
    clipped
}

fn clip_head_tail(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_owned();
    }
    let head = max / 2;
    let tail = max.saturating_sub(head + 16);
    let head_end = boundary_at_or_before(value, head);
    let tail_start = boundary_at_or_after(value, value.len().saturating_sub(tail));
    format!(
        "{}\n…[truncated {} chars]…\n{}",
        &value[..head_end],
        value
            .len()
            .saturating_sub(head_end + (value.len() - tail_start)),
        &value[tail_start..]
    )
}

fn tool_input_from_projection(projection_json: &Option<String>) -> Option<String> {
    let json = projection_json.as_deref()?;
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    value
        .get("toolInput")
        .or_else(|| value.get("tool_input"))
        .and_then(|v| {
            v.as_str()
                .map(str::to_owned)
                .or_else(|| serde_json::to_string(v).ok())
        })
}

fn looks_like_web_or_browse(label: &str) -> bool {
    let lower = label.to_ascii_lowercase();
    [
        "websearch",
        "web_search",
        "webfetch",
        "web_fetch",
        "browser",
        "search_web",
        "googlesearch",
        "duckduckgo",
        "fetch_url",
        "open_url",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn looks_like_file_read(label: &str, input: &str) -> bool {
    let hay = format!("{label} {input}").to_ascii_lowercase();
    [
        "read",
        "read_file",
        "readfile",
        "view",
        "cat ",
        "file_view",
        "open_file",
        "get_file",
        "preview",
    ]
    .iter()
    .any(|needle| hay.contains(needle))
}

fn extract_attachment_paths(body: &str) -> Vec<PathBuf> {
    let Some(index) = body.rfind("Attached files:\n") else {
        return Vec::new();
    };
    // Require start-of-body or blank line before the marker (matches UI parser).
    if index > 0 && !body[..index].ends_with("\n\n") {
        return Vec::new();
    }
    body[index + "Attached files:\n".len()..]
        .lines()
        .filter_map(|line| {
            let path = line.strip_prefix("- ")?.trim();
            (!path.is_empty()).then(|| PathBuf::from(path))
        })
        .collect()
}

fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico" | "avif"
            )
        })
        .unwrap_or(false)
}

fn format_file_changes(json: &str) -> Option<String> {
    let changes: Vec<serde_json::Value> = serde_json::from_str(json).ok()?;
    if changes.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for change in changes.iter().take(24) {
        let path = change.get("path").and_then(|v| v.as_str()).unwrap_or("?");
        let kind = change
            .get("changeKind")
            .or_else(|| change.get("change_kind"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        parts.push(format!("{kind} {path}"));
    }
    if changes.len() > 24 {
        parts.push(format!("…+{} more", changes.len() - 24));
    }
    Some(format!("File changes: {}", parts.join("; ")))
}

fn format_digest_line(row: &DigestItemRow) -> Option<String> {
    match row.kind.as_str() {
        "reasoning_summary" | "unknown" => None,
        "user_message" => {
            let text = strip_handoff_primer(row.body.as_deref().unwrap_or("")).trim();
            if text.is_empty() {
                return None;
            }
            Some(format!("User: {}", clip_chars(text, HANDOFF_USER_CLIP)))
        }
        "agent_message" => {
            let text = row
                .body
                .as_deref()
                .or(row.title.as_deref())
                .unwrap_or("")
                .trim();
            if text.is_empty() {
                return None;
            }
            Some(format!(
                "Assistant: {}",
                clip_chars(text, HANDOFF_ASSISTANT_CLIP)
            ))
        }
        "file_change" => row
            .file_changes_json
            .as_deref()
            .and_then(format_file_changes),
        "command_execution" => {
            let command = row.command_text.as_deref().unwrap_or("command").trim();
            let exit = row
                .exit_code
                .map(|code| format!(" exit={code}"))
                .unwrap_or_default();
            let output = row.output.as_deref().unwrap_or("").trim();
            if output.is_empty() {
                Some(format!("Command: `{command}`{exit}"))
            } else if output.len() > HANDOFF_NOISY_OUTPUT_THRESHOLD {
                Some(format!(
                    "Command: `{command}`{exit} → {} chars truncated",
                    output.len()
                ))
            } else {
                Some(format!(
                    "Command: `{command}`{exit}\n{}",
                    clip_chars(output, HANDOFF_COMMAND_OUTPUT_CLIP)
                ))
            }
        }
        "mcp_tool" => {
            let tool = row
                .mcp_tool
                .as_deref()
                .or(row.title.as_deref())
                .unwrap_or("tool");
            let server = row.mcp_server.as_deref().unwrap_or("");
            let label = if server.is_empty() {
                tool.to_owned()
            } else {
                format!("{server} · {tool}")
            };
            let input = tool_input_from_projection(&row.projection_json).unwrap_or_default();
            let output = row
                .output
                .as_deref()
                .or(row.body.as_deref())
                .unwrap_or("")
                .trim();

            if looks_like_web_or_browse(&label) || looks_like_web_or_browse(&input) {
                let query = clip_chars(input.trim(), 120);
                let query = if query.is_empty() {
                    "…".into()
                } else {
                    query
                };
                return Some(format!(
                    "WebSearch/browse ({label}): \"{query}\" → {} chars truncated",
                    output.len()
                ));
            }

            if looks_like_file_read(&label, &input) {
                let path_hint = clip_chars(input.trim(), 200);
                let meat = if output.is_empty() {
                    "(empty)".into()
                } else {
                    clip_head_tail(output, HANDOFF_READ_CLIP)
                };
                return Some(if path_hint.is_empty() {
                    format!("Read ({label}):\n{meat}")
                } else {
                    format!("Read ({label}): {path_hint}\n{meat}")
                });
            }

            if output.len() > HANDOFF_NOISY_OUTPUT_THRESHOLD {
                return Some(format!("Tool ({label}): {} chars truncated", output.len()));
            }
            if output.is_empty() {
                let input_clip = clip_chars(input.trim(), 200);
                return Some(if input_clip.is_empty() {
                    format!("Tool ({label})")
                } else {
                    format!("Tool ({label}): {input_clip}")
                });
            }
            Some(format!(
                "Tool ({label}):\n{}",
                clip_chars(output, HANDOFF_COMMAND_OUTPUT_CLIP)
            ))
        }
        _ => {
            let text = row
                .body
                .as_deref()
                .or(row.output.as_deref())
                .or(row.title.as_deref())
                .unwrap_or("")
                .trim();
            if text.is_empty() {
                None
            } else {
                Some(format!("{}: {}", row.kind, clip_chars(text, 700)))
            }
        }
    }
}
