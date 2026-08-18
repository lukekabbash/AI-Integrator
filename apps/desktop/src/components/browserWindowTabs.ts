import type { BrowserTab } from "../bridge";

/** A newly popped tab takes focus; ordinary state refreshes keep the current one. */
export function nextPoppedTabId(
  current: string | null,
  previousIds: ReadonlySet<string>,
  tabs: Pick<BrowserTab, "id">[],
): string | null {
  const added = tabs.find((tab) => !previousIds.has(tab.id));
  if (added) return added.id;
  if (current && tabs.some((tab) => tab.id === current)) return current;
  return tabs[0]?.id ?? null;
}

/** What a tab is called in the strip and the window title. */
export function tabLabel(tab: Pick<BrowserTab, "title" | "url">): string {
  return tab.title || tab.url.replace(/^https?:\/\//, "") || "New tab";
}

/** Ctrl+Tab / Ctrl+Shift+Tab: the neighbour, wrapping at either end. */
export function cycledTabId(
  current: string | null,
  tabs: Pick<BrowserTab, "id">[],
  step: 1 | -1,
): string | null {
  if (tabs.length === 0) return null;
  const index = tabs.findIndex((tab) => tab.id === current);
  return tabs[(index + step + tabs.length) % tabs.length].id;
}

/** Ctrl+1..8 pick that tab; Ctrl+9 picks the last, as browsers do. */
export function jumpedTabId(digit: number, tabs: Pick<BrowserTab, "id">[]): string | null {
  if (tabs.length === 0) return null;
  const target = digit === 9 ? tabs[tabs.length - 1] : tabs[digit - 1];
  return target?.id ?? null;
}

/** Which task a new tab opens under from the chat window: the page in front's,
 *  else the last one seen here, else the task the window was opened for. */
export function taskIdForNewTab(
  activeTaskId: string | null | undefined,
  lastKnownTaskId: string | null,
  urlTaskId: string | null,
): string | null {
  return activeTaskId ?? lastKnownTaskId ?? urlTaskId;
}
