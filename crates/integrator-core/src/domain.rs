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

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Versioned<T> {
    pub schema_version: u32,
    pub value: T,
}

impl<T> Versioned<T> {
    #[must_use]
    pub fn v1(value: T) -> Self {
        Self {
            schema_version: crate::DOMAIN_SCHEMA_VERSION,
            value,
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    Codex,
    Claude,
    Gemini,
    Cursor,
    Grok,
    CustomAcp,
}

impl ProviderKind {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Gemini => "gemini",
            Self::Cursor => "cursor",
            Self::Grok => "grok",
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
            "gemini" => Ok(Self::Gemini),
            "cursor" => Ok(Self::Cursor),
            "grok" => Ok(Self::Grok),
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: TaskId,
    pub title: String,
    pub repository_path: Option<PathBuf>,
    pub worktree_path: Option<PathBuf>,
    pub state: TaskState,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTask {
    pub title: String,
    pub repository_path: Option<PathBuf>,
    pub worktree_path: Option<PathBuf>,
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
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalExport {
    pub schema_version: u32,
    pub exported_at: DateTime<Utc>,
    pub tasks: Vec<Task>,
    pub settings: Vec<Setting>,
    pub provider_sessions: Vec<ProviderSession>,
    pub runtime_sessions: Vec<RuntimeSession>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_kind_round_trips_as_stable_wire_value() {
        let json = serde_json::to_string(&ProviderKind::CustomAcp).expect("serialize provider");
        assert_eq!(json, "\"custom-acp\"");
        let decoded: ProviderKind = serde_json::from_str(&json).expect("deserialize provider");
        assert_eq!(decoded, ProviderKind::CustomAcp);
    }

    #[test]
    fn versioned_wrapper_marks_v1() {
        let wrapped = Versioned::v1(TaskState::Ready);
        assert_eq!(wrapped.schema_version, 1);
    }
}
