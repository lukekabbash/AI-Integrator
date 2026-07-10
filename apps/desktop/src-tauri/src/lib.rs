#![forbid(unsafe_code)]

mod commands;
mod state;

use commands::*;
use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = AppState::initialize()
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_bootstrap,
            provider_discover,
            task_create,
            task_list,
            task_set_state,
            setting_list,
            setting_set,
            session_list,
            local_export,
            project_register,
            project_list,
            project_remove,
            git_repository,
            git_worktrees,
            git_worktree_create,
            git_status,
            git_diff,
            git_stage,
            git_unstage,
            git_commit,
            git_push_preview,
            codex_connect,
            codex_disconnect,
            codex_list_models,
            codex_list_threads,
            codex_read_thread,
            codex_start_thread,
            codex_resume_thread,
            codex_start_turn,
            codex_interrupt_turn,
            codex_resolve_approval,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AI Integrator");
}
