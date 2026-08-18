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
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { bridge, type BrowserTab, type LocalServer } from "../bridge";
import { watchLayoutShift } from "../layoutShift";
import { useNativePageParked } from "../useModalOpen";
import { resolveOmniboxInput, readSearchEngine } from "../browserOmnibox";
import { toggleBrowserBookmark } from "./browserBookmarks";
import { BrowserOmnibox } from "./BrowserOmnibox";
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

export interface BrowserChromeBarProps {
  /** Back / forward / reload. Omitted (or `disabled`) on a tab with no page. */
  onHistory?: (action: "back" | "forward" | "reload" | "stop") => void;
  disabled?: boolean;
  loading?: boolean;
  /** Tooltip bubbles draw in HTML unless a native page must draw them. */
  renderBubble?: boolean;
  onTooltipOpenChange?: (open: boolean, anchor?: DOMRect, label?: ReactNode) => void;
  onSubmit?: (event: React.FormEvent) => void;
  /** The address field and, after it, the action cluster. */
  children: ReactNode;
}

/**
 * The 38px strip every browser-shaped surface wears: history controls, then
 * whatever the caller puts after them (address, actions). A new tab with no
 * page uses the same strip with the history disabled, so the pane reads as
 * a browser before it has anywhere to go.
 */
export function BrowserChromeBar({
  onHistory,
  disabled = false,
  loading = false,
  renderBubble = true,
  onTooltipOpenChange,
  onSubmit,
  children,
}: BrowserChromeBarProps) {
  const inert = disabled || !onHistory;
  return (
    <form
      className="browser-chrome"
      onSubmit={
        onSubmit ??
        ((event) => {
          event.preventDefault();
        })
      }
    >
      <div className="browser-chrome-history">
        <Tooltip
          label="Back"
          placement="bottom"
          renderBubble={renderBubble}
          onOpenChange={onTooltipOpenChange}
        >
          <button
            type="button"
            className="icon-button subtle tiny"
            aria-label="Back"
            disabled={inert}
            onClick={() => onHistory?.("back")}
          >
            <ArrowLeft aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip
          label="Forward"
          placement="bottom"
          renderBubble={renderBubble}
          onOpenChange={onTooltipOpenChange}
        >
          <button
            type="button"
            className="icon-button subtle tiny"
            aria-label="Forward"
            disabled={inert}
            onClick={() => onHistory?.("forward")}
          >
            <ArrowRight aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip
          label={loading ? "Stop loading" : "Reload"}
          placement="bottom"
          renderBubble={renderBubble}
          onOpenChange={onTooltipOpenChange}
        >
          <button
            type="button"
            className="icon-button subtle tiny"
            aria-label={loading ? "Stop loading" : "Reload"}
            disabled={inert}
            onClick={() => onHistory?.(loading ? "stop" : "reload")}
          >
            <RotateCw className={loading ? "spin" : undefined} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      {children}
    </form>
  );
}

/**
 * The action cluster with nothing to act on: a new tab wears the same five
 * controls as a live page, disabled, so the strip is the same width and shape
 * before and after the first address — nothing jumps when the page arrives.
 */
export function BrowserChromeActionsPlaceholder() {
  const actions: [string, ReactNode][] = [
    ["Annotate this page", <MousePointerClick aria-hidden="true" key="annotate" />],
    ["Screenshot", <Camera aria-hidden="true" key="screenshot" />],
    ["Record", <Circle aria-hidden="true" key="record" />],
    ["Pop out into its own window", <PictureInPicture2 aria-hidden="true" key="popout" />],
    ["More browser actions", <MoreVertical aria-hidden="true" key="more" />],
  ];
  return (
    <div className="browser-chrome-actions" data-inert="true">
      {actions.map(([label, icon]) => (
        <button
          key={label}
          type="button"
          className="icon-button subtle tiny"
          aria-label={label}
          disabled
        >
          {icon}
        </button>
      ))}
    </div>
  );
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
  const [draft, setDraft] = useState(tab.url === "about:blank" ? "" : tab.url);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [servers, setServers] = useState<LocalServer[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const nativeParked = useNativePageParked();
  const popped = tab.poppedOut;
  const hostedHere = popped === poppedOutHost;
  const blank = !tab.url || tab.url === "about:blank";
  const canUseNativeMenu =
    !blank && hostedHere && typeof bridge.browser?.showMenu === "function";

  // The overflow menu's entries, in one place, so the HTML menu and the OS
  // menu offer the same things in the same order.
  const menuEntries = useMemo(
    () => [
      { id: "reload", label: "Reload" },
      ...(allowExternalOpen ? [{ id: "external", label: "Open in your system browser" }] : []),
      ...(onPopOutAll ? [{ id: "popout-all", label: "Pop out every tab" }] : []),
      { separator: true },
      { id: "save-login", label: "Save this login", enabled: !blank },
      { id: "fill-login", label: "Sign in with a saved login", enabled: !blank },
      { separator: true },
      { id: "copy", label: "Copy address" },
      { id: "close", label: "Close tab" },
    ],
    [allowExternalOpen, blank, onPopOutAll],
  );
  const pickMenu = useCallback(
    (itemId: string) => {
      switch (itemId) {
        case "reload":
          void onHistory("reload");
          break;
        case "external":
          void onOpenExternally();
          break;
        case "popout-all":
          void onPopOutAll?.();
          break;
        case "save-login":
          void onSaveLogin?.();
          break;
        case "fill-login":
          void onFillLogin?.();
          break;
        case "copy":
          void navigator.clipboard?.writeText(tab.url);
          break;
        case "close":
          onClose();
          break;
      }
    },
    [onClose, onFillLogin, onHistory, onOpenExternally, onPopOutAll, onSaveLogin, tab.url],
  );
  const pickRef = useRef(pickMenu);
  useEffect(() => {
    pickRef.current = pickMenu;
  }, [pickMenu]);
  useEffect(() => {
    const api = bridge.browser;
    if (!api?.onMenuPick) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void api
      .onMenuPick((pick) => {
        if (pick.tabId === tab.id && pick.taskId === tab.taskId) pickRef.current(pick.itemId);
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
  }, [tab.id, tab.taskId]);
  const openNativeMenu = useCallback(
    async (anchor: DOMRect) => {
      const api = bridge.browser;
      if (!api?.showMenu) return;
      // Under the button, right-aligned to it, in the window's logical pixels
      // (the renderer fills its window, so client coordinates are window
      // coordinates).
      await api
        .showMenu(tab.taskId, tab.id, anchor.right, anchor.bottom + 4, menuEntries)
        .catch(() => undefined);
    },
    [menuEntries, tab.id, tab.taskId],
  );
  // The caller passes a fresh arrow every render. Reach it through a ref so
  // the placement effect below survives its parent re-rendering: keyed on the
  // callback it tore the tab off screen and put it back several times a
  // second, which is the flicker.
  const boundsRef = useRef(onBoundsChange);
  useEffect(() => {
    boundsRef.current = onBoundsChange;
  }, [onBoundsChange]);

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
        x: anchor.left + anchor.width / 2 - viewport.left,
      });
    },
    [blank],
  );

  useEffect(() => {
    let active = true;
    void (bridge.browser?.localServers?.(false) ?? Promise.resolve<LocalServer[]>([]))
      .then((list) => {
        if (active) setServers(list);
      })
      .catch(() => {
        if (active) setServers([]);
      });
    return () => {
      active = false;
    };
  }, [tab.id]);

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
    // A dialog is one reason to stand down: the page would paint over it
    // and ignore its backdrop, so it parks until the dialog closes and the
    // poster underneath takes the blur in its place. Dragging the compact
    // deck across this slot is the same problem — the cards are HTML and
    // the webview would swallow them. The overflow menu must sit in HTML
    // space too, but it must not shove the live page down to make room.
    // Parking keeps the slot still.
    if (!node || blank || !hostedHere || nativeParked || menuOpen || suggestOpen) {
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
        rect.x,
        rect.y,
        Math.max(1, rect.width),
        Math.max(1, rect.height),
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
    // Size *and* position: the pane is a fixed-width column, so opening or
    // closing a sidebar slides this slot sideways without resizing it, and a
    // ResizeObserver on the slot alone would leave the page where the slot
    // used to be. See watchLayoutShift.
    const stopWatching = watchLayoutShift(node, report);
    window.addEventListener("scroll", report, true);
    return () => {
      cancelAnimationFrame(frame);
      stopWatching();
      window.removeEventListener("scroll", report, true);
      onBounds(null);
    };
  }, [blank, hostedHere, menuOpen, nativeParked, suggestOpen]);

  const go = useCallback(
    (input: string) => {
      const resolved = resolveOmniboxInput(input, readSearchEngine());
      if (resolved.kind === "empty") return;
      inputRef.current?.blur();
      void onNavigate(resolved.href);
    },
    [onNavigate],
  );

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      go(draft);
    },
    [draft, go],
  );

  useEffect(() => {
    if (!blank && !tab.loading) rememberBrowserVisit(tab.url, tab.title, tab.favicon);
  }, [blank, tab.favicon, tab.loading, tab.url, tab.title]);

  return (
    <div className="browser-surface" data-popped={popped ? "true" : undefined}>
      <BrowserChromeBar
        onSubmit={submit}
        loading={Boolean(tab.loading)}
        renderBubble={blank}
        onTooltipOpenChange={reportToolbarTooltip}
        onHistory={(action) => void onHistory(action)}
      >
        <div className="browser-address">
          <BrowserOmnibox
            size="chrome"
            value={focused ? draft : blank ? "" : tab.url}
            inputRef={inputRef}
            bookmark={blank ? undefined : { url: tab.url, title: tab.title, favicon: tab.favicon }}
            onToggleBookmark={
              blank
                ? undefined
                : () => {
                    toggleBrowserBookmark(tab.url, tab.title, tab.favicon);
                  }
            }
            onChange={setDraft}
            onSubmit={go}
            servers={servers.map((server) => ({
              url: server.url,
              title: server.title || server.process || `localhost:${server.port}`,
              hint: `localhost:${server.port}`,
            }))}
            onSuggestOpenChange={setSuggestOpen}
            onFocus={() => {
              setFocused(true);
              setDraft(blank ? "" : tab.url);
              queueMicrotask(() => inputRef.current?.select());
            }}
            onBlur={() => setFocused(false)}
            onEscape={() => {
              setDraft(blank ? "" : tab.url);
              inputRef.current?.blur();
            }}
            trailing={
              allowExternalOpen ? (
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
              ) : null
            }
          />
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
                onClick={(event) => {
                  // Over a live page the menu is the OS's, which draws above
                  // the native page; the HTML menu is for a blank tab and for
                  // hosts without a native side.
                  if (canUseNativeMenu) {
                    void openNativeMenu(event.currentTarget.getBoundingClientRect());
                    return;
                  }
                  setMenuOpen((open) => !open);
                }}
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
      </BrowserChromeBar>
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
        {blank && hostedHere ? (
          <BrowserStart
            layout="home"
            autoFocus={poppedOutHost}
            showSearch
            onOpen={(url) => void onNavigate(url)}
          />
        ) : null}
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
