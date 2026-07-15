// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridge, type DelegationView, type GitSnapshot, type RuntimeConnection } from "../bridge";
import { SubagentConversation } from "./SubagentConversation";

const runtimes: RuntimeConnection[] = [
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
    name: "Claude",
    command: "claude",
    status: "connected",
    fidelity: "structured",
    models: ["claude-fable-5"],
    detail: "Ready",
  },
  {
    id: "cursor",
    name: "Cursor",
    command: "cursor-agent",
    status: "connected",
    fidelity: "acp",
    models: ["composer-2.5"],
    detail: "Ready",
  },
  {
    id: "grok",
    name: "Grok",
    command: "grok",
    status: "connected",
    fidelity: "acp",
    models: ["grok-build-0.1"],
    detail: "Ready",
  },
];

const stoppedDelegation: DelegationView = {
  id: "delegation-1",
  parentTaskId: "task-root",
  childTaskId: "task-child",
  profileId: "ui-specialist",
  profileLabel: "UI specialist",
  runtime: "codex",
  model: "gpt-5.6-luna",
  effort: "high",
  permission: "project-write",
  title: "Polish the interaction",
  brief: "Review and improve the interaction.",
  status: "stopped",
  createdAt: "2026-07-12T10:00:00Z",
  updatedAt: "2026-07-12T10:05:00Z",
  unreadFromChild: 0,
  pendingQuestions: [],
};

const childGit: GitSnapshot = {
  kind: "repository",
  branch: "feature/subagent",
  upstream: "origin/feature/subagent",
  ahead: 1,
  behind: 0,
  worktree: "fixture/integrator-3-child",
  remotes: [
    {
      name: "origin",
      fetchUrl: "https://example.com/repo.git",
      pushUrl: "https://example.com/repo.git",
    },
  ],
  commits: [],
  files: [
    {
      path: "src/interaction.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      staged: false,
      lines: [
        { kind: "hunk", content: "@@ -1 +1 @@" },
        { kind: "delete", oldNumber: 1, content: "const speed = 1;" },
        { kind: "add", newNumber: 1, content: "const speed = 2;" },
      ],
    },
  ],
};

function childProjectionEvent(
  seq: number,
  body: string,
  status: "inProgress" | "completed" = "inProgress",
): Parameters<Parameters<typeof bridge.subscribeRuntimeProjections>[0]>[0] {
  return {
    taskId: "task-child",
    seq,
    providerSessionId: "session-child",
    provider: "codex",
    threadId: "thread-child",
    turnId: "turn-child",
    occurredAt: `2026-07-12T10:06:0${seq}Z`,
    projection: {
      kind: "itemChanged",
      item: {
        id: "message-child",
        providerItemId: "message-child",
        kind: "agentMessage",
        status,
        body,
        truncated: false,
        updatedAt: `2026-07-12T10:06:0${seq}Z`,
      },
    },
  };
}

function renderSubagent(props: Omit<ComponentProps<typeof SubagentConversation>, "headerTarget">) {
  const headerTarget = document.createElement("div");
  headerTarget.className = "test-subagent-header-target";
  document.body.appendChild(headerTarget);
  render(<SubagentConversation {...props} headerTarget={headerTarget} />);
  return headerTarget;
}

afterEach(() => {
  cleanup();
  document.querySelectorAll(".test-subagent-header-target").forEach((target) => target.remove());
  vi.restoreAllMocks();
});

describe("SubagentConversation", () => {
  it("publishes child text once per frame and flushes completion immediately in order", async () => {
    vi.spyOn(bridge, "loadTaskProjection").mockResolvedValue({
      watermarkSeq: 0,
      resetSeq: 0,
      runtimeLive: true,
      hydrate: {
        items: [],
        plan: [],
        planTruncated: false,
        approvals: [],
        firstSeen: {},
        hasMoreOlder: false,
      },
    });
    let projectionListener: Parameters<typeof bridge.subscribeRuntimeProjections>[0] | undefined;
    vi.spyOn(bridge, "subscribeRuntimeProjections").mockImplementation(async (listener) => {
      projectionListener = listener;
      return () => undefined;
    });
    vi.spyOn(bridge, "listModelCatalog").mockResolvedValue([
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    ]);
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrameId += 1;
      frameCallbacks.set(nextFrameId, callback);
      return nextFrameId;
    });
    const cancelFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((id) => void frameCallbacks.delete(id));

    renderSubagent({
      delegation: { ...stoppedDelegation, status: "running" },
      runtimes,
      onClose: vi.fn(),
      onSend: vi.fn().mockResolvedValue(undefined),
    });

    expect(await screen.findByText("No transcript events yet.")).toBeInTheDocument();
    expect(projectionListener).toBeDefined();
    act(() => {
      projectionListener?.(childProjectionEvent(1, "First"));
      projectionListener?.(childProjectionEvent(2, "First second"));
    });

    expect(screen.getByText("No transcript events yet.")).toBeInTheDocument();
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);

    act(() => {
      projectionListener?.(childProjectionEvent(3, "First second complete", "completed"));
    });

    expect(await screen.findByText("First second complete")).toBeInTheDocument();
    expect(screen.queryByText("No transcript events yet.")).not.toBeInTheDocument();
    expect(cancelFrame).toHaveBeenCalledTimes(1);
    expect(frameCallbacks.has(1)).toBe(false);
  });

  it("keeps Stop out of the open subagent header", async () => {
    vi.spyOn(bridge, "loadTaskProjection").mockResolvedValue({
      watermarkSeq: 0,
      resetSeq: 0,
      runtimeLive: true,
      hydrate: {
        items: [],
        plan: [],
        planTruncated: false,
        approvals: [],
        firstSeen: {},
        hasMoreOlder: false,
      },
    });
    vi.spyOn(bridge, "subscribeRuntimeProjections").mockResolvedValue(() => undefined);
    vi.spyOn(bridge, "listModelCatalog").mockResolvedValue([
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    ]);
    const headerTarget = renderSubagent({
      delegation: { ...stoppedDelegation, status: "running" },
      runtimes,
      onClose: vi.fn(),
      onSend: vi.fn().mockResolvedValue(undefined),
      onStop: vi.fn().mockResolvedValue(undefined),
    });

    expect(await screen.findByText("No transcript events yet.")).toBeInTheDocument();
    expect(
      within(headerTarget).queryByRole("button", { name: "Stop subagent" }),
    ).not.toBeInTheDocument();
  });

  it("reopens a stopped child and sends the provider/model selected in the shared composer", async () => {
    vi.spyOn(bridge, "loadTaskProjection").mockResolvedValue({
      watermarkSeq: 0,
      resetSeq: 0,
      runtimeLive: false,
      hydrate: {
        items: [],
        plan: [],
        planTruncated: false,
        approvals: [],
        firstSeen: {},
        hasMoreOlder: false,
      },
    });
    vi.spyOn(bridge, "loadTaskGit").mockResolvedValue(childGit);
    vi.spyOn(bridge, "subscribeRuntimeProjections").mockResolvedValue(() => undefined);
    vi.spyOn(bridge, "listModelCatalog").mockImplementation(async (runtime) =>
      runtime === "claude"
        ? [
            {
              id: "claude-fable-5",
              label: "Claude Fable 5",
              efforts: [{ id: "high", label: "High" }],
              defaultEffort: "high",
            },
          ]
        : [
            {
              id: "gpt-5.6-luna",
              label: "GPT-5.6 Luna",
              efforts: [{ id: "high", label: "High" }],
              defaultEffort: "high",
            },
          ],
    );
    const onSend = vi.fn().mockResolvedValue(undefined);

    renderSubagent({
      delegation: stoppedDelegation,
      runtimes,
      onClose: vi.fn(),
      onSend,
    });

    expect(await screen.findByText("No transcript events yet.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Polish the interaction" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    fireEvent.click(await screen.findByRole("option", { name: "Claude" }));
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(await screen.findByRole("option", { name: "Claude Fable 5" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Fable 5"),
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Message Polish the interaction" }), {
      target: { value: "Continue with the animation pass." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message to Polish the interaction" }));

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("delegation-1", "Continue with the animation pass.", {
        runtime: "claude",
        model: "claude-fable-5",
        effort: "high",
      }),
    );
  });

  it("offers Cursor and Grok as reroute targets for a child", async () => {
    vi.spyOn(bridge, "loadTaskProjection").mockResolvedValue({
      watermarkSeq: 0,
      resetSeq: 0,
      runtimeLive: false,
      hydrate: {
        items: [],
        plan: [],
        planTruncated: false,
        approvals: [],
        firstSeen: {},
        hasMoreOlder: false,
      },
    });
    vi.spyOn(bridge, "loadTaskGit").mockResolvedValue(childGit);
    vi.spyOn(bridge, "subscribeRuntimeProjections").mockResolvedValue(() => undefined);
    vi.spyOn(bridge, "listModelCatalog").mockResolvedValue([
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    ]);

    renderSubagent({
      delegation: stoppedDelegation,
      runtimes,
      onClose: vi.fn(),
      onSend: vi.fn().mockResolvedValue(undefined),
    });

    expect(await screen.findByText("No transcript events yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    expect(await screen.findByRole("option", { name: "Cursor" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Grok" })).toBeInTheDocument();
  });

  it("mirrors compact task controls, reports child tokens, and opens the child review", async () => {
    vi.spyOn(bridge, "loadTaskProjection").mockResolvedValue({
      watermarkSeq: 1,
      resetSeq: 0,
      runtimeLive: false,
      hydrate: {
        items: [],
        plan: [],
        planTruncated: false,
        approvals: [],
        usage: {
          inputTokens: 1_100_000,
          cachedInputTokens: 100_000,
          outputTokens: 200_000,
          reasoningOutputTokens: 0,
          totalTokens: 1_400_000,
        },
        firstSeen: {},
        hasMoreOlder: false,
      },
    });
    const pendingChildGit: GitSnapshot = {
      ...childGit,
      files: childGit.files.map((file) => ({
        ...file,
        additions: 0,
        deletions: 0,
        lines: [],
        diffLoaded: false,
      })),
    };
    vi.spyOn(bridge, "loadTaskGit").mockResolvedValue(pendingChildGit);
    const loadTaskGitFile = vi.spyOn(bridge, "loadTaskGitFile").mockResolvedValue({
      ...childGit.files[0],
      diffLoaded: true,
    });
    vi.spyOn(bridge, "subscribeRuntimeProjections").mockResolvedValue(() => undefined);
    vi.spyOn(bridge, "listModelCatalog").mockResolvedValue([
      {
        id: "gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        efforts: [{ id: "high", label: "High" }],
        defaultEffort: "high",
      },
    ]);
    const onToggleTerminal = vi.fn();
    const onToggleRightRail = vi.fn();

    const headerTarget = renderSubagent({
      delegation: stoppedDelegation,
      runtimes,
      onClose: vi.fn(),
      onSend: vi.fn().mockResolvedValue(undefined),
      onToggleTerminal,
      onToggleRightRail,
    });

    expect(await screen.findByLabelText("1,400,000 tokens")).toHaveTextContent("1.4m");
    expect(await screen.findByRole("tab", { name: "Review" })).toBeInTheDocument();
    expect(document.querySelector(".conversation-header")).not.toBeInTheDocument();
    const header = within(headerTarget).getByRole("heading", { name: "Polish the interaction" });
    expect(header).toBeInTheDocument();
    expect(within(headerTarget).getByRole("tab", { name: "Task" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Close task tools" }));
    expect(onToggleTerminal).toHaveBeenCalledOnce();
    expect(onToggleRightRail).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    expect(
      await screen.findByRole("region", { name: "Diff for src/interaction.ts" }),
    ).toBeVisible();
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
    expect(loadTaskGitFile).toHaveBeenCalledOnce();
    expect(loadTaskGitFile).toHaveBeenCalledWith(
      "task-child",
      expect.objectContaining({ path: "src/interaction.ts", diffLoaded: false }),
    );
  });

  it("offers a noninterruptive Resume control for an interrupted subagent", async () => {
    vi.spyOn(bridge, "loadTaskProjection").mockResolvedValue({
      watermarkSeq: 1,
      resetSeq: 0,
      runtimeLive: false,
      hydrate: {
        items: [],
        plan: [],
        planTruncated: false,
        approvals: [],
        turn: {
          id: "turn-interrupted",
          status: "interrupted",
          stopRequested: false,
          startedAt: "2026-07-12T10:05:00Z",
          completedAt: "2026-07-12T10:06:00Z",
        },
        firstSeen: {},
        hasMoreOlder: false,
      },
    });
    vi.spyOn(bridge, "subscribeRuntimeProjections").mockResolvedValue(() => undefined);
    vi.spyOn(bridge, "listModelCatalog").mockResolvedValue([
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    ]);
    const onSend = vi.fn().mockResolvedValue(undefined);

    renderSubagent({
      delegation: { ...stoppedDelegation, status: "interrupted" },
      runtimes,
      onClose: vi.fn(),
      onSend,
    });

    expect(await screen.findByText("Subagent interrupted")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        "delegation-1",
        "Resume from here",
        expect.objectContaining({ runtime: "codex", model: "gpt-5.6-luna" }),
      ),
    );
  });
});
