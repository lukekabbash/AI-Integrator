use super::*;

#[test]
fn provider_arguments_keep_prompts_off_the_command_line() {
    for provider in [
        StructuredCliProvider::Claude,
        StructuredCliProvider::Antigravity,
    ] {
        let args = provider_args(&StructuredCliLaunchOptions {
            provider,
            executable: "agent".into(),
            working_directory: ".".into(),
            model: None,
            effort: Some("high".into()),
            system_instructions: None,
            resume_session_id: Some("session-1".into()),
            permission_mode: StructuredPermissionMode::ReadOnly,
            mcp_config_path: None,
            control_overlay: None,
            plugin_dirs: Vec::new(),
        });
        assert!(!args.iter().any(|arg| arg.contains("secret prompt")));
        let has_effort = args
            .windows(2)
            .any(|w| w[0] == "--effort" && w[1] == "high");
        assert_eq!(has_effort, provider == StructuredCliProvider::Claude);
        match provider {
            StructuredCliProvider::Claude => {
                assert!(args.iter().any(|arg| arg == "stream-json"));
                assert!(
                    args.windows(2)
                        .any(|w| w[0] == "--resume" && w[1] == "session-1")
                );
            }
            StructuredCliProvider::Antigravity => {
                assert!(
                    args.windows(2)
                        .any(|w| w[0] == "--output-format" && w[1] == "json")
                );
                assert!(args.windows(2).any(|w| w[0] == "--mode" && w[1] == "plan"));
                assert!(
                    args.windows(2)
                        .any(|w| w[0] == "--conversation" && w[1] == "session-1")
                );
                // Print mode is activated by piped stdin; `-p` would stop
                // agy from reading the prompt off stdin.
                assert!(!args.iter().any(|arg| arg == "-p" || arg == "--print"));
            }
        }
        assert!(!args.iter().any(|arg| arg == "yolo"
            || arg == "bypassPermissions"
            || arg == "--dangerously-skip-permissions"));
    }
}

#[test]
fn claude_harness_policy_uses_the_native_system_prompt_layer() {
    let options = |provider| StructuredCliLaunchOptions {
        provider,
        executable: "agent".into(),
        working_directory: ".".into(),
        model: None,
        effort: None,
        system_instructions: Some("durable harness policy".into()),
        resume_session_id: None,
        permission_mode: StructuredPermissionMode::ReadOnly,
        mcp_config_path: None,
        control_overlay: None,
        plugin_dirs: Vec::new(),
    };
    let claude = provider_args(&options(StructuredCliProvider::Claude));
    assert!(claude.windows(2).any(|pair| {
        pair[0] == "--append-system-prompt" && pair[1] == "durable harness policy"
    }));
    let antigravity = provider_args(&options(StructuredCliProvider::Antigravity));
    assert!(
        !antigravity
            .iter()
            .any(|argument| argument == "--append-system-prompt")
    );
}

#[test]
fn chat_mode_removes_claude_coding_tools_and_keeps_antigravity_in_plan() {
    let options = |provider| StructuredCliLaunchOptions {
        provider,
        executable: "agent".into(),
        working_directory: ".".into(),
        model: None,
        effort: None,
        system_instructions: Some("Chat policy".into()),
        resume_session_id: None,
        permission_mode: StructuredPermissionMode::Chat,
        mcp_config_path: Some("/app/chat-mcp.json".into()),
        control_overlay: None,
        plugin_dirs: Vec::new(),
    };
    let claude = provider_args(&options(StructuredCliProvider::Claude));
    assert!(
        claude
            .windows(2)
            .any(|pair| pair[0] == "--permission-mode" && pair[1] == "dontAsk")
    );
    assert!(
        claude
            .windows(2)
            .any(|pair| pair[0] == "--tools" && pair[1].is_empty())
    );
    assert!(
        claude
            .iter()
            .any(|argument| argument == "--disable-slash-commands")
    );
    assert!(claude.iter().any(|argument| argument == "--no-chrome"));
    assert!(
        claude
            .windows(2)
            .any(|pair| pair[0] == "--setting-sources" && pair[1].is_empty())
    );
    assert!(
        claude
            .windows(2)
            .any(|pair| { pair[0] == "--settings" && pair[1] == CLAUDE_CHAT_SESSION_SETTINGS })
    );
    assert!(!claude.iter().any(|argument| argument == "--safe-mode"));
    assert!(!claude.iter().any(|argument| argument == "--bare"));
    assert!(
        claude
            .iter()
            .any(|argument| argument == "--strict-mcp-config")
    );
    assert!(
        claude
            .windows(2)
            .any(|pair| pair[0] == "--allowed-tools" && pair[1] == "mcp__integrator")
    );

    let antigravity = provider_args(&options(StructuredCliProvider::Antigravity));
    assert!(
        antigravity
            .windows(2)
            .any(|pair| pair[0] == "--mode" && pair[1] == "plan")
    );
    assert!(
        !antigravity
            .iter()
            .any(|argument| argument == "--dangerously-skip-permissions")
    );
}

#[test]
fn claude_chat_isolation_keeps_mcp_config_and_drops_safe_mode() {
    let chat = provider_args(&StructuredCliLaunchOptions {
        provider: StructuredCliProvider::Claude,
        executable: "claude".into(),
        working_directory: ".".into(),
        model: None,
        effort: None,
        system_instructions: Some("Chat policy".into()),
        resume_session_id: None,
        permission_mode: StructuredPermissionMode::Chat,
        mcp_config_path: Some("/app/chat-mcp.json".into()),
        control_overlay: None,
        plugin_dirs: Vec::new(),
    });
    assert!(
        chat.windows(2)
            .any(|pair| { pair[0] == "--mcp-config" && pair[1] == "/app/chat-mcp.json" })
    );
    assert!(
        chat.windows(2)
            .any(|pair| pair[0] == "--allowed-tools" && pair[1] == "mcp__integrator")
    );
    assert!(chat.contains(&"--append-system-prompt".to_owned()));
    // Empty setting-sources is the documented `settingSources: []` form.
    // `--safe-mode` would drop this MCP file; `--bare` would drop login.
    assert!(!chat.iter().any(|argument| argument == "--safe-mode"));
    assert!(!chat.iter().any(|argument| argument == "--bare"));
    assert!(CLAUDE_CHAT_SESSION_SETTINGS.contains("disableClaudeAiConnectors"));
    assert!(CLAUDE_CHAT_SESSION_SETTINGS.contains("autoMemoryEnabled"));
    assert_eq!(
        CLAUDE_CHAT_ISOLATION_ENV,
        [
            ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1"),
            ("ENABLE_CLAUDEAI_MCP_SERVERS", "false"),
        ]
        .as_slice()
    );

    let task = provider_args(&StructuredCliLaunchOptions {
        provider: StructuredCliProvider::Claude,
        executable: "claude".into(),
        working_directory: ".".into(),
        model: None,
        effort: None,
        system_instructions: Some("durable harness policy".into()),
        resume_session_id: None,
        permission_mode: StructuredPermissionMode::AcceptEdits,
        mcp_config_path: Some("/app/task-mcp.json".into()),
        control_overlay: None,
        plugin_dirs: Vec::new(),
    });
    assert!(!task.iter().any(|argument| argument == "--setting-sources"));
    assert!(!task.iter().any(|argument| argument == "--settings"));
    assert!(!task.iter().any(|argument| argument == "--tools"));
    assert!(
        task.windows(2)
            .any(|pair| { pair[0] == "--mcp-config" && pair[1] == "/app/task-mcp.json" })
    );
}

#[test]
fn plugin_dirs_project_per_provider_mechanism() {
    for provider in [
        StructuredCliProvider::Claude,
        StructuredCliProvider::Antigravity,
    ] {
        let args = provider_args(&StructuredCliLaunchOptions {
            provider,
            executable: "agent".into(),
            working_directory: ".".into(),
            model: None,
            effort: None,
            system_instructions: None,
            resume_session_id: None,
            permission_mode: StructuredPermissionMode::AcceptEdits,
            mcp_config_path: None,
            control_overlay: None,
            plugin_dirs: vec!["/private/tmp/overlay/gov-data".into()],
        });
        let has_plugin_dir = args
            .windows(2)
            .any(|w| w[0] == "--plugin-dir" && w[1] == "/private/tmp/overlay/gov-data");
        let has_add_dir = args
            .windows(2)
            .any(|w| w[0] == "--add-dir" && w[1] == "/private/tmp/overlay/gov-data");
        // Claude loads bundles natively; Antigravity gets sandbox read
        // access and follows the prompt-injected index instead.
        assert_eq!(has_plugin_dir, provider == StructuredCliProvider::Claude);
        assert_eq!(has_add_dir, provider == StructuredCliProvider::Antigravity);
    }
}

#[test]
fn prompt_mode_wires_the_stdio_permission_channel_for_claude() {
    let options = |mode| StructuredCliLaunchOptions {
        provider: StructuredCliProvider::Claude,
        executable: "claude".into(),
        working_directory: ".".into(),
        model: None,
        effort: None,
        system_instructions: None,
        resume_session_id: None,
        permission_mode: mode,
        mcp_config_path: None,
        control_overlay: None,
        plugin_dirs: Vec::new(),
    };
    for mode in [
        StructuredPermissionMode::Prompt,
        StructuredPermissionMode::ReadOnly,
        StructuredPermissionMode::AcceptEdits,
    ] {
        let args = provider_args(&options(mode));
        assert!(
            args.windows(2)
                .any(|w| w[0] == "--input-format" && w[1] == "stream-json")
        );
        assert!(
            args.windows(2)
                .any(|w| w[0] == "--permission-prompt-tool" && w[1] == "stdio")
        );
    }
    let args = provider_args(&options(StructuredPermissionMode::Prompt));
    assert!(
        args.windows(2)
            .any(|w| w[0] == "--permission-mode" && w[1] == "manual")
    );
}

#[test]
fn mcp_config_injects_broker_flags_for_claude_only() {
    let options = |provider| StructuredCliLaunchOptions {
        provider,
        executable: "agent".into(),
        working_directory: ".".into(),
        model: None,
        effort: None,
        system_instructions: None,
        resume_session_id: None,
        permission_mode: StructuredPermissionMode::AcceptEdits,
        mcp_config_path: Some("C:/data/broker-mcp/orchestrator-task.json".into()),
        control_overlay: None,
        plugin_dirs: Vec::new(),
    };
    let claude = provider_args(&options(StructuredCliProvider::Claude));
    assert!(claude.windows(2).any(|w| w[0] == "--mcp-config"));
    assert!(
        claude
            .windows(2)
            .any(|w| w[0] == "--allowed-tools" && w[1] == "mcp__integrator")
    );
    let agy = provider_args(&options(StructuredCliProvider::Antigravity));
    assert!(!agy.iter().any(|arg| arg == "--mcp-config"));
}

#[test]
fn full_access_maps_to_each_providers_bypass_flag() {
    let options = |provider| StructuredCliLaunchOptions {
        provider,
        executable: "agent".into(),
        working_directory: ".".into(),
        model: None,
        effort: None,
        system_instructions: None,
        resume_session_id: None,
        permission_mode: StructuredPermissionMode::BypassPermissions,
        mcp_config_path: None,
        control_overlay: None,
        plugin_dirs: Vec::new(),
    };
    let claude = provider_args(&options(StructuredCliProvider::Claude));
    assert!(
        claude
            .windows(2)
            .any(|w| w[0] == "--permission-mode" && w[1] == "bypassPermissions")
    );
    // Bypass mode never prompts, so no control channel is requested.
    assert!(!claude.iter().any(|arg| arg == "--permission-prompt-tool"));
    let agy = provider_args(&options(StructuredCliProvider::Antigravity));
    assert!(
        agy.iter()
            .any(|arg| arg == "--dangerously-skip-permissions")
    );
}

#[test]
fn parses_claude_can_use_tool_control_request() {
    let line = r#"{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"curl -s https://example.com"},"description":"Fetch example.com","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"curl -s https://example.com"}],"behavior":"allow","destination":"localSettings"}],"tool_use_id":"toolu_1"}}"#;
    let events = parse_provider_line(StructuredCliProvider::Claude, line);
    assert_eq!(events.len(), 1);
    let StructuredCliEventKind::PermissionRequest {
        request_id,
        tool_use_id,
        tool_name,
        input,
        description,
        suggestions,
    } = &events[0].event
    else {
        panic!("expected permission request, got {:?}", events[0].event);
    };
    assert_eq!(request_id, "req-1");
    assert_eq!(tool_use_id, "toolu_1");
    assert_eq!(tool_name, "Bash");
    assert_eq!(
        input.pointer("/command").and_then(Value::as_str),
        Some("curl -s https://example.com")
    );
    assert_eq!(description.as_deref(), Some("Fetch example.com"));
    assert!(suggestions.is_array());
    // The initialize acknowledgement must not leak into the event stream.
    let ack = r#"{"type":"control_response","response":{"subtype":"success","request_id":"integrator-init","response":{}}}"#;
    assert!(parse_provider_line(StructuredCliProvider::Claude, ack).is_empty());
}

#[test]
fn parses_claude_permission_mode_status() {
    // Observed live: the CLI reports mode transitions (e.g. after an
    // approved ExitPlanMode) as system/status with a permissionMode.
    let retry = r#"{"type":"system","subtype":"api_retry","attempt":2,"max_attempts":10,"error":"overloaded_error","session_id":"sess-1"}"#;
    let events = parse_provider_line(StructuredCliProvider::Claude, retry);
    assert_eq!(events.len(), 1);
    match &events[0].event {
        StructuredCliEventKind::Diagnostic { message } => {
            assert!(message.contains("attempt 2 of 10"), "got: {message}");
            assert!(message.contains("overloaded_error"), "got: {message}");
        }
        other => panic!("expected Diagnostic, got {other:?}"),
    }

    let line = r#"{"type":"system","subtype":"status","status":null,"permissionMode":"acceptEdits","session_id":"sess-1"}"#;
    let events = parse_provider_line(StructuredCliProvider::Claude, line);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].session_id.as_deref(), Some("sess-1"));
    assert!(matches!(
        &events[0].event,
        StructuredCliEventKind::PermissionModeChanged { mode } if mode == "acceptEdits"
    ));
    // A status without a permission mode carries nothing to project.
    let bare = r#"{"type":"system","subtype":"status","status":"compacting"}"#;
    assert!(parse_provider_line(StructuredCliProvider::Claude, bare).is_empty());
}

#[test]
fn parses_claude_exit_plan_mode_permission_request_with_plan() {
    // Observed live: ExitPlanMode arrives as can_use_tool with the full
    // plan markdown in the tool input.
    let line = r##"{"type":"control_request","request_id":"req-2","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","display_name":"ExitPlanMode","input":{"plan":"# Plan\n\nAdd power(a, b).","planFilePath":"C:\\plans\\p.md"},"tool_use_id":"toolu_2","requires_user_interaction":true}}"##;
    let events = parse_provider_line(StructuredCliProvider::Claude, line);
    assert_eq!(events.len(), 1);
    let StructuredCliEventKind::PermissionRequest {
        tool_name, input, ..
    } = &events[0].event
    else {
        panic!("expected permission request, got {:?}", events[0].event);
    };
    assert_eq!(tool_name, "ExitPlanMode");
    assert_eq!(
        input.pointer("/plan").and_then(Value::as_str),
        Some("# Plan\n\nAdd power(a, b).")
    );
}

#[test]
fn parses_claude_happy_and_auth_failure_fixtures() {
    let happy = include_str!("../../fixtures/claude-stream-happy.jsonl");
    let events: Vec<_> = happy
        .lines()
        .flat_map(|line| parse_provider_line(StructuredCliProvider::Claude, line))
        .collect();
    assert!(matches!(
        events[0].event,
        StructuredCliEventKind::Init { .. }
    ));
    assert!(events.iter().any(
        |item| matches!(&item.event, StructuredCliEventKind::Text { text, .. } if text == "OK")
    ));
    assert!(events.iter().any(|item| matches!(
        &item.event,
        StructuredCliEventKind::Result { success: true, usage, .. }
            if usage.input_tokens == Some(4)
                && usage.cached_input_tokens == Some(2)
                && usage.cache_creation_input_tokens == Some(3)
                && usage.output_tokens == Some(1)
                && usage.cost_micro_usd == Some(12_500)
    )));
    let failure = include_str!("../../fixtures/claude-stream-auth-failure.jsonl");
    let event = failure
        .lines()
        .flat_map(|line| parse_provider_line(StructuredCliProvider::Claude, line))
        .next()
        .expect("result");
    assert!(matches!(
        event.event,
        StructuredCliEventKind::Result { success: false, .. }
    ));
}

#[test]
fn parses_every_claude_tool_result_block() {
    let line = r#"{"type":"user","session_id":"sess-1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"read output"},{"type":"tool_result","tool_use_id":"tool-2","content":[{"type":"text","text":"exit 7"}],"is_error":true}]}}"#;
    let events = parse_provider_line(StructuredCliProvider::Claude, line);
    assert_eq!(events.len(), 2);
    assert!(matches!(
        &events[0],
        ParsedEvent {
            session_id: Some(session_id),
            event: StructuredCliEventKind::ToolResult { id, is_error: false, content }
        } if session_id == "sess-1" && id == "tool-1" && content == "read output"
    ));
    assert!(matches!(
        &events[1].event,
        StructuredCliEventKind::ToolResult { id, is_error: true, content }
            if id == "tool-2" && content == "exit 7"
    ));
}

#[test]
fn parses_all_displayable_claude_assistant_blocks_and_ignores_thinking() {
    let line = r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hidden"},{"type":"text","text":"Checking."},{"type":"tool_use","id":"tool-1","name":"Read","input":{"file_path":"alpha.txt"}}]}}"#;
    let events = parse_provider_line(StructuredCliProvider::Claude, line);
    assert_eq!(events.len(), 2);
    assert!(matches!(
        &events[0].event,
        StructuredCliEventKind::Text { text, delta: false } if text == "Checking."
    ));
    assert!(matches!(
        &events[1].event,
        StructuredCliEventKind::ToolUse { id, name, .. }
            if id == "tool-1" && name == "Read"
    ));
}

#[test]
fn antigravity_images_use_workspace_multimodal_references() {
    let root = std::env::temp_dir().join(format!("agy-image-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).expect("create image fixture directory");
    let image = root.join("screenshot.png");
    std::fs::write(&image, [0x89, 0x50, 0x4e, 0x47]).expect("write image fixture");

    let prompt = antigravity_prompt_with_images("Describe this", std::slice::from_ref(&image));
    assert!(prompt.starts_with("Describe this\n"));
    assert!(prompt.contains(&format!("@{{{}}}", image.display())));

    std::fs::remove_dir_all(root).expect("clean up image fixture directory");
}

#[test]
fn antigravity_effort_composes_into_the_model_name() {
    let options = |model: Option<&str>, effort: Option<&str>| StructuredCliLaunchOptions {
        provider: StructuredCliProvider::Antigravity,
        executable: "agy".into(),
        working_directory: ".".into(),
        model: model.map(str::to_owned),
        effort: effort.map(str::to_owned),
        system_instructions: None,
        resume_session_id: None,
        permission_mode: StructuredPermissionMode::Prompt,
        mcp_config_path: None,
        control_overlay: None,
        plugin_dirs: Vec::new(),
    };
    let model_arg = |args: Vec<String>| {
        args.windows(2)
            .find(|w| w[0] == "--model")
            .map(|w| w[1].clone())
    };
    assert_eq!(
        model_arg(provider_args(&options(
            Some("Gemini 3.1 Pro"),
            Some("high")
        ))),
        Some("Gemini 3.1 Pro (High)".into())
    );
    assert_eq!(
        model_arg(provider_args(&options(Some("Gemini 3.1 Pro"), None))),
        Some("Gemini 3.1 Pro".into())
    );
    // The isolated helper path (chat titles, commit messages) pins "low".
    assert_eq!(
        model_arg(provider_args(&options(
            Some("Gemini 3.5 Flash"),
            Some("low")
        ))),
        Some("Gemini 3.5 Flash (Low)".into())
    );
    // Unknown effort ids must not mutate the model string.
    assert_eq!(
        model_arg(provider_args(&options(
            Some("Gemini 3.1 Pro"),
            Some("xhigh")
        ))),
        Some("Gemini 3.1 Pro".into())
    );
    // No model selected: nothing to compose, no --model at all.
    assert_eq!(model_arg(provider_args(&options(None, Some("high")))), None);
    // Live-discovered slug ids compose effort as a `-level` suffix.
    assert_eq!(
        model_arg(provider_args(&options(
            Some("gemini-3.6-flash"),
            Some("medium")
        ))),
        Some("gemini-3.6-flash-medium".into())
    );
    // A slug that already carries its level never double-composes.
    assert_eq!(
        model_arg(provider_args(&options(
            Some("gemini-3.6-flash-low"),
            Some("high")
        ))),
        Some("gemini-3.6-flash-low".into())
    );
    // Persisted exact display variants never receive a second effort suffix.
    assert_eq!(
        model_arg(provider_args(&options(
            Some("Gemini 3.5 Flash (High)"),
            Some("low")
        ))),
        Some("Gemini 3.5 Flash (High)".into())
    );
    assert_eq!(
        model_arg(provider_args(&options(
            Some("Claude Sonnet 4.6 (Thinking)"),
            Some("high")
        ))),
        Some("Claude Sonnet 4.6 (Thinking)".into())
    );
    // Slugs without effort support pass through untouched.
    assert_eq!(
        model_arg(provider_args(&options(
            Some("claude-opus-4-6-thinking"),
            None
        ))),
        Some("claude-opus-4-6-thinking".into())
    );
    assert_eq!(
        model_arg(provider_args(&options(
            Some("claude-sonnet-4-6"),
            Some("xhigh")
        ))),
        Some("claude-sonnet-4-6".into())
    );
}

#[test]
fn antigravity_launches_an_exact_sandboxed_project_and_preserves_it_on_resume() {
    let options = |resume_session_id: Option<&str>| StructuredCliLaunchOptions {
        provider: StructuredCliProvider::Antigravity,
        executable: "agy".into(),
        working_directory: "/workspace/project".into(),
        model: None,
        effort: None,
        system_instructions: None,
        resume_session_id: resume_session_id.map(str::to_owned),
        permission_mode: StructuredPermissionMode::ReadOnly,
        mcp_config_path: None,
        control_overlay: Some("/private/tmp/integrator-overlay".into()),
        plugin_dirs: Vec::new(),
    };

    let first = provider_args(&options(None));
    assert!(first.iter().any(|arg| arg == "--new-project"));
    assert!(first.iter().any(|arg| arg == "--sandbox"));
    assert!(
        first
            .windows(2)
            .any(|args| { args[0] == "--add-dir" && args[1] == "/private/tmp/integrator-overlay" })
    );
    assert!(!first.iter().any(|arg| arg == "--conversation"));

    let resumed = provider_args(&options(Some("conversation-1")));
    assert!(!resumed.iter().any(|arg| arg == "--new-project"));
    assert!(resumed.iter().any(|arg| arg == "--sandbox"));
    assert!(
        resumed
            .windows(2)
            .any(|args| { args[0] == "--conversation" && args[1] == "conversation-1" })
    );
    assert!(
        resumed
            .windows(2)
            .any(|args| { args[0] == "--add-dir" && args[1] == "/private/tmp/integrator-overlay" })
    );
}

#[test]
fn parses_antigravity_result_line() {
    // Captured verbatim from `agy --output-format json` 1.1.1.
    let line = r#"{"conversation_id":"38a63c25-14b7-486a-8806-187275193d79","status":"SUCCESS","response":"OK\n","duration_seconds":1.4183724,"num_turns":1,"usage":{"input_tokens":24727,"output_tokens":93,"thinking_tokens":87,"total_tokens":24820}}"#;
    let events = parse_provider_line(StructuredCliProvider::Antigravity, line);
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0].session_id.as_deref(),
        Some("38a63c25-14b7-486a-8806-187275193d79")
    );
    assert!(matches!(
        &events[0].event,
        StructuredCliEventKind::Text { text, delta: false } if text == "OK\n"
    ));
    assert!(matches!(
        &events[1].event,
        StructuredCliEventKind::Result { success: true, message: None, usage }
            if usage.input_tokens == Some(24727)
                && usage.output_tokens == Some(93)
                && usage.reasoning_output_tokens == Some(87)
                && usage.total_tokens == Some(24820)
                && usage.cost_micro_usd.is_none()
    ));
}

#[test]
fn parses_antigravity_error_line() {
    let line = r#"{"conversation_id":"","status":"ERROR","response":"","error":"Error: empty prompt. Usage: agy --print \"your prompt here\"","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"total_tokens":0}}"#;
    let events = parse_provider_line(StructuredCliProvider::Antigravity, line);
    assert_eq!(events.len(), 1);
    assert!(events[0].session_id.is_none());
    assert!(matches!(
        &events[0].event,
        StructuredCliEventKind::Result {
            success: false,
            message: Some(_),
            ..
        }
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn cancellation_terminates_structured_provider_descendants() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Stdio;
    use tokio::process::Command;

    let directory = tempfile::tempdir().expect("provider fixture");
    let executable = directory.path().join("fixture-agent.sh");
    std::fs::write(
        &executable,
        "#!/bin/sh\nsleep 30 &\necho $! > child.pid\nwait\n",
    )
    .expect("write provider fixture");
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700))
        .expect("make provider fixture executable");

    let client = StructuredCliClient::new();
    let mut receiver = client.subscribe();
    let turn_id = client
        .start_turn(
            StructuredCliLaunchOptions {
                provider: StructuredCliProvider::Claude,
                executable,
                working_directory: directory.path().into(),
                model: None,
                effort: None,
                system_instructions: None,
                resume_session_id: None,
                permission_mode: StructuredPermissionMode::ReadOnly,
                mcp_config_path: None,
                control_overlay: None,
                plugin_dirs: Vec::new(),
            },
            "start fixture".into(),
        )
        .await
        .expect("start provider fixture");
    let pid_path = directory.path().join("child.pid");
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !pid_path.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("descendant pid");
    let descendant = std::fs::read_to_string(&pid_path)
        .expect("read descendant pid")
        .trim()
        .to_owned();

    assert!(client.cancel(&turn_id).await.expect("cancel provider"));
    tokio::time::timeout(std::time::Duration::from_secs(4), async {
        loop {
            let event = receiver.recv().await.expect("provider event");
            if matches!(
                event.event,
                StructuredCliEventKind::Exited {
                    cancelled: true,
                    ..
                }
            ) {
                break;
            }
        }
    })
    .await
    .expect("cancelled exit");

    let still_alive = Command::new("/bin/kill")
        .args(["-0", &descendant])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .is_ok_and(|status| status.success());
    assert!(
        !still_alive,
        "structured provider descendant survived cancellation"
    );
}
