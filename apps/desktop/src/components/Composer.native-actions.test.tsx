// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LazyMotion, domAnimation } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge, type RuntimeConnection } from "../bridge";
import { Composer } from "./Composer";

const codex: RuntimeConnection = {
  id: "codex",
  name: "Codex",
  command: "codex app-server",
  status: "connected",
  fidelity: "native",
  models: ["Provider default"],
  detail: "Ready",
};
const repository = String.raw`H:\Code\integrator-3`;

beforeEach(() => {
  document.documentElement.dataset.motion = "none";
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.motion;
  vi.restoreAllMocks();
});

describe("Composer provider-native actions", () => {
  it("prefetches and retains the provider catalog while sending the opaque selection", async () => {
    const listActions = vi.spyOn(bridge, "listNativeProviderActions").mockResolvedValue([
      {
        id: "opaque-skill-1",
        name: "skill-creator",
        description: "Create a Codex skill",
        source: "system",
        kind: "skill",
        invocation: "direct",
      },
      {
        id: "opaque-goal-1",
        name: "goal",
        description: "Keep working until done",
        source: "built-in",
        kind: "command",
        invocation: "direct",
      },
    ]);
    const onSend = vi.fn().mockResolvedValue(true);
    render(
      <LazyMotion features={domAnimation} strict>
        <Composer
          runtimes={[codex]}
          defaultRuntime="codex"
          defaultModel="Provider default"
          workingDirectory={repository}
          onSend={onSend}
        />
      </LazyMotion>,
    );

    await waitFor(() =>
      expect(bridge.listNativeProviderActions).toHaveBeenCalledWith("codex", repository),
    );
    const textbox = screen.getByRole("textbox", { name: "Task message" });
    fireEvent.change(textbox, { target: { value: "/", selectionStart: 1 } });
    const option = await screen.findByRole("option", { name: /skill-creator/ });
    expect(option).toHaveTextContent("system · Create a Codex skill");
    expect(option.querySelector("svg")).toBeNull();

    fireEvent.click(option);
    expect(textbox).toHaveValue("/skill-creator ");
    expect(document.querySelector('[data-native-skill="skill-creator"]')?.textContent).toBe(
      "/skill-creator ",
    );
    fireEvent.change(textbox, {
      target: { value: "/skill-creator add release checks", selectionStart: 39 },
    });
    expect(document.querySelector('[data-native-skill="skill-creator"]')).toHaveTextContent(
      "/skill-creator add release checks",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "/skill-creator add release checks",
          nativeActionId: "opaque-skill-1",
          nativeAction: { name: "skill-creator", kind: "skill" },
        }),
      ),
    );
    fireEvent.change(textbox, { target: { value: "/", selectionStart: 1 } });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /skill-creator/ })).toBeVisible(),
    );
    expect(listActions).toHaveBeenCalledTimes(1);

    fireEvent.change(textbox, {
      target: { value: "/goal finish the release", selectionStart: 24 },
    });
    expect(document.querySelector("[data-native-skill]")).toBeNull();

    fireEvent.change(textbox, {
      target: { value: "/skill-creator typed directly", selectionStart: 29 },
    });
    expect(document.querySelector('[data-native-skill="skill-creator"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: "/skill-creator typed directly",
        nativeActionId: "opaque-skill-1",
        nativeAction: { name: "skill-creator", kind: "skill" },
      }),
    );
  });

  it("labels Antigravity TUI actions as interactive-only and never sends them as prose", async () => {
    const antigravity: RuntimeConnection = {
      ...codex,
      id: "antigravity",
      name: "Antigravity",
      command: "agy",
      fidelity: "structured",
    };
    vi.spyOn(bridge, "listNativeProviderActions").mockResolvedValue([
      {
        id: "agy-guide",
        name: "antigravity-guide",
        description: "Provider guide",
        source: "builtin",
        kind: "skill",
        invocation: "interactiveOnly",
      },
    ]);
    const onSend = vi.fn().mockResolvedValue(true);
    render(
      <LazyMotion features={domAnimation} strict>
        <Composer
          runtimes={[antigravity]}
          defaultRuntime="antigravity"
          defaultModel="Provider default"
          workingDirectory={repository}
          onSend={onSend}
        />
      </LazyMotion>,
    );
    const textbox = screen.getByRole("textbox", { name: "Task message" });
    fireEvent.change(textbox, { target: { value: "/", selectionStart: 1 } });
    const option = await screen.findByRole("option", { name: /antigravity-guide/ });
    expect(option).toHaveAttribute("aria-disabled", "true");
    expect(option).toHaveTextContent("interactive provider terminal only");
    fireEvent.click(option);
    expect(textbox).toHaveValue("/");
    expect(onSend).not.toHaveBeenCalled();
  });
});
