// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteProjectModal } from "./DeleteProjectModal";
import type { ProjectSummary } from "../bridge";

afterEach(cleanup);

const project: ProjectSummary = {
  id: "integrator",
  name: "AI Integrator",
  path: "Projects/AI Integrator",
  branch: "main",
  dirtyFiles: 0,
  expanded: true,
};

describe("DeleteProjectModal", () => {
  it("defaults to removing chats and history, not the folder", () => {
    const onConfirm = vi.fn();
    render(
      <DeleteProjectModal
        project={project}
        busy={false}
        error=""
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("radio", { name: /Remove chats/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: /Delete folder from disk/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: /Remove from AI Integrator/i }));
    expect(onConfirm).toHaveBeenCalledWith("history");
  });

  it("switches the confirm action when deleting the folder", () => {
    const onConfirm = vi.fn();
    render(
      <DeleteProjectModal
        project={project}
        busy={false}
        error=""
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /Delete folder from disk/i }));
    expect(screen.getByRole("button", { name: /Delete folder permanently/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Delete folder permanently/i }));
    expect(onConfirm).toHaveBeenCalledWith("disk");
  });
});
