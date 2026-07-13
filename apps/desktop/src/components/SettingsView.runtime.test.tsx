// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { bridgeMock } = vi.hoisted(() => ({
  bridgeMock: {
    listSettings: vi.fn(),
    getAppInfo: vi.fn(),
    listRuntimeActionPlans: vi.fn(),
    setSetting: vi.fn(),
  },
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, bridge: bridgeMock };
});

vi.mock("./RuntimeSetupTerminal", () => ({
  RuntimeSetupTerminal: ({
    plan,
    onExit,
  }: {
    plan: { command: string };
    onExit: (code: number) => void;
  }) => (
    <div aria-label="Mock setup terminal">
      <code>{plan.command}</code>
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
  });

  it("opens an error-routed update as review-only, then re-probes after terminal exit", async () => {
    const onRefreshRuntimes = vi.fn().mockResolvedValue([runtime]);

    render(
      <SettingsView
        preferences={DEFAULT_THEME_PREFERENCES}
        runtimes={[runtime]}
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
        runtimes={[runtime]}
        usage={createEmptySnapshot().usage}
        onChangePreferences={vi.fn()}
        onResetPreferences={vi.fn()}
        runtimeActionRequest={{ id: 2, runtime: "codex", kind: "update" }}
        onBack={vi.fn()}
      />,
    );

    await screen.findByRole("dialog", { name: "Update Codex" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel runtime command" }));

    expect(screen.queryByRole("dialog", { name: "Update Codex" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Mock setup terminal")).not.toBeInTheDocument();
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
});
