import { ChevronLeft, ChevronRight, Maximize2, X } from "lucide-react";
import { AnimatePresence, m as motion, useIsPresent, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import type { BrowserTab } from "../bridge";
import { setNativePageDeckOccluding, useModalOpen } from "../useModalOpen";
import { useNativePageRects } from "../useNativePageRects";
import {
  clampDeckOffset,
  cycleDeck,
  DECK_PEEK_X,
  DECK_PEEK_Y,
  promoteDeckTab,
  resolveDeckOrder,
  deckRect,
  overlapsAny,
  settleDeckOffset,
  stackDeck,
  type DeckOffset,
} from "./browserDeckModel";
import { TabFavicon } from "./TabFavicon";
import { Tooltip } from "./Tooltip";
import "./browserDeck.css";

export interface BrowserDeckProps {
  /** This chat's live tabs, in strip order. */
  tabs: BrowserTab[];
  /** Reports where the face's page should sit, or null to park it. */
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
const DRAG_THRESHOLD = 5;
/** How long the deck is "in the air" after it is let go: the lift eases back
 *  and, if it had to slide clear of a page, the glide lands. The face's page
 *  returns only once the card is still, so it never lands mid-flight. */
const SETTLE_MS = 420;
/** How long a card or the pile is given to reach its place before the page is
 *  put there anyway — motion's completion callback is the real signal; this
 *  is the net under it for a window whose frames are paused. */
const ARRIVAL_FALLBACK_MS = 520;
/** Wheel travel that turns one card. */
const WHEEL_STEP = 48;
const WHEEL_REST_MS = 220;

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

function isHeaderControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button") !== null;
}

function sameOffset(a: DeckOffset, b: DeckOffset): boolean {
  return a.right === b.right && a.bottom === b.bottom;
}

type DeckPhase = "rest" | "dragging" | "settling";

/**
 * Tabs the work pane is not showing, as a pile of cards in the corner.
 *
 * Closing the pane does not stop an agent mid-page, so the pages it is working
 * on cannot simply vanish — the deck is where they go. Native pages cannot
 * overlap, so only the front card is live; the rest peek down and left as
 * stills. The face's title strip drags the pile; the strip's arrows, the mouse
 * wheel over it and the arrow keys turn the cards; a double-click puts that
 * tab back in the pane.
 *
 * While the deck is in the air its face shows its own still instead of the
 * live page: the pile then moves as one HTML thing, lifts and drops like a
 * card, and never asks the native page to chase the pointer. On release it
 * settles — clear of any live page in the pane, since a webview would swallow
 * the cards — and the page comes back to the face where it landed.
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
  const modalOpen = useModalOpen();
  const pageRects = useNativePageRects();
  const reduceMotion = Boolean(useReducedMotion());
  const tabIdsKey = tabs.map((tab) => tab.id).join("\0");
  const [state, setState] = useState(() => ({
    tabIdsKey,
    order: resolveDeckOrder(tabs, [], preferredTabId),
  }));
  let current = state;
  if (state.tabIdsKey !== tabIdsKey) {
    current = { tabIdsKey, order: resolveDeckOrder(tabs, state.order, preferredTabId) };
    setState(current);
  }
  const { front, behind } = stackDeck(tabs, current.order);
  const cycle = useCallback((direction: "next" | "prev") => {
    setState((previous) => ({ ...previous, order: cycleDeck(previous.order, direction) }));
  }, []);
  const promote = useCallback((tabId: string) => {
    setState((previous) => ({ ...previous, order: promoteDeckTab(previous.order, tabId) }));
  }, []);

  const [offset, setOffset] = useState<DeckOffset>(readStoredOffset);
  const [phase, setPhase] = useState<DeckPhase>("rest");
  // Bumped each time the deck comes to rest, so the face's page is placed
  // again where the card actually landed.
  const [landing, setLanding] = useState(0);
  const offsetRef = useRef(offset);
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);
  const deckRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    from: DeckOffset;
    moved: boolean;
  } | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const measure = useCallback(() => {
    const node = deckRef.current;
    if (!node || typeof window === "undefined") return null;
    // A window with no size (minimised, or a hidden view) is not a place to
    // clamp against; the stored position would collapse to the corner.
    if (window.innerWidth <= 0 || window.innerHeight <= 0) return null;
    const rect = node.getBoundingClientRect();
    return {
      deck: { width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }, []);
  const clampToViewport = useCallback(
    (next: DeckOffset): DeckOffset => {
      const box = measure();
      return box ? clampDeckOffset(next, box.deck, box.viewport) : next;
    },
    [measure],
  );

  // Coming to rest: the lift eases back and, when the drop was on a live
  // page, the glide to the nearest clear spot plays. Either way the face is a
  // still until the timer runs out, then its page is placed where it landed.
  // The pane's page, parked for the drag, stays parked until then too, so the
  // glide off it is not swallowed by the page coming back underneath.
  const land = useCallback((delay: number) => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    setPhase("settling");
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      setNativePageDeckOccluding(false);
      setPhase("rest");
      setLanding((count) => count + 1);
    }, delay);
  }, []);
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  const onHeaderPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || isHeaderControl(event.target)) return;
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        from: offset,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [offset],
  );
  const onHeaderPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const dx = event.clientX - active.startX;
      const dy = event.clientY - active.startY;
      if (!active.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!active.moved) {
        active.moved = true;
        if (settleTimer.current) {
          clearTimeout(settleTimer.current);
          settleTimer.current = null;
        }
        setPhase("dragging");
        setNativePageDeckOccluding(true);
      }
      setOffset(
        clampToViewport({
          right: active.from.right - dx,
          bottom: active.from.bottom - dy,
        }),
      );
    },
    [clampToViewport],
  );
  const onHeaderPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      drag.current = null;
      if (!active.moved) return;
      const box = measure();
      const settled = box
        ? settleDeckOffset(offsetRef.current, box.deck, box.viewport, [])
        : offsetRef.current;
      setOffset(settled);
      storeOffset(settled);
      land(reduceMotion ? 0 : SETTLE_MS);
    },
    [land, measure, reduceMotion],
  );

  useEffect(() => () => setNativePageDeckOccluding(false), []);

  // The deck may rest anywhere, the pane's page included. It cannot be drawn
  // over a live page — the page is a native webview and paints above HTML —
  // so while the deck sits on the slot the page stands down and its still,
  // refreshed every couple of seconds by the surface, shows under the cards.
  // Move the deck off and the page is live again.
  useEffect(() => {
    if (phase !== "rest" || typeof window === "undefined") return;
    const box = measure();
    if (!box) return;
    const resting = deckRect(offsetRef.current, box.deck, box.viewport);
    setNativePageDeckOccluding(overlapsAny(resting, pageRects));
  }, [measure, pageRects, phase, offset]);

  // At rest the deck stays inside the window: a shrink or a rail folding
  // away pulls it back to the nearest spot that fits.
  useEffect(() => {
    if (phase !== "rest" || typeof window === "undefined") return;
    const box = measure();
    if (!box) return;
    const settled = settleDeckOffset(offsetRef.current, box.deck, box.viewport, []);
    if (sameOffset(settled, offsetRef.current)) return;
    setOffset(settled);
    storeOffset(settled);
    land(reduceMotion ? 0 : SETTLE_MS);
  }, [land, measure, pageRects, phase, reduceMotion, tabs.length]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => {
      const box = measure();
      if (!box) return;
      setOffset((previous) => settleDeckOffset(previous, box.deck, box.viewport, []));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure, pageRects]);

  // The wheel over the title strip turns the pile, one card per notch or so.
  const wheel = useRef({ travel: 0, restUntil: 0 });
  const onBarWheel = useCallback(
    (event: ReactWheelEvent<HTMLElement>) => {
      if (tabs.length < 2) return;
      const now = performance.now();
      const state = wheel.current;
      if (now < state.restUntil) return;
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      state.travel += delta;
      if (Math.abs(state.travel) < WHEEL_STEP) return;
      cycle(state.travel > 0 ? "next" : "prev");
      state.travel = 0;
      state.restUntil = now + WHEEL_REST_MS;
    },
    [cycle, tabs.length],
  );
  const onStackKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (tabs.length < 2) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        cycle("prev");
      } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        cycle("next");
      }
    },
    [cycle, tabs.length],
  );

  // The pile rises as one thing when its first card arrives; the face's page
  // waits for that rise to finish, or it would be put down at the pile's
  // half-grown size.
  const [pileReady, setPileReady] = useState(reduceMotion);
  const onPileStart = useCallback(() => setPileReady(false), []);
  const onPileComplete = useCallback(() => setPileReady(true), []);
  const hasFront = front !== null;
  useEffect(() => {
    // Motion's completion is the signal; a window whose frames are paused
    // (hidden, minimised) still gets its page after a beat.
    if (!hasFront || pileReady) return;
    const timer = setTimeout(() => setPileReady(true), reduceMotion ? 0 : ARRIVAL_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [hasFront, pileReady, reduceMotion]);

  const moving = phase !== "rest";
  const placementKey = `${offset.right}:${offset.bottom}:${front?.id ?? ""}:${landing}`;
  const canCycle = tabs.length > 1;
  const position = front ? tabs.findIndex((tab) => tab.id === front.id) + 1 : 0;
  const rise = reduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 420, damping: 34, mass: 0.8 };
  const sink = reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.2, 0, 0, 1] as const };

  return (
    <div
      ref={deckRef}
      className="browser-deck"
      data-count={tabs.length}
      data-depth={behind.length}
      data-phase={phase}
      data-dragging={phase === "dragging" ? "true" : undefined}
      style={
        {
          right: `${offset.right}px`,
          bottom: `${offset.bottom}px`,
          "--deck-depth": behind.length,
          "--deck-peek-x": `${DECK_PEEK_X}px`,
          "--deck-peek-y": `${DECK_PEEK_Y}px`,
        } as CSSProperties
      }
    >
      {/* The whole pile rises when the first card arrives and sinks when the
          last one leaves; cards inside it come and go on their own. */}
      <AnimatePresence>
        {front ? (
          <motion.div
            key="pile"
            className="browser-deck-pile"
            initial={reduceMotion ? false : { opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: rise }}
            exit={{ opacity: 0, y: 12, scale: 0.97, transition: sink }}
            onAnimationStart={onPileStart}
            onAnimationComplete={onPileComplete}
          >
            <div
              className="browser-deck-stack"
              role="group"
              aria-label={`${tabs.length} compact browser ${tabs.length === 1 ? "tab" : "tabs"}`}
              onKeyDown={onStackKeyDown}
            >
              <AnimatePresence initial={false}>
                {behind.map((tab, index) => (
                  <DeckCard
                    key={tab.id}
                    tab={tab}
                    depth={behind.length - index}
                    poster={posters[tab.id]}
                    live={false}
                    stackReady={pileReady}
                    placementKey={placementKey}
                    protectedFromClose={protectedTabIds?.has(tab.id) === true}
                    modalOpen={modalOpen}
                    onBoundsChange={onBoundsChange}
                    onExpand={onExpand}
                    onClose={onClose}
                    onPromote={() => promote(tab.id)}
                  />
                ))}
                <DeckCard
                  key={front.id}
                  tab={front}
                  depth={0}
                  poster={posters[front.id]}
                  live={!moving}
                  stackReady={pileReady}
                  placementKey={placementKey}
                  protectedFromClose={protectedTabIds?.has(front.id) === true}
                  modalOpen={modalOpen}
                  onBoundsChange={onBoundsChange}
                  onExpand={onExpand}
                  onClose={onClose}
                  onHeaderPointerDown={onHeaderPointerDown}
                  onHeaderPointerMove={onHeaderPointerMove}
                  onHeaderPointerUp={onHeaderPointerUp}
                  onHeaderWheel={canCycle ? onBarWheel : undefined}
                />
              </AnimatePresence>
              {canCycle ? (
                // Docked over the face's title strip but owned by the stack, so
                // the arrows keep their focus while the card under them is
                // swapped out.
                <div className="browser-deck-nav" aria-label="Turn the deck" onWheel={onBarWheel}>
                  <Tooltip label="Previous tab" hint="← or wheel" placement="top">
                    <button
                      type="button"
                      className="browser-deck-cycle"
                      data-dir="prev"
                      aria-label="Previous browser card"
                      onClick={() => cycle("prev")}
                    >
                      <ChevronLeft aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <span className="browser-deck-count" aria-live="polite">
                    <b>{position}</b>
                    <i aria-hidden="true">/</i>
                    {tabs.length}
                  </span>
                  <Tooltip label="Next tab" hint="→ or wheel" placement="top">
                    <button
                      type="button"
                      className="browser-deck-cycle"
                      data-dir="next"
                      aria-label="Next browser card"
                      onClick={() => cycle("next")}
                    >
                      <ChevronRight aria-hidden="true" />
                    </button>
                  </Tooltip>
                </div>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

interface DeckCardProps {
  tab: BrowserTab;
  depth: number;
  poster?: string;
  /** Whether the card's native page is placed here right now. The face is
   *  live at rest and a still while the deck is in the air. */
  live: boolean;
  /** Whether the pile as a whole has finished rising into place. */
  stackReady: boolean;
  placementKey: string;
  protectedFromClose: boolean;
  modalOpen: boolean;
  onBoundsChange: (tabId: string, bounds: DOMRect | null) => void;
  onExpand: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onPromote?: () => void;
  onHeaderPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onHeaderPointerMove?: (event: ReactPointerEvent<HTMLElement>) => void;
  onHeaderPointerUp?: (event: ReactPointerEvent<HTMLElement>) => void;
  onHeaderWheel?: (event: ReactWheelEvent<HTMLElement>) => void;
}

function DeckCard({
  tab,
  depth,
  poster,
  live,
  stackReady,
  placementKey,
  protectedFromClose,
  modalOpen,
  onBoundsChange,
  onExpand,
  onClose,
  onPromote,
  onHeaderPointerDown,
  onHeaderPointerMove,
  onHeaderPointerUp,
  onHeaderWheel,
}: DeckCardProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const reduce = Boolean(useReducedMotion());
  const present = useIsPresent();
  const boundsRef = useRef(onBoundsChange);
  useEffect(() => {
    boundsRef.current = onBoundsChange;
  }, [onBoundsChange]);

  const tabId = tab.id;
  const face = depth === 0;
  const blank = !tab.url || tab.url === "about:blank";

  // Which way this card is travelling: forward toward the face, or back under
  // the pile. A card going back is shuffled — out, down and under — rather
  // than slid straight to its slot; a card coming forward springs into place.
  // The direction holds for as long as the card sits at this depth, so the
  // shuffle is not cut short by a re-render mid-flight.
  const [travel, setTravel] = useState({ depth, from: depth });
  if (travel.depth !== depth) setTravel({ depth, from: travel.depth });
  const cameFrom = travel.depth === depth ? travel.from : travel.depth;
  const goingBack = depth > cameFrom;

  // The face's page is placed only once the card is still: a page put down
  // while the card is still sliding in would sit where the card was going to
  // be, ahead of it. Until then the card shows its still. Arrival is recorded
  // against the depth it was reached at, so a new depth is a new journey.
  const [arrivedAt, setArrivedAt] = useState<number | null>(reduce ? depth : null);
  const arrived = reduce || arrivedAt === depth;
  // Every finished animation is a fresh measurement: a page placed while a
  // hidden window had its frames paused is put right once frames resume.
  const [stillness, setStillness] = useState(0);
  useEffect(() => {
    if (!face || arrived) return;
    const timer = setTimeout(() => setArrivedAt(depth), ARRIVAL_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [arrived, depth, face]);
  const onMove = useCallback(() => {
    if (face && !reduce) setArrivedAt(null);
  }, [face, reduce]);
  const onArrive = useCallback(() => {
    if (!face) return;
    setArrivedAt(depth);
    setStillness((count) => count + 1);
  }, [depth, face]);

  const placed = live && present && arrived && stackReady;
  const remeasure = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const node = pageRef.current;
    if (!placed || !node || blank || modalOpen) return;
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
    remeasure.current = schedule;
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    observer?.observe(node);
    window.addEventListener("resize", schedule);
    return () => {
      remeasure.current = null;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      report(tabId, null);
    };
  }, [tabId, blank, placed, modalOpen, placementKey]);
  // A finished animation re-measures in place; it never parks and re-places,
  // which would blink the page.
  useEffect(() => {
    remeasure.current?.();
  }, [stillness]);

  const label = tab.title || tab.url.replace(/^https?:\/\//, "");
  const agentAt = tab.heldBy && tab.heldBy !== "you" ? tab.heldBy : null;
  const peek = !face;
  const rest = { x: -DECK_PEEK_X * depth, y: DECK_PEEK_Y * depth };
  const offstage = { x: -DECK_PEEK_X * (depth + 1), y: DECK_PEEK_Y * (depth + 1) };
  const spring = { type: "spring" as const, stiffness: 520, damping: 36, mass: 0.7 };
  const shuffle = {
    duration: 0.44,
    ease: [0.2, 0.8, 0.2, 1] as const,
    times: [0, 0.42, 1],
  };
  const animate = reduce
    ? { opacity: 1, ...rest, transition: { duration: 0 } }
    : goingBack
      ? {
          opacity: 1,
          x: [null, rest.x - 30, rest.x],
          y: [null, rest.y + 28, rest.y],
          transition: shuffle,
        }
      : { opacity: 1, ...rest, transition: spring };
  const exitTo = reduce
    ? { opacity: 0, transition: { duration: 0 } }
    : {
        opacity: 0,
        x: offstage.x - 8,
        y: offstage.y + 8,
        transition: { duration: 0.24, ease: [0.2, 0, 0, 1] as const },
      };

  return (
    <motion.div
      className="browser-deck-card"
      data-depth={depth}
      data-peek={peek ? "true" : undefined}
      data-live={placed ? "true" : undefined}
      data-busy={agentAt ? "true" : undefined}
      initial={reduce ? false : { opacity: 0, ...offstage }}
      animate={animate}
      exit={exitTo}
      whileHover={peek && !reduce ? { y: rest.y - 3 } : undefined}
      onAnimationStart={onMove}
      onAnimationComplete={onArrive}
      onClick={peek ? onPromote : undefined}
      aria-label={peek ? `Bring ${label} to the front` : undefined}
      role={peek ? "button" : undefined}
    >
      <div
        className="browser-deck-bar"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
        onWheel={onHeaderWheel}
        onDoubleClick={
          face
            ? (event) => {
                if (isHeaderControl(event.target)) return;
                onExpand(tab.id);
              }
            : undefined
        }
      >
        {/* On a peeked card only this column shows past the face: its icon is
            what says which site is waiting there. */}
        <span className="browser-deck-mark" aria-hidden="true">
          <TabFavicon src={tab.favicon} />
        </span>
        <span className="browser-deck-title" title={tab.url}>
          {label}
        </span>
        {agentAt ? (
          <span className="browser-deck-who" title={`${agentAt} is working in this tab`}>
            <i aria-hidden="true" />
            {agentAt}
          </span>
        ) : null}
        {face ? (
          <div className="browser-deck-actions">
            <Tooltip label="Open in the pane" hint="Double-click the title" placement="top">
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
        ) : null}
      </div>
      <div className="browser-deck-page" ref={face ? pageRef : undefined}>
        {!blank && poster ? <img className="browser-deck-poster" src={poster} alt="" /> : null}
        {blank ? <span className="browser-deck-empty">Empty tab</span> : null}
        {face && !placed && !blank ? (
          <span className="browser-deck-veil" aria-hidden="true" />
        ) : null}
      </div>
    </motion.div>
  );
}
