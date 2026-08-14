use serde_json::Value;

use crate::redact_and_bound;

use super::{DIAGNOSTIC_LIMIT, StructuredCliEventKind, StructuredCliProvider, StructuredUsage};

#[derive(Debug)]
pub(super) struct ParsedEvent {
    pub(super) session_id: Option<String>,
    pub(super) event: StructuredCliEventKind,
}

pub(super) fn parse_provider_line(provider: StructuredCliProvider, line: &str) -> Vec<ParsedEvent> {
    let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
        return Vec::new();
    };
    match provider {
        StructuredCliProvider::Claude => parse_claude_event(&value),
        StructuredCliProvider::Antigravity => parse_antigravity_result(&value),
    }
}

fn parse_claude_event(value: &Value) -> Vec<ParsedEvent> {
    let session_id = string_at(value, "session_id");
    let Some(event_type) = value.get("type").and_then(Value::as_str) else {
        return Vec::new();
    };
    let event = match event_type {
        "system" if value.get("subtype").and_then(Value::as_str) == Some("init") => {
            Some(ParsedEvent {
                session_id,
                event: StructuredCliEventKind::Init {
                    model: string_at(value, "model"),
                },
            })
        }
        // Claude reports permission-mode transitions (e.g. leaving plan mode
        // after an approved ExitPlanMode) as status messages.
        "system" if value.get("subtype").and_then(Value::as_str) == Some("status") => {
            let Some(mode) = string_at(value, "permissionMode") else {
                return Vec::new();
            };
            Some(ParsedEvent {
                session_id,
                event: StructuredCliEventKind::PermissionModeChanged { mode },
            })
        }
        // Claude emits api_retry while backing off a failed or rate-limited
        // API call. Without surfacing it the stream simply goes silent for
        // the whole backoff window and reads as a frozen turn.
        "system" if value.get("subtype").and_then(Value::as_str) == Some("api_retry") => {
            let mut message = String::from("Provider is retrying the request");
            if let (Some(attempt), Some(max_attempts)) = (
                value.get("attempt").and_then(Value::as_u64),
                value.get("max_attempts").and_then(Value::as_u64),
            ) {
                message.push_str(&format!(" (attempt {attempt} of {max_attempts})"));
            }
            if let Some(detail) = string_at(value, "error").or_else(|| string_at(value, "message"))
            {
                message.push_str(": ");
                message.push_str(&redact_and_bound(&detail, DIAGNOSTIC_LIMIT).0);
            }
            Some(ParsedEvent {
                session_id,
                event: StructuredCliEventKind::Diagnostic { message },
            })
        }
        "stream_event" => {
            let Some(event) = value.get("event") else {
                return Vec::new();
            };
            if event.get("type").and_then(Value::as_str) != Some("content_block_delta") {
                return Vec::new();
            }
            let Some(delta) = event.get("delta") else {
                return Vec::new();
            };
            if delta.get("type").and_then(Value::as_str) != Some("text_delta") {
                return Vec::new();
            }
            Some(ParsedEvent {
                session_id,
                event: StructuredCliEventKind::Text {
                    text: string_at(delta, "text").unwrap_or_default(),
                    delta: true,
                },
            })
        }
        "assistant" => return parse_claude_assistant(value, session_id),
        "user" => return parse_claude_tool_results(value, session_id),
        "control_request" => parse_claude_control_request(value, session_id),
        "result" => Some(ParsedEvent {
            session_id,
            event: StructuredCliEventKind::Result {
                success: !value
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                message: string_at(value, "result")
                    .map(|text| redact_and_bound(&text, DIAGNOSTIC_LIMIT).0),
                usage: StructuredUsage {
                    cost_micro_usd: micro_usd_at(value, "total_cost_usd"),
                    ..parse_usage(value.get("usage"))
                },
            },
        }),
        _ => None,
    };
    event.into_iter().collect()
}

/// Maps a stream-json `control_request` line onto a permission event. Only
/// `can_use_tool` is surfaced; other control subtypes (e.g. the initialize
/// acknowledgement flow) need no UI.
fn parse_claude_control_request(value: &Value, session_id: Option<String>) -> Option<ParsedEvent> {
    let request = value.get("request")?;
    (request.get("subtype")?.as_str()? == "can_use_tool").then_some(())?;
    Some(ParsedEvent {
        session_id,
        event: StructuredCliEventKind::PermissionRequest {
            request_id: string_at(value, "request_id")?,
            tool_use_id: string_at(request, "tool_use_id").unwrap_or_default(),
            tool_name: string_at(request, "tool_name").unwrap_or_default(),
            input: request.get("input").cloned().unwrap_or(Value::Null),
            description: string_at(request, "description"),
            suggestions: request
                .get("permission_suggestions")
                .cloned()
                .unwrap_or(Value::Null),
        },
    })
}

fn parse_claude_assistant(value: &Value, session_id: Option<String>) -> Vec<ParsedEvent> {
    let Some(content) = value.pointer("/message/content").and_then(Value::as_array) else {
        return Vec::new();
    };
    content
        .iter()
        .filter_map(|block| match block.get("type").and_then(Value::as_str) {
            Some("text") => Some(ParsedEvent {
                session_id: session_id.clone(),
                event: StructuredCliEventKind::Text {
                    text: string_at(block, "text").unwrap_or_default(),
                    delta: false,
                },
            }),
            Some("tool_use") => Some(ParsedEvent {
                session_id: session_id.clone(),
                event: StructuredCliEventKind::ToolUse {
                    id: string_at(block, "id").unwrap_or_default(),
                    name: string_at(block, "name").unwrap_or_default(),
                    input: block.get("input").cloned().unwrap_or(Value::Null),
                },
            }),
            _ => None,
        })
        .collect()
}

fn parse_claude_tool_results(value: &Value, session_id: Option<String>) -> Vec<ParsedEvent> {
    let Some(content) = value.pointer("/message/content").and_then(Value::as_array) else {
        return Vec::new();
    };
    content
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
        .map(|block| ParsedEvent {
            session_id: session_id.clone(),
            event: StructuredCliEventKind::ToolResult {
                id: string_at(block, "tool_use_id").unwrap_or_default(),
                is_error: block
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                content: claude_tool_result_content(block.get("content")),
            },
        })
        .collect()
}

fn claude_tool_result_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| match block {
                Value::String(text) => Some(text.clone()),
                Value::Object(_) => block
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| serde_json::to_string(block).ok()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::Object(_)) => content
            .and_then(|value| value.get("text"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| content.and_then(|value| serde_json::to_string(value).ok()))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

/// `agy --output-format json` prints exactly one object per turn:
/// `{"conversation_id","status","response","error"?,"usage":{...}}`.
/// The single line therefore expands into a Text event (the full response)
/// followed by a Result event carrying success and usage.
fn parse_antigravity_result(value: &Value) -> Vec<ParsedEvent> {
    let Some(status) = value.get("status").and_then(Value::as_str) else {
        return Vec::new();
    };
    if value.get("conversation_id").is_none() && value.get("response").is_none() {
        return Vec::new();
    }
    let session_id = string_at(value, "conversation_id").filter(|id| !id.is_empty());
    let mut events = Vec::new();
    if let Some(response) = string_at(value, "response").filter(|text| !text.is_empty()) {
        events.push(ParsedEvent {
            session_id: session_id.clone(),
            event: StructuredCliEventKind::Text {
                text: response,
                delta: false,
            },
        });
    }
    events.push(ParsedEvent {
        session_id,
        event: StructuredCliEventKind::Result {
            success: status.eq_ignore_ascii_case("success"),
            message: string_at(value, "error")
                .filter(|text| !text.is_empty())
                .map(|text| redact_and_bound(&text, DIAGNOSTIC_LIMIT).0),
            usage: parse_usage(value.get("usage")),
        },
    });
    events
}

fn parse_usage(value: Option<&Value>) -> StructuredUsage {
    StructuredUsage {
        input_tokens: u64_at(value, "input_tokens"),
        cached_input_tokens: u64_at(value, "cache_read_input_tokens"),
        cache_creation_input_tokens: u64_at(value, "cache_creation_input_tokens"),
        output_tokens: u64_at(value, "output_tokens"),
        reasoning_output_tokens: u64_at(value, "thinking_tokens"),
        total_tokens: u64_at(value, "total_tokens"),
        cost_micro_usd: None,
    }
}

/// Converts Claude's fractional-dollar `total_cost_usd` into micro-USD,
/// rejecting non-finite or negative values a malformed line could carry.
fn micro_usd_at(value: &Value, key: &str) -> Option<u64> {
    let dollars = value.get(key)?.as_f64()?;
    (dollars.is_finite() && dollars >= 0.0).then(|| (dollars * 1_000_000.0).round() as u64)
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}
fn u64_at(value: Option<&Value>, key: &str) -> Option<u64> {
    value
        .and_then(|value| value.get(key))
        .and_then(Value::as_u64)
}
