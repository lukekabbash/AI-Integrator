import { describe, expect, it } from "vitest";

import { nextPoppedTabId } from "./browserWindowTabs";

describe("nextPoppedTabId", () => {
  it("selects the tab that just arrived in an existing pop-out window", () => {
    expect(nextPoppedTabId("tab-a", new Set(["tab-a"]), [{ id: "tab-a" }, { id: "tab-b" }])).toBe(
      "tab-b",
    );
  });

  it("keeps the current tab during ordinary state refreshes", () => {
    expect(
      nextPoppedTabId("tab-b", new Set(["tab-a", "tab-b"]), [{ id: "tab-a" }, { id: "tab-b" }]),
    ).toBe("tab-b");
  });

  it("falls back when the active tab docks or closes", () => {
    expect(nextPoppedTabId("tab-b", new Set(["tab-a", "tab-b"]), [{ id: "tab-a" }])).toBe("tab-a");
  });
});
