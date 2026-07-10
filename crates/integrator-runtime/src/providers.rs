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
            provider: ProviderKind::Gemini,
            executables: &["gemini"],
            version_args: &["--version"],
            transport: ProviderTransport::AcpStdio,
        },
        ProbeDefinition {
            provider: ProviderKind::Cursor,
            executables: &["cursor-agent", "agent"],
            version_args: &["--version"],
            transport: ProviderTransport::AcpStdio,
        },
        ProbeDefinition {
            provider: ProviderKind::Grok,
            executables: &["grok"],
            version_args: &["--version"],
            transport: ProviderTransport::AcpStdio,
        },
    ]
}

fn discover_one(definition: ProbeDefinition) -> ProviderStatus {
    let executable = definition
        .executables
        .iter()
        .find_map(|candidate| which::which(candidate).ok());
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
    let (authentication, auth_code) = authentication_status(&definition.provider, &executable);

    ProviderStatus {
        provider: definition.provider,
        installed: true,
        executable: Some(executable),
        version,
        authentication,
        transport: Some(definition.transport),
        diagnostic_code: auth_code.or(probe_code),
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
        ProviderKind::Gemini
        | ProviderKind::Cursor
        | ProviderKind::Grok
        | ProviderKind::CustomAcp => (AuthenticationState::Unknown, Some("auth-not-probed".into())),
    }
}

fn parse_codex_auth_text(value: &str) -> (AuthenticationState, Option<String>) {
    if value.contains("not logged in") || value.contains("logged out") {
        (
            AuthenticationState::LoggedOut,
            Some("login-required".into()),
        )
    } else if value.contains("logged in") {
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
        assert!(providers.contains(&ProviderKind::Gemini));
    }

    #[test]
    fn logged_out_text_is_not_misclassified_as_logged_in() {
        let (state, code) = parse_codex_auth_text("not logged in");
        assert_eq!(state, AuthenticationState::LoggedOut);
        assert_eq!(code.as_deref(), Some("login-required"));
    }
}
