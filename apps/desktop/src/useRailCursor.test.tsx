// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { useRailCursor, type RailCursorOptions } from "./useRailCursor";

beforeAll(() => {
  // jsdom has no layout, so scrolling a cell into view is a no-op here.
  Element.prototype.scrollIntoView = vi.fn();
});

/** A project group holding two chats, plus a collapsed group below it. */
function Rail(options: RailCursorOptions = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useRailCursor(ref, options);
  return (
    <div ref={ref} onKeyDown={onKeyDown} data-testid="rail">
      <button data-nav-item data-nav-id="p1" data-nav-label="Adapters" aria-expanded="true">
        Adapters
      </button>
      <button data-nav-item data-nav-parent="p1" data-nav-label="Session store">
        Session store
      </button>
      <button data-nav-item data-nav-parent="p1" data-nav-label="Bridge contract">
        Bridge contract
      </button>
      <button data-nav-item data-nav-id="p2" data-nav-label="Relay" aria-expanded="false">
        Relay
      </button>
      <button data-nav-item data-nav-parent="p2" data-nav-label="Browser">
        Browser
      </button>
    </div>
  );
}

const rail = () => screen.getByTestId("rail");
const focused = () => (document.activeElement as HTMLElement | null)?.dataset.navLabel ?? null;
const press = (key: string, init: object = {}) =>
  fireEvent.keyDown(document.activeElement ?? rail(), { key, bubbles: true, ...init });

const start = (label: string) => screen.getByText(label).focus();

describe("useRailCursor", () => {
  it("walks the rail with Up and Down", () => {
    render(<Rail />);
    start("Adapters");
    press("ArrowDown");
    expect(focused()).toBe("Session store");
    press("ArrowDown");
    expect(focused()).toBe("Bridge contract");
    press("ArrowUp");
    expect(focused()).toBe("Session store");
  });

  it("wraps at the ends, or holds when wrapping is off", () => {
    const { unmount } = render(<Rail />);
    start("Browser");
    press("ArrowDown");
    expect(focused()).toBe("Adapters");
    unmount();

    render(<Rail wrap={false} />);
    start("Browser");
    press("ArrowDown");
    expect(focused()).toBe("Browser");
  });

  it("jumps to the ends with Home and End", () => {
    render(<Rail />);
    start("Session store");
    press("End");
    expect(focused()).toBe("Browser");
    press("Home");
    expect(focused()).toBe("Adapters");
  });

  it("opens a collapsed group with Right and closes an open one with Left", () => {
    const onExpand = vi.fn();
    const onCollapse = vi.fn();
    render(<Rail onExpand={onExpand} onCollapse={onCollapse} />);
    start("Relay");
    press("ArrowRight");
    expect(onExpand.mock.calls[0]?.[0]?.dataset.navId).toBe("p2");
    start("Adapters");
    press("ArrowLeft");
    expect(onCollapse.mock.calls[0]?.[0]?.dataset.navId).toBe("p1");
  });

  it("steps out of a group with Left from one of its children", () => {
    render(<Rail />);
    start("Bridge contract");
    press("ArrowLeft");
    expect(focused()).toBe("Adapters");
  });

  it("leaves Right alone on a leaf", () => {
    render(<Rail />);
    start("Session store");
    press("ArrowRight");
    expect(focused()).toBe("Session store");
  });

  it("jumps to the next row starting with a typed letter", () => {
    render(<Rail />);
    start("Adapters");
    press("s");
    expect(focused()).toBe("Session store");
  });

  it("cycles through the rows sharing a letter when it is repeated", () => {
    render(<Rail />);
    start("Adapters");
    press("b");
    expect(focused()).toBe("Bridge contract");
    press("b");
    expect(focused()).toBe("Browser");
    press("b");
    expect(focused()).toBe("Bridge contract");
  });

  it("refines in place as a longer prefix is typed", () => {
    render(<Rail />);
    start("Adapters");
    press("r");
    expect(focused()).toBe("Relay");
    // Same burst: "re" still matches Relay rather than moving off it.
    press("e");
    expect(focused()).toBe("Relay");
  });

  it("ignores a letter that is part of a shortcut", () => {
    render(<Rail />);
    start("Adapters");
    press("s", { ctrlKey: true });
    expect(focused()).toBe("Adapters");
  });

  it("leaves modified arrows to the shortcut layer", () => {
    render(<Rail />);
    start("Adapters");
    press("ArrowDown", { ctrlKey: true });
    expect(focused()).toBe("Adapters");
  });

  it("does nothing at all when the setting is off", () => {
    render(<Rail enabled={false} />);
    start("Adapters");
    press("ArrowDown");
    expect(focused()).toBe("Adapters");
  });

  it("skips type-ahead where a field owns typing", () => {
    render(<Rail typeahead={false} />);
    start("Adapters");
    press("s");
    expect(focused()).toBe("Adapters");
    press("ArrowDown");
    expect(focused()).toBe("Session store");
  });

  it("moves along a strip with Left and Right when horizontal", () => {
    render(<Rail orientation="horizontal" />);
    start("Adapters");
    press("ArrowRight");
    expect(focused()).toBe("Session store");
    press("ArrowLeft");
    expect(focused()).toBe("Adapters");
  });
});
