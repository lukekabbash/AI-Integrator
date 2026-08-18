// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  measureWorkPaneHeaderAlignment,
  useWorkPaneHeaderAlignment,
} from "./useWorkPane";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("measureWorkPaneHeaderAlignment", () => {
  const root = { left: 0, width: 1440, height: 38 };

  it("aligns the titlebar slot to the pane's left edge", () => {
    expect(
      measureWorkPaneHeaderAlignment({
        root,
        pane: { left: 820, width: 460, height: 800 },
        headerEnd: { width: 168.4 },
        reservedLeft: 420,
      }),
    ).toEqual({ paneLeft: 820, endWidth: 168 });
  });

  it("ignores a collapsed first frame so a tab switch cannot cover File/Edit/View", () => {
    expect(
      measureWorkPaneHeaderAlignment({
        root,
        pane: { left: 0, width: 0, height: 0 },
        reservedLeft: 420,
      }),
    ).toBeNull();
    expect(
      measureWorkPaneHeaderAlignment({
        root,
        pane: { left: 820, width: 0, height: 800 },
        reservedLeft: 420,
      }),
    ).toBeNull();
  });

  it("keeps File/Edit/View visible when a pop-out reports the pane at the window edge", () => {
    expect(
      measureWorkPaneHeaderAlignment({
        root,
        pane: { left: 0, width: 760, height: 800 },
        headerEnd: { width: 160 },
        reservedLeft: 412,
      }),
    ).toEqual({ paneLeft: 412, endWidth: 160 });
  });
});

describe("useWorkPaneHeaderAlignment", () => {
  let observers: Array<{ callback: ResizeObserverCallback; nodes: Set<Element> }>;
  let rafQueue: FrameRequestCallback[];

  beforeEach(() => {
    observers = [];
    rafQueue = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        nodes = new Set<Element>();
        constructor(callback: ResizeObserverCallback) {
          observers.push({ callback, nodes: this.nodes });
        }
        observe(node: Element) {
          this.nodes.add(node);
        }
        disconnect() {
          this.nodes.clear();
        }
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      rafQueue[id - 1] = () => undefined;
    });
  });

  function Harness({
    rootRef,
    paneRef,
    open,
  }: {
    rootRef: RefObject<HTMLElement | null>;
    paneRef: RefObject<HTMLElement | null>;
    open: boolean;
  }) {
    useWorkPaneHeaderAlignment(rootRef, paneRef, open);
    return null;
  }

  function mountChrome() {
    const root = document.createElement("div");
    root.className = "app-root";
    const left = document.createElement("div");
    left.className = "titlebar-left";
    const end = document.createElement("div");
    end.className = "titlebar-end";
    const pane = document.createElement("div");
    pane.className = "work-pane";
    root.append(left, end, pane);
    document.body.append(root);
    const rootRef = { current: root };
    const paneRef = { current: pane as HTMLElement };
    return { root, left, end, pane, rootRef, paneRef };
  }

  function stubRects(
    root: HTMLElement,
    pane: HTMLElement,
    left: HTMLElement,
    end: HTMLElement,
    boxes: { pane: DOMRect; left: DOMRect; end?: DOMRect },
  ) {
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1440, 900));
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(boxes.pane);
    vi.spyOn(left, "getBoundingClientRect").mockReturnValue(boxes.left);
    vi.spyOn(end, "getBoundingClientRect").mockReturnValue(
      boxes.end ?? new DOMRect(1280, 0, 160, 38),
    );
  }

  it("keeps the last good offset when a tab switch or pop-out collapses the pane", () => {
    const { root, left, end, pane, rootRef, paneRef } = mountChrome();
    stubRects(root, pane, left, end, {
      pane: new DOMRect(820, 38, 460, 800),
      left: new DOMRect(0, 0, 412, 38),
    });

    render(<Harness rootRef={rootRef} paneRef={paneRef} open />);
    expect(root.style.getPropertyValue("--subagent-pane-left")).toBe("820px");
    expect(root.dataset.subagentLayoutReady).toBe("true");

    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 0, 0));
    observers[0]?.callback([], observers[0] as unknown as ResizeObserver);

    expect(root.style.getPropertyValue("--subagent-pane-left")).toBe("820px");
    expect(root.dataset.subagentLayoutReady).toBe("true");
  });

  it("retries once the pane mounts instead of locking in a missing ref", () => {
    const { root, left, end, pane, rootRef } = mountChrome();
    const paneRef: RefObject<HTMLElement | null> = { current: null };
    stubRects(root, pane, left, end, {
      pane: new DOMRect(820, 38, 460, 800),
      left: new DOMRect(0, 0, 412, 38),
    });

    render(<Harness rootRef={rootRef} paneRef={paneRef} open />);
    expect(root.style.getPropertyValue("--subagent-pane-left")).toBe("");

    paneRef.current = pane;
    rafQueue.shift()?.(0);
    expect(root.style.getPropertyValue("--subagent-pane-left")).toBe("820px");
  });
});
