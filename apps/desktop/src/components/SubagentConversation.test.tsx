// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  title: "Polish the interaction",
  brief: "Review and improve the interaction.",
  status: "stopped",
  createdAt: "2026-07-12T10:00:00Z",
  updatedAt: "2026-07-12T10:05:00Z",
  unreadFromChild: 0,
  pendingQuestions: [],
};

const childGit: GitSnapshot = {
  branch: "feature/subagent",
  upstream: "origin/feature/subagent",
  ahead: 1,
  behind: 0,
  worktree: "H:/Code/integrator-3-child",
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SubagentConversation", () => {
  it("reopens a stopped child and sends the provider/model selected in the shared composer", async () => {
    vi.spyOn(bridge, "loadTaskProjection").mockResolvedValue({ events: [], watermarkSeq: 0 });
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

    render(
      <SubagentConversation
        delegation={stoppedDelegation}
        runtimes={runtimes}
        onClose={vi.fn()}
        onSend={onSend}
      />,
    );

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

  it("mirrors compact task controls, reports child tokens, and opens the child review", async () => {
    vi.spyOn(bridge, "loadTaskProjection").mockResolvedValue({
      watermarkSeq: 1,
      events: [
        {
          taskId: "task-child",
          seq: 1,
          providerSessionId: "session-child",
          provider: "codex",
          threadId: "thread-child",
          occurredAt: "2026-07-12T10:06:00Z",
          projection: {
            kind: "usageChanged",
            usage: {
              inputTokens: 1_100_000,
              cachedInputTokens: 100_000,
              outputTokens: 200_000,
              reasoningOutputTokens: 0,
              totalTokens: 1_400_000,
            },
          },
        },
      ],
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

    render(
      <SubagentConversation
        delegation={stoppedDelegation}
        runtimes={runtimes}
        onClose={vi.fn()}
        onSend={vi.fn().mockResolvedValue(undefined)}
        onToggleTerminal={onToggleTerminal}
        onToggleRightRail={onToggleRightRail}
      />,
    );

    expect(await screen.findByLabelText("1,400,000 tokens")).toHaveTextContent("1.4m");
    expect(await screen.findByRole("tab", { name: "Review" })).toBeInTheDocument();
    const header = document.querySelector<HTMLElement>(".conversation-header");
    expect(header).not.toBeNull();
    expect(within(header!).getByRole("tab", { name: "Task" })).toHaveAttribute(
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
});
