//! The tab registry: what tabs exist, who may reach each one, and who has it
//! right now.
//!
//! Everything here is bookkeeping over a `HashMap` behind one mutex. The
//! webviews themselves, and every call into a page, live in the parent module —
//! this half has no opinions about Tauri and answers the same questions for the
//! renderer and for an agent.

use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::groups::{GroupCache, GroupKind};

/// One tab's user-visible state. The renderer renders from this; the agent
/// reads the same fields through the broker.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub id: String,
    /// Task that owns the tab, so agent tools cannot address another task's tabs.
    pub task_id: String,
    /// The group this tab is drawn and (from stage B) cookie-scoped under: the
    /// task's project, or the one Chat group. Derived from the task; never edited.
    pub group_id: String,
    pub group_name: String,
    pub group_kind: GroupKind,
    pub url: String,
    pub title: String,
    /// The site's own icon as a `data:` URL, once the page has been asked for
    /// it. Absent until then, and absent for any page that has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favicon: Option<String>,
    pub loading: bool,
    pub popped_out: bool,
    /// True while the tab has no visible host (pane closed); it keeps running.
    pub hidden: bool,
    /// Set while an agent is driving this tab, so a second one can see that
    /// someone is mid-flow here and open its own rather than take the wheel.
    /// `you` appears only when the Settings lock is on and the person is in
    /// the tab.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub held_by: Option<String>,
    /// Wall-clock deadline through which the UI must preserve this tab when
    /// its close button is pressed. Agent work gets a short safety tail after
    /// the live hold expires; user-only tabs never receive one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_protected_until: Option<u64>,
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
    /// Label of the webview.
    pub(crate) label: String,
    /// The pop-out window this tab lives in, by label; `None` while it is in
    /// the main window. `state.popped_out` is kept equal to `window.is_some()`
    /// by `set_window`, the one place either changes.
    pub(crate) window: Option<String>,
    /// Position in its pop-out window's strip. Meaningless in the main window,
    /// where the pane orders its own surfaces.
    pub(crate) order: u32,
    /// Which intentional rectangle in that native host currently owns it.
    /// The pane and compact deck may both be visible without evicting each
    /// other; two tabs claiming the same slot may not.
    pub(crate) placement_slot: Option<PlacementSlot>,
    /// Who last drove this tab through the broker, and when. A page can only
    /// be in one state at a time, so two agents taking turns on one tab undo
    /// each other's work; this is what lets the second one notice.
    pub(crate) held: Option<(String, std::time::Instant)>,
    /// The task whose agent last held this tab. A shared tab may be driven
    /// from another task in the group, so the label alone does not say whose
    /// "main agent" it was.
    pub(crate) held_task: Option<String>,
    /// When a real hand last touched the page. Input inside a child webview
    /// never reaches the app, so this arrives on the back of whatever the guest
    /// last answered — see `userIdleMs` in `guest.js`.
    pub(crate) user_at: Option<std::time::Instant>,
    /// Children the orchestrator has handed this tab to, and what they may do
    /// with it. Read means snapshot; drive adds the verbs that change the page.
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
    /// The last still taken of this page, if one is still held. A tab that has
    /// never been on screen has none, and a card with none reads exactly as it
    /// did before there were any.
    pub(crate) poster: Option<Poster>,
}

/// A still of one page, base64 PNG, with the tick it was taken on. The tick is
/// a counter rather than a clock so two captures in the same instant still
/// evict in the order they arrived.
pub(crate) struct Poster {
    pub(crate) png: String,
    pub(crate) tick: u64,
    /// A still is page data: never hand it out after this tab navigates.
    pub(crate) url: String,
    pub(crate) generation: u64,
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PlacementSlot {
    Pane,
    Deck,
    Popout,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct PlacementLaneKey {
    /// Main-window lanes are shared across chats; each popout window has its
    /// own, whatever tasks it holds.
    popout_window: Option<String>,
    slot: PlacementSlot,
    /// The deck shows every card's page at once, so each card is its own lane
    /// rather than competing for one rectangle. Pane and popout are `None`.
    deck_tab: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct PlacementOrder {
    session: u64,
    revision: u64,
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
/// caller owns it or has been granted it — or when it is popped out inside the
/// caller's own group.
#[derive(Clone, Debug)]
pub struct Caller {
    pub task_id: String,
    /// Set when the caller is a delegated child rather than the orchestrator.
    pub delegation_id: Option<String>,
    /// The task's group (its project, or the one Chat group). Children carry
    /// the parent task's group, so they inherit its shared tabs.
    pub group_id: String,
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

/// How long after an agent's last action the tab still reads as theirs. When
/// the Settings lock is on, a recent real keystroke uses the same window.
pub(crate) const HOLD_TTL: Duration = Duration::from_secs(45);

/// A close click shortly after an agent action minimizes the tab instead of
/// destroying work the person may still want to inspect. This is deliberately
/// longer than the collision-prevention hold, but remains a recent-use window.
pub(crate) const AGENT_CLOSE_PROTECTION_TTL: Duration = Duration::from_secs(5 * 60);

/// The holder a tab reports while the person is working in it.
pub(crate) const USER_HOLDER: &str = "you";

/// How long a filled password keeps a tab closed to reading, if the page never
/// navigates. Long enough for a slow sign-in, short enough that a tab left on a
/// form does not stay unreadable for the session.
pub(crate) const CREDENTIAL_TTL: Duration = Duration::from_secs(300);

/// How many tabs keep a still at once. The deck draws four cards and the pane
/// one, so this is more than is ever painted together; past it the oldest
/// capture is dropped, because a long chat can hold dozens of tabs and a PNG
/// per tab is memory spent on pictures nothing is going to show.
pub(crate) const POSTER_LIMIT: usize = 8;

/// The largest still worth keeping, in base64 characters. Captures are scaled
/// down before they are encoded, so anything past this is a pathological page
/// rather than a card-sized picture — and a poster is a nicety, never worth
/// that much resident memory.
pub(crate) const MAX_POSTER_BYTES: usize = 512 * 1024;

pub struct BrowserTabs {
    pub(crate) tabs: Mutex<HashMap<String, Tab>>,
    pub(crate) sequence: AtomicU64,
    /// Proves to the guest that a call came from the app. Written into the
    /// prelude, which the guest reads and deletes before any page script runs,
    /// so neither a page nor an agent's `evaluate` can reach the entry points
    /// that touch a saved password. Fresh every launch.
    host_key: String,
    /// Orders stills against each other, so eviction goes by arrival rather
    /// than by a clock two captures in the same instant would share.
    poster_clock: AtomicU64,
    /// Latest renderer owner of each native rectangle. A slow wake from the
    /// chat being left may finish after the next chat has claimed that slot;
    /// the older request must then stay parked rather than leak across chats.
    placement_orders: Mutex<HashMap<PlacementLaneKey, PlacementOrder>>,
    /// Fixed for this app process. A settings change is applied after restart,
    /// so old and new tabs can never silently use different identity scopes.
    identity_scope: super::BrowserIdentityScope,
    /// Serializes profile merges and scope-setting writes. A second confirm
    /// cannot race the rollback snapshot from the first.
    pub(crate) identity_change: Mutex<()>,
    /// Each task's group, resolved once from the store. Cleared by
    /// `groups::invalidate_groups` when a project changes.
    pub(crate) groups: GroupCache,
    /// Pop-out window labels, most recently focused first. Decides where a tab
    /// goes when it is popped out without a named window, and the order the
    /// drag hit-test tries windows in (Tauri has no z-order to ask for).
    popout_focus: Mutex<Vec<String>>,
}

impl Default for BrowserTabs {
    fn default() -> Self {
        Self {
            tabs: Mutex::default(),
            sequence: AtomicU64::default(),
            host_key: uuid::Uuid::new_v4().to_string(),
            poster_clock: AtomicU64::default(),
            placement_orders: Mutex::default(),
            identity_scope: super::BrowserIdentityScope::Task,
            identity_change: Mutex::default(),
            groups: Mutex::default(),
            popout_focus: Mutex::default(),
        }
    }
}

impl BrowserTabs {
    #[cfg(test)]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_identity_scope(identity_scope: super::BrowserIdentityScope) -> Self {
        Self {
            identity_scope,
            ..Self::default()
        }
    }

    pub(crate) const fn identity_scope(&self) -> super::BrowserIdentityScope {
        self.identity_scope
    }

    pub(crate) fn snapshot(&self, task_id: Option<&str>) -> Vec<BrowserTab> {
        self.snapshot_held(task_id, false)
    }

    /// Same as `snapshot`, and when `user_hold` is on a recent real keystroke
    /// is reported as an exclusive hold — the Settings lock.
    pub(crate) fn snapshot_held(&self, task_id: Option<&str>, user_hold: bool) -> Vec<BrowserTab> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let mut list: Vec<BrowserTab> = tabs
            .values()
            .filter(|tab| task_id.is_none_or(|task| tab.state.task_id == task))
            .map(|tab| self.decorated(tab, user_hold))
            .collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    /// One tab as a snapshot reports it: hold and protection read fresh, and
    /// the group name taken from the cache.
    fn decorated(&self, tab: &Tab, user_hold: bool) -> BrowserTab {
        let mut state = tab.state.clone();
        state.held_by = holder_of(tab, user_hold);
        state.agent_protected_until = agent_protected_until(tab);
        // A re-registered project renames its pill without touching each
        // tab: the cached name wins over the one recorded at open.
        if let Some(name) = self.cached_group_name(&state.task_id) {
            state.group_name = name;
        }
        state
    }

    /// The tabs in one pop-out window, in strip order: by `order`, then by
    /// creation for tabs that share one (`tab-10` after `tab-9`).
    pub(crate) fn snapshot_window(&self, label: &str) -> Vec<BrowserTab> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let mut list: Vec<(u32, u64, BrowserTab)> = tabs
            .values()
            .filter(|tab| tab.window.as_deref() == Some(label))
            .map(|tab| {
                (
                    tab.order,
                    tab_sequence(&tab.state.id),
                    self.decorated(tab, false),
                )
            })
            .collect();
        list.sort_by_key(|(order, sequence, _)| (*order, *sequence));
        list.into_iter().map(|(_, _, tab)| tab).collect()
    }

    /// The pop-out window this tab is in, if it is popped out.
    pub(crate) fn window_of(&self, id: &str) -> Option<String> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.get(id).and_then(|tab| tab.window.clone())
    }

    /// Whether any tab of this task lives in that window — what lets the
    /// window's renderer address the task.
    pub(crate) fn window_holds_task(&self, label: &str, task_id: &str) -> bool {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.values()
            .any(|tab| tab.window.as_deref() == Some(label) && tab.state.task_id == task_id)
    }

    /// Whether the window holds anything at all.
    pub(crate) fn window_is_empty(&self, label: &str) -> bool {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        !tabs
            .values()
            .any(|tab| tab.window.as_deref() == Some(label))
    }

    /// Puts a tab in a pop-out window (or back in main with `None`), keeping
    /// `popped_out` in step. `order` places it in the window's strip; absent,
    /// it goes on the end. Docking clears the order.
    pub(crate) fn set_window(
        &self,
        id: &str,
        window: Option<&str>,
        order: Option<u32>,
    ) -> Option<BrowserTab> {
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let order = match window {
            Some(label) => order.unwrap_or_else(|| next_order_in(&tabs, label)),
            None => 0,
        };
        let tab = tabs.get_mut(id)?;
        tab.window = window.map(str::to_owned);
        tab.order = order;
        tab.state.popped_out = window.is_some();
        Some(tab.state.clone())
    }

    /// The order a tab appended to this window would take — what
    /// `set_window` gives one when no order is asked for.
    #[cfg(test)]
    pub(crate) fn next_order(&self, label: &str) -> u32 {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        next_order_in(&tabs, label)
    }

    /// Rewrites the strip order of one window: the listed tabs take 0, 1, 2…
    /// in the order given, and any tab of the window not listed follows them
    /// in its old order. False, and nothing changes, if a listed tab is not in
    /// that window.
    pub(crate) fn reorder_window(&self, label: &str, ids: &[String]) -> bool {
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        if ids.iter().any(|id| {
            tabs.get(id)
                .is_none_or(|tab| tab.window.as_deref() != Some(label))
        }) {
            return false;
        }
        let mut rest: Vec<(u32, u64, String)> = tabs
            .values()
            .filter(|tab| tab.window.as_deref() == Some(label) && !ids.contains(&tab.state.id))
            .map(|tab| (tab.order, tab_sequence(&tab.state.id), tab.state.id.clone()))
            .collect();
        rest.sort();
        let ordered = ids
            .iter()
            .cloned()
            .chain(rest.into_iter().map(|(_, _, id)| id));
        for (index, id) in ordered.enumerate() {
            if let Some(tab) = tabs.get_mut(&id) {
                tab.order = u32::try_from(index).unwrap_or(u32::MAX);
            }
        }
        true
    }

    /// Records that a pop-out window just came to the front.
    pub(crate) fn note_window_focus(&self, label: &str) {
        let mut focus = self
            .popout_focus
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        focus.retain(|known| known != label);
        focus.insert(0, label.to_string());
    }

    /// Drops a window that no longer exists from the focus order.
    pub(crate) fn forget_window(&self, label: &str) {
        let mut focus = self
            .popout_focus
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        focus.retain(|known| known != label);
    }

    /// Pop-out window labels, most recently focused first.
    pub(crate) fn windows_by_focus(&self) -> Vec<String> {
        self.popout_focus
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    /// Where a tab of this group goes when popped out without a named window:
    /// the most recently focused window already holding one of the group's
    /// tabs, else the most recently focused window, else nowhere (open one).
    pub(crate) fn preferred_window_for(&self, group_id: &str) -> Option<String> {
        let focus = self.windows_by_focus();
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        focus
            .iter()
            .find(|label| {
                tabs.values().any(|tab| {
                    tab.window.as_deref() == Some(label.as_str()) && tab.state.group_id == group_id
                })
            })
            .or_else(|| focus.first())
            .cloned()
    }

    /// Every tab this caller may address: the task's own, minus the ones a
    /// sibling child opened, plus anything granted to it, plus the tabs other
    /// tasks in the same group have popped out.
    pub(crate) fn visible_to(&self, caller: &Caller, user_hold: bool) -> Vec<BrowserTab> {
        self.snapshot_held(None, user_hold)
            .into_iter()
            .filter(|tab| self.reach(&tab.id, caller).is_some())
            .collect()
    }

    /// What this caller may do with one tab, or `None` if it cannot see it.
    pub(crate) fn reach(&self, id: &str, caller: &Caller) -> Option<GrantMode> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let tab = tabs.get(id)?;
        if tab.state.task_id != caller.task_id {
            // Popping out shares a tab with the whole group; anything else in
            // another task is invisible.
            return (tab.state.popped_out && tab.state.group_id == caller.group_id)
                .then_some(GrantMode::Drive);
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

    /// `mark_held` for a broker caller, remembering which task it drove from.
    pub(crate) fn mark_held_by(&self, id: &str, caller: &Caller) {
        self.mark_held(id, &caller.label());
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(tab) = tabs.get_mut(id) {
            tab.held_task = Some(caller.task_id.clone());
        }
    }

    /// Who is driving this tab right now and from which task, if anyone.
    pub(crate) fn holder(&self, id: &str, user_hold: bool) -> Option<(String, Option<String>)> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let tab = tabs.get(id)?;
        let who = holder_of(tab, user_hold)?;
        let task = (who != USER_HOLDER)
            .then(|| tab.held_task.clone())
            .flatten();
        Some((who, task))
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
    /// `user_hold` is the Settings lock: off, a person in the tab is not an
    /// exclusive holder.
    pub(crate) fn held_by_other(&self, id: &str, asker: &str, user_hold: bool) -> Option<String> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        holder_of(tabs.get(id)?, user_hold).filter(|who| who != asker)
    }

    /// Whether a renderer close request must preserve this tab in the compact
    /// deck. Only broker-driven agent activity sets `held`; a person's own tab
    /// remains immediately closable.
    pub(crate) fn agent_recently_used(&self, id: &str) -> bool {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.get(id).is_some_and(|tab| {
            tab.held
                .as_ref()
                .is_some_and(|(_, at)| at.elapsed() < AGENT_CLOSE_PROTECTION_TTL)
        })
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

    /// This group's loaded tabs that nothing is looking at, oldest touch first —
    /// the order the cap puts them back to sleep in. `None` spans every group,
    /// for the total cap. A parked popped-out tab is as invisible as a parked
    /// pane tab, so it is a candidate; a tab someone drove inside the hold
    /// window is not.
    pub(crate) fn sleepable(&self, group_id: Option<&str>, keep: &str) -> Vec<String> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let mut candidates: Vec<(std::time::Instant, String)> = tabs
            .values()
            .filter(|tab| {
                group_id.is_none_or(|group| tab.state.group_id == group)
                    && tab.state.id != keep
                    // `hidden && !sleeping` is exactly `!on_screen`: the
                    // renderer's placement is the only honest read of that.
                    && !tab.state.sleeping
                    && tab.state.hidden
                    && tab
                        .held
                        .as_ref()
                        .is_none_or(|(_, at)| at.elapsed() > HOLD_TTL)
            })
            .map(|tab| (tab.touched, tab.state.id.clone()))
            .collect();
        candidates.sort_by_key(|(touched, _)| *touched);
        candidates.into_iter().map(|(_, id)| id).collect()
    }

    /// How many loaded tabs this group holds, or every group when `None`.
    pub(crate) fn live_count(&self, group_id: Option<&str>) -> usize {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.values()
            .filter(|tab| {
                !tab.state.sleeping && group_id.is_none_or(|group| tab.state.group_id == group)
            })
            .count()
    }

    /// Whether the renderer is currently giving this tab a rectangle. A parked
    /// tab keeps its full size, so this is the only honest read of "on screen".
    pub(crate) fn on_screen(&self, id: &str) -> bool {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.get(id)
            .is_some_and(|tab| !tab.state.hidden && !tab.state.sleeping)
    }

    /// The visible siblings competing for one rectangle in the same native
    /// host. A pane and compact deck are separate slots and may coexist. In a
    /// pop-out window the peers are the tabs of that same window, whatever
    /// task they belong to; `task_id` only matters in the main window.
    pub(crate) fn visible_peers(
        &self,
        _task_id: &str,
        keep: &str,
        popped_out: bool,
        placement_slot: PlacementSlot,
    ) -> Vec<String> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let window = tabs.get(keep).and_then(|tab| tab.window.clone());
        let mut peers: Vec<String> = tabs
            .values()
            .filter(|tab| {
                tab.state.id != keep
                    && tab.state.popped_out == popped_out
                    && (!popped_out || tab.window == window)
                    && !tab.state.sleeping
                    && !tab.state.hidden
                    && tab.placement_slot == Some(placement_slot)
            })
            .map(|tab| tab.state.id.clone())
            .collect();
        peers.sort();
        peers
    }

    /// Reports whether this actually moved the tab, so a caller can tell a slot
    /// change from the stream of geometry updates a pane drag produces.
    pub(crate) fn set_placement(&self, id: &str, placement_slot: Option<PlacementSlot>) -> bool {
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        match tabs.get_mut(id) {
            Some(tab) => {
                let moved = tab.placement_slot != placement_slot;
                tab.state.hidden = placement_slot.is_none();
                tab.placement_slot = placement_slot;
                moved
            }
            None => false,
        }
    }

    /// The visible tabs holding one slot of the main window. `visible_peers`
    /// answers the same question for everyone *but* one tab; this one includes
    /// it, because raising the deck has to raise the card that just arrived.
    pub(crate) fn visible_in_slot(&self, task_id: &str, slot: PlacementSlot) -> Vec<String> {
        self.visible_peers(task_id, "", false, slot)
    }

    /// The lane a placement request competes in. In a pop-out window it is
    /// the tab's window, so two windows never invalidate each other; a
    /// popped-out request for a tab the registry does not have in a window
    /// gets a lane of its own rather than the main one.
    fn placement_lane(
        &self,
        tab_id: &str,
        popped_out: bool,
        slot: PlacementSlot,
    ) -> PlacementLaneKey {
        PlacementLaneKey {
            popout_window: popped_out.then(|| self.window_of(tab_id).unwrap_or_default()),
            slot,
            deck_tab: (slot == PlacementSlot::Deck).then(|| tab_id.to_string()),
        }
    }

    /// Claims one native host slot if this renderer request is newer. Main
    /// window claims deliberately span tasks; that is the isolation boundary
    /// that prevents an old chat's pane from reappearing late. Deck lanes are
    /// per tab: every card is on screen together.
    pub(crate) fn claim_placement(
        &self,
        _task_id: &str,
        tab_id: &str,
        popped_out: bool,
        slot: PlacementSlot,
        session: u64,
        revision: u64,
    ) -> bool {
        let key = self.placement_lane(tab_id, popped_out, slot);
        let incoming = PlacementOrder { session, revision };
        let mut orders = self
            .placement_orders
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if orders.get(&key).is_some_and(|current| *current >= incoming) {
            return false;
        }
        orders.insert(key, incoming);
        true
    }

    /// Re-checks ownership after an await such as waking a sleeping webview.
    pub(crate) fn placement_is_current(
        &self,
        _task_id: &str,
        tab_id: &str,
        popped_out: bool,
        slot: PlacementSlot,
        session: u64,
        revision: u64,
    ) -> bool {
        let key = self.placement_lane(tab_id, popped_out, slot);
        let expected = PlacementOrder { session, revision };
        let orders = self
            .placement_orders
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        orders.get(&key).is_some_and(|current| *current == expected)
    }

    /// Remembers a still of this page and evicts the oldest once the cache is
    /// over its limit. Nothing here is written to disk: a poster is a paint,
    /// not a record, and it dies with the session.
    pub(crate) fn set_poster(&self, id: &str, png: String) -> bool {
        if png.is_empty() || png.len() > MAX_POSTER_BYTES {
            return false;
        }
        let tick = self.poster_clock.fetch_add(1, Ordering::Relaxed);
        let mut tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        let Some(tab) = tabs.get_mut(id) else {
            return false;
        };
        tab.poster = Some(Poster {
            png,
            tick,
            url: tab.state.url.clone(),
            generation: tab.generation,
        });
        let mut held: Vec<(u64, String)> = tabs
            .values()
            .filter_map(|tab| {
                tab.poster
                    .as_ref()
                    .map(|poster| (poster.tick, tab.state.id.clone()))
            })
            .collect();
        if held.len() > POSTER_LIMIT {
            held.sort_by_key(|(tick, _)| *tick);
            let stale = held.len() - POSTER_LIMIT;
            for (_, evicted) in held.iter().take(stale) {
                if let Some(tab) = tabs.get_mut(evicted) {
                    tab.poster = None;
                }
            }
        }
        true
    }

    /// This tab's last still, if one was taken and has not been evicted.
    pub(crate) fn poster(&self, id: &str) -> Option<String> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.get(id).and_then(|tab| {
            tab.poster
                .as_ref()
                .filter(|poster| {
                    !tab.state.loading
                        && poster.url == tab.state.url
                        && poster.generation == tab.generation
                })
                .map(|poster| poster.png.clone())
        })
    }

    pub(crate) fn label_for(&self, id: &str) -> Option<String> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.get(id).map(|tab| tab.label.clone())
    }

    /// One tab's state as the renderer would see it, if it is still open.
    pub(crate) fn tab(&self, id: &str) -> Option<BrowserTab> {
        let tabs = self.tabs.lock().unwrap_or_else(|error| error.into_inner());
        tabs.get(id).map(|tab| tab.state.clone())
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

/// The numeric part of a `tab-N` id, so a strip orders by creation and not by
/// string (`tab-10` after `tab-9`).
pub(crate) fn tab_sequence(id: &str) -> u64 {
    id.rsplit('-')
        .next()
        .and_then(|part| part.parse().ok())
        .unwrap_or(u64::MAX)
}

fn next_order_in(tabs: &HashMap<String, Tab>, label: &str) -> u32 {
    tabs.values()
        .filter(|tab| tab.window.as_deref() == Some(label))
        .map(|tab| tab.order.saturating_add(1))
        .max()
        .unwrap_or(0)
}

/// Who has this tab right now, if anyone. A hold is reported only while it is
/// fresh, so nothing has to remember to release one when a run ends or an agent
/// dies. When `user_hold` is on, the person outranks an agent: if they have
/// touched the page inside the window, it is theirs even if an agent was
/// mid-flow. Off (the default) they share the page.
pub(crate) fn holder_of(tab: &Tab, user_hold: bool) -> Option<String> {
    if user_hold && tab.user_at.is_some_and(|at| at.elapsed() < HOLD_TTL) {
        return Some(USER_HOLDER.to_string());
    }
    tab.held
        .as_ref()
        .filter(|(_, at)| at.elapsed() < HOLD_TTL)
        .map(|(who, _)| who.clone())
}

fn agent_protected_until(tab: &Tab) -> Option<u64> {
    let (_, at) = tab.held.as_ref()?;
    let remaining = AGENT_CLOSE_PROTECTION_TTL.checked_sub(at.elapsed())?;
    let deadline = SystemTime::now().checked_add(remaining)?;
    u64::try_from(deadline.duration_since(UNIX_EPOCH).ok()?.as_millis()).ok()
}

/// Notes the person's last touch from a guest reply, so a lock-on snapshot
/// can report `heldBy: "you"` from the same clock the guest uses.
pub(crate) fn note_user_activity(tabs: &BrowserTabs, tab_id: &str, reply: &Value) {
    if let Some(idle) = reply.get("userIdleMs").and_then(Value::as_u64) {
        tabs.mark_user_active(tab_id, idle);
    }
}
