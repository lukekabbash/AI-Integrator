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
});
