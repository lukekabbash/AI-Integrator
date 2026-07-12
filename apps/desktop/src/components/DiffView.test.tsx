// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../demoData";
import { DiffView } from "./DiffView";

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
});
