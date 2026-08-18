import { describe, expect, it } from "vitest";

import {
  cycledTabId,
  jumpedTabId,
  nextPoppedTabId,
  tabLabel,
  taskIdForNewTab,
} from "./browserWindowTabs";

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

describe("strip helpers", () => {
  const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("cycles with wrap in both directions", () => {
    expect(cycledTabId("a", tabs, 1)).toBe("b");
    expect(cycledTabId("c", tabs, 1)).toBe("a");
    expect(cycledTabId("a", tabs, -1)).toBe("c");
    expect(cycledTabId(null, tabs, 1)).toBe("a");
    expect(cycledTabId("a", [], 1)).toBeNull();
  });

  it("jumps by digit, with 9 meaning the last tab", () => {
    expect(jumpedTabId(2, tabs)).toBe("b");
    expect(jumpedTabId(9, tabs)).toBe("c");
    expect(jumpedTabId(5, tabs)).toBeNull();
  });

  it("names tabs by title, then host, then a placeholder", () => {
    expect(tabLabel({ title: "Docs", url: "https://x.dev" })).toBe("Docs");
    expect(tabLabel({ title: "", url: "https://x.dev/path" })).toBe("x.dev/path");
    expect(tabLabel({ title: "", url: "" })).toBe("New tab");
  });

  it("opens new tabs under the front page's chat, else the last seen, else the URL's", () => {
    expect(taskIdForNewTab("front", "last", "url")).toBe("front");
    expect(taskIdForNewTab(undefined, "last", "url")).toBe("last");
    expect(taskIdForNewTab(undefined, null, "url")).toBe("url");
    expect(taskIdForNewTab(undefined, null, null)).toBeNull();
  });
});
