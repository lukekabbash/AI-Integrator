/**
 * Where a browser tab has been. Recents are a convenience for the blank-tab
 * start page, kept in localStorage alongside the other renderer-local
 * preferences: never synced, never sent anywhere, and safe to lose.
 */

const RECENTS_KEY = "aiintegrator.browser-recents.v1";
const RECENTS_LIMIT = 8;

export interface BrowserRecent {
  url: string;
  title: string;
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

export function rememberBrowserVisit(url: string, title: string): void {
  if (typeof window === "undefined" || !url || url === "about:blank") return;
  const next = [
    { url, title, at: Date.now() },
    ...readBrowserRecents().filter((entry) => entry.url !== url),
  ].slice(0, RECENTS_LIMIT);
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Recents are a convenience; losing them is not worth an error.
  }
}
