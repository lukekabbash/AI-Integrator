/**
 * Site icons the renderer has already seen, keyed by host.
 *
 * A bookmark made from a local server, or from a page whose icon had not
 * arrived yet, has no icon of its own — but the same host has usually shown one
 * somewhere: a recent visit, another bookmark, the tab that is open now. This
 * looks it up so a tile never wears the globe when the site's mark is known.
 */

import { readBrowserBookmarks } from "./browserBookmarks";
import { readBrowserRecents } from "./browserRecents";

export function hostKey(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The best known icon for a page's host, or undefined. */
export function knownFaviconFor(url: string, extra?: { url: string; favicon?: string }[]): string | undefined {
  const host = hostKey(url);
  if (!host) return undefined;
  const sources = [
    ...(extra ?? []),
    ...readBrowserRecents(),
    ...readBrowserBookmarks(),
  ];
  for (const entry of sources) {
    if (entry.favicon && hostKey(entry.url) === host) return entry.favicon;
  }
  return undefined;
}

/**
 * Icons for a list of places, filling gaps from what the host is known to
 * wear. Same length, same order; entries that already carry an icon keep it.
 */
export function withKnownFavicons<T extends { url: string; favicon?: string }>(places: T[]): T[] {
  if (places.every((place) => place.favicon)) return places;
  const byHost = new Map<string, string>();
  const learn = (entry: { url: string; favicon?: string }) => {
    const host = entry.favicon ? hostKey(entry.url) : null;
    if (host && !byHost.has(host)) byHost.set(host, entry.favicon as string);
  };
  places.forEach(learn);
  readBrowserRecents().forEach(learn);
  readBrowserBookmarks().forEach(learn);
  return places.map((place) => {
    if (place.favicon) return place;
    const host = hostKey(place.url);
    const favicon = host ? byHost.get(host) : undefined;
    return favicon ? { ...place, favicon } : place;
  });
}
