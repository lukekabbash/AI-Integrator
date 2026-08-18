import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Minus, Plus, X } from "lucide-react";
import { AnimatePresence, m as motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { bridge, type BrowserTab } from "../bridge";
import { poppedOutComposerHost } from "../composerCapture";
import { initializeTheme, normalizeThemePreferences, setThemePreferences } from "../theme";
import { type BrowserHost, useBrowserTabs } from "../useBrowserTabs";
import { BROWSER_SETTINGS } from "./BrowserSettings";
import { BrowserSurface } from "./BrowserSurface";
import {
  cycledTabId,
  jumpedTabId,
  nextPoppedTabId,
  tabLabel,
  taskIdForNewTab,
} from "./browserWindowTabs";
import { TabFavicon } from "./TabFavicon";
import { TravelingSelection } from "./TravelingSelection";
import "./browserWindow.css";

const NO_TABS: BrowserTab[] = [];

/** The strip's enter/exit motion: a tab grows in from its leading edge. */
const tabSpring = { type: "spring" as const, stiffness: 540, damping: 38, mass: 0.7 };

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * The pop-out browser window.
 *
 * Same chrome as the pane — address, history, annotate, capture, dock — around
 * the same native tabs, so popping a page out changes where it lives and
 * nothing else. Several tabs share the window with a strip across the top,
 * which is what makes it a browser window rather than a detached page.
 *
 * Two kinds of window run this shell. A task's window (`?taskId=`) shows that
 * task's popped-out tabs. The chat window (`?scope=chat`) is shared by every
 * chat, so its strip mixes tabs from several tasks; the native side decides
 * which tabs belong to the calling window and this shell just lists them.
 * Closing the window docks them all back; that lives in the native side, so it
 * holds even if this renderer never gets the chance.
 */
export function BrowserWindowShell() {
  const [allowExternalOpen, setAllowExternalOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState("Browser");
  const query = useMemo(
    () =>
      typeof window === "undefined"
        ? new URLSearchParams()
        : new URLSearchParams(window.location.search),
    [],
  );
  const urlTaskId = query.get("taskId");
  const chatScope = query.get("scope") === "chat";
  const host = useMemo<BrowserHost>(
    () =>
      poppedOutComposerHost(async (file, name, chatTaskId) =>
        bridge.savePastedImageAttachment?.(file, name, chatTaskId),
      ),
    [],
  );

  const [tabs, setTabs] = useState<BrowserTab[]>(NO_TABS);
  const [activeId, setActiveId] = useState<string | null>(null);
  const previousTabIds = useRef<Set<string>>(new Set());
  const lastTaskId = useRef<string | null>(urlTaskId);
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

  useEffect(() => {
    if (chatScope || !urlTaskId) return;
    let active = true;
    const refresh = () => {
      void bridge
        .loadWorkspace()
        .then((workspace) => {
          if (!active) return;
          setTaskTitle(workspace.tasks.find((task) => task.id === urlTaskId)?.title || "Browser");
        })
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [chatScope, urlTaskId]);

  useEffect(() => {
    const previous = previousTabIds.current;
    previousTabIds.current = new Set(tabs.map((tab) => tab.id));
    setActiveId((current) => nextPoppedTabId(current, previous, tabs));
  }, [tabs]);

  // An agent asking to be watched. A popped tab is not the work pane's to
  // show, so this window answers for its own strip — without it, an agent
  // could never bring a popped page forward, and a screenshot of one came back
  // as a picture of whatever was covering this window.
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

  // A task window is named for its task; the chat window, holding several
  // chats' pages, is named for whichever page is in front.
  const windowTitle = chatScope
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
  const closeTab = useCallback(
    (tab: BrowserTab) => void bridge.browser?.close(tab.taskId, tab.id),
    [],
  );
  const addTab = useCallback(async () => {
    const api = bridge.browser;
    const taskId = taskIdForNewTab(activeTaskId, lastTaskId.current, urlTaskId);
    if (!api || !taskId) return;
    const tab = await api.open(taskId);
    await api.setPoppedOut(taskId, tab.id, true);
  }, [activeTaskId, urlTaskId]);

  // Browser shortcuts: the strip is keyboard-driven the way any browser's is,
  // as long as the keys are not on their way into a text field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      if (isTypingTarget(event.target)) return;
      const key = event.key;
      if (key === "t" || key === "T") {
        event.preventDefault();
        void addTab();
        return;
      }
      if (key === "w" || key === "W") {
        event.preventDefault();
        if (active) dock(active);
        return;
      }
      if (key === "Tab") {
        event.preventDefault();
        const next = cycledTabId(activeId, tabs, event.shiftKey ? -1 : 1);
        if (next) setActiveId(next);
        return;
      }
      if (/^[1-9]$/.test(key)) {
        const target = jumpedTabId(Number(key), tabs);
        if (target) {
          event.preventDefault();
          setActiveId(target);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tabs, activeId, active, addTab, dock]);

  const windowHandle = getCurrentWindow();
  const stripLabel = chatScope ? "Chat" : taskTitle;

  return (
    <div className="browser-window" data-tauri-drag-region>
      <header className="browser-window-strip" data-tauri-drag-region>
        <span
          className="browser-window-title"
          data-scope={chatScope ? "chat" : "task"}
          title={stripLabel}
          data-tauri-drag-region
        >
          {stripLabel}
        </span>
        <div
          className="browser-window-tabs"
          role="tablist"
          aria-label="Popped out browser tabs"
          data-tauri-drag-region
        >
          {/* The work pane's strip and this one are the same object in two
              frames, so the selection reads the same way here: outlines on
              every tab, one travelling fill in the sidebar's colour. */}
          <TravelingSelection
            activeKey={activeId ?? ""}
            className="tab-strip-selection"
            clampWidth={false}
            pace="quick"
            layoutKey={tabs.map((tab) => tab.id).join("|")}
          />
          <AnimatePresence initial={false}>
            {tabs.map((tab) => (
              <motion.div
                key={tab.id}
                layout={!reduceMotion}
                className="file-reader-tab browser-window-tab"
                data-active={tab.id === activeId ? "true" : undefined}
                data-traveling-selection={tab.id}
                data-task-id={tab.taskId}
                initial={reduceMotion ? false : { opacity: 0, scaleX: 0.6, flexGrow: 0, minWidth: 0 }}
                animate={{ opacity: 1, scaleX: 1, flexGrow: 1, minWidth: 64 }}
                exit={
                  reduceMotion
                    ? { opacity: 0 }
                    : { opacity: 0, scaleX: 0.6, flexGrow: 0, minWidth: 0 }
                }
                transition={reduceMotion ? { duration: 0 } : tabSpring}
                style={{ originX: 0 }}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    closeTab(tab);
                  }
                }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.id === activeId}
                  onClick={() => setActiveId(tab.id)}
                >
                  <TabFavicon src={tab.favicon} />
                  <span>{tabLabel(tab)}</span>
                </button>
                <button
                  type="button"
                  className="file-reader-tab-close"
                  aria-label={`Return ${tab.title || tab.url} to the app`}
                  title="Return to the app"
                  onClick={() => dock(tab)}
                >
                  <X aria-hidden="true" />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
        <button
          type="button"
          className="browser-window-new-tab"
          aria-label="New browser tab"
          title="New tab (Ctrl+T)"
          onClick={() => void addTab()}
        >
          <Plus aria-hidden="true" />
        </button>
        <div className="browser-window-strip-spacer" data-tauri-drag-region />
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
    </div>
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
