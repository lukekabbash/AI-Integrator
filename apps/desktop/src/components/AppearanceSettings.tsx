import { useMemo } from "react";
import { Check, Palette, RotateCcw } from "lucide-react";
import {
  CODE_FONT_CHOICES,
  getThemePreset,
  INTERFACE_FONT_CHOICES,
  THEME_COLOR_TOKENS,
  THEME_PRESET_GRID_ORDER,
  type ThemeColorToken,
  type ThemePreferencePatch,
  type ThemePreferences,
} from "../theme";
import { Dropdown } from "./Dropdown";
import { SettingRow, Switch } from "./SettingControls";

const CONTRAST_TOKEN_PAIRS: ReadonlyArray<readonly [ThemeColorToken, ThemeColorToken]> = [
  ["text.primary", "surface.canvas"],
  ["text.secondary", "surface.canvas"],
  ["accent.text", "accent.primary"],
  ["focus.ring", "surface.canvas"],
];

function contrastRatio(foreground: string, background: string): number | null {
  const parse = (value: string) => {
    const match = value.match(/^#([\da-f]{6})/i);
    if (!match) return null;
    return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
  };
  const fg = parse(foreground);
  const bg = parse(background);
  if (!fg || !bg) return null;
  const luminance = (rgb: number[]) =>
    rgb
      .map((channel) => channel / 255)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const light = Math.max(luminance(fg), luminance(bg));
  const dark = Math.min(luminance(fg), luminance(bg));
  return (light + 0.05) / (dark + 0.05);
}

export interface AppearanceSettingsProps {
  preferences: ThemePreferences;
  onChange: (patch: ThemePreferencePatch) => void;
  onReset: () => void;
}

export function AppearanceSettings({ preferences, onChange, onReset }: AppearanceSettingsProps) {
  const preset = getThemePreset(preferences.themeId);
  const colors = useMemo(
    () => ({ ...preset.colors, ...preferences.colorOverrides }),
    [preset.colors, preferences.colorOverrides],
  );
  const contrastWarnings = CONTRAST_TOKEN_PAIRS.filter(
    ([foreground, background]) =>
      (contrastRatio(colors[foreground], colors[background]) ?? 7) < 4.5,
  );
  const updateColor = (token: ThemeColorToken, value: string) =>
    onChange({ colorOverrides: { ...preferences.colorOverrides, [token]: value } });
  const resetColor = (token: ThemeColorToken) => {
    const next = { ...preferences.colorOverrides };
    delete next[token];
    onChange({ colorOverrides: next });
  };
  return (
    <>
      <div className="settings-page-heading">
        <span>
          <Palette />
        </span>
        <div>
          <h1>Appearance</h1>
          <p>Theme, fonts, density, motion, and semantic color overrides.</p>
        </div>
        <button className="secondary-button" type="button" onClick={onReset}>
          <RotateCcw /> Reset
        </button>
      </div>
      <section className="settings-section">
        <header>
          <h2>Theme preset</h2>
          <p>The color palette used across the whole workspace.</p>
        </header>
        <div className="theme-grid" role="radiogroup" aria-label="Theme preset">
          {THEME_PRESET_GRID_ORDER.map((themeId) => {
            const theme = getThemePreset(themeId);
            const previewDetail =
              theme.colors["accent.secondary"] === theme.colors["accent.primary"]
                ? theme.colors["diff.addedStrong"]
                : theme.colors["accent.secondary"];
            return (
              <button
                className="theme-swatch"
                type="button"
                role="radio"
                aria-checked={preferences.themeId === theme.id}
                data-active={preferences.themeId === theme.id}
                onClick={() => onChange({ themeId: theme.id })}
                key={theme.id}
              >
                <span
                  className="theme-preview"
                  style={{
                    background: theme.colors["surface.canvas"],
                    borderColor: theme.colors["border.strong"],
                  }}
                >
                  <i style={{ background: theme.colors["surface.rail"] }} />
                  <b style={{ background: theme.colors["surface.layer1"] }} />
                  <em style={{ background: theme.colors["accent.primary"] }} />
                  <small style={{ background: previewDetail }} />
                </span>
                <span>
                  <strong>{theme.label}</strong>
                  <small>{theme.appearance}</small>
                </span>
                {preferences.themeId === theme.id ? <Check /> : null}
              </button>
            );
          })}
        </div>
      </section>
      <section className="settings-section">
        <header>
          <h2>Type</h2>
          <p>
            Interface and code fonts are independent. Unsupported choices fall back to a native
            stack.
          </p>
        </header>
        <SettingRow
          label="Interface font"
          description="Navigation, transcripts, settings, and controls."
        >
          <Dropdown
            aria-label="Interface font"
            value={preferences.interfaceFont}
            onChange={(value) =>
              onChange({ interfaceFont: value as ThemePreferences["interfaceFont"] })
            }
            options={INTERFACE_FONT_CHOICES.map((font) => ({ value: font.id, label: font.label }))}
          />
        </SettingRow>
        <SettingRow label="Code font" description="Diffs, terminals, commands, paths, and logs.">
          <Dropdown
            aria-label="Code font"
            value={preferences.codeFont}
            onChange={(value) => onChange({ codeFont: value as ThemePreferences["codeFont"] })}
            options={CODE_FONT_CHOICES.map((font) => ({ value: font.id, label: font.label }))}
          />
        </SettingRow>
        <SettingRow
          label="Interface size"
          description="Scales body text while compact metadata stays readable."
        >
          <div className="range-control">
            <input
              type="range"
              min="12"
              max="18"
              step="1"
              value={preferences.bodySize}
              onChange={(event) => onChange({ bodySize: Number(event.target.value) })}
            />
            <output>{preferences.bodySize}px</output>
          </div>
        </SettingRow>
        <SettingRow label="Code size" description="Used by the review and terminal surfaces.">
          <div className="range-control">
            <input
              type="range"
              min="11"
              max="18"
              step="1"
              value={preferences.codeSize}
              onChange={(event) => onChange({ codeSize: Number(event.target.value) })}
            />
            <output>{preferences.codeSize}px</output>
          </div>
        </SettingRow>
        <SettingRow
          label="Code ligatures"
          description="Keep operator ligatures when the selected font supports them."
        >
          <Switch
            checked={preferences.ligatures}
            onChange={(ligatures) => onChange({ ligatures })}
            label="Code ligatures"
          />
        </SettingRow>
      </section>
      <section className="settings-section">
        <header>
          <h2>Geometry and motion</h2>
          <p>Layout density, sidebar menus, corner radius, animation, and the streaming cursor.</p>
        </header>
        <SettingRow
          label="Density"
          description="Compact mode fits more work without shrinking readable text."
        >
          <div className="segmented">
            <button
              type="button"
              data-active={preferences.density === "comfortable"}
              onClick={() => onChange({ density: "comfortable" })}
            >
              Comfortable
            </button>
            <button
              type="button"
              data-active={preferences.density === "compact"}
              onClick={() => onChange({ density: "compact" })}
            >
              Compact
            </button>
          </div>
        </SettingRow>
        <SettingRow
          label="Sidebar menus"
          description="Open chat and project ··· menus to the left or right of the trigger."
        >
          <div className="segmented">
            <button
              type="button"
              data-active={preferences.sidebarMenuDirection === "left"}
              onClick={() => onChange({ sidebarMenuDirection: "left" })}
            >
              Left
            </button>
            <button
              type="button"
              data-active={preferences.sidebarMenuDirection === "right"}
              onClick={() => onChange({ sidebarMenuDirection: "right" })}
            >
              Right
            </button>
          </div>
        </SettingRow>
        <SettingRow
          label="Corner softness"
          description="Controls menus, panes, the composer, and common controls."
        >
          <div className="segmented">
            <button
              type="button"
              data-active={preferences.radius === "square"}
              onClick={() => onChange({ radius: "square" })}
            >
              Square
            </button>
            <button
              type="button"
              data-active={preferences.radius === "subtle"}
              onClick={() => onChange({ radius: "subtle" })}
            >
              Subtle
            </button>
            <button
              type="button"
              data-active={preferences.radius === "soft"}
              onClick={() => onChange({ radius: "soft" })}
            >
              Soft
            </button>
            <button
              type="button"
              data-active={preferences.radius === "round"}
              onClick={() => onChange({ radius: "round" })}
            >
              Round
            </button>
          </div>
        </SettingRow>
        <SettingRow
          label="Motion"
          description="Reduced and None preserve state without spatial animation."
        >
          <Dropdown
            aria-label="Motion"
            value={preferences.motion}
            onChange={(value) => onChange({ motion: value as ThemePreferences["motion"] })}
            options={[
              { value: "system", label: "Follow system" },
              { value: "full", label: "Full" },
              { value: "reduced", label: "Reduced" },
              { value: "none", label: "None" },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Streaming cursor"
          description="A quiet cursor marks the active response; it never simulates thinking."
        >
          <Switch
            checked={preferences.streamingCursor}
            onChange={(streamingCursor) => onChange({ streamingCursor })}
            label="Streaming cursor"
          />
        </SettingRow>
      </section>
      <section className="settings-section">
        <header>
          <h2>Typography detail</h2>
          <p>Font weight, line height, and panel spacing.</p>
        </header>
        <SettingRow
          label="Body weight"
          description="Increase weight when low-contrast text needs more presence."
        >
          <div className="range-control">
            <input
              aria-label="Body weight"
              type="range"
              min="350"
              max="700"
              step="25"
              value={preferences.bodyWeight}
              onChange={(event) => onChange({ bodyWeight: Number(event.target.value) })}
            />
            <output>{preferences.bodyWeight}</output>
          </div>
        </SettingRow>
        <SettingRow
          label="Body line height"
          description="Keeps transcript and settings text comfortable at larger type scales."
        >
          <div className="range-control">
            <input
              aria-label="Body line height"
              type="range"
              min="1.25"
              max="2"
              step="0.05"
              value={preferences.bodyLineHeight}
              onChange={(event) => onChange({ bodyLineHeight: Number(event.target.value) })}
            />
            <output>{preferences.bodyLineHeight.toFixed(2)}</output>
          </div>
        </SettingRow>
        <SettingRow
          label="Code line height"
          description="Balances dense diffs and terminal readability."
        >
          <div className="range-control">
            <input
              aria-label="Code line height"
              type="range"
              min="1.2"
              max="2"
              step="0.05"
              value={preferences.codeLineHeight}
              onChange={(event) => onChange({ codeLineHeight: Number(event.target.value) })}
            />
            <output>{preferences.codeLineHeight.toFixed(2)}</output>
          </div>
        </SettingRow>
        <SettingRow
          label="Panel spacing"
          description="Controls the breathing room between grouped surfaces."
        >
          <Dropdown
            aria-label="Panel spacing"
            value={preferences.panelSpacing}
            onChange={(value) =>
              onChange({ panelSpacing: value as ThemePreferences["panelSpacing"] })
            }
            options={[
              { value: "tight", label: "Tight" },
              { value: "balanced", label: "Balanced" },
              { value: "airy", label: "Airy" },
            ]}
          />
        </SettingRow>
      </section>
      <section className="settings-section">
        <header>
          <h2>Semantic color overrides</h2>
          <p>Override individual UI colors. Each token previews live and can be reset.</p>
        </header>
        <div
          className={`settings-callout ${contrastWarnings.length ? "settings-callout--warning" : "settings-callout--success"}`}
          role="status"
        >
          {contrastWarnings.length ? <RotateCcw /> : <Check />}
          <span>
            <strong>
              {contrastWarnings.length ? "Contrast needs attention" : "Contrast preview passes"}
            </strong>
            <small>
              {contrastWarnings.length
                ? `${contrastWarnings.length} token pair(s) are below the 4.5:1 normal-text target.`
                : "Primary text, accent controls, and focus ring meet the current text target."}
            </small>
          </span>
        </div>
        <div className="color-token-grid">
          {THEME_COLOR_TOKENS.map((token) => (
            <div className="color-token-row" key={token}>
              <span className="color-token-swatch" style={{ background: colors[token] }} />
              <code>{token}</code>
              <input
                aria-label={`${token} color`}
                type="color"
                value={
                  colors[token].startsWith("#")
                    ? colors[token].slice(0, 7)
                    : preset.colors["surface.canvas"].slice(0, 7)
                }
                onChange={(event) => updateColor(token, event.target.value)}
              />
              <button
                className="text-button"
                type="button"
                onClick={() => resetColor(token)}
                disabled={preferences.colorOverrides[token] === undefined}
              >
                Reset
              </button>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
