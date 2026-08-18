import { useRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { useTabDrag, type UseTabDragOptions } from "./useTabDrag";
import type { HitTarget } from "./browserTabDrag";

const TABS = [
  { id: "tab-a", taskId: "task-1", groupId: "group-1", title: "Alpha" },
  { id: "tab-b", taskId: "task-1", groupId: "group-1", title: "Bravo" },
  { id: "tab-c", taskId: "task-2", groupId: "group-2", title: "Charlie" },
];

/** Four handlers, one strip: the same shape both real strips use. */
function Strip(props: Partial<UseTabDragOptions> & Pick<UseTabDragOptions, "onReorder">) {
  const stripRef = useRef<HTMLDivElement>(null);
  const drag = useTabDrag({
    origin: { kind: "popout", label: "browser-window-a" },
    tabs: TABS,
    stripRef,
    groupSpanFor: () => [0, 1],
    onMove: () => {},
    onDock: () => {},
    onTearOff: () => {},
    ...props,
  });
  return (
    <div>
      <div ref={stripRef} data-testid="strip">
        {TABS.map((tab, index) => (
          <div
            key={tab.id}
            data-testid={tab.id}
            data-traveling-selection={tab.id}
            data-drag-gap={drag.hoverIndex === index ? "before" : undefined}
            {...drag.handlersFor(tab.id, index)}
          >
            <span>{tab.title}</span>
            <button type="button" className="file-reader-tab-close" data-testid={`close-${tab.id}`}>
              x
            </button>
          </div>
        ))}
      </div>
      {drag.ghost}
      <span data-testid="state">{`${drag.dragging}:${drag.draggingTabId}:${drag.hoverIndex}`}</span>
    </div>
  );
}

/** 100px tabs in a 30px strip, so the vertical centre is 15. */
function layOutStrip() {
  TABS.forEach((tab, index) => {
    const element = screen.getByTestId(tab.id);
    element.getBoundingClientRect = () =>
      ({
        left: index * 100,
        right: index * 100 + 100,
        top: 0,
        bottom: 30,
        x: index * 100,
        y: 0,
        width: 100,
        height: 30,
        toJSON: () => ({}),
      }) as DOMRect;
  });
}

function setUp(overrides: Partial<UseTabDragOptions> = {}) {
  const callbacks = {
    onReorder: vi.fn(),
    onMove: vi.fn(),
    onDock: vi.fn(),
    onTearOff: vi.fn(),
  };
  render(<Strip {...callbacks} {...overrides} />);
  layOutStrip();
  return callbacks;
}

/** Press on Bravo, the middle tab, at its centre. */
function pressBravo() {
  const tab = screen.getByTestId("tab-b");
  fireEvent.pointerDown(tab, {
    button: 0,
    pointerId: 1,
    clientX: 150,
    clientY: 15,
    screenX: 350,
    screenY: 215,
  });
  return tab;
}

function movePointer(tab: HTMLElement, clientX: number, clientY: number) {
  fireEvent.pointerMove(tab, {
    pointerId: 1,
    clientX,
    clientY,
    screenX: clientX + 200,
    screenY: clientY + 200,
  });
}

/** Long enough for the throttling frame and the hit test's promise. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

beforeAll(() => {
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
});

describe("useTabDrag", () => {
  it("ignores a press that barely moves", () => {
    const callbacks = setUp();
    const tab = pressBravo();
    movePointer(tab, 152, 16);
    expect(screen.getByTestId("state")).toHaveTextContent("false:null:null");
    expect(document.querySelector(".browser-tab-ghost")).toBeNull();
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 152, clientY: 16 });
    expect(callbacks.onReorder).not.toHaveBeenCalled();
  });

  it("drags and shows a ghost once past the threshold", () => {
    setUp();
    const tab = pressBravo();
    movePointer(tab, 162, 15);
    expect(screen.getByTestId("state")).toHaveTextContent("true:tab-b:1");
    const ghost = document.querySelector(".browser-tab-ghost");
    expect(ghost).not.toBeNull();
    expect(ghost).toHaveTextContent("Bravo");
    expect(document.body.dataset.tabDragging).toBe("true");
  });

  it("reorders when the pointer lets go over another slot", () => {
    const callbacks = setUp({ groupSpanFor: () => [0, 2] });
    const tab = pressBravo();
    movePointer(tab, 260, 15);
    expect(screen.getByTestId("tab-c")).toHaveAttribute("data-drag-gap", "before");
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 260, clientY: 15 });
    expect(callbacks.onReorder).toHaveBeenCalledWith(1, 2);
    expect(document.body.dataset.tabDragging).toBeUndefined();
  });

  it("does nothing when the tab lands back on its own slot", () => {
    const callbacks = setUp();
    const tab = pressBravo();
    movePointer(tab, 162, 15);
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 162, clientY: 15 });
    expect(callbacks.onReorder).not.toHaveBeenCalled();
  });

  it("moves the tab into the popout under the pointer", async () => {
    const hitTest = vi
      .fn<(x: number, y: number) => Promise<HitTarget>>()
      .mockResolvedValue({ kind: "popout", label: "browser-window-z", strip: false });
    const dragEnd = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const callbacks = setUp({ hitTest, dragEnd, groupSpanFor: () => [0, 2] });
    const tab = pressBravo();
    movePointer(tab, 300, 400);
    await settle();
    expect(hitTest).toHaveBeenCalledWith(500, 600);
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 300, clientY: 400 });
    expect(callbacks.onMove).toHaveBeenCalledWith("tab-b", "task-1", "browser-window-z", undefined);
    expect(dragEnd).toHaveBeenCalled();
  });

  it("docks the tab when it lands on the main window", async () => {
    const hitTest = vi
      .fn<(x: number, y: number) => Promise<HitTarget>>()
      .mockResolvedValue({ kind: "main" });
    const callbacks = setUp({ hitTest });
    const tab = pressBravo();
    movePointer(tab, 300, 400);
    await settle();
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 300, clientY: 400 });
    expect(callbacks.onDock).toHaveBeenCalledWith("tab-b", "task-1");
    expect(callbacks.onMove).not.toHaveBeenCalled();
  });

  it("tears the tab off over nothing, at the logical screen point", async () => {
    const hitTest = vi.fn<(x: number, y: number) => Promise<HitTarget>>().mockResolvedValue(null);
    const callbacks = setUp({ hitTest });
    const tab = pressBravo();
    movePointer(tab, 300, 400);
    await settle();
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 300, clientY: 400 });
    expect(callbacks.onTearOff).toHaveBeenCalledWith("tab-b", "task-1", { x: 500, y: 600 });
  });

  it("tears off without a hit test at all", () => {
    const callbacks = setUp();
    const tab = pressBravo();
    movePointer(tab, 300, 400);
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 300, clientY: 400 });
    expect(callbacks.onTearOff).toHaveBeenCalledWith("tab-b", "task-1", { x: 500, y: 600 });
  });

  it("drops everything on Escape", () => {
    const callbacks = setUp({ groupSpanFor: () => [0, 2] });
    const tab = pressBravo();
    movePointer(tab, 260, 15);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("state")).toHaveTextContent("false:null:null");
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 260, clientY: 15 });
    expect(callbacks.onReorder).not.toHaveBeenCalled();
    expect(callbacks.onTearOff).not.toHaveBeenCalled();
    expect(document.body.dataset.tabDragging).toBeUndefined();
  });

  it("leaves the close button to its own click", () => {
    const callbacks = setUp({ groupSpanFor: () => [0, 2] });
    const tab = screen.getByTestId("tab-b");
    fireEvent.pointerDown(screen.getByTestId("close-tab-b"), {
      button: 0,
      pointerId: 1,
      clientX: 150,
      clientY: 15,
    });
    movePointer(tab, 260, 15);
    expect(screen.getByTestId("state")).toHaveTextContent("false:null:null");
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 260, clientY: 15 });
    expect(callbacks.onReorder).not.toHaveBeenCalled();
  });

  it("ignores a secondary button", () => {
    const callbacks = setUp({ groupSpanFor: () => [0, 2] });
    const tab = screen.getByTestId("tab-b");
    fireEvent.pointerDown(tab, { button: 2, pointerId: 1, clientX: 150, clientY: 15 });
    movePointer(tab, 260, 15);
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 260, clientY: 15 });
    expect(callbacks.onReorder).not.toHaveBeenCalled();
  });

  it("swallows the click that follows a drag", () => {
    const clicked = vi.fn();
    window.addEventListener("click", clicked);
    setUp({ groupSpanFor: () => [0, 2] });
    const tab = pressBravo();
    movePointer(tab, 260, 15);
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 260, clientY: 15 });
    fireEvent.click(tab);
    window.removeEventListener("click", clicked);
    expect(clicked).not.toHaveBeenCalled();
  });
});
