// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TitlebarFileTabs } from "./TitlebarFileTabs";

const tabs = [
  { path: "src/alpha.ts" },
  { path: "src/components/beta.tsx" },
  { path: "src/styles/gamma.css" },
];

function renderTabs(overrides?: Partial<Parameters<typeof TitlebarFileTabs>[0]>) {
  const props = {
    tabs,
    activePath: tabs[0].path,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...props, ...render(<TitlebarFileTabs {...props} />) };
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TitlebarFileTabs", () => {
  it("keeps append order, exposes the active tab, and supports direct and middle-click close", () => {
    const { onSelect, onClose } = renderTabs();
    const tablist = screen.getByRole("tablist", { name: "Open files" });

    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "alpha.ts",
      "beta.tsx",
      "gamma.css",
    ]);
    expect(screen.getByRole("tab", { name: "alpha.ts" })).toHaveAttribute("aria-selected", "true");
    expect(tablist.querySelector("[data-active='true']")).toContainElement(
      screen.getByRole("tab", { name: "alpha.ts" }),
    );
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "beta.tsx" }));
    expect(onSelect).toHaveBeenCalledWith("src/components/beta.tsx");

    fireEvent(
      screen.getByRole("tab", { name: "gamma.css" }),
      new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close src/alpha.ts" }));
    expect(onClose).toHaveBeenNthCalledWith(1, "src/styles/gamma.css");
    expect(onClose).toHaveBeenNthCalledWith(2, "src/alpha.ts");
  });

  it("pans only after the tabs reach real overflow and suppresses the release click", () => {
    vi.useFakeTimers();
    const { onSelect } = renderTabs();
    const tablist = screen.getByRole("tablist", { name: "Open files" });
    Object.defineProperties(tablist, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 600 },
      scrollLeft: { configurable: true, value: 0, writable: true },
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });

    fireEvent.pointerDown(tablist, { button: 0, pointerId: 4, clientX: 180 });
    fireEvent.pointerMove(tablist, { pointerId: 4, clientX: 100 });
    expect(tablist.scrollLeft).toBe(80);
    expect(tablist).toHaveAttribute("data-dragging", "true");

    fireEvent.pointerUp(tablist, { pointerId: 4, clientX: 100 });
    fireEvent.click(screen.getByRole("tab", { name: "alpha.ts" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(tablist).not.toHaveAttribute("data-dragging");

    vi.runAllTimers();
    fireEvent.click(screen.getByRole("tab", { name: "alpha.ts" }));
    expect(onSelect).toHaveBeenCalledWith("src/alpha.ts");
  });

  it("keeps existing tabs stable while rapid additions recompress the strip", () => {
    const { rerender } = renderTabs({ tabs: tabs.slice(0, 1) });
    const firstTab = screen.getByRole("tab", { name: "alpha.ts" }).parentElement;

    rerender(
      <TitlebarFileTabs
        tabs={tabs.slice(0, 2)}
        activePath={tabs[1].path}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    rerender(
      <TitlebarFileTabs
        tabs={tabs}
        activePath={tabs[2].path}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "alpha.ts" }).parentElement).toBe(firstTab);
    expect(firstTab).not.toHaveAttribute("style");
  });
});
