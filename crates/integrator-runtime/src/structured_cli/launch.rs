use std::path::PathBuf;

use serde_json::Value;

use super::{StructuredCliLaunchOptions, StructuredCliProvider, StructuredPermissionMode};

/// Effort levels `claude --effort` accepts. Unknown values are dropped rather
/// than forwarded so a stale UI value cannot fail the whole turn.
const CLAUDE_EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// Session settings that `--setting-sources` cannot turn off. Official Agent
/// SDK docs list auto memory and claude.ai MCP connectors as still loading
/// after an empty setting-sources list. Servers passed via `--mcp-config` are
/// unaffected by `disableClaudeAiConnectors`.
pub(super) const CLAUDE_CHAT_SESSION_SETTINGS: &str =
    r#"{"disableClaudeAiConnectors":true,"autoMemoryEnabled":false}"#;

/// Process env that backs the Chat `--settings` keys. `ENABLE_CLAUDEAI_MCP_SERVERS`
/// is the documented env form of `disableClaudeAiConnectors`;
/// `CLAUDE_CODE_DISABLE_AUTO_MEMORY` is the documented env form of
/// `autoMemoryEnabled: false`. Both are set so a CLI that honors only one
/// surface still isolates Chat.
pub(super) const CLAUDE_CHAT_ISOLATION_ENV: &[(&str, &str)] = &[
    ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1"),
    ("ENABLE_CLAUDEAI_MCP_SERVERS", "false"),
];

/// Maps a UI effort id to the capitalized suffix agy's display-style model
/// names use ("Gemini 3.1 Pro (High)"). Unknown values are dropped so a stale
/// UI value cannot fail the whole turn (agy validates `--model` and rejects
/// unknown selections with an error).
fn antigravity_effort_suffix(effort: &Option<String>) -> Option<&'static str> {
    match effort.as_deref()? {
        "low" => Some("Low"),
        "medium" => Some("Medium"),
        "high" => Some("High"),
        _ => None,
    }
}

/// Composes the selected effort into an agy `--model` value. Current live
/// catalogs use display names ("Gemini 3.5 Flash (High)"), while older builds
/// emitted effort-suffixed slugs (`gemini-3.6-flash-low`). An exact display
/// variant or slug that already carries a suffix passes through unchanged.
fn antigravity_model_arg(model: &str, effort: &Option<String>) -> String {
    if model.contains(' ') {
        // Persisted routes from older app builds may still contain the full
        // catalog value. Parenthetical variants such as `(Thinking)` are also
        // exact names, so neither should receive a second suffix.
        if model.ends_with(')') && model.contains(" (") {
            return model.to_owned();
        }
        return match antigravity_effort_suffix(effort) {
            Some(suffix) => format!("{model} ({suffix})"),
            None => model.to_owned(),
        };
    }
    let already_leveled = ["low", "medium", "high"]
        .iter()
        .any(|level| model.ends_with(&format!("-{level}")));
    match effort.as_deref() {
        Some(level @ ("low" | "medium" | "high")) if !already_leveled => {
            format!("{model}-{level}")
        }
        _ => model.to_owned(),
    }
}

pub(super) fn provider_args(options: &StructuredCliLaunchOptions) -> Vec<String> {
    let mut args = match options.provider {
        StructuredCliProvider::Claude => {
            let mut args: Vec<String> = vec![
                "--print".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--verbose".into(),
                "--include-partial-messages".into(),
                // The prompt is delivered as a stream-json user message so
                // stdin can double as the permission control channel.
                "--input-format".into(),
                "stream-json".into(),
                "--permission-mode".into(),
                match options.permission_mode {
                    StructuredPermissionMode::Prompt => "manual",
                    StructuredPermissionMode::ReadOnly => "plan",
                    StructuredPermissionMode::Chat => "dontAsk",
                    StructuredPermissionMode::AcceptEdits => "acceptEdits",
                    StructuredPermissionMode::BypassPermissions => "bypassPermissions",
                }
                .into(),
            ];
            if !matches!(
                options.permission_mode,
                StructuredPermissionMode::BypassPermissions
            ) {
                // Route permission prompts over stdio control requests so the
                // UI can render approval popups instead of tools being
                // silently denied in print mode.
                args.extend(["--permission-prompt-tool".into(), "stdio".into()]);
            }
            for plugin_dir in &options.plugin_dirs {
                args.extend([
                    "--plugin-dir".into(),
                    plugin_dir.to_string_lossy().into_owned(),
                ]);
            }
            if let Some(instructions) = options
                .system_instructions
                .as_deref()
                .filter(|instructions| !instructions.is_empty())
            {
                args.extend(["--append-system-prompt".into(), instructions.into()]);
            }
            if options.permission_mode == StructuredPermissionMode::Chat {
                // Chat isolation has to keep two things that the obvious
                // "lock it down" flags each drop:
                //
                // * `--safe-mode` / CLAUDE_CODE_SAFE_MODE disables MCP
                //   servers, including `--mcp-config`. The Chat prompt then
                //   advertises Integrator browser/scheduling tools that never
                //   appear in the model's tool list.
                // * `--bare` / CLAUDE_CODE_SIMPLE keeps `--mcp-config` but
                //   refuses OAuth and the keychain, so Chat cannot use the
                //   user's Claude login.
                //
                // The documented replacement is `settingSources: []` on the
                // CLI (`--setting-sources` with an empty list): no
                // user/project/local settings, CLAUDE.md, skills, hooks, or
                // commands. Subscription auth and `--mcp-config` still work.
                // `--tools ""` strips built-ins only; MCP is unaffected.
                // `--settings` covers auto memory and claude.ai connectors,
                // which an empty setting-sources list does not control.
                args.extend([
                    "--tools".into(),
                    String::new(),
                    "--disable-slash-commands".into(),
                    "--no-chrome".into(),
                    "--setting-sources".into(),
                    String::new(),
                    "--settings".into(),
                    CLAUDE_CHAT_SESSION_SETTINGS.into(),
                ]);
            }
            args
        }
        // The prompt reaches `agy` over piped stdin (print mode activates on
        // non-TTY stdin without `-p`), keeping prompt text off the command
        // line. `--mode` accepts only `plan` and `accept-edits`; the default
        // request-review mode is agy's own prompt-for-approval behavior.
        StructuredCliProvider::Antigravity => {
            let mut args = vec!["--output-format".into(), "json".into()];
            // Every first turn receives an exact project instead of falling
            // into agy's empty default project. Resumed turns use
            // `--conversation` below and retain the original project.
            if options.resume_session_id.is_none() {
                args.push("--new-project".into());
            }
            args.push("--sandbox".into());
            if let Some(overlay) = options.control_overlay.as_deref() {
                args.extend(["--add-dir".into(), overlay.to_string_lossy().into_owned()]);
            }
            // Projected skill bundles: readable inside the sandbox so the
            // skill index injected into the prompt can be followed.
            for plugin_dir in &options.plugin_dirs {
                args.extend([
                    "--add-dir".into(),
                    plugin_dir.to_string_lossy().into_owned(),
                ]);
            }
            match options.permission_mode {
                // agy print mode has no control channel to answer its default
                // request-review prompts; callers must not route "ask" here.
                // Auto is AcceptEdits plus the PreToolUse mailbox, not Prompt.
                StructuredPermissionMode::Prompt => {}
                StructuredPermissionMode::ReadOnly => {
                    args.extend(["--mode".into(), "plan".into()]);
                }
                StructuredPermissionMode::Chat => {
                    args.extend(["--mode".into(), "plan".into()]);
                }
                StructuredPermissionMode::AcceptEdits => {
                    args.extend(["--mode".into(), "accept-edits".into()]);
                }
                StructuredPermissionMode::BypassPermissions => {
                    args.push("--dangerously-skip-permissions".into());
                }
            }
            args
        }
    };
    if let Some(model) = options
        .model
        .as_deref()
        .filter(|value| !value.is_empty() && *value != "provider-default")
    {
        let model = match options.provider {
            // agy's catalog encodes the reasoning level in the model id
            // itself, so the selected effort composes into the `--model`
            // value (slug or legacy display-name form).
            StructuredCliProvider::Antigravity => antigravity_model_arg(model, &options.effort),
            StructuredCliProvider::Claude => model.to_owned(),
        };
        args.extend(["--model".into(), model]);
    }
    if matches!(options.provider, StructuredCliProvider::Claude)
        && let Some(effort) = options
            .effort
            .as_deref()
            .filter(|value| CLAUDE_EFFORT_LEVELS.contains(value))
    {
        args.extend(["--effort".into(), effort.into()]);
    }
    if let Some(session) = options
        .resume_session_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        let resume_flag = match options.provider {
            StructuredCliProvider::Claude => "--resume",
            StructuredCliProvider::Antigravity => "--conversation",
        };
        args.extend([resume_flag.into(), session.into()]);
    }
    if matches!(options.provider, StructuredCliProvider::Claude)
        && let Some(mcp_config) = options.mcp_config_path.as_deref()
    {
        // `--allowed-tools mcp__integrator` pre-approves the injected
        // broker server's tools; print mode has no interactive prompt to
        // approve them otherwise.
        args.extend([
            "--mcp-config".into(),
            mcp_config.to_string_lossy().into_owned(),
            "--strict-mcp-config".into(),
            "--allowed-tools".into(),
            "mcp__integrator".into(),
        ]);
    }
    args
}

const STRUCTURED_IMAGE_MAX_BYTES: u64 = 12 * 1024 * 1024;

fn structured_image_mime(path: &std::path::Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())?
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

pub(super) fn claude_user_content(prompt: &str, image_paths: &[PathBuf]) -> Value {
    if image_paths.is_empty() {
        return Value::String(prompt.to_owned());
    }
    let mut blocks = vec![serde_json::json!({
        "type": "text",
        "text": prompt,
    })];
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    for path in image_paths {
        let Some(mime) = structured_image_mime(path) else {
            continue;
        };
        let Ok(metadata) = std::fs::metadata(path) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > STRUCTURED_IMAGE_MAX_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        blocks.push(serde_json::json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": mime,
                "data": STANDARD.encode(bytes),
            }
        }));
    }
    Value::Array(blocks)
}

pub(super) fn antigravity_prompt_with_images(prompt: &str, image_paths: &[PathBuf]) -> String {
    if image_paths.is_empty() {
        return prompt.to_owned();
    }
    let mut lines = vec![
        prompt.to_owned(),
        String::new(),
        "User-selected images supplied as multimodal workspace context:".into(),
    ];
    for path in image_paths {
        if path.is_file() {
            let rendered = path.to_string_lossy();
            if !rendered.contains('{') && !rendered.contains('}') {
                lines.push(format!("- @{{{rendered}}}"));
            }
        }
    }
    lines.join("\n")
}
