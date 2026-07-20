// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../demoData";
import { DiffView } from "./DiffView";

afterEach(cleanup);

describe("DiffView", () => {
  const file = createDemoSnapshot().git.files[0];

  it("renders a genuinely side-by-side replacement view", () => {
    const onViewModeChange = vi.fn();
    const { rerender } = render(
      <DiffView file={file} viewMode="unified" onViewModeChange={onViewModeChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Split/i }));
    expect(onViewModeChange).toHaveBeenCalledWith("split");

    rerender(<DiffView file={file} viewMode="split" onViewModeChange={onViewModeChange} />);
    const splitTable = document.querySelector(".diff-table--split");
    expect(splitTable).toBeInTheDocument();
    expect(splitTable?.querySelectorAll(".diff-split-code--delete")).toHaveLength(2);
    expect(splitTable?.querySelectorAll(".diff-split-code--add").length).toBeGreaterThan(0);
  });

  it("exposes hunk markers as sticky row-group headings in unified and split views", () => {
    const onViewModeChange = vi.fn();
    const { rerender } = render(
      <DiffView file={file} viewMode="unified" onViewModeChange={onViewModeChange} />,
    );

    let hunk = document.querySelector(".diff-table--unified .diff-line--hunk > th");
    expect(hunk).toHaveAttribute("scope", "rowgroup");
    expect(hunk).toHaveAttribute("colspan", "4");

    rerender(<DiffView file={file} viewMode="split" onViewModeChange={onViewModeChange} />);
    hunk = document.querySelector(".diff-table--split .diff-line--hunk > th");
    expect(hunk).toHaveAttribute("scope", "rowgroup");
    expect(hunk).toHaveAttribute("colspan", "4");
  });

  it("syntax-highlights every tokenless context and change row in unified and split views", () => {
    const tokenlessFile = {
      ...file,
      path: "src/review.ts",
      additions: 1,
      deletions: 1,
      lines: [
        {
          kind: "context" as const,
          oldNumber: 1,
          newNumber: 1,
          content: 'const current: ReviewState = read("ready");',
        },
        {
          kind: "delete" as const,
          oldNumber: 2,
          content: "const count = 1; // before",
        },
        {
          kind: "add" as const,
          newNumber: 2,
          content: "const count = 2; // after",
        },
      ],
    };
    const { rerender } = render(
      <DiffView file={tokenlessFile} viewMode="unified" onViewModeChange={vi.fn()} />,
    );

    for (const selector of [".diff-line--context", ".diff-line--delete", ".diff-line--add"]) {
      const row = document.querySelector(selector);
      expect(row?.querySelector(".syntax-keyword")).toHaveTextContent("const");
    }
    expect(document.querySelector(".diff-line--context .syntax-type")).toHaveTextContent(
      "ReviewState",
    );
    expect(document.querySelector(".diff-line--context .syntax-function")).toHaveTextContent(
      "read",
    );
    expect(document.querySelector(".diff-line--context .syntax-string")).toHaveTextContent(
      '"ready"',
    );
    expect(document.querySelector(".diff-line--delete .syntax-number")).toHaveTextContent("1");
    expect(document.querySelector(".diff-line--add .syntax-number")).toHaveTextContent("2");
    expect(document.querySelector(".diff-line--add .syntax-comment")).toHaveTextContent("// after");

    rerender(<DiffView file={tokenlessFile} viewMode="split" onViewModeChange={vi.fn()} />);
    const contextCells = document.querySelectorAll(".diff-split-code--context");
    expect(contextCells).toHaveLength(2);
    expect(contextCells[0].querySelector(".syntax-string")).toHaveTextContent('"ready"');
    expect(contextCells[1].querySelector(".syntax-string")).toHaveTextContent('"ready"');
    expect(document.querySelector(".diff-split-code--delete .syntax-comment")).toHaveTextContent(
      "// before",
    );
    expect(document.querySelector(".diff-split-code--add .syntax-comment")).toHaveTextContent(
      "// after",
    );
  });

  it("keeps long source lines intact across wrapped full, split, and task views", () => {
    const longLine = `const compact = "${"long-segment-".repeat(40)}";`;
    const longFile = {
      ...file,
      path: "src/compact.ts",
      additions: 1,
      deletions: 0,
      lines: [{ kind: "add" as const, newNumber: 1, content: longLine }],
    };
    const { rerender } = render(
      <DiffView file={longFile} viewMode="unified" onViewModeChange={vi.fn()} />,
    );

    expect(document.querySelector(".diff-code code")).toHaveTextContent(longLine);
    rerender(<DiffView file={longFile} viewMode="split" onViewModeChange={vi.fn()} />);
    expect(document.querySelector(".diff-split-code--add code")).toHaveTextContent(longLine);
    rerender(<DiffView file={longFile} variant="inline" showReviewActions={false} />);
    expect(document.querySelector(".diff-workspace--inline .diff-code code")).toHaveTextContent(
      longLine,
    );
  });

  it("keeps empty change rows non-collapsing in unified and split views", () => {
    const emptyFile = {
      ...file,
      path: "src/blank.ts",
      additions: 1,
      deletions: 1,
      lines: [
        { kind: "hunk" as const, content: "@@ -1,2 +1,2 @@" },
        { kind: "delete" as const, oldNumber: 1, content: "" },
        { kind: "add" as const, newNumber: 1, content: "" },
        { kind: "context" as const, oldNumber: 2, newNumber: 2, content: "export {};" },
      ],
    };
    const { rerender } = render(
      <DiffView file={emptyFile} viewMode="unified" onViewModeChange={vi.fn()} />,
    );

    expect(document.querySelector(".diff-line--delete .diff-code code")?.textContent).toBe(" ");
    expect(document.querySelector(".diff-line--add .diff-code code")?.textContent).toBe(" ");
    expect(document.querySelectorAll(".diff-line-number")).toHaveLength(6);

    rerender(<DiffView file={emptyFile} viewMode="split" onViewModeChange={vi.fn()} />);
    expect(document.querySelector(".diff-split-code--delete code")?.textContent).toBe(" ");
    expect(document.querySelector(".diff-split-code--add code")?.textContent).toBe(" ");
    expect(document.querySelector(".diff-table--split")).toBeInTheDocument();
  });

  it("renders the inline variant unified-only with just the file name", () => {
    render(
      <DiffView
        file={{ ...file, path: "C:\\repo\\src\\components\\App.tsx" }}
        variant="inline"
        showReviewActions={false}
      />,
    );

    expect(screen.queryByRole("button", { name: /Split/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Unified/i })).not.toBeInTheDocument();
    expect(document.querySelector(".diff-table--unified")).toBeInTheDocument();
    const title = screen.getByTitle("C:\\repo\\src\\components\\App.tsx");
    expect(title).toHaveTextContent(/^App\.tsx$/);
    expect(document.querySelector(".diff-file-title small")).not.toBeInTheDocument();
    expect(document.querySelector(".diff-context-bar")).not.toBeInTheDocument();
    expect(document.querySelector(".diff-footer")).not.toBeInTheDocument();
  });

  it("folds the comparison context into the compact full-view toolbar", () => {
    render(<DiffView file={file} viewMode="unified" onViewModeChange={vi.fn()} />);

    expect(document.querySelector(".diff-context-bar")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Working tree against HEAD")).toBeInTheDocument();
    expect(document.querySelector(".diff-file-path")).toHaveTextContent(file.path);
  });

  it("only exposes persisted review and comment actions when a caller wires them", () => {
    const onMarkReviewed = vi.fn();
    const onAddLineComment = vi.fn();
    render(
      <DiffView
        file={file}
        viewMode="unified"
        onViewModeChange={vi.fn()}
        onMarkReviewed={onMarkReviewed}
        onAddLineComment={onAddLineComment}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    expect(onMarkReviewed).toHaveBeenCalledWith(file);

    fireEvent.click(screen.getAllByRole("button", { name: "Comment on line 43" })[0]);
    expect(onAddLineComment).toHaveBeenCalledWith({ path: file.path, line: 43 });
  });

  it("keeps the compact review toolbar keyboard-semantic and explicitly labeled", () => {
    const onRefresh = vi.fn();
    const onViewModeChange = vi.fn();
    const { rerender } = render(
      <DiffView
        file={file}
        viewMode="unified"
        onViewModeChange={onViewModeChange}
        onRefresh={onRefresh}
        onMarkReviewed={vi.fn()}
      />,
    );

    const layout = screen.getByRole("group", { name: "Diff layout" });
    expect(layout).toContainElement(screen.getByRole("button", { name: "Unified" }));
    expect(screen.getByRole("button", { name: "Unified" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Split" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Refresh diff" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(
      <DiffView
        file={file}
        viewMode="unified"
        onViewModeChange={onViewModeChange}
        onRefresh={onRefresh}
        refreshing
        onMarkReviewed={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Refreshing diff" })).toBeDisabled();
  });

  it("progressively mounts large diffs and keeps an explicit full-content action", () => {
    const largeFile = {
      ...file,
      additions: 1_200,
      deletions: 0,
      lines: Array.from({ length: 1_200 }, (_, index) => ({
        kind: "add" as const,
        newNumber: index + 1,
        content: `large-line-${index}`,
      })),
    };
    render(<DiffView file={largeFile} viewMode="unified" onViewModeChange={vi.fn()} />);

    const table = document.querySelector(".diff-table--unified");
    expect(table).toHaveAttribute("aria-rowcount", "1200");
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(400);
    expect(screen.queryByText("large-line-1199")).not.toBeInTheDocument();
    expect(screen.getByText("Showing 400 of 1,200 diff rows")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show next 400 rows" }));
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(800);
    fireEvent.click(screen.getByRole("button", { name: "Show all 1,200 rows" }));
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(1_200);
    expect(table?.querySelector("tbody tr:last-child code")).toHaveTextContent("large-line-1199");
  });

  it("labels bounded and empty native previews instead of showing a blank canvas", () => {
    const { rerender } = render(
      <DiffView
        file={{ ...file, lines: [], additions: 0, deletions: 0, truncated: true }}
        viewMode="unified"
        onViewModeChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/visible review is partial/i)).toBeInTheDocument();
    expect(screen.getByText(/No text changes are available/i)).toBeInTheDocument();

    rerender(
      <DiffView
        file={{ ...file, diffLoaded: false, lines: [] }}
        viewMode="unified"
        onViewModeChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Loading diff…")).toBeInTheDocument();
  });

  it("offers approve/revert on inline diffs, ordered ahead of the +/− counts", () => {
    const onMarkReviewed = vi.fn();
    const onRevert = vi.fn();
    render(
      <DiffView
        file={file}
        variant="inline"
        showReviewActions={false}
        onMarkReviewed={onMarkReviewed}
        onRevert={onRevert}
      />,
    );

    const actions = document.querySelector(".diff-inline-actions");
    expect(actions).toBeInTheDocument();
    // The pair must sit between the file title and the counts, which is what
    // puts it where the header's flex: 1 title pushes it: hard against +N −M.
    expect(actions?.nextElementSibling).toHaveClass("diff-summary");

    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    expect(onMarkReviewed).toHaveBeenCalledWith(file);

    fireEvent.click(screen.getByRole("button", { name: /Revert/i }));
    expect(onRevert).toHaveBeenCalledWith(file);
  });

  it("reads approved once the file is reviewed", () => {
    render(
      <DiffView
        file={file}
        variant="inline"
        showReviewActions={false}
        reviewed
        onMarkReviewed={vi.fn()}
      />,
    );

    const approve = screen.getByRole("button", { name: /Approved/i });
    expect(approve).toHaveAttribute("aria-pressed", "true");
    expect(approve).toHaveAttribute("data-reviewed", "true");
  });

  it("disables revert until a caller can actually undo the edit", () => {
    render(
      <DiffView file={file} variant="inline" showReviewActions={false} onMarkReviewed={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: /Revert/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Approve/i })).toBeEnabled();
  });

  it("keeps the full variant free of the inline pair", () => {
    render(<DiffView file={file} viewMode="unified" onMarkReviewed={vi.fn()} onRevert={vi.fn()} />);

    expect(document.querySelector(".diff-inline-actions")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mark reviewed/i })).toBeInTheDocument();
  });
});
