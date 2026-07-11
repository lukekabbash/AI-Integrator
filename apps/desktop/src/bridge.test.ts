// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMock, openMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { bridge } from "./bridge";

describe("native trusted-project bridge", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockReset();
    listenMock.mockReset();
    openMock.mockReset();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("treats a cancelled native directory dialog as a no-op", async () => {
    openMock.mockResolvedValue(null);

    await expect(bridge.openProject()).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("registers only the directory returned by the user-owned dialog", async () => {
    openMock.mockResolvedValue("H:\\Code\\sample");
    invokeMock.mockResolvedValue({
      id: "project-1",
      displayName: "sample",
      repositoryRoot: "H:\\Code\\sample",
      gitCommonDirectory: "H:\\Code\\sample\\.git",
      createdAt: "2026-07-10T15:00:00Z",
      lastOpenedAt: "2026-07-10T15:00:00Z",
    });

    await expect(bridge.openProject()).resolves.toMatchObject({
      id: "project-1",
      name: "sample",
      path: "H:\\Code\\sample",
    });
    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, multiple: false }),
    );
    expect(invokeMock).toHaveBeenCalledWith("project_register", {
      path: "H:\\Code\\sample",
    });
  });

  it("uses the normalized sequenced event and task-control command contracts", async () => {
    const unlisten = vi.fn();
    const listener = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    invokeMock
      .mockResolvedValueOnce({ events: [], watermarkSeq: 41 })
      .mockResolvedValueOnce({ id: "approval-1", state: "responding" })
      .mockResolvedValueOnce({ turnId: "turn-1", stopRequested: true, alreadyRequested: false });

    await expect(bridge.subscribeRuntimeProjections(listener)).resolves.toBe(unlisten);
    expect(listenMock).toHaveBeenCalledWith("runtime://projection", expect.any(Function));
    await expect(bridge.loadTaskProjection("task-1")).resolves.toEqual({
      events: [],
      watermarkSeq: 41,
    });
    await bridge.respondToApproval("task-1", "approval-1", "acceptForSession");
    await bridge.stopTurn("task-1");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "task_snapshot", { taskId: "task-1" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "codex_respond_approval", {
      taskId: "task-1",
      approvalId: "approval-1",
      decision: "acceptForSession",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "codex_stop_turn", { taskId: "task-1" });
  });
});
