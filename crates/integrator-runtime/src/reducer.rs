use chrono::{DateTime, TimeZone, Utc};
use integrator_core::{
    ApprovalKind, ConnectionState, FileChangeKind, FileChangeProjection, ItemKind, ItemProjection,
    ItemStatus, ModeOption, ModeProjection, PlanStep, PlanStepStatus, Result, TransportRequestId,
    TurnProjection, TurnStatus, UsageProjection,
};
use serde_json::{Map, Value, json};

const AUDIT_LIMIT: usize = 256 * 1024;
const BODY_LIMIT: usize = 2 * 1024 * 1024;
const DIFF_LIMIT: usize = 4 * 1024 * 1024;
const TEXT_LIMIT: usize = 16 * 1024;
const PATH_LIMIT: usize = 4 * 1024;
const PLAN_STEP_LIMIT: usize = 4 * 1024;
const PLAN_STEPS_LIMIT: usize = 256;
/// Full plan documents (markdown) attached to plan-review approvals.
const PLAN_DOCUMENT_LIMIT: usize = 256 * 1024;
const TOOL_DETAIL_LIMIT: usize = 64 * 1024;

#[derive(Clone, Debug)]
pub struct ProviderEventInput {
    pub method: String,
    pub params: Value,
    pub request_id: Option<TransportRequestId>,
    pub occurred_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct ReducedProviderEvent {
    pub method: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub audit_json: String,
    pub audit_truncated: bool,
    pub mutation: ProjectionMutation,
    pub occurred_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub enum ProjectionMutation {
    Turn(TurnProjection),
    ReplaceItem(ItemProjection),
    AppendItem {
        provider_item_id: String,
        item_kind: ItemKind,
        field: ItemTextField,
        delta: String,
        updated_at: DateTime<Utc>,
    },
    Plan {
        steps: Vec<PlanStep>,
        truncated: bool,
    },
    Diff {
        diff: String,
        truncated: bool,
    },
    Usage(UsageProjection),
    /// Adds per-turn usage onto the task's stored projection instead of
    /// replacing it. Codex streams cumulative thread totals (`Usage`
    /// replaces); structured CLIs report each turn in isolation, so their
    /// numbers must accumulate or later turns would erase earlier ones.
    UsageDelta(UsageProjection),
    ApprovalRequested {
        request_id: TransportRequestId,
        approval_kind: ApprovalKind,
        item_id: String,
        approval_id: Option<String>,
        reason: Option<String>,
        command: Option<String>,
        cwd: Option<String>,
        /// Full plan document for `PlanReview` approvals; `None` otherwise.
        plan_markdown: Option<String>,
    },
    /// Replaces the session's mode state (current mode + available modes).
    Mode(ModeProjection),
    ApprovalResolved {
        request_id: TransportRequestId,
    },
    TurnError {
        message: String,
        retryable: bool,
    },
    Connection {
        state: ConnectionState,
        reason: Option<String>,
    },
    NeutralItem(ItemProjection),
    /// Overlay the populated fields onto an existing item, keeping detail a
    /// partial provider update (e.g. an ACP `tool_call_update`) omitted.
    MergeItem(ItemProjection),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ItemTextField {
    Body,
    Output,
}

pub fn reduce_provider_event(input: ProviderEventInput) -> Result<Option<ReducedProviderEvent>> {
    let (audit_json, audit_truncated) = bounded_event_audit(&input.params);
    let method = input.method.as_str();
    if method == "item/commandExecution/terminalInteraction" {
        return Ok(None);
    }
    let thread_id = extract_id(&input.params, &["threadId", "thread", "id"])?;
    let turn_id = optional_id(&input.params, &["turnId"])
        .or_else(|| optional_nested_id(&input.params, "turn"));
    let mutation = match method {
        "thread/started" => ProjectionMutation::Connection {
            state: ConnectionState::Connected,
            reason: None,
        },
        "turn/started" | "turn/completed" => {
            let turn = input.params.get("turn").unwrap_or(&input.params);
            ProjectionMutation::Turn(parse_turn(turn, input.occurred_at)?)
        }
        "item/started" | "item/completed" => {
            let item = input.params.get("item").unwrap_or(&input.params);
            let completed = method == "item/completed";
            let projection = parse_item(
                &thread_id,
                turn_id.as_deref().ok_or_else(|| {
                    integrator_core::IntegratorError::Protocol("item event missing turn id".into())
                })?,
                item,
                completed,
                input.occurred_at,
            )?;
            if projection.kind == ItemKind::ReasoningSummary
                && projection
                    .body
                    .as_deref()
                    .is_none_or(|body| body.trim().is_empty())
            {
                return Ok(None);
            }
            ProjectionMutation::ReplaceItem(projection)
        }
        "item/agentMessage/delta" => ProjectionMutation::AppendItem {
            provider_item_id: required_string(&input.params, "itemId")?,
            item_kind: ItemKind::AgentMessage,
            field: ItemTextField::Body,
            delta: required_string(&input.params, "delta")?,
            updated_at: input.occurred_at,
        },
        "item/reasoning/summaryTextDelta" => ProjectionMutation::AppendItem {
            provider_item_id: required_string(&input.params, "itemId")?,
            item_kind: ItemKind::ReasoningSummary,
            field: ItemTextField::Body,
            delta: required_string(&input.params, "delta")?,
            updated_at: input.occurred_at,
        },
        "item/commandExecution/outputDelta" => ProjectionMutation::AppendItem {
            provider_item_id: required_string(&input.params, "itemId")?,
            item_kind: ItemKind::CommandExecution,
            field: ItemTextField::Output,
            delta: required_string(&input.params, "delta")?,
            updated_at: input.occurred_at,
        },
        "item/fileChange/outputDelta" => ProjectionMutation::AppendItem {
            provider_item_id: required_string(&input.params, "itemId")?,
            item_kind: ItemKind::FileChange,
            field: ItemTextField::Output,
            delta: required_string(&input.params, "delta")?,
            updated_at: input.occurred_at,
        },
        "item/fileChange/patchUpdated" => {
            let item_id = required_string(&input.params, "itemId")?;
            ProjectionMutation::ReplaceItem(ItemProjection {
                id: stable_item_id(
                    &thread_id,
                    turn_id.as_deref().unwrap_or("unknown"),
                    &item_id,
                ),
                provider_item_id: item_id,
                kind: ItemKind::FileChange,
                status: ItemStatus::InProgress,
                title: Some("File changes".into()),
                body: None,
                native_skill: None,
                phase: None,
                command: None,
                cwd: None,
                output: None,
                exit_code: None,
                file_changes: Some(parse_file_changes(input.params.get("changes"))),
                mcp_server: None,
                mcp_tool: None,
                tool_input: None,
                truncated: false,
                updated_at: input.occurred_at,
            })
        }
        "turn/plan/updated" => {
            let (steps, truncated) = parse_plan(input.params.get("plan"));
            ProjectionMutation::Plan { steps, truncated }
        }
        "turn/diff/updated" => {
            let raw = input
                .params
                .get("diff")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let (diff, truncated) = bound_and_redact_patch(raw, DIFF_LIMIT);
            ProjectionMutation::Diff { diff, truncated }
        }
        "thread/tokenUsage/updated" => {
            ProjectionMutation::Usage(parse_usage(input.params.get("tokenUsage")))
        }
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            let request_id = input.request_id.ok_or_else(|| {
                integrator_core::IntegratorError::Protocol("approval missing request id".into())
            })?;
            ProjectionMutation::ApprovalRequested {
                request_id,
                approval_kind: if method.contains("commandExecution") {
                    ApprovalKind::CommandExecution
                } else {
                    ApprovalKind::FileChange
                },
                item_id: required_string(&input.params, "itemId")?,
                approval_id: optional_string(&input.params, "approvalId"),
                reason: optional_string(&input.params, "reason")
                    .map(|reason| bound_and_redact(&reason, TEXT_LIMIT).0),
                command: optional_string(&input.params, "command")
                    .map(|command| bound_and_redact(&command, TEXT_LIMIT).0),
                cwd: optional_string(&input.params, "cwd")
                    .or_else(|| optional_string(&input.params, "grantRoot"))
                    .map(|cwd| bound_and_redact(&cwd, PATH_LIMIT).0),
                plan_markdown: None,
            }
        }
        "serverRequest/resolved" => {
            let request_id = input
                .params
                .get("requestId")
                .and_then(transport_id_from_value)
                .ok_or_else(|| {
                    integrator_core::IntegratorError::Protocol(
                        "resolved request missing tagged id".into(),
                    )
                })?;
            ProjectionMutation::ApprovalResolved { request_id }
        }
        "error" | "thread/realtime/error" => {
            let message = input
                .params
                .pointer("/error/message")
                .or_else(|| input.params.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Provider error");
            ProjectionMutation::TurnError {
                message: bound_and_redact(message, TEXT_LIMIT).0,
                retryable: input
                    .params
                    .get("willRetry")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }
        }
        _ => return Ok(None),
    };
    Ok(Some(ReducedProviderEvent {
        method: input.method,
        thread_id,
        turn_id,
        audit_json,
        audit_truncated,
        mutation,
        occurred_at: input.occurred_at,
    }))
}

pub fn reduce_connection_event(
    method: &str,
    thread_id: &str,
    state: ConnectionState,
    reason: Option<&str>,
    occurred_at: DateTime<Utc>,
) -> ReducedProviderEvent {
    let reason = reason.map(|value| bound_and_redact(value, TEXT_LIMIT).0);
    ReducedProviderEvent {
        method: method.into(),
        thread_id: thread_id.into(),
        turn_id: None,
        audit_json: json!({ "state": state, "reason": reason }).to_string(),
        audit_truncated: false,
        mutation: ProjectionMutation::Connection { state, reason },
        occurred_at,
    }
}

fn parse_turn(value: &Value, now: DateTime<Utc>) -> Result<TurnProjection> {
    let id = required_string(value, "id")?;
    let status = match value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("inProgress")
    {
        "completed" => TurnStatus::Completed,
        "interrupted" => TurnStatus::Interrupted,
        "failed" => TurnStatus::Failed,
        "inProgress" => TurnStatus::InProgress,
        _ => TurnStatus::Pending,
    };
    let error = value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .map(|text| bound_and_redact(text, TEXT_LIMIT).0);
    Ok(TurnProjection {
        id,
        status: status.clone(),
        stop_requested: false,
        error,
        started_at: timestamp_seconds(value.get("startedAt"))
            .or((status == TurnStatus::InProgress).then_some(now)),
        completed_at: timestamp_seconds(value.get("completedAt")),
    })
}

fn parse_item(
    thread_id: &str,
    turn_id: &str,
    value: &Value,
    completed: bool,
    now: DateTime<Utc>,
) -> Result<ItemProjection> {
    let provider_item_id = required_string(value, "id")?;
    let item_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let mut projection = ItemProjection {
        id: stable_item_id(thread_id, turn_id, &provider_item_id),
        provider_item_id,
        kind: ItemKind::Unknown,
        status: if completed {
            ItemStatus::Completed
        } else {
            ItemStatus::InProgress
        },
        title: None,
        body: None,
        native_skill: None,
        phase: None,
        command: None,
        cwd: None,
        output: None,
        exit_code: None,
        file_changes: None,
        mcp_server: None,
        mcp_tool: None,
        tool_input: None,
        truncated: false,
        updated_at: now,
    };
    match item_type {
        "userMessage" => {
            projection.kind = ItemKind::UserMessage;
            let text = extract_text(value.get("content"));
            projection.body = Some(bound_and_redact(strip_context_primer(&text), BODY_LIMIT).0);
        }
        "agentMessage" => {
            projection.kind = ItemKind::AgentMessage;
            let (body, truncated) = bound_and_redact(
                value
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                BODY_LIMIT,
            );
            projection.body = Some(body);
            projection.truncated = truncated;
            projection.phase = value
                .get("phase")
                .and_then(Value::as_str)
                .and_then(integrator_core::AgentMessagePhase::parse);
        }
        "plan" => {
            projection.kind = ItemKind::ReasoningSummary;
            projection.title = Some("Plan".into());
            projection.body = Some(
                bound_and_redact(
                    value
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    BODY_LIMIT,
                )
                .0,
            );
        }
        "reasoning" => {
            projection.kind = ItemKind::ReasoningSummary;
            projection.title = Some("Reasoning summary".into());
            projection.body =
                Some(bound_and_redact(&extract_text(value.get("summary")), BODY_LIMIT).0);
        }
        "commandExecution" => {
            projection.kind = ItemKind::CommandExecution;
            projection.status = item_status(value.get("status"), completed);
            projection.title = Some("Command".into());
            projection.command =
                optional_string(value, "command").map(|text| bound_and_redact(&text, TEXT_LIMIT).0);
            projection.cwd =
                optional_string(value, "cwd").map(|text| bound_and_redact(&text, PATH_LIMIT).0);
            projection.output = optional_string(value, "aggregatedOutput")
                .map(|text| bound_and_redact(&text, 1024 * 1024).0);
            projection.exit_code = value.get("exitCode").and_then(Value::as_i64);
        }
        "fileChange" => {
            projection.kind = ItemKind::FileChange;
            projection.status = item_status(value.get("status"), completed);
            projection.title = Some("File changes".into());
            projection.file_changes = Some(parse_file_changes(value.get("changes")));
        }
        "mcpToolCall" | "dynamicToolCall" => {
            projection.kind = ItemKind::McpTool;
            projection.status = item_status(value.get("status"), completed);
            projection.mcp_server =
                optional_string(value, "server").map(|text| bound_and_redact(&text, TEXT_LIMIT).0);
            projection.mcp_tool =
                optional_string(value, "tool").map(|text| bound_and_redact(&text, TEXT_LIMIT).0);
            projection.title = Some(match (&projection.mcp_server, &projection.mcp_tool) {
                (Some(server), Some(tool)) => format!("{server} · {tool}"),
                (None, Some(tool)) => tool.clone(),
                _ => "Tool call".into(),
            });
            projection.tool_input = json_detail(
                value.get("arguments").or_else(|| value.get("input")),
                TOOL_DETAIL_LIMIT,
            );
            projection.output = json_detail(
                value
                    .get("result")
                    .or_else(|| value.get("output"))
                    .or_else(|| value.get("error")),
                TOOL_DETAIL_LIMIT,
            );
        }
        _ => {
            projection.title = Some("Provider activity".into());
            projection.body = Some(format!(
                "Unsupported item type: {}",
                bound_and_redact(item_type, 128).0
            ));
        }
    }
    Ok(projection)
}

fn parse_plan(value: Option<&Value>) -> (Vec<PlanStep>, bool) {
    let values = value.and_then(Value::as_array).cloned().unwrap_or_default();
    let truncated = values.len() > PLAN_STEPS_LIMIT;
    let steps = values
        .into_iter()
        .take(PLAN_STEPS_LIMIT)
        .enumerate()
        .map(|(index, value)| {
            let text = value
                .get("step")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let status = match value.get("status").and_then(Value::as_str) {
                Some("inProgress") => PlanStepStatus::InProgress,
                Some("completed") => PlanStepStatus::Completed,
                _ => PlanStepStatus::Pending,
            };
            PlanStep {
                index: index as u32,
                text: bound_and_redact(text, PLAN_STEP_LIMIT).0,
                status,
            }
        })
        .collect();
    (steps, truncated)
}

fn parse_usage(value: Option<&Value>) -> UsageProjection {
    let total = value
        .and_then(|value| value.get("total"))
        .unwrap_or(&Value::Null);
    UsageProjection {
        input_tokens: u64_field(total, "inputTokens"),
        cached_input_tokens: u64_field(total, "cachedInputTokens"),
        output_tokens: u64_field(total, "outputTokens"),
        reasoning_output_tokens: u64_field(total, "reasoningOutputTokens"),
        total_tokens: u64_field(total, "totalTokens"),
        model_context_window: value
            .and_then(|value| value.get("modelContextWindow"))
            .and_then(Value::as_u64),
        vendor_cost_micro_usd: None,
    }
}

fn parse_file_changes(value: Option<&Value>) -> Vec<FileChangeProjection> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(512)
        .map(|change| {
            let path = change
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let kind_value = change
                .pointer("/kind/type")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let change_kind = match kind_value {
                "add" => FileChangeKind::Add,
                "delete" => FileChangeKind::Delete,
                "update"
                    if change
                        .pointer("/kind/move_path")
                        .and_then(Value::as_str)
                        .is_some() =>
                {
                    FileChangeKind::Rename
                }
                "update" => FileChangeKind::Modify,
                _ => FileChangeKind::Unknown,
            };
            FileChangeProjection {
                path: bound_and_redact(path, PATH_LIMIT).0,
                change_kind,
                patch: change
                    .get("diff")
                    .and_then(Value::as_str)
                    .map(|diff| bound_and_redact_patch(diff, DIFF_LIMIT).0),
            }
        })
        .collect()
}

pub fn redact_and_bound(value: &str, limit: usize) -> (String, bool) {
    bound_and_redact(value, limit)
}

fn bound_and_redact(value: &str, limit: usize) -> (String, bool) {
    let redacted = redact_text(value);
    truncate_utf8(&redacted, limit)
}

fn redact_text(value: &str) -> String {
    let mut private_key = false;
    value
        .lines()
        .map(|line| {
            let upper = line.to_ascii_uppercase();
            if upper.contains("-----BEGIN") && upper.contains("PRIVATE KEY-----") {
                private_key = true;
                return "[redacted-private-key]".into();
            }
            if private_key {
                if upper.contains("-----END") && upper.contains("PRIVATE KEY-----") {
                    private_key = false;
                }
                return "[redacted-private-key]".into();
            }
            let trimmed = line.trim_start();
            let lower = trimmed.to_ascii_lowercase();
            if lower.starts_with("authorization:")
                || lower.starts_with("cookie:")
                || lower.starts_with("set-cookie:")
            {
                return "[redacted-header]".into();
            }
            let mut words = Vec::new();
            let mut redact_next = false;
            for word in line.split_whitespace() {
                let lower_word = word.to_ascii_lowercase();
                let sensitive_assignment = word.split_once('=').is_some_and(|(key, _)| {
                    let key = key.to_ascii_uppercase();
                    key.contains("TOKEN")
                        || key.contains("SECRET")
                        || key.contains("PASSWORD")
                        || key.contains("API_KEY")
                });
                let high_entropy = word.len() >= 32
                    && word.chars().any(|c| c.is_ascii_lowercase())
                    && word.chars().any(|c| c.is_ascii_uppercase())
                    && word.chars().any(|c| c.is_ascii_digit());
                let path_like =
                    (word.contains('/') || word.contains('\\')) && !word.contains("://");
                if redact_next
                    || sensitive_assignment
                    || (high_entropy && !path_like)
                    || lower_word.starts_with("sk-")
                {
                    words.push("[redacted]".to_owned());
                    redact_next = false;
                } else if lower_word == "bearer" {
                    words.push("Bearer".into());
                    redact_next = true;
                } else if word.contains("://") && word.contains('@') {
                    words.push(redact_credential_url(word));
                } else {
                    words.push(word.to_owned());
                }
            }
            words.join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Redact with `redact_text`, but keep each line's original whitespace when
/// that line carried nothing to hide. `redact_text` rebuilds lines by joining
/// words with single spaces, which corrupts patch payloads: unified-diff
/// prefix columns and code indentation are significant there.
fn redact_preserving_layout(value: &str) -> String {
    let redacted: Vec<&str> = value.lines().collect();
    let fully_redacted = redact_text(value);
    let redacted_lines: Vec<&str> = fully_redacted.lines().collect();
    if redacted.len() != redacted_lines.len() {
        return fully_redacted;
    }
    redacted
        .iter()
        .zip(&redacted_lines)
        .map(|(original, redacted_line)| {
            let collapsed = original.split_whitespace().collect::<Vec<_>>().join(" ");
            if *redacted_line == collapsed {
                (*original).to_owned()
            } else {
                (*redacted_line).to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn bound_and_redact_patch(value: &str, limit: usize) -> (String, bool) {
    truncate_utf8(&redact_preserving_layout(value), limit)
}

fn redact_credential_url(value: &str) -> String {
    let Some(scheme) = value.find("://") else {
        return "[redacted-url]".into();
    };
    let after = scheme + 3;
    let Some(at) = value[after..].find('@').map(|index| after + index) else {
        return value.into();
    };
    format!("{}[redacted]@{}", &value[..after], &value[at + 1..])
}

fn bounded_audit(value: &Value) -> (String, bool) {
    let redacted = redact_json(value, None);
    truncate_utf8(&redacted.to_string(), AUDIT_LIMIT)
}

/// Keep provider-labeled reasoning summaries available for diagnostics while
/// ensuring raw reasoning blocks never enter the persisted audit stream.
fn bounded_event_audit(value: &Value) -> (String, bool) {
    let is_reasoning_item = value
        .get("item")
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
        == Some("reasoning")
        || (value.get("type").and_then(Value::as_str) == Some("reasoning"));
    if !is_reasoning_item {
        return bounded_audit(value);
    }
    let mut sanitized = value.clone();
    let item = if sanitized.get("item").is_some() {
        sanitized.get_mut("item")
    } else {
        Some(&mut sanitized)
    };
    if let Some(item) = item.and_then(Value::as_object_mut) {
        item.remove("content");
    }
    bounded_audit(&sanitized)
}

fn redact_json(value: &Value, key: Option<&str>) -> Value {
    let sensitive_key = key.is_some_and(|key| {
        matches!(
            key.to_ascii_lowercase().as_str(),
            "stdin" | "environment" | "env" | "arguments" | "result" | "authorization" | "cookie"
        )
    });
    if sensitive_key {
        return Value::String("[redacted]".into());
    }
    match value {
        Value::String(text) => Value::String(bound_and_redact(text, TEXT_LIMIT).0),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .take(512)
                .map(|value| redact_json(value, key))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), redact_json(value, Some(key))))
                .collect::<Map<_, _>>(),
        ),
        primitive => primitive.clone(),
    }
}

fn truncate_utf8(value: &str, limit: usize) -> (String, bool) {
    if value.len() <= limit {
        return (value.into(), false);
    }
    let mut boundary = limit;
    while !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    (format!("{}\n[truncated]", &value[..boundary]), true)
}

fn extract_id(value: &Value, paths: &[&str]) -> Result<String> {
    optional_id(value, paths).ok_or_else(|| {
        integrator_core::IntegratorError::Protocol("provider event missing thread id".into())
    })
}
fn optional_id(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str).map(str::to_owned))
        .filter(|id| valid_id(id))
}
fn optional_nested_id(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|id| valid_id(id))
}
fn required_string(value: &Value, key: &str) -> Result<String> {
    optional_string(value, key).ok_or_else(|| {
        integrator_core::IntegratorError::Protocol(format!("provider event missing {key}"))
    })
}
fn optional_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}
fn stable_item_id(thread: &str, turn: &str, item: &str) -> String {
    format!("codex:{thread}:{turn}:{item}")
}
fn extract_text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.get("text")
                .and_then(Value::as_str)
                .or_else(|| item.as_str())
        })
        .collect::<Vec<_>>()
        .join("\n")
}
fn item_status(value: Option<&Value>, completed: bool) -> ItemStatus {
    match value.and_then(Value::as_str) {
        Some("failed") => ItemStatus::Failed,
        Some("declined") => ItemStatus::Declined,
        Some("completed") => ItemStatus::Completed,
        _ if completed => ItemStatus::Completed,
        _ => ItemStatus::InProgress,
    }
}
fn timestamp_seconds(value: Option<&Value>) -> Option<DateTime<Utc>> {
    value
        .and_then(Value::as_i64)
        .and_then(|seconds| Utc.timestamp_opt(seconds, 0).single())
}
/// Render a provider JSON payload as bounded, redacted display text. Strings
/// pass through verbatim; everything else is pretty-printed JSON.
fn json_detail(value: Option<&Value>, limit: usize) -> Option<String> {
    let value = value?;
    let text = match value {
        Value::Null => return None,
        Value::String(text) => text.clone(),
        other => serde_json::to_string_pretty(other).ok()?,
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(bound_and_redact(trimmed, limit).0)
}

fn u64_field(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}
fn transport_id_from_value(value: &Value) -> Option<TransportRequestId> {
    match value {
        Value::Number(number) => Some(TransportRequestId::Number(number.clone())),
        Value::String(text) if text.len() <= 512 => Some(TransportRequestId::String(text.clone())),
        _ => None,
    }
}

/// Strip the client-injected `<conversation-context>` handoff block from an
/// echoed user message so the transcript shows only what the user typed.
fn strip_context_primer(text: &str) -> &str {
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

/// Collect ACP `diff` content blocks (`{type, path, oldText, newText}`) from a
/// tool call into file-change projections carrying a unified patch.
fn acp_diff_file_changes(blocks: &[Value]) -> Vec<FileChangeProjection> {
    blocks
        .iter()
        .take(512)
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("diff"))
        .filter_map(|block| {
            let path = block.get("path").and_then(Value::as_str)?;
            let old_text = block.get("oldText").and_then(Value::as_str);
            let new_text = block.get("newText").and_then(Value::as_str).unwrap_or("");
            Some(FileChangeProjection {
                path: bound_and_redact(path, PATH_LIMIT).0,
                change_kind: if old_text.is_none() {
                    FileChangeKind::Add
                } else {
                    FileChangeKind::Modify
                },
                patch: unified_patch(old_text.unwrap_or(""), new_text),
            })
        })
        .collect()
}

/// Render a whole-file before/after pair as unified-diff hunks. Returns `None`
/// when the texts are identical, so an unchanged block projects no patch.
fn unified_patch(old_text: &str, new_text: &str) -> Option<String> {
    if old_text == new_text {
        return None;
    }
    let diff = similar::TextDiff::from_lines(old_text, new_text);
    let patch = diff.unified_diff().context_radius(3).to_string();
    if patch.trim().is_empty() {
        return None;
    }
    Some(bound_and_redact_patch(&patch, DIFF_LIMIT).0)
}

/// Reduce one ACP `session/update` notification into the same projection
/// mutations the Codex reducer emits, so persistence and the renderer treat
/// both providers identically. ACP has no provider turn identity, so the
/// caller supplies the client-generated `turn_id` for the in-flight prompt.
pub fn reduce_acp_update(
    session_id: &str,
    turn_id: &str,
    agent_segment: u32,
    update: &Value,
    occurred_at: DateTime<Utc>,
) -> Result<Option<ReducedProviderEvent>> {
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default();
    // ACP calls this stream `agent_thought_chunk`, but it is raw thought
    // content rather than a provider-labeled summary. Do not persist or
    // forward it as a transcript item or audit payload.
    if kind == "agent_thought_chunk" {
        return Ok(None);
    }
    let (audit_json, audit_truncated) = bounded_audit(update);
    let mutation = match kind {
        "agent_message_chunk" => {
            let text = update
                .pointer("/content/text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            ProjectionMutation::AppendItem {
                // The segment counter opens a fresh transcript item whenever
                // tool activity interrupted the message stream, so text and
                // tool calls interleave in wire order instead of coalescing.
                provider_item_id: format!("{turn_id}-agent-{agent_segment}"),
                item_kind: ItemKind::AgentMessage,
                field: ItemTextField::Body,
                delta: text.to_owned(),
                updated_at: occurred_at,
            }
        }
        "tool_call" | "tool_call_update" => {
            let tool_call_id = update
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("tool-call");
            let title = update
                .get("title")
                .and_then(Value::as_str)
                .map(|title| bound_and_redact(title, TEXT_LIMIT).0);
            let status = match update.get("status").and_then(Value::as_str) {
                Some("completed") => ItemStatus::Completed,
                Some("failed") => ItemStatus::Failed,
                Some("pending") => ItemStatus::Pending,
                _ => ItemStatus::InProgress,
            };
            // Join every text content block; fall back to the structured
            // rawOutput payload when the agent sent no display content.
            let content_text = update
                .get("content")
                .and_then(Value::as_array)
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|block| {
                            block
                                .pointer("/content/text")
                                .or_else(|| block.get("text"))
                                .and_then(Value::as_str)
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .filter(|text| !text.trim().is_empty());
            let output = content_text
                .map(|text| bound_and_redact(&text, TOOL_DETAIL_LIMIT).0)
                .or_else(|| json_detail(update.get("rawOutput"), TOOL_DETAIL_LIMIT));
            // Diff content blocks carry the whole-file before/after text of an
            // edit (Cursor sends these instead of tool arguments). Project them
            // as file changes with a unified patch so the transcript can show
            // the same inline diff it renders for Codex file changes.
            let file_changes = update
                .get("content")
                .and_then(Value::as_array)
                .map(|blocks| acp_diff_file_changes(blocks))
                .filter(|changes| !changes.is_empty());
            let item = ItemProjection {
                id: format!("acp:{session_id}:{turn_id}:{tool_call_id}"),
                provider_item_id: tool_call_id.to_owned(),
                kind: ItemKind::McpTool,
                status,
                title: if kind == "tool_call" {
                    Some(title.unwrap_or_else(|| "Tool call".into()))
                } else {
                    title
                },
                body: None,
                native_skill: None,
                phase: None,
                command: None,
                cwd: None,
                output,
                exit_code: None,
                file_changes,
                mcp_server: None,
                // ACP reports a tool category ("read", "execute", ...) rather
                // than a server/tool pair; surface it as the tool label.
                mcp_tool: update
                    .get("kind")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                tool_input: json_detail(update.get("rawInput"), TOOL_DETAIL_LIMIT),
                truncated: false,
                updated_at: occurred_at,
            };
            if kind == "tool_call" {
                ProjectionMutation::ReplaceItem(item)
            } else {
                // Updates are partial: merge so a bare status change does not
                // wipe the title, input, and output captured at call time.
                ProjectionMutation::MergeItem(item)
            }
        }
        "plan" => {
            let entries = update
                .get("entries")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let truncated = entries.len() > PLAN_STEPS_LIMIT;
            let steps = entries
                .into_iter()
                .take(PLAN_STEPS_LIMIT)
                .enumerate()
                .map(|(index, entry)| {
                    let text = entry.get("content").and_then(Value::as_str).unwrap_or("");
                    let status = match entry.get("status").and_then(Value::as_str) {
                        Some("in_progress") => PlanStepStatus::InProgress,
                        Some("completed") => PlanStepStatus::Completed,
                        _ => PlanStepStatus::Pending,
                    };
                    PlanStep {
                        index: index as u32,
                        text: bound_and_redact(text, PLAN_STEP_LIMIT).0,
                        status,
                    }
                })
                .collect();
            ProjectionMutation::Plan { steps, truncated }
        }
        // Mode/command advertisements are session metadata, not transcript.
        _ => return Ok(None),
    };
    Ok(Some(ReducedProviderEvent {
        method: format!("session/update/{kind}"),
        thread_id: session_id.to_owned(),
        turn_id: Some(turn_id.to_owned()),
        audit_json,
        audit_truncated,
        mutation,
        occurred_at,
    }))
}

/// Reduce an ACP `session/request_permission` server request.
pub fn reduce_acp_permission_request(
    session_id: &str,
    turn_id: &str,
    request_id: TransportRequestId,
    params: &Value,
    occurred_at: DateTime<Utc>,
) -> ReducedProviderEvent {
    let (audit_json, audit_truncated) = bounded_audit(params);
    let tool_call_id = params
        .pointer("/toolCall/toolCallId")
        .and_then(Value::as_str)
        .unwrap_or("tool-call");
    let title = params
        .pointer("/toolCall/title")
        .and_then(Value::as_str)
        .map(|text| bound_and_redact(text, TEXT_LIMIT).0);
    ReducedProviderEvent {
        method: "session/request_permission".into(),
        thread_id: session_id.to_owned(),
        turn_id: Some(turn_id.to_owned()),
        audit_json,
        audit_truncated,
        mutation: ProjectionMutation::ApprovalRequested {
            request_id,
            approval_kind: ApprovalKind::CommandExecution,
            item_id: tool_call_id.to_owned(),
            approval_id: None,
            reason: title,
            command: None,
            cwd: None,
            plan_markdown: None,
        },
        occurred_at,
    }
}

/// Reduce a Cursor `cursor/create_plan` extension request into a plan-review
/// approval. The agent blocks until the client responds, so this surfaces the
/// full plan document for the user to approve or reject.
pub fn reduce_acp_plan_review_request(
    session_id: &str,
    turn_id: &str,
    request_id: TransportRequestId,
    params: &Value,
    occurred_at: DateTime<Utc>,
) -> ReducedProviderEvent {
    let (audit_json, audit_truncated) = bounded_audit(params);
    let item_id = params
        .get("toolCallId")
        .and_then(Value::as_str)
        .unwrap_or("create-plan");
    let name = params.get("name").and_then(Value::as_str);
    let overview = params.get("overview").and_then(Value::as_str);
    let reason = match (name, overview) {
        (Some(name), Some(overview)) if !overview.trim().is_empty() => {
            Some(format!("{name} — {overview}"))
        }
        (Some(name), _) => Some(name.to_owned()),
        (None, Some(overview)) => Some(overview.to_owned()),
        (None, None) => None,
    }
    .map(|text| bound_and_redact(&text, TEXT_LIMIT).0);
    let plan_markdown = params
        .get("plan")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(|text| bound_and_redact(text, PLAN_DOCUMENT_LIMIT).0);
    ReducedProviderEvent {
        method: "cursor/create_plan".into(),
        thread_id: session_id.to_owned(),
        turn_id: Some(turn_id.to_owned()),
        audit_json,
        audit_truncated,
        mutation: ProjectionMutation::ApprovalRequested {
            request_id,
            approval_kind: ApprovalKind::PlanReview,
            item_id: item_id.to_owned(),
            approval_id: None,
            reason,
            command: None,
            cwd: None,
            plan_markdown,
        },
        occurred_at,
    }
}

/// Build the mode projection event for an ACP session. Used both when
/// `session/new` advertises the initial mode state and when a
/// `current_mode_update` notification (or a client-side `session/set_mode`)
/// switches the current mode. `turn_id` is absent for between-turn changes.
pub fn acp_mode_event(
    session_id: &str,
    turn_id: Option<&str>,
    mode: ModeProjection,
    occurred_at: DateTime<Utc>,
) -> ReducedProviderEvent {
    ReducedProviderEvent {
        method: "session/update/current_mode_update".into(),
        thread_id: session_id.to_owned(),
        turn_id: turn_id.map(str::to_owned),
        audit_json: "{}".into(),
        audit_truncated: false,
        mutation: ProjectionMutation::Mode(mode),
        occurred_at,
    }
}

/// Parse the `modes` field of an ACP `session/new`/`session/load` response
/// (`SessionModeState`). Returns `None` when the agent does not support
/// session modes.
pub fn parse_acp_mode_state(response: &Value) -> Option<ModeProjection> {
    let modes = response.get("modes")?;
    let current = modes.get("currentModeId").and_then(Value::as_str)?;
    let available = modes
        .get("availableModes")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    Some(ModeOption {
                        id: entry.get("id").and_then(Value::as_str)?.to_owned(),
                        name: entry
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_else(|| {
                                entry.get("id").and_then(Value::as_str).unwrap_or("")
                            })
                            .to_owned(),
                        description: entry
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(ModeProjection {
        current_mode_id: current.to_owned(),
        available_modes: available,
    })
}

/// Build the terminal turn projection for a started or finished ACP prompt.
pub fn acp_turn_projection(
    turn_id: &str,
    status: TurnStatus,
    error: Option<String>,
    started_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> TurnProjection {
    let terminal = !matches!(status, TurnStatus::InProgress | TurnStatus::Pending);
    TurnProjection {
        id: turn_id.to_owned(),
        status,
        stop_requested: false,
        error: error.map(|text| bound_and_redact(&text, TEXT_LIMIT).0),
        started_at: Some(started_at),
        completed_at: terminal.then_some(now),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_primer_is_stripped_from_echoed_user_messages() {
        let event = reduce_provider_event(ProviderEventInput {
            method: "item/completed".into(),
            params: json!({ "threadId":"th1", "turnId":"tu1", "item": {
                "type":"userMessage", "id":"it1",
                "content":[{"text":"<conversation-context>\nUser: earlier\n</conversation-context>\n\nactual question"}]
            }}),
            request_id: None,
            occurred_at: Utc::now(),
        })
        .expect("reduce")
        .expect("accepted");
        assert!(matches!(
            event.mutation,
            ProjectionMutation::ReplaceItem(ItemProjection { body: Some(ref body), .. })
                if body == "actual question"
        ));
    }

    #[test]
    fn text_happy_path_reduces_to_agent_item() {
        let event = reduce_provider_event(ProviderEventInput {
            method: "item/completed".into(),
            params: json!({ "threadId":"th1", "turnId":"tu1", "item": { "type":"agentMessage", "id":"it1", "text":"Done" } }),
            request_id: None,
            occurred_at: Utc::now(),
        }).expect("reduce").expect("accepted");
        assert!(
            matches!(event.mutation, ProjectionMutation::ReplaceItem(ItemProjection { kind: ItemKind::AgentMessage, body: Some(ref body), .. }) if body == "Done")
        );
    }

    #[test]
    fn agent_message_phase_is_projected_from_item_events() {
        let commentary = reduce_provider_event(ProviderEventInput {
            method: "item/started".into(),
            params: json!({
                "threadId": "th1",
                "turnId": "tu1",
                "item": {
                    "type": "agentMessage",
                    "id": "it-commentary",
                    "text": "Working on it…",
                    "phase": "commentary"
                }
            }),
            request_id: None,
            occurred_at: Utc::now(),
        })
        .expect("reduce")
        .expect("accepted");
        assert!(matches!(
            commentary.mutation,
            ProjectionMutation::ReplaceItem(ItemProjection {
                kind: ItemKind::AgentMessage,
                phase: Some(integrator_core::AgentMessagePhase::Commentary),
                ..
            })
        ));

        let final_answer = reduce_provider_event(ProviderEventInput {
            method: "item/completed".into(),
            params: json!({
                "threadId": "th1",
                "turnId": "tu1",
                "item": {
                    "type": "agentMessage",
                    "id": "it-final",
                    "text": "Done.",
                    "phase": "final_answer"
                }
            }),
            request_id: None,
            occurred_at: Utc::now(),
        })
        .expect("reduce")
        .expect("accepted");
        assert!(matches!(
            final_answer.mutation,
            ProjectionMutation::ReplaceItem(ItemProjection {
                kind: ItemKind::AgentMessage,
                phase: Some(integrator_core::AgentMessagePhase::FinalAnswer),
                ..
            })
        ));

        let unknown = reduce_provider_event(ProviderEventInput {
            method: "item/completed".into(),
            params: json!({
                "threadId": "th1",
                "turnId": "tu1",
                "item": {
                    "type": "agentMessage",
                    "id": "it-legacy",
                    "text": "Legacy reply",
                    "phase": "something_else"
                }
            }),
            request_id: None,
            occurred_at: Utc::now(),
        })
        .expect("reduce")
        .expect("accepted");
        assert!(matches!(
            unknown.mutation,
            ProjectionMutation::ReplaceItem(ItemProjection {
                kind: ItemKind::AgentMessage,
                phase: None,
                ..
            })
        ));
    }

    #[test]
    fn long_file_paths_are_not_mistaken_for_high_entropy_secrets() {
        assert_eq!(
            redact_text("/Users/lukekabbash/Documents/Code/integrator-3/src/App2.tsx"),
            "/Users/lukekabbash/Documents/Code/integrator-3/src/App2.tsx"
        );
        assert_eq!(
            redact_text(r"C:\Users\Luke\Documents\Integrator-3\src\App2.tsx"),
            r"C:\Users\Luke\Documents\Integrator-3\src\App2.tsx"
        );
    }

    #[test]
    fn high_entropy_non_path_tokens_are_still_redacted() {
        assert_eq!(
            redact_text("prefix AbcdefghijklmnopQRSTUVWX1234567890 suffix"),
            "prefix [redacted] suffix"
        );
    }

    #[test]
    fn terminal_stdin_is_never_reduced() {
        let event = reduce_provider_event(ProviderEventInput {
            method: "item/commandExecution/terminalInteraction".into(),
            params: json!({"threadId":"th1","turnId":"tu1","itemId":"it1","stdin":"secret"}),
            request_id: None,
            occurred_at: Utc::now(),
        })
        .expect("reduce");
        assert!(event.is_none());
    }

    #[test]
    fn audit_redacts_headers_env_private_keys_and_mcp_arguments() {
        let (audit, _) = bounded_audit(
            &json!({ "authorization":"Bearer abc", "env":"API_TOKEN=secret", "arguments":{"password":"secret"}, "text":"-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" }),
        );
        assert!(!audit.contains("abc"));
        assert!(!audit.contains("secret"));
        assert!(audit.contains("redacted"));
    }

    #[test]
    fn raw_codex_reasoning_content_is_not_written_to_audit() {
        let event = reduce_provider_event(ProviderEventInput {
            method: "item/completed".into(),
            params: json!({
                "threadId": "th1",
                "turnId": "tu1",
                "item": {
                    "type": "reasoning",
                    "id": "reasoning-1",
                    "summary": [{"text": "Safe provider summary"}],
                    "content": [{"text": "Raw hidden chain of thought"}]
                }
            }),
            request_id: None,
            occurred_at: Utc::now(),
        })
        .expect("reduce")
        .expect("accepted");
        assert!(event.audit_json.contains("Safe provider summary"));
        assert!(!event.audit_json.contains("Raw hidden chain of thought"));
    }

    #[test]
    fn empty_codex_reasoning_items_do_not_create_transcript_rows() {
        for method in ["item/started", "item/completed"] {
            let event = reduce_provider_event(ProviderEventInput {
                method: method.into(),
                params: json!({
                    "threadId": "th1",
                    "turnId": "tu1",
                    "item": {
                        "type": "reasoning",
                        "id": "reasoning-empty",
                        "summary": [],
                        "content": []
                    }
                }),
                request_id: None,
                occurred_at: Utc::now(),
            })
            .expect("reduce");
            assert!(event.is_none(), "{method} should be ignored");
        }
    }

    #[test]
    fn acp_session_modes_parse_from_session_new_response() {
        let mode = parse_acp_mode_state(&json!({
            "sessionId": "sess-1",
            "modes": {
                "currentModeId": "agent",
                "availableModes": [
                    {"id": "agent", "name": "Agent", "description": "Full agent capabilities"},
                    {"id": "plan", "name": "Plan", "description": "Read-only planning"},
                    {"id": "ask", "name": "Ask"}
                ]
            }
        }))
        .expect("mode state");
        assert_eq!(mode.current_mode_id, "agent");
        assert_eq!(mode.available_modes.len(), 3);
        assert_eq!(mode.available_modes[1].name, "Plan");
        assert_eq!(
            mode.available_modes[1].description.as_deref(),
            Some("Read-only planning")
        );
        assert_eq!(mode.available_modes[2].description, None);
    }

    #[test]
    fn acp_session_modes_absent_or_malformed_yield_none() {
        assert!(parse_acp_mode_state(&json!({ "sessionId": "sess-1" })).is_none());
        assert!(parse_acp_mode_state(&json!({ "modes": { "availableModes": [] } })).is_none());
    }

    #[test]
    fn acp_current_mode_update_stays_out_of_the_transcript() {
        // The pump handles mode updates via session metadata; the transcript
        // reducer must keep dropping them rather than surfacing a raw item.
        let event = reduce_acp_update(
            "session-1",
            "turn-1",
            0,
            &json!({ "sessionUpdate": "current_mode_update", "currentModeId": "plan" }),
            Utc::now(),
        )
        .expect("reduce");
        assert!(event.is_none());
    }

    #[test]
    fn cursor_create_plan_reduces_to_plan_review_approval() {
        let event = reduce_acp_plan_review_request(
            "session-1",
            "turn-1",
            TransportRequestId::Number(7.into()),
            &json!({
                "toolCallId": "call-1",
                "name": "Add subtract function",
                "overview": "Add subtract(a, b) to hello.py",
                "plan": "# Plan\n\nAdd the function.",
                "todos": [{"id": "t1", "content": "Add subtract", "status": "pending"}]
            }),
            Utc::now(),
        );
        match event.mutation {
            ProjectionMutation::ApprovalRequested {
                approval_kind,
                item_id,
                reason,
                plan_markdown,
                ..
            } => {
                assert_eq!(approval_kind, ApprovalKind::PlanReview);
                assert_eq!(item_id, "call-1");
                assert_eq!(
                    reason.as_deref(),
                    Some("Add subtract function — Add subtract(a, b) to hello.py")
                );
                assert_eq!(
                    plan_markdown.as_deref(),
                    Some("# Plan\n\nAdd the function.")
                );
            }
            other => panic!("expected plan-review approval, got {other:?}"),
        }
    }

    #[test]
    fn cursor_create_plan_survives_missing_fields() {
        let event = reduce_acp_plan_review_request(
            "session-1",
            "turn-1",
            TransportRequestId::Number(8.into()),
            &json!({}),
            Utc::now(),
        );
        match event.mutation {
            ProjectionMutation::ApprovalRequested {
                approval_kind,
                item_id,
                reason,
                plan_markdown,
                ..
            } => {
                assert_eq!(approval_kind, ApprovalKind::PlanReview);
                assert_eq!(item_id, "create-plan");
                assert_eq!(reason, None);
                assert_eq!(plan_markdown, None);
            }
            other => panic!("expected plan-review approval, got {other:?}"),
        }
    }

    #[test]
    fn cursor_create_plan_bounds_oversized_plan_documents() {
        let huge = "x".repeat(PLAN_DOCUMENT_LIMIT + 1024);
        let event = reduce_acp_plan_review_request(
            "session-1",
            "turn-1",
            TransportRequestId::Number(9.into()),
            &json!({ "toolCallId": "call-1", "plan": huge }),
            Utc::now(),
        );
        match event.mutation {
            ProjectionMutation::ApprovalRequested { plan_markdown, .. } => {
                let plan = plan_markdown.expect("plan");
                // Bounded to the document limit plus the truncation marker.
                assert!(plan.len() <= PLAN_DOCUMENT_LIMIT + "\n[truncated]".len());
                assert!(plan.ends_with("[truncated]"));
            }
            other => panic!("expected plan-review approval, got {other:?}"),
        }
    }

    #[test]
    fn raw_acp_thought_chunks_are_dropped() {
        let event = reduce_acp_update(
            "session-1",
            "turn-1",
            0,
            &json!({
                "sessionUpdate": "agent_thought_chunk",
                "content": {"type": "text", "text": "Raw hidden chain of thought"}
            }),
            Utc::now(),
        )
        .expect("reduce");
        assert!(event.is_none());
    }

    #[test]
    fn acp_tool_call_captures_input_output_and_merges_updates() {
        let event = reduce_acp_update(
            "session-1",
            "turn-1",
            0,
            &json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "call-1",
                "title": "Read main.rs",
                "kind": "read",
                "status": "in_progress",
                "rawInput": {"path": "src/main.rs"}
            }),
            Utc::now(),
        )
        .expect("reduce")
        .expect("accepted");
        let ProjectionMutation::ReplaceItem(item) = &event.mutation else {
            panic!("expected replace mutation");
        };
        assert_eq!(item.title.as_deref(), Some("Read main.rs"));
        assert_eq!(item.mcp_tool.as_deref(), Some("read"));
        assert!(
            item.tool_input
                .as_deref()
                .expect("tool input")
                .contains("src/main.rs")
        );

        let update = reduce_acp_update(
            "session-1",
            "turn-1",
            0,
            &json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call-1",
                "status": "completed",
                "content": [{"type": "content", "content": {"type": "text", "text": "fn main() {}"}}]
            }),
            Utc::now(),
        )
        .expect("reduce")
        .expect("accepted");
        let ProjectionMutation::MergeItem(item) = &update.mutation else {
            panic!("expected merge mutation");
        };
        assert_eq!(item.status, ItemStatus::Completed);
        assert_eq!(
            item.title, None,
            "partial update must not fabricate a title"
        );
        assert_eq!(item.output.as_deref(), Some("fn main() {}"));
    }

    #[test]
    fn acp_diff_content_blocks_project_file_changes_with_unified_patch() {
        let event = reduce_acp_update(
            "session-1",
            "turn-1",
            0,
            &json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call-1",
                "status": "completed",
                "content": [{
                    "type": "diff",
                    "path": "C:\\repo\\src\\main.rs",
                    "oldText": "fn main() {\n    println!(\"old\");\n}\n",
                    "newText": "fn main() {\n    println!(\"new\");\n}\n"
                }]
            }),
            Utc::now(),
        )
        .expect("reduce")
        .expect("accepted");
        let ProjectionMutation::MergeItem(item) = &event.mutation else {
            panic!("expected merge mutation");
        };
        let changes = item.file_changes.as_ref().expect("file changes");
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "C:\\repo\\src\\main.rs");
        assert_eq!(changes[0].change_kind, FileChangeKind::Modify);
        let patch = changes[0].patch.as_deref().expect("patch");
        assert!(patch.contains("@@"), "patch has hunk headers: {patch}");
        assert!(
            patch.contains("-    println!(\"old\");"),
            "patch: {patch:?}"
        );
        assert!(
            patch.contains("+    println!(\"new\");"),
            "patch: {patch:?}"
        );
    }

    #[test]
    fn acp_diff_block_without_old_text_projects_an_added_file() {
        let event = reduce_acp_update(
            "session-1",
            "turn-1",
            0,
            &json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "call-2",
                "title": "Write File",
                "kind": "edit",
                "content": [{
                    "type": "diff",
                    "path": "src/new.rs",
                    "newText": "pub fn added() {}\n"
                }]
            }),
            Utc::now(),
        )
        .expect("reduce")
        .expect("accepted");
        let ProjectionMutation::ReplaceItem(item) = &event.mutation else {
            panic!("expected replace mutation");
        };
        let changes = item.file_changes.as_ref().expect("file changes");
        assert_eq!(changes[0].change_kind, FileChangeKind::Add);
        assert!(
            changes[0]
                .patch
                .as_deref()
                .expect("patch")
                .contains("+pub fn added() {}")
        );
    }

    #[test]
    fn acp_agent_segments_open_distinct_items() {
        let chunk = json!({
            "sessionUpdate": "agent_message_chunk",
            "content": {"type": "text", "text": "hello"}
        });
        let first = reduce_acp_update("session-1", "turn-1", 0, &chunk, Utc::now())
            .expect("reduce")
            .expect("accepted");
        let second = reduce_acp_update("session-1", "turn-1", 1, &chunk, Utc::now())
            .expect("reduce")
            .expect("accepted");
        let ids: Vec<_> = [first, second]
            .iter()
            .map(|event| match &event.mutation {
                ProjectionMutation::AppendItem {
                    provider_item_id, ..
                } => provider_item_id.clone(),
                _ => panic!("expected append mutation"),
            })
            .collect();
        assert_eq!(ids, vec!["turn-1-agent-0", "turn-1-agent-1"]);
    }

    #[test]
    fn codex_mcp_tool_call_captures_arguments_and_named_title() {
        let event = reduce_provider_event(ProviderEventInput {
            method: "item/completed".into(),
            params: json!({
                "threadId": "th1",
                "turnId": "tu1",
                "item": {
                    "type": "mcpToolCall",
                    "id": "tool-1",
                    "server": "github",
                    "tool": "search",
                    "arguments": {"query": "flaky tests"},
                    "result": {"matches": 3}
                }
            }),
            request_id: None,
            occurred_at: Utc::now(),
        })
        .expect("reduce")
        .expect("accepted");
        let ProjectionMutation::ReplaceItem(item) = &event.mutation else {
            panic!("expected replace mutation");
        };
        assert_eq!(item.title.as_deref(), Some("github · search"));
        assert!(
            item.tool_input
                .as_deref()
                .expect("tool input")
                .contains("flaky tests")
        );
        assert!(
            item.output
                .as_deref()
                .expect("tool output")
                .contains("matches")
        );
    }

    #[test]
    fn string_approval_request_id_is_preserved() {
        let request = TransportRequestId::String("request-alpha".into());
        let event = reduce_provider_event(ProviderEventInput { method: "item/fileChange/requestApproval".into(), params: json!({"threadId":"th1","turnId":"tu1","itemId":"it1","approvalId":"approval-a"}), request_id: Some(request.clone()), occurred_at: Utc::now() }).expect("reduce").expect("accepted");
        assert!(
            matches!(event.mutation, ProjectionMutation::ApprovalRequested { request_id, approval_id: Some(ref id), .. } if request_id == request && id == "approval-a")
        );
    }
}
