import { describe, expect, it } from "vitest";
import {
  arm,
  cancel,
  drop,
  move,
  target,
  type DragStart,
  type DragState,
  type MoveOptions,
  type StripRect,
} from "./browserTabDrag";

/** Four 100px tabs in a 30px-tall strip: midpoints at 50, 150, 250, 350 and a
 *  vertical centre of 15. */
const STRIP: StripRect[] = [0, 1, 2, 3].map((slot) => ({
  left: slot * 100,
  right: slot * 100 + 100,
  top: 0,
  bottom: 30,
}));

const CLIENT = { width: 800, height: 600 };

function start(overrides: Partial<DragStart> = {}): DragStart {
  return {
    tabId: "tab-b",
    taskId: "task-1",
    groupId: "group-1",
    origin: { kind: "popout", label: "browser-window-abc" },
    index: 1,
    x: 150,
    y: 15,
    ...overrides,
  };
}

function options(overrides: Partial<MoveOptions> = {}): MoveOptions {
  return { stripRects: STRIP, groupSpan: [0, 3], originClient: CLIENT, ...overrides };
}

/** A state the pointer has already dragged into, without walking every move. */
function torn(overrides: Partial<DragState> = {}): DragState {
  return {
    start: start(),
    phase: "torn",
    pointer: { x: 900, y: 400 },
    hoverIndex: null,
    target: null,
    ...overrides,
  };
}

describe("browserTabDrag", () => {
  it("stays armed until the pointer clears the threshold", () => {
    const armed = arm(start());
    expect(armed.phase).toBe("armed");
    expect(armed.pointer).toEqual({ x: 150, y: 15 });

    const nudged = move(armed, 153, 17, options());
    expect(nudged.phase).toBe("armed");
    expect(nudged.pointer).toEqual({ x: 153, y: 17 });
    expect(nudged.hoverIndex).toBeNull();

    expect(move(armed, 156, 15, options()).phase).toBe("dragging");
  });

  it("keeps dragging once started, even back inside the threshold", () => {
    const dragging = move(arm(start()), 156, 15, options());
    expect(move(dragging, 150, 15, options()).phase).toBe("dragging");
  });

  it("tears off past the tear-off distance from the strip's centre", () => {
    const dragging = move(arm(start()), 156, 15, options());
    expect(move(dragging, 156, 54, options()).phase).toBe("dragging");
    expect(move(dragging, 156, 55, options()).phase).toBe("torn");
    // Upwards counts the same.
    expect(move(dragging, 156, -25, options()).phase).toBe("torn");
  });

  it("honours a custom threshold and tear-off distance", () => {
    const armed = arm(start());
    expect(move(armed, 158, 15, options({ threshold: 20 })).phase).toBe("armed");
    const dragging = move(armed, 200, 15, options({ threshold: 20 }));
    expect(dragging.phase).toBe("dragging");
    expect(move(dragging, 200, 30, options({ tearOff: 10 })).phase).toBe("torn");
  });

  it("tears off when the pointer leaves the origin window, strip height or not", () => {
    const dragging = move(arm(start()), 156, 15, options());
    expect(move(dragging, 801, 15, options()).phase).toBe("torn");
    expect(move(dragging, -1, 15, options()).phase).toBe("torn");
    expect(move(dragging, 400, 601, options()).phase).toBe("torn");
    // Without a client rect only the vertical distance tears.
    expect(move(dragging, 801, 15, options({ originClient: undefined })).phase).toBe("dragging");
  });

  it("comes back to dragging, and drops the hit-test target, on re-entry", () => {
    const away = target(move(arm(start()), 156, 300, options()), { kind: "main" });
    expect(away.phase).toBe("torn");
    const back = move(away, 260, 15, options());
    expect(back.phase).toBe("dragging");
    expect(back.target).toBeNull();
    expect(back.hoverIndex).toBe(2);
  });

  it("reads hoverIndex off the strip midpoints, ignoring the dragged tab", () => {
    const dragging = move(arm(start()), 156, 15, options());
    expect(move(dragging, 40, 15, options()).hoverIndex).toBe(0);
    expect(move(dragging, 150, 15, options()).hoverIndex).toBe(1);
    expect(move(dragging, 260, 15, options()).hoverIndex).toBe(2);
    expect(move(dragging, 780, 15, options()).hoverIndex).toBe(3);
  });

  it("clamps hoverIndex to the tab's own group at both ends", () => {
    const dragging = move(arm(start()), 156, 15, options({ groupSpan: [1, 2] }));
    expect(move(dragging, 0, 15, options({ groupSpan: [1, 2] })).hoverIndex).toBe(1);
    expect(move(dragging, 790, 15, options({ groupSpan: [1, 2] })).hoverIndex).toBe(2);
    // A one-tab group cannot move at all.
    expect(move(dragging, 790, 15, options({ groupSpan: [1, 1] })).hoverIndex).toBe(1);
  });

  it("has no hoverIndex without a strip to measure", () => {
    const dragging = move(arm(start()), 156, 15, options({ stripRects: [] }));
    expect(dragging.phase).toBe("dragging");
    expect(dragging.hoverIndex).toBeNull();
  });

  it("replaces the hit-test target as the pointer crosses windows", () => {
    const away = move(arm(start()), 900, 400, options());
    expect(away.target).toBeNull();
    const overMain = target(away, { kind: "main" });
    expect(overMain.target).toEqual({ kind: "main" });
    const overPopout = target(overMain, { kind: "popout", label: "browser-window-z", strip: true });
    expect(overPopout.target).toEqual({ kind: "popout", label: "browser-window-z", strip: true });
    expect(target(overPopout, null).target).toBeNull();
    // Retargeting leaves the rest of the gesture alone.
    expect(overPopout.phase).toBe("torn");
    expect(overPopout.pointer).toEqual({ x: 900, y: 400 });
  });

  describe("drop", () => {
    it("does nothing for a press that never became a drag", () => {
      expect(drop(arm(start()))).toEqual({ kind: "none" });
    });

    it("reorders within the strip", () => {
      const dragging = move(move(arm(start()), 156, 15, options()), 260, 15, options());
      expect(drop(dragging)).toEqual({ kind: "reorder", index: 2 });
    });

    it("does nothing when the tab lands back on its own index", () => {
      const dragging = move(move(arm(start()), 156, 15, options()), 150, 15, options());
      expect(dragging.hoverIndex).toBe(1);
      expect(drop(dragging)).toEqual({ kind: "none" });
    });

    it("moves into a popout, appending when the pointer is off its strip", () => {
      const state = torn({ target: { kind: "popout", label: "browser-window-z", strip: false } });
      expect(drop(state)).toEqual({ kind: "move", label: "browser-window-z" });
    });

    it("moves into a popout's strip at the hovered index", () => {
      const state = torn({
        target: { kind: "popout", label: "browser-window-z", strip: true },
        hoverIndex: 2,
      });
      expect(drop(state)).toEqual({ kind: "move", label: "browser-window-z", index: 2 });
    });

    it("docks on the main window", () => {
      expect(drop(torn({ target: { kind: "main" } }))).toEqual({ kind: "dock" });
    });

    it("tears off at the pointer over nothing", () => {
      expect(drop(torn())).toEqual({ kind: "tearOff", at: { x: 900, y: 400 } });
    });
  });

  it("cancels to nothing from every phase", () => {
    expect(cancel(arm(start()))).toEqual({ kind: "none" });
    expect(cancel(move(arm(start()), 260, 15, options()))).toEqual({ kind: "none" });
    expect(cancel(torn({ target: { kind: "main" } }))).toEqual({ kind: "none" });
  });
});
