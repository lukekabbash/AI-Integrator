#![forbid(unsafe_code)]

mod broker_mcp;
mod chat_title;
mod code_explain;
mod commands;
mod commit_message;
mod delegation;
mod native_actions;
mod runtime_setup;
mod state;

use chat_title::task_generate_title;
use code_explain::selection_explain;
use commands::*;
use commit_message::git_generate_commit_message;
use delegation::{
    delegation_approve, delegation_deny, delegation_list, delegation_send_message,
    delegation_stop_cmd,
};
use runtime_setup::{
    runtime_action_plan_list, runtime_terminal_close, runtime_terminal_open,
    runtime_terminal_resize, runtime_terminal_write,
};
use state::AppState;
use tauri::Manager;

/// `--broker-mcp` mode: run the stdio MCP bridge instead of the app. Spawned
/// by provider CLIs; must never touch Tauri or the local store.
pub fn run_broker_mcp() -> i32 {
    broker_mcp::run()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // rustls 0.23 panics on the first TLS connection (voice typing's
    // websocket) unless a process-wide crypto provider is installed.
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        // A second launch focuses the existing window instead of spawning a
        // competing process against the same local store.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = AppState::initialize().map_err(|error| {
                let boxed: Box<dyn std::error::Error> = Box::new(error);
                boxed
            })?;
            app.manage(state);
            if let Err(error) = delegation::prune_stale_mcp_configs(app.handle()) {
                eprintln!("delegation broker config cleanup failed: {error}");
            }
            delegation::start_broker_host(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_bootstrap,
            open_external_url,
            provider_discover,
            provider_action_list,
            task_create,
            composer_draft_save,
            queued_message_enqueue,
            queued_message_list,
            queued_message_reorder,
            queued_message_take,
            queued_message_set_dispatching,
            task_list,
            task_search_messages,
            task_set_state,
            task_update_metadata,
            task_generate_title,
            task_update_routing,
            setting_list,
            setting_set,
            session_list,
            local_export,
            local_clear,
            storage_totals,
            usage_summary,
            voice_typing_credential_status,
            voice_typing_credential_set,
            voice_typing_credential_clear,
            voice_typing_start,
            voice_typing_append,
            voice_typing_stop,
            project_register,
            project_create,
            project_default_parent,
            project_clone,
            project_git_init,
            github_repository_list,
            project_list,
            project_remove,
            git_repository,
            git_worktrees,
            git_worktree_create,
            project_file_list,
            project_file_read,
            project_file_write,
            project_file_rename,
            selection_explain,
            project_file_opener_list,
            project_file_open,
            project_file_reveal,
            attachment_preview,
            git_status,
            git_overview,
            git_remote_add,
            git_remote_update,
            git_remote_remove,
            git_fetch,
            git_pull,
            git_publish_branch,
            git_publish_github,
            git_history,
            terminal_open,
            terminal_run,
            terminal_interrupt,
            terminal_close,
            runtime_action_plan_list,
            runtime_terminal_open,
            runtime_terminal_write,
            runtime_terminal_resize,
            runtime_terminal_close,
            git_diff,
            git_stage,
            git_unstage,
            git_commit,
            git_generate_commit_message,
            git_push_preview,
            git_push_confirmed,
            codex_connect,
            codex_disconnect,
            codex_list_models,
            codex_list_threads,
            codex_read_thread,
            codex_start_thread,
            codex_resume_thread,
            codex_start_turn,
            codex_interrupt_turn,
            codex_steer_turn,
            task_snapshot,
            codex_respond_approval,
            codex_stop_turn,
            acp_connect,
            acp_start_session,
            acp_send_turn,
            acp_set_config_option,
            acp_set_mode,
            acp_list_cursor_models,
            structured_cli_start_turn,
            delegation_list,
            delegation_approve,
            delegation_deny,
            delegation_send_message,
            delegation_stop_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AI Integrator");
}
