import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Circle,
  ExternalLink,
  MoreVertical,
  MousePointerClick,
  PictureInPicture2,
  RotateCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { BrowserTab } from "../bridge";
import { BrowserStart } from "./BrowserStart";
import { rememberBrowserVisit } from "./browserRecents";
import { Tooltip } from "./Tooltip";
import "./browserSurface.css";

export interface BrowserSurfaceProps {
  tab: BrowserTab;
  /** Reports the slot rectangle so the native tab can sit exactly over it. */
  onBoundsChange: (bounds: DOMRect | null) => void;
  onNavigate: (url: string) => Promise<void>;
  onHistory: (action: "back" | "forward" | "reload" | "stop") => Promise<void>;
  onScreenshot: () => Promise<void>;
  onRecordToggle: () => Promise<void>;
  recording: boolean;
  onAnnotate: () => Promise<void>;
  annotating: boolean;
  onPopOut: (popped: boolean) => Promise<void>;
  onOpenExternally: () => Promise<void>;
  onClose: () => void;
  message?: string | null;
}

/**
 * The chrome around a native browser tab. The page itself is a webview the
 * native side positions over `.browser-viewport`; everything here is the
 * frame: address, history, and the capture/annotate/pop-out controls.
 */
export function BrowserSurface({
  tab,
  onBoundsChange,
  onNavigate,
  onHistory,
  onScreenshot,
  onRecordToggle,
  recording,
  onAnnotate,
  annotating,
  onPopOut,
  onOpenExternally,
  onClose,
  message,
}: BrowserSurfaceProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(tab.url);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const popped = tab.popped_out;
  const blank = !tab.url || tab.url === "about:blank";
  // The caller passes a fresh arrow every render. Reach it through a ref so
  // the placement effect below survives its parent re-rendering: keyed on the
  // callback it tore the tab off screen and put it back several times a
  // second, which is the flicker.
  const boundsRef = useRef(onBoundsChange);
  useEffect(() => {
    boundsRef.current = onBoundsChange;
  }, [onBoundsChange]);

  // Keep the native tab glued to this slot: observe the box, the scroll
  // ancestors and the window, and report physical pixels.
  useLayoutEffect(() => {
    const node = viewportRef.current;
    const onBounds = (rect: DOMRect | null) => boundsRef.current(rect);
    // A blank or popped-out tab has nothing worth showing here, and leaving
    // the native surface parked over the slot would bury the start page under
    // an empty white page.
    if (!node || blank || popped) {
      boundsRef.current(null);
      return;
    }
    let frame = 0;
    let settle = 0;
    let first = true;
    // A moving slot repaints the native surface every frame, which reads as a
    // flicker. Hide it while the geometry is changing and place it once, after
    // it settles; the first placement is immediate so opening feels instant.
    const report = () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      const place = () => {
        // A paused drag must not bring the tab back under the cursor.
        if (document.body.dataset.resizing === "true") return;
        const rect = node.getBoundingClientRect();
        onBounds(rect.width > 0 && rect.height > 0 ? rect : null);
      };
      if (first) {
        first = false;
        frame = requestAnimationFrame(place);
        return;
      }
      onBounds(null);
      settle = window.setTimeout(() => {
        frame = requestAnimationFrame(place);
      }, 90);
    };
    report();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(report);
    observer?.observe(node);
    window.addEventListener("resize", report);
    window.addEventListener("scroll", report, true);
    // A native tab swallows the pointer events a drag needs, so any panel
    // resize anywhere in the window takes the tab off screen for the whole
    // gesture and places it once on release. `data-resizing` is set by every
    // resize handle in the app.
    const dragging = () => document.body.dataset.resizing === "true";
    const onDragChange = () => {
      if (dragging()) {
        cancelAnimationFrame(frame);
        window.clearTimeout(settle);
        onBounds(null);
      } else {
        report();
      }
    };
    const dragObserver =
      typeof MutationObserver === "undefined" ? undefined : new MutationObserver(onDragChange);
    dragObserver?.observe(document.body, { attributeFilter: ["data-resizing"] });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      observer?.disconnect();
      dragObserver?.disconnect();
      window.removeEventListener("resize", report);
      window.removeEventListener("scroll", report, true);
      onBounds(null);
    };
  }, [blank, popped]);

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      inputRef.current?.blur();
      void onNavigate(draft);
    },
    [draft, onNavigate],
  );

  useEffect(() => {
    if (!blank && !tab.loading) rememberBrowserVisit(tab.url, tab.title);
  }, [blank, tab.loading, tab.url, tab.title]);

  return (
    <div className="browser-surface" data-popped={popped ? "true" : undefined}>
      <form className="browser-chrome" onSubmit={submit}>
        <div className="browser-chrome-history">
          <Tooltip label="Back" placement="bottom">
            <button
              type="button"
              className="icon-button subtle tiny"
              aria-label="Back"
              onClick={() => void onHistory("back")}
            >
              <ArrowLeft aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip label="Forward" placement="bottom">
            <button
              type="button"
              className="icon-button subtle tiny"
              aria-label="Forward"
              onClick={() => void onHistory("forward")}
            >
              <ArrowRight aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip label={tab.loading ? "Stop loading" : "Reload"} placement="bottom">
            <button
              type="button"
              className="icon-button subtle tiny"
              aria-label={tab.loading ? "Stop loading" : "Reload"}
              onClick={() => void onHistory(tab.loading ? "stop" : "reload")}
            >
              <RotateCw className={tab.loading ? "spin" : undefined} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
        <div className="browser-address">
          <input
            ref={inputRef}
            type="text"
            value={focused ? draft : tab.url}
            spellCheck={false}
            aria-label="Address"
            placeholder="Search or enter a URL"
            onFocus={() => {
              setFocused(true);
              setDraft(tab.url);
              queueMicrotask(() => inputRef.current?.select());
            }}
            onBlur={() => setFocused(false)}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft(tab.url);
                inputRef.current?.blur();
              }
            }}
          />
          <Tooltip label="Open in your system browser" placement="bottom">
            <button
              type="button"
              className="icon-button subtle tiny browser-address-external"
              aria-label="Open in your system browser"
              onClick={() => void onOpenExternally()}
            >
              <ExternalLink aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
        <div className="browser-chrome-actions">
          <Tooltip
            label={annotating ? "Cancel annotation" : "Annotate this page"}
            hint={annotating ? "Esc" : "Pick an element to send to the chat"}
            placement="bottom"
          >
            <button
              type="button"
              className="icon-button subtle tiny"
              aria-label={annotating ? "Cancel annotation" : "Annotate this page"}
              aria-pressed={annotating}
              onClick={() => void onAnnotate()}
            >
              <MousePointerClick aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip label="Screenshot" hint="Attaches to the composer" placement="bottom">
            <button
              type="button"
              className="icon-button subtle tiny"
              aria-label="Screenshot"
              onClick={() => void onScreenshot()}
            >
              <Camera aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip
            label={recording ? "Stop recording" : "Record"}
            hint={recording ? undefined : "Frames are captured locally"}
            placement="bottom"
          >
            <button
              type="button"
              className="icon-button subtle tiny browser-record"
              aria-label={recording ? "Stop recording" : "Record"}
              aria-pressed={recording}
              data-recording={recording ? "true" : undefined}
              onClick={() => void onRecordToggle()}
            >
              <Circle aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip
            label={popped ? "Dock back into the pane" : "Pop out into its own window"}
            placement="bottom"
          >
            <button
              type="button"
              className="icon-button subtle tiny"
              aria-label={popped ? "Dock back into the pane" : "Pop out into its own window"}
              aria-pressed={popped}
              onClick={() => void onPopOut(!popped)}
            >
              <PictureInPicture2 aria-hidden="true" />
            </button>
          </Tooltip>
          <div className="browser-more">
            <Tooltip label="More" placement="bottom">
              <button
                type="button"
                className="icon-button subtle tiny"
                aria-label="More browser actions"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <MoreVertical aria-hidden="true" />
              </button>
            </Tooltip>
            {menuOpen ? (
              <div className="browser-menu" role="menu" onMouseLeave={() => setMenuOpen(false)}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void onHistory("reload");
                  }}
                >
                  Reload
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void onOpenExternally();
                  }}
                >
                  Open in your system browser
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void navigator.clipboard?.writeText(tab.url);
                  }}
                >
                  Copy address
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onClose();
                  }}
                >
                  Close tab
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </form>
      {message ? (
        <p className="browser-message" role="status">
          {message}
        </p>
      ) : null}
      <div
        className="browser-viewport"
        ref={viewportRef}
        data-native={popped || blank ? undefined : "true"}
      >
        {blank && !popped ? <BrowserStart onOpen={(url) => void onNavigate(url)} /> : null}
        {popped ? (
          <div className="browser-viewport-note">
            <strong>This tab is in its own window</strong>
            <small>It keeps running and stays available to the agent.</small>
            <button
              className="secondary-button small"
              type="button"
              onClick={() => void onPopOut(false)}
            >
              Dock it back
            </button>
          </div>
        ) : null}
        {annotating && !popped ? (
          <div className="browser-annotating" role="status">
            <span>Pick an element to send to the chat</span>
            <button
              type="button"
              className="icon-button subtle tiny"
              aria-label="Cancel annotation"
              onClick={() => void onAnnotate()}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
