import { describe, expect, it } from "vitest";
import {
  clearOptimisticMessageForTask,
  isComposerTurnBusy,
  isTurnActiveError,
} from "./appTurnState";

const idle = {
  projectedTurnActive: false,
  optimisticTurnStarting: false,
  resuming: false,
  queueBusy: false,
  queueAwaiting: false,
};

describe("isComposerTurnBusy", () => {
  it("is idle when no turn signal is active", () => {
    expect(isComposerTurnBusy(idle)).toBe(false);
  });

  it.each([
    ["projectedTurnActive"],
    ["optimisticTurnStarting"],
    ["resuming"],
    ["queueBusy"],
    ["queueAwaiting"],
  ] as const)("is busy while %s", (signal) => {
    expect(isComposerTurnBusy({ ...idle, [signal]: true })).toBe(true);
  });

  it("does not stay busy from a lingering optimistic display message", () => {
    // Regression: the optimistic user message persists after a successful
    // send for transcript dedup. Counting its presence as busy sent every
    // follow-up message through the queue detour (extra IPC hops + "queued"
    // flash) for the rest of the session. Once the provider projects the
    // turn, only the projected/queue signals may hold the composer busy.
    expect(isComposerTurnBusy(idle)).toBe(false);
  });
});

describe("clearOptimisticMessageForTask", () => {
  const message = {
    taskId: "task-1",
    event: {
      id: "optimistic-user-1",
      kind: "user",
      body: "hello",
      timestamp: "2026-07-17T00:00:00Z",
    },
  } as never;

  it("clears only the matching task", () => {
    expect(clearOptimisticMessageForTask(message, "task-1")).toBeNull();
    expect(clearOptimisticMessageForTask(message, "task-2")).toBe(message);
    expect(clearOptimisticMessageForTask(null, "task-1")).toBeNull();
  });
});

describe("isTurnActiveError", () => {
  it.each([
    [{ code: "turn-active", message: "busy" }],
    [new Error("A turn is already running for this chat (turn-active)")],
    ["A turn is already starting for this chat"],
  ])("recognizes native turn admission failures", (error) => {
    expect(isTurnActiveError(error)).toBe(true);
  });

  it("does not confuse unrelated active-work errors with a turn conflict", () => {
    expect(isTurnActiveError(new Error("Another subagent is already active"))).toBe(false);
  });
});
