// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_PREFERENCES,
  THEME_COLOR_TOKENS,
  THEME_PRESET_GRID_ORDER,
  THEME_PRESETS,
  applyThemePreferences,
  normalizeThemePreferences,
} from "./theme";

describe("semantic theme catalog", () => {
  it("ships the full preset catalog with a complete semantic palette", () => {
    expect(THEME_PRESETS).toHaveLength(24);
    expect(new Set(THEME_PRESETS.map((preset) => preset.id)).size).toBe(24);
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
      "high-contrast",
      "midnight",
      "slate",
      "graphite",
      "velvet",
      "iris",
      "orchid",
      "dawn",
      "sand",
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
    ).toEqual([...Array<string>(16).fill("dark"), ...Array<string>(8).fill("light")]);
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
  });
});
