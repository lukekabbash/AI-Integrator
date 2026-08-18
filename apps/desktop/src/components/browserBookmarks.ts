/**
 * Pages the person pinned. Bookmarks are installation chrome — every task,
 * chat, and pop-out shares one list — and never follow a cookie identity.
 */

import { notifyBrowserPlaces } from "./browserPlaces";

const BOOKMARKS_KEY = "aiintegrator.browser-bookmarks.v1";
const BOOKMARKS_LIMIT = 24;

export interface BrowserBookmark {
  url: string;
  title: string;
  favicon?: string;
  at: number;
}

function isBookmark(value: unknown): value is BrowserBookmark {
  if (!value || typeof value !== "object") return false;
  const entry = value as BrowserBookmark;
  return typeof entry.url === "string" && entry.url.length > 0 && typeof entry.at === "number";
}

export function readBrowserBookmarks(): BrowserBookmark[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(BOOKMARKS_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter(isBookmark).slice(0, BOOKMARKS_LIMIT) : [];
  } catch {
    return [];
  }
}

function write(next: BrowserBookmark[]): void {
  try {
    window.localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(next.slice(0, BOOKMARKS_LIMIT)));
    notifyBrowserPlaces();
  } catch {
    // Bookmarks are a convenience; losing them is not worth an error.
  }
}

export function isBrowserBookmarked(url: string): boolean {
  return Boolean(url) && url !== "about:blank" && readBrowserBookmarks().some((entry) => entry.url === url);
}

export function toggleBrowserBookmark(url: string, title: string, favicon?: string): boolean {
  if (typeof window === "undefined" || !url || url === "about:blank") return false;
  const current = readBrowserBookmarks();
  const existing = current.find((entry) => entry.url === url);
  if (existing) {
    write(current.filter((entry) => entry.url !== url));
    return false;
  }
  write([{ url, title: title || url, favicon, at: Date.now() }, ...current]);
  return true;
}

/**
 * Gives an icon to bookmarks on this page's host that were made before the
 * site had shown one. Bookmarks that already carry an icon are left alone.
 */
export function backfillBookmarkFavicon(url: string, favicon: string): void {
  if (typeof window === "undefined" || !favicon) return;
  const host = hostOfUrl(url);
  if (!host) return;
  const current = readBrowserBookmarks();
  let changed = false;
  const next = current.map((entry) => {
    if (entry.favicon || hostOfUrl(entry.url) !== host) return entry;
    changed = true;
    return { ...entry, favicon };
  });
  if (changed) write(next);
}

function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function removeBrowserBookmark(url: string): void {
  if (typeof window === "undefined") return;
  write(readBrowserBookmarks().filter((entry) => entry.url !== url));
}
