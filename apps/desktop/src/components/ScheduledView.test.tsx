// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge, type Automation } from "../bridge";
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

function renderScheduled(createRequest = 0) {
  function Harness() {
    const [railOpen, setRailOpen] = useState(false);
    return (
      <ScheduledView
        createRequest={createRequest}
        railOpen={railOpen}
        onRailOpenChange={setRailOpen}
        rightRailWidth={356}
        onResizeRail={() => undefined}
        motionScale={0}
        projects={projects}
        tasks={tasks}
        runtimes={runtimes}
        activeTaskId="task-1"
        onOpenTask={() => undefined}
      />
    );
  }
  return render(<Harness />);
}

beforeEach(() => {
  vi.spyOn(bridge, "listAutomations").mockResolvedValue([automation]);
  vi.spyOn(bridge, "listAutomationRuns").mockResolvedValue([]);
  vi.spyOn(bridge, "subscribeAutomationChanges").mockResolvedValue(() => undefined);
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

  it("portals the create dialog above the complete app shell", async () => {
    const { container } = renderScheduled(1);
    const dialog = await screen.findByRole("dialog", { name: "New scheduled task" });

    expect(container).not.toContainElement(dialog);
    expect(dialog.closest(".scheduled-modal-backdrop")?.parentElement).toBe(document.body);
  });
});
