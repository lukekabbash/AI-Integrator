// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tooltip } from "./Tooltip";

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.dataset.motion = "none";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete document.documentElement.dataset.motion;
});

describe("Tooltip", () => {
  it("opens after its delay, measures the settled anchor, and preserves child handlers", () => {
    const onMouseEnter = vi.fn();
    render(
      <Tooltip label="New chat" hint="Ctrl N" delay={100}>
        <button type="button" onMouseEnter={onMouseEnter}>
          Trigger
        </button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Trigger" });
    const rectSpy = vi
      .spyOn(trigger, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(20, 30, 80, 24));

    fireEvent.mouseEnter(trigger);
    expect(onMouseEnter).toHaveBeenCalledOnce();
    expect(rectSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(100));

    expect(rectSpy).toHaveBeenCalledOnce();
    expect(screen.getByRole("tooltip")).toHaveTextContent("New chatCtrl N");
  });

  it("cancels a pending tooltip and removes an open tooltip on mouse leave", () => {
    render(
      <Tooltip label="More actions" delay={100}>
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Trigger" });

    fireEvent.mouseEnter(trigger);
    fireEvent.mouseLeave(trigger);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.mouseEnter(trigger);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
