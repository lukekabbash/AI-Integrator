use chrono::{DateTime, Utc};
use integrator_core::{
    ItemKind, ItemProjection, ItemStatus, ModeOption, ModeProjection, ProviderKind, TurnStatus,
    UsageProjection,
};
use integrator_runtime::{StructuredCliProvider, StructuredUsage, redact_and_bound};
use serde_json::Value;

use crate::command_api::{CommandError, CommandResult};

pub(crate) fn structured_provider(provider: &ProviderKind) -> CommandResult<StructuredCliProvider> {
    match provider {
        ProviderKind::Claude => Ok(StructuredCliProvider::Claude),
        ProviderKind::Antigravity => Ok(StructuredCliProvider::Antigravity),
        _ => Err(CommandError {
            code: "provider-unavailable",
            message: format!("{} has no structured CLI route", provider.as_str()),
        }),
    }
}

pub(crate) fn structured_result_status(
    provider: ProviderKind,
    success: bool,
    had_denied_tool: bool,
    has_answer_text: bool,
) -> TurnStatus {
    if success || (provider == ProviderKind::Antigravity && had_denied_tool && has_answer_text) {
        TurnStatus::Completed
    } else {
        TurnStatus::Failed
    }
}

/// Claude's fixed CLI permission vocabulary as a canonical mode projection.
/// The CLI reports the launch flag's `manual` back as `default`.
pub(crate) fn claude_mode_projection(current: &str) -> ModeProjection {
    let current = if current == "manual" {
        "default"
    } else {
        current
    };
    let mut available = vec![
        ModeOption {
            id: "plan".into(),
            name: "Plan".into(),
            description: Some("Read-only planning; implementation waits for plan approval".into()),
        },
        ModeOption {
            id: "default".into(),
            name: "Ask".into(),
            description: Some("Prompt for approval before edits and commands".into()),
        },
        ModeOption {
            id: "acceptEdits".into(),
            name: "Accept edits".into(),
            description: Some("Auto-accept file edits; still ask for commands".into()),
        },
        ModeOption {
            id: "bypassPermissions".into(),
            name: "Bypass permissions".into(),
            description: Some("Run without permission prompts".into()),
        },
    ];
    if !available.iter().any(|mode| mode.id == current) {
        available.push(ModeOption {
            id: current.into(),
            name: current.into(),
            description: None,
        });
    }
    ModeProjection {
        current_mode_id: current.into(),
        available_modes: available,
    }
}

/// Maps a structured turn's usage onto an accumulating projection delta.
pub(crate) fn structured_usage_delta(usage: &StructuredUsage) -> Option<UsageProjection> {
    let input = usage
        .input_tokens
        .unwrap_or(0)
        .saturating_add(usage.cache_creation_input_tokens.unwrap_or(0));
    let cached = usage.cached_input_tokens.unwrap_or(0);
    let output = usage.output_tokens.unwrap_or(0);
    let reasoning = usage.reasoning_output_tokens.unwrap_or(0);
    let total = usage.total_tokens.unwrap_or_else(|| {
        input
            .saturating_add(cached)
            .saturating_add(output)
            .saturating_add(reasoning)
    });
    if total == 0 && usage.cost_micro_usd.is_none() {
        return None;
    }
    Some(UsageProjection {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: total,
        model_context_window: None,
        vendor_cost_micro_usd: usage.cost_micro_usd,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn structured_item(
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
    kind: ItemKind,
    title: Option<String>,
    body: Option<String>,
    output: Option<String>,
    tool_input: Option<String>,
    status: ItemStatus,
    updated_at: DateTime<Utc>,
) -> ItemProjection {
    ItemProjection {
        id: format!("structured:{thread_id}:{turn_id}:{item_id}"),
        provider_item_id: item_id.to_owned(),
        kind,
        status,
        title: title.map(|value| redact_and_bound(&value, 64 * 1024).0),
        body: body.map(|value| redact_and_bound(&value, 2 * 1024 * 1024).0),
        native_skill: None,
        phase: None,
        command: None,
        cwd: None,
        output: output.map(|value| redact_and_bound(&value, 2 * 1024 * 1024).0),
        exit_code: None,
        file_changes: None,
        mcp_server: None,
        mcp_tool: None,
        tool_input: tool_input.map(|value| redact_and_bound(&value, 256 * 1024).0),
        truncated: false,
        updated_at,
    }
}

pub(crate) fn structured_json_detail(value: &Value) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let text = serde_json::to_string_pretty(value).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(redact_and_bound(trimmed, 256 * 1024).0)
}
