use std::path::{Path, PathBuf};

use integrator_core::{AuthenticationState, ProviderKind, ProviderStatus, ProviderTransport};

use crate::safe_process::{redact_text, run_bounded};

#[derive(Clone, Debug)]
struct ProbeDefinition {
    provider: ProviderKind,
    executables: &'static [&'static str],
    version_args: &'static [&'static str],
    transport: ProviderTransport,
}

pub fn discover_providers() -> Vec<ProviderStatus> {
    definitions().into_iter().map(discover_one).collect()
}

pub fn discover_provider(provider: ProviderKind) -> Option<ProviderStatus> {
    definitions()
        .into_iter()
        .find(|definition| definition.provider == provider)
        .map(discover_one)
}

fn definitions() -> [ProbeDefinition; 5] {
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
            // Cursor documents `agent` as the primary CLI entrypoint and
            // keeps `cursor-agent` as a compatibility alias.
            executables: &["agent", "cursor-agent"],
            version_args: &["--version"],
            transport: ProviderTransport::AcpStdio,
        },
        ProbeDefinition {
            provider: ProviderKind::Grok,
            executables: &["grok"],
            version_args: &["version"],
            transport: ProviderTransport::AcpStdio,
        },
    ]
}

fn discover_one(definition: ProbeDefinition) -> ProviderStatus {
    let executable = definition
        .executables
        .iter()
        .find_map(|candidate| which::which(candidate).ok().map(prefer_windows_launcher))
        .or_else(|| find_known_install(&definition.provider));
    let Some(executable) = executable else {
        return ProviderStatus {
            provider: definition.provider,
            installed: false,
            executable: None,
            version: None,
            authentication: AuthenticationState::Unavailable,
            transport: None,
            diagnostic_code: Some("not-installed".into()),
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
    let (authentication, auth_code) = authentication_status(&definition.provider, &executable);

    ProviderStatus {
        provider: definition.provider,
        installed: true,
        executable: Some(executable),
        version,
        authentication,
        transport: Some(definition.transport),
        diagnostic_code: auth_code.or(compatibility_code).or(probe_code),
    }
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
    match provider {
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
        _ => Vec::new(),
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
        ProviderKind::Grok | ProviderKind::CustomAcp => {
            (AuthenticationState::Unknown, Some("auth-not-probed".into()))
        }
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
        assert_eq!(cursor.executables, &["agent", "cursor-agent"]);

        let grok = definitions()
            .into_iter()
            .find(|definition| definition.provider == ProviderKind::Grok)
            .expect("Grok Build definition");
        assert_eq!(grok.version_args, &["version"]);
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
    fn non_cursor_providers_have_no_known_install_fallback() {
        assert!(known_install_candidates(&ProviderKind::Codex).is_empty());
        assert!(known_install_candidates(&ProviderKind::Claude).is_empty());
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
}
