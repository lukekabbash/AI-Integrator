// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffFile, TranscriptEvent } from "../bridge";
import type { DiffSelectionPayload } from "./DiffView";

const diffRender = vi.hoisted(() => ({ count: 0 }));

vi.mock("./DiffView", () => ({
  DiffView: ({
    file,
    onAddSelection,
  }: {
    file: DiffFile;
    onAddSelection?: (payload: DiffSelectionPayload) => void;
  }) => {
    diffRender.count += 1;
    return (
      <button
        type="button"
        data-testid={`mock-diff-${file.path}`}
        onClick={() =>
          onAddSelection?.({
            path: file.path,
            text: `selected ${file.path}`,
            startLine: 1,
            endLine: 1,
            intent: "add",
          })
        }
      >
        {file.path} · {file.additions} added
      </button>
    );
  },
}));

import { Transcript } from "./Transcript";

function diffActivity(id: string, path: string): TranscriptEvent {
  return {
    id,
    kind: "tool",
    activityType: "file",
    title: "Edited",
    body: path,
    timestamp: "2026-07-11T12:00:00.000Z",
    status: "success",
    expandedByDefault: true,
    filePath: path,
    diff: {
      path,
      status: "modified",
      additions: 1,
      deletions: 1,
      staged: false,
      lines: [
        { kind: "hunk", content: "@@ -1 +1 @@" },
        { kind: "delete", oldNumber: 1, content: "old" },
        { kind: "add", newNumber: 1, content: "new" },
      ],
    },
  };
}

describe("Transcript activity memoization", () => {
  beforeEach(() => {
    diffRender.count = 0;
  });

  it("keeps a stable activity row mounted while unrelated transcript content changes", () => {
    const activity = diffActivity("file-a", "src/a.ts");
    const firstSelection = vi.fn();
    const latestSelection = vi.fn();
    const { rerender } = render(
      <Transcript events={[activity]} onAddDiffSelection={firstSelection} />,
    );

    expect(diffRender.count).toBe(1);
    rerender(
      <Transcript
        events={[
          activity,
          {
            id: "assistant-live",
            kind: "assistant",
            body: "An unrelated streamed update",
            timestamp: "2026-07-11T12:00:01.000Z",
          },
        ]}
        onAddDiffSelection={latestSelection}
      />,
    );

    expect(diffRender.count).toBe(1);
    fireEvent.click(screen.getByTestId("mock-diff-src/a.ts"));
    expect(firstSelection).not.toHaveBeenCalled();
    expect(latestSelection).toHaveBeenCalledWith({
      path: "src/a.ts",
      text: "selected src/a.ts",
      startLine: 1,
      endLine: 1,
      intent: "add",
    });

    const changedActivity = {
      ...activity,
      title: "Updated",
      status: "warning" as const,
      diff: { ...activity.diff!, additions: 2 },
    };
    rerender(<Transcript events={[changedActivity]} onAddDiffSelection={latestSelection} />);
    expect(diffRender.count).toBe(2);
    expect(screen.getByText("Updated")).toBeInTheDocument();
    expect(screen.getByTestId("mock-diff-src/a.ts")).toHaveTextContent("2 added");
    expect(document.querySelector(".activity-event")).toHaveAttribute("data-status", "warning");
  });

  it("memoizes recursively mounted stable children when a group gains another child", () => {
    const firstChild = diffActivity("file-a", "src/a.ts");
    const secondChild = diffActivity("file-b", "src/b.ts");
    const group: TranscriptEvent = {
      id: "activity-group",
      kind: "activity",
      title: "Activity",
      body: "1 file change",
      timestamp: "2026-07-11T12:00:00.000Z",
      status: "success",
      expandedByDefault: true,
      children: [firstChild],
    };
    const { rerender } = render(<Transcript events={[group]} />);

    expect(diffRender.count).toBe(1);
    rerender(
      <Transcript
        events={[
          {
            ...group,
            body: "2 file changes",
            children: [firstChild, secondChild],
          },
        ]}
      />,
    );

    expect(diffRender.count).toBe(2);
    expect(screen.getByTestId("mock-diff-src/a.ts")).toBeInTheDocument();
    expect(screen.getByTestId("mock-diff-src/b.ts")).toBeInTheDocument();
  });

  it("uses the latest file callback without rerendering a stable row", () => {
    const activity = diffActivity("file-a", "src/a.ts");
    const firstOpen = vi.fn();
    const latestOpen = vi.fn();
    const { rerender } = render(<Transcript events={[activity]} onOpenFile={firstOpen} />);

    rerender(<Transcript events={[activity]} onOpenFile={latestOpen} />);
    expect(diffRender.count).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Open src/a.ts in Files" }));
    expect(firstOpen).not.toHaveBeenCalled();
    expect(latestOpen).toHaveBeenCalledWith("src/a.ts");
  });
});
