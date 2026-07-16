// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { bridgeMock } = vi.hoisted(() => ({
  bridgeMock: {
    listSettings: vi.fn(),
    getAppInfo: vi.fn(),
    listRuntimeActionPlans: vi.fn(),
    listModelCatalog: vi.fn(),
    setSetting: vi.fn(),
    getStorageTotals: vi.fn(),
    explainPromptPreview: vi.fn(),
  },
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, bridge: bridgeMock };
});

vi.mock("./RuntimeSetupTerminal", () => ({
  RuntimeSetupTerminal: () => <div aria-label="Mock setup terminal" />,
}));

import { createEmptySnapshot } from "../demoData";
import { DEFAULT_THEME_PREFERENCES } from "../theme";
import { SettingsView } from "./SettingsView";

const codex = {
  id: "codex" as const,
  name: "Codex",
  command: "/opt/homebrew/bin/codex",
  status: "connected" as const,
  fidelity: "native" as const,
  models: [],
  detail: "Ready.",
};

const claude = {
  id: "claude" as const,
  name: "Claude",
  command: "/opt/homebrew/bin/claude",
  status: "connected" as const,
  fidelity: "native" as const,
  models: [],
  detail: "Ready.",
};

const cursor = {
  id: "cursor" as const,
  name: "Cursor",
  command: "cursor-agent",
  status: "not_installed" as const,
  fidelity: "acp" as const,
  models: [],
  detail: "Not installed.",
};

function renderSettings() {
  return render(
    <SettingsView
      preferences={DEFAULT_THEME_PREFERENCES}
      runtimes={[codex, claude, cursor]}
      usage={createEmptySnapshot().usage}
      onChangePreferences={vi.fn()}
      onResetPreferences={vi.fn()}
      onBack={vi.fn()}
    />,
  );
}

async function openSection() {
  renderSettings();
  fireEvent.click(screen.getByText("Explain").closest("button") as HTMLButtonElement);
  await screen.findByRole("heading", { name: "Explain" });
}

describe("Explain settings", () => {
  beforeEach(() => {
    for (const mock of Object.values(bridgeMock)) mock.mockReset();
    bridgeMock.listSettings.mockResolvedValue([]);
    bridgeMock.getAppInfo.mockResolvedValue({
      applicationVersion: "test",
      domainSchemaVersion: 2,
      dataDirectory: "/tmp/integrator-test",
      localOnly: true,
    });
    bridgeMock.listRuntimeActionPlans.mockResolvedValue([]);
    bridgeMock.listModelCatalog.mockResolvedValue([]);
    bridgeMock.setSetting.mockResolvedValue(undefined);
    bridgeMock.explainPromptPreview.mockResolvedValue("PROMPT PREVIEW");
    bridgeMock.getStorageTotals.mockResolvedValue({
      totalBytes: 0,
      databaseBytes: 0,
      walBytes: 0,
      sharedMemoryBytes: 0,
      measuredAt: "2026-07-15T00:00:00Z",
      kind: "sqlite",
    });
  });

  it("persists the archetype and both sliders", async () => {
    await openSection();

    fireEvent.click(screen.getByRole("button", { name: "Explain archetype" }));
    fireEvent.click(await screen.findByRole("option", { name: "Socratic" }));
    await waitFor(() =>
      expect(bridgeMock.setSetting).toHaveBeenCalledWith("settings.explain.archetype", "socratic"),
    );

    fireEvent.change(screen.getByRole("slider", { name: "Verbosity" }), {
      target: { value: "95" },
    });
    await waitFor(() =>
      expect(bridgeMock.setSetting).toHaveBeenCalledWith("settings.explain.verbosity", 95),
    );

    fireEvent.change(screen.getByRole("slider", { name: "Audience" }), { target: { value: "0" } });
    await waitFor(() =>
      expect(bridgeMock.setSetting).toHaveBeenCalledWith("settings.explain.technicality", 0),
    );
  });

  it("announces each slider's meaning rather than its raw index", async () => {
    await openSection();
    // "2" tells a screen-reader user nothing about who the answer is written for.
    expect(screen.getByRole("slider", { name: "Audience" })).toHaveAttribute(
      "aria-valuetext",
      "Technical",
    );
    expect(screen.getByRole("slider", { name: "Verbosity" })).toHaveAttribute(
      "aria-valuetext",
      "Brief · 40",
    );
  });

  it("creates a custom archetype from the dropdown's New row and selects it", async () => {
    await openSection();
    fireEvent.click(screen.getByRole("button", { name: "Explain archetype" }));
    fireEvent.click(await screen.findByRole("option", { name: "New archetype…" }));

    await waitFor(() => expect(bridgeMock.setSetting).toHaveBeenCalled());
    const written = bridgeMock.setSetting.mock.calls.find(
      ([key]) => key === "settings.explain.customArchetypes",
    );
    expect(written?.[1]).toHaveLength(1);
    // The sentinel is an action, not a value: it must never be stored.
    expect(bridgeMock.setSetting).not.toHaveBeenCalledWith(
      "settings.explain.archetype",
      "__new__",
    );

    // The new archetype opens its editor with a starter mission to edit.
    const mission = await screen.findByRole("textbox", { name: "Archetype mission" });
    expect(mission).toHaveValue("Explain what this code does and why it matters.");
  });

  it("shows the natively composed prompt rather than a local imitation", async () => {
    await openSection();
    await waitFor(() => expect(bridgeMock.explainPromptPreview).toHaveBeenCalled());
    expect(await screen.findByLabelText("Composed explain prompt")).toHaveTextContent(
      "PROMPT PREVIEW",
    );
    expect(bridgeMock.explainPromptPreview.mock.calls.at(-1)?.[0]).toMatchObject({
      archetype: "explanation",
      verbosity: 40,
      technicality: 2,
    });
  });

  it("orders the fallback chain by click and offers only installed runtimes", async () => {
    await openSection();
    // Cursor is not installed, so it can never answer and is not offered.
    expect(screen.queryByRole("button", { name: /Cursor/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Claude/ }));
    await waitFor(() =>
      expect(bridgeMock.setSetting).toHaveBeenCalledWith("settings.explain.fallbacks", ["claude"]),
    );
  });
});
