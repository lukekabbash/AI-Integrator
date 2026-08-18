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
fn the_blank_page_is_a_url_a_tab_may_be_pointed_at() {
    // Every tab opened without an address starts here, so refusing to navigate
    // back to it was refusing the one page the browser itself hands out. Read as
    // a bare host it became "https://about:blank", whose port is "blank".
    assert_eq!(
        normalize_url("about:blank").unwrap().as_str(),
        "about:blank"
    );
    assert_eq!(
        normalize_url("  about:blank  ").unwrap().as_str(),
        "about:blank"
    );
    // Only that one. `about:` is not a general escape from the scheme rules.
    assert!(normalize_url("about:srcdoc").is_err());
    assert!(normalize_url("about:config").is_err());
}

#[test]
fn a_guest_call_answers_for_a_runtime_that_is_not_there_yet() {
    // A document part-way through a navigation has no `window.__integrator`, and
    // reading a method off it threw: `browser_wait_for` polling a loading page
    // ended on its first poll with "Cannot read properties of undefined". The
    // guard names the state in a code a caller can wait out.
    let script = guest_call("window.__integrator.snapshot()".into());
    assert!(script.starts_with("(window.__integrator ? ("));
    assert!(script.contains("guest-not-ready"));

    // Both the action and the wait loop go through it.
    assert!(
        source_between(
            include_str!("agent.rs"),
            "pub async fn agent_invoke",
            "/// Waits for the page to stop changing size",
        )
        .contains("guest_call(format!(")
    );
    let waiting = source_between(
        include_str!("../delegation.rs"),
        "\"browser_wait_for\" =>",
        "other => Err(IntegratorError::InvalidInput",
    );
    assert!(waiting.contains("\"guest-not-ready\" | \"page-navigated\""));
}

#[test]
fn a_deferred_reply_belongs_to_the_document_that_parked_it() {
    // A new page gets a new guest with its ticket counter back at zero, so a
    // bare number let the host poll for one action's reply and be handed the
    // next page's. Tickets carry the document; a mismatch is reported as the
    // navigation it was, not as "that reply is gone".
    assert!(GUEST_RUNTIME.contains("const DOC = "));
    assert!(GUEST_RUNTIME.contains("`${DOC}:${++ticketSeq}`"));
    assert!(GUEST_RUNTIME.contains("if (!key.startsWith(`${DOC}:`))"));
    assert!(GUEST_RUNTIME.contains("\"page-navigated\""));

    // And the host turns that into where the tab now is, because the gesture
    // did land — answering with a failure invites the same click twice.
    let invoke = source_between(
        include_str!("agent.rs"),
        "pub async fn agent_invoke",
        "/// Waits for the page to stop changing size",
    );
    assert!(invoke.contains("super::NAVIGATED && writing"));
    assert!(invoke.contains("\"navigated\": true"));
}

#[test]
fn one_guest_call_at_a_time_per_tab() {
    // Parking a ticket and polling `settle` is two round trips, and the guest
    // runs a pending gesture early the moment a second action arrives, so two
    // calls in flight on one tab interleave and one reply is lost.
    let module = include_str!("mod.rs");
    assert!(module.contains("fn eval_lock_for(label: &str)"));
    let eval = source_between(
        module,
        "pub(super) async fn eval_json",
        "if value.get(\"ok\")",
    );
    assert!(eval.contains("let lock = eval_lock_for(label);"));
    assert!(eval.contains("lock.lock().await"));
}

#[test]
fn a_ticket_is_only_ever_the_shape_the_guest_issues() {
    // It is put back into a script, so nothing else may travel there.
    assert!(ticket_is_well_formed("1755478900123-42:7"));
    assert!(!ticket_is_well_formed(""));
    assert!(!ticket_is_well_formed("1:2\"); alert(1); ("));
    assert!(!ticket_is_well_formed("a".repeat(65).as_str()));
}

#[test]
fn agent_tab_replies_carry_no_icon_bytes() {
    // `favicon` is a data: URL of up to 96 KiB. It is a picture for the tab
    // strip; in a tool reply it is thousands of base64 characters a model reads
    // and can do nothing with.
    let agent = include_str!("agent.rs");
    assert!(agent.contains("fn without_icon(mut tab: BrowserTab)"));
    for site in [
        "open_for_agent",
        "navigate_for_agent",
        "grant_for_agent",
        "tabs_for_caller",
    ] {
        let body = source_between(agent, &format!("fn {site}"), "\n}\n");
        assert!(
            body.contains("without_icon"),
            "{site} still hands back icon bytes"
        );
    }
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

/// A registry holding one tab per `(id, task, owner)`, where `owner` is the
/// delegated child that opened it, or `None` for the orchestrator's own.
fn registry(rows: &[(&str, &str, Option<&str>)]) -> BrowserTabs {
    let tabs = BrowserTabs::new();
    {
        let mut guard = tabs.tabs.lock().unwrap();
        for (id, task, owner) in rows {
            guard.insert(
                (*id).to_string(),
                Tab {
                    state: BrowserTab {
                        id: (*id).to_string(),
                        task_id: (*task).to_string(),
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
                    placement_slot: Some(PlacementSlot::Pane),
                    held: None,
                    user_at: None,
                    grants: HashMap::new(),
                    generation: 0,
                    touched: std::time::Instant::now(),
                    credential_at: None,
                    poster: None,
                },
            );
        }
    }
    tabs
}

fn caller(task: &str, delegation: Option<&str>) -> Caller {
    Caller {
        task_id: task.to_string(),
        delegation_id: delegation.map(str::to_owned),
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
    tabs.update("popout-peer", |tab| tab.popped_out = true);
    tabs.update("other-task", |tab| tab.popped_out = false);

    assert_eq!(
        tabs.visible_peers("task-a", "keep", false, PlacementSlot::Pane),
        ["main-peer", "other-task"]
    );
    assert_eq!(
        tabs.visible_peers("task-a", "keep", true, PlacementSlot::Pane),
        ["popout-peer"]
    );
    tabs.set_placement("main-peer", Some(PlacementSlot::Deck));
    assert_eq!(
        tabs.visible_peers("task-a", "keep", false, PlacementSlot::Pane),
        ["other-task"]
    );
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
fn placement_claims_keep_slots_and_popout_tasks_independent() {
    let tabs = registry(&[("tab-a", "task-a", None), ("tab-b", "task-b", None)]);

    assert!(tabs.claim_placement("task-a", "tab-a", false, PlacementSlot::Pane, 10, 8));
    assert!(tabs.claim_placement("task-a", "tab-a", false, PlacementSlot::Deck, 10, 1));
    assert!(tabs.claim_placement("task-a", "tab-a", true, PlacementSlot::Popout, 10, 4));
    assert!(tabs.claim_placement("task-b", "tab-b", true, PlacementSlot::Popout, 10, 1));
    assert!(tabs.placement_is_current("task-b", "tab-b", true, PlacementSlot::Popout, 10, 1));

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
fn secondary_renderers_are_bound_to_their_native_task_label() {
    assert!(renderer_may_address_task("main", "task-a", false));
    assert!(renderer_may_address_task("task-task-a", "task-a", false));
    assert!(!renderer_may_address_task("task-task-b", "task-a", false));
    assert!(renderer_may_address_task(
        &popout::window_label("task-a"),
        "task-a",
        false
    ));
    assert!(!renderer_may_address_task(
        &popout::window_label("task-b"),
        "task-a",
        false
    ));
    // The shared chat window reaches chats only.
    assert!(renderer_may_address_task(
        popout::CHAT_WINDOW_LABEL,
        "task-a",
        true
    ));
    assert!(!renderer_may_address_task(
        popout::CHAT_WINDOW_LABEL,
        "task-a",
        false
    ));
}

#[test]
fn popout_window_identity_is_task_scoped_and_stable() {
    let first = popout::window_label("task-a");
    assert_eq!(first, popout::window_label("task-a"));
    assert_ne!(first, popout::window_label("task-b"));
    assert!(first.starts_with(popout::POPOUT_WINDOW_PREFIX));
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
    // Everything starts on screen, and what is on screen is never a candidate.
    assert!(tabs.sleepable("task-a", "tab-1").is_empty());

    for id in ["tab-1", "tab-2", "tab-3"] {
        tabs.update(id, |tab| tab.hidden = true);
    }
    // Touch order decides, and the tab that just opened is spared.
    tabs.touch("tab-3");
    tabs.touch("tab-2");
    assert_eq!(tabs.sleepable("task-a", "tab-2"), ["tab-1", "tab-3"]);
    // Never another task's tabs, whatever their age.
    assert_eq!(tabs.sleepable("task-b", "none"), Vec::<String>::new());

    tabs.update("tab-1", |tab| tab.popped_out = true);
    assert_eq!(tabs.sleepable("task-a", "tab-2"), ["tab-3"]);
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
fn a_verb_describes_its_target_before_the_gesture_lands() {
    // A click that navigates or re-renders leaves the node detached, and a
    // detached node measures 0×0 — which is how a click that worked came back
    // reporting an empty rectangle over the thing it had just pressed.
    assert!(GUEST_RUNTIME.contains("const clicked = describe(element);"));
    assert!(GUEST_RUNTIME.contains("ok({ clicked, ...pageState() })"));
    assert!(GUEST_RUNTIME.contains("const hovered = describe(element);"));
    assert!(GUEST_RUNTIME.contains("const described = { from: describe(source)"));
}

#[test]
fn a_gesture_can_be_aimed_at_a_plain_coordinate() {
    // A canvas stroke and a slider have no element to name. Only the end of a
    // drag understood a point, so every coordinate drag was refused for a start
    // it never looked for — and asking the document what is at a point had to
    // stop answering "the agent cursor you are drawing".
    assert!(GUEST_RUNTIME.contains("function elementAtPoint(x, y)"));
    assert!(GUEST_RUNTIME.contains("host.style.pointerEvents = \"none\""));
    assert!(GUEST_RUNTIME.contains("function resolveAt(target)"));
    assert!(GUEST_RUNTIME.contains("const source = resolveAt(from);"));
    // One precedence rule, in one place: a named locator wins, a bare point
    // asks the page what is there, and both together mean that element at that
    // point.
    assert!(GUEST_RUNTIME.contains("function named(target)"));
    assert!(GUEST_RUNTIME.contains("function pointOf(target)"));
    // Scrolling the page would move the coordinate out from under the gesture.
    assert!(GUEST_RUNTIME.contains("if (!fromPoint) source.scrollIntoView"));
    assert!(GUEST_RUNTIME.contains("if (!at) element.scrollIntoView"));
}

#[test]
fn scrolling_something_that_does_not_scroll_scrolls_the_page() {
    // `scrollBy` on a box with no overflow does nothing and says nothing, so
    // naming a wrapper — `#content` on a page whose scroller is the document —
    // swallowed the gesture and reported success.
    assert!(GUEST_RUNTIME.contains("function scrollableFrom(element)"));
    assert!(GUEST_RUNTIME.contains("(scroller ?? window).scrollBy("));
    assert!(GUEST_RUNTIME.contains("that element does not scroll, so the page was scrolled"));
}

#[test]
fn a_ref_taken_at_another_width_is_spent_like_one_from_another_page() {
    // A parked tab is 1280 wide and one in the pane about 460, and a gesture
    // brings the tab forward before it lands: the snapshot describes a desktop
    // layout the click never sees. Refs still resolved, because generation only
    // counts documents, so a click reported success against geometry that had
    // moved — or a control the narrow layout does not have at all.
    assert!(GUEST_RUNTIME.contains("function layoutClass()"));
    assert!(
        GUEST_RUNTIME.contains("if (record && record.layout !== layoutClass()) return RESIZED;")
    );
    assert!(GUEST_RUNTIME.contains("RESIZED_MESSAGE"));
    // Every verb answers for both kinds of spent ref, through one helper.
    assert!(GUEST_RUNTIME.contains("function gone(resolved)"));
    assert!(!GUEST_RUNTIME.contains("=== STALE ?"));
    assert_eq!(
        GUEST_RUNTIME
            .matches("err(\"stale-ref\", STALE_MESSAGE)")
            .count(),
        1
    );
    // And a reply says the page has re-laid out since it was last read.
    assert!(GUEST_RUNTIME.contains("function layoutShift()"));
    assert!(GUEST_RUNTIME.contains("describedAt = { width: innerWidth, height: innerHeight };"));
    // The host waits for the resize to finish before the gesture resolves.
    let invoke = source_between(
        include_str!("agent.rs"),
        "pub async fn agent_invoke",
        "/// Waits for the page to stop changing size",
    );
    assert!(invoke.contains("settle_layout(app, &label).await"));
}

#[test]
fn typing_never_hunts_for_a_field_named_after_what_is_typed() {
    // One locator was built for every verb, so `text` — the characters to
    // insert — was also the accessible name to find. Worse, the object was then
    // never empty, which took away the "type into whatever has focus" path too.
    let browser = source_between(
        include_str!("../delegation.rs"),
        "async fn browser_tool",
        "fn peers_list",
    );
    let typing = source_between(browser, "let typing_target = ||", "let call =");
    assert!(!typing.contains("\"text\""));
    assert!(typing.contains("\"role\""));
    assert!(browser.contains("vec![\n                    typing_target(),"));
    // Role on its own is a target, so `{ role: "searchbox" }` finds the field.
    assert!(GUEST_RUNTIME.contains("if (target.text || target.role)"));
    assert!(GUEST_RUNTIME.contains("if (!wanted) return element;"));
    // And the words a person reads count, not only the accessible name, which a
    // long `title` tooltip otherwise owns outright.
    assert!(
        GUEST_RUNTIME.contains("const label = shown.length <= 200 ? shown.toLowerCase() : \"\";")
    );
}

#[test]
fn a_bare_space_is_answered_with_what_to_write_instead() {
    let press = source_between(
        include_str!("../delegation.rs"),
        "\"browser_press\" =>",
        "\"browser_drag\" =>",
    );
    assert!(press.contains("write Space for the space bar"));
    assert!(press.contains("if given.is_empty()"));
}

#[test]
fn a_grant_reply_names_the_share_it_made() {
    // The reply was the tab exactly as it looked before, so a grant that had
    // worked read as a call that did nothing. `heldBy` stays the orchestrator:
    // handing a child a key does not take yours away.
    let grant = source_between(
        include_str!("../delegation.rs"),
        "\"browser_grant\" =>",
        "\"browser_focus\" =>",
    );
    assert!(grant.contains("\"grantedTo\": delegation"));
    assert!(grant.contains("\"mode\": mode"));
    // Never by moving the hold: that would lock the orchestrator out of its own
    // tab, and it is the one that has to keep driving.
    assert!(!grant.contains("mark_held"));
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
    // WebView2's ExecuteScript serialises a Promise as `{}`, so the wrapper
    // must stay synchronous and hand a pending reply to the guest as a ticket
    // the host polls; an `async` wrapper made every reply read as null.
    let eval = source_between(
        include_str!("mod.rs"),
        "pub(super) async fn eval_json",
        "if value.get(\"ok\")",
    );
    assert!(!eval.contains("(async () =>"));
    assert!(eval.contains("typeof value.then === 'function'"));
    assert!(eval.contains("guest.defer(value)"));
    assert!(eval.contains("guest.settle("));

    let guest = include_str!("guest.js");
    assert!(guest.contains("defer(value) {"));
    assert!(guest.contains("settle(ticket) {"));
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

#[test]
fn windows_ua_uses_the_engine_major_and_never_says_webview() {
    let ua = surface::user_agent(surface::SurfaceOs::Windows, Some("151.0.3351.95"));
    assert!(ua.contains("Chrome/151.0.0.0"));
    assert!(ua.contains("Windows NT 10.0"));
    assert!(!ua.contains("WebView"));
    assert!(!ua.contains("Edg/"));
    assert!(!ua.contains("Chrome/134"));
}

#[test]
fn unknown_or_unreadable_engine_falls_back_to_current_chrome() {
    let missing = surface::user_agent(surface::SurfaceOs::Windows, None);
    let webkit = surface::user_agent(surface::SurfaceOs::Windows, Some("21619.1.26.11.3"));
    let expected = format!("Chrome/{}.0.0.0", surface::FALLBACK_CHROME_MAJOR);
    assert!(missing.contains(&expected));
    assert!(webkit.contains(&expected));
    assert!(!missing.contains("WebView"));
}

#[test]
fn macos_ua_looks_like_safari_not_windows_chrome() {
    let ua = surface::user_agent(surface::SurfaceOs::Mac, Some("21619.1.26.11.3"));
    assert!(ua.contains("Macintosh"));
    assert!(ua.contains("Version/19.0"));
    assert!(ua.contains("Safari/605.1.15"));
    assert!(!ua.contains("Windows NT"));
    assert!(!ua.contains("WebView"));
}

#[test]
fn windows_args_keep_wry_defaults_and_drop_client_hints() {
    assert!(surface::WINDOWS_BROWSER_ARGS.contains("msWebOOUI"));
    assert!(surface::WINDOWS_BROWSER_ARGS.contains("msPdfOOUI"));
    assert!(surface::WINDOWS_BROWSER_ARGS.contains("msSmartScreenProtection"));
    assert!(surface::WINDOWS_BROWSER_ARGS.contains("UserAgentClientHint"));
}

#[test]
fn identity_surface_strips_its_prelude_and_never_names_webview() {
    let script = include_str!("identity_surface.js");
    assert!(script.contains("delete window.__integratorSurface;"));
    assert!(script.contains("userAgentData"));
    assert!(script.contains("webdriver"));
    assert!(!script.contains("WebView"));
}

#[test]
fn every_profile_webview_takes_the_desktop_browser_surface() {
    let tabs = include_str!("mod.rs");
    let create = source_between(
        tabs,
        "pub(super) fn tab_webview_builder",
        "pub(super) async fn create_tab",
    );
    assert!(create.contains("surface::apply"));
    assert!(!create.contains("Chrome/134"));

    let sites = include_str!("sites.rs");
    let probe = source_between(sites, "fn open_profile_probe", "fn profile_webview_known");
    assert!(probe.contains("surface::apply"));
}
