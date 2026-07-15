// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteChatModal } from "./DeleteChatModal";
import type { TaskSummary } from "../bridge";

afterEach(cleanup);

const task: TaskSummary = {
  id: "chat-1",
  projectId: "integrator",
  title: "Construct the native v1 workspace",
  status: "completed",
  runtime: "codex",
  model: "gpt-5",
  updatedAt: "2026-07-12T12:00:00.000Z",
  pinned: false,
  archived: false,
};

describe("DeleteChatModal", () => {
  it("confirms wiping the chat without offering a folder delete option", () => {
    const onConfirm = vi.fn();
    render(
      <DeleteChatModal task={task} busy={false} error="" onClose={vi.fn()} onConfirm={onConfirm} />,
    );

    expect(screen.getByRole("heading", { name: "Delete chat" })).toBeInTheDocument();
    expect(screen.getByText(task.title)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByText(/project folder and code stay on disk/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
