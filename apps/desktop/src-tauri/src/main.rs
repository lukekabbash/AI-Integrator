#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Provider CLIs spawn this same executable as a stdio MCP server for the
    // delegation broker; that mode must never start Tauri or open windows.
    if std::env::args().any(|argument| argument == "--broker-mcp") {
        std::process::exit(ai_integrator_desktop_lib::run_broker_mcp());
    }
    if std::env::args().any(|argument| argument == "--antigravity-hook") {
        std::process::exit(ai_integrator_desktop_lib::run_antigravity_hook());
    }
    ai_integrator_desktop_lib::run();
}
