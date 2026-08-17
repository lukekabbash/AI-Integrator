import { describe, expect, it } from "vitest";

import type { BrowserTab } from "../bridge";
import { adjacentDeckTabId, resolveDeckRaisedId } from "./browserDeckModel";

function tab(id: string, url = `https://example.com/${id}`): BrowserTab {
  return { id, url } as BrowserTab;
}

describe("browser deck selection", () => {
  it("raises the exact tab newly removed from the pane", () => {
    expect(
      resolveDeckRaisedId([tab("already"), tab("closed")], new Set(["already"]), "already", null),
    ).toBe("closed");
  });

  it("raises the active browser when closing the whole pane adds several cards", () => {
    expect(resolveDeckRaisedId([tab("one"), tab("two")], new Set(), null, "one")).toBe("one");
  });

  it("keeps an explicit card choice and avoids a blank fallback", () => {
    const tabs = [tab("page"), tab("blank", "about:blank")];
    expect(resolveDeckRaisedId(tabs, new Set(["page", "blank"]), "page", null)).toBe("page");
    expect(resolveDeckRaisedId(tabs, new Set(["page", "blank"]), null, null)).toBe("page");
    expect(resolveDeckRaisedId(tabs, new Set(), null, null)).toBe("page");
  });

  it("cycles in both directions and wraps", () => {
    const tabs = [tab("one"), tab("two"), tab("three")];
    expect(adjacentDeckTabId(tabs, "one", -1)).toBe("three");
    expect(adjacentDeckTabId(tabs, "three", 1)).toBe("one");
  });
});
