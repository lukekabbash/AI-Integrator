// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../demoData";
import { RightRail } from "./RightRail";

function setup() {
  const snapshot = createDemoSnapshot();
  const callbacks = {
    onSelectFile: vi.fn(),
    onStageFile: vi.fn().mockResolvedValue(undefined),
    onCommit: vi.fn().mockResolvedValue(undefined),
    onPush: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
  };
  render(
    <RightRail
      git={snapshot.git}
      children={snapshot.children}
      usage={snapshot.usage}
      activeFile={snapshot.git.files[0]}
      {...callbacks}
    />,
  );
  return { snapshot, callbacks };
}

describe("RightRail", () => {
  it("switches accessible tabs and filters changed files before opening a diff", () => {
    const { snapshot, callbacks } = setup();
    const filesTab = screen.getByRole("tab", { name: "Files" });
    fireEvent.click(filesTab);

    expect(filesTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Files");

    const target = snapshot.git.files[0];
    fireEvent.change(screen.getByRole("textbox", { name: "Filter files" }), {
      target: { value: target.path },
    });
    expect(screen.getByRole("button", { name: new RegExp(target.path) })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /\.[cm]?[jt]sx?/i })).toHaveLength(1);

    fireEvent.click(screen.getByTitle(target.path));
    expect(callbacks.onSelectFile).toHaveBeenCalledWith(target);
  });

  it("commits with Ctrl+Enter and exposes failures instead of reporting fake success", async () => {
    const { callbacks } = setup();
    callbacks.onCommit.mockRejectedValueOnce(new Error("Commit rejected by Git"));

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Commit message" }), {
      key: "Enter",
      ctrlKey: true,
    });

    await waitFor(() => expect(callbacks.onCommit).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent("Commit rejected by Git");
  });

  it("does not present unconnected sidebar actions as buttons", () => {
    setup();
    expect(
      screen.queryByRole("button", { name: /Fetch|Open PR|All branches/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /^Agents/ }));
    expect(
      screen.queryByRole("button", { name: /Delegate|Message agent/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Delegation controls are not connected yet/i)).toBeInTheDocument();
  });

  it("supports arrow-key navigation across rail tabs", () => {
    setup();
    const gitTab = screen.getByRole("tab", { name: /^Git/ });
    gitTab.focus();
    fireEvent.keyDown(gitTab, { key: "ArrowRight" });
    const agentsTab = screen.getByRole("tab", { name: /^Agents/ });
    expect(agentsTab).toHaveFocus();
    expect(agentsTab).toHaveAttribute("aria-selected", "true");
  });

  it("closes overlaid task tools from inside the rail", () => {
    const { callbacks } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Close task tools" }));
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  });
});
