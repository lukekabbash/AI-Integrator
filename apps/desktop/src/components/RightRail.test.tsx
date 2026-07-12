// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../demoData";
import type { ProjectFileContent, ProjectFileEntry } from "../bridge";
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
    onCommit: vi.fn().mockResolvedValue(undefined),
    onPush: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
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
    expect(screen.queryByRole("tab", { name: /README\.md/ })).not.toBeInTheDocument();
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

  it("closes overlaid task tools from inside the rail", () => {
    const { callbacks } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Close task tools" }));
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  });
});
