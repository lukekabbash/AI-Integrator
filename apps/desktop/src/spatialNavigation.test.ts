// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  arrowIntent,
  cellIndexOf,
  entryCell,
  expandedState,
  focusRegion,
  isTypeaheadKey,
  navCells,
  parentIndex,
  stepIndex,
  typeaheadIndex,
} from "./spatialNavigation";

describe("arrowIntent", () => {
  it("maps the vertical axis to movement and the cross axis to depth", () => {
    expect(arrowIntent("ArrowDown", "vertical")).toBe("next");
    expect(arrowIntent("ArrowUp", "vertical")).toBe("previous");
    expect(arrowIntent("ArrowRight", "vertical")).toBe("expand");
    expect(arrowIntent("ArrowLeft", "vertical")).toBe("collapse");
  });

  it("moves along a strip with Left and Right and ignores the cross axis", () => {
    expect(arrowIntent("ArrowRight", "horizontal")).toBe("next");
    expect(arrowIntent("ArrowLeft", "horizontal")).toBe("previous");
    expect(arrowIntent("ArrowDown", "horizontal")).toBe(null);
    expect(arrowIntent("ArrowUp", "horizontal")).toBe(null);
  });

  it("takes Home and End on either axis and passes everything else through", () => {
    expect(arrowIntent("Home", "horizontal")).toBe("first");
    expect(arrowIntent("End", "vertical")).toBe("last");
    expect(arrowIntent("Enter", "vertical")).toBe(null);
    expect(arrowIntent("Tab", "vertical")).toBe(null);
  });
});

describe("stepIndex", () => {
  it("walks the list", () => {
    expect(stepIndex(0, 4, "next", true)).toBe(1);
    expect(stepIndex(2, 4, "previous", true)).toBe(1);
    expect(stepIndex(2, 4, "first", true)).toBe(0);
    expect(stepIndex(1, 4, "last", true)).toBe(3);
  });

  it("wraps at the ends when wrapping is on", () => {
    expect(stepIndex(3, 4, "next", true)).toBe(0);
    expect(stepIndex(0, 4, "previous", true)).toBe(3);
  });

  it("declines the move at the ends when wrapping is off", () => {
    expect(stepIndex(3, 4, "next", false)).toBe(-1);
    expect(stepIndex(0, 4, "previous", false)).toBe(-1);
  });

  it("enters from the edge the key points away from", () => {
    expect(stepIndex(-1, 4, "next", false)).toBe(0);
    expect(stepIndex(-1, 4, "previous", false)).toBe(3);
  });

  it("declines everything in an empty region", () => {
    expect(stepIndex(-1, 0, "next", true)).toBe(-1);
    expect(stepIndex(-1, 0, "first", true)).toBe(-1);
  });
});

describe("typeaheadIndex", () => {
  const labels = ["Alpha", "Bravo", "Charlie", "Bronze"];

  it("finds the next match after the cursor and wraps once", () => {
    expect(typeaheadIndex(labels, 0, "b")).toBe(1);
    expect(typeaheadIndex(labels, 1, "b")).toBe(3);
    expect(typeaheadIndex(labels, 3, "b")).toBe(1);
  });

  it("matches a multi-letter prefix, case and padding insensitively", () => {
    expect(typeaheadIndex(labels, 0, "bro")).toBe(3);
    expect(typeaheadIndex(labels, 0, "  CHAR ")).toBe(2);
  });

  it("returns -1 for no match or an empty query", () => {
    expect(typeaheadIndex(labels, 0, "z")).toBe(-1);
    expect(typeaheadIndex(labels, 0, "   ")).toBe(-1);
  });
});

describe("isTypeaheadKey", () => {
  it("takes printable characters only, and never with a modifier", () => {
    expect(isTypeaheadKey("b", false)).toBe(true);
    expect(isTypeaheadKey("7", false)).toBe(true);
    expect(isTypeaheadKey("b", true)).toBe(false);
    expect(isTypeaheadKey(" ", false)).toBe(false);
    expect(isTypeaheadKey("ArrowDown", false)).toBe(false);
  });
});

describe("the DOM contract", () => {
  const mount = (html: string) => {
    document.body.innerHTML = `<div id="root">${html}</div>`;
    return document.getElementById("root")!;
  };

  it("collects cells in document order and locates the focused one", () => {
    const root = mount(`
      <button data-nav-item id="a"></button>
      <div><button data-nav-item id="b"><span id="inner"></span></button></div>
      <button id="not-a-cell"></button>
    `);
    const cells = navCells(root);
    expect(cells.map((cell) => cell.id)).toEqual(["a", "b"]);
    expect(cellIndexOf(cells, document.getElementById("inner"))).toBe(1);
    expect(cellIndexOf(cells, document.getElementById("not-a-cell"))).toBe(-1);
    expect(cellIndexOf(cells, null)).toBe(-1);
  });

  it("skips rows a collapse has hidden or made inert", () => {
    const root = mount(`
      <button data-nav-item id="a"></button>
      <button data-nav-item id="hidden" aria-hidden="true"></button>
      <div inert><button data-nav-item id="inert"></button></div>
      <button data-nav-item id="b"></button>
    `);
    expect(navCells(root).map((cell) => cell.id)).toEqual(["a", "b"]);
  });

  it("reads expansion from either the data attribute or aria-expanded", () => {
    const root = mount(`
      <button data-nav-item id="open" aria-expanded="true"></button>
      <button data-nav-item id="shut" data-nav-expanded="false"></button>
      <button data-nav-item id="leaf"></button>
    `);
    const [open, shut, leaf] = navCells(root);
    expect(expandedState(open)).toBe(true);
    expect(expandedState(shut)).toBe(false);
    expect(expandedState(leaf)).toBe(null);
    expect(expandedState(null)).toBe(null);
  });

  it("climbs from a child to the row that owns it", () => {
    const root = mount(`
      <button data-nav-item data-nav-id="p1" id="p1"></button>
      <button data-nav-item data-nav-parent="p1" id="c1"></button>
      <button data-nav-item id="loose"></button>
    `);
    const cells = navCells(root);
    expect(parentIndex(cells, 1)).toBe(0);
    expect(parentIndex(cells, 2)).toBe(-1);
  });

  it("enters a region on its active cell, falling back to the first", () => {
    const withActive = mount(`
      <button data-nav-item id="a"></button>
      <button data-nav-item id="b" data-nav-active="true"></button>
    `);
    expect(entryCell(withActive)?.id).toBe("b");
    const withoutActive = mount(`<button data-nav-item id="a"></button>`);
    expect(entryCell(withoutActive)?.id).toBe("a");
    expect(entryCell(mount(""))).toBe(null);
  });
});

describe("focusRegion", () => {
  it("focuses the active cell of the named region", () => {
    document.body.innerHTML = `
      <div data-nav-region="sidebar">
        <button data-nav-item id="a"></button>
        <button data-nav-item id="b" data-nav-active="true"></button>
      </div>`;
    expect(focusRegion("sidebar")).toBe(true);
    expect(document.activeElement?.id).toBe("b");
  });

  it("falls back to the first focusable control when a region has no cells", () => {
    document.body.innerHTML = `
      <div data-nav-region="workPane"><textarea id="entry"></textarea></div>`;
    expect(focusRegion("workPane")).toBe(true);
    expect(document.activeElement?.id).toBe("entry");
  });

  it("declines when the region is not on screen", () => {
    document.body.innerHTML = "";
    expect(focusRegion("transcript")).toBe(false);
  });
});
