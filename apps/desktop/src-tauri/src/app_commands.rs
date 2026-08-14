use std::{path::PathBuf, process::Command};

#[cfg(target_os = "windows")]
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use integrator_core::{TaskId, Versioned};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::command_api::{CommandError, CommandResult};
use crate::native_process::spawn_quiet;
use crate::state::AppState;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    application_version: String,
    domain_schema_version: u32,
    data_directory: PathBuf,
    git_available: bool,
    local_only: bool,
}

#[tauri::command]
pub fn app_bootstrap(state: State<'_, AppState>) -> Versioned<Bootstrap> {
    Versioned::current(Bootstrap {
        application_version: env!("CARGO_PKG_VERSION").into(),
        domain_schema_version: integrator_core::DOMAIN_SCHEMA_VERSION,
        data_directory: state.data_directory.clone(),
        git_available: state.git.is_some(),
        local_only: true,
    })
}

/// Opens a user-visible HTTP(S) URL with the operating system's default
/// browser. The renderer can request only this narrowly validated action; it
/// never receives general process-launch authority.
#[tauri::command]
pub fn open_external_url(url: String) -> CommandResult<()> {
    let parsed = url::Url::parse(&url).map_err(|_| CommandError {
        code: "invalid-input",
        message: "only absolute HTTP(S) URLs can be opened externally".into(),
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(CommandError {
            code: "invalid-input",
            message: "only absolute HTTP(S) URLs can be opened externally".into(),
        });
    }

    #[cfg(target_os = "windows")]
    return spawn_quiet(
        windows_external_url_command(&parsed),
        "could not open the default browser",
    );
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return Err(CommandError {
        code: "external-open-failed",
        message: "opening external URLs is not supported on this platform".into(),
    });

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        command.arg(parsed.as_str());
        spawn_quiet(command, "could not open the default browser")
    }
}

#[cfg(target_os = "windows")]
fn windows_external_url_command(url: &url::Url) -> Command {
    // OAuth URLs contain cmd.exe metacharacters (`&` and `%`). Passing one to
    // `cmd /C start` can silently strip client_id, redirect_uri, and PKCE
    // parameters. Keep the URL as base64 data until a fixed PowerShell
    // expression hands it to the registered URL handler.
    let encoded_url = BASE64.encode(url.as_str().as_bytes());
    let script = format!(
        "Start-Process -FilePath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_url}')))"
    );
    let encoded_command = BASE64.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let mut command = Command::new("powershell");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encoded_command.as_str(),
    ]);
    command
}

/// Opens a second window mirroring `task_id`, or focuses it if already open.
/// Runtime/session state lives in process-wide `AppState`, and task events
/// broadcast to every window, so the new window sees the same live task
/// without any additional wiring.
#[tauri::command]
pub fn open_task_window(app: AppHandle, task_id: TaskId) -> CommandResult<()> {
    let label = format!("task-{task_id}");
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::App(format!("index.html?taskId={task_id}").into()),
    )
    .title("AI Integrator")
    .inner_size(1440.0, 900.0)
    .min_inner_size(720.0, 640.0)
    .resizable(true)
    .decorations(false)
    .center()
    .build()
    .map(|_| ())
    .map_err(|error| CommandError {
        code: "unavailable",
        message: format!("could not open a new window: {error}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_url_requires_absolute_http_or_https_with_a_host() {
        for url in [
            "relative/path",
            "file:///tmp/example",
            "mailto:user@example.com",
            "https://",
        ] {
            let error = open_external_url(url.into()).expect_err("URL must be rejected");
            assert_eq!(error.code, "invalid-input", "{url}");
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn external_oauth_url_is_passed_to_powershell_as_data() {
        let url = url::Url::parse(
            "https://example.com/oauth?response_type=code&client_id=app&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Foauth%2Fcallback",
        )
        .expect("OAuth URL");
        let command = windows_external_url_command(&url);
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let encoded = args.last().expect("encoded command argument");
        let decoded = BASE64.decode(encoded).expect("base64 command");
        let utf16 = decoded
            .chunks_exact(2)
            .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
            .collect::<Vec<_>>();
        let script = String::from_utf16(&utf16).expect("PowerShell command");
        let encoded_url = script
            .split_once("FromBase64String('")
            .and_then(|(_, tail)| tail.split_once("')"))
            .map(|(value, _)| value)
            .expect("encoded URL in command");
        let decoded_url = BASE64.decode(encoded_url).expect("base64 URL");

        assert_eq!(decoded_url, url.as_str().as_bytes());
        assert!(!encoded.contains('&'));
        assert!(!encoded.contains('%'));
        assert!(args.contains(&"-EncodedCommand".to_owned()));
        assert_eq!(command.get_program(), "powershell");
    }
}
