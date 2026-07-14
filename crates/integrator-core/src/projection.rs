use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{ProviderKind, ProviderSessionId, RuntimeSessionId, Task, TaskId};

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
}

impl ApprovalKind {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::CommandExecution => "command_execution",
            Self::FileChange => "file_change",
            Self::PlanReview => "plan_review",
        }
    }
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
}

impl ApprovalDecision {
    #[must_use]
    pub const fn as_protocol_str(&self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::AcceptForSession => "acceptForSession",
            Self::Decline => "decline",
            Self::Cancel => "cancel",
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub task: Task,
    pub events: Vec<RuntimeProjectionEvent>,
    pub watermark_seq: i64,
    /// Attested by the native command after checking the in-process runtime
    /// registry. Store-only snapshots cannot claim process liveness.
    pub runtime_live: bool,
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
