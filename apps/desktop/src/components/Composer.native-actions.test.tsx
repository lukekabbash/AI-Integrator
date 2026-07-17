// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const repository = "fixture-repository";

beforeEach(() => {
  document.documentElement.dataset.motion = "none";
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    } satisfies Storage,
  });
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.motion;
  vi.restoreAllMocks();
});

describe("Composer provider-native actions", () => {
  it("never sends a process-stale cached action handle", async () => {
    const cacheKey = `codex\u0000${repository}`;
    window.localStorage.setItem(
      "aiintegrator.native-actions.v1",
      JSON.stringify({
        [cacheKey]: [
          {
            id: "stale-skill",
            name: "skill-creator",
            description: "Create a Codex skill",
            source: "system",
            kind: "skill",
            invocation: "direct",
          },
        ],
      }),
    );
    let resolveActions:
      ((actions: Awaited<ReturnType<typeof bridge.listNativeProviderActions>>) => void) | undefined;
    vi.spyOn(bridge, "listNativeProviderActions").mockReturnValue(
      new Promise((resolve) => {
        resolveActions = resolve;
      }),
    );
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

    const textbox = screen.getByRole("textbox", { name: "Task message" });
    fireEvent.change(textbox, {
      target: { value: "/skill-creator", selectionStart: 14 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => {
      resolveActions?.([
        {
          id: "fresh-skill",
          name: "skill-creator",
          description: "Create a Codex skill",
          source: "system",
          kind: "skill",
          invocation: "direct",
        },
      ]);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "choose it again from the refreshed slash menu",
    );
    expect(textbox).toHaveValue("/skill-creator");
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.change(textbox, { target: { value: "/", selectionStart: 1 } });
    fireEvent.click(await screen.findByRole("option", { name: /skill-creator/ }));
    fireEvent.change(textbox, {
      target: { value: "/skill-creator update the skill", selectionStart: 31 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        expect.objectContaining({
          nativeActionId: "fresh-skill",
        }),
      ),
    );
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("sends Codex goal through its process-stable built-in route", async () => {
    const cacheKey = `codex\u0000${repository}`;
    window.localStorage.setItem(
      "aiintegrator.native-actions.v1",
      JSON.stringify({
        [cacheKey]: [
          {
            id: "stale-goal",
            name: "goal",
            description: "Keep working until done",
            source: "built-in",
            kind: "command",
            invocation: "direct",
          },
        ],
      }),
    );
    vi.spyOn(bridge, "listNativeProviderActions").mockReturnValue(new Promise(() => undefined));
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

    const textbox = screen.getByRole("textbox", { name: "Task message" });
    fireEvent.change(textbox, {
      target: { value: "/goal finish the release", selectionStart: 24 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "/goal finish the release",
          nativeActionId: "builtin:codex:goal:v1",
          nativeAction: { name: "goal", kind: "command" },
        }),
      ),
    );
  });

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
    expect(onSend).toHaveBeenCalledTimes(1);
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
