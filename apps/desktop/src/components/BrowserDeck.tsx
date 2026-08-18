import { GripHorizontal, Maximize2, X } from "lucide-react";
import { m as motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { BrowserTab } from "../bridge";
import { useModalOpen } from "../useModalOpen";
import {
  clampDeckOffset,
  promoteDeckTab,
  resolveDeckOrder,
  splitDeck,
  type DeckOffset,
} from "./browserDeckModel";
import { TabFavicon } from "./TabFavicon";
import { Tooltip } from "./Tooltip";
import "./browserDeck.css";

export interface BrowserDeckProps {
  /** This chat's live tabs, in strip order. */
  tabs: BrowserTab[];
  /** Reports where a card's page should sit, or null to park it. */
  onBoundsChange: (tabId: string, bounds: DOMRect | null) => void;
  /** Puts the card back in the work pane, at full size. */
  onExpand: (tabId: string) => void;
  onClose: (tabId: string) => void;
  /** Active browser when closing the whole pane, if there was one. */
  preferredTabId?: string | null;
  /** Data URL of the last still taken of each tab, by id. Painted under the
   *  page so a card is never an empty rectangle while its page arrives. */
  posters?: Readonly<Record<string, string>>;
  /** Recent agent work cannot be destroyed until its native deadline passes. */
  protectedTabIds?: ReadonlySet<string>;
}

const NO_POSTERS: Readonly<Record<string, string>> = {};

const DEFAULT_OFFSET: DeckOffset = { right: 18, bottom: 18 };
const OFFSET_STORAGE_KEY = "integrator.browserDeck.offset";

function readStoredOffset(): DeckOffset {
  try {
    const raw = globalThis.localStorage?.getItem(OFFSET_STORAGE_KEY);
    if (!raw) return DEFAULT_OFFSET;
    const parsed = JSON.parse(raw) as Partial<DeckOffset>;
    if (typeof parsed.right === "number" && typeof parsed.bottom === "number") {
      return { right: parsed.right, bottom: parsed.bottom };
    }
  } catch {
    // A corrupt entry is the default position, not a broken deck.
  }
  return DEFAULT_OFFSET;
}

function storeOffset(offset: DeckOffset): void {
  try {
    globalThis.localStorage?.setItem(OFFSET_STORAGE_KEY, JSON.stringify(offset));
  } catch {
    // Storage may be unavailable; the position simply does not survive.
  }
}

/**
 * Tabs the work pane is not showing, as a column of live cards in the corner.
 *
 * Closing the pane does not stop an agent mid-page, so the pages it is working
 * on cannot simply vanish — the deck is where they go. Every card is its own
 * live webview under its own title strip; native pages cannot overlap, so the
 * cards are laid out one above another rather than fanned. Past the column's
 * limit the oldest become named strips that a click brings back to life.
 *
 * The deck sits over whatever the pane holds, in the bottom-right by default,
 * and the grip at its top drags it anywhere; the position is remembered.
 * Nothing is ever drawn over a card's page: the title strip sits above it.
 */
export function BrowserDeck({
  tabs,
  onBoundsChange,
  onExpand,
  onClose,
  preferredTabId = null,
  posters = NO_POSTERS,
  protectedTabIds,
}: BrowserDeckProps) {
  const tabIdsKey = tabs.map((tab) => tab.id).join("\0");
  const [state, setState] = useState(() => ({
    tabIdsKey,
    order: resolveDeckOrder(tabs, [], preferredTabId),
  }));
  let current = state;
  if (state.tabIdsKey !== tabIdsKey) {
    current = { tabIdsKey, order: resolveDeckOrder(tabs, state.order, preferredTabId) };
    // React's previous-props state pattern: this rerenders immediately, before
    // a departed card's page can be placed against a stale column.
    setState(current);
  }
  const { live, strips } = splitDeck(tabs, current.order);
  const promote = useCallback((tabId: string) => {
    setState((previous) => ({ ...previous, order: promoteDeckTab(previous.order, tabId) }));
  }, []);

  const [offset, setOffset] = useState<DeckOffset>(readStoredOffset);
  const offsetRef = useRef(offset);
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);
  const deckRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; from: DeckOffset } | null>(
    null,
  );

  const clampToViewport = useCallback((next: DeckOffset): DeckOffset => {
    const node = deckRef.current;
    if (!node || typeof window === "undefined") return next;
    const rect = node.getBoundingClientRect();
    return clampDeckOffset(
      next,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
  }, []);

  const onGripPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        from: offset,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [offset],
  );
  const onGripPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      // Dragging left grows `right`; dragging up grows `bottom`.
      setOffset(
        clampToViewport({
          right: active.from.right - (event.clientX - active.startX),
          bottom: active.from.bottom - (event.clientY - active.startY),
        }),
      );
    },
    [clampToViewport],
  );
  const onGripPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    storeOffset(offsetRef.current);
  }, []);

  // A window that shrinks under a dragged deck pulls it back on screen.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setOffset((previous) => clampToViewport(previous));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampToViewport]);

  if (live.length === 0) return null;

  // Cards re-place their pages whenever the deck moves; the key names the spot.
  const placementKey = `${offset.right}:${offset.bottom}:${live.length}`;

  return (
    <div
      ref={deckRef}
      className="browser-deck"
      data-count={tabs.length}
      data-live={live.length}
      style={{ right: `${offset.right}px`, bottom: `${offset.bottom}px` }}
    >
      <div
        className="browser-deck-grip"
        role="button"
        tabIndex={0}
        aria-label="Move browser cards"
        title="Drag to move"
        onPointerDown={onGripPointerDown}
        onPointerMove={onGripPointerMove}
        onPointerUp={onGripPointerUp}
        onPointerCancel={onGripPointerUp}
      >
        <GripHorizontal aria-hidden="true" />
      </div>
      {strips.length > 0 ? (
        <div className="browser-deck-strips" role="group" aria-label="More browser tabs">
          {strips.map((tab) => {
            const name = tab.title || tab.url.replace(/^https?:\/\//, "");
            return (
              <button
                type="button"
                key={tab.id}
                className="browser-deck-strip"
                onClick={() => promote(tab.id)}
                title={tab.title || tab.url}
                aria-label={name}
              >
                <TabFavicon src={tab.favicon} />
                <span className="browser-deck-strip-label">{name}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div
        className="browser-deck-column"
        role="group"
        aria-label={`${live.length} compact browser ${live.length === 1 ? "tab" : "tabs"}`}
      >
        {live.map((tab) => (
          <DeckCard
            key={tab.id}
            tab={tab}
            poster={posters[tab.id]}
            placementKey={placementKey}
            protectedFromClose={protectedTabIds?.has(tab.id) === true}
            onBoundsChange={onBoundsChange}
            onExpand={onExpand}
            onClose={onClose}
          />
        ))}
      </div>
    </div>
  );
}

interface DeckCardProps {
  tab: BrowserTab;
  poster?: string;
  placementKey: string;
  protectedFromClose: boolean;
  onBoundsChange: (tabId: string, bounds: DOMRect | null) => void;
  onExpand: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

function DeckCard({
  tab,
  poster,
  placementKey,
  protectedFromClose,
  onBoundsChange,
  onExpand,
  onClose,
}: DeckCardProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const modalOpen = useModalOpen();
  const boundsRef = useRef(onBoundsChange);
  useEffect(() => {
    boundsRef.current = onBoundsChange;
  }, [onBoundsChange]);

  // Same placement discipline as the pane: follow the slot rather than hiding
  // and re-showing, and never send a rectangle that has not moved.
  const tabId = tab.id;
  const blank = !tab.url || tab.url === "about:blank";
  useLayoutEffect(() => {
    const node = pageRef.current;
    // A card's page is a native surface too, so a dialog parks it for the same
    // reason the pane's does: it would sit over the dialog, unblurred.
    if (!node || blank || modalOpen) return;
    const report = boundsRef.current;
    let frame = 0;
    let last = "";
    const place = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const key = `${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
      if (key === last) return;
      last = key;
      report(tabId, rect);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    schedule();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    observer?.observe(node);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      // Leaving the deck parks the page rather than closing it: the tab keeps
      // running, which is the whole point of the corner.
      report(tabId, null);
    };
    // placementKey: the deck moved or the column changed height, so the same
    // node now sits somewhere else and the page must follow.
  }, [tabId, blank, modalOpen, placementKey]);

  const label = tab.title || tab.url.replace(/^https?:\/\//, "");
  // "you" is the person's own hold; only an agent's turn is worth marking.
  const agentAt = tab.heldBy && tab.heldBy !== "you" ? tab.heldBy : null;

  return (
    <motion.div
      className="browser-deck-card"
      data-busy={agentAt ? "true" : undefined}
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34 }}
    >
      <div className="browser-deck-bar">
        <TabFavicon src={tab.favicon} />
        <span className="browser-deck-title" title={tab.url}>
          {label}
        </span>
        {agentAt ? (
          <span className="browser-deck-who" title={`${agentAt} is working in this tab`}>
            <i aria-hidden="true" />
            {agentAt}
          </span>
        ) : null}
        <div className="browser-deck-actions">
          <Tooltip label="Open in the pane" placement="top">
            <button
              type="button"
              className="icon-button subtle tiny"
              aria-label="Open in the pane"
              onClick={() => onExpand(tab.id)}
            >
              <Maximize2 aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip
            label={protectedFromClose ? "Agent used this tab recently" : "Close tab"}
            placement="top"
          >
            <button
              type="button"
              className="icon-button subtle tiny"
              aria-label={
                protectedFromClose
                  ? "Browser tab preserved for recent agent work"
                  : "Close browser tab"
              }
              disabled={protectedFromClose}
              onClick={() => onClose(tab.id)}
            >
              <X aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      </div>
      {/* The webview lands exactly here; nothing may be drawn over it. The
          still underneath is a backdrop, not an overlay: the native page
          covers it the moment it arrives. */}
      <div className="browser-deck-page" ref={pageRef}>
        {!blank && poster ? <img className="browser-deck-poster" src={poster} alt="" /> : null}
        {blank ? <span className="browser-deck-empty">Empty tab</span> : null}
      </div>
    </motion.div>
  );
}
