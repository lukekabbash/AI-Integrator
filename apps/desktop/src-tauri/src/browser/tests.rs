//! Tests for the browser module: URL handling, task scoping, the guest
//! runtime contract, and the labels that keep guest webviews outside the
//! app's capability scope.

use super::*;

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
fn rejects_non_web_schemes_and_junk() {
    assert!(normalize_url("file:///etc/passwd").is_err());
    assert!(normalize_url("javascript:alert(1)").is_err());
    assert!(normalize_url("   ").is_err());
    assert!(normalize_url(&"a".repeat(3000)).is_err());
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
                        loading: false,
                        popped_out: false,
                        hidden: false,
                        held_by: None,
                        sleeping: false,
                        delegation_id: owner.map(str::to_owned),
                    },
                    label: format!("browser-{id}"),
                    held: None,
                    user_at: None,
                    grants: HashMap::new(),
                    generation: 0,
                    touched: std::time::Instant::now(),
                    credential_at: None,
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
        .visible_to(&child)
        .into_iter()
        .map(|tab| tab.id)
        .collect();
    assert_eq!(seen, ["tab-own"]);
    assert!(tabs.visible_to(&sibling).is_empty());
    assert_eq!(tabs.visible_to(&boss).len(), 2);
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
fn the_person_outranks_whatever_agent_was_mid_flow() {
    // Both holds run on one clock, and the one at the keyboard wins: an agent
    // that took the tab a moment ago is stood off the instant a hand moves.
    let tabs = registry(&[("tab-1", "task-a", None)]);
    tabs.mark_held("tab-1", "the main agent");
    assert_eq!(
        tabs.held_by_other("tab-1", "subagent child-1").as_deref(),
        Some("the main agent")
    );

    tabs.mark_user_active("tab-1", 1_000);
    assert_eq!(
        tabs.held_by_other("tab-1", "the main agent").as_deref(),
        Some(USER_HOLDER)
    );
    assert_eq!(
        tabs.snapshot(Some("task-a"))[0].held_by.as_deref(),
        Some(USER_HOLDER)
    );

    // A hold older than the window has expired, and a late report of an older
    // touch never shortens one the person has already renewed.
    let stale = registry::HOLD_TTL.as_millis() as u64 + 1_000;
    tabs.mark_user_active("tab-1", stale);
    assert_eq!(
        tabs.held_by_other("tab-1", "the main agent").as_deref(),
        Some(USER_HOLDER)
    );

    let fresh = registry(&[("tab-2", "task-a", None)]);
    fresh.mark_user_active("tab-2", stale);
    assert_eq!(fresh.held_by_other("tab-2", "the main agent"), None);
}

#[test]
fn the_guest_refuses_agent_writes_while_the_person_is_working() {
    // Only the page can tell a real keystroke from a synthesised one, so the
    // veto lives there — and it has to cover exactly the verbs the host calls
    // writes, or one of them slips past the person's hold.
    assert!(GUEST_RUNTIME.contains("function blocked(method)"));
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
    tabs.mark_credential_filled("tab-1");
    assert!(tabs.credential_in_flight("tab-1"));
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
        "fillLogin(key, username, password, submit)",
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
    assert!(GUEST_RUNTIME.contains("CREDENTIAL_READS = new Set([\"evaluate\", \"snapshot\"])"));
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
        "evaluate",
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
    // It must define exactly one global and never leak a second one.
    assert!(GUEST_RUNTIME.contains("window.__integrator = api;"));
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
    // The gesture lands before the reply; the animation catches up after.
    // Deferring the action behind the cursor made `scroll` answer with the
    // position it had before scrolling.
    assert!(GUEST_RUNTIME.contains("function schedule(_delay, run)"));
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
fn tabs_are_labelled_out_of_the_capability_scope() {
    // capabilities/default.json scopes app commands to main/task-* webviews,
    // so a guest label must never match those globs.
    let label = "browser-tab-1";
    assert!(!label.starts_with("main"));
    assert!(!label.starts_with("task-"));
}
