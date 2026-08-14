import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME_PREFERENCES, type ThemePreferences } from "../theme";
import { AppearanceSettings } from "./AppearanceSettings";

function renderAppearance(
  preferences: ThemePreferences = DEFAULT_THEME_PREFERENCES,
  onChange = vi.fn(),
  onReset = vi.fn(),
) {
  const view = render(
    <AppearanceSettings preferences={preferences} onChange={onChange} onReset={onReset} />,
  );
  return { ...view, onChange, onReset };
}

describe("AppearanceSettings", () => {
  it("preserves the theme, range, switch, dropdown, and reset callbacks", () => {
    const { container, onChange, onReset } = renderAppearance();

    fireEvent.click(screen.getByRole("radio", { name: /Graphite/ }));
    expect(onChange).toHaveBeenLastCalledWith({ themeId: "graphite" });

    fireEvent.change(screen.getByLabelText("Body weight"), { target: { value: "500" } });
    expect(onChange).toHaveBeenLastCalledWith({ bodyWeight: 500 });

    fireEvent.click(screen.getByRole("switch", { name: "Code ligatures" }));
    expect(onChange).toHaveBeenLastCalledWith({ ligatures: false });

    fireEvent.click(screen.getByRole("button", { name: "Motion" }));
    fireEvent.click(screen.getByRole("option", { name: "Reduced" }));
    expect(onChange).toHaveBeenLastCalledWith({ motion: "reduced" });

    const reset = container.querySelector<HTMLButtonElement>(
      ".settings-page-heading .secondary-button",
    );
    expect(reset).not.toBeNull();
    fireEvent.click(reset!);
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("removes only the selected semantic color override", () => {
    const preferences: ThemePreferences = {
      ...DEFAULT_THEME_PREFERENCES,
      colorOverrides: {
        "text.primary": "#111111",
        "surface.canvas": "#fefefe",
      },
    };
    const { onChange } = renderAppearance(preferences);
    const row = screen.getByText("text.primary").closest(".color-token-row");
    expect(row).not.toBeNull();

    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Reset" }));

    expect(onChange).toHaveBeenCalledWith({
      colorOverrides: { "surface.canvas": "#fefefe" },
    });
  });

  it("keeps the existing contrast warning behavior", () => {
    renderAppearance({
      ...DEFAULT_THEME_PREFERENCES,
      colorOverrides: {
        "text.primary": "#000000",
        "surface.canvas": "#000000",
      },
    });

    expect(
      screen.getByText("Contrast needs attention").closest('[role="status"]'),
    ).toHaveTextContent("Contrast needs attention");
  });
});
