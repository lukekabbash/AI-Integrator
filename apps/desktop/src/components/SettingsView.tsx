import { useMemo, useState } from "react";
import {
  Accessibility,
  ArrowLeft,
  Bot,
  Braces,
  Check,
  ChevronRight,
  CircleDollarSign,
  Download,
  GitBranch,
  Keyboard,
  MonitorCog,
  Palette,
  RotateCcw,
  Search,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { RuntimeConnection, UsageSnapshot } from "../bridge";
import {
  CODE_FONT_CHOICES,
  INTERFACE_FONT_CHOICES,
  THEME_PRESETS,
  type ThemePreferencePatch,
  type ThemePreferences,
} from "../theme";
import { BrandMark } from "./BrandMark";

type SettingsSection =
  | "appearance"
  | "agents"
  | "delegation"
  | "git"
  | "terminal"
  | "usage"
  | "privacy"
  | "shortcuts"
  | "updates";

interface SettingsViewProps {
  preferences: ThemePreferences;
  runtimes: RuntimeConnection[];
  usage: UsageSnapshot;
  onChangePreferences: (patch: ThemePreferencePatch) => void;
  onResetPreferences: () => void;
  onBack: () => void;
}

const settingsNav: Array<{ id: SettingsSection; label: string; hint: string; icon: LucideIcon }> = [
  { id: "appearance", label: "Appearance", hint: "Themes, type, motion", icon: Palette },
  { id: "agents", label: "Agents & models", hint: "Installed runtimes", icon: Bot },
  { id: "delegation", label: "Delegation", hint: "Roles and budgets", icon: Users },
  { id: "git", label: "Git & worktrees", hint: "Branches and safety", icon: GitBranch },
  { id: "terminal", label: "Terminal", hint: "Shells and input", icon: TerminalSquare },
  { id: "usage", label: "Usage & budgets", hint: "Plans, tokens, spend", icon: CircleDollarSign },
  { id: "privacy", label: "Privacy & data", hint: "Storage and retention", icon: ShieldCheck },
  { id: "shortcuts", label: "Keyboard", hint: "Keymap and commands", icon: Keyboard },
  { id: "updates", label: "Updates", hint: "Channels and rollback", icon: MonitorCog },
];

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting-row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      className="switch"
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      data-checked={checked}
    >
      <span />
    </button>
  );
}

function AppearanceSettings({
  preferences,
  onChange,
  onReset,
}: Pick<SettingsViewProps, "preferences" | "onResetPreferences"> & {
  onChange: SettingsViewProps["onChangePreferences"];
  onReset: () => void;
}) {
  return (
    <>
      <div className="settings-page-heading">
        <span>
          <Palette />
        </span>
        <div>
          <h1>Appearance</h1>
          <p>Make the workspace yours without sacrificing code contrast or state clarity.</p>
        </div>
        <button className="secondary-button" type="button" onClick={onReset}>
          <RotateCcw /> Reset
        </button>
      </div>
      <section className="settings-section">
        <header>
          <h2>Theme preset</h2>
          <p>Twelve coordinated palettes. Provider identity never recolors the workspace.</p>
        </header>
        <div className="theme-grid" role="radiogroup" aria-label="Theme preset">
          {THEME_PRESETS.map((theme) => (
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
                <small style={{ background: theme.colors["diff.addedStrong"] }} />
              </span>
              <span>
                <strong>{theme.label}</strong>
                <small>{theme.appearance}</small>
              </span>
              {preferences.themeId === theme.id ? <Check /> : null}
            </button>
          ))}
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
          <select
            value={preferences.interfaceFont}
            onChange={(event) =>
              onChange({ interfaceFont: event.target.value as ThemePreferences["interfaceFont"] })
            }
          >
            {INTERFACE_FONT_CHOICES.map((font) => (
              <option value={font.id} key={font.id}>
                {font.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label="Code font" description="Diffs, terminals, commands, paths, and logs.">
          <select
            value={preferences.codeFont}
            onChange={(event) =>
              onChange({ codeFont: event.target.value as ThemePreferences["codeFont"] })
            }
          >
            {CODE_FONT_CHOICES.map((font) => (
              <option value={font.id} key={font.id}>
                {font.label}
              </option>
            ))}
          </select>
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
          <p>Changes apply immediately and remain reversible.</p>
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
          <select
            value={preferences.motion}
            onChange={(event) =>
              onChange({ motion: event.target.value as ThemePreferences["motion"] })
            }
          >
            <option value="system">Follow system</option>
            <option value="full">Full</option>
            <option value="reduced">Reduced</option>
            <option value="none">None</option>
          </select>
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
    </>
  );
}

function RuntimeSettings({ runtimes }: { runtimes: RuntimeConnection[] }) {
  return (
    <>
      <div className="settings-page-heading">
        <span>
          <Bot />
        </span>
        <div>
          <h1>Agents & models</h1>
          <p>
            Integrator reuses each CLI’s own login and records the exact executable it launches.
          </p>
        </div>
      </div>
      <section className="settings-section">
        <header>
          <h2>Installed runtimes</h2>
          <p>Login and setup always run in vendor-owned or user-controlled surfaces.</p>
        </header>
        <div className="settings-runtime-list">
          {runtimes.map((runtime) => (
            <div key={runtime.id}>
              <span className={`runtime-logo runtime-logo--${runtime.id}`}>{runtime.name[0]}</span>
              <span>
                <strong>
                  {runtime.name}
                  <small data-status={runtime.status}>{runtime.status.replace("_", " ")}</small>
                </strong>
                <code>{runtime.command}</code>
                <p>{runtime.detail}</p>
              </span>
              <button className="secondary-button" type="button">
                {runtime.status === "connected" ? "Details" : "Set up"}
                <ChevronRight />
              </button>
            </div>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <header>
          <h2>Model defaults</h2>
          <p>Defaults are inherited by new tasks and remain adjustable per turn.</p>
        </header>
        {runtimes
          .filter((runtime) => runtime.status === "connected")
          .map((runtime) => (
            <SettingRow
              key={runtime.id}
              label={`${runtime.name} default`}
              description={`${runtime.fidelity} adapter · ${runtime.version ?? "version unknown"}`}
            >
              <select>
                {runtime.models.map((model) => (
                  <option key={model}>{model}</option>
                ))}
              </select>
            </SettingRow>
          ))}
      </section>
    </>
  );
}

function DelegationSettings() {
  return (
    <>
      <div className="settings-page-heading">
        <span>
          <Users />
        </span>
        <div>
          <h1>Delegation</h1>
          <p>Choose who may delegate, where child agents write, and how budgets are reserved.</p>
        </div>
      </div>
      <section className="settings-section">
        <header>
          <h2>Default policy</h2>
          <p>Task-level settings override these values and always show their effective source.</p>
        </header>
        <SettingRow
          label="Delegation profile"
          description="Balanced uses cheaper readers for discovery and reserves stronger models for synthesis."
        >
          <select defaultValue="balanced">
            <option value="off">Off</option>
            <option value="manual">Manual only</option>
            <option value="balanced">Balanced</option>
            <option value="budget">Budget first</option>
          </select>
        </SettingRow>
        <SettingRow
          label="Maximum depth"
          description="Prevents children from recursively creating uncontrolled work."
        >
          <select defaultValue="1">
            <option value="0">No child delegation</option>
            <option value="1">One level</option>
            <option value="2">Two levels</option>
          </select>
        </SettingRow>
        <SettingRow
          label="Concurrent writers"
          description="Each writing agent receives an isolated worktree lease."
        >
          <select defaultValue="3">
            <option>1</option>
            <option>2</option>
            <option>3</option>
            <option>4</option>
          </select>
        </SettingRow>
        <SettingRow
          label="Transcript access"
          description="Parents read scoped, redacted ranges only when needed."
        >
          <select defaultValue="bounded">
            <option value="bounded">Bounded on demand</option>
            <option value="summary">Summary only</option>
            <option value="disabled">Disabled</option>
          </select>
        </SettingRow>
      </section>
      <section className="settings-section">
        <header>
          <h2>Role routing</h2>
          <p>Semantic roles avoid hard-coded vendor instructions.</p>
        </header>
        <div className="role-routing">
          <div>
            <Braces />
            <span>
              <strong>Implementation</strong>
              <small>Codex · GPT-5.6 Sol · project write</small>
            </span>
            <button type="button">Edit</button>
          </div>
          <div>
            <Search />
            <span>
              <strong>Research and reading</strong>
              <small>Claude · Fable · read only</small>
            </span>
            <button type="button">Edit</button>
          </div>
          <div>
            <Accessibility />
            <span>
              <strong>Review and accessibility</strong>
              <small>Auto · budget capped · read only</small>
            </span>
            <button type="button">Edit</button>
          </div>
        </div>
      </section>
    </>
  );
}

function UsageSettings({ usage }: { usage: UsageSnapshot }) {
  return (
    <>
      <div className="settings-page-heading">
        <span>
          <CircleDollarSign />
        </span>
        <div>
          <h1>Usage & budgets</h1>
          <p>
            Subscription pressure, tokens, equivalent API value, and actual charges stay separate.
          </p>
        </div>
      </div>
      <section className="settings-section">
        <header>
          <h2>Current task</h2>
          <p>Every number includes its source and confidence.</p>
        </header>
        <div className="settings-usage-grid">
          {usage.metrics.map((metric) => (
            <div key={metric.label}>
              <span>
                {metric.label}
                <small>{metric.provenance.replace("_", " ")}</small>
              </span>
              <strong>{metric.value}</strong>
              <p>{metric.detail}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <header>
          <h2>Budget guardrails</h2>
          <p>Limits pause new work; they do not destroy an in-progress task.</p>
        </header>
        <SettingRow
          label="Warn at plan usage"
          description="Show a quiet warning before a subscription window is exhausted."
        >
          <div className="range-control">
            <input type="range" min="50" max="95" defaultValue="80" />
            <output>80%</output>
          </div>
        </SettingRow>
        <SettingRow
          label="Maximum equivalent value"
          description="Requires consent before estimated equivalent API value exceeds this amount."
        >
          <select defaultValue="25">
            <option>$10</option>
            <option value="25">$25</option>
            <option>$50</option>
            <option>No limit</option>
          </select>
        </SettingRow>
        <SettingRow
          label="Fallback consent"
          description="Ask before moving a turn across subscription, API, or provider boundaries."
        >
          <Switch checked onChange={() => undefined} label="Fallback consent" />
        </SettingRow>
      </section>
    </>
  );
}

function GenericSettings({
  section,
}: {
  section: Exclude<SettingsSection, "appearance" | "agents" | "delegation" | "usage">;
}) {
  const content = {
    git: {
      icon: GitBranch,
      title: "Git & worktrees",
      subtitle: "Pair every writing agent with one visible, recoverable checkout.",
      rows: [
        ["Isolation", "Create a worktree for parallel writers", "Worktrees by default"],
        ["Commit behavior", "Commit and push remain separate actions", "Never auto-push"],
        ["Protected branches", "Require preview before integration", "main, production"],
        ["Cleanup", "Preserve orphaned or dirty worktrees", "Ask before cleanup"],
      ],
    },
    terminal: {
      icon: TerminalSquare,
      title: "Terminal",
      subtitle: "Keep interactive input ownership explicit and secret-safe.",
      rows: [
        ["Windows shell", "Used by task and setup terminals", "PowerShell 7"],
        ["macOS shell", "Uses the user login environment", "zsh"],
        ["Agent input", "Who owns stdin when a process asks a question", "Ask before takeover"],
        ["Sensitive prompts", "Password input stays out of agent transcripts", "User only"],
      ],
    },
    privacy: {
      icon: ShieldCheck,
      title: "Privacy & data",
      subtitle: "Local state is inspectable, exportable, and deletable.",
      rows: [
        ["Session storage", "Tasks, transcripts, usage, and indexes", "On this device"],
        ["Retention", "Automatic cleanup for old task artifacts", "Keep indefinitely"],
        ["Diagnostics", "Logs are redacted before export", "Local only"],
        ["Telemetry", "Optional anonymous product diagnostics", "Off"],
      ],
    },
    shortcuts: {
      icon: Keyboard,
      title: "Keyboard",
      subtitle: "Searchable, platform-correct shortcuts with conflict awareness.",
      rows: [
        ["New task", "Start in the current project", "Ctrl N"],
        ["Command palette", "Reach every visible action", "Ctrl Shift P"],
        ["Quick open", "Files, tasks, symbols, and commands", "Ctrl P"],
        ["Toggle terminal", "Show or hide the task terminal", "Ctrl `"],
      ],
    },
    updates: {
      icon: MonitorCog,
      title: "Updates",
      subtitle: "Signed application and adapter updates with visible rollback.",
      rows: [
        ["Application channel", "Stable signed builds", "Stable"],
        ["Adapter compatibility", "Pin until conformance checks pass", "Automatic checks"],
        ["Download behavior", "Prepare updates without interrupting runs", "Ask to install"],
        ["Rollback", "Keep the last known-good package", "Enabled"],
      ],
    },
  }[section];
  const Icon = content.icon;
  return (
    <>
      <div className="settings-page-heading">
        <span>
          <Icon />
        </span>
        <div>
          <h1>{content.title}</h1>
          <p>{content.subtitle}</p>
        </div>
      </div>
      <section className="settings-section">
        <header>
          <h2>Defaults</h2>
          <p>Project and task policy may narrow these values.</p>
        </header>
        {content.rows.map(([label, description, value]) => (
          <SettingRow label={label} description={description} key={label}>
            <button className="setting-value-button" type="button">
              {value}
              <ChevronRight />
            </button>
          </SettingRow>
        ))}
      </section>
      {section === "privacy" ? (
        <section className="settings-section danger-zone">
          <header>
            <h2>Local data</h2>
            <p>Export before deleting if you may need task evidence later.</p>
          </header>
          <div className="data-actions">
            <button className="secondary-button" type="button">
              <Download /> Export settings
            </button>
            <button className="secondary-button" type="button">
              <Upload /> Import settings
            </button>
            <button className="danger-button" type="button">
              <Trash2 /> Delete local data…
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}

export function SettingsView(props: SettingsViewProps) {
  const [section, setSection] = useState<SettingsSection>("appearance");
  const [query, setQuery] = useState("");
  const visibleNav = useMemo(
    () =>
      settingsNav.filter((item) =>
        `${item.label} ${item.hint}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [query],
  );
  return (
    <main className="settings-shell" id="main-content">
      <aside className="settings-navigation" aria-label="Settings navigation">
        <div className="settings-brand">
          <BrandMark />
          <button
            className="icon-button subtle"
            type="button"
            onClick={props.onBack}
            aria-label="Close Settings"
          >
            <ArrowLeft />
          </button>
        </div>
        <button className="back-to-work" type="button" onClick={props.onBack}>
          <ArrowLeft /> Back to workspace
        </button>
        <label className="settings-search">
          <Search />
          <span className="sr-only">Search Settings</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search settings"
          />
        </label>
        <nav>
          {visibleNav.map((item) => (
            <button
              key={item.id}
              type="button"
              data-active={section === item.id}
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              <item.icon />
              <span>
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </span>
              <ChevronRight />
            </button>
          ))}
        </nav>
        <div className="settings-local-note">
          <ShieldCheck />
          <span>
            <strong>Local-first</strong>
            <small>No AI Integrator account required</small>
          </span>
        </div>
      </aside>
      <div className="settings-content-scroll">
        <div className="settings-content">
          {section === "appearance" ? (
            <AppearanceSettings
              preferences={props.preferences}
              onChange={props.onChangePreferences}
              onReset={props.onResetPreferences}
              onResetPreferences={props.onResetPreferences}
            />
          ) : null}
          {section === "agents" ? <RuntimeSettings runtimes={props.runtimes} /> : null}
          {section === "delegation" ? <DelegationSettings /> : null}
          {section === "usage" ? <UsageSettings usage={props.usage} /> : null}
          {section !== "appearance" &&
          section !== "agents" &&
          section !== "delegation" &&
          section !== "usage" ? (
            <GenericSettings section={section} />
          ) : null}
        </div>
      </div>
    </main>
  );
}
