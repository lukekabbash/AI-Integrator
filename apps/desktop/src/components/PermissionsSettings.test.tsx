// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

const { bridgeMock } = vi.hoisted(() => ({
  bridgeMock: {
    probeRuntimes: vi.fn(),
    listModelCatalog: vi.fn(),
  },
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, bridge: { ...actual.bridge, ...bridgeMock } };
});

import {
  AUTO_REVIEW_FALLBACK,
  AUTO_REVIEW_POLICY,
  AUTO_REVIEW_SETTING,
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

/** Catalog order is deliberately expensive-first so a picker that shows the
 *  cheap model can only have got there through `suggestedReviewerModels`. */
const catalogs: Partial<Record<RuntimeId, ModelCatalogEntry[]>> = {
  claude: [
    { id: "claude-opus-5", label: "Opus 5" },
    { id: "claude-sonnet-5", label: "Sonnet 5", efforts, defaultEffort: "high" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5", efforts, defaultEffort: "high" },
  ],
  codex: [
    { id: "gpt-5.6-codex", label: "GPT-5.6 Codex", efforts, defaultEffort: "high" },
    { id: "gpt-5.6-codex-mini", label: "Codex Mini", efforts, defaultEffort: "high" },
  ],
};

/** Mirrors SettingsView: the parent owns the map and echoes writes back down. */
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

const disclosure = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
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
  });

  it("offers the auto profile alongside the four and persists it", async () => {
    const onWrite = vi.fn();
    render(<Harness onWrite={onWrite} />);
    await pick("Default profile", "Auto · reviewed by a model");
    expect(onWrite).toHaveBeenCalledWith("permissions.defaultProfile", "auto");
    expect(trigger("Default profile")).toHaveTextContent("Auto · reviewed by a model");
  });

  it("lists installed runtimes only", async () => {
    render(<Harness />);
    expect(
      await screen.findByRole("switch", { name: "Auto review on Claude" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Auto review on Codex" })).toBeInTheDocument();
    // Cursor is not on this machine, so it could never answer a request.
    expect(screen.queryByRole("switch", { name: "Auto review on Cursor" })).not.toBeInTheDocument();
  });

  it("writes the runtime's route and seeds the cheapest model it reports", async () => {
    const onWrite = vi.fn();
    render(<Harness onWrite={onWrite} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Auto review on Claude" }));

    expect(onWrite).toHaveBeenCalledWith(AUTO_REVIEW_SETTING, { claude: { enabled: true } });
    // Catalog order leads with Opus; the picker must not, and what it shows has
    // to be what is stored.
    await waitFor(() =>
      expect(onWrite).toHaveBeenLastCalledWith(AUTO_REVIEW_SETTING, {
        claude: { enabled: true, model: "claude-haiku-4-5", effort: "low" },
      }),
    );
    expect(trigger("Reviewer model for Claude")).toHaveTextContent("Haiku 4.5");
    expect(trigger("Reviewer effort for Claude")).toHaveTextContent("Low");
    expect(disclosure("Claude")).toHaveTextContent("Reviewed by Claude · Haiku 4.5 · low");
  });

  it("re-seeds the model suggestions from the runtime that reviews, not the one that works", async () => {
    const onWrite = vi.fn();
    render(<Harness onWrite={onWrite} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Auto review on Claude" }));
    await waitFor(() =>
      expect(trigger("Reviewer model for Claude")).toHaveTextContent("Haiku 4.5"),
    );

    await pick("Reviewer runtime for Claude", "Codex");

    await waitFor(() =>
      expect(trigger("Reviewer model for Claude")).toHaveTextContent("Codex Mini"),
    );
    expect(onWrite).toHaveBeenLastCalledWith(AUTO_REVIEW_SETTING, {
      claude: {
        enabled: true,
        reviewer: "delegated",
        reviewerRuntime: "codex",
        model: "gpt-5.6-codex-mini",
        effort: "low",
      },
    });
  });

  it("normalizes a native reviewer down to delegated where no native one exists", async () => {
    const onWrite = vi.fn();
    render(
      <Harness
        initial={{ [AUTO_REVIEW_SETTING]: { claude: { enabled: true, reviewer: "native" } } }}
        onWrite={onWrite}
      />,
    );
    await screen.findByRole("switch", { name: "Auto review on Claude" });
    fireEvent.click(disclosure("Claude"));

    // Never a selectable option the app would then ignore.
    expect(
      screen.queryByRole("button", { name: "Who answers for Claude" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Claude has no reviewer of its own")).toBeInTheDocument();
    await waitFor(() =>
      expect(onWrite).toHaveBeenLastCalledWith(AUTO_REVIEW_SETTING, {
        claude: {
          enabled: true,
          reviewer: "delegated",
          model: "claude-haiku-4-5",
          effort: "low",
        },
      }),
    );
  });

  it("gives Codex the native choice and hands the pickers back when it is dropped", async () => {
    const onWrite = vi.fn();
    render(<Harness onWrite={onWrite} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Auto review on Codex" }));

    expect(trigger("Who answers for Codex")).toHaveTextContent("Codex's own reviewer");
    expect(screen.getByLabelText("Reviewer model chosen by Codex")).toBeInTheDocument();

    await pick("Who answers for Codex", "Integrator");

    await waitFor(() =>
      expect(trigger("Reviewer model for Codex")).toHaveTextContent("Codex Mini"),
    );
    expect(onWrite).toHaveBeenLastCalledWith(AUTO_REVIEW_SETTING, {
      codex: {
        enabled: true,
        reviewer: "delegated",
        model: "gpt-5.6-codex-mini",
        effort: "low",
      },
    });
  });

  it("offers only the efforts the chosen model advertises", async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole("switch", { name: "Auto review on Claude" }));
    await waitFor(() =>
      expect(trigger("Reviewer model for Claude")).toHaveTextContent("Haiku 4.5"),
    );

    await pick("Reviewer model for Claude", "Opus 5");

    expect(screen.getByLabelText("Reviewer effort unavailable for Claude")).toHaveTextContent(
      "Not exposed by this model",
    );
  });

  it("persists the fallback for a reviewer that cannot answer", async () => {
    const onWrite = vi.fn();
    render(<Harness onWrite={onWrite} />);
    await pick("When the reviewer cannot answer", "Deny the request");
    expect(onWrite).toHaveBeenCalledWith(AUTO_REVIEW_FALLBACK, "deny");
  });

  it("round-trips the policy and restores the shipped one", async () => {
    const onWrite = vi.fn();
    render(<Harness onWrite={onWrite} />);
    fireEvent.click(disclosure("Policy text"));

    const editor = screen.getByRole("textbox", { name: "Reviewer policy" });
    fireEvent.change(editor, {
      target: { value: "  Deny anything that leaves the repository.  " },
    });
    fireEvent.blur(editor);

    expect(onWrite).toHaveBeenCalledWith(
      AUTO_REVIEW_POLICY,
      "Deny anything that leaves the repository.",
    );
    expect(screen.getByRole("textbox", { name: "Reviewer policy" })).toHaveValue(
      "Deny anything that leaves the repository.",
    );
    expect(disclosure("Policy text")).toHaveTextContent("Edited on this machine");

    fireEvent.click(screen.getByRole("button", { name: /Restore the shipped policy/ }));

    // Empty is not "review with no policy" — the normalizer reads it as the
    // shipped text, which is the only copy of the rules.
    expect(onWrite).toHaveBeenLastCalledWith(AUTO_REVIEW_POLICY, "");
    expect(screen.getByRole("textbox", { name: "Reviewer policy" })).toHaveValue("");
    expect(screen.getByRole("button", { name: /Restore the shipped policy/ })).toBeDisabled();
    expect(disclosure("Policy text")).toHaveTextContent("The shipped policy");
  });

  it("opens the row and its pickers from the keyboard alone", async () => {
    render(<Harness />);
    await screen.findByRole("switch", { name: "Auto review on Claude" });

    const row = disclosure("Claude");
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(row).toHaveAttribute("aria-controls");
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");

    // Arrow-down on a closed picker opens it, so no control needs a pointer.
    fireEvent.keyDown(trigger("Reviewer runtime for Claude"), { key: "ArrowDown" });
    expect(
      await screen.findByRole("listbox", { name: "Reviewer runtime for Claude" }),
    ).toBeInTheDocument();
  });
});
