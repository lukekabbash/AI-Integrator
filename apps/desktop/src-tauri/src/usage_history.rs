//! Usage history read from the installed CLIs' own local transcripts.
//!
//! Codex writes rollouts under `~/.codex/sessions/**/*.jsonl` and Claude Code
//! writes project logs under `~/.claude/projects/**/*.jsonl`. Both carry
//! per-message token usage. This module scans those files inside a time
//! window and returns hourly slices per provider and model; the renderer
//! does bucketing, pricing, and presentation. Nothing here contacts a vendor
//! and no transcript text leaves the machine — only counts.

use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;

use crate::command_api::{CommandError, CommandResult, worker_error};

const HOUR_MS: i64 = 3_600_000;
/// Files whose last write predates the window by more than this cannot hold
/// in-window lines; a day of slack covers clock skew and delayed flushes.
const MTIME_SLACK: Duration = Duration::from_secs(24 * 3_600);
/// A forked or subagent Codex rollout opens with the parent's history copied
/// in and re-stamped to the fork instant. Copies land in one burst; the first
/// genuine event follows a real model turn. One second separates them.
const FORK_COPY_MAX_GAP_MS: i64 = 1_000;
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageProvider {
    Codex,
    Claude,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub uncached_input_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_creation_tokens: u64,
    /// Subset of `cache_creation_tokens` written with a 1-hour TTL. Anthropic
    /// prices those at 2x input against 1.25x for the 5-minute default, and on
    /// a real workload most writes are the long kind — so the split is not a
    /// rounding detail.
    pub cache_creation_long_tokens: u64,
    pub output_tokens: u64,
    /// Subset of `output_tokens`; never added to the total again.
    pub reasoning_tokens: u64,
}

impl UsageTotals {
    fn is_empty(&self) -> bool {
        self.uncached_input_tokens
            + self.cached_input_tokens
            + self.cache_creation_tokens
            + self.output_tokens
            == 0
    }

    fn add(&mut self, other: &UsageTotals) {
        self.uncached_input_tokens += other.uncached_input_tokens;
        self.cached_input_tokens += other.cached_input_tokens;
        self.cache_creation_tokens += other.cache_creation_tokens;
        self.cache_creation_long_tokens += other.cache_creation_long_tokens;
        self.output_tokens += other.output_tokens;
        self.reasoning_tokens += other.reasoning_tokens;
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHistorySlice {
    pub provider: UsageProvider,
    pub model: String,
    /// Start of the UTC hour this slice belongs to (epoch ms).
    pub hour_start_ms: i64,
    #[serde(flatten)]
    pub totals: UsageTotals,
    /// Cost the vendor wrote into its own log, when it did.
    pub reported_cost_usd: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHistorySource {
    pub provider: UsageProvider,
    /// Home-relative root that was scanned, for the coverage note.
    pub root: String,
    pub status: &'static str,
    pub files_scanned: u32,
    pub files_skipped: u32,
    pub sessions: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHistoryReport {
    pub since_ms: i64,
    pub until_ms: i64,
    pub measured_at: DateTime<Utc>,
    pub slices: Vec<UsageHistorySlice>,
    pub sources: Vec<UsageHistorySource>,
}

/// One usage-bearing line, before hourly aggregation.
#[derive(Clone, Debug, PartialEq)]
pub struct UsageRecord {
    pub provider: UsageProvider,
    pub timestamp_ms: i64,
    pub model: String,
    pub session_id: String,
    pub totals: UsageTotals,
    pub reported_cost_usd: Option<f64>,
    /// Cross-file de-duplication key, or `None` when the record is unique.
    pub dedupe_key: Option<String>,
}

#[tauri::command]
pub async fn usage_history(since_ms: i64, until_ms: i64) -> CommandResult<UsageHistoryReport> {
    if until_ms <= since_ms {
        return Err(CommandError {
            code: "invalid-input",
            message: "usage window must end after it starts".into(),
        });
    }
    tauri::async_runtime::spawn_blocking(move || {
        Ok(scan_usage_history(&default_roots(), since_ms, until_ms))
    })
    .await
    .map_err(|_| worker_error())?
}

pub struct UsageRoot {
    pub provider: UsageProvider,
    pub path: PathBuf,
    pub label: String,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Where each CLI keeps its transcripts, honouring the vendors' own overrides.
pub fn default_roots() -> Vec<UsageRoot> {
    let home = home_dir();
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|h| h.join(".codex")));
    let claude_home = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|h| h.join(".claude")));
    let mut roots = Vec::new();
    if let Some(codex) = codex_home {
        roots.push(UsageRoot {
            provider: UsageProvider::Codex,
            path: codex.join("sessions"),
            label: "~/.codex/sessions".into(),
        });
    }
    if let Some(claude) = claude_home {
        roots.push(UsageRoot {
            provider: UsageProvider::Claude,
            path: claude.join("projects"),
            label: "~/.claude/projects".into(),
        });
    }
    roots
}

/// Parsed records per transcript file, keyed by path and validated against the
/// file's mtime and size. Transcripts total gigabytes; re-reading them on every
/// window change would make the settings page unusable, and a file that has
/// not changed cannot yield different records.
#[derive(Clone)]
struct CachedFile {
    modified: Option<SystemTime>,
    len: u64,
    records: Arc<[UsageRecord]>,
}

type ScanCache = HashMap<PathBuf, CachedFile>;

fn process_cache() -> &'static Mutex<ScanCache> {
    static CACHE: OnceLock<Mutex<ScanCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Scans with the process-wide cache.
pub fn scan_usage_history(roots: &[UsageRoot], since_ms: i64, until_ms: i64) -> UsageHistoryReport {
    let mut cache = process_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    scan_usage_history_with(roots, since_ms, until_ms, &mut cache)
}

fn cached_records(
    provider: UsageProvider,
    path: &Path,
    cache: &mut ScanCache,
) -> std::io::Result<Arc<[UsageRecord]>> {
    let metadata = std::fs::metadata(path)?;
    let modified = metadata.modified().ok();
    let len = metadata.len();
    if let Some(entry) = cache.get(path)
        && entry.modified == modified
        && entry.len == len
    {
        return Ok(Arc::clone(&entry.records));
    }
    let records: Arc<[UsageRecord]> = scan_file(provider, path)?.into();
    cache.insert(
        path.to_path_buf(),
        CachedFile {
            modified,
            len,
            records: Arc::clone(&records),
        },
    );
    Ok(records)
}

fn scan_usage_history_with(
    roots: &[UsageRoot],
    since_ms: i64,
    until_ms: i64,
    cache: &mut ScanCache,
) -> UsageHistoryReport {
    let mut slices: HashMap<(UsageProvider, String, i64), UsageHistorySlice> = HashMap::new();
    let mut sources = Vec::with_capacity(roots.len());
    // Claude repeats one message's usage on every content-block record;
    // dedupe by message/request id across every file of the scan.
    let mut seen_claude: HashSet<String> = HashSet::new();

    for root in roots {
        let mut source = UsageHistorySource {
            provider: root.provider,
            root: root.label.clone(),
            status: "scanned",
            files_scanned: 0,
            files_skipped: 0,
            sessions: 0,
            detail: None,
        };
        if !root.path.is_dir() {
            source.status = "missing";
            sources.push(source);
            continue;
        }
        let mut files = Vec::new();
        collect_jsonl(&root.path, &mut files, 0);
        // Deterministic order so cross-file de-duplication keeps the same copy.
        files.sort();
        let mut sessions: HashSet<String> = HashSet::new();
        for file in files {
            if !file_may_overlap(&file, since_ms) {
                source.files_skipped += 1;
                continue;
            }
            match cached_records(root.provider, &file, cache) {
                Ok(records) => {
                    source.files_scanned += 1;
                    for record in records.iter() {
                        if record.timestamp_ms < since_ms || record.timestamp_ms >= until_ms {
                            continue;
                        }
                        if let Some(key) = &record.dedupe_key
                            && !seen_claude.insert(key.clone())
                        {
                            continue;
                        }
                        if !record.session_id.is_empty() {
                            sessions.insert(record.session_id.clone());
                        }
                        let hour = record.timestamp_ms.div_euclid(HOUR_MS) * HOUR_MS;
                        let key = (record.provider, record.model.clone(), hour);
                        let slice = slices.entry(key).or_insert_with(|| UsageHistorySlice {
                            provider: record.provider,
                            model: record.model.clone(),
                            hour_start_ms: hour,
                            totals: UsageTotals::default(),
                            reported_cost_usd: None,
                        });
                        slice.totals.add(&record.totals);
                        if let Some(cost) = record.reported_cost_usd {
                            slice.reported_cost_usd =
                                Some(slice.reported_cost_usd.unwrap_or(0.0) + cost);
                        }
                    }
                }
                Err(error) => {
                    source.files_skipped += 1;
                    if source.detail.is_none() {
                        source.detail = Some(format!("{}: {error}", file.display()));
                    }
                }
            }
        }
        source.sessions = sessions.len() as u32;
        if source.files_scanned == 0 && source.detail.is_some() {
            source.status = "error";
        }
        sources.push(source);
    }

    let mut slices: Vec<UsageHistorySlice> = slices.into_values().collect();
    slices.sort_by(|a, b| {
        a.hour_start_ms
            .cmp(&b.hour_start_ms)
            .then_with(|| a.model.cmp(&b.model))
    });
    UsageHistoryReport {
        since_ms,
        until_ms,
        measured_at: Utc::now(),
        slices,
        sources,
    }
}

fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 8 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_jsonl(&path, out, depth + 1);
        } else if path.extension().is_some_and(|ext| ext == "jsonl") {
            out.push(path);
        }
    }
}

fn file_may_overlap(path: &Path, since_ms: i64) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = metadata.modified() else {
        return true;
    };
    let Ok(age) = modified.duration_since(UNIX_EPOCH) else {
        return true;
    };
    let modified_ms = age.as_millis() as i64;
    modified_ms + MTIME_SLACK.as_millis() as i64 >= since_ms
}

/// Every usage record in one transcript file, unfiltered; the caller applies
/// the window and cross-file de-duplication so cached results stay reusable.
fn scan_file(provider: UsageProvider, path: &Path) -> std::io::Result<Vec<UsageRecord>> {
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut line = String::new();
    let mut records = Vec::new();
    let mut codex_state = CodexScanState::default();
    loop {
        line.clear();
        let read = reader.read_line(&mut line)?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_LINE_BYTES || !might_carry_usage(&line, provider) {
            continue;
        }
        let record = match provider {
            UsageProvider::Codex => parse_codex_line(&line, &mut codex_state),
            UsageProvider::Claude => parse_claude_line(&line),
        };
        if let Some(record) = record {
            records.push(record);
        }
    }
    Ok(records)
}

/// Cheap substring gate applied before JSON parsing: most transcript lines are
/// tool output and never carry usage.
pub fn might_carry_usage(line: &str, provider: UsageProvider) -> bool {
    match provider {
        UsageProvider::Claude => line.contains("\"usage\""),
        UsageProvider::Codex => {
            line.contains("\"token_count\"")
                || line.contains("\"session_meta\"")
                || line.contains("\"turn_context\"")
        }
    }
}

fn parse_timestamp_ms(value: Option<&Value>) -> Option<i64> {
    let text = value?.as_str()?;
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

fn count(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::Number(number)) => number
            .as_u64()
            .or_else(|| {
                number
                    .as_f64()
                    .map(|f| if f > 0.0 { f.trunc() as u64 } else { 0 })
            })
            .unwrap_or(0),
        _ => 0,
    }
}

/* -------------------------------------------------------------------------- */
/* Claude Code                                                                */
/* -------------------------------------------------------------------------- */

/// One line of a Claude Code project log. Claude writes one record per
/// assistant content block and repeats the parent message's full `usage` on
/// each, so the caller drops repeats by `dedupe_key`.
pub fn parse_claude_line(line: &str) -> Option<UsageRecord> {
    let record: Value = serde_json::from_str(line).ok()?;
    if record.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let message = record.get("message")?.as_object()?;
    let usage = message.get("usage")?.as_object()?;
    let timestamp_ms = parse_timestamp_ms(record.get("timestamp"))?;
    let model = message.get("model")?.as_str()?.trim();
    if model.is_empty() || model.starts_with('<') {
        return None;
    }
    let message_id = message.get("id").and_then(Value::as_str);
    let request_id = record.get("requestId").and_then(Value::as_str);
    let dedupe_key = match (message_id, request_id) {
        (None, None) => None,
        (message, request) => Some(format!(
            "{}:{}",
            message.unwrap_or_default(),
            request.unwrap_or_default()
        )),
    };
    // Newer records carry the TTL split under `cache_creation`; older ones only
    // have the flat total, which is then all short-lived.
    let nested = usage.get("cache_creation").and_then(Value::as_object);
    let long_write = nested.map_or(0, |c| count(c.get("ephemeral_1h_input_tokens")));
    let short_write = nested.map_or(0, |c| count(c.get("ephemeral_5m_input_tokens")));
    let flat_write = count(usage.get("cache_creation_input_tokens"));
    let cache_creation_tokens = flat_write.max(long_write + short_write);
    let output_tokens = count(usage.get("output_tokens"));
    let totals = UsageTotals {
        uncached_input_tokens: count(usage.get("input_tokens")),
        cached_input_tokens: count(usage.get("cache_read_input_tokens")),
        cache_creation_tokens,
        cache_creation_long_tokens: long_write.min(cache_creation_tokens),
        output_tokens,
        // Only newer records break thinking out of the output total.
        reasoning_tokens: usage
            .get("output_tokens_details")
            .and_then(Value::as_object)
            .map_or(0, |d| count(d.get("thinking_tokens")))
            .min(output_tokens),
    };
    if totals.is_empty() {
        return None;
    }
    Some(UsageRecord {
        provider: UsageProvider::Claude,
        timestamp_ms,
        model: model.to_string(),
        session_id: record
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        totals,
        reported_cost_usd: record
            .get("costUSD")
            .and_then(Value::as_f64)
            .filter(|c| c.is_finite()),
        dedupe_key,
    })
}

/* -------------------------------------------------------------------------- */
/* Codex                                                                      */
/* -------------------------------------------------------------------------- */

/// Rolling state for one Codex rollout. `token_count` events carry no model,
/// so it is carried forward from the latest `turn_context`.
#[derive(Debug, Default)]
pub struct CodexScanState {
    model: String,
    session_id: String,
    last_usage_signature: Option<String>,
    saw_session_meta: bool,
    suppressing_fork_copies: bool,
    fork_copy_anchor_ms: i64,
}

fn is_forked_session_meta(payload: &serde_json::Map<String, Value>) -> bool {
    if payload.get("forked_from_id").is_some_and(Value::is_string) {
        return true;
    }
    payload
        .get("source")
        .and_then(Value::as_object)
        .and_then(|source| source.get("subagent"))
        .and_then(Value::as_object)
        .and_then(|subagent| subagent.get("thread_spawn"))
        .and_then(Value::as_object)
        .and_then(|spawn| spawn.get("parent_thread_id"))
        .is_some_and(Value::is_string)
}

/// Feeds one rollout line into `state`, returning a record for usage events.
/// Deltas come from `last_token_usage`; summing them reconciles with the
/// session's `total_token_usage` once consecutive duplicates are dropped.
pub fn parse_codex_line(line: &str, state: &mut CodexScanState) -> Option<UsageRecord> {
    let record: Value = serde_json::from_str(line).ok()?;
    let payload = record.get("payload")?.as_object()?;
    match record.get("type").and_then(Value::as_str) {
        Some("session_meta") => {
            // Only the first meta describes this file's own session; a forked
            // rollout repeats the ancestors' metas right after it.
            if state.saw_session_meta {
                return None;
            }
            state.saw_session_meta = true;
            if let Some(id) = payload
                .get("id")
                .or_else(|| payload.get("session_id"))
                .and_then(Value::as_str)
            {
                state.session_id = id.to_string();
            }
            if let Some(meta_ms) = parse_timestamp_ms(record.get("timestamp"))
                && is_forked_session_meta(payload)
            {
                state.suppressing_fork_copies = true;
                state.fork_copy_anchor_ms = meta_ms;
            }
            return None;
        }
        Some("turn_context") => {
            if let Some(model) = payload.get("model").and_then(Value::as_str) {
                state.model = model.to_string();
            }
            return None;
        }
        _ => {}
    }
    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }
    let last = payload.get("info")?.get("last_token_usage")?.as_object()?;
    let timestamp_ms = parse_timestamp_ms(record.get("timestamp"))?;
    // A token_count arriving before its turn_context must not consume the
    // duplicate signature, or the copy emitted once the model is known would
    // be skipped and those tokens never counted.
    if state.model.is_empty() {
        return None;
    }
    let signature = serde_json::to_string(last).ok()?;
    if state.last_usage_signature.as_deref() == Some(signature.as_str()) {
        return None;
    }
    state.last_usage_signature = Some(signature);
    if state.suppressing_fork_copies {
        if timestamp_ms - state.fork_copy_anchor_ms < FORK_COPY_MAX_GAP_MS {
            state.fork_copy_anchor_ms = timestamp_ms;
            return None;
        }
        state.suppressing_fork_copies = false;
    }
    let input = count(last.get("input_tokens"));
    let cached = count(last.get("cached_input_tokens"));
    let cache_write = count(last.get("cache_write_input_tokens"));
    let output = count(last.get("output_tokens"));
    let totals = UsageTotals {
        // Codex reports `input_tokens` inclusive of the cached portion.
        uncached_input_tokens: input.saturating_sub(cached).saturating_sub(cache_write),
        cached_input_tokens: cached,
        cache_creation_tokens: cache_write,
        // Codex rollouts do not distinguish a cache-write TTL.
        cache_creation_long_tokens: 0,
        output_tokens: output,
        reasoning_tokens: count(last.get("reasoning_output_tokens")).min(output),
    };
    if totals.is_empty() {
        return None;
    }
    Some(UsageRecord {
        provider: UsageProvider::Codex,
        timestamp_ms,
        model: state.model.clone(),
        session_id: state.session_id.clone(),
        totals,
        reported_cost_usd: None,
        dedupe_key: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE_LINE: &str = r#"{"type":"assistant","timestamp":"2026-08-16T02:00:10.000Z","requestId":"req_1","sessionId":"s1","message":{"id":"msg_1","model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":120,"cache_read_input_tokens":4000,"cache_creation_input_tokens":300,"output_tokens":80}}}"#;

    #[test]
    fn claude_line_parses_usage_and_dedupe_key() {
        let record = parse_claude_line(CLAUDE_LINE).expect("record");
        assert_eq!(record.provider, UsageProvider::Claude);
        assert_eq!(record.model, "claude-sonnet-4-5-20250929");
        assert_eq!(record.session_id, "s1");
        assert_eq!(record.totals.uncached_input_tokens, 120);
        assert_eq!(record.totals.cached_input_tokens, 4000);
        assert_eq!(record.totals.cache_creation_tokens, 300);
        assert_eq!(record.totals.output_tokens, 80);
        assert_eq!(record.totals.reasoning_tokens, 0);
        assert_eq!(record.dedupe_key.as_deref(), Some("msg_1:req_1"));
        assert_eq!(record.timestamp_ms, 1_786_845_610_000);
    }

    #[test]
    fn claude_splits_cache_write_ttls_and_reads_thinking_tokens() {
        let line = r#"{"type":"assistant","timestamp":"2026-08-16T02:00:10.000Z","requestId":"r","sessionId":"s","message":{"id":"m","model":"claude-fable-5","usage":{"input_tokens":10,"cache_read_input_tokens":900,"cache_creation_input_tokens":300,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200},"output_tokens":50,"output_tokens_details":{"thinking_tokens":30}}}}"#;
        let record = parse_claude_line(line).expect("record");
        assert_eq!(record.totals.cache_creation_tokens, 300);
        assert_eq!(record.totals.cache_creation_long_tokens, 200);
        assert_eq!(record.totals.reasoning_tokens, 30);

        // Only the nested object is present: it becomes the total.
        let nested_only = line.replace(r#""cache_creation_input_tokens":300,"#, "");
        let record = parse_claude_line(&nested_only).expect("record");
        assert_eq!(record.totals.cache_creation_tokens, 300);
        assert_eq!(record.totals.cache_creation_long_tokens, 200);

        // Reasoning can never exceed the output it is a subset of.
        let over = line.replace(r#""thinking_tokens":30"#, r#""thinking_tokens":9999"#);
        assert_eq!(
            parse_claude_line(&over)
                .expect("record")
                .totals
                .reasoning_tokens,
            50
        );
    }

    #[test]
    fn claude_skips_synthetic_and_empty_usage() {
        let synthetic = CLAUDE_LINE.replace("claude-sonnet-4-5-20250929", "<synthetic>");
        assert!(parse_claude_line(&synthetic).is_none());
        let empty = r#"{"type":"assistant","timestamp":"2026-08-16T02:00:10.000Z","message":{"id":"m","model":"claude-opus-4-1","usage":{"input_tokens":0,"output_tokens":0}}}"#;
        assert!(parse_claude_line(empty).is_none());
        assert!(parse_claude_line(r#"{"type":"user","timestamp":"x"}"#).is_none());
    }

    fn codex_lines() -> Vec<String> {
        vec![
            r#"{"timestamp":"2026-08-16T02:10:03.308Z","type":"session_meta","payload":{"id":"sess-1","cwd":"H:\\Code"}}"#.into(),
            r#"{"timestamp":"2026-08-16T02:10:03.400Z","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-5-codex"}}"#.into(),
            r#"{"timestamp":"2026-08-16T02:10:12.252Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":23182,"cached_input_tokens":0,"output_tokens":361,"reasoning_output_tokens":229,"total_tokens":23543},"last_token_usage":{"input_tokens":23182,"cached_input_tokens":0,"output_tokens":361,"reasoning_output_tokens":229,"total_tokens":23543}}}}"#.into(),
            // Re-emitted, unchanged: must be dropped.
            r#"{"timestamp":"2026-08-16T02:10:12.900Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":23182,"cached_input_tokens":0,"output_tokens":361,"reasoning_output_tokens":229,"total_tokens":23543},"last_token_usage":{"input_tokens":23182,"cached_input_tokens":0,"output_tokens":361,"reasoning_output_tokens":229,"total_tokens":23543}}}}"#.into(),
            r#"{"timestamp":"2026-08-16T02:10:27.992Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":56797,"cached_input_tokens":23179,"output_tokens":680,"reasoning_output_tokens":285,"total_tokens":57477},"last_token_usage":{"input_tokens":33615,"cached_input_tokens":23179,"output_tokens":319,"reasoning_output_tokens":56,"total_tokens":33934}}}}"#.into(),
        ]
    }

    #[test]
    fn codex_lines_carry_model_forward_and_drop_duplicates() {
        let mut state = CodexScanState::default();
        let records: Vec<UsageRecord> = codex_lines()
            .iter()
            .filter_map(|line| parse_codex_line(line, &mut state))
            .collect();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].model, "gpt-5-codex");
        assert_eq!(records[0].session_id, "sess-1");
        assert_eq!(records[0].totals.uncached_input_tokens, 23182);
        assert_eq!(records[0].totals.reasoning_tokens, 229);
        assert_eq!(records[1].totals.uncached_input_tokens, 33615 - 23179);
        assert_eq!(records[1].totals.cached_input_tokens, 23179);
        assert_eq!(records[1].totals.output_tokens, 319);
    }

    #[test]
    fn codex_token_count_before_turn_context_is_ignored_without_poisoning() {
        let lines = codex_lines();
        let mut state = CodexScanState::default();
        // Usage before any turn_context: skipped, and it must not consume the signature.
        assert!(parse_codex_line(&lines[2], &mut state).is_none());
        assert!(parse_codex_line(&lines[1], &mut state).is_none());
        assert!(parse_codex_line(&lines[2], &mut state).is_some());
    }

    #[test]
    fn codex_forked_rollout_suppresses_leading_copies() {
        let mut state = CodexScanState::default();
        let meta = r#"{"timestamp":"2026-08-16T02:10:03.308Z","type":"session_meta","payload":{"id":"child","forked_from_id":"parent"}}"#;
        let ctx = r#"{"timestamp":"2026-08-16T02:10:03.310Z","type":"turn_context","payload":{"model":"gpt-5-codex"}}"#;
        let copy = r#"{"timestamp":"2026-08-16T02:10:03.320Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}}}"#;
        let genuine = r#"{"timestamp":"2026-08-16T02:10:09.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":20,"cached_input_tokens":0,"output_tokens":7,"reasoning_output_tokens":0}}}}"#;
        assert!(parse_codex_line(meta, &mut state).is_none());
        assert!(parse_codex_line(ctx, &mut state).is_none());
        assert!(parse_codex_line(copy, &mut state).is_none());
        let record = parse_codex_line(genuine, &mut state).expect("genuine usage");
        assert_eq!(record.totals.uncached_input_tokens, 20);
    }

    /// Scans this machine's real transcripts. Ignored by default: it depends on
    /// what the CLIs have written locally. Run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn scan_real_home_roots_is_fast() {
        let until = Utc::now().timestamp_millis();
        let since = until - 90 * 24 * HOUR_MS;
        let mut cache = ScanCache::new();
        let started = std::time::Instant::now();
        let report = scan_usage_history_with(&default_roots(), since, until, &mut cache);
        let elapsed = started.elapsed();
        let warm_started = std::time::Instant::now();
        let warm = scan_usage_history_with(&default_roots(), since, until, &mut cache);
        let warm_elapsed = warm_started.elapsed();
        assert_eq!(warm.slices.len(), report.slices.len());
        eprintln!("warm rescan elapsed={warm_elapsed:?}");
        for source in &report.sources {
            eprintln!(
                "{:?} {} status={} scanned={} skipped={} sessions={} detail={:?}",
                source.provider,
                source.root,
                source.status,
                source.files_scanned,
                source.files_skipped,
                source.sessions,
                source.detail
            );
        }
        let total: u64 = report.slices.iter().map(|s| s.totals.output_tokens).sum();
        eprintln!(
            "slices={} output_tokens={} elapsed={elapsed:?}",
            report.slices.len(),
            total
        );
        assert!(
            warm_elapsed < std::time::Duration::from_secs(2),
            "warm rescan took {warm_elapsed:?}"
        );
    }

    #[test]
    fn scan_aggregates_by_hour_and_dedupes_claude_across_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let codex_root = dir.path().join("codex");
        let claude_root = dir.path().join("claude").join("proj");
        std::fs::create_dir_all(codex_root.join("2026").join("08")).unwrap();
        std::fs::create_dir_all(&claude_root).unwrap();
        std::fs::write(
            codex_root.join("2026").join("08").join("rollout.jsonl"),
            codex_lines().join("\n"),
        )
        .unwrap();
        // The same Claude message repeated across two files counts once.
        std::fs::write(
            claude_root.join("a.jsonl"),
            format!("{CLAUDE_LINE}\n{CLAUDE_LINE}\n"),
        )
        .unwrap();
        std::fs::write(claude_root.join("b.jsonl"), format!("{CLAUDE_LINE}\n")).unwrap();
        let roots = vec![
            UsageRoot {
                provider: UsageProvider::Codex,
                path: codex_root,
                label: "codex".into(),
            },
            UsageRoot {
                provider: UsageProvider::Claude,
                path: dir.path().join("claude"),
                label: "claude".into(),
            },
            UsageRoot {
                provider: UsageProvider::Claude,
                path: dir.path().join("nope"),
                label: "nope".into(),
            },
        ];
        let since = DateTime::parse_from_rfc3339("2026-08-15T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        let until = DateTime::parse_from_rfc3339("2026-08-17T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        let mut cache = ScanCache::new();
        let report = scan_usage_history_with(&roots, since, until, &mut cache);
        assert_eq!(cache.len(), 3);
        assert_eq!(report.sources.len(), 3);
        assert_eq!(report.sources[0].files_scanned, 1);
        assert_eq!(report.sources[0].sessions, 1);
        assert_eq!(report.sources[2].status, "missing");
        let claude: Vec<_> = report
            .slices
            .iter()
            .filter(|s| s.provider == UsageProvider::Claude)
            .collect();
        assert_eq!(claude.len(), 1);
        assert_eq!(claude[0].totals.cached_input_tokens, 4000);
        let codex: Vec<_> = report
            .slices
            .iter()
            .filter(|s| s.provider == UsageProvider::Codex)
            .collect();
        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0].totals.output_tokens, 361 + 319);
        assert_eq!(codex[0].hour_start_ms % HOUR_MS, 0);
        // Outside the window: nothing, and the cache answers without re-parsing.
        let empty = scan_usage_history_with(&roots, until, until + HOUR_MS, &mut cache);
        assert!(empty.slices.is_empty());
        assert_eq!(empty.sources[0].files_scanned, 1);
        // Same window again from cache reproduces the totals exactly.
        let again = scan_usage_history_with(&roots, since, until, &mut cache);
        assert_eq!(again.slices.len(), report.slices.len());
    }
}
