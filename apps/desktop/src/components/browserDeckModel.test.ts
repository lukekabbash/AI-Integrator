import { describe, expect, it } from "vitest";

import type { BrowserTab } from "../bridge";
import {
  cycleDeck,
  deckRect,
  promoteDeckTab,
  resolveDeckOrder,
  settleDeckOffset,
  stackDeck,
} from "./browserDeckModel";

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
    expect(resolveDeckOrder([tab("a"), tab("b")], promoted, null)).toEqual(["b", "a"]);
    expect(resolveDeckOrder([tab("a"), tab("c")], promoted, null)).toEqual(["a", "c"]);
  });

  it("puts the pane's active browser on the front when several arrive", () => {
    const order = resolveDeckOrder([tab("a"), tab("b"), tab("c")], [], "b");
    expect(order).toEqual(["a", "c", "b"]);
    expect(stackDeck([tab("a"), tab("b"), tab("c")], order).front?.id).toBe("b");
  });

  it("stacks only a short peek behind the live face", () => {
    const tabs = ["a", "b", "c", "d", "e", "f"].map(tab);
    const { front, behind } = stackDeck(tabs, ["a", "b", "c", "d", "e", "f"]);
    expect(front?.id).toBe("f");
    expect(behind.map((item) => item.id)).toEqual(["d", "e"]);
  });

  it("cycles the face forward and back without dropping cards", () => {
    expect(cycleDeck(["a", "b", "c"], "next")).toEqual(["c", "a", "b"]);
    expect(cycleDeck(["c", "a", "b"], "prev")).toEqual(["a", "b", "c"]);
    expect(cycleDeck(["a"], "next")).toEqual(["a"]);
  });

  describe("settleDeckOffset", () => {
    const size = { width: 300, height: 200 };
    const viewport = { width: 1000, height: 800 };
    const page = { left: 200, top: 300, right: 600, bottom: 700 };

    it("leaves a deck alone when it is clear of every live page", () => {
      expect(settleDeckOffset({ right: 18, bottom: 18 }, size, viewport, [page])).toEqual({
        right: 18,
        bottom: 18,
      });
      expect(settleDeckOffset({ right: 500, bottom: 500 }, size, viewport, [])).toEqual({
        right: 500,
        bottom: 500,
      });
    });

    it("makes the smallest move that clears the page", () => {
      // Deck at x 250..550 sits inside the page's columns; the way out is
      // sideways, and the right edge (612) is nearer than the left (188).
      const settled = settleDeckOffset({ right: 450, bottom: 18 }, size, viewport, [page]);
      expect(deckRect(settled, size, viewport)).toEqual({
        left: 612,
        top: 582,
        right: 912,
        bottom: 782,
      });
      // Nudged just past the top edge instead when that is the shorter trip.
      const above = settleDeckOffset({ right: 450, bottom: 480 }, size, viewport, [page]);
      expect(deckRect(above, size, viewport).bottom).toBe(288);
    });

    it("only clamps when nothing beside the page fits on screen", () => {
      const wall = { left: 0, top: 0, right: 1000, bottom: 800 };
      expect(settleDeckOffset({ right: -40, bottom: 5000 }, size, viewport, [wall])).toEqual({
        right: 0,
        bottom: 550,
      });
    });
  });
});
