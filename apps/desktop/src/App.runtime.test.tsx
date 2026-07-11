// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { bridgeMock } = vi.hoisted(() => ({
  bridgeMock: {
    loadWorkspace: vi.fn(),
    subscribeRuntimeProjections: vi.fn(),
    loadTaskProjection: vi.fn(),
    respondToApproval: vi.fn(),
    stopTurn: vi.fn(),
    persistSession: vi.fn(),
    probeRuntimes: vi.fn(),
    beginRuntimeLogin: vi.fn(),
    openProject: vi.fn(),
    registerProject: vi.fn(),
    listProjects: vi.fn(),
    startTask: vi.fn(),
    loadTaskGit: vi.fn(),
    supportsTaskMetadata: vi.fn(),
    updateTaskMetadata: vi.fn(),
    sendTurn: vi.fn(),
    stageFiles: vi.fn(),
    commit: vi.fn(),
    push: vi.fn(),
  },
}));

vi.mock("./bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bridge")>();
  return { ...actual, bridge: bridgeMock };
});

import App from "./App";
import type { RuntimeProjectionEvent } from "./bridge";
import { createEmptySnapshot } from "./demoData";

let runtimeListener: ((event: RuntimeProjectionEvent) => void) | undefined;

function projection(
  seq: number,
  value: RuntimeProjectionEvent["projection"],
): RuntimeProjectionEvent {
  return {
    seq,
    taskId: "task-1",
    providerSessionId: "session-1",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    occurredAt: "2026-07-10T16:00:00Z",
    projection: value,
  };
}

describe("native runtime recovery UI", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    for (const value of Object.values(bridgeMock)) value.mockReset();
    runtimeListener = undefined;
    bridgeMock.subscribeRuntimeProjections.mockImplementation(async (listener) => {
      runtimeListener = listener;
      return vi.fn();
    });
    bridgeMock.supportsTaskMetadata.mockReturnValue(true);
    const workspace = createEmptySnapshot();
    workspace.projects = [
      {
        id: "project-1",
        name: "sample",
        path: "H:\\Code\\sample",
        branch: "main",
        dirtyFiles: 0,
        expanded: true,
      },
    ];
    workspace.tasks = [
      {
        id: "task-1",
        projectId: "project-1",
        title: "Native recovery task",
        status: "running",
        runtime: "codex",
        model: "Provider default",
        updatedAt: "2026-07-10T16:00:00Z",
      },
    ];
    workspace.activeProjectId = "project-1";
    workspace.activeTaskId = "task-1";
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.loadTaskProjection.mockImplementation(async () => {
      runtimeListener?.(
        projection(9, {
          kind: "itemChanged",
          item: {
            id: "codex:thread-1:turn-1:item-buffered",
            providerItemId: "item-buffered",
            kind: "agentMessage",
            status: "completed",
            body: "Buffered after the snapshot watermark.",
            truncated: false,
            updatedAt: "2026-07-10T16:00:01Z",
          },
        }),
      );
      return {
        watermarkSeq: 8,
        events: [
          projection(5, {
            kind: "turnChanged",
            turn: { id: "turn-1", status: "inProgress", stopRequested: false },
          }),
          projection(6, { kind: "connectionChanged", state: "gap", reason: "receiver lagged" }),
          projection(7, {
            kind: "itemChanged",
            item: {
              id: "codex:thread-1:turn-1:item-1",
              providerItemId: "item-1",
              kind: "agentMessage",
              status: "completed",
              body: "Recovered from the persisted projection.",
              truncated: false,
              updatedAt: "2026-07-10T16:00:00Z",
            },
          }),
          projection(8, {
            kind: "approvalChanged",
            approval: {
              id: "approval-1",
              requestId: { kind: "string", value: "request-a" },
              approvalKind: "commandExecution",
              state: "pending",
              command: "npm test",
              updatedAt: "2026-07-10T16:00:00Z",
            },
          }),
        ],
      };
    });
    bridgeMock.respondToApproval.mockResolvedValue({});
    bridgeMock.stopTurn.mockResolvedValue({
      turnId: "turn-1",
      stopRequested: true,
      alreadyRequested: false,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("listens before snapshot load and renders real recovery controls", async () => {
    render(<App />);

    expect(
      await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Buffered after the snapshot watermark.")).toBeInTheDocument();
    expect(
      screen.getByText("Event gap detected; recovering authoritative history…"),
    ).toBeInTheDocument();
    expect(bridgeMock.subscribeRuntimeProjections.mock.invocationCallOrder[0]).toBeLessThan(
      bridgeMock.loadWorkspace.mock.invocationCallOrder[0],
    );

    fireEvent.click(screen.getByRole("button", { name: "Run command" }));
    await waitFor(() =>
      expect(bridgeMock.respondToApproval).toHaveBeenCalledWith("task-1", "approval-1", "accept"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(bridgeMock.stopTurn).toHaveBeenCalledWith("task-1"));
  });
});
