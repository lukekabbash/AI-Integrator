use std::{collections::HashMap, fs, sync::Arc};

use adapter_acp::AcpClient;
use adapter_codex::CodexClient;
use directories::ProjectDirs;
use integrator_core::{IntegratorError, Result, RuntimeBinding};
use integrator_runtime::GitService;
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
    pub process_id: String,
    pub binding: Arc<std::sync::Mutex<Option<RuntimeBinding>>>,
    /// The client-generated id of the in-flight prompt; ACP has no provider
    /// turn identity, so this attributes streamed session updates.
    pub current_turn: Arc<std::sync::Mutex<Option<String>>>,
    pub permission_options: Arc<std::sync::Mutex<HashMap<String, Vec<AcpPermissionOption>>>>,
    /// See `CodexRuntime::context_primer`.
    pub context_primer: Arc<std::sync::Mutex<Option<String>>>,
}

pub struct AppState {
    pub store: Arc<LocalStore>,
    pub git: Option<GitService>,
    pub codex: Mutex<Option<CodexRuntime>>,
    pub acp: Mutex<Option<AcpRuntime>>,
}

impl AppState {
    pub fn initialize() -> Result<Self> {
        let directories =
            ProjectDirs::from("dev", "AI Integrator", "AI Integrator").ok_or_else(|| {
                IntegratorError::Unavailable("application data directory unavailable".into())
            })?;
        let data_directory = directories.data_local_dir();
        fs::create_dir_all(data_directory)?;
        let store = LocalStore::open(data_directory.join("integrator.sqlite3"))?;
        Ok(Self {
            store: Arc::new(store),
            git: GitService::discover().ok(),
            codex: Mutex::new(None),
            acp: Mutex::new(None),
        })
    }
}
