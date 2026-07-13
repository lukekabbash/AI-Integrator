// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_PREFERENCES,
  THEME_COLOR_TOKENS,
  THEME_PRESETS,
  applyThemePreferences,
  normalizeThemePreferences,
} from "./theme";

describe("semantic theme catalog", () => {
  it("ships the full preset catalog with a complete semantic palette", () => {
    expect(THEME_PRESETS).toHaveLength(19);
    expect(new Set(THEME_PRESETS.map((preset) => preset.id)).size).toBe(19);
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
