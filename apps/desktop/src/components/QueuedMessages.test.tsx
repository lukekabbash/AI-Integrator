// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LazyMotion, domAnimation } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueuedMessages, type QueuedMessage } from "./QueuedMessages";

const messages: QueuedMessage[] = [
  { id: "q1", prompt: "Fix the flaky login test" },
  { id: "q2", prompt: "Update the changelog for the release" },
  { id: "q3", prompt: "Refactor the settings page\nwith a second line" },
];

function renderQueue(overrides: Partial<Parameters<typeof QueuedMessages>[0]> = {}) {
  const onSendNow = vi.fn();
  const onReturnToComposer = vi.fn();
  const onDelete = vi.fn();
  const onReorder = vi.fn();
  render(
    <LazyMotion features={domAnimation} strict>
      <QueuedMessages
        messages={messages}
        onSendNow={onSendNow}
        onReturnToComposer={onReturnToComposer}
        onDelete={onDelete}
        onReorder={onReorder}
        {...overrides}
      />
    </LazyMotion>,
  );
  return { onSendNow, onReturnToComposer, onDelete, onReorder };
}

beforeEach(() => {
  document.documentElement.dataset.motion = "none";
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.motion;
  vi.restoreAllMocks();
});

describe("QueuedMessages", () => {
  it("renders one compact row per queued message with an icon-only send action", () => {
    renderQueue();
    const list = screen.getByRole("list", { name: "Queued messages (3)" });
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(list).toContainElement(rows[0]);
    const sendButtons = screen.getAllByRole("button", { name: /^Send now:/ });
    expect(sendButtons).toHaveLength(3);
    // Icon-only: no visible label, an svg glyph, and no native title tooltip.
    expect(sendButtons[0]).not.toHaveTextContent(/\S/);
    expect(sendButtons[0].querySelector("svg")).toBeInTheDocument();
    expect(sendButtons[0]).not.toHaveAttribute("title");
  });

  it("renders nothing for an empty queue", () => {
    const { container } = render(
      <LazyMotion features={domAnimation} strict>
        <QueuedMessages
          messages={[]}
          onSendNow={vi.fn()}
          onReturnToComposer={vi.fn()}
          onDelete={vi.fn()}
          onReorder={vi.fn()}
        />
      </LazyMotion>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("dispatches send-now, return-to-composer, and delete with the message id", () => {
    const { onSendNow, onReturnToComposer, onDelete } = renderQueue();
    fireEvent.click(
      screen.getByRole("button", { name: "Send now: Update the changelog for the release" }),
    );
    expect(onSendNow).toHaveBeenCalledWith("q2");

    fireEvent.click(
      screen.getByRole("button", { name: "Edit in composer: Fix the flaky login test" }),
    );
    expect(onReturnToComposer).toHaveBeenCalledWith("q1");

    fireEvent.click(
      screen.getByRole("button", { name: "Remove from queue: Fix the flaky login test" }),
    );
    expect(onDelete).toHaveBeenCalledWith("q1");
  });

  it("truncates the preview to one line while keeping the full prompt accessible", () => {
    renderQueue();
    const row = screen.getAllByRole("listitem")[2];
    expect(row).toHaveAccessibleName(
      "Queued message 3 of 3: Refactor the settings page\nwith a second line",
    );
    const preview = row.querySelector(".queued-message-text");
    expect(preview).toHaveTextContent("Refactor the settings page");
    expect(preview).not.toHaveTextContent("second line");
    expect(preview).not.toHaveAttribute("title");
  });

  it("reorders with native drag and drop", () => {
    const { onReorder } = renderQueue();
    const rows = screen.getAllByRole("listitem");
    const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };

    fireEvent.dragStart(rows[0], { dataTransfer });
    fireEvent.dragOver(rows[2], { dataTransfer });
    expect(rows[2]).toHaveAttribute("data-drop-target");
    fireEvent.drop(rows[2], { dataTransfer });

    expect(onReorder).toHaveBeenCalledWith(["q2", "q3", "q1"]);
    expect(rows[2]).not.toHaveAttribute("data-drop-target");
  });

  it("moves a message up and down from its keyboard reorder grip", () => {
    const { onReorder } = renderQueue();
    const grip = screen.getByRole("button", {
      name: /^Reorder queued message 2 of 3: Update the changelog/,
    });
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(onReorder).toHaveBeenCalledWith(["q2", "q1", "q3"]);

    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(onReorder).toHaveBeenCalledWith(["q1", "q3", "q2"]);
  });

  it("ignores keyboard moves past either end of the queue", () => {
    const { onReorder } = renderQueue();
    fireEvent.keyDown(screen.getByRole("button", { name: /^Reorder queued message 1 of 3:/ }), {
      key: "ArrowUp",
    });
    fireEvent.keyDown(screen.getByRole("button", { name: /^Reorder queued message 3 of 3:/ }), {
      key: "ArrowDown",
    });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("locks every action while disabled", () => {
    const { onReorder } = renderQueue({ disabled: true });
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("button", { name: /^Reorder queued message 1 of 3:/ }), {
      key: "ArrowDown",
    });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("marks only the busy message as sending and locks its actions", () => {
    renderQueue({ busyId: "q1" });
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveAttribute("data-busy");
    expect(rows[1]).not.toHaveAttribute("data-busy");
    expect(screen.getByRole("status", { name: "Sending" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send now: Fix the flaky login test" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Send now: Update the changelog for the release" }),
    ).toBeEnabled();
  });
});
