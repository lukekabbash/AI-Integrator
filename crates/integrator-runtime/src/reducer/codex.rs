use chrono::{DateTime, TimeZone, Utc};
use integrator_core::{
    ApprovalKind, ConnectionState, FileChangeKind, FileChangeProjection, ItemKind, ItemProjection,
    ItemStatus, PlanStep, PlanStepStatus, Result, TransportRequestId, TurnProjection, TurnStatus,
    UsageProjection,
};
use serde_json::{Value, json};

use crate::redaction::{TEXT_LIMIT, bound_and_redact, bound_and_redact_patch, bounded_event_audit};

use super::{
    BODY_LIMIT, DIFF_LIMIT, ItemTextField, PATH_LIMIT, PLAN_STEP_LIMIT, PLAN_STEPS_LIMIT,
    ProjectionMutation, ProviderEventInput, ReducedProviderEvent, TOOL_DETAIL_LIMIT, json_detail,
};

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
