// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResizeHandle } from "./ResizeHandle";

afterEach(() => {
  document.body.removeAttribute("data-resizing");
});

describe("ResizeHandle", () => {
  it("reports pointer deltas and supports keyboard resizing", () => {
    const onResize = vi.fn();
    render(
      <ResizeHandle axis="horizontal" label="Resize subagent conversation" onResize={onResize} />,
    );
    const separator = screen.getByRole("separator", {
      name: "Resize subagent conversation",
    });
    expect(separator).toHaveAttribute("aria-orientation", "vertical");

    fireEvent.pointerDown(separator, { clientX: 100 });
    expect(document.body).toHaveAttribute("data-resizing", "true");
    fireEvent.pointerMove(window, { clientX: 124 });
    expect(onResize).toHaveBeenCalledWith(24);
    fireEvent.pointerUp(window);
    expect(document.body).not.toHaveAttribute("data-resizing");

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(onResize).toHaveBeenNthCalledWith(2, -16);
    expect(onResize).toHaveBeenNthCalledWith(3, 16);
  });

  it("reports horizontal separator semantics and values for a vertical resize axis", () => {
    render(
      <ResizeHandle
        axis="vertical"
        label="Resize staged changes"
        valueNow={28}
        valueMin={14}
        valueMax={48}
        onResize={vi.fn()}
      />,
    );

    const separator = screen.getByRole("separator", { name: "Resize staged changes" });
    expect(separator).toHaveAttribute("aria-orientation", "horizontal");
    expect(separator).toHaveAttribute("aria-valuenow", "28");
    expect(separator).toHaveAttribute("aria-valuemin", "14");
    expect(separator).toHaveAttribute("aria-valuemax", "48");
  });

  it("flushes the final pointer delta before ending resize mode", () => {
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const resizeModes: Array<string | undefined> = [];
    const onResize = vi.fn(() => resizeModes.push(document.body.dataset.resizing));
    render(<ResizeHandle axis="horizontal" label="Resize tools" onResize={onResize} />);
    const separator = screen.getByRole("separator", { name: "Resize tools" });

    fireEvent.pointerDown(separator, { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 110 });
    fireEvent.pointerMove(window, { clientX: 125 });
    fireEvent.pointerUp(window);

    expect(onResize).toHaveBeenNthCalledWith(1, 10);
    expect(onResize).toHaveBeenNthCalledWith(2, 15);
    expect(resizeModes).toEqual(["true", "true"]);
    expect(document.body).not.toHaveAttribute("data-resizing");
  });

  it("cleans up resize mode when pointer-up is lost", () => {
    const { unmount } = render(
      <ResizeHandle axis="horizontal" label="Resize tools" onResize={vi.fn()} />,
    );
    const separator = screen.getByRole("separator", { name: "Resize tools" });

    fireEvent.pointerDown(separator, { clientX: 100 });
    fireEvent.blur(window);
    expect(document.body).not.toHaveAttribute("data-resizing");

    fireEvent.pointerDown(separator, { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 110 });
    fireEvent.pointerMove(window, { clientX: 125 });
    unmount();
    expect(document.body).not.toHaveAttribute("data-resizing");
  });

  it("captures the pointer and exits resize mode when capture is lost outside the WebView", () => {
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    render(<ResizeHandle axis="horizontal" label="Resize tools" onResize={vi.fn()} />);
    const separator = screen.getByRole("separator", { name: "Resize tools" });
    Object.defineProperties(separator, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      hasPointerCapture: { configurable: true, value: () => false },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    });

    fireEvent.pointerDown(separator, { button: 0, clientX: 100, pointerId: 7 });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(document.body).toHaveAttribute("data-resizing", "true");

    fireEvent.lostPointerCapture(separator, { pointerId: 7 });
    expect(document.body).not.toHaveAttribute("data-resizing");
    expect(releasePointerCapture).not.toHaveBeenCalled();
  });

  it("releases pointer capture when the handle unmounts during a drag", () => {
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    const { unmount } = render(
      <ResizeHandle axis="horizontal" label="Resize tools" onResize={vi.fn()} />,
    );
    const separator = screen.getByRole("separator", { name: "Resize tools" });
    Object.defineProperties(separator, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      hasPointerCapture: { configurable: true, value: () => true },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    });

    fireEvent.pointerDown(separator, { button: 0, clientX: 100, pointerId: 11 });
    unmount();

    expect(setPointerCapture).toHaveBeenCalledWith(11);
    expect(releasePointerCapture).toHaveBeenCalledWith(11);
    expect(document.body).not.toHaveAttribute("data-resizing");
  });
});
