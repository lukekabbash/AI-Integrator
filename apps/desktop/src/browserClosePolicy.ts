import type { BrowserTab } from "./bridge";

/** A native close request remains the source of truth; this keeps labels and
 * controls in step with the same deadline without polling the browser. */
export function browserTabNeedsAgentProtection(tab: BrowserTab, now = Date.now()): boolean {
  return (tab.agentProtectedUntil ?? 0) > now;
}
