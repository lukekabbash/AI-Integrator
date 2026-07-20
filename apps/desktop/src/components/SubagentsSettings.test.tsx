// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { bridgeMock } = vi.hoisted(() => ({
  bridgeMock: {
    listModelCatalog: vi.fn(),
    listIntegratorSkills: vi.fn(),
    listIntegratorMcps: vi.fn(),
    generateSpecialist: vi.fn(),
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
    bridgeMock.listModelCatalog.mockImplementation(async (runtime: string) => [
      {
        id: `${runtime}-model`,
        label: `${runtime} model`,
        efforts: [{ id: "high", label: "High" }],
        defaultEffort: "high",
      },
    ]);
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
    bridgeMock.generateSpecialist.mockResolvedValue({
      id: "specialist-ai-security",
      label: "Security Auditor",
      bestFor: "Authentication and authorization review.",
      workingGuidance: "Inspect boundaries and report concrete findings.",
      access: "read-only",
      serviceLevels: [
        {
          level: "budget",
          enabled: false,
          primary: { runtime: "claude", model: "claude-model", effort: "high" },
          fallbacksEnabled: true,
          fallbacks: [{ runtime: "codex", model: "codex-model", effort: "high" }],
        },
        {
          level: "standard",
          enabled: true,
          primary: { runtime: "claude", model: "claude-model", effort: "high" },
          fallbacksEnabled: true,
          fallbacks: [{ runtime: "codex", model: "codex-model", effort: "high" }],
        },
        {
          level: "premium",
          enabled: false,
          primary: { runtime: "claude", model: "claude-model", effort: "high" },
          fallbacksEnabled: true,
          fallbacks: [{ runtime: "codex", model: "codex-model", effort: "high" }],
        },
      ],
      skillIds: ["design-principles"],
      mcpServerIds: ["figma"],
      enabled: false,
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

  it("makes delegation guidance explicit and animated without hiding the prompt", async () => {
    const setSetting = renderSettings();
    await waitFor(() => expect(bridgeMock.listIntegratorMcps).toHaveBeenCalledOnce());
    const trigger = screen.getByRole("button", { name: /Delegation guidance/i });
    const guidance = screen.getByLabelText("Instructions for the lead agent");

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(guidance).toHaveAttribute(
      "placeholder",
      expect.stringContaining("use read-only specialists"),
    );

    fireEvent.change(guidance, { target: { value: "Ask for exact evidence." } });
    expect(setSetting).toHaveBeenLastCalledWith(
      "delegation.instruction",
      "Ask for exact evidence.",
    );
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

  it("creates a complete generated specialist in the disabled state", async () => {
    const setSetting = renderSettings();

    fireEvent.change(screen.getByLabelText("Describe a specialist"), {
      target: { value: "A security reviewer with design and Figma context." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create specialist from description" }));

    await waitFor(() =>
      expect(bridgeMock.generateSpecialist).toHaveBeenCalledWith(
        "A security reviewer with design and Figma context.",
        { runtime: "codex", fallbacks: ["claude"] },
        [
          {
            runtime: "codex",
            models: [
              {
                id: "codex-model",
                label: "codex model",
                efforts: [{ id: "high", label: "High" }],
                defaultEffort: "high",
              },
            ],
          },
          {
            runtime: "claude",
            models: [
              {
                id: "claude-model",
                label: "claude model",
                efforts: [{ id: "high", label: "High" }],
                defaultEffort: "high",
              },
            ],
          },
        ],
      ),
    );
    expect(setSetting).toHaveBeenLastCalledWith(
      "delegation.profiles",
      expect.arrayContaining([
        expect.objectContaining({
          id: "specialist-ai-security",
          label: "Security Auditor",
          skillIds: ["design-principles"],
          mcpServerIds: ["figma"],
          enabled: false,
        }),
      ]),
    );
    expect(
      await screen.findByText("Security Auditor was created disabled. Review it, then enable it."),
    ).toBeInTheDocument();
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
