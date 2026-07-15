// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../demoData";
import type { ReactNode } from "react";

const travelingRender = vi.hoisted(() => ({ count: 0 }));

vi.mock("./TravelingSelection", () => ({
  TravelingSelection: ({ children }: { children?: ReactNode }) => {
    travelingRender.count += 1;
    return <div data-testid="traveling-selection">{children}</div>;
  },
}));

import { TaskSidebar } from "./TaskSidebar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function stableProps() {
  const snapshot = createDemoSnapshot();
  return {
    projects: snapshot.projects,
    tasks: snapshot.tasks,
    activeProjectId: snapshot.activeProjectId,
    activeTaskId: snapshot.activeTaskId,
    openingProject: false,
    metadataActionsEnabled: true,
    taskActionBusyId: "",
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
    onResize: vi.fn(),
  } satisfies Parameters<typeof TaskSidebar>[0];
}

describe("TaskSidebar memoization", () => {
  beforeEach(() => {
    travelingRender.count = 0;
  });

  it("skips re-render when data and callback identities stay equal", () => {
    const props = stableProps();
    const { rerender } = render(<TaskSidebar {...props} />);
    expect(travelingRender.count).toBe(1);
    expect(screen.getByTestId("traveling-selection")).toBeInTheDocument();

    rerender(<TaskSidebar {...props} />);
    expect(travelingRender.count).toBe(1);

    // Simulate a parent App stream frame that only rebuilt inline lambdas —
    // without stable callback identities, memo would miss and re-render.
    rerender(
      <TaskSidebar
        {...props}
        onSelectTask={(taskId) => props.onSelectTask(taskId)}
        onNewTask={() => props.onNewTask()}
      />,
    );
    expect(travelingRender.count).toBe(2);
  });

  it("re-renders when task lifecycle data changes", () => {
    const props = stableProps();
    const { rerender } = render(<TaskSidebar {...props} />);
    expect(travelingRender.count).toBe(1);

    const [first, ...rest] = props.tasks;
    rerender(
      <TaskSidebar
        {...props}
        tasks={[{ ...first, status: "waiting", updatedAt: "2099-01-01T00:00:00Z" }, ...rest]}
      />,
    );
    expect(travelingRender.count).toBe(2);
  });
});
