import type { BrowserTab } from "../bridge";

/** How many cards peek behind the front face. Native pages cannot overlap, so
 *  only the front card is live; the rest are stills. */
export const MAX_DECK_PEEK = 2;
/** Peek offset of each card behind the face. Motion and CSS share these. The
 *  sideways peek is wide enough to show each card's favicon in its own column,
 *  so the pile reads as "these sites" and not just "some more". */
export const DECK_PEEK_X = 26;
export const DECK_PEEK_Y = 10;

/**
 * Keeps the deck's order current as tabs come and go.
 *
 * `order` lists tab ids oldest-first; the last id is the front card. A tab
 * that has just arrived goes to the end so it is on top at once — when closing
 * the whole pane adds several, its active browser lands last. Tabs that left
 * are dropped; the relative order of the rest is untouched, so cycling by hand
 * survives title and loading updates.
 */
export function resolveDeckOrder(
  tabs: BrowserTab[],
  order: readonly string[],
  preferredTabId: string | null,
): string[] {
  const present = new Set(tabs.map((tab) => tab.id));
  const known = new Set(order);
  const kept = order.filter((id) => present.has(id));
  const added = tabs.filter((tab) => !known.has(tab.id)).map((tab) => tab.id);
  if (preferredTabId && added.includes(preferredTabId)) {
    added.splice(added.indexOf(preferredTabId), 1);
    added.push(preferredTabId);
  }
  return [...kept, ...added];
}

/** Moves one card to the front of the deck. */
export function promoteDeckTab(order: readonly string[], tabId: string): string[] {
  if (order.at(-1) === tabId) return [...order];
  return [...order.filter((id) => id !== tabId), tabId];
}

/** Rotates the deck: next brings the card immediately behind to the front;
 *  previous brings the back of the pile forward. */
export function cycleDeck(order: readonly string[], direction: "next" | "prev"): string[] {
  if (order.length < 2) return [...order];
  if (direction === "next") {
    const front = order[order.length - 1];
    return front === undefined ? [...order] : [front, ...order.slice(0, -1)];
  }
  const [first, ...rest] = order;
  return first === undefined ? [...order] : [...rest, first];
}

/** Where the deck sits, as its distance from the window's bottom-right corner. */
export interface DeckOffset {
  right: number;
  bottom: number;
}

/** The main window's title bar; the deck never slides under it. */
const DECK_TOP_INSET = 50;

/** Keeps the whole deck on screen for a deck of this size. */
export function clampDeckOffset(
  offset: DeckOffset,
  deckSize: { width: number; height: number },
  viewport: { width: number; height: number },
): DeckOffset {
  const maxRight = Math.max(0, viewport.width - deckSize.width);
  const maxBottom = Math.max(0, viewport.height - DECK_TOP_INSET - deckSize.height);
  return {
    right: Math.min(Math.max(0, offset.right), maxRight),
    bottom: Math.min(Math.max(0, offset.bottom), maxBottom),
  };
}

/** A screen rectangle in viewport (CSS pixel) coordinates. */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Room the deck keeps between itself and a live page it has slid off. */
export const DECK_SETTLE_GAP = 12;

/** The rectangle a deck of this size occupies at this offset. */
export function deckRect(
  offset: DeckOffset,
  deckSize: { width: number; height: number },
  viewport: { width: number; height: number },
): ScreenRect {
  const right = viewport.width - offset.right;
  const bottom = viewport.height - offset.bottom;
  return { left: right - deckSize.width, top: bottom - deckSize.height, right, bottom };
}

function overlaps(a: ScreenRect, b: ScreenRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function overlapsAny(rect: ScreenRect, obstacles: readonly ScreenRect[]): boolean {
  return obstacles.some((obstacle) => overlaps(rect, obstacle));
}

/**
 * Where the deck comes to rest once it is let go.
 *
 * The deck is HTML and a live page in the pane is a native webview: nothing
 * in CSS can paint the cards over that page, so a deck dropped on it would
 * lose its title strip and arrows under the page. Rather than park the page
 * for as long as the deck sits there, the deck slides to the nearest spot
 * beside the page — the smallest move that clears every live page and stays
 * on screen. Anywhere else (the transcript, the rails, the sidebar) it stays
 * exactly where it was dropped. When no move clears the page (the page fills
 * the window), the offset is only clamped; the pane's own parking handles the
 * rest.
 */
export function settleDeckOffset(
  offset: DeckOffset,
  deckSize: { width: number; height: number },
  viewport: { width: number; height: number },
  obstacles: readonly ScreenRect[],
): DeckOffset {
  const clamped = clampDeckOffset(offset, deckSize, viewport);
  const live = obstacles.filter(
    (rect) => rect.right > rect.left && rect.bottom > rect.top,
  );
  if (!live.length || !overlapsAny(deckRect(clamped, deckSize, viewport), live)) {
    return clamped;
  }
  const gap = DECK_SETTLE_GAP;
  // Slide left of the page, right of it, above it, below it.
  const candidates = live.flatMap((rect) => [
    { right: viewport.width - (rect.left - gap), bottom: clamped.bottom },
    { right: viewport.width - (rect.right + gap) - deckSize.width, bottom: clamped.bottom },
    { right: clamped.right, bottom: viewport.height - (rect.top - gap) },
    { right: clamped.right, bottom: viewport.height - (rect.bottom + gap) - deckSize.height },
  ]);
  let best: DeckOffset | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const next = clampDeckOffset(candidate, deckSize, viewport);
    if (overlapsAny(deckRect(next, deckSize, viewport), live)) continue;
    const distance = Math.hypot(next.right - clamped.right, next.bottom - clamped.bottom);
    if (distance < bestDistance) {
      best = next;
      bestDistance = distance;
    }
  }
  return best ?? clamped;
}

export interface DeckStack {
  /** The face: the only card whose native page is on screen. */
  front: BrowserTab | null;
  /** Cards immediately under the face, deepest first, for the peek. */
  behind: BrowserTab[];
}

export function stackDeck(tabs: BrowserTab[], order: readonly string[]): DeckStack {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ordered = order.flatMap((id) => {
    const tab = byId.get(id);
    return tab ? [tab] : [];
  });
  const front = ordered.at(-1) ?? null;
  if (!front) return { front: null, behind: [] };
  const start = Math.max(0, ordered.length - 1 - MAX_DECK_PEEK);
  return { front, behind: ordered.slice(start, -1) };
}
