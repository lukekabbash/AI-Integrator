import { describe, expect, it } from "vitest";

import type { BrowserTab } from "../bridge";
import { promoteDeckTab, resolveDeckOrder, splitDeck } from "./browserDeckModel";

function tab(id: string): BrowserTab {
  return {
    id,
    taskId: "task-1",
    url: `https://example.com/${id}`,
    title: id,
    loading: false,
    poppedOut: false,
    hidden: true,
    sleeping: false,
  } as BrowserTab;
}

describe("browserDeckModel", () => {
  it("appends new tabs, drops departed ones, and keeps the rest in place", () => {
    const first = resolveDeckOrder([tab("a"), tab("b")], [], null);
    expect(first).toEqual(["a", "b"]);
    const promoted = promoteDeckTab(first, "a");
    expect(promoted).toEqual(["b", "a"]);
    // A title update rerenders with the same tabs: nothing moves.
    expect(resolveDeckOrder([tab("a"), tab("b")], promoted, null)).toEqual(["b", "a"]);
    // A new arrival lands last; a departure just disappears.
    expect(resolveDeckOrder([tab("a"), tab("c")], promoted, null)).toEqual(["a", "c"]);
  });

  it("puts the pane's active browser nearest the corner when several arrive", () => {
    const order = resolveDeckOrder([tab("a"), tab("b"), tab("c")], [], "b");
    expect(order).toEqual(["a", "c", "b"]);
  });

  it("splits the order into live cards and strips", () => {
    const tabs = ["a", "b", "c", "d", "e", "f"].map(tab);
    const { live, strips } = splitDeck(tabs, ["a", "b", "c", "d", "e", "f"]);
    expect(live.map((item) => item.id)).toEqual(["c", "d", "e", "f"]);
    expect(strips.map((item) => item.id)).toEqual(["a", "b"]);
  });
});
