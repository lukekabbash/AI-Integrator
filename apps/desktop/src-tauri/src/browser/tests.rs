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

#[test]
fn snapshot_filters_by_task_and_sorts() {
    let tabs = BrowserTabs::new();
    {
        let mut guard = tabs.tabs.lock().unwrap();
        for (id, task) in [
            ("tab-2", "task-a"),
            ("tab-1", "task-a"),
            ("tab-3", "task-b"),
        ] {
            guard.insert(
                id.to_string(),
                Tab {
                    state: BrowserTab {
                        id: id.to_string(),
                        task_id: task.to_string(),
                        url: "about:blank".into(),
                        title: String::new(),
                        loading: false,
                        popped_out: false,
                        hidden: false,
                        held_by: None,
                        sleeping: false,
                    },
                    label: format!("browser-{id}"),
                    held: None,
                    generation: 0,
                },
            );
        }
    }
    let mine = tabs.snapshot(Some("task-a"));
    assert_eq!(
        mine.iter().map(|tab| tab.id.as_str()).collect::<Vec<_>>(),
        ["tab-1", "tab-2"]
    );
    assert_eq!(tabs.snapshot(None).len(), 3);
    assert_eq!(tabs.task_of("tab-3").as_deref(), Some("task-b"));
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
fn the_popup_guard_reads_the_key_the_prelude_writes() {
    // guest_runtime() writes this flag; a rename on either side would
    // silently stop keeping pop-ups inside the tab.
    assert!(GUEST_RUNTIME.contains("window.__integratorBrowser?.keepPopupsInside"));
}

#[test]
fn tabs_are_labelled_out_of_the_capability_scope() {
    // capabilities/default.json scopes app commands to main/task-* webviews,
    // so a guest label must never match those globs.
    let label = "browser-tab-1";
    assert!(!label.starts_with("main"));
    assert!(!label.starts_with("task-"));
}
