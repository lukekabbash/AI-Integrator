// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridge, type RuntimeConnection } from "../bridge";
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

afterEach(() => vi.restoreAllMocks());

describe("Composer compact controls", () => {
  it("keeps routing and mic visible while the overflow menu controls mode and policy", async () => {
    vi.spyOn(bridge, "listModelCatalog").mockResolvedValue([
      {
        id: "gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        efforts: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
        defaultEffort: "high",
      },
    ]);
    const onSend = vi.fn().mockResolvedValue(true);
    const onPermissionChange = vi.fn();
    const onSessionModeChange = vi.fn();

    render(
      <Composer
        runtimes={runtimes}
        defaultRuntime="codex"
        defaultModel="gpt-5.6-luna"
        defaultEffort="high"
        onSend={onSend}
        onPermissionChange={onPermissionChange}
        sessionModes={{
          currentModeId: "agent",
          availableModes: [
            { id: "agent", name: "Agent" },
            { id: "plan", name: "Plan" },
          ],
        }}
        onSessionModeChange={onSessionModeChange}
      />,
    );

    expect(screen.getByRole("button", { name: "Runtime" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Model" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start voice typing" })).toBeInTheDocument();
    expect(bridge.listModelCatalog).not.toHaveBeenCalled();
    // Native catalogs are deliberately negotiated only after explicit model
    // interaction so mounting a composer cannot start or replace a session.
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(bridge.listModelCatalog).toHaveBeenCalledWith("codex");
    fireEvent.click(await screen.findByRole("option", { name: "GPT-5.6 Luna" }));
    expect(await screen.findByRole("button", { name: "Reasoning effort" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Microphone" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "More composer controls" }));
    const controlsMenu = screen.getByRole("menu", { name: "Composer controls" });
    expect(controlsMenu).not.toHaveTextContent("Reasoning");
    expect(controlsMenu.querySelector("svg")).toBeNull();

    fireEvent.pointerEnter(screen.getByRole("menuitem", { name: /^Mode/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Plan" }));
    expect(onSessionModeChange).toHaveBeenCalledWith("plan");

    fireEvent.click(screen.getByRole("button", { name: "More composer controls" }));
    fireEvent.pointerEnter(screen.getByRole("menuitem", { name: /^Permission/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Read only" }));
    expect(onPermissionChange).toHaveBeenCalledWith("read-only");

    fireEvent.click(screen.getByRole("button", { name: "More composer controls" }));
    fireEvent.pointerEnter(screen.getByRole("menuitem", { name: /^Delegation/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Balanced delegation" }));

    fireEvent.click(screen.getByRole("button", { name: "Reasoning effort" }));
    fireEvent.click(await screen.findByRole("option", { name: "Low" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Task message" }), {
      target: { value: "Use the compact controls." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith({
        prompt: "Use the compact controls.",
        runtime: "codex",
        model: "gpt-5.6-luna",
        effort: "low",
        permission: "read-only",
        delegation: "balanced",
      }),
    );
  });
});
