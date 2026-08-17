import type { BrowserTab } from "../bridge";

/**
 * Chooses the one live page the corner deck raises.
 *
 * A tab that has just left the pane wins. When closing the whole pane adds
 * several cards at once, its active browser wins instead. After that, a
 * person's explicit card choice remains stable across title/loading updates.
 */
export function resolveDeckRaisedId(
  tabs: BrowserTab[],
  knownIds: ReadonlySet<string>,
  raisedId: string | null,
  preferredTabId: string | null,
): string | null {
  if (tabs.length === 0) return null;

  const added = tabs.filter((tab) => !knownIds.has(tab.id));
  if (preferredTabId && added.some((tab) => tab.id === preferredTabId)) {
    return preferredTabId;
  }
  let newestAdded = added.at(-1);
  if (added.length > 1 && newestAdded?.url === "about:blank") {
    for (let index = added.length - 2; index >= 0; index -= 1) {
      const candidate = added[index];
      if (candidate?.url && candidate.url !== "about:blank") {
        newestAdded = candidate;
        break;
      }
    }
  }
  if (newestAdded) return newestAdded.id;
  if (raisedId && tabs.some((tab) => tab.id === raisedId)) return raisedId;
  if (preferredTabId && tabs.some((tab) => tab.id === preferredTabId)) return preferredTabId;

  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    const tab = tabs[index];
    if (tab?.url && tab.url !== "about:blank") return tab.id;
  }
  return tabs.at(-1)?.id ?? null;
}

export function adjacentDeckTabId(
  tabs: BrowserTab[],
  raisedId: string,
  direction: -1 | 1,
): string | null {
  if (tabs.length < 2) return null;
  const currentIndex = tabs.findIndex((tab) => tab.id === raisedId);
  const start = currentIndex < 0 ? 0 : currentIndex;
  return tabs[(start + direction + tabs.length) % tabs.length]?.id ?? null;
}
