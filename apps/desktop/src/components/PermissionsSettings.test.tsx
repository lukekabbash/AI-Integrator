// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

const DEFAULT_POLICY = "DEFAULT REVIEWER POLICY";

const { bridgeMock } = vi.hoisted(() => ({
  bridgeMock: {
    probeRuntimes: vi.fn(),
    listModelCatalog: vi.fn(),
    defaultAutoReviewPolicy: vi.fn(),
  },
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, bridge: { ...actual.bridge, ...bridgeMock } };
});

import {
  AUTO_REVIEW_FALLBACK,
  AUTO_REVIEW_POLICY,
  AUTO_REVIEW_REVIEWERS,
} from "../autoReviewSettings";
import type { ModelCatalogEntry, RuntimeConnection, RuntimeId } from "../bridge";
import { PermissionsSettings } from "./PermissionsSettings";
import type { SettingsMap } from "./settingsModel";

const runtimes: RuntimeConnection[] = [
  {
    id: "claude",
    name: "Claude",
    command: "claude",
    status: "connected",
    fidelity: "native",
    models: [],
    detail: "Ready.",
  },
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
    id: "cursor",
    name: "Cursor",
    command: "cursor-agent",
    status: "not_installed",
    fidelity: "acp",
    models: [],
    detail: "Not installed.",
  },
];

const efforts = [
  { id: "low", label: "Low" },
  { id: "high", label: "High" },
];

const catalogs: Partial<Record<RuntimeId, ModelCatalogEntry[]>> = {
  claude: [
    { id: "claude-opus-5", label: "Opus 5" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5", efforts, defaultEffort: "high" },
  ],
  codex: [
    { id: "gpt-5.6-codex", label: "GPT-5.6 Codex", efforts, defaultEffort: "high" },
    { id: "gpt-5.6-codex-mini", label: "Codex Mini", efforts, defaultEffort: "high" },
  ],
};

function Harness({
  initial = {},
  onWrite,
}: {
  initial?: SettingsMap;
  onWrite?: (key: string, value: unknown) => void;
}) {
  const [settings, setSettings] = useState<SettingsMap>(initial);
  return (
    <PermissionsSettings
      settings={settings}
      setSetting={(key, value) => {
        onWrite?.(key, value);
        setSettings((current) => ({ ...current, [key]: value }));
      }}
    />
  );
}

const trigger = (name: string) => screen.getByRole("button", { name });
const pick = async (control: string, option: string) => {
  fireEvent.click(trigger(control));
  fireEvent.click(await screen.findByRole("option", { name: option }));
};

describe("PermissionsSettings", () => {
  beforeEach(() => {
    for (const mock of Object.values(bridgeMock)) mock.mockReset();
    bridgeMock.probeRuntimes.mockResolvedValue(runtimes);
    bridgeMock.listModelCatalog.mockImplementation(
      async (runtime: RuntimeId) => catalogs[runtime] ?? [],
    );
    bridgeMock.defaultAutoReviewPolicy.mockResolvedValue(DEFAULT_POLICY);
  });

  it("offers the plain Auto review profile", async () => {
    const onWrite = vi.fn();
    render(<Harness onWrite={onWrite} />);
    await pick("Default profile", "Auto");
    expect(onWrite).toHaveBeenCalledWith("permissions.defaultProfile", "auto");
  });

  it("creates one shared reviewer order instead of task-runtime switches", async () => {
    const onWrite = vi.fn();
    render(<Harness onWrite={onWrite} />);

    await waitFor(() =>
      expect(onWrite).toHaveBeenCalledWith(AUTO_REVIEW_REVIEWERS, [{ runtime: "codex" }]),
    );
    await waitFor(() =>
      expect(onWrite).toHaveBeenLastCalledWith(AUTO_REVIEW_REVIEWERS, [
        {
          runtime: "codex",
          model: "gpt-5.6-codex-mini",
          effort: "low",
        },
      ]),
    );

    expect(trigger("Reviewer runtime 1")).toHaveTextContent("Codex");
    expect(trigger("Reviewer model 1")).toHaveTextContent("Codex Mini");
    expect(screen.queryByRole("switch", { name: /Auto review on/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Cursor")).not.toBeInTheDocument();
  });

  it("adds and reorders reviewer fallbacks", async () => {
    const onWrite = vi.fn();
    render(
      <Harness
        initial={{
          [AUTO_REVIEW_REVIEWERS]: [
            { runtime: "codex", model: "gpt-5.6-codex-mini", effort: "low" },
          ],
        }}
        onWrite={onWrite}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add fallback" }));
    await waitFor(() => expect(trigger("Reviewer runtime 2")).toBeInTheDocument());
    await pick("Reviewer runtime 2", "Claude");
    await waitFor(() => expect(trigger("Reviewer model 2")).toHaveTextContent("Haiku 4.5"));

    fireEvent.click(screen.getByRole("button", { name: "Move reviewer 2 up" }));
    expect(onWrite).toHaveBeenLastCalledWith(AUTO_REVIEW_REVIEWERS, [
      { runtime: "claude", model: "claude-haiku-4-5", effort: "low" },
      { runtime: "codex", model: "gpt-5.6-codex-mini", effort: "low" },
    ]);
  });

  it("persists the final fallback", async () => {
    const onWrite = vi.fn();
    render(<Harness onWrite={onWrite} />);
    await pick("If no reviewer answers", "Deny");
    expect(onWrite).toHaveBeenCalledWith(AUTO_REVIEW_FALLBACK, "deny");
  });

  it("shows the default policy in the editor and restores it", async () => {
    const onWrite = vi.fn();
    render(
      <Harness
        initial={{ [AUTO_REVIEW_POLICY]: "Deny anything outside the repository." }}
        onWrite={onWrite}
      />,
    );

    expect(await screen.findByRole("textbox", { name: "Reviewer policy" })).toHaveValue(
      "Deny anything outside the repository.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Restore default" }));
    expect(onWrite).toHaveBeenCalledWith(AUTO_REVIEW_POLICY, "");
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Reviewer policy" })).toHaveValue(DEFAULT_POLICY),
    );
  });

  it("fills an unedited policy box with the shipped default", async () => {
    render(<Harness />);
    expect(await screen.findByRole("textbox", { name: "Reviewer policy" })).toHaveValue(
      DEFAULT_POLICY,
    );
    expect(screen.queryByText(/Every reviewer runs/)).not.toBeInTheDocument();
  });
});
