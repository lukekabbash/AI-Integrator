// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { bridgeMock } = vi.hoisted(() => ({
  bridgeMock: {
    listSettings: vi.fn(),
    getAppInfo: vi.fn(),
    listRuntimeActionPlans: vi.fn(),
    listModelCatalog: vi.fn(),
    listIntegratorSkills: vi.fn(),
    listIntegratorMcps: vi.fn(),
    installIntegratorPlugin: vi.fn(),
    uninstallIntegratorPlugin: vi.fn(),
    previewCuratedPlugin: vi.fn(),
    previewSkillBody: vi.fn(),
    getIntegratorSkillBody: vi.fn(),
    setIntegratorSkillCredential: vi.fn(),
    clearIntegratorSkillCredential: vi.fn(),
    connectIntegratorMcp: vi.fn(),
    disconnectIntegratorMcp: vi.fn(),
    listMemories: vi.fn(),
    createMemory: vi.fn(),
    updateMemory: vi.fn(),
    setMemoryEnabled: vi.fn(),
    deleteMemory: vi.fn(),
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    bridgeMock.listIntegratorSkills.mockResolvedValue({
      skillsRoot: "/tmp/AI Integrator/Skills",
      pluginsRoot: "/tmp/AI Integrator/Plugins",
      bundledAvailable: true,
      skills: [],
    });
    bridgeMock.listIntegratorMcps.mockResolvedValue({
      mcpsRoot: "/tmp/AI Integrator/MCPs",
      servers: [],
    });
    bridgeMock.installIntegratorPlugin.mockRejectedValue(new Error("not used"));
    bridgeMock.uninstallIntegratorPlugin.mockRejectedValue(new Error("not used"));
    bridgeMock.previewCuratedPlugin.mockRejectedValue(new Error("not used"));
    bridgeMock.previewSkillBody.mockRejectedValue(new Error("not used"));
    bridgeMock.getIntegratorSkillBody.mockRejectedValue(new Error("not used"));
    bridgeMock.setIntegratorSkillCredential.mockResolvedValue(undefined);
    bridgeMock.clearIntegratorSkillCredential.mockResolvedValue(undefined);
    bridgeMock.connectIntegratorMcp.mockRejectedValue(new Error("not used"));
    bridgeMock.disconnectIntegratorMcp.mockRejectedValue(new Error("not used"));
    bridgeMock.listMemories.mockResolvedValue([]);
    bridgeMock.createMemory.mockRejectedValue(new Error("not used"));
    bridgeMock.updateMemory.mockRejectedValue(new Error("not used"));
    bridgeMock.setMemoryEnabled.mockRejectedValue(new Error("not used"));
    bridgeMock.deleteMemory.mockRejectedValue(new Error("not used"));
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

    fireEvent.click(screen.getByRole("button", { name: "General" }));
    await screen.findByRole("heading", { name: "General" });
    const saveContext = screen.getByRole("switch", { name: "Save context on edit" });
    expect(saveContext).toHaveAttribute("aria-checked", "false");
    fireEvent.click(saveContext);
    await waitFor(() =>
      expect(bridgeMock.setSetting).toHaveBeenCalledWith(
        "settings.general.saveContextOnEdit",
        true,
      ),
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

  it("preserves composer send behavior and the live default permission profile", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Composer" }));
    await screen.findByRole("heading", { name: "Composer" });
    fireEvent.click(screen.getByRole("button", { name: "Enter key" }));
    fireEvent.click(await screen.findByRole("option", { name: "New line" }));
    await waitFor(() =>
      expect(bridgeMock.setSetting).toHaveBeenCalledWith("settings.composer.enterToSend", false),
    );

    fireEvent.click(screen.getByRole("button", { name: "Permissions" }));
    await screen.findByRole("heading", { name: "Permissions" });
    fireEvent.click(screen.getByRole("button", { name: "Default profile" }));
    fireEvent.click(await screen.findByRole("option", { name: "Full access · explicit" }));
    await waitFor(() =>
      expect(bridgeMock.setSetting).toHaveBeenCalledWith(
        "settings.permissions.defaultProfile",
        "full-access",
      ),
    );
  });

  it("keeps personalization and memory transparent and editable", async () => {
    const saved = {
      id: "memory-1",
      text: "Prefers concise release notes",
      state: "active" as const,
      creator: "user" as const,
      createdAt: "2026-07-19T12:00:00Z",
      updatedAt: "2026-07-19T12:00:00Z",
    };
    bridgeMock.listMemories.mockResolvedValueOnce([]).mockResolvedValue([saved]);
    bridgeMock.createMemory.mockResolvedValue(saved);

    render(
      <SettingsView
        preferences={DEFAULT_THEME_PREFERENCES}
        runtimes={[runtime]}
        usage={createEmptySnapshot().usage}
        onChangePreferences={vi.fn()}
        onResetPreferences={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Personalization" }));
    const name = await screen.findByRole("textbox", { name: "Your name" });
    fireEvent.change(name, { target: { value: "Luke" } });
    fireEvent.blur(name);
    expect(bridgeMock.setSetting).toHaveBeenCalledWith("settings.personalization.name", "Luke");

    const about = screen.getByRole("textbox", { name: "About you" });
    fireEvent.change(about, { target: { value: "I build local-first AI products." } });
    fireEvent.blur(about);
    expect(bridgeMock.setSetting).toHaveBeenCalledWith(
      "settings.personalization.about",
      "I build local-first AI products.",
    );

    const memoryToggle = await screen.findByRole("switch", { name: "Use memory in Chats" });
    expect(memoryToggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(memoryToggle);
    expect(bridgeMock.setSetting).toHaveBeenCalledWith("settings.memory.enabled", true);

    fireEvent.change(screen.getByRole("textbox", { name: "New memory" }), {
      target: { value: saved.text },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(bridgeMock.createMemory).toHaveBeenCalledWith(saved.text));
    expect(await screen.findByDisplayValue(saved.text)).toBeInTheDocument();
    expect(screen.getByText("1 of 20 active")).toBeInTheDocument();
  });

  it("opens the capability library to Marketplace and moves cards between install sections", async () => {
    bridgeMock.listIntegratorSkills.mockResolvedValueOnce({
      skillsRoot: "/tmp/AI Integrator/Skills",
      pluginsRoot: "/tmp/AI Integrator/Plugins",
      bundledAvailable: true,
      skills: [
        {
          name: "anthropics-skills:document-skills",
          description: "Create polished documents",
          source: "plugin",
          enabled: false,
          defaultEnabled: false,
          invocationCount: 0,
        },
      ],
    });
    bridgeMock.uninstallIntegratorPlugin.mockResolvedValueOnce({
      skillsRoot: "/tmp/AI Integrator/Skills",
      pluginsRoot: "/tmp/AI Integrator/Plugins",
      bundledAvailable: true,
      skills: [],
    });
    bridgeMock.installIntegratorPlugin.mockResolvedValueOnce({
      skillsRoot: "/tmp/AI Integrator/Skills",
      pluginsRoot: "/tmp/AI Integrator/Plugins",
      bundledAvailable: true,
      skills: [
        {
          name: "anthropics-skills:document-skills",
          description: "Create polished documents",
          source: "plugin",
          enabled: false,
          defaultEnabled: false,
          invocationCount: 0,
        },
      ],
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

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

    fireEvent.click(screen.getByRole("button", { name: "Skills and Plugins" }));
    expect(await screen.findByRole("tab", { name: "Marketplace" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const installedHeading = await screen.findByRole("heading", { name: "Installed" });
    const availableHeading = screen.getByRole("heading", { name: "Available" });
    expect(
      installedHeading.compareDocumentPosition(availableHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const installedCard = screen.getByRole("button", { name: "Anthropic skills" });
    const marketplaceHeading = within(installedCard)
      .getByText("Anthropic skills")
      .closest(".marketplace-card-heading");
    expect(marketplaceHeading).not.toBeNull();
    expect(marketplaceHeading?.querySelector(".browse-card-tile")).not.toBeNull();
    const uninstallButton = within(installedCard).getByRole("button", {
      name: "Uninstall Anthropic skills",
    });
    expect(uninstallButton).toBe(installedCard.querySelector(".marketplace-uninstall-button"));

    fireEvent.click(uninstallButton);
    await waitFor(() =>
      expect(bridgeMock.uninstallIntegratorPlugin).toHaveBeenCalledWith("anthropics-skills"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Installed" })).not.toBeInTheDocument(),
    );
    expect(
      within(screen.getByRole("button", { name: "Anthropic skills" })).queryByRole("button", {
        name: "Uninstall Anthropic skills",
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Anthropic skills" }));
    const dialog = await screen.findByRole("dialog", { name: "Anthropic skills" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(bridgeMock.installIntegratorPlugin).toHaveBeenCalledWith("anthropics/skills"),
    );
    expect(await screen.findByRole("heading", { name: "Installed" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("button", { name: "Anthropic skills" })).getByRole("button", {
        name: "Uninstall Anthropic skills",
      }),
    ).toBeInTheDocument();
  });

  it("presents standalone skills and MCP connectors as cards", async () => {
    bridgeMock.listIntegratorSkills.mockResolvedValueOnce({
      skillsRoot: "/tmp/AI Integrator/Skills",
      pluginsRoot: "/tmp/AI Integrator/Plugins",
      bundledAvailable: true,
      skills: [
        {
          name: "release-notes",
          description: "Draft concise release notes",
          source: "integrator",
          enabled: true,
          defaultEnabled: true,
          invocationCount: 4,
        },
      ],
    });
    bridgeMock.listIntegratorMcps.mockResolvedValueOnce({
      mcpsRoot: "/tmp/AI Integrator/MCPs",
      servers: [
        {
          name: "local-docs",
          source: "user",
          origin: "MCPs folder",
          enabled: false,
          transport: "stdio",
          command: "npx",
          args: ["-y", "local-docs-mcp"],
          env: {},
        },
      ],
    });

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

    fireEvent.click(screen.getByRole("button", { name: "Skills and Plugins" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Skills" }));
    const skillCard = await screen.findByRole("button", { name: "Open release-notes" });
    expect(skillCard).toHaveClass("capability-card", "skill-card");
    const skillSwitch = within(skillCard).getByRole("switch", { name: "Enable release-notes" });
    const skillDisclosure = within(skillCard).getByRole("button", {
      name: "Open release-notes details",
    });
    expect(skillSwitch.parentElement).toBe(skillDisclosure.parentElement);
    expect(
      skillSwitch.compareDocumentPosition(skillDisclosure) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "MCPs" }));
    const connectorCard = (await screen.findByText("local-docs")).closest(".capability-card");
    expect(connectorCard).not.toBeNull();
    expect(
      within(connectorCard as HTMLElement).getByRole("switch", { name: "Enable local-docs" }),
    ).toBeInTheDocument();
    expect(connectorCard).toHaveTextContent("npx -y local-docs-mcp");
  });

  it("keeps a curated MCP icon visible after the server is enabled", async () => {
    bridgeMock.listIntegratorMcps.mockResolvedValue({
      mcpsRoot: "/tmp/AI Integrator/MCPs",
      servers: [
        {
          name: "figma",
          source: "user",
          origin: "MCPs folder",
          enabled: false,
          transport: "remote",
          url: "https://mcp.figma.com/mcp",
        },
      ],
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

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

    fireEvent.click(screen.getByRole("button", { name: "Skills and Plugins" }));
    fireEvent.click(await screen.findByRole("tab", { name: "MCPs" }));
    const card = (await screen.findByText("figma")).closest(".mcp-card");
    expect(card).not.toBeNull();
    const icon = card?.querySelector("img");
    expect(icon).toHaveAttribute("src", "/brand/skills/figma.ico");

    fireEvent.click(within(card as HTMLElement).getByRole("switch", { name: "Enable figma" }));
    await waitFor(() =>
      expect(
        within(card as HTMLElement).getByRole("switch", { name: "Enable figma" }),
      ).toHaveAttribute("aria-checked", "true"),
    );
    expect(card?.querySelector("img")).toHaveAttribute("src", "/brand/skills/figma.ico");
  });

  it("warns before every Robinhood activation and keeps the enabled state visible", async () => {
    bridgeMock.listIntegratorMcps.mockResolvedValue({
      mcpsRoot: "/tmp/AI Integrator/MCPs",
      servers: [
        {
          name: "robinhood-trading",
          source: "user",
          origin: "MCPs folder",
          enabled: false,
          authorization: { state: "notConnected" as const, available: true },
          oauth: true,
          transport: "remote" as const,
          url: "https://agent.robinhood.com/mcp/trading",
        },
      ],
    });
    const genericConfirm = vi.spyOn(window, "confirm");

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

    fireEvent.click(screen.getByRole("button", { name: "Skills and Plugins" }));
    fireEvent.click(await screen.findByRole("tab", { name: "MCPs" }));
    const card = (await screen.findByText("robinhood-trading")).closest(".mcp-card") as HTMLElement;
    expect(card.querySelector("img")).toHaveAttribute("src", "/brand/skills/robinhood.svg");

    fireEvent.click(within(card).getByRole("switch", { name: "Enable robinhood-trading" }));
    const dialog = await screen.findByRole("dialog", { name: "Enable Robinhood Trading?" });
    expect(dialog).toHaveTextContent("real brokerage connection");
    expect(dialog).toHaveTextContent("Financial data across your accounts");
    expect(dialog).toHaveTextContent("Real order authority");
    expect(genericConfirm).not.toHaveBeenCalled();
    expect(bridgeMock.setSetting).not.toHaveBeenCalledWith(
      "settings.mcp.integrator.enabled",
      expect.anything(),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Enable Robinhood Trading?" })).toBeNull();

    fireEvent.click(within(card).getByRole("switch", { name: "Enable robinhood-trading" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Enable Robinhood Trading?" })).getByRole(
        "button",
        { name: "Enable Robinhood Trading" },
      ),
    );

    await waitFor(() =>
      expect(bridgeMock.setSetting).toHaveBeenCalledWith("settings.mcp.integrator.enabled", {
        "robinhood-trading": true,
      }),
    );
    await waitFor(() => expect(card).toHaveTextContent("Real trading enabled"));
  });

  it("signs remote MCP servers in and out from their installed cards", async () => {
    const disconnected = {
      mcpsRoot: "/tmp/AI Integrator/MCPs",
      servers: [
        {
          name: "figma",
          source: "user",
          origin: "MCPs folder",
          enabled: false,
          authorization: { state: "notConnected" as const, available: true },
          oauth: true,
          transport: "remote" as const,
          url: "https://mcp.figma.com/mcp",
        },
      ],
    };
    const connected = {
      ...disconnected,
      servers: disconnected.servers.map((server) => ({
        ...server,
        authorization: { state: "connected" as const, available: true },
      })),
    };
    bridgeMock.listIntegratorMcps.mockResolvedValueOnce(disconnected).mockResolvedValue(connected);
    bridgeMock.connectIntegratorMcp.mockResolvedValue(connected);
    bridgeMock.disconnectIntegratorMcp.mockResolvedValue(disconnected);
    vi.spyOn(window, "confirm").mockReturnValue(true);

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

    fireEvent.click(screen.getByRole("button", { name: "Skills and Plugins" }));
    fireEvent.click(await screen.findByRole("tab", { name: "MCPs" }));
    const card = (await screen.findByText("figma")).closest(".mcp-card") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Sign in to figma" }));

    await waitFor(() => expect(bridgeMock.connectIntegratorMcp).toHaveBeenCalledWith("figma"));
    const disconnect = await within(card).findByRole("button", { name: "Disconnect figma" });
    expect(card).toHaveTextContent("Connected");

    bridgeMock.listIntegratorMcps.mockResolvedValue(disconnected);
    fireEvent.click(disconnect);
    await waitFor(() => expect(bridgeMock.disconnectIntegratorMcp).toHaveBeenCalledWith("figma"));
    await within(card).findByRole("button", { name: "Sign in to figma" });
  });

  it("toggles an entire skill plugin while preserving per-skill controls", async () => {
    bridgeMock.listIntegratorSkills.mockResolvedValueOnce({
      skillsRoot: "/tmp/AI Integrator/Skills",
      pluginsRoot: "/tmp/AI Integrator/Plugins",
      bundledAvailable: true,
      skills: [
        {
          name: "gov-data:fred",
          description: "Fetch FRED series",
          source: "first-party",
          enabled: false,
          defaultEnabled: false,
          invocationCount: 2,
        },
        {
          name: "gov-data:bls",
          description: "Fetch BLS series",
          source: "first-party",
          enabled: true,
          defaultEnabled: false,
          invocationCount: 0,
        },
      ],
    });
    bridgeMock.listIntegratorMcps.mockResolvedValue({
      mcpsRoot: "/tmp/AI Integrator/MCPs",
      servers: [
        {
          name: "gov-data:data",
          source: "first-party",
          origin: "gov-data",
          enabled: false,
          transport: "remote",
          url: "https://example.com/mcp",
        },
      ],
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

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

    fireEvent.click(screen.getByRole("button", { name: "Skills and Plugins" }));
    await waitFor(() => expect(bridgeMock.listIntegratorSkills).toHaveBeenCalled(), {
      timeout: 3_000,
    });
    fireEvent.click(await screen.findByRole("tab", { name: "Plugins" }));
    const plugin = await screen.findByRole("button", { name: "gov-data" }, { timeout: 3_000 });
    expect(plugin.querySelector("img")).toHaveAttribute("src", "/brand/skills/data-gov.ico");
    await waitFor(() => expect(within(plugin).getByText("1 of 3 on")).toBeInTheDocument(), {
      timeout: 3_000,
    });

    const pluginSwitch = within(plugin).getByRole("switch", {
      name: "Enable gov-data",
    });
    const pluginDisclosure = within(plugin).getByRole("button", {
      name: "Open gov-data details",
    });
    expect(pluginSwitch.parentElement).toBe(pluginDisclosure.parentElement);
    expect(
      pluginSwitch.compareDocumentPosition(pluginDisclosure) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(pluginSwitch).toHaveAttribute("aria-checked", "false");
    fireEvent.click(pluginSwitch);
    await waitFor(() =>
      expect(bridgeMock.setSetting).toHaveBeenCalledWith("settings.skills.integrator.enabled", {
        "gov-data:fred": true,
        "gov-data:bls": true,
      }),
    );
    expect(bridgeMock.setSetting).toHaveBeenCalledWith("settings.mcp.integrator.enabled", {
      "gov-data:data": true,
    });
    await waitFor(() => expect(pluginSwitch).toHaveAttribute("aria-checked", "true"));

    fireEvent.click(pluginDisclosure);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("switch", { name: "Enable gov-data:fred" }));
    await waitFor(() =>
      expect(bridgeMock.setSetting).toHaveBeenCalledWith("settings.skills.integrator.enabled", {
        "gov-data:fred": false,
        "gov-data:bls": true,
      }),
    );
  });

  it("opens an installed plugin skill as inline rendered Markdown", async () => {
    bridgeMock.listIntegratorSkills.mockResolvedValueOnce({
      skillsRoot: "/tmp/AI Integrator/Skills",
      pluginsRoot: "/tmp/AI Integrator/Plugins",
      bundledAvailable: true,
      skills: [
        {
          name: "gov-data:fred",
          description: "Fetch FRED series",
          source: "first-party",
          enabled: true,
          defaultEnabled: false,
          invocationCount: 2,
        },
        {
          name: "gov-data:bls",
          description: "Fetch BLS series",
          source: "first-party",
          enabled: true,
          defaultEnabled: false,
          invocationCount: 0,
        },
      ],
    });
    bridgeMock.getIntegratorSkillBody.mockResolvedValueOnce({
      name: "gov-data:fred",
      description: "Fetch FRED series",
      body: [
        "---",
        "name: gov-data:fred",
        "description: Fetch FRED series",
        "---",
        "",
        "# Purpose",
        "",
        "Use the API safely.",
        "",
        "- Read the requested series",
        "- Cite the observation date",
        "",
        "```json",
        '{"provider":"fred","path":"/fred/series/observations"}',
        "```",
      ].join("\n"),
      truncated: false,
    });

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

    fireEvent.click(screen.getByRole("button", { name: "Skills and Plugins" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Plugins" }));
    const plugin = await screen.findByRole("button", { name: "gov-data" });
    fireEvent.click(plugin);
    const dialog = await screen.findByRole("dialog", { name: "gov-data" });
    const skillRow = within(dialog).getByText("fred").closest(".skill-settings-row");
    expect(skillRow).not.toBeNull();
    const skillSwitch = within(skillRow as HTMLElement).getByRole("switch", {
      name: "Enable gov-data:fred",
    });
    const showInstructions = within(skillRow as HTMLElement).getByRole("button", {
      name: "Show gov-data:fred instructions",
    });
    expect(skillSwitch.parentElement).toBe(showInstructions.parentElement);
    expect(
      skillSwitch.compareDocumentPosition(showInstructions) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(showInstructions);
    expect(skillRow).toHaveAttribute("aria-expanded", "true");
    expect(bridgeMock.getIntegratorSkillBody).toHaveBeenCalledWith("gov-data:fred");

    const disclosure = await within(dialog).findByRole("region", {
      name: "gov-data:fred instructions",
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(disclosure).getByRole("heading", { name: "Purpose" })).toBeInTheDocument();
    expect(within(disclosure).getByText("Use the API safely.")).toBeInTheDocument();
    expect(within(disclosure).getByText("Read the requested series")).toBeInTheDocument();
    expect(
      within(disclosure).getByText('{"provider":"fred","path":"/fred/series/observations"}'),
    ).toBeInTheDocument();
    expect(within(disclosure).queryByText("name: gov-data:fred")).not.toBeInTheDocument();

    fireEvent.click(
      within(skillRow as HTMLElement).getByRole("button", {
        name: "Hide gov-data:fred instructions",
      }),
    );
    await waitFor(() =>
      expect(
        within(dialog).queryByRole("region", { name: "gov-data:fred instructions" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("opens a marketplace skill inside its plugin preview", async () => {
    bridgeMock.previewCuratedPlugin.mockResolvedValueOnce({
      skills: [
        {
          name: "document-skills",
          description: "Create polished documents",
          path: "skills/document-skills/SKILL.md",
        },
      ],
      totalFound: 1,
      truncated: false,
    });
    bridgeMock.previewSkillBody.mockResolvedValueOnce({
      name: "document-skills",
      body: "## Workflow\n\n1. Inspect the source\n2. Render the result",
      truncated: false,
    });

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

    fireEvent.click(screen.getByRole("button", { name: "Skills and Plugins" }));
    expect(await screen.findByRole("tab", { name: "Marketplace" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(await screen.findByRole("button", { name: /Anthropic skills/ }));

    const dialog = await screen.findByRole("dialog", { name: "Anthropic skills" });
    const skillTrigger = await within(dialog).findByRole("button", {
      name: /document-skills/,
    });
    fireEvent.click(skillTrigger);

    expect(bridgeMock.previewSkillBody).toHaveBeenCalledWith(
      "anthropics/skills",
      "skills/document-skills/SKILL.md",
    );
    const disclosure = await within(dialog).findByRole("region", {
      name: "document-skills instructions",
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(disclosure).getByRole("heading", { name: "Workflow" })).toBeInTheDocument();
    expect(within(disclosure).getByText("Render the result")).toBeInTheDocument();
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

    fireEvent.click(screen.getByText("Runtimes and Models").closest("button") as HTMLButtonElement);
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

    fireEvent.click(screen.getByRole("button", { name: "Runtimes and Models" }));
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

    fireEvent.click(await screen.findByRole("button", { name: "Runtimes and Models" }));
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
