use std::path::{Path, PathBuf};

use integrator_core::{
    AuthenticationState, ProviderCapabilities, ProviderCertification, ProviderKind, ProviderStatus,
    ProviderTransport,
};

use crate::safe_process::{redact_text, run_bounded};

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
    std::thread::scope(|scope| {
        let handles: Vec<_> = definitions()
            .into_iter()
            .map(|definition| scope.spawn(move || discover_one(definition)))
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().expect("provider probe thread"))
            .collect()
    })
}

pub fn discover_provider(provider: ProviderKind) -> Option<ProviderStatus> {
    definitions()
        .into_iter()
        .find(|definition| definition.provider == provider)
        .map(discover_one)
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

fn discover_one(definition: ProbeDefinition) -> ProviderStatus {
    let path_executable = definition
        .executables
        .iter()
        .find_map(|candidate| which::which(candidate).ok().map(prefer_windows_launcher));
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

    let (version, probe_code) = match run_bounded(&executable, definition.version_args, None) {
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
                probe_capabilities(&definition.provider, &executable, version_compatible)
            });
            let auth_probe =
                scope.spawn(|| authentication_status(&definition.provider, &executable));
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
) -> (ProviderCapabilities, ProviderCertification, Option<String>) {
    let help = run_bounded(executable, &["--help"], None)
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
        ProviderKind::Cursor => {
            let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") else {
                return Vec::new();
            };
            let root = PathBuf::from(local_app_data).join("cursor-agent");
            vec![
                root.join("agent.cmd"),
                root.join("cursor-agent.cmd"),
                root.join("dist-package").join("cursor-agent.cmd"),
            ]
        }
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
) -> (AuthenticationState, Option<String>) {
    match provider {
        ProviderKind::Codex => match run_bounded(executable, &["login", "status"], None) {
            Ok(output) => {
                let combined = format!("{} {}", output.stdout, output.stderr).to_ascii_lowercase();
                parse_codex_auth_text(&combined)
            }
            Err(_) => (
                AuthenticationState::Unknown,
                Some("auth-probe-failed".into()),
            ),
        },
        ProviderKind::Claude => {
            match run_bounded(executable, &["auth", "status", "--json"], None) {
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
        // `agy` exposes no auth-status command and its `models` panel needs a
        // TTY, so the probe checks the on-disk Google OAuth credential the
        // CLI itself maintains (`~/.gemini/oauth_creds.json`, cleared by
        // `/logout`). This can read stale until agy's next refresh, so a
        // present credential reports Authenticated with that caveat.
        ProviderKind::Antigravity => match antigravity_credentials_path() {
            Some(path) if path.is_file() => (AuthenticationState::Authenticated, None),
            Some(_) => (
                AuthenticationState::LoggedOut,
                Some("login-required".into()),
            ),
            None => (
                AuthenticationState::Unknown,
                Some("auth-probe-failed".into()),
            ),
        },
        ProviderKind::Cursor => match run_bounded(executable, &["status"], None) {
            Ok(output) => {
                let combined = format!("{} {}", output.stdout, output.stderr);
                parse_cli_auth_text(&combined)
            }
            Err(_) => (
                AuthenticationState::Unknown,
                Some("auth-probe-failed".into()),
            ),
        },
        ProviderKind::Kimi => (
            AuthenticationState::Unknown,
            Some("auth-probe-requires-acp".into()),
        ),
        // `grok models` is the documented read-only inventory and prints a
        // login sentence (`You are logged in with grok.com.`) without exposing
        // token contents. Do not read `~/.grok/auth.json`.
        ProviderKind::Grok => {
            match run_bounded(executable, &["--no-auto-update", "models"], None) {
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

fn antigravity_credentials_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".gemini").join("oauth_creds.json"))
}

fn parse_codex_auth_text(value: &str) -> (AuthenticationState, Option<String>) {
    parse_cli_auth_text(value)
}

fn parse_cli_auth_text(value: &str) -> (AuthenticationState, Option<String>) {
    let value = value.to_ascii_lowercase();
    if value.contains("not logged in")
        || value.contains("logged out")
        || value.contains("not authenticated")
        || value.contains("not signed in")
        || value.contains("login required")
    {
        (
            AuthenticationState::LoggedOut,
            Some("login-required".into()),
        )
    } else if value.contains("logged in")
        || value.contains("authenticated")
        || value.contains("signed in")
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
    fn cursor_known_install_candidates_use_local_app_data() {
        if std::env::var_os("LOCALAPPDATA").is_none() {
            return;
        }
        let candidates = known_install_candidates(&ProviderKind::Cursor);
        assert!(!candidates.is_empty());
        assert!(candidates.iter().all(|path| {
            path.components()
                .any(|part| part.as_os_str().to_string_lossy() == "cursor-agent")
        }));
    }

    #[test]
    fn providers_without_documented_install_locations_have_no_fallback() {
        assert!(known_install_candidates(&ProviderKind::Antigravity).is_empty());
        assert!(known_install_candidates(&ProviderKind::CustomAcp).is_empty());
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
        let (state, code) = parse_cli_auth_text("Logged in");
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
}
