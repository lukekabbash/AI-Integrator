import { describe, expect, it } from "vitest";

import {
  activateSurface,
  browserSurface,
  closeAllSurfaces,
  closeOtherSurfaces,
  closeSurface,
  closeSurfacesToRight,
  createWorkPaneState,
  fileSurface,
  openSurface,
  parseWorkPane,
  pruneSurfaces,
  reorderSurfaces,
  REVIEW_SURFACE,
  serializeWorkPane,
  setPaneWidth,
  subagentSurface,
  surfaceFileName,
  togglePane,
  WORK_PANE_MIN_WIDTH,
} from "./workPaneModel";

describe("workPaneModel", () => {
  it("opens surfaces without duplicating, activates the newest, and shows the pane", () => {
    let state = createWorkPaneState();
    state = openSurface(state, fileSurface("src/a.ts"));
    state = openSurface(state, REVIEW_SURFACE);
    state = openSurface(state, fileSurface("src/a.ts", 42));
    expect(state.surfaces.map((s) => s.id)).toEqual(["file:src/a.ts", "review"]);
    expect(state.activeId).toBe("file:src/a.ts");
    expect(state.open).toBe(true);
    const file = state.surfaces[0];
    expect(file.kind === "file" && file.revealLine).toBe(42);
    expect(file.kind === "file" && file.revealRequestId).toBe(1);
  });

  it("can open in the background without stealing focus or showing the pane", () => {
    let state = openSurface(createWorkPaneState(), fileSurface("a"));
    state = togglePane(state, false);
    state = openSurface(state, subagentSurface("d1"), { activate: false, show: false });
    expect(state.activeId).toBe("file:a");
    expect(state.open).toBe(false);
    expect(state.surfaces).toHaveLength(2);
  });

  it("closing the active tab activates the right neighbour, then the left", () => {
    let state = createWorkPaneState();
    for (const path of ["a", "b", "c"]) state = openSurface(state, fileSurface(path));
    state = activateSurface(state, "file:b");
    state = closeSurface(state, "file:b");
    expect(state.activeId).toBe("file:c");
    state = closeSurface(state, "file:c");
    expect(state.activeId).toBe("file:a");
    state = closeSurface(state, "file:a");
    expect(state.activeId).toBeNull();
    expect(state.open).toBe(true);
  });

  it("supports close others, close to the right, and close all (pane stays open for the launcher)", () => {
    let state = createWorkPaneState();
    for (const path of ["a", "b", "c", "d"]) state = openSurface(state, fileSurface(path));
    expect(closeSurfacesToRight(state, "file:b").surfaces.map((s) => s.id)).toEqual([
      "file:a",
      "file:b",
    ]);
    expect(closeSurfacesToRight(state, "file:b").activeId).toBe("file:b");
    expect(closeOtherSurfaces(state, "file:c").surfaces.map((s) => s.id)).toEqual(["file:c"]);
    const emptied = closeAllSurfaces(state);
    expect(emptied.surfaces).toEqual([]);
    expect(emptied.open).toBe(true);
  });

  it("reorders, clamps width, and prunes surfaces whose backing object vanished", () => {
    let state = createWorkPaneState();
    state = openSurface(state, fileSurface("a"));
    state = openSurface(state, browserSurface("t1"));
    state = openSurface(state, subagentSurface("d1"));
    state = reorderSurfaces(state, 2, 0);
    expect(state.surfaces.map((s) => s.kind)).toEqual(["subagent", "file", "browser"]);
    expect(setPaneWidth(state, 10).width).toBe(WORK_PANE_MIN_WIDTH);
    const pruned = pruneSurfaces(state, (surface) => surface.kind !== "subagent");
    expect(pruned.surfaces.map((s) => s.kind)).toEqual(["file", "browser"]);
    expect(pruned.activeId).toBe("browser:t1");
  });

  it("round-trips through storage but drops browser tabs and rejects junk", () => {
    let state = createWorkPaneState();
    state = openSurface(state, fileSurface("src/a.ts", 7));
    state = openSurface(state, browserSurface("t1"));
    state = openSurface(state, subagentSurface("d1"));
    state = openSurface(state, REVIEW_SURFACE);
    state = activateSurface(state, "browser:t1");
    const restored = parseWorkPane(serializeWorkPane({ task1: state }));
    expect(restored.task1.surfaces.map((s) => s.id)).toEqual([
      "file:src/a.ts",
      "subagent:d1",
      "review",
    ]);
    // Active browser tab was dropped, so the first remaining tab is active.
    expect(restored.task1.activeId).toBe("file:src/a.ts");
    expect(restored.task1.open).toBe(true);
    expect(parseWorkPane("nope")).toEqual({});
    expect(
      parseWorkPane(
        JSON.stringify({ version: 1, byTask: { t: { surfaces: [{ kind: "file", id: "x" }] } } }),
      ).t.surfaces,
    ).toEqual([]);
  });

  it("names files by their last segment on either separator", () => {
    expect(surfaceFileName("apps/desktop/src/App.tsx")).toBe("App.tsx");
    expect(surfaceFileName("C:\\Code\\a\\b.rs")).toBe("b.rs");
  });
});
