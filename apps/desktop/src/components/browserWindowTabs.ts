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
