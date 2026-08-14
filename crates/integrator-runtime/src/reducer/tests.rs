use super::*;
use crate::redaction::bounded_audit;
use integrator_core::{FileChangeKind, ItemStatus};
use serde_json::json;

#[test]
fn context_primer_is_stripped_from_echoed_user_messages() {
    let event = reduce_provider_event(ProviderEventInput {
        method: "item/completed".into(),
        params: json!({ "threadId":"th1", "turnId":"tu1", "item": {
            "type":"userMessage", "id":"it1",
            "content":[{"text":"<conversation-context>\nUser: earlier\n</conversation-context>\n\nactual question"}]
        }}),
        request_id: None,
        occurred_at: Utc::now(),
    })
    .expect("reduce")
    .expect("accepted");
    assert!(matches!(
        event.mutation,
        ProjectionMutation::ReplaceItem(ItemProjection { body: Some(ref body), .. })
            if body == "actual question"
    ));
}

#[test]
fn all_leading_integrator_context_is_stripped_from_echoed_user_messages() {
    let event = reduce_provider_event(ProviderEventInput {
        method: "item/completed".into(),
        params: json!({ "threadId":"th1", "turnId":"tu1", "item": {
            "type":"userMessage", "id":"it1",
            "content":[{"text":"<ai-integrator-harness>\nprivate\n</ai-integrator-harness>\n\
                <integrator-skills>\nskills\n</integrator-skills>\n\
                <delegation>\ntools\n</delegation>\nactual question"}]
        }}),
        request_id: None,
        occurred_at: Utc::now(),
    })
    .expect("reduce")
    .expect("accepted");
    assert!(matches!(
        event.mutation,
        ProjectionMutation::ReplaceItem(ItemProjection { body: Some(ref body), .. })
            if body == "actual question"
    ));
}

#[test]
fn text_happy_path_reduces_to_agent_item() {
    let event = reduce_provider_event(ProviderEventInput {
        method: "item/completed".into(),
        params: json!({ "threadId":"th1", "turnId":"tu1", "item": { "type":"agentMessage", "id":"it1", "text":"Done" } }),
        request_id: None,
        occurred_at: Utc::now(),
    }).expect("reduce").expect("accepted");
    assert!(
        matches!(event.mutation, ProjectionMutation::ReplaceItem(ItemProjection { kind: ItemKind::AgentMessage, body: Some(ref body), .. }) if body == "Done")
    );
}

#[test]
fn agent_message_phase_is_projected_from_item_events() {
    let commentary = reduce_provider_event(ProviderEventInput {
        method: "item/started".into(),
        params: json!({
            "threadId": "th1",
            "turnId": "tu1",
            "item": {
                "type": "agentMessage",
                "id": "it-commentary",
                "text": "Working on it…",
                "phase": "commentary"
            }
        }),
        request_id: None,
        occurred_at: Utc::now(),
    })
    .expect("reduce")
    .expect("accepted");
    assert!(matches!(
        commentary.mutation,
        ProjectionMutation::ReplaceItem(ItemProjection {
            kind: ItemKind::AgentMessage,
            phase: Some(integrator_core::AgentMessagePhase::Commentary),
            ..
        })
    ));

    let final_answer = reduce_provider_event(ProviderEventInput {
        method: "item/completed".into(),
        params: json!({
            "threadId": "th1",
            "turnId": "tu1",
            "item": {
                "type": "agentMessage",
                "id": "it-final",
                "text": "Done.",
                "phase": "final_answer"
            }
        }),
        request_id: None,
        occurred_at: Utc::now(),
    })
    .expect("reduce")
    .expect("accepted");
    assert!(matches!(
        final_answer.mutation,
        ProjectionMutation::ReplaceItem(ItemProjection {
            kind: ItemKind::AgentMessage,
            phase: Some(integrator_core::AgentMessagePhase::FinalAnswer),
            ..
        })
    ));

    let unknown = reduce_provider_event(ProviderEventInput {
        method: "item/completed".into(),
        params: json!({
            "threadId": "th1",
            "turnId": "tu1",
            "item": {
                "type": "agentMessage",
                "id": "it-legacy",
                "text": "Legacy reply",
                "phase": "something_else"
            }
        }),
        request_id: None,
        occurred_at: Utc::now(),
    })
    .expect("reduce")
    .expect("accepted");
    assert!(matches!(
        unknown.mutation,
        ProjectionMutation::ReplaceItem(ItemProjection {
            kind: ItemKind::AgentMessage,
            phase: None,
            ..
        })
    ));
}

#[test]
fn legitimate_paths_and_opaque_identifiers_remain_visible() {
    assert_eq!(
        redact_text("/Users/lukekabbash/Documents/Code/integrator-3/src/App2.tsx"),
        "/Users/lukekabbash/Documents/Code/integrator-3/src/App2.tsx"
    );
    assert_eq!(
        redact_text(r"C:\Users\Luke\Documents\Integrator-3\src\App2.tsx"),
        r"C:\Users\Luke\Documents\Integrator-3\src\App2.tsx"
    );
    assert_eq!(
        redact_text("prefix AbcdefghijklmnopQRSTUVWX1234567890 suffix"),
        "prefix AbcdefghijklmnopQRSTUVWX1234567890 suffix"
    );
}

#[test]
fn model_visible_json_rpc_output_is_preserved_exactly() {
    let output = r#"{"id":1,"jsonrpc":"2.0","result":{"capabilities":{"tools":{}},"protocolVersion":"2024-11-05","serverInfo":{"name":"integrator-local-tools","version":"0.1.0"}}}"#;
    assert_eq!(redact_text(output), output);
}

#[test]
fn conservative_redaction_preserves_layout_and_non_secret_names() {
    let output =
        "  TOKEN_COUNT=2048  SECRETARY=Luke\tPASSWORD_POLICY=required\n    aligned output\n";
    assert_eq!(redact_text(output), output);
}

#[test]
fn explicit_credentials_are_still_redacted() {
    let openai_key = format!("sk-{}", "a".repeat(32));
    let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123";
    assert_eq!(
        redact_text(&format!(
            "OPENAI_API_KEY=secret Bearer bearer-value {openai_key} {jwt}"
        )),
        "OPENAI_API_KEY=[redacted] Bearer [redacted] [redacted] [redacted]"
    );
    assert_eq!(
        redact_text("  Authorization: Bearer bearer-value\r\nCookie: session=value\r\n"),
        "  Authorization: [redacted]\r\nCookie: [redacted]\r\n"
    );
}

#[test]
fn json_redaction_targets_secret_fields_without_hiding_metrics() {
    let output = r#"{"apiKey":"secret-value","tokenCount":2048,"passwordPolicy":"required"}"#;
    assert_eq!(
        redact_text(output),
        r#"{"apiKey":"[redacted]","passwordPolicy":"required","tokenCount":2048}"#
    );
}

#[test]
fn terminal_stdin_is_never_reduced() {
    let event = reduce_provider_event(ProviderEventInput {
        method: "item/commandExecution/terminalInteraction".into(),
        params: json!({"threadId":"th1","turnId":"tu1","itemId":"it1","stdin":"secret"}),
        request_id: None,
        occurred_at: Utc::now(),
    })
    .expect("reduce");
    assert!(event.is_none());
}

#[test]
fn audit_redacts_headers_env_private_keys_and_mcp_arguments() {
    let (audit, _) = bounded_audit(
        &json!({ "authorization":"Bearer abc", "env":"API_TOKEN=secret", "arguments":{"password":"secret"}, "text":"-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" }),
    );
    assert!(!audit.contains("abc"));
    assert!(!audit.contains("secret"));
    assert!(audit.contains("redacted"));
}

#[test]
fn raw_codex_reasoning_content_is_not_written_to_audit() {
    let event = reduce_provider_event(ProviderEventInput {
        method: "item/completed".into(),
        params: json!({
            "threadId": "th1",
            "turnId": "tu1",
            "item": {
                "type": "reasoning",
                "id": "reasoning-1",
                "summary": [{"text": "Safe provider summary"}],
                "content": [{"text": "Raw hidden chain of thought"}]
            }
        }),
        request_id: None,
        occurred_at: Utc::now(),
    })
    .expect("reduce")
    .expect("accepted");
    assert!(event.audit_json.contains("Safe provider summary"));
    assert!(!event.audit_json.contains("Raw hidden chain of thought"));
}

#[test]
fn empty_codex_reasoning_items_do_not_create_transcript_rows() {
    for method in ["item/started", "item/completed"] {
        let event = reduce_provider_event(ProviderEventInput {
            method: method.into(),
            params: json!({
                "threadId": "th1",
                "turnId": "tu1",
                "item": {
                    "type": "reasoning",
                    "id": "reasoning-empty",
                    "summary": [],
                    "content": []
                }
            }),
            request_id: None,
            occurred_at: Utc::now(),
        })
        .expect("reduce");
        assert!(event.is_none(), "{method} should be ignored");
    }
}

#[test]
fn acp_session_modes_parse_from_session_new_response() {
    let mode = parse_acp_mode_state(&json!({
        "sessionId": "sess-1",
        "modes": {
            "currentModeId": "agent",
            "availableModes": [
                {"id": "agent", "name": "Agent", "description": "Full agent capabilities"},
                {"id": "plan", "name": "Plan", "description": "Read-only planning"},
                {"id": "ask", "name": "Ask"}
            ]
        }
    }))
    .expect("mode state");
    assert_eq!(mode.current_mode_id, "agent");
    assert_eq!(mode.available_modes.len(), 3);
    assert_eq!(mode.available_modes[1].name, "Plan");
    assert_eq!(
        mode.available_modes[1].description.as_deref(),
        Some("Read-only planning")
    );
    assert_eq!(mode.available_modes[2].description, None);
}

#[test]
fn acp_session_modes_parse_from_config_options() {
    let mode = parse_acp_mode_state(&json!({
        "sessionId": "sess-kimi",
        "configOptions": [{
            "type": "select",
            "id": "mode",
            "category": "mode",
            "currentValue": "default",
            "options": [
                {"value": "default", "name": "Default", "description": "Manual approvals"},
                {"value": "plan", "name": "Plan", "description": "Read-only planning"},
                {"value": "auto", "name": "Auto"},
                {"value": "yolo", "name": "YOLO"}
            ]
        }]
    }))
    .expect("mode config option");
    assert_eq!(mode.current_mode_id, "default");
    assert_eq!(mode.available_modes.len(), 4);
    assert_eq!(mode.available_modes[1].id, "plan");
}

#[test]
fn acp_session_modes_absent_or_malformed_yield_none() {
    assert!(parse_acp_mode_state(&json!({ "sessionId": "sess-1" })).is_none());
    assert!(parse_acp_mode_state(&json!({ "modes": { "availableModes": [] } })).is_none());
}

#[test]
fn acp_current_mode_update_stays_out_of_the_transcript() {
    // The pump handles mode updates via session metadata; the transcript
    // reducer must keep dropping them rather than surfacing a raw item.
    let event = reduce_acp_update(
        "session-1",
        "turn-1",
        0,
        &json!({ "sessionUpdate": "current_mode_update", "currentModeId": "plan" }),
        Utc::now(),
    )
    .expect("reduce");
    assert!(event.is_none());
}

#[test]
fn cursor_create_plan_reduces_to_plan_review_approval() {
    let event = reduce_acp_plan_review_request(
        "session-1",
        "turn-1",
        TransportRequestId::Number(7.into()),
        &json!({
            "toolCallId": "call-1",
            "name": "Add subtract function",
            "overview": "Add subtract(a, b) to hello.py",
            "plan": "# Plan\n\nAdd the function.",
            "todos": [{"id": "t1", "content": "Add subtract", "status": "pending"}]
        }),
        Utc::now(),
    );
    match event.mutation {
        ProjectionMutation::ApprovalRequested {
            approval_kind,
            item_id,
            reason,
            plan_markdown,
            ..
        } => {
            assert_eq!(approval_kind, ApprovalKind::PlanReview);
            assert_eq!(item_id, "call-1");
            assert_eq!(
                reason.as_deref(),
                Some("Add subtract function — Add subtract(a, b) to hello.py")
            );
            assert_eq!(
                plan_markdown.as_deref(),
                Some("# Plan\n\nAdd the function.")
            );
        }
        other => panic!("expected plan-review approval, got {other:?}"),
    }
}

#[test]
fn cursor_create_plan_survives_missing_fields() {
    let event = reduce_acp_plan_review_request(
        "session-1",
        "turn-1",
        TransportRequestId::Number(8.into()),
        &json!({}),
        Utc::now(),
    );
    match event.mutation {
        ProjectionMutation::ApprovalRequested {
            approval_kind,
            item_id,
            reason,
            plan_markdown,
            ..
        } => {
            assert_eq!(approval_kind, ApprovalKind::PlanReview);
            assert_eq!(item_id, "create-plan");
            assert_eq!(reason, None);
            assert_eq!(plan_markdown, None);
        }
        other => panic!("expected plan-review approval, got {other:?}"),
    }
}

#[test]
fn cursor_create_plan_bounds_oversized_plan_documents() {
    let huge = "x".repeat(PLAN_DOCUMENT_LIMIT + 1024);
    let event = reduce_acp_plan_review_request(
        "session-1",
        "turn-1",
        TransportRequestId::Number(9.into()),
        &json!({ "toolCallId": "call-1", "plan": huge }),
        Utc::now(),
    );
    match event.mutation {
        ProjectionMutation::ApprovalRequested { plan_markdown, .. } => {
            let plan = plan_markdown.expect("plan");
            // Bounded to the document limit plus the truncation marker.
            assert!(plan.len() <= PLAN_DOCUMENT_LIMIT + "\n[truncated]".len());
            assert!(plan.ends_with("[truncated]"));
        }
        other => panic!("expected plan-review approval, got {other:?}"),
    }
}

#[test]
fn acp_permission_request_with_unique_option_kinds_stays_command_execution() {
    let event = reduce_acp_permission_request(
        "session-1",
        "turn-1",
        TransportRequestId::Number(1.into()),
        &json!({
            "toolCall": {"toolCallId": "call-1", "title": "rm -rf build/"},
            "options": [
                {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                {"optionId": "reject", "name": "Reject", "kind": "reject_once"},
            ]
        }),
        Utc::now(),
    );
    match event.mutation {
        ProjectionMutation::ApprovalRequested {
            approval_kind,
            options,
            reason,
            ..
        } => {
            assert_eq!(approval_kind, ApprovalKind::CommandExecution);
            assert!(options.is_empty());
            assert_eq!(reason.as_deref(), Some("rm -rf build/"));
        }
        other => panic!("expected command-execution approval, got {other:?}"),
    }
}

#[test]
fn acp_permission_request_with_repeated_option_kind_becomes_a_question() {
    // A coding CLI's own "ask the user" tool, bridged onto ACP's only
    // client-interaction channel: three distinct answers, all offered
    // as `allow_once` because none of them reject anything.
    let event = reduce_acp_permission_request(
        "session-1",
        "turn-1",
        TransportRequestId::Number(2.into()),
        &json!({
            "toolCall": {"toolCallId": "call-2", "title": "Which frequency should I use?"},
            "options": [
                {"optionId": "opt-monthly", "name": "Monthly", "kind": "allow_once"},
                {"optionId": "opt-quarterly", "name": "Quarterly", "kind": "allow_once"},
                {"optionId": "opt-skip", "name": "Skip this series", "kind": "allow_once"},
            ]
        }),
        Utc::now(),
    );
    match event.mutation {
        ProjectionMutation::ApprovalRequested {
            approval_kind,
            options,
            reason,
            ..
        } => {
            assert_eq!(approval_kind, ApprovalKind::Question);
            assert_eq!(reason.as_deref(), Some("Which frequency should I use?"));
            assert_eq!(
                options,
                vec![
                    QuestionOption {
                        option_id: "opt-monthly".into(),
                        label: "Monthly".into()
                    },
                    QuestionOption {
                        option_id: "opt-quarterly".into(),
                        label: "Quarterly".into()
                    },
                    QuestionOption {
                        option_id: "opt-skip".into(),
                        label: "Skip this series".into()
                    },
                ]
            );
        }
        other => panic!("expected question approval, got {other:?}"),
    }
}

#[test]
fn acp_permission_request_falls_back_to_option_id_when_name_is_missing() {
    let event = reduce_acp_permission_request(
        "session-1",
        "turn-1",
        TransportRequestId::Number(3.into()),
        &json!({
            "toolCall": {"toolCallId": "call-3", "title": "Pick one"},
            "options": [
                {"optionId": "a", "kind": "allow_once"},
                {"optionId": "b", "kind": "allow_once"},
            ]
        }),
        Utc::now(),
    );
    match event.mutation {
        ProjectionMutation::ApprovalRequested { options, .. } => {
            assert_eq!(options[0].label, "a");
            assert_eq!(options[1].label, "b");
        }
        other => panic!("expected question approval, got {other:?}"),
    }
}

#[test]
fn raw_acp_thought_chunks_become_host_activity_without_vendor_text() {
    let event = reduce_acp_update(
        "session-1",
        "turn-1",
        0,
        &json!({
            "sessionUpdate": "agent_thought_chunk",
            "content": {"type": "text", "text": "Raw hidden chain of thought"}
        }),
        Utc::now(),
    )
    .expect("reduce")
    .expect("placeholder");
    assert!(!event.audit_json.contains("Raw hidden"));
    match event.mutation {
        ProjectionMutation::ReplaceItem(item) => {
            assert_eq!(item.kind, ItemKind::ReasoningSummary);
            assert_eq!(item.body.as_deref(), Some("Thinking…"));
            assert_eq!(item.title.as_deref(), Some("Reasoning"));
        }
        other => panic!("expected reasoning placeholder, got {other:?}"),
    }
}

/// The turn-settle write must land on the same transcript row the first
/// thought chunk opened. A drifting id would orphan the `inProgress` row and
/// leave the transcript spinning on it forever.
#[test]
fn acp_reasoning_placeholder_completes_on_the_same_item_id() {
    let opened = reduce_acp_update(
        "session-1",
        "turn-1",
        0,
        &json!({
            "sessionUpdate": "agent_thought_chunk",
            "content": {"type": "text", "text": "Raw hidden chain of thought"}
        }),
        Utc::now(),
    )
    .expect("reduce")
    .expect("placeholder");
    let settled = acp_reasoning_event("session-1", "turn-1", ItemStatus::Completed, Utc::now());

    let (
        ProjectionMutation::ReplaceItem(opened_item),
        ProjectionMutation::ReplaceItem(settled_item),
    ) = (opened.mutation, settled.mutation)
    else {
        panic!("expected replace mutations");
    };
    assert_eq!(opened_item.id, settled_item.id);
    assert_eq!(opened_item.id, acp_reasoning_item_id("session-1", "turn-1"));
    assert_eq!(opened_item.status, ItemStatus::InProgress);
    assert_eq!(settled_item.status, ItemStatus::Completed);
    assert_eq!(settled_item.kind, ItemKind::ReasoningSummary);
    // The settled row must still carry a non-empty body: the renderer drops
    // reasoning items whose body is blank.
    assert!(
        settled_item
            .body
            .is_some_and(|body| !body.trim().is_empty())
    );
}

#[test]
fn acp_tool_call_captures_input_output_and_merges_updates() {
    let event = reduce_acp_update(
        "session-1",
        "turn-1",
        0,
        &json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-1",
            "title": "Read main.rs",
            "kind": "read",
            "status": "in_progress",
            "rawInput": {"path": "src/main.rs"}
        }),
        Utc::now(),
    )
    .expect("reduce")
    .expect("accepted");
    let ProjectionMutation::ReplaceItem(item) = &event.mutation else {
        panic!("expected replace mutation");
    };
    assert_eq!(item.title.as_deref(), Some("Read main.rs"));
    assert_eq!(item.mcp_tool.as_deref(), Some("read"));
    assert!(
        item.tool_input
            .as_deref()
            .expect("tool input")
            .contains("src/main.rs")
    );

    let update = reduce_acp_update(
        "session-1",
        "turn-1",
        0,
        &json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call-1",
            "status": "completed",
            "content": [{"type": "content", "content": {"type": "text", "text": "fn main() {}"}}]
        }),
        Utc::now(),
    )
    .expect("reduce")
    .expect("accepted");
    let ProjectionMutation::MergeItem(item) = &update.mutation else {
        panic!("expected merge mutation");
    };
    assert_eq!(item.status, ItemStatus::Completed);
    assert_eq!(
        item.title, None,
        "partial update must not fabricate a title"
    );
    assert_eq!(item.output.as_deref(), Some("fn main() {}"));
}

#[test]
fn acp_tool_call_folds_locations_into_tool_input_when_raw_input_omits_path() {
    let event = reduce_acp_update(
        "session-1",
        "turn-1",
        0,
        &json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-loc",
            "title": "Read",
            "kind": "read",
            "status": "in_progress",
            "locations": [{"path": "apps/desktop/src/components/Transcript.tsx", "line": 12}]
        }),
        Utc::now(),
    )
    .expect("reduce")
    .expect("accepted");
    let ProjectionMutation::ReplaceItem(item) = &event.mutation else {
        panic!("expected replace mutation");
    };
    assert_eq!(item.title.as_deref(), Some("Read"));
    assert!(
        item.tool_input
            .as_deref()
            .expect("tool input")
            .contains("Transcript.tsx"),
        "locations path should become tool_input: {:?}",
        item.tool_input
    );

    let with_raw = reduce_acp_update(
        "session-1",
        "turn-1",
        0,
        &json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-both",
            "title": "Searched",
            "kind": "search",
            "status": "completed",
            "rawInput": {"query": "activity rows"},
            "locations": [{"path": "apps/desktop/src/components/Transcript.tsx"}]
        }),
        Utc::now(),
    )
    .expect("reduce")
    .expect("accepted");
    let ProjectionMutation::ReplaceItem(item) = &with_raw.mutation else {
        panic!("expected replace mutation");
    };
    let input = item.tool_input.as_deref().expect("tool input");
    assert!(
        input.contains("activity rows"),
        "raw query preserved: {input}"
    );
    assert!(
        input.contains("Transcript.tsx"),
        "location path is folded in when rawInput has no path field: {input}"
    );
}

#[test]
fn acp_diff_content_blocks_project_file_changes_with_unified_patch() {
    let event = reduce_acp_update(
        "session-1",
        "turn-1",
        0,
        &json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call-1",
            "status": "completed",
            "content": [{
                "type": "diff",
                "path": "C:\\repo\\src\\main.rs",
                "oldText": "fn main() {\n    println!(\"old\");\n}\n",
                "newText": "fn main() {\n    println!(\"new\");\n}\n"
            }]
        }),
        Utc::now(),
    )
    .expect("reduce")
    .expect("accepted");
    let ProjectionMutation::MergeItem(item) = &event.mutation else {
        panic!("expected merge mutation");
    };
    let changes = item.file_changes.as_ref().expect("file changes");
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].path, "C:\\repo\\src\\main.rs");
    assert_eq!(changes[0].change_kind, FileChangeKind::Modify);
    let patch = changes[0].patch.as_deref().expect("patch");
    assert!(patch.contains("@@"), "patch has hunk headers: {patch}");
    assert!(
        patch.contains("-    println!(\"old\");"),
        "patch: {patch:?}"
    );
    assert!(
        patch.contains("+    println!(\"new\");"),
        "patch: {patch:?}"
    );
}

#[test]
fn acp_diff_block_without_old_text_projects_an_added_file() {
    let event = reduce_acp_update(
        "session-1",
        "turn-1",
        0,
        &json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-2",
            "title": "Write File",
            "kind": "edit",
            "content": [{
                "type": "diff",
                "path": "src/new.rs",
                "newText": "pub fn added() {}\n"
            }]
        }),
        Utc::now(),
    )
    .expect("reduce")
    .expect("accepted");
    let ProjectionMutation::ReplaceItem(item) = &event.mutation else {
        panic!("expected replace mutation");
    };
    let changes = item.file_changes.as_ref().expect("file changes");
    assert_eq!(changes[0].change_kind, FileChangeKind::Add);
    assert!(
        changes[0]
            .patch
            .as_deref()
            .expect("patch")
            .contains("+pub fn added() {}")
    );
}

#[test]
fn acp_agent_segments_open_distinct_items() {
    let chunk = json!({
        "sessionUpdate": "agent_message_chunk",
        "content": {"type": "text", "text": "hello"}
    });
    let first = reduce_acp_update("session-1", "turn-1", 0, &chunk, Utc::now())
        .expect("reduce")
        .expect("accepted");
    let second = reduce_acp_update("session-1", "turn-1", 1, &chunk, Utc::now())
        .expect("reduce")
        .expect("accepted");
    let ids: Vec<_> = [first, second]
        .iter()
        .map(|event| match &event.mutation {
            ProjectionMutation::AppendItem {
                provider_item_id, ..
            } => provider_item_id.clone(),
            _ => panic!("expected append mutation"),
        })
        .collect();
    assert_eq!(ids, vec!["turn-1-agent-0", "turn-1-agent-1"]);
}

#[test]
fn codex_mcp_tool_call_captures_arguments_and_named_title() {
    let event = reduce_provider_event(ProviderEventInput {
        method: "item/completed".into(),
        params: json!({
            "threadId": "th1",
            "turnId": "tu1",
            "item": {
                "type": "mcpToolCall",
                "id": "tool-1",
                "server": "github",
                "tool": "search",
                "arguments": {"query": "flaky tests"},
                "result": {"matches": 3}
            }
        }),
        request_id: None,
        occurred_at: Utc::now(),
    })
    .expect("reduce")
    .expect("accepted");
    let ProjectionMutation::ReplaceItem(item) = &event.mutation else {
        panic!("expected replace mutation");
    };
    assert_eq!(item.title.as_deref(), Some("github · search"));
    assert!(
        item.tool_input
            .as_deref()
            .expect("tool input")
            .contains("flaky tests")
    );
    assert!(
        item.output
            .as_deref()
            .expect("tool output")
            .contains("matches")
    );
}

#[test]
fn codex_web_search_becomes_search_activity() {
    let started = reduce_provider_event(ProviderEventInput {
        method: "item/started".into(),
        params: json!({
            "threadId": "th1",
            "turnId": "tu1",
            "item": {
                "type": "webSearch",
                "id": "search-1",
                "query": "",
                "action": {"type": "other"}
            }
        }),
        request_id: None,
        occurred_at: Utc::now(),
    })
    .expect("reduce")
    .expect("accepted");
    let completed = reduce_provider_event(ProviderEventInput {
        method: "item/completed".into(),
        params: json!({
            "threadId": "th1",
            "turnId": "tu1",
            "item": {
                "type": "webSearch",
                "id": "search-1",
                "query": "Stripe MCP connector sign in status",
                "action": {
                    "type": "search",
                    "query": "Stripe MCP connector sign in status"
                }
            }
        }),
        request_id: None,
        occurred_at: Utc::now(),
    })
    .expect("reduce")
    .expect("accepted");

    let ProjectionMutation::ReplaceItem(started) = started.mutation else {
        panic!("expected started item");
    };
    let ProjectionMutation::ReplaceItem(completed) = completed.mutation else {
        panic!("expected completed item");
    };
    assert_eq!(started.id, completed.id);
    assert_eq!(started.kind, ItemKind::McpTool);
    assert_eq!(started.status, ItemStatus::InProgress);
    assert_eq!(completed.status, ItemStatus::Completed);
    assert_eq!(completed.mcp_tool.as_deref(), Some("web_search"));
    assert_eq!(
        completed.body.as_deref(),
        Some("Stripe MCP connector sign in status")
    );
    assert!(
        completed
            .tool_input
            .as_deref()
            .expect("search input")
            .contains("Stripe MCP connector sign in status")
    );
}

#[test]
fn unknown_items_use_neutral_provider_activity_copy() {
    let event = reduce_provider_event(ProviderEventInput {
        method: "item/completed".into(),
        params: json!({
            "threadId": "th1",
            "turnId": "tu1",
            "item": {
                "type": "futureProviderItem",
                "id": "future-1"
            }
        }),
        request_id: None,
        occurred_at: Utc::now(),
    })
    .expect("reduce")
    .expect("accepted");
    let ProjectionMutation::ReplaceItem(item) = event.mutation else {
        panic!("expected provider item");
    };
    assert_eq!(item.kind, ItemKind::Unknown);
    assert_eq!(item.title.as_deref(), Some("Provider activity"));
    assert_eq!(item.body.as_deref(), Some("Additional provider activity"));
}

#[test]
fn string_approval_request_id_is_preserved() {
    let request = TransportRequestId::String("request-alpha".into());
    let event = reduce_provider_event(ProviderEventInput {
        method: "item/fileChange/requestApproval".into(),
        params: json!({"threadId":"th1","turnId":"tu1","itemId":"it1","approvalId":"approval-a"}),
        request_id: Some(request.clone()),
        occurred_at: Utc::now(),
    })
    .expect("reduce")
    .expect("accepted");
    assert!(
        matches!(event.mutation, ProjectionMutation::ApprovalRequested { request_id, approval_id: Some(ref id), .. } if request_id == request && id == "approval-a")
    );
}
