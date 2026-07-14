// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { bridgeMock } = vi.hoisted(() => ({
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
    getAppInfo: vi.fn(),
    openProject: vi.fn(),
    registerProject: vi.fn(),
    listProjects: vi.fn(),
    startTask: vi.fn(),
    loadTaskGit: vi.fn(),
    loadTaskGitFile: vi.fn(),
    listProjectFiles: vi.fn(),
    readProjectFile: vi.fn(),
    listProjectFileOpeners: vi.fn(),
    openProjectFileExternal: vi.fn(),
    revealProjectFile: vi.fn(),
    listNativeProviderActions: vi.fn(),
    searchTaskMessages: vi.fn(),
    supportsTaskMetadata: vi.fn(),
    updateTaskMetadata: vi.fn(),
    updateTaskRouting: vi.fn(),
    setTaskStatus: vi.fn(),
    sendTurn: vi.fn(),
    listModelCatalog: vi.fn(),
    listDelegations: vi.fn(),
    subscribeDelegationUpdates: vi.fn(),
    sendDelegationMessage: vi.fn(),
    stopDelegation: vi.fn(),
    stageFiles: vi.fn(),
    commit: vi.fn(),
    previewPush: vi.fn(),
    confirmPush: vi.fn(),
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
    bridgeMock.listProjectFileOpeners.mockResolvedValue([]);
    runtimeListener = undefined;
    bridgeMock.subscribeRuntimeProjections.mockImplementation(async (listener) => {
      runtimeListener = listener;
      return vi.fn();
    });
    bridgeMock.supportsTaskMetadata.mockReturnValue(true);
    bridgeMock.searchTaskMessages.mockResolvedValue([]);
    bridgeMock.listNativeProviderActions.mockResolvedValue([]);
    bridgeMock.listDelegations.mockResolvedValue([]);
    bridgeMock.listModelCatalog.mockResolvedValue([]);
    bridgeMock.listSettings.mockResolvedValue([]);
    bridgeMock.getAppInfo.mockResolvedValue({
      applicationVersion: "test",
      domainSchemaVersion: 2,
      dataDirectory: "H:\\AppData\\Integrator",
      localOnly: true,
    });
    bridgeMock.subscribeDelegationUpdates.mockResolvedValue(vi.fn());
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

  it("listens before snapshot load and renders real recovery controls", async () => {
    render(<App />);

    expect(
      await screen.findByText("Recovered from the persisted projection.", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Buffered after the snapshot watermark.")).toBeInTheDocument();
    expect(bridgeMock.probeRuntimes).toHaveBeenCalledTimes(1);
    expect(bridgeMock.loadTaskGit).toHaveBeenCalledWith("task-1");
    expect(bridgeMock.listProjectFiles).not.toHaveBeenCalled();
    expect(
      screen.getByText("Event gap detected; recovering authoritative history…"),
    ).toBeInTheDocument();
    expect(bridgeMock.subscribeRuntimeProjections.mock.invocationCallOrder[0]).toBeLessThan(
      bridgeMock.loadWorkspace.mock.invocationCallOrder[0],
    );

    // The persisted in-progress turn cannot still be streaming without a live
    // provider connection: it settles as interrupted instead of showing a
    // stop control and an ever-growing elapsed timer.
    expect(screen.getByText("Response interrupted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Stop/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run command" }));
    await waitFor(() =>
      expect(bridgeMock.respondToApproval).toHaveBeenCalledWith("task-1", "approval-1", "accept"),
    );

    // A live provider picks the task back up: the turn revives and the stop
    // control returns.
    act(() => {
      runtimeListener?.(
        projection(12, { kind: "connectionChanged", state: "connected", processId: "process-1" }),
      );
      runtimeListener?.(
        projection(13, {
          kind: "turnChanged",
          turn: { id: "turn-2", status: "inProgress", stopRequested: false },
        }),
      );
    });
    fireEvent.click(await screen.findByRole("button", { name: "Stop turn" }));
    await waitFor(() => expect(bridgeMock.stopTurn).toHaveBeenCalledWith("task-1"));
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

  it("moves the shared terminal and task-tools controls to the rightmost conversation", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: "View transcript" }));
    const child = await screen.findByLabelText("Polish the interaction transcript");
    // The lead task's chrome lives in the titlebar; only the subagent pane
    // renders a conversation header, and it owns the shared controls.
    const headers = document.querySelectorAll<HTMLElement>(".conversation-header");
    expect(headers).toHaveLength(1);
    const childHeader = headers[0];
    const titlebar = document.querySelector<HTMLElement>(".native-titlebar");
    expect(titlebar).not.toBeNull();

    expect(screen.getAllByRole("button", { name: /chat navigation/i })).toHaveLength(1);
    expect(
      within(titlebar!).getByRole("button", { name: /chat navigation/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Toggle terminal" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Close task tools" })).toHaveLength(1);
    expect(within(titlebar!).queryByRole("button", { name: "Toggle terminal" })).toBeNull();
    expect(
      within(childHeader).getByRole("button", { name: "Toggle terminal" }),
    ).toBeInTheDocument();
    expect(
      within(childHeader).getByRole("button", { name: "Close task tools" }),
    ).toBeInTheDocument();

    fireEvent.click(within(child).getByRole("button", { name: "Close subagent transcript" }));
    await waitFor(() => expect(document.querySelectorAll(".conversation-header")).toHaveLength(0));
    expect(
      within(titlebar!).getByRole("button", { name: "Toggle terminal" }),
    ).toBeInTheDocument();
    expect(
      within(titlebar!).getByRole("button", { name: "Close task tools" }),
    ).toBeInTheDocument();
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
            state: "resolved",
            decision: "accept",
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

    expect(await screen.findByText("Approve this plan?")).toBeInTheDocument();
    expect(screen.getByText(/Add subtract\(a, b\) to hello\.py\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep planning" })).toBeInTheDocument();

    // Full access must not auto-approve a plan review — the user chose plan
    // mode specifically to read the plan first.
    fireEvent.click(screen.getByRole("button", { name: "Permission" }));
    fireEvent.click(screen.getByRole("option", { name: "Full access" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridgeMock.respondToApproval).not.toHaveBeenCalled();

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
    bridgeMock.loadTaskProjection.mockResolvedValue({
      watermarkSeq: 6,
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
    });

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
    bridgeMock.loadTaskProjection.mockResolvedValue({ watermarkSeq: 0, events: [] });
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

  it("clears stale provider errors and disconnect notices after a successful re-check", async () => {
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

    expect(await screen.findByText("Codex is disconnected")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Update Codex" }));
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

    expect(screen.queryByText("Codex is disconnected")).not.toBeInTheDocument();
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
    expect(await screen.findByText("Codex is disconnected")).toBeVisible();
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

  it("projects background turn activity into real sidebar dots and unread state", async () => {
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
    bridgeMock.loadTaskProjection.mockResolvedValue({ watermarkSeq: 0, events: [] });

    render(<App />);
    const background = await screen.findByRole("button", { name: /Background task/i });
    await waitFor(() => expect(bridgeMock.loadTaskProjection).toHaveBeenCalledWith("task-1"));

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

    fireEvent.click(screen.getByRole("button", { name: /Background task/i }));
    const selectedBackground = await screen.findByRole("button", { name: /Background task/i });
    await waitFor(() => expect(selectedBackground).toHaveAttribute("aria-current", "page"));
    expect(within(selectedBackground).queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows the serialized Cursor failure instead of replacing it with a generic turn error", async () => {
    bridgeMock.sendTurn.mockRejectedValue({
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
    expect(notice).not.toHaveTextContent("The turn could not be started");
  });
});
