//! Child processes the app owns: start, watch, stop, and never orphan.
//!
//! The lifetime rule is the whole point. A dev server that outlives the app is
//! worse than no feature at all: the port stays held, the next launch fails
//! confusingly, and the user has to go find a process they never started by
//! hand. Everything else here is bookkeeping around that one guarantee, which
//! lives in `guard.rs` and is enforced by the OS rather than by a destructor.
//!
//! Nothing in this module knows about Tauri. It takes plain values, returns
//! plain values, and reports change through an observer the command layer
//! installs, so the whole lifecycle is testable without launching an app.
//!
//! Everything retained is bounded: the log ring per server, the number of
//! servers, how many finished rows are kept, and how often a change is
//! announced. A dev server that prints a stack trace per frame must cost the
//! app a fixed amount of memory, not a growing one.

mod detect;
mod guard;
mod log;

use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsString,
    fmt,
    io::{BufReader, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::command_api::{CommandError, CommandResult};
use log::LogBuffer;

pub use detect::candidates;
pub use log::{LogLine, Stream};

/// Servers that may run at once. A window full of them is already a mistake;
/// this only stops a loop in the caller from forking the machine to a halt.
const MAX_RUNNING: usize = 12;
/// Rows kept in total, including finished ones, so the exit code and the last
/// lines of a server that died stay readable without growing forever.
const MAX_RETAINED: usize = 24;
/// At most one output notice per server per interval. The reader threads pull
/// lines as fast as the child writes them; the UI does not need to hear about
/// each one, and a per-line event is how a chatty server becomes a stutter.
const EMIT_INTERVAL: Duration = Duration::from_millis(120);
/// How long a killed child is given to be reaped before we stop waiting. The
/// kill itself is not in question — this is only about collecting the status.
const REAP_TIMEOUT: Duration = Duration::from_millis(500);
const MAX_ARGS: usize = 64;
const MAX_ENV: usize = 64;
const MAX_LABEL_CHARS: usize = 120;

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ServerId(String);

impl ServerId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ServerId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSpec {
    pub label: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Extra environment for the child, on top of the app's own.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Declared port, when we know it. Absent means we learn it from the scan.
    pub port: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ServerState {
    Starting,
    Listening { port: u16 },
    Running,
    Exited { code: Option<i32> },
    Failed { message: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    pub id: ServerId,
    pub spec: ServerSpec,
    pub state: ServerState,
    pub started_at_ms: i64,
    /// The OS process id while the server is running, for diagnostics.
    pub pid: Option<u32>,
    /// Sequence the next log line will carry, so a reader knows where to
    /// resume without asking for the log first.
    pub next_seq: u64,
    /// Lines the ring has evicted. A reader that fell behind can say so
    /// instead of quietly showing a log with a hole in it.
    pub dropped_lines: u64,
}

/// What the command layer subscribes to. Deliberately thin: an event says
/// something changed and where to read it, never carries the payload, so a
/// flood of output cannot become a flood of large messages.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DevServerEvent {
    Output { id: ServerId, next_seq: u64 },
    State { id: ServerId, state: ServerState },
}

pub type Observer = Arc<dyn Fn(DevServerEvent) + Send + Sync>;

type SharedObserver = Arc<Mutex<Option<Observer>>>;

struct Managed {
    spec: ServerSpec,
    state: ServerState,
    started_at_ms: i64,
    child: Option<Child>,
    guard: Option<guard::ProcessGuard>,
    pid: Option<u32>,
    log: Arc<Mutex<LogBuffer>>,
    /// One auto-open per start: set once the tab URL has been handed out.
    auto_opened: bool,
}

#[derive(Default)]
pub struct DevServers {
    servers: Mutex<HashMap<ServerId, Managed>>,
    next_id: AtomicU64,
    observer: SharedObserver,
}

impl DevServers {
    /// Install the sink that turns lifecycle changes into app events. Set
    /// after construction because the registry outlives any one window.
    pub fn set_observer(&self, observer: Observer) {
        *lock(&self.observer) = Some(observer);
    }

    pub fn start(&self, spec: ServerSpec) -> CommandResult<ServerId> {
        let spec = validate(spec)?;
        let id = ServerId(format!(
            "srv-{}",
            self.next_id.fetch_add(1, Ordering::Relaxed)
        ));
        let mut managed = Managed {
            spec,
            state: ServerState::Starting,
            started_at_ms: now_ms(),
            child: None,
            guard: None,
            pid: None,
            log: Arc::new(Mutex::new(LogBuffer::default())),
            auto_opened: false,
        };
        {
            let mut servers = self.servers();
            prune(&mut servers);
            if servers
                .values()
                .filter(|managed| managed.child.is_some())
                .count()
                >= MAX_RUNNING
            {
                return Err(CommandError {
                    code: "unavailable",
                    message: format!("at most {MAX_RUNNING} dev servers can run at once"),
                });
            }
            spawn_into(&id, &mut managed, &self.observer)?;
            servers.insert(id.clone(), managed);
        }
        self.notify(DevServerEvent::State {
            id: id.clone(),
            state: ServerState::Starting,
        });
        Ok(id)
    }

    pub fn stop(&self, id: &ServerId) -> CommandResult<()> {
        let state = {
            let mut servers = self.servers();
            let managed = servers.get_mut(id).ok_or_else(|| unknown(id))?;
            terminate(managed);
            managed.state.clone()
        };
        self.notify(DevServerEvent::State {
            id: id.clone(),
            state,
        });
        Ok(())
    }

    /// Stop and start again under the same id, so the row the user is looking
    /// at survives and the log keeps its sequence numbers climbing.
    pub fn restart(&self, id: &ServerId) -> CommandResult<()> {
        let (outcome, state) = {
            let mut servers = self.servers();
            let managed = servers.get_mut(id).ok_or_else(|| unknown(id))?;
            terminate(managed);
            lock(&managed.log).push(Stream::System, "— restarting —");
            match spawn_into(id, managed, &self.observer) {
                Ok(()) => (Ok(()), managed.state.clone()),
                Err(error) => {
                    managed.state = ServerState::Failed {
                        message: error.message.clone(),
                    };
                    (Err(error), managed.state.clone())
                }
            }
        };
        self.notify(DevServerEvent::State {
            id: id.clone(),
            state,
        });
        outcome
    }

    pub fn list(&self) -> Vec<ServerView> {
        let (mut views, changes) = {
            let mut servers = self.servers();
            let mut changes = Vec::new();
            let mut views = Vec::new();
            for (id, managed) in servers.iter_mut() {
                if let Some(state) = reconcile(managed) {
                    changes.push(DevServerEvent::State {
                        id: id.clone(),
                        state,
                    });
                }
                let (next_seq, dropped_lines) = {
                    let buffer = lock(&managed.log);
                    (buffer.next_seq(), buffer.dropped())
                };
                views.push(ServerView {
                    id: id.clone(),
                    spec: managed.spec.clone(),
                    state: managed.state.clone(),
                    started_at_ms: managed.started_at_ms,
                    pid: managed.pid,
                    next_seq,
                    dropped_lines,
                });
            }
            (views, changes)
        };
        for change in changes {
            self.notify(change);
        }
        views.sort_by(|left, right| {
            left.started_at_ms
                .cmp(&right.started_at_ms)
                .then_with(|| left.id.cmp(&right.id))
        });
        views
    }

    /// Bounded tail. `since` is a sequence number, so the UI can resume.
    pub fn log(&self, id: &ServerId, since: u64) -> Vec<LogLine> {
        let servers = self.servers();
        servers
            .get(id)
            .map(|managed| lock(&managed.log).since(since))
            .unwrap_or_default()
    }

    /// Record that the port scan found this server listening, and hand back
    /// the URL to open — but only the first time per start. If the user closes
    /// that tab, reopening it is their call, not ours.
    pub fn mark_listening(&self, id: &ServerId, port: u16) -> Option<String> {
        let (url, state) = {
            let mut servers = self.servers();
            // Only a row that is still running can be listening; a stopped
            // one keeps its exit code rather than being quietly revived.
            let managed = servers
                .get_mut(id)
                .filter(|managed| managed.child.is_some())?;
            managed.state = ServerState::Listening { port };
            let url = (!managed.auto_opened).then(|| {
                managed.auto_opened = true;
                format!("http://localhost:{port}")
            });
            (url, managed.state.clone())
        };
        self.notify(DevServerEvent::State {
            id: id.clone(),
            state,
        });
        url
    }

    /// Kill everything now. Called from `Drop`, and safe to call twice.
    pub fn shutdown(&self) {
        let mut servers = self.servers();
        for managed in servers.values_mut() {
            terminate(managed);
        }
    }

    fn servers(&self) -> MutexGuard<'_, HashMap<ServerId, Managed>> {
        lock(&self.servers)
    }

    fn notify(&self, event: DevServerEvent) {
        notify(&self.observer, event);
    }
}

impl Drop for DevServers {
    fn drop(&mut self) {
        // The `ProcessGuard` in each row would do this on its own as it drops.
        // Doing it explicitly means the children are also waited on, so the
        // caller that dropped us is not left with zombies to collect — and it
        // states the intent where someone reading `Drop` will look for it.
        self.shutdown();
    }
}

fn validate(mut spec: ServerSpec) -> CommandResult<ServerSpec> {
    if spec.program.trim().is_empty() {
        return Err(invalid("a dev server needs a program to run"));
    }
    if spec.args.len() > MAX_ARGS {
        return Err(invalid("that command line has too many arguments"));
    }
    if spec.env.len() > MAX_ENV {
        return Err(invalid("that command line has too many environment entries"));
    }
    if !spec.cwd.is_dir() {
        return Err(invalid(&format!(
            "{} is not a folder this app can run in",
            spec.cwd.display()
        )));
    }
    spec.label = spec.label.chars().take(MAX_LABEL_CHARS).collect();
    if spec.label.trim().is_empty() {
        spec.label = spec.program.clone();
    }
    Ok(spec)
}

fn spawn_into(
    id: &ServerId,
    managed: &mut Managed,
    observer: &SharedObserver,
) -> Result<(), CommandError> {
    // `which` resolves PATHEXT on Windows, which is the difference between
    // finding `npm.cmd` and failing to find `npm` at all.
    let program = which::which(&managed.spec.program)
        .map(PathBuf::into_os_string)
        .unwrap_or_else(|_| OsString::from(&managed.spec.program));
    let mut command = Command::new(&program);
    command
        .args(&managed.spec.args)
        .current_dir(&managed.spec.cwd)
        // A shim that reads stdin waits forever on an inherited console, and
        // a dev server has nothing to read anyway.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Escape sequences in a log view are noise, not colour.
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0");
    for (key, value) in &managed.spec.env {
        command.env(key, value);
    }
    guard::ProcessGuard::prepare(&mut command);
    let mut child = command.spawn().map_err(|error| CommandError {
        code: "unavailable",
        message: format!("{} could not start: {error}", managed.spec.program),
    })?;
    let pid = child.id();
    let guard = match guard::ProcessGuard::adopt(&child) {
        Ok(guard) => guard,
        Err(reason) => {
            // A child we cannot promise to reap is the exact outcome this
            // module exists to prevent, so it does not get to keep running.
            let _ = child.kill();
            let _ = child.wait();
            return Err(CommandError {
                code: "unavailable",
                message: format!("{} was stopped again because it could not be held to the app's lifetime: {reason}", managed.spec.label),
            });
        }
    };
    {
        let mut buffer = lock(&managed.log);
        buffer.push(
            Stream::System,
            &format!(
                "$ {} {}",
                program.to_string_lossy(),
                managed.spec.args.join(" ")
            ),
        );
    }
    if let Some(stdout) = child.stdout.take() {
        pump(stdout, Stream::Stdout, id.clone(), &managed.log, observer);
    }
    if let Some(stderr) = child.stderr.take() {
        pump(stderr, Stream::Stderr, id.clone(), &managed.log, observer);
    }
    managed.child = Some(child);
    managed.guard = Some(guard);
    managed.pid = Some(pid);
    managed.state = ServerState::Starting;
    managed.started_at_ms = now_ms();
    managed.auto_opened = false;
    Ok(())
}

/// One reader thread per stream. It ends on its own when the pipe closes,
/// which is what killing the child does, so nothing has to join it.
fn pump<R: Read + Send + 'static>(
    source: R,
    stream: Stream,
    id: ServerId,
    buffer: &Arc<Mutex<LogBuffer>>,
    observer: &SharedObserver,
) {
    let buffer = Arc::clone(buffer);
    let observer = Arc::clone(observer);
    let _ = std::thread::Builder::new()
        .name("dev-server-log".into())
        .spawn(move || {
            let mut reader = BufReader::new(source);
            let mut raw = Vec::new();
            let mut last_emit: Option<Instant> = None;
            let mut next_seq = 0;
            while log::read_bounded_line(&mut reader, &mut raw, log::MAX_LINE_BYTES)
                .unwrap_or(false)
            {
                let text = String::from_utf8_lossy(&raw).into_owned();
                next_seq = lock(&buffer).push(stream, &text) + 1;
                if last_emit.is_none_or(|at| at.elapsed() >= EMIT_INTERVAL) {
                    notify(
                        &observer,
                        DevServerEvent::Output {
                            id: id.clone(),
                            next_seq,
                        },
                    );
                    last_emit = Some(Instant::now());
                }
            }
            // The rate limit must never be the reason the last lines of a
            // failed start are the ones nobody sees.
            notify(&observer, DevServerEvent::Output { id, next_seq });
        });
}

/// Bring the state up to date with what the OS knows, returning the new state
/// when it changed. Polling on read keeps the module free of a watcher thread
/// whose only job would be to wait on a process nobody is looking at.
fn reconcile(managed: &mut Managed) -> Option<ServerState> {
    let status = managed.child.as_mut()?.try_wait();
    match status {
        Ok(Some(status)) => {
            let code = status.code();
            managed.child = None;
            managed.guard = None;
            managed.state = ServerState::Exited { code };
            lock(&managed.log).push(Stream::System, &exit_note(code));
            Some(managed.state.clone())
        }
        Ok(None) => matches!(managed.state, ServerState::Starting).then(|| {
            managed.state = ServerState::Running;
            ServerState::Running
        }),
        Err(error) => {
            managed.child = None;
            managed.guard = None;
            managed.state = ServerState::Failed {
                message: error.to_string(),
            };
            Some(managed.state.clone())
        }
    }
}

fn terminate(managed: &mut Managed) {
    if let Some(mut guard) = managed.guard.take() {
        guard.kill();
    }
    let code = managed.child.as_mut().and_then(reap);
    let was_running = managed.child.take().is_some();
    if was_running {
        // A kill that did not land is the exact failure this module exists to
        // prevent, so it gets said out loud instead of assumed away. Only
        // worth asking when no status ever arrived: an exit code is already
        // proof the process is gone, and the check costs a process of its own.
        let note = match (code, managed.pid) {
            (None, Some(pid)) if guard::process_is_alive(pid) => {
                format!("— process {pid} did not stop —")
            }
            _ => exit_note(code),
        };
        lock(&managed.log).push(Stream::System, &note);
    }
    if !matches!(managed.state, ServerState::Exited { .. }) {
        managed.state = ServerState::Exited { code };
    }
}

/// Collect the status of a child we have already killed. Bounded: the kill is
/// the guarantee, and a status we never manage to read costs only a nicer log
/// line, so this never blocks shutdown for long.
fn reap(child: &mut Child) -> Option<i32> {
    let deadline = Instant::now() + REAP_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.code(),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => return None,
        }
    }
}

fn exit_note(code: Option<i32>) -> String {
    match code {
        Some(code) => format!("— exited with code {code} —"),
        None => "— exited —".into(),
    }
}

/// Drop the oldest finished rows once the table is over its ceiling. Running
/// servers are never pruned: the row is the only handle on the process.
fn prune(servers: &mut HashMap<ServerId, Managed>) {
    if servers.len() < MAX_RETAINED {
        return;
    }
    let mut finished: Vec<(ServerId, i64)> = servers
        .iter()
        .filter(|(_, managed)| managed.child.is_none())
        .map(|(id, managed)| (id.clone(), managed.started_at_ms))
        .collect();
    finished.sort_by_key(|(_, started_at_ms)| *started_at_ms);
    let excess = servers.len() + 1 - MAX_RETAINED;
    for (id, _) in finished.into_iter().take(excess) {
        servers.remove(&id);
    }
}

fn notify(observer: &SharedObserver, event: DevServerEvent) {
    // Cloned out from under the lock: an observer that calls back into the
    // registry is a reasonable thing to write and must not deadlock.
    let listener = lock(observer).clone();
    if let Some(listener) = listener {
        listener(event);
    }
}

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|error| error.into_inner())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| i64::try_from(since.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn invalid(message: &str) -> CommandError {
    CommandError {
        code: "invalid-input",
        message: message.into(),
    }
}

fn unknown(id: &ServerId) -> CommandError {
    CommandError {
        code: "not-found",
        message: format!("no dev server called {id}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Write};

    /// Turns this test binary into a stand-in dev server. Using our own
    /// executable rather than `node` keeps the tests honest on a machine with
    /// no toolchain installed, and gives us a child that behaves like one:
    /// prints a line, then stays up until something kills it.
    const SLEEPER_FLAG: &str = "DEV_SERVER_TEST_SLEEPER";
    const SLEEPER_TEST: &str = "dev_server::tests::stand_in_dev_server";
    /// Turns this test binary into an app that starts a server and then dies
    /// without unwinding.
    const ORPHAN_FLAG: &str = "DEV_SERVER_TEST_ORPHAN_OWNER";
    const ORPHAN_TEST: &str = "dev_server::tests::orphan_owner";
    const READY_LINE: &str = "stand-in-ready";
    const PATIENCE: Duration = Duration::from_secs(10);

    #[test]
    #[ignore = "spawned as a child by the lifecycle tests"]
    fn stand_in_dev_server() {
        if std::env::var(SLEEPER_FLAG).is_err() {
            return;
        }
        println!("{READY_LINE}");
        let _ = std::io::stdout().flush();
        std::thread::sleep(Duration::from_secs(120));
    }

    #[test]
    #[ignore = "spawned as a child by the orphan test"]
    fn orphan_owner() {
        if std::env::var(ORPHAN_FLAG).is_err() {
            return;
        }
        let servers = DevServers::default();
        let id = servers.start(stand_in_spec()).expect("the stand-in starts");
        let pid = pid_of(&servers, &id);
        println!("child-pid={pid}");
        let _ = std::io::stdout().flush();
        // Wait for the parent to confirm it has seen the child alive, so the
        // test proves a running process was killed rather than racing a
        // process that had not finished starting.
        let mut go = String::new();
        let _ = std::io::stdin().read_line(&mut go);
        // Leaked on purpose and then left behind by `exit`, which runs no
        // destructors: after this line nothing in this process can be what
        // kills the child. Only the OS closing our job handle can.
        std::mem::forget(servers);
        std::process::exit(9);
    }

    fn stand_in_spec() -> ServerSpec {
        ServerSpec {
            label: "stand-in".into(),
            program: current_exe(),
            args: test_child_args(SLEEPER_TEST),
            cwd: std::env::temp_dir(),
            env: BTreeMap::from([(SLEEPER_FLAG.into(), "1".into())]),
            port: None,
        }
    }

    fn current_exe() -> String {
        std::env::current_exe()
            .expect("the test binary has a path")
            .to_string_lossy()
            .into_owned()
    }

    fn test_child_args(name: &str) -> Vec<String> {
        ["--exact", name, "--ignored", "--nocapture", "--test-threads=1"]
            .iter()
            .map(|argument| (*argument).to_string())
            .collect()
    }

    fn pid_of(servers: &DevServers, id: &ServerId) -> u32 {
        servers
            .list()
            .into_iter()
            .find(|view| &view.id == id)
            .and_then(|view| view.pid)
            .expect("a started server has a process id")
    }

    fn state_of(servers: &DevServers, id: &ServerId) -> ServerState {
        servers
            .list()
            .into_iter()
            .find(|view| &view.id == id)
            .map(|view| view.state)
            .expect("the server is still listed")
    }

    fn wait_until(mut condition: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + PATIENCE;
        while Instant::now() < deadline {
            if condition() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        condition()
    }

    fn wait_for_ready(servers: &DevServers, id: &ServerId) {
        assert!(
            wait_until(|| servers
                .log(id, 0)
                .iter()
                .any(|line| line.text.contains(READY_LINE))),
            "the child's own output never reached the log: {:?}",
            servers.log(id, 0)
        );
    }

    /// THE test this module exists for: the registry goes away without anyone
    /// calling `stop`, and the OS no longer has the process. Not "a function
    /// was called" — the process id is gone.
    #[test]
    fn dropping_the_registry_kills_a_child_it_was_never_told_to_stop() {
        let servers = DevServers::default();
        let id = servers.start(stand_in_spec()).expect("the stand-in starts");
        let pid = pid_of(&servers, &id);
        wait_for_ready(&servers, &id);
        assert!(
            guard::process_is_alive(pid),
            "the child should be running before the registry is dropped"
        );

        drop(servers);

        assert!(
            wait_until(|| !guard::process_is_alive(pid)),
            "process {pid} outlived the registry that owned it"
        );
    }

    /// The stronger claim, and the reason `guard.rs` exists: even when the
    /// owner dies without running a single destructor — the force-kill case —
    /// the OS still takes the child down with it.
    #[test]
    fn a_killed_owner_still_takes_its_child_down() {
        if !guard::KILLS_ON_OWNER_DEATH {
            // Unix has no kernel-side equivalent to the job object; there the
            // guarantee is the drop test above and nothing more is claimed.
            return;
        }
        let mut owner = Command::new(current_exe())
            .args(test_child_args(ORPHAN_TEST))
            .env(ORPHAN_FLAG, "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("the owner process starts");
        let stdout = owner.stdout.take().expect("the owner's output is piped");
        let mut transcript = Vec::new();
        let mut pid = None;
        // The harness writes `test NAME ... ` without a newline under
        // `--nocapture`, so the marker lands part way along a line rather than
        // at the start of one. Bounded, because a reader waiting on a line
        // that never comes is a hung test suite, not a failing one.
        for line in BufReader::new(stdout).lines().map_while(Result::ok).take(64) {
            if let Some((_, value)) = line.split_once("child-pid=") {
                pid = value.trim().parse::<u32>().ok();
            }
            transcript.push(line);
            if pid.is_some() {
                break;
            }
        }
        let Some(pid) = pid else {
            // Let the owner go before failing, or it waits on a `go` that
            // never arrives and takes the run down with it.
            drop(owner.stdin.take());
            let _ = owner.wait();
            panic!("the owner never reported a child process id:\n{transcript:#?}");
        };
        assert!(
            guard::process_is_alive(pid),
            "the owner's child should be running before the owner dies"
        );

        // Release the owner, which now leaves without unwinding.
        if let Some(mut stdin) = owner.stdin.take() {
            let _ = stdin.write_all(b"go\n");
        }
        let status = owner.wait().expect("the owner exits");
        assert_eq!(
            status.code(),
            Some(9),
            "the owner must have left through `exit`, running no destructors"
        );

        assert!(
            wait_until(|| !guard::process_is_alive(pid)),
            "process {pid} survived the death of the app that started it"
        );
    }

    #[test]
    fn a_server_runs_until_it_is_stopped() {
        let servers = DevServers::default();
        let id = servers.start(stand_in_spec()).expect("the stand-in starts");
        let pid = pid_of(&servers, &id);
        assert_eq!(state_of(&servers, &id), ServerState::Running);
        wait_for_ready(&servers, &id);
        // A caught-up reader is told nothing new, and picks up exactly where
        // it stopped once there is more.
        let cursor = servers.log(&id, 0).last().map_or(0, |line| line.seq + 1);
        assert!(servers.log(&id, cursor).is_empty());

        servers.stop(&id).expect("stopping a running server");

        assert_eq!(
            servers.log(&id, cursor).first().map(|line| line.seq),
            Some(cursor),
            "resuming from a cursor neither repeats nor skips a line"
        );

        assert!(
            matches!(state_of(&servers, &id), ServerState::Exited { .. }),
            "a stopped server reads as exited, not as running"
        );
        assert!(
            wait_until(|| !guard::process_is_alive(pid)),
            "process {pid} is still alive after stop"
        );
        let log = servers.log(&id, 0);
        assert!(
            log.first().is_some_and(|line| line.stream == Stream::System),
            "the log opens with the command line we ran"
        );
        assert!(
            log.iter()
                .any(|line| line.stream == Stream::System && line.text.contains("exited")),
            "the log records the exit: {log:?}"
        );
        servers.stop(&id).expect("stopping twice is not an error");
    }

    #[test]
    fn a_restart_keeps_the_row_and_keeps_the_sequence_climbing() {
        let servers = DevServers::default();
        let id = servers.start(stand_in_spec()).expect("the stand-in starts");
        let first_pid = pid_of(&servers, &id);
        wait_for_ready(&servers, &id);
        let before = servers.log(&id, 0).len();

        servers.restart(&id).expect("restarting a running server");

        let second_pid = pid_of(&servers, &id);
        assert_ne!(first_pid, second_pid, "restart starts a new process");
        assert!(
            wait_until(|| !guard::process_is_alive(first_pid)),
            "the old process {first_pid} was left running by the restart"
        );
        let after = servers.log(&id, 0);
        assert!(
            after.len() > before,
            "the restart is recorded in the same log"
        );
        assert!(
            after.windows(2).all(|pair| pair[1].seq > pair[0].seq),
            "sequence numbers never restart"
        );
        assert_eq!(servers.list().len(), 1, "a restart is not a second row");
        servers.stop(&id).expect("cleaning up");
    }

    #[test]
    fn the_auto_open_url_is_handed_out_once_per_start() {
        let servers = DevServers::default();
        let id = servers.start(stand_in_spec()).expect("the stand-in starts");

        assert_eq!(
            servers.mark_listening(&id, 4180),
            Some("http://localhost:4180".into())
        );
        assert_eq!(
            servers.mark_listening(&id, 4180),
            None,
            "a tab the user closed does not get reopened behind them"
        );
        assert_eq!(state_of(&servers, &id), ServerState::Listening { port: 4180 });

        servers.restart(&id).expect("restarting");
        assert_eq!(
            servers.mark_listening(&id, 4180),
            Some("http://localhost:4180".into()),
            "a fresh start earns a fresh tab"
        );
        servers.stop(&id).expect("cleaning up");
        assert_eq!(
            servers.mark_listening(&id, 4180),
            None,
            "a stopped server is not listening"
        );
    }

    #[test]
    fn a_spec_that_cannot_be_run_is_refused_before_anything_is_spawned() {
        let servers = DevServers::default();
        let refusal = |spec| servers.start(spec).err().map(|error| error.code);
        assert_eq!(
            refusal(ServerSpec {
                program: "  ".into(),
                ..stand_in_spec()
            }),
            Some("invalid-input")
        );
        assert_eq!(
            refusal(ServerSpec {
                cwd: std::env::temp_dir().join("dev-server-tests-no-such-folder"),
                ..stand_in_spec()
            }),
            Some("invalid-input")
        );
        assert_eq!(
            refusal(ServerSpec {
                program: "definitely-not-an-installed-program-9f2a".into(),
                args: Vec::new(),
                ..stand_in_spec()
            }),
            Some("unavailable")
        );
        assert!(
            servers.list().is_empty(),
            "nothing that failed to start is listed"
        );
    }

    #[test]
    fn an_unknown_id_is_a_not_found_rather_than_a_panic() {
        let servers = DevServers::default();
        let ghost = ServerId::new("srv-does-not-exist");
        assert_eq!(
            servers.stop(&ghost).err().map(|error| error.code),
            Some("not-found")
        );
        assert_eq!(
            servers.restart(&ghost).err().map(|error| error.code),
            Some("not-found")
        );
        assert!(servers.log(&ghost, 0).is_empty());
        assert_eq!(servers.mark_listening(&ghost, 1234), None);
    }

    #[test]
    fn finished_rows_are_pruned_so_the_table_stays_bounded() {
        let mut servers: HashMap<ServerId, Managed> = HashMap::new();
        for index in 0..MAX_RETAINED + 6 {
            servers.insert(
                ServerId::new(format!("srv-{index}")),
                Managed {
                    spec: stand_in_spec(),
                    state: ServerState::Exited { code: Some(0) },
                    started_at_ms: index as i64,
                    child: None,
                    guard: None,
                    pid: None,
                    log: Arc::new(Mutex::new(LogBuffer::default())),
                    auto_opened: false,
                },
            );
        }
        prune(&mut servers);
        assert_eq!(servers.len(), MAX_RETAINED - 1, "room is left for the new row");
        assert!(
            servers.contains_key(&ServerId::new(format!("srv-{}", MAX_RETAINED + 5))),
            "the newest rows are the ones kept"
        );
        assert!(
            !servers.contains_key(&ServerId::new("srv-0")),
            "the oldest finished row is the one dropped"
        );
    }
}
