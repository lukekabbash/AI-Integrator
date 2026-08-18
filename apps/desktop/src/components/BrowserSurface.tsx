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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import type { BrowserTab } from "../bridge";
import { useModalOpen } from "../useModalOpen";
import { BrowserStart } from "./BrowserStart";
import { rememberBrowserVisit } from "./browserRecents";
import { Tooltip } from "./Tooltip";
import "./browserSurface.css";

/** Room the overflow menu needs below the toolbar, in CSS pixels. Grows with
 *  the menu: every item added has to be counted here, because the tab gives up
 *  exactly this much of its top and a native surface would paint over the rest. */
const MENU_CLEARANCE = 250;
/** The couple of pixels the pane's hairline and drag pill occupy at the seam.
 *  A native surface would paint over them, so the tab starts just inside. */
const SEAM_CLEARANCE = 3;

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
  /** Sends every tab in this task to the pop-out window at once. */
  onPopOutAll?: () => Promise<void>;
  /** True only in the task-scoped pop-out renderer that owns popped tabs. */
  poppedOutHost?: boolean;
  allowExternalOpen: boolean;
  onOpenExternally: () => Promise<void>;
  onClose: () => void;
  /** Remembers the login the person has just typed into this page. */
  onSaveLogin?: () => Promise<void>;
  /** Types a login already saved for this site. */
  onFillLogin?: () => Promise<void>;
  /** Draws toolbar hover copy inside the native page so it never moves it. */
  onToolbarTooltip?: (tooltip: { label: string; x: number } | null) => Promise<void>;
  /** Data URL of the last still taken of this tab, if there is one. */
  poster?: string;
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
  onPopOutAll,
  poppedOutHost = false,
  allowExternalOpen,
  onOpenExternally,
  onClose,
  onSaveLogin,
  onFillLogin,
  onToolbarTooltip,
  poster,
  message,
}: BrowserSurfaceProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(tab.url);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const modalOpen = useModalOpen();
  const popped = tab.poppedOut;
  const hostedHere = popped === poppedOutHost;
  const blank = !tab.url || tab.url === "about:blank";
  // Only the in-app pane has a divider hanging over its left edge. Applying
  // that inset in the independent window made its page look three pixels off.
  const seamClearance = poppedOutHost ? 0 : SEAM_CLEARANCE;
  // The caller passes a fresh arrow every render. Reach it through a ref so
  // the placement effect below survives its parent re-rendering: keyed on the
  // callback it tore the tab off screen and put it back several times a
  // second, which is the flicker.
  const boundsRef = useRef(onBoundsChange);
  useEffect(() => {
    boundsRef.current = onBoundsChange;
  }, [onBoundsChange]);

  // How much of the tab's top the open dropdown needs. A native surface paints
  // above HTML, so a menu over the page would be invisible; while one is open
  // the tab gives up this much of its top and the menu sits in real space. Held
  // as a constant rather than measured, so opening the menu is one placement
  // instead of a render, a measure and a second placement.
  const overlayInset = menuOpen ? MENU_CLEARANCE : 0;

  const tooltipRef = useRef(onToolbarTooltip);
  useEffect(() => {
    tooltipRef.current = onToolbarTooltip;
  }, [onToolbarTooltip]);
  const reportToolbarTooltip = useCallback(
    (open: boolean, anchor?: DOMRect, label?: ReactNode) => {
      if (blank || !tooltipRef.current) return;
      if (!open || !anchor || typeof label !== "string") {
        void tooltipRef.current(null);
        return;
      }
      const viewport = viewportRef.current?.getBoundingClientRect();
      if (!viewport) return;
      void tooltipRef.current({
        label,
        x: anchor.left + anchor.width / 2 - viewport.left - seamClearance,
      });
    },
    [blank, seamClearance],
  );

  // Keep the native tab glued to this slot: observe the box, the scroll
  // ancestors and the window, and report physical pixels.
  useLayoutEffect(() => {
    const node = viewportRef.current;
    const onBounds = (rect: DOMRect | null) => boundsRef.current(rect);
    // A blank or remotely hosted tab has nothing worth showing here. Do not
    // emit a second null placement for it: React retires the formerly visible
    // surface in the same commit, and that surface's cleanup is the request
    // that must park the native page. Replacing it with `new blank -> null`
    // would park the blank tab instead and leave the old page over this slot.
    // Popped tabs are remote in the main window but local in the pop-out.
    // A dialog is the other reason to stand down: the page would paint over it
    // and ignore its backdrop, so it parks until the dialog closes and the
    // poster underneath takes the blur in its place.
    if (!node || blank || !hostedHere || modalOpen) {
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
      const placed = new DOMRect(
        rect.x + seamClearance,
        rect.y + overlayInset,
        Math.max(1, rect.width - seamClearance),
        Math.max(1, rect.height - overlayInset),
      );
      const ratio = window.devicePixelRatio || 1;
      const key = [placed.left, placed.top, placed.right, placed.bottom]
        .map((edge) => Math.round(edge * ratio))
        .join(":");
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
  }, [blank, hostedHere, modalOpen, overlayInset, seamClearance]);

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
    <div
      className="browser-surface"
      data-popped={popped ? "true" : undefined}
      // The strip the native page leaves free at the seam. Painting it in the
      // chrome's colour makes it the browser's own edge rather than a stray
      // line between the transcript and the page.
      style={{ "--browser-seam": `${seamClearance}px` } as CSSProperties}
    >
      <form className="browser-chrome" onSubmit={submit}>
        <div className="browser-chrome-history">
          <Tooltip
            label="Back"
            placement="bottom"
            renderBubble={blank}
            onOpenChange={reportToolbarTooltip}
          >
            <button
              type="button"
              className="icon-button subtle tiny"
              aria-label="Back"
              onClick={() => void onHistory("back")}
            >
              <ArrowLeft aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip
            label="Forward"
            placement="bottom"
            renderBubble={blank}
            onOpenChange={reportToolbarTooltip}
          >
            <button
              type="button"
              className="icon-button subtle tiny"
              aria-label="Forward"
              onClick={() => void onHistory("forward")}
            >
              <ArrowRight aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip
            label={tab.loading ? "Stop loading" : "Reload"}
            placement="bottom"
            renderBubble={blank}
            onOpenChange={reportToolbarTooltip}
          >
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
          {allowExternalOpen ? (
            <Tooltip
              label="Open in your system browser"
              placement="bottom"
              renderBubble={blank}
              onOpenChange={reportToolbarTooltip}
            >
              <button
                type="button"
                className="icon-button subtle tiny browser-address-external"
                aria-label="Open in your system browser"
                onClick={() => void onOpenExternally()}
              >
                <ExternalLink aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}
        </div>
        <div className="browser-chrome-actions">
          <Tooltip
            label={annotating ? "Cancel annotation" : "Annotate this page"}
            hint={annotating ? "Esc" : "Pick an element to send to the chat"}
            placement="bottom"
            renderBubble={blank}
            onOpenChange={reportToolbarTooltip}
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
          <Tooltip
            label="Screenshot"
            hint="Attaches to the composer"
            placement="bottom"
            renderBubble={blank}
            onOpenChange={reportToolbarTooltip}
          >
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
            renderBubble={blank}
            onOpenChange={reportToolbarTooltip}
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
            renderBubble={blank}
            onOpenChange={reportToolbarTooltip}
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
            <Tooltip
              label="More"
              placement="bottom"
              renderBubble={blank}
              onOpenChange={reportToolbarTooltip}
            >
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
                {allowExternalOpen ? (
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
                ) : null}
                {onPopOutAll ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void onPopOutAll();
                    }}
                  >
                    Pop out every tab
                  </button>
                ) : null}
                {/* Saving reads the form the person just filled in; filling
                    types a saved password back. Both happen entirely on the
                    native side, so the value never reaches this window. */}
                <button
                  type="button"
                  role="menuitem"
                  disabled={blank}
                  onClick={() => {
                    setMenuOpen(false);
                    void onSaveLogin?.();
                  }}
                >
                  Save this login
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={blank}
                  onClick={() => {
                    setMenuOpen(false);
                    void onFillLogin?.();
                  }}
                >
                  Sign in with a saved login
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
        data-native={!blank && hostedHere ? "true" : undefined}
      >
        {/* The tab's own last still, painted *under* the native page rather
            than over it. Switching tabs mounts this slot, measures it and
            waits on a round trip before the webview moves, and the pane was
            blank for all of it; now it shows the page you asked for and the
            live one lands on top of its own picture. */}
        {!blank && hostedHere && poster ? (
          <img className="browser-viewport-poster" src={poster} alt="" />
        ) : null}
        {blank && hostedHere ? <BrowserStart onOpen={(url) => void onNavigate(url)} /> : null}
        {!hostedHere ? (
          <div className="browser-viewport-note">
            <strong>{popped ? "This tab is in its own window" : "This tab is docked"}</strong>
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
        {annotating && hostedHere ? (
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
