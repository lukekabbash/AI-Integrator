// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridge, type ComposerDraftValue, type RuntimeConnection } from "../bridge";
import { Composer } from "./Composer";

const runtimes: RuntimeConnection[] = [
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    status: "connected",
    fidelity: "native",
    models: ["gpt-5.6-luna"],
    detail: "Ready",
  },
];

const draft: ComposerDraftValue = {
  prompt: "Return to this exact draft",
  attachments: [],
  runtime: "codex",
  model: "gpt-5.6-luna",
  effort: "high",
  permission: "read-only",
  delegation: "manual",
  selectionStart: 7,
  selectionEnd: 7,
};

afterEach(() => vi.restoreAllMocks());

describe("Composer draft lifecycle", () => {
  it("restores a draft on the first rendered frame", () => {
    render(
      <Composer
        runtimes={runtimes}
        defaultRuntime="codex"
        defaultModel="gpt-5.6-luna"
        initialDraft={draft}
        onSend={vi.fn().mockResolvedValue(true)}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Task message" })).toHaveValue(draft.prompt);
  });

  it("does not persist the optimistic clear before a send is accepted", async () => {
    vi.spyOn(bridge, "listModelCatalog").mockResolvedValue([
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    ]);
    let settle: ((accepted: boolean) => void) | undefined;
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    const onDraftChange = vi.fn();
    render(
      <Composer
        runtimes={runtimes}
        defaultRuntime="codex"
        defaultModel="gpt-5.6-luna"
        initialDraft={draft}
        onDraftChange={onDraftChange}
        onDraftSubmit={() => 9}
        onSend={onSend}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(screen.getByRole("textbox", { name: "Task message" })).toHaveValue("");
    await Promise.resolve();
    expect(onDraftChange).not.toHaveBeenCalledWith(expect.objectContaining({ prompt: "" }));

    settle?.(false);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Task message" })).toHaveValue(draft.prompt),
    );
  });

  it("submits once when two send events land in the same render", async () => {
    vi.spyOn(bridge, "listModelCatalog").mockResolvedValue([
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    ]);
    const onSend = vi.fn(() => new Promise<boolean>(() => undefined));
    render(
      <Composer
        runtimes={runtimes}
        defaultRuntime="codex"
        defaultModel="gpt-5.6-luna"
        initialDraft={draft}
        onSend={onSend}
      />,
    );

    const send = screen.getByRole("button", { name: "Send message" });
    act(() => {
      send.click();
      send.click();
    });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  it("does not stop a voice session that was never started", () => {
    const stopVoiceTyping = vi.spyOn(bridge, "stopVoiceTyping").mockResolvedValue(undefined);
    const { unmount } = render(
      <Composer
        runtimes={runtimes}
        defaultRuntime="codex"
        defaultModel="gpt-5.6-luna"
        onSend={vi.fn().mockResolvedValue(true)}
      />,
    );

    unmount();
    expect(stopVoiceTyping).not.toHaveBeenCalled();
  });
});
