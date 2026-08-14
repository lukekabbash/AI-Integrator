// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { bridge } from "./bridge";

function nativeGrokExport(taskId: string) {
  return {
    projects: [
      {
        id: `project-${taskId}`,
        displayName: "integrator-3",
        repositoryRoot: "H:\\Code\\integrator-3",
        gitCommonDirectory: "H:\\Code\\integrator-3\\.git",
        createdAt: "2026-08-13T00:00:00Z",
        lastOpenedAt: "2026-08-13T00:00:00Z",
      },
    ],
    tasks: [
      {
        id: taskId,
        title: "Grok recovery",
        repositoryPath: "H:\\Code\\integrator-3",
        state: "ready",
        pinned: false,
        archived: false,
        runtime: "grok",
        model: "grok-4.6",
        effort: "high",
        createdAt: "2026-08-13T00:00:00Z",
        updatedAt: "2026-08-13T00:00:00Z",
      },
    ],
    settings: [],
    providerSessions: [],
    providerResumeStates: [],
    runtimeSessions: [],
  };
}

describe("standard ACP recovery", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: { invoke: invokeMock },
    });
    invokeMock.mockReset();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    bridge.invalidateModelCatalog("cursor");
    bridge.invalidateModelCatalog("grok");
    bridge.invalidateModelCatalog("kimi");
  });

  it("revalidates cached Grok ACP liveness before submitting a prompt", async () => {
    let nativeAlive = true;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "app_bootstrap") return { value: {} };
      if (command === "local_export") return nativeGrokExport("task-grok-dead-cache");
      if (command === "acp_connect") {
        nativeAlive = true;
        return undefined;
      }
      if (command === "acp_session_capabilities") {
        if (!nativeAlive) {
          throw {
            code: "provider-disconnected",
            message: "ACP session is not connected for this task",
          };
        }
        return { load: true, resume: true, mcpHttp: true, mcpSse: true };
      }
      if (command === "acp_start_session" || command === "acp_resume_session") {
        return { sessionId: "grok-session-recovered" };
      }
      if (command === "acp_send_turn") {
        if (!nativeAlive) {
          throw {
            code: "provider-disconnected",
            message: "ACP session is not connected for this task",
          };
        }
        return { turnId: "grok-turn-recovered" };
      }
      return undefined;
    });

    await bridge.loadWorkspace();
    const input = {
      taskId: "task-grok-dead-cache",
      prompt: "Reply after reconnect",
      runtime: "grok" as const,
      model: "grok-4.6",
      effort: "high",
      permission: "project-write" as const,
      delegation: "off" as const,
    };
    await expect(bridge.sendTurn(input)).resolves.toMatchObject({
      kind: "user",
      body: "Reply after reconnect",
    });
    nativeAlive = false;

    await expect(bridge.sendTurn(input)).resolves.toMatchObject({
      kind: "user",
      body: "Reply after reconnect",
    });
    expect(invokeMock.mock.calls.filter(([command]) => command === "acp_connect")).toHaveLength(2);
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "acp_session_capabilities"),
    ).toHaveLength(3);
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "acp_start_session"),
    ).toHaveLength(1);
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "acp_resume_session"),
    ).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([command]) => command === "acp_send_turn")).toEqual([
      [
        "acp_send_turn",
        {
          taskId: "task-grok-dead-cache",
          prompt: "Reply after reconnect",
          delegation: "off",
          nativeActionId: undefined,
          contextReferences: undefined,
          resumeInterrupted: undefined,
        },
      ],
      [
        "acp_send_turn",
        {
          taskId: "task-grok-dead-cache",
          prompt: "Reply after reconnect",
          delegation: "off",
          nativeActionId: undefined,
          contextReferences: undefined,
          resumeInterrupted: undefined,
        },
      ],
    ]);
  });

  it("retries one Grok submission only after a definitive pre-submit disconnect", async () => {
    let sendAttempts = 0;
    const acceptedPrompts: string[] = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "app_bootstrap") return { value: {} };
      if (command === "local_export") return nativeGrokExport("task-grok-submit-race");
      if (command === "acp_session_capabilities") {
        return { load: true, resume: true, mcpHttp: true, mcpSse: true };
      }
      if (command === "acp_start_session" || command === "acp_resume_session") {
        return { sessionId: "grok-session-race" };
      }
      if (command === "acp_send_turn") {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          throw {
            code: "provider-disconnected",
            message: "Grok session is not bound to this task",
          };
        }
        acceptedPrompts.push(String(args?.prompt));
        return { turnId: "grok-turn-race" };
      }
      return undefined;
    });

    await bridge.loadWorkspace();
    const input = {
      taskId: "task-grok-submit-race",
      prompt: "Submit exactly once",
      runtime: "grok" as const,
      model: "grok-4.6",
      effort: "high",
      permission: "project-write" as const,
      delegation: "off" as const,
    };

    await expect(bridge.sendTurn(input)).resolves.toMatchObject({ kind: "user" });
    expect(sendAttempts).toBe(2);
    expect(acceptedPrompts).toEqual(["Submit exactly once"]);
    expect(invokeMock.mock.calls.filter(([command]) => command === "acp_connect")).toHaveLength(2);
  });

  it("does not retry Grok when prompt submission outcome is uncertain", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "app_bootstrap") return { value: {} };
      if (command === "local_export") return nativeGrokExport("task-grok-uncertain");
      if (command === "acp_session_capabilities") {
        return { load: true, resume: true, mcpHttp: true, mcpSse: true };
      }
      if (command === "acp_start_session") return { sessionId: "grok-session-uncertain" };
      if (command === "acp_send_turn") {
        throw {
          code: "provider-unavailable",
          message: "Prompt submission outcome is uncertain",
        };
      }
      return undefined;
    });

    await bridge.loadWorkspace();
    await expect(
      bridge.sendTurn({
        taskId: "task-grok-uncertain",
        prompt: "Do not duplicate this",
        runtime: "grok",
        model: "grok-4.6",
        effort: "high",
        permission: "project-write",
        delegation: "off",
      }),
    ).rejects.toThrow("Prompt submission outcome is uncertain");
    expect(invokeMock.mock.calls.filter(([command]) => command === "acp_send_turn")).toHaveLength(
      1,
    );
    expect(invokeMock.mock.calls.filter(([command]) => command === "acp_connect")).toHaveLength(1);
  });

  it("serializes ACP providers through prompt admission for the same task", async () => {
    let releaseCursorConnect: (() => void) | undefined;
    const cursorConnectGate = new Promise<void>((resolve) => {
      releaseCursorConnect = resolve;
    });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "app_bootstrap") return { value: {} };
      if (command === "local_export") return nativeGrokExport("task-acp-provider-race");
      if (command === "acp_connect" && args?.provider === "cursor") {
        await cursorConnectGate;
        return undefined;
      }
      if (command === "acp_connect") return undefined;
      if (command === "acp_session_capabilities") {
        return { load: true, resume: true, mcpHttp: true, mcpSse: true };
      }
      if (command === "acp_list_cursor_models") {
        return {
          models: [{ value: "cursor-model", name: "Cursor model", configOptions: [] }],
        };
      }
      if (command === "acp_start_session") return { sessionId: "grok-session-serialized" };
      if (command === "acp_send_turn") return { turnId: "grok-turn-serialized" };
      return undefined;
    });

    await bridge.loadWorkspace();
    bridge.invalidateModelCatalog("cursor");
    const cursorCatalog = bridge.listModelCatalog("cursor");
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "acp_connect",
        expect.objectContaining({ provider: "cursor", taskId: "task-acp-provider-race" }),
      ),
    );
    const grokTurn = bridge.sendTurn({
      taskId: "task-acp-provider-race",
      prompt: "Reply after the competing probe",
      runtime: "grok",
      model: "grok-4.6",
      effort: "high",
      permission: "project-write",
      delegation: "off",
    });
    await Promise.resolve();

    expect(
      invokeMock.mock.calls.some(
        ([command, args]) => command === "acp_connect" && args?.provider === "grok",
      ),
    ).toBe(false);
    releaseCursorConnect?.();

    await expect(cursorCatalog).resolves.toEqual([expect.objectContaining({ id: "cursor-model" })]);
    await expect(grokTurn).resolves.toMatchObject({ kind: "user" });
    expect(
      invokeMock.mock.calls
        .filter(([command]) =>
          ["acp_connect", "acp_list_cursor_models", "acp_start_session", "acp_send_turn"].includes(
            String(command),
          ),
        )
        .map(([command, args]) =>
          command === "acp_connect" ? `${command}:${String(args?.provider)}` : command,
        ),
    ).toEqual([
      "acp_connect:cursor",
      "acp_list_cursor_models",
      "acp_connect:grok",
      "acp_start_session",
      "acp_send_turn",
    ]);
  });
});
