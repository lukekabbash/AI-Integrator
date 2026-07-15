// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LazyMotion, domMax } from "motion/react";
import { describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../demoData";
import type { DelegationView, ProjectFileEntry } from "../bridge";
import { RightRail } from "./RightRail";

const projectFiles: ProjectFileEntry[] = [
  { path: "src/App.tsx", size: 1200 },
  { path: "src/bridge.ts", size: 2400 },
  { path: "README.md", size: 800 },
];

function setup(overrides?: Partial<Parameters<typeof RightRail>[0]>) {
  const snapshot = createDemoSnapshot();
  const callbacks = {
    onSelectFile: vi.fn(),
    onOpenFile: vi.fn(),
    onStageFile: vi.fn().mockResolvedValue(undefined),
    onStageFiles: vi.fn().mockResolvedValue(undefined),
    onCommit: vi.fn().mockResolvedValue(undefined),
    onGenerateCommitMessage: vi.fn().mockResolvedValue("feat: generate commit subjects"),
    onPush: vi.fn().mockResolvedValue(undefined),
    onReviewChanges: vi.fn(),
    onRefreshGit: vi.fn().mockResolvedValue(undefined),
  };
  render(
    <LazyMotion features={domMax} strict>
      <RightRail
        git={snapshot.git}
        children={snapshot.children}
        usage={snapshot.usage}
        activeFile={snapshot.git.files[0]}
        projectId="integrator"
        projectFiles={projectFiles}
        projectFilesState="ready"
        {...callbacks}
        {...overrides}
      />
    </LazyMotion>,
  );
  return { snapshot, callbacks };
}

describe("RightRail", () => {
  it("moves one selection line through click and keyboard tab changes", () => {
    setup();
    const tabs = screen.getByRole("tablist", { name: "Task tools" });
    const git = within(tabs).getByRole("tab", { name: /^Git/ });
    const agents = within(tabs).getByRole("tab", { name: /^Agents/ });

    expect(git.querySelector(".sliding-tab-indicator")).toBeInTheDocument();
    expect(tabs.querySelectorAll(".sliding-tab-indicator")).toHaveLength(1);

    fireEvent.keyDown(git, { key: "ArrowRight" });
    expect(agents).toHaveAttribute("aria-selected", "true");
    expect(agents.querySelector(".sliding-tab-indicator")).toBeInTheDocument();
    expect(git.querySelector(".sliding-tab-indicator")).not.toBeInTheDocument();
    expect(tabs.querySelectorAll(".sliding-tab-indicator")).toHaveLength(1);
  });

  it("does not offer Git setup while repository detection is still running", () => {
    setup({
      gitLoading: true,
      git: {
        kind: "notRepository",
        branch: "",
        upstream: "",
        ahead: 0,
        behind: 0,
        worktree: "/Users/me/Projects/existing-repository",
        remotes: [],
        files: [],
        commits: [],
      },
    });

    expect(screen.getByRole("status")).toHaveTextContent("Checking repository…");
    expect(
      screen.queryByRole("heading", { name: "Set up Git for this folder" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the Git panel painted while a known repository refreshes", () => {
    const snapshot = createDemoSnapshot();
    setup({
      gitLoading: true,
      git: snapshot.git,
      activeFile: snapshot.git.files[0],
    });

    expect(screen.queryByRole("status", { name: "Checking repository" })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Commit message")).toBeInTheDocument();
    expect(document.querySelector(".git-panel")).toHaveAttribute("aria-busy", "true");
    expect(document.querySelector(".git-panel")).toHaveAttribute("data-refreshing", "true");
    expect(document.querySelectorAll(".git-file-row").length).toBeGreaterThan(0);
  });

  it("treats an ordinary folder as an intentional Git setup state", async () => {
    const onInitializeGit = vi.fn().mockResolvedValue(undefined);
    setup({
      git: {
        kind: "notRepository",
        branch: "",
        upstream: "",
        ahead: 0,
        behind: 0,
        worktree: "/Users/me/Projects/notes",
        remotes: [],
        files: [],
        commits: [],
      },
      onInitializeGit,
    });

    expect(screen.getByRole("heading", { name: "Set up Git for this folder" })).toBeVisible();
    expect(screen.queryByPlaceholderText("Commit message")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Set up Git$/ }));
    });
    expect(onInitializeGit).toHaveBeenCalledOnce();
  });

  it("shows and selects both scopes of a partially staged file", () => {
    const snapshot = createDemoSnapshot();
    const staged = {
      ...snapshot.git.files[0],
      path: "src/App.tsx",
      staged: true,
      additions: 4,
      deletions: 1,
    };
    const unstaged = {
      ...staged,
      staged: false,
      additions: 2,
      deletions: 0,
    };
    const { callbacks } = setup({ git: { ...snapshot.git, files: [staged, unstaged] } });

    expect(
      within(screen.getByRole("region", { name: "Staged changes" })).getByText("App.tsx"),
    ).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Unstaged changes" })).getByText("App.tsx"),
    ).toBeVisible();

    const fileButtons = document.querySelectorAll<HTMLButtonElement>(".git-file-name");
    fireEvent.click(fileButtons[1]!);
    expect(callbacks.onSelectFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "src/App.tsx",
        staged: false,
      }),
    );
  });

  it("surfaces local-only publishing and keeps remote management in the Git menu", async () => {
    const snapshot = createDemoSnapshot();
    setup({ git: { ...snapshot.git, upstream: "", remotes: [] } });

    expect(screen.getByText("Local only")).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish to GitHub" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect remote" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "More Git actions" }));
    // The menu springs in via motion, so wait for its enter animation.
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: /Manage remotes/i })).toBeVisible(),
    );
    // Commit & push stays discoverable even without a remote — disabled, with
    // the reason spelled out instead of vanishing from the menu.
    const commitAndPush = screen.getByRole("menuitem", { name: /Commit & push/i });
    expect(commitAndPush).toBeDisabled();
    expect(commitAndPush).toHaveTextContent("Connect a remote first");
    // Exactly one separator (before Manage remotes): hidden items must not
    // leave extra dividers or phantom space at the top of the menu.
    expect(document.querySelectorAll(".compact-action-menu-separator")).toHaveLength(1);
    expect(screen.queryByText("Nothing to push")).not.toBeInTheDocument();
  });

  it("selects a subagent for the sibling conversation pane and renders descendant lineage", () => {
    const delegations: DelegationView[] = [
      {
        id: "delegation-root",
        parentTaskId: "task-root",
        childTaskId: "task-child",
        profileId: "claude-ux",
        profileLabel: "Claude UX",
        runtime: "claude",
        model: "claude-fable-5",
        title: "Audit the interaction",
        brief:
          "Review the complete interaction flow and report only the highest-impact selection issues.",
        status: "completed",
        result: "A very long completed audit that belongs in the conversation pane, not the rail.",
        createdAt: "2026-07-12T10:00:00Z",
        updatedAt: "2026-07-12T10:01:00Z",
        unreadFromChild: 0,
        pendingQuestions: [],
      },
      {
        id: "delegation-grandchild",
        parentTaskId: "task-child",
        childTaskId: "task-grandchild",
        profileId: "codex-explore",
        profileLabel: "Fast explorer",
        runtime: "codex",
        model: "gpt-5.6-luna",
        title: "Map the existing components",
        brief: "Inspect the component tree.",
        status: "waiting",
        createdAt: "2026-07-12T10:02:00Z",
        updatedAt: "2026-07-12T10:03:00Z",
        unreadFromChild: 0,
        pendingQuestions: [],
      },
    ];
    const onNudgeDelegation = vi.fn().mockResolvedValue(undefined);
    const onSelectDelegation = vi.fn();
    setup({ delegations, onNudgeDelegation, onSelectDelegation });

    fireEvent.click(screen.getByRole("tab", { name: /Agents/ }));
    expect(screen.getByRole("tab", { name: /Agents\s*2/ })).toBeInTheDocument();
    const lineage = screen.getByRole("tree", { name: "Subagent lineage" });
    expect(lineage).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /Audit the interaction/ })).toHaveAttribute(
      "aria-level",
      "1",
    );
    expect(screen.getByRole("treeitem", { name: /Map the existing components/ })).toHaveAttribute(
      "aria-level",
      "2",
    );

    fireEvent.click(screen.getByRole("treeitem", { name: /Audit the interaction/ }));
    expect(onSelectDelegation).toHaveBeenCalledWith("delegation-root");
    expect(screen.queryByRole("button", { name: /View transcript/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Audit the interaction transcript")).not.toBeInTheDocument();
    expect(
      screen.getByTitle(
        "Review the complete interaction flow and report only the highest-impact selection issues.",
      ),
    ).toHaveClass("agent-activity");
    expect(
      screen.queryByText(
        "A very long completed audit that belongs in the conversation pane, not the rail.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Git/ })).toBeInTheDocument();
  });

  it("gives concurrent agents stable provider-colored glyphs and opens transcripts from the row", () => {
    const statuses: DelegationView["status"][] = [
      "starting",
      "running",
      "waiting",
      "completed",
      "failed",
      "stopped",
    ];
    const delegations: DelegationView[] = Array.from({ length: 12 }, (_, index) => ({
      id: `delegation-${index + 1}`,
      parentTaskId: "task-root",
      childTaskId: `task-child-${index + 1}`,
      profileId: "codex-default",
      profileLabel: "Codex builder",
      runtime: "codex",
      model: "gpt-5.6-codex",
      title: `Agent ${index + 1}`,
      brief: `Workstream ${index + 1}`,
      status: statuses[index % statuses.length]!,
      createdAt: new Date(Date.UTC(2026, 6, 12, 10, index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 6, 12, 10, index)).toISOString(),
      unreadFromChild: 0,
      pendingQuestions: [],
    }));
    const onSelectDelegation = vi.fn();
    setup({ delegations, onSelectDelegation });

    expect(screen.getByRole("tab", { name: /Agents\s*12/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Agents/ }));
    const tree = screen.getByRole("tree", { name: "Subagent lineage" });
    const glyphs = Array.from(tree.querySelectorAll<HTMLElement>(".agent-glyph"));
    const firstTen = glyphs.slice(0, 10).map((glyph) => glyph.dataset.agentIcon);

    expect(new Set(firstTen)).toHaveLength(10);
    expect(glyphs[10]).toHaveAttribute("data-agent-icon", glyphs[0]!.dataset.agentIcon);
    expect(glyphs[0]).toHaveAttribute("data-shade", "0");
    expect(glyphs[10]).toHaveAttribute("data-shade", "1");
    expect(glyphs[0]).toHaveAttribute("data-morphing", "true");
    expect(glyphs[0]).toHaveAttribute("data-morph-frames", "4");
    expect(glyphs[1]).toHaveAttribute("data-morph-frames", "5");
    expect(glyphs[3]).toHaveAttribute("data-morphing", "false");
    expect(glyphs[3]).toHaveAttribute("data-morph-frames", "1");
    expect(tree.querySelectorAll(".agent-route .provider-icon")).toHaveLength(12);
    expect(screen.getAllByText("gpt-5.6-codex")).toHaveLength(12);

    fireEvent.click(screen.getByRole("treeitem", { name: /Agent 11/ }));
    expect(onSelectDelegation).toHaveBeenCalledWith("delegation-11");
  });

  it("shows only the project file tree in Files and opens files toward the canvas", () => {
    const { callbacks } = setup();
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));

    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Files");
    expect(screen.queryByText(/Changed files reported by Git/i)).not.toBeInTheDocument();
    // The rail is navigator-only: no embedded reader, tabs, or resize split.
    expect(screen.queryByRole("region", { name: "Open files in review" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("separator", { name: "Resize file preview" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTitle("Open src/App.tsx")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Open src/App.tsx"));
    expect(callbacks.onOpenFile).toHaveBeenCalledWith(projectFiles[0]);
  });

  it("highlights the canvas-active file in the tree", async () => {
    setup({ activeFilePath: "src/App.tsx" });
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));

    expect(screen.getByTitle("Open src/App.tsx")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTitle("Open src/bridge.ts")).not.toHaveAttribute("aria-current");
    await waitFor(() =>
      expect(document.querySelector(".file-tree-active")?.parentElement).toHaveClass("file-tree"),
    );
    expect(screen.getByTitle("Open src/App.tsx")).not.toContainElement(
      document.querySelector(".file-tree-active"),
    );
  });

  it("filters project files and keeps Git diffs out of the Files tab", () => {
    const { snapshot } = setup();
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Filter files" }), {
      target: { value: "bridge" },
    });
    expect(screen.getByTitle("Open src/bridge.ts")).toBeInTheDocument();
    expect(screen.queryByTitle("Open src/App.tsx")).not.toBeInTheDocument();
    expect(screen.queryByTitle(snapshot.git.files[0]?.path ?? "missing")).not.toBeInTheDocument();
  });

  it("progressively mounts a large project tree while filtering the full file set", () => {
    const largeFileSet = Array.from({ length: 1_000 }, (_, index) => ({
      path: `file-${index.toString().padStart(4, "0")}.ts`,
      size: index + 1,
    }));
    setup({ projectFiles: largeFileSet });
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));

    const tree = screen.getByLabelText("Project files");
    expect(tree.querySelectorAll("[title^='Open file-']")).toHaveLength(300);
    expect(screen.getByText("Showing 300 of 1,000 files")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show next 300 files" }));
    expect(tree.querySelectorAll("[title^='Open file-']")).toHaveLength(600);

    fireEvent.change(screen.getByRole("textbox", { name: "Filter files" }), {
      target: { value: "file-0999" },
    });
    expect(screen.getByTitle("Open file-0999.ts")).toBeInTheDocument();
    expect(tree.querySelectorAll("[title^='Open file-']")).toHaveLength(1);
  }, 12_000);

  it("indents nested folders and files by their tree depth", () => {
    setup({
      projectFiles: [
        { path: "src/runtime/router.ts", size: 1200 },
        { path: "src/runtime/index.ts", size: 900 },
        { path: "README.md", size: 800 },
      ],
    });
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));

    expect(screen.getByRole("button", { name: "Collapse folder src" })).toHaveAttribute(
      "data-tree-depth",
      "0",
    );
    expect(screen.getByRole("button", { name: "Collapse folder src/runtime" })).toHaveAttribute(
      "data-tree-depth",
      "1",
    );
    expect(screen.getByTitle("Open src/runtime/router.ts")).toHaveAttribute("data-tree-depth", "2");
  });

  it("collapses the active folder immediately while the selection pill fades in place", async () => {
    setup({
      activeFilePath: "src/runtime/router.ts",
      projectFiles: [
        { path: "src/runtime/router.ts", size: 1200 },
        { path: "src/runtime/index.ts", size: 900 },
      ],
    });
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));

    await waitFor(() => expect(document.querySelector(".file-tree-active")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Collapse folder src/runtime" }));
    // The slide starts right away — no deferred collapse.
    expect(screen.getByRole("button", { name: "Expand folder src/runtime" })).toBeInTheDocument();
    // The pill is removed once the sliding rows unmount, never re-shown.
    await waitFor(() =>
      expect(document.querySelector(".file-tree-active")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand folder src/runtime" }));
    await waitFor(() => expect(document.querySelector(".file-tree-active")).toBeInTheDocument());
  });

  it("marks unavailable vendor plan data instead of inventing a plan percentage", () => {
    setup({ runtime: "claude" });
    fireEvent.click(screen.getByRole("tab", { name: "Usage" }));

    expect(screen.getByText("Plan telemetry not exposed")).toBeInTheDocument();
    expect(screen.getByText(/run \/usage/i)).toBeInTheDocument();
    expect(screen.queryByText("Subscription usage")).not.toBeInTheDocument();
    expect(screen.getByText("Local turns").parentElement).toHaveTextContent("local observed");
    expect(screen.getByText("Input tokens (estimate)").parentElement).toHaveTextContent(
      "estimated",
    );
  });

  it("shows every provider-reported Codex plan window without collapsing them", () => {
    setup({
      runtime: "codex",
      subscription: {
        planType: "pro",
        primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 1_900_000_000 },
        secondary: { usedPercent: 8, windowDurationMins: 10_080, resetsAt: 1_900_500_000 },
        updatedAt: "2026-07-14T12:00:00Z",
      },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Usage" }));

    expect(screen.getByText("5-hour limit")).toBeInTheDocument();
    expect(screen.getByText("Weekly limit")).toBeInTheDocument();
    expect(screen.getByText("34% used")).toBeInTheDocument();
    expect(screen.getByText("8% used")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    expect(screen.queryByText("Plan telemetry not exposed")).not.toBeInTheDocument();
  });

  it("commits with Ctrl+Enter and exposes failures instead of reporting fake success", async () => {
    const { callbacks } = setup();
    callbacks.onCommit.mockRejectedValueOnce(new Error("Commit rejected by Git"));

    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), {
      target: { value: "Ship the staged change" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Commit message" }), {
      key: "Enter",
      ctrlKey: true,
    });

    await waitFor(() => expect(callbacks.onCommit).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent("Commit rejected by Git");
  });

  it("generates a commit draft from the sparkle without committing it", async () => {
    const { callbacks } = setup();

    fireEvent.click(screen.getByRole("button", { name: "Generate commit message" }));

    await waitFor(() => expect(callbacks.onGenerateCommitMessage).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveValue(
      "feat: generate commit subjects",
    );
    expect(callbacks.onCommit).not.toHaveBeenCalled();
  });

  it("never overwrites a manual edit made while generation is running", async () => {
    let resolveGeneration: (message: string) => void = () => undefined;
    const generation = new Promise<string>((resolve) => {
      resolveGeneration = resolve;
    });
    setup({ onGenerateCommitMessage: vi.fn(() => generation) });

    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), {
      target: { value: "Initial draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate commit message" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), {
      target: { value: "My manual subject" },
    });
    await act(async () => resolveGeneration("feat: generated subject"));

    expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveValue(
      "My manual subject",
    );
  });

  it("surfaces commit-message provider failures in the Git panel", async () => {
    setup({
      onGenerateCommitMessage: vi.fn().mockRejectedValue(new Error("Provider is unavailable")),
    });

    fireEvent.click(screen.getByRole("button", { name: "Generate commit message" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Provider is unavailable");
  });

  it("commits and pushes immediately from the compact split action", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onPush = vi.fn().mockRejectedValue(new Error("Confirmed native push is unavailable"));
    setup({ onCommit, onPush });

    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), {
      target: { value: "Ship the staged change" },
    });
    fireEvent.click(screen.getByRole("button", { name: "More Git actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Commit & push/i }));

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("Ship the staged change"));
    await waitFor(() => expect(onPush).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Committed locally. Push failed: Confirmed native push is unavailable",
    );
    expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveValue("");
  });

  it("skips the commit when only pushing existing local commits", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onPush = vi.fn().mockResolvedValue(undefined);
    setup({ onCommit, onPush });

    fireEvent.click(screen.getByRole("button", { name: "More Git actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Push/i }));

    await waitFor(() => expect(onPush).toHaveBeenCalledTimes(1));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("keeps Git panes independently scrollable with the graph last and resizable", () => {
    setup();

    const workspace = document.querySelector(".git-workspace");
    expect(workspace).not.toBeNull();
    expect(workspace?.lastElementChild).toHaveClass("git-history");
    expect(
      screen.getByLabelText("Staged changes").querySelector(".git-section-body"),
    ).not.toBeNull();
    expect(
      screen.getByLabelText("Unstaged changes").querySelector(".git-section-body"),
    ).not.toBeNull();
    expect(screen.getByLabelText("Commit graph").querySelector(".git-history-body")).not.toBeNull();

    const graphDivider = screen.getByRole("separator", {
      name: "Resize Git graph",
    });
    fireEvent.keyDown(graphDivider, { key: "ArrowUp" });
    expect(workspace).toHaveStyle({ "--git-graph-ratio": "45%" });
  });

  it("opens Git file actions on right click with detected-app and reveal handoffs", async () => {
    const onOpenGitFileExternal = vi.fn().mockResolvedValue(undefined);
    const onRevealGitFile = vi.fn().mockResolvedValue(undefined);
    const { snapshot } = setup({
      fileOpeners: [
        { id: "cursor", label: "Cursor", description: "Open in Cursor" },
        { id: "codex", label: "Codex (workspace)", description: "Open workspace in Codex" },
      ],
      onOpenGitFileExternal,
      onRevealGitFile,
    });
    const file = snapshot.git.files[0]!;

    fireEvent.contextMenu(screen.getByTitle(file.path), { clientX: 900, clientY: 240 });
    const openIn = screen.getByRole("menuitem", { name: /Open in$/i });
    fireEvent.pointerEnter(openIn);
    expect(screen.getByRole("menuitem", { name: "Codex (workspace)" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Cursor" }));
    await waitFor(() => expect(onOpenGitFileExternal).toHaveBeenCalledWith(file, "cursor"));

    fireEvent.contextMenu(screen.getByTitle(file.path), { clientX: 900, clientY: 240 });
    fireEvent.pointerEnter(screen.getByRole("menuitem", { name: /Open in$/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Codex (workspace)" }));
    await waitFor(() => expect(onOpenGitFileExternal).toHaveBeenCalledWith(file, "codex"));

    fireEvent.contextMenu(screen.getByTitle(file.path), { clientX: 900, clientY: 240 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Reveal in File Explorer/i }));
    await waitFor(() => expect(onRevealGitFile).toHaveBeenCalledWith(file));
  });

  it("opens project files in detected editors or File Explorer from the Files menu", async () => {
    const onOpenProjectFileExternal = vi.fn().mockResolvedValue(undefined);
    const onRevealProjectFile = vi.fn().mockResolvedValue(undefined);
    setup({
      fileOpeners: [
        { id: "cursor", label: "Cursor", description: "Open in Cursor" },
        { id: "vscode", label: "VS Code", description: "Open in VS Code" },
        { id: "codex", label: "Codex", description: "Open in Codex" },
      ],
      onOpenProjectFileExternal,
      onRevealProjectFile,
    });

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    const fileButton = screen.getByTitle("Open src/App.tsx");
    fireEvent.contextMenu(fileButton, { clientX: 760, clientY: 220 });
    expect(screen.queryByRole("menuitem", { name: /Codex/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in Cursor" }));
    await waitFor(() =>
      expect(onOpenProjectFileExternal).toHaveBeenCalledWith("src/App.tsx", "cursor"),
    );

    fireEvent.contextMenu(fileButton, { clientX: 760, clientY: 220 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in File Explorer" }));
    await waitFor(() => expect(onRevealProjectFile).toHaveBeenCalledWith("src/App.tsx"));
  });

  it("keeps Git metadata compact, refreshes Git, and stages a whole group", async () => {
    const onRefreshGit = vi.fn().mockResolvedValue(undefined);
    const { callbacks } = setup({ onRefreshGit });

    expect(screen.queryByRole("button", { name: /Review changes/i })).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("2 commits ahead, 0 behind origin/feature/v1-native-app"),
    ).toHaveTextContent("2 ahead · 0 behind");
    expect(
      screen.getByLabelText("62 lines added, 37 lines removed in the working tree"),
    ).toHaveTextContent("+62−37");

    fireEvent.click(screen.getByRole("button", { name: "Refresh Git status" }));
    await waitFor(() => expect(onRefreshGit).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Stage all" }));
    await waitFor(() =>
      expect(callbacks.onStageFiles).toHaveBeenCalledWith(
        expect.arrayContaining(["src/runtime/router.ts"]),
        true,
      ),
    );
  });

  it("bounds large Git groups without narrowing bulk staging scope", async () => {
    const snapshot = createDemoSnapshot();
    const baseFile = snapshot.git.files[0]!;
    const files = Array.from({ length: 600 }, (_, index) => ({
      ...baseFile,
      path: `src/generated/file-${index}.ts`,
      staged: false,
    }));
    const { callbacks } = setup({
      git: { ...snapshot.git, files },
      activeFile: files[0],
    });

    expect(document.querySelectorAll(".git-file-row")).toHaveLength(200);
    expect(screen.getByText("Showing 200 of 600 files")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stage all" }));
    await waitFor(() => expect(callbacks.onStageFiles).toHaveBeenCalledTimes(1));
    expect(callbacks.onStageFiles.mock.calls[0][0]).toHaveLength(600);

    fireEvent.click(screen.getByRole("button", { name: "Show all 600 files" }));
    expect(document.querySelectorAll(".git-file-row")).toHaveLength(600);
  }, 12_000);

  it("does not present unconnected sidebar actions as buttons", () => {
    setup();
    expect(
      screen.queryByRole("button", { name: /Fetch|Open PR|All branches/i }),
    ).not.toBeInTheDocument();

    // Without live delegations (demo mode), the Agents tab is display-only.
    fireEvent.click(screen.getByRole("tab", { name: /^Agents/ }));
    expect(
      screen.queryByRole("button", { name: /Approve|Deny|Stop|Open transcript/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps live delegation actions compact and nudges the selected subagent from the rail", async () => {
    const onApproveDelegation = vi.fn().mockResolvedValue(undefined);
    const onNudgeDelegation = vi.fn().mockResolvedValue(undefined);
    setup({
      delegations: [
        {
          id: "delegation-1",
          parentTaskId: "task-1",
          childTaskId: null,
          profileId: "codex-default",
          profileLabel: "Codex (OpenAI)",
          runtime: "codex",
          model: "gpt-5.6-codex",
          title: "Write reducer tests",
          brief: "Cover the ACP reducer paths",
          status: "pending-approval",
          result: null,
          createdAt: "2026-07-11T00:00:00Z",
          updatedAt: "2026-07-11T00:00:00Z",
          unreadFromChild: 0,
          pendingQuestions: [],
        },
        {
          id: "delegation-2",
          parentTaskId: "task-1",
          childTaskId: "task-child",
          profileId: "claude-default",
          profileLabel: "Claude",
          runtime: "claude",
          model: null,
          title: "Review the diff",
          brief: "Second-opinion review",
          status: "waiting",
          result: null,
          createdAt: "2026-07-11T00:00:00Z",
          updatedAt: "2026-07-11T00:00:00Z",
          unreadFromChild: 1,
          pendingQuestions: ["Should I include style nits?"],
        },
      ],
      selectedDelegationId: "delegation-2",
      onApproveDelegation,
      onNudgeDelegation,
    });

    fireEvent.click(screen.getByRole("tab", { name: /^Agents/ }));
    expect(screen.getByText("Write reducer tests")).toBeInTheDocument();
    expect(screen.getByText("Should I include style nits?")).toBeInTheDocument();
    expect(screen.queryByText(/❓/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onApproveDelegation).toHaveBeenCalledWith("delegation-1"));
    const nudge = screen.getByPlaceholderText("Nudge this subagent…");
    fireEvent.change(nudge, { target: { value: "Focus on behavior, not style nits." } });
    fireEvent.click(screen.getByRole("button", { name: "Send nudge to Review the diff" }));
    await waitFor(() =>
      expect(onNudgeDelegation).toHaveBeenCalledWith(
        "delegation-2",
        "Focus on behavior, not style nits.",
      ),
    );
    expect(nudge).toHaveValue("");
  });

  it("supports arrow-key navigation across rail tabs", () => {
    setup();
    const gitTab = screen.getByRole("tab", { name: /^Git/ });
    gitTab.focus();
    fireEvent.keyDown(gitTab, { key: "ArrowRight" });
    const agentsTab = screen.getByRole("tab", { name: /^Agents/ });
    expect(agentsTab).toHaveFocus();
    expect(agentsTab).toHaveAttribute("aria-selected", "true");
  });

  it("keeps the single close control in the workspace header, not inside the rail", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Close task tools" })).not.toBeInTheDocument();
  });
});
