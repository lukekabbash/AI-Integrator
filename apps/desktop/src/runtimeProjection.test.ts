import { describe, expect, it } from "vitest";
import type { RuntimeProjectionEvent } from "./bridge";
import {
  applyRuntimeProjection,
  createRuntimeProjectionState,
  runtimeTranscript,
  taskActivityUpdate,
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

describe("sidebar task activity projection", () => {
  it("maps live, attention, unread completion, failure, and cancellation states", () => {
    const running = taskActivityUpdate(
      event(1, {
        kind: "turnChanged",
        turn: { id: "turn-1", status: "inProgress", stopRequested: false },
      }),
      true,
    );
    expect(running).toMatchObject({ status: "running" });
    expect(running).not.toHaveProperty("unread");

    expect(
      taskActivityUpdate(
        event(2, {
          kind: "approvalChanged",
          approval: {
            id: "approval-1",
            requestId: { kind: "string", value: "request-1" },
            approvalKind: "commandExecution",
            state: "pending",
            updatedAt: "2026-07-10T16:00:00Z",
          },
        }),
        false,
      ),
    ).toMatchObject({ status: "waiting" });

    expect(
      taskActivityUpdate(
        event(3, {
          kind: "turnChanged",
          turn: { id: "turn-1", status: "completed", stopRequested: false },
        }),
        false,
      ),
    ).toMatchObject({ status: "completed", unread: true });
    expect(
      taskActivityUpdate(
        event(4, { kind: "turnError", message: "provider exited", retryable: true }),
        true,
      ),
    ).toMatchObject({ status: "failed", unread: false });
    expect(
      taskActivityUpdate(
        event(5, {
          kind: "turnChanged",
          turn: { id: "turn-1", status: "interrupted", stopRequested: true },
        }),
        false,
      ),
    ).toMatchObject({ status: "stopped" });
  });

  it("ignores streaming item chunks so they cannot reorder the sidebar", () => {
    expect(
      taskActivityUpdate(
        event(6, {
          kind: "itemChanged",
          item: {
            id: "item-1",
            providerItemId: "item-1",
            kind: "agentMessage",
            status: "inProgress",
            body: "partial",
            truncated: false,
            updatedAt: "2026-07-10T16:00:00Z",
          },
        }),
        false,
      ),
    ).toBeNull();
  });
});

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

  it("keeps verified native skill identity on projected user messages", () => {
    const state = applyRuntimeProjection(
      createRuntimeProjectionState("task-1"),
      event(12, {
        kind: "itemChanged",
        item: {
          id: "codex:thread-1:turn-1:user-1",
          providerItemId: "user-1",
          kind: "userMessage",
          status: "completed",
          body: "/skill-creator add release checks",
          nativeSkill: "skill-creator",
          truncated: false,
          updatedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );

    expect(runtimeTranscript(state)[0]).toMatchObject({
      kind: "user",
      body: "/skill-creator add release checks",
      nativeSkill: "skill-creator",
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

  it("groups contiguous observable activity between streamed message segments", () => {
    let state = createRuntimeProjectionState("task-1");
    const items = [
      {
        id: "msg-1",
        providerItemId: "msg-1",
        kind: "agentMessage" as const,
        status: "completed" as const,
        body: "I will inspect the project.",
        truncated: false,
        updatedAt: "2026-07-10T16:00:00Z",
      },
      {
        id: "command-1",
        providerItemId: "command-1",
        kind: "commandExecution" as const,
        status: "completed" as const,
        command: "pnpm test",
        cwd: "fixture/integrator-3",
        output: "passed",
        truncated: false,
        updatedAt: "2026-07-10T16:00:02Z",
      },
      {
        id: "tool-1",
        providerItemId: "tool-1",
        kind: "mcpTool" as const,
        status: "completed" as const,
        mcpTool: "read",
        toolInput: '{"path":"src/App.tsx"}',
        output: "file contents",
        truncated: false,
        updatedAt: "2026-07-10T16:00:03Z",
      },
      {
        id: "msg-2",
        providerItemId: "msg-2",
        kind: "agentMessage" as const,
        status: "completed" as const,
        body: "The checks passed.",
        truncated: false,
        updatedAt: "2026-07-10T16:00:04Z",
      },
    ];
    for (const [index, item] of items.entries()) {
      state = applyRuntimeProjection(state, {
        ...event(60 + index, { kind: "itemChanged", item }),
        occurredAt: item.updatedAt,
      });
    }

    const transcript = runtimeTranscript(state);
    expect(transcript.map((entry) => entry.id)).toEqual([
      "msg-1",
      "activity-group-command-1",
      "msg-2",
    ]);
    expect(transcript[1]).toMatchObject({
      title: "Activity",
      body: "1 command · 1 tool",
      children: [
        expect.objectContaining({ activityType: "command", details: expect.any(Array) }),
        expect.objectContaining({ activityType: "tool" }),
      ],
    });
  });

  it("keeps pending approvals inside the activity stack between text segments", () => {
    let state = createRuntimeProjectionState("task-1");
    const messageBefore = {
      id: "msg-before-approval",
      providerItemId: "msg-before-approval",
      kind: "agentMessage" as const,
      status: "completed" as const,
      body: "I need permission before continuing.",
      truncated: false,
      updatedAt: "2026-07-10T16:00:00Z",
    };
    const command = {
      id: "command-before-approval",
      providerItemId: "command-before-approval",
      kind: "commandExecution" as const,
      status: "completed" as const,
      command: "npm test",
      truncated: false,
      updatedAt: "2026-07-10T16:00:01Z",
    };
    const tool = {
      id: "tool-after-approval",
      providerItemId: "tool-after-approval",
      kind: "mcpTool" as const,
      status: "inProgress" as const,
      title: "Edit",
      toolInput: '{"path":"src/App.tsx"}',
      truncated: false,
      updatedAt: "2026-07-10T16:00:03Z",
    };
    const messageAfter = {
      id: "msg-after-approval",
      providerItemId: "msg-after-approval",
      kind: "agentMessage" as const,
      status: "completed" as const,
      body: "Permission granted; I am applying the edit.",
      truncated: false,
      updatedAt: "2026-07-10T16:00:04Z",
    };

    for (const [index, item] of [messageBefore, command, tool, messageAfter].entries()) {
      state = applyRuntimeProjection(state, {
        ...event(80 + index * 2, { kind: "itemChanged", item }),
        occurredAt: item.updatedAt,
      });
      if (item === command) {
        state = applyRuntimeProjection(state, {
          ...event(83, {
            kind: "approvalChanged",
            approval: {
              id: "approval-stack",
              requestId: { kind: "string", value: "request-stack" },
              approvalKind: "commandExecution",
              state: "pending",
              command: "npm test",
              reason: "The command needs approval.",
              updatedAt: "2026-07-10T16:00:02Z",
            },
          }),
          occurredAt: "2026-07-10T16:00:02Z",
        });
      }
    }

    const transcript = runtimeTranscript(state);
    expect(transcript.map((entry) => entry.id)).toEqual([
      "msg-before-approval",
      "activity-group-command-before-approval",
      "msg-after-approval",
    ]);
    expect(transcript[1]).toMatchObject({
      expandedByDefault: false,
      children: [
        expect.objectContaining({ activityType: "command" }),
        expect.objectContaining({ kind: "approval", status: "warning" }),
        expect.objectContaining({ kind: "tool" }),
      ],
    });
    expect(transcript[1].body).toContain("1 command");
    expect(transcript[1].body).toContain("1 approval");
    expect(transcript[1].body).toContain("1 tool");
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
    // Search-shaped tools surface the verb and the query instead of the raw
    // provider identifier.
    expect(tool).toMatchObject({ kind: "tool", title: "Searched", body: "flaky tests" });
    expect(tool.details).toEqual([
      { label: "Input", body: '{\n  "query": "flaky tests"\n}' },
      { label: "Output", body: "3 results" },
    ]);
  });

  it("turns file tools into readable paths with diff-style line counts", () => {
    const state = applyRuntimeProjection(
      createRuntimeProjectionState("task-1"),
      event(51, {
        kind: "itemChanged",
        item: {
          id: "codex:thread-1:turn-1:tool-3",
          providerItemId: "tool-3",
          kind: "mcpTool",
          status: "completed",
          mcpTool: "edit",
          toolInput: JSON.stringify({
            path: "src/App.tsx",
            old_string: "const oldValue = true;",
            new_string: "const newValue = false;\nconst second = true;",
          }),
          truncated: false,
          updatedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );

    expect(runtimeTranscript(state)[0]).toMatchObject({
      title: "Edited",
      body: "src/App.tsx",
      changeStats: { additions: 2, deletions: 1 },
      expandedByDefault: true,
    });
    expect(runtimeTranscript(state)[0].details).toBeUndefined();
    expect(runtimeTranscript(state)[0].diff).toMatchObject({
      path: "src/App.tsx",
      additions: 2,
      deletions: 1,
    });
  });

  it("counts patch lines for provider file changes", () => {
    const state = applyRuntimeProjection(
      createRuntimeProjectionState("task-1"),
      event(52, {
        kind: "itemChanged",
        item: {
          id: "codex:thread-1:turn-1:file-1",
          providerItemId: "file-1",
          kind: "fileChange",
          status: "completed",
          fileChanges: [
            {
              path: "src/router.ts",
              changeKind: "modify",
              patch: "@@ -1,2 +1,3 @@\n-old\n+new\n+extra",
            },
          ],
          truncated: false,
          updatedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );

    expect(runtimeTranscript(state)[0]).toMatchObject({
      body: "src/router.ts",
      changeStats: { additions: 2, deletions: 1 },
      expandedByDefault: true,
    });
    expect(runtimeTranscript(state)[0].details).toBeUndefined();
    expect(runtimeTranscript(state)[0].diff).toMatchObject({
      path: "src/router.ts",
      additions: 2,
      deletions: 1,
    });
  });

  it("renders per-file diff events for ACP tool calls carrying file changes", () => {
    const state = applyRuntimeProjection(
      createRuntimeProjectionState("task-1"),
      event(53, {
        kind: "itemChanged",
        item: {
          id: "acp:session-1:turn-1:call-1",
          providerItemId: "call-1",
          kind: "mcpTool",
          status: "completed",
          title: "Edit File",
          mcpTool: "edit",
          fileChanges: [
            {
              path: "C:\\repo\\src\\Hud.tsx",
              changeKind: "modify",
              patch: "@@ -1,2 +1,3 @@\n-old\n+new\n+extra",
            },
          ],
          truncated: false,
          updatedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );

    expect(runtimeTranscript(state)[0]).toMatchObject({
      title: "Edited",
      body: "C:\\repo\\src\\Hud.tsx",
      filePath: "C:\\repo\\src\\Hud.tsx",
      changeStats: { additions: 2, deletions: 1 },
      expandedByDefault: true,
    });
    expect(runtimeTranscript(state)[0].details).toBeUndefined();
    expect(runtimeTranscript(state)[0].diff).toMatchObject({
      path: "C:\\repo\\src\\Hud.tsx",
      additions: 2,
      deletions: 1,
    });
  });

  it("tracks session mode snapshots for the composer mode picker", () => {
    let state = createRuntimeProjectionState("task-1");
    state = applyRuntimeProjection(
      state,
      event(60, {
        kind: "modeChanged",
        mode: {
          currentModeId: "plan",
          availableModes: [
            { id: "agent", name: "Agent", description: "Full agent capabilities" },
            { id: "plan", name: "Plan" },
            { id: "ask", name: "Ask" },
          ],
        },
      }),
    );
    expect(state.mode?.currentModeId).toBe("plan");
    expect(state.mode?.availableModes).toHaveLength(3);
    // Snapshot semantics: each update replaces the whole mode state.
    state = applyRuntimeProjection(
      state,
      event(61, {
        kind: "modeChanged",
        mode: { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }] },
      }),
    );
    expect(state.mode?.currentModeId).toBe("agent");
    expect(state.mode?.availableModes).toHaveLength(1);
    // Mode changes are composer state, not transcript entries.
    expect(runtimeTranscript(state)).toHaveLength(0);
  });

  it("titles plan-review approvals distinctly in the transcript", () => {
    const state = applyRuntimeProjection(
      createRuntimeProjectionState("task-1"),
      event(70, {
        kind: "approvalChanged",
        approval: {
          id: "approval-plan",
          requestId: { kind: "string", value: "request-02" },
          approvalKind: "planReview",
          state: "pending",
          reason: "Add subtract function",
          planMarkdown: "# Plan\n\nAdd subtract(a, b).",
          updatedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );
    expect(runtimeTranscript(state)).toContainEqual(
      expect.objectContaining({
        id: "runtime-approval-approval-plan",
        kind: "approval",
        title: "Plan approval",
        status: "warning",
      }),
    );
  });

  it("settles an interrupted turn: no live spinners, one interruption notice", () => {
    let state = createRuntimeProjectionState("task-1");
    state = applyRuntimeProjection(
      state,
      event(40, {
        kind: "itemChanged",
        item: {
          id: "codex:thread-1:turn-1:item-1",
          providerItemId: "item-1",
          kind: "commandExecution",
          status: "inProgress",
          command: "cargo test",
          truncated: false,
          updatedAt: "2026-07-10T16:00:05Z",
        },
      }),
    );
    state = applyRuntimeProjection(
      state,
      event(41, {
        kind: "turnChanged",
        turn: {
          id: "turn-1",
          status: "interrupted",
          stopRequested: true,
          startedAt: "2026-07-10T16:00:00Z",
          completedAt: "2026-07-10T19:30:00Z",
        },
      }),
    );

    const transcript = runtimeTranscript(state);
    expect(transcript).not.toContainEqual(expect.objectContaining({ status: "running" }));
    expect(transcript.at(-1)).toMatchObject({
      id: "runtime-turn-interrupted-turn-1",
      kind: "notice",
      title: "Response interrupted",
      timestamp: "2026-07-10T19:30:00Z",
    });
  });

  it("keeps unfinished items spinning while the turn is still in progress", () => {
    let state = createRuntimeProjectionState("task-1");
    state = applyRuntimeProjection(
      state,
      event(50, {
        kind: "turnChanged",
        turn: {
          id: "turn-1",
          status: "inProgress",
          stopRequested: false,
          startedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );
    state = applyRuntimeProjection(
      state,
      event(51, {
        kind: "itemChanged",
        item: {
          id: "codex:thread-1:turn-1:item-1",
          providerItemId: "item-1",
          kind: "commandExecution",
          status: "inProgress",
          command: "cargo test",
          truncated: false,
          updatedAt: "2026-07-10T16:00:05Z",
        },
      }),
    );

    const transcript = runtimeTranscript(state);
    expect(transcript).toContainEqual(
      expect.objectContaining({ id: "codex:thread-1:turn-1:item-1", status: "running" }),
    );
    expect(transcript).not.toContainEqual(expect.objectContaining({ kind: "notice" }));
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
