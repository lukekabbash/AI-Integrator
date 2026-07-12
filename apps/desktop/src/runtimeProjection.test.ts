import { describe, expect, it } from "vitest";
import type { RuntimeProjectionEvent } from "./bridge";
import {
  applyRuntimeProjection,
  createRuntimeProjectionState,
  runtimeTranscript,
} from "./runtimeProjection";

function event(
  seq: number,
  projection: RuntimeProjectionEvent["projection"],
): RuntimeProjectionEvent {
  return {
    seq,
    taskId: "task-1",
    providerSessionId: "session-1",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    occurredAt: "2026-07-10T16:00:00Z",
    projection,
  };
}

describe("runtime projection reducer", () => {
  it("deduplicates only by sequence and replaces stable item projections", () => {
    let state = createRuntimeProjectionState("task-1");
    state = applyRuntimeProjection(
      state,
      event(10, {
        kind: "itemChanged",
        item: {
          id: "codex:thread-1:turn-1:item-1",
          providerItemId: "item-1",
          kind: "agentMessage",
          status: "inProgress",
          body: "same",
          truncated: false,
          updatedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );
    const duplicateSeq = applyRuntimeProjection(
      state,
      event(10, {
        kind: "turnError",
        message: "must not apply",
        retryable: false,
      }),
    );
    state = applyRuntimeProjection(
      duplicateSeq,
      event(11, {
        kind: "itemChanged",
        item: {
          ...state.items[0],
          status: "completed",
          body: "same",
        },
      }),
    );

    expect(state.items).toHaveLength(1);
    expect(state.items[0].status).toBe("completed");
    expect(state.errors).toHaveLength(0);
    expect(runtimeTranscript(state)[0]).toMatchObject({
      id: "codex:thread-1:turn-1:item-1",
      kind: "assistant",
      body: "same",
    });
  });

  it("projects connection gaps and pending approvals without losing tagged request IDs", () => {
    let state = createRuntimeProjectionState("task-1");
    state = applyRuntimeProjection(
      state,
      event(20, { kind: "connectionChanged", state: "gap", reason: "receiver lagged" }),
    );
    state = applyRuntimeProjection(
      state,
      event(21, {
        kind: "approvalChanged",
        approval: {
          id: "approval-1",
          requestId: { kind: "string", value: "request-01" },
          approvalKind: "fileChange",
          state: "pending",
          updatedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );

    expect(state.connection).toMatchObject({ state: "gap", reason: "receiver lagged" });
    expect(state.approvals[0].requestId).toEqual({ kind: "string", value: "request-01" });
    expect(runtimeTranscript(state)).toContainEqual(
      expect.objectContaining({ id: "runtime-approval-approval-1", kind: "approval" }),
    );
  });

  it("orders transcript events by first appearance, not last update", () => {
    let state = createRuntimeProjectionState("task-1");
    const message = {
      id: "codex:thread-1:turn-1:msg-1",
      providerItemId: "msg-1",
      kind: "agentMessage" as const,
      status: "inProgress" as const,
      body: "Starting…",
      truncated: false,
      updatedAt: "2026-07-10T16:00:00Z",
    };
    state = applyRuntimeProjection(state, {
      ...event(40, { kind: "itemChanged", item: message }),
      occurredAt: "2026-07-10T16:00:00Z",
    });
    state = applyRuntimeProjection(state, {
      ...event(41, {
        kind: "itemChanged",
        item: {
          id: "codex:thread-1:turn-1:tool-1",
          providerItemId: "tool-1",
          kind: "mcpTool",
          status: "completed",
          mcpServer: "github",
          mcpTool: "search",
          truncated: false,
          updatedAt: "2026-07-10T16:00:05Z",
        },
      }),
      occurredAt: "2026-07-10T16:00:05Z",
    });
    // The message keeps streaming after the tool call completed.
    state = applyRuntimeProjection(state, {
      ...event(42, {
        kind: "itemChanged",
        item: { ...message, body: "Starting… and more text", updatedAt: "2026-07-10T16:00:10Z" },
      }),
      occurredAt: "2026-07-10T16:00:10Z",
    });

    const transcript = runtimeTranscript(state);
    expect(transcript.map((entry) => entry.id)).toEqual([
      "codex:thread-1:turn-1:msg-1",
      "codex:thread-1:turn-1:tool-1",
    ]);
  });

  it("surfaces tool call details for expansion", () => {
    const state = applyRuntimeProjection(
      createRuntimeProjectionState("task-1"),
      event(50, {
        kind: "itemChanged",
        item: {
          id: "codex:thread-1:turn-1:tool-2",
          providerItemId: "tool-2",
          kind: "mcpTool",
          status: "completed",
          title: "github · search",
          mcpServer: "github",
          mcpTool: "search",
          toolInput: '{\n  "query": "flaky tests"\n}',
          output: "3 results",
          truncated: false,
          updatedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );

    const [tool] = runtimeTranscript(state);
    expect(tool).toMatchObject({ kind: "tool", title: "github · search" });
    expect(tool.details).toEqual([
      { label: "Input", body: '{\n  "query": "flaky tests"\n}' },
      { label: "Output", body: "3 results" },
    ]);
  });

  it("keeps turn errors out of the transcript for the composer dock", () => {
    const state = applyRuntimeProjection(
      createRuntimeProjectionState("task-1"),
      event(30, {
        kind: "turnError",
        message: "gemini turn execution is not implemented by the native backend",
        retryable: false,
      }),
    );

    expect(state.errors).toHaveLength(1);
    expect(runtimeTranscript(state)).not.toContainEqual(
      expect.objectContaining({ id: "runtime-error-30" }),
    );
  });
});
