// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { bridgeMock, rightRailProbe, sidebarProbe } = vi.hoisted(() => ({
  rightRailProbe: { enabled: false },
  sidebarProbe: {
    enabled: false,
    comparisons: 0,
    executions: 0,
    changedKeys: [] as string[][],
  },
  bridgeMock: {
    loadWorkspace: vi.fn(),
    subscribeRuntimeProjections: vi.fn(),
    loadTaskProjection: vi.fn(),
    respondToApproval: vi.fn(),
    setSessionMode: vi.fn(),
    stopTurn: vi.fn(),
    persistSession: vi.fn(),
    probeRuntimes: vi.fn(),
    beginRuntimeLogin: vi.fn(),
    listRuntimeActionPlans: vi.fn(),
    listSettings: vi.fn(),
    setSetting: vi.fn(),
    getAppInfo: vi.fn(),
    openProject: vi.fn(),
    registerProject: vi.fn(),
    listProjects: vi.fn(),
    createChat: vi.fn(),
    startTask: vi.fn(),
    generateTaskTitle: vi.fn(),
    loadTaskGit: vi.fn(),
    loadProjectGit: vi.fn(),
    loadTaskGitFile: vi.fn(),
    loadProjectGitFile: vi.fn(),
    subscribeWorkingTreeChanges: vi.fn(),
    listProjectFiles: vi.fn(),
    readProjectFile: vi.fn(),
    listProjectFileOpeners: vi.fn(),
    openProjectFileExternal: vi.fn(),
    revealProjectFile: vi.fn(),
    pickContextAttachments: vi.fn(),
    savePastedImageAttachment: vi.fn(),
    listNativeProviderActions: vi.fn(),
    listIntegratorSkills: vi.fn(),
    listIntegratorMcps: vi.fn(),
    searchTaskMessages: vi.fn(),
    listArchivedTasks: vi.fn(),
    supportsTaskMetadata: vi.fn(),
    updateTaskMetadata: vi.fn(),
    updateTaskRouting: vi.fn(),
    setTaskStatus: vi.fn(),
    sendTurn: vi.fn(),
    enqueueMessage: vi.fn(),
    listQueuedMessages: vi.fn(),
    reorderQueuedMessages: vi.fn(),
    takeQueuedMessage: vi.fn(),
    setQueuedMessageDispatching: vi.fn(),
    steerTurn: vi.fn(),
    listModelCatalog: vi.fn(),
    getCachedModelCatalog: vi.fn(),
    refreshModelCatalog: vi.fn(),
    invalidateModelCatalog: vi.fn(),
    subscribeModelCatalogs: vi.fn(),
    listDelegations: vi.fn(),
    subscribeDelegationUpdates: vi.fn(),
    sendDelegationMessage: vi.fn(),
    stopDelegation: vi.fn(),
    automationTimeline: vi.fn(),
    subscribeAutomationChanges: vi.fn(),
    subscribeAutomationDue: vi.fn(),
    pendingAutomationDispatches: vi.fn(),
    finishAutomationRun: vi.fn(),
    cancelAutomation: vi.fn(),
    stageFiles: vi.fn(),
    stageProjectFiles: vi.fn(),
    commit: vi.fn(),
    commitProject: vi.fn(),
    generateCommitMessage: vi.fn(),
    previewPush: vi.fn(),
    previewProjectPush: vi.fn(),
    confirmPush: vi.fn(),
    confirmProjectPush: vi.fn(),
    push: vi.fn(),
  },
}));

vi.mock("./bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bridge")>();
  return { ...actual, bridge: bridgeMock };
});

vi.mock("./components/RightRail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/RightRail")>();
  const React = await import("react");
  return {
    ...actual,
    RightRail: (props: ComponentProps<typeof actual.RightRail>) =>
      rightRailProbe.enabled ? React.createElement(actual.RightRail, props) : null,
  };
});

vi.mock("./components/TaskSidebar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/TaskSidebar")>();
  const React = await import("react");
  const ProbedTaskSidebar = React.memo(
    (props: ComponentProps<typeof actual.TaskSidebar>) => {
      if (sidebarProbe.enabled) sidebarProbe.executions += 1;
      return React.createElement(actual.TaskSidebar, props);
    },
    (previous, next) => {
      if (!sidebarProbe.enabled) return false;
      const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
      const changedKeys = [...keys].filter(
        (key) => !Object.is(Reflect.get(previous, key), Reflect.get(next, key)),
      );
      sidebarProbe.comparisons += 1;
      sidebarProbe.changedKeys.push(changedKeys);
      return changedKeys.length === 0;
    },
  );
  return { ...actual, TaskSidebar: ProbedTaskSidebar };
});

import App from "./App";
import type {
  LoadTaskProjectionOptions,
  RuntimeProjectionEvent,
  TaskSummary,
  TaskProjectionSnapshot,
} from "./bridge";
import { createEmptySnapshot } from "./demoData";
import { applyRuntimeProjectionBatch, createRuntimeProjectionState } from "./runtimeProjection";

let runtimeListener: ((event: RuntimeProjectionEvent) => void) | undefined;
let delegationListener: ((parentTaskId: string) => void) | undefined;
let workingTreeListener: (() => void) | undefined;

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

function projectionSnapshot(input: {
  events?: RuntimeProjectionEvent[];
  watermarkSeq: number;
  runtimeLive: boolean;
  resetSeq?: number;
  taskId?: string;
}): TaskProjectionSnapshot {
  const taskId = input.taskId ?? input.events?.[0]?.taskId ?? "task-1";
  const state = applyRuntimeProjectionBatch(
    createRuntimeProjectionState(taskId),
    [...(input.events ?? [])].sort((a, b) => a.seq - b.seq),
  );
  return {
    watermarkSeq: input.watermarkSeq,
    resetSeq: input.resetSeq ?? 0,
    runtimeLive: input.runtimeLive,
    hydrate: {
      turn: state.turn,
      items: state.items,
      plan: state.plan,
      planTruncated: state.planTruncated,
      diff: state.diff,
      usage: state.usage,
      approvals: state.approvals,
      mode: state.mode,
      connection: state.connection,
      error: state.errors[0],
      firstSeen: state.firstSeen,
      hasMoreOlder: false,
    },
  };
}

function queuedMessage(prompt = "Follow up") {
  return {
    taskId: "task-1",
    id: "queued-1",
    prompt,
    attachments: [],
    runtime: "codex" as const,
    model: "Provider default",
    permission: "project-write" as const,
    delegation: "off" as const,
    position: 0,
    state: "queued" as const,
    createdAt: "2026-07-10T16:00:02Z",
    updatedAt: "2026-07-10T16:00:02Z",
  };
}

describe("native runtime recovery UI", () => {
  beforeEach(() => {
    const localValues = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: () => localValues.clear(),
        getItem: (key: string) => localValues.get(key) ?? null,
        key: (index: number) => [...localValues.keys()][index] ?? null,
        get length() {
          return localValues.size;
        },
        removeItem: (key: string) => localValues.delete(key),
        setItem: (key: string, value: string) => localValues.set(key, value),
      },
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    for (const value of Object.values(bridgeMock)) value.mockReset();
    sidebarProbe.enabled = false;
    rightRailProbe.enabled = false;
    sidebarProbe.comparisons = 0;
    sidebarProbe.executions = 0;
    sidebarProbe.changedKeys = [];
    bridgeMock.listProjectFileOpeners.mockResolvedValue([]);
    bridgeMock.pickContextAttachments.mockResolvedValue(null);
    runtimeListener = undefined;
    delegationListener = undefined;
    workingTreeListener = undefined;
    bridgeMock.subscribeRuntimeProjections.mockImplementation(async (listener) => {
      runtimeListener = listener;
      return vi.fn();
    });
    bridgeMock.subscribeWorkingTreeChanges.mockImplementation(async (_repository, listener) => {
      workingTreeListener = listener;
      return vi.fn();
    });
    bridgeMock.supportsTaskMetadata.mockReturnValue(true);
    bridgeMock.searchTaskMessages.mockResolvedValue([]);
    bridgeMock.listArchivedTasks.mockResolvedValue({ tasks: [], total: 0 });
    bridgeMock.listNativeProviderActions.mockResolvedValue([]);
    bridgeMock.listIntegratorSkills.mockResolvedValue({
      skillsRoot: "",
      pluginsRoot: "",
      bundledAvailable: true,
      skills: [],
    });
    bridgeMock.listIntegratorMcps.mockResolvedValue({ mcpsRoot: "", servers: [] });
    bridgeMock.listDelegations.mockResolvedValue([]);
    bridgeMock.automationTimeline.mockResolvedValue([]);
    bridgeMock.subscribeAutomationChanges.mockResolvedValue(vi.fn());
    bridgeMock.subscribeAutomationDue.mockResolvedValue(vi.fn());
    bridgeMock.pendingAutomationDispatches.mockResolvedValue([]);
    bridgeMock.listModelCatalog.mockResolvedValue([]);
    bridgeMock.getCachedModelCatalog.mockReturnValue(undefined);
    bridgeMock.subscribeModelCatalogs.mockReturnValue(vi.fn());
    bridgeMock.listSettings.mockResolvedValue([]);
    bridgeMock.setSetting.mockResolvedValue(undefined);
    bridgeMock.updateTaskRouting.mockResolvedValue(undefined);
    bridgeMock.generateTaskTitle.mockResolvedValue(null);
    bridgeMock.createChat.mockResolvedValue({
      id: "general-chat-1",
      projectId: "__integrator_chats__",
      kind: "chat",
      title: "New chat",
      status: "draft",
      runtime: "codex",
      model: "Provider default",
      updatedAt: "2026-07-19T19:00:00Z",
    });
    bridgeMock.listQueuedMessages.mockResolvedValue([]);
    bridgeMock.steerTurn.mockResolvedValue(false);
    bridgeMock.enqueueMessage.mockImplementation(async (input) => ({
      ...input,
      id: "queued-1",
      position: 0,
      state: "queued",
      createdAt: "2026-07-10T16:00:02Z",
      updatedAt: "2026-07-10T16:00:02Z",
    }));
    bridgeMock.setQueuedMessageDispatching.mockImplementation(
      async (_taskId, _messageId, dispatching) => ({
        taskId: "task-1",
        id: "queued-1",
        prompt: "Follow up",
        attachments: [],
        runtime: "codex",
        model: "Provider default",
        permission: "project-write",
        delegation: "off",
        position: 0,
        state: dispatching ? "dispatching" : "queued",
        createdAt: "2026-07-10T16:00:02Z",
        updatedAt: "2026-07-10T16:00:02Z",
      }),
    );
    bridgeMock.generateCommitMessage.mockResolvedValue("feat: generate commit subjects");
    bridgeMock.getAppInfo.mockResolvedValue({
      applicationVersion: "test",
      domainSchemaVersion: 2,
      dataDirectory: "H:\\AppData\\Integrator",
      localOnly: true,
    });
    bridgeMock.subscribeDelegationUpdates.mockImplementation(async (listener) => {
      delegationListener = listener;
      return vi.fn();
    });
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
    bridgeMock.listProjectFiles.mockResolvedValue([]);
    bridgeMock.loadTaskGit.mockResolvedValue(workspace.git);
    bridgeMock.loadProjectGit.mockResolvedValue(workspace.git);
    bridgeMock.loadTaskGitFile.mockImplementation(async (_taskId, file) => file);
    bridgeMock.loadProjectGitFile.mockImplementation(async (_projectId, file) => file);
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
      return projectionSnapshot({
        watermarkSeq: 8,
        runtimeLive: true,
        events: [
          projection(5, {
            kind: "turnChanged",
            turn: {
              id: "turn-1",
              status: "inProgress",
              stopRequested: false,
              startedAt: new Date(Date.now() - 125 * 60_000).toISOString(),
            },
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
      });
    });
    bridgeMock.respondToApproval.mockResolvedValue({});
    bridgeMock.setTaskStatus.mockResolvedValue(undefined);
    bridgeMock.stopTurn.mockResolvedValue({
      turnId: "turn-1",
      stopRequested: true,
      alreadyRequested: false,
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("opens the global Chat welcome without adding the empty chat to the sidebar", async () => {
    render(<App />);

    const sidebar = await screen.findByRole("complementary", { name: "Chat navigation" });
    const newChatButton = within(sidebar).getByRole("button", { name: /^New chat.*N$/ });
    fireEvent.click(newChatButton);

    await waitFor(() =>
      expect(bridgeMock.createChat).toHaveBeenCalledWith({
        runtime: "codex",
        model: "Provider default",
      }),
    );
    expect(await screen.findByRole("heading", { name: "What can I help you with?" })).toBeVisible();
    expect(within(sidebar).queryByText("New chat", { selector: ".chat-row-title" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Permission" })).not.toBeInTheDocument();
    const titlebar = document.querySelector<HTMLElement>(".native-titlebar");
    expect(titlebar).not.toBeNull();
    expect(within(titlebar!).getByRole("button", { name: "Open work pane" })).toBeVisible();
    expect(within(titlebar!).queryByRole("button", { name: "Toggle terminal" })).toBeNull();
    expect(within(titlebar!).queryByRole("button", { name: "Open task tools" })).toBeNull();

    fireEvent.click(within(titlebar!).getByRole("button", { name: "Open work pane" }));
    const workPane = document.querySelector<HTMLElement>(".work-pane");
    expect(workPane).not.toBeNull();
    expect(await within(workPane!).findByRole("button", { name: /^Browser/ })).toBeDisabled();
    expect(within(workPane!).queryByRole("button", { name: /^Review changes/ })).toBeNull();
    expect(within(workPane!).queryByRole("button", { name: /^Files/ })).toBeNull();
    expect(within(workPane!).queryByRole("button", { name: /^Subagents/ })).toBeNull();
  });

  it("sends Chat through the selected runtime without relaxing its safety route", async () => {
    const workspace = createEmptySnapshot();
    workspace.tasks = [
      {
        id: "chat-route-1",
        projectId: "__integrator_chats__",
        kind: "chat",
        title: "New chat",
        status: "draft",
        runtime: "codex",
        model: "gpt-5.6-luna",
        updatedAt: "2026-07-19T19:00:00Z",
      },
    ];
    workspace.activeTaskId = "chat-route-1";
    workspace.runtimes = [
      {
        id: "codex",
        name: "Codex",
        command: "codex",
        status: "connected",
        fidelity: "native",
        models: ["gpt-5.6-luna"],
        detail: "Ready",
      },
      {
        id: "claude",
        name: "Claude Code",
        command: "claude",
        status: "connected",
        fidelity: "structured",
        models: ["claude-sonnet-4-6"],
        detail: "Ready",
      },
    ];
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.loadTaskProjection.mockResolvedValue(
      projectionSnapshot({ watermarkSeq: 0, runtimeLive: false, taskId: "chat-route-1" }),
    );
    bridgeMock.listModelCatalog.mockImplementation(async (runtime) =>
      runtime === "claude"
        ? [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }]
        : [{ id: "gpt-5.6-luna", label: "GPT-5.6 Luna" }],
    );
    bridgeMock.sendTurn.mockResolvedValue({
      id: "chat-route-user",
      kind: "user",
      body: "Compare these ideas",
      timestamp: "2026-07-19T19:01:00Z",
      status: "neutral",
    });
    bridgeMock.pickContextAttachments.mockResolvedValue([
      {
        path: "/app/chat-attachments/chat-route-1/notes.txt",
        name: "notes.txt",
        kind: "file",
      },
    ]);

    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "What can I help you with?" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    fireEvent.click(screen.getByRole("option", { name: "Claude Code" }));
    await waitFor(() =>
      expect(bridgeMock.updateTaskRouting).toHaveBeenCalledWith(
        "chat-route-1",
        expect.objectContaining({ runtime: "claude" }),
      ),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Attach files or images from your computer" }),
    );
    expect(await screen.findByText("notes.txt")).toBeVisible();
    expect(bridgeMock.pickContextAttachments).toHaveBeenCalledWith("chat-route-1");

    fireEvent.change(screen.getByRole("textbox", { name: "Task message" }), {
      target: { value: "Compare these ideas" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(bridgeMock.setTaskStatus).toHaveBeenCalledWith("chat-route-1", "starting"),
    );
    await waitFor(() =>
      expect(bridgeMock.sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "chat-route-1",
          attachments: [expect.objectContaining({ name: "notes.txt", kind: "file" })],
          runtime: "claude",
          permission: "read-only",
          delegation: "off",
        }),
      ),
    );
    await waitFor(
      () =>
        expect(bridgeMock.generateTaskTitle).toHaveBeenCalledWith({
          taskId: "chat-route-1",
          prompt: "Compare these ideas",
          runtime: "claude",
          route: { runtime: "claude", fallbacks: [] },
        }),
      { timeout: 4_000 },
    );
  });

  it("keeps a backend-attested live turn running across snapshot recovery", async () => {
    render(<App />);

    expect(
      await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Buffered after the snapshot watermark.")).toBeInTheDocument();
    expect(bridgeMock.probeRuntimes).toHaveBeenCalledTimes(1);
    expect(bridgeMock.loadTaskGit).toHaveBeenCalledWith("task-1");
    expect(bridgeMock.listProjectFiles).not.toHaveBeenCalled();
    // Connection notices render after a grace delay to avoid flashing on
    // fast transitions, so wait for them instead of querying synchronously.
    expect(
      await screen.findByText("Some runtime events were missed", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(bridgeMock.subscribeRuntimeProjections.mock.invocationCallOrder[0]).toBeLessThan(
      bridgeMock.loadWorkspace.mock.invocationCallOrder[0],
    );

    // No connection event landed during hydration. The snapshot's native
    // liveness attestation keeps the turn active and its original clock intact.
    expect(screen.queryByText("Response interrupted")).not.toBeInTheDocument();
    expect(screen.getByText("2h 5m")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop turn" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run command" }));
    await waitFor(() =>
      expect(bridgeMock.respondToApproval).toHaveBeenCalledWith("task-1", "approval-1", "accept"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop turn" }));
    await waitFor(() => expect(bridgeMock.stopTurn).toHaveBeenCalledWith("task-1"));
  });

  it("shows persisted history while runtime authority reconciles in the background", async () => {
    const persisted = projectionSnapshot({
      watermarkSeq: 3,
      runtimeLive: false,
      events: [
        projection(1, {
          kind: "connectionChanged",
          state: "connected",
          processId: "process-1",
        }),
        projection(2, {
          kind: "itemChanged",
          item: {
            id: "codex:thread-1:turn-1:item-persisted",
            providerItemId: "item-persisted",
            kind: "agentMessage",
            status: "completed",
            body: "Visible from durable local history.",
            truncated: false,
            updatedAt: "2026-07-10T16:00:00Z",
          },
        }),
        projection(3, {
          kind: "approvalChanged",
          approval: {
            id: "approval-stale-until-checked",
            requestId: { kind: "string", value: "request-stale-until-checked" },
            approvalKind: "commandExecution",
            state: "pending",
            command: "npm test",
            updatedAt: "2026-07-10T16:00:00Z",
          },
        }),
      ],
    });
    let resolveAuthority!: (snapshot: TaskProjectionSnapshot) => void;
    const authority = new Promise<TaskProjectionSnapshot>((resolve) => {
      resolveAuthority = resolve;
    });
    bridgeMock.loadTaskProjection.mockImplementation(
      async (_taskId: string, options?: LoadTaskProjectionOptions) =>
        options?.skipRuntimeCheck ? persisted : authority,
    );

    render(<App />);

    expect(
      await screen.findByText("Visible from durable local history.", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    expect(screen.queryByText("Reconciling persisted task state…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run command" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Task message" }), {
      target: { value: "Wait for authority" },
    });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    act(() =>
      resolveAuthority({
        ...persisted,
        runtimeLive: true,
        cacheMatched: true,
        hydrate: undefined,
      }),
    );

    expect(await screen.findByRole("button", { name: "Run command" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).not.toBeDisabled(),
    );
  }, 30_000);

  it("keeps a restored empty chat quiet while its runtime check is still pending", async () => {
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
        title: "New chat",
        status: "draft",
        runtime: "codex",
        model: "Provider default",
        updatedAt: "2026-07-10T16:00:00Z",
      },
    ];
    workspace.activeProjectId = "project-1";
    workspace.activeTaskId = "task-1";
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    // No persisted events: hydrate carries the "reconciling" placeholder
    // connection, and the authority check (runtime liveness probe) never
    // resolves within the notice grace period.
    const persisted = projectionSnapshot({ watermarkSeq: 0, runtimeLive: false });
    bridgeMock.loadTaskProjection.mockImplementation(
      async (_taskId: string, options?: LoadTaskProjectionOptions) =>
        options?.skipRuntimeCheck
          ? persisted
          : new Promise<TaskProjectionSnapshot>(() => undefined),
    );

    render(<App />);

    await screen.findByRole("textbox", { name: "Task message" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    expect(screen.queryByText("Reconciling persisted task state…")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading persisted task state")).not.toBeInTheDocument();
  }, 30_000);

  it("preserves persisted history and fails closed when runtime authority is unavailable", async () => {
    const persisted = projectionSnapshot({
      watermarkSeq: 3,
      runtimeLive: false,
      events: [
        projection(1, {
          kind: "connectionChanged",
          state: "connected",
          processId: "process-1",
        }),
        projection(2, {
          kind: "itemChanged",
          item: {
            id: "codex:thread-1:turn-1:item-degraded",
            providerItemId: "item-degraded",
            kind: "agentMessage",
            status: "completed",
            body: "Durable history survives a failed authority check.",
            truncated: false,
            updatedAt: "2026-07-10T16:00:00Z",
          },
        }),
        projection(3, {
          kind: "approvalChanged",
          approval: {
            id: "approval-degraded",
            requestId: { kind: "string", value: "request-degraded" },
            approvalKind: "commandExecution",
            state: "pending",
            command: "npm test",
            updatedAt: "2026-07-10T16:00:00Z",
          },
        }),
      ],
    });
    bridgeMock.loadTaskProjection.mockImplementation(
      async (_taskId: string, options?: LoadTaskProjectionOptions) => {
        if (options?.skipRuntimeCheck) return persisted;
        throw new Error("Runtime authority check failed");
      },
    );

    render(<App />);

    expect(
      await screen.findByText(
        "Durable history survives a failed authority check.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText("Runtime authority check failed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run command" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Task message" }), {
      target: { value: "Keep this draft local" },
    });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(bridgeMock.sendTurn).not.toHaveBeenCalled();
  }, 30_000);

  it("offers a noninterruptive resume control for a transport-interrupted turn", async () => {
    bridgeMock.loadTaskProjection.mockResolvedValue(
      projectionSnapshot({
        watermarkSeq: 1,
        runtimeLive: false,
        events: [
          projection(1, {
            kind: "turnChanged",
            turn: {
              id: "turn-interrupted",
              status: "interrupted",
              stopRequested: false,
              startedAt: "2026-07-10T16:00:00Z",
              completedAt: "2026-07-10T16:00:03Z",
            },
          }),
        ],
      }),
    );
    bridgeMock.sendTurn.mockResolvedValue({
      id: "resume-user",
      kind: "user",
      body: "Resume from here",
      timestamp: "2026-07-10T16:01:00Z",
      status: "neutral",
    });

    render(<App />);
    expect(await screen.findByText("Response interrupted")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() =>
      expect(bridgeMock.sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "task-1",
          prompt: "Resume from here",
          runtime: "codex",
          resumeInterrupted: true,
        }),
      ),
    );
  });

  it("hides resume recovery when the user stopped the turn", async () => {
    bridgeMock.loadTaskProjection.mockResolvedValue(
      projectionSnapshot({
        watermarkSeq: 1,
        runtimeLive: false,
        events: [
          projection(1, {
            kind: "turnChanged",
            turn: {
              id: "turn-stopped",
              status: "interrupted",
              stopRequested: true,
              startedAt: "2026-07-10T16:00:00Z",
              completedAt: "2026-07-10T16:00:03Z",
            },
          }),
        ],
      }),
    );

    render(<App />);
    await waitFor(() => expect(bridgeMock.loadTaskProjection).toHaveBeenCalled());
    expect(screen.queryByText("Response interrupted")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
  });

  it("never auto-resumes an interrupted turn; Resume stays explicit", async () => {
    bridgeMock.loadTaskProjection.mockResolvedValue(
      projectionSnapshot({
        watermarkSeq: 1,
        runtimeLive: false,
        events: [
          projection(1, {
            kind: "turnChanged",
            turn: {
              id: "turn-interrupted",
              status: "interrupted",
              stopRequested: false,
              startedAt: "2026-07-10T16:00:00Z",
              completedAt: "2026-07-10T16:00:03Z",
            },
          }),
        ],
      }),
    );

    render(<App />);
    expect(await screen.findByText("Response interrupted")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridgeMock.sendTurn).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("does not resume when the user stopped the turn", async () => {
    bridgeMock.loadTaskProjection.mockResolvedValue(
      projectionSnapshot({
        watermarkSeq: 1,
        runtimeLive: false,
        events: [
          projection(1, {
            kind: "turnChanged",
            turn: {
              id: "turn-stopped",
              status: "interrupted",
              stopRequested: true,
              startedAt: "2026-07-10T16:00:00Z",
              completedAt: "2026-07-10T16:00:03Z",
            },
          }),
        ],
      }),
    );

    render(<App />);
    await waitFor(() => expect(bridgeMock.loadTaskProjection).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridgeMock.sendTurn).not.toHaveBeenCalled();
    expect(screen.queryByText("Response interrupted")).not.toBeInTheDocument();
  });

  it("does not resume after Stop even if a late interrupt clears stopRequested", async () => {
    render(<App />);
    expect(await screen.findByRole("button", { name: "Stop turn" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop turn" }));
    await waitFor(() => expect(bridgeMock.stopTurn).toHaveBeenCalledWith("task-1"));

    act(() => {
      runtimeListener?.(
        projection(20, {
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
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridgeMock.sendTurn).not.toHaveBeenCalled();
    expect(screen.queryByText("Response interrupted")).not.toBeInTheDocument();
  });

  it("publishes main text once per frame and flushes an urgent event in order", async () => {
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    const frameCallbacks = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        nextFrameId += 1;
        frameCallbacks.set(nextFrameId, callback);
        return nextFrameId;
      });
    const cancelFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((id) => void frameCallbacks.delete(id));
    const streamingItem = (body: string) => ({
      id: "codex:thread-1:turn-1:item-streaming",
      providerItemId: "item-streaming",
      kind: "agentMessage" as const,
      status: "inProgress" as const,
      body,
      truncated: false,
      updatedAt: "2026-07-10T16:00:02Z",
    });

    try {
      act(() => {
        for (let index = 0; index < 64; index += 1) {
          runtimeListener?.(
            projection(10 + index, {
              kind: "itemChanged",
              item: streamingItem(`Dense stream ${index + 1}`),
            }),
          );
        }
      });

      expect(screen.queryByText("Dense stream 64")).not.toBeInTheDocument();
      expect(requestFrame).toHaveBeenCalledTimes(1);
      expect(frameCallbacks.size).toBe(1);

      const [publicationFrameId, publicationFrame] = [...frameCallbacks.entries()][0];
      act(() => {
        frameCallbacks.delete(publicationFrameId);
        publicationFrame(0);
      });
      expect(await screen.findByText("Dense stream 64")).toBeInTheDocument();
      // Text-only itemChanged frames must not churn sidebar task status.
      const sidebar = screen.getByLabelText("Chat navigation");
      expect(within(sidebar).getByRole("button", { name: /Native recovery task/ })).toHaveAttribute(
        "data-status",
        "running",
      );

      act(() => {
        for (const [frameId, callback] of [...frameCallbacks]) {
          frameCallbacks.delete(frameId);
          callback(0);
        }
      });
      requestFrame.mockClear();
      cancelFrame.mockClear();

      act(() => {
        runtimeListener?.(
          projection(74, {
            kind: "itemChanged",
            item: streamingItem("Buffered immediately before urgent state"),
          }),
        );
      });
      expect(frameCallbacks.size).toBe(1);
      const pendingPublication = [...frameCallbacks.keys()][0];

      act(() => {
        runtimeListener?.(
          projection(75, {
            kind: "connectionChanged",
            state: "gap",
            reason: "urgent receiver gap",
          }),
        );
      });

      expect(cancelFrame).toHaveBeenCalledWith(pendingPublication);
      expect(
        await screen.findByText("Buffered immediately before urgent state"),
      ).toBeInTheDocument();
      expect(
        await screen.findByText("urgent receiver gap", {}, { timeout: 3000 }),
      ).toBeInTheDocument();
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it("stops every TaskSidebar prop change and execution on token-only frames", async () => {
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    const frameCallbacks = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        nextFrameId += 1;
        frameCallbacks.set(nextFrameId, callback);
        return nextFrameId;
      });
    const cancelFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((id) => void frameCallbacks.delete(id));
    const streamingItem = (body: string) => ({
      id: "codex:thread-1:turn-1:item-sidebar-probe",
      providerItemId: "item-sidebar-probe",
      kind: "agentMessage" as const,
      status: "inProgress" as const,
      body,
      truncated: false,
      updatedAt: "2026-07-10T16:00:02Z",
    });
    const flushFrames = () => {
      for (let pass = 0; pass < 8 && frameCallbacks.size > 0; pass += 1) {
        const callbacks = [...frameCallbacks.values()];
        frameCallbacks.clear();
        act(() => callbacks.forEach((callback) => callback(performance.now())));
      }
    };

    sidebarProbe.enabled = true;
    sidebarProbe.comparisons = 0;
    sidebarProbe.executions = 0;
    sidebarProbe.changedKeys = [];

    try {
      for (let index = 0; index < 30; index += 1) {
        act(() => {
          runtimeListener?.(
            projection(100 + index, {
              kind: "itemChanged",
              item: streamingItem(`Sidebar identity frame ${index + 1}`),
            }),
          );
        });
        flushFrames();
      }

      console.info(
        JSON.stringify({
          frames: 30,
          comparisons: sidebarProbe.comparisons,
          executions: sidebarProbe.executions,
          changedKeys: [...new Set(sidebarProbe.changedKeys.flat())].sort(),
        }),
      );

      expect(sidebarProbe.comparisons).toBeGreaterThanOrEqual(30);
      expect(sidebarProbe.changedKeys.every((keys) => keys.length === 0)).toBe(true);
      expect(sidebarProbe.executions).toBe(0);
    } finally {
      sidebarProbe.enabled = false;
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it("keeps the stable Sidebar Skills shortcut routed to its exact settings section", async () => {
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "Skills & plugins" }));
    expect(await screen.findByRole("heading", { name: "Skills and Plugins" })).toBeVisible();
  });

  it("keeps the stable Sidebar Subagents shortcut routed to its exact settings section", async () => {
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "Subagents" }));
    expect(await screen.findByRole("heading", { name: "Subagents" })).toBeVisible();
  });

  it("preserves health-error clearing across connected then disconnected events", async () => {
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    act(() => {
      runtimeListener?.(
        projection(10, {
          kind: "turnError",
          message: "Provider connection lost",
          retryable: true,
        }),
      );
      runtimeListener?.(
        projection(11, {
          kind: "connectionChanged",
          state: "connected",
          processId: "process-verified",
        }),
      );
      runtimeListener?.(
        projection(12, {
          kind: "connectionChanged",
          state: "disconnected",
          reason: "Provider process exited after verification",
        }),
      );
    });

    expect(await screen.findByText("Codex is disconnected", {}, { timeout: 3000 })).toBeVisible();
    expect(screen.getByText("Provider process exited after verification")).toBeVisible();
    expect(screen.queryByText("Provider connection lost")).not.toBeInTheDocument();
  });

  it("replaces stale disconnect copy while connecting and disappears when connected", async () => {
    const workspace = await bridgeMock.loadWorkspace();
    workspace.tasks = workspace.tasks.map((task: TaskSummary) => ({
      ...task,
      runtime: "cursor" as const,
    }));
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);

    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    act(() => {
      runtimeListener?.(
        projection(10, {
          kind: "connectionChanged",
          state: "disconnected",
          reason: "Cursor is not connected",
        }),
      );
    });
    expect(await screen.findByText("Cursor is disconnected")).toBeVisible();

    act(() => {
      runtimeListener?.(
        projection(11, {
          kind: "connectionChanged",
          state: "connecting",
        }),
      );
    });
    expect(screen.getByText("Connecting to Cursor…")).toBeVisible();
    expect(screen.queryByText("Cursor is disconnected")).not.toBeInTheDocument();
    expect(screen.queryByText("Cursor is not connected")).not.toBeInTheDocument();

    act(() => {
      runtimeListener?.(
        projection(12, {
          kind: "connectionChanged",
          state: "connected",
          processId: "cursor-process",
        }),
      );
    });
    expect(screen.queryByText("Connecting to Cursor…")).not.toBeInTheDocument();
    expect(document.querySelector(".runtime-connection")).toBeNull();
  }, 10_000);

  it("does not present an idle Antigravity chat as disconnected when switching tabs", async () => {
    const workspace = await bridgeMock.loadWorkspace();
    workspace.tasks.push({
      id: "task-2",
      projectId: "project-1",
      title: "Idle Antigravity chat",
      status: "completed",
      runtime: "antigravity",
      model: "Gemini 3.5 Pro",
      updatedAt: "2026-07-10T15:00:00Z",
    });
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.loadTaskProjection.mockImplementation(async (taskId: string) => {
      if (taskId !== "task-2") {
        return projectionSnapshot({ watermarkSeq: 0, runtimeLive: false, events: [] });
      }
      return projectionSnapshot({
        taskId,
        watermarkSeq: 2,
        runtimeLive: false,
        events: [
          {
            ...projection(1, {
              kind: "turnChanged",
              turn: {
                id: "turn-complete",
                status: "completed",
                stopRequested: false,
                completedAt: "2026-07-10T15:00:00Z",
              },
            }),
            taskId,
            provider: "antigravity",
          },
          {
            ...projection(2, {
              kind: "connectionChanged",
              state: "disconnected",
              reason: "Turn process exited",
            }),
            taskId,
            provider: "antigravity",
          },
        ],
      });
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Idle Antigravity chat/i }));
    await waitFor(() =>
      expect(bridgeMock.loadTaskProjection).toHaveBeenCalledWith("task-2", expect.any(Object)),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });

    expect(screen.queryByText("Antigravity is disconnected")).not.toBeInTheDocument();
    expect(document.querySelector(".runtime-connection")).toBeNull();
  });

  it("queues a typed follow-up instead of starting a competing turn", async () => {
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    fireEvent.change(screen.getByRole("textbox", { name: "Task message" }), {
      target: { value: "Follow up" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(bridgeMock.enqueueMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "task-1",
          prompt: "Follow up",
          attachments: [],
          runtime: "codex",
        }),
      ),
    );
    expect(bridgeMock.sendTurn).not.toHaveBeenCalled();
    expect(screen.getByText("Follow up")).toBeInTheDocument();
  });

  it("queues while the authoritative turn is still pending", async () => {
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    act(() => {
      runtimeListener?.(
        projection(10, {
          kind: "turnChanged",
          turn: {
            id: "turn-pending",
            status: "pending",
            stopRequested: false,
            startedAt: new Date().toISOString(),
          },
        }),
      );
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Task message" }), {
      target: { value: "Queue during startup" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(bridgeMock.enqueueMessage).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task-1", prompt: "Queue during startup" }),
      ),
    );
    expect(bridgeMock.sendTurn).not.toHaveBeenCalled();
  });

  it("queues a stale-projection send when native admission reports an active turn", async () => {
    let nativeRejectedTurn = false;
    bridgeMock.loadTaskProjection.mockImplementation(async () =>
      projectionSnapshot({
        watermarkSeq: nativeRejectedTurn ? 10 : 9,
        runtimeLive: true,
        events: [
          projection(nativeRejectedTurn ? 10 : 9, {
            kind: "turnChanged",
            turn: {
              id: "turn-1",
              status: nativeRejectedTurn ? "inProgress" : "completed",
              stopRequested: false,
              startedAt: "2026-07-10T16:00:00Z",
              completedAt: nativeRejectedTurn ? undefined : "2026-07-10T16:00:01Z",
            },
          }),
        ],
      }),
    );
    bridgeMock.sendTurn
      .mockImplementationOnce(async () => {
        nativeRejectedTurn = true;
        throw new Error("A turn is already running for this chat (turn-active)");
      })
      .mockResolvedValueOnce(undefined);
    bridgeMock.takeQueuedMessage.mockResolvedValue(queuedMessage("Keep this follow-up"));
    bridgeMock.listQueuedMessages.mockResolvedValue([]);

    render(<App />);
    await waitFor(() =>
      expect(bridgeMock.loadTaskProjection).toHaveBeenCalledWith("task-1", expect.any(Object)),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Task message" }), {
      target: { value: "Keep this follow-up" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(bridgeMock.enqueueMessage).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task-1", prompt: "Keep this follow-up" }),
      ),
    );
    expect(await screen.findByText("Keep this follow-up")).toBeInTheDocument();
    expect(screen.queryByText(/turn is already running/i)).not.toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    expect(bridgeMock.sendTurn).toHaveBeenCalledTimes(1);

    act(() => {
      runtimeListener?.(
        projection(11, {
          kind: "turnChanged",
          turn: {
            id: "turn-1",
            status: "completed",
            stopRequested: false,
            startedAt: "2026-07-10T16:00:00Z",
            completedAt: "2026-07-10T16:00:03Z",
          },
        }),
      );
    });

    await waitFor(() => expect(bridgeMock.sendTurn).toHaveBeenCalledTimes(2));
    expect(bridgeMock.sendTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ taskId: "task-1", prompt: "Keep this follow-up" }),
    );
  });

  it("drains once when the rejected turn settles before reconciliation finishes", async () => {
    let nativeRejectedTurn = false;
    let finishReconciliation: ((snapshot: TaskProjectionSnapshot) => void) | undefined;
    const reconciliation = new Promise<TaskProjectionSnapshot>((resolve) => {
      finishReconciliation = resolve;
    });
    bridgeMock.loadTaskProjection.mockImplementation(async () => {
      if (nativeRejectedTurn) return reconciliation;
      return projectionSnapshot({
        watermarkSeq: 9,
        runtimeLive: true,
        events: [
          projection(9, {
            kind: "turnChanged",
            turn: {
              id: "turn-1",
              status: "completed",
              stopRequested: false,
              completedAt: "2026-07-10T16:00:01Z",
            },
          }),
        ],
      });
    });
    bridgeMock.sendTurn
      .mockImplementationOnce(async () => {
        nativeRejectedTurn = true;
        throw new Error("A turn is already running for this chat (turn-active)");
      })
      .mockResolvedValueOnce(undefined);
    bridgeMock.takeQueuedMessage.mockResolvedValue(queuedMessage("Fast-settle follow-up"));
    bridgeMock.listQueuedMessages.mockResolvedValue([]);

    render(<App />);
    await waitFor(() =>
      expect(bridgeMock.loadTaskProjection).toHaveBeenCalledWith("task-1", expect.any(Object)),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Task message" }), {
      target: { value: "Fast-settle follow-up" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(bridgeMock.enqueueMessage).toHaveBeenCalledTimes(1));

    act(() => {
      runtimeListener?.(
        projection(11, {
          kind: "turnChanged",
          turn: {
            id: "turn-1",
            status: "completed",
            stopRequested: false,
            completedAt: "2026-07-10T16:00:03Z",
          },
        }),
      );
      finishReconciliation?.(
        projectionSnapshot({
          watermarkSeq: 10,
          runtimeLive: true,
          events: [
            projection(10, {
              kind: "turnChanged",
              turn: {
                id: "turn-1",
                status: "inProgress",
                stopRequested: false,
              },
            }),
          ],
        }),
      );
    });

    await waitFor(() => expect(bridgeMock.sendTurn).toHaveBeenCalledTimes(2));
    expect(bridgeMock.enqueueMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the exact draft when the busy fallback cannot be queued", async () => {
    bridgeMock.loadTaskProjection.mockResolvedValue(
      projectionSnapshot({
        watermarkSeq: 9,
        runtimeLive: true,
        events: [
          projection(9, {
            kind: "turnChanged",
            turn: {
              id: "turn-1",
              status: "completed",
              stopRequested: false,
              completedAt: "2026-07-10T16:00:01Z",
            },
          }),
        ],
      }),
    );
    bridgeMock.sendTurn.mockRejectedValue(
      new Error("A turn is already running for this chat (turn-active)"),
    );
    bridgeMock.enqueueMessage.mockRejectedValue(new Error("Queue storage unavailable"));

    render(<App />);
    await waitFor(() =>
      expect(bridgeMock.loadTaskProjection).toHaveBeenCalledWith("task-1", expect.any(Object)),
    );
    const composer = screen.getByRole("textbox", { name: "Task message" });
    fireEvent.change(composer, { target: { value: "Do not lose this exact draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Queue storage unavailable");
    expect(composer).toHaveValue("Do not lose this exact draft");
    expect(bridgeMock.enqueueMessage).toHaveBeenCalledTimes(1);
  });

  it("releases optimistic connecting state when a newer turn already settled", async () => {
    bridgeMock.sendTurn.mockResolvedValue(undefined);
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    act(() => {
      runtimeListener?.(
        projection(10, {
          kind: "turnChanged",
          turn: {
            id: "turn-1",
            status: "completed",
            stopRequested: false,
            startedAt: new Date(Date.now() - 125 * 60_000).toISOString(),
            completedAt: new Date().toISOString(),
          },
        }),
      );
    });
    fireEvent.change(await screen.findByRole("textbox", { name: "Task message" }), {
      target: { value: "Start a fresh turn" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => {
      const elapsed = document.querySelector(".task-status-pill-elapsed");
      expect(elapsed).toBeInTheDocument();
      expect(Number.parseFloat(elapsed?.textContent ?? "")).toBeLessThan(2);
    });
    expect(screen.queryByText("2h 5m")).not.toBeInTheDocument();

    act(() => {
      runtimeListener?.(
        projection(11, {
          kind: "turnChanged",
          turn: {
            id: "turn-2",
            status: "completed",
            stopRequested: false,
            startedAt: new Date(Date.now() + 1_000).toISOString(),
            completedAt: new Date(Date.now() + 2_000).toISOString(),
          },
        }),
      );
    });

    await waitFor(() =>
      expect(document.querySelector(".task-status-pill")).not.toBeInTheDocument(),
    );
  });

  it("keeps the draft local until authoritative chat state is ready", async () => {
    const workspace = await bridgeMock.loadWorkspace();
    workspace.tasks.push({
      id: "task-2",
      projectId: "project-1",
      title: "Reconnecting chat",
      status: "completed",
      runtime: "codex",
      model: "Provider default",
      updatedAt: "2026-07-10T15:00:00Z",
    });
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    let releaseTaskTwo: ((value: TaskProjectionSnapshot) => void) | undefined;
    const taskTwoProjection = new Promise<TaskProjectionSnapshot>((resolve) => {
      releaseTaskTwo = resolve;
    });
    bridgeMock.loadTaskProjection.mockImplementation(async (taskId: string) => {
      if (taskId === "task-2") return taskTwoProjection;
      return projectionSnapshot({ watermarkSeq: 0, runtimeLive: false, events: [] });
    });
    bridgeMock.setQueuedMessageDispatching.mockImplementation(
      async (taskId, _messageId, dispatching) => ({
        ...queuedMessage("Wait for state"),
        taskId,
        state: dispatching ? "dispatching" : "queued",
      }),
    );
    bridgeMock.takeQueuedMessage.mockResolvedValue(queuedMessage("Wait for state"));
    bridgeMock.sendTurn.mockResolvedValue(undefined);

    render(<App />);
    await waitFor(() =>
      expect(bridgeMock.loadTaskProjection).toHaveBeenCalledWith("task-1", expect.any(Object)),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Reconnecting chat/i }));
    fireEvent.change(screen.getByRole("textbox", { name: "Task message" }), {
      target: { value: "Wait for state" },
    });
    const sendButton = screen.getByRole("button", { name: "Send message" });
    expect(sendButton).toBeDisabled();
    fireEvent.click(sendButton);

    expect(bridgeMock.enqueueMessage).not.toHaveBeenCalled();
    expect(bridgeMock.sendTurn).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Task message" })).toHaveValue("Wait for state");

    releaseTaskTwo?.(
      projectionSnapshot({ watermarkSeq: 0, runtimeLive: false, events: [], taskId: "task-2" }),
    );
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    fireEvent.click(sendButton);
    await waitFor(() =>
      expect(bridgeMock.sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task-2", prompt: "Wait for state" }),
      ),
    );
    expect(bridgeMock.enqueueMessage).not.toHaveBeenCalled();
  });

  it("steers a supported active turn when Send now is selected", async () => {
    bridgeMock.steerTurn.mockResolvedValue(true);
    bridgeMock.takeQueuedMessage.mockResolvedValue(queuedMessage());
    bridgeMock.listQueuedMessages.mockResolvedValue([]);
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    fireEvent.change(screen.getByRole("textbox", { name: "Task message" }), {
      target: { value: "Follow up" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send now: Follow up" }));

    await waitFor(() =>
      expect(bridgeMock.steerTurn).toHaveBeenCalledWith("task-1", "turn-1", "Follow up"),
    );
    expect(bridgeMock.stopTurn).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Follow up")).not.toBeInTheDocument());
  });

  it("interrupts then dispatches Send now when native steering is unavailable", async () => {
    const workspace = await bridgeMock.loadWorkspace();
    workspace.queuedMessages = [queuedMessage()];
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.takeQueuedMessage.mockResolvedValue(queuedMessage());
    bridgeMock.listQueuedMessages.mockResolvedValue([]);
    bridgeMock.sendTurn.mockResolvedValue(undefined);
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "Send now: Follow up" }));
    await waitFor(() => expect(bridgeMock.stopTurn).toHaveBeenCalledWith("task-1"));
    expect(bridgeMock.sendTurn).not.toHaveBeenCalled();

    act(() => {
      runtimeListener?.(
        projection(10, {
          kind: "turnChanged",
          turn: {
            id: "turn-1",
            status: "interrupted",
            stopRequested: true,
            completedAt: "2026-07-10T16:00:03Z",
          },
        }),
      );
    });

    await waitFor(() =>
      expect(bridgeMock.sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task-1", prompt: "Follow up" }),
      ),
    );
  });

  it("leaves queued work paused after a manual Stop until Send now is selected", async () => {
    const workspace = await bridgeMock.loadWorkspace();
    workspace.queuedMessages = [queuedMessage()];
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.takeQueuedMessage.mockResolvedValue(queuedMessage());
    bridgeMock.listQueuedMessages.mockResolvedValue([]);
    bridgeMock.sendTurn.mockResolvedValue(undefined);
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "Stop turn" }));
    await waitFor(() => expect(bridgeMock.stopTurn).toHaveBeenCalledWith("task-1"));
    act(() => {
      runtimeListener?.(
        projection(10, {
          kind: "turnChanged",
          turn: {
            id: "turn-1",
            status: "interrupted",
            stopRequested: true,
            completedAt: "2026-07-10T16:00:03Z",
          },
        }),
      );
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    expect(bridgeMock.sendTurn).not.toHaveBeenCalled();
    expect(screen.getByText("Follow up")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send now: Follow up" }));
    await waitFor(() =>
      expect(bridgeMock.sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task-1", prompt: "Follow up" }),
      ),
    );
  });

  it("automatically drains the next queued message when the active turn settles", async () => {
    const workspace = await bridgeMock.loadWorkspace();
    workspace.queuedMessages = [queuedMessage()];
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.takeQueuedMessage.mockResolvedValue(queuedMessage());
    bridgeMock.listQueuedMessages.mockResolvedValue([]);
    bridgeMock.sendTurn.mockResolvedValue(undefined);
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    act(() => {
      runtimeListener?.(
        projection(10, {
          kind: "turnChanged",
          turn: {
            id: "turn-1",
            status: "completed",
            stopRequested: false,
            completedAt: "2026-07-10T16:00:03Z",
          },
        }),
      );
    });

    await waitFor(() =>
      expect(bridgeMock.sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task-1", prompt: "Follow up" }),
      ),
    );
  });

  it("returns a queued message to the composer for editing", async () => {
    const workspace = await bridgeMock.loadWorkspace();
    workspace.queuedMessages = [queuedMessage("Revise this")];
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.takeQueuedMessage.mockResolvedValue(queuedMessage("Revise this"));
    bridgeMock.listQueuedMessages.mockResolvedValue([]);
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "Edit in composer: Revise this" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Task message" })).toHaveValue("Revise this"),
    );
    await waitFor(() =>
      expect(screen.queryByText("Revise this", { selector: ".queued-message-text" })).toBeNull(),
    );
  });

  it("removes a queued message without changing the composer draft", async () => {
    const workspace = await bridgeMock.loadWorkspace();
    workspace.queuedMessages = [queuedMessage("Discard this")];
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.takeQueuedMessage.mockResolvedValue(queuedMessage("Discard this"));
    bridgeMock.listQueuedMessages.mockResolvedValue([]);
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "Remove from queue: Discard this" }));

    await waitFor(() =>
      expect(bridgeMock.takeQueuedMessage).toHaveBeenCalledWith("task-1", "queued-1"),
    );
    await waitFor(() =>
      expect(screen.queryByText("Discard this", { selector: ".queued-message-text" })).toBeNull(),
    );
    expect(screen.getByRole("textbox", { name: "Task message" })).toHaveValue("");
  });

  it("preserves a live turn and its timer when switching away and back", async () => {
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
        title: "Foreground task",
        status: "completed",
        runtime: "codex",
        model: "Provider default",
        updatedAt: "2026-07-10T16:00:00Z",
      },
      {
        id: "task-2",
        projectId: "project-1",
        title: "Background live task",
        status: "running",
        runtime: "codex",
        model: "Provider default",
        updatedAt: "2026-07-10T15:00:00Z",
      },
    ];
    workspace.activeProjectId = "project-1";
    workspace.activeTaskId = "task-2";
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.loadTaskProjection.mockImplementation(async (taskId: string) => {
      if (taskId === "task-1") {
        return projectionSnapshot({ watermarkSeq: 0, runtimeLive: false, events: [] });
      }
      return projectionSnapshot({
        watermarkSeq: 2,
        runtimeLive: true,
        events: [
          {
            ...projection(1, {
              kind: "connectionChanged",
              state: "connected",
              processId: "process-2",
            }),
            taskId: "task-2",
          },
          {
            ...projection(2, {
              kind: "turnChanged",
              turn: {
                id: "turn-background",
                status: "inProgress",
                stopRequested: false,
                startedAt: new Date(Date.now() - 125 * 60_000).toISOString(),
              },
            }),
            taskId: "task-2",
          },
        ],
      });
    });

    render(<App />);
    await waitFor(() =>
      expect(bridgeMock.loadTaskProjection).toHaveBeenCalledWith("task-2", expect.any(Object)),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Foreground task/i }));
    await waitFor(() =>
      expect(bridgeMock.loadTaskProjection).toHaveBeenCalledWith("task-1", expect.any(Object)),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Background live task/i }));

    await waitFor(() => {
      expect(
        bridgeMock.loadTaskProjection.mock.calls.filter(([taskId]) => taskId === "task-2"),
      ).toEqual([
        ["task-2", { skipRuntimeCheck: true }],
        ["task-2", { knownWatermark: 2, knownResetSeq: 0 }],
        ["task-2", { knownWatermark: 2, knownResetSeq: 0 }],
      ]);
    });
    expect(screen.queryByText("Response interrupted")).not.toBeInTheDocument();
    expect(screen.getByText("2h 5m")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop turn" })).toBeInTheDocument();
  });

  it("clears a transient composer error when reopening a chat", async () => {
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
        title: "Foreground task",
        status: "completed",
        runtime: "codex",
        model: "Provider default",
        updatedAt: "2026-07-10T16:00:00Z",
      },
      {
        id: "task-2",
        projectId: "project-1",
        title: "Background task",
        status: "completed",
        runtime: "codex",
        model: "Provider default",
        updatedAt: "2026-07-10T15:00:00Z",
      },
    ];
    workspace.activeProjectId = "project-1";
    workspace.activeTaskId = "task-1";
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.loadTaskProjection.mockImplementation((taskId: string) =>
      projectionSnapshot({ taskId, watermarkSeq: 0, runtimeLive: false, events: [] }),
    );
    bridgeMock.sendTurn.mockRejectedValue(new Error("stale turn error"));

    render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Task message" });
    fireEvent.change(composer, { target: { value: "Try again" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("stale turn error")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Background task/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Foreground task/i }));
    expect(screen.queryByText("stale turn error")).not.toBeInTheDocument();
  });

  it("keeps a background chat projection current while another chat is selected", async () => {
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
        title: "Foreground task",
        status: "completed",
        runtime: "codex",
        model: "Provider default",
        updatedAt: "2026-07-10T16:00:00Z",
      },
      {
        id: "task-2",
        projectId: "project-1",
        title: "Background live task",
        status: "running",
        runtime: "codex",
        model: "Provider default",
        updatedAt: "2026-07-10T15:00:00Z",
      },
    ];
    workspace.activeProjectId = "project-1";
    workspace.activeTaskId = "task-2";
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);

    let taskTwoAuthorityLoads = 0;
    let releaseSecondTaskTwoLoad: ((value: TaskProjectionSnapshot) => void) | undefined;
    const secondTaskTwoLoad = new Promise<TaskProjectionSnapshot>((resolve) => {
      releaseSecondTaskTwoLoad = resolve;
    });
    bridgeMock.loadTaskProjection.mockImplementation(
      async (taskId: string, options?: LoadTaskProjectionOptions) => {
        if (taskId === "task-1") {
          return projectionSnapshot({ watermarkSeq: 0, runtimeLive: false, events: [] });
        }
        const persisted = projectionSnapshot({
          watermarkSeq: 2,
          runtimeLive: false,
          events: [
            {
              ...projection(1, {
                kind: "connectionChanged",
                state: "connected",
                processId: "process-2",
              }),
              taskId: "task-2",
            },
            {
              ...projection(2, {
                kind: "turnChanged",
                turn: {
                  id: "turn-background",
                  status: "inProgress",
                  stopRequested: false,
                },
              }),
              taskId: "task-2",
            },
          ],
        });
        if (options?.skipRuntimeCheck) return persisted;
        taskTwoAuthorityLoads += 1;
        if (taskTwoAuthorityLoads > 1) return secondTaskTwoLoad;
        return {
          ...persisted,
          runtimeLive: true,
          cacheMatched: true,
          hydrate: undefined,
        };
      },
    );

    render(<App />);
    expect(await screen.findByRole("button", { name: "Stop turn" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /Foreground task/i }));
    await waitFor(() =>
      expect(bridgeMock.loadTaskProjection).toHaveBeenCalledWith("task-1", expect.any(Object)),
    );

    act(() => {
      runtimeListener?.({
        ...projection(3, {
          kind: "turnChanged",
          turn: {
            id: "turn-background",
            status: "completed",
            stopRequested: false,
            completedAt: "2026-07-10T16:00:03Z",
          },
        }),
        taskId: "task-2",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /Background live task/i }));
    expect(screen.queryByRole("button", { name: "Stop turn" })).not.toBeInTheDocument();
    expect(bridgeMock.loadTaskProjection).toHaveBeenLastCalledWith(
      "task-2",
      expect.objectContaining({ knownWatermark: 3 }),
    );
    releaseSecondTaskTwoLoad?.({
      watermarkSeq: 3,
      resetSeq: 0,
      runtimeLive: false,
      cacheMatched: true,
    });
  });

  it("reuses Git state without rechecking when switching chats in the same checkout", async () => {
    const workspace = await bridgeMock.loadWorkspace();
    workspace.tasks.push({
      id: "task-2",
      projectId: "project-1",
      title: "Another chat",
      status: "draft",
      runtime: "codex",
      model: "Provider default",
      updatedAt: "2026-07-10T15:00:00Z",
    });
    workspace.git = {
      ...workspace.git,
      kind: "repository",
      branch: "main",
      worktree: "H:\\Code\\sample",
    };
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.loadTaskGit.mockResolvedValue(workspace.git);
    bridgeMock.loadTaskProjection.mockResolvedValue(
      projectionSnapshot({
        watermarkSeq: 0,
        runtimeLive: false,
        events: [],
      }),
    );

    render(<App />);
    await waitFor(() => expect(bridgeMock.loadTaskGit).toHaveBeenCalledWith("task-1"));
    await waitFor(() =>
      expect(bridgeMock.subscribeWorkingTreeChanges).toHaveBeenCalledWith(
        "H:\\Code\\sample",
        expect.any(Function),
      ),
    );
    bridgeMock.loadTaskGit.mockClear();
    bridgeMock.subscribeWorkingTreeChanges.mockClear();

    fireEvent.click(await screen.findByRole("button", { name: /Another chat/i }));
    await waitFor(() =>
      expect(bridgeMock.loadTaskProjection).toHaveBeenCalledWith("task-2", expect.any(Object)),
    );

    expect(bridgeMock.loadTaskGit).not.toHaveBeenCalled();
    expect(bridgeMock.subscribeWorkingTreeChanges).not.toHaveBeenCalled();

    act(() => workingTreeListener?.());
    await waitFor(() => expect(bridgeMock.loadTaskGit).toHaveBeenCalledWith("task-2"));
  });

  it("loads the selected native diff when the header Review tab opens", async () => {
    const pendingFile = {
      path: "src/review.ts",
      status: "modified" as const,
      additions: 0,
      deletions: 0,
      staged: false,
      lines: [],
      diffLoaded: false,
    };
    bridgeMock.loadTaskGit.mockResolvedValue({
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      worktree: "H:\\Code\\sample",
      commits: [],
      files: [pendingFile],
    });
    bridgeMock.loadTaskGitFile.mockResolvedValue({
      ...pendingFile,
      additions: 1,
      lines: [
        { kind: "hunk", content: "@@ -0,0 +1 @@" },
        { kind: "add", newNumber: 1, content: "export const reviewWorks = true;" },
      ],
      diffLoaded: true,
    });

    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });
    fireEvent.click(await screen.findByRole("tab", { name: "Review" }));

    expect(
      await screen.findByText(
        (_content, element) =>
          element?.tagName === "CODE" && element.textContent === "export const reviewWorks = true;",
      ),
    ).toBeInTheDocument();
    expect(bridgeMock.loadTaskGitFile).toHaveBeenCalledTimes(1);
    expect(bridgeMock.loadTaskGitFile).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ path: "src/review.ts", diffLoaded: false }),
    );
  });

  it("turns a native diff failure into a retryable Review state", async () => {
    const pendingFile = {
      path: "src/retry.ts",
      status: "modified" as const,
      additions: 0,
      deletions: 0,
      staged: false,
      lines: [],
      diffLoaded: false,
    };
    bridgeMock.loadTaskGit.mockResolvedValue({
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      worktree: "H:\\Code\\sample",
      commits: [],
      files: [pendingFile],
    });
    bridgeMock.loadTaskGitFile
      .mockRejectedValueOnce(new Error("Git diff timed out"))
      .mockResolvedValueOnce({
        ...pendingFile,
        additions: 1,
        lines: [{ kind: "add", newNumber: 1, content: "export const retried = true;" }],
        diffLoaded: true,
      });

    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });
    fireEvent.click(await screen.findByRole("tab", { name: "Review" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Git diff timed out");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText(
        (_content, element) =>
          element?.tagName === "CODE" && element.textContent === "export const retried = true;",
      ),
    ).toBeInTheDocument();
    expect(bridgeMock.loadTaskGitFile).toHaveBeenCalledTimes(2);
  });

  it("keeps Task and Review left of the shared controls while the work pane is open", async () => {
    rightRailProbe.enabled = true;
    bridgeMock.listDelegations.mockImplementation(async (taskId: string) =>
      taskId === "task-1"
        ? [
            {
              id: "delegation-1",
              parentTaskId: "task-1",
              childTaskId: "task-child",
              profileId: "ui-specialist",
              profileLabel: "UI specialist",
              runtime: "codex",
              model: "gpt-5.6-luna",
              effort: "high",
              title: "Polish the interaction",
              brief: "Unify the conversation chrome.",
              status: "stopped",
              createdAt: "2026-07-10T16:00:00Z",
              updatedAt: "2026-07-10T16:05:00Z",
              unreadFromChild: 0,
              pendingQuestions: [],
            },
            {
              id: "delegation-2",
              parentTaskId: "task-1",
              childTaskId: "task-child-2",
              profileId: "review-specialist",
              profileLabel: "Review specialist",
              runtime: "claude",
              model: "claude-fable-5",
              effort: "high",
              title: "Inspect the interaction",
              brief: "Check the conversation behavior.",
              status: "waiting",
              createdAt: "2026-07-10T16:01:00Z",
              updatedAt: "2026-07-10T16:05:00Z",
              unreadFromChild: 0,
              pendingQuestions: [],
            },
          ]
        : [],
    );
    bridgeMock.loadTaskGit.mockResolvedValue({
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      worktree: "H:\\Code\\sample",
      commits: [],
      files: [],
    });

    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    fireEvent.click(await screen.findByRole("tab", { name: /^Agents/ }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /Polish the interaction/ }));
    await screen.findByLabelText("Polish the interaction transcript");
    const titlebar = document.querySelector<HTMLElement>(".native-titlebar");
    const appRoot = document.querySelector<HTMLElement>(".app-root");
    expect(titlebar).not.toBeNull();
    expect(appRoot).toHaveAttribute("data-subagent-visible", "true");
    expect(appRoot).toHaveAttribute("data-subagent-layout-ready", "true");
    expect(document.querySelector(".conversation-header")).not.toBeInTheDocument();
    // The titlebar slice over the pane carries the tab strip. The subagent's
    // detail is on its tab, not in a row of its own inside the pane.
    expect(titlebar!.querySelector(".titlebar-subagent-slot")).toContainElement(
      titlebar!.querySelector(".work-pane-strip"),
    );
    expect(document.querySelector(".work-pane-subheader")).not.toBeInTheDocument();
    const strip = titlebar!.querySelector<HTMLElement>(".work-pane-strip");
    const subagentTab = within(strip!).getByRole("tab", { name: /Polish the interaction/ });
    expect(subagentTab.getAttribute("title")).toContain("Polish the interaction");

    // The shared controls stay in the titlebar end. Opening the pane must not
    // move Task and Review to the far side of them.
    expect(screen.getAllByRole("button", { name: /chat navigation/i })).toHaveLength(1);
    expect(within(titlebar!).getByRole("button", { name: /chat navigation/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Toggle terminal" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Close task tools" })).toHaveLength(1);
    expect(titlebar!.querySelector(".work-pane-strip-trailing")).not.toBeInTheDocument();
    const taskTab = within(titlebar!).getByRole("tab", { name: "Task" });
    const terminalToggle = within(titlebar!).getByRole("button", { name: "Toggle terminal" });
    expect(
      taskTab.compareDocumentPosition(terminalToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // A second subagent is a peer tab in the same pane, never a second pane.
    const stablePane = document.querySelector(".work-pane");
    fireEvent.click(screen.getByRole("treeitem", { name: /Inspect the interaction/ }));
    await screen.findByLabelText("Inspect the interaction transcript");
    expect(document.querySelectorAll(".work-pane")).toHaveLength(1);
    expect(document.querySelector(".work-pane")).toBe(stablePane);
    const surfaces = screen.getByRole("tablist", { name: "Open surfaces" });
    expect(
      within(surfaces)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Polish the interaction", "Inspect the interaction"]);

    fireEvent.click(within(surfaces).getByRole("tab", { name: "Polish the interaction" }));
    await screen.findByLabelText("Polish the interaction transcript");
    expect(document.querySelectorAll(".work-pane")).toHaveLength(1);
    expect(document.querySelector(".work-pane")).toBe(stablePane);

    // There is no redundant close-all X; each tab keeps its own explicit X.
    expect(screen.queryByRole("button", { name: "Close all tabs" })).not.toBeInTheDocument();
    fireEvent.click(within(surfaces).getByRole("button", { name: "Close Polish the interaction" }));
    fireEvent.click(
      within(surfaces).getByRole("button", { name: "Close Inspect the interaction" }),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("Polish the interaction transcript")).not.toBeInTheDocument(),
    );
    expect(appRoot).toHaveAttribute("data-subagent-visible", "true");
    fireEvent.click(within(titlebar!).getByRole("button", { name: "Close work pane" }));
    await waitFor(() => expect(document.querySelector(".work-pane")).not.toBeInTheDocument());
    expect(appRoot).toHaveAttribute("data-subagent-visible", "false");
    expect(within(titlebar!).getByRole("button", { name: "Toggle terminal" })).toBeInTheDocument();
    expect(within(titlebar!).getByRole("button", { name: "Close task tools" })).toBeInTheDocument();
  });

  it("auto-approves pending and later approvals after switching to full access mid-run", async () => {
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });
    expect(screen.getByRole("button", { name: "Run command" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Permission" }));
    fireEvent.click(screen.getByRole("option", { name: "Full access" }));

    await waitFor(() =>
      expect(bridgeMock.respondToApproval).toHaveBeenCalledWith(
        "task-1",
        "approval-1",
        "acceptForSession",
      ),
    );
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Run command" })).not.toBeInTheDocument();
      expect(screen.queryByText("Command approval")).not.toBeInTheDocument();
      expect(screen.queryByText(/Approval is (?:pending|responding)\./)).not.toBeInTheDocument();
    });

    // The resolved projection lands, then the provider asks about another
    // command. It must be answered without any click.
    act(() => {
      runtimeListener?.(
        projection(10, {
          kind: "approvalChanged",
          approval: {
            id: "approval-1",
            requestId: { kind: "string", value: "request-a" },
            approvalKind: "commandExecution",
            state: "resolved",
            decision: "acceptForSession",
            command: "npm test",
            updatedAt: "2026-07-10T16:00:02Z",
          },
        }),
      );
      runtimeListener?.(
        projection(11, {
          kind: "approvalChanged",
          approval: {
            id: "approval-2",
            requestId: { kind: "string", value: "request-b" },
            approvalKind: "commandExecution",
            state: "pending",
            command: "npm run build",
            updatedAt: "2026-07-10T16:00:03Z",
          },
        }),
      );
    });

    await waitFor(() =>
      expect(bridgeMock.respondToApproval).toHaveBeenCalledWith(
        "task-1",
        "approval-2",
        "acceptForSession",
      ),
    );
    await waitFor(() => {
      expect(screen.queryByText("Command approval")).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Approval is (?:resolved|pending|responding)\./),
      ).not.toBeInTheDocument();
    });
  }, 10_000);

  it("restores an approval gate when an automatic full-access response cannot be sent", async () => {
    bridgeMock.respondToApproval.mockRejectedValueOnce(new Error("Approval transport failed"));
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "Permission" }));
    fireEvent.click(screen.getByRole("option", { name: "Full access" }));

    expect(await screen.findByText("Approval transport failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run command" })).toBeInTheDocument();
  });

  it("keeps an explicit permission choice attached to each Claude task across chat switches", async () => {
    const workspace = await bridgeMock.loadWorkspace();
    workspace.tasks = [
      {
        ...workspace.tasks[0],
        title: "First Claude task",
        status: "completed",
        runtime: "claude",
      },
      {
        id: "task-2",
        projectId: "project-1",
        title: "Second Claude task",
        status: "completed",
        runtime: "claude",
        model: "Provider default",
        updatedAt: "2026-07-10T15:00:00Z",
      },
    ];
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.loadTaskProjection.mockImplementation(async (taskId: string) =>
      projectionSnapshot({ taskId, watermarkSeq: 0, runtimeLive: true, events: [] }),
    );
    const reportClaudeAskMode = (taskId: string, seq: number) => {
      runtimeListener?.({
        ...projection(seq, {
          kind: "modeChanged",
          mode: {
            currentModeId: "default",
            availableModes: [
              { id: "default", name: "Ask before edits" },
              { id: "acceptEdits", name: "Accept edits" },
              { id: "bypassPermissions", name: "Bypass permissions" },
            ],
          },
        }),
        taskId,
        provider: "claude",
      });
    };

    render(<App />);
    const permission = await screen.findByRole("button", { name: "Permission" });
    act(() => reportClaudeAskMode("task-1", 1));
    await waitFor(() => expect(permission).toHaveTextContent("Ask as needed"));
    fireEvent.click(permission);
    fireEvent.click(screen.getByRole("option", { name: "Full access" }));
    expect(screen.getByRole("button", { name: "Permission" })).toHaveTextContent("Full access");

    fireEvent.click(await screen.findByRole("button", { name: /Second Claude task/i }));
    await waitFor(() =>
      expect(bridgeMock.loadTaskProjection).toHaveBeenCalledWith("task-2", expect.any(Object)),
    );
    act(() => reportClaudeAskMode("task-2", 1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Permission" })).toHaveTextContent("Ask as needed"),
    );

    act(() => {
      runtimeListener?.({
        ...projection(2, {
          kind: "approvalChanged",
          approval: {
            id: "background-approval",
            requestId: { kind: "string", value: "background-request" },
            approvalKind: "commandExecution",
            state: "pending",
            command: "npm test",
            updatedAt: "2026-07-10T16:00:02Z",
          },
        }),
        taskId: "task-1",
        provider: "claude",
      });
    });
    await waitFor(() =>
      expect(bridgeMock.respondToApproval).toHaveBeenCalledWith(
        "task-1",
        "background-approval",
        "acceptForSession",
      ),
    );

    fireEvent.click(await screen.findByRole("button", { name: /First Claude task/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Permission" })).toHaveTextContent("Full access"),
    );
  });

  it("renders plan-review approvals with the plan and keeps them out of auto-approve", async () => {
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    act(() => {
      runtimeListener?.(
        projection(10, {
          kind: "approvalChanged",
          approval: {
            id: "approval-1",
            requestId: { kind: "string", value: "request-a" },
            approvalKind: "commandExecution",
            state: "pending",
            command: "npm test",
            updatedAt: "2026-07-10T16:00:02Z",
          },
        }),
      );
      runtimeListener?.(
        projection(11, {
          kind: "approvalChanged",
          approval: {
            id: "approval-plan",
            requestId: { kind: "string", value: "request-plan" },
            approvalKind: "planReview",
            state: "pending",
            reason: "The agent finished planning and wants to start implementing.",
            planMarkdown: "# Plan\n\nAdd subtract(a, b) to hello.py.",
            updatedAt: "2026-07-10T16:00:03Z",
          },
        }),
      );
    });

    // Full access must not auto-approve a plan review — the user chose plan
    // mode specifically to read the plan first.
    fireEvent.click(screen.getByRole("button", { name: "Permission" }));
    fireEvent.click(screen.getByRole("option", { name: "Full access" }));
    await waitFor(() =>
      expect(bridgeMock.respondToApproval).toHaveBeenCalledWith(
        "task-1",
        "approval-1",
        "acceptForSession",
      ),
    );
    expect(await screen.findByText("Approve this plan?")).toBeInTheDocument();
    expect(screen.getByText(/Add subtract\(a, b\) to hello\.py\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep planning" })).toBeInTheDocument();
    expect(bridgeMock.respondToApproval).not.toHaveBeenCalledWith(
      "task-1",
      "approval-plan",
      expect.anything(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    await waitFor(() =>
      expect(bridgeMock.respondToApproval).toHaveBeenCalledWith(
        "task-1",
        "approval-plan",
        "accept",
      ),
    );
  });

  it("shows the session mode picker for Cursor tasks and applies mode switches", async () => {
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
        title: "Cursor plan task",
        status: "running",
        runtime: "cursor",
        model: "Provider default",
        updatedAt: "2026-07-10T16:00:00Z",
      },
    ];
    workspace.activeProjectId = "project-1";
    workspace.activeTaskId = "task-1";
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.setSessionMode.mockResolvedValue(undefined);
    bridgeMock.loadTaskProjection.mockResolvedValue(
      projectionSnapshot({
        watermarkSeq: 6,
        runtimeLive: true,
        events: [
          projection(5, {
            kind: "turnChanged",
            turn: { id: "turn-1", status: "inProgress", stopRequested: false },
          }),
          projection(6, {
            kind: "modeChanged",
            mode: {
              currentModeId: "agent",
              availableModes: [
                { id: "agent", name: "Agent", description: "Full agent capabilities" },
                { id: "plan", name: "Plan", description: "Read-only planning" },
                { id: "ask", name: "Ask", description: "Q&A mode" },
              ],
            },
          }),
        ],
      }),
    );

    render(<App />);
    const modePicker = await screen.findByRole("button", { name: "Agent mode" }, { timeout: 5000 });
    expect(modePicker).toHaveTextContent("Agent");

    fireEvent.click(modePicker);
    fireEvent.click(screen.getByRole("option", { name: "Plan" }));
    await waitFor(() => expect(bridgeMock.setSessionMode).toHaveBeenCalledWith("task-1", "plan"));

    // The agent confirms the switch; the picker reflects the session state.
    act(() => {
      runtimeListener?.(
        projection(7, {
          kind: "modeChanged",
          mode: {
            currentModeId: "plan",
            availableModes: [
              { id: "agent", name: "Agent" },
              { id: "plan", name: "Plan" },
              { id: "ask", name: "Ask" },
            ],
          },
        }),
      );
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Agent mode" })).toHaveTextContent("Plan"),
    );
  });

  it("keeps the task provider while deferred discovery is still pending", async () => {
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
        title: "Cursor cold-start task",
        status: "draft",
        runtime: "cursor",
        model: "Provider default",
        updatedAt: "2026-07-10T16:00:00Z",
      },
    ];
    workspace.activeProjectId = "project-1";
    workspace.activeTaskId = "task-1";
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.loadTaskProjection.mockResolvedValue(
      projectionSnapshot({
        watermarkSeq: 0,
        runtimeLive: false,
        events: [],
      }),
    );
    bridgeMock.probeRuntimes.mockReturnValue(new Promise(() => undefined));
    bridgeMock.sendTurn.mockResolvedValue(undefined);

    render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Task message" });
    fireEvent.change(composer, { target: { value: "Stay on Cursor" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(bridgeMock.sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "task-1",
          prompt: "Stay on Cursor",
          runtime: "cursor",
        }),
      ),
    );
  });

  it("docks native turn errors above the composer and allows dismissal", async () => {
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    act(() => {
      runtimeListener?.(
        projection(10, {
          kind: "turnError",
          message: "gemini turn execution is not implemented by the native backend",
          retryable: false,
        }),
      );
    });

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("gemini turn execution is not implemented");
    expect(
      notice.compareDocumentPosition(screen.getByRole("textbox", { name: "Task message" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Turn error" }));
    expect(screen.queryByText("gemini turn execution is not implemented")).not.toBeInTheDocument();
  });

  it("hands the composer back after a usage limit ends the turn", async () => {
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    act(() => {
      runtimeListener?.(
        projection(10, {
          kind: "turnChanged",
          turn: { id: "turn-1", status: "inProgress", stopRequested: false },
        }),
      );
    });
    expect(await screen.findByRole("button", { name: "Stop turn" })).toBeInTheDocument();

    act(() => {
      runtimeListener?.(
        projection(11, {
          kind: "turnError",
          message: "You've hit your usage limit.",
          retryable: false,
        }),
      );
    });

    // The provider has given up on the turn, so the composer goes back to send
    // rather than leaving stop as the only control on a turn nothing is running.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop turn" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("usage limit");
  });

  it("keeps stop available while the provider is still retrying", async () => {
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });
    bridgeMock.loadTaskGit.mockClear();
    bridgeMock.setTaskStatus.mockClear();

    act(() => {
      runtimeListener?.(
        projection(10, {
          kind: "turnChanged",
          turn: { id: "turn-1", status: "inProgress", stopRequested: false },
        }),
      );
      runtimeListener?.(
        projection(11, {
          kind: "turnError",
          message: "stream disconnected",
          retryable: true,
        }),
      );
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("stream disconnected");
    expect(screen.getByRole("button", { name: "Stop turn" })).toBeInTheDocument();
    expect(bridgeMock.setTaskStatus).not.toHaveBeenCalled();
    expect(bridgeMock.loadTaskGit).not.toHaveBeenCalled();
  });

  it("routes a provider version error into disclosed Runtime Settings without executing it", async () => {
    bridgeMock.listRuntimeActionPlans.mockResolvedValue([
      {
        id: "codex:update:vendor-cli",
        provider: "codex",
        kind: "update",
        method: "Vendor CLI",
        label: "Update with the installed CLI",
        command: "/opt/homebrew/bin/codex update",
        description: "Runs the exact installed vendor CLI.",
        sourceUrl: "https://developers.openai.com/codex/cli",
        available: true,
        recommended: true,
        downloadsAndExecutesCode: true,
        modifiesOutsideProjects: true,
        environmentNote: "Runs locally with a reduced environment.",
      },
    ]);

    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    act(() => {
      runtimeListener?.(
        projection(10, {
          kind: "turnError",
          message:
            "'gpt-5.6-luna' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
          retryable: false,
        }),
      );
    });

    fireEvent.click(await screen.findByRole("button", { name: "Update Codex" }));
    const dialog = await screen.findByRole("dialog", { name: "Update Codex" });
    expect(dialog).toHaveTextContent("/opt/homebrew/bin/codex update");
    expect(dialog).toHaveTextContent("Review the exact local command before anything runs");
  });

  it("clears stale provider errors and keeps later idle disconnects quiet", async () => {
    bridgeMock.listRuntimeActionPlans.mockResolvedValue([
      {
        id: "codex:update:vendor-cli",
        provider: "codex",
        kind: "update",
        method: "Vendor CLI",
        label: "Update with the installed CLI",
        command: "/opt/homebrew/bin/codex update",
        description: "Runs the exact installed vendor CLI.",
        sourceUrl: "https://developers.openai.com/codex/cli",
        available: true,
        recommended: true,
        downloadsAndExecutesCode: true,
        modifiesOutsideProjects: true,
        environmentNote: "Runs locally with a reduced environment.",
      },
    ]);

    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });

    act(() => {
      runtimeListener?.(
        projection(10, {
          kind: "connectionChanged",
          state: "disconnected",
          reason: "Codex is not connected",
        }),
      );
      runtimeListener?.(
        projection(11, {
          kind: "turnError",
          message:
            "'gpt-5.6-luna' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
          retryable: false,
        }),
      );
    });

    const updateButton = await screen.findByRole("button", { name: "Update Codex" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    expect(screen.queryByText("Codex is disconnected")).not.toBeInTheDocument();
    fireEvent.click(updateButton);
    await screen.findByRole("dialog", { name: "Update Codex" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel runtime command" }));

    bridgeMock.probeRuntimes.mockResolvedValueOnce([
      {
        id: "codex",
        name: "Codex",
        command: "/opt/homebrew/bin/codex",
        version: "codex-cli 0.140.0",
        status: "connected",
        fidelity: "native",
        models: ["gpt-5.6-luna"],
        detail: "Ready.",
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Check all" }));
    await screen.findByText("Runtime status refreshed.");
    fireEvent.click(screen.getByRole("button", { name: /Back to workspace/i }));

    // The notice lingers briefly for its exit animation before unmounting.
    await waitFor(() =>
      expect(screen.queryByText("Codex is disconnected")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/requires a newer version of Codex/i)).not.toBeInTheDocument();

    act(() => {
      runtimeListener?.(
        projection(12, {
          kind: "connectionChanged",
          state: "disconnected",
          reason: "Provider process exited after verification",
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    expect(screen.queryByText("Codex is disconnected")).not.toBeInTheDocument();
  });

  it("allows stale approval operation errors to be dismissed", async () => {
    bridgeMock.respondToApproval.mockRejectedValueOnce(
      new Error("approval belongs to an expired provider process"),
    );

    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Run command" }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("approval belongs to an expired provider process");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss operation error" }));
    expect(
      screen.queryByText("approval belongs to an expired provider process"),
    ).not.toBeInTheDocument();
  });

  it("ignores delegation notifications outside the active task lineage", async () => {
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });
    await waitFor(() => expect(bridgeMock.listDelegations).toHaveBeenCalledWith("task-1"));
    const readsAfterHydration = bridgeMock.listDelegations.mock.calls.length;

    act(() => delegationListener?.("unrelated-task"));
    await Promise.resolve();
    expect(bridgeMock.listDelegations).toHaveBeenCalledTimes(readsAfterHydration);

    act(() => delegationListener?.("task-1"));
    await waitFor(() =>
      expect(bridgeMock.listDelegations).toHaveBeenCalledTimes(readsAfterHydration + 1),
    );
  });

  it("reconciles missed delegation updates when the Agents tab opens", async () => {
    rightRailProbe.enabled = true;
    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });
    await waitFor(() => expect(bridgeMock.listDelegations).toHaveBeenCalledWith("task-1"));

    bridgeMock.listDelegations.mockImplementation(async (taskId: string) =>
      taskId === "task-1"
        ? [
            {
              id: "delegation-recovered",
              parentTaskId: "task-1",
              childTaskId: null,
              profileId: "review-specialist",
              profileLabel: "Review specialist",
              runtime: "codex",
              model: "gpt-5.6-luna",
              effort: "high",
              title: "Recovered subagent",
              brief: "Appeared after an authoritative refresh.",
              status: "waiting",
              createdAt: "2026-07-10T16:00:00Z",
              updatedAt: "2026-07-10T16:05:00Z",
              unreadFromChild: 0,
              pendingQuestions: [],
            },
          ]
        : [],
    );

    fireEvent.click(await screen.findByRole("tab", { name: /^Agents/ }));

    expect(await screen.findByText("Recovered subagent")).toBeInTheDocument();
    expect(bridgeMock.listDelegations).toHaveBeenLastCalledWith("task-1");
  });

  it("projects background activity immediately but defers its Git scan until selection", async () => {
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
        title: "Foreground task",
        status: "completed",
        runtime: "codex",
        model: "Provider default",
        updatedAt: "2026-07-10T16:00:00Z",
      },
      {
        id: "task-2",
        projectId: "project-1",
        title: "Background task",
        status: "draft",
        runtime: "codex",
        model: "Provider default",
        updatedAt: "2026-07-10T15:00:00Z",
      },
    ];
    workspace.activeProjectId = "project-1";
    workspace.activeTaskId = "task-1";
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.loadTaskProjection.mockResolvedValue(
      projectionSnapshot({
        watermarkSeq: 0,
        runtimeLive: false,
        events: [],
      }),
    );

    render(<App />);
    const background = await screen.findByRole("button", { name: /Background task/i });
    await waitFor(() =>
      expect(bridgeMock.loadTaskProjection).toHaveBeenCalledWith("task-1", expect.any(Object)),
    );

    act(() => {
      runtimeListener?.({
        ...projection(20, {
          kind: "turnChanged",
          turn: { id: "turn-background", status: "inProgress", stopRequested: false },
        }),
        taskId: "task-2",
      });
    });
    expect(within(background).getByRole("img", { name: "Streaming" })).toBeInTheDocument();

    act(() => {
      runtimeListener?.({
        ...projection(21, {
          kind: "turnChanged",
          turn: { id: "turn-background", status: "completed", stopRequested: false },
        }),
        taskId: "task-2",
      });
    });
    expect(within(background).getByRole("img", { name: "Unread reply" })).toBeInTheDocument();
    await waitFor(() =>
      expect(bridgeMock.setTaskStatus).toHaveBeenCalledWith("task-2", "completed"),
    );
    expect(bridgeMock.loadTaskGit).not.toHaveBeenCalledWith("task-2");

    fireEvent.click(screen.getByRole("button", { name: /Background task/i }));
    await waitFor(() => expect(bridgeMock.loadTaskGit).toHaveBeenCalledWith("task-2"));
    await waitFor(() => expect(background).toHaveAttribute("aria-current", "page"));
    expect(within(background).queryByRole("img")).not.toBeInTheDocument();
  });

  it("fully invalidates loaded diffs when settlement has no reported file paths", async () => {
    const workspace = await bridgeMock.loadWorkspace();
    const loadedFile = {
      path: "src/settled.ts",
      status: "modified" as const,
      additions: 1,
      deletions: 0,
      staged: false,
      lines: [{ kind: "add" as const, newNumber: 1, content: "before" }],
      diffLoaded: true,
    };
    workspace.git = {
      ...createEmptySnapshot().git,
      kind: "repository",
      branch: "main",
      worktree: "H:\\Code\\sample",
      files: [loadedFile],
    };
    const refreshedFile = { ...loadedFile, lines: [], diffLoaded: false };
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.loadTaskGit
      .mockReset()
      .mockResolvedValueOnce(workspace.git)
      .mockResolvedValueOnce({ ...workspace.git, files: [refreshedFile] });

    render(<App />);
    await waitFor(() => expect(bridgeMock.loadTaskGit).toHaveBeenCalledTimes(1));

    act(() => {
      runtimeListener?.(
        projection(29, {
          kind: "turnChanged",
          turn: { id: "turn-settled", status: "completed", stopRequested: false },
        }),
      );
    });
    await waitFor(() => expect(bridgeMock.loadTaskGit).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    await waitFor(() =>
      expect(bridgeMock.loadTaskGitFile).toHaveBeenCalledWith(
        "task-1",
        expect.objectContaining({ path: "src/settled.ts", diffLoaded: false }),
      ),
    );
  });

  it("coalesces adjacent error and terminal projections into one Git refresh", async () => {
    render(<App />);
    await waitFor(() => expect(bridgeMock.loadTaskGit).toHaveBeenCalledWith("task-1"));
    bridgeMock.loadTaskGit.mockClear();

    act(() => {
      runtimeListener?.(
        projection(30, {
          kind: "turnError",
          message: "provider failed",
          retryable: false,
        }),
      );
      runtimeListener?.(
        projection(31, {
          kind: "turnChanged",
          turn: { id: "turn-1", status: "failed", stopRequested: false },
        }),
      );
    });
    await waitFor(() => expect(bridgeMock.loadTaskGit).toHaveBeenCalledTimes(1));
  });

  it("debounces provider file changes into a live Git refresh", async () => {
    render(<App />);
    await waitFor(() => expect(bridgeMock.loadTaskGit).toHaveBeenCalledWith("task-1"));
    bridgeMock.loadTaskGit.mockClear();

    act(() => {
      runtimeListener?.(
        projection(32, {
          kind: "itemChanged",
          item: {
            id: "codex:thread-1:turn-1:file-1",
            providerItemId: "file-1",
            kind: "fileChange",
            status: "completed",
            fileChanges: [{ path: "src/live.ts", changeKind: "modify" }],
            truncated: false,
            updatedAt: "2026-07-10T16:00:00Z",
          },
        }),
      );
    });

    await waitFor(() => expect(bridgeMock.loadTaskGit).toHaveBeenCalledWith("task-1"));
    expect(bridgeMock.loadTaskGit).toHaveBeenCalledTimes(1);
  });

  it("coalesces direct working-tree edits into one live Git refresh", async () => {
    render(<App />);
    await waitFor(() =>
      expect(bridgeMock.subscribeWorkingTreeChanges).toHaveBeenCalledWith(
        "H:\\Code\\sample",
        expect.any(Function),
      ),
    );
    await waitFor(() => expect(bridgeMock.loadTaskGit).toHaveBeenCalledWith("task-1"));
    bridgeMock.loadTaskGit.mockClear();

    act(() => {
      workingTreeListener?.();
      workingTreeListener?.();
      workingTreeListener?.();
    });

    await waitFor(() => expect(bridgeMock.loadTaskGit).toHaveBeenCalledWith("task-1"));
    expect(bridgeMock.loadTaskGit).toHaveBeenCalledTimes(1);
  });

  it("keeps persisted-state reconciliation quiet on the first send", async () => {
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
    workspace.activeProjectId = "project-1";
    workspace.runtimes = [
      {
        id: "codex",
        name: "Codex",
        command: "codex",
        status: "connected",
        fidelity: "native",
        models: ["gpt-5.6-luna"],
        detail: "Authenticated local CLI",
      },
    ];
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.loadProjectGit.mockResolvedValue(workspace.git);
    bridgeMock.startTask.mockResolvedValue({
      id: "task-first-send",
      projectId: "project-1",
      title: "New chat",
      status: "draft",
      runtime: "codex",
      model: "gpt-5.6-luna",
      updatedAt: "2026-07-14T19:00:00Z",
    });
    let resolveSend!: (value: undefined) => void;
    bridgeMock.sendTurn.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          resolveSend = resolve;
        }),
    );

    render(<App />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Task message" }), {
      target: { value: "Start cleanly" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(bridgeMock.sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task-first-send" }),
      ),
    );
    expect(bridgeMock.generateTaskTitle).not.toHaveBeenCalled();
    act(() => resolveSend(undefined));
    await waitFor(
      () =>
        expect(bridgeMock.generateTaskTitle).toHaveBeenCalledWith({
          taskId: "task-first-send",
          prompt: "Start cleanly",
          runtime: "codex",
          route: { runtime: "codex", fallbacks: [] },
        }),
      { timeout: 4_000 },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    expect(screen.queryByText("Reconciling persisted task state…")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading persisted task state")).not.toBeInTheDocument();
  }, 30_000);

  it("keeps project Git usable while a new chat becomes its first task", async () => {
    rightRailProbe.enabled = true;
    const workspace = createEmptySnapshot();
    workspace.projects = [
      {
        id: "project-1",
        name: "sample",
        path: "H:\\Code\\sample",
        gitRepositoryRoot: "H:\\Code\\sample",
        branch: "main",
        dirtyFiles: 1,
        expanded: true,
      },
    ];
    workspace.activeProjectId = "project-1";
    workspace.git = {
      ...workspace.git,
      kind: "repository",
      branch: "main",
      worktree: "H:\\Code\\sample",
      files: [
        {
          path: "src/new-chat.ts",
          status: "modified",
          additions: 2,
          deletions: 0,
          staged: false,
          lines: [],
        },
      ],
    };
    workspace.runtimes = [
      {
        id: "codex",
        name: "Codex",
        command: "codex",
        status: "connected",
        fidelity: "native",
        models: ["Provider default"],
        detail: "Authenticated local CLI",
      },
    ];
    const stagedGit = {
      ...workspace.git,
      files: workspace.git.files.map((file) => ({ ...file, staged: true })),
    };
    bridgeMock.loadWorkspace.mockResolvedValue(workspace);
    bridgeMock.loadProjectGit.mockResolvedValue(workspace.git);
    bridgeMock.stageProjectFiles.mockResolvedValue(stagedGit);
    bridgeMock.startTask.mockResolvedValue({
      id: "task-new-chat",
      projectId: "project-1",
      title: "Coding session",
      status: "draft",
      runtime: "codex",
      model: "Provider default",
      updatedAt: "2026-07-14T19:00:00Z",
    });
    bridgeMock.sendTurn.mockResolvedValue(undefined);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Stage all" }, { timeout: 4_000 }));
    await waitFor(() =>
      expect(bridgeMock.stageProjectFiles).toHaveBeenCalledWith(
        "project-1",
        ["src/new-chat.ts"],
        true,
      ),
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Task message" }), {
      target: { value: "Start from this repository" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(bridgeMock.sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task-new-chat" }),
      ),
    );
    expect(screen.getByText("new-chat.ts")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Set up Git for this folder" })).toBeNull();
  });

  it("shows a serialized queue failure instead of replacing it with a generic error", async () => {
    bridgeMock.enqueueMessage.mockRejectedValue({
      code: "provider-disconnected",
      message: "Cursor session is not bound to this task",
    });

    render(<App />);
    await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 });
    fireEvent.change(screen.getByRole("textbox", { name: "Task message" }), {
      target: { value: "Try Cursor again" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Cursor session is not bound to this task");
    expect(notice).toHaveTextContent("provider-disconnected");
    expect(notice).not.toHaveTextContent("The message could not be queued");
  });
});
