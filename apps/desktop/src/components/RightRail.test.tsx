// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../demoData";
import type { DelegationView, ProjectFileContent, ProjectFileEntry } from "../bridge";
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
    onOpenProjectFile: vi.fn(async (file: ProjectFileEntry): Promise<ProjectFileContent> => ({
      path: file.path,
      content: `// contents of ${file.path}\nexport {};\n`,
      isBinary: false,
    })),
    onStageFile: vi.fn().mockResolvedValue(undefined),
    onStageFiles: vi.fn().mockResolvedValue(undefined),
    onCommit: vi.fn().mockResolvedValue(undefined),
    onPush: vi.fn().mockResolvedValue(undefined),
    onReviewChanges: vi.fn(),
    onRefreshGit: vi.fn().mockResolvedValue(undefined),
  };
  render(
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
    />,
  );
  return { snapshot, callbacks };
}

describe("RightRail", () => {
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
        brief: "Review the flow.",
        status: "running",
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

    fireEvent.click(screen.getAllByRole("button", { name: "View transcript" })[0]);
    expect(onSelectDelegation).toHaveBeenCalledWith("delegation-root");
    expect(screen.queryByLabelText("Audit the interaction transcript")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Git/ })).toBeInTheDocument();
  });

  it("shows only the project file tree in Files and opens a reader tab", async () => {
    const { callbacks } = setup();
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));

    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Files");
    expect(screen.queryByText(/Changed files reported by Git/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Open files in review" })).not.toBeInTheDocument();
    expect(screen.getByTitle("Open src/App.tsx")).toBeInTheDocument();
    expect(
      screen.getByText("Select a file from the project tree to preview it."),
    ).toBeInTheDocument();

    callbacks.onOpenProjectFile.mockResolvedValueOnce({
      path: "src/App.tsx",
      content: 'const value = "ok";\nfunction run() {}\n',
      isBinary: false,
    });
    fireEvent.click(screen.getByTitle("Open src/App.tsx"));
    await waitFor(() => expect(callbacks.onOpenProjectFile).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("tab", { name: /App\.tsx/ })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize file preview" })).toBeInTheDocument();
    expect(screen.getByLabelText("Contents of src/App.tsx")).toHaveTextContent(
      'const value = "ok";',
    );
    expect(screen.getByText("const", { selector: ".syntax-keyword" })).toBeInTheDocument();
    expect(screen.getByText('"ok"', { selector: ".syntax-string" })).toBeInTheDocument();
  });

  it("opens a transcript-requested file directly in the Files tab", async () => {
    const { callbacks } = setup({
      openProjectFileRequest: { path: "src/App.tsx", id: 1 },
    });

    expect(await screen.findByRole("tab", { name: /App\.tsx/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Contents of src/App.tsx")).toBeInTheDocument();
    expect(callbacks.onOpenProjectFile).toHaveBeenCalledWith(projectFiles[0]);
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
  });

  it("progressively mounts large text previews with an explicit show-all action", async () => {
    const content = Array.from({ length: 1_200 }, (_, index) => `preview-line-${index}`).join("\n");
    const { callbacks } = setup();
    callbacks.onOpenProjectFile.mockResolvedValueOnce({
      path: "src/App.tsx",
      content,
      isBinary: false,
    });
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.click(screen.getByTitle("Open src/App.tsx"));

    const preview = await screen.findByLabelText("Contents of src/App.tsx");
    expect(preview.querySelectorAll("li")).toHaveLength(400);
    expect(preview).not.toHaveTextContent("preview-line-1199");
    fireEvent.click(screen.getByRole("button", { name: "Show all 1,200 lines" }));
    expect(preview.querySelectorAll("li")).toHaveLength(1_200);
    expect(preview).toHaveTextContent("preview-line-1199");
  });

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

  it("closes an open reader tab", async () => {
    setup();
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.click(screen.getByTitle("Open README.md"));
    expect(await screen.findByRole("tab", { name: /README\.md/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close README.md" }));
    // The tab leaves through a short exit animation before unmounting.
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: /README\.md/ })).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText("Select a file from the project tree to preview it."),
    ).toBeInTheDocument();
  });

  it("marks unavailable vendor plan data instead of inventing a plan percentage", () => {
    setup();
    fireEvent.click(screen.getByRole("tab", { name: "Usage" }));

    expect(screen.getByText("Vendor plan unavailable")).toBeInTheDocument();
    expect(screen.getByText("Subscription usage").parentElement).toHaveTextContent("Unavailable");
    expect(screen.getByText("Local turns").parentElement).toHaveTextContent("local observed");
    expect(screen.getByText("Input tokens (estimate)").parentElement).toHaveTextContent(
      "estimated",
    );
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

  it("keeps commit and push distinct inside the compact split action", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onPush = vi.fn().mockRejectedValue(new Error("Confirmed native push is unavailable"));
    setup({ onCommit, onPush });

    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), {
      target: { value: "Ship the staged change" },
    });
    fireEvent.click(screen.getByRole("button", { name: "More commit actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Commit & push/i }));

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("Ship the staged change"));
    expect(onPush).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Confirm Git push" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Push now/i }));
    await waitFor(() => expect(onPush).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Committed locally. Push failed: Confirmed native push is unavailable",
    );
    expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveValue("");
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

  it("reviews changes, refreshes Git, and stages a whole group", async () => {
    const onReviewChanges = vi.fn();
    const onRefreshGit = vi.fn().mockResolvedValue(undefined);
    const { callbacks } = setup({ onReviewChanges, onRefreshGit });

    fireEvent.click(screen.getByRole("button", { name: /Review changes/i }));
    expect(onReviewChanges).toHaveBeenCalledTimes(1);

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
  });

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

  it("renders live delegations with working approve and nudge controls", async () => {
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
      onApproveDelegation,
      onNudgeDelegation,
    });

    fireEvent.click(screen.getByRole("tab", { name: /^Agents/ }));
    expect(screen.getByText("Write reducer tests")).toBeInTheDocument();
    expect(screen.getByText("Should I include style nits?", { exact: false })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onApproveDelegation).toHaveBeenCalledWith("delegation-1"));

    const nudgeInput = screen.getByRole("textbox", { name: "Message Review the diff" });
    fireEvent.change(nudgeInput, { target: { value: "Yes, include style nits" } });
    fireEvent.keyDown(nudgeInput, { key: "Enter" });
    await waitFor(() =>
      expect(onNudgeDelegation).toHaveBeenCalledWith("delegation-2", "Yes, include style nits"),
    );
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
