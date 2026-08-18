use std::sync::Arc;

use integrator_core::{IntegratorError, Setting};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::command_api::{CommandError, CommandResult, worker_error};
use crate::diagnostic_commands::documents_directory;
use crate::state::AppState;

fn requires_dedicated_command(key: &str) -> bool {
    crate::browser::requires_dedicated_setting_command(key)
}

#[tauri::command]
pub async fn setting_list(state: State<'_, AppState>) -> CommandResult<Vec<Setting>> {
    let store = Arc::clone(&state.store);
    let mut settings = tauri::async_runtime::spawn_blocking(move || store.list_settings())
        .await
        .map_err(|_| worker_error())?
        .map_err(CommandError::from)?;
    settings.retain(|setting| !crate::browser::setting_is_internal(&setting.key));
    Ok(settings)
}

#[tauri::command]
pub async fn setting_set(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    value: Value,
) -> CommandResult<Setting> {
    if requires_dedicated_command(&key) {
        return Err(CommandError {
            code: "dedicated-command",
            message: "this browser security setting must be changed through its dedicated command"
                .into(),
        });
    }
    let store = Arc::clone(&state.store);
    let retention_value = value.clone();
    let stored_key = key.clone();
    let setting = tauri::async_runtime::spawn_blocking(move || {
        let setting = store.set_setting(&stored_key, value)?;
        if stored_key == crate::integrator_mcp::ENABLED_SETTING_KEY {
            crate::integrator_mcp::mark_configuration_changed(&store)?;
        }
        Ok::<Setting, IntegratorError>(setting)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(CommandError::from)?;
    if key == "settings.diagnostics.retention"
        && let Ok(documents) = documents_directory(&app)
    {
        let retention = retention_value
            .as_str()
            .map(crate::diagnostic_log::parse_retention)
            .unwrap_or(crate::diagnostic_log::Retention::Days(7));
        let _ = tauri::async_runtime::spawn_blocking(move || {
            crate::diagnostic_log::prune_logs(&documents, retention)
        })
        .await;
    }
    Ok(setting)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_identity_scope_cannot_bypass_its_merge_command() {
        assert!(requires_dedicated_command(
            crate::browser::IDENTITY_SCOPE_SETTING
        ));
        assert!(requires_dedicated_command("settings.browser.savedLogins"));
        assert!(requires_dedicated_command(
            "settings.browser.agentSignIn.https://example.com"
        ));
        assert!(!requires_dedicated_command("settings.browser.keepSignedIn"));
    }
}
