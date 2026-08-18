//! Browser tests for the grouped, shared, movable and persistent pop-out
//! model (stages B–D of `temp/browser-upgrades`): reach across a group,
//! the per-group cap, windows as bags, and what survives a restart.

use super::tests::{caller, registry, source_between};
use super::*;

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
