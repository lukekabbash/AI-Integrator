/**
 * Where a browser tab has been. Recents are a convenience for the blank-tab
 * start page, kept in localStorage alongside the other renderer-local
 * preferences: never synced, never sent anywhere, and safe to lose.
 */

import { backfillBookmarkFavicon } from "./browserBookmarks";
import { notifyBrowserPlaces } from "./browserPlaces";

const RECENTS_KEY = "aiintegrator.browser-recents.v1";
const RECENTS_LIMIT = 8;

export interface BrowserRecent {
  url: string;
  title: string;
  favicon?: string;
  at: number;
}

export function readBrowserRecents(): BrowserRecent[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENTS_KEY) ?? "[]") as BrowserRecent[];
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry?.url === "string") : [];
  } catch {
    return [];
  }
}

export function rememberBrowserVisit(url: string, title: string, favicon?: string): void {
  if (typeof window === "undefined" || !url || url === "about:blank") return;
  const current = readBrowserRecents();
  // The icon usually lands a beat after the page: keep the one already
  // remembered rather than blanking it on the earlier, icon-less report.
  const kept = favicon ?? current.find((entry) => entry.url === url)?.favicon;
  const next = [
    { url, title, favicon: kept, at: Date.now() },
    ...current.filter((entry) => entry.url !== url),
  ].slice(0, RECENTS_LIMIT);
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    notifyBrowserPlaces();
  } catch {
    // Recents are a convenience; losing them is not worth an error.
  }
  if (favicon) backfillBookmarkFavicon(url, favicon);
}
