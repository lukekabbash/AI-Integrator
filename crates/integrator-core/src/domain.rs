use std::{fmt, path::PathBuf, str::FromStr};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

macro_rules! uuid_id {
    ($name:ident) => {
        #[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(formatter)
            }
        }

        impl FromStr for $name {
            type Err = uuid::Error;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Uuid::parse_str(value).map(Self)
            }
        }
    };
}

uuid_id!(TaskId);
uuid_id!(RuntimeSessionId);
uuid_id!(ProviderSessionId);
uuid_id!(ProjectId);
uuid_id!(QueuedMessageId);
uuid_id!(AutomationId);
uuid_id!(AutomationRunId);
uuid_id!(ContextReferenceId);
uuid_id!(MemoryId);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Versioned<T> {
    pub schema_version: u32,
    pub value: T,
}

impl<T> Versioned<T> {
    #[must_use]
    pub fn current(value: T) -> Self {
        Self {
            schema_version: crate::DOMAIN_SCHEMA_VERSION,
            value,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    Codex,
    Claude,
    /// Google Antigravity CLI (`agy`). Replaces the retired Gemini CLI;
    /// `"gemini"` is accepted as a legacy alias when deserializing so older
    /// stored sessions keep parsing.
    #[serde(alias = "gemini")]
    Antigravity,
    Cursor,
    Grok,
    Kimi,
    CustomAcp,
}

impl ProviderKind {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Antigravity => "antigravity",
            Self::Cursor => "cursor",
            Self::Grok => "grok",
            Self::Kimi => "kimi",
            Self::CustomAcp => "custom-acp",
        }
    }
}

impl fmt::Display for ProviderKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for ProviderKind {
    type Err = crate::IntegratorError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "codex" => Ok(Self::Codex),
            "claude" => Ok(Self::Claude),
            "antigravity" | "gemini" => Ok(Self::Antigravity),
            "cursor" => Ok(Self::Cursor),
            "grok" => Ok(Self::Grok),
            "kimi" => Ok(Self::Kimi),
            "custom-acp" => Ok(Self::CustomAcp),
            _ => Err(crate::IntegratorError::InvalidInput(format!(
                "unknown provider kind: {value}"
            ))),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthenticationState {
    Authenticated,
    LoggedOut,
    Unavailable,
    Unknown,
    NeedsAttention,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderTransport {
    JsonlStdio,
    AcpStdio,
    ExternalApplication,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub session_resume: bool,
    pub authoritative_history: bool,
    pub structured_tool_events: bool,
    pub hooks: bool,
    pub sandboxed_workspace: bool,
    pub subscription_auth: bool,
    pub skills: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderCertification {
    Certified,
    SessionProbeRequired,
    #[default]
    Uncertified,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: ProviderKind,
    pub installed: bool,
    pub executable: Option<PathBuf>,
    pub version: Option<String>,
    pub authentication: AuthenticationState,
    pub transport: Option<ProviderTransport>,
    pub diagnostic_code: Option<String>,
    #[serde(default)]
    pub capabilities: ProviderCapabilities,
    #[serde(default)]
    pub certification: ProviderCertification,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskState {
    Draft,
    Ready,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

impl TaskState {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Ready => "ready",
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

impl FromStr for TaskState {
    type Err = crate::IntegratorError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "draft" => Ok(Self::Draft),
            "ready" => Ok(Self::Ready),
            "running" => Ok(Self::Running),
            "waiting" => Ok(Self::Waiting),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(crate::IntegratorError::InvalidInput(format!(
                "unknown task state: {value}"
            ))),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskKind {
    #[default]
    Code,
    Chat,
}

impl TaskKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Code => "code",
            Self::Chat => "chat",
        }
    }
}

impl FromStr for TaskKind {
    type Err = crate::IntegratorError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "code" => Ok(Self::Code),
            "chat" => Ok(Self::Chat),
            _ => Err(crate::IntegratorError::InvalidInput(format!(
                "unknown task kind: {value}"
            ))),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: TaskId,
    #[serde(default)]
    pub kind: TaskKind,
    pub title: String,
    pub repository_path: Option<PathBuf>,
    pub worktree_path: Option<PathBuf>,
    pub state: TaskState,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub archived: bool,
    /// Last composer runtime id for this chat (`codex`, `cursor`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    /// Last composer model id for this chat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Last composer reasoning-effort id when the model advertises levels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Set when this task is a delegated subagent spawned on behalf of
    /// another task. Child tasks are hidden from the primary task list and
    /// surfaced through the parent's delegation lineage instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<TaskId>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTask {
    #[serde(default)]
    pub kind: TaskKind,
    pub title: String,
    pub repository_path: Option<PathBuf>,
    pub worktree_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<TaskId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedProject {
    pub id: ProjectId,
    pub display_name: String,
    /// Exact canonical folder selected by the user. It may be a subfolder of
    /// a Git repository or an ordinary non-Git directory.
    pub repository_root: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_repository_root: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_common_directory: Option<PathBuf>,
    pub created_at: DateTime<Utc>,
    pub last_opened_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub key: String,
    pub value: Value,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSession {
    pub id: ProviderSessionId,
    pub task_id: TaskId,
    pub provider: ProviderKind,
    pub provider_thread_id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSession {
    pub id: RuntimeSessionId,
    pub task_id: TaskId,
    pub provider_session_id: Option<ProviderSessionId>,
    pub process_id: Option<String>,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
}

/// Durable provider-owned conversation identity plus the exact local scope
/// required to reconnect it after an app or provider-process restart.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResumeState {
    pub task_id: TaskId,
    pub provider: ProviderKind,
    pub session_ref: String,
    pub repository_root: PathBuf,
    pub permission: String,
    pub delegation: String,
    pub updated_at: DateTime<Utc>,
}

/// Who created an automation. Agent-created recurring work still carries a
/// separately verified excerpt of the user's explicit recurrence request.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutomationSource {
    User,
    Agent,
}

impl AutomationSource {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Agent => "agent",
        }
    }
}

impl FromStr for AutomationSource {
    type Err = crate::IntegratorError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "user" => Ok(Self::User),
            "agent" => Ok(Self::Agent),
            _ => Err(crate::IntegratorError::InvalidInput(format!(
                "unknown automation source: {value}"
            ))),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutomationStatus {
    Active,
    Paused,
    Running,
    Completed,
    NeedsAttention,
    Cancelled,
}

impl AutomationStatus {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::NeedsAttention => "needs-attention",
            Self::Cancelled => "cancelled",
        }
    }
}

impl FromStr for AutomationStatus {
    type Err = crate::IntegratorError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "active" => Ok(Self::Active),
            "paused" => Ok(Self::Paused),
            "running" => Ok(Self::Running),
            "completed" => Ok(Self::Completed),
            "needs-attention" => Ok(Self::NeedsAttention),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(crate::IntegratorError::InvalidInput(format!(
                "unknown automation status: {value}"
            ))),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AutomationTarget {
    Task,
    Delegation {
        #[serde(alias = "delegation_id")]
        delegation_id: DelegationId,
    },
}

/// Triggers are deliberately small and provider-neutral. Calendar/RRULE UI
/// can compile into these primitives without entering any runtime adapter.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AutomationTrigger {
    At {
        #[serde(alias = "run_at")]
        run_at: DateTime<Utc>,
    },
    Interval {
        #[serde(alias = "every_seconds")]
        every_seconds: u64,
        #[serde(alias = "anchor_at")]
        anchor_at: DateTime<Utc>,
        #[serde(default, alias = "end_at", skip_serializing_if = "Option::is_none")]
        end_at: Option<DateTime<Utc>>,
    },
    DelegationsSettled {
        #[serde(alias = "delegation_ids")]
        delegation_ids: Vec<DelegationId>,
        #[serde(alias = "require_all")]
        require_all: bool,
        #[serde(default, alias = "timeout_at", skip_serializing_if = "Option::is_none")]
        timeout_at: Option<DateTime<Utc>>,
    },
}

impl AutomationTrigger {
    #[must_use]
    pub const fn is_recurring(&self) -> bool {
        matches!(self, Self::Interval { .. })
    }
}

/// Exact execution policy frozen when the automation is created. Mutable
/// composer defaults never silently change an unattended run.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationFallback {
    pub runtime: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRoute {
    pub runtime: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default)]
    pub fallbacks: Vec<AutomationFallback>,
    pub permission: String,
    pub delegation: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: AutomationId,
    pub task_id: TaskId,
    pub title: String,
    pub prompt: String,
    pub target: AutomationTarget,
    pub trigger: AutomationTrigger,
    pub route: AutomationRoute,
    pub source: AutomationSource,
    /// Exact excerpt of the latest user message used to authorize recurrence.
    /// Absent for one-shot automation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_user_request: Option<String>,
    #[serde(default)]
    pub iteration_notes: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_note: Option<String>,
    pub status: AutomationStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutomationRunStatus {
    Claimed,
    Dispatched,
    Failed,
}

impl AutomationRunStatus {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Claimed => "claimed",
            Self::Dispatched => "dispatched",
            Self::Failed => "failed",
        }
    }
}

impl FromStr for AutomationRunStatus {
    type Err = crate::IntegratorError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "claimed" => Ok(Self::Claimed),
            "dispatched" => Ok(Self::Dispatched),
            "failed" => Ok(Self::Failed),
            _ => Err(crate::IntegratorError::InvalidInput(format!(
                "unknown automation run status: {value}"
            ))),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: AutomationRunId,
    pub automation_id: AutomationId,
    pub scheduled_for: DateTime<Utc>,
    pub status: AutomationRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub claimed_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalExport {
    pub schema_version: u32,
    pub exported_at: DateTime<Utc>,
    pub projects: Vec<TrustedProject>,
    /// Live (non-archived) tasks only. Archived chats load through
    /// `list_archived_tasks` so workspace bootstrap stays on the hot set.
    pub tasks: Vec<Task>,
    pub settings: Vec<Setting>,
    pub provider_sessions: Vec<ProviderSession>,
    pub runtime_sessions: Vec<RuntimeSession>,
    #[serde(default)]
    pub provider_resume_states: Vec<ProviderResumeState>,
    pub composer_drafts: Vec<ComposerDraft>,
    pub queued_messages: Vec<QueuedMessage>,
    #[serde(default)]
    pub context_references: Vec<TaskContextReference>,
    #[serde(default)]
    pub memories: Vec<MemoryEntry>,
}

/// One page of archived root chats for the Archive sidebar/settings surfaces.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedTaskPage {
    pub tasks: Vec<Task>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub total: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ComposerDraftOwner {
    NewChat {
        #[serde(rename = "projectId")]
        project_id: ProjectId,
    },
    Task {
        #[serde(rename = "taskId")]
        task_id: TaskId,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerDraftAttachment {
    pub path: String,
    pub name: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
}

/// A durable composer selection. The native host resolves the source Chat at
/// send time; the renderer never supplies transcript text or a filesystem
/// path for this reference.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatContextReference {
    pub id: ContextReferenceId,
    pub source_task_id: TaskId,
    pub source_title: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerDraft {
    pub owner: ComposerDraftOwner,
    pub prompt: String,
    pub attachments: Vec<ComposerDraftAttachment>,
    #[serde(default)]
    pub context_references: Vec<ChatContextReference>,
    pub runtime: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub permission: String,
    pub delegation: String,
    pub selection_start: u32,
    pub selection_end: u32,
    pub revision: u64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QueuedMessageState {
    Queued,
    Dispatching,
}

impl QueuedMessageState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Dispatching => "dispatching",
        }
    }
}

impl FromStr for QueuedMessageState {
    type Err = crate::IntegratorError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "queued" => Ok(Self::Queued),
            "dispatching" => Ok(Self::Dispatching),
            _ => Err(crate::IntegratorError::InvalidInput(format!(
                "unknown queued message state: {value}"
            ))),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewQueuedMessage {
    pub task_id: TaskId,
    pub prompt: String,
    pub attachments: Vec<ComposerDraftAttachment>,
    #[serde(default)]
    pub context_references: Vec<ChatContextReference>,
    pub runtime: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub permission: String,
    pub delegation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_action_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub id: QueuedMessageId,
    pub task_id: TaskId,
    pub prompt: String,
    pub attachments: Vec<ComposerDraftAttachment>,
    #[serde(default)]
    pub context_references: Vec<ChatContextReference>,
    pub runtime: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub permission: String,
    pub delegation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_action_id: Option<String>,
    pub position: u32,
    pub state: QueuedMessageState,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Immutable record of the exact bounded Chat context supplied to one target
/// task. `source_task_id` becomes null if the source is deleted, while the
/// snapshot and provenance stay legible in the target's local history.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskContextReference {
    pub id: ContextReferenceId,
    pub target_task_id: TaskId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_task_id: Option<TaskId>,
    pub source_title: String,
    pub source_watermark: u64,
    pub message_count: u32,
    pub rendered_chars: u32,
    pub rendered_sha256: String,
    pub rendered_markdown: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryState {
    #[default]
    Active,
    Disabled,
}

impl MemoryState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Disabled => "disabled",
        }
    }
}

impl FromStr for MemoryState {
    type Err = crate::IntegratorError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "active" => Ok(Self::Active),
            "disabled" => Ok(Self::Disabled),
            _ => Err(crate::IntegratorError::InvalidInput(format!(
                "unknown memory state: {value}"
            ))),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryCreator {
    #[default]
    User,
    Agent,
}

impl MemoryCreator {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Agent => "agent",
        }
    }
}

impl FromStr for MemoryCreator {
    type Err = crate::IntegratorError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "user" => Ok(Self::User),
            "agent" => Ok(Self::Agent),
            _ => Err(crate::IntegratorError::InvalidInput(format!(
                "unknown memory creator: {value}"
            ))),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: MemoryId,
    pub text: String,
    pub state: MemoryState,
    pub creator: MemoryCreator,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_task_id: Option<TaskId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_item_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMemoryEntry {
    pub text: String,
    #[serde(default)]
    pub creator: MemoryCreator,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_task_id: Option<TaskId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_item_id: Option<String>,
}

uuid_id!(DelegationId);

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DelegationPermission {
    ReadOnly,
    #[default]
    ProjectWrite,
}

impl DelegationPermission {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::ProjectWrite => "project-write",
        }
    }

    #[must_use]
    pub const fn is_read_only(&self) -> bool {
        matches!(self, Self::ReadOnly)
    }
}

impl FromStr for DelegationPermission {
    type Err = crate::IntegratorError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "read-only" => Ok(Self::ReadOnly),
            "project-write" => Ok(Self::ProjectWrite),
            _ => Err(crate::IntegratorError::InvalidInput(format!(
                "unknown delegation permission: {value}"
            ))),
        }
    }
}

/// Lifecycle of one delegated subagent. Delegation is fully asynchronous:
/// state changes never interrupt the orchestrator's conversation; they are
/// pulled via broker tools or surfaced in the UI lineage panel.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DelegationStatus {
    /// Created under `manual` mode; waiting for the user to approve.
    PendingApproval,
    Starting,
    Running,
    /// Idle: the child settled a turn without completing and has no queued
    /// work. Nudges wake it back to `Running`.
    Waiting,
    /// The child process/session was lost (app restart, crash, or transport
    /// drop) before the assignment finished. Resume restores provider state.
    Interrupted,
    Completed,
    Failed,
    Stopped,
    /// The user declined a `manual`-mode delegation.
    Denied,
}

impl DelegationStatus {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::PendingApproval => "pending-approval",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Interrupted => "interrupted",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
            Self::Denied => "denied",
        }
    }

    /// Statuses that count against the concurrency cap.
    #[must_use]
    pub const fn is_active(&self) -> bool {
        matches!(self, Self::Starting | Self::Running | Self::Waiting)
    }

    /// Process-owned work that cannot survive an Integrator restart.
    #[must_use]
    pub const fn is_process_owned(&self) -> bool {
        matches!(self, Self::Starting | Self::Running)
    }
}

impl FromStr for DelegationStatus {
    type Err = crate::IntegratorError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "pending-approval" => Ok(Self::PendingApproval),
            "starting" => Ok(Self::Starting),
            "running" => Ok(Self::Running),
            "waiting" => Ok(Self::Waiting),
            "interrupted" => Ok(Self::Interrupted),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "stopped" => Ok(Self::Stopped),
            "denied" => Ok(Self::Denied),
            _ => Err(crate::IntegratorError::InvalidInput(format!(
                "unknown delegation status: {value}"
            ))),
        }
    }
}

/// Who authored a delegation message. `User` messages travel the same
/// direction as orchestrator messages (into the child).
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DelegationSender {
    Orchestrator,
    Child,
    User,
}

impl DelegationSender {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Orchestrator => "orchestrator",
            Self::Child => "child",
            Self::User => "user",
        }
    }

    /// Messages from the child flow to the orchestrator; everything else
    /// flows to the child.
    #[must_use]
    pub const fn to_child(&self) -> bool {
        !matches!(self, Self::Child)
    }
}

impl FromStr for DelegationSender {
    type Err = crate::IntegratorError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "orchestrator" => Ok(Self::Orchestrator),
            "child" => Ok(Self::Child),
            "user" => Ok(Self::User),
            _ => Err(crate::IntegratorError::InvalidInput(format!(
                "unknown delegation sender: {value}"
            ))),
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationRoute {
    pub runtime: String,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// The host-resolved saved or one-off specialist contract frozen when a
/// delegation is requested. Existing children never reread mutable Settings.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationCapabilitySnapshot {
    pub version: u32,
    pub profile_id: String,
    pub profile_label: String,
    pub best_for: String,
    pub working_guidance: String,
    pub access_ceiling: DelegationPermission,
    pub service_level: String,
    pub routes: Vec<DelegationRoute>,
    pub skill_ids: Vec<String>,
    pub mcp_server_ids: Vec<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delegation {
    pub id: DelegationId,
    pub parent_task_id: TaskId,
    /// The child task holding the subagent's transcript. Absent until the
    /// delegation is approved and spawned.
    pub child_task_id: Option<TaskId>,
    /// Saved-profile identity, or a host-minted ephemeral identity for a
    /// one-off specialist.
    pub profile_id: String,
    pub profile_label: String,
    pub runtime: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Budget, Standard, or Premium route selected for this child.
    #[serde(default = "default_delegation_service_level")]
    pub service_level: String,
    /// Immutable specialist, route, access, and capability selection.
    pub capability_snapshot: DelegationCapabilitySnapshot,
    #[serde(default)]
    pub permission: DelegationPermission,
    pub title: String,
    /// The work brief the orchestrator handed over.
    pub brief: String,
    pub status: DelegationStatus,
    /// Deliverable reported by the child via `task_complete`, or a failure
    /// diagnostic.
    pub result: Option<String>,
    /// Provider-side session/thread reference used to resume the child for
    /// follow-up turns (structured CLI session id or Codex thread id).
    pub child_session_ref: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

fn default_delegation_service_level() -> String {
    "standard".into()
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationMessage {
    pub id: String,
    pub delegation_id: DelegationId,
    pub sender: DelegationSender,
    pub body: String,
    pub created_at: DateTime<Utc>,
    /// When the message reached its recipient: injected into a child turn,
    /// returned through an orchestrator broker tool, or prepended to the
    /// orchestrator's next wire prompt.
    pub delivered_at: Option<DateTime<Utc>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn provider_kind_round_trips_as_stable_wire_value() {
        let json = serde_json::to_string(&ProviderKind::CustomAcp).expect("serialize provider");
        assert_eq!(json, "\"custom-acp\"");
        let decoded: ProviderKind = serde_json::from_str(&json).expect("deserialize provider");
        assert_eq!(decoded, ProviderKind::CustomAcp);
        assert_eq!(
            ProviderKind::from_str("kimi").expect("Kimi provider wire id"),
            ProviderKind::Kimi
        );
    }

    #[test]
    fn versioned_wrapper_marks_current_schema() {
        let wrapped = Versioned::current(TaskState::Ready);
        assert_eq!(wrapped.schema_version, crate::DOMAIN_SCHEMA_VERSION);
    }

    #[test]
    fn automation_wire_values_use_complete_camel_case_payloads() {
        let anchor_at = "2026-07-19T23:47:00Z"
            .parse::<DateTime<Utc>>()
            .expect("valid automation anchor");
        let trigger = AutomationTrigger::Interval {
            every_seconds: 60,
            anchor_at,
            end_at: None,
        };

        assert_eq!(
            serde_json::to_value(&trigger).expect("serialize automation trigger"),
            json!({
                "kind": "interval",
                "everySeconds": 60,
                "anchorAt": "2026-07-19T23:47:00Z"
            })
        );
        assert_eq!(
            serde_json::from_value::<AutomationTrigger>(json!({
                "kind": "interval",
                "everySeconds": 60,
                "anchorAt": "2026-07-19T23:47:00Z"
            }))
            .expect("deserialize automation trigger"),
            trigger
        );
        assert_eq!(
            serde_json::from_value::<AutomationTrigger>(json!({
                "kind": "interval",
                "every_seconds": 60,
                "anchor_at": "2026-07-19T23:47:00Z"
            }))
            .expect("deserialize legacy automation trigger"),
            trigger
        );

        let route = AutomationRoute {
            runtime: "codex".into(),
            model: "gpt-5.6-sol".into(),
            effort: None,
            fallbacks: Vec::new(),
            permission: "read-only".into(),
            delegation: "off".into(),
        };
        let route_json = serde_json::to_value(route).expect("serialize automation route");
        assert_eq!(route_json["fallbacks"], json!([]));
    }
}
