import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Minus, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { bridge } from "../bridge";
import { initializeTheme, normalizeThemePreferences, setThemePreferences } from "../theme";
import { useBrowserTabs } from "../useBrowserTabs";
import { BROWSER_SETTINGS } from "./BrowserSettings";
import { BrowserSurface } from "./BrowserSurface";
import { nextPoppedTabId } from "./browserWindowTabs";
import { TabFavicon } from "./TabFavicon";
import { TravelingSelection } from "./TravelingSelection";
import "./browserWindow.css";

/**
 * The pop-out browser window.
 *
 * Same chrome as the pane — address, history, annotate, capture, dock — around
 * the same native tabs, so popping a page out changes where it lives and
 * nothing else. Several tabs share the window with a strip across the top,
 * which is what makes it a browser window rather than a detached page.
 *
 * It reads the same tab list the main window does, filtered to the tabs that
 * are actually out here. Closing the window docks them all back; that lives in
 * the native side, so it holds even if this renderer never gets the chance.
 */
export function BrowserWindowShell() {
  const [allowExternalOpen, setAllowExternalOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState("Browser");
  const taskId =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("taskId");
  const browser = useBrowserTabs(
    {
      // A capture taken out here has no composer to land in. The native side
      // still writes the file, and the toolbar reports what happened.
      attachImage: async () => undefined,
      insertText: () => undefined,
    },
    { taskId, allowExternalOpen, poppedOutHost: true },
  );
  const tabs = useMemo(() => browser.tabs.filter((tab) => tab.poppedOut), [browser.tabs]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const previousTabIds = useRef<Set<string>>(new Set());

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
    let active = true;
    const refresh = () => {
      if (!taskId) return;
      void bridge
        .loadWorkspace()
        .then((workspace) => {
          if (!active) return;
          const title = workspace.tasks.find((task) => task.id === taskId)?.title || "Browser";
          setTaskTitle(title);
          const windowTitle = `${title} — Integrator Browser`;
          document.title = windowTitle;
          void getCurrentWindow()
            .setTitle(windowTitle)
            .catch(() => undefined);
        })
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [taskId]);

  useEffect(() => {
    const previous = previousTabIds.current;
    previousTabIds.current = new Set(tabs.map((tab) => tab.id));
    setActiveId((current) => nextPoppedTabId(current, previous, tabs));
  }, [tabs]);

  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const dock = useCallback((tabId: string) => void browser.setPoppedOut(tabId, false), [browser]);
  const addTab = useCallback(async () => {
    const tab = await browser.open();
    if (tab) await browser.setPoppedOut(tab.id, true);
  }, [browser]);
  const windowHandle = getCurrentWindow();

  return (
    <div className="browser-window" data-tauri-drag-region>
      <header className="browser-window-strip" data-tauri-drag-region>
        <span className="browser-window-title" title={taskTitle} data-tauri-drag-region>
          {taskTitle}
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
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className="file-reader-tab browser-window-tab"
              data-active={tab.id === activeId ? "true" : undefined}
              data-traveling-selection={tab.id}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === activeId}
                onClick={() => setActiveId(tab.id)}
              >
                <TabFavicon src={tab.favicon} />
                <span>{tab.title || tab.url.replace(/^https?:\/\//, "") || "New tab"}</span>
              </button>
              <button
                type="button"
                className="file-reader-tab-close"
                aria-label={`Return ${tab.title || tab.url} to the app`}
                title="Return to the app"
                onClick={() => dock(tab.id)}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="browser-window-new-tab"
          aria-label="New browser tab"
          title="New tab"
          onClick={() => void addTab()}
        >
          <Plus aria-hidden="true" />
        </button>
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
          <BrowserSurface
            key={active.id}
            tab={active}
            poster={browser.posters[active.id]}
            message={browser.message}
            recording={browser.recordingTabId === active.id}
            annotating={browser.annotatingTabId === active.id}
            onBoundsChange={(rect) => browser.setBounds(active.id, rect, "popout")}
            onNavigate={(url) => browser.navigate(active.id, url)}
            onHistory={(action) => browser.history(active.id, action)}
            onScreenshot={() => browser.screenshot(active.id)}
            onRecordToggle={() => browser.toggleRecording(active.id)}
            onAnnotate={() => browser.toggleAnnotate(active.id)}
            onPopOut={() => browser.setPoppedOut(active.id, false)}
            poppedOutHost
            allowExternalOpen={browser.allowExternalOpen}
            onOpenExternally={() => browser.openExternally(active.id)}
            onSaveLogin={() => browser.saveLogin(active.id, active.taskId)}
            onFillLogin={() => browser.fillLogin(active.id, active.taskId)}
            onToolbarTooltip={(tooltip) => browser.setToolbarTooltip(active.id, tooltip)}
            onClose={() => browser.close(active.id)}
          />
        ) : (
          <div className="browser-window-empty" role="status">
            <strong>No tabs out here</strong>
            <small>Pop a tab out of the work pane and it appears in this window.</small>
          </div>
        )}
      </div>
    </div>
  );
}
