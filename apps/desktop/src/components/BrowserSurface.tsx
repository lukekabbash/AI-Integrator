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

/** Width of the pane grip the tab steps aside for, matching .resize-handle. */
const GRIP_WIDTH = 8;

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

  // A drag anywhere in the window steps the tab aside until the pointer is
  // released. The pane edge cannot keep up with a fast pointer, and the moment
  // the cursor crosses onto a native surface the gesture is stranded: no more
  // pointer moves, no pointerup, a handle left armed. Once out and once back is
  // nothing like the per-frame blinking this used to do.
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const read = () => setDragging(document.body.dataset.resizing === "true");
    read();
    const observer =
      typeof MutationObserver === "undefined" ? undefined : new MutationObserver(read);
    observer?.observe(document.body, { attributeFilter: ["data-resizing"] });
    return () => observer?.disconnect();
  }, []);

  // The pane's grab grip lives in its left few pixels, and a native surface
  // paints above it — so with the page filling the pane there is nothing to
  // take hold of. Rather than keep a standing gutter, the tab yields that
  // strip only as the pointer comes near the edge, and takes it back when the
  // pointer leaves. The approach is made across the transcript, which is
  // ordinary HTML, so the moves arrive before the cursor reaches the page.
  const [nearEdge, setNearEdge] = useState(false);
  useEffect(() => {
    const node = viewportRef.current;
    if (!node || blank || popped) return;
    const onMove = (event: PointerEvent) => {
      const distance = node.getBoundingClientRect().left - event.clientX;
      // Hysteresis: opening early and closing late keeps the edge from
      // flickering when the pointer hovers right on the threshold.
      setNearEdge((current) => (current ? distance > -4 && distance < 40 : distance > 0 && distance < 18));
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [blank, popped]);

  // Keep the native tab glued to this slot: observe the box, the scroll
  // ancestors and the window, and report physical pixels.
  useLayoutEffect(() => {
    const node = viewportRef.current;
    const onBounds = (rect: DOMRect | null) => boundsRef.current(rect);
    // A blank or popped-out tab has nothing worth showing here, and leaving
    // the native surface parked over the slot would bury the start page under
    // an empty white page. A drag holds it off screen for the same reason the
    // placeholder appears.
    if (!node || blank || popped || dragging) {
      boundsRef.current(null);
      return;
    }
    let frame = 0;
    let last = "";
    // The tab follows its slot instead of being taken off screen and put back:
    // hiding it for even a frame reads as a flash, and the scroll listener
    // below fires for every scrollable box in the window, so a blink here
    // would follow the transcript's scrolling too. Reports the window and its
    // scrollers generate are almost always no-ops, and a rectangle that has
    // not moved is dropped rather than sent.
    const place = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        if (last === "") return;
        last = "";
        onBounds(null);
        return;
      }
      const inset = nearEdge ? GRIP_WIDTH : 0;
      const placed = new DOMRect(
        rect.x + inset,
        rect.y,
        Math.max(1, rect.width - inset),
        rect.height,
      );
      const key = `${Math.round(placed.x)}:${Math.round(placed.y)}:${Math.round(placed.width)}:${Math.round(placed.height)}`;
      if (key === last) return;
      last = key;
      onBounds(placed);
    };
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    report();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(report);
    observer?.observe(node);
    window.addEventListener("resize", report);
    window.addEventListener("scroll", report, true);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", report);
      window.removeEventListener("scroll", report, true);
      onBounds(null);
    };
  }, [blank, popped, dragging, nearEdge]);

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
        {dragging && !popped && !blank ? (
          <div className="browser-resizing" aria-hidden="true">
            <span>{tab.title || tab.url.replace(/^https?:\/\//, "")}</span>
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
