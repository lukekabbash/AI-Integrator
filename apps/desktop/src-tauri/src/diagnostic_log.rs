//! Local diagnostic JSONL storage.
//!
//! Records use a common envelope with these optional fields:
//! `ts`, `level`, `faultId`, `layer`, `op`, `outcome`, `code`,
//! `causeClass`, `retryable`, `projectId`, `taskId`, `runId`, `processId`,
//! `turnId`, `requestId`, `route`, `prevPhase`, `durationMs`, `detail`,
//! `appVersion`, and `os`.

use chrono::{Duration, Local, NaiveDate};
use integrator_core::{IntegratorError, Result};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const PRODUCT_DIRECTORY: &str = "AI Integrator";
const LOGS_DIRECTORY: &str = "Logs";
const DETAIL_STRING_LIMIT: usize = 256 * 1024;
const MAX_LOG_BYTES: u64 = 500 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Retention {
    Days(u32),
    Never,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PruneStats {
    pub deleted_files: u64,
    pub deleted_bytes: u64,
    pub remaining_files: u64,
    pub remaining_bytes: u64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct LogsTotals {
    pub file_count: u64,
    pub total_bytes: u64,
    pub incident_files: u64,
    pub detail_files: u64,
}

#[derive(Debug)]
struct LogFile {
    path: PathBuf,
    date: NaiveDate,
    bytes: u64,
}

pub fn logs_root(documents: &Path) -> PathBuf {
    documents.join(PRODUCT_DIRECTORY).join(LOGS_DIRECTORY)
}

pub fn ensure_logs_dir(documents: &Path) -> io::Result<PathBuf> {
    let root = logs_root(documents);
    fs::create_dir_all(&root)?;
    Ok(root)
}

pub fn append_incident(documents: &Path, record: &Value) -> Result<()> {
    append_record(documents, "incidents", record)
}

pub fn append_detail(documents: &Path, record: &Value, detailed_enabled: bool) -> Result<()> {
    if !detailed_enabled {
        return Ok(());
    }
    append_record(documents, "detail", record)
}

pub fn prune_logs(documents: &Path, retention: Retention) -> Result<PruneStats> {
    let root = ensure_logs_dir(documents)?;
    let mut files = log_files(&root)?;
    let mut stats = PruneStats::default();

    if let Retention::Days(days) = retention {
        let cutoff = Local::now().date_naive() - Duration::days(i64::from(days));
        let mut retained = Vec::with_capacity(files.len());
        for file in files {
            if file.date < cutoff {
                delete_log_file(&file, &mut stats)?;
            } else {
                retained.push(file);
            }
        }
        files = retained;
    }

    files.sort_by(|left, right| {
        left.date
            .cmp(&right.date)
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut remaining_bytes = files.iter().map(|file| file.bytes).sum::<u64>();
    while remaining_bytes > MAX_LOG_BYTES && !files.is_empty() {
        let file = files.remove(0);
        delete_log_file(&file, &mut stats)?;
        remaining_bytes = remaining_bytes.saturating_sub(file.bytes);
    }

    stats.remaining_files = files.len() as u64;
    stats.remaining_bytes = remaining_bytes;
    Ok(stats)
}

pub fn logs_totals(documents: &Path) -> Result<LogsTotals> {
    let root = ensure_logs_dir(documents)?;
    let mut totals = LogsTotals::default();
    for file in log_files(&root)? {
        totals.file_count += 1;
        totals.total_bytes = totals.total_bytes.saturating_add(file.bytes);
        match log_kind(&file.path) {
            Some("incidents") => totals.incident_files += 1,
            Some("detail") => totals.detail_files += 1,
            _ => {}
        }
    }
    Ok(totals)
}

pub fn clear_logs(documents: &Path) -> Result<()> {
    let root = ensure_logs_dir(documents)?;
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            fs::remove_dir_all(entry.path())?;
        } else {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

pub fn open_logs_folder(documents: &Path) -> Result<()> {
    let root = ensure_logs_dir(documents)?;

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        command.arg(&root);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&root);
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&root);
        command
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return Err(IntegratorError::Unavailable(
        "opening the diagnostic logs folder is not supported on this platform".into(),
    ));

    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        command.stdin(Stdio::null());
        command.stdout(Stdio::null());
        command.stderr(Stdio::null());
        command.spawn().map_err(IntegratorError::from)?;
        Ok(())
    }
}

pub fn parse_retention(value: &str) -> Retention {
    match value {
        "14d" => Retention::Days(14),
        "30d" => Retention::Days(30),
        "never" => Retention::Never,
        "7d" => Retention::Days(7),
        _ => Retention::Days(7),
    }
}

pub fn redact_record(mut value: Value) -> Value {
    redact_value(&mut value);
    value
}

fn redact_value(value: &mut Value) {
    match value {
        Value::String(text) => {
            *text = integrator_runtime::redact_and_bound(text, DETAIL_STRING_LIMIT).0;
        }
        Value::Array(values) => {
            for value in values {
                redact_value(value);
            }
        }
        Value::Object(fields) => {
            for value in fields.values_mut() {
                redact_value(value);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn append_record(documents: &Path, kind: &str, record: &Value) -> Result<()> {
    let root = ensure_logs_dir(documents)?;
    let filename = format!("{kind}-{}.jsonl", Local::now().format("%Y-%m-%d"));
    let path = root.join(filename);
    let canonical_root = dunce::canonicalize(&root)?;
    let parent = path
        .parent()
        .ok_or_else(|| IntegratorError::Unauthorized("log path has no parent".into()))?;
    let canonical_parent = dunce::canonicalize(parent)?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(IntegratorError::Unauthorized(
            "diagnostic log path escaped the logs directory".into(),
        ));
    }
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(IntegratorError::Unauthorized(
            "diagnostic log path must not be a symbolic link".into(),
        ));
    }

    let redacted = redact_record(record.clone());
    let mut encoded = serde_json::to_vec(&redacted)?;
    encoded.push(b'\n');

    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path)?;
    file.write_all(&encoded)?;
    Ok(())
}

fn log_files(root: &Path) -> Result<Vec<LogFile>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let Some(date) = log_date(&path) else {
            continue;
        };
        let metadata = entry.metadata()?;
        if metadata.is_file() {
            files.push(LogFile {
                path,
                date,
                bytes: metadata.len(),
            });
        }
    }
    Ok(files)
}

fn log_kind(path: &Path) -> Option<&'static str> {
    let name = path.file_name()?.to_str()?;
    if name.starts_with("incidents-") {
        Some("incidents")
    } else if name.starts_with("detail-") {
        Some("detail")
    } else {
        None
    }
}

fn log_date(path: &Path) -> Option<NaiveDate> {
    let name = path.file_name()?.to_str()?;
    let date = name
        .strip_prefix("incidents-")
        .or_else(|| name.strip_prefix("detail-"))?
        .strip_suffix(".jsonl")?;
    NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()
}

fn delete_log_file(file: &LogFile, stats: &mut PruneStats) -> Result<()> {
    fs::remove_file(&file.path)?;
    stats.deleted_files += 1;
    stats.deleted_bytes = stats.deleted_bytes.saturating_add(file.bytes);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn logs_root_uses_documents_product_logs_path() {
        let documents = Path::new("documents");
        assert_eq!(
            logs_root(documents),
            documents.join("AI Integrator").join("Logs")
        );
    }

    #[test]
    fn redact_record_strips_bearer_tokens_from_nested_detail() {
        let record = json!({
            "detail": {
                "lines": ["request failed: Bearer bearer-value"]
            }
        });

        let redacted = redact_record(record);
        let detail = redacted["detail"]["lines"][0]
            .as_str()
            .expect("detail should remain a string");
        assert!(!detail.contains("bearer-value"));
        assert!(detail.contains("[redacted]"));
    }

    #[test]
    fn prune_deletes_old_dated_files() {
        let temp = tempfile::tempdir().expect("temporary directory should be created");
        let root = ensure_logs_dir(temp.path()).expect("logs directory should be created");
        let old = root.join("incidents-2000-01-01.jsonl");
        let current = root.join(format!("detail-{}.jsonl", Local::now().format("%Y-%m-%d")));
        fs::write(&old, "{}\n").expect("old fixture should be written");
        fs::write(&current, "{}\n").expect("current fixture should be written");

        let stats = prune_logs(temp.path(), Retention::Days(7)).expect("pruning should succeed");

        assert_eq!(stats.deleted_files, 1);
        assert!(!old.exists());
        assert!(current.exists());
    }

    #[test]
    fn clear_empties_logs_directory() {
        let temp = tempfile::tempdir().expect("temporary directory should be created");
        let root = ensure_logs_dir(temp.path()).expect("logs directory should be created");
        fs::write(root.join("incidents-2026-08-12.jsonl"), "{}\n")
            .expect("incident fixture should be written");
        fs::write(root.join("detail-2026-08-12.jsonl"), "{}\n")
            .expect("detail fixture should be written");
        fs::write(root.join("incomplete-write.tmp"), "partial")
            .expect("temporary fixture should be written");

        clear_logs(temp.path()).expect("clearing should succeed");

        assert_eq!(
            fs::read_dir(root)
                .expect("logs directory should be readable")
                .count(),
            0
        );
    }

    #[test]
    fn append_detail_only_writes_when_enabled() {
        let temp = tempfile::tempdir().expect("temporary directory should be created");
        let record = json!({"detail": "diagnostic"});

        append_detail(temp.path(), &record, false).expect("disabled append should be a no-op");
        assert!(!logs_root(temp.path()).exists());

        append_detail(temp.path(), &record, true).expect("enabled append should succeed");
        let path = logs_root(temp.path())
            .join(format!("detail-{}.jsonl", Local::now().format("%Y-%m-%d")));
        let contents = fs::read_to_string(path).expect("detail log should be readable");
        assert_eq!(contents.lines().count(), 1);
        assert!(contents.contains("diagnostic"));
    }
}
