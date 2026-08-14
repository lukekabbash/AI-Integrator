import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArchiveSettings } from "./ArchiveSettings";

const projects = [
  {
    id: "project-active",
    name: "Active project",
    path: "C:/work/active",
    branch: "main",
    dirtyFiles: 0,
    expanded: true,
  },
  {
    id: "project-archived",
    name: "Archived project",
    path: "C:/work/archived",
    branch: "main",
    dirtyFiles: 0,
    expanded: false,
    archived: true,
  },
];

const tasks = [
  {
    id: "older-chat",
    projectId: "project-active",
    title: "Older archived chat",
    status: "completed" as const,
    runtime: "codex" as const,
    model: "gpt-5",
    updatedAt: "2026-08-01T12:00:00Z",
    archived: true,
  },
  {
    id: "newer-chat",
    projectId: "project-active",
    title: "Newer archived chat",
    status: "completed" as const,
    runtime: "codex" as const,
    model: "gpt-5",
    updatedAt: "2026-08-02T12:00:00Z",
    archived: true,
  },
  {
    id: "child-chat",
    projectId: "project-active",
    parentId: "older-chat",
    title: "Hidden child run",
    status: "completed" as const,
    runtime: "codex" as const,
    model: "gpt-5",
    updatedAt: "2026-08-03T12:00:00Z",
    archived: true,
  },
  {
    id: "live-chat",
    projectId: "project-active",
    title: "Live chat",
    status: "completed" as const,
    runtime: "codex" as const,
    model: "gpt-5",
    updatedAt: "2026-08-04T12:00:00Z",
  },
];

function renderArchive() {
  const callbacks = {
    setSetting: vi.fn(),
    onEnsureArchived: vi.fn(),
    onLoadMoreArchived: vi.fn(),
    onOpenTask: vi.fn(),
    onUpdateTask: vi.fn(),
    onUpdateProject: vi.fn(),
    onDeleteTask: vi.fn(),
    onDeleteProject: vi.fn(),
    onDeleteArchivedChats: vi.fn(),
  };
  render(
    <ArchiveSettings
      projects={projects}
      tasks={tasks}
      archivedHasMore
      settings={{
        "archive.autoArchiveAfter": "never",
        "archive.autoDeleteAfter": "never",
      }}
      {...callbacks}
    />,
  );
  return callbacks;
}

describe("ArchiveSettings", () => {
  it("loads archived roots once and preserves task action callbacks", () => {
    const callbacks = renderArchive();
    expect(callbacks.onEnsureArchived).toHaveBeenCalledOnce();
    expect(screen.getByText("Older archived chat")).toBeInTheDocument();
    expect(screen.getByText("Newer archived chat")).toBeInTheDocument();
    expect(screen.queryByText("Hidden child run")).not.toBeInTheDocument();
    expect(screen.queryByText("Live chat")).not.toBeInTheDocument();

    const newerRow = screen.getByText("Newer archived chat").closest(".archive-row");
    expect(newerRow).not.toBeNull();
    fireEvent.click(within(newerRow as HTMLElement).getByRole("button", { name: "Open" }));
    fireEvent.click(within(newerRow as HTMLElement).getByRole("button", { name: "Restore" }));
    fireEvent.click(within(newerRow as HTMLElement).getByRole("button", { name: "Delete…" }));

    expect(callbacks.onOpenTask).toHaveBeenCalledWith("newer-chat");
    expect(callbacks.onUpdateTask).toHaveBeenCalledWith("newer-chat", { archived: false });
    expect(callbacks.onDeleteTask).toHaveBeenCalledWith("newer-chat");
  });

  it("filters by title and keeps retention and pagination wiring intact", () => {
    const callbacks = renderArchive();
    fireEvent.change(screen.getByPlaceholderText("Filter by title or project"), {
      target: { value: "older" },
    });
    expect(screen.getByText("Older archived chat")).toBeInTheDocument();
    expect(screen.queryByText("Newer archived chat")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Auto-archive inactive chats" }));
    fireEvent.click(screen.getByRole("option", { name: "After 14 days" }));
    expect(callbacks.setSetting).toHaveBeenCalledWith("archive.autoArchiveAfter", "14d");

    fireEvent.click(screen.getByRole("button", { name: "Show more archived chats" }));
    expect(callbacks.onLoadMoreArchived).toHaveBeenCalledOnce();
  });

  it("preserves archived-project restore and delete actions", () => {
    const callbacks = renderArchive();
    const projectRow = screen.getByText("C:/work/archived").closest(".archive-row");
    expect(projectRow).not.toBeNull();

    fireEvent.click(within(projectRow as HTMLElement).getByRole("button", { name: "Restore" }));
    fireEvent.click(within(projectRow as HTMLElement).getByRole("button", { name: "Delete…" }));

    expect(callbacks.onUpdateProject).toHaveBeenCalledWith("project-archived", {
      archived: false,
    });
    expect(callbacks.onDeleteProject).toHaveBeenCalledWith("project-archived");
  });
});
