// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { bridgeMock } = vi.hoisted(() => ({
  bridgeMock: {
    listSettings: vi.fn(),
    getAppInfo: vi.fn(),
    listRuntimeActionPlans: vi.fn(),
    listModelCatalog: vi.fn(),
    setSetting: vi.fn(),
    getStorageTotals: vi.fn(),
  },
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, bridge: bridgeMock };
});

vi.mock("./RuntimeSetupTerminal", () => ({
  RuntimeSetupTerminal: ({
    plan,
    onClose,
    onExit,
  }: {
    plan: { command: string };
    onClose: () => void;
    onExit: (code: number) => void;
  }) => (
    <div aria-label="Mock setup terminal">
      <code>{plan.command}</code>
      <button type="button" onClick={onClose}>
        Close setup terminal
      </button>
      <button type="button" onClick={() => onExit(0)}>
        Finish command
      </button>
    </div>
  ),
}));

import { createEmptySnapshot } from "../demoData";
import { DEFAULT_THEME_PREFERENCES } from "../theme";
import { SettingsView } from "./SettingsView";

const runtime = {
  id: "codex" as const,
  name: "Codex",
  command: "/opt/homebrew/bin/codex",
  version: "codex-cli 0.139.0",
  status: "degraded" as const,
  fidelity: "native" as const,
  models: [],
  detail: "This CLI is authenticated but older than Integrator's certified protocol floor.",
};

const claudeRuntime = {
  id: "claude" as const,
  name: "Claude",
  command: "/opt/homebrew/bin/claude",
  version: "claude 2.1.0",
  status: "connected" as const,
  fidelity: "native" as const,
  models: [],
  detail: "Ready.",
};

const updatePlan = {
  id: "codex:update:installed:opaque",
  provider: "codex" as const,
  kind: "update" as const,
  method: "Installed vendor CLI",
  label: "Update Codex",
  command: "/opt/homebrew/bin/codex update",
  description: "Uses the installed vendor CLI's documented self-update command.",
  sourceUrl: "https://developers.openai.com/codex/cli",
  available: true,
  recommended: true,
  downloadsAndExecutesCode: true,
  modifiesOutsideProjects: true,
  environmentNote: "Runs locally with a reduced environment.",
};

describe("Runtime Settings command disclosure", () => {
  beforeEach(() => {
    for (const mock of Object.values(bridgeMock)) mock.mockReset();
    bridgeMock.listSettings.mockResolvedValue([]);
    bridgeMock.getAppInfo.mockResolvedValue({
      applicationVersion: "test",
      domainSchemaVersion: 2,
      dataDirectory: "/tmp/integrator-test",
      localOnly: true,
    });
    bridgeMock.listRuntimeActionPlans.mockResolvedValue([updatePlan]);
    bridgeMock.listModelCatalog.mockResolvedValue([]);
    bridgeMock.setSetting.mockResolvedValue(undefined);
    bridgeMock.getStorageTotals.mockResolvedValue({
      totalBytes: 0,
      databaseBytes: 0,
      walBytes: 0,
      sharedMemoryBytes: 0,
      measuredAt: "2026-07-15T00:00:00Z",
      kind: "sqlite",
    });
  });

  it("persists general and transcript density as local settings", async () => {
    render(
      <SettingsView
        preferences={DEFAULT_THEME_PREFERENCES}
        runtimes={[claudeRuntime, runtime]}
        usage={createEmptySnapshot().usage}
        onChangePreferences={vi.fn()}
        onResetPreferences={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("General").closest("button") as HTMLButtonElement);
    await screen.findByRole("heading", { name: "General" });
    const saveContext = screen.getByRole("switch", { name: "Save context on edit" });
    expect(saveContext).toHaveAttribute("aria-checked", "false");
    fireEvent.click(saveContext);
    await waitFor(() =>
      expect(bridgeMock.setSetting).toHaveBeenCalledWith("settings.general.saveContextOnEdit", true),
    );

    fireEvent.click(screen.getByText("Composer").closest("button") as HTMLButtonElement);
    const density = await screen.findByRole("button", { name: "Activity detail" });
    expect(density).toHaveTextContent("Normal");
    fireEvent.click(density);
    fireEvent.click(await screen.findByRole("option", { name: "Verbose" }));
    await waitFor(() =>
      expect(bridgeMock.setSetting).toHaveBeenCalledWith(
        "settings.transcript.activityDensity",
        "verbose",
      ),
    );
  });

  it("opens an error-routed update as review-only, then re-probes after terminal exit", async () => {
    const onRefreshRuntimes = vi.fn().mockResolvedValue([runtime]);

    render(
      <SettingsView
        preferences={DEFAULT_THEME_PREFERENCES}
        runtimes={[claudeRuntime, runtime]}
        usage={createEmptySnapshot().usage}
        onChangePreferences={vi.fn()}
        onResetPreferences={vi.fn()}
        runtimeActionRequest={{ id: 1, runtime: "codex", kind: "update" }}
        onRefreshRuntimes={onRefreshRuntimes}
        onBack={vi.fn()}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "Update Codex" });
    expect(dialog).toHaveTextContent("Review the exact local command before anything runs");
    expect(dialog).toHaveTextContent("/opt/homebrew/bin/codex update");
    expect(dialog).toHaveTextContent("downloads and executes vendor code");
    expect(screen.queryByLabelText("Mock setup terminal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run this command" }));
    expect(screen.getByLabelText("Mock setup terminal")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Finish command" }));
    await waitFor(() => expect(onRefreshRuntimes).toHaveBeenCalledOnce());
    expect(
      await screen.findByText("Codex checked again after the command finished."),
    ).toBeVisible();
  });

  it("does not start anything when the command review is cancelled", async () => {
    render(
      <SettingsView
        preferences={DEFAULT_THEME_PREFERENCES}
        runtimes={[claudeRuntime, runtime]}
        usage={createEmptySnapshot().usage}
        onChangePreferences={vi.fn()}
        onResetPreferences={vi.fn()}
        runtimeActionRequest={{ id: 2, runtime: "codex", kind: "update" }}
        onBack={vi.fn()}
      />,
    );

    await screen.findByRole("dialog", { name: "Update Codex" });
    await waitFor(() => expect(screen.queryByText("Claude")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Favorite runtime" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel runtime command" }));

    expect(screen.queryByRole("dialog", { name: "Update Codex" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Mock setup terminal")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Runtime library" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "New chat route" })).not.toBeInTheDocument();
    expect(await screen.findByText("Claude")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Favorite runtime" })).toBeInTheDocument();
    expect(document.querySelector(".runtime-settings-stage")).toHaveAttribute(
      "data-focused",
      "false",
    );
  });

  it("keeps a cancelled loading review closed when discovery finishes later", async () => {
    let resolvePlans: (plans: Array<typeof updatePlan>) => void = () => undefined;
    bridgeMock.listRuntimeActionPlans.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePlans = resolve;
      }),
    );

    render(
      <SettingsView
        preferences={DEFAULT_THEME_PREFERENCES}
        runtimes={[claudeRuntime, runtime]}
        usage={createEmptySnapshot().usage}
        onChangePreferences={vi.fn()}
        onResetPreferences={vi.fn()}
        runtimeActionRequest={{ id: 5, runtime: "codex", kind: "update" }}
        onBack={vi.fn()}
      />,
    );

    const review = await screen.findByRole("dialog", { name: "Update Codex" });
    expect(review).toHaveTextContent("Inspecting documented methods");
    fireEvent.click(screen.getByRole("button", { name: "Cancel runtime command" }));
    await act(async () => resolvePlans([updatePlan]));

    expect(screen.queryByRole("dialog", { name: "Update Codex" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Mock setup terminal")).not.toBeInTheDocument();
    expect(document.querySelector(".runtime-settings-stage")).toHaveAttribute(
      "data-focused",
      "false",
    );
  });

  it("focuses the active provider and brings its terminal directly beneath it", async () => {
    const { container } = render(
      <SettingsView
        preferences={DEFAULT_THEME_PREFERENCES}
        runtimes={[claudeRuntime, runtime]}
        usage={createEmptySnapshot().usage}
        onChangePreferences={vi.fn()}
        onResetPreferences={vi.fn()}
        runtimeActionRequest={{ id: 4, runtime: "codex", kind: "update" }}
        onBack={vi.fn()}
      />,
    );

    const review = await screen.findByRole("dialog", { name: "Update Codex" });
    await waitFor(() => expect(screen.queryByText("Claude")).not.toBeInTheDocument());
    const stage = container.querySelector(".runtime-settings-stage");
    expect(stage).toHaveAttribute("data-focused", "true");
    expect(stage).toHaveAttribute("data-terminal-active", "true");
    expect(screen.queryByRole("heading", { name: "New chat route" })).not.toBeInTheDocument();
    expect(stage?.querySelector(".settings-runtime-row[data-active='true']")).toHaveTextContent(
      "Codex",
    );
    expect(stage?.querySelector(".runtime-terminal-stage")).toContainElement(review);
    expect(screen.queryByLabelText("Mock setup terminal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run this command" }));
    expect(await screen.findByLabelText("Mock setup terminal")).toBeInTheDocument();
  });

  it("opens and closes the approved terminal from a runtime row action", async () => {
    render(
      <SettingsView
        preferences={DEFAULT_THEME_PREFERENCES}
        runtimes={[claudeRuntime, runtime]}
        usage={createEmptySnapshot().usage}
        onChangePreferences={vi.fn()}
        onResetPreferences={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Models and Runtimes").closest("button") as HTMLButtonElement);
    expect(await screen.findByRole("button", { name: "Favorite runtime" })).toBeInTheDocument();
    const runtimeRow = (await screen.findByText("Codex")).closest(".settings-runtime-row");
    expect(runtimeRow).not.toBeNull();
    fireEvent.click(within(runtimeRow as HTMLElement).getByRole("button", { name: "Update" }));

    expect(await screen.findByRole("dialog", { name: "Update Codex" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Favorite runtime" })).not.toBeInTheDocument();
    expect(bridgeMock.listRuntimeActionPlans).toHaveBeenCalledWith("codex", "update");
    fireEvent.click(screen.getByRole("button", { name: "Run this command" }));
    expect(await screen.findByLabelText("Mock setup terminal")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close setup terminal" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Mock setup terminal")).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("Claude")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Favorite runtime" })).toBeInTheDocument();
    expect(document.querySelector(".runtime-settings-stage")).toHaveAttribute(
      "data-focused",
      "false",
    );
  });

  it("shows documented install methods and their exact commands before choosing one", async () => {
    bridgeMock.listRuntimeActionPlans.mockResolvedValue([
      {
        ...updatePlan,
        id: "codex:install:official-installer",
        kind: "install",
        method: "Official installer",
        label: "Install with Official installer",
        command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      },
      {
        ...updatePlan,
        id: "codex:install:npm",
        kind: "install",
        method: "npm",
        label: "Install with npm",
        command: "npm install -g @openai/codex@latest",
        recommended: false,
      },
    ]);

    render(
      <SettingsView
        preferences={DEFAULT_THEME_PREFERENCES}
        runtimes={[{ ...runtime, status: "not_installed", version: undefined }]}
        usage={createEmptySnapshot().usage}
        onChangePreferences={vi.fn()}
        onResetPreferences={vi.fn()}
        runtimeActionRequest={{ id: 3, runtime: "codex", kind: "install" }}
        onBack={vi.fn()}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "Install Codex" });
    expect(within(dialog).getByRole("radio", { name: /Official installer/ })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /^npm/ })).not.toBeChecked();
    expect(dialog).toHaveTextContent("curl -fsSL https://chatgpt.com/codex/install.sh | sh");

    fireEvent.click(within(dialog).getByRole("radio", { name: /^npm/ }));
    expect(dialog).toHaveTextContent("npm install -g @openai/codex@latest");
  });

  it("stores a separate preferred model and effort for each runtime", async () => {
    bridgeMock.listModelCatalog.mockImplementation(async (runtimeId: string) =>
      runtimeId === "claude"
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
          ]
        : [
            {
              id: "gpt-codex",
              label: "GPT Codex",
              efforts: [{ id: "medium", label: "Medium" }],
              defaultEffort: "medium",
            },
          ],
    );

    render(
      <SettingsView
        preferences={DEFAULT_THEME_PREFERENCES}
        runtimes={[
          { ...runtime, status: "connected", models: ["gpt-codex"] },
          { ...claudeRuntime, models: ["claude-sonnet"] },
        ]}
        usage={createEmptySnapshot().usage}
        onChangePreferences={vi.fn()}
        onResetPreferences={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Models and Runtimes" }));
    expect(await screen.findByRole("button", { name: "Favorite runtime" })).toHaveTextContent(
      "Last used",
    );
    const claudeRow = (await screen.findByText("Claude")).closest(".settings-runtime-row");
    expect(claudeRow).not.toBeNull();
    fireEvent.click(
      within(claudeRow as HTMLElement).getByRole("button", {
        name: "Edit defaults for Claude",
      }),
    );
    expect(screen.queryByRole("button", { name: "Favorite runtime" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();

    const model = await screen.findByRole("button", { name: "Preferred model for claude" });
    fireEvent.click(model);
    fireEvent.click(await screen.findByRole("option", { name: "Claude Sonnet" }));
    const effort = await screen.findByRole("button", { name: "Preferred effort for claude" });
    fireEvent.click(effort);
    fireEvent.click(screen.getByRole("option", { name: "Low" }));

    expect(bridgeMock.setSetting).toHaveBeenCalledWith(
      "settings.models.defaultsByRuntime",
      expect.objectContaining({
        claude: { model: "claude-sonnet", effort: "low" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Runtime library" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Favorite runtime" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Default runtime" })).not.toBeInTheDocument();
  });

  it("uses a reversible favorite dropdown and preserves legacy route defaults when clearing it", async () => {
    bridgeMock.listSettings.mockResolvedValueOnce([
      { key: "settings.models.defaultRuntime", value: "codex" },
      { key: "settings.models.defaultModel", value: "gpt-codex" },
      { key: "settings.models.defaultEffort", value: "high" },
    ]);

    render(
      <SettingsView
        preferences={DEFAULT_THEME_PREFERENCES}
        runtimes={[{ ...runtime, status: "connected", models: ["gpt-codex"] }, claudeRuntime]}
        usage={createEmptySnapshot().usage}
        onChangePreferences={vi.fn()}
        onResetPreferences={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Models and Runtimes" }));
    const favoriteRuntime = await screen.findByRole("button", { name: "Favorite runtime" });
    expect(favoriteRuntime).toHaveTextContent("Codex");
    fireEvent.click(favoriteRuntime);
    fireEvent.click(await screen.findByRole("option", { name: "Last used" }));

    expect(bridgeMock.setSetting).toHaveBeenCalledWith(
      "settings.models.defaultsByRuntime",
      expect.objectContaining({ codex: { model: "gpt-codex", effort: "high" } }),
    );
    expect(bridgeMock.setSetting).toHaveBeenCalledWith("settings.models.defaultRuntime", "");
    expect(await screen.findByRole("button", { name: "Favorite runtime" })).toHaveTextContent(
      "Last used",
    );
  });
});
