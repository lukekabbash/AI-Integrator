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
import { CO_AUTHOR_TRAILER } from "../gitDecoration";
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
  fireEvent.click(screen.getByText("Git").closest("button") as HTMLButtonElement);
  await screen.findByRole("heading", { name: "Git" });
}

describe("Git settings", () => {
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
    bridgeMock.getStorageTotals.mockResolvedValue({
      totalBytes: 0,
      databaseBytes: 0,
      walBytes: 0,
      sharedMemoryBytes: 0,
      measuredAt: "2026-07-15T00:00:00Z",
      kind: "sqlite",
    });
  });

  it("puts what AI Integrator writes into a commit above who drafts it", async () => {
    await openSection();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    const commitsIndex = headings.indexOf("Commits");
    const commitMessagesIndex = headings.indexOf("Commit messages");
    expect(commitsIndex).toBeGreaterThanOrEqual(0);
    expect(commitMessagesIndex).toBeGreaterThan(commitsIndex);
  });

  it("requires an explicit commit-message runtime and auto-picks its first catalog model", async () => {
    bridgeMock.listModelCatalog.mockResolvedValue([
      { id: "gpt-5-mini", label: "GPT-5 mini" },
      { id: "gpt-5", label: "GPT-5" },
    ]);
    await openSection();

    fireEvent.click(screen.getByRole("button", { name: "Commit message runtime" }));
    fireEvent.click(await screen.findByRole("option", { name: "Codex" }));

    await waitFor(() =>
      expect(bridgeMock.setSetting).toHaveBeenCalledWith(
        "settings.git.commitMessage.runtime",
        "codex",
      ),
    );
    await waitFor(() =>
      expect(bridgeMock.setSetting).toHaveBeenCalledWith(
        "settings.git.commitMessage.model",
        "gpt-5-mini",
      ),
    );
  });

  it("keeps every git decoration off until it is asked for", async () => {
    await openSection();
    expect(
      screen.getByRole("switch", { name: "Credit AI Integrator as co-author" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "Prefix commit subjects" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("button", { name: "Force push" })).toHaveTextContent("Off");
    expect(screen.queryByLabelText("Example decorated commit message")).not.toBeInTheDocument();
  });

  it("previews the decorated commit once a decoration is on", async () => {
    await openSection();
    fireEvent.click(screen.getByRole("switch", { name: "Credit AI Integrator as co-author" }));
    await waitFor(() =>
      expect(bridgeMock.setSetting).toHaveBeenCalledWith("settings.git.coAuthor", true),
    );
    const preview = await screen.findByLabelText("Example decorated commit message");
    expect(preview).toHaveTextContent(CO_AUTHOR_TRAILER);
  });

  it("warns only for unconditional force, which is the mode that loses commits", async () => {
    await openSection();
    fireEvent.click(screen.getByRole("button", { name: "Force push" }));
    fireEvent.click(await screen.findByRole("option", { name: "With lease" }));
    await waitFor(() =>
      expect(bridgeMock.setSetting).toHaveBeenCalledWith("settings.git.forcePush", "lease"),
    );
    expect(screen.queryByText(/not recoverable/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Force push" }));
    fireEvent.click(await screen.findByRole("option", { name: "Always force" }));
    expect(await screen.findByText(/not recoverable/)).toBeInTheDocument();
  });
});
