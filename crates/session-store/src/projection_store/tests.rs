use super::*;
use chrono::{DateTime, Utc};
use integrator_core::{
    ApprovalDecision, ApprovalKind, ConnectionState, ItemKind, ModeOption, ModeProjection, NewTask,
    TaskId, TaskKind, TaskSnapshotQuery, TransportRequestId, TurnProjection, TurnStatus,
};
use integrator_core::{ProviderKind, TASK_PROJECTION_HYDRATE_TAIL};

fn bound_store(provider: ProviderKind) -> (LocalStore, RuntimeBinding) {
    let store = LocalStore::open_in_memory().expect("open store");
    let task = store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Projection fixture".into(),
            repository_path: None,
            worktree_path: None,
            runtime: None,
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create task");
    let binding = store
        .create_runtime_binding(task.id, "process-fixture", provider)
        .expect("create runtime binding");
    let binding = store
        .attach_provider_thread(&binding, "thread-fixture")
        .expect("attach thread");
    (store, binding)
}

fn redundant_event_projection_count(store: &LocalStore, task_id: TaskId) -> i64 {
    let connection = store.connection.lock();
    connection
        .query_row(
            "SELECT COUNT(*) FROM integrator_event_log WHERE task_id=?1 AND projection_json IS NOT NULL",
            [task_id.to_string()],
            |row| row.get(0),
        )
        .expect("count redundant event projections")
}

fn request_command_approval(
    store: &LocalStore,
    binding: &RuntimeBinding,
    request_id: &str,
) -> ApprovalProjection {
    let requested = store
        .apply_reduced_event(
            binding,
            &ReducedProviderEvent {
                method: "item/commandExecution/requestApproval".into(),
                thread_id: "thread-fixture".into(),
                turn_id: Some("turn-approval".into()),
                audit_json: "{}".into(),
                audit_truncated: false,
                mutation: ProjectionMutation::ApprovalRequested {
                    request_id: TransportRequestId::String(request_id.into()),
                    approval_kind: ApprovalKind::CommandExecution,
                    item_id: format!("command-{request_id}"),
                    approval_id: Some(format!("provider-{request_id}")),
                    reason: Some("run focused tests".into()),
                    command: Some("cargo test -p session-store".into()),
                    cwd: Some("fixture/integrator-3".into()),
                    plan_markdown: None,
                    options: Vec::new(),
                },
                occurred_at: Utc::now(),
            },
        )
        .expect("persist approval request");
    let RuntimeProjection::ApprovalChanged { approval } = requested.projection else {
        panic!("expected approval projection");
    };
    approval
}

fn request_question_approval(
    store: &LocalStore,
    binding: &RuntimeBinding,
    request_id: &str,
) -> ApprovalProjection {
    let requested = store
        .apply_reduced_event(
            binding,
            &ReducedProviderEvent {
                method: "session/request_permission".into(),
                thread_id: "thread-fixture".into(),
                turn_id: Some("turn-approval".into()),
                audit_json: "{}".into(),
                audit_truncated: false,
                mutation: ProjectionMutation::ApprovalRequested {
                    request_id: TransportRequestId::String(request_id.into()),
                    approval_kind: ApprovalKind::Question,
                    item_id: format!("question-{request_id}"),
                    approval_id: Some(format!("provider-{request_id}")),
                    reason: Some("Which frequency should I use?".into()),
                    command: None,
                    cwd: None,
                    plan_markdown: None,
                    options: vec![
                        integrator_core::QuestionOption {
                            option_id: "opt-monthly".into(),
                            label: "Monthly".into(),
                        },
                        integrator_core::QuestionOption {
                            option_id: "opt-quarterly".into(),
                            label: "Quarterly".into(),
                        },
                    ],
                },
                occurred_at: Utc::now(),
            },
        )
        .expect("persist question approval request");
    let RuntimeProjection::ApprovalChanged { approval } = requested.projection else {
        panic!("expected approval projection");
    };
    approval
}

fn completed_message(provider_item_id: &str, kind: ItemKind, body: &str) -> ReducedProviderEvent {
    let occurred_at = Utc::now();
    ReducedProviderEvent {
        method: "item/completed".into(),
        thread_id: "thread-fixture".into(),
        turn_id: Some("turn-search".into()),
        audit_json: "{}".into(),
        audit_truncated: false,
        mutation: ProjectionMutation::ReplaceItem(ItemProjection {
            id: format!("fixture:{provider_item_id}"),
            provider_item_id: provider_item_id.into(),
            kind,
            status: ItemStatus::Completed,
            title: None,
            body: Some(body.into()),
            native_skill: None,
            phase: None,
            command: None,
            cwd: None,
            output: None,
            exit_code: None,
            file_changes: None,
            mcp_server: None,
            mcp_tool: None,
            tool_input: None,
            truncated: false,
            updated_at: occurred_at,
        }),
        occurred_at,
    }
}

fn append_message(
    provider_item_id: &str,
    delta: &str,
    item_updated_at: DateTime<Utc>,
    occurred_at: DateTime<Utc>,
) -> ReducedProviderEvent {
    ReducedProviderEvent {
        method: "item/agentMessage/delta".into(),
        thread_id: "thread-fixture".into(),
        turn_id: Some("turn-1".into()),
        audit_json: "{}".into(),
        audit_truncated: false,
        mutation: ProjectionMutation::AppendItem {
            provider_item_id: provider_item_id.into(),
            item_kind: ItemKind::AgentMessage,
            field: ItemTextField::Body,
            delta: delta.into(),
            updated_at: item_updated_at,
        },
        occurred_at,
    }
}

fn append_command_output(provider_item_id: &str, delta: &str) -> ReducedProviderEvent {
    let occurred_at = Utc::now();
    ReducedProviderEvent {
        method: "item/commandExecution/outputDelta".into(),
        thread_id: "thread-fixture".into(),
        turn_id: Some("turn-command".into()),
        audit_json: "{}".into(),
        audit_truncated: false,
        mutation: ProjectionMutation::AppendItem {
            provider_item_id: provider_item_id.into(),
            item_kind: ItemKind::CommandExecution,
            field: ItemTextField::Output,
            delta: delta.into(),
            updated_at: occurred_at,
        },
        occurred_at,
    }
}

fn persist_reset(
    store: &LocalStore,
    binding: &RuntimeBinding,
    occurred_at: DateTime<Utc>,
) -> RuntimeProjectionEvent {
    let provider_session_id = binding
        .provider_session_id
        .expect("attached provider session");
    let thread_id = binding.thread_id.as_deref().expect("attached thread");
    let mut connection = store.connection.lock();
    let transaction = connection.transaction().expect("reset transaction");
    transaction
        .execute(
            "INSERT INTO integrator_event_log(task_id,provider_session_id,runtime_session_id,process_id,thread_id,turn_id,method,audit_json,audit_truncated,occurred_at) VALUES (?1,?2,?3,?4,?5,NULL,'client/projection/reset','{}',0,?6)",
            params![
                binding.task_id.to_string(),
                provider_session_id.to_string(),
                binding.runtime_session_id.to_string(),
                binding.process_id,
                thread_id,
                occurred_at.to_rfc3339()
            ],
        )
        .expect("insert reset audit event");
    let seq = transaction.last_insert_rowid();
    ensure_task_projection(&transaction, binding, seq).expect("ensure task projection");
    let event = RuntimeProjectionEvent {
        seq,
        task_id: binding.task_id,
        provider_session_id,
        provider: binding.provider.as_str().into(),
        thread_id: thread_id.into(),
        turn_id: None,
        occurred_at,
        projection: RuntimeProjection::ProjectionReset {
            reason: "test reset".into(),
        },
    };
    persist_snapshot_event(&transaction, &event).expect("materialize reset");
    transaction.commit().expect("commit reset");
    event
}

#[test]
fn message_search_is_indexed_bounded_and_provider_independent() {
    let (store, binding) = bound_store(ProviderKind::Codex);
    store
        .apply_reduced_event(
            &binding,
            &completed_message(
                "user-search",
                ItemKind::UserMessage,
                "Please retry the SQLite migration safely",
            ),
        )
        .expect("persist user message");
    store
        .apply_reduced_event(
            &binding,
            &completed_message(
                "agent-search",
                ItemKind::AgentMessage,
                "The retry now keeps every local projection intact",
            ),
        )
        .expect("persist agent message");
    store
        .apply_reduced_event(
            &binding,
            &completed_message(
                "tool-search",
                ItemKind::CommandExecution,
                "secret-tool-only-needle",
            ),
        )
        .expect("persist tool output");

    let matches = store
        .search_task_messages("retry SQLite", 20, false)
        .expect("search messages");
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].0, binding.task_id);
    assert!(matches[0].1.to_lowercase().contains("retry"));
    assert!(
        store
            .search_task_messages("secret-tool-only-needle", 20, false)
            .expect("search tool-only text")
            .is_empty()
    );
    assert!(
        store
            .search_task_messages("retry OR \\\"migration", 20, false)
            .expect("sanitize FTS syntax")
            .len()
            <= 1
    );
}

#[test]
fn message_search_excludes_archived_tasks_unless_requested() {
    let (store, binding) = bound_store(ProviderKind::Codex);
    store
        .apply_reduced_event(
            &binding,
            &completed_message(
                "archived-user",
                ItemKind::UserMessage,
                "Archive needle stays cold until requested",
            ),
        )
        .expect("persist user message");
    store
        .update_task_metadata(binding.task_id, None, None, Some(true))
        .expect("archive task");

    assert!(
        store
            .search_task_messages("Archive needle", 20, false)
            .expect("live search")
            .is_empty(),
        "archived chats must stay out of the live search hot path"
    );
    let included = store
        .search_task_messages("Archive needle", 20, true)
        .expect("archive-inclusive search");
    assert_eq!(included.len(), 1);
    assert_eq!(included[0].0, binding.task_id);
}

#[test]
fn reduced_events_are_sequenced_and_snapshot_at_a_watermark() {
    let (store, binding) = bound_store(ProviderKind::Codex);
    let occurred_at = Utc::now();
    let turn = ReducedProviderEvent {
        method: "turn/started".into(),
        thread_id: "thread-fixture".into(),
        turn_id: Some("turn-1".into()),
        audit_json: "{}".into(),
        audit_truncated: false,
        mutation: ProjectionMutation::Turn(TurnProjection {
            id: "turn-1".into(),
            status: TurnStatus::InProgress,
            stop_requested: false,
            error: None,
            started_at: Some(occurred_at),
            completed_at: None,
        }),
        occurred_at,
    };
    let event = store
        .apply_reduced_event(&binding, &turn)
        .expect("persist turn");
    let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
    assert_eq!(snapshot.watermark_seq, event.seq);
    assert_eq!(snapshot.reset_seq, 0);
    assert!(!snapshot.cache_matched);
    let hydrate = snapshot.hydrate.expect("compact hydrate");
    let RuntimeProjection::TurnChanged { turn } = event.projection else {
        panic!("expected turn event");
    };
    assert_eq!(hydrate.turn.as_ref(), Some(&turn));
    assert!(hydrate.items.is_empty());
}

#[test]
fn turn_settlement_keeps_the_original_start_time() {
    let (store, binding) = bound_store(ProviderKind::Claude);
    let started_at = Utc::now();
    let settled_at = started_at + chrono::Duration::seconds(42);
    let turn_event = |status: TurnStatus,
                      started: DateTime<Utc>,
                      completed: Option<DateTime<Utc>>,
                      occurred_at: DateTime<Utc>| ReducedProviderEvent {
        method: "turn/started".into(),
        thread_id: "thread-fixture".into(),
        turn_id: Some("turn-1".into()),
        audit_json: "{}".into(),
        audit_truncated: false,
        mutation: ProjectionMutation::Turn(TurnProjection {
            id: "turn-1".into(),
            status,
            stop_requested: false,
            error: None,
            started_at: Some(started),
            completed_at: completed,
        }),
        occurred_at,
    };
    store
        .apply_reduced_event(
            &binding,
            &turn_event(TurnStatus::InProgress, started_at, None, started_at),
        )
        .expect("start turn");
    // Structured CLIs settle with `now` as the restated start; the stored
    // start must survive or the settled turn's duration collapses to zero.
    let event = store
        .apply_reduced_event(
            &binding,
            &turn_event(
                TurnStatus::Completed,
                settled_at,
                Some(settled_at),
                settled_at,
            ),
        )
        .expect("settle turn");
    let RuntimeProjection::TurnChanged { turn } = event.projection else {
        panic!("expected turn event");
    };
    assert_eq!(
        turn.started_at.map(|v| v.timestamp()),
        Some(started_at.timestamp())
    );
    assert_eq!(
        turn.completed_at.map(|v| v.timestamp()),
        Some(settled_at.timestamp())
    );
    let stored = store
        .connection
        .lock()
        .query_row(
            "SELECT started_at, completed_at FROM integrator_turns WHERE turn_id='turn-1'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .expect("read stored turn");
    assert_eq!(
        parse_time(&stored.0).expect("parse start").timestamp(),
        started_at.timestamp()
    );
    assert_eq!(
        parse_time(&stored.1).expect("parse completion").timestamp(),
        settled_at.timestamp()
    );
}

#[test]
fn non_retryable_error_settles_the_stored_turn_but_a_retryable_one_does_not() {
    fn started_turn(occurred_at: DateTime<Utc>) -> ReducedProviderEvent {
        ReducedProviderEvent {
            method: "turn/started".into(),
            thread_id: "thread-fixture".into(),
            turn_id: Some("turn-1".into()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::Turn(TurnProjection {
                id: "turn-1".into(),
                status: TurnStatus::InProgress,
                stop_requested: false,
                error: None,
                started_at: Some(occurred_at),
                completed_at: None,
            }),
            occurred_at,
        }
    }
    fn error_event(
        occurred_at: DateTime<Utc>,
        message: &str,
        retryable: bool,
    ) -> ReducedProviderEvent {
        ReducedProviderEvent {
            method: "error".into(),
            thread_id: "thread-fixture".into(),
            turn_id: Some("turn-1".into()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::TurnError {
                message: message.into(),
                retryable,
            },
            occurred_at,
        }
    }
    fn stored_turn_status(store: &LocalStore) -> String {
        store
            .connection
            .lock()
            .query_row(
                "SELECT status FROM integrator_turns WHERE turn_id='turn-1'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("read stored turn")
    }

    let occurred_at = Utc::now();

    // A provider that is still retrying keeps the turn open.
    let (retrying, retrying_binding) = bound_store(ProviderKind::Codex);
    retrying
        .apply_reduced_event(&retrying_binding, &started_turn(occurred_at))
        .expect("persist turn");
    retrying
        .apply_reduced_event(
            &retrying_binding,
            &error_event(occurred_at, "stream disconnected", true),
        )
        .expect("persist retryable error");
    assert_eq!(stored_turn_status(&retrying), "in_progress");

    // A provider that will not retry has abandoned the turn, so the stored
    // row settles rather than rehydrating as running after a reload.
    let (limited, limited_binding) = bound_store(ProviderKind::Codex);
    limited
        .apply_reduced_event(&limited_binding, &started_turn(occurred_at))
        .expect("persist turn");
    limited
        .apply_reduced_event(
            &limited_binding,
            &error_event(occurred_at, "usage limit reached", false),
        )
        .expect("persist non-retryable error");
    assert_eq!(stored_turn_status(&limited), "failed");

    // The settled turn is no longer unfinished work for the stale sweep, so
    // closing the session cannot relabel it `interrupted` after the fact.
    let connection = limited.connection.lock();
    let transaction = connection.unchecked_transaction().expect("transaction");
    assert!(
        settle_stale_turn(&transaction, limited_binding.task_id, false)
            .expect("sweep settled turn")
            .is_none()
    );
}

#[test]
fn verified_native_skill_survives_snapshot_persistence() {
    let (store, binding) = bound_store(ProviderKind::Codex);
    let mut event = completed_message(
        "user-native-skill",
        ItemKind::UserMessage,
        "/skill-creator build one",
    );
    let ProjectionMutation::ReplaceItem(item) = &mut event.mutation else {
        panic!("expected completed message replacement");
    };
    item.native_skill = Some("skill-creator".into());

    store
        .apply_reduced_event(&binding, &event)
        .expect("persist verified native skill");

    let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
    let item = &snapshot.hydrate.expect("hydrate").items[0];
    assert_eq!(item.body.as_deref(), Some("/skill-creator build one"));
    assert_eq!(item.native_skill.as_deref(), Some("skill-creator"));
    assert_eq!(
        store
            .skill_invocation_counts()
            .expect("count verified skill")
            .get("skill-creator"),
        Some(&1)
    );
}

#[test]
fn snapshot_collapses_streaming_item_deltas_to_the_latest_projection() {
    let (store, binding) = bound_store(ProviderKind::Codex);
    let occurred_at = Utc::now();

    store
        .apply_reduced_event(
            &binding,
            &append_message("message-1", "hello ", occurred_at, occurred_at),
        )
        .expect("persist first delta");
    let latest = store
        .apply_reduced_event(
            &binding,
            &append_message(
                "message-1",
                "world",
                occurred_at,
                occurred_at + chrono::Duration::milliseconds(10),
            ),
        )
        .expect("persist second delta");
    let other = store
        .apply_reduced_event(
            &binding,
            &append_message(
                "message-2",
                "another item",
                occurred_at,
                occurred_at + chrono::Duration::milliseconds(20),
            ),
        )
        .expect("persist other item");

    let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
    assert_eq!(snapshot.watermark_seq, other.seq);
    let hydrate = snapshot.hydrate.expect("hydrate");
    assert_eq!(hydrate.items.len(), 2);
    assert_eq!(hydrate.items[0].body.as_deref(), Some("hello world"));
    assert_eq!(
        hydrate.first_seen.get(&hydrate.items[0].id),
        Some(&occurred_at)
    );
    assert_eq!(hydrate.before_seq, Some(latest.seq));
    assert!(!hydrate.has_more_older);
}

#[test]
fn streamed_command_output_preserves_model_visible_json() {
    let (store, binding) = bound_store(ProviderKind::Codex);
    let output = r#"{"id":1,"jsonrpc":"2.0","result":{"capabilities":{"tools":{}},"protocolVersion":"2024-11-05","serverInfo":{"name":"integrator-local-tools","version":"0.1.0"}}}"#;
    store
        .apply_reduced_event(&binding, &append_command_output("command-1", output))
        .expect("persist command output");

    let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
    let hydrate = snapshot.hydrate.expect("hydrate");
    assert_eq!(hydrate.items.len(), 1);
    assert_eq!(hydrate.items[0].output.as_deref(), Some(output));
}

#[test]
fn snapshot_keeps_singletons_and_approval_current_without_replaying_audit_json() {
    let (store, binding) = bound_store(ProviderKind::Cursor);
    let at = Utc::now();
    let mutations = [
        ProjectionMutation::Connection {
            state: ConnectionState::Connected,
            reason: None,
        },
        ProjectionMutation::Mode(ModeProjection {
            current_mode_id: "agent".into(),
            available_modes: vec![ModeOption {
                id: "agent".into(),
                name: "Agent".into(),
                description: Some("Provider-owned mode".into()),
            }],
        }),
        ProjectionMutation::ApprovalRequested {
            request_id: TransportRequestId::String("approval-request".into()),
            approval_kind: ApprovalKind::CommandExecution,
            item_id: "command-1".into(),
            approval_id: Some("provider-approval-1".into()),
            reason: Some("run tests".into()),
            command: Some("cargo test".into()),
            cwd: Some("fixture/integrator-3".into()),
            plan_markdown: None,
            options: Vec::new(),
        },
        ProjectionMutation::TurnError {
            message: "provider disconnected".into(),
            retryable: true,
        },
    ];
    for (offset, mutation) in mutations.into_iter().enumerate() {
        store
            .apply_reduced_event(
                &binding,
                &ReducedProviderEvent {
                    method: format!("fixture/{offset}"),
                    thread_id: "thread-fixture".into(),
                    turn_id: Some("turn-1".into()),
                    audit_json: format!(r#"{{"offset":{offset}}}"#),
                    audit_truncated: false,
                    mutation,
                    occurred_at: at + chrono::Duration::milliseconds(offset as i64),
                },
            )
            .expect("persist projection");
    }

    let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
    let hydrate = snapshot.hydrate.expect("hydrate");
    assert!(matches!(
        hydrate.connection.as_ref(),
        Some(connection) if connection.state == ConnectionState::Connected
    ));
    assert_eq!(
        hydrate
            .mode
            .as_ref()
            .map(|mode| mode.current_mode_id.as_str()),
        Some("agent")
    );
    assert_eq!(hydrate.approvals.len(), 1);
    assert_eq!(hydrate.approvals[0].state, ApprovalState::Pending);
    assert!(matches!(
        hydrate.error.as_ref(),
        Some(error) if error.retryable
    ));
    let connection = store.connection.lock();
    let audit_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM integrator_event_log WHERE task_id=?1",
            [binding.task_id.to_string()],
            |row| row.get(0),
        )
        .expect("audit count");
    assert_eq!(
        audit_count, 4,
        "every accepted event remains in the audit log"
    );
    drop(connection);
    assert_eq!(
        redundant_event_projection_count(&store, binding.task_id),
        0,
        "current snapshots must not be copied into the append-only audit log"
    );
}

#[test]
fn approval_client_events_keep_compact_audit_identity_without_projection_copies() {
    let (store, binding) = bound_store(ProviderKind::Codex);
    let approval = request_command_approval(&store, &binding, "request-approval");

    store
        .prepare_approval_response(binding.task_id, &approval.id, ApprovalDecision::Accept)
        .expect("prepare approval response");
    store
        .mark_approval_response_failed(&approval.id)
        .expect("record provider response failure");

    let audit_rows = {
        let connection = store.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT method,audit_json FROM integrator_event_log WHERE task_id=?1 AND method LIKE 'client/approval/%' ORDER BY seq",
            )
            .expect("prepare compact audit query");
        statement
            .query_map([binding.task_id.to_string()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .expect("query compact audit rows")
            .collect::<std::result::Result<Vec<_>, _>>()
            .expect("collect compact audit rows")
    };
    assert_eq!(audit_rows.len(), 2);
    assert_eq!(audit_rows[0].0, "client/approval/responding");
    assert_eq!(audit_rows[1].0, "client/approval/response_failed");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&audit_rows[0].1)
            .expect("parse responding audit"),
        serde_json::json!({
            "approvalId": approval.id,
            "decision": "accept",
            "state": "responding",
        })
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&audit_rows[1].1)
            .expect("parse response-failed audit"),
        serde_json::json!({
            "approvalId": approval.id,
            "decision": "accept",
            "state": "response_failed",
        })
    );
    assert_eq!(redundant_event_projection_count(&store, binding.task_id), 0);
}

#[test]
fn successful_client_approval_response_resolves_durable_projection() {
    let (store, binding) = bound_store(ProviderKind::Cursor);
    let approval = request_command_approval(&store, &binding, "request-success");

    store
        .prepare_approval_response(
            binding.task_id,
            &approval.id,
            ApprovalDecision::AcceptForSession,
        )
        .expect("prepare approval response");
    let resolved = store
        .mark_approval_response_resolved(&approval.id)
        .expect("record successful provider response");

    let RuntimeProjection::ApprovalChanged { approval: resolved } = resolved.projection else {
        panic!("expected resolved approval projection");
    };
    assert_eq!(resolved.state, ApprovalState::Resolved);
    assert_eq!(resolved.decision, Some(ApprovalDecision::AcceptForSession));

    let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
    let hydrated = snapshot.hydrate.expect("hydrate snapshot");
    assert_eq!(hydrated.approvals.len(), 1);
    assert_eq!(hydrated.approvals[0].state, ApprovalState::Resolved);

    let methods = {
        let connection = store.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT method FROM integrator_event_log WHERE task_id=?1 AND method LIKE 'client/approval/%' ORDER BY seq",
            )
            .expect("prepare approval audit query");
        statement
            .query_map([binding.task_id.to_string()], |row| row.get::<_, String>(0))
            .expect("query approval audit")
            .collect::<std::result::Result<Vec<_>, _>>()
            .expect("collect approval audit")
    };
    assert_eq!(
        methods,
        vec!["client/approval/responding", "client/approval/resolved"]
    );
    assert_eq!(redundant_event_projection_count(&store, binding.task_id), 0);
}

#[test]
fn question_approval_carries_its_offered_options() {
    let (store, binding) = bound_store(ProviderKind::Kimi);
    let approval = request_question_approval(&store, &binding, "request-question");
    assert_eq!(approval.approval_kind, ApprovalKind::Question);
    assert_eq!(approval.options.len(), 2);
    assert_eq!(approval.options[0].label, "Monthly");
    assert_eq!(approval.selected_option_id, None);
}

#[test]
fn answering_a_question_records_the_chosen_option_and_selects_it_over_acp() {
    let (store, binding) = bound_store(ProviderKind::Kimi);
    let approval = request_question_approval(&store, &binding, "request-answer");

    let prepared = store
        .prepare_question_response(binding.task_id, &approval.id, "opt-quarterly")
        .expect("prepare question response");
    let RuntimeProjection::ApprovalChanged {
        approval: responding,
    } = prepared.event.projection
    else {
        panic!("expected approval projection");
    };
    assert_eq!(responding.state, ApprovalState::Responding);
    assert_eq!(responding.decision, Some(ApprovalDecision::Select));
    assert_eq!(
        responding.selected_option_id.as_deref(),
        Some("opt-quarterly")
    );

    let resolved = store
        .mark_approval_response_resolved(&approval.id)
        .expect("record successful provider response");
    let RuntimeProjection::ApprovalChanged { approval: resolved } = resolved.projection else {
        panic!("expected resolved approval projection");
    };
    assert_eq!(resolved.state, ApprovalState::Resolved);
    assert_eq!(
        resolved.selected_option_id.as_deref(),
        Some("opt-quarterly")
    );
}

#[test]
fn answering_a_question_rejects_an_option_that_was_never_offered() {
    let (store, binding) = bound_store(ProviderKind::Kimi);
    let approval = request_question_approval(&store, &binding, "request-bad-option");

    let error = store
        .prepare_question_response(binding.task_id, &approval.id, "opt-annually")
        .expect_err("an unoffered option must be rejected");
    assert!(matches!(error, IntegratorError::InvalidInput(_)));
}

#[test]
fn answering_a_question_rejects_non_question_approvals() {
    let (store, binding) = bound_store(ProviderKind::Kimi);
    let approval = request_command_approval(&store, &binding, "request-not-a-question");

    let error = store
        .prepare_question_response(binding.task_id, &approval.id, "allow")
        .expect_err("a command-execution approval has no options to select");
    assert!(matches!(error, IntegratorError::InvalidInput(_)));
}

#[test]
fn reset_excludes_old_rows_and_restarts_first_seen_ordering() {
    let (store, binding) = bound_store(ProviderKind::Codex);
    let at = Utc::now();
    store
        .apply_reduced_event(&binding, &append_message("old-only", "old", at, at))
        .expect("persist old-only item");
    store
        .apply_reduced_event(
            &binding,
            &append_message(
                "reused",
                "before reset",
                at,
                at + chrono::Duration::milliseconds(1),
            ),
        )
        .expect("persist reused item");
    let reset_at = at + chrono::Duration::milliseconds(2);
    let reset = persist_reset(&store, &binding, reset_at);
    let after_at = at + chrono::Duration::milliseconds(3);
    let reused = store
        .apply_reduced_event(
            &binding,
            &append_message("reused", " after reset", after_at, after_at),
        )
        .expect("persist post-reset item");

    let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
    assert_eq!(snapshot.reset_seq, reset.seq);
    let hydrate = snapshot.hydrate.expect("hydrate");
    assert_eq!(hydrate.items.len(), 1);
    assert_eq!(hydrate.items[0].body.as_deref(), Some(" after reset"));
    assert_eq!(
        hydrate.first_seen.get(&hydrate.items[0].id),
        Some(&after_at)
    );
    assert_eq!(hydrate.before_seq, Some(reused.seq));
}

#[test]
fn duplicate_deltas_are_audited_and_current_rows_follow_latest_seq_order() {
    let (store, binding) = bound_store(ProviderKind::Codex);
    let at = Utc::now();
    store
        .apply_reduced_event(&binding, &append_message("a", "same", at, at))
        .expect("persist first delta");
    let b = store
        .apply_reduced_event(
            &binding,
            &append_message("b", "middle", at, at + chrono::Duration::milliseconds(1)),
        )
        .expect("persist second item");
    let a_latest = store
        .apply_reduced_event(
            &binding,
            &append_message("a", "same", at, at + chrono::Duration::milliseconds(2)),
        )
        .expect("persist duplicate delta");

    let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
    let hydrate = snapshot.hydrate.expect("hydrate");
    assert_eq!(hydrate.items.len(), 2);
    // Ascending last_event_seq: b then a_latest.
    assert_eq!(hydrate.items[0].provider_item_id, "b");
    assert_eq!(hydrate.items[1].provider_item_id, "a");
    assert_eq!(hydrate.items[1].body.as_deref(), Some("samesame"));
    assert_eq!(hydrate.first_seen.get(&hydrate.items[1].id), Some(&at));
    assert_eq!(hydrate.before_seq, Some(b.seq));
    assert_eq!(snapshot.watermark_seq, a_latest.seq);
    let connection = store.connection.lock();
    let audit_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM integrator_event_log WHERE task_id=?1",
            [binding.task_id.to_string()],
            |row| row.get(0),
        )
        .expect("audit count");
    assert_eq!(audit_count, 3);
}

#[test]
fn stale_turn_settlement_survives_snapshot_restart() {
    let directory = tempfile::tempdir().expect("temp directory");
    let database = directory.path().join("projection.sqlite3");
    let store = LocalStore::open(&database).expect("open store");
    let task = store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Restart fixture".into(),
            repository_path: None,
            worktree_path: None,
            runtime: None,
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create task");
    let binding = store
        .create_runtime_binding(task.id, "restart-process", ProviderKind::Codex)
        .and_then(|binding| store.attach_provider_thread(&binding, "restart-thread"))
        .expect("attach runtime");
    let at = Utc::now();
    store
        .apply_reduced_event(
            &binding,
            &ReducedProviderEvent {
                method: "turn/started".into(),
                thread_id: "restart-thread".into(),
                turn_id: Some("restart-turn".into()),
                audit_json: "{}".into(),
                audit_truncated: false,
                mutation: ProjectionMutation::Turn(TurnProjection {
                    id: "restart-turn".into(),
                    status: TurnStatus::InProgress,
                    stop_requested: false,
                    error: None,
                    started_at: Some(at),
                    completed_at: None,
                }),
                occurred_at: at,
            },
        )
        .expect("persist running turn");
    let settled = store
        .settle_interrupted_turn(task.id)
        .expect("settle stale turn")
        .expect("settlement event");
    drop(store);

    let reopened = LocalStore::open(&database).expect("reopen store");
    let snapshot = reopened.task_snapshot(task.id).expect("load snapshot");
    assert_eq!(snapshot.watermark_seq, settled.seq);
    let hydrate = snapshot.hydrate.expect("hydrate");
    assert!(matches!(
        hydrate.turn.as_ref(),
        Some(TurnProjection {
            status: TurnStatus::Interrupted,
            stop_requested: false,
            ..
        })
    ));
    assert!(matches!(
        settled.projection,
        RuntimeProjection::TurnChanged {
            turn: TurnProjection {
                status: TurnStatus::Interrupted,
                stop_requested: false,
                ..
            }
        }
    ));
    assert_eq!(redundant_event_projection_count(&reopened, task.id), 0);
}

#[test]
fn startup_settlement_reconciles_every_unfinished_chat_once() {
    let store = LocalStore::open_in_memory().expect("open store");
    let mut task_ids = Vec::new();
    for index in 0..2 {
        let task = store
            .create_task(NewTask {
                kind: TaskKind::Code,
                title: format!("Restart fixture {index}"),
                repository_path: None,
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create task");
        let thread_id = format!("restart-thread-{index}");
        let turn_id = format!("restart-turn-{index}");
        let binding = store
            .create_runtime_binding(
                task.id,
                &format!("restart-process-{index}"),
                ProviderKind::Codex,
            )
            .and_then(|binding| store.attach_provider_thread(&binding, &thread_id))
            .expect("attach runtime");
        let at = Utc::now();
        store
            .apply_reduced_event(
                &binding,
                &ReducedProviderEvent {
                    method: "turn/started".into(),
                    thread_id,
                    turn_id: Some(turn_id.clone()),
                    audit_json: "{}".into(),
                    audit_truncated: false,
                    mutation: ProjectionMutation::Turn(TurnProjection {
                        id: turn_id,
                        status: TurnStatus::InProgress,
                        stop_requested: false,
                        error: None,
                        started_at: Some(at),
                        completed_at: None,
                    }),
                    occurred_at: at,
                },
            )
            .expect("persist running turn");
        task_ids.push(task.id);
    }

    for task_id in &task_ids {
        assert!(
            store
                .task_has_unfinished_turn(*task_id)
                .expect("unfinished turn before startup settlement")
        );
    }

    assert_eq!(
        store
            .settle_unfinished_turns_after_restart()
            .expect("settle startup turns"),
        2
    );
    assert_eq!(
        store
            .settle_unfinished_turns_after_restart()
            .expect("idempotent startup settlement"),
        0
    );
    for task_id in task_ids {
        assert!(
            !store
                .task_has_unfinished_turn(task_id)
                .expect("no unfinished turn after startup settlement")
        );
        let snapshot = store.task_snapshot(task_id).expect("load settled task");
        assert!(matches!(
            snapshot.hydrate.expect("hydrate").turn.as_ref(),
            Some(TurnProjection {
                status: TurnStatus::Interrupted,
                stop_requested: false,
                ..
            })
        ));
    }
}

#[test]
fn task_tip_stop_requested_tracks_stop_latch() {
    let (store, binding) = bound_store(ProviderKind::Codex);
    let at = Utc::now();
    store
        .apply_reduced_event(
            &binding,
            &ReducedProviderEvent {
                method: "turn/started".into(),
                thread_id: binding.thread_id.clone().expect("thread"),
                turn_id: Some("tip-turn".into()),
                audit_json: "{}".into(),
                audit_truncated: false,
                mutation: ProjectionMutation::Turn(TurnProjection {
                    id: "tip-turn".into(),
                    status: TurnStatus::InProgress,
                    stop_requested: false,
                    error: None,
                    started_at: Some(at),
                    completed_at: None,
                }),
                occurred_at: at,
            },
        )
        .expect("persist running turn");
    assert!(
        !store
            .task_tip_stop_requested(binding.task_id)
            .expect("query before stop")
    );
    store.request_stop(binding.task_id).expect("request stop");
    assert!(
        store
            .task_tip_stop_requested(binding.task_id)
            .expect("query after stop")
    );
}

#[test]
fn settle_interrupted_preserves_user_stop_request() {
    let (store, binding) = bound_store(ProviderKind::Cursor);
    let at = Utc::now();
    store
        .apply_reduced_event(
            &binding,
            &ReducedProviderEvent {
                method: "client/acp/turnStarted".into(),
                thread_id: "thread-fixture".into(),
                turn_id: Some("stop-turn".into()),
                audit_json: "{}".into(),
                audit_truncated: false,
                mutation: ProjectionMutation::Turn(TurnProjection {
                    id: "stop-turn".into(),
                    status: TurnStatus::InProgress,
                    stop_requested: false,
                    error: None,
                    started_at: Some(at),
                    completed_at: None,
                }),
                occurred_at: at,
            },
        )
        .expect("persist running turn");
    let stopped = store.request_stop(binding.task_id).expect("request stop");
    assert!(stopped.result.stop_requested);
    assert!(!stopped.result.settled);

    let settled = store
        .settle_interrupted_turn(binding.task_id)
        .expect("settle after stop")
        .expect("settlement event");
    assert!(matches!(
        settled.projection,
        RuntimeProjection::TurnChanged {
            turn: TurnProjection {
                status: TurnStatus::Interrupted,
                stop_requested: true,
                ..
            }
        }
    ));
    let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
    assert!(matches!(
        snapshot.hydrate.expect("hydrate").turn.as_ref(),
        Some(TurnProjection {
            status: TurnStatus::Interrupted,
            stop_requested: true,
            ..
        })
    ));
}

#[test]
fn settle_stopped_latches_stop_onto_already_interrupted_tip() {
    let (store, binding) = bound_store(ProviderKind::Cursor);
    let at = Utc::now();
    store
        .apply_reduced_event(
            &binding,
            &ReducedProviderEvent {
                method: "client/acp/turnStarted".into(),
                thread_id: "thread-fixture".into(),
                turn_id: Some("raced-turn".into()),
                audit_json: "{}".into(),
                audit_truncated: false,
                mutation: ProjectionMutation::Turn(TurnProjection {
                    id: "raced-turn".into(),
                    status: TurnStatus::InProgress,
                    stop_requested: false,
                    error: None,
                    started_at: Some(at),
                    completed_at: None,
                }),
                occurred_at: at,
            },
        )
        .expect("persist running turn");
    store
        .settle_interrupted_turn(binding.task_id)
        .expect("provider cancel settled first")
        .expect("interrupted event");

    let latched = store
        .settle_stopped_turn(binding.task_id)
        .expect("latch stop")
        .expect("stop event");
    assert!(matches!(
        latched.projection,
        RuntimeProjection::TurnChanged {
            turn: TurnProjection {
                status: TurnStatus::Interrupted,
                stop_requested: true,
                ..
            }
        }
    ));
}

#[test]
fn snapshot_watermark_and_reset_short_circuit_skips_hydrate() {
    let (store, binding) = bound_store(ProviderKind::Codex);
    let at = Utc::now();
    store
        .apply_reduced_event(&binding, &append_message("keep", "body", at, at))
        .expect("persist item");
    let full = store.task_snapshot(binding.task_id).expect("full hydrate");
    assert!(full.hydrate.is_some());
    assert!(!full.cache_matched);

    let matched = store
        .task_snapshot_with(
            binding.task_id,
            TaskSnapshotQuery {
                known_watermark: Some(full.watermark_seq),
                known_reset_seq: Some(full.reset_seq),
                ..TaskSnapshotQuery::default()
            },
        )
        .expect("if-match hydrate");
    assert!(matched.cache_matched);
    assert!(matched.hydrate.is_none());
    assert_eq!(matched.watermark_seq, full.watermark_seq);
    assert_eq!(matched.reset_seq, full.reset_seq);

    // Watermark alone is insufficient after a projection reset.
    let reset = persist_reset(&store, &binding, at + chrono::Duration::milliseconds(1));
    store
        .apply_reduced_event(
            &binding,
            &append_message(
                "after",
                "new",
                at + chrono::Duration::milliseconds(2),
                at + chrono::Duration::milliseconds(2),
            ),
        )
        .expect("persist post-reset item");
    let stale_match = store
        .task_snapshot_with(
            binding.task_id,
            TaskSnapshotQuery {
                known_watermark: Some(full.watermark_seq),
                known_reset_seq: Some(full.reset_seq),
                ..TaskSnapshotQuery::default()
            },
        )
        .expect("stale if-match after reset");
    assert!(!stale_match.cache_matched);
    assert_eq!(stale_match.reset_seq, reset.seq);
    assert_eq!(
        stale_match
            .hydrate
            .expect("full hydrate after reset mismatch")
            .items
            .len(),
        1
    );
}

#[test]
fn snapshot_tail_window_reports_has_more_older_and_loads_prior_page() {
    let (store, binding) = bound_store(ProviderKind::Codex);
    let at = Utc::now();
    for index in 0..5 {
        store
            .apply_reduced_event(
                &binding,
                &append_message(
                    &format!("item-{index}"),
                    &format!("body-{index}"),
                    at + chrono::Duration::milliseconds(index),
                    at + chrono::Duration::milliseconds(index),
                ),
            )
            .expect("persist item");
    }

    let tail = store
        .task_snapshot_with(
            binding.task_id,
            TaskSnapshotQuery {
                limit: Some(2),
                ..TaskSnapshotQuery::default()
            },
        )
        .expect("tail hydrate");
    let hydrate = tail.hydrate.expect("hydrate");
    assert_eq!(hydrate.items.len(), 2);
    assert!(hydrate.has_more_older);
    assert_eq!(
        hydrate
            .items
            .iter()
            .map(|item| item.provider_item_id.as_str())
            .collect::<Vec<_>>(),
        vec!["item-3", "item-4"]
    );
    let before_seq = hydrate.before_seq.expect("before_seq cursor");

    let older = store
        .task_snapshot_with(
            binding.task_id,
            TaskSnapshotQuery {
                before_seq: Some(before_seq),
                limit: Some(2),
                ..TaskSnapshotQuery::default()
            },
        )
        .expect("older page");
    let older_hydrate = older.hydrate.expect("older hydrate");
    assert_eq!(older_hydrate.items.len(), 2);
    assert!(older_hydrate.has_more_older);
    assert_eq!(
        older_hydrate
            .items
            .iter()
            .map(|item| item.provider_item_id.as_str())
            .collect::<Vec<_>>(),
        vec!["item-1", "item-2"]
    );

    let oldest = store
        .task_snapshot_with(
            binding.task_id,
            TaskSnapshotQuery {
                before_seq: older_hydrate.before_seq,
                limit: Some(2),
                ..TaskSnapshotQuery::default()
            },
        )
        .expect("oldest page");
    let oldest_hydrate = oldest.hydrate.expect("oldest hydrate");
    assert_eq!(oldest_hydrate.items.len(), 1);
    assert!(!oldest_hydrate.has_more_older);
    assert_eq!(oldest_hydrate.items[0].provider_item_id, "item-0");
}

#[test]
fn default_hydrate_extends_past_item_floor_when_tools_crowd_out_messages() {
    let (store, binding) = bound_store(ProviderKind::Codex);
    // Oldest: real conversation. Newest: a tool-heavy stretch larger than
    // the item floor, which used to evict every message from the window.
    for index in 0..40 {
        store
            .apply_reduced_event(
                &binding,
                &completed_message(
                    &format!("msg-{index:03}"),
                    ItemKind::AgentMessage,
                    &format!("message body {index}"),
                ),
            )
            .expect("persist message item");
    }
    for index in 0..400 {
        store
            .apply_reduced_event(
                &binding,
                &completed_message(
                    &format!("cmd-{index:03}"),
                    ItemKind::CommandExecution,
                    &format!("command output {index}"),
                ),
            )
            .expect("persist command item");
    }

    let snapshot = store.task_snapshot(binding.task_id).expect("hydrate");
    let hydrate = snapshot.hydrate.expect("hydrate");
    assert_eq!(
        hydrate.items.len(),
        440,
        "window keeps extending to reach messages"
    );
    assert!(!hydrate.has_more_older);
    let messages = hydrate
        .items
        .iter()
        .filter(|item| item.kind == ItemKind::AgentMessage)
        .count();
    assert_eq!(messages, 40);
}

#[test]
fn default_hydrate_stops_at_message_target_and_pages_older() {
    let (store, binding) = bound_store(ProviderKind::Codex);
    for index in 0..500 {
        store
            .apply_reduced_event(
                &binding,
                &completed_message(
                    &format!("msg-{index:03}"),
                    ItemKind::AgentMessage,
                    &format!("message body {index}"),
                ),
            )
            .expect("persist message item");
    }

    let snapshot = store.task_snapshot(binding.task_id).expect("hydrate");
    let hydrate = snapshot.hydrate.expect("hydrate");
    // Message-dense chats satisfy the message target within the item
    // floor, so the window matches the historical tail size.
    assert_eq!(hydrate.items.len(), TASK_PROJECTION_HYDRATE_TAIL);
    assert!(hydrate.has_more_older);
    assert_eq!(hydrate.items[0].provider_item_id, "msg-200");

    let older = store
        .task_snapshot_with(
            binding.task_id,
            TaskSnapshotQuery {
                before_seq: hydrate.before_seq,
                ..TaskSnapshotQuery::default()
            },
        )
        .expect("older page");
    let older_hydrate = older.hydrate.expect("older hydrate");
    assert_eq!(older_hydrate.items.len(), 200);
    assert!(!older_hydrate.has_more_older);
    assert_eq!(older_hydrate.items[0].provider_item_id, "msg-000");
    assert_eq!(older_hydrate.items[199].provider_item_id, "msg-199");
}

#[test]
fn snapshot_empty_task_returns_empty_compact_hydrate() {
    let (store, binding) = bound_store(ProviderKind::Codex);
    let snapshot = store.task_snapshot(binding.task_id).expect("empty hydrate");
    assert_eq!(snapshot.watermark_seq, 0);
    assert_eq!(snapshot.reset_seq, 0);
    assert!(!snapshot.cache_matched);
    let hydrate = snapshot.hydrate.expect("hydrate");
    assert!(hydrate.items.is_empty());
    assert!(hydrate.approvals.is_empty());
    assert!(!hydrate.has_more_older);
    assert!(hydrate.before_seq.is_none());
}

#[test]
fn snapshot_does_not_parse_unmaterialized_adversarial_audit_rows() {
    let (store, binding) = bound_store(ProviderKind::Codex);
    let event = store
        .apply_reduced_event(
            &binding,
            &append_message("message", "safe", Utc::now(), Utc::now()),
        )
        .expect("persist item");
    let watermark = {
        let connection = store.connection.lock();
        connection
            .execute(
                "INSERT INTO integrator_event_log(task_id,provider_session_id,runtime_session_id,process_id,thread_id,turn_id,method,audit_json,audit_truncated,occurred_at,projection_json) VALUES (?1,?2,?3,?4,?5,NULL,'fixture/adversarial','not-json',1,?6,'{')",
                params![
                    binding.task_id.to_string(),
                    binding.provider_session_id.expect("provider session").to_string(),
                    binding.runtime_session_id.to_string(),
                    binding.process_id,
                    binding.thread_id.as_deref().expect("thread"),
                    Utc::now().to_rfc3339()
                ],
            )
            .expect("insert adversarial audit row");
        connection.last_insert_rowid()
    };
    let snapshot = store.task_snapshot(binding.task_id).expect("load snapshot");
    assert_eq!(snapshot.watermark_seq, watermark);
    let hydrate = snapshot.hydrate.expect("hydrate");
    assert_eq!(hydrate.items.len(), 1);
    let RuntimeProjection::ItemChanged { item } = event.projection else {
        panic!("expected item event");
    };
    assert_eq!(hydrate.items[0].id, item.id);
    assert_eq!(
        redundant_event_projection_count(&store, binding.task_id),
        1,
        "only the deliberately malformed legacy fixture carries projection_json"
    );
}

#[test]
fn stop_request_is_state_idempotent_for_acp_sessions() {
    let (store, binding) = bound_store(ProviderKind::Cursor);
    let occurred_at = Utc::now();
    store
        .apply_reduced_event(
            &binding,
            &ReducedProviderEvent {
                method: "client/acp/turnStarted".into(),
                thread_id: "thread-fixture".into(),
                turn_id: Some("turn-1".into()),
                audit_json: "{}".into(),
                audit_truncated: false,
                mutation: ProjectionMutation::Turn(TurnProjection {
                    id: "turn-1".into(),
                    status: TurnStatus::InProgress,
                    stop_requested: false,
                    error: None,
                    started_at: Some(occurred_at),
                    completed_at: None,
                }),
                occurred_at,
            },
        )
        .expect("persist turn");
    let first = store.request_stop(binding.task_id).expect("first stop");
    let second = store.request_stop(binding.task_id).expect("second stop");
    assert!(!first.result.already_requested);
    assert!(second.result.already_requested);
    assert_eq!(second.event.expect("stop event").provider, "cursor");
    assert_eq!(redundant_event_projection_count(&store, binding.task_id), 0);
}

fn persist_item(store: &LocalStore, binding: &RuntimeBinding, turn_id: &str, item: ItemProjection) {
    let occurred_at = item.updated_at;
    store
        .apply_reduced_event(
            binding,
            &ReducedProviderEvent {
                method: "item/completed".into(),
                thread_id: binding.thread_id.clone().unwrap_or_default(),
                turn_id: Some(turn_id.into()),
                audit_json: "{}".into(),
                audit_truncated: false,
                mutation: ProjectionMutation::ReplaceItem(item),
                occurred_at,
            },
        )
        .expect("persist handoff fixture item");
}

fn base_item(id: &str, kind: ItemKind, turn_offset_secs: i64) -> ItemProjection {
    let updated_at = Utc::now() + chrono::Duration::seconds(turn_offset_secs);
    ItemProjection {
        id: format!("fixture:{id}"),
        provider_item_id: id.into(),
        kind,
        status: ItemStatus::Completed,
        title: None,
        body: None,
        native_skill: None,
        phase: None,
        command: None,
        cwd: None,
        output: None,
        exit_code: None,
        file_changes: None,
        mcp_server: None,
        mcp_tool: None,
        tool_input: None,
        truncated: false,
        updated_at,
    }
}

#[test]
fn handoff_digest_happy_packs_read_meat_and_chat() {
    let (store, binding) = bound_store(ProviderKind::Claude);
    let mut user = base_item("u1", ItemKind::UserMessage, 1);
    user.body = Some("fix the overflow menu".into());
    persist_item(&store, &binding, "turn-1", user);

    let mut read = base_item("r1", ItemKind::McpTool, 2);
    read.title = Some("Read".into());
    read.mcp_tool = Some("Read".into());
    read.tool_input = Some(r#"{"path":"apps/desktop/src/components/TaskSidebar.tsx"}"#.into());
    read.output = Some("export function TaskSidebar() {\n  return null;\n}".into());
    persist_item(&store, &binding, "turn-1", read);

    let mut assistant = base_item("a1", ItemKind::AgentMessage, 3);
    assistant.body = Some("Menus are right-anchored so they open left.".into());
    persist_item(&store, &binding, "turn-1", assistant);

    let digest = store
        .task_handoff_digest(binding.task_id, HandoffDigestOptions::default())
        .expect("digest")
        .expect("present");
    assert!(digest.text.contains("fix the overflow menu"));
    assert!(digest.text.contains("Read"));
    assert!(digest.text.contains("TaskSidebar"));
    assert!(digest.text.contains("right-anchored"));
    assert!(digest.image_paths.is_empty());
}

#[test]
fn handoff_digest_degraded_drops_oldest_turns_and_stubs_web_search() {
    let (store, binding) = bound_store(ProviderKind::Codex);
    for index in 0..12 {
        let mut user = base_item(&format!("u{index}"), ItemKind::UserMessage, index * 3);
        user.body = Some(format!("turn-{index}-user-marker"));
        persist_item(&store, &binding, &format!("turn-{index}"), user);

        let mut search = base_item(&format!("s{index}"), ItemKind::McpTool, index * 3 + 1);
        search.mcp_tool = Some("WebSearch".into());
        search.title = Some("WebSearch".into());
        search.tool_input = Some(r#"{"query":"overflow menus"}"#.into());
        search.output = Some("x".repeat(20_000));
        persist_item(&store, &binding, &format!("turn-{index}"), search);

        let mut assistant = base_item(&format!("a{index}"), ItemKind::AgentMessage, index * 3 + 2);
        assistant.body = Some(format!("turn-{index}-assistant"));
        persist_item(&store, &binding, &format!("turn-{index}"), assistant);
    }

    let digest = store
        .task_handoff_digest(
            binding.task_id,
            HandoffDigestOptions {
                max_turns: 10,
                max_tokens: 50_000,
                max_images: 4,
            },
        )
        .expect("digest")
        .expect("present");
    assert!(
        !digest.text.contains("turn-0-user-marker"),
        "oldest turn should drop: {}",
        digest.text
    );
    assert!(digest.text.contains("turn-11-user-marker"));
    assert!(digest.text.contains("chars truncated"));
    assert!(
        !digest.text.contains(&"x".repeat(500)),
        "web search body must not dump into the digest"
    );
}

#[test]
fn handoff_digest_images_reattach_existing_and_note_missing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let existing = dir.path().join("shot.png");
    std::fs::write(&existing, [0x89, 0x50, 0x4E, 0x47]).expect("write png");
    let missing = dir.path().join("gone.png");

    let (store, binding) = bound_store(ProviderKind::Cursor);
    let mut user = base_item("u-img", ItemKind::UserMessage, 1);
    user.body = Some(format!(
        "what is this?\n\nAttached files:\n- {}\n- {}",
        existing.display(),
        missing.display()
    ));
    persist_item(&store, &binding, "turn-img", user);

    let digest = store
        .task_handoff_digest(binding.task_id, HandoffDigestOptions::default())
        .expect("digest")
        .expect("present");
    assert_eq!(digest.image_paths, vec![existing]);
    assert!(digest.text.contains("missing on disk"));
    assert!(digest.text.contains("gone.png"));
}

#[test]
fn handoff_digest_adversarial_truncates_huge_command_dumps() {
    let (store, binding) = bound_store(ProviderKind::Antigravity);
    let mut command = base_item("cmd", ItemKind::CommandExecution, 1);
    command.command = Some("cat /dev/urandom | head -c 50000".into());
    command.exit_code = Some(0);
    command.output = Some("\u{0000}".repeat(50_000));
    persist_item(&store, &binding, "turn-cmd", command);

    let digest = store
        .task_handoff_digest(binding.task_id, HandoffDigestOptions::default())
        .expect("digest")
        .expect("present");
    assert!(digest.text.contains("chars truncated"));
    assert!(digest.text.len() < 5_000);
}

#[test]
fn handoff_digest_restart_rebuilds_from_sqlite() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("handoff.sqlite3");
    let task_id = {
        let store = LocalStore::open(&db).expect("open store");
        let (store_ref, binding) = {
            let task = store
                .create_task(NewTask {
                    kind: TaskKind::Code,
                    title: "Restart handoff".into(),
                    repository_path: None,
                    worktree_path: None,
                    runtime: None,
                    model: None,
                    effort: None,
                    parent_task_id: None,
                })
                .expect("task");
            let binding = store
                .create_runtime_binding(task.id, "proc", ProviderKind::Grok)
                .expect("binding");
            let binding = store
                .attach_provider_thread(&binding, "thread-grok")
                .expect("thread");
            (store, binding)
        };
        let mut user = base_item("u", ItemKind::UserMessage, 1);
        user.body = Some("survive restart marker".into());
        persist_item(&store_ref, &binding, "turn-1", user);
        binding.task_id
    };

    let reopened = LocalStore::open(&db).expect("reopen");
    let digest = reopened
        .task_handoff_digest(task_id, HandoffDigestOptions::default())
        .expect("digest")
        .expect("present");
    assert!(digest.text.contains("survive restart marker"));
}

#[test]
fn handoff_digest_is_provider_neutral_across_mixed_history() {
    let store = LocalStore::open_in_memory().expect("open");
    let task = store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Mixed providers".into(),
            repository_path: None,
            worktree_path: None,
            runtime: None,
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("task");

    let claude = store
        .create_runtime_binding(task.id, "claude-proc", ProviderKind::Claude)
        .expect("claude binding");
    let claude = store
        .attach_provider_thread(&claude, "claude-thread")
        .expect("claude thread");
    let mut claude_user = base_item("cu", ItemKind::UserMessage, 1);
    claude_user.body = Some("claude said look at styles".into());
    persist_item(&store, &claude, "turn-claude", claude_user);

    let codex = store
        .create_runtime_binding(task.id, "codex-proc", ProviderKind::Codex)
        .expect("codex binding");
    let codex = store
        .attach_provider_thread(&codex, "codex-thread")
        .expect("codex thread");
    let mut codex_assistant = base_item("ca", ItemKind::AgentMessage, 2);
    codex_assistant.body = Some("codex found right: 3px".into());
    persist_item(&store, &codex, "turn-codex", codex_assistant);

    let digest = store
        .task_handoff_digest(task.id, HandoffDigestOptions::default())
        .expect("digest")
        .expect("present");
    assert!(digest.text.contains("claude said look at styles"));
    assert!(digest.text.contains("codex found right: 3px"));
}
