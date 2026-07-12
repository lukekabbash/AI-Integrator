// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../demoData";
import { TaskSidebar } from "./TaskSidebar";

function setup(overrides?: Partial<Parameters<typeof TaskSidebar>[0]>) {
  const snapshot = createDemoSnapshot();
  const callbacks = {
    onToggleCollapsed: vi.fn(),
    onSelectProject: vi.fn(),
    onSelectTask: vi.fn(),
    onNewTask: vi.fn(),
    onOpenProject: vi.fn(),
    onUpdateTask: vi.fn(),
    onOpenSettings: vi.fn(),
    onResize: vi.fn(),
  };
  render(
    <TaskSidebar
      projects={snapshot.projects}
      tasks={snapshot.tasks}
      activeProjectId={snapshot.activeProjectId}
      activeTaskId={snapshot.activeTaskId}
      collapsed={false}
      openingProject={false}
      metadataActionsEnabled
      taskActionBusyId=""
      {...callbacks}
      {...overrides}
    />,
  );
  return { snapshot, callbacks };
}

describe("TaskSidebar", () => {
  it("nests chats under the expanded active project", () => {
    const { snapshot } = setup();
    const active = snapshot.projects.find((project) => project.id === snapshot.activeProjectId)!;
    expect(screen.getByRole("button", { name: `Collapse ${active.name}` })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    const integratorChats = snapshot.tasks.filter(
      (task) => task.projectId === active.id && !task.archived,
    );
    for (const chat of integratorChats) {
      expect(screen.getByRole("button", { name: new RegExp(chat.title) })).toBeInTheDocument();
    }
  });

  it("reveals nested chats when expanding another project", () => {
    const { snapshot, callbacks } = setup();
    const lotmind = snapshot.projects.find((project) => project.id === "lotmind")!;
    fireEvent.click(screen.getByRole("button", { name: `Expand ${lotmind.name}` }));
    expect(screen.getByRole("button", { name: `Collapse ${lotmind.name}` })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Mobile intake overnight agent/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: `Open project ${lotmind.name}` }));
    expect(callbacks.onSelectProject).toHaveBeenCalledWith("lotmind");
  });

  it("selects a chat nested under a non-active project", () => {
    const { callbacks } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Expand Lotmind AI" }));
    fireEvent.click(screen.getByRole("button", { name: /Mobile intake overnight agent/i }));
    expect(callbacks.onSelectTask).toHaveBeenCalledWith("overnight");
  });

  it("flattens search results across projects with project labels", () => {
    setup();
    fireEvent.change(screen.getByRole("textbox", { name: "Search chats" }), {
      target: { value: "overnight" },
    });
    expect(screen.getByText("Search results")).toBeInTheDocument();
    const result = screen.getByRole("button", { name: /Mobile intake overnight agent/i });
    expect(within(result).getByText(/Lotmind AI/i)).toBeInTheDocument();
  });

  it("keeps Settings as a bottom-aligned control", () => {
    setup();
    expect(screen.getByRole("button", { name: "Open Settings" })).toBeInTheDocument();
  });

  it("keeps idle chat meta quiet with relative time instead of permanent status", () => {
    setup();
    const idle = screen.getByRole("button", { name: /Tune coordinated theme presets/i });
    expect(idle.textContent).not.toMatch(/Completed/);
    expect(idle.textContent).toMatch(/ago|Just now|Jul/);
    const live = screen.getByRole("button", { name: /Construct the native v1 workspace/i });
    expect(live.textContent).toMatch(/Running/);
  });

  it("keeps the row overflow action above adjacent chats", () => {
    setup();
    const overflowButtons = screen.getAllByRole("button", { name: "More chat actions" });
    fireEvent.click(overflowButtons[0]);

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(overflowButtons[0].parentElement).toHaveAttribute("data-menu-open", "true");
  });
});
