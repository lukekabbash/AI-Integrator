// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { domAnimation, LazyMotion } from "motion/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge, type Automation, type TaskSummary } from "../bridge";
import { ScheduledView } from "./ScheduledView";

const automation: Automation = {
  id: "automation-1",
  taskId: "task-1",
  title: "Dependency audit",
  prompt: "Review dependency health.",
  target: { kind: "task" },
  trigger: { kind: "interval", everySeconds: 3600, anchorAt: "2026-07-19T17:00:00.000Z" },
  route: {
    runtime: "codex",
    model: "gpt-5.6-sol",
    effort: "medium",
    fallbacks: [],
    permission: "read-only",
    delegation: "off",
  },
  source: "user",
  recurrenceUserRequest: "Every hour",
  iterationNotes: true,
  nextRunNote: "Verify whether the dependency changed before widening the audit.",
  status: "active",
  nextRunAt: "2026-07-19T17:00:00.000Z",
  createdAt: "2026-07-19T16:00:00.000Z",
  updatedAt: "2026-07-19T16:00:00.000Z",
};

const projects = [
  {
    id: "project-1",
    name: "Integrator",
    path: "/tmp/integrator",
    branch: "main",
    dirtyFiles: 0,
    expanded: true,
  },
];
const tasks = [
  {
    id: "task-1",
    projectId: "project-1",
    title: "Coding session",
    status: "completed" as const,
    runtime: "codex" as const,
    model: "gpt-5.6-sol",
    effort: "medium",
    updatedAt: "2026-07-19T16:00:00.000Z",
  },
];
const runtimes = [
  {
    id: "codex" as const,
    name: "Codex",
    command: "codex",
    status: "connected" as const,
    fidelity: "native" as const,
    models: ["gpt-5.6-sol"],
    detail: "ready",
  },
];

function renderScheduled(
  createRequest = 0,
  onTaskCreated?: (task: TaskSummary) => void,
  options: { motionScale?: number; railToggle?: boolean } = {},
) {
  function Harness() {
    const [railOpen, setRailOpen] = useState(false);
    // The titlebar "New" button only exists while this screen is mounted, so a
    // request always arrives as a change after mount — never as the initial value.
    const [request, setRequest] = useState(0);
    useEffect(() => {
      if (createRequest > 0) setRequest(createRequest);
    }, []);
    return (
      <>
        {options.railToggle ? (
          <button type="button" onClick={() => setRailOpen((open) => !open)}>
            {railOpen ? "Close scheduled rail" : "Open scheduled rail"}
          </button>
        ) : null}
        <ScheduledView
          createRequest={request}
          railOpen={railOpen}
          onRailOpenChange={setRailOpen}
          rightRailWidth={356}
          onResizeRail={() => undefined}
          motionScale={options.motionScale ?? 0}
          projects={projects}
          tasks={tasks}
          runtimes={runtimes}
          activeTaskId="task-1"
          defaultRoute={{ runtime: "codex", model: "gpt-5.6-sol", effort: "medium" }}
          onOpenTask={() => undefined}
          onTaskCreated={onTaskCreated}
        />
      </>
    );
  }
  const view = <Harness />;
  return render(
    options.motionScale ? <LazyMotion features={domAnimation}>{view}</LazyMotion> : view,
  );
}

beforeEach(() => {
  vi.spyOn(bridge, "listAutomations").mockResolvedValue([automation]);
  vi.spyOn(bridge, "listAutomationRuns").mockResolvedValue([]);
  vi.spyOn(bridge, "subscribeAutomationChanges").mockResolvedValue(() => undefined);
  vi.spyOn(bridge, "listIntegratorMcps").mockResolvedValue({
    mcpsRoot: "/tmp/mcps",
    servers: [
      {
        name: "github",
        source: "user",
        origin: "MCPs folder",
        enabled: true,
        transport: "stdio",
      },
      {
        name: "notion",
        source: "user",
        origin: "MCPs folder",
        enabled: false,
        transport: "remote",
      },
    ],
  });
  vi.spyOn(bridge, "listIntegratorSkills").mockResolvedValue({
    skillsRoot: "/tmp/skills",
    pluginsRoot: "/tmp/plugins",
    bundledAvailable: true,
    skills: [
      {
        name: "integrator-authoring:skill-creator",
        description: "Create a skill",
        source: "first-party",
        enabled: true,
        defaultEnabled: true,
        invocationCount: 0,
      },
    ],
  });
  vi.spyOn(bridge, "listModelCatalog").mockResolvedValue([
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: [{ id: "medium", label: "Medium" }] },
  ]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ScheduledView", () => {
  it("loads real schedules and opens setup in the shared rail", async () => {
    renderScheduled();
    fireEvent.click(await screen.findByRole("button", { name: /Dependency audit/ }));
    expect(screen.getByRole("complementary", { name: "Scheduled task" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Primary runtime")).toBeInTheDocument();
  });

  it("keeps the scheduled rail mounted through its reduced-motion close and reopen glide", async () => {
    const { container } = renderScheduled(0, undefined, { motionScale: 0.35, railToggle: true });
    fireEvent.click(await screen.findByRole("button", { name: /Dependency audit/ }));
    await waitFor(
      () => expect(container.querySelector(".panel-slot--right")).toHaveStyle({ width: "356px" }),
      { timeout: 1_500 },
    );

    fireEvent.click(screen.getByRole("button", { name: "Close scheduled rail" }));
    expect(screen.getByRole("complementary", { name: "Scheduled task" })).toBeInTheDocument();
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    expect(screen.getByRole("complementary", { name: "Scheduled task" })).toBeInTheDocument();
    await waitFor(
      () => expect(screen.queryByRole("complementary", { name: "Scheduled task" })).toBeNull(),
      { timeout: 1_500 },
    );

    fireEvent.click(screen.getByRole("button", { name: "Open scheduled rail" }));
    expect(container.querySelector(".panel-slot--right")).toHaveStyle({ width: "0px" });
    await waitFor(
      () => expect(container.querySelector(".panel-slot--right")).toHaveStyle({ width: "356px" }),
      { timeout: 1_500 },
    );
  });

  it("adds and removes a fully specified fallback slot", async () => {
    renderScheduled();
    fireEvent.click(await screen.findByRole("button", { name: /Dependency audit/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add fallback" }));
    expect(screen.getByLabelText("Fallback 1 model")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Fallback 1" }));
    expect(screen.queryByLabelText("Fallback 1 model")).toBeNull();
  });

  it("shows the bounded note carried into the next recurring run", async () => {
    renderScheduled();
    fireEvent.click(await screen.findByRole("button", { name: /Dependency audit/ }));

    expect(screen.getByRole("switch", { name: "Build on previous runs" })).toBeChecked();
    expect(screen.getByText(/Verify whether the dependency changed/)).toBeInTheDocument();
  });

  it("creates through the native automation bridge", async () => {
    const create = vi.spyOn(bridge, "createAutomation").mockResolvedValue(automation);
    renderScheduled(1);
    fireEvent.change(screen.getByPlaceholderText("Check CI again"), {
      target: { value: "Check CI" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Review the latest checks/), {
      target: { value: "Review CI." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ iterationNotes: false })),
    );
  });

  it("enables iterative notes by default for a new repeating task", async () => {
    const create = vi.spyOn(bridge, "createAutomation").mockResolvedValue(automation);
    renderScheduled(1);
    fireEvent.change(screen.getByPlaceholderText("Check CI again"), {
      target: { value: "Check CI" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Review the latest checks/), {
      target: { value: "Review CI." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Repeat" }));
    expect(screen.getByRole("switch", { name: "Build on previous runs" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ iterationNotes: true })),
    );
  });

  it("uses the themed dropdown for every choice control instead of native selects", async () => {
    const update = vi.spyOn(bridge, "updateAutomation").mockResolvedValue(automation);
    const { container } = renderScheduled(1);
    fireEvent.click(await screen.findByRole("button", { name: /Dependency audit/ }));

    // Rail: interval unit is a listbox trigger, not a <select>.
    const unit = screen.getByRole("button", { name: "Repeat interval unit" });
    expect(unit).toHaveAttribute("aria-haspopup", "listbox");
    fireEvent.click(unit);
    fireEvent.click(screen.getByRole("option", { name: "days" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        "automation-1",
        expect.objectContaining({
          trigger: expect.objectContaining({ everySeconds: 86_400 }),
        }),
      ),
    );

    // Create sheet: target chat and repeat unit are dropdowns too.
    fireEvent.click(screen.getByRole("button", { name: "Repeat" }));
    expect(screen.getByRole("button", { name: "Continue in" })).toHaveAttribute(
      "aria-haspopup",
      "listbox",
    );
    expect(screen.getByRole("button", { name: "Repeat unit" })).toHaveAttribute(
      "aria-haspopup",
      "listbox",
    );
    expect(container.querySelector("select")).toBeNull();
    expect(document.querySelector(".scheduled-create-sheet select")).toBeNull();
  });

  it("continues in a fresh project chat and runs with the chosen model", async () => {
    const created: TaskSummary = {
      id: "task-new",
      projectId: "project-1",
      kind: "code",
      title: "Check CI",
      status: "draft",
      runtime: "codex",
      model: "gpt-5.6-sol",
      updatedAt: "2026-07-19T16:00:00.000Z",
    };
    const createChat = vi.spyOn(bridge, "createChat").mockResolvedValue(created);
    const create = vi.spyOn(bridge, "createAutomation").mockResolvedValue(automation);
    const onTaskCreated = vi.fn();
    renderScheduled(1, onTaskCreated);
    fireEvent.change(screen.getByPlaceholderText("Check CI again"), {
      target: { value: "Check CI" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Review the latest checks/), {
      target: { value: "Review CI." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue in" }));
    fireEvent.click(screen.getByRole("option", { name: "New chat in Integrator" }));
    expect(screen.getByText(/A fresh chat is created when you save/)).toBeInTheDocument();

    // The route picker follows the shell default and stays editable.
    expect(screen.getByRole("button", { name: "Run with runtime" })).toHaveAttribute(
      "aria-haspopup",
      "listbox",
    );
    expect(screen.getByRole("button", { name: "Run with model" })).toHaveTextContent("GPT-5.6 Sol");
    fireEvent.click(await screen.findByRole("button", { name: "Run with thinking" }));
    fireEvent.click(screen.getByRole("option", { name: "Medium" }));

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        runtime: "codex",
        model: "gpt-5.6-sol",
        title: "Check CI",
      }),
    );
    expect(onTaskCreated).toHaveBeenCalledWith(created);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-new",
        route: expect.objectContaining({ runtime: "codex", model: "gpt-5.6-sol" }),
      }),
    );
  });

  it("narrows a schedule to named MCP servers and skills, and persists the scope", async () => {
    const update = vi.spyOn(bridge, "updateAutomation").mockResolvedValue(automation);
    renderScheduled();
    fireEvent.click(await screen.findByRole("button", { name: /Dependency audit/ }));

    const tools = await screen.findByRole("button", { name: "Tools" });
    await waitFor(() => expect(tools).toHaveTextContent("All enabled tools · 2"));
    fireEvent.click(tools);
    // Only enabled tools are offered; the disabled notion server is absent.
    expect(screen.getByRole("checkbox", { name: "github" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "notion" })).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Use every enabled tool" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "skill-creator" }));
    expect(tools).toHaveTextContent("1 MCP");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        "automation-1",
        expect.objectContaining({
          route: expect.objectContaining({
            tools: { mcpServers: ["github"], skills: [] },
          }),
        }),
      ),
    );

    // Restricting and then returning to "every enabled tool" drops the scope
    // entirely, so there is nothing to save.
    fireEvent.click(screen.getByRole("switch", { name: "Use every enabled tool" }));
    expect(tools).toHaveTextContent("1 MCP · 1 skill");
    fireEvent.click(screen.getByRole("switch", { name: "Use every enabled tool" }));
    expect(tools).toHaveTextContent("All enabled tools · 2");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("does not reopen the create sheet when the screen remounts with a stale request", async () => {
    // First mount with an already-consumed counter (user opened New earlier,
    // closed it, navigated away, and came back).
    const { unmount } = renderScheduled(1);
    expect(screen.getByRole("dialog", { name: "New scheduled task" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New scheduled task" })).toBeNull(),
    );
    unmount();

    // Coming back to the screen: the shell still holds the consumed counter.
    render(
      <ScheduledView
        createRequest={1}
        railOpen={false}
        onRailOpenChange={() => undefined}
        rightRailWidth={356}
        onResizeRail={() => undefined}
        motionScale={0}
        projects={projects}
        tasks={tasks}
        runtimes={runtimes}
        onOpenTask={() => undefined}
      />,
    );
    await screen.findByRole("button", { name: /Dependency audit/ });
    expect(screen.queryByRole("dialog", { name: "New scheduled task" })).toBeNull();
  });

  it("portals the create dialog above the complete app shell", async () => {
    const { container } = renderScheduled(1);
    const dialog = await screen.findByRole("dialog", { name: "New scheduled task" });

    expect(container).not.toContainElement(dialog);
    expect(dialog.closest(".scheduled-modal-backdrop")?.parentElement).toBe(document.body);
  });
});
