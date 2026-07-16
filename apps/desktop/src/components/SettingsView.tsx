import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { AnimatePresence, LayoutGroup, m as motion, useReducedMotion } from "motion/react";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bot,
  Braces,
  Folder,
  Check,
  CircleDollarSign,
  Copy,
  Database,
  Download,
  ExternalLink,
  FolderGit2,
  KeyRound,
  LoaderCircle,
  Mic,
  MonitorCog,
  Palette,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  TriangleAlert,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  bridge,
  openExternalLink,
  resolveModelEffort,
  type LocalAppInfo,
  type ModelCatalogEntry,
  type ProjectSummary,
  type ProviderUsageSummary,
  type RuntimeConnection,
  type RuntimeActionKind,
  type RuntimeActionPlan,
  type RuntimeId,
  type StorageTotals,
  type SubscriptionQuota,
  type SubscriptionWindow,
  type TaskSummary,
  type UsageSnapshot,
  type UsageSummary,
  type VoiceTypingCredentialStatus,
} from "../bridge";
import {
  CODE_FONT_CHOICES,
  exportThemePreferences,
  getThemePreset,
  importThemePreferences,
  INTERFACE_FONT_CHOICES,
  THEME_COLOR_TOKENS,
  THEME_PRESET_GRID_ORDER,
  type ThemeColorToken,
  type ThemePreferencePatch,
  type ThemePreferences,
} from "../theme";
import { BrandMark } from "./BrandMark";
import { Tooltip } from "./Tooltip";
import { Dropdown, ProviderIcon, type DropdownOption } from "./Dropdown";
import { Slider } from "./Slider";
import { RuntimeSetupTerminal } from "./RuntimeSetupTerminal";
import {
  normalizeRuntimeRouteDefaults,
  readRuntimeRouteDefault,
  RUNTIME_ROUTE_DEFAULTS_SETTING,
} from "../routingDefaults";
import {
  BUILT_IN_ARCHETYPES,
  contextSummary,
  CUSTOM_ARCHETYPE_PREFIX,
  DEFAULT_CUSTOM_LABEL,
  DEFAULT_CUSTOM_MISSION,
  DEFAULT_TECHNICALITY,
  DEFAULT_VERBOSITY,
  EXPLAIN_SETTINGS,
  INHERIT_RUNTIME,
  NEW_ARCHETYPE_OPTION,
  normalizeCustomArchetypes,
  normalizeFallbacks,
  readTechnicality,
  readVerbosity,
  resolveExplainConfig,
  technicalityLabel,
  verbosityLabel,
} from "../explainSettings";
import {
  DEFAULT_COMMIT_PREFIX,
  decorateCommitMessage,
  GIT_SETTINGS,
  readGitDecorationSettings,
  readPushForce,
} from "../gitDecoration";

type SettingsSection =
  | "general"
  | "appearance"
  | "composer"
  | "files-git"
  | "models-runtimes"
  | "permissions"
  | "subagents"
  | "usage"
  | "archive";

interface SettingsViewProps {
  preferences: ThemePreferences;
  runtimes: RuntimeConnection[];
  usage: UsageSnapshot;
  /** Live chats plus lazily loaded archived roots for the Archive section. */
  projects?: ProjectSummary[];
  tasks?: TaskSummary[];
  taskActionBusyId?: string;
  archivedLoading?: boolean;
  archivedHasMore?: boolean;
  onEnsureArchived?: () => void;
  onLoadMoreArchived?: () => void;
  /** Select the chat and return to the workspace screen. */
  onOpenTask?: (taskId: string) => void;
  onUpdateTask?: (taskId: string, patch: { archived?: boolean }) => void;
  onUpdateProject?: (projectId: string, patch: { archived?: boolean }) => void;
  onDeleteTask?: (taskId: string) => void;
  onDeleteProject?: (projectId: string) => void;
  onDeleteArchivedChats?: (projectId: string) => void;
  onChangePreferences: (patch: ThemePreferencePatch) => void;
  onResetPreferences: () => void;
  runtimeActionRequest?: RuntimeActionRequest | null;
  onRefreshRuntimes?: () => Promise<RuntimeConnection[]>;
  /** Mirrors each persisted change into the workspace immediately. */
  onSettingChanged?: (key: string, value: unknown) => void;
  onBack: () => void;
}

export interface RuntimeActionRequest {
  id: number;
  runtime: RuntimeId;
  kind: RuntimeActionKind;
}

const settingsNav: Array<{ id: SettingsSection; label: string; hint: string; icon: LucideIcon }> = [
  { id: "general", label: "General", hint: "Local app and data", icon: MonitorCog },
  { id: "appearance", label: "Appearance", hint: "Themes, type, motion", icon: Palette },
  { id: "composer", label: "Composer", hint: "Send behavior", icon: Braces },
  {
    id: "files-git",
    label: "Files and Git",
    hint: "Ask about a selection, commit trailers, push safety",
    icon: FolderGit2,
  },
  {
    id: "models-runtimes",
    label: "Models and Runtimes",
    hint: "Defaults, connections, and capability",
    icon: Bot,
  },
  { id: "permissions", label: "Permissions", hint: "Safe execution defaults", icon: ShieldCheck },
  { id: "subagents", label: "Subagents", hint: "Cross-provider handoff policy", icon: Users },
  { id: "usage", label: "Usage and Budgets", hint: "Local usage evidence", icon: CircleDollarSign },
  { id: "archive", label: "Archive", hint: "Browse, restore, and clean up", icon: Archive },
];

type SettingsMap = Record<string, unknown>;

/** Kept in sync with the Rust broker's built-in fallbacks (delegation.rs). */
interface DelegationProfileSetting {
  id: string;
  label: string;
  runtime: string;
  model?: string;
  effort?: string;
  /** Specialist prompt injected into every child launched with this profile. */
  instruction?: string;
  /** Profile ids preferred if this specialist may delegate downstream. */
  preferredChildProfileIds?: string[];
  costTier: "low" | "medium" | "high";
  enabled: boolean;
}

const DEFAULT_DELEGATION_PROFILES: DelegationProfileSetting[] = [
  {
    id: "codex-default",
    label: "Codex (OpenAI)",
    runtime: "codex",
    costTier: "low",
    enabled: true,
  },
  { id: "claude-default", label: "Claude", runtime: "claude", costTier: "high", enabled: true },
  {
    id: "antigravity-default",
    label: "Antigravity (Gemini)",
    runtime: "antigravity",
    costTier: "medium",
    enabled: true,
  },
  { id: "cursor-default", label: "Cursor", runtime: "cursor", costTier: "medium", enabled: true },
  { id: "grok-default", label: "Grok Build", runtime: "grok", costTier: "low", enabled: true },
];

/**
 * Every key here is consumed by real behavior: workspace restore and the
 * external-link confirmation live in the bridge, the composer defaults are
 * read when a new chat's composer mounts. A setting with no consumer does
 * not belong in this map or in the UI.
 */
const DEFAULT_SETTINGS: SettingsMap = {
  "general.openLastWorkspace": true,
  "general.autoResumeInterruptedTurns": false,
  "general.confirmExternalActions": true,
  "general.saveContextOnEdit": false,
  "composer.enterToSend": true,
  "transcript.showModel": true,
  "transcript.showTimestamps": true,
  "transcript.activityDensity": "normal",
  "models.defaultRuntime": "",
  "models.defaultModel": "",
  "models.defaultEffort": "medium",
  [RUNTIME_ROUTE_DEFAULTS_SETTING]: {},
  // Read by the selection explainer (FileView's "Ask about this"). The prompt
  // itself is composed natively from these; nothing here is a display-only
  // preference.
  [EXPLAIN_SETTINGS.archetype]: "explanation",
  [EXPLAIN_SETTINGS.customArchetypes]: [],
  [EXPLAIN_SETTINGS.verbosity]: DEFAULT_VERBOSITY,
  [EXPLAIN_SETTINGS.technicality]: DEFAULT_TECHNICALITY,
  // Empty runtime means the explainer follows whatever the chat is using.
  [EXPLAIN_SETTINGS.runtime]: INHERIT_RUNTIME,
  [EXPLAIN_SETTINGS.model]: "",
  [EXPLAIN_SETTINGS.effort]: "",
  [EXPLAIN_SETTINGS.fallbacks]: [],
  // Git decorations are all opt-in: each one either changes permanent history
  // or relaxes a push safeguard, so none may arrive by default.
  [GIT_SETTINGS.coAuthor]: false,
  [GIT_SETTINGS.forcePush]: "off",
  [GIT_SETTINGS.commitPrefixEnabled]: false,
  [GIT_SETTINGS.commitPrefix]: DEFAULT_COMMIT_PREFIX,
  "permissions.defaultProfile": "project-write",
  // Enforced by the workspace's retention sweep (App): auto-archive uses the
  // chat's last activity, auto-delete counts from the moment it was archived.
  "archive.autoArchiveAfter": "never",
  "archive.autoDeleteAfter": "never",
  // Consumed by the native delegation broker (peers_list / delegate_start
  // policy) and by the composer's delegation-mode default.
  "delegation.defaultMode": "off",
  "delegation.maxConcurrent": 3,
  "delegation.instruction": "",
  "delegation.profiles": DEFAULT_DELEGATION_PROFILES,
};

function readSetting<T>(settings: SettingsMap, key: string, fallback: T): T {
  return (key in settings ? settings[key] : fallback) as T;
}

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

/** An explicitly stored array is respected verbatim (including empty — the
 * user may have removed every profile on purpose); only a missing or
 * malformed value falls back to the built-in defaults. */
function normalizeDelegationProfiles(value: unknown): DelegationProfileSetting[] {
  if (!Array.isArray(value)) return DEFAULT_DELEGATION_PROFILES;
  return value.filter(
    (item): item is DelegationProfileSetting =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as DelegationProfileSetting).id === "string" &&
      typeof (item as DelegationProfileSetting).runtime === "string",
  );
}

/**
 * Delegation policy for the native broker: which agents an orchestrator may
 * hand subtasks to, how many at once, and the user's standing instruction.
 * Every control here is read by the Rust side on `peers_list`/`delegate_start`.
 */
/** Static effort choices when a provider catalog is unavailable; the Rust
 * side drops values a provider does not accept, so stale ids cannot fail a
 * delegated turn. */
const FALLBACK_EFFORTS: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high"],
  antigravity: ["low", "medium", "high"],
  // Cursor thought levels are per-model and only known from the live
  // catalog; Grok advertises none. An empty list keeps the picker honest
  // ("Default effort" only) instead of offering ids the agent would drop.
  cursor: [],
  grok: [],
};

/** Runtimes that can run as delegated subagents. */
const DELEGATION_TARGETS: Array<{ runtime: string; label: string }> = [
  { runtime: "codex", label: "Codex (OpenAI)" },
  { runtime: "claude", label: "Claude" },
  { runtime: "antigravity", label: "Antigravity (Gemini)" },
  { runtime: "cursor", label: "Cursor" },
  { runtime: "grok", label: "Grok Build" },
];

function SubagentsSettings({
  settings,
  setSetting,
  runtimes,
}: {
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
  runtimes: RuntimeConnection[];
}) {
  const mode = readSetting<string>(settings, "delegation.defaultMode", "off");
  const maxConcurrent = readSetting<number>(settings, "delegation.maxConcurrent", 3);
  const instruction = readSetting<string>(settings, "delegation.instruction", "");
  const profiles = normalizeDelegationProfiles(settings["delegation.profiles"]);
  const [instructionDraft, setInstructionDraft] = useState(instruction);
  const [catalogs, setCatalogs] = useState<Record<string, ModelCatalogEntry[]>>({});
  const profileSequence = useRef(0);

  // One catalog fetch per runtime present in the profile list. Failures fall
  // back to the static effort ids without blocking the page.
  const profileRuntimes = Array.from(new Set(profiles.map((profile) => profile.runtime))).join();
  useEffect(() => {
    let active = true;
    for (const runtime of profileRuntimes.split(",").filter(Boolean)) {
      if (catalogs[runtime]) continue;
      void bridge
        .listModelCatalog(runtime as RuntimeId)
        .then((entries) => {
          if (active && entries.length > 0) {
            setCatalogs((current) => ({ ...current, [runtime]: entries }));
          }
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [catalogs, profileRuntimes]);

  const updateProfiles = (next: DelegationProfileSetting[]) =>
    setSetting("delegation.profiles", next);
  const updateProfile = (id: string, patch: Partial<DelegationProfileSetting>) =>
    updateProfiles(
      profiles.map((profile) => (profile.id === id ? { ...profile, ...patch } : profile)),
    );
  const addProfile = (target: { runtime: string; label: string }) => {
    const suffix = profiles.filter((profile) => profile.runtime === target.runtime).length + 1;
    updateProfiles([
      ...profiles,
      {
        id: `${target.runtime}-local-${++profileSequence.current}`,
        label: suffix > 1 ? `${target.label} ${suffix}` : target.label,
        runtime: target.runtime,
        instruction: "",
        preferredChildProfileIds: [],
        costTier: target.runtime === "codex" || target.runtime === "grok" ? "low" : "medium",
        enabled: true,
      },
    ]);
  };
  const runtimeInstalled = (runtime: string) =>
    runtimes.find((connection) => connection.id === runtime)?.status !== "not_installed";

  return (
    <>
      <div className="settings-page-heading">
        <span>
          <Users />
        </span>
        <div>
          <h1>Subagents</h1>
          <p>
            Delegate subtasks to agents on other providers, asynchronously. Everything here is
            enforced by the local broker — orchestrators only ever see the profiles you enable.
          </p>
        </div>
      </div>
      <section className="settings-section">
        <header>
          <h2>Delegation policy</h2>
          <p>Mode and caps are yours; models can pick a peer but never override them.</p>
        </header>
        <SettingRow
          label="Default delegation mode"
          description="Preselected in the composer for new chats. Manual queues every delegation for your approval in the task's Agents rail before anything launches."
        >
          <Dropdown
            className="compact-select"
            aria-label="Default delegation mode"
            value={mode}
            options={[
              { value: "off", label: "No delegation" },
              { value: "manual", label: "Manual approval" },
              { value: "balanced", label: "Balanced" },
              { value: "budget-first", label: "Budget first" },
            ]}
            onChange={(value) => setSetting("delegation.defaultMode", value)}
          />
        </SettingRow>
        <SettingRow
          label="Concurrent subagents"
          description="Hard cap per task, enforced by the broker regardless of what the model asks for."
        >
          <input
            className="subagent-number"
            type="number"
            min={1}
            max={16}
            aria-label="Concurrent subagents"
            value={maxConcurrent}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next))
                setSetting("delegation.maxConcurrent", Math.min(16, Math.max(1, Math.round(next))));
            }}
          />
        </SettingRow>
        <SettingRow
          label="Delegation instruction"
          description="Your standing policy, injected into the orchestrator's prompt whenever delegation is active."
        >
          <textarea
            className="subagent-instruction"
            aria-label="Delegation instruction"
            rows={3}
            placeholder="e.g. Prefer Codex for mechanical refactors and test writing; keep review and design work yourself."
            value={instructionDraft}
            onChange={(event) => setInstructionDraft(event.target.value)}
            onBlur={() => setSetting("delegation.instruction", instructionDraft.trim())}
          />
        </SettingRow>
      </section>
      <section className="settings-section">
        <header>
          <h2>Delegation profiles</h2>
          <p>
            The peer list shown to orchestrators, with your preferred model and reasoning effort
            pinned per profile. Budget-first mode offers them cheapest tier first.
          </p>
        </header>
        {profiles.length === 0 ? (
          <p className="subagent-empty">
            No profiles — orchestrators have nothing to delegate to. Add one below.
          </p>
        ) : null}
        {profiles.map((profile) => {
          const catalog = (catalogs[profile.runtime] ?? []).filter(
            (entry) => entry.id !== "Provider default",
          );
          const entry = catalog.find((item) => item.id === profile.model);
          const effortOptions = entry?.efforts?.length
            ? entry.efforts.map((option) => ({
                value: option.id,
                label: option.label ?? option.id,
              }))
            : (FALLBACK_EFFORTS[profile.runtime] ?? ["low", "medium", "high"]).map((id) => ({
                value: id,
                label: id,
              }));
          return (
            <article className="subagent-profile" key={profile.id} data-enabled={profile.enabled}>
              <div className="subagent-profile-head">
                <ProviderIcon provider={profile.runtime} label={profile.label} />
                <input
                  className="subagent-profile-name"
                  aria-label={`Name for the ${profile.runtime} profile`}
                  value={profile.label}
                  onChange={(event) => updateProfile(profile.id, { label: event.target.value })}
                />
                {runtimeInstalled(profile.runtime) ? null : (
                  <span className="subagent-profile-badge">CLI not installed</span>
                )}
                <Switch
                  checked={profile.enabled}
                  onChange={(value) => updateProfile(profile.id, { enabled: value })}
                  label={`Enable delegation to ${profile.label}`}
                />
                <button
                  type="button"
                  className="subagent-profile-remove"
                  aria-label={`Remove the ${profile.label} profile`}
                  onClick={() => updateProfiles(profiles.filter((item) => item.id !== profile.id))}
                >
                  <Trash2 />
                </button>
              </div>
              <div className="subagent-profile-grid">
                <div className="subagent-field">
                  <small>Model</small>
                  {catalog.length > 0 ? (
                    <Dropdown
                      className="compact-select"
                      aria-label={`Model for ${profile.label}`}
                      value={entry?.id ?? catalog[0].id}
                      options={catalog.map((item) => ({
                        value: item.id,
                        label: item.label || item.id,
                      }))}
                      onChange={(value) => {
                        const nextEntry = catalog.find((item) => item.id === value);
                        updateProfile(profile.id, {
                          model: value || undefined,
                          // Keep the effort only when the new model supports it.
                          effort: value
                            ? resolveModelEffort(nextEntry, profile.effort)
                            : profile.effort,
                        });
                      }}
                    />
                  ) : (
                    <input
                      aria-label={`Model for ${profile.label}`}
                      placeholder="Model ID"
                      value={profile.model ?? ""}
                      onChange={(event) =>
                        updateProfile(profile.id, { model: event.target.value || undefined })
                      }
                    />
                  )}
                </div>
                <div className="subagent-field">
                  <small>Reasoning effort</small>
                  <Dropdown
                    className="compact-select"
                    aria-label={`Reasoning effort for ${profile.label}`}
                    value={profile.effort ?? ""}
                    options={[{ value: "", label: "Default effort" }, ...effortOptions]}
                    onChange={(value) => updateProfile(profile.id, { effort: value || undefined })}
                  />
                </div>
                <div className="subagent-field">
                  <small>Cost tier</small>
                  <Dropdown
                    className="compact-select"
                    aria-label={`Cost tier for ${profile.label}`}
                    value={profile.costTier}
                    options={[
                      { value: "low", label: "Low cost" },
                      { value: "medium", label: "Medium cost" },
                      { value: "high", label: "High cost" },
                    ]}
                    onChange={(value) =>
                      updateProfile(profile.id, {
                        costTier: value as DelegationProfileSetting["costTier"],
                      })
                    }
                  />
                </div>
              </div>
              <label className="subagent-profile-instruction">
                <small>Specialist instructions</small>
                <textarea
                  rows={4}
                  maxLength={65_536}
                  aria-label={`Specialist instructions for ${profile.label}`}
                  placeholder="Define this specialist's role, quality bar, workflow, and expected deliverables."
                  value={profile.instruction ?? ""}
                  onChange={(event) =>
                    updateProfile(profile.id, { instruction: event.target.value })
                  }
                  onBlur={(event) =>
                    updateProfile(profile.id, { instruction: event.target.value.trim() })
                  }
                />
              </label>
              <div className="subagent-downstream">
                <span>
                  <small>Preferred downstream helpers</small>
                  <p>
                    Ordered preferences for this specialist's future delegated research and
                    exploration. Recursive launching remains gated by the current one-level policy.
                  </p>
                </span>
                <div>
                  {profiles
                    .filter((candidate) => candidate.id !== profile.id)
                    .map((candidate) => {
                      const selected = (profile.preferredChildProfileIds ?? []).includes(
                        candidate.id,
                      );
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          role="checkbox"
                          aria-checked={selected}
                          data-selected={selected}
                          onClick={() =>
                            updateProfile(profile.id, {
                              preferredChildProfileIds: selected
                                ? (profile.preferredChildProfileIds ?? []).filter(
                                    (id) => id !== candidate.id,
                                  )
                                : [...(profile.preferredChildProfileIds ?? []), candidate.id],
                            })
                          }
                        >
                          <ProviderIcon provider={candidate.runtime} label={candidate.label} />
                          {candidate.label}
                        </button>
                      );
                    })}
                  {profiles.length <= 1 ? (
                    <small>Add another profile to choose a helper.</small>
                  ) : null}
                </div>
              </div>
            </article>
          );
        })}
        <div className="subagent-add-row">
          {DELEGATION_TARGETS.map((target) => (
            <button
              key={target.runtime}
              type="button"
              className="subagent-add"
              onClick={() => addProfile(target)}
            >
              <ProviderIcon provider={target.runtime} label={target.label} />
              Add {target.label}
            </button>
          ))}
        </div>
        <p className="subagent-footnote">
          Orchestrator tools are injected for Claude and Cursor sessions; every listed provider can
          run as a subagent. Claude and Cursor children get subagent tools; Codex, Antigravity, and
          Grok report through their transcript digest. See docs/delegation-broker-v1.md for the
          support matrix.
        </p>
      </section>
    </>
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
  const preset = getThemePreset(preferences.themeId);
  const colors = useMemo(
    () => ({ ...preset.colors, ...preferences.colorOverrides }),
    [preset.colors, preferences.colorOverrides],
  );
  const contrastRatio = (foreground: string, background: string): number | null => {
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
        .map((channel) =>
          channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
        )
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const light = Math.max(luminance(fg), luminance(bg));
    const dark = Math.min(luminance(fg), luminance(bg));
    return (light + 0.05) / (dark + 0.05);
  };
  const contrastWarnings = (
    [
      ["text.primary", "surface.canvas"],
      ["text.secondary", "surface.canvas"],
      ["accent.text", "accent.primary"],
      ["focus.ring", "surface.canvas"],
    ] as Array<[ThemeColorToken, ThemeColorToken]>
  ).filter(
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
          <p>Make the workspace yours without sacrificing code contrast or state clarity.</p>
        </div>
        <button className="secondary-button" type="button" onClick={onReset}>
          <RotateCcw /> Reset
        </button>
      </div>
      <section className="settings-section">
        <header>
          <h2>Theme preset</h2>
          <p>Coordinated palettes. Provider identity never recolors the workspace.</p>
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
          <p>Weight and line height apply to readable content without weakening hit targets.</p>
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
          <p>Every token is previewable and resettable. Changes stay local to this installation.</p>
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

function runtimeConnectionForRequest(
  runtimes: RuntimeConnection[],
  runtimeId: RuntimeId,
): RuntimeConnection {
  return (
    runtimes.find((candidate) => candidate.id === runtimeId) ?? {
      id: runtimeId,
      name: {
        codex: "Codex",
        cursor: "Cursor",
        claude: "Claude Code",
        grok: "Grok Build",
        antigravity: "Antigravity",
        custom: "Custom ACP",
      }[runtimeId],
      command: runtimeId,
      status: "degraded",
      fidelity: "pty",
      models: [],
      detail: "Runtime status will be checked after this action.",
    }
  );
}

function runtimeCertificationSummary(runtime: RuntimeConnection): string | undefined {
  if (runtime.status === "not_installed") return undefined;
  const certification =
    runtime.certification === "certified"
      ? "Certified installed route"
      : runtime.certification === "session_probe_required"
        ? "ACP session probe pending"
        : "Installed route not certified";
  const capabilities = runtime.capabilities;
  if (!capabilities) return certification;
  const observed = [
    capabilities.sessionResume && "session recovery",
    capabilities.authoritativeHistory && "history replay",
    capabilities.structuredToolEvents && "structured tools",
    capabilities.sandboxedWorkspace && "workspace sandbox",
    capabilities.subscriptionAuth && "subscription auth",
    capabilities.hooks && "hooks",
    capabilities.skills && "skills",
  ].filter(Boolean);
  return observed.length > 0 ? `${certification} · ${observed.join(" · ")}` : certification;
}

interface RuntimePlannerState {
  runtime: RuntimeConnection;
  kind: RuntimeActionKind;
  plans: RuntimeActionPlan[];
  selectedId: string;
}

function runtimeActionTitle(planner: RuntimePlannerState): string {
  if (planner.kind === "install") return `Install ${planner.runtime.name}`;
  if (planner.kind === "update") return `Update ${planner.runtime.name}`;
  return `Sign in to ${planner.runtime.name}`;
}

function RuntimeCommandReview({
  planner,
  selectedPlan,
  loading,
  onSelectPlan,
  onCancel,
  onRun,
}: {
  planner: RuntimePlannerState;
  selectedPlan?: RuntimeActionPlan;
  loading: boolean;
  onSelectPlan: (planId: string) => void;
  onCancel: () => void;
  onRun: () => void;
}) {
  const title = runtimeActionTitle(planner);
  return (
    <section
      className="runtime-setup-terminal runtime-command-review"
      role="dialog"
      aria-labelledby="runtime-action-title"
    >
      <header>
        <span>
          <strong id="runtime-action-title">{title}</strong>
          <small>Review the exact local command before anything runs.</small>
        </span>
        <button
          className="icon-button"
          type="button"
          onClick={onCancel}
          aria-label="Cancel runtime command"
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="runtime-command-review-body">
        {loading || !selectedPlan ? (
          <div className="runtime-command-review-loading" role="status">
            <LoaderCircle className="spin-slow" aria-hidden="true" />
            <span>
              <strong>Inspecting documented methods…</strong>
              <small>No command has started.</small>
            </span>
          </div>
        ) : (
          <>
            {planner.plans.length > 1 ? (
              <fieldset className="runtime-methods">
                <legend>Method</legend>
                {planner.plans.map((plan) => (
                  <label key={plan.id} data-available={plan.available}>
                    <input
                      type="radio"
                      name="runtime-method"
                      value={plan.id}
                      checked={planner.selectedId === plan.id}
                      disabled={!plan.available}
                      onChange={() => onSelectPlan(plan.id)}
                    />
                    <span>
                      <strong>
                        {plan.method}
                        {plan.recommended ? " · Recommended" : ""}
                      </strong>
                      <small>{plan.available ? plan.description : plan.unavailableReason}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            <div className="runtime-command-disclosure">
              <span>
                <strong>Command</strong>
                <small>{selectedPlan.method}</small>
              </span>
              <code>{selectedPlan.command}</code>
              <button
                className="icon-button"
                type="button"
                aria-label="Copy runtime command"
                onClick={() => void navigator.clipboard.writeText(selectedPlan.command)}
              >
                <Copy aria-hidden="true" />
              </button>
            </div>
            <p className="runtime-command-review-note">{selectedPlan.environmentNote}</p>
            {selectedPlan.downloadsAndExecutesCode ? (
              <p className="runtime-action-warning">
                <TriangleAlert aria-hidden="true" /> This command downloads and executes vendor code
                and may replace files outside your projects.
              </p>
            ) : null}
            <div className="runtime-action-source">
              <button
                className="text-button"
                type="button"
                disabled={!selectedPlan.sourceUrl}
                onClick={() => void openExternalLink(selectedPlan.sourceUrl)}
              >
                <ExternalLink aria-hidden="true" /> Vendor documentation
              </button>
            </div>
          </>
        )}
      </div>
      <footer className="runtime-command-review-footer">
        <span>Nothing runs until you confirm this exact command.</span>
        <span className="runtime-command-review-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={loading || !selectedPlan?.available}
            onClick={onRun}
          >
            Run this command
          </button>
        </span>
      </footer>
    </section>
  );
}

function ModelsAndRuntimesSettings({
  runtimes,
  settings,
  setSetting,
  actionRequest,
  onRefreshRuntimes,
}: {
  runtimes: RuntimeConnection[];
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
  actionRequest?: RuntimeActionRequest | null;
  onRefreshRuntimes?: () => Promise<RuntimeConnection[]>;
}) {
  const reduceMotion =
    Boolean(useReducedMotion()) || document.documentElement.dataset.motion === "none";
  const handledRequest = useRef(0);
  const plannerRequestSequence = useRef(0);
  const [planner, setPlanner] = useState<RuntimePlannerState | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [checking, setChecking] = useState(false);
  const [activePlan, setActivePlan] = useState<RuntimeActionPlan | null>(null);
  const [configuringRuntime, setConfiguringRuntime] = useState<RuntimeId | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, ModelCatalogEntry[]>>({});
  const catalogLoads = useRef(new Set<RuntimeId>());
  const [message, setMessage] = useState("");

  const configuredDefaultRuntime = readSetting<string>(settings, "models.defaultRuntime", "");
  const favoriteRuntime =
    typeof configuredDefaultRuntime === "string" &&
    configuredDefaultRuntime.length > 0 &&
    runtimes.some((runtime) => runtime.id === configuredDefaultRuntime)
      ? (configuredDefaultRuntime as RuntimeId)
      : null;
  const routeDefaults = normalizeRuntimeRouteDefaults(settings[RUNTIME_ROUTE_DEFAULTS_SETTING]);

  const fallbackCatalog = useCallback(
    (runtime: RuntimeId) =>
      runtimes
        .find((connection) => connection.id === runtime)
        ?.models.filter((id) => id !== "Provider default")
        .map((id) => ({ id, label: id })) ?? [],
    [runtimes],
  );

  const catalogFor = (runtime: RuntimeId) =>
    (catalogs[runtime] ?? fallbackCatalog(runtime)).filter(
      (entry) => entry.id !== "Provider default",
    );

  const loadCatalog = useCallback(
    (runtime: RuntimeId) => {
      if (Object.hasOwn(catalogs, runtime) || catalogLoads.current.has(runtime)) return;
      catalogLoads.current.add(runtime);
      void bridge
        .listModelCatalog(runtime)
        .then((entries) =>
          setCatalogs((current) => ({
            ...current,
            [runtime]: entries.filter((entry) => entry.id !== "Provider default"),
          })),
        )
        .catch(() =>
          setCatalogs((current) => ({ ...current, [runtime]: fallbackCatalog(runtime) })),
        )
        .finally(() => catalogLoads.current.delete(runtime));
    },
    [catalogs, fallbackCatalog],
  );

  const resolvedRoute = (runtime: RuntimeId) => {
    const saved = readRuntimeRouteDefault(settings, runtime);
    const catalog = catalogFor(runtime);
    const model = catalog.some((entry) => entry.id === saved.model)
      ? (saved.model ?? "")
      : (catalog[0]?.id ?? saved.model ?? "");
    const entry = catalog.find((candidate) => candidate.id === model);
    return {
      catalog,
      model,
      entry,
      effort: resolveModelEffort(entry, saved.effort),
      effortOptions: entry?.efforts ?? [],
      loaded: Object.hasOwn(catalogs, runtime),
    };
  };

  const writeRuntimeRoute = (
    runtime: RuntimeId,
    model: string,
    effort: string | undefined,
    mirrorGlobal = runtime === favoriteRuntime,
  ) => {
    setSetting(RUNTIME_ROUTE_DEFAULTS_SETTING, {
      ...routeDefaults,
      [runtime]: { model, ...(effort ? { effort } : {}) },
    });
    if (!mirrorGlobal) return;
    setSetting("models.defaultModel", model);
    setSetting("models.defaultEffort", effort ?? "");
  };

  const changeFavoriteRuntime = (value: string) => {
    const nextRuntime = value ? (value as RuntimeId) : null;
    const nextDefaults = { ...routeDefaults };
    const preserveRoute = (runtime: RuntimeId) => {
      const saved = readRuntimeRouteDefault(settings, runtime);
      const route = resolvedRoute(runtime);
      const model = route.model || route.catalog[0]?.id || "";
      const entry = route.catalog.find((candidate) => candidate.id === model);
      const effort = route.loaded
        ? resolveModelEffort(entry, route.effort)
        : (saved.effort ?? resolveModelEffort(entry, route.effort));
      nextDefaults[runtime] = { model, ...(effort ? { effort } : {}) };
      return { model, effort };
    };

    if (favoriteRuntime) preserveRoute(favoriteRuntime);
    const nextRoute = nextRuntime ? preserveRoute(nextRuntime) : null;
    setSetting(RUNTIME_ROUTE_DEFAULTS_SETTING, nextDefaults);
    setSetting("models.defaultRuntime", nextRuntime ?? "");
    if (!nextRuntime || !nextRoute) return;
    setSetting("models.defaultModel", nextRoute.model);
    setSetting("models.defaultEffort", nextRoute.effort ?? "");
    loadCatalog(nextRuntime);
  };

  const cancelPlanner = useCallback(() => {
    plannerRequestSequence.current += 1;
    setPlanner(null);
    setLoadingPlan(false);
  }, []);

  const openPlanner = useCallback(async (runtime: RuntimeConnection, kind: RuntimeActionKind) => {
    const requestId = ++plannerRequestSequence.current;
    setConfiguringRuntime(null);
    setActivePlan(null);
    setPlanner({ runtime, kind, plans: [], selectedId: "" });
    setLoadingPlan(true);
    setMessage(`Inspecting documented ${kind} methods for ${runtime.name}…`);
    try {
      const plans = await bridge.listRuntimeActionPlans(runtime.id, kind);
      if (requestId !== plannerRequestSequence.current) return;
      if (plans.length === 0) {
        setPlanner(null);
        setMessage(
          `No documented ${kind} command is available for ${runtime.name} on this system.`,
        );
        return;
      }
      const selected =
        plans.find((plan) => plan.recommended && plan.available) ??
        plans.find((plan) => plan.available) ??
        plans[0];
      setPlanner({ runtime, kind, plans, selectedId: selected?.id ?? "" });
      setMessage("");
    } catch (error) {
      if (requestId !== plannerRequestSequence.current) return;
      setPlanner(null);
      setMessage(
        error instanceof Error ? error.message : `Could not inspect ${runtime.name} setup.`,
      );
    } finally {
      if (requestId === plannerRequestSequence.current) setLoadingPlan(false);
    }
  }, []);

  useEffect(() => {
    if (!actionRequest || handledRequest.current === actionRequest.id) return;
    handledRequest.current = actionRequest.id;
    void openPlanner(
      runtimeConnectionForRequest(runtimes, actionRequest.runtime),
      actionRequest.kind,
    );
  }, [actionRequest, openPlanner, runtimes]);

  const refresh = async (name?: string) => {
    if (!onRefreshRuntimes) return;
    setChecking(true);
    setMessage(name ? `Checking ${name} again…` : "Checking installed runtimes…");
    try {
      await onRefreshRuntimes();
      setMessage(
        name ? `${name} checked again after the command finished.` : "Runtime status refreshed.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Runtime status could not be refreshed.");
    } finally {
      setChecking(false);
    }
  };

  const selectedPlan = planner?.plans.find((plan) => plan.id === planner.selectedId);
  const terminalRuntime = activePlan?.provider ?? planner?.runtime.id;
  const focusedRuntime = terminalRuntime ?? configuringRuntime ?? undefined;
  const visibleRuntimes = focusedRuntime
    ? runtimes.filter((runtime) => runtime.id === focusedRuntime)
    : runtimes;
  const configuredRoute = configuringRuntime ? resolvedRoute(configuringRuntime) : null;
  const startSelectedPlan = () => {
    if (!selectedPlan?.available) return;
    setActivePlan(selectedPlan);
    setPlanner(null);
  };

  return (
    <>
      <div className="settings-page-heading models-runtimes-heading">
        <span>
          <Bot />
        </span>
        <div>
          <h1>Models and Runtimes</h1>
          <p>Manage local CLIs and the route each one should prefer.</p>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void refresh()}
          disabled={checking}
          aria-busy={checking}
        >
          <RefreshCw className={checking ? "spin-slow" : undefined} aria-hidden="true" />
          {checking ? "Checking…" : "Check all"}
        </button>
      </div>
      <motion.div
        className="runtime-settings-stage"
        data-focused={Boolean(focusedRuntime)}
        data-terminal-active={Boolean(terminalRuntime)}
        layout={!reduceMotion}
        transition={reduceMotion ? { duration: 0 } : navPillSpring}
      >
        <section className="settings-section runtime-library-section">
          <header className="runtime-library-header">
            <div>
              <h2>Runtime library</h2>
              <p>Install, authenticate, update, and keep a preferred route for every local CLI.</p>
            </div>
            {configuringRuntime ? (
              <button
                className="secondary-button runtime-library-back"
                type="button"
                onClick={() => setConfiguringRuntime(null)}
              >
                <ArrowLeft aria-hidden="true" /> Back
              </button>
            ) : null}
          </header>
          <div className="settings-runtime-list">
            <AnimatePresence initial={false} mode="popLayout">
              {visibleRuntimes.map((runtime, index) => (
                <motion.div
                  key={runtime.id}
                  className="settings-runtime-row"
                  data-active={runtime.id === focusedRuntime}
                  layout={!reduceMotion}
                  layoutId={reduceMotion ? undefined : `runtime-row-${runtime.id}`}
                  initial={
                    reduceMotion ? false : { opacity: 0, y: 10, scale: 0.985, filter: "blur(5px)" }
                  }
                  animate={{ opacity: 1, x: 0, y: 0, scale: 1, filter: "blur(0px)" }}
                  exit={
                    reduceMotion
                      ? { opacity: 0 }
                      : {
                          opacity: 0,
                          x: index % 2 === 0 ? -18 : 18,
                          y: 5,
                          scale: 0.975,
                          filter: "blur(7px)",
                        }
                  }
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : {
                          layout: { type: "spring", stiffness: 360, damping: 34, mass: 0.8 },
                          opacity: { duration: 0.2 },
                          filter: { duration: 0.22 },
                          x: { duration: 0.24, ease: [0.2, 0, 0, 1] },
                        }
                  }
                >
                  <span className={`runtime-logo runtime-logo--${runtime.id}`}>
                    <ProviderIcon provider={runtime.id} label={runtime.name} />
                  </span>
                  <span className="runtime-row-info">
                    <span className="runtime-row-title">
                      <strong>
                        {runtime.name}
                        <small data-status={runtime.status}>
                          {runtime.status.replace("_", " ")}
                        </small>
                      </strong>
                      <code>{runtime.version ?? "Version not reported"}</code>
                      {runtime.status !== "not_installed" && configuringRuntime !== runtime.id ? (
                        <Tooltip label={`Edit defaults for ${runtime.name}`}>
                          <button
                            className="icon-button subtle runtime-defaults-button"
                            type="button"
                            aria-label={`Edit defaults for ${runtime.name}`}
                            onClick={() => {
                              setConfiguringRuntime(runtime.id);
                              loadCatalog(runtime.id);
                              setMessage("");
                            }}
                          >
                            <Settings aria-hidden="true" />
                          </button>
                        </Tooltip>
                      ) : null}
                    </span>
                    <p>{runtime.detail}</p>
                    {runtimeCertificationSummary(runtime) ? (
                      <small
                        className="runtime-certification"
                        data-certification={runtime.certification}
                      >
                        {runtimeCertificationSummary(runtime)}
                      </small>
                    ) : null}
                    <code className="runtime-executable">{runtime.command}</code>
                  </span>
                  <span className="runtime-row-actions">
                    {runtime.status === "not_installed" ? (
                      <button
                        className="primary-button"
                        type="button"
                        onClick={() => void openPlanner(runtime, "install")}
                        disabled={loadingPlan}
                      >
                        Install
                      </button>
                    ) : (
                      <>
                        <button
                          className={
                            runtime.status === "login_required"
                              ? "primary-button"
                              : "secondary-button"
                          }
                          type="button"
                          onClick={() => void openPlanner(runtime, "login")}
                          disabled={loadingPlan}
                        >
                          Sign in
                        </button>
                        <button
                          className={
                            runtime.status === "degraded" ? "primary-button" : "secondary-button"
                          }
                          type="button"
                          onClick={() => void openPlanner(runtime, "update")}
                          disabled={loadingPlan}
                        >
                          Update
                        </button>
                      </>
                    )}
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
          <AnimatePresence initial={false} mode="popLayout">
            {!focusedRuntime ? (
              <motion.div
                className="runtime-favorite-setting"
                key="runtime-favorite-setting"
                layout={!reduceMotion}
                initial={reduceMotion ? false : { opacity: 0, y: -5, filter: "blur(3px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={
                  reduceMotion
                    ? { opacity: 0 }
                    : {
                        opacity: 0,
                        y: -7,
                        filter: "blur(4px)",
                        transition: { duration: 0.15, ease: [0.4, 0, 1, 1] },
                      }
                }
                transition={
                  reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.2, 0, 0, 1] }
                }
              >
                <span>
                  <strong>Favorite runtime</strong>
                  <small>
                    New chats use this runtime; Last used follows your previous session.
                  </small>
                </span>
                <Dropdown
                  aria-label="Favorite runtime"
                  value={favoriteRuntime ?? ""}
                  onChange={changeFavoriteRuntime}
                  options={[
                    { value: "", label: "Last used" },
                    ...runtimes
                      .filter((runtime) => runtime.status !== "not_installed")
                      .map((runtime) => ({
                        value: runtime.id,
                        label: runtime.name,
                        icon: <ProviderIcon provider={runtime.id} label={runtime.name} />,
                      })),
                  ]}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </section>
        <AnimatePresence initial={false} mode="popLayout">
          {focusedRuntime ? (
            <motion.div
              className={terminalRuntime ? "runtime-terminal-stage" : "runtime-defaults-stage"}
              key={
                terminalRuntime ? `terminal-stage-${terminalRuntime}` : `defaults-${focusedRuntime}`
              }
              layout={!reduceMotion}
              initial={
                reduceMotion
                  ? false
                  : {
                      opacity: 0,
                      y: 14,
                      scale: 0.985,
                    }
              }
              animate={
                reduceMotion
                  ? { opacity: 1 }
                  : {
                      opacity: 1,
                      y: 0,
                      scale: 1,
                      transition: {
                        layout: { duration: 0.28, ease: [0.2, 0, 0, 1] },
                        opacity: { duration: 0.24, ease: [0.2, 0, 0, 1] },
                        y: { duration: 0.24, ease: [0.2, 0, 0, 1] },
                        scale: { duration: 0.24, ease: [0.2, 0, 0, 1] },
                      },
                    }
              }
              exit={
                reduceMotion
                  ? { opacity: 0, transition: { duration: 0 } }
                  : {
                      opacity: 0,
                      y: 8,
                      scale: 0.985,
                      transition: { duration: 0.16, ease: [0.4, 0, 1, 1] },
                    }
              }
              style={{ transformOrigin: "top center" }}
            >
              <AnimatePresence initial={false} mode="wait">
                {configuringRuntime && configuredRoute ? (
                  <motion.section
                    className="runtime-default-editor"
                    aria-labelledby={`runtime-default-editor-${configuringRuntime}`}
                    key={`defaults-${configuringRuntime}`}
                    layout={!reduceMotion}
                    initial={reduceMotion ? false : { opacity: 0, y: 10, filter: "blur(4px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    exit={
                      reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, filter: "blur(4px)" }
                    }
                    transition={
                      reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.2, 0, 0, 1] }
                    }
                  >
                    <header>
                      <span>
                        <ProviderIcon
                          provider={configuringRuntime}
                          label={
                            runtimes.find((runtime) => runtime.id === configuringRuntime)?.name ??
                            configuringRuntime
                          }
                        />
                      </span>
                      <div>
                        <h3 id={`runtime-default-editor-${configuringRuntime}`}>
                          {runtimes.find((runtime) => runtime.id === configuringRuntime)?.name ??
                            configuringRuntime}{" "}
                          defaults
                        </h3>
                      </div>
                    </header>
                    <SettingRow
                      label="Preferred model"
                      description="Used when this runtime is selected; still adjustable before every send."
                    >
                      <Dropdown
                        aria-label={`Preferred model for ${configuringRuntime}`}
                        value={configuredRoute.model}
                        onOpen={() => loadCatalog(configuringRuntime)}
                        onChange={(value) => {
                          const entry = configuredRoute.catalog.find(
                            (candidate) => candidate.id === value,
                          );
                          writeRuntimeRoute(
                            configuringRuntime,
                            value,
                            resolveModelEffort(entry, configuredRoute.effort),
                          );
                        }}
                        options={
                          configuredRoute.catalog.length > 0
                            ? configuredRoute.catalog.map((entry) => ({
                                value: entry.id,
                                label: entry.label,
                              }))
                            : [
                                {
                                  value: "",
                                  label: configuredRoute.loaded
                                    ? "Model unavailable"
                                    : "Checking model…",
                                  disabled: true,
                                },
                              ]
                        }
                      />
                    </SettingRow>
                    <SettingRow
                      label="Preferred effort"
                      description="Only provider-advertised reasoning levels are offered."
                    >
                      {configuredRoute.effortOptions.length > 0 ? (
                        <Dropdown
                          aria-label={`Preferred effort for ${configuringRuntime}`}
                          value={configuredRoute.effort ?? configuredRoute.effortOptions[0]?.id}
                          onChange={(value) =>
                            writeRuntimeRoute(configuringRuntime, configuredRoute.model, value)
                          }
                          options={configuredRoute.effortOptions.map((option) => ({
                            value: option.id,
                            label: option.label,
                          }))}
                        />
                      ) : (
                        <span
                          className="settings-unavailable"
                          aria-label={`Preferred effort unavailable for ${configuringRuntime}`}
                        >
                          {configuredRoute.loaded
                            ? "Not exposed by this model"
                            : "Checking capability…"}
                        </span>
                      )}
                    </SettingRow>
                  </motion.section>
                ) : activePlan ? (
                  <motion.div
                    className="runtime-terminal-content"
                    key={`terminal-${activePlan.id}`}
                    layout={!reduceMotion}
                    initial={
                      reduceMotion
                        ? false
                        : {
                            opacity: 0,
                            y: 8,
                            scale: 0.99,
                          }
                    }
                    animate={
                      reduceMotion
                        ? { opacity: 1 }
                        : {
                            opacity: 1,
                            y: 0,
                            scale: 1,
                          }
                    }
                    exit={
                      reduceMotion
                        ? { opacity: 0 }
                        : {
                            opacity: 0,
                            y: -8,
                            scale: 0.99,
                            transition: { duration: 0.1, ease: [0.4, 0, 1, 1] },
                          }
                    }
                    transition={
                      reduceMotion
                        ? { duration: 0 }
                        : {
                            layout: { duration: 0.28, ease: [0.2, 0, 0, 1] },
                            opacity: { duration: 0.24, ease: [0.2, 0, 0, 1] },
                            y: { duration: 0.24, ease: [0.2, 0, 0, 1] },
                            scale: { duration: 0.24, ease: [0.2, 0, 0, 1] },
                          }
                    }
                    style={{ transformOrigin: "top center" }}
                  >
                    <RuntimeSetupTerminal
                      plan={activePlan}
                      onClose={() => setActivePlan(null)}
                      onExit={() =>
                        void refresh(
                          runtimes.find((runtime) => runtime.id === activePlan.provider)?.name,
                        )
                      }
                    />
                  </motion.div>
                ) : planner ? (
                  <motion.div
                    className="runtime-terminal-content"
                    key={`review-${planner.runtime.id}-${planner.kind}`}
                    initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.99 }}
                    animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.99 }}
                    transition={
                      reduceMotion
                        ? { duration: 0 }
                        : {
                            opacity: { duration: 0.2, ease: [0.2, 0, 0, 1] },
                            y: { duration: 0.2, ease: [0.2, 0, 0, 1] },
                            scale: { duration: 0.2, ease: [0.2, 0, 0, 1] },
                          }
                    }
                  >
                    <RuntimeCommandReview
                      planner={planner}
                      selectedPlan={selectedPlan}
                      loading={loadingPlan}
                      onSelectPlan={(selectedId) =>
                        setPlanner((current) => (current ? { ...current, selectedId } : current))
                      }
                      onCancel={cancelPlanner}
                      onRun={startSelectedPlan}
                    />
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
      {message ? (
        <p className="settings-action-message" role="status">
          {message}
        </p>
      ) : null}
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const nextUnit of units) {
    value /= 1024;
    unit = nextUnit;
    if (value < 1024 || nextUnit === units[units.length - 1]) break;
  }
  return `${value.toFixed(value >= 10 || unit === "KB" ? 0 : 1)} ${unit}`;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function providerUsageLabel(provider: ProviderUsageSummary["provider"]): string {
  if (provider === "unknown") return "Unknown runtime";
  return provider === "custom" ? "Custom runtime" : provider[0].toUpperCase() + provider.slice(1);
}

function formatEstimatedCost(usd: number): string {
  if (usd > 0 && usd < 0.0001) return "<$0.0001";
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}

/** Labels a rate-limit window by its provider-reported duration; the labels
 * are derived, never assumed (Codex documents primary/secondary only via
 * windowDurationMins). */
function quotaWindowLabel(mins?: number): string {
  if (!mins) return "window";
  if (Math.abs(mins - 300) <= 15) return "5h";
  if (Math.abs(mins - 1440) <= 72) return "daily";
  if (Math.abs(mins - 10080) <= 504) return "weekly";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

function formatSubscription(quota: SubscriptionQuota): string {
  const windows = [quota.primary, quota.secondary]
    .filter((window): window is SubscriptionWindow => window != null)
    .map(
      (window) =>
        `${Math.round(window.usedPercent)}% of ${quotaWindowLabel(window.windowDurationMins)}`,
    );
  return windows.length > 0 ? windows.join(" · ") : "—";
}

function usageProvenanceLabel(provenance: ProviderUsageSummary["provenance"]): string {
  return {
    vendor_exact: "Vendor exact",
    local_observed: "Local observed",
    estimated: "Estimated",
    unavailable: "Unavailable",
  }[provenance];
}

function StorageTotalsSettings() {
  const [totals, setTotals] = useState<StorageTotals | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    void bridge
      .getStorageTotals()
      .then((next) => {
        if (active) setTotals(next);
      })
      .catch((error) => {
        if (active)
          setMessage(error instanceof Error ? error.message : "Storage totals unavailable.");
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="settings-section">
      <header>
        <h2>Storage totals</h2>
        <p>
          Measured local footprint for AI Integrator data; repositories and vendor stores are not
          included.
        </p>
      </header>
      {totals ? (
        <>
          <div className="settings-storage-grid">
            <div>
              <span>Total local footprint</span>
              <strong>{formatBytes(totals.totalBytes)}</strong>
            </div>
            <div>
              <span>{totals.kind === "sqlite" ? "SQLite database" : "Browser local storage"}</span>
              <strong>{formatBytes(totals.databaseBytes)}</strong>
            </div>
            <div>
              <span>SQLite WAL</span>
              <strong>{formatBytes(totals.walBytes)}</strong>
            </div>
            <div>
              <span>Shared memory</span>
              <strong>{formatBytes(totals.sharedMemoryBytes)}</strong>
            </div>
          </div>
          <p className="settings-measured-note">
            Measured {new Date(totals.measuredAt).toLocaleString()} ·{" "}
            {totals.kind === "sqlite" ? "native SQLite files" : "browser preview storage"}.
          </p>
        </>
      ) : (
        <div className="settings-empty">{message || "Measuring local storage…"}</div>
      )}
    </section>
  );
}

function UsageSettings({
  usage,
  runtimes,
}: {
  usage: UsageSnapshot;
  runtimes: RuntimeConnection[];
}) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    void bridge
      .getUsageSummary()
      .then((next) => {
        if (active) setSummary(next);
      })
      .catch((error) => {
        if (active)
          setMessage(error instanceof Error ? error.message : "Provider usage unavailable.");
      });
    return () => {
      active = false;
    };
  }, []);

  const summaryByProvider = new Map(summary?.providers.map((row) => [row.provider, row]) ?? []);
  const providerRows: ProviderUsageSummary[] = runtimes.map((runtime) => {
    return (
      summaryByProvider.get(runtime.id) ?? {
        provider: runtime.id,
        taskCount: 0,
        turnCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        provenance: "unavailable",
        detail: "No provider token usage has been reported for this runtime.",
      }
    );
  });
  for (const row of summary?.providers ?? []) {
    if (!providerRows.some((current) => current.provider === row.provider)) providerRows.push(row);
  }

  return (
    <>
      <div className="settings-page-heading">
        <span>
          <CircleDollarSign />
        </span>
        <div>
          <h1>Usage and Budgets</h1>
          <p>Plan limits, processed tokens, cost estimates, and actual charges stay separate.</p>
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
          <h2>Per-provider usage</h2>
          <p>
            Persisted native projections are exact where a provider reports them; missing data stays
            unavailable.
          </p>
        </header>
        {providerRows.length > 0 ? (
          <div className="settings-provider-usage">
            {providerRows.map((row) => (
              <article className="settings-provider-row" key={row.provider}>
                <div className="settings-provider-name">
                  <strong>{providerUsageLabel(row.provider)}</strong>
                  <small>{row.detail}</small>
                </div>
                <div className="settings-provider-stat">
                  <span>Tasks / turns</span>
                  <strong>
                    {row.taskCount} / {row.turnCount}
                  </strong>
                </div>
                <div className="settings-provider-stat">
                  <span>Processed tokens</span>
                  <strong>{formatTokens(row.totalTokens)}</strong>
                </div>
                <div className="settings-provider-stat">
                  <span>API cost estimate</span>
                  <strong>
                    {row.estimatedCostUsd != null && row.estimatedCostUsd > 0
                      ? formatEstimatedCost(row.estimatedCostUsd)
                      : "—"}
                  </strong>
                </div>
                <div className="settings-provider-stat">
                  <span>Subscription used</span>
                  <strong>{row.subscription ? formatSubscription(row.subscription) : "—"}</strong>
                </div>
                <div className="settings-provider-breakdown">
                  <span>Input {formatTokens(row.inputTokens)}</span>
                  <span>Cached {formatTokens(row.cachedInputTokens)}</span>
                  <span>Output {formatTokens(row.outputTokens)}</span>
                  <span>Reasoning {formatTokens(row.reasoningOutputTokens)}</span>
                </div>
                <span className={`settings-usage-badge settings-usage-badge--${row.provenance}`}>
                  {usageProvenanceLabel(row.provenance)}
                </span>
              </article>
            ))}
          </div>
        ) : (
          <div className="settings-empty">
            {message || "No provider usage has been recorded yet."}
          </div>
        )}
        {summary ? (
          <p className="settings-measured-note">
            Measured {new Date(summary.measuredAt).toLocaleString()} · Processed-token and plan
            totals are never inferred.
          </p>
        ) : message ? (
          <p className="settings-action-message" role="status">
            {message}
          </p>
        ) : null}
      </section>
    </>
  );
}

interface PolicySettingsProps {
  section: "general" | "composer" | "permissions";
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
  appInfo: LocalAppInfo;
  onExportSettings: () => void;
  onExportData: () => void;
  onImport: () => void;
  onClear: () => void;
  actionMessage: string;
}

function PolicySettings({
  section,
  settings,
  setSetting,
  appInfo,
  onExportSettings,
  onExportData,
  onImport,
  onClear,
  actionMessage,
}: PolicySettingsProps) {
  const page = {
    general: {
      icon: MonitorCog,
      title: "General",
      subtitle: "Local installation preferences and data portability.",
    },
    composer: {
      icon: Braces,
      title: "Composer",
      subtitle: "Keep task intent primary while the send gesture stays predictable.",
    },
    permissions: {
      icon: ShieldCheck,
      title: "Permissions",
      subtitle: "Make the safe path fast while keeping broader authority explicit and reversible.",
    },
  }[section];
  const Icon = page.icon;
  if (section === "general")
    return (
      <>
        <div className="settings-page-heading">
          <span>
            <Icon />
          </span>
          <div>
            <h1>{page.title}</h1>
            <p>{page.subtitle}</p>
          </div>
        </div>
        <section className="settings-section">
          <header>
            <h2>Startup and safety</h2>
            <p>These choices apply locally and never create an AI Integrator account.</p>
          </header>
          <SettingRow
            label="Restore last workspace"
            description="Reopen the last project and chat after restart. Off starts on the project list."
          >
            <Switch
              checked={readSetting(settings, "general.openLastWorkspace", true)}
              onChange={(value) => setSetting("general.openLastWorkspace", value)}
              label="Restore last workspace"
            />
          </SettingRow>
          <SettingRow
            label="Automatically resume interrupted responses"
            description="After a crash or lost connection, reconnect the provider and continue from its last safe boundary. Off leaves a Resume control above the composer."
          >
            <Switch
              checked={readSetting(settings, "general.autoResumeInterruptedTurns", false)}
              onChange={(value) => setSetting("general.autoResumeInterruptedTurns", value)}
              label="Automatically resume interrupted responses"
            />
          </SettingRow>
          <SettingRow
            label="Confirm external actions"
            description="Ask before a link opens in your default browser."
          >
            <Switch
              checked={readSetting(settings, "general.confirmExternalActions", true)}
              onChange={(value) => setSetting("general.confirmExternalActions", value)}
              label="Confirm external actions"
            />
          </SettingRow>
          <SettingRow
            label="Save context on edit"
            description="When you edit a prompt and send again, keep the discarded replies below it as context for the model. The chat view still clears past that message. Off starts the new turn from earlier history only."
          >
            <Switch
              checked={readSetting(settings, "general.saveContextOnEdit", false)}
              onChange={(value) => setSetting("general.saveContextOnEdit", value)}
              label="Save context on edit"
            />
          </SettingRow>
        </section>
        <VoiceTypingSettings />
        <section className="settings-section">
          <header>
            <h2>Local data location</h2>
            <p>
              The exact application-data directory is shown so the local boundary stays inspectable.
            </p>
          </header>
          <div className="settings-location">
            <Database />
            <span>
              <strong>{appInfo.dataDirectory}</strong>
              <small>
                SQLite settings, task metadata, indexes, and redacted diagnostics · schema{" "}
                {appInfo.domainSchemaVersion}
              </small>
            </span>
          </div>
          <div className="settings-callout">
            <ShieldCheck />
            <span>
              <strong>Accountless by design</strong>
              <small>
                There is no Integrator account, cloud transcript store, mandatory telemetry, or
                credential proxy.
              </small>
            </span>
          </div>
        </section>
        <StorageTotalsSettings />
        <section className="settings-section danger-zone">
          <header>
            <h2>Portability and deletion</h2>
            <p>
              Exports omit credentials, secure terminal input, hidden policy data, and raw
              environment values.
            </p>
          </header>
          <div className="data-actions">
            <button className="secondary-button" type="button" onClick={onExportSettings}>
              <Download /> Export settings &amp; theme
            </button>
            <button className="secondary-button" type="button" onClick={onExportData}>
              <Save /> Export local data
            </button>
            <button className="secondary-button" type="button" onClick={onImport}>
              <Upload /> Import settings
            </button>
            <button className="danger-button" type="button" onClick={onClear}>
              <Trash2 /> Delete local data…
            </button>
          </div>
          {actionMessage ? (
            <p className="settings-action-message" role="status">
              {actionMessage}
            </p>
          ) : null}
        </section>
      </>
    );
  if (section === "composer")
    return (
      <>
        <div className="settings-page-heading">
          <span>
            <Icon />
          </span>
          <div>
            <h1>{page.title}</h1>
            <p>{page.subtitle}</p>
          </div>
        </div>
        <section className="settings-section">
          <header>
            <h2>Turn behavior</h2>
            <p>The send gesture applies to every chat composer immediately.</p>
          </header>
          <SettingRow
            label="Enter key"
            description="Choose whether Enter sends or inserts a new line. Ctrl+Enter always sends."
          >
            <Dropdown
              aria-label="Enter key"
              value={readSetting(settings, "composer.enterToSend", true) ? "send" : "newline"}
              onChange={(value) => setSetting("composer.enterToSend", value === "send")}
              options={[
                { value: "send", label: "Send message" },
                { value: "newline", label: "New line" },
              ]}
            />
          </SettingRow>
        </section>
        <section className="settings-section">
          <header>
            <h2>Transcript</h2>
            <p>Metadata shown above each agent reply in every chat.</p>
          </header>
          <SettingRow label="Model attribution" description="Show which model produced each reply.">
            <Dropdown
              aria-label="Model attribution"
              value={readSetting(settings, "transcript.showModel", true) ? "show" : "hide"}
              onChange={(value) => setSetting("transcript.showModel", value === "show")}
              options={[
                { value: "show", label: "Show" },
                { value: "hide", label: "Hide" },
              ]}
            />
          </SettingRow>
          <SettingRow
            label="Timestamps"
            description="Show the clock time above replies and on your messages."
          >
            <Dropdown
              aria-label="Timestamps"
              value={readSetting(settings, "transcript.showTimestamps", true) ? "show" : "hide"}
              onChange={(value) => setSetting("transcript.showTimestamps", value === "show")}
              options={[
                { value: "show", label: "Show" },
                { value: "hide", label: "Hide" },
              ]}
            />
          </SettingRow>
          <SettingRow
            label="Activity detail"
            description="Summary collapses every tool step, Normal groups runs of activity, and Verbose shows each event."
          >
            <Dropdown
              aria-label="Activity detail"
              value={readSetting(settings, "transcript.activityDensity", "normal")}
              onChange={(value) => setSetting("transcript.activityDensity", value)}
              options={[
                { value: "summary", label: "Summary" },
                { value: "normal", label: "Normal" },
                { value: "verbose", label: "Verbose" },
              ]}
            />
          </SettingRow>
        </section>
      </>
    );
  return (
    <>
      <div className="settings-page-heading">
        <span>
          <Icon />
        </span>
        <div>
          <h1>{page.title}</h1>
          <p>{page.subtitle}</p>
        </div>
      </div>
      <section className="settings-section">
        <header>
          <h2>Default permission profile</h2>
          <p>Preselected in the composer for new chats; every turn can still narrow or widen it.</p>
        </header>
        <SettingRow
          label="Default profile"
          description="Applied to the permission picker when a new chat's composer opens."
        >
          <Dropdown
            aria-label="Default profile"
            value={readSetting(settings, "permissions.defaultProfile", "project-write")}
            onChange={(value) => setSetting("permissions.defaultProfile", value)}
            options={[
              { value: "read-only", label: "Read only" },
              { value: "project-write", label: "Project write" },
              { value: "ask", label: "Ask as needed" },
              { value: "full-access", label: "Full access · explicit" },
            ]}
          />
        </SettingRow>
      </section>
    </>
  );
}

function VoiceTypingSettings() {
  const [status, setStatus] = useState<VoiceTypingCredentialStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    const getCredentialStatus = bridge.getVoiceTypingCredentialStatus;
    if (getCredentialStatus) {
      void getCredentialStatus()
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch((error) => {
          if (active)
            setMessage(error instanceof Error ? error.message : "Could not read key status.");
        });
    }
    return () => {
      active = false;
    };
  }, []);

  const save = async () => {
    if (!apiKey.trim() || busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (!bridge.setVoiceTypingCredential) {
        throw new Error("Secure BYOK storage is unavailable in this app build.");
      }
      const next = await bridge.setVoiceTypingCredential(apiKey);
      setStatus(next);
      setApiKey("");
      setMessage(
        "Saved in the operating system credential store. The key is not exported or shown again.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save the OpenAI API key.");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (!bridge.clearVoiceTypingCredential) {
        throw new Error("Secure BYOK storage is unavailable in this app build.");
      }
      await bridge.clearVoiceTypingCredential();
      setStatus((current) => (current ? { ...current, configured: false } : current));
      setMessage("Removed the OpenAI API key from the operating system credential store.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not remove the OpenAI API key.");
    } finally {
      setBusy(false);
    }
  };

  const nativeOnly = status?.storage === "native-only";
  return (
    <section className="settings-section">
      <header>
        <h2>Voice typing · bring your own key</h2>
        <p>Paste your own OpenAI API key to enable realtime transcription from the composer mic.</p>
      </header>
      <div className={`settings-callout ${nativeOnly ? "settings-callout--warning" : ""}`}>
        <Mic />
        <span>
          <strong>
            {nativeOnly
              ? "Native app storage required"
              : status?.configured
                ? "OpenAI STT is configured"
                : "No OpenAI STT key configured"}
          </strong>
          <small>
            {nativeOnly
              ? "Browser preview never stores BYOK secrets. Use the installed desktop app for OS credential storage."
              : "The renderer never receives the saved key; audio is sent only while you hold an active voice-typing session."}
          </small>
        </span>
      </div>
      <div className="credential-form">
        <label className="credential-input-label">
          <span>OpenAI API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={status?.configured ? "Paste a replacement key" : "Paste your key"}
            aria-label="OpenAI API key for voice typing"
            autoComplete="off"
            spellCheck={false}
            disabled={nativeOnly || busy}
          />
        </label>
        <div className="credential-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => void save()}
            disabled={nativeOnly || busy || !apiKey.trim()}
          >
            <KeyRound /> {busy ? "Saving…" : "Save key"}
          </button>
          {status?.configured ? (
            <button
              className="danger-button"
              type="button"
              onClick={() => void clear()}
              disabled={busy}
            >
              Remove key
            </button>
          ) : null}
        </div>
      </div>
      {message ? (
        <p className="settings-action-message" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}

// Same spring as the chat sidebar's traveling selection pill.
function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return "just now";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const AUTO_ARCHIVE_OPTIONS = [
  { value: "never", label: "Never" },
  { value: "7d", label: "After 7 days" },
  { value: "14d", label: "After 14 days" },
  { value: "30d", label: "After 30 days" },
  { value: "90d", label: "After 90 days" },
];

const AUTO_DELETE_OPTIONS = [
  { value: "never", label: "Never" },
  { value: "24h", label: "After 24 hours" },
  { value: "3d", label: "After 3 days" },
  { value: "7d", label: "After 7 days" },
  { value: "30d", label: "After 30 days" },
  { value: "90d", label: "After 90 days" },
];

interface ArchiveSettingsProps {
  projects: ProjectSummary[];
  tasks: TaskSummary[];
  taskActionBusyId?: string;
  archivedLoading?: boolean;
  archivedHasMore?: boolean;
  onEnsureArchived?: () => void;
  onLoadMoreArchived?: () => void;
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
  onOpenTask?: (taskId: string) => void;
  onUpdateTask?: (taskId: string, patch: { archived?: boolean }) => void;
  onUpdateProject?: (projectId: string, patch: { archived?: boolean }) => void;
  onDeleteTask?: (taskId: string) => void;
  onDeleteProject?: (projectId: string) => void;
  onDeleteArchivedChats?: (projectId: string) => void;
}

/**
 * A full-width view over the same archive the sidebar toggle shows, sized for
 * triage: filter across every project at once, then restore, reopen, or
 * delete without leaving the page. Destructive actions defer to the shared
 * confirmation modals owned by the workspace.
 */
function ArchiveSettings({
  projects,
  tasks,
  taskActionBusyId,
  archivedLoading = false,
  archivedHasMore = false,
  onEnsureArchived,
  onLoadMoreArchived,
  settings,
  setSetting,
  onOpenTask,
  onUpdateTask,
  onUpdateProject,
  onDeleteTask,
  onDeleteProject,
  onDeleteArchivedChats,
}: ArchiveSettingsProps) {
  const [filter, setFilter] = useState("");
  const ensureArchivedRef = useRef(onEnsureArchived);
  ensureArchivedRef.current = onEnsureArchived;
  useEffect(() => {
    ensureArchivedRef.current?.();
  }, []);
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const archivedChats = useMemo(
    () =>
      tasks
        .filter((task) => task.archived && !task.parentId)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [tasks],
  );
  const archivedProjects = projects.filter((project) => project.archived);
  const query = filter.trim().toLowerCase();
  const visibleChats = query
    ? archivedChats.filter(
        (task) =>
          task.title.toLowerCase().includes(query) ||
          (projectNames.get(task.projectId) ?? "").toLowerCase().includes(query),
      )
    : archivedChats;
  // Group in the sidebar's project order so both archive views read the same.
  const groups = projects
    .map((project) => ({
      project,
      chats: visibleChats.filter((task) => task.projectId === project.id),
    }))
    .filter((group) => group.chats.length > 0);
  const canMutate = Boolean(onUpdateTask);

  return (
    <>
      <div className="settings-page-heading">
        <span>
          <Archive />
        </span>
        <div>
          <h1>Archive</h1>
          <p>
            Everything you have archived, in one sortable place. The sidebar toggle shows the same
            data next to your chats.
          </p>
        </div>
      </div>
      <section className="settings-section">
        <header>
          <h2>Retention</h2>
          <p>Applied locally by this app while it is running; nothing leaves your machine.</p>
        </header>
        <SettingRow
          label="Auto-archive inactive chats"
          description="Archive chats with no activity for this long. Pinned chats and the open chat are never touched."
        >
          <Dropdown
            aria-label="Auto-archive inactive chats"
            value={readSetting(settings, "archive.autoArchiveAfter", "never")}
            onChange={(value) => setSetting("archive.autoArchiveAfter", value)}
            options={AUTO_ARCHIVE_OPTIONS}
          />
        </SettingRow>
        <SettingRow
          label="Auto-delete archived chats"
          description="Permanently delete a chat this long after it was archived. The timer starts at archival, not at last activity."
        >
          <Dropdown
            aria-label="Auto-delete archived chats"
            value={readSetting(settings, "archive.autoDeleteAfter", "never")}
            onChange={(value) => setSetting("archive.autoDeleteAfter", value)}
            options={AUTO_DELETE_OPTIONS}
          />
        </SettingRow>
      </section>
      <section className="settings-section">
        <header>
          <h2>Archived chats{archivedChats.length ? ` · ${archivedChats.length}` : ""}</h2>
          <p>Restore returns a chat to its project; Open jumps straight back into it.</p>
        </header>
        {archivedChats.length > 0 ? (
          <label className="settings-search archive-filter">
            <Search />
            <span className="sr-only">Filter archived chats</span>
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter by title or project"
            />
          </label>
        ) : null}
        {archivedLoading && archivedChats.length === 0 ? (
          <p className="archive-empty" role="status">
            Loading archived chats…
          </p>
        ) : archivedChats.length === 0 ? (
          <p className="archive-empty" role="status">
            Nothing archived. Chats you archive from the sidebar will show up here.
          </p>
        ) : groups.length === 0 ? (
          <p className="archive-empty" role="status">
            No archived chats match “{filter.trim()}”.
          </p>
        ) : (
          groups.map(({ project, chats }) => (
            <div className="archive-group" key={project.id}>
              <div className="archive-group-header">
                <Folder aria-hidden="true" />
                <strong>{project.name}</strong>
                <small>{chats.length}</small>
                {onDeleteArchivedChats && !project.archived ? (
                  <button
                    className="archive-action archive-action--danger"
                    type="button"
                    onClick={() => onDeleteArchivedChats(project.id)}
                  >
                    Delete all…
                  </button>
                ) : null}
              </div>
              {chats.map((task) => (
                <div className="archive-row" key={task.id}>
                  <span className="archive-row-copy">
                    <strong>{task.title || "Untitled chat"}</strong>
                    <small>{formatRelativeTime(task.updatedAt)}</small>
                  </span>
                  <div className="archive-row-actions">
                    {onOpenTask ? (
                      <button
                        className="archive-action"
                        type="button"
                        onClick={() => onOpenTask(task.id)}
                      >
                        Open
                      </button>
                    ) : null}
                    {canMutate ? (
                      <button
                        className="archive-action"
                        type="button"
                        disabled={taskActionBusyId === task.id}
                        onClick={() => onUpdateTask?.(task.id, { archived: false })}
                      >
                        <ArchiveRestore aria-hidden="true" /> Restore
                      </button>
                    ) : null}
                    {onDeleteTask ? (
                      <button
                        className="archive-action archive-action--danger"
                        type="button"
                        onClick={() => onDeleteTask(task.id)}
                      >
                        <Trash2 aria-hidden="true" /> Delete…
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
        {archivedHasMore ? (
          <button
            className="archive-action"
            type="button"
            disabled={archivedLoading}
            onClick={() => onLoadMoreArchived?.()}
          >
            {archivedLoading ? "Loading…" : "Show more archived chats"}
          </button>
        ) : null}
      </section>
      {archivedProjects.length > 0 ? (
        <section className="settings-section">
          <header>
            <h2>Archived projects · {archivedProjects.length}</h2>
            <p>Restoring a project brings its chats back to the sidebar unchanged.</p>
          </header>
          {archivedProjects.map((project) => (
            <div className="archive-row" key={project.id}>
              <span className="archive-row-copy">
                <strong>{project.name}</strong>
                <small>{project.path}</small>
              </span>
              <div className="archive-row-actions">
                {onUpdateProject ? (
                  <button
                    className="archive-action"
                    type="button"
                    onClick={() => onUpdateProject(project.id, { archived: false })}
                  >
                    <ArchiveRestore aria-hidden="true" /> Restore
                  </button>
                ) : null}
                {onDeleteProject ? (
                  <button
                    className="archive-action archive-action--danger"
                    type="button"
                    onClick={() => onDeleteProject(project.id)}
                  >
                    <Trash2 aria-hidden="true" /> Delete…
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}

const navPillSpring = {
  type: "spring" as const,
  stiffness: 460,
  damping: 38,
  mass: 0.7,
};

/**
 * Everything that happens on a file surface and on the way out to Git: the
 * selection explainer's configuration, then what the app writes into commits
 * and how far a push may go.
 */
function FilesAndGitSettings({
  settings,
  setSetting,
  runtimes,
  projectName,
}: {
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
  runtimes: RuntimeConnection[];
  projectName?: string;
}) {
  return (
    <>
      <div className="settings-page-heading">
        <span>
          <FolderGit2 />
        </span>
        <div>
          <h1>Files and Git</h1>
          <p>
            What comes back when you ask about highlighted code, and what AI Integrator adds to
            your history on the way out.
          </p>
        </div>
      </div>
      <ExplainSettings
        settings={settings}
        setSetting={setSetting}
        runtimes={runtimes}
        projectName={projectName}
      />
      <GitSettings settings={settings} setSetting={setSetting} />
    </>
  );
}

/**
 * The selection explainer's configuration: what the answer is, who it is for,
 * how long it runs, and which provider produces it.
 *
 * The prompt shown at the foot is rendered natively by the same function a real
 * explanation calls, so it is the prompt rather than a description of one.
 */
function ExplainSettings({
  settings,
  setSetting,
  runtimes,
  projectName,
}: {
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
  runtimes: RuntimeConnection[];
  projectName?: string;
}) {
  const [preview, setPreview] = useState("");
  const [catalog, setCatalog] = useState<ModelCatalogEntry[] | null>(null);

  const customArchetypes = normalizeCustomArchetypes(settings[EXPLAIN_SETTINGS.customArchetypes]);
  const archetype = readSetting<string>(settings, EXPLAIN_SETTINGS.archetype, "explanation");
  const verbosity = readVerbosity(settings);
  const technicality = readTechnicality(settings);
  const storedRuntime = readSetting<string>(settings, EXPLAIN_SETTINGS.runtime, INHERIT_RUNTIME);

  const usable = useMemo(
    () => runtimes.filter((runtime) => runtime.status !== "not_installed"),
    [runtimes],
  );
  const available = useMemo(() => usable.map((runtime) => runtime.id), [usable]);
  const pinned = available.includes(storedRuntime as RuntimeId)
    ? (storedRuntime as RuntimeId)
    : null;
  const pinnedRuntime = pinned ? usable.find((runtime) => runtime.id === pinned) : undefined;
  const fallbacks = normalizeFallbacks(settings[EXPLAIN_SETTINGS.fallbacks], available);

  // Only a pinned runtime has a model to choose: without one the explainer
  // inherits the chat's route. Every read of `catalog` is itself gated on
  // `pinned` (the model/effort rows only render when pinned), so an unpinned
  // catalog going stale in state is invisible rather than a bug — there is no
  // need to reset it here, only to skip fetching.
  useEffect(() => {
    if (!pinned) return;
    let active = true;
    void bridge
      .listModelCatalog(pinned)
      .then((entries) => {
        if (active) setCatalog(entries.filter((entry) => entry.id !== "Provider default"));
      })
      .catch(() => {
        if (active) setCatalog([]);
      });
    return () => {
      active = false;
    };
  }, [pinned]);

  const config = resolveExplainConfig(settings);
  const { customMission } = config;
  const configArchetype = config.archetype;
  useEffect(() => {
    let active = true;
    const handle = window.setTimeout(() => {
      void bridge
        .explainPromptPreview(
          { archetype: configArchetype, customMission, verbosity, technicality },
          projectName,
        )
        .then((text) => {
          if (active) setPreview(text);
        })
        .catch(() => {
          if (active) setPreview("The prompt preview is only available in the desktop app.");
        });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(handle);
    };
  }, [configArchetype, customMission, verbosity, technicality, projectName]);

  const selectedCustom = customArchetypes.find((item) => item.id === archetype);
  const model = readSetting<string>(settings, EXPLAIN_SETTINGS.model, "");
  const entry = catalog?.find((candidate) => candidate.id === model);
  const effortOptions = entry?.efforts ?? [];
  const effort = resolveModelEffort(entry, readSetting<string>(settings, EXPLAIN_SETTINGS.effort, ""));

  const archetypeOptions: DropdownOption[] = [
    ...BUILT_IN_ARCHETYPES.map((item) => ({ value: item.id, label: item.label })),
    ...customArchetypes.map((item) => ({ value: item.id, label: item.label })),
    { value: NEW_ARCHETYPE_OPTION, label: "New archetype…" },
  ];
  const archetypeHint =
    BUILT_IN_ARCHETYPES.find((item) => item.id === archetype)?.hint ??
    "Your own mission, sent in place of the built-in ones.";

  const createArchetype = () => {
    const id = `${CUSTOM_ARCHETYPE_PREFIX}${Date.now().toString(36)}`;
    const taken = new Set(customArchetypes.map((item) => item.label));
    let label = DEFAULT_CUSTOM_LABEL;
    for (let index = 2; taken.has(label); index += 1) label = `${DEFAULT_CUSTOM_LABEL} ${index}`;
    setSetting(EXPLAIN_SETTINGS.customArchetypes, [
      ...customArchetypes,
      { id, label, mission: DEFAULT_CUSTOM_MISSION },
    ]);
    setSetting(EXPLAIN_SETTINGS.archetype, id);
  };

  const updateArchetype = (id: string, patch: { label?: string; mission?: string }) => {
    setSetting(
      EXPLAIN_SETTINGS.customArchetypes,
      customArchetypes.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const removeArchetype = (id: string) => {
    setSetting(
      EXPLAIN_SETTINGS.customArchetypes,
      customArchetypes.filter((item) => item.id !== id),
    );
    if (archetype === id) setSetting(EXPLAIN_SETTINGS.archetype, "explanation");
  };

  const changeRuntime = (value: string) => {
    setSetting(EXPLAIN_SETTINGS.runtime, value);
    // A model id means nothing to a different provider, and an effort the new
    // model does not advertise would be dropped anyway.
    setSetting(EXPLAIN_SETTINGS.model, "");
    setSetting(EXPLAIN_SETTINGS.effort, "");
    setSetting(
      EXPLAIN_SETTINGS.fallbacks,
      fallbacks.filter((item) => item !== value),
    );
  };

  const toggleFallback = (runtime: RuntimeId) => {
    setSetting(
      EXPLAIN_SETTINGS.fallbacks,
      fallbacks.includes(runtime)
        ? fallbacks.filter((item) => item !== runtime)
        : [...fallbacks, runtime],
    );
  };

  return (
    <>
      <section className="settings-section">
        <header>
          <h2>Ask about this</h2>
          <p>
            Highlight code in a file and right-click. The archetype replaces the whole
            instruction, not just its tone.
          </p>
        </header>
        <SettingRow label="Archetype" description={archetypeHint}>
          <Dropdown
            aria-label="Explain archetype"
            value={archetype}
            options={archetypeOptions}
            onChange={(value) =>
              value === NEW_ARCHETYPE_OPTION
                ? createArchetype()
                : setSetting(EXPLAIN_SETTINGS.archetype, value)
            }
          />
        </SettingRow>
        {selectedCustom ? (
          <div className="explain-archetype-editor">
            <label>
              <span>Name</span>
              <input
                value={selectedCustom.label}
                aria-label="Archetype name"
                maxLength={40}
                onChange={(event) =>
                  updateArchetype(selectedCustom.id, { label: event.target.value })
                }
              />
            </label>
            <label>
              <span>Mission</span>
              <textarea
                value={selectedCustom.mission}
                aria-label="Archetype mission"
                rows={3}
                maxLength={600}
                placeholder={DEFAULT_CUSTOM_MISSION}
                onChange={(event) =>
                  updateArchetype(selectedCustom.id, { mission: event.target.value })
                }
              />
            </label>
            <div className="explain-archetype-editor-actions">
              <small>
                One or two sentences works best. An empty mission falls back to Explanation.
              </small>
              <button
                className="secondary-button"
                type="button"
                onClick={() => removeArchetype(selectedCustom.id)}
              >
                <Trash2 /> Delete archetype
              </button>
            </div>
          </div>
        ) : null}
        <SettingRow label="Verbosity" description={contextSummary(verbosity)}>
          <Slider
            aria-label="Verbosity"
            min={1}
            max={100}
            value={verbosity}
            wide
            format={(value) => `${verbosityLabel(value)} · ${value}`}
            onChange={(value) => setSetting(EXPLAIN_SETTINGS.verbosity, value)}
          />
        </SettingRow>
        <SettingRow
          label="Audience"
          description="Who the answer is written for, from someone new to programming to an expert in this stack."
        >
          <Slider
            aria-label="Audience"
            min={0}
            max={3}
            value={technicality}
            wide
            format={technicalityLabel}
            onChange={(value) => setSetting(EXPLAIN_SETTINGS.technicality, value)}
          />
        </SettingRow>
      </section>

      <section className="settings-section">
        <header>
          <h2>Who answers</h2>
          <p>
            Explanations run isolated and tool-denied on a scratch directory, whichever provider
            answers.
          </p>
        </header>
        <SettingRow
          label="Runtime"
          description="Current model follows whatever the chat is already using."
        >
          <Dropdown
            aria-label="Explain runtime"
            value={storedRuntime}
            options={[
              { value: INHERIT_RUNTIME, label: "Current model" },
              ...usable.map((runtime) => ({
                value: runtime.id,
                label: runtime.name,
                icon: <ProviderIcon provider={runtime.id} label={runtime.name} />,
              })),
            ]}
            onChange={changeRuntime}
          />
        </SettingRow>
        {pinned ? (
          <SettingRow
            label="Model"
            description="Economy default picks the provider's cheapest model, the same one chat titles use."
          >
            <Dropdown
              aria-label="Explain model"
              value={model}
              options={[
                { value: "", label: "Economy default" },
                ...(catalog ?? []).map((item) => ({ value: item.id, label: item.label })),
              ]}
              onChange={(value) => {
                setSetting(EXPLAIN_SETTINGS.model, value);
                setSetting(EXPLAIN_SETTINGS.effort, "");
              }}
            />
          </SettingRow>
        ) : null}
        {pinned && effortOptions.length > 0 ? (
          <SettingRow
            label="Reasoning effort"
            description="Only the levels this model advertises are offered."
          >
            <Dropdown
              aria-label="Explain reasoning effort"
              value={effort ?? ""}
              options={effortOptions.map((option) => ({
                value: option.id,
                label: option.label,
              }))}
              onChange={(value) => setSetting(EXPLAIN_SETTINGS.effort, value)}
            />
          </SettingRow>
        ) : null}
        <div className="setting-row setting-row-stacked">
          <span>
            <strong>Fallbacks</strong>
            <small>
              Click to add a provider to the chain. If the one above it cannot answer — not
              installed, timed out, out of usage — the next one is tried. Fallbacks run on their
              own economy model.
            </small>
          </span>
          <div className="explain-fallback-chain">
            <span className="explain-fallback-chip" data-primary="true">
              <span className="explain-fallback-order">1</span>
              {pinnedRuntime ? (
                <ProviderIcon provider={pinnedRuntime.id} label={pinnedRuntime.name} />
              ) : null}
              {pinnedRuntime?.name ?? "Current model"}
            </span>
            {usable
              .filter((runtime) => runtime.id !== pinned)
              .map((runtime) => {
                const index = fallbacks.indexOf(runtime.id);
                return (
                  <button
                    key={runtime.id}
                    type="button"
                    className="explain-fallback-chip"
                    aria-pressed={index >= 0}
                    data-selected={index >= 0}
                    onClick={() => toggleFallback(runtime.id)}
                  >
                    <span className="explain-fallback-order">
                      {index >= 0 ? index + 2 : <Plus />}
                    </span>
                    <ProviderIcon provider={runtime.id} label={runtime.name} />
                    {runtime.name}
                  </button>
                );
              })}
          </div>
        </div>
      </section>

      <section className="settings-section">
        <header>
          <h2>Prompt</h2>
          <p>
            Exactly what gets sent, composed by the same code a real explanation uses. The file and
            selection are stand-ins.
          </p>
        </header>
        <pre className="explain-prompt-preview" aria-label="Composed explain prompt" tabIndex={0}>
          {preview}
        </pre>
      </section>
    </>
  );
}

/**
 * Git decorations and push safety. Every control defaults off: each one either
 * writes something permanent into history or relaxes a safeguard, so none of it
 * should arrive without being asked for.
 */
function GitSettings({
  settings,
  setSetting,
}: {
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
}) {
  const decoration = readGitDecorationSettings(settings);
  const force = readPushForce(settings);
  const samplePreview = decorateCommitMessage("fix the parser panic", decoration);

  return (
    <>
      <section className="settings-section">
        <header>
          <h2>Commits</h2>
          <p>These change permanent history, so both are off until you turn them on.</p>
        </header>
        <SettingRow
          label="Credit AI Integrator as co-author"
          description="Adds a Co-authored-by trailer to every commit made from the app. Rewriting it later means rewriting history."
        >
          <Switch
            checked={decoration.coAuthor}
            onChange={(value) => setSetting(GIT_SETTINGS.coAuthor, value)}
            label="Credit AI Integrator as co-author"
          />
        </SettingRow>
        <SettingRow
          label="Prefix commit subjects"
          description="Marks commits made from the app so they are easy to find in a log."
        >
          <Switch
            checked={decoration.commitPrefixEnabled}
            onChange={(value) => setSetting(GIT_SETTINGS.commitPrefixEnabled, value)}
            label="Prefix commit subjects"
          />
        </SettingRow>
        {decoration.commitPrefixEnabled ? (
          <SettingRow label="Commit prefix" description="Written ahead of the subject you type.">
            <input
              className="setting-text-input"
              aria-label="Commit prefix"
              value={decoration.commitPrefix}
              maxLength={40}
              onChange={(event) => setSetting(GIT_SETTINGS.commitPrefix, event.target.value)}
            />
          </SettingRow>
        ) : null}
        {decoration.coAuthor || decoration.commitPrefixEnabled ? (
          <pre className="git-commit-preview" aria-label="Example decorated commit message">
            {samplePreview}
          </pre>
        ) : null}
      </section>

      <section className="settings-section">
        <header>
          <h2>Pushing</h2>
          <p>A push is still previewed and confirmed before anything reaches the remote.</p>
        </header>
        <SettingRow
          label="Force push"
          description="Off refuses any push that would rewrite the remote. With lease rewrites only while the remote is where your last fetch left it, so a teammate's commit aborts the push instead of vanishing."
        >
          <Dropdown
            aria-label="Force push"
            value={force}
            options={[
              { value: "off", label: "Off" },
              { value: "lease", label: "With lease" },
              { value: "always", label: "Always force" },
            ]}
            onChange={(value) => setSetting(GIT_SETTINGS.forcePush, value)}
          />
        </SettingRow>
        {force === "always" ? (
          <p className="settings-inline-warning" role="status">
            <TriangleAlert /> Always force overwrites the remote branch even when it holds commits
            you have never seen. Those commits are not recoverable from your machine.
          </p>
        ) : null}
      </section>
    </>
  );
}

export function SettingsView(props: SettingsViewProps) {
  const reduceMotion =
    Boolean(useReducedMotion()) || document.documentElement.dataset.motion === "none";
  const [section, setSection] = useState<SettingsSection>(
    props.runtimeActionRequest ? "models-runtimes" : "appearance",
  );
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState<SettingsMap>(DEFAULT_SETTINGS);
  const [appInfo, setAppInfo] = useState<LocalAppInfo>({
    applicationVersion: "browser-preview",
    domainSchemaVersion: 2,
    dataDirectory: "Browser-managed local storage",
    localOnly: true,
  });
  const [actionMessage, setActionMessage] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const visibleNav = useMemo(
    () =>
      settingsNav.filter((item) =>
        `${item.label} ${item.hint}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [query],
  );

  useEffect(() => {
    let active = true;
    void Promise.all([bridge.listSettings(), bridge.getAppInfo()])
      .then(([stored, info]) => {
        if (!active) return;
        const loaded = { ...DEFAULT_SETTINGS };
        for (const setting of stored) {
          const key = setting.key.startsWith("settings.")
            ? setting.key.slice("settings.".length)
            : setting.key;
          if (!key.startsWith("appearance.")) loaded[key] = setting.value;
        }
        setSettings(loaded);
        setAppInfo(info);
      })
      .catch(() => {
        // Settings remain usable in browser preview when local storage is unavailable.
      });
    return () => {
      active = false;
    };
  }, []);

  const setSetting = (key: string, value: unknown) => {
    setSettings((current) => ({ ...current, [key]: value }));
    props.onSettingChanged?.(key, value);
    void bridge
      .setSetting(`settings.${key}`, value)
      .catch(() => setActionMessage("Could not persist this setting locally."));
  };
  const downloadJson = (filename: string, value: unknown) => {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const exportSettings = () => {
    downloadJson("ai-integrator-settings.json", {
      kind: "ai-integrator-settings",
      version: 1,
      exportedAt: new Date().toISOString(),
      theme: exportThemePreferences(props.preferences),
      settings,
    });
    setActionMessage("Settings and theme exported locally.");
  };
  const exportData = async () => {
    try {
      downloadJson("ai-integrator-local-data.json", {
        kind: "ai-integrator-local-data",
        version: 1,
        exportedAt: new Date().toISOString(),
        data: await bridge.exportLocalData(),
      });
      setActionMessage("Local data export created with redacted application records.");
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Could not export local data.");
    }
  };
  const importFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
      const imported = importThemePreferences(
        parsed.kind === "ai-integrator-theme" ? parsed : parsed.theme,
      );
      if (imported) props.onChangePreferences(imported);
      const importedSettings = parsed.settings;
      if (
        importedSettings &&
        typeof importedSettings === "object" &&
        !Array.isArray(importedSettings)
      ) {
        for (const [key, value] of Object.entries(importedSettings as Record<string, unknown>)) {
          setSetting(key.replace(/^settings\./, ""), value);
        }
      }
      if (!imported && !importedSettings)
        throw new Error("This is not a supported AI Integrator settings export.");
      setActionMessage("Settings imported and validated locally.");
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Could not import settings.");
    }
  };
  const clearData = async () => {
    if (
      !window.confirm(
        "Delete local tasks, settings, indexes, and diagnostics? Export anything you need first.",
      )
    )
      return;
    try {
      await bridge.clearLocalData();
      setActionMessage("Local data deleted. Restart the app to rebuild an empty workspace.");
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Could not delete local data.");
    }
  };
  const policySections = new Set<SettingsSection>(["general", "composer", "permissions"]);

  return (
    <main className="settings-shell" id="main-content">
      <aside className="settings-navigation" aria-label="Settings navigation">
        <div className="settings-brand">
          <BrandMark />
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
          <LayoutGroup id="settings-navigation">
            {visibleNav.length === 0 ? (
              <p className="settings-nav-empty">No settings match “{query.trim()}”.</p>
            ) : null}
            {visibleNav.map((item) => (
              <Tooltip label={item.hint} placement="right" key={item.id}>
                <button
                  type="button"
                  data-active={section === item.id}
                  aria-current={section === item.id ? "page" : undefined}
                  onClick={() => setSection(item.id)}
                >
                  {section === item.id ? (
                    <motion.span
                      className="settings-nav-active"
                      layoutId={reduceMotion ? undefined : "active-category"}
                      transition={reduceMotion ? { duration: 0 } : navPillSpring}
                      aria-hidden="true"
                    />
                  ) : null}
                  <item.icon />
                  <span>{item.label}</span>
                </button>
              </Tooltip>
            ))}
          </LayoutGroup>
        </nav>
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
          {section === "models-runtimes" ? (
            <ModelsAndRuntimesSettings
              runtimes={props.runtimes}
              settings={settings}
              setSetting={setSetting}
              actionRequest={props.runtimeActionRequest}
              onRefreshRuntimes={props.onRefreshRuntimes}
            />
          ) : null}
          {section === "files-git" ? (
            <FilesAndGitSettings
              settings={settings}
              setSetting={setSetting}
              runtimes={props.runtimes}
              projectName={props.projects?.find((project) => !project.archived)?.name}
            />
          ) : null}
          {section === "subagents" ? (
            <SubagentsSettings
              settings={settings}
              setSetting={setSetting}
              runtimes={props.runtimes}
            />
          ) : null}
          {section === "usage" ? (
            <UsageSettings usage={props.usage} runtimes={props.runtimes} />
          ) : null}
          {section === "archive" ? (
            <ArchiveSettings
              projects={props.projects ?? []}
              tasks={props.tasks ?? []}
              taskActionBusyId={props.taskActionBusyId}
              archivedLoading={props.archivedLoading}
              archivedHasMore={props.archivedHasMore}
              onEnsureArchived={props.onEnsureArchived}
              onLoadMoreArchived={props.onLoadMoreArchived}
              settings={settings}
              setSetting={setSetting}
              onOpenTask={props.onOpenTask}
              onUpdateTask={props.onUpdateTask}
              onUpdateProject={props.onUpdateProject}
              onDeleteTask={props.onDeleteTask}
              onDeleteProject={props.onDeleteProject}
              onDeleteArchivedChats={props.onDeleteArchivedChats}
            />
          ) : null}
          {policySections.has(section) ? (
            <PolicySettings
              section={section as PolicySettingsProps["section"]}
              settings={settings}
              setSetting={setSetting}
              appInfo={appInfo}
              onExportSettings={exportSettings}
              onExportData={() => void exportData()}
              onImport={() => importRef.current?.click()}
              onClear={() => void clearData()}
              actionMessage={actionMessage}
            />
          ) : null}
          <input
            ref={importRef}
            className="sr-only"
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
              event.currentTarget.value = "";
            }}
          />
          {actionMessage && section !== "general" ? (
            <p className="settings-action-message" role="status">
              {actionMessage}
            </p>
          ) : null}
        </div>
      </div>
    </main>
  );
}
