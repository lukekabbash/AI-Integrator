import { describe, expect, it, vi } from "vitest";
import type { RuntimeProjectionEvent } from "./bridge";
import {
  applyRuntimeProjection,
  applyRuntimeProjectionBatch,
  createRuntimeProjectionState,
  createRuntimeTranscriptDeriver,
  hydrateRuntimeProjectionState,
  isFrameBatchableRuntimeProjection,
  mergeOlderProjectionHydrate,
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
    ).toBeNull();
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

  it("shows real reasoning summaries as content and drops empty placeholders", () => {
    let state = createRuntimeProjectionState("task-1");
    state = applyRuntimeProjection(
      state,
      event(13, {
        kind: "itemChanged",
        item: {
          id: "codex:thread-1:turn-1:reasoning-empty",
          providerItemId: "reasoning-empty",
          kind: "reasoningSummary",
          status: "completed",
          title: "Reasoning summary",
          body: "",
          truncated: false,
          updatedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );
    state = applyRuntimeProjection(
      state,
      event(14, {
        kind: "itemChanged",
        item: {
          id: "codex:thread-1:turn-1:reasoning-real",
          providerItemId: "reasoning-real",
          kind: "reasoningSummary",
          status: "completed",
          title: "Reasoning summary",
          body: "Comparing the reducer with the captured event stream.",
          truncated: false,
          updatedAt: "2026-07-10T16:00:01Z",
        },
      }),
    );

    expect(runtimeTranscript(state)).toEqual([
      expect.objectContaining({
        id: "codex:thread-1:turn-1:reasoning-real",
        body: "Comparing the reducer with the captured event stream.",
        meta: "Reasoning summary",
      }),
    ]);
    expect(runtimeTranscript(state)[0].title).toBeUndefined();
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
    expect(runtimeTranscript(state, "verbose").map((entry) => entry.id)).toEqual([
      "msg-1",
      "command-1",
      "tool-1",
      "msg-2",
    ]);

    let single = createRuntimeProjectionState("task-summary");
    single = applyRuntimeProjection(single, {
      ...event(70, { kind: "itemChanged", item: items[1] }),
      taskId: "task-summary",
      occurredAt: items[1].updatedAt,
    });
    expect(runtimeTranscript(single, "summary")[0]).toMatchObject({
      id: "activity-group-command-1",
      body: "1 command",
      children: [expect.objectContaining({ id: "command-1" })],
    });
  });

  it("caps collapsed activity groups so expanding one cannot mount an unbounded history", () => {
    let state = createRuntimeProjectionState("task-1");
    for (let index = 0; index < 125; index += 1) {
      const timestamp = new Date(Date.UTC(2026, 6, 10, 16, 0, index)).toISOString();
      state = applyRuntimeProjection(state, {
        ...event(200 + index, {
          kind: "itemChanged",
          item: {
            id: `command-${index}`,
            providerItemId: `command-${index}`,
            kind: "commandExecution",
            status: "completed",
            command: `echo ${index}`,
            truncated: false,
            updatedAt: timestamp,
          },
        }),
        occurredAt: timestamp,
      });
    }

    const grouped = runtimeTranscript(state);
    expect(grouped).toHaveLength(3);
    expect(grouped.map((entry) => entry.children?.length)).toEqual([50, 50, 25]);
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
      "command-before-approval",
      "runtime-approval-approval-stack",
      "tool-after-approval",
      "msg-after-approval",
    ]);
    expect(transcript[2]).toMatchObject({
      kind: "approval",
      status: "warning",
    });
    expect(transcript[3]).toMatchObject({
      kind: "tool",
      title: expect.stringMatching(/^Edit/i),
    });
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

  it("renders provider web search as calm search activity", () => {
    const state = applyRuntimeProjection(
      createRuntimeProjectionState("task-1"),
      event(50, {
        kind: "itemChanged",
        item: {
          id: "codex:thread-1:turn-1:search-1",
          providerItemId: "search-1",
          kind: "mcpTool",
          status: "completed",
          title: "Web search",
          mcpTool: "web_search",
          body: "Stripe MCP connector sign in status",
          toolInput: '{\n  "query": "Stripe MCP connector sign in status"\n}',
          truncated: false,
          updatedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );

    expect(runtimeTranscript(state)[0]).toMatchObject({
      kind: "tool",
      title: "Searched",
      body: "Stripe MCP connector sign in status",
    });
  });

  it("normalizes legacy unsupported web search rows", () => {
    const state = applyRuntimeProjection(
      createRuntimeProjectionState("task-1"),
      event(50, {
        kind: "itemChanged",
        item: {
          id: "codex:thread-1:turn-1:legacy-search",
          providerItemId: "legacy-search",
          kind: "unknown",
          status: "completed",
          title: "Provider activity",
          body: "Unsupported item type: webSearch",
          truncated: false,
          updatedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );

    expect(runtimeTranscript(state)[0]).toMatchObject({
      kind: "tool",
      title: "Searched",
      body: "Web search",
    });
  });

  it("uses typed subagent copy and fails unknown tools closed", () => {
    let state = createRuntimeProjectionState("task-1");
    const peers = {
      id: "codex:thread-1:turn-1:peers",
      providerItemId: "peers",
      kind: "mcpTool" as const,
      status: "inProgress" as const,
      mcpServer: "integrator",
      mcpTool: "peers_list",
      toolInput: "{}",
      truncated: false,
      updatedAt: "2026-07-10T16:00:00Z",
    };
    state = applyRuntimeProjection(state, event(51, { kind: "itemChanged", item: peers }));
    expect(runtimeTranscript(state)[0].title).toBe("Checking subagent configuration");

    state = applyRuntimeProjection(
      state,
      event(52, {
        kind: "itemChanged",
        item: { ...peers, status: "completed", updatedAt: "2026-07-10T16:00:01Z" },
      }),
    );
    expect(runtimeTranscript(state)[0].title).toBe("Checked subagent configuration");

    const unknown = applyRuntimeProjection(
      createRuntimeProjectionState("task-1"),
      event(53, {
        kind: "itemChanged",
        item: {
          id: "codex:thread-1:turn-1:unknown",
          providerItemId: "unknown",
          kind: "mcpTool",
          status: "completed",
          mcpServer: "future-provider",
          mcpTool: "invented_tool",
          toolInput: "{}",
          truncated: false,
          updatedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );
    expect(runtimeTranscript(unknown)[0].title).toBe("Runtime event");
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
      expandedByDefault: false,
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
      expandedByDefault: false,
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
      expandedByDefault: false,
    });
    expect(runtimeTranscript(state)[0].details).toBeUndefined();
    expect(runtimeTranscript(state)[0].diff).toMatchObject({
      path: "C:\\repo\\src\\Hud.tsx",
      additions: 2,
      deletions: 1,
    });
  });

  it("groups contiguous file edits into an Edits summary with aggregated diffs", () => {
    let state = createRuntimeProjectionState("task-1");
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
    for (const [index, path] of files.entries()) {
      const timestamp = `2026-07-10T16:00:0${index}Z`;
      state = applyRuntimeProjection(state, {
        ...event(90 + index, {
          kind: "itemChanged",
          item: {
            id: `file-${index}`,
            providerItemId: `file-${index}`,
            kind: "fileChange",
            status: "completed",
            fileChanges: [
              {
                path,
                changeKind: "modify",
                patch: "@@ -1,1 +1,1 @@\n-old\n+new",
              },
            ],
            truncated: false,
            updatedAt: timestamp,
          },
        }),
        occurredAt: timestamp,
      });
    }

    const transcript = runtimeTranscript(state);
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      title: "Edits",
      body: "3 files",
      activityType: "file",
      changeStats: { additions: 3, deletions: 3 },
      children: [
        expect.objectContaining({ title: "Edited", body: "src/a.ts" }),
        expect.objectContaining({ title: "Edited", body: "src/b.ts" }),
        expect.objectContaining({ title: "Edited", body: "src/c.ts" }),
      ],
    });
    expect(runtimeTranscript(state, "verbose")).toHaveLength(3);
  });

  it("collapses settled mid-turn activity into Worked for above the final reply", () => {
    let state = createRuntimeProjectionState("task-1");
    state = applyRuntimeProjection(
      state,
      event(100, {
        kind: "turnChanged",
        turn: {
          id: "turn-1",
          status: "inProgress",
          stopRequested: false,
          startedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );
    const liveItems = [
      {
        id: "user-1",
        providerItemId: "user-1",
        kind: "userMessage" as const,
        status: "completed" as const,
        body: "Fix the flaky test",
        truncated: false,
        updatedAt: "2026-07-10T16:00:00Z",
      },
      {
        id: "command-1",
        providerItemId: "command-1",
        kind: "commandExecution" as const,
        status: "completed" as const,
        command: "pnpm test",
        output: "failed",
        truncated: false,
        updatedAt: "2026-07-10T16:00:10Z",
      },
      {
        id: "tool-1",
        providerItemId: "tool-1",
        kind: "mcpTool" as const,
        status: "completed" as const,
        mcpTool: "edit",
        toolInput: '{"path":"src/App.tsx"}',
        fileChanges: [
          {
            path: "src/App.tsx",
            changeKind: "modify" as const,
            patch: "@@ -1,1 +1,1 @@\n-old\n+new",
          },
        ],
        truncated: false,
        updatedAt: "2026-07-10T16:00:20Z",
      },
      {
        id: "assistant-1",
        providerItemId: "assistant-1",
        kind: "agentMessage" as const,
        status: "completed" as const,
        body: "The flaky test is fixed.",
        truncated: false,
        updatedAt: "2026-07-10T16:01:35Z",
      },
    ];
    for (const [index, item] of liveItems.entries()) {
      state = applyRuntimeProjection(state, {
        ...event(101 + index, { kind: "itemChanged", item }),
        occurredAt: item.updatedAt,
      });
    }

    const live = runtimeTranscript(state);
    expect(live.map((entry) => entry.kind)).toEqual(["user", "tool", "tool", "assistant"]);
    expect(live.some((entry) => entry.title === "Worked for")).toBe(false);

    state = applyRuntimeProjection(
      state,
      event(110, {
        kind: "turnChanged",
        turn: {
          id: "turn-1",
          status: "completed",
          stopRequested: false,
          startedAt: "2026-07-10T16:00:00Z",
          completedAt: "2026-07-10T16:01:35Z",
        },
      }),
    );

    const settled = runtimeTranscript(state);
    expect(settled.map((entry) => entry.id)).toEqual([
      "user-1",
      "worked-for-assistant-1",
      "assistant-1",
    ]);
    expect(settled[1]).toMatchObject({
      title: "Worked for",
      body: "1m 35s",
      expandedByDefault: false,
      children: expect.any(Array),
    });
    expect(settled[1].children?.length).toBeGreaterThanOrEqual(2);
    expect(settled[2]).toMatchObject({ kind: "assistant", body: "The flaky test is fixed." });

    expect(runtimeTranscript(state, "verbose").some((entry) => entry.title === "Worked for")).toBe(
      false,
    );
  });

  it("folds mid-turn assistant replies into Worked for in chronological order", () => {
    let state = createRuntimeProjectionState("task-1");
    state = applyRuntimeProjection(
      state,
      event(120, {
        kind: "turnChanged",
        turn: {
          id: "turn-1",
          status: "completed",
          stopRequested: false,
          startedAt: "2026-07-10T15:00:00Z",
          completedAt: "2026-07-10T16:01:35Z",
        },
      }),
    );
    const items = [
      {
        id: "user-2",
        providerItemId: "user-2",
        kind: "userMessage" as const,
        status: "completed" as const,
        body: "Ship the fix",
        truncated: false,
        updatedAt: "2026-07-10T15:00:00Z",
      },
      {
        id: "assistant-early",
        providerItemId: "assistant-early",
        kind: "agentMessage" as const,
        status: "completed" as const,
        body: "I will inspect the failure first.",
        truncated: false,
        updatedAt: "2026-07-10T15:00:05Z",
      },
      {
        id: "command-2",
        providerItemId: "command-2",
        kind: "commandExecution" as const,
        status: "completed" as const,
        command: "pnpm test",
        truncated: false,
        updatedAt: "2026-07-10T15:00:30Z",
      },
      {
        id: "assistant-mid",
        providerItemId: "assistant-mid",
        kind: "agentMessage" as const,
        status: "completed" as const,
        body: "Tests are green; applying the patch.",
        truncated: false,
        updatedAt: "2026-07-10T15:00:45Z",
      },
      {
        id: "assistant-final",
        providerItemId: "assistant-final",
        kind: "agentMessage" as const,
        status: "completed" as const,
        body: "Done.",
        truncated: false,
        updatedAt: "2026-07-10T16:01:35Z",
      },
    ];
    for (const [index, item] of items.entries()) {
      state = applyRuntimeProjection(state, {
        ...event(121 + index, { kind: "itemChanged", item }),
        occurredAt: item.updatedAt,
      });
    }
    state = applyRuntimeProjection(state, {
      ...event(130, {
        kind: "approvalChanged",
        approval: {
          id: "approval-open",
          requestId: { kind: "string", value: "request-open" },
          approvalKind: "commandExecution",
          state: "pending",
          command: "rm -rf build",
          reason: "Destructive command",
          updatedAt: "2026-07-10T15:00:20Z",
        },
      }),
      occurredAt: "2026-07-10T15:00:20Z",
    });

    const transcript = runtimeTranscript(state);
    expect(transcript.map((entry) => entry.id)).toEqual([
      "user-2",
      "worked-for-assistant-final",
      "runtime-approval-approval-open",
      "worked-for-assistant-final-1",
      "assistant-final",
    ]);
    expect(transcript[1]).toMatchObject({
      title: "Worked for",
      children: [expect.objectContaining({ id: "assistant-early", kind: "assistant" })],
    });
    expect(transcript[2]).toMatchObject({ kind: "approval", status: "warning" });
    expect(transcript[3]).toMatchObject({
      title: "Worked for",
      children: [
        expect.objectContaining({ id: "command-2" }),
        expect.objectContaining({ id: "assistant-mid", kind: "assistant" }),
      ],
    });
    expect(transcript[4]).toMatchObject({ kind: "assistant", body: "Done." });
  });

  it("keeps prior Worked for rows collapsed when a new turn starts", () => {
    let state = createRuntimeProjectionState("task-1");
    state = applyRuntimeProjection(
      state,
      event(200, {
        kind: "turnChanged",
        turn: {
          id: "turn-1",
          status: "completed",
          stopRequested: false,
          startedAt: "2026-07-10T16:00:00Z",
          completedAt: "2026-07-10T16:01:00Z",
        },
      }),
    );
    for (const [index, item] of [
      {
        id: "user-a",
        providerItemId: "user-a",
        kind: "userMessage" as const,
        status: "completed" as const,
        body: "First ask",
        truncated: false,
        updatedAt: "2026-07-10T16:00:00Z",
      },
      {
        id: "command-a",
        providerItemId: "command-a",
        kind: "commandExecution" as const,
        status: "completed" as const,
        command: "pnpm test",
        truncated: false,
        updatedAt: "2026-07-10T16:00:20Z",
      },
      {
        id: "assistant-a",
        providerItemId: "assistant-a",
        kind: "agentMessage" as const,
        status: "completed" as const,
        body: "First answer",
        truncated: false,
        updatedAt: "2026-07-10T16:01:00Z",
      },
    ].entries()) {
      state = applyRuntimeProjection(state, {
        ...event(201 + index, { kind: "itemChanged", item }),
        occurredAt: item.updatedAt,
      });
    }

    expect(runtimeTranscript(state).map((entry) => entry.id)).toEqual([
      "user-a",
      "worked-for-assistant-a",
      "assistant-a",
    ]);

    // Follow-up send starts a new in-progress turn — prior Worked for must stay.
    state = applyRuntimeProjection(
      state,
      event(210, {
        kind: "turnChanged",
        turn: {
          id: "turn-2",
          status: "inProgress",
          stopRequested: false,
          startedAt: "2026-07-10T16:02:00Z",
        },
      }),
    );
    state = applyRuntimeProjection(state, {
      ...event(211, {
        kind: "itemChanged",
        item: {
          id: "user-b",
          providerItemId: "user-b",
          kind: "userMessage",
          status: "completed",
          body: "Second ask",
          truncated: false,
          updatedAt: "2026-07-10T16:02:00Z",
        },
      }),
      occurredAt: "2026-07-10T16:02:00Z",
    });

    const transcript = runtimeTranscript(state);
    expect(transcript.map((entry) => entry.id)).toEqual([
      "user-a",
      "worked-for-assistant-a",
      "assistant-a",
      "user-b",
    ]);
    expect(transcript[1]).toMatchObject({
      title: "Worked for",
      children: [expect.objectContaining({ id: "command-a" })],
    });
    expect(transcript.some((entry) => entry.id === "command-a")).toBe(false);
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

  it("omits wire-only interrupted resume placeholders from the transcript", () => {
    let state = applyRuntimeProjection(
      createRuntimeProjectionState("task-1"),
      event(1, {
        kind: "itemChanged",
        item: {
          id: "user-resume",
          providerItemId: "provider-user-resume",
          kind: "userMessage",
          status: "completed",
          body: "Resume from here",
          truncated: false,
          updatedAt: "2026-07-10T16:01:00Z",
        },
      }),
    );
    state = applyRuntimeProjection(
      state,
      event(2, {
        kind: "itemChanged",
        item: {
          id: "assistant-1",
          providerItemId: "provider-assistant-1",
          kind: "agentMessage",
          status: "completed",
          body: "Continuing.",
          truncated: false,
          updatedAt: "2026-07-10T16:01:01Z",
        },
      }),
    );
    expect(runtimeTranscript(state).map((entry) => entry.kind)).toEqual(["assistant"]);
    expect(runtimeTranscript(state).some((entry) => entry.body === "Resume from here")).toBe(false);
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

  it("settles an interrupted turn without putting recovery state in the transcript", () => {
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
    expect(transcript).not.toContainEqual(expect.objectContaining({ kind: "notice" }));
  });

  it("keeps a user stop request across a later interrupted settlement", () => {
    let state = createRuntimeProjectionState("task-1");
    state = applyRuntimeProjection(
      state,
      event(42, {
        kind: "turnChanged",
        turn: {
          id: "turn-1",
          status: "inProgress",
          stopRequested: true,
          startedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );
    state = applyRuntimeProjection(
      state,
      event(43, {
        kind: "turnChanged",
        turn: {
          id: "turn-1",
          status: "interrupted",
          stopRequested: false,
          startedAt: "2026-07-10T16:00:00Z",
          completedAt: "2026-07-10T16:00:03Z",
        },
      }),
    );

    expect(state.turn).toMatchObject({
      id: "turn-1",
      status: "interrupted",
      stopRequested: true,
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

  it("reuses unchanged item derivations without changing canonical transcript output", () => {
    let state = createRuntimeProjectionState("task-1");
    state = applyRuntimeProjection(
      state,
      event(90, {
        kind: "itemChanged",
        item: {
          id: "tool-cached",
          providerItemId: "tool-cached",
          kind: "mcpTool",
          status: "completed",
          mcpTool: "edit",
          toolInput: JSON.stringify({
            path: "src/App.tsx",
            old_string: "const value = 1;",
            new_string: "const value = 2;",
          }),
          truncated: false,
          updatedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );
    state = applyRuntimeProjection(
      state,
      event(91, {
        kind: "itemChanged",
        item: {
          id: "message-streaming",
          providerItemId: "message-streaming",
          kind: "agentMessage",
          status: "inProgress",
          body: "First chunk",
          truncated: false,
          updatedAt: "2026-07-10T16:00:01Z",
        },
      }),
    );

    const deriveTranscript = createRuntimeTranscriptDeriver();
    const first = deriveTranscript(state);
    expect(first).toEqual(runtimeTranscript(state));
    const firstTool = first.find((entry) => entry.id === "tool-cached");
    const firstMessage = first.find((entry) => entry.id === "message-streaming");

    state = applyRuntimeProjection(
      state,
      event(92, {
        kind: "itemChanged",
        item: {
          ...state.items.find((item) => item.id === "message-streaming")!,
          body: "First chunk and second chunk",
          updatedAt: "2026-07-10T16:00:02Z",
        },
      }),
    );
    const second = deriveTranscript(state);

    expect(second).toEqual(runtimeTranscript(state));
    expect(second.find((entry) => entry.id === "tool-cached")).toBe(firstTool);
    expect(second.find((entry) => entry.id === "message-streaming")).not.toBe(firstMessage);
  });

  it("invalidates cached item surfaces when first-seen time or settled status changes", () => {
    let state = applyRuntimeProjection(
      createRuntimeProjectionState("task-1"),
      event(100, {
        kind: "itemChanged",
        item: {
          id: "command-cached",
          providerItemId: "command-cached",
          kind: "commandExecution",
          status: "inProgress",
          command: "npm test",
          truncated: false,
          updatedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );
    const deriveTranscript = createRuntimeTranscriptDeriver();
    const initial = deriveTranscript(state)[0];

    state = {
      ...state,
      firstSeen: { ...state.firstSeen, "command-cached": "2026-07-10T15:59:59Z" },
    };
    const retimed = deriveTranscript(state)[0];
    expect(retimed).not.toBe(initial);
    expect(retimed.timestamp).toBe("2026-07-10T15:59:59Z");

    state = applyRuntimeProjection(
      state,
      event(101, {
        kind: "turnChanged",
        turn: { id: "turn-1", status: "completed", stopRequested: false },
      }),
    );
    const settled = deriveTranscript(state)[0];
    expect(settled).not.toBe(retimed);
    expect(settled.status).toBe("neutral");
    expect(settled).toEqual(runtimeTranscript(state)[0]);
  });

  it("parses a cached MCP item once per scoped transcript deriver", () => {
    const state = applyRuntimeProjection(
      createRuntimeProjectionState("task-1"),
      event(110, {
        kind: "itemChanged",
        item: {
          id: "tool-parse-once",
          providerItemId: "tool-parse-once",
          kind: "mcpTool",
          status: "completed",
          mcpTool: "edit",
          toolInput: '{"path":"src/App.tsx","old_string":"a","new_string":"b"}',
          truncated: false,
          updatedAt: "2026-07-10T16:00:00Z",
        },
      }),
    );
    const parse = vi.spyOn(JSON, "parse");
    const deriveTranscript = createRuntimeTranscriptDeriver();

    deriveTranscript(state);
    expect(parse).toHaveBeenCalledTimes(1);
    deriveTranscript(state);
    expect(parse).toHaveBeenCalledTimes(1);
    createRuntimeTranscriptDeriver()(state);
    expect(parse).toHaveBeenCalledTimes(2);
    parse.mockRestore();
  });

  it("frame-batches only in-progress assistant and reasoning projections", () => {
    expect(
      isFrameBatchableRuntimeProjection(
        event(120, {
          kind: "itemChanged",
          item: {
            id: "message-frame",
            providerItemId: "message-frame",
            kind: "agentMessage",
            status: "inProgress",
            body: "streaming",
            truncated: false,
            updatedAt: "2026-07-10T16:00:00Z",
          },
        }),
      ),
    ).toBe(true);
    expect(
      isFrameBatchableRuntimeProjection(
        event(121, {
          kind: "itemChanged",
          item: {
            id: "command-frame",
            providerItemId: "command-frame",
            kind: "commandExecution",
            status: "inProgress",
            command: "npm test",
            truncated: false,
            updatedAt: "2026-07-10T16:00:00Z",
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("turn settlement on provider errors", () => {
  const startedTurn = (seq: number) =>
    event(seq, {
      kind: "turnChanged",
      turn: { id: "turn-1", status: "inProgress", stopRequested: false },
    });

  it("settles the turn when the provider will not retry", () => {
    const running = applyRuntimeProjection(createRuntimeProjectionState("task-1"), startedTurn(1));
    expect(running.turn).toMatchObject({ status: "inProgress" });

    const limited = applyRuntimeProjection(
      running,
      event(2, {
        kind: "turnError",
        message: "You've hit your usage limit. Try again at 3pm.",
        retryable: false,
      }),
    );

    // Without this the composer stays pinned to stop and the queue never
    // drains, because both read `turn.status`.
    expect(limited.turn).toMatchObject({
      id: "turn-1",
      status: "failed",
      error: "You've hit your usage limit. Try again at 3pm.",
      completedAt: "2026-07-10T16:00:00Z",
    });
    expect(limited.errors).toMatchObject([{ retryable: false }]);
  });

  it("leaves the turn running while the provider is still retrying", () => {
    const running = applyRuntimeProjection(createRuntimeProjectionState("task-1"), startedTurn(1));
    const retrying = applyRuntimeProjection(
      running,
      event(2, { kind: "turnError", message: "stream disconnected", retryable: true }),
    );

    expect(retrying.turn).toMatchObject({ status: "inProgress" });
    expect(retrying.errors).toMatchObject([{ retryable: true }]);
  });

  it("settles a hydrated turn, so a reload does not resurrect the stop button", () => {
    // Compact hydrate still applies the same turn/error semantics the live
    // reducer would when those singletons are present.
    const hydrated = applyRuntimeProjectionBatch(createRuntimeProjectionState("task-1"), [
      startedTurn(1),
      event(2, { kind: "turnError", message: "usage limit reached", retryable: false }),
    ]);

    expect(hydrated.turn).toMatchObject({ status: "failed" });
  });

  it("lets a provider that reports its own outcome win over the settled guess", () => {
    const limited = applyRuntimeProjectionBatch(createRuntimeProjectionState("task-1"), [
      startedTurn(1),
      event(2, { kind: "turnError", message: "usage limit reached", retryable: false }),
    ]);

    // A provider that does close the turn after erroring stays authoritative.
    const closed = applyRuntimeProjection(
      limited,
      event(3, {
        kind: "turnChanged",
        turn: { id: "turn-1", status: "interrupted", stopRequested: false },
      }),
    );
    expect(closed.turn).toMatchObject({ status: "interrupted" });

    // And a fresh turn still clears the stale error rather than inheriting it.
    const retried = applyRuntimeProjection(
      closed,
      event(4, {
        kind: "turnChanged",
        turn: { id: "turn-2", status: "inProgress", stopRequested: false },
      }),
    );
    expect(retried.turn).toMatchObject({ id: "turn-2", status: "inProgress" });
    expect(retried.errors).toHaveLength(0);
  });

  it("ignores a non-retryable error that arrives with no turn to settle", () => {
    const state = applyRuntimeProjection(
      createRuntimeProjectionState("task-1"),
      event(1, { kind: "turnError", message: "runtime is not installed", retryable: false }),
    );

    expect(state.turn).toBeUndefined();
    expect(state.errors).toHaveLength(1);
  });
});

describe("runtime projection batch reducer", () => {
  const projectedItem = (
    id: string,
    body: string,
    status: "inProgress" | "completed" = "inProgress",
  ) => ({
    id,
    providerItemId: id,
    kind: "agentMessage" as const,
    status,
    body,
    truncated: false,
    updatedAt: "2026-07-10T16:00:00Z",
  });

  const sequentiallyReduce = (
    events: readonly RuntimeProjectionEvent[],
    initial = createRuntimeProjectionState("task-1"),
  ) => events.reduce(applyRuntimeProjection, initial);

  it("matches the canonical reducer at every prefix of a mixed ordered stream", () => {
    const stream: RuntimeProjectionEvent[] = [
      event(1, {
        kind: "turnChanged",
        turn: { id: "turn-1", status: "inProgress", stopRequested: false },
      }),
      event(2, { kind: "itemChanged", item: projectedItem("message-a", "a") }),
      event(3, { kind: "itemChanged", item: projectedItem("message-b", "b") }),
      {
        ...event(999, { kind: "itemChanged", item: projectedItem("wrong-task", "ignored") }),
        taskId: "task-2",
      },
      event(3, { kind: "itemChanged", item: projectedItem("duplicate-seq", "ignored") }),
      event(5, {
        kind: "approvalChanged",
        approval: {
          id: "message-a",
          requestId: { kind: "string", value: "request-a" },
          approvalKind: "commandExecution",
          state: "pending",
          updatedAt: "2026-07-10T16:00:05Z",
        },
      }),
      event(6, {
        kind: "itemChanged",
        item: projectedItem("message-a", "a complete", "completed"),
      }),
      event(7, {
        kind: "planChanged",
        steps: [{ index: 0, text: "Read", status: "completed" }],
        truncated: false,
      }),
      event(8, { kind: "diffChanged", diff: "@@ -1 +1 @@\n-old\n+new", truncated: false }),
      event(9, {
        kind: "usageChanged",
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          reasoningOutputTokens: 1,
          totalTokens: 17,
        },
      }),
      event(10, {
        kind: "modeChanged",
        mode: { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }] },
      }),
      event(11, { kind: "turnError", message: "temporary failure", retryable: true }),
      event(12, { kind: "connectionChanged", state: "gap", reason: "receiver lagged" }),
      event(13, { kind: "projectionReset", reason: "authoritative replay" }),
      event(12, { kind: "itemChanged", item: projectedItem("stale-after-reset", "ignored") }),
      event(14, { kind: "itemChanged", item: projectedItem("message-a", "new epoch") }),
      event(15, { kind: "itemChanged", item: projectedItem("message-c", "c") }),
      event(16, {
        kind: "turnChanged",
        turn: { id: "turn-2", status: "completed", stopRequested: false },
      }),
    ];

    for (let length = 0; length <= stream.length; length += 1) {
      const prefix = stream.slice(0, length);
      const sequential = sequentiallyReduce(prefix);
      const batched = applyRuntimeProjectionBatch(createRuntimeProjectionState("task-1"), prefix);
      expect(batched).toEqual(sequential);
      expect(runtimeTranscript(batched)).toEqual(runtimeTranscript(sequential));
    }
  });

  it("preserves rejection identity and first-index replacement without mutating inputs", () => {
    const first = projectedItem("duplicate", "first");
    const second = projectedItem("duplicate", "second");
    const initial = {
      ...createRuntimeProjectionState("task-1"),
      lastSeq: 20,
      items: [first, second],
      firstSeen: { duplicate: "2026-07-10T15:59:00Z" },
    };
    const rejected = [
      Object.freeze(event(20, { kind: "itemChanged", item: projectedItem("duplicate", "stale") })),
      Object.freeze({
        ...event(100, { kind: "itemChanged", item: projectedItem("other", "wrong task") }),
        taskId: "task-2",
      }),
    ];

    expect(applyRuntimeProjectionBatch(initial, rejected)).toBe(initial);

    const replacement = Object.freeze(
      event(21, { kind: "itemChanged", item: projectedItem("duplicate", "replacement") }),
    );
    const appended = Object.freeze(
      event(22, { kind: "itemChanged", item: projectedItem("appended", "new") }),
    );
    const source = Object.freeze([replacement, appended]);
    const batched = applyRuntimeProjectionBatch(initial, source);
    const sequential = sequentiallyReduce(source, initial);

    expect(batched).toEqual(sequential);
    expect(batched.items[0]).toBe(
      replacement.projection.kind === "itemChanged" ? replacement.projection.item : undefined,
    );
    expect(batched.items[1]).toBe(second);
    expect(initial.items).toEqual([first, second]);
  });

  it("keeps unchanged item and cached transcript row identities across a dense update run", () => {
    const stable = projectedItem("stable", "unchanged", "completed");
    const streaming = projectedItem("streaming", "chunk 0");
    const initial = applyRuntimeProjectionBatch(createRuntimeProjectionState("task-1"), [
      event(1, { kind: "itemChanged", item: stable }),
      event(2, { kind: "itemChanged", item: streaming }),
    ]);
    const deriveTranscript = createRuntimeTranscriptDeriver();
    const stableRow = deriveTranscript(initial).find((entry) => entry.id === stable.id);
    const updates = Array.from({ length: 32 }, (_, index) =>
      event(3 + index, {
        kind: "itemChanged",
        item: projectedItem("streaming", `chunk ${index + 1}`),
      }),
    );

    const batched = applyRuntimeProjectionBatch(initial, updates);
    expect(batched).toEqual(sequentiallyReduce(updates, initial));
    expect(batched.items.find((item) => item.id === stable.id)).toBe(stable);
    expect(deriveTranscript(batched).find((entry) => entry.id === stable.id)).toBe(stableRow);
  });

  it("matches sequential reduction across different publication partitions", () => {
    const stream: RuntimeProjectionEvent[] = [
      event(1, { kind: "itemChanged", item: projectedItem("message-a", "a1") }),
      event(2, { kind: "itemChanged", item: projectedItem("message-a", "a2") }),
      event(3, { kind: "connectionChanged", state: "connected", processId: "process-1" }),
      event(4, { kind: "itemChanged", item: projectedItem("message-b", "b1") }),
      event(5, {
        kind: "approvalChanged",
        approval: {
          id: "approval-a",
          requestId: { kind: "number", value: 5 },
          approvalKind: "fileChange",
          state: "pending",
          updatedAt: "2026-07-10T16:00:05Z",
        },
      }),
      event(6, { kind: "projectionReset", reason: "authoritative replay" }),
      event(7, { kind: "itemChanged", item: projectedItem("message-c", "c1") }),
      event(8, { kind: "turnError", message: "retry later", retryable: true }),
      event(9, { kind: "itemChanged", item: projectedItem("message-c", "c2", "completed") }),
    ];
    const expected = sequentiallyReduce(stream);

    for (const partition of [[9], [1, 1, 1, 1, 1, 1, 1, 1, 1], [2, 1, 3, 3], [3, 2, 1, 3]]) {
      let state = createRuntimeProjectionState("task-1");
      let offset = 0;
      for (const size of partition) {
        state = applyRuntimeProjectionBatch(state, stream.slice(offset, offset + size));
        offset += size;
      }
      expect(offset).toBe(stream.length);
      expect(state).toEqual(expected);
      expect(runtimeTranscript(state)).toEqual(runtimeTranscript(expected));
    }
  });
});

describe("compact hydrate and older-page merge", () => {
  it("builds display state from a compact hydrate DTO without event replay", () => {
    const state = hydrateRuntimeProjectionState(
      "task-1",
      {
        turn: { id: "turn-1", status: "completed", stopRequested: false },
        items: [
          {
            id: "item-1",
            providerItemId: "p1",
            kind: "agentMessage",
            status: "completed",
            body: "hello",
            truncated: false,
            updatedAt: "2026-07-10T16:00:00Z",
          },
        ],
        plan: [],
        planTruncated: false,
        approvals: [],
        connection: { state: "disconnected", reason: "idle" },
        firstSeen: { "item-1": "2026-07-10T15:59:00Z" },
        hasMoreOlder: true,
        beforeSeq: 40,
      },
      50,
      0,
    );

    expect(state.lastSeq).toBe(50);
    expect(state.resetSeq).toBe(0);
    expect(state.items).toHaveLength(1);
    expect(state.firstSeen["item-1"]).toBe("2026-07-10T15:59:00Z");
    expect(state.hasMoreOlder).toBe(true);
    expect(state.oldestLoadedSeq).toBe(40);
    expect(state.connection).toMatchObject({ state: "disconnected" });
  });

  it("merges an older page without dropping live items or firstSeen", () => {
    const current = hydrateRuntimeProjectionState(
      "task-1",
      {
        items: [
          {
            id: "new",
            providerItemId: "n",
            kind: "userMessage",
            status: "completed",
            body: "new",
            truncated: false,
            updatedAt: "2026-07-10T16:00:00Z",
          },
        ],
        plan: [],
        planTruncated: false,
        approvals: [],
        firstSeen: { new: "2026-07-10T16:00:00Z" },
        hasMoreOlder: true,
        beforeSeq: 20,
      },
      30,
      0,
    );
    const merged = mergeOlderProjectionHydrate(current, {
      items: [
        {
          id: "old",
          providerItemId: "o",
          kind: "userMessage",
          status: "completed",
          body: "old",
          truncated: false,
          updatedAt: "2026-07-10T15:00:00Z",
        },
        {
          id: "new",
          providerItemId: "n",
          kind: "userMessage",
          status: "completed",
          body: "should-not-replace",
          truncated: false,
          updatedAt: "2026-07-10T16:00:00Z",
        },
      ],
      plan: [],
      planTruncated: false,
      approvals: [],
      firstSeen: {
        old: "2026-07-10T15:00:00Z",
        new: "2026-07-10T15:30:00Z",
      },
      hasMoreOlder: false,
      beforeSeq: 10,
    });

    expect(merged.items.map((item) => item.id)).toEqual(["old", "new"]);
    expect(merged.items.find((item) => item.id === "new")?.body).toBe("new");
    expect(merged.firstSeen.new).toBe("2026-07-10T16:00:00Z");
    expect(merged.firstSeen.old).toBe("2026-07-10T15:00:00Z");
    expect(merged.hasMoreOlder).toBe(false);
    expect(merged.oldestLoadedSeq).toBe(10);
    expect(merged.lastSeq).toBe(30);
  });

  it("records resetSeq on projectionReset for cache if-match", () => {
    const state = applyRuntimeProjection(
      createRuntimeProjectionState("task-1"),
      event(12, { kind: "projectionReset", reason: "replay" }),
    );
    expect(state.resetSeq).toBe(12);
    expect(state.lastSeq).toBe(12);
    expect(state.items).toHaveLength(0);
  });
});
