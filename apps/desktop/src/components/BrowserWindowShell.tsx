import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Minus, Plus, X } from "lucide-react";
import { AnimatePresence, m as motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { bridge, type BrowserDragHit, type BrowserTab } from "../bridge";
import { browserTabNeedsAgentProtection } from "../browserClosePolicy";
import type { HitTarget } from "../browserTabDrag";
import { useTabDrag, type TabDragHandlers } from "../useTabDrag";
import { poppedOutComposerHost } from "../composerCapture";
import { initializeTheme, normalizeThemePreferences, setThemePreferences } from "../theme";
import { type BrowserHost, useBrowserTabs } from "../useBrowserTabs";
import { BROWSER_SETTINGS } from "./BrowserSettings";
import { BrowserSurface } from "./BrowserSurface";
import {
  groupTabs,
  nextActiveAfterCollapse,
  truncateGroupName,
  visibleTabs,
  type StripGroup,
} from "./browserWindowGroups";
import {
  cycledTabId,
  jumpedTabId,
  nextPoppedTabId,
  tabLabel,
  taskIdForNewTab,
} from "./browserWindowTabs";
import { TabFavicon } from "./TabFavicon";
import { Tooltip } from "./Tooltip";
import { TravelingSelection } from "./TravelingSelection";
import "./browserWindow.css";

const NO_TABS: BrowserTab[] = [];
/** How many closed tabs Ctrl+Shift+T can bring back this session. */
const CLOSED_RING = 10;

/** The strip's enter/exit motion: a tab grows in from its leading edge. */
const tabSpring = { type: "spring" as const, stiffness: 540, damping: 38, mass: 0.7 };

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function collapsedStorageKey(scope: string): string {
  return `integrator.popout.collapsed.${scope}`;
}

function readCollapsed(scope: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.sessionStorage.getItem(collapsedStorageKey(scope));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(scope: string, collapsed: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(collapsedStorageKey(scope), JSON.stringify([...collapsed]));
  } catch {
    // Session storage is a convenience; the strip works without it.
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Where a strip tooltip is drawn. The strip sits above a native page that
 *  covers any HTML bubble under it, so while a live tab is in front the guest
 *  draws the bubble in its own layer (`hostTooltip`); with nothing live to
 *  cover it, the ordinary bubble does. */
interface TooltipHost {
  taskId: string;
  tabId: string;
}

interface StripTooltipProps {
  label: string;
  hint?: string;
  host: TooltipHost | null;
  children: ReactElement;
}

function StripTooltip({ label, hint, host, children }: StripTooltipProps) {
  const onOpenChange = useCallback(
    (open: boolean, anchor?: DOMRect, shown?: ReactNode) => {
      const api = bridge.browser;
      if (!host || !api) return;
      if (!open || !anchor || typeof shown !== "string") {
        void api.invoke(host.taskId, host.tabId, "hostTooltip", [null]).catch(() => undefined);
        return;
      }
      void api
        .invoke(host.taskId, host.tabId, "hostTooltip", [
          { label: shown, hint, x: anchor.left + anchor.width / 2 },
        ])
        .catch(() => undefined);
    },
    [hint, host],
  );
  return (
    <Tooltip
      label={label}
      hint={hint}
      placement="bottom"
      renderBubble={host === null}
      onOpenChange={host ? onOpenChange : undefined}
    >
      {children}
    </Tooltip>
  );
}

/**
 * The pop-out browser window.
 *
 * Same chrome as the pane — address, history, annotate, capture, dock — around
 * the same native tabs, so popping a page out changes where it lives and
 * nothing else. Several tabs share the window with a strip across the top,
 * which is what makes it a browser window rather than a detached page.
 *
 * The strip is grouped: every tab sits under a coloured pill named for its
 * group — the task's project, or the one Chat group — and a pill collapses its
 * tabs away. Two kinds of window run this shell. A task's window (`?taskId=`)
 * shows that task's popped-out tabs. The chat window (`?scope=chat`) is shared
 * by every chat, so its strip mixes tabs from several tasks; the native side
 * decides which tabs belong to the calling window and this shell just lists
 * them. Closing the window docks them all back; that lives in the native side,
 * so it holds even if this renderer never gets the chance.
 */
export function BrowserWindowShell() {
  const [allowExternalOpen, setAllowExternalOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState("Browser");
  const [taskTitles, setTaskTitles] = useState<ReadonlyMap<string, string>>(() => new Map());
  const query = useMemo(
    () =>
      typeof window === "undefined"
        ? new URLSearchParams()
        : new URLSearchParams(window.location.search),
    [],
  );
  const urlTaskId = query.get("taskId");
  const chatScope = query.get("scope") === "chat";
  // A window is a bag of tabs from any groups; its label is its identity.
  // The older `taskId`/`scope` queries still boot the shell for the fallback list.
  const windowLabel = query.get("window");
  const storageScope = windowLabel ?? (chatScope ? "chat" : (urlTaskId ?? "task"));
  const host = useMemo<BrowserHost>(
    () =>
      poppedOutComposerHost(async (file, name, chatTaskId) =>
        bridge.savePastedImageAttachment?.(file, name, chatTaskId),
      ),
    [],
  );

  const [tabs, setTabs] = useState<BrowserTab[]>(NO_TABS);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(storageScope));
  const previousTabIds = useRef<Set<string>>(new Set());
  const lastTaskId = useRef<string | null>(urlTaskId);
  const closedRing = useRef<{ taskId: string; url: string }[]>([]);
  const reduceMotion =
    Boolean(useReducedMotion()) ||
    (typeof document !== "undefined" && document.documentElement.dataset.motion === "none");

  // The strip reads the native side's answer to "which tabs are out here", and
  // re-reads it whenever any tab changes anywhere.
  useEffect(() => {
    const api = bridge.browser;
    if (!api) return;
    let active = true;
    // A native side that predates the cross-task listing still answers the
    // per-task one; a task window can fall back to that so popping out never
    // lands on an empty strip.
    const fallback = (): Promise<BrowserTab[]> =>
      urlTaskId
        ? api.list(urlTaskId).then((all) => all.filter((tab) => tab.poppedOut))
        : Promise.resolve(NO_TABS);
    const refresh = () => {
      void api
        .poppedOutTabs()
        .catch(fallback)
        .then((next) => {
          if (active) setTabs(next);
        })
        .catch(() => undefined);
    };
    refresh();
    let unsubscribe: (() => void) | undefined;
    void api
      .subscribe(refresh)
      .then((stop) => {
        if (active) unsubscribe = stop;
        else stop();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [urlTaskId]);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void bridge
        .listSettings()
        .then((settings) => {
          if (!active) return;
          const savedTheme = settings.find(
            (setting) =>
              setting.key === "appearance.theme" || setting.key === "settings.appearance.theme",
          )?.value;
          if (savedTheme && typeof savedTheme === "object") {
            setThemePreferences(normalizeThemePreferences(savedTheme), { persist: false });
          } else {
            initializeTheme();
          }
          setAllowExternalOpen(
            settings.find(
              (setting) =>
                setting.key === `settings.${BROWSER_SETTINGS.externalOpen}` ||
                setting.key === BROWSER_SETTINGS.externalOpen,
            )?.value === true,
          );
        })
        .catch(() => undefined);
    };
    const refreshCachedTheme = () => initializeTheme();
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refreshCachedTheme);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refreshCachedTheme);
    };
  }, []);

  // Task titles name the window and say whose agent is in a tab. Both kinds of
  // window need them: the chat window's strip mixes chats.
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void bridge
        .loadWorkspace()
        .then((workspace) => {
          if (!active) return;
          const titles = new Map<string, string>();
          for (const task of workspace.tasks) titles.set(task.id, task.title);
          setTaskTitles(titles);
          if (urlTaskId) setTaskTitle(titles.get(urlTaskId) || "Browser");
        })
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [urlTaskId]);

  useEffect(() => {
    const previous = previousTabIds.current;
    previousTabIds.current = new Set(tabs.map((tab) => tab.id));
    setActiveId((current) => nextPoppedTabId(current, previous, tabs));
  }, [tabs]);

  const groups = useMemo(() => groupTabs(tabs, collapsed, activeId), [tabs, collapsed, activeId]);
  const visible = useMemo(() => visibleTabs(groups), [groups]);
  // Read once per tab change, as the pane does; the native close is the
  // source of truth and answers `false` if the deadline has not passed.
  const protectedIds = useMemo(
    () => new Set(tabs.filter((tab) => browserTabNeedsAgentProtection(tab)).map((tab) => tab.id)),
    [tabs],
  );

  const toggleGroup = useCallback(
    (groupId: string) => {
      setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(groupId)) next.delete(groupId);
        else next.add(groupId);
        writeCollapsed(storageScope, next);
        // Collapsing the group in front moves the selection to a neighbour;
        // the tab keeps running, parked, like every other tab not in front.
        if (!current.has(groupId)) {
          const after = groupTabs(tabs, next, activeId);
          const owner = after.find((group) => group.id === groupId);
          if (owner?.activeHidden) {
            const target = nextActiveAfterCollapse(activeId, after);
            if (target) setActiveId(target);
          }
        }
        return next;
      });
    },
    [activeId, storageScope, tabs],
  );

  // An agent asking to be watched. A popped tab is not the work pane's to
  // show, so this window answers for its own strip — without it, an agent
  // could never bring a popped page forward, and a screenshot of one came back
  // as a picture of whatever was covering this window. A collapsed group stays
  // collapsed: the tab comes to the front, the pill lights up, and the person
  // decides whether to expand.
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  });
  useEffect(() => {
    const api = bridge.browser;
    if (!api?.onFocusRequest) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void api
      .onFocusRequest((request) => {
        if (!active) return;
        if (!tabsRef.current.some((tab) => tab.id === request.tabId)) return;
        setActiveId(request.tabId);
        void getCurrentWindow()
          .setFocus()
          .catch(() => undefined);
      })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const activeTaskId = active?.taskId ?? null;
  useEffect(() => {
    if (activeTaskId) lastTaskId.current = activeTaskId;
  }, [activeTaskId]);
  const activeGroup = groups.find((group) => group.tabs.some((tab) => tab.id === activeId));
  // The guest can only draw a tooltip while it is awake and in front.
  const tooltipHost: TooltipHost | null =
    active && !active.sleeping && !activeGroup?.collapsed
      ? { taskId: active.taskId, tabId: active.id }
      : null;

  // A task window is named for its task; the chat window, holding several
  // chats' pages, is named for whichever page is in front.
  const windowTitle =
    chatScope || windowLabel
      ? active
        ? `${tabLabel(active)} — Integrator Browser`
        : "Integrator Browser"
      : `${taskTitle} — Integrator Browser`;
  useEffect(() => {
    document.title = windowTitle;
    void getCurrentWindow()
      .setTitle(windowTitle)
      .catch(() => undefined);
  }, [windowTitle]);

  const dock = useCallback(
    (tab: BrowserTab) => void bridge.browser?.setPoppedOut(tab.taskId, tab.id, false),
    [],
  );
  const closeTab = useCallback(async (tab: BrowserTab) => {
    const api = bridge.browser;
    if (!api) return;
    // `false` means the native side kept the tab for recent agent work; the
    // tooltip already said so, and there is nothing to reopen.
    const closed = await api.close(tab.taskId, tab.id).catch(() => false);
    if (closed && tab.url && !/^about:/.test(tab.url)) {
      closedRing.current = [...closedRing.current, { taskId: tab.taskId, url: tab.url }].slice(
        -CLOSED_RING,
      );
    }
  }, []);
  const addTab = useCallback(async () => {
    const api = bridge.browser;
    const taskId = taskIdForNewTab(activeTaskId, lastTaskId.current, urlTaskId);
    if (!api || !taskId) return;
    const tab = await api.open(taskId);
    if (windowLabel) await api.moveTab(taskId, tab.id, { kind: "window", label: windowLabel });
    else await api.setPoppedOut(taskId, tab.id, true);
  }, [activeTaskId, urlTaskId, windowLabel]);
  const reopenClosed = useCallback(async () => {
    const api = bridge.browser;
    if (!api) return;
    while (closedRing.current.length > 0) {
      const last = closedRing.current[closedRing.current.length - 1];
      closedRing.current = closedRing.current.slice(0, -1);
      try {
        const tab = await api.open(last.taskId, last.url);
        if (windowLabel) {
          await api.moveTab(last.taskId, tab.id, { kind: "window", label: windowLabel });
        } else {
          await api.setPoppedOut(last.taskId, tab.id, true);
        }
        return;
      } catch {
        // The task may be gone; try the one before it.
      }
    }
  }, [windowLabel]);

  // Browser shortcuts: the strip is keyboard-driven the way any browser's is,
  // as long as the keys are not on their way into a text field. Cycling and
  // digits walk the visible tabs — a collapsed group is skipped, as in Chrome.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      if (isTypingTarget(event.target)) return;
      const key = event.key;
      if (key === "t" || key === "T") {
        event.preventDefault();
        if (event.shiftKey) void reopenClosed();
        else void addTab();
        return;
      }
      if (key === "w" || key === "W") {
        event.preventDefault();
        if (active) void closeTab(active);
        return;
      }
      if (key === "Tab") {
        event.preventDefault();
        const next = cycledTabId(activeId, visible, event.shiftKey ? -1 : 1);
        if (next) setActiveId(next);
        return;
      }
      if (/^[1-9]$/.test(key)) {
        const target = jumpedTabId(Number(key), visible);
        if (target) {
          event.preventDefault();
          setActiveId(target);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible, activeId, active, addTab, closeTab, reopenClosed]);

  // Dragging: reorder inside a group, tear off into a new window, or carry a
  // tab to another window or back to the pane. The machine lives in
  // useTabDrag; this window only says what each drop means.
  const stripRef = useRef<HTMLDivElement>(null);
  const [dropOver, setDropOver] = useState(false);
  useEffect(() => {
    const api = bridge.browser;
    if (!api?.onDragOver || !api.onDragLeave) return;
    let active = true;
    const stops: (() => void)[] = [];
    void api
      .onDragOver(() => {
        if (active) setDropOver(true);
      })
      .then((stop) => (active ? stops.push(stop) : stop()))
      .catch(() => undefined);
    void api
      .onDragLeave(() => {
        if (active) setDropOver(false);
      })
      .then((stop) => (active ? stops.push(stop) : stop()))
      .catch(() => undefined);
    return () => {
      active = false;
      for (const stop of stops) stop();
    };
  }, []);
  const groupSpanFor = useCallback(
    (tabId: string): [number, number] => {
      let start = 0;
      for (const group of groups) {
        if (group.collapsed) continue;
        const end = start + group.tabs.length - 1;
        if (group.tabs.some((tab) => tab.id === tabId)) return [start, end];
        start = end + 1;
      }
      return [0, Math.max(0, visible.length - 1)];
    },
    [groups, visible],
  );
  const dragApi = bridge.browser;
  const drag = useTabDrag({
    origin: { kind: "popout", label: windowLabel ?? storageScope },
    tabs: visible.map((tab) => ({
      id: tab.id,
      taskId: tab.taskId,
      groupId: tab.groupId,
      title: tabLabel(tab),
      favicon: tab.favicon,
    })),
    stripRef,
    groupSpanFor,
    hitTest: dragApi?.dragHitTest
      ? async (x, y): Promise<HitTarget> => {
          const hit: BrowserDragHit = await dragApi.dragHitTest(x, y);
          if (!hit.target) return null;
          if (hit.target === "main") return { kind: "main" };
          if (hit.target === windowLabel) return null;
          return { kind: "popout", label: hit.target, strip: hit.strip };
        }
      : undefined,
    dragEnd: dragApi?.dragEnd ? () => dragApi.dragEnd() : undefined,
    onReorder: (from, to) => {
      if (!dragApi?.reorderWindow || from === to) return;
      // Move within the visible list, then hand native the whole window
      // group by group, so a folded group keeps its place in the strip.
      const moved = [...visible];
      const [item] = moved.splice(from, 1);
      moved.splice(to, 0, item);
      const order: string[] = [];
      let cursor = 0;
      for (const group of groups) {
        if (group.collapsed) {
          order.push(...group.tabs.map((tab) => tab.id));
          continue;
        }
        order.push(...moved.slice(cursor, cursor + group.tabs.length).map((tab) => tab.id));
        cursor += group.tabs.length;
      }
      void dragApi.reorderWindow(order).catch(() => undefined);
    },
    onMove: (tabId, taskId, label, index) => {
      void dragApi?.moveTab(taskId, tabId, { kind: "window", label, index }).catch(() => undefined);
    },
    onDock: (tabId, taskId) => {
      void dragApi?.moveTab(taskId, tabId, { kind: "main" }).catch(() => undefined);
    },
    onTearOff: (tabId, taskId, at) => {
      // The last tab in a window has nowhere better to be.
      if (visible.length < 2) return;
      void dragApi?.moveTab(taskId, tabId, { kind: "window", at }).catch(() => undefined);
    },
  });
  const visibleIndex = new Map(visible.map((tab, index) => [tab.id, index]));

  const windowHandle = getCurrentWindow();
  const layoutKey = groups
    .map(
      (group) => `${group.id}:${group.collapsed ? "" : group.tabs.map((tab) => tab.id).join(",")}`,
    )
    .join("|");

  return (
    <div className="browser-window" data-tauri-drag-region>
      <header className="browser-window-strip" data-tauri-drag-region>
        <div
          className="browser-window-tabs"
          role="tablist"
          aria-label="Popped out browser tabs"
          ref={stripRef}
          data-drop-target={dropOver ? "true" : undefined}
        >
          {/* The work pane's strip and this one are the same object in two
              frames, so the selection reads the same way here: outlines on
              every tab, one travelling fill in the sidebar's colour. */}
          <TravelingSelection
            activeKey={activeGroup?.activeHidden ? "" : (activeId ?? "")}
            className="tab-strip-selection"
            clampWidth={false}
            pace="quick"
            layoutKey={layoutKey}
          />
          <AnimatePresence initial={false}>
            {groups.flatMap((group) => [
              <GroupPill
                key={`pill:${group.id}`}
                group={group}
                tooltipHost={tooltipHost}
                reduceMotion={reduceMotion}
                onToggle={toggleGroup}
              />,
              ...(group.collapsed
                ? []
                : group.tabs.map((tab) => (
                    <StripTab
                      key={tab.id}
                      tab={tab}
                      group={group}
                      active={tab.id === activeId}
                      preservesAgentWork={protectedIds.has(tab.id)}
                      driver={
                        tab.heldBy && tab.heldBy !== "you"
                          ? `${tab.heldBy} is working here — ${
                              taskTitles.get(tab.taskId) ?? "another chat"
                            }`
                          : null
                      }
                      tooltipHost={tooltipHost}
                      reduceMotion={reduceMotion}
                      dragHandlers={drag.handlersFor(tab.id, visibleIndex.get(tab.id) ?? 0)}
                      dragGap={drag.dragging && drag.hoverIndex === visibleIndex.get(tab.id)}
                      onSelect={() => setActiveId(tab.id)}
                      onDock={() => dock(tab)}
                      onClose={() => void closeTab(tab)}
                    />
                  ))),
            ])}
          </AnimatePresence>
        </div>
        <StripTooltip label="New tab" hint="Ctrl+T" host={tooltipHost}>
          <button
            type="button"
            className="browser-window-new-tab"
            aria-label="New browser tab"
            onClick={() => void addTab()}
          >
            <Plus aria-hidden="true" />
          </button>
        </StripTooltip>
        <div
          className="browser-window-strip-spacer"
          data-tauri-drag-region
          onDoubleClick={() => void windowHandle.toggleMaximize()}
        />
        <div className="browser-window-controls">
          <button
            type="button"
            aria-label="Minimize browser window"
            onClick={() => void windowHandle.minimize()}
          >
            <Minus aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Maximize or restore browser window"
            onClick={() => void windowHandle.toggleMaximize()}
          >
            <Maximize2 aria-hidden="true" />
          </button>
          <button
            type="button"
            className="browser-window-close"
            aria-label="Close browser window"
            onClick={() => void windowHandle.close()}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="browser-window-body">
        {active ? (
          <PoppedTabSurface
            key={active.taskId}
            tab={active}
            host={host}
            allowExternalOpen={allowExternalOpen}
          />
        ) : (
          <div className="browser-window-empty" role="status">
            <span className="browser-window-empty-mark" aria-hidden="true" />
            <strong>Nothing out here yet</strong>
            <small>
              {chatScope
                ? "Pop a page out of any chat and it lands in this window."
                : "Pop a page out of the work pane and it lands in this window."}
            </small>
          </div>
        )}
      </div>
      {drag.ghost}
      {/* Chromeless at the OS level, so the edges are ours to grab. */}
      {RESIZE_EDGES.map((edge) => (
        <div
          key={edge}
          className="browser-window-resize"
          data-edge={edge}
          aria-hidden="true"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            void windowHandle.startResizeDragging(edge).catch(() => undefined);
          }}
        />
      ))}
    </div>
  );
}

const RESIZE_EDGES = [
  "North",
  "South",
  "East",
  "West",
  "NorthEast",
  "NorthWest",
  "SouthEast",
  "SouthWest",
] as const;

interface GroupPillProps {
  group: StripGroup<BrowserTab>;
  tooltipHost: TooltipHost | null;
  reduceMotion: boolean;
  onToggle: (groupId: string) => void;
}

/** One group's name, in its colour. Click folds the group's tabs away and
 *  back; a dot says an agent is working in one of them. */
function GroupPill({ group, tooltipHost, reduceMotion, onToggle }: GroupPillProps) {
  const count = group.tabs.length;
  const tabsWord = count === 1 ? "tab" : "tabs";
  return (
    <StripTooltip
      label={group.name}
      hint={`${count} ${tabsWord} · click to ${group.collapsed ? "expand" : "collapse"}`}
      host={tooltipHost}
    >
      <motion.button
        type="button"
        layout={!reduceMotion}
        className="browser-group-pill"
        data-group-id={group.id}
        data-group-kind={group.kind}
        data-color={group.colorIndex}
        data-collapsed={group.collapsed ? "true" : undefined}
        data-live={group.live ? "true" : undefined}
        data-active-hidden={group.activeHidden ? "true" : undefined}
        aria-pressed={!group.collapsed}
        aria-label={`${group.name}, ${count} ${tabsWord}, ${
          group.collapsed ? "collapsed" : "expanded"
        }`}
        transition={reduceMotion ? { duration: 0 } : tabSpring}
        onClick={() => onToggle(group.id)}
      >
        <span className="browser-group-pill-name">{truncateGroupName(group.name)}</span>
        {group.live ? <span className="browser-group-pill-dot" aria-hidden="true" /> : null}
      </motion.button>
    </StripTooltip>
  );
}

interface StripTabProps {
  tab: BrowserTab;
  group: StripGroup<BrowserTab>;
  active: boolean;
  /** The native side would keep this tab on close for recent agent work. */
  preservesAgentWork: boolean;
  /** "<agent> is working here — <task>" while an agent holds the tab. */
  driver: string | null;
  tooltipHost: TooltipHost | null;
  reduceMotion: boolean;
  dragHandlers: TabDragHandlers;
  /** A dragged tab is about to land in front of this one. */
  dragGap: boolean;
  onSelect: () => void;
  onDock: () => void;
  onClose: () => void;
}

function StripTab({
  tab,
  group,
  active,
  preservesAgentWork,
  driver,
  tooltipHost,
  reduceMotion,
  dragHandlers,
  dragGap,
  onSelect,
  onDock,
  onClose,
}: StripTabProps) {
  const label = tabLabel(tab);
  return (
    <motion.div
      layout={!reduceMotion}
      className="file-reader-tab browser-window-tab"
      data-active={active ? "true" : undefined}
      data-traveling-selection={tab.id}
      data-task-id={tab.taskId}
      data-group-id={group.id}
      data-color={group.colorIndex}
      data-busy={driver ? "true" : undefined}
      data-drag-gap={dragGap ? "before" : undefined}
      {...dragHandlers}
      initial={reduceMotion ? false : { opacity: 0, scaleX: 0.6, flexGrow: 0, minWidth: 0 }}
      animate={{ opacity: 1, scaleX: 1, flexGrow: 1, minWidth: 96 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scaleX: 0.6, flexGrow: 0, minWidth: 0 }}
      transition={reduceMotion ? { duration: 0 } : tabSpring}
      style={{ originX: 0 }}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <StripTooltip
        label={`${group.name} · ${label}`}
        hint={driver ?? hostOf(tab.url)}
        host={tooltipHost}
      >
        <button type="button" role="tab" aria-selected={active} onClick={onSelect}>
          <TabFavicon src={tab.favicon} />
          <span>{label}</span>
        </button>
      </StripTooltip>
      {/* Two verbs, as in the pane: Minus sends the page back to the pane with
          everything still running; X ends it. */}
      <StripTooltip label="Send to the pane" hint="Keeps the page running" host={tooltipHost}>
        <button
          type="button"
          className="file-reader-tab-close browser-window-tab-minimize"
          aria-label={`Send ${label} to the app`}
          onClick={(event) => {
            event.stopPropagation();
            onDock();
          }}
        >
          <Minus aria-hidden="true" />
        </button>
      </StripTooltip>
      <StripTooltip
        label={preservesAgentWork ? "Minimize" : "Close"}
        hint={preservesAgentWork ? "Recent agent work is kept in the compact browser" : "Ctrl+W"}
        host={tooltipHost}
      >
        <button
          type="button"
          className="file-reader-tab-close"
          aria-label={preservesAgentWork ? `Minimize ${label}` : `Close ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <X aria-hidden="true" />
        </button>
      </StripTooltip>
    </motion.div>
  );
}

interface PoppedTabSurfaceProps {
  tab: BrowserTab;
  host: BrowserHost;
  allowExternalOpen: boolean;
}

/**
 * The surface for the tab in front. `useBrowserTabs` observes one task, and
 * the chat window's strip crosses tasks, so the controller lives here — keyed
 * by task in the shell — and a switch between chats mounts a fresh one while a
 * switch within a chat keeps it.
 */
function PoppedTabSurface({ tab, host, allowExternalOpen }: PoppedTabSurfaceProps) {
  const browser = useBrowserTabs(host, {
    taskId: tab.taskId,
    allowExternalOpen,
    poppedOutHost: true,
  });
  const live = browser.byId[tab.id] ?? tab;
  return (
    <BrowserSurface
      key={live.id}
      tab={live}
      poster={browser.posters[live.id]}
      message={browser.message}
      recording={browser.recordingTabId === live.id}
      annotating={browser.annotatingTabId === live.id}
      onBoundsChange={(rect) => browser.setBounds(live.id, rect, "popout")}
      onNavigate={(url) => browser.navigate(live.id, url)}
      onHistory={(action) => browser.history(live.id, action)}
      onScreenshot={() => browser.screenshot(live.id)}
      onRecordToggle={() => browser.toggleRecording(live.id)}
      onAnnotate={() => browser.toggleAnnotate(live.id)}
      onPopOut={() => browser.setPoppedOut(live.id, false)}
      poppedOutHost
      allowExternalOpen={browser.allowExternalOpen}
      onOpenExternally={() => browser.openExternally(live.id)}
      onSaveLogin={() => browser.saveLogin(live.id, live.taskId)}
      onFillLogin={() => browser.fillLogin(live.id, live.taskId)}
      onToolbarTooltip={(tooltip) => browser.setToolbarTooltip(live.id, tooltip)}
      onClose={() => browser.close(live.id)}
    />
  );
}
