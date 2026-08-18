import { describe, expect, it } from "vitest";

import type { BrowserTab } from "./bridge";
import { browserTabNeedsAgentProtection } from "./browserClosePolicy";

const TAB: BrowserTab = {
  id: "tab-1",
  taskId: "task-1",
  groupId: "project:test",
  groupName: "Test project",
  groupKind: "project",
  url: "https://example.com",
  title: "Example",
  loading: false,
  poppedOut: false,
  hidden: false,
  sleeping: false,
};

describe("browserTabNeedsAgentProtection", () => {
  it("protects only a future native agent-use deadline", () => {
    expect(browserTabNeedsAgentProtection(TAB, 1_000)).toBe(false);
    expect(browserTabNeedsAgentProtection({ ...TAB, agentProtectedUntil: 1_001 }, 1_000)).toBe(
      true,
    );
    expect(browserTabNeedsAgentProtection({ ...TAB, agentProtectedUntil: 1_000 }, 1_000)).toBe(
      false,
    );
  });
});
