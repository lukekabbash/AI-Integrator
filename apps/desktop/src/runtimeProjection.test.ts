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
});
