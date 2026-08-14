// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../demoData";
import { TaskSidebar } from "./TaskSidebar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(overrides?: Partial<Parameters<typeof TaskSidebar>[0]>) {
  const snapshot = createDemoSnapshot();
  const callbacks = {
    onSelectProject: vi.fn(),
    onSelectTask: vi.fn(),
    onNewTask: vi.fn(),
    onNewTaskInProject: vi.fn(),
    onOpenProject: vi.fn(),
    onUpdateTask: vi.fn(),
    onCopyTask: vi.fn(),
    onUpdateProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onDeleteTask: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenScheduled: vi.fn(),
    onOpenCapabilities: vi.fn(),
    onOpenSubagents: vi.fn(),
    onResize: vi.fn(),
    ...pickFnOverrides(overrides),
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

function pickFnOverrides(overrides?: Partial<Parameters<typeof TaskSidebar>[0]>) {
  if (!overrides) return {};
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "function") next[key] = value;
  }
  return next;
}

describe("TaskSidebar", () => {
  it("keeps core agent surfaces in the permanent navigation rail", () => {
    const { callbacks } = setup({ activeDestination: "scheduled" });

    const scheduled = screen.getByRole("button", { name: "Scheduled" });
    expect(scheduled).toHaveAttribute("data-active", "true");
    fireEvent.click(scheduled);
    fireEvent.click(screen.getByRole("button", { name: "Skills & plugins" }));
    fireEvent.click(screen.getByRole("button", { name: "Subagents" }));

    expect(callbacks.onOpenScheduled).toHaveBeenCalledOnce();
    expect(callbacks.onOpenCapabilities).toHaveBeenCalledOnce();
    expect(callbacks.onOpenSubagents).toHaveBeenCalledOnce();
    expect(document.querySelector(".new-task-button")).toBeVisible();
  });

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
    const { snapshot } = setup();
    const lotmind = snapshot.projects.find((project) => project.id === "lotmind")!;
    fireEvent.click(screen.getByRole("button", { name: `Expand ${lotmind.name}` }));
    expect(screen.getByRole("button", { name: `Collapse ${lotmind.name}` })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Mobile intake overnight agent/i }),
    ).toBeInTheDocument();
  });

  it("toggles expand and collapse from the project name", () => {
    const { snapshot, callbacks } = setup();
    const lotmind = snapshot.projects.find((project) => project.id === "lotmind")!;
    const name = screen.getByRole("button", { name: lotmind.name });

    // Inactive → select (and auto-expand).
    fireEvent.click(name);
    expect(callbacks.onSelectProject).toHaveBeenCalledWith("lotmind");
  });

  it("collapses the active project from its name without requiring the chevron", () => {
    const { snapshot } = setup();
    const active = snapshot.projects.find((project) => project.id === snapshot.activeProjectId)!;
    const name = screen.getByRole("button", { name: active.name });
    expect(name).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(name);
    expect(screen.getByRole("button", { name: `Expand ${active.name}` })).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(name);
    expect(screen.getByRole("button", { name: `Collapse ${active.name}` })).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the traveling selection target after collapsing and re-expanding the active project", async () => {
    document.documentElement.dataset.motion = "none";
    try {
      const { snapshot } = setup();
      const active = snapshot.projects.find((project) => project.id === snapshot.activeProjectId)!;
      const activeChat = snapshot.tasks.find((task) => task.id === snapshot.activeTaskId)!;

      fireEvent.click(screen.getByRole("button", { name: `Collapse ${active.name}` }));
      expect(screen.getByRole("button", { name: `Expand ${active.name}` })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: `Expand ${active.name}` }));
      await waitFor(() => {
        expect(
          document.querySelector(`[data-traveling-selection="${activeChat.id}"]`),
        ).toBeInTheDocument();
      });
      expect(
        screen
          .getByRole("button", { name: new RegExp(activeChat.title) })
          .closest(".chat-row-shell"),
      ).toHaveAttribute("data-traveling-selection", activeChat.id);
    } finally {
      delete document.documentElement.dataset.motion;
    }
  });

  it("opens and closes the project clip without a stuck height under reduced motion", () => {
    document.documentElement.dataset.motion = "none";
    try {
      const { snapshot } = setup();
      const active = snapshot.projects.find((project) => project.id === snapshot.activeProjectId)!;
      const activeProjectGroup = screen
        .getByRole("button", { name: active.name })
        .closest(".project-group");

      const openClip = activeProjectGroup?.querySelector(".project-chat-list-clip");
      expect(openClip).toHaveAttribute("data-open", "true");
      expect(openClip?.querySelector(".project-chat-list")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: `Collapse ${active.name}` }));
      expect(activeProjectGroup?.querySelector(".project-chat-list-clip")).toBeNull();
      expect(
        screen.queryByRole("button", { name: new RegExp(snapshot.tasks[0].title) }),
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: `Expand ${active.name}` }));
      const reopened = activeProjectGroup?.querySelector(".project-chat-list-clip");
      expect(reopened).toHaveAttribute("data-open", "true");
      expect(
        screen.getByRole("button", { name: new RegExp(snapshot.tasks[0].title) }),
      ).toBeInTheDocument();
    } finally {
      delete document.documentElement.dataset.motion;
    }
  });

  it("keeps the original section-heading hierarchy while both collections collapse", () => {
    document.documentElement.dataset.motion = "none";
    const snapshot = createDemoSnapshot();
    const generalChat = {
      ...snapshot.tasks[0],
      id: "general-chat",
      projectId: "__integrator_chats__",
      kind: "chat" as const,
      title: "Research notes",
    };
    setup({ tasks: [...snapshot.tasks, generalChat] });

    const projectsDisclosure = screen.getByRole("button", { name: "Collapse Projects" });
    const chatsDisclosure = screen.getByRole("button", { name: "Collapse Chats" });
    expect(projectsDisclosure).toHaveClass("rail-section-disclosure");
    expect(chatsDisclosure).toHaveClass("rail-section-disclosure");
    expect(projectsDisclosure.closest(".rail-section-heading")).toBeInTheDocument();
    expect(chatsDisclosure.closest(".rail-section-heading")).toHaveClass(
      "rail-section-heading--later",
    );
    expect(projectsDisclosure.querySelector(".disclosure--open")).toBeTruthy();
    expect(chatsDisclosure.querySelector(".disclosure--open")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: `Collapse ${snapshot.projects[0].name}` }),
    ).toHaveClass("project-disclosure");
    expect(screen.getByRole("button", { name: "Open another project" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a new chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Research notes/ })).toBeInTheDocument();

    fireEvent.click(chatsDisclosure);
    expect(screen.getByRole("button", { name: "Expand Chats" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Research notes/ })).not.toBeInTheDocument();

    fireEvent.click(projectsDisclosure);
    expect(screen.getByRole("button", { name: "Expand Projects" })).toBeInTheDocument();
    delete document.documentElement.dataset.motion;
  });

  it("paints the closed frame before animating a collection open", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const snapshot = createDemoSnapshot();
    setup({
      tasks: [
        ...snapshot.tasks,
        {
          ...snapshot.tasks[0],
          id: "general-chat",
          projectId: "__integrator_chats__",
          kind: "chat",
          title: "Research notes",
        },
      ],
    });
    const chatCollection = screen.getByRole("region", { name: "Chat collection" });

    fireEvent.click(screen.getByRole("button", { name: "Collapse Chats" }));
    const closingClip = chatCollection.querySelector(".project-chat-list-clip");
    expect(closingClip).toHaveAttribute("data-open", "false");
    fireEvent.transitionEnd(closingClip as Element, { propertyName: "grid-template-rows" });

    fireEvent.click(screen.getByRole("button", { name: "Expand Chats" }));
    const openingClip = chatCollection.querySelector(".project-chat-list-clip");
    expect(openingClip).toHaveAttribute("data-open", "false");
    expect(frames).toHaveLength(1);

    act(() => frames.shift()?.(0));
    expect(openingClip).toHaveAttribute("data-open", "false");
    expect(frames).toHaveLength(1);

    act(() => frames.shift()?.(16));
    expect(openingClip).toHaveAttribute("data-open", "true");
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

  it("surfaces archived chats from live projects and whole archived projects", () => {
    document.documentElement.dataset.motion = "none";
    try {
      const snapshot = createDemoSnapshot();
      const projects = snapshot.projects.map((project) =>
        project.id === "lotmind" ? { ...project, archived: true } : project,
      );
      const tasks = snapshot.tasks.map((task) =>
        task.id === "theme-pass" ? { ...task, archived: true } : task,
      );
      setup({ projects, tasks });

      const toggle = screen.getByRole("button", { name: /^Archived/ });
      expect(within(toggle).getByText("2")).toBeInTheDocument();
      fireEvent.click(toggle);

      // A live project holding an archived chat appears with only that chat.
      expect(
        screen.getByRole("button", { name: /Tune coordinated theme presets/ }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Construct the native v1 workspace/ }),
      ).not.toBeInTheDocument();

      // An archived project brings all of its chats, expanded by default,
      // and wears an Archived badge.
      expect(
        screen.getByRole("button", { name: /Mobile intake overnight agent/ }),
      ).toBeInTheDocument();
      expect(document.querySelector(".project-archived-badge")).toHaveAccessibleName(
        "Archived project",
      );

      // Fully live projects stay out of the archive.
      expect(screen.queryByRole("button", { name: "EVE OS" })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /Back to chats/ }));
      expect(screen.getByRole("button", { name: "EVE OS" })).toBeInTheDocument();
    } finally {
      delete document.documentElement.dataset.motion;
    }
  });

  it("scopes archive-view deletion to archived chats for live projects", () => {
    document.documentElement.dataset.motion = "none";
    try {
      const snapshot = createDemoSnapshot();
      const projects = snapshot.projects.map((project) =>
        project.id === "lotmind" ? { ...project, archived: true } : project,
      );
      const tasks = snapshot.tasks.map((task) =>
        task.id === "theme-pass" ? { ...task, archived: true } : task,
      );
      const onDeleteArchivedChats = vi.fn();
      const onDeleteProject = vi.fn();
      setup({ projects, tasks, onDeleteArchivedChats, onDeleteProject });
      fireEvent.click(screen.getByRole("button", { name: /^Archived/ }));

      // A live project holding archived chats deletes just those chats.
      fireEvent.click(screen.getByRole("button", { name: "More actions for AI Integrator" }));
      fireEvent.click(screen.getByRole("menuitem", { name: /Delete archived chats/ }));
      expect(onDeleteArchivedChats).toHaveBeenCalledWith("integrator");
      expect(onDeleteProject).not.toHaveBeenCalled();

      // A fully archived project keeps the full project-delete flow.
      fireEvent.click(screen.getByRole("button", { name: "More actions for Lotmind AI" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
      expect(onDeleteProject).toHaveBeenCalledWith("lotmind");
    } finally {
      delete document.documentElement.dataset.motion;
    }
  });

  it("shows an empty state when nothing is archived", () => {
    document.documentElement.dataset.motion = "none";
    try {
      setup();
      fireEvent.click(screen.getByRole("button", { name: "Archived" }));
      expect(screen.getByText("Nothing archived")).toBeInTheDocument();
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

    await waitFor(() =>
      expect(onSearchMessages).toHaveBeenCalledWith("orchestrated emerald", {
        includeArchived: false,
      }),
    );
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
    const brand = within(sidebar).getByLabelText("AI Integrator", {
      selector: ".brand-lockup",
    });
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
    expect(screen.getByRole("menu")).toHaveAttribute("data-direction", "right");
    expect(overflowButtons[0].parentElement).toHaveAttribute("data-menu-open", "true");
  });

  it("opens the chat overflow menu from a right-click and reveals the folder", () => {
    document.documentElement.dataset.motion = "none";
    try {
      const onRevealTask = vi.fn();
      const snapshot = createDemoSnapshot();
      const task = snapshot.tasks.find((entry) => entry.id === snapshot.activeTaskId)!;
      setup({ onRevealTask, tasks: [task], activeTaskId: task.id });
      fireEvent.contextMenu(screen.getByRole("button", { name: new RegExp(task.title) }));
      const menu = screen.getByRole("menu");
      fireEvent.click(within(menu).getByRole("menuitem", { name: /Reveal in File Explorer/i }));
      expect(onRevealTask).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));
    } finally {
      delete document.documentElement.dataset.motion;
    }
  });

  it("resolves a general chat folder when copy path has no project pairing", async () => {
    document.documentElement.dataset.motion = "none";
    try {
      const onResolveTaskFolder = vi
        .fn()
        .mockResolvedValue("C:\\Users\\me\\chat-runtime\\general-chat");
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      const snapshot = createDemoSnapshot();
      const generalChat = {
        ...snapshot.tasks[0],
        id: "general-chat",
        projectId: "__integrator_chats__",
        kind: "chat" as const,
        title: "Research notes",
        worktree: undefined,
      };
      setup({
        onResolveTaskFolder,
        tasks: [generalChat],
        activeTaskId: generalChat.id,
        activeProjectId: undefined,
        projects: [],
      });
      fireEvent.contextMenu(screen.getByRole("button", { name: /Research notes/ }));
      fireEvent.click(screen.getByRole("menuitem", { name: /Copy absolute path/i }));
      expect(onResolveTaskFolder).toHaveBeenCalledWith(
        expect.objectContaining({ id: generalChat.id }),
      );
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("C:\\Users\\me\\chat-runtime\\general-chat");
      });
    } finally {
      delete document.documentElement.dataset.motion;
    }
  });

  it("opens the project overflow menu from a right-click with reveal and copy path", () => {
    document.documentElement.dataset.motion = "none";
    try {
      const onRevealProject = vi.fn();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      const { snapshot } = setup({ onRevealProject });
      const active = snapshot.projects.find((project) => project.id === snapshot.activeProjectId)!;
      fireEvent.contextMenu(screen.getByRole("button", { name: active.name }));
      const menu = screen.getByRole("menu");
      fireEvent.click(within(menu).getByRole("menuitem", { name: /Copy absolute path/i }));
      expect(writeText).toHaveBeenCalledWith(active.path);
      fireEvent.contextMenu(screen.getByRole("button", { name: active.name }));
      fireEvent.click(screen.getByRole("menuitem", { name: /Copy relative path/i }));
      expect(writeText).toHaveBeenCalledWith(
        active.path
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .filter(Boolean)
          .at(-1),
      );
      fireEvent.contextMenu(screen.getByRole("button", { name: active.name }));
      fireEvent.click(screen.getByRole("menuitem", { name: /Reveal in File Explorer/i }));
      expect(onRevealProject).toHaveBeenCalledWith(expect.objectContaining({ id: active.id }));
    } finally {
      delete document.documentElement.dataset.motion;
    }
  });

  it("anchors the overflow menu left when that direction is selected", () => {
    setup({ sidebarMenuDirection: "left" });
    const overflowButtons = screen.getAllByRole("button", { name: "More chat actions" });
    const trigger = overflowButtons[0];
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      top: 120,
      bottom: 144,
      left: 220,
      right: 244,
      width: 24,
      height: 24,
      x: 220,
      y: 120,
      toJSON: () => ({}),
    });

    fireEvent.click(trigger);

    const menu = screen.getByRole("menu");
    expect(menu).toHaveAttribute("data-direction", "left");
    // Menu width 200 → left edge at trigger.right - 3 - 200.
    expect(menu).toHaveStyle({ left: "41px" });
  });

  it("opens the chat overflow menu upward when space below is tight", () => {
    setup();
    const overflowButtons = screen.getAllByRole("button", { name: "More chat actions" });
    const trigger = overflowButtons[overflowButtons.length - 1];
    const scroll = trigger.closest(".sidebar-scroll") as HTMLElement;

    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 400,
      left: 0,
      right: 272,
      width: 272,
      height: 300,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      top: 360,
      bottom: 384,
      left: 220,
      right: 244,
      width: 24,
      height: 24,
      x: 220,
      y: 360,
      toJSON: () => ({}),
    });

    fireEvent.click(trigger);

    expect(screen.getByRole("menu")).toHaveClass("chat-action-menu--up");
  });

  it("copies a chat from the overflow menu and closes it", () => {
    const snapshot = createDemoSnapshot();
    const task = { ...snapshot.tasks[0], status: "completed" as const };
    const { callbacks } = setup({ tasks: [task], activeTaskId: task.id });
    fireEvent.click(screen.getByRole("button", { name: "More chat actions" }));

    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /^Copy$/ }));

    expect(callbacks.onCopyTask).toHaveBeenCalledWith(task.id);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("copies settled history from a chat that is still running", () => {
    const snapshot = createDemoSnapshot();
    const task = { ...snapshot.tasks[0], status: "running" as const };
    const { callbacks } = setup({ tasks: [task], activeTaskId: task.id });
    fireEvent.click(screen.getByRole("button", { name: "More chat actions" }));

    const copy = within(screen.getByRole("menu")).getByRole("menuitem", { name: /^Copy$/ });
    expect(copy).toBeEnabled();
    fireEvent.click(copy);
    expect(callbacks.onCopyTask).toHaveBeenCalledWith(task.id);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the rename field when a chat name is double-clicked", () => {
    const snapshot = createDemoSnapshot();
    const task = snapshot.tasks[0];
    const { callbacks } = setup({ tasks: [task], activeTaskId: task.id });

    fireEvent.doubleClick(screen.getByRole("button", { name: new RegExp(task.title) }));

    const input = screen.getByRole("textbox", { name: "Chat name" });
    expect(input).toHaveValue(task.title);
    fireEvent.change(input, { target: { value: "Renamed via double click" } });
    fireEvent.submit(input.closest("form")!);
    expect(callbacks.onUpdateTask).toHaveBeenCalledWith(task.id, {
      title: "Renamed via double click",
    });
  });

  it("ignores double-click renaming while metadata actions are unavailable", () => {
    const snapshot = createDemoSnapshot();
    const task = snapshot.tasks[0];
    setup({ tasks: [task], activeTaskId: task.id, metadataActionsEnabled: false });

    fireEvent.doubleClick(screen.getByRole("button", { name: new RegExp(task.title) }));

    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull();
  });

  it("clips a fork's name rather than the marker that identifies it", () => {
    const snapshot = createDemoSnapshot();
    const task = { ...snapshot.tasks[0], title: "Port the parser: Branch 2" };
    setup({ tasks: [task], activeTaskId: task.id });

    // Separate boxes, so the row's ellipsis trims the name and leaves the
    // marker whole. One text node would lose the marker first.
    expect(screen.getByText("Port the parser", { selector: ".chat-row-title-name" })).toBeVisible();
    expect(screen.getByText(": Branch 2", { selector: ".chat-row-title-suffix" })).toBeVisible();
    // The full title still reaches the tooltip and the rename field.
    expect(screen.getByRole("button", { name: /Port the parser: Branch 2/ })).toBeVisible();
  });

  it("leaves an ordinary chat title as a single node", () => {
    const snapshot = createDemoSnapshot();
    const task = { ...snapshot.tasks[0], title: "Port the parser" };
    setup({ tasks: [task], activeTaskId: task.id });

    expect(screen.getByText("Port the parser", { selector: ".chat-row-title" })).toBeVisible();
    expect(document.querySelector(".chat-row-title-suffix")).toBeNull();
  });

  it("lifts the project that owns an open chat menu above sibling projects", () => {
    const { snapshot } = setup();
    const active = snapshot.projects.find((project) => project.id === snapshot.activeProjectId)!;
    const other = snapshot.projects.find((project) => project.id !== active.id)!;
    fireEvent.click(screen.getByRole("button", { name: `Expand ${other.name}` }));

    const activeGroup = screen
      .getByRole("button", { name: `Collapse ${active.name}` })
      .closest(".project-group");
    const otherGroup = screen
      .getByRole("button", { name: `Collapse ${other.name}` })
      .closest(".project-group");
    expect(activeGroup).toBeTruthy();
    expect(otherGroup).toBeTruthy();

    const overflowInActive = within(activeGroup as HTMLElement).getAllByRole("button", {
      name: "More chat actions",
    })[0];
    fireEvent.click(overflowInActive);

    expect(activeGroup).toHaveAttribute("data-menu-open", "true");
    expect(activeGroup).not.toHaveAttribute("data-project-menu-open");
    expect(otherGroup).not.toHaveAttribute("data-menu-open");
    // The menu itself portals to document.body (the sidebar clips overflow),
    // so it's no longer a DOM descendant of the row it opened from.
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("marks project-menu-open only for the project overflow menu", () => {
    const { snapshot } = setup();
    const active = snapshot.projects.find((project) => project.id === snapshot.activeProjectId)!;
    const group = screen
      .getByRole("button", { name: `Collapse ${active.name}` })
      .closest(".project-group") as HTMLElement;

    fireEvent.click(within(group).getByRole("button", { name: `More actions for ${active.name}` }));

    expect(group).toHaveAttribute("data-menu-open", "true");
    expect(group).toHaveAttribute("data-project-menu-open", "true");
  });

  it("opens a project menu with pin, archive, and delete to the left of new chat", () => {
    const { snapshot, callbacks } = setup();
    const active = snapshot.projects.find((project) => project.id === snapshot.activeProjectId)!;
    const group = screen
      .getByRole("button", { name: `Collapse ${active.name}` })
      .closest(".project-group") as HTMLElement;

    const more = within(group).getByRole("button", {
      name: `More actions for ${active.name}`,
    });
    const newChat = within(group).getByRole("button", {
      name: `New chat in ${active.name}`,
    });
    expect(more.compareDocumentPosition(newChat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(more);
    // Portaled to document.body, so query from screen rather than within(group).
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Pin/i })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Archive/i })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Delete/i }));
    expect(callbacks.onDeleteProject).toHaveBeenCalledWith(active.id);
  });

  it("pins a project from the project overflow menu", () => {
    const { snapshot, callbacks } = setup();
    const active = snapshot.projects.find((project) => project.id === snapshot.activeProjectId)!;
    const group = screen
      .getByRole("button", { name: `Collapse ${active.name}` })
      .closest(".project-group") as HTMLElement;

    fireEvent.click(within(group).getByRole("button", { name: `More actions for ${active.name}` }));
    // Portaled to document.body, so query from screen rather than within(group).
    fireEvent.click(screen.getByRole("menuitem", { name: /^Pin$/i }));
    expect(callbacks.onUpdateProject).toHaveBeenCalledWith(active.id, { pinned: true });
  });

  it("unpins a project when its pin glyph is clicked", () => {
    const snapshot = createDemoSnapshot();
    const active = snapshot.projects.find((project) => project.id === snapshot.activeProjectId)!;
    const { callbacks } = setup({
      projects: snapshot.projects.map((project) =>
        project.id === active.id ? { ...project, pinned: true } : project,
      ),
    });

    fireEvent.click(screen.getByRole("button", { name: "Unpin project" }));
    expect(callbacks.onUpdateProject).toHaveBeenCalledWith(active.id, { pinned: false });
  });

  it("unpins a chat when its pin glyph is clicked", () => {
    const snapshot = createDemoSnapshot();
    const pinned = {
      ...snapshot.tasks[0],
      pinned: true,
    };
    const { callbacks } = setup({
      tasks: [pinned, ...snapshot.tasks.slice(1)],
      activeTaskId: pinned.id,
    });

    fireEvent.click(screen.getByRole("button", { name: "Unpin chat" }));
    expect(callbacks.onUpdateTask).toHaveBeenCalledWith(pinned.id, { pinned: false });
  });

  it("offers delete from the chat overflow menu", () => {
    const { snapshot, callbacks } = setup();
    const active = snapshot.tasks.find((task) => task.id === snapshot.activeTaskId)!;
    const row = screen
      .getByRole("button", { name: new RegExp(active.title) })
      .closest(".chat-row-shell") as HTMLElement;

    fireEvent.click(within(row).getByRole("button", { name: "More chat actions" }));
    // Portaled to document.body, so query from screen rather than within(row).
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/i }));
    expect(callbacks.onDeleteTask).toHaveBeenCalledWith(active.id);
  });
});
