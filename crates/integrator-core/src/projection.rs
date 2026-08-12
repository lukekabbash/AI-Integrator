use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{ProviderKind, ProviderSessionId, RuntimeSessionId, Task, TaskId};

/// Minimum item/approval rows returned on cold UI hydrate.
///
/// Kept above the transcript virtualization threshold (250) so a typical open
/// paints without an immediate older-page fetch, while bounding SQLite/IPC
/// deserialize cost for long chats. Agent seeding uses `task_handoff_digest`
/// (unchanged contract: shared SQLite by task_id across providers); this
/// constant is display-hydrate only.
pub const TASK_PROJECTION_HYDRATE_TAIL: usize = 300;

/// User/agent messages a default hydrate page keeps extending toward.
///
/// Tool-heavy turns fill the item window with command/tool/reasoning rows, so
/// counting raw items alone can hydrate a page holding almost no conversation.
/// The window grows past [`TASK_PROJECTION_HYDRATE_TAIL`] until it contains
/// this many `user_message`/`agent_message` rows (or the caps below stop it).
pub const TASK_PROJECTION_HYDRATE_TAIL_MESSAGES: usize = 100;

/// Hard cap on item/approval rows in one default hydrate page.
pub const TASK_PROJECTION_HYDRATE_MAX_ITEMS: usize = 1500;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum TransportRequestId {
    Number(serde_json::Number),
    String(String),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Interrupted,
}

impl TurnStatus {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnProjection {
    pub id: String,
    pub status: TurnStatus,
    pub stop_requested: bool,
    pub error: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    UserMessage,
    AgentMessage,
    ReasoningSummary,
    CommandExecution,
    FileChange,
    McpTool,
    Unknown,
}

impl ItemKind {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::UserMessage => "user_message",
            Self::AgentMessage => "agent_message",
            Self::ReasoningSummary => "reasoning_summary",
            Self::CommandExecution => "command_execution",
            Self::FileChange => "file_change",
            Self::McpTool => "mcp_tool",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Declined,
}

impl ItemStatus {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Declined => "declined",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeKind {
    Add,
    Modify,
    Delete,
    Rename,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeProjection {
    pub path: String,
    pub change_kind: FileChangeKind,
    pub patch: Option<String>,
}

/// Codex (and compatible hosts) classify assistant text as mid-turn commentary
/// or the turn's final answer. Absent when the runtime does not emit a phase.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentMessagePhase {
    Commentary,
    FinalAnswer,
}

impl AgentMessagePhase {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Commentary => "commentary",
            Self::FinalAnswer => "final_answer",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "commentary" => Some(Self::Commentary),
            "final_answer" => Some(Self::FinalAnswer),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemProjection {
    pub id: String,
    pub provider_item_id: String,
    pub kind: ItemKind,
    pub status: ItemStatus,
    pub title: Option<String>,
    pub body: Option<String>,
    /// Provider-native skill verified by the trusted host for this user item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_skill: Option<String>,
    /// Present for `agentMessage` when the host reports commentary vs final answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<AgentMessagePhase>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub output: Option<String>,
    pub exit_code: Option<i64>,
    pub file_changes: Option<Vec<FileChangeProjection>>,
    pub mcp_server: Option<String>,
    pub mcp_tool: Option<String>,
    /// Redacted, bounded rendering of the tool call's input arguments.
    #[serde(default)]
    pub tool_input: Option<String>,
    pub truncated: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanStepStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub index: u32,
    pub text: String,
    pub status: PlanStepStatus,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageProjection {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
    pub model_context_window: Option<u64>,
    /// Vendor-computed API-equivalent cost in micro-USD (only Claude reports
    /// one today). Kept as an integer so the projection stays `Eq`; `default`
    /// keeps usage_json rows persisted before this field deserializable.
    #[serde(default)]
    pub vendor_cost_micro_usd: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalKind {
    CommandExecution,
    FileChange,
    /// The agent finished planning and is waiting for the user to approve
    /// the plan before implementation (Claude `ExitPlanMode`, Cursor
    /// `cursor/create_plan`).
    PlanReview,
    /// The agent asked a multiple-choice question through ACP's
    /// `session/request_permission` — the only client-interaction channel
    /// the protocol offers, since it has no dedicated elicitation method.
    /// `options` on the approval carries the real answer choices; the
    /// chosen `optionId` rides straight back as the permission outcome.
    Question,
}

impl ApprovalKind {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::CommandExecution => "command_execution",
            Self::FileChange => "file_change",
            Self::PlanReview => "plan_review",
            Self::Question => "question",
        }
    }
}

/// One answer choice offered by a `Question` approval, sourced from the
/// ACP permission request's own `options[].name`/`optionId`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub option_id: String,
    pub label: String,
}

/// One agent-advertised session mode (ACP `SessionMode`), or a synthesized
/// equivalent for providers with a fixed mode vocabulary (Claude permission
/// modes). Ids are provider-opaque; render `name`/`description`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeOption {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

/// The session's current mode plus every mode it can switch into. Snapshot
/// semantics: each update replaces the whole state.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeProjection {
    pub current_mode_id: String,
    pub available_modes: Vec<ModeOption>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalState {
    Pending,
    Responding,
    Resolved,
    Declined,
    Cancelled,
    Expired,
    ResponseFailed,
}

impl ApprovalState {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Responding => "responding",
            Self::Resolved => "resolved",
            Self::Declined => "declined",
            Self::Cancelled => "cancelled",
            Self::Expired => "expired",
            Self::ResponseFailed => "response_failed",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
    /// The user picked one of a `Question` approval's answer choices. The
    /// chosen option lives in `ApprovalProjection::selected_option_id`, not
    /// in this variant, so the string stays `'static`.
    Select,
}

impl ApprovalDecision {
    #[must_use]
    pub const fn as_protocol_str(&self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::AcceptForSession => "acceptForSession",
            Self::Decline => "decline",
            Self::Cancel => "cancel",
            Self::Select => "select",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalProjection {
    pub id: String,
    pub request_id: TransportRequestId,
    pub approval_kind: ApprovalKind,
    pub state: ApprovalState,
    pub decision: Option<ApprovalDecision>,
    pub item_id: Option<String>,
    pub approval_id: Option<String>,
    pub reason: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub file_changes: Option<Vec<FileChangeProjection>>,
    /// Full plan document (markdown) for `PlanReview` approvals. `default`
    /// keeps approvals persisted before this field deserializable.
    #[serde(default)]
    pub plan_markdown: Option<String>,
    /// Answer choices for a `Question` approval. `default` keeps approvals
    /// persisted before this field deserializable.
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    /// Which `options` entry the user picked, once a `Question` approval is
    /// answered. `default` keeps approvals persisted before this field
    /// deserializable.
    #[serde(default)]
    pub selected_option_id: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    Connecting,
    Connected,
    Disconnected,
    Reconciling,
    Gap,
}

impl ConnectionState {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Disconnected => "disconnected",
            Self::Reconciling => "reconciling",
            Self::Gap => "gap",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RuntimeProjection {
    TurnChanged {
        turn: TurnProjection,
    },
    ItemChanged {
        item: ItemProjection,
    },
    PlanChanged {
        steps: Vec<PlanStep>,
        truncated: bool,
    },
    DiffChanged {
        diff: String,
        truncated: bool,
    },
    UsageChanged {
        usage: UsageProjection,
    },
    ApprovalChanged {
        approval: ApprovalProjection,
    },
    ModeChanged {
        mode: ModeProjection,
    },
    TurnError {
        message: String,
        retryable: bool,
    },
    ConnectionChanged {
        state: ConnectionState,
        reason: Option<String>,
        process_id: Option<String>,
    },
    ProjectionReset {
        reason: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProjectionEvent {
    pub seq: i64,
    pub task_id: TaskId,
    pub provider_session_id: ProviderSessionId,
    pub provider: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub occurred_at: DateTime<Utc>,
    pub projection: RuntimeProjection,
}

/// Compact cold-hydrate payload for the renderer. Built from materialized
/// current rows so the UI does not replay full `RuntimeProjectionEvent`
/// envelopes through `applyRuntimeProjectionBatch`. Live streaming still uses
/// those envelopes on `runtime://projection`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProjectionHydrate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<TurnProjection>,
    pub items: Vec<ItemProjection>,
    pub plan: Vec<PlanStep>,
    pub plan_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<TaskProjectionDiffHydrate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageProjection>,
    pub approvals: Vec<ApprovalProjection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ModeProjection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<TaskProjectionConnectionHydrate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<TaskProjectionErrorHydrate>,
    /// First-appearance timestamps in the current reset epoch (item/approval id → time).
    pub first_seen: BTreeMap<String, DateTime<Utc>>,
    pub has_more_older: bool,
    /// Oldest `last_event_seq` included in this page; pass as `before_seq` to load older.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_seq: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProjectionDiffHydrate {
    pub body: String,
    pub truncated: bool,
    pub seq: i64,
    pub occurred_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProjectionConnectionHydrate {
    pub state: ConnectionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProjectionErrorHydrate {
    pub message: String,
    pub retryable: bool,
    pub seq: i64,
    pub occurred_at: DateTime<Utc>,
}

/// Optional if-match / windowing controls for UI hydrate.
///
/// Watermark alone is insufficient after `ProjectionReset`: the client must
/// also present the reset epoch it cached. Agent digest / resume paths do not
/// use this query.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TaskSnapshotQuery {
    pub known_watermark: Option<i64>,
    pub known_reset_seq: Option<i64>,
    /// When set, return only older items/approvals with `last_event_seq < before_seq`.
    pub before_seq: Option<i64>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub task: Task,
    pub watermark_seq: i64,
    /// Current projection reset epoch. Required with `watermark_seq` for cache short-circuit.
    pub reset_seq: i64,
    /// Attested by the native command after checking the in-process runtime
    /// registry. Store-only snapshots cannot claim process liveness.
    pub runtime_live: bool,
    /// Client cache matched `known_watermark` + `known_reset_seq`; `hydrate` is omitted.
    #[serde(default)]
    pub cache_matched: bool,
    /// Compact UI state. Absent when `cache_matched` or on a pure older-page miss with no rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hydrate: Option<TaskProjectionHydrate>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopRequestResult {
    pub turn_id: String,
    pub stop_requested: bool,
    pub already_requested: bool,
    /// True when no live provider owned the turn and the store force-marked
    /// it interrupted so a dead session still stops cleanly.
    #[serde(default)]
    pub settled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeBinding {
    pub task_id: TaskId,
    pub provider: ProviderKind,
    pub provider_session_id: Option<ProviderSessionId>,
    pub runtime_session_id: RuntimeSessionId,
    pub process_id: String,
    pub thread_id: Option<String>,
}
