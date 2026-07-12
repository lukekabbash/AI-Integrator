use std::{collections::HashMap, fs, path::PathBuf, sync::Arc};

use adapter_acp::AcpClient;
use adapter_codex::CodexClient;
use directories::ProjectDirs;
use integrator_core::{IntegratorError, ProviderKind, Result, RuntimeBinding};
use integrator_runtime::{GitService, StructuredCliClient};
use session_store::LocalStore;
use tokio::sync::Mutex;

/// One connected Codex app-server process plus the task/thread binding the
/// projection pump uses to attribute events.
#[derive(Clone)]
pub struct CodexRuntime {
    pub client: CodexClient,
    pub process_id: String,
    pub binding: Arc<std::sync::Mutex<Option<RuntimeBinding>>>,
    /// Conversation digest queued for injection into the first turn of a
    /// freshly created provider thread, so a new session inherits the task's
    /// prior context (possibly produced by a different provider).
    pub context_primer: Arc<std::sync::Mutex<Option<String>>>,
}

/// A permission option advertised by an ACP `session/request_permission`
/// request. Kept in memory keyed by transport request id: approvals are only
/// answerable while the requesting agent process is alive, so the mapping
/// does not need to survive restarts.
#[derive(Clone, Debug)]
pub struct AcpPermissionOption {
    pub option_id: String,
    pub kind: String,
}

/// One connected ACP agent process (e.g. `cursor-agent acp`).
#[derive(Clone)]
pub struct AcpRuntime {
    pub client: AcpClient,
    /// Provider identity is retained alongside the shared ACP transport so
    /// bindings, diagnostics, and cancellation never silently assume Cursor.
    pub provider: ProviderKind,
    pub process_id: String,
    pub binding: Arc<std::sync::Mutex<Option<RuntimeBinding>>>,
    /// The client-generated id of the in-flight prompt; ACP has no provider
    /// turn identity, so this attributes streamed session updates.
    pub current_turn: Arc<std::sync::Mutex<Option<String>>>,
    pub permission_options: Arc<std::sync::Mutex<HashMap<String, Vec<AcpPermissionOption>>>>,
    /// See `CodexRuntime::context_primer`.
    pub context_primer: Arc<std::sync::Mutex<Option<String>>>,
    /// One-shot delegation tool preamble queued at session start and spent
    /// on the first turn (ACP sessions persist, so it must not repeat).
    pub delegation_preamble: Arc<std::sync::Mutex<Option<String>>>,
}

/// One provider-neutral structured CLI route. The vendor CLI owns auth and
/// credentials; Integrator retains only local task/process attribution.
#[derive(Clone)]
pub struct StructuredRuntime {
    pub client: StructuredCliClient,
    pub process_id: String,
    pub binding: Arc<std::sync::Mutex<Option<RuntimeBinding>>>,
    pub current_turn: Arc<std::sync::Mutex<Option<String>>>,
    pub last_diagnostic: Arc<std::sync::Mutex<Option<String>>>,
    /// Pending `can_use_tool` permission requests keyed by control request
    /// id. Each value stores the original tool `input` (echoed back on
    /// allow) and the CLI's `permission_suggestions` (echoed back on
    /// allow-always). Lives only as long as the provider process.
    pub permission_requests: Arc<std::sync::Mutex<HashMap<String, PendingStructuredPermission>>>,
}

/// See [`StructuredRuntime::permission_requests`].
#[derive(Clone, Debug)]
pub struct PendingStructuredPermission {
    pub input: serde_json::Value,
    pub suggestions: serde_json::Value,
}

/// One live delegated subagent. Persistence uses the child task's own
/// runtime binding (inside the driver's runtime); this entry only carries
/// the delegation state machine's in-memory bits.
pub struct DelegationChild {
    pub delegation_id: integrator_core::DelegationId,
    pub child_task_id: integrator_core::TaskId,
    pub parent_task_id: integrator_core::TaskId,
    /// A turn is currently in flight; queued messages wait for it to settle.
    pub busy: Arc<std::sync::Mutex<bool>>,
    /// Set by the `task_complete` broker tool so turn settlement does not
    /// misfile a finished delegation as `waiting`.
    pub completed: Arc<std::sync::Mutex<bool>>,
    pub driver: DelegationChildDriver,
}

pub enum DelegationChildDriver {
    /// Claude/Antigravity print-mode CLIs: one process per turn, resumed via
    /// the provider session id captured from its events.
    Structured {
        runtime: StructuredRuntime,
        provider: ProviderKind,
        executable: PathBuf,
        cwd: PathBuf,
        model: Option<String>,
        effort: Option<String>,
        mcp_config: Option<PathBuf>,
        session_ref: Arc<std::sync::Mutex<Option<String>>>,
    },
    /// Codex app-server: one long-lived process per child thread.
    Codex {
        runtime: CodexRuntime,
        thread_id: String,
    },
}

/// The command currently executing in a terminal session. Dropping the kill
/// sender aborts nothing on its own; `terminal_interrupt` fires it to stop
/// the child process.
pub struct TerminalRun {
    pub run_id: String,
    pub kill: tokio::sync::oneshot::Sender<()>,
}

/// One interactive terminal bound to a trusted repository. Commands always
/// execute inside `root`; `cwd` tracks `cd` but may never escape the
/// repository the user explicitly trusted.
pub struct TerminalSession {
    pub root: PathBuf,
    pub cwd: PathBuf,
    pub running: Option<TerminalRun>,
}

pub struct VoiceTypingSession {
    pub sender: tokio::sync::mpsc::Sender<VoiceTypingCommand>,
}

pub enum VoiceTypingCommand {
    Append(Vec<u8>),
    Stop(tokio::sync::oneshot::Sender<()>),
}

pub struct AppState {
    pub store: Arc<LocalStore>,
    pub data_directory: PathBuf,
    pub git: Option<GitService>,
    pub codex: Mutex<Option<CodexRuntime>>,
    pub acp: Mutex<Option<AcpRuntime>>,
    pub structured: Mutex<Option<StructuredRuntime>>,
    pub voice_typing: std::sync::Mutex<Option<VoiceTypingSession>>,
    pub terminals: std::sync::Mutex<HashMap<String, TerminalSession>>,
    /// Live delegated subagents keyed by delegation id. Unlike the primary
    /// single-slot runtimes above, children run concurrently.
    pub delegation_children: Mutex<HashMap<String, Arc<crate::state::DelegationChild>>>,
    /// Loopback address + token of the delegation broker, set once its
    /// listener binds at startup.
    pub broker: std::sync::Mutex<Option<crate::delegation::BrokerInfo>>,
}

impl AppState {
    pub fn initialize() -> Result<Self> {
        let directories =
            ProjectDirs::from("dev", "AI Integrator", "AI Integrator").ok_or_else(|| {
                IntegratorError::Unavailable("application data directory unavailable".into())
            })?;
        let data_directory = directories.data_local_dir().to_path_buf();
        fs::create_dir_all(&data_directory)?;
        let store = LocalStore::open(data_directory.join("integrator.sqlite3"))?;
        Ok(Self {
            store: Arc::new(store),
            data_directory,
            git: GitService::discover().ok(),
            codex: Mutex::new(None),
            acp: Mutex::new(None),
            structured: Mutex::new(None),
            voice_typing: std::sync::Mutex::new(None),
            terminals: std::sync::Mutex::new(HashMap::new()),
            delegation_children: Mutex::new(HashMap::new()),
            broker: std::sync::Mutex::new(None),
        })
    }
}
