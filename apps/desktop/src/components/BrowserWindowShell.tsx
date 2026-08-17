import { useCallback, useEffect, useMemo, useState } from "react";

import { useBrowserTabs } from "../useBrowserTabs";
import { BrowserSurface } from "./BrowserSurface";
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
  const browser = useBrowserTabs({
    // A capture taken out here has no composer to land in. The native side
    // still writes the file, and the toolbar reports what happened.
    attachImage: async () => undefined,
    insertText: () => undefined,
  });
  const tabs = useMemo(() => browser.tabs.filter((tab) => tab.popped_out), [browser.tabs]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (tabs.length === 0) {
      setActiveId(null);
      return;
    }
    setActiveId((current) =>
      current && tabs.some((tab) => tab.id === current) ? current : tabs[0].id,
    );
  }, [tabs]);

  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const dock = useCallback((tabId: string) => void browser.setPoppedOut(tabId, false), [browser]);

  return (
    <div className="browser-window" data-tauri-drag-region>
      <header className="browser-window-strip" data-tauri-drag-region>
        <div className="browser-window-tabs" data-tauri-drag-region>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className="file-reader-tab browser-window-tab"
              data-active={tab.id === activeId ? "true" : undefined}
            >
              <button type="button" onClick={() => setActiveId(tab.id)}>
                <span>{tab.title || tab.url.replace(/^https?:\/\//, "") || "New tab"}</span>
              </button>
              <button
                type="button"
                className="file-reader-tab-close"
                aria-label={`Dock ${tab.title || tab.url}`}
                title="Send back to the pane"
                onClick={() => dock(tab.id)}
              >
                ⤓
              </button>
            </div>
          ))}
        </div>
      </header>
      <div className="browser-window-body">
        {active ? (
          <BrowserSurface
            key={active.id}
            tab={active}
            message={browser.message}
            recording={browser.recordingTabId === active.id}
            annotating={browser.annotatingTabId === active.id}
            onBoundsChange={(rect) => browser.setBounds(active.id, rect)}
            onNavigate={(url) => browser.navigate(active.id, url)}
            onHistory={(action) => browser.history(active.id, action)}
            onScreenshot={() => browser.screenshot(active.id)}
            onRecordToggle={() => browser.toggleRecording(active.id)}
            onAnnotate={() => browser.toggleAnnotate(active.id)}
            onPopOut={() => browser.setPoppedOut(active.id, false)}
            onOpenExternally={() => browser.openExternally(active.id)}
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
