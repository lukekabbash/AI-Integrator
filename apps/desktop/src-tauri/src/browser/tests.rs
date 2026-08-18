//! Tests for the browser module: URL handling, task scoping, the guest
//! runtime contract, and the labels that keep guest webviews outside the
//! app's capability scope.

use super::*;

fn source_between<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
    source
        .split_once(start)
        .and_then(|(_, rest)| rest.split_once(end).map(|(section, _)| section))
        .expect("browser lifecycle section should remain identifiable")
}

#[test]
fn normalizes_bare_hosts_by_reachability() {
    assert_eq!(normalize_url("example.com").unwrap().scheme(), "https");
    assert_eq!(normalize_url("localhost:5173").unwrap().scheme(), "http");
    assert_eq!(normalize_url("127.0.0.1:3000").unwrap().scheme(), "http");
    assert_eq!(
        normalize_url("http://localhost:4180/x").unwrap().as_str(),
        "http://localhost:4180/x"
    );
}

#[test]
fn a_blank_tab_is_never_loading() {
    // about:blank reports no page load, so calling it "loading" leaves the
    // reload control spinning over a tab that is only waiting for an address.
    assert!(is_blank(&Url::parse("about:blank").unwrap()));
    assert!(is_blank(&Url::parse("about:srcdoc").unwrap()));
    assert!(!is_blank(&Url::parse("https://example.com").unwrap()));
    assert!(!is_blank(&Url::parse("http://localhost:5173/").unwrap()));
}

#[test]
fn every_parked_webview_is_hidden_from_the_host_chat() {
    // Off-screen bounds preserve desktop layout for background agent work but
    // do not remove a child page from Windows UI Automation. Every lifecycle
    // that creates, parks, wakes, or reparents one must also hide it.
    let module = include_str!("mod.rs");
    let create = source_between(
        module,
        "pub(super) async fn create_tab",
        concat!("#[tauri::", "command]"),
    );
    let park = source_between(module, "fn park_tab", "/// Positions the tab");
    assert!(create.contains("webview.hide()"));
    assert!(park.contains(".hide()"));
    assert!(!park.contains(".show()"));

    let remember = include_str!("remember.rs");
    let wake = source_between(
        remember,
        "pub(super) async fn adopt_sleeping",
        "emit_changed",
    );
    assert!(wake.contains("webview.hide()"));

    let popout = include_str!("popout.rs");
    let moved = source_between(
        popout,
        "fn move_tab",
        "/// Moves a tab without losing history",
    );
    assert!(moved.contains("webview.hide()"));
}

#[test]
fn rejects_non_web_schemes_and_junk() {
    assert!(normalize_url("file:///etc/passwd").is_err());
    assert!(normalize_url("javascript:alert(1)").is_err());
    assert!(normalize_url("https://user:secret@example.com").is_err());
    assert!(normalize_url("   ").is_err());
    assert!(normalize_url(&"a".repeat(3000)).is_err());
}

#[test]
fn page_titles_are_bounded_before_they_cross_native_boundaries() {
    let title = bounded_page_title(&format!("hello\r\n{}", "x".repeat(800)));
    assert!(!title.contains('\r') && !title.contains('\n'));
    assert!(title.chars().count() <= 512);
}

fn context_action_url(key: &str, action: &str, target: &str, text: &str) -> Url {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("key", key)
        .append_pair("action", action)
        .append_pair("url", target)
        .append_pair("text", text)
        .finish();
    Url::parse(&format!("{BROWSER_CONTEXT_SCHEME}://action?{query}")).unwrap()
}

#[test]
fn context_actions_are_authenticated_task_scoped_and_web_only() {
    let tabs = registry(&[("tab-1", "task-a", None), ("tab-2", "task-b", None)]);
    let key = tabs.host_key();
    let action = context_action_from_url(
        &tabs,
        "task-a",
        "tab-1",
        &context_action_url(&key, "open-tab", "https://example.com/a", "selected"),
    )
    .expect("the guest's authenticated action should parse");
    assert_eq!(action.task_id, "task-a");
    assert_eq!(action.tab_id, "tab-1");
    assert_eq!(action.target_url.as_deref(), Some("https://example.com/a"));
    assert_eq!(action.text.as_deref(), Some("selected"));

    assert!(
        context_action_from_url(
            &tabs,
            "task-a",
            "tab-1",
            &context_action_url("wrong", "open-tab", "https://example.com", ""),
        )
        .is_none()
    );
    assert!(
        context_action_from_url(
            &tabs,
            "task-a",
            "tab-1",
            &context_action_url(&key, "open-tab", "javascript:alert(1)", ""),
        )
        .is_none()
    );
    assert!(
        context_action_from_url(
            &tabs,
            "task-b",
            "tab-1",
            &context_action_url(&key, "send-chat", "", "text"),
        )
        .is_none()
    );
}

/// The group a test task belongs to, without a store: task ids starting with
/// `chat` are chats (mirroring `groups::resolve_group` for the fixtures here),
/// everything else is a path group over the task string.
fn test_group(task: &str) -> Group {
    if task.starts_with("chat") {
        Group::chat()
    } else {
        Group {
            id: groups::path_group_id(std::path::Path::new(task)),
            name: task.to_string(),
            kind: groups::GroupKind::Path,
        }
    }
}

/// One registry entry, visible in the pane, for `(id, task, owner)`.
pub(super) fn fixture_tab(id: &str, task: &str, owner: Option<&str>) -> Tab {
    let group = test_group(task);
    Tab {
        state: BrowserTab {
            id: id.to_string(),
            task_id: task.to_string(),
            group_id: group.id,
            group_name: group.name,
            group_kind: group.kind,
            url: "about:blank".into(),
            title: String::new(),
            favicon: None,
            loading: false,
            popped_out: false,
            hidden: false,
            held_by: None,
            agent_protected_until: None,
            sleeping: false,
            delegation_id: owner.map(str::to_owned),
        },
        label: format!("browser-{id}"),
        window: None,
        order: 0,
        placement_slot: Some(PlacementSlot::Pane),
        held: None,
        held_task: None,
        user_at: None,
        grants: HashMap::new(),
        generation: 0,
        touched: std::time::Instant::now(),
        touched_at: chrono::Utc::now(),
        credential_at: None,
        poster: None,
    }
}

/// A registry holding one tab per `(id, task, owner)`, where `owner` is the
/// delegated child that opened it, or `None` for the orchestrator's own.
fn registry(rows: &[(&str, &str, Option<&str>)]) -> BrowserTabs {
    let tabs = BrowserTabs::new();
    {
        let mut guard = tabs.tabs.lock().unwrap();
        for (id, task, owner) in rows {
            guard.insert((*id).to_string(), fixture_tab(id, task, *owner));
        }
    }
    tabs
}

#[test]
fn registry_fixture_groups_match_the_chat_rule() {
    // The fixture's Chat kind is decided by the task string the way
    // `groups::resolve_group` decides it from the store: chats and only chats
    // land in the Chat group. Everything else keeps a group of its own.
    let tabs = registry(&[
        ("tab-1", "chat-a", None),
        ("tab-2", "chat-b", None),
        ("tab-3", "task-a", None),
        ("tab-4", "task-b", Some("child")),
    ]);
    for tab in tabs.snapshot(None) {
        let chat = tab.task_id.starts_with("chat");
        assert_eq!(
            tab.group_kind == groups::GroupKind::Chat,
            chat,
            "{}",
            tab.id
        );
        assert_eq!(tab.group_id == groups::CHAT_GROUP_ID, chat, "{}", tab.id);
        if !chat {
            assert_eq!(
                tab.group_id,
                groups::path_group_id(std::path::Path::new(&tab.task_id))
            );
        }
    }
    let ids: std::collections::HashSet<_> = tabs
        .snapshot(None)
        .into_iter()
        .map(|tab| tab.group_id)
        .collect();
    assert_eq!(
        ids.len(),
        3,
        "two chats share one group; each task has its own"
    );
}

#[test]
fn snapshots_take_the_cached_group_name() {
    // A re-registered project renames its pill through the cache; a tab
    // recorded under the old name reads the new one on the way out.
    let tabs = registry(&[("tab-1", "task-a", None)]);
    assert_eq!(tabs.snapshot(None)[0].group_name, "task-a");
    tabs.groups.lock().unwrap().insert(
        "task-a".into(),
        Group {
            id: groups::path_group_id(std::path::Path::new("task-a")),
            name: "Renamed".into(),
            kind: groups::GroupKind::Path,
        },
    );
    assert_eq!(tabs.snapshot(None)[0].group_name, "Renamed");
    groups::invalidate_groups(&tabs);
    assert_eq!(tabs.snapshot(None)[0].group_name, "task-a");
}

#[test]
fn store_backed_groups_agree_with_task_kind() {
    // Same rule `groups::resolve_group` applies from the store: a task is in
    // the Chat group exactly when its kind is Chat.
    let store = session_store::LocalStore::open_in_memory().expect("open store");
    let make = |kind, path: Option<std::path::PathBuf>| {
        store
            .create_task(integrator_core::NewTask {
                kind,
                title: "t".into(),
                repository_path: path,
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create task")
    };
    let chat = make(integrator_core::TaskKind::Chat, None);
    let code = make(
        integrator_core::TaskKind::Code,
        Some(std::path::PathBuf::from("/tmp/somewhere")),
    );
    for task in [chat, code] {
        let group = groups::resolve_group(&store, &task.id.to_string());
        let is_chat = task.kind == integrator_core::TaskKind::Chat;
        assert_eq!(group.kind == groups::GroupKind::Chat, is_chat);
        assert_eq!(group.id == groups::CHAT_GROUP_ID, is_chat);
    }
}

fn caller(task: &str, delegation: Option<&str>) -> Caller {
    Caller {
        task_id: task.to_string(),
        delegation_id: delegation.map(str::to_owned),
        group_id: test_group(task).id,
    }
}

#[test]
fn snapshot_filters_by_task_and_sorts() {
    let tabs = registry(&[
        ("tab-2", "task-a", None),
        ("tab-1", "task-a", None),
        ("tab-3", "task-b", None),
    ]);
    let mine = tabs.snapshot(Some("task-a"));
    assert_eq!(
        mine.iter().map(|tab| tab.id.as_str()).collect::<Vec<_>>(),
        ["tab-1", "tab-2"]
    );
    assert_eq!(tabs.snapshot(None).len(), 3);
    assert_eq!(tabs.task_of("tab-3").as_deref(), Some("task-b"));
}

#[test]
fn visible_peers_stay_inside_one_host_slot() {
    let tabs = registry(&[
        ("keep", "task-a", None),
        ("main-peer", "task-a", None),
        ("popout-peer", "task-a", None),
        ("other-task", "task-b", None),
    ]);
    tabs.set_window("popout-peer", Some("browser-window-1"), None);

    assert_eq!(
        tabs.visible_peers("task-a", "keep", false, PlacementSlot::Pane),
        ["main-peer", "other-task"]
    );
    // `keep` is in main, so its popped-out peers are those of no window at
    // all: a pop-out window's peers are asked for from inside it.
    assert!(
        tabs.visible_peers("task-a", "keep", true, PlacementSlot::Pane)
            .is_empty()
    );
    tabs.set_placement("main-peer", Some(PlacementSlot::Deck));
    assert_eq!(
        tabs.visible_peers("task-a", "keep", false, PlacementSlot::Pane),
        ["other-task"]
    );
}

#[test]
fn peers_in_a_popout_span_tasks_but_never_windows() {
    // A window is a bag of tabs from any task; the one rectangle they compete
    // for is the window's, so the peers of a popped tab are its window-mates
    // whatever their task, and never a tab in another window.
    let tabs = registry(&[
        ("keep", "task-a", None),
        ("mate-other-task", "task-b", None),
        ("mate-same-task", "task-a", None),
        ("elsewhere", "task-a", None),
        ("in-main", "task-a", None),
    ]);
    for id in ["keep", "mate-other-task", "mate-same-task"] {
        tabs.set_window(id, Some("browser-window-1"), None);
    }
    tabs.set_window("elsewhere", Some("browser-window-2"), None);
    assert_eq!(
        tabs.visible_peers("task-a", "keep", true, PlacementSlot::Pane),
        ["mate-other-task", "mate-same-task"]
    );
    assert_eq!(
        tabs.visible_peers("task-a", "elsewhere", true, PlacementSlot::Pane),
        Vec::<String>::new()
    );
}

#[test]
fn snapshots_by_window_order() {
    let tabs = registry(&[
        ("tab-10", "task-a", None),
        ("tab-2", "task-b", None),
        ("tab-9", "task-a", None),
        ("tab-3", "task-a", None),
    ]);
    // Appended one at a time: each takes the next order.
    tabs.set_window("tab-10", Some("browser-window-1"), None);
    tabs.set_window("tab-2", Some("browser-window-1"), None);
    tabs.set_window("tab-9", Some("browser-window-1"), None);
    tabs.set_window("tab-3", Some("browser-window-2"), None);
    let ids = |label: &str| -> Vec<String> {
        tabs.snapshot_window(label)
            .into_iter()
            .map(|tab| tab.id)
            .collect()
    };
    assert_eq!(ids("browser-window-1"), ["tab-10", "tab-2", "tab-9"]);
    assert_eq!(ids("browser-window-2"), ["tab-3"]);
    assert!(ids("browser-window-3").is_empty());
    assert_eq!(tabs.next_order("browser-window-1"), 3);
    assert_eq!(tabs.next_order("browser-window-3"), 0);
    // An explicit order wins; ties break by creation, not by string.
    tabs.set_window("tab-9", Some("browser-window-1"), Some(0));
    tabs.set_window("tab-2", Some("browser-window-1"), Some(0));
    assert_eq!(ids("browser-window-1"), ["tab-2", "tab-9", "tab-10"]);
    // Every popped tab reads as popped, and docking clears both.
    assert!(tabs.tab("tab-2").unwrap().popped_out);
    tabs.set_window("tab-2", None, None);
    let docked = tabs.tab("tab-2").unwrap();
    assert!(!docked.popped_out);
    assert_eq!(tabs.window_of("tab-2"), None);
    assert_eq!(ids("browser-window-1"), ["tab-9", "tab-10"]);
}

#[test]
fn reorder_renumbers_densely() {
    let tabs = registry(&[
        ("tab-1", "task-a", None),
        ("tab-2", "task-a", None),
        ("tab-3", "task-b", None),
        ("tab-4", "task-b", None),
    ]);
    for id in ["tab-1", "tab-2", "tab-3"] {
        tabs.set_window(id, Some("browser-window-1"), None);
    }
    tabs.set_window("tab-4", Some("browser-window-2"), None);
    let orders = || -> Vec<(String, u32)> {
        // Snapshot before taking the lock: `snapshot_window` locks too.
        let in_window = tabs.snapshot_window("browser-window-1");
        let guard = tabs.tabs.lock().unwrap();
        let mut list: Vec<(String, u32)> = in_window
            .into_iter()
            .map(|tab| (tab.id.clone(), guard[&tab.id].order))
            .collect();
        list.sort();
        list
    };
    assert!(tabs.reorder_window(
        "browser-window-1",
        &[
            "tab-3".to_string(),
            "tab-1".to_string(),
            "tab-2".to_string()
        ]
    ));
    assert_eq!(
        orders(),
        [
            ("tab-1".to_string(), 1),
            ("tab-2".to_string(), 2),
            ("tab-3".to_string(), 0)
        ]
    );
    // A partial list leads; the rest follow in their old order.
    assert!(tabs.reorder_window("browser-window-1", &["tab-2".to_string()]));
    assert_eq!(
        orders(),
        [
            ("tab-1".to_string(), 2),
            ("tab-2".to_string(), 0),
            ("tab-3".to_string(), 1)
        ]
    );
    // A tab from another window, or none, refuses the whole reorder.
    assert!(!tabs.reorder_window("browser-window-1", &["tab-4".to_string()]));
    assert!(!tabs.reorder_window("browser-window-1", &["tab-9".to_string()]));
    assert_eq!(
        orders(),
        [
            ("tab-1".to_string(), 2),
            ("tab-2".to_string(), 0),
            ("tab-3".to_string(), 1)
        ]
    );
}

#[test]
fn preferred_window_prefers_same_group_then_mru() {
    let tabs = registry(&[
        ("tab-a", "task-a", None),
        ("tab-b", "task-b", None),
        ("tab-c", "chat-1", None),
    ]);
    let group_a = test_group("task-a").id;
    let group_b = test_group("task-b").id;
    // No window yet: open one.
    assert_eq!(tabs.preferred_window_for(&group_a), None);
    tabs.set_window("tab-a", Some("browser-window-1"), None);
    tabs.set_window("tab-b", Some("browser-window-2"), None);
    tabs.note_window_focus("browser-window-1");
    tabs.note_window_focus("browser-window-2");
    // The window holding the group wins even when another is in front.
    assert_eq!(
        tabs.preferred_window_for(&group_a).as_deref(),
        Some("browser-window-1")
    );
    assert_eq!(
        tabs.preferred_window_for(&group_b).as_deref(),
        Some("browser-window-2")
    );
    // A group in no window goes to the one most recently in front.
    assert_eq!(
        tabs.preferred_window_for(groups::CHAT_GROUP_ID).as_deref(),
        Some("browser-window-2")
    );
    tabs.note_window_focus("browser-window-1");
    assert_eq!(
        tabs.preferred_window_for(groups::CHAT_GROUP_ID).as_deref(),
        Some("browser-window-1")
    );
    // A window that closed drops out of the running.
    tabs.forget_window("browser-window-1");
    assert_eq!(
        tabs.preferred_window_for(&group_a).as_deref(),
        Some("browser-window-2")
    );
    assert_eq!(tabs.windows_by_focus(), ["browser-window-2"]);
}

#[test]
fn moving_between_windows_keeps_group_and_task() {
    // The registry half of `move_tab`: the window changes, nothing about
    // whose tab it is does — the reach rules keep reading the same answer.
    let tabs = registry(&[("tab-a", "task-a", None), ("tab-b", "task-b", None)]);
    let before = tabs.tab("tab-a").unwrap();
    tabs.set_window("tab-a", Some("browser-window-1"), None);
    tabs.set_window("tab-a", Some("browser-window-2"), Some(0));
    let after = tabs.tab("tab-a").unwrap();
    assert_eq!(after.task_id, before.task_id);
    assert_eq!(after.group_id, before.group_id);
    assert_eq!(after.id, before.id);
    assert!(after.popped_out);
    assert_eq!(tabs.window_of("tab-a").as_deref(), Some("browser-window-2"));
    assert!(tabs.window_is_empty("browser-window-1"));
    assert!(tabs.window_holds_task("browser-window-2", "task-a"));
    assert!(!tabs.window_holds_task("browser-window-2", "task-b"));
    // What a close does to a window: every tab back to main, none left.
    tabs.set_window("tab-b", Some("browser-window-2"), None);
    for tab in tabs.snapshot_window("browser-window-2") {
        tabs.set_window(&tab.id, None, None);
    }
    assert!(tabs.window_is_empty("browser-window-2"));
    assert!(tabs.snapshot(None).iter().all(|tab| !tab.popped_out));
}

#[test]
fn raising_the_deck_includes_the_card_that_just_arrived() {
    // `visible_peers` answers for everyone but one tab, which is the wrong
    // question when the tab being placed is the deck card itself.
    let tabs = registry(&[("pane", "task-a", None), ("card", "task-a", None)]);
    tabs.set_placement("card", Some(PlacementSlot::Deck));
    assert_eq!(
        tabs.visible_in_slot("task-a", PlacementSlot::Deck),
        ["card"]
    );
    assert_eq!(
        tabs.visible_in_slot("task-a", PlacementSlot::Pane),
        ["pane"]
    );
}

#[test]
fn placement_reports_only_a_real_slot_change() {
    // A pane drag sends a rectangle a frame; only the moves between slots may
    // cost a reparent, so the same slot twice has to read as no change.
    let tabs = registry(&[("tab-1", "task-a", None)]);
    assert!(!tabs.set_placement("tab-1", Some(PlacementSlot::Pane)));
    assert!(tabs.set_placement("tab-1", Some(PlacementSlot::Deck)));
    assert!(!tabs.set_placement("tab-1", Some(PlacementSlot::Deck)));
    assert!(tabs.set_placement("tab-1", None));
    assert!(!tabs.set_placement("missing", Some(PlacementSlot::Pane)));
}

#[test]
fn newer_main_window_claim_prevents_an_old_chat_from_returning() {
    let tabs = registry(&[("tab-a", "task-a", None), ("tab-b", "task-b", None)]);

    assert!(tabs.claim_placement("task-a", "tab-a", false, PlacementSlot::Pane, 10, 1));
    assert!(tabs.claim_placement("task-b", "tab-b", false, PlacementSlot::Pane, 10, 2));
    assert!(!tabs.claim_placement("task-a", "tab-a", false, PlacementSlot::Pane, 10, 1));
    assert!(!tabs.placement_is_current("task-a", "tab-a", false, PlacementSlot::Pane, 10, 1));
    assert!(tabs.placement_is_current("task-b", "tab-b", false, PlacementSlot::Pane, 10, 2));
}

#[test]
fn placement_claims_keep_slots_and_popout_windows_independent() {
    let tabs = registry(&[
        ("tab-a", "task-a", None),
        ("tab-b", "task-b", None),
        ("tab-c", "task-a", None),
    ]);
    tabs.set_window("tab-a", Some("browser-window-1"), None);
    tabs.set_window("tab-b", Some("browser-window-2"), None);
    tabs.set_window("tab-c", Some("browser-window-2"), None);

    assert!(tabs.claim_placement("task-a", "tab-a", false, PlacementSlot::Pane, 10, 8));
    assert!(tabs.claim_placement("task-a", "tab-a", false, PlacementSlot::Deck, 10, 1));
    // Lanes are per window: a lower revision in another window still wins
    // its own lane, and one window's claim never invalidates the other's.
    assert!(tabs.claim_placement("task-a", "tab-a", true, PlacementSlot::Popout, 10, 4));
    assert!(tabs.claim_placement("task-b", "tab-b", true, PlacementSlot::Popout, 10, 1));
    assert!(tabs.placement_is_current("task-a", "tab-a", true, PlacementSlot::Popout, 10, 4));
    assert!(tabs.placement_is_current("task-b", "tab-b", true, PlacementSlot::Popout, 10, 1));
    // Two tabs of one window, whatever their tasks, share that window's lane.
    assert!(tabs.claim_placement("task-a", "tab-c", true, PlacementSlot::Popout, 10, 2));
    assert!(!tabs.placement_is_current("task-b", "tab-b", true, PlacementSlot::Popout, 10, 1));
    assert!(tabs.placement_is_current("task-a", "tab-a", true, PlacementSlot::Popout, 10, 4));

    // A renderer reload starts a newer session even when its local revision
    // starts over, and a late call from the retired session cannot take back.
    assert!(tabs.claim_placement("task-a", "tab-a", false, PlacementSlot::Pane, 11, 1));
    assert!(!tabs.claim_placement("task-a", "tab-a", false, PlacementSlot::Pane, 10, 99));
}

#[test]
fn deck_claims_are_one_lane_per_card() {
    // Every deck card is on screen at once, so a newer claim from one card must
    // not invalidate a wake in flight for another. Pane claims stay one lane.
    let tabs = registry(&[("tab-a", "task-a", None), ("tab-b", "task-a", None)]);

    assert!(tabs.claim_placement("task-a", "tab-a", false, PlacementSlot::Deck, 10, 1));
    assert!(tabs.claim_placement("task-a", "tab-b", false, PlacementSlot::Deck, 10, 2));
    assert!(tabs.placement_is_current("task-a", "tab-a", false, PlacementSlot::Deck, 10, 1));
    assert!(tabs.placement_is_current("task-a", "tab-b", false, PlacementSlot::Deck, 10, 2));

    assert!(tabs.claim_placement("task-a", "tab-a", false, PlacementSlot::Pane, 10, 3));
    assert!(tabs.claim_placement("task-a", "tab-b", false, PlacementSlot::Pane, 10, 4));
    assert!(!tabs.placement_is_current("task-a", "tab-a", false, PlacementSlot::Pane, 10, 3));
}

#[test]
fn the_poster_cache_keeps_the_newest_and_refuses_the_huge() {
    let limit = registry::POSTER_LIMIT;
    let ids: Vec<String> = (0..limit + 3).map(|index| format!("tab-{index}")).collect();
    let rows: Vec<(&str, &str, Option<&str>)> =
        ids.iter().map(|id| (id.as_str(), "task-a", None)).collect();
    let tabs = registry(&rows);
    for id in &ids {
        assert!(tabs.set_poster(id, format!("png-for-{id}")));
    }

    let held = ids.iter().filter(|id| tabs.poster(id).is_some()).count();
    assert_eq!(held, limit, "the cache has to stop somewhere");
    // The three oldest went and the rest stayed, each still its own picture.
    for (index, id) in ids.iter().enumerate() {
        assert_eq!(
            tabs.poster(id).is_some(),
            index >= ids.len() - limit,
            "{id}"
        );
    }
    let newest = ids.last().expect("the run is not empty");
    assert_eq!(tabs.poster(newest), Some(format!("png-for-{newest}")));

    // One pathological capture may not spend the whole budget, and a refused
    // one never displaces the poster a card is already showing.
    assert!(!tabs.set_poster(newest, "x".repeat(registry::MAX_POSTER_BYTES + 1)));
    assert_eq!(tabs.poster(newest), Some(format!("png-for-{newest}")));
    assert!(!tabs.set_poster(newest, String::new()));
    assert!(!tabs.set_poster("no-such-tab", "png".into()));
}

#[test]
fn renderer_tab_commands_refuse_another_task() {
    let tabs = registry(&[("tab-a", "task-a", None), ("tab-b", "task-b", None)]);
    assert!(require_task(&tabs, "task-a", "tab-a").is_ok());
    let error = require_task(&tabs, "task-a", "tab-b").expect_err("cross-task tab must fail");
    assert_eq!(error.code, "unavailable");
    assert_eq!(error.message, "that browser tab is no longer open");
}

#[test]
fn secondary_renderers_are_bound_to_their_native_label() {
    let tabs = registry(&[("tab-a", "task-a", None), ("tab-b", "task-b", None)]);
    let holding = popout::new_window_label();
    let other = popout::new_window_label();
    tabs.set_window("tab-a", Some(&holding), None);
    tabs.set_window("tab-b", Some(&other), None);

    assert!(renderer_may_address_task(&tabs, "main", "task-a"));
    assert!(renderer_may_address_task(&tabs, "task-task-a", "task-a"));
    assert!(!renderer_may_address_task(&tabs, "task-task-b", "task-a"));
    // A browser window reaches the tasks of the tabs it holds, and no other.
    assert!(renderer_may_address_task(&tabs, &holding, "task-a"));
    assert!(!renderer_may_address_task(&tabs, &holding, "task-b"));
    assert!(!renderer_may_address_task(&tabs, &other, "task-a"));
    // Docking the tab takes the reach with it.
    tabs.set_window("tab-a", None, None);
    assert!(!renderer_may_address_task(&tabs, &holding, "task-a"));
}

#[test]
fn dock_all_on_close() {
    // A window's close request docks everything it holds before the OS
    // window goes, and only then destroys it — closing first would take the
    // child webviews with it. Destroy, not close: close would ask again.
    let popout = include_str!("popout.rs");
    let closing = source_between(
        popout,
        "tauri::WindowEvent::CloseRequested",
        "tauri::WindowEvent::Focused(true)",
    );
    assert!(closing.contains("api.prevent_close()"));
    assert!(closing.contains("dock_all_in_window(&app, &label)"));
    assert!(closing.contains("state.window_is_empty(&label)"));
    assert!(closing.contains("window.destroy()"));
    assert!(!closing.contains("window.close()"));
    let docking = source_between(popout, "pub fn dock_all_in_window", "/// Hides a window");
    assert!(docking.contains("snapshot_window(label)"));
    assert!(docking.contains("MoveTarget::Main"));
}

#[test]
fn a_child_owns_what_it_opens_and_siblings_never_see_it() {
    // The task is the outer wall; inside it, one child's page is its own.
    let tabs = registry(&[
        ("tab-own", "task-a", Some("child-1")),
        ("tab-boss", "task-a", None),
        ("tab-other", "task-b", Some("child-1")),
    ]);
    let child = caller("task-a", Some("child-1"));
    let sibling = caller("task-a", Some("child-2"));
    let boss = caller("task-a", None);

    assert_eq!(tabs.reach("tab-own", &child), Some(GrantMode::Drive));
    assert_eq!(tabs.reach("tab-own", &sibling), None);
    // The orchestrator can see into any of its children's tabs.
    assert_eq!(tabs.reach("tab-own", &boss), Some(GrantMode::Drive));
    // Another task's tab is invisible even to the same delegation id.
    assert_eq!(tabs.reach("tab-other", &child), None);

    let seen: Vec<String> = tabs
        .visible_to(&child, false)
        .into_iter()
        .map(|tab| tab.id)
        .collect();
    assert_eq!(seen, ["tab-own"]);
    assert!(tabs.visible_to(&sibling, false).is_empty());
    assert_eq!(tabs.visible_to(&boss, false).len(), 2);
}

#[test]
fn a_granted_tab_is_reachable_at_the_mode_it_was_granted() {
    let tabs = registry(&[("tab-1", "task-a", None)]);
    let child = caller("task-a", Some("child-1"));
    assert_eq!(tabs.reach("tab-1", &child), None);

    assert!(tabs.grant("tab-1", "child-1", GrantMode::Read));
    assert_eq!(tabs.reach("tab-1", &child), Some(GrantMode::Read));
    // A grant is reach, not ownership: it is not the child's to close.
    assert!(!tabs.owns("tab-1", &child));

    assert!(tabs.grant("tab-1", "child-1", GrantMode::Drive));
    assert_eq!(tabs.reach("tab-1", &child), Some(GrantMode::Drive));
    assert!(!tabs.grant("gone", "child-1", GrantMode::Drive));
}

#[test]
fn the_person_outranks_an_agent_only_when_the_tab_is_locked() {
    // Agent-to-agent holds still stand the second caller off. A person in the
    // tab does not, unless Settings → Browser lock is on.
    let tabs = registry(&[("tab-1", "task-a", None)]);
    tabs.mark_held("tab-1", "the main agent");
    assert_eq!(
        tabs.held_by_other("tab-1", "subagent child-1", false)
            .as_deref(),
        Some("the main agent")
    );

    tabs.mark_user_active("tab-1", 1_000);
    assert_eq!(
        tabs.held_by_other("tab-1", "the main agent", false)
            .as_deref(),
        None
    );
    assert_eq!(
        tabs.snapshot(Some("task-a"))[0].held_by.as_deref(),
        Some("the main agent")
    );
    assert_eq!(
        tabs.held_by_other("tab-1", "the main agent", true)
            .as_deref(),
        Some(USER_HOLDER)
    );
    assert_eq!(
        tabs.snapshot_held(Some("task-a"), true)[0]
            .held_by
            .as_deref(),
        Some(USER_HOLDER)
    );

    // A hold older than the window has expired, and a late report of an older
    // touch never shortens one the person has already renewed.
    let stale = registry::HOLD_TTL.as_millis() as u64 + 1_000;
    tabs.mark_user_active("tab-1", stale);
    assert_eq!(
        tabs.held_by_other("tab-1", "the main agent", true)
            .as_deref(),
        Some(USER_HOLDER)
    );

    let fresh = registry(&[("tab-2", "task-a", None)]);
    fresh.mark_user_active("tab-2", stale);
    assert_eq!(fresh.held_by_other("tab-2", "the main agent", true), None);
}

#[test]
fn recent_agent_work_outlives_the_live_hold_but_eventually_becomes_closable() {
    let tabs = registry(&[("tab-1", "task-a", None)]);
    tabs.mark_held("tab-1", "the main agent");
    let live = tabs.snapshot(Some("task-a"));
    assert!(tabs.agent_recently_used("tab-1"));
    assert!(live[0].agent_protected_until.is_some());

    {
        let mut entries = tabs.tabs.lock().unwrap_or_else(|error| error.into_inner());
        entries.get_mut("tab-1").unwrap().held = Some((
            "the main agent".into(),
            std::time::Instant::now()
                .checked_sub(registry::HOLD_TTL + std::time::Duration::from_secs(1))
                .unwrap(),
        ));
    }
    let recently_idle = tabs.snapshot(Some("task-a"));
    assert_eq!(recently_idle[0].held_by, None);
    assert!(recently_idle[0].agent_protected_until.is_some());
    assert!(tabs.agent_recently_used("tab-1"));

    {
        let mut entries = tabs.tabs.lock().unwrap_or_else(|error| error.into_inner());
        entries.get_mut("tab-1").unwrap().held = Some((
            "the main agent".into(),
            std::time::Instant::now()
                .checked_sub(
                    registry::AGENT_CLOSE_PROTECTION_TTL + std::time::Duration::from_secs(1),
                )
                .unwrap(),
        ));
    }
    assert!(!tabs.agent_recently_used("tab-1"));
    assert_eq!(tabs.snapshot(Some("task-a"))[0].agent_protected_until, None);
}

#[test]
fn the_guest_refuses_agent_writes_only_when_the_tab_is_locked() {
    // Only the page can tell a real keystroke from a synthesised one, so the
    // veto lives there — and it has to cover exactly the verbs the host calls
    // writes, or one of them slips past the person's hold. Off (the default)
    // the second argument is false and the veto never fires.
    assert!(GUEST_RUNTIME.contains("function blocked(method, lockActiveTab)"));
    assert!(GUEST_RUNTIME.contains("if (!lockActiveTab || !AGENT_WRITES.has(method))"));
    assert!(GUEST_RUNTIME.contains("user-holding"));
    assert!(GUEST_RUNTIME.contains("event.isTrusted"));
    assert!(GUEST_RUNTIME.contains("userIdleMs: userIdle()"));
    for method in agent::WRITES {
        assert!(
            GUEST_RUNTIME.contains(&format!("\"{method}\"")),
            "the guest's write list is missing {method}"
        );
    }
}

#[test]
fn the_cap_sleeps_the_oldest_tab_nothing_is_looking_at() {
    let tabs = registry(&[
        ("tab-1", "task-a", None),
        ("tab-2", "task-a", None),
        ("tab-3", "task-a", None),
        ("tab-4", "task-b", None),
    ]);
    let group_a = test_group("task-a").id;
    let group_b = test_group("task-b").id;
    // Everything starts on screen, and what is on screen is never a candidate.
    assert!(tabs.sleepable(Some(&group_a), "tab-1").is_empty());

    for id in ["tab-1", "tab-2", "tab-3"] {
        tabs.update(id, |tab| tab.hidden = true);
    }
    // Touch order decides, and the tab that just opened is spared.
    tabs.touch("tab-3");
    tabs.touch("tab-2");
    assert_eq!(tabs.sleepable(Some(&group_a), "tab-2"), ["tab-1", "tab-3"]);
    // Never another group's tabs, whatever their age.
    assert_eq!(tabs.sleepable(Some(&group_b), "none"), Vec::<String>::new());

    // A parked popped-out tab is as invisible as a parked pane tab: still a
    // candidate. A tab someone drove inside the hold window is not.
    tabs.update("tab-1", |tab| tab.popped_out = true);
    assert_eq!(tabs.sleepable(Some(&group_a), "tab-2"), ["tab-1", "tab-3"]);
    tabs.mark_held("tab-1", "the main agent");
    assert_eq!(tabs.sleepable(Some(&group_a), "tab-2"), ["tab-3"]);
    // Across every group, for the total cap.
    assert_eq!(tabs.sleepable(None, "tab-2"), ["tab-3"]);
    assert_eq!(tabs.live_count(Some(&group_a)), 3);
    assert_eq!(tabs.live_count(None), 4);
}

#[test]
fn a_filled_credential_closes_the_tab_to_reading() {
    let tabs = registry(&[("tab-1", "task-a", None)]);
    assert!(!tabs.credential_in_flight("tab-1"));
    assert!(agent::ensure_credential_read_safe(&tabs, "tab-1", "snapshot").is_ok());
    tabs.mark_credential_filled("tab-1");
    assert!(tabs.credential_in_flight("tab-1"));
    assert!(agent::ensure_credential_read_safe(&tabs, "tab-1", "snapshot").is_err());
    assert!(agent::ensure_credential_read_safe(&tabs, "tab-1", "click").is_ok());
    // Navigating away is the end of it; the new document has nothing filled.
    tabs.clear_credential("tab-1");
    assert!(!tabs.credential_in_flight("tab-1"));
}

#[test]
fn only_the_app_can_reach_the_login_entry_points() {
    // The page reads the prelude and deletes it before any page script runs,
    // so neither a page nor an agent's `evaluate` holds the key. Losing any
    // one of these lines would quietly hand a password to whoever asked.
    assert!(GUEST_RUNTIME.contains("delete window.__integratorBrowser;"));
    assert!(GUEST_RUNTIME.contains("const HOST_KEY = String(CONFIG.hostKey ?? \"\");"));
    for method in [
        "fillLogin(key, expectedOrigin, username, password, submit)",
        "captureLogin(key)",
    ] {
        assert!(
            GUEST_RUNTIME.contains(method),
            "the guest no longer defines {method}"
        );
    }
    assert_eq!(
        GUEST_RUNTIME
            .matches("if (!HOST_KEY || key !== HOST_KEY)")
            .count(),
        2,
        "every host-only entry point must check the key"
    );
    // And the lockout that makes the promise real.
    assert!(GUEST_RUNTIME.contains("credential-in-flight"));
    assert!(GUEST_RUNTIME.contains("CREDENTIAL_READS = new Set([\"snapshot\"])"));
    assert!(GUEST_RUNTIME.contains("location.origin !== expectedOrigin"));
    assert!(!GUEST_RUNTIME.contains("evaluate(expression)"));
}

#[test]
fn consent_dialogs_are_matched_by_vendor_not_by_words() {
    // Matching on words like "accept" would also catch a login wall, an age
    // gate and a terms dialog — three things nothing here may click through.
    for vendor in ["Cookiebot", "OneTrust", "Didomi", "Usercentrics"] {
        assert!(GUEST_RUNTIME.contains(vendor), "no matcher for {vendor}");
    }
    assert!(GUEST_RUNTIME.contains("kind: \"consent-dialog\""));
    // Reject only: there is no accept path in the runtime at all.
    assert!(!GUEST_RUNTIME.contains("acceptConsent"));
}

#[test]
fn a_page_dialog_is_answered_rather_than_left_to_block() {
    // `prompt` blocks the page's main thread, and a child webview has no dialog
    // UI to unblock it: the tab froze outright and every later call timed out
    // until it was navigated away. All three are replaced with stubs that
    // record the question and answer it, the same way `window.open` is
    // replaced — a page can call `prompt` for entirely ordinary reasons.
    for stub in ["window.alert =", "window.confirm =", "window.prompt ="] {
        assert!(
            GUEST_RUNTIME.contains(stub),
            "the guest still lets {stub} block"
        );
    }
    assert!(GUEST_RUNTIME.contains("dialogs: takeDialogs()"));
}

#[test]
fn every_verb_answers_for_the_mechanism_the_page_actually_uses() {
    // Each of these is a case where the obvious implementation reports success
    // over a page that did not move.
    //
    // A <select> has a value but throws on the input setter; typing at one
    // chooses the option instead.
    assert!(GUEST_RUNTIME.contains("element instanceof HTMLSelectElement"));
    // A printable key inserts no character of its own.
    assert!(GUEST_RUNTIME.contains("insertText(element, typed)"));
    assert!(GUEST_RUNTIME.contains("key === \"Space\" ? \" \" : key"));
    // HTML5 drag-and-drop never sees a pointer, so both are performed.
    assert!(GUEST_RUNTIME.contains("function dragSequence("));
    assert!(GUEST_RUNTIME.contains("dragstart"));
    assert!(GUEST_RUNTIME.contains("kind: html5 ? \"html5-drag\" : \"pointer-drag\""));
    // A CSS :hover menu cannot be opened by any event; say so rather than
    // reporting a hover that did nothing.
    assert!(GUEST_RUNTIME.contains("cssHoverOnly"));
    // A snapshot that stops at an iframe border reports an empty page.
    assert!(GUEST_RUNTIME.contains("function describeFrames("));
}

#[test]
fn guest_runtime_exposes_every_method_the_host_may_call() {
    // The dispatcher allowlist and the runtime must not drift apart.
    for method in [
        "snapshot",
        "setTheme",
        "setGeneration",
        "hover",
        "click",
        "type",
        "press",
        "scroll",
        "drag",
        "waitFor",
        "highlight",
        "startPick",
        "pickResult",
        "cancelPick",
        "annotate",
        "clearAnnotations",
    ] {
        assert!(
            GUEST_RUNTIME.contains(&format!("{method}(")),
            "guest runtime is missing {method}"
        );
    }
    // It must define exactly one sealed global and never let a page replace
    // the native call surface or its credential/user-hold vetoes.
    assert!(GUEST_RUNTIME.contains("Object.freeze(api);"));
    assert!(GUEST_RUNTIME.contains("Object.defineProperty(window, \"__integrator\""));
    assert!(GUEST_RUNTIME.contains("writable: false"));
    assert!(GUEST_RUNTIME.contains("configurable: false"));
}

#[test]
fn every_agent_action_shows_the_cursor_that_performed_it() {
    // A page driven from the outside moves by itself; the cursor is what
    // makes that legible, so no action may quietly skip it.
    for action in ["click", "typing", "scroll"] {
        assert!(
            GUEST_RUNTIME.contains(action),
            "guest runtime never shows the cursor for {action}"
        );
    }
    // Every verb that moves the page names itself on the cursor. Asserted by
    // label rather than by counting calls: a count breaks the moment a verb
    // is added, without saying which one forgot to show itself.
    for label in [
        "\"click\"",
        "\"scroll\"",
        "\"hover\"",
        "\"drag\"",
        "\"drop\"",
    ] {
        assert!(
            GUEST_RUNTIME.contains(&format!(", {label})")),
            "no cursor labelled {label}"
        );
    }
    // Typing labels itself with the text, so it is built rather than literal.
    assert!(GUEST_RUNTIME.contains("agentCursor(centreOf(element), label)"));
    // The pointer travels, then the gesture lands, then the reply is built —
    // so the user sees the click and the agent reads the page after it.
    assert!(GUEST_RUNTIME.contains("function schedule(delay, run)"));
    assert!(GUEST_RUNTIME.contains("setTimeout(finish, delay)"));
}

#[test]
fn eval_waits_for_the_cursor_to_arrive_before_reading_the_page() {
    let eval = source_between(
        include_str!("mod.rs"),
        "pub(super) async fn eval_json",
        "let raw = Zeroizing::new(",
    );
    assert!(eval.contains("await value"));
}

#[test]
fn agent_clicks_bring_the_tab_on_screen() {
    let invoke = source_between(
        include_str!("agent.rs"),
        "pub async fn agent_invoke",
        "fn stood_off",
    );
    assert!(invoke.contains("bring_on_screen"));
    assert!(invoke.contains("CURSOR_METHODS"));
    assert!(invoke.contains("lock_active_tab"));
    assert!(invoke.contains("blocked?.({method:?}, {user_hold})"));
}

#[test]
fn the_guest_reads_the_prelude_once_and_takes_it_off_the_page() {
    // guest_runtime() writes these flags; a rename on either side would
    // silently stop keeping pop-ups inside the tab or leave consent banners
    // clicked when the user never asked. The prelude is read into a closure
    // and deleted, which is also what keeps the host key off the page.
    assert!(GUEST_RUNTIME.contains("const CONFIG = window.__integratorBrowser ?? {};"));
    assert!(GUEST_RUNTIME.contains("delete window.__integratorBrowser;"));
    assert!(GUEST_RUNTIME.contains("CONFIG.keepPopupsInside"));
    assert!(GUEST_RUNTIME.contains("CONFIG.dismissConsent"));
}

#[test]
fn the_guest_context_menu_is_trusted_and_never_opens_a_real_window() {
    assert!(GUEST_RUNTIME.contains("const HOST_OPEN ="));
    assert!(GUEST_RUNTIME.contains("if (!event.isTrusted || pickState) return"));
    assert!(GUEST_RUNTIME.contains("Open link in new tab"));
    assert!(GUEST_RUNTIME.contains("Copy link address"));
    assert!(GUEST_RUNTIME.contains("Add to chat"));
    assert!(GUEST_RUNTIME.contains("Refresh page"));
    assert!(GUEST_RUNTIME.contains("integrator-browser-context://action"));
}

#[test]
fn tabs_are_labelled_out_of_the_capability_scope() {
    // capabilities/default.json scopes app commands to main/task-* webviews,
    // so a guest label must never match those globs.
    let label = "browser-tab-1";
    assert!(!label.starts_with("main"));
    assert!(!label.starts_with("task-"));
}

// ---- stage B: group-shared reach

/// The fixture's chat tasks all share the one Chat group; path tasks are each
/// their own group. Popping a tab out is what shares it.
fn shared_registry() -> BrowserTabs {
    let tabs = registry(&[
        ("tab-mine", "chat-1", None),
        ("tab-mine-popped", "chat-1", None),
        ("tab-sibling-pane", "chat-2", None),
        ("tab-sibling-popped", "chat-2", None),
        ("tab-elsewhere-popped", "task-a", None),
    ]);
    for id in [
        "tab-mine-popped",
        "tab-sibling-popped",
        "tab-elsewhere-popped",
    ] {
        tabs.update(id, |tab| tab.popped_out = true);
    }
    tabs
}

#[test]
fn the_access_matrix_holds_for_every_row() {
    // 01-vocabulary-and-model.md: (group, task, popped_out) → reach.
    let tabs = shared_registry();
    let me = caller("chat-1", None);
    let rows: [(&str, Option<GrantMode>); 5] = [
        // ≠ G, any, any → invisible.
        ("tab-elsewhere-popped", None),
        // = G, = T, any → yes.
        ("tab-mine", Some(GrantMode::Drive)),
        ("tab-mine-popped", Some(GrantMode::Drive)),
        // = G, ≠ T, pane → invisible.
        ("tab-sibling-pane", None),
        // = G, ≠ T, popped out → Drive.
        ("tab-sibling-popped", Some(GrantMode::Drive)),
    ];
    for (id, expected) in rows {
        assert_eq!(tabs.reach(id, &me), expected, "{id}");
    }
    let seen: Vec<String> = tabs
        .visible_to(&me, false)
        .into_iter()
        .map(|tab| tab.id)
        .collect();
    assert_eq!(seen, ["tab-mine", "tab-mine-popped", "tab-sibling-popped"]);
}

#[test]
fn a_shared_tab_is_driven_but_never_owned() {
    // Close, grant and dock go through `owns`, which still wants the task.
    let tabs = shared_registry();
    let me = caller("chat-1", None);
    assert_eq!(
        tabs.reach("tab-sibling-popped", &me),
        Some(GrantMode::Drive)
    );
    assert!(!tabs.owns("tab-sibling-popped", &me));
    assert!(tabs.owns("tab-mine-popped", &me));
    // Docking the sibling's tab would make it invisible again: sharing is the
    // owner's choice both ways.
    tabs.update("tab-sibling-popped", |tab| tab.popped_out = false);
    assert_eq!(tabs.reach("tab-sibling-popped", &me), None);
}

#[test]
fn a_child_inherits_its_parents_group_and_reaches_a_popped_out_sibling_task_tab() {
    let tabs = shared_registry();
    let child = caller("chat-1", Some("child-1"));
    assert_eq!(
        tabs.reach("tab-sibling-popped", &child),
        Some(GrantMode::Drive)
    );
    assert_eq!(tabs.reach("tab-sibling-pane", &child), None);
    assert!(!tabs.owns("tab-sibling-popped", &child));
    let seen: Vec<String> = tabs
        .visible_to(&child, false)
        .into_iter()
        .map(|tab| tab.id)
        .collect();
    assert_eq!(seen, ["tab-sibling-popped"]);
}

#[test]
fn the_cap_is_shared_by_every_task_in_a_group() {
    let tabs = registry(&[
        ("tab-1", "chat-1", None),
        ("tab-2", "chat-2", None),
        ("tab-3", "chat-2", None),
        ("tab-4", "task-a", None),
    ]);
    for id in ["tab-1", "tab-2", "tab-3", "tab-4"] {
        tabs.update(id, |tab| tab.hidden = true);
    }
    tabs.touch("tab-2");
    tabs.touch("tab-1");
    // Two chats, one group, one cap: candidates come from both tasks.
    assert_eq!(
        tabs.sleepable(Some(groups::CHAT_GROUP_ID), "tab-1"),
        ["tab-3", "tab-2"]
    );
    assert_eq!(tabs.live_count(Some(groups::CHAT_GROUP_ID)), 3);
    // A parked popped-out tab is a candidate like any other.
    tabs.update("tab-3", |tab| tab.popped_out = true);
    assert_eq!(
        tabs.sleepable(Some(groups::CHAT_GROUP_ID), "tab-1"),
        ["tab-3", "tab-2"]
    );
    // The total cap looks across groups, oldest first.
    tabs.touch("tab-4");
    assert_eq!(
        tabs.sleepable(None, "none"),
        ["tab-3", "tab-2", "tab-1", "tab-4"]
    );
    assert_eq!(remember::LIVE_TAB_CAP_PER_GROUP, 8);
    assert_eq!(remember::LIVE_TAB_CAP_TOTAL, 24);
}

#[test]
fn waking_and_opening_both_enforce_the_group_cap() {
    // Both entry points hand the woken/new tab's group to the cap.
    let remember = include_str!("remember.rs");
    let wake = source_between(remember, "pub async fn wake(", "impl BrowserTabs {");
    assert!(wake.contains("enforce_cap(app, tabs, &tab.group_id, tab_id)"));
    let module = include_str!("mod.rs");
    assert!(module.contains("remember::enforce_cap(app, state, &tab.group_id, &tab.id)"));
    // The cap is per group and then total, in that order.
    let cap = source_between(remember, "pub(super) fn enforce_cap(", "/// Loads a tab");
    assert!(cap.contains("(Some(group_id), LIVE_TAB_CAP_PER_GROUP)"));
    assert!(cap.contains("(None, LIVE_TAB_CAP_TOTAL)"));
}

#[test]
fn a_hold_names_the_holder_and_its_task() {
    let tabs = shared_registry();
    let sibling = caller("chat-2", None);
    tabs.mark_held_by("tab-sibling-popped", &sibling);
    assert_eq!(
        tabs.holder("tab-sibling-popped", false),
        Some(("the main agent".to_string(), Some("chat-2".to_string())))
    );
    // A person's hold has no task.
    tabs.mark_user_active("tab-mine", 0);
    assert_eq!(
        tabs.holder("tab-mine", true),
        Some((USER_HOLDER.to_string(), None))
    );
    // Standing off names the task when it is known, and how long to wait.
    let text = agent::stood_off("the main agent", Some("Fix login"));
    assert!(
        text.starts_with("the main agent of task \"Fix login\" is working in that tab right now")
    );
    assert!(text.contains(
        "open your own with browser_open, or wait; holds expire 45 s after the last action"
    ));
    let untitled = agent::stood_off("subagent child-1", None);
    assert!(untitled.starts_with("subagent child-1 is working in that tab right now"));
    let person = agent::stood_off(USER_HOLDER, Some("Fix login"));
    assert!(person.starts_with("the person is working in that tab right now"));
    assert!(!person.contains("Fix login"));
}

#[test]
fn agent_tools_open_popped_out_and_move_tabs_only_for_the_owner() {
    let agent = include_str!("agent.rs");
    let open = source_between(
        agent,
        "pub async fn open_for_agent(",
        "pub async fn set_popped_out_for_agent(",
    );
    assert!(open.contains("popped_out: bool"));
    assert!(open.contains("super::popout::preferred_target(tabs, &tab.id)"));
    assert!(open.contains("super::popout::move_tab(app, tabs, &tab.id, target, false)"));
    let moved = source_between(
        agent,
        "pub async fn set_popped_out_for_agent(",
        "/// Points one reachable tab",
    );
    assert!(moved.contains("if !tabs.owns(tab_id, caller)"));
    assert!(moved.contains("super::popout::preferred_target(tabs, tab_id)"));
    assert!(moved.contains("super::popout::MoveTarget::Main"));
    assert!(moved.contains("super::popout::move_tab(app, tabs, tab_id, target, false)"));
    let focus = source_between(
        agent,
        "pub async fn focus_for_agent(",
        "async fn bring_on_screen(",
    );
    assert!(focus.contains("tab.popped_out"));
    assert!(focus.contains("raise_host_window(app, &label).await"));
    let close = source_between(
        agent,
        "pub async fn close_for_agent(",
        "pub fn grant_for_agent(",
    );
    assert!(close.contains("dock or close it from there"));
}

#[test]
fn a_browser_list_row_names_its_group_holder_and_sharer() {
    let tabs = shared_registry();
    let sibling = caller("chat-2", None);
    tabs.mark_held_by("tab-sibling-popped", &sibling);
    let me = caller("chat-1", None);
    let title_of = |task: &str| (task == "chat-2").then(|| "Book flights".to_string());

    let held = tabs
        .snapshot_held(None, false)
        .into_iter()
        .find(|tab| tab.id == "tab-sibling-popped")
        .unwrap();
    let row = agent::decorate_row(&held, &me, Some("chat-2"), title_of);
    assert_eq!(row["id"], "tab-sibling-popped");
    assert_eq!(row["taskId"], "chat-2");
    assert_eq!(
        row["group"],
        serde_json::json!({ "id": groups::CHAT_GROUP_ID, "name": groups::CHAT_GROUP_NAME, "kind": "chat" })
    );
    assert!(row.get("groupId").is_none() && row.get("groupName").is_none());
    assert_eq!(row["poppedOut"], true);
    assert_eq!(row["sleeping"], false);
    assert_eq!(
        row["heldBy"],
        serde_json::json!({ "label": "the main agent", "taskId": "chat-2", "taskTitle": "Book flights" })
    );
    assert_eq!(row["heldByLabel"], "the main agent");
    assert_eq!(
        row["sharedFrom"],
        serde_json::json!({ "taskId": "chat-2", "taskTitle": "Book flights" })
    );

    // One of my own, idle: no holder, no sharer, and the title lookup is
    // never asked about a task the row does not name.
    let mine = tabs.tab("tab-mine").unwrap();
    let row = agent::decorate_row(&mine, &me, None, |_| panic!("no task to name"));
    assert!(row.get("heldBy").is_none() && row.get("heldByLabel").is_none());
    assert!(row.get("sharedFrom").is_none());
    assert_eq!(row["group"]["kind"], "chat");
}

// ---- stage D: persistence and cleanup

fn recent(task: &str, url: &str) -> session_store::StoredRecentTab {
    session_store::StoredRecentTab {
        task_id: task.parse().unwrap(),
        group_id: groups::CHAT_GROUP_ID.into(),
        url: url.into(),
        title: url.into(),
        favicon: None,
        closed_at: chrono::Utc::now(),
        reason: "stale".into(),
    }
}

#[test]
fn cleanup_never_closes_a_tab_on_screen_or_held() {
    let task_a = integrator_core::TaskId::new().to_string();
    let task_b = integrator_core::TaskId::new().to_string();
    let tabs = registry(&[
        ("tab-1", &task_a, None),
        ("tab-2", &task_a, None),
        ("tab-3", &task_a, None),
        ("tab-4", &task_b, None),
    ]);
    for (id, url) in [
        ("tab-1", "one"),
        ("tab-2", "two"),
        ("tab-3", "three"),
        ("tab-4", "four"),
    ] {
        tabs.update(id, |tab| tab.url = format!("https://{url}.example/"));
    }
    // tab-1 on screen; tab-2 parked and idle; tab-3 asleep; tab-4 parked but
    // driven by an agent inside the hold window.
    tabs.update("tab-2", |tab| tab.hidden = true);
    tabs.update("tab-3", |tab| {
        tab.hidden = true;
        tab.sleeping = true;
    });
    tabs.update("tab-4", |tab| tab.hidden = true);
    tabs.mark_held("tab-4", "the main agent");
    assert!(!tabs.retirable("tab-1"));
    assert!(tabs.retirable("tab-2"));
    assert!(tabs.retirable("tab-3"));
    assert!(!tabs.retirable("tab-4"));
    assert!(!tabs.retirable("tab-none"));

    let retired = [
        recent(&task_a, "https://one.example/"),
        recent(&task_a, "https://two.example/"),
        recent(&task_a, "https://three.example/"),
        recent(&task_b, "https://four.example/"),
        recent(&task_b, "https://gone.example/"),
    ];
    let plan = cleanup::plan(&tabs, &retired);
    assert_eq!(plan.close, vec!["tab-2".to_string(), "tab-3".to_string()]);
    // The on-screen and held tabs stay, and their rows are written back.
    assert_eq!(plan.rewrite, vec![task_a.clone(), task_b.clone()]);
}

#[test]
fn stored_rows_carry_window_order_and_touch() {
    let tabs = registry(&[("tab-1", "task-a", None), ("tab-2", "task-a", None)]);
    tabs.set_window("tab-2", Some("browser-window-x"), Some(3));
    let (rows, touched) = tabs.stored_rows("task-a");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].window_id, None);
    assert_eq!(rows[0].window_order, None);
    assert!(rows[0].last_touched_at.is_some());
    assert_eq!(rows[1].window_id.as_deref(), Some("browser-window-x"));
    assert_eq!(rows[1].window_order, Some(3));
    assert_eq!(touched.len(), 2);
    assert_eq!(touched[1].0, "tab-2");
    // A touch moves the wall-clock time and queues the task for the flush.
    let before = touched[1].1;
    std::thread::sleep(Duration::from_millis(5));
    tabs.touch("tab-2");
    let (rows, _) = tabs.stored_rows("task-a");
    assert!(rows[1].last_touched_at.unwrap() > before);
    assert_eq!(tabs.take_dirty_touch(), vec!["task-a".to_string()]);
    assert!(tabs.take_dirty_touch().is_empty());
}

#[test]
fn every_change_to_a_strip_is_written() {
    // Moves, reorders and title changes each write the affected tasks; the
    // touch flush writes only what drifted; a closed popped-out tab is
    // recorded for "Recently closed".
    let popout = include_str!("popout.rs");
    let moved = source_between(popout, "pub(super) fn move_tab(", "fn place_at(");
    assert!(moved.contains("super::remember::remember(app, state, &tab.task_id)"));
    assert!(moved.contains("super::remember::remember_window(app, state, label)"));
    let reorder = source_between(
        popout,
        "pub fn browser_window_reorder(",
        "pub fn browser_popout_tabs(",
    );
    assert!(reorder.contains("remember_window(webview.app_handle(), &state, label)"));
    let events = source_between(popout, "window.on_window_event(move |event|", "Ok(window)");
    assert!(events.contains("note_window_geometry(&event_app, &event_label, true)"));
    assert!(events.contains("tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)"));
    assert!(events.contains("persist::forget_window(&event_app, &event_label)"));

    let module = include_str!("mod.rs");
    let title = source_between(module, ".on_document_title_changed(", ".on_new_window(");
    assert!(title.contains("remember::remember(&title_app, &title_tabs, &task)"));
    let close = source_between(module, "pub(super) fn close_tab_with(", "/// Keeps a still");
    assert!(close.contains("remember::note_closed(app, &closing)"));

    let remember = include_str!("remember.rs");
    let pane = source_between(
        remember,
        "pub fn restore(",
        "pub(crate) const LIVE_TAB_CAP_PER_GROUP",
    );
    assert!(pane.contains("stored.window_id.is_some()"));
    let noted = source_between(remember, "pub(super) fn note_closed(", "pub fn restore(");
    assert!(noted.contains("!closing.popped_out || closing.url.starts_with(\"about:\")"));
    assert!(noted.contains("reason: \"closed\""));

    // Restore is armed on the main window's first focus, never at boot.
    let persist = include_str!("persist.rs");
    let armed = source_between(persist, "pub fn start_background_tasks(", "#[cfg(test)]");
    assert!(armed.contains("tauri::WindowEvent::Focused(true)) && once.claim()"));
    assert!(armed.contains("restore::restore_windows(&app)"));
}

#[test]
fn recent_rows_take_the_agent_shape() {
    let task = integrator_core::TaskId::new();
    let mut row = recent(&task.to_string(), "https://docs.example/page");
    row.title = "Docs".into();
    row.reason = "over-cap".into();
    let rows = agent::recent_rows(&[row.clone()], &Group::chat());
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["url"], "https://docs.example/page");
    assert_eq!(rows[0]["title"], "Docs");
    assert_eq!(rows[0]["reason"], "over-cap");
    assert_eq!(rows[0]["closedAt"], row.closed_at.to_rfc3339());
    assert_eq!(
        rows[0]["group"],
        serde_json::json!({ "id": groups::CHAT_GROUP_ID, "name": groups::CHAT_GROUP_NAME, "kind": "chat" })
    );
    assert!(rows[0].get("taskId").is_none() && rows[0].get("favicon").is_none());
    // The tool declaration and dispatch both know the flag.
    let broker = include_str!("../broker_mcp.rs");
    assert!(broker.contains("\"includeRecent\": { \"type\": \"boolean\""));
    let delegation = include_str!("../delegation.rs");
    assert!(
        delegation.contains("params.get(\"includeRecent\").and_then(Value::as_bool) == Some(true)")
    );
}
