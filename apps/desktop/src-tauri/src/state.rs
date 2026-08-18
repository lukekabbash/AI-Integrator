use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use adapter_acp::AcpClient;
use adapter_codex::CodexClient;
use chrono::{DateTime, Utc};
use directories::ProjectDirs;
use integrator_core::{
    DelegationPermission, IntegratorError, ProviderKind, ProviderStatus, Result, RuntimeBinding,
    TaskId,
};
use integrator_runtime::{
    AuthorizedRepositoryCache, GitService, StructuredCliClient, discover_providers,
};
use portable_pty::{ChildKiller, MasterPty};
use session_store::LocalStore;
use tokio::sync::{Mutex, Notify, broadcast, watch};
use zeroize::Zeroizing;

use crate::repository_watch::{RepositoryWatchRegistry, RepositoryWatcher};

/// One connected Codex app-server process plus the task/thread binding the
/// projection pump uses to attribute events.
#[derive(Clone, Debug)]
pub struct PendingUserPrompt {
    pub wire_prompt: String,
    pub visible_prompt: String,
    pub native_skill: Option<String>,
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
    pub reconciling: Arc<AtomicBool>,
    pub binding: Arc<std::sync::Mutex<Option<RuntimeBinding>>>,
    /// Conversation digest + image paths queued for injection into the first
    /// turn of a freshly created provider thread (any provider).
    pub context_primer: Arc<std::sync::Mutex<Option<session_store::HandoffDigest>>>,
    /// Keeps provider-only context out of the durable user transcript and,
    /// when applicable, stamps a verified native skill invocation.
    pub pending_user_prompt: Arc<std::sync::Mutex<Option<PendingUserPrompt>>>,
    /// The delegation preamble text most recently injected into the live
    /// thread. Codex threads persist their history, so the block is sent
    /// once and repeated only when its content changes (mode or user policy
    /// edits), never on every turn.
    pub sent_delegation_preamble: Arc<std::sync::Mutex<Option<String>>>,
    /// See [`CodexRuntime::sent_delegation_preamble`]; same dedupe for the
    /// `<integrator-skills>` index, re-sent only when the enabled set changes.
    pub sent_skill_index: Arc<std::sync::Mutex<Option<String>>>,
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

#[derive(Clone, Debug)]
pub struct AcpSessionSpec {
    pub cwd: PathBuf,
    pub mcp_servers: Vec<serde_json::Value>,
}

#[derive(Clone, Debug)]
pub struct AcpTurnSettlement {
    pub failed: bool,
}

/// One connected ACP agent process (e.g. `cursor-agent acp`).
#[derive(Clone)]
pub struct AcpRuntime {
    pub client: AcpClient,
    /// Provider identity is retained alongside the shared ACP transport so
    /// bindings, diagnostics, and cancellation never silently assume Cursor.
    pub provider: ProviderKind,
    /// Model/effort fixed at process launch for ACP agents such as Grok that
    /// expose routing as CLI flags instead of session config options.
    pub launch_model: Option<String>,
    pub launch_effort: Option<String>,
    pub process_id: String,
    pub alive: Arc<AtomicBool>,
    pub binding: Arc<std::sync::Mutex<Option<RuntimeBinding>>>,
    /// The client-generated id of the in-flight prompt; ACP has no provider
    /// turn identity, so this attributes streamed session updates.
    pub current_turn: Arc<std::sync::Mutex<Option<String>>>,
    /// Captured with `current_turn` so the ordered prompt boundary can build
    /// the terminal projection after every preceding stream update is stored.
    pub current_turn_started_at: Arc<std::sync::Mutex<Option<DateTime<Utc>>>>,
    /// Emitted by the projection pump only after it persists the ordered
    /// prompt boundary and clears the active turn. Delegated-child lifecycle
    /// watchers use this instead of racing the raw prompt future.
    pub turn_settled: broadcast::Sender<AcpTurnSettlement>,
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
    pub context_primer: Arc<std::sync::Mutex<Option<session_store::HandoffDigest>>>,
    /// One-shot delegation tool preamble queued at session start and spent
    /// on the first turn (ACP sessions persist, so it must not repeat).
    pub delegation_preamble: Arc<std::sync::Mutex<Option<String>>>,
    /// The `<integrator-skills>` index most recently injected into the live
    /// session. ACP sessions persist their history, so the index is re-sent
    /// only when the enabled-skill set changes, never on every turn.
    pub sent_skill_index: Arc<std::sync::Mutex<Option<String>>>,
    /// Delegated children run without a human watching their approvals: the
    /// pump resolves `session/request_permission` and `cursor/create_plan`
    /// immediately (the ACP analog of Codex's approval-policy "never")
    /// instead of parking an approval card no one will answer.
    pub unattended: bool,
    /// Read-only delegated children reject ACP permission requests instead of
    /// inheriting the unattended auto-allow behavior used by writing workers.
    pub read_only: bool,
    /// Project Grok ACP launches `--always-approve` so tool prompts must not
    /// park a card. Chat stays `dontAsk` and keeps this false.
    pub auto_approve_permissions: bool,
    /// Exact lifecycle parameters required by ACP session/load or
    /// session/resume. Kept in memory only; the durable resume record stores
    /// no MCP secrets.
    pub session_spec: Arc<std::sync::Mutex<Option<AcpSessionSpec>>>,
    /// True while session/load replay notifications are being reconciled.
    pub replaying_history: Arc<AtomicBool>,
}

impl AcpRuntime {
    #[must_use]
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire) && self.client.is_alive()
    }
}

#[derive(Clone, Debug)]
pub struct StructuredResumeContext {
    pub repository: PathBuf,
    pub permission: String,
    pub delegation: String,
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
    /// Integrator-owned Agy customization root. It remains outside the user
    /// repository and is reused with the provider conversation.
    pub control_overlay: Option<PathBuf>,
    /// Redacted official-hook event stream inside `control_overlay`.
    pub hook_event_log: Option<PathBuf>,
    pub resume_context: Option<StructuredResumeContext>,
    /// The `<integrator-skills>` index most recently injected into the
    /// resumed provider conversation (Antigravity only; Claude loads skills
    /// natively). Carried across the per-turn process respawns like
    /// `control_overlay` so the index repeats only when the enabled-skill
    /// set changes, never on every turn.
    pub sent_skill_index: Arc<std::sync::Mutex<Option<String>>>,
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
    /// Newest transcript item seq already scanned for `<integrator:…>`
    /// sentinel blocks. `Some` only for children without broker tools; `None`
    /// disables sentinel routing so tooled children can quote the syntax
    /// safely (e.g. while working on Integrator's own source).
    pub sentinel_watermark: Option<Arc<std::sync::Mutex<i64>>>,
    /// Exact selected-skill index for runtimes without native plugin loading.
    /// Wire-only, spent on the child's first turn: the provider session keeps
    /// its history, so later turns must not repeat it. Respawned drivers are
    /// rebuilt with a fresh index.
    pub capability_index: Arc<std::sync::Mutex<Option<String>>>,
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
        permission: DelegationPermission,
        mcp_config: Option<PathBuf>,
        plugin_dirs: Vec<PathBuf>,
        session_ref: Arc<std::sync::Mutex<Option<String>>>,
    },
    /// Codex app-server: one long-lived process per child thread.
    Codex {
        runtime: CodexRuntime,
        thread_id: String,
    },
    /// Cursor/Grok ACP agents: one long-lived process per child session,
    /// running unattended (permission prompts auto-resolve in the pump).
    Acp {
        runtime: AcpRuntime,
        session_id: String,
    },
}

/// One live PTY-backed terminal bound to a trusted repository. The shell
/// owns its current directory; the renderer only receives an opaque session
/// id and can write bytes, resize, interrupt, or close the session.
pub struct TerminalSession {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub killer: Box<dyn ChildKiller + Send + Sync>,
    /// Process id of the PTY session leader (the shell). Compared against
    /// the terminal's foreground process group to tell a foreground job
    /// apart from an idle prompt.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub shell_pid: Option<u32>,
}

impl TerminalSession {
    /// True when the terminal's foreground process group is a job the shell
    /// spawned rather than the shell itself. Platforms without a cheap
    /// foreground-group query report a process as always running.
    pub fn has_foreground_process(&self) -> bool {
        #[cfg(unix)]
        {
            crate::terminal_process::foreground_process_active(
                self.master.process_group_leader(),
                self.shell_pid,
            )
        }
        #[cfg(not(unix))]
        {
            true
        }
    }
}

#[derive(Default)]
struct NativeSecretCache {
    values: HashMap<String, Zeroizing<String>>,
}

impl NativeSecretCache {
    fn get(&self, id: &str) -> Option<Zeroizing<String>> {
        self.values.get(id).cloned()
    }

    fn insert(&mut self, id: &str, secret: Zeroizing<String>) {
        self.values.insert(id.to_owned(), secret);
    }

    fn remove(&mut self, id: &str) {
        self.values.remove(id);
    }
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

/// Short-lived reservation covering provider setup before the turn is visible
/// in the durable projection. This closes the launch race without holding a
/// mutex across provider discovery or process startup.
pub struct TurnLaunchGuard {
    launches: Arc<std::sync::Mutex<HashSet<TaskId>>>,
    task_id: TaskId,
}

impl Drop for TurnLaunchGuard {
    fn drop(&mut self) {
        self.launches
            .lock()
            .expect("turn launch lock")
            .remove(&self.task_id);
    }
}

fn reserve_turn_launch(
    launches: &Arc<std::sync::Mutex<HashSet<TaskId>>>,
    task_id: TaskId,
) -> Option<TurnLaunchGuard> {
    let inserted = launches.lock().expect("turn launch lock").insert(task_id);
    inserted.then(|| TurnLaunchGuard {
        launches: Arc::clone(launches),
        task_id,
    })
}

fn reusable_provider_statuses(
    cached: &Option<Vec<ProviderStatus>>,
    force: bool,
) -> Option<Vec<ProviderStatus>> {
    if force { None } else { cached.clone() }
}

struct CodexUsageRefreshState {
    running: bool,
    generation: u64,
}

struct CodexUsageRefreshFlight {
    state: std::sync::Mutex<CodexUsageRefreshState>,
    completed: watch::Sender<u64>,
}

impl CodexUsageRefreshFlight {
    fn new() -> Self {
        let (completed, _) = watch::channel(0);
        Self {
            state: std::sync::Mutex::new(CodexUsageRefreshState {
                running: false,
                generation: 0,
            }),
            completed,
        }
    }

    async fn join_or_lead(&self) -> Option<CodexUsageRefreshGuard<'_>> {
        let mut completed = self.completed.subscribe();
        let generation = {
            let mut state = self.state.lock().expect("Codex usage refresh lock");
            if !state.running {
                state.running = true;
                return Some(CodexUsageRefreshGuard { flight: self });
            }
            state.generation
        };
        while *completed.borrow() == generation {
            if completed.changed().await.is_err() {
                break;
            }
        }
        None
    }
}

pub struct CodexUsageRefreshGuard<'a> {
    flight: &'a CodexUsageRefreshFlight,
}

impl Drop for CodexUsageRefreshGuard<'_> {
    fn drop(&mut self) {
        let generation = {
            let mut state = self.flight.state.lock().expect("Codex usage refresh lock");
            state.running = false;
            state.generation = state.generation.wrapping_add(1);
            state.generation
        };
        self.flight.completed.send_replace(generation);
    }
}

pub struct AppState {
    pub store: Arc<LocalStore>,
    pub data_directory: PathBuf,
    pub git: Option<GitService>,
    /// One sanitized runtime inventory for the whole native process. The first
    /// window fills it during boot; secondary windows and task launches reuse
    /// it until an explicit status refresh replaces it.
    provider_status_cache: Mutex<Option<Vec<ProviderStatus>>>,
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
    codex_usage_refresh: CodexUsageRefreshFlight,
    pub acp: Mutex<HashMap<TaskId, AcpRuntime>>,
    /// ACP discovery helpers are provider-keyed because Cursor and Grok use
    /// different local processes even before a task session exists.
    pub acp_catalog: Mutex<HashMap<ProviderKind, AcpRuntime>>,
    pub structured: Mutex<HashMap<TaskId, StructuredRuntime>>,
    turn_launches: Arc<std::sync::Mutex<HashSet<TaskId>>>,
    /// Opaque renderer ids mapped to trusted provider/cwd/action records.
    /// Paths remain native-only and handles are replaced on each catalog
    /// refresh for that provider/repository pair.
    pub native_action_handles:
        std::sync::Mutex<HashMap<String, crate::native_actions::NativeActionHandle>>,
    /// Secrets saved for first-party data skills. Keychain remains the
    /// persistent store; this zeroizing process-local cache prevents repeated
    /// credential reads and never crosses the native command boundary.
    skill_credentials: std::sync::Mutex<NativeSecretCache>,
    pub terminals: std::sync::Mutex<HashMap<String, TerminalSession>>,
    /// Vendor setup/update PTYs. Each session is born from a native allowlisted
    /// plan; the renderer can write terminal bytes but cannot choose a program,
    /// argv, cwd, or inherited environment.
    pub runtime_terminals:
        std::sync::Mutex<HashMap<String, crate::runtime_setup::RuntimeTerminalSession>>,
    /// One authorized, debounced working-tree watcher per app window. The
    /// renderer receives only an opaque invalidation signal, never file paths.
    pub repository_watchers: std::sync::Mutex<RepositoryWatchRegistry<RepositoryWatcher>>,
    /// Live delegated subagents keyed by delegation id. Unlike the primary
    /// single-slot runtimes above, children run concurrently.
    pub delegation_children: Mutex<HashMap<String, Arc<crate::state::DelegationChild>>>,
    /// Loopback address + token of the delegation broker, set once its
    /// listener binds at startup.
    pub broker: std::sync::Mutex<Option<crate::delegation::BrokerInfo>>,
    /// Wakes the single native automation timer after schedules change.
    pub automation_notify: Notify,
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
        store.settle_unfinished_turns_after_restart()?;
        store.recover_dispatching_queued_messages()?;
        store.recover_orphaned_delegations()?;
        Ok(Self {
            store: Arc::new(store),
            data_directory,
            git: GitService::discover().ok(),
            provider_status_cache: Mutex::new(None),
            git_authorizations: Arc::new(std::sync::Mutex::new(
                AuthorizedRepositoryCache::default(),
            )),
            codex: Mutex::new(HashMap::new()),
            codex_catalog: Mutex::new(None),
            codex_usage_refresh: CodexUsageRefreshFlight::new(),
            acp: Mutex::new(HashMap::new()),
            acp_catalog: Mutex::new(HashMap::new()),
            structured: Mutex::new(HashMap::new()),
            turn_launches: Arc::new(std::sync::Mutex::new(HashSet::new())),
            native_action_handles: std::sync::Mutex::new(HashMap::new()),
            skill_credentials: std::sync::Mutex::new(NativeSecretCache::default()),
            terminals: std::sync::Mutex::new(HashMap::new()),
            runtime_terminals: std::sync::Mutex::new(HashMap::new()),
            repository_watchers: std::sync::Mutex::new(RepositoryWatchRegistry::default()),
            delegation_children: Mutex::new(HashMap::new()),
            broker: std::sync::Mutex::new(None),
            automation_notify: Notify::new(),
        })
    }

    /// Reserve one launch per chat while allowing unrelated chats to start and
    /// run concurrently.
    pub fn reserve_turn_launch(&self, task_id: TaskId) -> Option<TurnLaunchGuard> {
        reserve_turn_launch(&self.turn_launches, task_id)
    }

    pub fn turn_launch_in_progress(&self, task_id: TaskId) -> bool {
        self.turn_launches
            .lock()
            .expect("turn launch lock")
            .contains(&task_id)
    }

    pub async fn begin_codex_usage_refresh(&self) -> Option<CodexUsageRefreshGuard<'_>> {
        self.codex_usage_refresh.join_or_lead().await
    }

    pub fn cached_skill_credential(&self, id: &str) -> Result<Option<Zeroizing<String>>> {
        self.skill_credentials
            .lock()
            .map(|cache| cache.get(id))
            .map_err(|_| IntegratorError::Unavailable("credential cache is unavailable".into()))
    }

    pub fn cache_skill_credential(&self, id: &str, secret: Zeroizing<String>) -> Result<()> {
        self.skill_credentials
            .lock()
            .map(|mut cache| cache.insert(id, secret))
            .map_err(|_| IntegratorError::Unavailable("credential cache is unavailable".into()))
    }

    pub fn forget_skill_credential(&self, id: &str) -> Result<()> {
        self.skill_credentials
            .lock()
            .map(|mut cache| cache.remove(id))
            .map_err(|_| IntegratorError::Unavailable("credential cache is unavailable".into()))
    }

    /// Discover installed runtimes once per app process. Holding the async
    /// mutex through the worker call makes concurrent boot/catalog/task
    /// requests single-flight without blocking unrelated native state.
    pub async fn provider_statuses(&self, force: bool) -> Result<Vec<ProviderStatus>> {
        let mut cached = self.provider_status_cache.lock().await;
        if let Some(statuses) = reusable_provider_statuses(&cached, force) {
            return Ok(statuses);
        }
        if force {
            integrator_runtime::invalidate_runtime_search_path();
        }
        let statuses = tokio::task::spawn_blocking(discover_providers)
            .await
            .map_err(|_| IntegratorError::Unavailable("provider discovery worker failed".into()))?;
        *cached = Some(statuses.clone());
        Ok(statuses)
    }
}

#[cfg(test)]
mod task_runtime_registry_fixtures {
    use super::{
        CodexUsageRefreshFlight, NativeSecretCache, remove_task_runtime, replace_task_runtime,
        reserve_turn_launch, reusable_provider_statuses,
    };
    use integrator_core::TaskId;
    use std::{
        collections::HashMap,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };
    use zeroize::Zeroizing;

    #[test]
    fn native_secret_cache_reuses_and_forgets_values() {
        let mut cache = NativeSecretCache::default();
        cache.insert("census-api-key", Zeroizing::new("first".to_owned()));
        assert_eq!(
            cache
                .get("census-api-key")
                .as_ref()
                .map(|secret| secret.as_str()),
            Some("first")
        );

        cache.insert("census-api-key", Zeroizing::new("second".to_owned()));
        assert_eq!(
            cache
                .get("census-api-key")
                .as_ref()
                .map(|secret| secret.as_str()),
            Some("second")
        );

        cache.remove("census-api-key");
        assert!(cache.get("census-api-key").is_none());
    }

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

    #[test]
    fn turn_launch_reservations_are_task_scoped_and_release_on_drop() {
        let first = TaskId::new();
        let second = TaskId::new();
        let launches = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
        let first_guard = reserve_turn_launch(&launches, first).expect("first reservation");
        assert!(reserve_turn_launch(&launches, first).is_none());
        let _second_guard =
            reserve_turn_launch(&launches, second).expect("independent reservation");
        drop(first_guard);
        assert!(reserve_turn_launch(&launches, first).is_some());
    }

    #[test]
    fn provider_inventory_is_reused_until_refresh_is_explicit() {
        let cached = Some(Vec::new());
        assert_eq!(reusable_provider_statuses(&cached, false), Some(Vec::new()));
        assert_eq!(reusable_provider_statuses(&cached, true), None);
        assert_eq!(reusable_provider_statuses(&None, false), None);
    }

    #[tokio::test]
    async fn concurrent_codex_usage_refreshes_share_one_flight() {
        let flight = Arc::new(CodexUsageRefreshFlight::new());
        let barrier = Arc::new(tokio::sync::Barrier::new(20));
        let leaders = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..20 {
            let flight = Arc::clone(&flight);
            let barrier = Arc::clone(&barrier);
            let leaders = Arc::clone(&leaders);
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                if let Some(_guard) = flight.join_or_lead().await {
                    leaders.fetch_add(1, Ordering::Relaxed);
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
            }));
        }
        for task in tasks {
            task.await.expect("join usage refresh caller");
        }
        assert_eq!(leaders.load(Ordering::Relaxed), 1);

        let next = flight
            .join_or_lead()
            .await
            .expect("a completed flight must not become a freshness cache");
        drop(next);
    }
}
