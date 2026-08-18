use super::*;
use integrator_core::{
    ItemKind, ItemProjection, ItemStatus, RuntimeBinding, RuntimeProjection,
    RuntimeProjectionEvent, TurnProjection, TurnStatus,
};
use integrator_runtime::{ProjectionMutation, ReducedProviderEvent};

/// Drives the real ingest path so the forked rows under test are the ones
/// a live provider would actually have written.
fn seed_conversation(store: &LocalStore, task_id: TaskId) -> Vec<RuntimeProjectionEvent> {
    let binding = store
        .create_runtime_binding(task_id, "fork-process", ProviderKind::Codex)
        .expect("create runtime binding");
    let binding = store
        .attach_provider_thread(&binding, "fork-thread")
        .expect("attach provider thread");
    let started = Utc::now();
    [
        (ItemKind::UserMessage, "port the parser to the new lexer"),
        (ItemKind::AgentMessage, "here is the port"),
        (ItemKind::UserMessage, "now delete the old lexer"),
        (ItemKind::AgentMessage, "deleted"),
    ]
    .into_iter()
    .enumerate()
    .map(|(index, (kind, body))| {
        let item = ItemProjection {
            id: format!("codex:fork-thread:turn-1:item-{index}"),
            provider_item_id: format!("item-{index}"),
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
            updated_at: started + chrono::Duration::seconds(index as i64),
        };
        store
            .apply_reduced_event(
                &binding,
                &ReducedProviderEvent {
                    method: "item/completed".into(),
                    thread_id: "fork-thread".into(),
                    turn_id: Some("turn-1".into()),
                    audit_json: "{}".into(),
                    audit_truncated: false,
                    mutation: ProjectionMutation::ReplaceItem(item),
                    occurred_at: started + chrono::Duration::seconds(index as i64),
                },
            )
            .expect("apply seeded event")
    })
    .collect()
}

fn item_bodies(store: &LocalStore, task_id: TaskId) -> Vec<String> {
    store
        .task_snapshot(task_id)
        .expect("hydrate snapshot")
        .hydrate
        .expect("compact hydrate")
        .items
        .into_iter()
        .filter_map(|item| item.body)
        .collect()
}

fn legacy_database_before(path: &Path, next_version: i64) -> Connection {
    let mut connection = Connection::open(path).expect("open legacy fixture");
    LocalStore::configure(&connection).expect("configure legacy fixture");
    connection
        .execute(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
            [],
        )
        .expect("create migration ledger");
    let applied_at = Utc::now().to_rfc3339();
    for (version, sql) in MIGRATIONS
        .iter()
        .filter(|(version, _)| *version < next_version)
    {
        let transaction = connection.transaction().expect("migration transaction");
        transaction
            .execute_batch(sql)
            .expect("apply legacy migration");
        transaction
            .execute(
                "INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?1,?2)",
                params![version, applied_at],
            )
            .expect("record legacy migration");
        transaction.commit().expect("commit legacy migration");
    }
    connection
}

fn fork_source(store: &LocalStore) -> Task {
    store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Port the parser".into(),
            repository_path: Some(PathBuf::from("/repo")),
            worktree_path: None,
            runtime: Some("codex".into()),
            model: Some("gpt-5-codex".into()),
            effort: Some("high".into()),
            parent_task_id: None,
        })
        .expect("create fork source")
}

#[test]
fn whole_fork_copies_the_transcript_and_leaves_the_source_untouched() {
    let store = LocalStore::open_in_memory().expect("open store");
    let source = fork_source(&store);
    seed_conversation(&store, source.id);

    let fork = store
        .fork_task(source.id, None, "Port the parser: Copy 1".into())
        .expect("fork whole task");

    assert_ne!(fork.id, source.id);
    assert_eq!(fork.title, "Port the parser: Copy 1");
    // Routing settings must survive or the copy answers with a different
    // model than the conversation it continues.
    assert_eq!(fork.runtime, source.runtime);
    assert_eq!(fork.model, source.model);
    assert_eq!(fork.effort, source.effort);
    assert_eq!(fork.repository_path, source.repository_path);

    assert_eq!(
        item_bodies(&store, fork.id),
        vec![
            "port the parser to the new lexer",
            "here is the port",
            "now delete the old lexer",
            "deleted",
        ]
    );
    assert_eq!(item_bodies(&store, source.id), item_bodies(&store, fork.id));

    // Renaming or deleting a fork must not reach back into the source.
    store
        .update_task_metadata(fork.id, Some("Renamed fork".into()), None, None)
        .expect("rename fork");
    assert_eq!(
        store.get_task(source.id).expect("reread source").title,
        "Port the parser"
    );
    store.remove_task(fork.id).expect("remove fork");
    assert_eq!(item_bodies(&store, source.id).len(), 4);
}

#[test]
fn branch_truncates_at_the_chosen_item_and_digests_only_the_kept_history() {
    let store = LocalStore::open_in_memory().expect("open store");
    let source = fork_source(&store);
    seed_conversation(&store, source.id);

    let branch = store
        .fork_task(
            source.id,
            Some("codex:fork-thread:turn-1:item-1"),
            "Port the parser: Branch 1".into(),
        )
        .expect("branch at the first reply");

    assert_eq!(
        item_bodies(&store, branch.id),
        vec!["port the parser to the new lexer", "here is the port"]
    );

    // The digest is what the branch's first prompt actually carries to a
    // fresh provider session, so truncation has to hold there too.
    let digest = store
        .task_conversation_digest(branch.id, 6 * 1024)
        .expect("branch digest")
        .expect("branch has history");
    assert!(digest.contains("here is the port"));
    assert!(
        !digest.contains("now delete the old lexer"),
        "history past the branch point leaked into the digest: {digest}"
    );

    // Resuming would make the provider replay its own untruncated
    // transcript and ignore every row copied above.
    assert!(
        store
            .provider_resume_state(branch.id)
            .expect("read branch resume state")
            .is_none()
    );
    assert!(
        !store
            .list_provider_sessions()
            .expect("list sessions")
            .iter()
            .any(|session| session.task_id == branch.id
                && session.provider_thread_id == "fork-thread"),
        "the branch must not claim the source's provider thread"
    );
}

#[test]
fn truncate_from_edit_clears_the_tip_and_drops_resume_state() {
    let store = LocalStore::open_in_memory().expect("open store");
    let source = fork_source(&store);
    seed_conversation(&store, source.id);
    store
        .upsert_provider_resume_state(&ProviderResumeState {
            task_id: source.id,
            provider: ProviderKind::Codex,
            session_ref: "resume-thread".into(),
            repository_root: std::env::temp_dir().join("session-store-resume-fixture"),
            permission: "project-write".into(),
            delegation: "off".into(),
            updated_at: Utc::now(),
        })
        .expect("seed resume state");

    // item-2 is the second user message ("now delete…"); cutting there
    // keeps the first exchange and drops that prompt plus its reply.
    store
        .truncate_task_from(source.id, "codex:fork-thread:turn-1:item-2", false)
        .expect("truncate without salvage");
    assert_eq!(
        item_bodies(&store, source.id),
        vec!["port the parser to the new lexer", "here is the port"]
    );
    assert!(
        store
            .provider_resume_state(source.id)
            .expect("read resume")
            .is_none()
    );
    let digest = store
        .task_conversation_digest(source.id, 6 * 1024)
        .expect("digest")
        .expect("history");
    assert!(!digest.contains("deleted"));
    assert!(!digest.contains("discarded by a later edit"));
}

#[test]
fn truncate_with_save_context_keeps_discarded_replies_in_the_digest() {
    let store = LocalStore::open_in_memory().expect("open store");
    let source = fork_source(&store);
    seed_conversation(&store, source.id);

    store
        .truncate_task_from(source.id, "codex:fork-thread:turn-1:item-2", true)
        .expect("truncate with salvage");

    assert_eq!(
        item_bodies(&store, source.id),
        vec!["port the parser to the new lexer", "here is the port"]
    );
    let digest = store
        .task_conversation_digest(source.id, 6 * 1024)
        .expect("digest")
        .expect("history");
    assert!(
        digest.contains("deleted"),
        "salvaged assistant reply missing from digest: {digest}"
    );
    assert!(digest.contains("discarded by a later edit"));
}

#[test]
fn fork_while_running_excludes_the_live_turn_and_keeps_earlier_branching_available() {
    let store = LocalStore::open_in_memory().expect("open store");
    let source = fork_source(&store);
    seed_conversation(&store, source.id);

    assert!(matches!(
        store.fork_task(
            source.id,
            Some("codex:fork-thread:turn-1:item-99"),
            "x".into()
        ),
        Err(IntegratorError::NotFound(_))
    ));

    let binding = store
        .create_runtime_binding(source.id, "running-process", ProviderKind::Codex)
        .expect("create runtime binding");
    let binding = store
        .attach_provider_thread(&binding, "fork-thread")
        .expect("attach provider thread");
    store
        .apply_reduced_event(
            &binding,
            &ReducedProviderEvent {
                method: "turn/started".into(),
                thread_id: "fork-thread".into(),
                turn_id: Some("turn-2".into()),
                audit_json: "{}".into(),
                audit_truncated: false,
                mutation: ProjectionMutation::Turn(TurnProjection {
                    id: "turn-2".into(),
                    status: TurnStatus::InProgress,
                    stop_requested: false,
                    error: None,
                    started_at: Some(Utc::now()),
                    completed_at: None,
                }),
                occurred_at: Utc::now(),
            },
        )
        .expect("start a turn");

    for (provider_item_id, kind, status, body) in [
        (
            "live-user",
            ItemKind::UserMessage,
            ItemStatus::Completed,
            "unfinished request",
        ),
        (
            "live-assistant",
            ItemKind::AgentMessage,
            ItemStatus::InProgress,
            "partial reply",
        ),
    ] {
        store
            .apply_reduced_event(
                &binding,
                &ReducedProviderEvent {
                    method: "item/updated".into(),
                    thread_id: "fork-thread".into(),
                    turn_id: Some("turn-2".into()),
                    audit_json: "{}".into(),
                    audit_truncated: false,
                    mutation: ProjectionMutation::ReplaceItem(ItemProjection {
                        id: format!("codex:fork-thread:turn-2:{provider_item_id}"),
                        provider_item_id: provider_item_id.into(),
                        kind,
                        status,
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
                        updated_at: Utc::now(),
                    }),
                    occurred_at: Utc::now(),
                },
            )
            .expect("append live item");
    }

    let copy = store
        .fork_task(source.id, None, "Port the parser: Copy 1".into())
        .expect("copy settled history while source runs");
    assert_eq!(
        item_bodies(&store, copy.id),
        vec![
            "port the parser to the new lexer",
            "here is the port",
            "now delete the old lexer",
            "deleted",
        ]
    );
    assert_eq!(
        item_bodies(&store, source.id),
        vec![
            "port the parser to the new lexer",
            "here is the port",
            "now delete the old lexer",
            "deleted",
            "unfinished request",
            "partial reply",
        ]
    );
    assert!(
        store
            .task_has_unfinished_turn(source.id)
            .expect("source turn remains live")
    );
    assert!(
        !store
            .task_has_unfinished_turn(copy.id)
            .expect("copy contains settled history only")
    );

    let branch = store
        .fork_task(
            source.id,
            Some("codex:fork-thread:turn-1:item-1"),
            "Port the parser: Branch 1".into(),
        )
        .expect("branch above the live turn");
    assert_eq!(
        item_bodies(&store, branch.id),
        vec!["port the parser to the new lexer", "here is the port"]
    );

    assert!(matches!(
        store.fork_task(
            source.id,
            Some("codex:fork-thread:turn-2:live-assistant"),
            "x".into()
        ),
        Err(IntegratorError::InvalidInput(_))
    ));
    assert!(
        !store
            .list_tasks()
            .expect("list tasks")
            .iter()
            .any(|task| task.title == "x")
    );
}

fn create_naming_task(store: &LocalStore) -> Task {
    store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Coding session".into(),
            repository_path: None,
            worktree_path: None,
            runtime: Some("codex".into()),
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create naming task")
}

#[test]
fn title_generation_claim_is_one_shot_and_manual_rename_wins() {
    let store = LocalStore::open_in_memory().expect("open store");
    let task = create_naming_task(&store);
    assert!(
        store
            .claim_task_title_generation(task.id, "Coding session")
            .expect("first claim")
    );
    assert!(
        !store
            .claim_task_title_generation(task.id, "Coding session")
            .expect("duplicate claim")
    );
    store
        .update_task_metadata(task.id, Some("My own title".into()), None, None)
        .expect("manual rename");
    assert_eq!(
        store
            .compare_and_set_task_title(task.id, "Coding session", "Generated title")
            .expect("late generated title"),
        None
    );
    assert_eq!(store.get_task(task.id).expect("task").title, "My own title");
}

#[test]
fn title_generation_claim_survives_restart() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = directory.path().join("title-claim.sqlite3");
    let task_id = {
        let store = LocalStore::open(&database).expect("open store");
        let task = create_naming_task(&store);
        assert!(
            store
                .claim_task_title_generation(task.id, "Coding session")
                .expect("claim")
        );
        task.id
    };
    let reopened = LocalStore::open(&database).expect("reopen store");
    assert!(
        !reopened
            .claim_task_title_generation(task_id, "Coding session")
            .expect("persistent claim")
    );
}

#[test]
fn commit_message_generation_reuses_completed_diff_and_blocks_duplicate_spend() {
    let store = LocalStore::open_in_memory().expect("open store");
    let task = create_naming_task(&store);
    assert_eq!(
        store
            .claim_commit_message_generation(task.id, "codex", "diff-a")
            .expect("claim"),
        CommitMessageGenerationClaim::Claimed
    );
    assert_eq!(
        store
            .claim_commit_message_generation(task.id, "codex", "diff-a")
            .expect("pending claim"),
        CommitMessageGenerationClaim::InProgress
    );
    store
        .complete_commit_message_generation(
            task.id,
            "codex",
            "diff-a",
            "feat: generate commit subjects",
        )
        .expect("complete");
    assert_eq!(
        store
            .claim_commit_message_generation(task.id, "codex", "diff-a")
            .expect("cached claim"),
        CommitMessageGenerationClaim::Cached("feat: generate commit subjects".into())
    );
    assert_eq!(
        store
            .claim_commit_message_generation(task.id, "codex", "diff-b")
            .expect("changed diff"),
        CommitMessageGenerationClaim::Claimed
    );
}

#[test]
fn abandoned_commit_message_claims_are_retryable_but_cached_results_stay() {
    let store = LocalStore::open_in_memory().expect("open store");
    let task = create_naming_task(&store);
    assert_eq!(
        store
            .claim_commit_message_generation(task.id, "antigravity", "diff-a")
            .expect("claim"),
        CommitMessageGenerationClaim::Claimed
    );
    store
        .abandon_commit_message_generation(task.id, "antigravity", "diff-a")
        .expect("release failed generation");
    assert_eq!(
        store
            .claim_commit_message_generation(task.id, "antigravity", "diff-a")
            .expect("re-claim"),
        CommitMessageGenerationClaim::Claimed
    );
    store
        .complete_commit_message_generation(task.id, "antigravity", "diff-a", "fix: retry")
        .expect("complete");
    store
        .abandon_commit_message_generation(task.id, "antigravity", "diff-a")
        .expect("abandon is a no-op once cached");
    assert_eq!(
        store
            .claim_commit_message_generation(task.id, "antigravity", "diff-a")
            .expect("cached claim"),
        CommitMessageGenerationClaim::Cached("fix: retry".into())
    );
}

#[test]
fn stale_unfinished_commit_message_claims_expire() {
    let store = LocalStore::open_in_memory().expect("open store");
    let task = create_naming_task(&store);
    assert_eq!(
        store
            .claim_commit_message_generation(task.id, "antigravity", "diff-a")
            .expect("claim"),
        CommitMessageGenerationClaim::Claimed
    );
    // Age the claim past the TTL as if the app crashed mid-generation.
    let started =
        (Utc::now() - chrono::Duration::seconds(COMMIT_MESSAGE_CLAIM_TTL_SECONDS + 5)).to_rfc3339();
    store
        .connection
        .lock()
        .execute(
            "UPDATE commit_message_jobs SET started_at = ?1 WHERE task_id = ?2",
            params![started, task.id.to_string()],
        )
        .expect("age claim");
    assert_eq!(
        store
            .claim_commit_message_generation(task.id, "antigravity", "diff-a")
            .expect("expired claim is re-claimable"),
        CommitMessageGenerationClaim::Claimed
    );
}

#[test]
fn commit_message_generation_cache_survives_restart() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = directory.path().join("commit-message-cache.sqlite3");
    let task_id = {
        let store = LocalStore::open(&database).expect("open store");
        let task = create_naming_task(&store);
        store
            .claim_commit_message_generation(task.id, "claude", "diff-a")
            .expect("claim");
        store
            .complete_commit_message_generation(
                task.id,
                "claude",
                "diff-a",
                "fix: preserve staged changes",
            )
            .expect("complete");
        task.id
    };
    let reopened = LocalStore::open(&database).expect("reopen store");
    assert_eq!(
        reopened
            .claim_commit_message_generation(task_id, "claude", "diff-a")
            .expect("cached after restart"),
        CommitMessageGenerationClaim::Cached("fix: preserve staged changes".into())
    );
}

#[test]
fn migration_and_local_round_trip() {
    let store = LocalStore::open_in_memory().expect("open store");
    let task = store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Implement adapter".into(),
            repository_path: Some("C:/repo".into()),
            worktree_path: Some("C:/worktree".into()),
            runtime: None,
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create task");
    store
        .update_task_state(task.id, TaskState::Running)
        .expect("update task");
    store
        .update_task_metadata(
            task.id,
            Some("Renamed chat".into()),
            Some(true),
            Some(false),
        )
        .expect("update task metadata");
    store
        .update_task_routing(task.id, "cursor", "composer-2.5", Some("high"))
        .expect("update task routing");
    store
        .set_setting("appearance.theme", Value::String("graphite".into()))
        .expect("set setting");
    let exported = store.export().expect("export");
    assert_eq!(exported.tasks.len(), 1);
    assert_eq!(exported.tasks[0].state, TaskState::Running);
    assert_eq!(exported.tasks[0].title, "Renamed chat");
    assert_eq!(exported.tasks[0].runtime.as_deref(), Some("cursor"));
    assert_eq!(exported.tasks[0].model.as_deref(), Some("composer-2.5"));
    assert_eq!(exported.tasks[0].effort.as_deref(), Some("high"));
    assert!(exported.tasks[0].pinned);
    assert!(!exported.tasks[0].archived);
    assert_eq!(exported.settings.len(), 1);

    let usage_rows = store.provider_usage_rows().expect("provider usage rows");
    assert_eq!(usage_rows.len(), 1);
    assert_eq!(usage_rows[0].0, "cursor");
    assert_eq!(usage_rows[0].1, 1);
    assert_eq!(usage_rows[0].2, 0);
    assert_eq!(usage_rows[0].3.total_tokens, 0);
}

#[test]
fn provider_resume_state_round_trips_without_provider_credentials() {
    let store = LocalStore::open_in_memory().expect("open store");
    let task = create_naming_task(&store);
    let repository = std::env::temp_dir().join("integrator-resume-fixture");
    let state = ProviderResumeState {
        task_id: task.id,
        provider: ProviderKind::Antigravity,
        session_ref: "conversation-fixture".into(),
        repository_root: repository.clone(),
        permission: "project-write".into(),
        delegation: "off".into(),
        updated_at: Utc::now(),
    };
    store
        .upsert_provider_resume_state(&state)
        .expect("persist resume state");

    let restored = store
        .provider_resume_state(task.id)
        .expect("read resume state")
        .expect("resume state");
    assert_eq!(restored.provider, ProviderKind::Antigravity);
    assert_eq!(restored.session_ref, "conversation-fixture");
    assert_eq!(restored.repository_root, repository);
    assert_eq!(
        store.export().expect("export").provider_resume_states,
        vec![restored]
    );
}

#[test]
fn clear_all_data_preserves_schema_and_migration_history() {
    let store = LocalStore::open_in_memory().expect("open store");
    let task = store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Clearable task".into(),
            repository_path: None,
            worktree_path: None,
            runtime: None,
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create task");
    store
        .set_setting("appearance.theme", Value::String("graphite".into()))
        .expect("set setting");
    let directory = tempfile::tempdir().expect("temp directory");
    let common = directory.path().join(".git");
    store
        .upsert_trusted_project(
            "Clearable project",
            directory.path(),
            Some((directory.path(), &common)),
        )
        .expect("register project");
    let now = Utc::now();
    let provider_session = ProviderSession {
        id: ProviderSessionId::new(),
        task_id: task.id,
        provider: ProviderKind::Codex,
        provider_thread_id: "clearable-thread".into(),
        created_at: now,
        updated_at: now,
    };
    store
        .upsert_provider_session(&provider_session)
        .expect("provider session");
    store
        .insert_runtime_session(&RuntimeSession {
            id: RuntimeSessionId::new(),
            task_id: task.id,
            provider_session_id: Some(provider_session.id),
            process_id: Some("clearable-process".into()),
            status: "completed".into(),
            started_at: now,
            ended_at: Some(now),
        })
        .expect("runtime session");

    store.clear_all_data().expect("clear local data");

    let export = store.export().expect("export after clear");
    assert!(export.projects.is_empty());
    assert!(export.tasks.is_empty());
    assert!(export.settings.is_empty());
    assert!(export.provider_sessions.is_empty());
    assert!(export.runtime_sessions.is_empty());

    let connection = store.connection.lock();
    let migration_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .expect("migration history");
    assert_eq!(migration_count, MIGRATIONS.len() as i64);
    let foreign_keys: i64 = connection
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .expect("foreign key setting");
    assert_eq!(foreign_keys, 1);
    drop(connection);

    store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Schema remains usable".into(),
            repository_path: None,
            worktree_path: None,
            runtime: None,
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create task after clear");
}

#[test]
fn credentials_are_rejected_from_settings() {
    let store = LocalStore::open_in_memory().expect("open store");
    let error = store
        .set_setting(
            "provider.api_token",
            Value::String("not-a-real-token".into()),
        )
        .expect_err("credential key must fail");
    assert!(error.to_string().contains("credentials"));
}

#[test]
fn database_reopens_after_migration() {
    let directory = tempfile::tempdir().expect("temp directory");
    let path = directory.path().join("integrator.sqlite3");
    LocalStore::open(&path).expect("first open");
    LocalStore::open(&path).expect("second open");
}

#[test]
fn provider_neutral_schema_migration_preserves_legacy_projects_and_transcripts() {
    let directory = tempfile::tempdir().expect("temp directory");
    let path = directory.path().join("legacy-v21.sqlite3");
    let repository = directory.path().join("legacy-project");
    std::fs::create_dir(&repository).expect("create legacy project folder");
    let project_id = ProjectId::new();
    let task_id = TaskId::new();
    let provider_session_id = ProviderSessionId::new();
    let runtime_session_id = RuntimeSessionId::new();
    let now = Utc::now();
    let item = ItemProjection {
        id: "legacy-stable-message".into(),
        provider_item_id: "legacy-provider-message".into(),
        kind: ItemKind::UserMessage,
        status: ItemStatus::Completed,
        title: None,
        body: Some("migrationkeepsproject transcript survives".into()),
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
        updated_at: now,
    };
    let snapshot_event = RuntimeProjectionEvent {
        seq: 1,
        task_id,
        provider_session_id,
        provider: "codex".into(),
        thread_id: "legacy-thread".into(),
        turn_id: Some("legacy-turn".into()),
        occurred_at: now,
        projection: RuntimeProjection::ItemChanged { item: item.clone() },
    };

    {
        let connection = legacy_database_before(&path, 22);
        connection.execute(
            "INSERT INTO trusted_projects(id,display_name,repository_root,git_common_directory,created_at,last_opened_at) VALUES (?1,'Legacy project',?2,?3,?4,?4)",
            params![project_id.to_string(), repository.to_string_lossy(), repository.join(".git").to_string_lossy(), now.to_rfc3339()],
        ).expect("insert legacy project");
        connection.execute(
            "INSERT INTO project_git_repositories(project_id,repository_root,git_common_directory) VALUES (?1,?2,?3)",
            params![project_id.to_string(), repository.to_string_lossy(), repository.join(".git").to_string_lossy()],
        ).expect("insert legacy project git identity");
        connection.execute(
            "INSERT INTO tasks(id,title,repository_path,state,runtime,created_at,updated_at) VALUES (?1,'Legacy research',?2,'ready','codex',?3,?3)",
            params![task_id.to_string(), repository.to_string_lossy(), now.to_rfc3339()],
        ).expect("insert legacy task");
        connection.execute(
            "INSERT INTO provider_sessions(id,task_id,provider,provider_thread_id,created_at,updated_at) VALUES (?1,?2,'codex','legacy-thread',?3,?3)",
            params![provider_session_id.to_string(), task_id.to_string(), now.to_rfc3339()],
        ).expect("insert legacy provider session");
        connection.execute(
            "INSERT INTO runtime_sessions(id,task_id,provider_session_id,status,started_at,ended_at,process_id) VALUES (?1,?2,?3,'completed',?4,?4,'legacy-process')",
            params![runtime_session_id.to_string(), task_id.to_string(), provider_session_id.to_string(), now.to_rfc3339()],
        ).expect("insert legacy runtime session");
        connection.execute(
            "INSERT INTO codex_task_projection(task_id,provider_session_id,thread_id,current_turn_id,process_id,last_event_seq) VALUES (?1,?2,'legacy-thread','legacy-turn','legacy-process',1)",
            params![task_id.to_string(), provider_session_id.to_string()],
        ).expect("insert legacy task projection");
        connection.execute(
            "INSERT INTO codex_items(provider_session_id,task_id,thread_id,turn_id,item_id,stable_id,kind,status,body,updated_at,projection_json,last_event_seq,first_event_seq,first_occurred_at,snapshot_event_json) VALUES (?1,?2,'legacy-thread','legacy-turn',?3,?4,'user_message','completed',?5,?6,?7,1,1,?6,?8)",
            params![provider_session_id.to_string(), task_id.to_string(), item.provider_item_id, item.id, item.body, now.to_rfc3339(), serde_json::to_string(&item).expect("serialize item"), serde_json::to_string(&snapshot_event).expect("serialize snapshot event")],
        ).expect("insert legacy transcript item");
        connection.execute(
            "INSERT INTO codex_event_log(seq,task_id,provider_session_id,runtime_session_id,process_id,thread_id,turn_id,method,audit_json,audit_truncated,projection_json,occurred_at) VALUES (1,?1,?2,?3,'legacy-process','legacy-thread','legacy-turn','item/completed','{}',0,?4,?5)",
            params![task_id.to_string(), provider_session_id.to_string(), runtime_session_id.to_string(), serde_json::to_string(&snapshot_event).expect("serialize event"), now.to_rfc3339()],
        ).expect("insert legacy event");
    }

    let store = LocalStore::open(&path).expect("migrate populated legacy database");
    let connection = store.connection.lock();
    for old_name in [
        "codex_turns",
        "codex_items",
        "codex_approvals",
        "codex_task_projection",
        "codex_event_log",
        "codex_items_fts",
    ] {
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name=?1",
                [old_name],
                |row| row.get(0),
            )
            .expect("inspect legacy schema name");
        assert_eq!(count, 0, "legacy schema object remains: {old_name}");
    }
    let foreign_key_failures: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .expect("check migrated foreign keys");
    assert_eq!(foreign_key_failures, 0);
    drop(connection);

    assert_eq!(
        store.list_trusted_projects().expect("list projects").len(),
        1
    );
    assert_eq!(store.list_tasks().expect("list tasks")[0].id, task_id);
    assert_eq!(
        store
            .list_provider_sessions()
            .expect("list providers")
            .len(),
        1
    );
    assert_eq!(
        store.list_runtime_sessions().expect("list runtimes").len(),
        1
    );
    assert_eq!(
        item_bodies(&store, task_id),
        vec!["migrationkeepsproject transcript survives"]
    );
    let search = store
        .search_task_messages("migrationkeepsproject", 10, false)
        .expect("search migrated transcript");
    assert_eq!(search.len(), 1);
    assert_eq!(search[0].0, task_id);
    drop(store);

    let reopened = LocalStore::open(&path).expect("reopen migrated database");
    assert_eq!(
        reopened.list_tasks().expect("list reopened tasks")[0].id,
        task_id
    );
    reopened.remove_task(task_id).expect("remove migrated task");
    let connection = reopened.connection.lock();
    for table in [
        "integrator_turns",
        "integrator_items",
        "integrator_approvals",
        "integrator_task_projection",
        "integrator_event_log",
    ] {
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("check task cascade");
        assert_eq!(count, 0, "task rows remain in {table}");
    }
    drop(connection);
    assert_eq!(
        reopened
            .list_trusted_projects()
            .expect("project survives task removal")
            .len(),
        1
    );
}

#[test]
fn provider_neutral_schema_migration_rolls_back_as_one_unit() {
    let directory = tempfile::tempdir().expect("temp directory");
    let path = directory.path().join("blocked-v21.sqlite3");
    let task_id = TaskId::new();
    let provider_session_id = ProviderSessionId::new();
    let now = Utc::now().to_rfc3339();
    {
        let connection = legacy_database_before(&path, 22);
        connection.execute(
            "INSERT INTO tasks(id,title,state,created_at,updated_at) VALUES (?1,'Rollback fixture','ready',?2,?2)",
            params![task_id.to_string(), now],
        ).expect("insert rollback task");
        connection.execute(
            "INSERT INTO provider_sessions(id,task_id,provider,provider_thread_id,created_at,updated_at) VALUES (?1,?2,'codex','rollback-thread',?3,?3)",
            params![provider_session_id.to_string(), task_id.to_string(), now],
        ).expect("insert rollback provider session");
        connection.execute(
            "INSERT INTO codex_items(provider_session_id,task_id,thread_id,turn_id,item_id,stable_id,kind,status,body,updated_at,projection_json,last_event_seq) VALUES (?1,?2,'rollback-thread','rollback-turn','rollback-item','rollback-stable','user_message','completed','rollback needle',?3,'{}',1)",
            params![provider_session_id.to_string(), task_id.to_string(), now],
        ).expect("insert rollback item");
        connection
            .execute("CREATE TABLE integrator_items(blocker TEXT)", [])
            .expect("create deliberate rename conflict");
    }

    assert!(
        LocalStore::open(&path).is_err(),
        "the deliberate schema conflict must reject migration 22"
    );
    let connection = Connection::open(&path).expect("inspect rolled-back database");
    let migration_recorded: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version=22",
            [],
            |row| row.get(0),
        )
        .expect("read migration ledger");
    assert_eq!(migration_recorded, 0);
    for old_name in ["codex_turns", "codex_items", "codex_items_fts"] {
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name=?1",
                [old_name],
                |row| row.get(0),
            )
            .expect("inspect rolled-back object");
        assert_eq!(count, 1, "migration partially removed {old_name}");
    }
    let trigger_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='codex_items_fts_insert'",
            [],
            |row| row.get(0),
        )
        .expect("inspect rolled-back trigger");
    assert_eq!(trigger_count, 1);
    let item_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM codex_items", [], |row| row.get(0))
        .expect("read rolled-back item");
    assert_eq!(item_count, 1);
}

#[test]
fn legacy_delegations_gain_a_frozen_standard_snapshot() {
    let directory = tempfile::tempdir().expect("temp directory");
    let path = directory.path().join("legacy-delegation.sqlite3");
    let task_id = TaskId::new();
    let delegation_id = integrator_core::DelegationId::new();
    let now = Utc::now();
    {
        let mut connection = Connection::open(&path).expect("open v19 fixture");
        LocalStore::configure(&connection).expect("configure fixture");
        connection
            .execute(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
                [],
            )
            .expect("create migration ledger");
        for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version < 20) {
            let transaction = connection.transaction().expect("migration transaction");
            transaction.execute_batch(sql).expect("apply v19 migration");
            transaction
                .execute(
                    "INSERT INTO schema_migrations(version,applied_at) VALUES (?1,?2)",
                    params![version, now.to_rfc3339()],
                )
                .expect("record migration");
            transaction.commit().expect("commit migration");
        }
        connection
            .execute(
                "INSERT INTO tasks(id,title,state,created_at,updated_at) VALUES (?1,'Legacy parent','ready',?2,?2)",
                params![task_id.to_string(), now.to_rfc3339()],
            )
            .expect("insert parent task");
        connection
            .execute(
                "INSERT INTO delegations(id,parent_task_id,profile_id,profile_label,runtime,model,effort,permission,title,brief,status,created_at,updated_at) VALUES (?1,?2,'legacy-reviewer','Legacy reviewer','claude','sonnet','high','project-write','Review','Review the diff','completed',?3,?3)",
                params![delegation_id.to_string(), task_id.to_string(), now.to_rfc3339()],
            )
            .expect("insert legacy delegation");
    }

    let store = LocalStore::open(&path).expect("migrate legacy delegation");
    let delegation = store
        .get_delegation(delegation_id)
        .expect("read migrated delegation");
    assert_eq!(delegation.service_level, "standard");
    assert_eq!(delegation.capability_snapshot.version, 0);
    assert_eq!(delegation.capability_snapshot.profile_id, "legacy-reviewer");
    assert_eq!(delegation.capability_snapshot.routes.len(), 1);
    assert_eq!(delegation.capability_snapshot.routes[0].runtime, "claude");
    assert_eq!(
        delegation.capability_snapshot.access_ceiling,
        integrator_core::DelegationPermission::ProjectWrite
    );
}

#[test]
fn resume_replay_migration_removes_only_shadow_message_rows() {
    let directory = tempfile::tempdir().expect("temp directory");
    let path = directory.path().join("resume-replay.sqlite3");
    let task_id = TaskId::new();
    let provider_session_id = ProviderSessionId::new();
    let now = Utc::now();
    {
        let mut connection = Connection::open(&path).expect("open v18 fixture");
        LocalStore::configure(&connection).expect("configure v18 fixture");
        connection
            .execute(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
                [],
            )
            .expect("create migration ledger");
        for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version < 19) {
            let transaction = connection.transaction().expect("migration transaction");
            transaction
                .execute_batch(sql)
                .expect("apply pre-repair migration");
            transaction
                .execute(
                    "INSERT INTO schema_migrations(version,applied_at) VALUES (?1,?2)",
                    params![version, now.to_rfc3339()],
                )
                .expect("record migration");
            transaction.commit().expect("commit migration");
        }
        connection.execute(
            "INSERT INTO tasks(id,title,state,created_at,updated_at) VALUES (?1,'Replay fixture','ready',?2,?2)",
            params![task_id.to_string(), now.to_rfc3339()],
        ).expect("insert task");
        connection.execute(
            "INSERT INTO provider_sessions(id,task_id,provider,provider_thread_id,created_at,updated_at) VALUES (?1,?2,'codex','thread-1',?3,?3)",
            params![provider_session_id.to_string(), task_id.to_string(), now.to_rfc3339()],
        ).expect("insert provider session");

        let rows = [
            (
                "turn-1",
                "user-live",
                "stable-user-live",
                "user_message",
                "completed",
                "visible question",
                10_i64,
            ),
            (
                "turn-1",
                "assistant-live",
                "stable-assistant-live",
                "agent_message",
                "completed",
                "visible answer",
                11,
            ),
            (
                "turn-1",
                "item-1",
                "stable-replayed-user",
                "user_message",
                "in_progress",
                "<integrator-skills>private</integrator-skills>\n\nvisible question",
                20,
            ),
            (
                "turn-1",
                "item-2",
                "stable-replayed-assistant",
                "agent_message",
                "in_progress",
                "visible answer",
                21,
            ),
            (
                "turn-1",
                "item-3",
                "stable-distinct-assistant",
                "agent_message",
                "completed",
                "a distinct snapshot-only answer",
                22,
            ),
            (
                "turn-2",
                "item-1",
                "stable-snapshot-only-user",
                "user_message",
                "completed",
                "snapshot-only question",
                30,
            ),
        ];
        for (turn_id, item_id, stable_id, kind, status, body, seq) in rows {
            let projection = ItemProjection {
                id: stable_id.into(),
                provider_item_id: item_id.into(),
                kind: match kind {
                    "user_message" => ItemKind::UserMessage,
                    _ => ItemKind::AgentMessage,
                },
                status: match status {
                    "completed" => ItemStatus::Completed,
                    _ => ItemStatus::InProgress,
                },
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
                updated_at: now,
            };
            connection.execute(
                "INSERT INTO codex_items(provider_session_id,task_id,thread_id,turn_id,item_id,stable_id,kind,status,body,updated_at,projection_json,last_event_seq,first_event_seq,first_occurred_at)
                 VALUES (?1,?2,'thread-1',?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,?9)",
                params![
                    provider_session_id.to_string(),
                    task_id.to_string(),
                    turn_id,
                    item_id,
                    stable_id,
                    kind,
                    status,
                    body,
                    now.to_rfc3339(),
                    serde_json::to_string(&projection).expect("serialize projection"),
                    seq,
                ],
            ).expect("insert item");
        }
    }

    let store = LocalStore::open(&path).expect("apply replay repair");
    let connection = store.connection.lock();
    let remaining = connection
        .prepare(
            "SELECT turn_id,item_id FROM integrator_items
             WHERE provider_session_id=?1 ORDER BY first_event_seq",
        )
        .expect("prepare remaining items")
        .query_map([provider_session_id.to_string()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .expect("query remaining items")
        .collect::<std::result::Result<Vec<_>, _>>()
        .expect("collect remaining items");
    assert_eq!(
        remaining,
        vec![
            ("turn-1".into(), "user-live".into()),
            ("turn-1".into(), "assistant-live".into()),
            ("turn-1".into(), "item-3".into()),
            ("turn-2".into(), "item-1".into()),
        ]
    );
}

#[test]
fn materialized_snapshot_schema_migration_is_idempotent() {
    let directory = tempfile::tempdir().expect("temp directory");
    let path = directory.path().join("snapshot.sqlite3");
    let store = LocalStore::open(&path).expect("first open");
    {
        let connection = store.connection.lock();
        let columns = connection
            .prepare("PRAGMA table_info(integrator_task_projection)")
            .expect("projection columns")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query columns")
            .collect::<std::result::Result<std::collections::HashSet<_>, _>>()
            .expect("collect columns");
        for column in [
            "turn_event_json",
            "mode_seq",
            "mode_event_json",
            "error_seq",
            "error_event_json",
            "reset_seq",
            "reset_event_json",
        ] {
            assert!(columns.contains(column), "missing {column}");
        }
        let item_indexes = connection
            .prepare("PRAGMA index_list(integrator_items)")
            .expect("item indexes")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query indexes")
            .collect::<std::result::Result<std::collections::HashSet<_>, _>>()
            .expect("collect indexes");
        assert!(item_indexes.contains("integrator_items_task_snapshot_idx"));
        assert!(item_indexes.contains("integrator_items_provider_stable_seq_idx"));
        let approval_indexes = connection
            .prepare("PRAGMA index_list(integrator_approvals)")
            .expect("approval indexes")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query approval indexes")
            .collect::<std::result::Result<std::collections::HashSet<_>, _>>()
            .expect("collect approval indexes");
        assert!(approval_indexes.contains("integrator_approvals_active_process_idx"));
    }
    drop(store);
    LocalStore::open(&path).expect("idempotent reopen");
}

#[test]
fn legacy_projection_rows_migrate_before_new_audit_rows_omit_the_copy() {
    let directory = tempfile::tempdir().expect("temp directory");
    let path = directory.path().join("legacy-snapshot.sqlite3");
    let task_id = TaskId::new();
    let provider_session_id = ProviderSessionId::new();
    let runtime_session_id = RuntimeSessionId::new();
    let occurred_at = Utc::now();
    let legacy_item = ItemProjection {
        id: "legacy-stable-item".into(),
        provider_item_id: "legacy-provider-item".into(),
        kind: ItemKind::AgentMessage,
        status: ItemStatus::Completed,
        title: None,
        body: Some("legacy materialized message".into()),
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
    };
    let legacy_event = RuntimeProjectionEvent {
        seq: 1,
        task_id,
        provider_session_id,
        provider: "codex".into(),
        thread_id: "legacy-thread".into(),
        turn_id: Some("legacy-turn".into()),
        occurred_at,
        projection: RuntimeProjection::ItemChanged {
            item: legacy_item.clone(),
        },
    };

    {
        let mut connection = Connection::open(&path).expect("open v7 fixture");
        LocalStore::configure(&connection).expect("configure v7 fixture");
        connection
            .execute(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
                [],
            )
            .expect("create migration ledger");
        for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version < 8) {
            let transaction = connection.transaction().expect("v7 migration transaction");
            transaction
                .execute_batch(sql)
                .expect("apply pre-snapshot migration");
            transaction
                .execute(
                    "INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?1,?2)",
                    params![version, occurred_at.to_rfc3339()],
                )
                .expect("record pre-snapshot migration");
            transaction.commit().expect("commit pre-snapshot migration");
        }
        connection.execute("INSERT INTO tasks(id,title,state,created_at,updated_at) VALUES (?1,'Legacy fixture','ready',?2,?2)", params![task_id.to_string(), occurred_at.to_rfc3339()]).expect("insert legacy task");
        connection.execute("INSERT INTO provider_sessions(id,task_id,provider,provider_thread_id,created_at,updated_at) VALUES (?1,?2,'codex','legacy-thread',?3,?3)", params![provider_session_id.to_string(), task_id.to_string(), occurred_at.to_rfc3339()]).expect("insert legacy provider session");
        connection.execute("INSERT INTO runtime_sessions(id,task_id,provider_session_id,status,started_at,process_id) VALUES (?1,?2,?3,'running',?4,'legacy-process')", params![runtime_session_id.to_string(), task_id.to_string(), provider_session_id.to_string(), occurred_at.to_rfc3339()]).expect("insert legacy runtime session");
        connection.execute("INSERT INTO codex_task_projection(task_id,provider_session_id,thread_id,process_id,last_event_seq) VALUES (?1,?2,'legacy-thread','legacy-process',1)", params![task_id.to_string(), provider_session_id.to_string()]).expect("insert legacy task projection");
        connection.execute("INSERT INTO codex_items(provider_session_id,task_id,thread_id,turn_id,item_id,stable_id,kind,status,body,updated_at,projection_json,last_event_seq) VALUES (?1,?2,'legacy-thread','legacy-turn',?3,?4,'agent_message','completed',?5,?6,?7,1)", params![provider_session_id.to_string(), task_id.to_string(), legacy_item.provider_item_id, legacy_item.id, legacy_item.body, occurred_at.to_rfc3339(), serde_json::to_string(&legacy_item).expect("serialize legacy item")]).expect("insert legacy current item");
        connection.execute("INSERT INTO codex_event_log(seq,task_id,provider_session_id,runtime_session_id,process_id,thread_id,turn_id,method,audit_json,audit_truncated,projection_json,occurred_at) VALUES (1,?1,?2,?3,'legacy-process','legacy-thread','legacy-turn','item/completed','{}',0,?4,?5)", params![task_id.to_string(), provider_session_id.to_string(), runtime_session_id.to_string(), serde_json::to_string(&legacy_event).expect("serialize legacy event"), occurred_at.to_rfc3339()]).expect("insert legacy event projection");
    }

    let migrated = LocalStore::open(&path).expect("migrate v7 fixture");
    let migrated_snapshot = migrated
        .task_snapshot(task_id)
        .expect("hydrate migrated legacy snapshot");
    let migrated_hydrate = migrated_snapshot.hydrate.expect("compact hydrate");
    assert_eq!(migrated_hydrate.items.len(), 1);
    assert_eq!(&migrated_hydrate.items[0], &legacy_item);
    let _ = &legacy_event;

    let binding = RuntimeBinding {
        task_id,
        provider: ProviderKind::Codex,
        provider_session_id: Some(provider_session_id),
        runtime_session_id,
        process_id: "legacy-process".into(),
        thread_id: Some("legacy-thread".into()),
    };
    let new_item = ItemProjection {
        id: "new-stable-item".into(),
        provider_item_id: "new-provider-item".into(),
        kind: ItemKind::AgentMessage,
        status: ItemStatus::Completed,
        title: None,
        body: Some("post-migration message".into()),
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
        updated_at: occurred_at + chrono::Duration::seconds(1),
    };
    let appended = migrated
        .apply_reduced_event(
            &binding,
            &ReducedProviderEvent {
                method: "item/completed".into(),
                thread_id: "legacy-thread".into(),
                turn_id: Some("legacy-turn".into()),
                audit_json: "{}".into(),
                audit_truncated: false,
                mutation: ProjectionMutation::ReplaceItem(new_item),
                occurred_at: occurred_at + chrono::Duration::seconds(1),
            },
        )
        .expect("append post-migration event");
    {
        let connection = migrated.connection.lock();
        let projection_copy: Option<String> = connection
            .query_row(
                "SELECT projection_json FROM integrator_event_log WHERE seq=?1",
                [appended.seq],
                |row| row.get(0),
            )
            .expect("read post-migration audit row");
        assert!(projection_copy.is_none());
    }
    drop(migrated);

    let reopened = LocalStore::open(&path).expect("reopen migrated fixture");
    let snapshot = reopened
        .task_snapshot(task_id)
        .expect("hydrate after reopen");
    assert_eq!(snapshot.watermark_seq, appended.seq);
    let hydrate = snapshot.hydrate.expect("compact hydrate");
    assert_eq!(hydrate.items.len(), 2);
    assert!(
        hydrate
            .items
            .iter()
            .any(|item| { item.body.as_deref() == Some("legacy materialized message") })
    );
    assert!(
        hydrate
            .items
            .iter()
            .any(|item| item.body.as_deref() == Some("post-migration message"))
    );
}

#[test]
fn provider_and_runtime_sessions_are_exported() {
    let store = LocalStore::open_in_memory().expect("open store");
    let task = store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Persist a provider session".into(),
            repository_path: None,
            worktree_path: None,
            runtime: None,
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create task");
    let now = Utc::now();
    let provider_session = ProviderSession {
        id: ProviderSessionId::new(),
        task_id: task.id,
        provider: ProviderKind::Codex,
        provider_thread_id: "thread-fixture".into(),
        created_at: now,
        updated_at: now,
    };
    store
        .upsert_provider_session(&provider_session)
        .expect("provider session");
    store
        .insert_runtime_session(&RuntimeSession {
            id: RuntimeSessionId::new(),
            task_id: task.id,
            provider_session_id: Some(provider_session.id),
            process_id: Some("process-fixture".into()),
            status: "completed".into(),
            started_at: now,
            ended_at: Some(now),
        })
        .expect("runtime session");

    let export = store.export().expect("export");
    assert_eq!(export.provider_sessions.len(), 1);
    assert_eq!(export.runtime_sessions.len(), 1);
}

#[test]
fn setting_lookup_uses_the_primary_key_and_distinguishes_missing_values() {
    let store = LocalStore::open_in_memory().expect("open store");
    let expected = serde_json::json!({"primary": {"usedPercent": 42}});
    store
        .set_setting("provider-quota.codex", expected.clone())
        .expect("set quota");

    assert_eq!(
        store
            .get_setting("provider-quota.codex")
            .expect("get quota")
            .expect("stored quota")
            .value,
        expected
    );
    assert!(
        store
            .get_setting("provider-quota.cursor")
            .expect("get missing quota")
            .is_none()
    );
}

#[test]
fn startup_reconciliation_interrupts_only_unfinished_runtime_sessions_once() {
    let store = LocalStore::open_in_memory().expect("open store");
    let task = store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Runtime reconciliation".into(),
            repository_path: None,
            worktree_path: None,
            runtime: None,
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create task");
    let now = Utc::now();
    let running_id = RuntimeSessionId::new();
    let completed_id = RuntimeSessionId::new();
    store
        .insert_runtime_session(&RuntimeSession {
            id: running_id,
            task_id: task.id,
            provider_session_id: None,
            process_id: Some("startup-running".into()),
            status: "running".into(),
            started_at: now,
            ended_at: None,
        })
        .expect("insert unfinished session");
    store
        .insert_runtime_session(&RuntimeSession {
            id: completed_id,
            task_id: task.id,
            provider_session_id: None,
            process_id: Some("startup-completed".into()),
            status: "completed".into(),
            started_at: now,
            ended_at: Some(now),
        })
        .expect("insert completed session");

    assert_eq!(
        store
            .interrupt_unfinished_runtime_sessions()
            .expect("first reconciliation"),
        1
    );
    assert_eq!(
        store
            .interrupt_unfinished_runtime_sessions()
            .expect("idempotent reconciliation"),
        0
    );
    let sessions = store.list_runtime_sessions().expect("list sessions");
    let running = sessions
        .iter()
        .find(|session| session.id == running_id)
        .expect("reconciled session");
    assert_eq!(running.status, "interrupted");
    assert!(running.ended_at.is_some());
    let completed = sessions
        .iter()
        .find(|session| session.id == completed_id)
        .expect("completed session");
    assert_eq!(completed.status, "completed");
    assert_eq!(completed.ended_at, Some(now));
}

fn draft_fixture(owner: ComposerDraftOwner, prompt: &str, revision: u64) -> ComposerDraft {
    let selection = prompt.encode_utf16().count() as u32;
    ComposerDraft {
        owner,
        prompt: prompt.into(),
        attachments: Vec::new(),
        context_references: Vec::new(),
        runtime: "codex".into(),
        model: "gpt-5.6-luna".into(),
        effort: Some("high".into()),
        permission: "project-write".into(),
        delegation: "off".into(),
        selection_start: selection,
        selection_end: selection,
        revision,
        updated_at: Utc::now(),
    }
}

fn queued_fixture(task_id: TaskId, prompt: &str) -> NewQueuedMessage {
    NewQueuedMessage {
        task_id,
        prompt: prompt.into(),
        attachments: Vec::new(),
        context_references: Vec::new(),
        runtime: "codex".into(),
        model: "gpt-5.6-luna".into(),
        effort: Some("high".into()),
        permission: "project-write".into(),
        delegation: "off".into(),
        native_action_id: None,
    }
}

fn register_draft_project(store: &LocalStore, directory: &tempfile::TempDir) -> TrustedProject {
    let repository = directory.path().join("repository");
    let common = repository.join(".git");
    std::fs::create_dir_all(&common).expect("fixture repository");
    store
        .upsert_trusted_project("Draft fixture", &repository, Some((&repository, &common)))
        .expect("register draft project")
}

#[test]
fn happy_project_and_task_drafts_remain_isolated() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let store = LocalStore::open_in_memory().expect("open store");
    let project = register_draft_project(&store, &directory);
    let task = store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Existing conversation".into(),
            repository_path: Some(project.repository_root.clone()),
            worktree_path: None,
            runtime: Some("codex".into()),
            model: Some("gpt-5.6-luna".into()),
            effort: Some("high".into()),
            parent_task_id: None,
        })
        .expect("create task");
    store
        .upsert_composer_draft(draft_fixture(
            ComposerDraftOwner::NewChat {
                project_id: project.id,
            },
            "A new chat thought",
            1,
        ))
        .expect("save project draft");
    store
        .upsert_composer_draft(draft_fixture(
            ComposerDraftOwner::Task { task_id: task.id },
            "A reply for the existing chat",
            1,
        ))
        .expect("save task draft");

    let drafts = store.list_composer_drafts().expect("list drafts");
    assert_eq!(drafts.len(), 2);
    assert!(
        drafts
            .iter()
            .any(|draft| draft.prompt == "A new chat thought")
    );
    assert!(
        drafts
            .iter()
            .any(|draft| draft.prompt == "A reply for the existing chat")
    );
}

#[test]
fn degraded_out_of_order_write_cannot_replace_a_newer_revision() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let store = LocalStore::open_in_memory().expect("open store");
    let project = register_draft_project(&store, &directory);
    let owner = ComposerDraftOwner::NewChat {
        project_id: project.id,
    };
    store
        .upsert_composer_draft(draft_fixture(owner.clone(), "newest", 4))
        .expect("save newest");
    store
        .upsert_composer_draft(draft_fixture(owner, "stale", 3))
        .expect("ignore stale");

    let drafts = store.list_composer_drafts().expect("list drafts");
    assert_eq!(drafts[0].prompt, "newest");
    assert_eq!(drafts[0].revision, 4);
}

#[test]
fn restart_reopens_the_durable_draft() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = directory.path().join("draft-restart.sqlite3");
    let expected_project = {
        let store = LocalStore::open(&database).expect("first open");
        let project = register_draft_project(&store, &directory);
        store
            .upsert_composer_draft(draft_fixture(
                ComposerDraftOwner::NewChat {
                    project_id: project.id,
                },
                "Survive a hard restart",
                7,
            ))
            .expect("save draft");
        project.id
    };

    let reopened = LocalStore::open(&database).expect("reopen store");
    let drafts = reopened.list_composer_drafts().expect("restore drafts");
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].prompt, "Survive a hard restart");
    assert_eq!(
        drafts[0].owner,
        ComposerDraftOwner::NewChat {
            project_id: expected_project
        }
    );
}

#[test]
fn new_chat_promotion_atomically_rekeys_the_draft_to_the_created_task() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let store = LocalStore::open_in_memory().expect("open store");
    let project = register_draft_project(&store, &directory);
    let draft = draft_fixture(
        ComposerDraftOwner::NewChat {
            project_id: project.id,
        },
        "Create the task without losing me",
        5,
    );
    store
        .upsert_composer_draft(draft.clone())
        .expect("save new-chat draft");
    let task = store
        .create_task_with_project_draft(
            NewTask {
                kind: TaskKind::Code,
                title: "Promoted chat".into(),
                repository_path: Some(project.repository_root),
                worktree_path: None,
                runtime: Some("codex".into()),
                model: Some("gpt-5.6-luna".into()),
                effort: Some("high".into()),
                parent_task_id: None,
            },
            draft,
        )
        .expect("create task and promote draft");

    let drafts = store.list_composer_drafts().expect("list promoted drafts");
    let task_draft = drafts
        .iter()
        .find(|candidate| candidate.owner == ComposerDraftOwner::Task { task_id: task.id })
        .expect("task draft");
    let project_draft = drafts
        .iter()
        .find(|candidate| {
            candidate.owner
                == ComposerDraftOwner::NewChat {
                    project_id: project.id,
                }
        })
        .expect("project tombstone");
    assert_eq!(task_draft.prompt, "Create the task without losing me");
    assert!(project_draft.prompt.is_empty());
    assert_eq!(project_draft.revision, task_draft.revision);
}

#[test]
fn cancellation_race_keeps_new_text_when_an_older_clear_arrives() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let store = LocalStore::open_in_memory().expect("open store");
    let project = register_draft_project(&store, &directory);
    let task = store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Cancellation race".into(),
            repository_path: Some(project.repository_root),
            worktree_path: None,
            runtime: Some("codex".into()),
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create task");
    let owner = ComposerDraftOwner::Task { task_id: task.id };
    store
        .upsert_composer_draft(draft_fixture(
            owner.clone(),
            "Typed while the send was settling",
            12,
        ))
        .expect("save next draft");
    store
        .upsert_composer_draft(draft_fixture(owner, "", 11))
        .expect("ignore stale clear");

    let draft = store.list_composer_drafts().expect("list drafts").remove(0);
    assert_eq!(draft.prompt, "Typed while the send was settling");
    assert_eq!(draft.revision, 12);
}

#[test]
fn adversarial_unknown_owner_and_oversized_body_fail_closed() {
    let store = LocalStore::open_in_memory().expect("open store");
    let unknown = draft_fixture(
        ComposerDraftOwner::NewChat {
            project_id: ProjectId::new(),
        },
        "Untrusted owner",
        1,
    );
    assert!(matches!(
        store.upsert_composer_draft(unknown),
        Err(IntegratorError::NotFound(_))
    ));

    let directory = tempfile::tempdir().expect("temporary directory");
    let project = register_draft_project(&store, &directory);
    let oversized = draft_fixture(
        ComposerDraftOwner::NewChat {
            project_id: project.id,
        },
        &"x".repeat(2 * 1024 * 1024 + 1),
        1,
    );
    assert!(matches!(
        store.upsert_composer_draft(oversized),
        Err(IntegratorError::InvalidInput(_))
    ));
}

#[test]
fn queued_messages_persist_reorder_and_return_without_crossing_tasks() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = directory.path().join("queue.sqlite3");
    let (task_id, other_task_id, first_id, third_id) = {
        let store = LocalStore::open(&database).expect("open store");
        let task = store
            .create_task(NewTask {
                kind: TaskKind::Code,
                title: "Queued conversation".into(),
                repository_path: None,
                worktree_path: None,
                runtime: Some("codex".into()),
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create task");
        let other = store
            .create_task(NewTask {
                kind: TaskKind::Code,
                title: "Other conversation".into(),
                repository_path: None,
                worktree_path: None,
                runtime: Some("cursor".into()),
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create other task");
        let first = store
            .enqueue_message(queued_fixture(task.id, "First"))
            .expect("queue first");
        let second = store
            .enqueue_message(queued_fixture(task.id, "Second"))
            .expect("queue second");
        let third = store
            .enqueue_message(queued_fixture(task.id, "Third"))
            .expect("queue third");
        store
            .enqueue_message(queued_fixture(other.id, "Other task"))
            .expect("queue other task");
        let reordered = store
            .reorder_queued_messages(task.id, &[third.id, first.id, second.id])
            .expect("reorder");
        assert_eq!(
            reordered
                .iter()
                .map(|message| message.prompt.as_str())
                .collect::<Vec<_>>(),
            ["Third", "First", "Second"]
        );
        (task.id, other.id, first.id, third.id)
    };

    let reopened = LocalStore::open(&database).expect("reopen store");
    let restored = reopened
        .list_queued_messages(task_id)
        .expect("restore queue");
    assert_eq!(restored.len(), 3);
    assert_eq!(restored[0].id, third_id);
    let returned = reopened
        .take_queued_message(task_id, first_id)
        .expect("return to composer");
    assert_eq!(returned.prompt, "First");
    assert_eq!(
        reopened
            .list_queued_messages(task_id)
            .expect("remaining queue")
            .len(),
        2
    );
    assert_eq!(
        reopened
            .list_queued_messages(other_task_id)
            .expect("other queue")
            .len(),
        1
    );
    assert_eq!(reopened.export().expect("export").queued_messages.len(), 3);
}

#[test]
fn queued_message_dispatch_recovery_and_adversarial_boundaries_fail_closed() {
    let store = LocalStore::open_in_memory().expect("open store");
    let task = store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Queue recovery".into(),
            repository_path: None,
            worktree_path: None,
            runtime: Some("claude".into()),
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create task");
    let message = store
        .enqueue_message(queued_fixture(task.id, "Recover me"))
        .expect("queue message");
    store
        .set_queued_message_state(task.id, message.id, QueuedMessageState::Dispatching)
        .expect("mark dispatching");
    assert_eq!(
        store
            .recover_dispatching_queued_messages()
            .expect("recover dispatch"),
        1
    );
    assert_eq!(
        store.list_queued_messages(task.id).expect("list queue")[0].state,
        QueuedMessageState::Queued
    );
    assert!(matches!(
        store.enqueue_message(queued_fixture(TaskId::new(), "Unknown task")),
        Err(IntegratorError::NotFound(_))
    ));
    let mut empty = queued_fixture(task.id, "");
    empty.attachments.clear();
    assert!(matches!(
        store.enqueue_message(empty),
        Err(IntegratorError::InvalidInput(_))
    ));
    let oversized = queued_fixture(task.id, &"x".repeat(2 * 1024 * 1024 + 1));
    assert!(matches!(
        store.enqueue_message(oversized),
        Err(IntegratorError::InvalidInput(_))
    ));
    assert!(matches!(
        store.reorder_queued_messages(task.id, &[message.id, message.id]),
        Err(IntegratorError::InvalidInput(_))
    ));
}

#[test]
fn trusted_projects_persist_across_reopen_and_export() {
    let directory = tempfile::tempdir().expect("temp directory");
    let database = directory.path().join("integrator.sqlite3");
    let repository = directory.path().join("repository");
    let common = repository.join(".git");
    std::fs::create_dir_all(&common).expect("fixture directories");

    let first = LocalStore::open(&database).expect("first open");
    let registered = first
        .upsert_trusted_project("Repository", &repository, Some((&repository, &common)))
        .expect("register project");
    drop(first);

    let reopened = LocalStore::open(&database).expect("reopen");
    let projects = reopened.list_trusted_projects().expect("list projects");
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].id, registered.id);
    assert_eq!(projects[0].repository_root, repository);
    assert_eq!(reopened.export().expect("export").projects, projects);
    let _ = reopened
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Project chat".into(),
            repository_path: Some(repository.clone()),
            worktree_path: None,
            runtime: None,
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create project task");
    assert_eq!(reopened.list_tasks().expect("list tasks").len(), 1);

    let removed = reopened
        .remove_trusted_project(registered.id)
        .expect("remove trust record");
    assert_eq!(removed.id, registered.id);
    assert!(
        reopened
            .list_trusted_projects()
            .expect("list after removal")
            .is_empty()
    );
    assert!(
        reopened
            .list_tasks()
            .expect("list tasks after removal")
            .is_empty(),
        "removing a project must delete its Integrator chat history"
    );
    assert!(
        repository.exists(),
        "removal must never delete repository data"
    );
}

#[test]
fn legacy_project_history_can_be_removed_by_its_exact_stored_path() {
    let store = LocalStore::open_in_memory().expect("open store");
    let legacy_path = PathBuf::from("Projects/AI Integrator");
    let other_path = PathBuf::from("Projects/Other");
    for (title, repository_path) in [
        ("Legacy one", legacy_path.clone()),
        ("Legacy two", legacy_path.clone()),
        ("Other project", other_path.clone()),
    ] {
        store
            .create_task(NewTask {
                kind: TaskKind::Code,
                title: title.into(),
                repository_path: Some(repository_path),
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create legacy task");
    }

    assert_eq!(
        store
            .remove_project_history_by_repository_path(&legacy_path)
            .expect("remove legacy project history"),
        2
    );
    let remaining = store.list_all_tasks().expect("list remaining tasks");
    assert_eq!(remaining.len(), 1);
    assert_eq!(
        remaining[0].repository_path.as_deref(),
        Some(other_path.as_path())
    );
}

#[test]
fn list_tasks_keeps_archived_out_of_the_hot_set() {
    let store = LocalStore::open_in_memory().expect("open store");
    let live = store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Live chat".into(),
            repository_path: None,
            worktree_path: None,
            runtime: None,
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create live");
    let archived = store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Archived chat".into(),
            repository_path: None,
            worktree_path: None,
            runtime: None,
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create archived");
    store
        .update_task_metadata(archived.id, None, None, Some(true))
        .expect("archive");

    let hot = store.list_tasks().expect("list live tasks");
    assert_eq!(hot.len(), 1);
    assert_eq!(hot[0].id, live.id);
    assert!(!hot[0].archived);

    let page = store.list_archived_tasks(None, 50).expect("list archived");
    assert_eq!(page.total, 1);
    assert_eq!(page.tasks.len(), 1);
    assert_eq!(page.tasks[0].id, archived.id);
    assert!(page.tasks[0].archived);
    assert!(page.next_cursor.is_none());

    let export = store.export().expect("export");
    assert_eq!(export.tasks.len(), 1);
    assert_eq!(export.tasks[0].id, live.id);

    let all = store.list_all_tasks().expect("list all");
    assert_eq!(all.len(), 2);
}

#[test]
fn remove_task_wipes_chat_history_and_preserves_project_folder() {
    let directory = tempfile::tempdir().expect("temp directory");
    let database = directory.path().join("integrator.sqlite3");
    let repository = directory.path().join("repository");
    std::fs::create_dir_all(&repository).expect("fixture directories");
    let store = LocalStore::open(&database).expect("open store");
    let _project = store
        .upsert_trusted_project("Repository", &repository, None)
        .expect("register project");
    let keep = store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Keep me".into(),
            repository_path: Some(repository.clone()),
            worktree_path: None,
            runtime: None,
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create kept task");
    let remove = store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Delete me".into(),
            repository_path: Some(repository.clone()),
            worktree_path: None,
            runtime: None,
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create removed task");

    let removed = store.remove_task(remove.id).expect("remove task");
    assert_eq!(removed.id, remove.id);
    let tasks = store.list_tasks().expect("list tasks");
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, keep.id);
    assert!(
        repository.exists(),
        "removing a chat must never delete the project folder"
    );
    assert!(matches!(
        store.remove_task(remove.id),
        Err(IntegratorError::NotFound(_))
    ));
}

#[test]
fn ordinary_project_folder_persists_without_git_identity() {
    let directory = tempfile::tempdir().expect("temp directory");
    let database = directory.path().join("integrator.sqlite3");
    let project_root = directory.path().join("notes");
    std::fs::create_dir(&project_root).expect("project folder");
    let store = LocalStore::open(&database).expect("open store");

    let project = store
        .upsert_trusted_project("Notes", &project_root, None)
        .expect("register ordinary folder");
    assert_eq!(project.repository_root, project_root);
    assert_eq!(project.git_repository_root, None);
    assert_eq!(project.git_common_directory, None);
    assert_eq!(
        store.list_trusted_projects().expect("list projects"),
        vec![project]
    );
}

#[test]
fn chat_kind_round_trips_without_repository_identity() {
    let store = LocalStore::open_in_memory().expect("open store");
    let task = store
        .create_task(NewTask {
            kind: TaskKind::Chat,
            title: "Research chat".into(),
            repository_path: None,
            worktree_path: None,
            runtime: Some("codex".into()),
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create Chat task");

    assert_eq!(task.kind, TaskKind::Chat);
    assert_eq!(
        store.get_task(task.id).expect("reload Chat").kind,
        TaskKind::Chat
    );
    assert_eq!(
        store.export().expect("export").tasks[0].kind,
        TaskKind::Chat
    );
    let rerouted = store
        .update_task_routing(task.id, "cursor", "composer", None)
        .expect("reroute Chat task");
    assert_eq!(rerouted.runtime.as_deref(), Some("cursor"));
    assert!(matches!(
        store.create_task(NewTask {
            kind: TaskKind::Chat,
            title: "Unsafe Chat".into(),
            repository_path: Some(PathBuf::from("/tmp/project")),
            worktree_path: None,
            runtime: Some("cursor".into()),
            model: None,
            effort: None,
            parent_task_id: None,
        }),
        Err(IntegratorError::InvalidInput(_))
    ));
}

#[test]
fn chat_context_is_a_bounded_native_markdown_snapshot() {
    let store = LocalStore::open_in_memory().expect("open store");
    let source = store
        .create_task(NewTask {
            kind: TaskKind::Chat,
            title: "Parser research".into(),
            repository_path: None,
            worktree_path: None,
            runtime: Some("codex".into()),
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create source Chat");
    let target = store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Implement parser".into(),
            repository_path: None,
            worktree_path: None,
            runtime: Some("codex".into()),
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create target task");
    seed_conversation(&store, source.id);
    let input = ChatContextReference {
        id: ContextReferenceId::new(),
        source_task_id: source.id,
        source_title: "renderer cannot override this".into(),
    };

    let snapshot = store
        .resolve_chat_context_reference(target.id, &input)
        .expect("resolve Chat context");
    assert_eq!(snapshot.source_title, "Parser research");
    assert_eq!(snapshot.message_count, 4);
    assert!(
        snapshot
            .rendered_markdown
            .starts_with("# Chat: Parser research\n")
    );
    assert!(
        snapshot
            .rendered_markdown
            .contains("## User\n\nport the parser")
    );
    assert!(
        snapshot
            .rendered_markdown
            .contains("## Assistant\n\nhere is the port")
    );
    assert_eq!(snapshot.rendered_sha256.len(), 64);

    store.remove_task(source.id).expect("delete source Chat");
    let persisted = store
        .list_context_references(target.id)
        .expect("list target context")
        .pop()
        .expect("persisted reference");
    assert_eq!(persisted.source_task_id, None);
    assert_eq!(persisted.rendered_markdown, snapshot.rendered_markdown);
    assert_eq!(persisted.rendered_sha256, snapshot.rendered_sha256);
}

#[test]
fn chat_context_rejects_code_sources_and_self_references() {
    let store = LocalStore::open_in_memory().expect("open store");
    let code = store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Code task".into(),
            repository_path: None,
            worktree_path: None,
            runtime: Some("codex".into()),
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create code task");
    seed_conversation(&store, code.id);
    let reference = ChatContextReference {
        id: ContextReferenceId::new(),
        source_task_id: code.id,
        source_title: code.title.clone(),
    };
    assert!(matches!(
        store.resolve_chat_context_reference(TaskId::new(), &reference),
        Err(IntegratorError::NotFound(_))
    ));
    assert!(matches!(
        store.resolve_chat_context_reference(code.id, &reference),
        Err(IntegratorError::InvalidInput(_))
    ));

    let target = store
        .create_task(NewTask {
            kind: TaskKind::Chat,
            title: "Target".into(),
            repository_path: None,
            worktree_path: None,
            runtime: Some("codex".into()),
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create target");
    assert!(matches!(
        store.resolve_chat_context_reference(target.id, &reference),
        Err(IntegratorError::InvalidInput(_))
    ));
}

#[test]
fn memory_is_transparent_deduplicated_bounded_and_secret_averse() {
    let store = LocalStore::open_in_memory().expect("open store");
    let first = store
        .create_memory(NewMemoryEntry {
            text: "Prefers concise release notes".into(),
            creator: MemoryCreator::User,
            source_task_id: None,
            source_item_id: None,
        })
        .expect("create memory");
    assert!(matches!(
        store.create_memory(NewMemoryEntry {
            text: "  PREFERS   concise release notes  ".into(),
            creator: MemoryCreator::Agent,
            source_task_id: None,
            source_item_id: None,
        }),
        Err(IntegratorError::InvalidInput(_))
    ));
    assert!(matches!(
        store.create_memory(NewMemoryEntry {
            text: "API key: sk-proj-12345678901234567890".into(),
            creator: MemoryCreator::User,
            source_task_id: None,
            source_item_id: None,
        }),
        Err(IntegratorError::InvalidInput(_))
    ));
    let harmless = store
        .create_memory(NewMemoryEntry {
            text: "Likes task-based, risk-aware plans".into(),
            creator: MemoryCreator::User,
            source_task_id: None,
            source_item_id: None,
        })
        .expect("do not reject ordinary sk- text");

    store
        .set_memory_state(first.id, MemoryState::Disabled)
        .expect("disable memory");
    let injected = store
        .active_memories_for_injection()
        .expect("list injectable memories");
    assert_eq!(
        injected.iter().map(|entry| entry.id).collect::<Vec<_>>(),
        vec![harmless.id]
    );
    store
        .mark_memories_used(&[harmless.id])
        .expect("mark memory used");
    assert!(
        store
            .list_memories()
            .expect("list memories")
            .into_iter()
            .find(|entry| entry.id == harmless.id)
            .expect("used memory")
            .last_used_at
            .is_some()
    );
}

#[test]
fn memory_enforces_twenty_active_entry_limit() {
    let store = LocalStore::open_in_memory().expect("open store");
    let mut memories = Vec::new();
    for index in 0..20 {
        memories.push(
            store
                .create_memory(NewMemoryEntry {
                    text: format!("Stable preference {index}"),
                    creator: MemoryCreator::User,
                    source_task_id: None,
                    source_item_id: None,
                })
                .expect("fill memory"),
        );
    }
    assert!(matches!(
        store.create_memory(NewMemoryEntry {
            text: "One too many".into(),
            creator: MemoryCreator::User,
            source_task_id: None,
            source_item_id: None,
        }),
        Err(IntegratorError::InvalidInput(_))
    ));
    store
        .set_memory_state(memories[0].id, MemoryState::Disabled)
        .expect("free capacity");
    store
        .create_memory(NewMemoryEntry {
            text: "Replacement preference".into(),
            creator: MemoryCreator::User,
            source_task_id: None,
            source_item_id: None,
        })
        .expect("reuse capacity");
}

#[test]
fn browser_tabs_are_remembered_per_task_and_die_with_it() {
    let store = LocalStore::open_in_memory().expect("open store");
    let task = fork_source(&store);
    let other = store
        .create_task(NewTask {
            kind: TaskKind::Code,
            title: "Another chat".into(),
            repository_path: Some(PathBuf::from("/repo")),
            worktree_path: None,
            runtime: None,
            model: None,
            effort: None,
            parent_task_id: None,
        })
        .expect("create second task");

    store
        .set_browser_tabs(
            task.id,
            &[
                StoredBrowserTab {
                    url: "https://example.com/docs".into(),
                    title: "Docs".into(),
                    favicon: None,
                },
                // Nothing to reopen: a blank tab and an oversized address are
                // dropped rather than stored.
                StoredBrowserTab {
                    url: "about:blank".into(),
                    title: String::new(),
                    favicon: None,
                },
                StoredBrowserTab {
                    url: format!("https://example.com/{}", "x".repeat(2100)),
                    title: "Too long".into(),
                    favicon: None,
                },
                StoredBrowserTab {
                    url: "http://localhost:5173/".into(),
                    title: "Vite".into(),
                    favicon: Some("data:image/png;base64,AAAA".into()),
                },
            ],
        )
        .expect("remember tabs");

    // Order is the order they were in, and one task never sees another's tabs.
    assert_eq!(
        store.browser_tabs(task.id).expect("read tabs"),
        vec![
            StoredBrowserTab {
                url: "https://example.com/docs".into(),
                title: "Docs".into(),
                favicon: None,
            },
            StoredBrowserTab {
                url: "http://localhost:5173/".into(),
                title: "Vite".into(),
                favicon: Some("data:image/png;base64,AAAA".into()),
            },
        ]
    );
    assert!(store.browser_tabs(other.id).expect("read tabs").is_empty());

    // Writing again replaces the list rather than appending to it.
    store
        .set_browser_tabs(
            task.id,
            &[StoredBrowserTab {
                url: "https://example.com/other".into(),
                title: "Other".into(),
                favicon: None,
            }],
        )
        .expect("replace tabs");
    assert_eq!(store.browser_tabs(task.id).expect("read tabs").len(), 1);

    // A deleted chat takes its remembered tabs with it.
    store.remove_task(task.id).expect("remove task");
    assert!(store.browser_tabs(task.id).expect("read tabs").is_empty());
}
