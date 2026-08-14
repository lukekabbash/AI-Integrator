#![forbid(unsafe_code)]
#![cfg_attr(test, allow(clippy::unwrap_used))]

mod antigravity_hooks;
mod app_commands;
mod automations;
mod broker_mcp;
mod chat_title;
mod code_explain;
mod command_api;
mod commands;
mod commit_message;
mod context_primer;
mod credential_store;
mod delegation;
mod diagnostic_commands;
mod diagnostic_log;
mod explain_context;
mod harness_prompt;
mod integrator_mcp;
mod integrator_skills;
mod interrupted_turn;
mod local_data_commands;
mod mcp_oauth;
mod memory_commands;
mod native_actions;
mod native_process;
mod plugin_preview;
mod provider_model_catalog;
mod provider_routing;
mod provider_usage;
mod queue_commands;
mod repository_watch;
mod runtime_setup;
mod settings_commands;
mod skill_api;
mod specialist_generator;
mod state;
mod structured_projection;
mod task_commands;
mod terminal_process;

use app_commands::{app_bootstrap, open_external_url, open_task_window};
use automations::{
    automation_cancel, automation_create, automation_finish_run, automation_list,
    automation_pending_dispatches, automation_run_list, automation_run_now, automation_set_paused,
    automation_timeline, automation_update,
};
use chat_title::task_generate_title;
use code_explain::{selection_explain, selection_explain_preview};
use commands::*;
use commit_message::git_generate_commit_message;
use delegation::{
    delegation_approve, delegation_deny, delegation_list, delegation_send_message,
    delegation_stop_cmd,
};
use diagnostic_commands::{
    diagnostics_report, logs_clear, logs_open_folder, logs_prune, logs_totals,
};
use integrator_mcp::{
    integrator_mcp_credential_clear, integrator_mcp_credential_set, integrator_mcp_import,
    integrator_mcp_oauth_connect, integrator_mcp_oauth_disconnect, integrator_mcp_overview,
    integrator_mcp_remove, integrator_mcp_save,
};
use integrator_skills::{
    integrator_skill_body, integrator_skill_credential_clear, integrator_skill_credential_set,
    integrator_skills_install, integrator_skills_overview, integrator_skills_uninstall,
};
use local_data_commands::*;
use memory_commands::*;
use plugin_preview::{integrator_skill_preview_body, integrator_skills_preview};
use queue_commands::*;
use repository_watch::{repository_watch_start, repository_watch_stop};
use runtime_setup::{
    runtime_action_plan_list, runtime_terminal_close, runtime_terminal_open,
    runtime_terminal_resize, runtime_terminal_write,
};
use settings_commands::{setting_list, setting_set};
use specialist_generator::specialist_generate;
use state::AppState;
use task_commands::*;
use tauri::Manager;

/// `--broker-mcp` mode: run the stdio MCP bridge instead of the app. Spawned
/// by provider CLIs; must never touch Tauri or the local store.
pub fn run_broker_mcp() -> i32 {
    broker_mcp::run()
}

/// `--antigravity-hook` mode: observe one official Agy lifecycle event and
/// return a narrow permission decision without starting Tauri.
pub fn run_antigravity_hook() -> i32 {
    antigravity_hooks::run_hook()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // rustls 0.23 panics on the first TLS connection (reqwest is built with
    // rustls-no-provider) unless a process-wide crypto provider is installed.
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
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .state::<AppState>()
                    .repository_watchers
                    .lock()
                    .expect("repository watcher registry lock")
                    .remove_window(window.label());
            }
        })
        .setup(|app| {
            let state = AppState::initialize().map_err(|error| {
                let boxed: Box<dyn std::error::Error> = Box::new(error);
                boxed
            })?;
            integrator_mcp::ensure_configuration_revision(&state.store).map_err(|error| {
                let boxed: Box<dyn std::error::Error> = Box::new(error);
                boxed
            })?;
            integrator_skills::prune_projections(&state.data_directory);
            integrator_mcp::prune_projections(&state.data_directory);
            if let Ok(documents) = app.path().document_dir() {
                let retention = state
                    .store
                    .get_setting("settings.diagnostics.retention")
                    .ok()
                    .flatten()
                    .and_then(|setting| setting.value.as_str().map(str::to_owned))
                    .unwrap_or_else(|| "7d".into());
                if let Err(error) = crate::diagnostic_log::prune_logs(
                    &documents,
                    crate::diagnostic_log::parse_retention(&retention),
                ) {
                    eprintln!("diagnostic log prune failed: {error}");
                }
            }
            app.manage(state);
            if let Err(error) = integrator_skills::ensure_roots(app.handle()) {
                eprintln!("skills root creation failed: {error}");
            }
            if let Err(error) = delegation::prune_stale_mcp_configs(app.handle()) {
                eprintln!("delegation broker config cleanup failed: {error}");
            }
            delegation::start_broker_host(app.handle().clone());
            delegation::emit_recovered_delegation_updates(app.handle());
            automations::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_bootstrap,
            open_external_url,
            open_task_window,
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
            task_list_archived,
            task_search_messages,
            task_context_reference_list,
            memory_list,
            memory_create,
            memory_update,
            memory_set_enabled,
            memory_delete,
            task_set_state,
            task_update_metadata,
            task_generate_title,
            task_update_routing,
            task_fork,
            task_truncate_from,
            task_remove,
            setting_list,
            setting_set,
            integrator_skills_overview,
            integrator_skills_install,
            integrator_skills_uninstall,
            integrator_skills_preview,
            integrator_skill_preview_body,
            integrator_skill_body,
            integrator_skill_credential_set,
            integrator_skill_credential_clear,
            integrator_mcp_overview,
            integrator_mcp_save,
            integrator_mcp_remove,
            integrator_mcp_import,
            integrator_mcp_credential_set,
            integrator_mcp_credential_clear,
            integrator_mcp_oauth_connect,
            integrator_mcp_oauth_disconnect,
            session_list,
            local_export,
            local_clear,
            storage_totals,
            usage_summary,
            voice_typing_credential_status,
            voice_typing_credential_set,
            voice_typing_credential_clear,
            voice_typing_transcribe,
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
            repository_watch_start,
            repository_watch_stop,
            selection_explain,
            selection_explain_preview,
            project_file_opener_list,
            project_file_open,
            project_file_reveal,
            project_file_duplicate,
            project_path_resolve,
            path_reveal,
            task_reveal,
            task_working_directory,
            logs_open_folder,
            logs_totals,
            logs_clear,
            logs_prune,
            diagnostics_report,
            attachment_preview,
            chat_attachment_pick,
            attachment_save_paste,
            git_status,
            git_tracked_paths,
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
            terminal_write,
            terminal_resize,
            terminal_interrupt,
            terminal_has_foreground_process,
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
            grok_list_models,
            antigravity_list_models,
            claude_list_models,
            codex_list_threads,
            codex_read_thread,
            codex_start_thread,
            codex_resume_thread,
            codex_start_turn,
            codex_interrupt_turn,
            codex_steer_turn,
            task_snapshot,
            codex_respond_approval,
            acp_respond_question,
            codex_stop_turn,
            acp_connect,
            acp_start_session,
            acp_resume_session,
            acp_send_turn,
            acp_set_config_option,
            acp_set_mode,
            acp_list_cursor_models,
            acp_session_capabilities,
            structured_cli_start_turn,
            delegation_list,
            delegation_approve,
            delegation_deny,
            delegation_send_message,
            delegation_stop_cmd,
            specialist_generate,
            automation_list,
            automation_create,
            automation_update,
            automation_run_list,
            automation_timeline,
            automation_pending_dispatches,
            automation_set_paused,
            automation_cancel,
            automation_run_now,
            automation_finish_run,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AI Integrator");
}
