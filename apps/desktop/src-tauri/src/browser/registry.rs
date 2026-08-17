//! The tab registry: what tabs exist, who may reach each one, and who has it
//! right now.
//!
//! Everything here is bookkeeping over a `HashMap` behind one mutex. The
//! webviews themselves, and every call into a page, live in the parent module —
//! this half has no opinions about Tauri and answers the same questions for the
//! renderer and for an agent.

use std::{
    collections::HashMap,
    sync::{Mutex, atomic::AtomicU64},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One tab's user-visible state. The renderer renders from this; the agent
/// reads the same fields through the broker.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub id: String,
    /// Task that owns the tab, so agent tools cannot address another task's tabs.
    pub task_id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub popped_out: bool,
    /// True while the tab has no visible host (pane closed); it keeps running.
    pub hidden: bool,
    /// Set while an agent is driving this tab, so a second one can see that
    /// someone is mid-flow here and open its own rather than take the wheel.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub held_by: Option<String>,
    /// The delegated child that owns this tab, when a child opened it. Tabs
    /// the orchestrator opened have none, and siblings never see each other's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delegation_id: Option<String>,
    /// Remembered from a previous session and not yet loaded. It has an address
    /// and a title but no webview, so a chat can come back with a dozen tabs
    /// without fetching a dozen pages.
    pub sleeping: bool,
}

pub(crate) struct Tab {
    pub(crate) state: BrowserTab,
    /// Label of the webview; also the pop-out window label when popped out.
    pub(crate) label: String,
    /// Who last drove this tab through the broker, and when. A page can only
    /// be in one state at a time, so two agents taking turns on one tab undo
    /// each other's work; this is what lets the second one notice.
    pub(crate) held: Option<(String, std::time::Instant)>,
    /// When a real hand last touched the page. Input inside a child webview
    /// never reaches the app, so this arrives on the back of whatever the guest
    /// last answered — see `userIdleMs` in `guest.js`.
    pub(crate) user_at: Option<std::time::Instant>,
    /// Children the orchestrator has handed this tab to, and what they may do
    /// with it. Read means snapshot and evaluate; drive adds the verbs that
    /// change the page.
    pub(crate) grants: HashMap<String, GrantMode>,
    /// How many documents this tab has loaded. The guest is rebuilt per
    /// document and cannot count them itself, so the host does and pushes the
    /// number in; refs carry it, and one from an earlier page reads as stale.
    pub(crate) generation: u64,
    /// Last time anything reached for this tab — an agent, the person, or the
    /// renderer placing it. What the live-tab cap sleeps first.
    pub(crate) touched: std::time::Instant,
    /// When the app typed a saved password into this page. While it is set,
    /// reading the page back is refused; see `vault`.
    pub(crate) credential_at: Option<std::time::Instant>,
}

/// What a child may do with a tab it was handed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GrantMode {
    /// Snapshot and evaluate, but never change the page.
    Read,
    /// Everything the owner can do, short of granting it onward.
    Drive,
}

/// Who is asking. A tab is reachable when the task matches and either the
/// caller owns it or has been granted it.
#[derive(Clone, Debug)]
pub struct Caller {
    pub task_id: String,
    /// Set when the caller is a delegated child rather than the orchestrator.
    pub delegation_id: Option<String>,
}

impl Caller {
    /// The name a hold is recorded under, and what another agent is shown.
    pub(crate) fn label(&self) -> String {
        match &self.delegation_id {
            Some(delegation) => format!("subagent {delegation}"),
            None => "the main agent".to_string(),
        }
    }
}

/// How long after an agent's last action the tab still reads as theirs. The
/// user's hold runs on the same clock, so "someone has this page" means one
/// thing whoever the someone is.
pub(crate) const HOLD_TTL: Duration = Duration::from_secs(45);

/// The holder a tab reports while the person is working in it.
pub(crate) const USER_HOLDER: &str = "you";

/// How long a filled password keeps a tab closed to reading, if the page never
/// navigates. Long enough for a slow sign-in, short enough that a tab left on a
/// form does not stay unreadable for the session.
pub(crate) const CREDENTIAL_TTL: Duration = Duration::from_secs(300);

pub struct BrowserTabs {
    pub(crate) tabs: Mutex<HashMap<String, Tab>>,
    pub(crate) sequence: AtomicU64,
    /// Proves to the guest that a call came from the app. Written into the
    /// prelude, which the guest reads and deletes before any page script runs,
    /// so neither a page nor an agent's `evaluate` can reach the entry points
    /// that touch a saved password. Fresh every launch.
    host_key: String,
}

impl Default for BrowserTabs {
    fn default() -> Self {
        Self {
            tabs: Mutex::default(),
            sequence: AtomicU64::default(),
            host_key: uuid::Uuid::new_v4().to_string(),
        }
    }
}

impl BrowserTabs {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn snapshot(&self, task_id: Option<&str>) -> Vec<BrowserTab> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let mut list: Vec<BrowserTab> = tabs
            .values()
            .filter(|tab| task_id.is_none_or(|task| tab.state.task_id == task))
            .map(|tab| {
                let mut state = tab.state.clone();
                state.held_by = holder_of(tab);
                state
            })
            .collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    /// Every tab this caller may address: the task's own, minus the ones a
    /// sibling child opened, plus anything granted to it.
    pub(crate) fn visible_to(&self, caller: &Caller) -> Vec<BrowserTab> {
        self.snapshot(Some(&caller.task_id))
            .into_iter()
            .filter(|tab| self.reach(&tab.id, caller).is_some())
            .collect()
    }

    /// What this caller may do with one tab, or `None` if it cannot see it.
    pub(crate) fn reach(&self, id: &str, caller: &Caller) -> Option<GrantMode> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let tab = tabs.get(id)?;
        if tab.state.task_id != caller.task_id {
            return None;
        }
        match (&tab.state.delegation_id, &caller.delegation_id) {
            // The orchestrator reaches its own tabs and any child's.
            (_, None) => Some(GrantMode::Drive),
            // A child reaches the tabs it opened.
            (Some(owner), Some(asker)) if owner == asker => Some(GrantMode::Drive),
            // Otherwise only what it was handed.
            (_, Some(asker)) => tab.grants.get(asker).copied(),
        }
    }

    /// Whether this caller owns the tab outright, rather than holding a grant.
    pub(crate) fn owns(&self, id: &str, caller: &Caller) -> bool {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        match tabs.get(id) {
            Some(tab) if tab.state.task_id == caller.task_id => {
                tab.state.delegation_id == caller.delegation_id
                    || (caller.delegation_id.is_none() && tab.state.delegation_id.is_some())
            }
            _ => false,
        }
    }

    /// Hands a child one tab. Only the orchestrator grants, and a grant never
    /// crosses tasks because the tab is looked up inside the caller's own.
    pub(crate) fn grant(&self, id: &str, to: &str, mode: GrantMode) -> bool {
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        match tabs.get_mut(id) {
            Some(tab) => {
                tab.grants.insert(to.to_string(), mode);
                true
            }
            None => false,
        }
    }

    /// Counts a fresh document and returns the new generation.
    pub(crate) fn bump_generation(&self, id: &str) -> Option<u64> {
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let tab = tabs.get_mut(id)?;
        tab.generation += 1;
        Some(tab.generation)
    }

    /// Records that `holder` just drove this tab.
    pub(crate) fn mark_held(&self, id: &str, holder: &str) {
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(tab) = tabs.get_mut(id) {
            let now = std::time::Instant::now();
            tab.held = Some((holder.to_string(), now));
            tab.touched = now;
        }
    }

    /// Records that the person touched this page `idle_ms` ago, as the guest
    /// reported it in its reply.
    pub(crate) fn mark_user_active(&self, id: &str, idle_ms: u64) {
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(tab) = tabs.get_mut(id) {
            let at = std::time::Instant::now()
                .checked_sub(Duration::from_millis(idle_ms))
                .unwrap_or_else(std::time::Instant::now);
            // Only ever move forward: an older report arriving late must not
            // shorten a hold the person has already renewed.
            if tab.user_at.is_none_or(|previous| at > previous) {
                tab.user_at = Some(at);
            }
        }
    }

    /// Who is driving this tab right now, if anyone other than `asker`.
    pub(crate) fn held_by_other(&self, id: &str, asker: &str) -> Option<String> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        holder_of(tabs.get(id)?).filter(|who| who != asker)
    }

    /// The key that proves a guest call came from the app.
    pub(crate) fn host_key(&self) -> String {
        self.host_key.clone()
    }

    /// Records that a saved password is now typed into this page.
    pub(crate) fn mark_credential_filled(&self, id: &str) {
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(tab) = tabs.get_mut(id) {
            tab.credential_at = Some(std::time::Instant::now());
        }
    }

    /// Whether a secret is on this page. The guest refuses page reads while it
    /// is; this is the host's half, for the captures the guest cannot see.
    pub(crate) fn credential_in_flight(&self, id: &str) -> bool {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.get(id).is_some_and(|tab| {
            tab.credential_at
                .is_some_and(|at| at.elapsed() < CREDENTIAL_TTL)
        })
    }

    /// Clears the lockout. Navigating away ends it: the new document has a new
    /// guest and no filled field.
    pub(crate) fn clear_credential(&self, id: &str) {
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(tab) = tabs.get_mut(id) {
            tab.credential_at = None;
        }
    }

    /// Notes that something reached for this tab, for the live-tab cap.
    pub(crate) fn touch(&self, id: &str) {
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(tab) = tabs.get_mut(id) {
            tab.touched = std::time::Instant::now();
        }
    }

    /// This task's loaded tabs that nothing is looking at, oldest touch first —
    /// the order the cap puts them back to sleep in.
    pub(crate) fn sleepable(&self, task_id: &str, keep: &str) -> Vec<String> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let mut candidates: Vec<(std::time::Instant, String)> = tabs
            .values()
            .filter(|tab| {
                tab.state.task_id == task_id
                    && tab.state.id != keep
                    && !tab.state.sleeping
                    && tab.state.hidden
                    && !tab.state.popped_out
            })
            .map(|tab| (tab.touched, tab.state.id.clone()))
            .collect();
        candidates.sort_by_key(|(touched, _)| *touched);
        candidates.into_iter().map(|(_, id)| id).collect()
    }

    /// Whether the renderer is currently giving this tab a rectangle. A parked
    /// tab keeps its full size, so this is the only honest read of "on screen".
    pub(crate) fn on_screen(&self, id: &str) -> bool {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.get(id)
            .is_some_and(|tab| !tab.state.hidden && !tab.state.sleeping)
    }

    pub(crate) fn label_for(&self, id: &str) -> Option<String> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.get(id).map(|tab| tab.label.clone())
    }

    pub(crate) fn task_of(&self, id: &str) -> Option<String> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.get(id).map(|tab| tab.state.task_id.clone())
    }

    pub(crate) fn update(
        &self,
        id: &str,
        apply: impl FnOnce(&mut BrowserTab),
    ) -> Option<BrowserTab> {
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let tab = tabs.get_mut(id)?;
        apply(&mut tab.state);
        Some(tab.state.clone())
    }
}

/// Who has this tab right now, if anyone. A hold is reported only while it is
/// fresh, so nothing has to remember to release one when a run ends or an agent
/// dies. The person outranks an agent: if they have touched the page inside the
/// window, it is theirs even if an agent was mid-flow.
pub(crate) fn holder_of(tab: &Tab) -> Option<String> {
    if tab.user_at.is_some_and(|at| at.elapsed() < HOLD_TTL) {
        return Some(USER_HOLDER.to_string());
    }
    tab.held
        .as_ref()
        .filter(|(_, at)| at.elapsed() < HOLD_TTL)
        .map(|(who, _)| who.clone())
}

/// Notes the person's last touch from a guest reply, so a tab an agent is
/// reading still reports who really has it.
pub(crate) fn note_user_activity(tabs: &BrowserTabs, tab_id: &str, reply: &Value) {
    if let Some(idle) = reply.get("userIdleMs").and_then(Value::as_u64) {
        tabs.mark_user_active(tab_id, idle);
    }
}
