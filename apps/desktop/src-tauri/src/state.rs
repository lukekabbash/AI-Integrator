use std::{fs, sync::Arc};

use adapter_codex::CodexClient;
use directories::ProjectDirs;
use integrator_core::{IntegratorError, Result};
use integrator_runtime::GitService;
use session_store::LocalStore;
use tokio::sync::Mutex;

pub struct AppState {
    pub store: Arc<LocalStore>,
    pub git: Option<GitService>,
    pub codex: Mutex<Option<CodexClient>>,
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
        })
    }
}
