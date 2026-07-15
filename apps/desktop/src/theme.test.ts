// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_PREFERENCES,
  THEME_COLOR_TOKENS,
  THEME_PRESET_GRID_ORDER,
  THEME_PRESETS,
  applyThemePreferences,
  contrastRatio,
  deriveTerminalColors,
  normalizeThemePreferences,
} from "./theme";

describe("semantic theme catalog", () => {
  it("ships the full preset catalog with a complete semantic palette", () => {
    expect(THEME_PRESETS).toHaveLength(28);
    expect(new Set(THEME_PRESETS.map((preset) => preset.id)).size).toBe(28);
    for (const preset of THEME_PRESETS) {
      expect(Object.keys(preset.colors)).toHaveLength(THEME_COLOR_TOKENS.length);
      expect(preset.colors["diff.added"]).not.toBe(preset.colors["diff.removed"]);
    }
  });

  it("contains no legacy purple product accent", () => {
    const serialized = JSON.stringify(THEME_PRESETS).toLowerCase();
    expect(serialized).not.toContain("#9a8cff");
    expect(serialized).not.toContain("#7c3aed");
    expect(serialized).not.toContain("purple");
  });

  it("keeps Usonian federal blue primary and brick red secondary", () => {
    const usonian = THEME_PRESETS.find((preset) => preset.id === "usonian");
    expect(usonian?.colors["accent.primary"]).toBe("#365f82");
    expect(usonian?.colors["accent.secondary"]).toBe("#a6504b");
  });

  it("keeps selected-row text legible in every preset", () => {
    for (const preset of THEME_PRESETS) {
      const ratio = contrastRatio(
        preset.colors["selection.text"],
        preset.colors["selection.active"],
      );
      expect(
        ratio,
        `${preset.id}: selection text contrast is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("groups dark and light appearance presets while preserving their color progression", () => {
    expect(THEME_PRESET_GRID_ORDER).toEqual([
      "integrator",
      "rosewood",
      "ember",
      "dusk",
      "espresso",
      "brass",
      "forest",
      "juniper",
      "ocean",
      "glory",
      "high-contrast",
      "midnight",
      "slate",
      "storm",
      "graphite",
      "velvet",
      "iris",
      "orchid",
      "dawn",
      "usonian",
      "sand",
      "limestone",
      "paper",
      "sage",
      "arctic",
      "ash",
      "lilac",
      "porcelain",
    ]);
    expect(new Set(THEME_PRESET_GRID_ORDER)).toEqual(
      new Set(THEME_PRESETS.map((preset) => preset.id)),
    );
    expect(
      THEME_PRESET_GRID_ORDER.map(
        (id) => THEME_PRESETS.find((preset) => preset.id === id)?.appearance,
      ),
    ).toEqual([...Array<string>(18).fill("dark"), ...Array<string>(10).fill("light")]);
  });

  it("normalizes unsafe imported preferences", () => {
    const normalized = normalizeThemePreferences({
      ...DEFAULT_THEME_PREFERENCES,
      themeId: "unknown",
      bodySize: 100,
      radiusOverride: -20,
    });
    expect(normalized.themeId).toBe(DEFAULT_THEME_PREFERENCES.themeId);
    expect(normalized.bodySize).toBeLessThanOrEqual(24);
    expect(normalized.radiusOverride).toBeGreaterThanOrEqual(0);
  });

  it("applies semantic compatibility aliases to a document root", () => {
    const root = document.createElement("div");
    applyThemePreferences(DEFAULT_THEME_PREFERENCES, root);
    expect(root.dataset.theme).toBe("integrator");
    expect(root.style.getPropertyValue("--color-accent-primary")).toBeTruthy();
    expect(root.style.getPropertyValue("--color-diff-added")).toBeTruthy();
    expect(root.style.getPropertyValue("--color-terminal-surface")).toBeTruthy();
    expect(root.style.getPropertyValue("--color-terminal-text")).toBeTruthy();
  });
});

describe("terminal surface", () => {
  it("derives WCAG AA-legible terminal colors for every preset", () => {
    for (const preset of THEME_PRESETS) {
      const terminal = deriveTerminalColors(preset.colors, preset.appearance);
      for (const token of [
        "text",
        "textMuted",
        "command",
        "success",
        "error",
        "warning",
      ] as const) {
        const ratio = contrastRatio(terminal[token], terminal.surface);
        expect(
          ratio,
          `${preset.id}: terminal ${token} ${terminal[token]} on ${terminal.surface} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the terminal surface derivation stable for unparseable overrides", () => {
    const preset = THEME_PRESETS[0];
    const overridden = {
      ...preset.colors,
      "terminal.ansi0": "light-dawn-glow(unparseable)",
    };
    const terminal = deriveTerminalColors(overridden, preset.appearance, preset.colors);
    expect(terminal).toEqual(deriveTerminalColors(preset.colors, preset.appearance));
  });
});
