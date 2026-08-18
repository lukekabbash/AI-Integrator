// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserTab } from "../bridge";
import { NATIVE_PAGE_DECK_OCCLUSION_ATTR } from "../useModalOpen";
import { BrowserChromeBar, BrowserSurface, type BrowserSurfaceProps } from "./BrowserSurface";

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
    document.documentElement.removeAttribute(NATIVE_PAGE_DECK_OCCLUSION_ATTR);
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("places a popped tab inside its pop-out renderer", () => {
    const onBoundsChange = vi.fn();
    render(<BrowserSurface {...props({ onBoundsChange, poppedOutHost: true })} />);

    expect(document.querySelector(".browser-viewport")).toHaveAttribute("data-native", "true");
    expect(onBoundsChange).toHaveBeenCalledWith(
      expect.objectContaining({ x: 100, y: 80, width: 640, height: 420 }),
    );
    expect(screen.queryByText("This tab is in its own window")).not.toBeInTheDocument();
  });

  it("parks the native page while a dialog is open and places it again after", async () => {
    const onBoundsChange = vi.fn();
    render(<BrowserSurface {...props({ onBoundsChange, poppedOutHost: true })} />);
    expect(onBoundsChange).toHaveBeenCalledWith(expect.objectContaining({ width: 640 }));

    // A webview paints above every dialog and ignores its backdrop, so the
    // page has to leave rather than be covered.
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    await waitFor(() => expect(onBoundsChange).toHaveBeenLastCalledWith(null));

    dialog.remove();
    await waitFor(() =>
      expect(onBoundsChange).toHaveBeenLastCalledWith(expect.objectContaining({ width: 640 })),
    );
  });

  it("parks the in-pane page while the compact deck is dragged across it", async () => {
    const onBoundsChange = vi.fn();
    render(
      <BrowserSurface
        {...props({
          tab: { ...POPPED_TAB, poppedOut: false },
          onBoundsChange,
        })}
      />,
    );
    expect(onBoundsChange).toHaveBeenCalledWith(expect.objectContaining({ width: 640 }));

    document.documentElement.setAttribute(NATIVE_PAGE_DECK_OCCLUSION_ATTR, "");
    await waitFor(() => expect(onBoundsChange).toHaveBeenLastCalledWith(null));

    document.documentElement.removeAttribute(NATIVE_PAGE_DECK_OCCLUSION_ATTR);
    await waitFor(() =>
      expect(onBoundsChange).toHaveBeenLastCalledWith(expect.objectContaining({ width: 640 })),
    );
  });

  it("leaves a remotely hosted tab to its owning renderer and hides external actions by default", () => {
    const onBoundsChange = vi.fn();
    render(<BrowserSurface {...props({ onBoundsChange })} />);

    expect(onBoundsChange).not.toHaveBeenCalled();
    expect(screen.getByText("This tab is in its own window")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open in your system browser" })).toBeNull();
  });

  it("lets the outgoing page park itself when the selected replacement is blank", () => {
    const outgoingBounds = vi.fn();
    const blankBounds = vi.fn();
    const { rerender } = render(
      <BrowserSurface
        key="loaded"
        {...props({
          tab: { ...POPPED_TAB, poppedOut: false },
          onBoundsChange: outgoingBounds,
        })}
      />,
    );

    rerender(
      <BrowserSurface
        key="blank"
        {...props({
          tab: {
            ...POPPED_TAB,
            id: "tab-blank",
            url: "about:blank",
            title: "",
            poppedOut: false,
          },
          onBoundsChange: blankBounds,
        })}
      />,
    );

    expect(outgoingBounds).toHaveBeenLastCalledWith(null);
    expect(blankBounds).not.toHaveBeenCalled();
    expect(screen.getByText("Local servers")).toBeInTheDocument();
  });

  it("does not shove the native page down when more actions open", async () => {
    const onBoundsChange = vi.fn();
    render(<BrowserSurface {...props({ onBoundsChange, poppedOutHost: true })} />);
    expect(onBoundsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 100, y: 80, width: 640, height: 420 }),
    );

    fireEvent.click(screen.getByRole("button", { name: "More browser actions" }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    await waitFor(() => expect(onBoundsChange).toHaveBeenLastCalledWith(null));
    const shifted = onBoundsChange.mock.calls.some(
      ([bounds]) => bounds && typeof bounds === "object" && "y" in bounds && bounds.y > 80,
    );
    expect(shifted).toBe(false);
  });

  it("does not shove the in-app page down when more actions open", async () => {
    const onBoundsChange = vi.fn();
    render(
      <BrowserSurface
        {...props({
          tab: { ...POPPED_TAB, poppedOut: false },
          onBoundsChange,
        })}
      />,
    );
    expect(onBoundsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 100, y: 80, width: 640, height: 420 }),
    );

    fireEvent.click(screen.getByRole("button", { name: "More browser actions" }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    await waitFor(() => expect(onBoundsChange).toHaveBeenLastCalledWith(null));
    const shifted = onBoundsChange.mock.calls.some(
      ([bounds]) => bounds && typeof bounds === "object" && "y" in bounds && bounds.y > 80,
    );
    expect(shifted).toBe(false);
  });

  it("draws native-page tooltips without moving the browser bounds", async () => {
    const onBoundsChange = vi.fn();
    const onToolbarTooltip = vi.fn(async () => undefined);
    render(
      <BrowserSurface
        {...props({
          tab: { ...POPPED_TAB, poppedOut: false },
          onBoundsChange,
          onToolbarTooltip,
        })}
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => expect(onToolbarTooltip).toHaveBeenCalledWith({ label: "Back", x: 320 }), {
      timeout: 1_000,
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(onBoundsChange).toHaveBeenCalledTimes(1);
  });

  it("keeps a status notice in the chrome without insetting the native page", () => {
    const onBoundsChange = vi.fn();
    render(
      <BrowserSurface
        {...props({
          tab: { ...POPPED_TAB, poppedOut: false },
          onBoundsChange,
          message: "Screenshot attached to the composer.",
        })}
      />,
    );

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Screenshot attached to the composer.");
    expect(notice).toHaveClass("browser-message");
    expect(onBoundsChange).toHaveBeenCalledWith(expect.objectContaining({ x: 100, width: 640 }));
  });

  it("searches from the address field when the draft is not a URL", () => {
    const onNavigate = vi.fn(async () => undefined);
    render(<BrowserSurface {...props({ onNavigate, poppedOutHost: true })} />);

    const field = screen.getByRole("combobox");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "how to center a div" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(onNavigate).toHaveBeenCalledWith("https://www.google.com/search?q=how%20to%20center%20a%20div");
  });

  it("shows the hero search on a blank in-pane tab as well as the chrome address field", () => {
    const onNavigate = vi.fn(async () => undefined);
    render(
      <BrowserSurface
        {...props({
          tab: { ...POPPED_TAB, url: "about:blank", title: "", poppedOut: false },
          onNavigate,
        })}
      />,
    );

    expect(screen.getByRole("combobox", { name: /Search or enter a URL/ })).toBeInTheDocument();
    const hero = screen.getByRole("combobox", { name: /Search Google or enter a URL/ });
    fireEvent.focus(hero);
    fireEvent.change(hero, { target: { value: "https://example.com/docs" } });
    fireEvent.keyDown(hero, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledWith("https://example.com/docs");
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
  });

  it("renders a shared chrome bar with the history disabled when there is no page", () => {
    render(
      <BrowserChromeBar disabled>
        <div className="browser-address" />
      </BrowserChromeBar>,
    );

    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload" })).toBeDisabled();
    expect(document.querySelector("form.browser-chrome")).not.toBeNull();
  });

  it("keeps the ordinary downward tooltip on a blank HTML start page", async () => {
    render(
      <BrowserSurface
        {...props({
          tab: { ...POPPED_TAB, url: "about:blank", title: "", poppedOut: false },
        })}
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByRole("tooltip", {}, { timeout: 1_000 })).toHaveAttribute(
      "data-placement",
      "bottom",
    );
  });
});
