use chrono::{DateTime, Utc};
use integrator_core::{
    ApprovalKind, FileChangeKind, FileChangeProjection, ItemKind, ItemProjection, ItemStatus,
    ModeOption, ModeProjection, PlanStep, PlanStepStatus, QuestionOption, Result,
    TransportRequestId, TurnProjection, TurnStatus,
};
use serde_json::{Value, json};

use crate::redaction::{TEXT_LIMIT, bound_and_redact, bound_and_redact_patch, bounded_audit};

use super::{
    DIFF_LIMIT, ItemTextField, PATH_LIMIT, PLAN_DOCUMENT_LIMIT, PLAN_STEP_LIMIT, PLAN_STEPS_LIMIT,
    ProjectionMutation, ReducedProviderEvent, TOOL_DETAIL_LIMIT, json_detail,
};

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

/// Stable transcript id for a turn's reasoning placeholder. Both the
/// in-progress write (first thought chunk) and the completing write (turn
/// settle) must target this exact id, or the row is orphaned `inProgress`
/// and the renderer spins on it forever.
pub fn acp_reasoning_item_id(session_id: &str, turn_id: &str) -> String {
    format!("acp:{session_id}:{turn_id}:reasoning")
}

/// Host-owned placeholder standing in for ACP `agent_thought_chunk`, whose raw
/// text must never reach the transcript or the audit stream. Emitted once when
/// reasoning starts and once more, `Completed`, when the turn settles.
pub fn acp_reasoning_event(
    session_id: &str,
    turn_id: &str,
    status: ItemStatus,
    occurred_at: DateTime<Utc>,
) -> ReducedProviderEvent {
    let settled = status != ItemStatus::InProgress;
    ReducedProviderEvent {
        method: "session/update/agent_thought_chunk".into(),
        thread_id: session_id.to_owned(),
        turn_id: Some(turn_id.to_owned()),
        audit_json: r#"{"sessionUpdate":"agent_thought_chunk"}"#.into(),
        audit_truncated: false,
        mutation: ProjectionMutation::ReplaceItem(ItemProjection {
            id: acp_reasoning_item_id(session_id, turn_id),
            provider_item_id: format!("{turn_id}-reasoning"),
            kind: ItemKind::ReasoningSummary,
            status,
            title: Some("Reasoning".into()),
            body: Some(
                if settled {
                    "Thought for a moment"
                } else {
                    "Thinking…"
                }
                .into(),
            ),
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
    }
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
        return Ok(Some(acp_reasoning_event(
            session_id,
            turn_id,
            ItemStatus::InProgress,
            occurred_at,
        )));
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
