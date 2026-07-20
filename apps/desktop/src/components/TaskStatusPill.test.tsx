import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStatusPill } from "./TaskStatusPill";

describe("TaskStatusPill", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:30.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows tenth-of-a-second elapsed time, live tokens, and agent count", () => {
    render(
      <TaskStatusPill
        runningSince="2026-07-11T12:00:00.000Z"
        usage={{
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 384,
          reasoningOutputTokens: 0,
          totalTokens: 784,
        }}
        activeAgentCount={1}
      />,
    );

    expect(screen.getByText("30.0s")).toBeInTheDocument();
    expect(screen.getByText("784 tokens")).toBeInTheDocument();
    expect(screen.getByText("1 agent")).toBeInTheDocument();
  });

  it("renders nothing without a turn start time", () => {
    const { container } = render(<TaskStatusPill activeAgentCount={2} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders recovery beside the composer without a running timer", () => {
    render(<TaskStatusPill recovery={<button type="button">Resume</button>} />);
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.queryByText(/s$/)).not.toBeInTheDocument();
  });

  it("omits tokens and agents when they are unknown", () => {
    render(<TaskStatusPill runningSince="2026-07-11T12:00:00.000Z" />);
    expect(screen.getByText("30.0s")).toBeInTheDocument();
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();
    expect(screen.queryByText(/agent/)).not.toBeInTheDocument();
  });

  it("counts tenths of a second until the minute rolls over", () => {
    render(<TaskStatusPill runningSince="2026-07-11T12:00:00.000Z" />);
    expect(screen.getByText("30.0s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("30.3s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText("1m")).toBeInTheDocument();
  });

  it("keeps the elapsed label moving on quiet minutes", () => {
    render(<TaskStatusPill runningSince="2026-07-11T12:00:00.000Z" />);

    act(() => {
      vi.advanceTimersByTime(30_000); // rolls past 60s, downshifts the tick
    });
    expect(screen.getByText("1m")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.getByText("3m")).toBeInTheDocument();
  });
});
