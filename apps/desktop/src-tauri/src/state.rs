use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};

use adapter_acp::AcpClient;
use adapter_codex::CodexClient;
use directories::ProjectDirs;
use integrator_core::{IntegratorError, ProviderKind, Result, RuntimeBinding, TaskId};
use integrator_runtime::{AuthorizedRepositoryCache, GitService, StructuredCliClient};
use session_store::LocalStore;
use tokio::sync::Mutex;

/// One connected Codex app-server process plus the task/thread binding the
/// projection pump uses to attribute events.
#[derive(Clone, Debug)]
pub struct PendingNativeSkill {
    pub name: String,
    pub wire_prompt: String,
    pub visible_prompt: String,
    pub provider_item_id: Option<String>,
}

#[derive(Clone)]
pub struct CodexRuntime {
    pub client: CodexClient,
    pub process_id: String,
    /// Cleared by the projection pump when the provider process exits. The
    /// registry intentionally keeps the task slot until reconnect so stale
    /// handles can never make a crashed turn look live.
    pub alive: Arc<AtomicBool>,
    pub binding: Arc<std::sync::Mutex<Option<RuntimeBinding>>>,
    /// Conversation digest queued for injection into the first turn of a
    /// freshly created provider thread, so a new session inherits the task's
    /// prior context (possibly produced by a different provider).
    pub context_primer: Arc<std::sync::Mutex<Option<String>>>,
    /// Rewrites Codex's `$skill` wire echo back to the visible `/skill` draft
    /// and stamps the resulting durable user item as a verified skill call.
    pub pending_native_skill: Arc<std::sync::Mutex<Option<PendingNativeSkill>>>,
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
    pub alive: Arc<AtomicBool>,
    pub binding: Arc<std::sync::Mutex<Option<RuntimeBinding>>>,
    /// The client-generated id of the in-flight prompt; ACP has no provider
    /// turn identity, so this attributes streamed session updates.
    pub current_turn: Arc<std::sync::Mutex<Option<String>>>,
    pub permission_options: Arc<std::sync::Mutex<HashMap<String, Vec<AcpPermissionOption>>>>,
    /// Session mode state advertised by `session/new` and kept current by
    /// `current_mode_update` notifications / `session/set_mode` calls.
    pub session_modes: Arc<std::sync::Mutex<Option<integrator_core::ModeProjection>>>,
    /// Transport keys of pending `cursor/create_plan` extension requests.
    /// Their responses use the create-plan result shape instead of the
    /// standard permission outcome.
    pub plan_requests: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    /// Full replacement from ACP `available_commands_update`. These are
    /// provider-native slash actions (skills and built-ins are intentionally
    /// not reclassified by Integrator).
    pub available_actions: Arc<std::sync::Mutex<Vec<crate::native_actions::NativeProviderAction>>>,
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
    pub alive: Arc<AtomicBool>,
    pub binding: Arc<std::sync::Mutex<Option<RuntimeBinding>>>,
    pub current_turn: Arc<std::sync::Mutex<Option<String>>>,
    pub last_diagnostic: Arc<std::sync::Mutex<Option<String>>>,
    /// Pending `can_use_tool` permission requests keyed by control request
    /// id. Each value stores the original tool `input` (echoed back on
    /// allow) and the CLI's `permission_suggestions` (echoed back on
    /// allow-always). Lives only as long as the provider process.
    pub permission_requests: Arc<std::sync::Mutex<HashMap<String, PendingStructuredPermission>>>,
    /// Vendor session id captured from structured events and reused on the
    /// next turn so native Claude skill context stays provider-owned.
    pub session_ref: Arc<std::sync::Mutex<Option<String>>>,
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

/// Install or reconnect one task-owned runtime without disturbing work owned
/// by any other chat.
pub fn replace_task_runtime<T>(
    runtimes: &mut HashMap<TaskId, T>,
    task_id: TaskId,
    runtime: T,
) -> Option<T> {
    runtimes.insert(task_id, runtime)
}

/// Remove only the runtime named by a stop/retry/reconnect operation.
pub fn remove_task_runtime<T>(runtimes: &mut HashMap<TaskId, T>, task_id: TaskId) -> Option<T> {
    runtimes.remove(&task_id)
}

pub struct AppState {
    pub store: Arc<LocalStore>,
    pub data_directory: PathBuf,
    pub git: Option<GitService>,
    /// Exact canonical repository/worktree identities that already passed the
    /// trusted-project boundary. Trust-changing commands serialize through
    /// this mutex and clear it before returning.
    pub git_authorizations: Arc<std::sync::Mutex<AuthorizedRepositoryCache>>,
    /// Primary runtimes are task-owned, not view-owned. Navigating to or
    /// starting work in another chat must not replace a live provider process.
    pub codex: Mutex<HashMap<TaskId, CodexRuntime>>,
    /// Unbound helper used only for provider-wide discovery such as model
    /// catalogs. It never owns a task turn.
    pub codex_catalog: Mutex<Option<CodexRuntime>>,
    pub acp: Mutex<HashMap<TaskId, AcpRuntime>>,
    /// ACP discovery helpers are provider-keyed because Cursor and Grok use
    /// different local processes even before a task session exists.
    pub acp_catalog: Mutex<HashMap<ProviderKind, AcpRuntime>>,
    pub structured: Mutex<HashMap<TaskId, StructuredRuntime>>,
    /// Opaque renderer ids mapped to trusted provider/cwd/action records.
    /// Paths remain native-only and handles are replaced on each catalog
    /// refresh for that provider/repository pair.
    pub native_action_handles:
        std::sync::Mutex<HashMap<String, crate::native_actions::NativeActionHandle>>,
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
        store.interrupt_unfinished_runtime_sessions()?;
        Ok(Self {
            store: Arc::new(store),
            data_directory,
            git: GitService::discover().ok(),
            git_authorizations: Arc::new(std::sync::Mutex::new(
                AuthorizedRepositoryCache::default(),
            )),
            codex: Mutex::new(HashMap::new()),
            codex_catalog: Mutex::new(None),
            acp: Mutex::new(HashMap::new()),
            acp_catalog: Mutex::new(HashMap::new()),
            structured: Mutex::new(HashMap::new()),
            native_action_handles: std::sync::Mutex::new(HashMap::new()),
            voice_typing: std::sync::Mutex::new(None),
            terminals: std::sync::Mutex::new(HashMap::new()),
            delegation_children: Mutex::new(HashMap::new()),
            broker: std::sync::Mutex::new(None),
        })
    }
}

#[cfg(test)]
mod task_runtime_registry_fixtures {
    use super::{remove_task_runtime, replace_task_runtime};
    use integrator_core::TaskId;
    use std::collections::HashMap;

    #[test]
    fn happy_two_chat_runs_coexist() {
        let first = TaskId::new();
        let second = TaskId::new();
        let mut runtimes = HashMap::new();
        replace_task_runtime(&mut runtimes, first, "first-running");
        replace_task_runtime(&mut runtimes, second, "second-running");
        assert_eq!(runtimes.get(&first), Some(&"first-running"));
        assert_eq!(runtimes.get(&second), Some(&"second-running"));
    }

    #[test]
    fn degraded_missing_chat_does_not_disturb_live_work() {
        let running = TaskId::new();
        let missing = TaskId::new();
        let mut runtimes = HashMap::from([(running, "running")]);
        assert_eq!(remove_task_runtime(&mut runtimes, missing), None);
        assert_eq!(runtimes.get(&running), Some(&"running"));
    }

    #[test]
    fn restart_reconnect_replaces_only_the_named_chat() {
        let reconnecting = TaskId::new();
        let background = TaskId::new();
        let mut runtimes = HashMap::from([
            (reconnecting, "stale-process"),
            (background, "background-running"),
        ]);
        assert_eq!(
            replace_task_runtime(&mut runtimes, reconnecting, "reconnected-process"),
            Some("stale-process")
        );
        assert_eq!(runtimes.get(&reconnecting), Some(&"reconnected-process"));
        assert_eq!(runtimes.get(&background), Some(&"background-running"));
    }

    #[test]
    fn cancellation_race_is_scoped_to_the_target_chat() {
        let stopped = TaskId::new();
        let background = TaskId::new();
        let mut runtimes = HashMap::from([(stopped, "stopping"), (background, "running")]);
        assert_eq!(
            remove_task_runtime(&mut runtimes, stopped),
            Some("stopping")
        );
        assert_eq!(runtimes.get(&background), Some(&"running"));
    }

    #[test]
    fn adversarial_unknown_task_identity_cannot_replace_an_existing_run() {
        let trusted = TaskId::new();
        let untrusted = TaskId::new();
        let mut runtimes = HashMap::from([(trusted, "trusted-run")]);
        replace_task_runtime(&mut runtimes, untrusted, "isolated-run");
        assert_eq!(runtimes.get(&trusted), Some(&"trusted-run"));
        assert_eq!(runtimes.get(&untrusted), Some(&"isolated-run"));
    }
}
