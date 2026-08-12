use chrono::{DateTime, TimeZone, Utc};
use integrator_core::{
    ApprovalKind, ConnectionState, FileChangeKind, FileChangeProjection, ItemKind, ItemProjection,
    ItemStatus, ModeOption, ModeProjection, PlanStep, PlanStepStatus, QuestionOption, Result,
    TransportRequestId, TurnProjection, TurnStatus, UsageProjection,
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
        /// Answer choices for `Question` approvals; empty otherwise.
        options: Vec<QuestionOption>,
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
                options: Vec::new(),
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
        "webSearch" => {
            projection.kind = ItemKind::McpTool;
            projection.title = Some("Web search".into());
            projection.mcp_tool = Some("web_search".into());
            if let Some(query) = web_search_query(value) {
                projection.body = Some(query.clone());
                projection.tool_input = Some(
                    serde_json::to_string_pretty(&json!({ "query": query }))
                        .expect("web search input serializes"),
                );
            }
        }
        _ => {
            projection.title = Some("Provider activity".into());
            projection.body = Some("Additional provider activity".into());
        }
    }
    Ok(projection)
}

fn web_search_query(value: &Value) -> Option<String> {
    [
        value.get("query"),
        value.pointer("/action/query"),
        value.pointer("/action/pattern"),
        value.pointer("/action/url"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .map(str::trim)
    .find(|query| !query.is_empty())
    .map(|query| bound_and_redact(query, TEXT_LIMIT).0)
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

// Provider tool output may already have been visible to the model. Do not hide
// legitimate evidence from the user based on entropy or length guesses; redact
// only explicit credential syntax that must not become durable transcript data.
fn redact_text(value: &str) -> String {
    if let Some(redacted) = redact_json_document(value) {
        return redacted;
    }
    let mut private_key = false;
    let mut output = String::with_capacity(value.len());
    for segment in value.split_inclusive('\n') {
        let (line, ending) = if let Some(line) = segment.strip_suffix("\r\n") {
            (line, "\r\n")
        } else if let Some(line) = segment.strip_suffix('\n') {
            (line, "\n")
        } else {
            (segment, "")
        };
        let upper = line.to_ascii_uppercase();
        if upper.contains("-----BEGIN") && upper.contains("PRIVATE KEY-----") {
            private_key = true;
            output.push_str("[redacted-private-key]");
        } else if private_key {
            if upper.contains("-----END") && upper.contains("PRIVATE KEY-----") {
                private_key = false;
            }
            output.push_str("[redacted-private-key]");
        } else if let Some(header) = redact_sensitive_header(line) {
            output.push_str(&header);
        } else {
            output.push_str(&redact_line(line));
        }
        output.push_str(ending);
    }
    output
}

fn redact_sensitive_header(line: &str) -> Option<String> {
    let value = line.trim_start();
    let (name, _) = value.split_once(':')?;
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization" | "cookie" | "set-cookie"
    )
    .then(|| {
        let indentation = &line[..line.len() - value.len()];
        format!("{indentation}{name}: [redacted]")
    })
}

fn redact_line(line: &str) -> String {
    let mut output = String::with_capacity(line.len());
    let mut cursor = 0;
    let mut redact_next = false;
    while cursor < line.len() {
        let token_start = line[cursor..]
            .char_indices()
            .find(|(_, character)| !character.is_whitespace())
            .map(|(index, _)| cursor + index)
            .unwrap_or(line.len());
        output.push_str(&line[cursor..token_start]);
        if token_start == line.len() {
            break;
        }
        let token_end = line[token_start..]
            .char_indices()
            .find(|(_, character)| character.is_whitespace())
            .map(|(index, _)| token_start + index)
            .unwrap_or(line.len());
        let token = &line[token_start..token_end];
        let normalized = token.trim_matches(|character: char| {
            matches!(
                character,
                '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | ',' | ';'
            )
        });
        if redact_next || looks_like_known_secret(normalized) {
            output.push_str("[redacted]");
            redact_next = false;
        } else if normalized.eq_ignore_ascii_case("bearer") {
            output.push_str(token);
            redact_next = true;
        } else if let Some(redacted) = redact_sensitive_assignment(token) {
            output.push_str(&redacted);
        } else if token.contains("://") && token.contains('@') {
            output.push_str(&redact_credential_url(token));
        } else {
            output.push_str(token);
        }
        cursor = token_end;
    }
    output
}

fn redact_sensitive_assignment(token: &str) -> Option<String> {
    let (key, _) = token.split_once('=')?;
    is_sensitive_assignment_key(key).then(|| format!("{key}=[redacted]"))
}

fn is_sensitive_assignment_key(key: &str) -> bool {
    let key = key
        .trim_matches(|character: char| {
            matches!(
                character,
                '"' | '\'' | '`' | '(' | '[' | '{' | '<' | '-' | '/'
            )
        })
        .replace('-', "_")
        .to_ascii_uppercase();
    matches!(
        key.as_str(),
        "TOKEN"
            | "AUTH_TOKEN"
            | "ACCESS_TOKEN"
            | "REFRESH_TOKEN"
            | "ID_TOKEN"
            | "API_KEY"
            | "APIKEY"
            | "SECRET"
            | "CLIENT_SECRET"
            | "PASSWORD"
            | "PASSWD"
            | "PRIVATE_KEY"
            | "GITHUB_PAT"
            | "AWS_SECRET_ACCESS_KEY"
            | "AWS_SESSION_TOKEN"
    ) || key.ends_with("_TOKEN")
        || key.ends_with("_SECRET")
        || key.ends_with("_PASSWORD")
        || key.ends_with("_PASSWD")
        || key.ends_with("_API_KEY")
        || key.ends_with("_PRIVATE_KEY")
        || key.ends_with("_PAT")
}

fn looks_like_known_secret(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    (token.len() >= 16
        && (lower.starts_with("sk-")
            || lower.starts_with("ghp_")
            || lower.starts_with("gho_")
            || lower.starts_with("ghu_")
            || lower.starts_with("ghs_")
            || lower.starts_with("ghr_")
            || lower.starts_with("github_pat_")
            || lower.starts_with("xoxb-")
            || lower.starts_with("xoxp-")
            || lower.starts_with("xoxa-")
            || lower.starts_with("xoxr-")))
        || (token.len() >= 30 && token.starts_with("AIza"))
        || (token.len() == 20 && (token.starts_with("AKIA") || token.starts_with("ASIA")))
        || looks_like_jwt(token)
}

fn redact_json_document(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut parsed = serde_json::from_str::<Value>(trimmed).ok()?;
    if !redact_explicit_json_secrets(&mut parsed) {
        return None;
    }
    let start = value.len() - value.trim_start().len();
    let end = value.trim_end().len();
    let serialized = if trimmed.contains('\n') {
        serde_json::to_string_pretty(&parsed).ok()?
    } else {
        parsed.to_string()
    };
    Some(format!(
        "{}{}{}",
        &value[..start],
        serialized,
        &value[end..]
    ))
}

fn redact_explicit_json_secrets(value: &mut Value) -> bool {
    match value {
        Value::Object(fields) => {
            let mut changed = false;
            for (key, value) in fields {
                if is_sensitive_json_key(key) {
                    *value = Value::String("[redacted]".into());
                    changed = true;
                } else {
                    changed |= redact_explicit_json_secrets(value);
                }
            }
            changed
        }
        Value::Array(values) => {
            let mut changed = false;
            for value in values {
                changed |= redact_explicit_json_secrets(value);
            }
            changed
        }
        Value::String(text) => {
            let trimmed = text.trim();
            let replacement = if looks_like_known_secret(trimmed) {
                Some("[redacted]".into())
            } else if trimmed
                .get(..7)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer "))
            {
                Some("Bearer [redacted]".into())
            } else if trimmed.contains("://") && trimmed.contains('@') {
                Some(redact_credential_url(text))
            } else if trimmed.to_ascii_uppercase().contains("-----BEGIN")
                && trimmed.to_ascii_uppercase().contains("PRIVATE KEY-----")
            {
                Some("[redacted-private-key]".into())
            } else {
                None
            };
            if let Some(replacement) = replacement {
                *text = replacement;
                true
            } else {
                false
            }
        }
        _ => false,
    }
}

fn is_sensitive_json_key(key: &str) -> bool {
    let key = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect::<String>();
    matches!(
        key.as_str(),
        "token"
            | "authtoken"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "sessiontoken"
            | "csrftoken"
            | "apikey"
            | "secret"
            | "clientsecret"
            | "password"
            | "passwd"
            | "privatekey"
            | "githubpat"
            | "authorization"
            | "cookie"
            | "setcookie"
            | "awssecretaccesskey"
    ) || key.ends_with("apikey")
        || key.ends_with("password")
        || key.ends_with("privatekey")
        || key.ends_with("clientsecret")
}

fn looks_like_jwt(token: &str) -> bool {
    let mut segments = token.split('.');
    let Some(header) = segments.next() else {
        return false;
    };
    let Some(payload) = segments.next() else {
        return false;
    };
    let Some(signature) = segments.next() else {
        return false;
    };
    segments.next().is_none()
        && header.starts_with("eyJ")
        && payload.len() >= 8
        && signature.len() >= 8
        && [header, payload, signature].into_iter().all(|segment| {
            segment.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        })
}

fn bound_and_redact_patch(value: &str, limit: usize) -> (String, bool) {
    truncate_utf8(&redact_text(value), limit)
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

/// First absolute/relative path from ACP `locations` (follow-along file hints).
fn acp_location_path(update: &Value) -> Option<String> {
    let locations = update.get("locations")?.as_array()?;
    for location in locations {
        let Some(path) = location
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
        else {
            continue;
        };
        return Some(bound_and_redact(path, PATH_LIMIT).0);
    }
    None
}

fn tool_input_object_has_path(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    ["path", "filePath", "file_path", "filename", "file"]
        .iter()
        .any(|key| {
            object
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty())
        })
}

/// Prefer `rawInput`; when Cursor/ACP only reports `locations`, fold the path
/// in so the transcript can show "Read main.rs" instead of a bare "Read".
fn acp_tool_input(update: &Value) -> Option<String> {
    let location_path = acp_location_path(update);
    match update.get("rawInput") {
        Some(Value::Object(map)) => {
            let mut enriched = map.clone();
            if !tool_input_object_has_path(&Value::Object(enriched.clone()))
                && let Some(path) = location_path
            {
                enriched.insert("path".into(), Value::String(path));
            }
            json_detail(Some(&Value::Object(enriched)), TOOL_DETAIL_LIMIT)
        }
        Some(other) => json_detail(Some(other), TOOL_DETAIL_LIMIT)
            .or_else(|| location_path.map(|path| json!({ "path": path }).to_string())),
        None => location_path.map(|path| json!({ "path": path }).to_string()),
    }
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

/// Strip leading client-injected context blocks from an echoed user message
/// so the transcript shows only what the user typed.
fn strip_context_primer(text: &str) -> &str {
    const BLOCKS: [(&str, &str); 5] = [
        ("<ai-integrator-harness>", "</ai-integrator-harness>"),
        ("<integrator-skills>", "</integrator-skills>"),
        ("<delegation>", "</delegation>"),
        ("<delegation-update>", "</delegation-update>"),
        ("<conversation-context>", "</conversation-context>"),
    ];
    let mut remaining = text;
    loop {
        let trimmed = remaining.trim_start();
        let Some((rest, close)) = BLOCKS
            .iter()
            .find_map(|(open, close)| trimmed.strip_prefix(open).map(|rest| (rest, *close)))
        else {
            return remaining;
        };
        let Some(end) = rest.find(close) else {
            return remaining;
        };
        remaining = rest[end + close.len()..].trim_start();
    }
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
    // ACP `agent_thought_chunk` is raw hidden thought. Persist only a host
    // activity placeholder so xhigh/long-reasoning turns are not a blank
    // spinner; never copy the vendor text into the transcript or audit.
    if kind == "agent_thought_chunk" {
        return Ok(Some(ReducedProviderEvent {
            method: "session/update/agent_thought_chunk".into(),
            thread_id: session_id.to_owned(),
            turn_id: Some(turn_id.to_owned()),
            audit_json: r#"{"sessionUpdate":"agent_thought_chunk"}"#.into(),
            audit_truncated: false,
            mutation: ProjectionMutation::ReplaceItem(ItemProjection {
                id: format!("acp:{session_id}:{turn_id}:reasoning"),
                provider_item_id: format!("{turn_id}-reasoning"),
                kind: ItemKind::ReasoningSummary,
                status: ItemStatus::InProgress,
                title: Some("Reasoning".into()),
                body: Some("Thinking…".into()),
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
                updated_at: occurred_at,
            }),
            occurred_at,
        }));
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
                tool_input: acp_tool_input(update),
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
    let options = acp_question_options(params);
    let approval_kind = if options.is_empty() {
        ApprovalKind::CommandExecution
    } else {
        ApprovalKind::Question
    };
    ReducedProviderEvent {
        method: "session/request_permission".into(),
        thread_id: session_id.to_owned(),
        turn_id: Some(turn_id.to_owned()),
        audit_json,
        audit_truncated,
        mutation: ProjectionMutation::ApprovalRequested {
            request_id,
            approval_kind,
            item_id: tool_call_id.to_owned(),
            approval_id: None,
            reason: title,
            command: None,
            cwd: None,
            plan_markdown: None,
            options,
        },
        occurred_at,
    }
}

/// ACP has no elicitation method — `session/request_permission` is the only
/// client-interaction channel, built to gate one command or file edit behind
/// allow/reject. Its four option kinds (`allow_once`, `allow_always`,
/// `reject_once`, `reject_always`) each mean one specific thing, so a
/// legitimate command/file-edit gate never offers two options sharing a
/// kind. When a kind repeats, the agent is using this channel to offer
/// several distinct named answers instead — almost always a multiple-choice
/// question (e.g. a coding CLI's own "ask the user" tool bridged onto ACP).
/// Detect that shape and surface the real answer choices, keyed by the
/// `optionId` the response must echo back.
fn acp_question_options(params: &Value) -> Vec<QuestionOption> {
    let raw = params
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut kind_counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for option in &raw {
        let kind = option.get("kind").and_then(Value::as_str).unwrap_or("");
        *kind_counts.entry(kind).or_insert(0) += 1;
    }
    if !kind_counts.values().any(|count| *count > 1) {
        return Vec::new();
    }
    raw.iter()
        .filter_map(|option| {
            let option_id = option.get("optionId").and_then(Value::as_str)?;
            let label = option
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(option_id);
            Some(QuestionOption {
                option_id: bound_and_redact(option_id, TEXT_LIMIT).0,
                label: bound_and_redact(label, TEXT_LIMIT).0,
            })
        })
        .collect()
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
            options: Vec::new(),
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

/// Parse either ACP's legacy `modes` field or the current generic `mode`
/// config option. Returns `None` when the agent does not advertise modes.
pub fn parse_acp_mode_state(response: &Value) -> Option<ModeProjection> {
    if let Some(modes) = response.get("modes") {
        let current = modes.get("currentModeId").and_then(Value::as_str)?;
        let available = modes
            .get("availableModes")
            .and_then(Value::as_array)
            .map(|entries| parse_acp_mode_options(entries, "id"))
            .unwrap_or_default();
        return Some(ModeProjection {
            current_mode_id: current.to_owned(),
            available_modes: available,
        });
    }

    let option = response
        .get("configOptions")
        .or_else(|| response.get("config_options"))?
        .as_array()
        .and_then(|options| {
            options.iter().find(|option| {
                option.get("category").and_then(Value::as_str) == Some("mode")
                    || option.get("id").and_then(Value::as_str) == Some("mode")
            })
        })?;
    let current = option.get("currentValue").and_then(Value::as_str)?;
    let available = option
        .get("options")
        .and_then(Value::as_array)
        .map(|entries| parse_acp_mode_options(entries, "value"))
        .unwrap_or_default();
    Some(ModeProjection {
        current_mode_id: current.to_owned(),
        available_modes: available,
    })
}

fn parse_acp_mode_options(entries: &[Value], id_key: &str) -> Vec<ModeOption> {
    entries
        .iter()
        .filter_map(|entry| {
            let id = entry.get(id_key).and_then(Value::as_str)?;
            Some(ModeOption {
                id: id.to_owned(),
                name: entry
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_owned(),
                description: entry
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect()
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
    fn all_leading_integrator_context_is_stripped_from_echoed_user_messages() {
        let event = reduce_provider_event(ProviderEventInput {
            method: "item/completed".into(),
            params: json!({ "threadId":"th1", "turnId":"tu1", "item": {
                "type":"userMessage", "id":"it1",
                "content":[{"text":"<ai-integrator-harness>\nprivate\n</ai-integrator-harness>\n\
                    <integrator-skills>\nskills\n</integrator-skills>\n\
                    <delegation>\ntools\n</delegation>\nactual question"}]
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
    fn legitimate_paths_and_opaque_identifiers_remain_visible() {
        assert_eq!(
            redact_text("/Users/lukekabbash/Documents/Code/integrator-3/src/App2.tsx"),
            "/Users/lukekabbash/Documents/Code/integrator-3/src/App2.tsx"
        );
        assert_eq!(
            redact_text(r"C:\Users\Luke\Documents\Integrator-3\src\App2.tsx"),
            r"C:\Users\Luke\Documents\Integrator-3\src\App2.tsx"
        );
        assert_eq!(
            redact_text("prefix AbcdefghijklmnopQRSTUVWX1234567890 suffix"),
            "prefix AbcdefghijklmnopQRSTUVWX1234567890 suffix"
        );
    }

    #[test]
    fn model_visible_json_rpc_output_is_preserved_exactly() {
        let output = r#"{"id":1,"jsonrpc":"2.0","result":{"capabilities":{"tools":{}},"protocolVersion":"2024-11-05","serverInfo":{"name":"integrator-local-tools","version":"0.1.0"}}}"#;
        assert_eq!(redact_text(output), output);
    }

    #[test]
    fn conservative_redaction_preserves_layout_and_non_secret_names() {
        let output =
            "  TOKEN_COUNT=2048  SECRETARY=Luke\tPASSWORD_POLICY=required\n    aligned output\n";
        assert_eq!(redact_text(output), output);
    }

    #[test]
    fn explicit_credentials_are_still_redacted() {
        let openai_key = format!("sk-{}", "a".repeat(32));
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123";
        assert_eq!(
            redact_text(&format!(
                "OPENAI_API_KEY=secret Bearer bearer-value {openai_key} {jwt}"
            )),
            "OPENAI_API_KEY=[redacted] Bearer [redacted] [redacted] [redacted]"
        );
        assert_eq!(
            redact_text("  Authorization: Bearer bearer-value\r\nCookie: session=value\r\n"),
            "  Authorization: [redacted]\r\nCookie: [redacted]\r\n"
        );
    }

    #[test]
    fn json_redaction_targets_secret_fields_without_hiding_metrics() {
        let output = r#"{"apiKey":"secret-value","tokenCount":2048,"passwordPolicy":"required"}"#;
        assert_eq!(
            redact_text(output),
            r#"{"apiKey":"[redacted]","passwordPolicy":"required","tokenCount":2048}"#
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
    fn acp_session_modes_parse_from_config_options() {
        let mode = parse_acp_mode_state(&json!({
            "sessionId": "sess-kimi",
            "configOptions": [{
                "type": "select",
                "id": "mode",
                "category": "mode",
                "currentValue": "default",
                "options": [
                    {"value": "default", "name": "Default", "description": "Manual approvals"},
                    {"value": "plan", "name": "Plan", "description": "Read-only planning"},
                    {"value": "auto", "name": "Auto"},
                    {"value": "yolo", "name": "YOLO"}
                ]
            }]
        }))
        .expect("mode config option");
        assert_eq!(mode.current_mode_id, "default");
        assert_eq!(mode.available_modes.len(), 4);
        assert_eq!(mode.available_modes[1].id, "plan");
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
    fn acp_permission_request_with_unique_option_kinds_stays_command_execution() {
        let event = reduce_acp_permission_request(
            "session-1",
            "turn-1",
            TransportRequestId::Number(1.into()),
            &json!({
                "toolCall": {"toolCallId": "call-1", "title": "rm -rf build/"},
                "options": [
                    {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "reject", "name": "Reject", "kind": "reject_once"},
                ]
            }),
            Utc::now(),
        );
        match event.mutation {
            ProjectionMutation::ApprovalRequested {
                approval_kind,
                options,
                reason,
                ..
            } => {
                assert_eq!(approval_kind, ApprovalKind::CommandExecution);
                assert!(options.is_empty());
                assert_eq!(reason.as_deref(), Some("rm -rf build/"));
            }
            other => panic!("expected command-execution approval, got {other:?}"),
        }
    }

    #[test]
    fn acp_permission_request_with_repeated_option_kind_becomes_a_question() {
        // A coding CLI's own "ask the user" tool, bridged onto ACP's only
        // client-interaction channel: three distinct answers, all offered
        // as `allow_once` because none of them reject anything.
        let event = reduce_acp_permission_request(
            "session-1",
            "turn-1",
            TransportRequestId::Number(2.into()),
            &json!({
                "toolCall": {"toolCallId": "call-2", "title": "Which frequency should I use?"},
                "options": [
                    {"optionId": "opt-monthly", "name": "Monthly", "kind": "allow_once"},
                    {"optionId": "opt-quarterly", "name": "Quarterly", "kind": "allow_once"},
                    {"optionId": "opt-skip", "name": "Skip this series", "kind": "allow_once"},
                ]
            }),
            Utc::now(),
        );
        match event.mutation {
            ProjectionMutation::ApprovalRequested {
                approval_kind,
                options,
                reason,
                ..
            } => {
                assert_eq!(approval_kind, ApprovalKind::Question);
                assert_eq!(reason.as_deref(), Some("Which frequency should I use?"));
                assert_eq!(
                    options,
                    vec![
                        QuestionOption {
                            option_id: "opt-monthly".into(),
                            label: "Monthly".into()
                        },
                        QuestionOption {
                            option_id: "opt-quarterly".into(),
                            label: "Quarterly".into()
                        },
                        QuestionOption {
                            option_id: "opt-skip".into(),
                            label: "Skip this series".into()
                        },
                    ]
                );
            }
            other => panic!("expected question approval, got {other:?}"),
        }
    }

    #[test]
    fn acp_permission_request_falls_back_to_option_id_when_name_is_missing() {
        let event = reduce_acp_permission_request(
            "session-1",
            "turn-1",
            TransportRequestId::Number(3.into()),
            &json!({
                "toolCall": {"toolCallId": "call-3", "title": "Pick one"},
                "options": [
                    {"optionId": "a", "kind": "allow_once"},
                    {"optionId": "b", "kind": "allow_once"},
                ]
            }),
            Utc::now(),
        );
        match event.mutation {
            ProjectionMutation::ApprovalRequested { options, .. } => {
                assert_eq!(options[0].label, "a");
                assert_eq!(options[1].label, "b");
            }
            other => panic!("expected question approval, got {other:?}"),
        }
    }

    #[test]
    fn raw_acp_thought_chunks_become_host_activity_without_vendor_text() {
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
        .expect("reduce")
        .expect("placeholder");
        assert!(!event.audit_json.contains("Raw hidden"));
        match event.mutation {
            ProjectionMutation::ReplaceItem(item) => {
                assert_eq!(item.kind, ItemKind::ReasoningSummary);
                assert_eq!(item.body.as_deref(), Some("Thinking…"));
                assert_eq!(item.title.as_deref(), Some("Reasoning"));
            }
            other => panic!("expected reasoning placeholder, got {other:?}"),
        }
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
    fn acp_tool_call_folds_locations_into_tool_input_when_raw_input_omits_path() {
        let event = reduce_acp_update(
            "session-1",
            "turn-1",
            0,
            &json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "call-loc",
                "title": "Read",
                "kind": "read",
                "status": "in_progress",
                "locations": [{"path": "apps/desktop/src/components/Transcript.tsx", "line": 12}]
            }),
            Utc::now(),
        )
        .expect("reduce")
        .expect("accepted");
        let ProjectionMutation::ReplaceItem(item) = &event.mutation else {
            panic!("expected replace mutation");
        };
        assert_eq!(item.title.as_deref(), Some("Read"));
        assert!(
            item.tool_input
                .as_deref()
                .expect("tool input")
                .contains("Transcript.tsx"),
            "locations path should become tool_input: {:?}",
            item.tool_input
        );

        let with_raw = reduce_acp_update(
            "session-1",
            "turn-1",
            0,
            &json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "call-both",
                "title": "Searched",
                "kind": "search",
                "status": "completed",
                "rawInput": {"query": "activity rows"},
                "locations": [{"path": "apps/desktop/src/components/Transcript.tsx"}]
            }),
            Utc::now(),
        )
        .expect("reduce")
        .expect("accepted");
        let ProjectionMutation::ReplaceItem(item) = &with_raw.mutation else {
            panic!("expected replace mutation");
        };
        let input = item.tool_input.as_deref().expect("tool input");
        assert!(
            input.contains("activity rows"),
            "raw query preserved: {input}"
        );
        assert!(
            input.contains("Transcript.tsx"),
            "location path is folded in when rawInput has no path field: {input}"
        );
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
    fn codex_web_search_becomes_search_activity() {
        let started = reduce_provider_event(ProviderEventInput {
            method: "item/started".into(),
            params: json!({
                "threadId": "th1",
                "turnId": "tu1",
                "item": {
                    "type": "webSearch",
                    "id": "search-1",
                    "query": "",
                    "action": {"type": "other"}
                }
            }),
            request_id: None,
            occurred_at: Utc::now(),
        })
        .expect("reduce")
        .expect("accepted");
        let completed = reduce_provider_event(ProviderEventInput {
            method: "item/completed".into(),
            params: json!({
                "threadId": "th1",
                "turnId": "tu1",
                "item": {
                    "type": "webSearch",
                    "id": "search-1",
                    "query": "Stripe MCP connector sign in status",
                    "action": {
                        "type": "search",
                        "query": "Stripe MCP connector sign in status"
                    }
                }
            }),
            request_id: None,
            occurred_at: Utc::now(),
        })
        .expect("reduce")
        .expect("accepted");

        let ProjectionMutation::ReplaceItem(started) = started.mutation else {
            panic!("expected started item");
        };
        let ProjectionMutation::ReplaceItem(completed) = completed.mutation else {
            panic!("expected completed item");
        };
        assert_eq!(started.id, completed.id);
        assert_eq!(started.kind, ItemKind::McpTool);
        assert_eq!(started.status, ItemStatus::InProgress);
        assert_eq!(completed.status, ItemStatus::Completed);
        assert_eq!(completed.mcp_tool.as_deref(), Some("web_search"));
        assert_eq!(
            completed.body.as_deref(),
            Some("Stripe MCP connector sign in status")
        );
        assert!(
            completed
                .tool_input
                .as_deref()
                .expect("search input")
                .contains("Stripe MCP connector sign in status")
        );
    }

    #[test]
    fn unknown_items_use_neutral_provider_activity_copy() {
        let event = reduce_provider_event(ProviderEventInput {
            method: "item/completed".into(),
            params: json!({
                "threadId": "th1",
                "turnId": "tu1",
                "item": {
                    "type": "futureProviderItem",
                    "id": "future-1"
                }
            }),
            request_id: None,
            occurred_at: Utc::now(),
        })
        .expect("reduce")
        .expect("accepted");
        let ProjectionMutation::ReplaceItem(item) = event.mutation else {
            panic!("expected provider item");
        };
        assert_eq!(item.kind, ItemKind::Unknown);
        assert_eq!(item.title.as_deref(), Some("Provider activity"));
        assert_eq!(item.body.as_deref(), Some("Additional provider activity"));
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
