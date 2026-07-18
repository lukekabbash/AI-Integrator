use std::{
    collections::HashMap,
    ffi::OsString,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use integrator_core::ProviderKind;
use integrator_runtime::discover_provider;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    commands::{CommandError, CommandResult},
    state::AppState,
};

const MAX_TERMINAL_INPUT_BYTES: usize = 16 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const OUTPUT_FRAME_INTERVAL: Duration = Duration::from_millis(16);
const OUTPUT_EVENT: &str = "runtime-terminal://output";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeActionKind {
    Install,
    Update,
    Login,
    Usage,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeActionPlan {
    id: String,
    provider: ProviderKind,
    kind: RuntimeActionKind,
    method: String,
    label: String,
    command: String,
    description: String,
    source_url: String,
    available: bool,
    unavailable_reason: Option<String>,
    recommended: bool,
    downloads_and_executes_code: bool,
    modifies_outside_projects: bool,
    environment_note: String,
}

#[derive(Clone, Debug)]
struct LaunchSpec {
    program: PathBuf,
    args: Vec<OsString>,
}

#[derive(Clone, Debug)]
struct ResolvedPlan {
    public: RuntimeActionPlan,
    launch: Option<LaunchSpec>,
}

pub struct RuntimeTerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTerminalInfo {
    id: String,
    provider: ProviderKind,
    kind: RuntimeActionKind,
    command: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeTerminalOutput {
    session_id: String,
    stream: &'static str,
    data: Option<String>,
    exit_code: Option<u32>,
}

#[tauri::command]
pub fn runtime_action_plan_list(
    provider: ProviderKind,
    kind: RuntimeActionKind,
) -> CommandResult<Vec<RuntimeActionPlan>> {
    Ok(resolve_plans(provider, kind)
        .into_iter()
        .map(|plan| plan.public)
        .collect())
}

#[tauri::command]
pub fn runtime_terminal_open(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    plan_id: String,
    cols: u16,
    rows: u16,
) -> CommandResult<RuntimeTerminalInfo> {
    let plan = resolve_plan(&plan_id)?;
    let launch = plan.launch.ok_or_else(|| CommandError {
        code: "runtime-action-unavailable",
        message: plan
            .public
            .unavailable_reason
            .clone()
            .unwrap_or_else(|| "this runtime action is unavailable on this computer".into()),
    })?;
    let size = checked_size(cols, rows)?;
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|error| terminal_error("could not open the setup terminal", error))?;
    let mut command = CommandBuilder::new(&launch.program);
    command.args(launch.args);
    command.cwd(runtime_home()?);
    apply_runtime_environment(&mut command);

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| terminal_error("could not start the disclosed runtime command", error))?;
    drop(pair.slave);
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            return Err(terminal_error("could not read the setup terminal", error));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            return Err(terminal_error(
                "could not write to the setup terminal",
                error,
            ));
        }
    };
    let killer = child.clone_killer();
    let id = uuid::Uuid::new_v4().to_string();
    state
        .runtime_terminals
        .lock()
        .expect("runtime terminal lock")
        .insert(
            id.clone(),
            RuntimeTerminalSession {
                master: pair.master,
                writer,
                killer,
            },
        );

    let session_id = id.clone();
    std::thread::spawn(move || {
        pump_output(&app, &session_id, reader);
        let exit_code = child.wait().ok().map(|status| status.exit_code());
        take_terminal_session(&app.state::<AppState>().runtime_terminals, &session_id);
        let _ = app.emit(
            OUTPUT_EVENT,
            RuntimeTerminalOutput {
                session_id,
                stream: "exit",
                data: None,
                exit_code,
            },
        );
    });

    Ok(RuntimeTerminalInfo {
        id,
        provider: plan.public.provider,
        kind: plan.public.kind,
        command: plan.public.command,
    })
}

#[tauri::command]
pub fn runtime_terminal_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> CommandResult<()> {
    if data.len() > MAX_TERMINAL_INPUT_BYTES {
        return Err(CommandError {
            code: "invalid-input",
            message: "setup terminal input is too large".into(),
        });
    }
    let mut sessions = state
        .runtime_terminals
        .lock()
        .expect("runtime terminal lock");
    let session = sessions.get_mut(&session_id).ok_or_else(unknown_terminal)?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|error| terminal_error("could not send input to the setup terminal", error))?;
    session
        .writer
        .flush()
        .map_err(|error| terminal_error("could not flush input to the setup terminal", error))
}

#[tauri::command]
pub fn runtime_terminal_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> CommandResult<()> {
    let size = checked_size(cols, rows)?;
    let sessions = state
        .runtime_terminals
        .lock()
        .expect("runtime terminal lock");
    let session = sessions.get(&session_id).ok_or_else(unknown_terminal)?;
    session
        .master
        .resize(size)
        .map_err(|error| terminal_error("could not resize the setup terminal", error))
}

#[tauri::command]
pub fn runtime_terminal_close(state: State<'_, AppState>, session_id: String) -> CommandResult<()> {
    let session = take_terminal_session(&state.runtime_terminals, &session_id);
    if let Some(mut session) = session {
        let _ = session.killer.kill();
    }
    Ok(())
}

fn take_terminal_session(
    sessions: &Mutex<HashMap<String, RuntimeTerminalSession>>,
    session_id: &str,
) -> Option<RuntimeTerminalSession> {
    sessions
        .lock()
        .expect("runtime terminal lock")
        .remove(session_id)
}

fn pump_output(app: &AppHandle<tauri::Wry>, session_id: &str, mut reader: Box<dyn Read + Send>) {
    let mut buffer = [0_u8; 8 * 1024];
    let mut emitted = 0usize;
    let mut truncated = false;
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        if emitted >= MAX_TERMINAL_OUTPUT_BYTES {
            if !truncated {
                truncated = true;
                let _ = emit_output(
                    app,
                    session_id,
                    "\r\n… setup terminal output truncated after 2 MB\r\n",
                );
            }
            continue;
        }
        let allowed = read.min(MAX_TERMINAL_OUTPUT_BYTES - emitted);
        emitted += allowed;
        let _ = emit_output(
            app,
            session_id,
            &String::from_utf8_lossy(&buffer[..allowed]),
        );
        // Full-screen TUIs can redraw in hundreds of tiny writes. Cap bridge
        // events to roughly one display frame so renderer input and Stop stay
        // responsive while the PTY applies natural backpressure.
        std::thread::sleep(OUTPUT_FRAME_INTERVAL);
    }
}

fn emit_output(app: &AppHandle<tauri::Wry>, session_id: &str, data: &str) -> tauri::Result<()> {
    app.emit(
        OUTPUT_EVENT,
        RuntimeTerminalOutput {
            session_id: session_id.into(),
            stream: "output",
            data: Some(data.into()),
            exit_code: None,
        },
    )
}

fn checked_size(cols: u16, rows: u16) -> CommandResult<PtySize> {
    if !(20..=500).contains(&cols) || !(5..=300).contains(&rows) {
        return Err(CommandError {
            code: "invalid-input",
            message: "setup terminal dimensions are out of range".into(),
        });
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn runtime_home() -> CommandResult<PathBuf> {
    directories::BaseDirs::new()
        .map(|directories| directories.home_dir().to_path_buf())
        .ok_or_else(|| CommandError {
            code: "runtime-action-unavailable",
            message: "the local user home directory is unavailable".into(),
        })
}

fn apply_runtime_environment(command: &mut CommandBuilder) {
    const KEYS: &[&str] = &[
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "SystemRoot",
        "ComSpec",
        "ProgramFiles",
        "ProgramFiles(x86)",
    ];
    command.env_clear();
    for key in KEYS {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "AI Integrator");
}

fn resolve_plan(plan_id: &str) -> CommandResult<ResolvedPlan> {
    let (provider, kind) = plan_route(plan_id).ok_or_else(|| CommandError {
        code: "invalid-input",
        message: "unknown or stale runtime action plan".into(),
    })?;
    resolve_plans(provider, kind)
        .into_iter()
        .find(|plan| plan.public.id == plan_id)
        .ok_or_else(|| CommandError {
            code: "invalid-input",
            message: "unknown or stale runtime action plan".into(),
        })
}

fn plan_route(plan_id: &str) -> Option<(ProviderKind, RuntimeActionKind)> {
    let mut parts = plan_id.split(':');
    let provider = match parts.next()? {
        "codex" => ProviderKind::Codex,
        "cursor" => ProviderKind::Cursor,
        "claude" => ProviderKind::Claude,
        "grok" => ProviderKind::Grok,
        "kimi" => ProviderKind::Kimi,
        "antigravity" => ProviderKind::Antigravity,
        _ => return None,
    };
    let kind = match parts.next()? {
        "install" => RuntimeActionKind::Install,
        "update" => RuntimeActionKind::Update,
        "login" => RuntimeActionKind::Login,
        "usage" => RuntimeActionKind::Usage,
        _ => return None,
    };
    parts.next()?;
    (parts.next().is_none()).then_some((provider, kind))
}

fn resolve_plans(provider: ProviderKind, kind: RuntimeActionKind) -> Vec<ResolvedPlan> {
    match kind {
        RuntimeActionKind::Install => install_plans(provider),
        RuntimeActionKind::Update | RuntimeActionKind::Login | RuntimeActionKind::Usage => {
            discover_provider(provider)
                .and_then(|status| status.executable)
                .map(|executable| vec![installed_action(provider, kind, executable)])
                .unwrap_or_default()
        }
    }
}

fn installed_action(
    provider: ProviderKind,
    kind: RuntimeActionKind,
    executable: PathBuf,
) -> ResolvedPlan {
    let args: Vec<OsString> = match (provider, kind) {
        (ProviderKind::Claude, RuntimeActionKind::Login) => {
            ["auth", "login"].into_iter().map(OsString::from).collect()
        }
        (ProviderKind::Antigravity, RuntimeActionKind::Login) => Vec::new(),
        (_, RuntimeActionKind::Login) => vec![OsString::from("login")],
        (ProviderKind::Kimi, RuntimeActionKind::Update) => vec![OsString::from("upgrade")],
        (_, RuntimeActionKind::Update) => vec![OsString::from("update")],
        (ProviderKind::Codex, RuntimeActionKind::Usage) => ["--no-alt-screen", "-s", "read-only"]
            .into_iter()
            .map(OsString::from)
            .collect(),
        (ProviderKind::Claude, RuntimeActionKind::Usage) => ["--safe-mode", "--ax-screen-reader"]
            .into_iter()
            .map(OsString::from)
            .collect(),
        (ProviderKind::Cursor, RuntimeActionKind::Usage) => {
            ["--mode", "ask"].into_iter().map(OsString::from).collect()
        }
        (ProviderKind::Grok, RuntimeActionKind::Usage) => vec![OsString::from("--no-alt-screen")],
        (_, RuntimeActionKind::Usage) => Vec::new(),
        _ => Vec::new(),
    };
    let action = match kind {
        RuntimeActionKind::Update => "update",
        RuntimeActionKind::Login => "sign in",
        RuntimeActionKind::Install => "install",
        RuntimeActionKind::Usage => "view usage",
    };
    let command = display_command(&executable, &args);
    ResolvedPlan {
        public: RuntimeActionPlan {
            id: format!("{}:{}:vendor-cli", provider.as_str(), action_id(kind)),
            provider,
            kind,
            method: "Vendor CLI".into(),
            label: if kind == RuntimeActionKind::Usage {
                format!("Open {} usage", title_case(provider.as_str()))
            } else if provider == ProviderKind::Antigravity && kind == RuntimeActionKind::Login {
                "Open Antigravity interactive setup".into()
            } else {
                format!("{} with the installed CLI", title_case(action))
            },
            command,
            description: match kind {
                RuntimeActionKind::Update => {
                    "Runs the update command implemented by this exact installed vendor CLI.".into()
                }
                RuntimeActionKind::Login => {
                    if provider == ProviderKind::Antigravity {
                        "Antigravity has no login subcommand. This opens its full-screen setup, which remains running after browser sign-in until you close it."
                            .into()
                    } else {
                        "Starts the vendor-owned browser or terminal authentication flow.".into()
                    }
                }
                RuntimeActionKind::Install => String::new(),
                RuntimeActionKind::Usage => match provider {
                    ProviderKind::Cursor =>
                        "Opens Cursor Agent. Run `/usage` for activity or `/context` for this session's context breakdown. Cursor does not expose plan headroom here."
                            .into(),
                    ProviderKind::Antigravity =>
                        "Opens Antigravity. Run `/usage` or `/quota` to view its provider-owned model limits."
                            .into(),
                    _ => "Opens the installed vendor CLI. Run `/usage` to view its provider-owned usage screen."
                        .into(),
                },
            },
            source_url: provider_source(provider).into(),
            available: true,
            unavailable_reason: None,
            recommended: true,
            downloads_and_executes_code: kind == RuntimeActionKind::Update,
            modifies_outside_projects: true,
            environment_note: safe_environment_note().into(),
        },
        launch: Some(LaunchSpec {
            program: executable,
            args,
        }),
    }
}

fn install_plans(provider: ProviderKind) -> Vec<ResolvedPlan> {
    let mut plans = Vec::new();
    if cfg!(windows) {
        if let Some((script, source)) = windows_installer(provider) {
            plans.push(shell_install_plan(
                provider,
                "Official installer",
                script,
                source,
                true,
            ));
        }
    } else if let Some((script, source)) = unix_installer(provider) {
        plans.push(shell_install_plan(
            provider,
            "Official installer",
            script,
            source,
            true,
        ));
    }

    if let Some(package) = npm_package(provider) {
        plans.push(direct_install_plan(
            provider,
            "npm",
            which::which("npm").ok(),
            vec!["install".into(), "-g".into(), package.into()],
            format!("npm install -g {package}"),
            provider_source(provider),
            plans.is_empty(),
        ));
    }
    if provider == ProviderKind::Codex && cfg!(target_os = "macos") {
        plans.push(direct_install_plan(
            provider,
            "Homebrew",
            which::which("brew").ok(),
            vec!["install".into(), "--cask".into(), "codex".into()],
            "brew install --cask codex".into(),
            provider_source(provider),
            plans.is_empty(),
        ));
    }
    if provider == ProviderKind::Kimi && cfg!(target_os = "macos") {
        plans.push(direct_install_plan(
            provider,
            "Homebrew",
            which::which("brew").ok(),
            vec!["install".into(), "kimi-code".into()],
            "brew install kimi-code".into(),
            provider_source(provider),
            plans.is_empty(),
        ));
    }
    plans
}

fn shell_install_plan(
    provider: ProviderKind,
    method: &str,
    script: &str,
    source: &str,
    recommended: bool,
) -> ResolvedPlan {
    #[cfg(windows)]
    let (program, args, available, reason) = {
        let program = which::which("powershell.exe").ok();
        (
            program
                .clone()
                .unwrap_or_else(|| PathBuf::from("powershell.exe")),
            vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-Command".into(),
                script.into(),
            ],
            program.is_some(),
            program.is_none().then(|| "PowerShell was not found".into()),
        )
    };
    #[cfg(not(windows))]
    let (program, args, available, reason) = {
        let shell = which::which("sh").ok();
        (
            shell.clone().unwrap_or_else(|| PathBuf::from("/bin/sh")),
            vec!["-lc".into(), script.into()],
            shell.is_some() || Path::new("/bin/sh").is_file(),
            (shell.is_none() && !Path::new("/bin/sh").is_file())
                .then(|| "A POSIX shell was not found".into()),
        )
    };
    ResolvedPlan {
        public: RuntimeActionPlan {
            id: format!("{}:install:{}", provider.as_str(), method_id(method)),
            provider,
            kind: RuntimeActionKind::Install,
            method: method.into(),
            label: format!("Install with {method}"),
            command: script.into(),
            description:
                "Downloads the provider's current installer and executes it in the setup terminal."
                    .into(),
            source_url: source.into(),
            available,
            unavailable_reason: reason,
            recommended,
            downloads_and_executes_code: true,
            modifies_outside_projects: true,
            environment_note: safe_environment_note().into(),
        },
        launch: available.then_some(LaunchSpec { program, args }),
    }
}

#[allow(clippy::too_many_arguments)]
fn direct_install_plan(
    provider: ProviderKind,
    method: &str,
    program: Option<PathBuf>,
    args: Vec<OsString>,
    command: String,
    source: &str,
    recommended: bool,
) -> ResolvedPlan {
    let available = program.is_some();
    ResolvedPlan {
        public: RuntimeActionPlan {
            id: format!("{}:install:{}", provider.as_str(), method_id(method)),
            provider,
            kind: RuntimeActionKind::Install,
            method: method.into(),
            label: format!("Install with {method}"),
            command,
            description: format!("Uses the {method} already installed on this computer."),
            source_url: source.into(),
            available,
            unavailable_reason: (!available).then(|| format!("{method} was not found")),
            recommended,
            downloads_and_executes_code: true,
            modifies_outside_projects: true,
            environment_note: safe_environment_note().into(),
        },
        launch: program.map(|program| LaunchSpec { program, args }),
    }
}

fn unix_installer(provider: ProviderKind) -> Option<(&'static str, &'static str)> {
    match provider {
        ProviderKind::Codex => Some((
            "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
            "https://developers.openai.com/codex/cli",
        )),
        ProviderKind::Cursor => Some((
            "curl https://cursor.com/install -fsS | bash",
            "https://docs.cursor.com/en/cli/installation",
        )),
        ProviderKind::Claude => Some((
            "curl -fsSL https://claude.ai/install.sh | bash",
            "https://docs.anthropic.com/en/docs/claude-code/getting-started",
        )),
        ProviderKind::Grok => Some((
            "curl -fsSL https://x.ai/cli/install.sh | bash",
            "https://docs.x.ai/build/overview",
        )),
        ProviderKind::Kimi => Some((
            "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
            "https://www.kimi.com/code/docs/en/",
        )),
        ProviderKind::Antigravity => Some((
            "curl -fsSL https://antigravity.google/cli/install.sh | bash",
            "https://antigravity.google/docs/cli-getting-started",
        )),
        ProviderKind::CustomAcp => None,
    }
}

fn windows_installer(provider: ProviderKind) -> Option<(&'static str, &'static str)> {
    match provider {
        ProviderKind::Grok => Some((
            "irm https://x.ai/cli/install.ps1 | iex",
            "https://docs.x.ai/build/overview",
        )),
        ProviderKind::Antigravity => Some((
            "irm https://antigravity.google/cli/install.ps1 | iex",
            "https://antigravity.google/docs/cli-getting-started",
        )),
        ProviderKind::Kimi => Some((
            "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
            "https://www.kimi.com/code/docs/en/",
        )),
        _ => None,
    }
}

fn npm_package(provider: ProviderKind) -> Option<&'static str> {
    match provider {
        ProviderKind::Codex => Some("@openai/codex@latest"),
        ProviderKind::Claude => Some("@anthropic-ai/claude-code@latest"),
        ProviderKind::Grok => Some("@xai-official/grok@latest"),
        ProviderKind::Kimi => Some("@moonshot-ai/kimi-code@latest"),
        _ => None,
    }
}

fn provider_source(provider: ProviderKind) -> &'static str {
    match provider {
        ProviderKind::Codex => "https://developers.openai.com/codex/cli",
        ProviderKind::Cursor => "https://docs.cursor.com/en/cli/installation",
        ProviderKind::Claude => "https://docs.anthropic.com/en/docs/claude-code/getting-started",
        ProviderKind::Grok => "https://docs.x.ai/build/cli/reference",
        ProviderKind::Kimi => "https://www.kimi.com/code/docs/en/",
        ProviderKind::Antigravity => "https://antigravity.google/docs/cli-getting-started",
        ProviderKind::CustomAcp => "",
    }
}

fn safe_environment_note() -> &'static str {
    "Runs locally with a reduced environment. Integrator does not inherit API-key variables or record terminal input/output."
}

fn display_command(program: &Path, args: &[OsString]) -> String {
    std::iter::once(program.as_os_str())
        .chain(args.iter().map(OsString::as_os_str))
        .map(|value| quote_display(&value.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_display(value: &str) -> String {
    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "-._/:@".contains(character))
    {
        value.into()
    } else {
        format!("\"{}\"", value.replace('"', "\\\""))
    }
}

fn action_id(kind: RuntimeActionKind) -> &'static str {
    match kind {
        RuntimeActionKind::Install => "install",
        RuntimeActionKind::Update => "update",
        RuntimeActionKind::Login => "login",
        RuntimeActionKind::Usage => "usage",
    }
}

fn method_id(method: &str) -> String {
    method.to_ascii_lowercase().replace(' ', "-")
}

fn title_case(value: &str) -> String {
    let mut characters = value.chars();
    characters
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + characters.as_str())
        .unwrap_or_default()
}

fn unknown_terminal() -> CommandError {
    CommandError {
        code: "not-found",
        message: "unknown runtime setup terminal".into(),
    }
}

fn terminal_error(context: &str, error: impl std::fmt::Display) -> CommandError {
    CommandError {
        code: "runtime-terminal-unavailable",
        message: format!("{context}: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_actions_never_accept_renderer_argv() {
        let plan = installed_action(
            ProviderKind::Codex,
            RuntimeActionKind::Update,
            PathBuf::from("/opt/codex"),
        );
        let launch = plan.launch.expect("launch spec");
        assert_eq!(launch.program, PathBuf::from("/opt/codex"));
        assert_eq!(launch.args, vec![OsString::from("update")]);
        assert_eq!(plan.public.command, "/opt/codex update");
    }

    #[test]
    fn provider_login_commands_are_explicit() {
        let claude = installed_action(
            ProviderKind::Claude,
            RuntimeActionKind::Login,
            PathBuf::from("claude"),
        );
        assert_eq!(claude.public.command, "claude auth login");
        let kimi = installed_action(
            ProviderKind::Kimi,
            RuntimeActionKind::Login,
            PathBuf::from("kimi"),
        );
        assert_eq!(kimi.public.command, "kimi login");
        let kimi_update = installed_action(
            ProviderKind::Kimi,
            RuntimeActionKind::Update,
            PathBuf::from("kimi"),
        );
        assert_eq!(kimi_update.public.command, "kimi upgrade");
        let antigravity = installed_action(
            ProviderKind::Antigravity,
            RuntimeActionKind::Login,
            PathBuf::from("agy"),
        );
        assert_eq!(antigravity.public.command, "agy");
        assert!(
            antigravity
                .public
                .description
                .contains("remains running after browser sign-in")
        );
    }

    #[test]
    fn usage_actions_open_provider_owned_interactive_screens() {
        let claude = installed_action(
            ProviderKind::Claude,
            RuntimeActionKind::Usage,
            PathBuf::from("claude"),
        );
        assert_eq!(
            claude.public.command,
            "claude --safe-mode --ax-screen-reader"
        );
        assert!(claude.public.description.contains("`/usage`"));
        assert_eq!(
            plan_route("grok:usage:vendor-cli"),
            Some((ProviderKind::Grok, RuntimeActionKind::Usage))
        );
    }

    #[test]
    fn every_supported_provider_has_a_disclosed_installer() {
        for provider in [
            ProviderKind::Codex,
            ProviderKind::Cursor,
            ProviderKind::Claude,
            ProviderKind::Grok,
            ProviderKind::Kimi,
            ProviderKind::Antigravity,
        ] {
            let plans = install_plans(provider);
            assert!(!plans.is_empty(), "missing installer for {provider:?}");
            assert!(plans.iter().all(|plan| !plan.public.command.is_empty()));
            assert!(plans.iter().all(|plan| !plan.public.source_url.is_empty()));
            assert!(
                plans
                    .iter()
                    .all(|plan| plan.public.modifies_outside_projects)
            );
        }
    }

    #[test]
    fn terminal_dimensions_are_bounded() {
        assert!(checked_size(80, 24).is_ok());
        assert!(checked_size(10, 24).is_err());
        assert!(checked_size(80, 400).is_err());
    }

    #[test]
    fn stale_plan_ids_are_rejected() {
        let error = resolve_plan("codex:update:message-from-provider").expect_err("rejected");
        assert_eq!(error.code, "invalid-input");
    }

    #[test]
    fn plan_routes_are_parsed_once_without_renderer_commands() {
        assert_eq!(
            plan_route("antigravity:login:vendor-cli"),
            Some((ProviderKind::Antigravity, RuntimeActionKind::Login))
        );
        assert_eq!(
            plan_route("kimi:update:vendor-cli"),
            Some((ProviderKind::Kimi, RuntimeActionKind::Update))
        );
        assert!(plan_route("antigravity:login:vendor-cli:extra").is_none());
        assert!(plan_route("custom-acp:login:vendor-cli").is_none());
    }

    #[test]
    fn cancellation_and_process_exit_removal_are_idempotent() {
        let sessions = Mutex::new(HashMap::new());
        assert!(take_terminal_session(&sessions, "already-finished").is_none());
        assert!(take_terminal_session(&sessions, "already-finished").is_none());
    }
}
