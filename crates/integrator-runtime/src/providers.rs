use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

#[cfg(any(target_os = "macos", test))]
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::sync::OnceLock;

#[cfg(any(target_os = "macos", test))]
#[derive(Default)]
struct LoginPathCache(Mutex<Option<Option<OsString>>>);

#[cfg(any(target_os = "macos", test))]
impl LoginPathCache {
    fn resolve(&self, load: impl FnOnce() -> Option<OsString>) -> Option<OsString> {
        let mut cached = self.0.lock().ok()?;
        if let Some(path) = cached.as_ref() {
            return path.clone();
        }
        let path = load();
        *cached = Some(path.clone());
        path
    }

    fn invalidate(&self) {
        if let Ok(mut cached) = self.0.lock() {
            *cached = None;
        }
    }
}

#[cfg(target_os = "macos")]
static MACOS_LOGIN_PATH: OnceLock<LoginPathCache> = OnceLock::new();

use integrator_core::{
    AuthenticationState, ProviderCapabilities, ProviderCertification, ProviderKind, ProviderStatus,
    ProviderTransport,
};

use crate::safe_process::{redact_text, run_bounded_with_limits_and_path, run_bounded_with_path};

#[derive(Clone, Debug)]
struct ProbeDefinition {
    provider: ProviderKind,
    executables: &'static [&'static str],
    version_args: &'static [&'static str],
    transport: ProviderTransport,
}

pub fn discover_providers() -> Vec<ProviderStatus> {
    // Each probe boots the vendor's CLI (often a ~1s Node startup) up to
    // three times; serially this took >10s of wall clock and gated the first
    // turn after app launch. The probes are independent per provider, so run
    // them concurrently while keeping the reported order stable.
    let search_path = runtime_search_path();
    std::thread::scope(|scope| {
        let handles: Vec<_> = definitions()
            .into_iter()
            .map(|definition| {
                let search_path = search_path.as_deref();
                scope.spawn(move || discover_one(definition, search_path))
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().expect("provider probe thread"))
            .collect()
    })
}

pub fn discover_provider(provider: ProviderKind) -> Option<ProviderStatus> {
    let search_path = runtime_search_path();
    definitions()
        .into_iter()
        .find(|definition| definition.provider == provider)
        .map(|definition| discover_one(definition, search_path.as_deref()))
}

fn definitions() -> [ProbeDefinition; 6] {
    [
        ProbeDefinition {
            provider: ProviderKind::Codex,
            executables: &["codex"],
            version_args: &["--version"],
            transport: ProviderTransport::JsonlStdio,
        },
        ProbeDefinition {
            provider: ProviderKind::Claude,
            executables: &["claude"],
            version_args: &["--version"],
            transport: ProviderTransport::JsonlStdio,
        },
        ProbeDefinition {
            provider: ProviderKind::Antigravity,
            executables: &["agy"],
            version_args: &["--version"],
            transport: ProviderTransport::JsonlStdio,
        },
        ProbeDefinition {
            provider: ProviderKind::Cursor,
            // Prefer Cursor's provider-specific alias. Other vendors also
            // install a generic `agent` binary, so resolving that first can
            // launch the wrong ACP implementation under Cursor's route.
            executables: &["cursor-agent", "agent"],
            version_args: &["--version"],
            transport: ProviderTransport::AcpStdio,
        },
        ProbeDefinition {
            provider: ProviderKind::Grok,
            executables: &["grok"],
            version_args: &["version"],
            transport: ProviderTransport::AcpStdio,
        },
        ProbeDefinition {
            provider: ProviderKind::Kimi,
            executables: &["kimi"],
            version_args: &["--version"],
            transport: ProviderTransport::AcpStdio,
        },
    ]
}

fn discover_one(definition: ProbeDefinition, search_path: Option<&OsStr>) -> ProviderStatus {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let path_executable = definition.executables.iter().find_map(|candidate| {
        let executable = which::which_in(candidate, search_path, &cwd)
            .ok()
            .map(prefer_windows_launcher)?;
        if definition.provider == ProviderKind::Cursor
            && *candidate == "agent"
            && !verified_cursor_agent_alias(&executable, search_path)
        {
            return None;
        }
        Some(executable)
    });
    let known_executable = find_known_install(&definition.provider);
    let executable =
        select_provider_executable(&definition.provider, path_executable, known_executable);
    let Some(executable) = executable else {
        return ProviderStatus {
            provider: definition.provider,
            installed: false,
            executable: None,
            version: None,
            authentication: AuthenticationState::Unavailable,
            transport: None,
            diagnostic_code: Some("not-installed".into()),
            capabilities: ProviderCapabilities::default(),
            certification: ProviderCertification::Uncertified,
        };
    };

    let (version, probe_code) =
        match run_bounded_with_path(&executable, definition.version_args, None, search_path) {
            Ok(output) if output.success => (
                first_safe_line(&output.stdout).or_else(|| first_safe_line(&output.stderr)),
                None,
            ),
            Ok(_) => (None, Some("version-probe-failed".into())),
            Err(_) => (None, Some("version-probe-unavailable".into())),
        };
    let compatibility_code = runtime_compatibility_code(&definition.provider, version.as_deref());
    // The capability and authentication probes each boot the CLI again and
    // only depend on the version result above, not on each other — run them
    // concurrently to halve this provider's probe chain.
    let version_compatible = compatibility_code.is_none();
    let ((capabilities, certification, capability_code), (authentication, auth_code)) =
        std::thread::scope(|scope| {
            let capability_probe = scope.spawn(|| {
                probe_capabilities(
                    &definition.provider,
                    &executable,
                    version_compatible,
                    search_path,
                )
            });
            let auth_probe = scope
                .spawn(|| authentication_status(&definition.provider, &executable, search_path));
            (
                capability_probe.join().expect("capability probe thread"),
                auth_probe.join().expect("authentication probe thread"),
            )
        });

    ProviderStatus {
        provider: definition.provider,
        installed: true,
        executable: Some(executable),
        version,
        authentication,
        transport: Some(definition.transport),
        diagnostic_code: auth_code
            .or(compatibility_code)
            .or(capability_code)
            .or(probe_code),
        capabilities,
        certification,
    }
}

fn select_provider_executable(
    provider: &ProviderKind,
    path_executable: Option<PathBuf>,
    known_executable: Option<PathBuf>,
) -> Option<PathBuf> {
    // Grok's npm shim is suitable for bounded probes but can detach the real
    // agent and close the duplex stdio pipe. The official installer provides
    // a direct binary under ~/.grok/bin; prefer it whenever both exist.
    if *provider == ProviderKind::Grok {
        known_executable.or(path_executable)
    } else {
        path_executable.or(known_executable)
    }
}

fn probe_capabilities(
    provider: &ProviderKind,
    executable: &Path,
    version_compatible: bool,
    search_path: Option<&OsStr>,
) -> (ProviderCapabilities, ProviderCertification, Option<String>) {
    let help = run_bounded_with_path(executable, &["--help"], None, search_path)
        .ok()
        .filter(|output| output.success)
        .map(|output| format!("{}\n{}", output.stdout, output.stderr));
    let Some(help) = help else {
        return (
            ProviderCapabilities::default(),
            ProviderCertification::Uncertified,
            Some("capability-probe-failed".into()),
        );
    };
    classify_help_capabilities(provider, &help, version_compatible)
}

fn classify_help_capabilities(
    provider: &ProviderKind,
    help: &str,
    version_compatible: bool,
) -> (ProviderCapabilities, ProviderCertification, Option<String>) {
    let has = |marker: &str| help.contains(marker);
    let capabilities = match provider {
        ProviderKind::Codex => ProviderCapabilities {
            session_resume: has("resume"),
            authoritative_history: has("app-server"),
            structured_tool_events: has("app-server"),
            hooks: false,
            sandboxed_workspace: has("--sandbox"),
            subscription_auth: true,
            skills: has("plugin"),
        },
        ProviderKind::Claude => ProviderCapabilities {
            session_resume: has("--resume"),
            authoritative_history: false,
            structured_tool_events: has("--output-format") && has("--input-format"),
            hooks: has("--include-hook-events"),
            sandboxed_workspace: has("--permission-mode"),
            subscription_auth: true,
            skills: has("--disable-slash-commands"),
        },
        ProviderKind::Antigravity => ProviderCapabilities {
            session_resume: has("--conversation"),
            authoritative_history: false,
            structured_tool_events: has("--print"),
            hooks: true,
            sandboxed_workspace: has("--sandbox") && has("--new-project") && has("--add-dir"),
            subscription_auth: true,
            skills: has("plugin"),
        },
        ProviderKind::Cursor => ProviderCapabilities {
            session_resume: has("--resume"),
            authoritative_history: false,
            structured_tool_events: has("--output-format"),
            hooks: false,
            sandboxed_workspace: has("--sandbox") && has("--workspace"),
            subscription_auth: true,
            skills: has("--plugin-dir"),
        },
        ProviderKind::Grok => ProviderCapabilities {
            session_resume: false,
            authoritative_history: false,
            structured_tool_events: has("agent"),
            hooks: false,
            sandboxed_workspace: false,
            subscription_auth: true,
            skills: true,
        },
        ProviderKind::Kimi => ProviderCapabilities {
            session_resume: has("--session") || has("--resume"),
            authoritative_history: false,
            structured_tool_events: has("acp"),
            hooks: false,
            sandboxed_workspace: false,
            subscription_auth: has("login"),
            skills: has("skills") || has("plugin"),
        },
        ProviderKind::CustomAcp => ProviderCapabilities::default(),
    };
    let all_required = match provider {
        ProviderKind::Codex => {
            version_compatible
                && capabilities.session_resume
                && capabilities.authoritative_history
                && capabilities.structured_tool_events
                && capabilities.sandboxed_workspace
                && capabilities.subscription_auth
                && capabilities.skills
        }
        ProviderKind::Claude => {
            capabilities.session_resume
                && capabilities.structured_tool_events
                && capabilities.hooks
                && capabilities.sandboxed_workspace
                && capabilities.subscription_auth
                && capabilities.skills
        }
        ProviderKind::Antigravity => {
            capabilities.session_resume
                && capabilities.structured_tool_events
                && capabilities.sandboxed_workspace
                && capabilities.hooks
                && capabilities.subscription_auth
                && capabilities.skills
        }
        ProviderKind::Cursor => {
            capabilities.session_resume
                && capabilities.structured_tool_events
                && capabilities.sandboxed_workspace
                && capabilities.subscription_auth
                && capabilities.skills
        }
        ProviderKind::Grok => capabilities.structured_tool_events && capabilities.subscription_auth,
        ProviderKind::Kimi => capabilities.structured_tool_events && capabilities.subscription_auth,
        ProviderKind::CustomAcp => false,
    };
    let certification = if !all_required {
        ProviderCertification::Uncertified
    } else if matches!(
        provider,
        ProviderKind::Cursor | ProviderKind::Grok | ProviderKind::Kimi
    ) {
        ProviderCertification::SessionProbeRequired
    } else {
        ProviderCertification::Certified
    };
    let diagnostic = (!all_required).then(|| "capability-mismatch".into());
    (capabilities, certification, diagnostic)
}

/// Fallback for processes launched with a stale `PATH` (e.g. a dev shell or
/// IDE opened before the CLI's installer added its PATH entry): probe the
/// provider's documented default install locations directly.
#[must_use]
pub fn runtime_search_path() -> Option<OsString> {
    #[cfg(target_os = "macos")]
    let login_path = macos_login_shell_path();
    #[cfg(not(target_os = "macos"))]
    let login_path: Option<OsString> = None;
    let inherited = std::env::var_os("PATH");
    let home = home_dir();
    let mut paths = runtime_search_paths(
        login_path.as_deref(),
        inherited.as_deref(),
        home.as_deref(),
        cfg!(target_os = "macos"),
    );
    #[cfg(windows)]
    {
        if let Some(app_data) = std::env::var_os("APPDATA") {
            paths.push(PathBuf::from(app_data).join("npm"));
        }
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let local_app_data = PathBuf::from(local_app_data);
            paths.extend([
                local_app_data.join("cursor-agent"),
                local_app_data.join("agy").join("bin"),
                local_app_data.join("Programs").join("nodejs"),
            ]);
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            paths.push(PathBuf::from(program_files).join("nodejs"));
        }
    }

    join_unique_paths(paths)
}

fn runtime_search_paths(
    login_path: Option<&OsStr>,
    inherited_path: Option<&OsStr>,
    home: Option<&Path>,
    include_macos_defaults: bool,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(login_path) = login_path {
        paths.extend(std::env::split_paths(login_path));
    }
    if let Some(inherited_path) = inherited_path {
        paths.extend(std::env::split_paths(inherited_path));
    }

    // Finder/Dock launches do not receive interactive shell PATH edits. These
    // are documented vendor/package-manager roots and harmless when absent.
    if let Some(home) = home {
        paths.extend([
            home.join(".local").join("bin"),
            home.join(".cursor").join("bin"),
            home.join(".grok").join("bin"),
            home.join(".kimi-code").join("bin"),
            home.join(".claude").join("local"),
            home.join(".cargo").join("bin"),
            home.join(".bun").join("bin"),
            home.join(".npm-global").join("bin"),
        ]);
    }
    if include_macos_defaults {
        paths.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/usr/sbin"),
            PathBuf::from("/sbin"),
        ]);
    }
    paths
}

/// Force-refresh uses this before rediscovery so a profile edit made while the
/// app is open is visible without restarting the desktop process.
pub fn invalidate_runtime_search_path() {
    #[cfg(target_os = "macos")]
    if let Some(cache) = MACOS_LOGIN_PATH.get() {
        cache.invalidate();
    }
}

fn join_unique_paths(paths: impl IntoIterator<Item = PathBuf>) -> Option<OsString> {
    let mut seen = HashSet::new();
    let unique = paths
        .into_iter()
        .filter(|path| !path.as_os_str().is_empty())
        .filter(|path| seen.insert(path.clone()))
        .collect::<Vec<_>>();
    if unique.is_empty() {
        None
    } else {
        std::env::join_paths(unique).ok()
    }
}

#[cfg(target_os = "macos")]
fn macos_login_shell_path() -> Option<OsString> {
    MACOS_LOGIN_PATH
        .get_or_init(LoginPathCache::default)
        .resolve(read_macos_login_shell_path)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn read_macos_login_shell_path() -> Option<OsString> {
    let configured = std::env::var_os("SHELL").map(PathBuf::from);
    let shell = configured
        .filter(|path| path.is_absolute() && path.is_file())
        .unwrap_or_else(|| PathBuf::from("/bin/zsh"));
    if !shell.is_file() {
        return None;
    }
    read_login_shell_path_from(&shell)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn read_login_shell_path_from(shell: &Path) -> Option<OsString> {
    // `-i` reads ~/.zshrc or ~/.bashrc; `-l` also reads the login profile.
    // A leading newline keeps prompt/plugin chatter without a trailing newline
    // from swallowing the marker. Output remains bounded and marker-scoped.
    let output = crate::safe_process::run_bounded(
        shell,
        &[
            "-ilc",
            "/usr/bin/printf '\n__AI_INTEGRATOR_PATH__'; /usr/bin/printenv PATH; /usr/bin/printf '\n'",
        ],
        None,
    )
    .ok()
    .filter(|output| output.success)?;
    parse_login_shell_path(&output.stdout)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_login_shell_path(output: &str) -> Option<OsString> {
    const MARKER: &str = "__AI_INTEGRATOR_PATH__";
    output.lines().rev().find_map(|line| {
        line.trim()
            .strip_prefix(MARKER)
            .filter(|path| !path.is_empty())
            .map(OsString::from)
    })
}

fn verified_cursor_agent_alias(executable: &Path, search_path: Option<&OsStr>) -> bool {
    let Ok(output) = run_bounded_with_path(executable, &["--help"], None, search_path) else {
        return false;
    };
    cursor_agent_identity(&format!("{}\n{}", output.stdout, output.stderr))
}

fn cursor_agent_identity(output: &str) -> bool {
    let output = output.to_ascii_lowercase();
    output.contains("cursor agent")
        || output.contains("cursor-agent")
        || output.contains("cursor.com")
}

fn prefer_windows_launcher(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        if path.extension().is_none() {
            for extension in ["cmd", "bat", "exe"] {
                let candidate = path.with_extension(extension);
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    path
}

fn find_known_install(provider: &ProviderKind) -> Option<PathBuf> {
    known_install_candidates(provider)
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn known_install_candidates(provider: &ProviderKind) -> Vec<PathBuf> {
    let mut candidates = match provider {
        ProviderKind::Codex => home_dir()
            .map(|home| {
                let root = home.join(".local").join("bin");
                vec![
                    root.join("codex"),
                    root.join("codex.exe"),
                    root.join("codex.cmd"),
                ]
            })
            .unwrap_or_default(),
        ProviderKind::Claude => home_dir()
            .map(|home| {
                let local = home.join(".local").join("bin");
                let legacy = home.join(".claude").join("local");
                vec![
                    local.join("claude"),
                    local.join("claude.exe"),
                    local.join("claude.cmd"),
                    legacy.join("claude"),
                    legacy.join("claude.exe"),
                    legacy.join("claude.cmd"),
                ]
            })
            .unwrap_or_default(),
        ProviderKind::Antigravity => home_dir()
            .map(|home| {
                let root = home.join(".local").join("bin");
                vec![root.join("agy"), root.join("agy.exe"), root.join("agy.cmd")]
            })
            .unwrap_or_default(),
        ProviderKind::Cursor => home_dir()
            .map(|home| {
                vec![
                    home.join(".local").join("bin").join("cursor-agent"),
                    home.join(".cursor").join("bin").join("cursor-agent"),
                ]
            })
            .unwrap_or_default(),
        ProviderKind::Kimi => home_dir()
            .map(|home| {
                vec![
                    home.join(".local").join("bin").join("kimi"),
                    home.join(".local").join("bin").join("kimi.exe"),
                    home.join(".local").join("bin").join("kimi.cmd"),
                    home.join(".kimi-code").join("bin").join("kimi"),
                    home.join(".kimi-code").join("bin").join("kimi.exe"),
                    home.join(".kimi-code").join("bin").join("kimi.cmd"),
                ]
            })
            .unwrap_or_default(),
        // The official installer (x.ai/cli/install.ps1|sh) places the binary
        // in ~/.grok/bin and only amends the persistent PATH, which a running
        // app never inherits.
        ProviderKind::Grok => home_dir()
            .map(|home| {
                vec![
                    home.join(".grok").join("bin").join("grok.exe"),
                    home.join(".grok").join("bin").join("grok"),
                ]
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    #[cfg(windows)]
    if *provider == ProviderKind::Cursor
        && let Some(local_app_data) = std::env::var_os("LOCALAPPDATA")
    {
        let root = PathBuf::from(local_app_data).join("cursor-agent");
        candidates.extend([
            root.join("cursor-agent.cmd"),
            root.join("dist-package").join("cursor-agent.cmd"),
        ]);
    }
    #[cfg(windows)]
    if *provider == ProviderKind::Antigravity
        && let Some(local_app_data) = std::env::var_os("LOCALAPPDATA")
    {
        let root = PathBuf::from(local_app_data).join("agy").join("bin");
        candidates.extend([root.join("agy.exe"), root.join("agy.cmd")]);
    }
    // npm global shims land in %APPDATA%\npm, which exists on PATH only after
    // a re-login when npm itself created the directory.
    #[cfg(windows)]
    if let (Some(package_binary), Some(app_data)) =
        (npm_binary_name(provider), std::env::var_os("APPDATA"))
    {
        candidates.push(
            PathBuf::from(app_data)
                .join("npm")
                .join(format!("{package_binary}.cmd")),
        );
    }
    candidates
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

#[cfg(windows)]
fn npm_binary_name(provider: &ProviderKind) -> Option<&'static str> {
    match provider {
        ProviderKind::Codex => Some("codex"),
        ProviderKind::Claude => Some("claude"),
        ProviderKind::Grok => Some("grok"),
        ProviderKind::Kimi => Some("kimi"),
        _ => None,
    }
}

fn authentication_status(
    provider: &ProviderKind,
    executable: &Path,
    search_path: Option<&OsStr>,
) -> (AuthenticationState, Option<String>) {
    match provider {
        ProviderKind::Codex => {
            match run_bounded_with_path(executable, &["login", "status"], None, search_path) {
                Ok(output) => {
                    let combined =
                        format!("{} {}", output.stdout, output.stderr).to_ascii_lowercase();
                    parse_codex_auth_text(&combined)
                }
                Err(_) => (
                    AuthenticationState::Unknown,
                    Some("auth-probe-failed".into()),
                ),
            }
        }
        ProviderKind::Claude => {
            match run_bounded_with_path(
                executable,
                &["auth", "status", "--json"],
                None,
                search_path,
            ) {
                Ok(output) => match serde_json::from_str::<serde_json::Value>(&output.stdout) {
                    Ok(value)
                        if value.get("loggedIn").and_then(serde_json::Value::as_bool)
                            == Some(true) =>
                    {
                        (AuthenticationState::Authenticated, None)
                    }
                    Ok(value)
                        if value.get("loggedIn").and_then(serde_json::Value::as_bool)
                            == Some(false) =>
                    {
                        (
                            AuthenticationState::LoggedOut,
                            Some("login-required".into()),
                        )
                    }
                    _ => (
                        AuthenticationState::Unknown,
                        Some("auth-status-unknown".into()),
                    ),
                },
                Err(_) => (
                    AuthenticationState::Unknown,
                    Some("auth-probe-failed".into()),
                ),
            }
        }
        // Antigravity stores login in the OS keyring on macOS and Windows, so
        // a credential filename is neither necessary nor sufficient. `models`
        // is its documented read-only, headless-safe inventory and proves that
        // the CLI can actually reuse the vendor-owned login without spending a
        // turn or exposing credential material.
        ProviderKind::Antigravity => match run_bounded_with_limits_and_path(
            executable,
            &["--output-format", "json", "models"],
            None,
            256 * 1024,
            std::time::Duration::from_secs(15),
            search_path,
        ) {
            Ok(output) => {
                parse_antigravity_model_auth(output.success, &output.stdout, &output.stderr)
            }
            Err(_) => (
                AuthenticationState::Unknown,
                Some("auth-probe-failed".into()),
            ),
        },
        ProviderKind::Cursor => {
            match run_bounded_with_path(executable, &["status"], None, search_path) {
                Ok(output) => {
                    let combined = format!("{} {}", output.stdout, output.stderr);
                    parse_cli_auth_text(&combined)
                }
                Err(_) => (
                    AuthenticationState::Unknown,
                    Some("auth-probe-failed".into()),
                ),
            }
        }
        ProviderKind::Kimi => (
            AuthenticationState::Unknown,
            Some("auth-probe-requires-acp".into()),
        ),
        // `grok models` is the documented read-only inventory and prints a
        // login sentence (`You are logged in with grok.com.`) without exposing
        // token contents. Do not read `~/.grok/auth.json`.
        ProviderKind::Grok => {
            match run_bounded_with_path(
                executable,
                &["--no-auto-update", "models"],
                None,
                search_path,
            ) {
                Ok(output) => {
                    let combined = format!("{} {}", output.stdout, output.stderr);
                    parse_cli_auth_text(&combined)
                }
                Err(_) => (
                    AuthenticationState::Unknown,
                    Some("auth-probe-failed".into()),
                ),
            }
        }
        ProviderKind::CustomAcp => (AuthenticationState::Unknown, Some("auth-not-probed".into())),
    }
}

fn parse_antigravity_model_auth(
    success: bool,
    stdout: &str,
    stderr: &str,
) -> (AuthenticationState, Option<String>) {
    let parsed = parse_cli_auth_text(&format!("{stdout} {stderr}"));
    if parsed.0 == AuthenticationState::LoggedOut {
        return parsed;
    }
    if success && antigravity_inventory_has_models(stdout) {
        return (AuthenticationState::Authenticated, None);
    }
    (
        AuthenticationState::Unknown,
        Some("auth-probe-failed".into()),
    )
}

fn antigravity_inventory_has_models(stdout: &str) -> bool {
    fn model_shape(value: &str) -> bool {
        let model = value.trim();
        if model.is_empty()
            || model.len() > 256
            || model.starts_with('/')
            || model.contains("..")
            || model.ends_with(':')
            || !model.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || byte.is_ascii_whitespace()
                    || b"-._/:()+[]".contains(&byte)
            })
        {
            return false;
        }
        let normalized = model.split_whitespace().collect::<Vec<_>>().join(" ");
        let lower = normalized.to_ascii_lowercase();
        (!normalized.contains(' ')
            && (normalized.bytes().any(|byte| byte.is_ascii_digit())
                || normalized.contains('-')
                || matches!(lower.as_str(), "auto" | "flash" | "pro")))
            || (["gemini ", "claude ", "gpt-", "gpt "]
                .iter()
                .any(|prefix| lower.starts_with(prefix))
                && normalized.bytes().any(|byte| byte.is_ascii_digit()))
    }

    fn inventory_entry_is_model(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::String(model) => model_shape(model),
            serde_json::Value::Object(object) => {
                ["id", "slug", "model", "name", "displayName", "display_name"]
                    .iter()
                    .find_map(|key| object.get(*key).and_then(serde_json::Value::as_str))
                    .is_some_and(model_shape)
            }
            _ => false,
        }
    }

    fn inventory_value_has_models(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::String(model) => model_shape(model),
            serde_json::Value::Array(models) => models.iter().any(inventory_entry_is_model),
            serde_json::Value::Object(object) => ["models", "data", "items"]
                .iter()
                .filter_map(|key| object.get(*key))
                .any(inventory_value_has_models),
            _ => false,
        }
    }

    serde_json::from_str(stdout.trim()).is_ok_and(|value| inventory_value_has_models(&value))
}

fn parse_codex_auth_text(value: &str) -> (AuthenticationState, Option<String>) {
    parse_cli_auth_text(value)
}

fn parse_cli_auth_text(value: &str) -> (AuthenticationState, Option<String>) {
    let value = value.to_ascii_lowercase();
    if value.contains("not logged in")
        || value.contains("not logged into")
        || value.contains("logged out")
        || value.contains("not authenticated")
        || value.contains("not signed in")
        || value.contains("login required")
        || value.contains("please sign in")
    {
        (
            AuthenticationState::LoggedOut,
            Some("login-required".into()),
        )
    } else if value.contains("logged in")
        || value.contains("authenticated")
        || value.contains("signed in")
        || value.contains("login successful")
    {
        (AuthenticationState::Authenticated, None)
    } else {
        (
            AuthenticationState::Unknown,
            Some("auth-status-unknown".into()),
        )
    }
}

fn first_safe_line(value: &str) -> Option<String> {
    value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(redact_text)
        .filter(|line| !line.is_empty())
}

/// The generated Codex protocol snapshot is 0.144.0. Older app-server builds
/// can authenticate and list models yet still reject a turn when a newly
/// advertised model requires a newer client, so auth alone cannot mean ready.
fn runtime_compatibility_code(provider: &ProviderKind, version: Option<&str>) -> Option<String> {
    if *provider != ProviderKind::Codex {
        return None;
    }
    version
        .and_then(version_triplet)
        .filter(|version| *version < (0, 144, 0))
        .map(|_| "runtime-update-required".into())
}

fn version_triplet(value: &str) -> Option<(u32, u32, u32)> {
    value
        .split(|character: char| !character.is_ascii_digit() && character != '.')
        .filter(|candidate| !candidate.is_empty())
        .find_map(|candidate| {
            let mut parts = candidate.split('.');
            let major = parts.next()?.parse().ok()?;
            let minor = parts.next()?.parse().ok()?;
            let patch = parts.next()?.parse().ok()?;
            Some((major, minor, patch))
        })
}

#[must_use]
pub fn provider_executable(statuses: &[ProviderStatus], provider: ProviderKind) -> Option<PathBuf> {
    statuses
        .iter()
        .find(|status| status.provider == provider && status.installed)
        .and_then(|status| status.executable.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_version_line_does_not_return_email() {
        assert_eq!(
            first_safe_line("tool 1.2.3 user@example.test"),
            Some("tool 1.2.3 [redacted]".into())
        );
    }

    #[test]
    fn definitions_cover_primary_providers() {
        let providers = definitions().map(|definition| definition.provider);
        assert!(providers.contains(&ProviderKind::Codex));
        assert!(providers.contains(&ProviderKind::Claude));
        assert!(providers.contains(&ProviderKind::Antigravity));
        assert!(providers.contains(&ProviderKind::Kimi));
    }

    #[test]
    fn one_provider_probe_does_not_require_a_full_inventory() {
        let status = discover_provider(ProviderKind::Antigravity).expect("Antigravity definition");
        assert_eq!(status.provider, ProviderKind::Antigravity);
        assert!(discover_provider(ProviderKind::CustomAcp).is_none());
    }

    #[test]
    fn current_cli_entrypoints_are_preferred() {
        let cursor = definitions()
            .into_iter()
            .find(|definition| definition.provider == ProviderKind::Cursor)
            .expect("Cursor definition");
        assert_eq!(cursor.executables, &["cursor-agent", "agent"]);

        let grok = definitions()
            .into_iter()
            .find(|definition| definition.provider == ProviderKind::Grok)
            .expect("Grok Build definition");
        assert_eq!(grok.version_args, &["version"]);

        let kimi = definitions()
            .into_iter()
            .find(|definition| definition.provider == ProviderKind::Kimi)
            .expect("Kimi Code definition");
        assert_eq!(kimi.executables, &["kimi"]);
        assert_eq!(kimi.version_args, &["--version"]);
    }

    #[test]
    fn generic_agent_alias_must_identify_cursor() {
        assert!(cursor_agent_identity("Cursor Agent - command line tools"));
        assert!(cursor_agent_identity(
            "Learn more at https://cursor.com/docs"
        ));
        assert!(!cursor_agent_identity("Grok Agent 1.0"));
    }

    #[test]
    fn login_shell_path_parser_tolerates_chatter_and_fails_closed() {
        let output = "plugin banner\n__AI_INTEGRATOR_PATH__/usr/bin:/Users/test/.local/bin\n% ";
        assert_eq!(
            parse_login_shell_path(output),
            Some(OsString::from("/usr/bin:/Users/test/.local/bin"))
        );
        assert_eq!(parse_login_shell_path("plugin banner only"), None);
    }

    #[test]
    fn login_path_cache_can_be_invalidated_after_profile_changes() {
        let cache = LoginPathCache::default();
        assert_eq!(cache.resolve(|| Some("first".into())), Some("first".into()));
        assert_eq!(cache.resolve(|| Some("stale".into())), Some("first".into()));
        cache.invalidate();
        assert_eq!(
            cache.resolve(|| Some("second".into())),
            Some("second".into())
        );
    }

    #[test]
    fn installed_help_is_classified_provider_by_provider_and_fails_closed() {
        let (codex, certification, diagnostic) = classify_help_capabilities(
            &ProviderKind::Codex,
            "resume app-server --sandbox plugin",
            true,
        );
        assert!(codex.session_resume && codex.authoritative_history && codex.skills);
        assert_eq!(certification, ProviderCertification::Certified);
        assert_eq!(diagnostic, None);

        let (claude, certification, _) = classify_help_capabilities(
            &ProviderKind::Claude,
            "--resume --output-format --input-format --include-hook-events --permission-mode --disable-slash-commands",
            true,
        );
        assert!(claude.hooks && claude.structured_tool_events && claude.skills);
        assert_eq!(certification, ProviderCertification::Certified);

        let (agy, certification, _) = classify_help_capabilities(
            &ProviderKind::Antigravity,
            "--conversation --print --sandbox --new-project --add-dir plugin",
            true,
        );
        assert!(agy.session_resume && agy.subscription_auth && agy.skills);
        assert_eq!(certification, ProviderCertification::Certified);

        let (_, cursor_certification, _) = classify_help_capabilities(
            &ProviderKind::Cursor,
            "--resume --output-format --sandbox --workspace --plugin-dir",
            true,
        );
        assert_eq!(
            cursor_certification,
            ProviderCertification::SessionProbeRequired
        );

        let (kimi, kimi_certification, _) =
            classify_help_capabilities(&ProviderKind::Kimi, "--session acp login skills", true);
        assert!(kimi.session_resume && kimi.structured_tool_events && kimi.skills);
        assert_eq!(
            kimi_certification,
            ProviderCertification::SessionProbeRequired
        );

        let (_, incomplete_certification, diagnostic) = classify_help_capabilities(
            &ProviderKind::Claude,
            "--resume --output-format --input-format --permission-mode",
            true,
        );
        assert_eq!(incomplete_certification, ProviderCertification::Uncertified);
        assert_eq!(diagnostic.as_deref(), Some("capability-mismatch"));
    }

    #[test]
    fn codex_below_the_protocol_floor_requires_an_update() {
        assert_eq!(
            runtime_compatibility_code(&ProviderKind::Codex, Some("codex-cli 0.139.0")),
            Some("runtime-update-required".into())
        );
        assert_eq!(
            runtime_compatibility_code(&ProviderKind::Codex, Some("codex-cli 0.144.0")),
            None
        );
        assert_eq!(
            runtime_compatibility_code(&ProviderKind::Claude, Some("0.1.0")),
            None
        );
    }

    #[test]
    fn version_parser_accepts_vendor_prefixes_and_prereleases() {
        assert_eq!(
            version_triplet("codex-cli 0.144.0-alpha.4"),
            Some((0, 144, 0))
        );
        assert_eq!(version_triplet("v2.1.195 (Claude Code)"), Some((2, 1, 195)));
        assert_eq!(version_triplet("unknown"), None);
    }

    #[test]
    fn user_local_fallbacks_cover_every_supported_runtime() {
        if home_dir().is_none() {
            return;
        }
        for (provider, executable) in [
            (ProviderKind::Codex, "codex"),
            (ProviderKind::Claude, "claude"),
            (ProviderKind::Antigravity, "agy"),
            (ProviderKind::Cursor, "cursor-agent"),
            (ProviderKind::Grok, "grok"),
            (ProviderKind::Kimi, "kimi"),
        ] {
            assert!(
                known_install_candidates(&provider)
                    .iter()
                    .any(|path| path.file_name() == Some(OsStr::new(executable))),
                "missing {provider:?} user-local fallback"
            );
        }
    }

    #[test]
    fn custom_acp_has_no_guessed_install_location() {
        assert!(known_install_candidates(&ProviderKind::CustomAcp).is_empty());
    }

    #[test]
    fn runtime_path_deduplicates_shell_and_fallback_entries() {
        let joined = join_unique_paths([
            PathBuf::from("/Users/test/.local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/Users/test/.local/bin"),
        ])
        .expect("joined path");
        let paths = std::env::split_paths(&joined).collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec![
                PathBuf::from("/Users/test/.local/bin"),
                PathBuf::from("/opt/homebrew/bin")
            ]
        );
    }

    #[test]
    fn finder_style_path_recovers_login_and_every_user_runtime_root() {
        let home = Path::new("/Users/test");
        let local_bin = home.join(".local/bin");
        let login_path = std::env::join_paths([
            local_bin.clone(),
            PathBuf::from("/opt/homebrew/bin"),
            local_bin.clone(),
        ])
        .expect("login PATH");
        let joined = join_unique_paths(runtime_search_paths(
            Some(&login_path),
            None,
            Some(home),
            true,
        ))
        .expect("Finder runtime PATH");
        let paths = std::env::split_paths(&joined).collect::<Vec<_>>();

        assert_eq!(paths.first(), Some(&local_bin));
        assert_eq!(paths.iter().filter(|path| *path == &local_bin).count(), 1);
        for expected in [
            home.join(".cursor/bin"),
            home.join(".grok/bin"),
            home.join(".kimi-code/bin"),
            home.join(".claude/local"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ] {
            assert!(paths.contains(&expected), "missing {expected:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn login_shell_probe_handles_chatter_and_missing_markers() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temp login shell");
        let shell = directory.path().join("fixture-shell");
        std::fs::write(
            &shell,
            "#!/bin/sh\nprintf 'plugin banner\\n__AI_INTEGRATOR_PATH__/Users/test/.local/bin:/usr/bin\\n'\n",
        )
        .expect("write login shell");
        let mut permissions = std::fs::metadata(&shell)
            .expect("shell metadata")
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&shell, permissions).expect("make shell executable");

        assert_eq!(
            read_login_shell_path_from(&shell),
            Some(OsString::from("/Users/test/.local/bin:/usr/bin"))
        );

        std::fs::write(&shell, "#!/bin/sh\nprintf 'plugin banner only\\n'\n")
            .expect("write degraded login shell");
        assert_eq!(read_login_shell_path_from(&shell), None);

        std::fs::write(
            &shell,
            "#!/bin/sh\nprintf '__AI_INTEGRATOR_PATH__/untrusted/bin\\n'\nexit 9\n",
        )
        .expect("write failed login shell");
        assert_eq!(read_login_shell_path_from(&shell), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn finder_launch_discovers_every_provider_from_zprofile_path() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temp Finder fixture");
        let zdot = directory.path().join("zdot");
        let profile_bin = zdot.join("profile-bin");
        std::fs::create_dir_all(&profile_bin).expect("create profile bin");

        std::fs::write(
            zdot.join(".zprofile"),
            "#!/bin/zsh\n/usr/bin/printf 'profile chatter'\nexport PATH=\"$ZDOTDIR/profile-bin:/usr/bin:/bin\"\n",
        )
        .expect("write zprofile");

        let wrapper = directory.path().join("fixture-zsh");
        std::fs::write(
            &wrapper,
            "#!/bin/sh\nZDOTDIR=\"$(/usr/bin/dirname \"$0\")/zdot\"\nexport ZDOTDIR\nexec /bin/zsh \"$@\"\n",
        )
        .expect("write zsh wrapper");

        let provider_executables = ["codex", "claude", "agy", "cursor-agent", "grok", "kimi"];
        for executable in provider_executables {
            std::fs::write(
                profile_bin.join(executable),
                "#!/bin/sh\nexec fixture-runtime \"$0\" \"$@\"\n",
            )
            .expect("write provider fixture");
        }
        let fixture_runtime = profile_bin.join("fixture-runtime");
        std::fs::write(
            &fixture_runtime,
            r#"#!/bin/sh
provider=$(/usr/bin/basename "$1")
shift
case "$provider:$*" in
  "codex:--version") printf 'codex-cli 0.144.0\n' ;;
  "codex:--help") printf 'Codex resume app-server --sandbox plugin\n' ;;
  "codex:login status") printf 'Logged in using ChatGPT\n' ;;
  "claude:--version") printf 'claude 2.1.0\n' ;;
  "claude:--help") printf '%s\n' 'Claude --resume --output-format --input-format --include-hook-events --permission-mode --disable-slash-commands' ;;
  "claude:auth status --json") printf '%s\n' '{"loggedIn":true}' ;;
  "agy:--version") printf 'agy 1.1.12\n' ;;
  "agy:--help") printf '%s\n' 'Antigravity --conversation --print --sandbox --new-project --add-dir plugin' ;;
  "agy:--output-format json models") printf '%s\n' '{"models":["Gemini 3.5 Flash"]}' ;;
  "cursor-agent:--version") printf 'cursor-agent 2026.1.0\n' ;;
  "cursor-agent:--help") printf '%s\n' 'Cursor Agent --resume --output-format --sandbox --workspace --plugin-dir' ;;
  "cursor-agent:status") printf 'Login successful\n' ;;
  "grok:version") printf 'grok 1.0.0\n' ;;
  "grok:--help") printf 'Grok agent stdio\n' ;;
  "grok:--no-auto-update models") printf 'You are logged in with grok.com.\nAvailable models:\n  * grok-4.6\n' ;;
  "kimi:--version") printf 'kimi 1.0.0\n' ;;
  "kimi:--help") printf 'Kimi --session acp login skills\n' ;;
  *) exit 9 ;;
esac
"#,
        )
        .expect("write runtime fixture");

        let mut executable_paths = vec![wrapper.clone(), fixture_runtime.clone()];
        executable_paths.extend(
            provider_executables
                .iter()
                .map(|executable| profile_bin.join(executable)),
        );
        for executable in &executable_paths {
            let mut permissions = std::fs::metadata(executable)
                .expect("fixture metadata")
                .permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(executable, permissions).expect("make fixture executable");
        }

        let login_path = read_login_shell_path_from(&wrapper).expect("zprofile PATH");
        let inherited =
            std::env::join_paths([Path::new("/usr/bin"), Path::new("/bin")]).expect("Finder PATH");
        let search_path = join_unique_paths(runtime_search_paths(
            Some(&login_path),
            Some(&inherited),
            None,
            true,
        ))
        .expect("assembled runtime PATH");
        for (provider, executable, version, authentication, certification, diagnostic) in [
            (
                ProviderKind::Codex,
                "codex",
                "codex-cli 0.144.0",
                AuthenticationState::Authenticated,
                ProviderCertification::Certified,
                None,
            ),
            (
                ProviderKind::Claude,
                "claude",
                "claude 2.1.0",
                AuthenticationState::Authenticated,
                ProviderCertification::Certified,
                None,
            ),
            (
                ProviderKind::Antigravity,
                "agy",
                "agy 1.1.12",
                AuthenticationState::Authenticated,
                ProviderCertification::Certified,
                None,
            ),
            (
                ProviderKind::Cursor,
                "cursor-agent",
                "cursor-agent 2026.1.0",
                AuthenticationState::Authenticated,
                ProviderCertification::SessionProbeRequired,
                None,
            ),
            (
                ProviderKind::Grok,
                "grok",
                "grok 1.0.0",
                AuthenticationState::Authenticated,
                ProviderCertification::SessionProbeRequired,
                None,
            ),
            (
                ProviderKind::Kimi,
                "kimi",
                "kimi 1.0.0",
                AuthenticationState::Unknown,
                ProviderCertification::SessionProbeRequired,
                Some("auth-probe-requires-acp"),
            ),
        ] {
            let definition = definitions()
                .into_iter()
                .find(|definition| definition.provider == provider)
                .expect("provider definition");
            let status = discover_one(definition, Some(&search_path));

            assert!(status.installed, "{provider:?} should be installed");
            assert_eq!(
                status.executable.as_deref(),
                Some(profile_bin.join(executable).as_path()),
                "{provider:?} should use the zprofile executable"
            );
            assert_eq!(status.version.as_deref(), Some(version));
            assert_eq!(status.authentication, authentication);
            assert_eq!(status.certification, certification);
            assert_eq!(status.diagnostic_code.as_deref(), diagnostic);
        }
    }

    #[test]
    fn grok_fallback_covers_official_installer_and_npm_locations() {
        if home_dir().is_none() {
            return;
        }
        let candidates = known_install_candidates(&ProviderKind::Grok);
        assert!(
            candidates
                .iter()
                .any(|path| path.ends_with(Path::new(".grok/bin/grok.exe")))
        );
        #[cfg(windows)]
        assert!(
            candidates
                .iter()
                .any(|path| path.ends_with(Path::new("npm/grok.cmd")))
        );
    }

    #[test]
    fn grok_prefers_the_direct_vendor_binary_over_a_path_wrapper() {
        let path_wrapper = PathBuf::from(r"C:\Users\test\AppData\Roaming\npm\grok.cmd");
        let direct_binary = PathBuf::from(r"C:\Users\test\.grok\bin\grok.exe");
        assert_eq!(
            select_provider_executable(
                &ProviderKind::Grok,
                Some(path_wrapper),
                Some(direct_binary.clone()),
            ),
            Some(direct_binary)
        );
    }

    #[test]
    fn other_providers_keep_path_precedence() {
        let path_binary = PathBuf::from(r"C:\tools\cursor-agent.cmd");
        let fallback_binary = PathBuf::from(r"C:\fallback\cursor-agent.cmd");
        assert_eq!(
            select_provider_executable(
                &ProviderKind::Cursor,
                Some(path_binary.clone()),
                Some(fallback_binary),
            ),
            Some(path_binary)
        );
    }

    #[test]
    fn logged_out_text_is_not_misclassified_as_logged_in() {
        let (state, code) = parse_codex_auth_text("not logged in");
        assert_eq!(state, AuthenticationState::LoggedOut);
        assert_eq!(code.as_deref(), Some("login-required"));
    }

    #[test]
    fn cursor_status_text_maps_to_authenticated() {
        let (state, code) = parse_cli_auth_text("Login successful");
        assert_eq!(state, AuthenticationState::Authenticated);
        assert_eq!(code, None);
    }

    #[test]
    fn cursor_status_text_maps_to_logged_out() {
        let (state, code) = parse_cli_auth_text("Not authenticated. Run agent login.");
        assert_eq!(state, AuthenticationState::LoggedOut);
        assert_eq!(code.as_deref(), Some("login-required"));
    }

    #[test]
    fn grok_models_login_sentence_is_authenticated() {
        let (state, code) = parse_cli_auth_text("You are logged in with grok.com.");
        assert_eq!(state, AuthenticationState::Authenticated);
        assert_eq!(code, None);
    }

    #[test]
    fn grok_models_logged_out_sentence_requires_login() {
        let (state, code) = parse_cli_auth_text("Not logged in. Run grok login.");
        assert_eq!(state, AuthenticationState::LoggedOut);
        assert_eq!(code.as_deref(), Some("login-required"));
    }

    #[test]
    fn grok_models_without_login_language_stays_unknown() {
        let (state, code) = parse_cli_auth_text("Default model: grok-4.6\n\nAvailable models:");
        assert_eq!(state, AuthenticationState::Unknown);
        assert_eq!(code.as_deref(), Some("auth-status-unknown"));
    }

    #[test]
    fn antigravity_model_inventory_proves_keyring_login() {
        for inventory in [
            r#"{"models":[{"name":"Gemini 3.5 Flash (Medium)"},{"name":"Claude Sonnet 4.6 (Thinking)"}]}"#,
            r#"{"models":"Gemini 3.5 Flash"}"#,
        ] {
            let (state, code) = parse_antigravity_model_auth(true, inventory, "");
            assert_eq!(state, AuthenticationState::Authenticated);
            assert_eq!(code, None);
        }
    }

    #[test]
    fn antigravity_model_probe_reports_login_required_without_reading_credentials() {
        for (success, stdout, stderr) in [
            (false, "", "Not authenticated. Start agy to sign in."),
            (
                true,
                "You are not logged into Antigravity.\nPlease sign in to view available models.\n",
                "",
            ),
        ] {
            let (state, code) = parse_antigravity_model_auth(success, stdout, stderr);
            assert_eq!(state, AuthenticationState::LoggedOut);
            assert_eq!(code.as_deref(), Some("login-required"));
        }
    }

    #[test]
    fn antigravity_empty_or_failed_inventory_is_not_called_connected() {
        for (success, stdout, stderr) in [
            (true, "", ""),
            (true, r#"{"models":[]}"#, ""),
            (true, r#"{"models":[null,{"error":"auth"}]}"#, ""),
            (true, r#"{"models":["Gemini 3:"]}"#, ""),
            (
                true,
                r#"{"models":[{"id":"error","name":"Gemini 3.5 Flash"}]}"#,
                "",
            ),
            (true, "Update available", ""),
            (false, "", "network unavailable"),
        ] {
            let (state, code) = parse_antigravity_model_auth(success, stdout, stderr);
            assert_eq!(state, AuthenticationState::Unknown);
            assert_eq!(code.as_deref(), Some("auth-probe-failed"));
        }
    }
}
