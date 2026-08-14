// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LazyMotion, domAnimation } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConnection } from "../bridge";
import { Composer } from "./Composer";

const codex: RuntimeConnection = {
  id: "codex",
  name: "Codex",
  command: "codex app-server",
  status: "connected",
  fidelity: "native",
  models: ["gpt-5.3-codex"],
  detail: "Ready",
};

function renderComposer(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn().mockResolvedValue(true);
  const onStop = vi.fn();
  render(
    <LazyMotion features={domAnimation} strict>
      <Composer
        runtimes={[codex]}
        defaultRuntime="codex"
        defaultModel="gpt-5.3-codex"
        onSend={onSend}
        onStop={onStop}
        {...props}
      />
    </LazyMotion>,
  );
  return {
    onSend,
    onStop,
    textbox: screen.getByRole("textbox", { name: "Task message" }) as HTMLTextAreaElement,
  };
}

beforeEach(() => {
  document.documentElement.dataset.motion = "none";
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.motion;
  vi.restoreAllMocks();
});

describe("Composer stop and send split", () => {
  it("keeps stop in the send position while running with an empty draft", () => {
    const { onStop } = renderComposer({ running: true });
    const stop = screen.getByRole("button", { name: "Stop turn" });
    expect(stop).not.toHaveClass("send-button--stop-stacked");
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("reveals a stacked stop above send once a draft exists mid-run", () => {
    const { onStop, textbox } = renderComposer({ running: true });
    fireEvent.change(textbox, { target: { value: "Queue this follow-up" } });

    const stop = screen.getByRole("button", { name: "Stop the current turn" });
    expect(stop).toHaveClass("send-button--stop-stacked");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("never blocks sending the draft while a turn is running", async () => {
    const { onSend, textbox } = renderComposer({ running: true });
    fireEvent.change(textbox, { target: { value: "Send while running" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "Send while running" }),
      ),
    );
  });

  it("disables both stop variants while a stop is settling", () => {
    const { textbox } = renderComposer({ running: true, stopping: true });
    expect(screen.getByRole("button", { name: "Stopping turn" })).toBeDisabled();

    fireEvent.change(textbox, { target: { value: "draft during stop" } });
    const stackedStop = screen.getByRole("button", { name: "Stopping…" });
    expect(stackedStop).toHaveClass("send-button--stop-stacked");
    expect(stackedStop).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });

  it("shows only the send button when no turn is running", () => {
    renderComposer({ running: false });
    expect(screen.queryByRole("button", { name: "Stop turn" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });

  it("clearing the draft mid-run folds stop back into the send position", async () => {
    const { textbox } = renderComposer({ running: true });
    fireEvent.change(textbox, { target: { value: "temporary" } });
    expect(screen.getByRole("button", { name: "Stop the current turn" })).toHaveClass(
      "send-button--stop-stacked",
    );

    fireEvent.change(textbox, { target: { value: "" } });
    // The stacked stop may spend one exit frame in the tree; settle to exactly
    // one stop occupying the send position.
    await waitFor(() => {
      const stops = screen.getAllByRole("button", { name: "Stop turn" });
      expect(stops).toHaveLength(1);
      expect(stops[0]).not.toHaveClass("send-button--stop-stacked");
    });
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
  });
});
