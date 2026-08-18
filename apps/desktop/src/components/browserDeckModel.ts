import type { BrowserTab } from "../bridge";

/** Live cards drawn in the column before the rest become named strips. */
export const MAX_LIVE_DECK_CARDS = 4;

/**
 * Keeps the deck's promotion order current as tabs come and go.
 *
 * `order` lists tab ids oldest-first; the last `MAX_LIVE_DECK_CARDS` are the
 * live cards, everything before them a strip. A tab that has just arrived goes
 * to the end so it is live at once — when closing the whole pane adds several,
 * its active browser lands last so it is the one nearest the corner. Tabs that
 * left are dropped; the relative order of the rest is untouched, so promoting a
 * strip by hand survives title and loading updates.
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

/** Moves one strip to the end of the order, making it a live card. */
export function promoteDeckTab(order: readonly string[], tabId: string): string[] {
  if (order.at(-1) === tabId) return [...order];
  return [...order.filter((id) => id !== tabId), tabId];
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

export interface DeckSplit {
  /** Oldest first; drawn top to bottom, newest nearest the corner. */
  live: BrowserTab[];
  /** Named strips above the live column, oldest first. */
  strips: BrowserTab[];
}

export function splitDeck(
  tabs: BrowserTab[],
  order: readonly string[],
  maxLive = MAX_LIVE_DECK_CARDS,
): DeckSplit {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ordered = order.flatMap((id) => {
    const tab = byId.get(id);
    return tab ? [tab] : [];
  });
  const cut = Math.max(0, ordered.length - maxLive);
  return { strips: ordered.slice(0, cut), live: ordered.slice(cut) };
}
