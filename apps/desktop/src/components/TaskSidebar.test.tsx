// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../demoData";
import { TaskSidebar } from "./TaskSidebar";

afterEach(cleanup);

function setup(overrides?: Partial<Parameters<typeof TaskSidebar>[0]>) {
  const snapshot = createDemoSnapshot();
  const callbacks = {
    onSelectProject: vi.fn(),
    onSelectTask: vi.fn(),
    onNewTask: vi.fn(),
    onNewTaskInProject: vi.fn(),
    onOpenProject: vi.fn(),
    onUpdateTask: vi.fn(),
    onOpenSettings: vi.fn(),
    onResize: vi.fn(),
  };
  const props = {
    projects: snapshot.projects,
    tasks: snapshot.tasks,
    activeProjectId: snapshot.activeProjectId,
    activeTaskId: snapshot.activeTaskId,
    openingProject: false,
    metadataActionsEnabled: true,
    taskActionBusyId: "",
    ...callbacks,
    ...overrides,
  } satisfies Parameters<typeof TaskSidebar>[0];
  const view = render(<TaskSidebar {...props} />);
  return {
    snapshot,
    callbacks,
    rerenderSidebar: (next: Partial<Parameters<typeof TaskSidebar>[0]>) =>
      view.rerender(<TaskSidebar {...props} {...next} />),
  };
}

describe("TaskSidebar", () => {
  it("mounts a fresh motion title when an automatic name arrives", () => {
    const snapshot = createDemoSnapshot();
    const task = { ...snapshot.tasks[0], title: "Coding session" };
    const { rerenderSidebar } = setup({ tasks: [task], activeTaskId: task.id });
    const placeholder = screen.getByText("Coding session", { selector: ".chat-row-title" });

    rerenderSidebar({ tasks: [{ ...task, title: "Provider Agnostic Naming" }] });

    const generated = screen.getByText("Provider Agnostic Naming", {
      selector: ".chat-row-title",
    });
    expect(generated).not.toBe(placeholder);
    expect(screen.queryByText("Coding session", { selector: ".chat-row-title" })).toBeNull();
  });

  it("nests chats under the expanded active project", async () => {
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
    await waitFor(() => expect(document.querySelectorAll(".chat-row-active")).toHaveLength(1));
    expect(document.querySelector(".chat-row-active")?.parentElement).toHaveClass("project-tree");
    expect(
      screen
        .getByRole("button", { name: new RegExp(snapshot.tasks[0].title) })
        .closest(".chat-row-shell"),
    ).not.toContainElement(document.querySelector(".chat-row-active"));
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

  it("shows five chats per project, pages ten at a time, and collapses back", () => {
    document.documentElement.dataset.motion = "none";
    try {
      const snapshot = createDemoSnapshot();
      const tasks = Array.from({ length: 250 }, (_, index) => ({
        ...snapshot.tasks[0],
        id: `bulk-${index}`,
        projectId: snapshot.activeProjectId,
        title: `Bulk chat ${index}`,
        status: "completed" as const,
        updatedAt: new Date(Date.UTC(2026, 6, 12, 12, 0) - index * 60_000).toISOString(),
      }));
      setup({ tasks, activeTaskId: "bulk-249" });

      expect(screen.getByRole("button", { name: /^Bulk chat 249$/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Bulk chat 4$/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Bulk chat 5$/ })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Show 10 more" }));
      expect(screen.getByRole("button", { name: /^Bulk chat 14$/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Bulk chat 15$/ })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      expect(screen.queryByRole("button", { name: /^Bulk chat 14$/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Bulk chat 4$/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Show less" })).not.toBeInTheDocument();
    } finally {
      delete document.documentElement.dataset.motion;
    }
  });

  it("selects a chat nested under a non-active project", () => {
    const { callbacks } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Expand Lotmind AI" }));
    fireEvent.click(screen.getByRole("button", { name: /Mobile intake overnight agent/i }));
    expect(callbacks.onSelectTask).toHaveBeenCalledWith("overnight");
  });

  it("flattens search results across projects with project labels", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search chats" }), {
      target: { value: "overnight" },
    });
    expect(screen.getByRole("dialog", { name: "Search chats" })).toBeInTheDocument();
    const result = screen.getByRole("button", { name: /Mobile intake overnight agent/i });
    expect(within(result).getByText(/Lotmind AI/i)).toBeInTheDocument();
  });

  it("finds chats by persisted message text and shows a bounded snippet", async () => {
    const onSearchMessages = vi.fn().mockResolvedValue([
      {
        taskId: "theme-pass",
        snippet: "…the orchestrated emerald surface should stay semantic…",
      },
    ]);
    setup({ onSearchMessages });
    fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search chats" }), {
      target: { value: "orchestrated emerald" },
    });

    await waitFor(() => expect(onSearchMessages).toHaveBeenCalledWith("orchestrated emerald"));
    const dialog = screen.getByRole("dialog", { name: "Search chats" });
    const result = await within(dialog).findByRole("button", {
      name: /Tune coordinated theme presets/i,
    });
    expect(within(result).getByText(/orchestrated emerald/i)).toBeInTheDocument();
    expect(within(result).getByText(/AI Integrator/i)).toBeInTheDocument();
  });

  it("keeps search compact in the brand row and opens a focused modal", () => {
    setup();
    const sidebar = screen.getByRole("complementary", { name: "Chat navigation" });
    const searchButton = within(sidebar).getByRole("button", { name: "Search chats" });
    const brand = within(sidebar).getByLabelText("AI Integrator");
    expect(brand.closest(".sidebar-brand-row")).toContainElement(searchButton);
    expect(
      within(sidebar).queryByRole("textbox", { name: "Search chats" }),
    ).not.toBeInTheDocument();

    fireEvent.click(searchButton);
    const input = screen.getByRole("textbox", { name: "Search chats" });
    expect(screen.getByRole("dialog", { name: "Search chats" })).toBeInTheDocument();
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Search chats" })).not.toBeInTheDocument();
    expect(searchButton).toHaveFocus();
  });

  it("keeps Settings as a bottom-aligned control", () => {
    setup();
    expect(screen.getByRole("button", { name: "Open Settings" })).toBeInTheDocument();
  });

  it("keeps nested status compact while preserving accessible state labels", () => {
    setup();
    const idle = screen.getByRole("button", { name: /Tune coordinated theme presets/i });
    expect(within(idle).queryByRole("img")).not.toBeInTheDocument();
    expect(idle.textContent).not.toMatch(/Completed/);

    const live = screen.getByRole("button", { name: /Construct the native v1 workspace/i });
    const liveDot = within(live).getByRole("img", { name: "Streaming" });
    expect(liveDot).toHaveClass("chat-dot-transition");
    expect(liveDot.querySelector(".chat-dot--streaming")).toBeInTheDocument();
    expect(live.textContent).not.toMatch(/Running/);

    const waiting = screen.getByRole("button", { name: /Certify Codex and ACP adapters/i });
    expect(within(waiting).getByRole("img", { name: "Needs your input" })).toBeInTheDocument();
    expect(waiting.textContent).not.toMatch(/Waiting for input/);
  });

  it("distinguishes unread replies and failed unread replies without marking idle chats", () => {
    const snapshot = createDemoSnapshot();
    const completed = snapshot.tasks.find((task) => task.id === "theme-pass")!;
    setup({
      tasks: [
        ...snapshot.tasks,
        { ...completed, id: "unread", title: "Unread reply", unread: true },
        {
          ...completed,
          id: "failed-unread",
          title: "Failed unread reply",
          status: "failed",
          unread: true,
        },
      ],
    });

    expect(
      within(screen.getByRole("button", { name: /^Unread replyUnread reply$/ })).getByRole("img", {
        name: "Unread reply",
      }),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("button", {
          name: /^Failed, unreadFailed unread reply$/,
        }),
      ).getByRole("img", { name: "Failed, unread" }),
    ).toBeInTheDocument();
  });

  it("shares the project header's right slot between the chat count and new-chat action", () => {
    const { callbacks } = setup();
    expect(screen.getByLabelText("3 chats")).toHaveTextContent("3");

    fireEvent.click(screen.getByRole("button", { name: "New chat in AI Integrator" }));
    expect(callbacks.onNewTaskInProject).toHaveBeenCalledWith("integrator");
  });

  it("keeps the row overflow action above adjacent chats", () => {
    setup();
    const overflowButtons = screen.getAllByRole("button", { name: "More chat actions" });
    fireEvent.click(overflowButtons[0]);

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(overflowButtons[0].parentElement).toHaveAttribute("data-menu-open", "true");
  });
});
