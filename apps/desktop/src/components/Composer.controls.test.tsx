// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridge, type ModelCatalogEntry, type RuntimeConnection, type RuntimeId } from "../bridge";
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

function mockModelCatalog(
  resolve: (runtime: RuntimeId) => ModelCatalogEntry[] | Promise<ModelCatalogEntry[]>,
) {
  const catalogs = new Map<RuntimeId, ModelCatalogEntry[]>();
  const listeners = new Set<() => void>();
  vi.spyOn(bridge, "getCachedModelCatalog").mockImplementation((runtime) => catalogs.get(runtime));
  vi.spyOn(bridge, "subscribeModelCatalogs").mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  return vi.spyOn(bridge, "listModelCatalog").mockImplementation(async (runtime) => {
    const catalog = await resolve(runtime);
    catalogs.set(runtime, catalog);
    for (const listener of listeners) listener();
    return catalog;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  bridge.invalidateModelCatalog("codex");
  bridge.invalidateModelCatalog("claude");
  bridge.invalidateModelCatalog("antigravity");
  bridge.invalidateModelCatalog("cursor");
  bridge.invalidateModelCatalog("grok");
  bridge.invalidateModelCatalog("custom");
});

describe("Composer compact controls", () => {
  it("keeps routing and mic visible while the overflow menu controls mode and policy", async () => {
    mockModelCatalog(() => [
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
    await waitFor(() => expect(bridge.listModelCatalog).toHaveBeenCalledWith("codex"));
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
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
        draftPrompt: "Use the compact controls.",
        attachments: [],
        runtime: "codex",
        model: "gpt-5.6-luna",
        effort: "low",
        permission: "read-only",
        delegation: "balanced",
      }),
    );
  });

  it("replaces a legacy provider-default route with the discovered model", async () => {
    mockModelCatalog(() => [{ id: "gpt-5.6-luna", label: "GPT-5.6 Luna" }]);
    const onRoutingChange = vi.fn();

    render(
      <Composer
        runtimes={[{ ...runtimes[0], models: [] }]}
        defaultRuntime="codex"
        defaultModel="Provider default"
        onSend={vi.fn().mockResolvedValue(true)}
        onRoutingChange={onRoutingChange}
      />,
    );

    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Checking model…");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("GPT-5.6 Luna"),
    );
    expect(screen.queryByText("Provider default")).not.toBeInTheDocument();
    expect(onRoutingChange).toHaveBeenCalledWith({
      runtime: "codex",
      model: "gpt-5.6-luna",
      effort: undefined,
    });
  });

  it("reuses the warmed model catalog when a chat remounts", async () => {
    bridge.invalidateModelCatalog("codex");
    const listModelCatalog = vi.spyOn(bridge, "listModelCatalog");
    const props = {
      runtimes: [{ ...runtimes[0], models: [] }],
      defaultRuntime: "codex" as const,
      defaultModel: "Provider default",
      onSend: vi.fn().mockResolvedValue(true),
    };

    const first = render(<Composer {...props} />);
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Checking model…");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).not.toHaveTextContent(
        "Checking model…",
      ),
    );
    const warmedLabel = screen.getByRole("button", { name: "Model" }).textContent;
    expect(listModelCatalog).toHaveBeenCalledTimes(1);
    first.unmount();

    render(<Composer {...props} />);
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(warmedLabel ?? "");
    expect(screen.getByRole("button", { name: "Model" })).not.toHaveTextContent("Checking model…");
    expect(listModelCatalog).toHaveBeenCalledTimes(1);
  });

  it("recalls each runtime's preferred model and effort when switching", async () => {
    const routeRuntimes: RuntimeConnection[] = [
      ...runtimes,
      {
        id: "claude",
        name: "Claude",
        command: "claude",
        status: "connected",
        fidelity: "structured",
        models: ["claude-sonnet", "claude-opus"],
        detail: "Ready",
      },
    ];
    mockModelCatalog((runtime) =>
      runtime === "claude"
        ? [
            {
              id: "claude-sonnet",
              label: "Claude Sonnet",
              efforts: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
              defaultEffort: "high",
            },
            { id: "claude-opus", label: "Claude Opus" },
          ]
        : [{ id: "gpt-5.6-luna", label: "GPT-5.6 Luna" }],
    );
    const onRoutingChange = vi.fn();

    render(
      <Composer
        runtimes={routeRuntimes}
        defaultRuntime="codex"
        defaultModel="gpt-5.6-luna"
        runtimeDefaults={{
          codex: { model: "gpt-5.6-luna" },
          claude: { model: "claude-sonnet", effort: "low" },
        }}
        onSend={vi.fn().mockResolvedValue(true)}
        onRoutingChange={onRoutingChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    fireEvent.click(screen.getByRole("option", { name: "Claude" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Sonnet"),
    );
    expect(screen.getByRole("button", { name: "Reasoning effort" })).toHaveTextContent("Low");
  });

  it("keeps delegation off when the selected runtime cannot host the broker", async () => {
    const antigravity: RuntimeConnection = {
      id: "antigravity",
      name: "Antigravity",
      command: "agy",
      status: "connected",
      fidelity: "structured",
      models: ["gemini-3.5-flash"],
      detail: "Ready",
    };
    mockModelCatalog(() => [{ id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" }]);
    const onSend = vi.fn().mockResolvedValue(true);

    render(
      <Composer
        runtimes={[antigravity]}
        defaultRuntime="antigravity"
        defaultModel="gemini-3.5-flash"
        defaultDelegation="balanced"
        onSend={onSend}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Delegation unavailable for this runtime" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Task message" }), {
      target: { value: "Run without broker delegation." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        expect.objectContaining({ runtime: "antigravity", delegation: "off" }),
      ),
    );
  });

  it("disables approval prompts for Antigravity and normalizes stale ask drafts", async () => {
    const antigravity: RuntimeConnection = {
      id: "antigravity",
      name: "Antigravity",
      command: "agy",
      status: "connected",
      fidelity: "structured",
      models: ["gemini-3.5-flash"],
      detail: "Ready",
    };
    mockModelCatalog(() => [{ id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" }]);
    const onSend = vi.fn().mockResolvedValue(true);

    render(
      <Composer
        runtimes={[antigravity]}
        defaultRuntime="antigravity"
        defaultModel="gemini-3.5-flash"
        initialDraft={{
          prompt: "Run safely.",
          attachments: [],
          runtime: "antigravity",
          model: "gemini-3.5-flash",
          permission: "ask",
          delegation: "off",
          selectionStart: 11,
          selectionEnd: 11,
        }}
        onSend={onSend}
      />,
    );

    expect(screen.getByRole("button", { name: "Permission" })).toHaveTextContent("Project write");
    fireEvent.click(screen.getByRole("button", { name: "Permission" }));
    expect(screen.getByRole("option", { name: "Ask as needed" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        expect.objectContaining({ runtime: "antigravity", permission: "project-write" }),
      ),
    );
  });
});
