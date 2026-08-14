use chrono::{DateTime, Utc};
use integrator_core::{
    ApprovalKind, ConnectionState, ItemKind, ItemProjection, ModeProjection, PlanStep,
    QuestionOption, TransportRequestId, TurnProjection, UsageProjection,
};
use serde_json::Value;

use crate::redaction::bound_and_redact;
#[cfg(test)]
use crate::redaction::redact_text;

const BODY_LIMIT: usize = 2 * 1024 * 1024;
const DIFF_LIMIT: usize = 4 * 1024 * 1024;
const PATH_LIMIT: usize = 4 * 1024;
const PLAN_STEP_LIMIT: usize = 4 * 1024;
const PLAN_STEPS_LIMIT: usize = 256;
/// Full plan documents (markdown) attached to plan-review approvals.
const PLAN_DOCUMENT_LIMIT: usize = 256 * 1024;
const TOOL_DETAIL_LIMIT: usize = 64 * 1024;

mod acp;
mod codex;
pub use acp::*;
pub use codex::*;

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

#[cfg(test)]
mod tests;
