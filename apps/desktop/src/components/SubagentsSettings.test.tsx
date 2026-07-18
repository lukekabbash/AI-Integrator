// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { bridgeMock } = vi.hoisted(() => ({
  bridgeMock: {
    listModelCatalog: vi.fn(),
    listIntegratorSkills: vi.fn(),
    listIntegratorMcps: vi.fn(),
  },
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, bridge: { ...actual.bridge, ...bridgeMock } };
});

import type { RuntimeConnection } from "../bridge";
import { DEFAULT_SPECIALISTS } from "../subagentSettings";
import { SubagentsSettings } from "./SubagentsSettings";

const runtimes: RuntimeConnection[] = [
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    status: "connected",
    fidelity: "native",
    models: [],
    detail: "Ready.",
  },
  {
    id: "claude",
    name: "Claude",
    command: "claude",
    status: "connected",
    fidelity: "native",
    models: [],
    detail: "Ready.",
  },
];

describe("Subagents settings", () => {
  beforeEach(() => {
    for (const mock of Object.values(bridgeMock)) mock.mockReset();
    bridgeMock.listModelCatalog.mockResolvedValue([]);
    bridgeMock.listIntegratorSkills.mockResolvedValue({
      skillsRoot: "/tmp/Skills",
      pluginsRoot: "/tmp/Plugins",
      bundledAvailable: true,
      skills: [
        {
          name: "design-principles",
          description: "Grounded product design judgment.",
          source: "first-party",
          enabled: true,
          defaultEnabled: true,
          invocationCount: 0,
        },
        {
          name: "documents:documents",
          description: "Create documents.",
          source: "plugin",
          enabled: true,
          defaultEnabled: false,
          invocationCount: 0,
        },
        {
          name: "documents:pdf",
          description: "Create and inspect PDFs.",
          source: "plugin",
          enabled: false,
          defaultEnabled: false,
          invocationCount: 0,
        },
      ],
    });
    bridgeMock.listIntegratorMcps.mockResolvedValue({
      mcpsRoot: "/tmp/MCPs",
      servers: [
        {
          name: "figma",
          source: "first-party",
          origin: "Figma",
          enabled: true,
          transport: "stdio",
        },
      ],
    });
  });

  function renderSettings(setSetting = vi.fn()) {
    render(
      <SubagentsSettings
        settings={{
          "delegation.profiles": [DEFAULT_SPECIALISTS[0]],
          "delegation.maxConcurrent": 3,
        }}
        setSetting={setSetting}
        runtimes={runtimes}
      />,
    );
    return setSetting;
  }

  it("presents one specialist hierarchy without composer-owned delegation controls", async () => {
    renderSettings();

    await waitFor(() => expect(bridgeMock.listIntegratorMcps).toHaveBeenCalledOnce());

    expect(screen.getByRole("heading", { name: "Subagents" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Concurrent subagents" })).toHaveAttribute(
      "max",
      "4",
    );
    expect(screen.getByText("Budget")).toBeInTheDocument();
    expect(screen.getAllByText("Standard")).not.toHaveLength(0);
    expect(screen.getByText("Premium")).toBeInTheDocument();
    expect(screen.getByLabelText("Primary runtime")).toBeInTheDocument();
    expect(
      screen.getByRole("radiogroup", { name: "Specialist access ceiling" }),
    ).toBeInTheDocument();
    expect(document.querySelector('img[src="/brand/providers/openai.png"]')).toBeInTheDocument();
    expect(screen.queryByText(/delegation preference/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/preferred helper/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cost tier/i)).not.toBeInTheDocument();
  });

  it("gives equipped Skills, Plugin skills, and MCP servers a legible hierarchy", async () => {
    renderSettings();

    await waitFor(() => expect(bridgeMock.listIntegratorMcps).toHaveBeenCalledOnce());

    expect(screen.getByText("Equipped capabilities")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Add whole Plugins or individual Skills—even when they’re off in main chats. MCP servers stay explicit.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Skills & Plugins\s*0 assigned/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /MCP servers\s*0 assigned/ })).toBeInTheDocument();
    expect(screen.getByText("No Skills or Plugins assigned.")).toBeInTheDocument();
    expect(screen.getByText("No MCP servers assigned.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add capabilities" }));
    expect(screen.getByRole("heading", { name: /Plugins\s*1/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Individual Skills\s*3/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /MCP servers\s*1/ })).toBeInTheDocument();
  });

  it("assigns a whole plugin as an exact snapshot of its current skills", async () => {
    const setSetting = renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Add capabilities" }));

    fireEvent.click(await screen.findByRole("checkbox", { name: "Add documents plugin" }));
    expect(setSetting).toHaveBeenLastCalledWith(
      "delegation.profiles",
      expect.arrayContaining([
        expect.objectContaining({
          id: "codex-default",
          skillIds: ["documents:documents", "documents:pdf"],
        }),
      ]),
    );
  });

  it("allows an individual installed skill that is off for main chats", async () => {
    const setSetting = renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Add capabilities" }));

    const pdf = await screen.findByRole("checkbox", { name: /pdf.*Plugin · documents/i });
    expect(pdf).toBeEnabled();
    expect(pdf).toHaveTextContent("Specialist only");
    fireEvent.click(pdf);

    expect(setSetting).toHaveBeenLastCalledWith(
      "delegation.profiles",
      expect.arrayContaining([
        expect.objectContaining({ id: "codex-default", skillIds: ["documents:pdf"] }),
      ]),
    );
  });

  it("persists exact Skill, Plugin, and MCP assignments on the selected specialist", async () => {
    const setSetting = renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Add capabilities" }));

    fireEvent.click(await screen.findByRole("checkbox", { name: /design-principles/i }));
    expect(setSetting).toHaveBeenLastCalledWith(
      "delegation.profiles",
      expect.arrayContaining([
        expect.objectContaining({ id: "codex-default", skillIds: ["design-principles"] }),
      ]),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /figma/i }));
    expect(setSetting).toHaveBeenLastCalledWith(
      "delegation.profiles",
      expect.arrayContaining([
        expect.objectContaining({ id: "codex-default", mcpServerIds: ["figma"] }),
      ]),
    );
  });

  it("makes the access ceiling and fallback policy explicit", async () => {
    const setSetting = renderSettings();
    fireEvent.click(screen.getByRole("radio", { name: "May edit project" }));
    expect(setSetting).toHaveBeenLastCalledWith(
      "delegation.profiles",
      expect.arrayContaining([
        expect.objectContaining({ id: "codex-default", access: "project-write" }),
      ]),
    );

    fireEvent.click(screen.getByRole("switch", { name: "Use Standard fallbacks" }));
    await waitFor(() =>
      expect(setSetting).toHaveBeenLastCalledWith(
        "delegation.profiles",
        expect.arrayContaining([
          expect.objectContaining({
            id: "codex-default",
            serviceLevels: expect.arrayContaining([
              expect.objectContaining({ level: "standard", fallbacksEnabled: true }),
            ]),
          }),
        ]),
      ),
    );
  });
});
