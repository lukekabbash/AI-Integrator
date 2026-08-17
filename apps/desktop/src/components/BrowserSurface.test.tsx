// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserTab } from "../bridge";
import { BrowserSurface, type BrowserSurfaceProps } from "./BrowserSurface";

const POPPED_TAB: BrowserTab = {
  id: "tab-a",
  taskId: "task-a",
  url: "https://example.com",
  title: "Example",
  loading: false,
  poppedOut: true,
  hidden: false,
  sleeping: false,
};

function props(overrides: Partial<BrowserSurfaceProps> = {}): BrowserSurfaceProps {
  return {
    tab: POPPED_TAB,
    onBoundsChange: vi.fn(),
    onNavigate: vi.fn(async () => undefined),
    onHistory: vi.fn(async () => undefined),
    onScreenshot: vi.fn(async () => undefined),
    onRecordToggle: vi.fn(async () => undefined),
    recording: false,
    onAnnotate: vi.fn(async () => undefined),
    annotating: false,
    onPopOut: vi.fn(async () => undefined),
    allowExternalOpen: false,
    onOpenExternally: vi.fn(async () => undefined),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe("BrowserSurface native hosting", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(100, 80, 640, 420),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("places a popped tab inside its pop-out renderer", () => {
    const onBoundsChange = vi.fn();
    render(<BrowserSurface {...props({ onBoundsChange, poppedOutHost: true })} />);

    expect(document.querySelector(".browser-viewport")).toHaveAttribute("data-native", "true");
    expect(onBoundsChange).toHaveBeenCalledWith(
      expect.objectContaining({ x: 103, y: 80, width: 637, height: 420 }),
    );
    expect(screen.queryByText("This tab is in its own window")).not.toBeInTheDocument();
  });

  it("parks the same tab in the main renderer and hides external actions by default", () => {
    const onBoundsChange = vi.fn();
    render(<BrowserSurface {...props({ onBoundsChange })} />);

    expect(onBoundsChange).toHaveBeenCalledWith(null);
    expect(screen.getByText("This tab is in its own window")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open in your system browser" })).toBeNull();
  });

  it("opens toolbar tooltips below the top controls", async () => {
    render(<BrowserSurface {...props({ tab: { ...POPPED_TAB, poppedOut: false } })} />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByRole("tooltip", {}, { timeout: 1_000 })).toHaveAttribute(
      "data-placement",
      "bottom",
    );
  });
});
