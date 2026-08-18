import {
  startTransition,
  useCallback,
  useMemo,
  useRef,
  useState,
  useEffect,
  useTransition,
  type AnchorHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { AnimatePresence, LayoutGroup, m as motion, useReducedMotion } from "motion/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
  ArrowLeft,
  Bot,
  Brain,
  Boxes,
  Braces,
  Folder,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Copy,
  Database,
  Download,
  ExternalLink,
  GitBranch,
  KeyRound,
  Keyboard,
  Lightbulb,
  LoaderCircle,
  Mic,
  MonitorCog,
  Package,
  Palette,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Trash2,
  Upload,
  Users,
  X,
  FolderOpen,
  FolderSearch,
  ScrollText,
  Globe,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  bridge,
  openExternalLink,
  resolveModelEffort,
  type IntegratorMcpConfig,
  type IntegratorMcpOverview,
  type IntegratorMcpServer,
  type IntegratorSkillBody,
  type RemoteSkillBody,
  type RemoteSkillsPreview,
  type IntegratorSkillInfo,
  type IntegratorSkillsOverview,
  type LocalAppInfo,
  type LogsTotals,
  type MemoryEntry,
  type ModelCatalogEntry,
  type ProjectSummary,
  type RuntimeConnection,
  type RuntimeActionKind,
  type RuntimeActionPlan,
  type RuntimeId,
  type StorageTotals,
  type TaskSummary,
  type UsageSnapshot,
  type VoiceTypingCredentialStatus,
} from "../bridge";
import {
  exportThemePreferences,
  importThemePreferences,
  type ThemePreferencePatch,
  type ThemePreferences,
} from "../theme";
import { AppearanceSettings } from "./AppearanceSettings";
import { ArchiveSettings } from "./ArchiveSettings";
import { BrandMark } from "./BrandMark";
import { ComposerSettings } from "./ComposerSettings";
import { KeybindingsSettings } from "./KeybindingsSettings";
import { Tooltip } from "./Tooltip";
import { Dropdown, ProviderIcon, type DropdownOption } from "./Dropdown";
import { Slider } from "./Slider";
import { RuntimeSetupTerminal } from "./RuntimeSetupTerminal";
import { McpActivationDialog, type McpActivationRequest } from "./McpActivationDialog";
import { PermissionsSettings } from "./PermissionsSettings";
import { BrowserSettings, BROWSER_SETTINGS } from "./BrowserSettings";
import { SubagentsSettings } from "./SubagentsSettings";
import { UsageSettings } from "./UsageSettings";
import { SettingRow, Switch } from "./SettingControls";
import { readSetting, type SettingsMap } from "./settingsModel";
import { DEFAULT_SPECIALISTS } from "../subagentSettings";
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
import { COMMIT_MESSAGE_SETTINGS, resolveCommitMessageRoute } from "../commitMessageSettings";
import {
  CURATED_PLUGIN_INSTALLS,
  SKILLS_ENABLED_KEY,
  groupSkills,
  isSkillEnabled,
  readSkillEnablement,
  withSkillEnablement,
  withSkillsEnablement,
} from "../skillsSettings";
import {
  CURATED_MCP_SERVERS,
  MCP_ENABLED_KEY,
  mcpActivationWarning,
  mcpLaunchPreview,
  parseMcpForm,
} from "../mcpSettings";

export type SettingsSection =
  | "general"
  | "memory"
  | "appearance"
  | "composer"
  | "keybindings"
  | "explain"
  | "git"
  | "browser"
  | "models-runtimes"
  | "permissions"
  | "skills"
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
  initialSection?: SettingsSection;
  /** Bumped every time the workspace asks for a section; see the sync below. */
  sectionRequest?: number;
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
  {
    id: "memory",
    label: "Personalization",
    hint: "Your name, profile, and memory",
    icon: Brain,
  },
  { id: "appearance", label: "Appearance", hint: "Themes, type, motion", icon: Palette },
  { id: "composer", label: "Composer", hint: "Send behavior", icon: Braces },
  {
    id: "keybindings",
    label: "Keyboard",
    hint: "Shortcuts for every global command",
    icon: Keyboard,
  },
  {
    id: "models-runtimes",
    label: "Runtimes and Models",
    hint: "Defaults, connections, and capability",
    icon: Bot,
  },
  {
    id: "skills",
    label: "Skills and Plugins",
    hint: "Marketplace, installed capabilities, and MCP connectors",
    icon: Sparkles,
  },
  { id: "subagents", label: "Subagents", hint: "Cross-provider handoff policy", icon: Users },
  { id: "permissions", label: "Permissions", hint: "Safe execution defaults", icon: ShieldCheck },
  {
    id: "git",
    label: "Git",
    hint: "Commit messages, trailers, and push safety",
    icon: GitBranch,
  },
  {
    id: "browser",
    label: "Browser",
    hint: "Agent access, sign-in, and site data",
    icon: Globe,
  },
  { id: "explain", label: "Explain", hint: "Ask about a selection", icon: Lightbulb },
  { id: "usage", label: "Usage and Budgets", hint: "Local usage evidence", icon: CircleDollarSign },
  { id: "archive", label: "Archives", hint: "Browse, restore, and clean up", icon: Archive },
];

/**
 * Every key here is consumed by real behavior: workspace restore and the
 * external-link confirmation live in the bridge, the composer defaults are
 * read when a new chat's composer mounts. A setting with no consumer does
 * not belong in this map or in the UI.
 */
const DEFAULT_SETTINGS: SettingsMap = {
  [BROWSER_SETTINGS.agentAccess]: true,
  [BROWSER_SETTINGS.lockActiveTab]: false,
  [BROWSER_SETTINGS.keepSignedIn]: true,
  [BROWSER_SETTINGS.blockNewWindows]: true,
  [BROWSER_SETTINGS.externalOpen]: false,
  [BROWSER_SETTINGS.identityScope]: "task",
  [BROWSER_SETTINGS.searchEngine]: "google",
  "general.openLastWorkspace": true,
  "general.autoResumeInterruptedTurns": false,
  "general.confirmExternalActions": true,
  "general.saveContextOnEdit": false,
  "personalization.enabled": true,
  "personalization.name": "",
  "personalization.about": "",
  "memory.enabled": false,
  "composer.enterToSend": true,
  "keyboard.arrowNavigation": true,
  "keyboard.wrapNavigation": true,
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
  // Commit-message generation requires an explicit runtime + model; empty means
  // the Generate button asks the user to finish this section first.
  [COMMIT_MESSAGE_SETTINGS.runtime]: "",
  [COMMIT_MESSAGE_SETTINGS.model]: "",
  [COMMIT_MESSAGE_SETTINGS.effort]: "",
  [COMMIT_MESSAGE_SETTINGS.fallbacks]: [],
  "permissions.defaultProfile": "project-write",
  // Enforced by the workspace's retention sweep (App): auto-archive uses the
  // chat's last activity, auto-delete counts from the moment it was archived.
  "archive.autoArchiveAfter": "never",
  "archive.autoDeleteAfter": "never",
  // Compact incident logs always write; this gates verbose lifecycle/probe trails.
  "diagnostics.detailedLogging": false,
  "diagnostics.retention": "7d",
  // Consumed by the native delegation broker (peers_list / delegate_start
  // policy) and by the composer's delegation-mode default.
  "delegation.defaultMode": "off",
  "delegation.maxConcurrent": 3,
  "delegation.instruction": "",
  "delegation.profiles": DEFAULT_SPECIALISTS,
};

function isInternalBrowserSetting(key: string): boolean {
  return key === "browser.savedLogins" || key.startsWith("browser.agentSignIn.");
}

/**
 * Delegation policy for the native broker: which agents an orchestrator may
 * hand subtasks to, how many at once, and the user's standing instruction.
 * Every control here is read by the Rust side on `peers_list`/`delegate_start`.
 */
const SKILL_SOURCE_LABELS: Record<string, string> = {
  integrator: "My skills",
  plugin: "Installed plugin",
  "first-party": "Ships with the app",
};

/** Publisher marks are fetched once from their declared official URLs,
 * recorded in assets-manifest.json, and bundled locally. Settings therefore
 * shows the real marks without leaking an app-open ping to every publisher. */
const SKILL_BRAND_MARKS = {
  integrator: "/brand/ai-integrator-mark-light.png",
  anthropic: "/brand/providers/anthropic.ico",
  openai: "/brand/skills/openai.png",
  gemini: "/brand/providers/gemini.png",
  xai: "/brand/providers/xai.ico",
  vercel: "/brand/skills/vercel.ico",
  cloudflare: "/brand/skills/cloudflare.png",
  microsoft: "/brand/skills/microsoft.ico",
  huggingface: "/brand/skills/huggingface.ico",
  expo: "/brand/skills/expo.png",
  stripe: "/brand/skills/stripe.ico",
  remotion: "/brand/skills/remotion.png",
  superpowers: "/brand/skills/superpowers.svg",
  firebase: "/brand/skills/firebase.png",
  google: "/brand/skills/google.png",
  googleDrive: "/brand/skills/google-drive.png",
  nvidia: "/brand/skills/nvidia.ico",
  supabase: "/brand/skills/supabase.ico",
  tauri: "/brand/skills/tauri.svg",
  government: "/brand/skills/data-gov.ico",
  market: "/brand/skills/alpha-vantage.ico",
  github: "/brand/skills/github.svg",
  notion: "/brand/skills/notion.ico",
  linear: "/brand/skills/linear.ico",
  figma: "/brand/skills/figma.ico",
  sentry: "/brand/skills/sentry.ico",
  blender: "/brand/skills/blender.ico",
  robinhood: "/brand/skills/robinhood.svg",
} as const;

type SkillBrand = keyof typeof SKILL_BRAND_MARKS;

const INVERT_ON_DARK = new Set<SkillBrand>(["expo", "github", "superpowers"]);

const PLUGIN_GROUP_BRANDS: Record<string, SkillBrand[]> = {
  "integrator-authoring": ["integrator"],
  "gov-data": ["government"],
  "market-data": ["market"],
  "ai-provider-docs": ["openai", "anthropic", "gemini", "xai"],
  "release-craft": ["github"],
  firebase: ["firebase"],
  cloudflare: ["cloudflare"],
  stripe: ["stripe"],
  supabase: ["supabase"],
  vercel: ["vercel"],
  tauri: ["tauri"],
  "anthropics-skills": ["anthropic"],
  "openai-skills": ["openai"],
  "vercel-labs-agent-skills": ["vercel"],
  "cloudflare-skills": ["cloudflare"],
  "microsoft-skills": ["microsoft"],
  "huggingface-skills": ["huggingface"],
  "expo-skills": ["expo"],
  "stripe-ai": ["stripe"],
  "remotion-dev-skills": ["remotion"],
  "obra-superpowers": ["superpowers"],
  "firebase-agent-skills": ["firebase"],
  "google-skills": ["google"],
  "googleworkspace-cli": ["googleDrive"],
  "nvidia-skills": ["nvidia"],
  "supabase-agent-skills": ["supabase"],
};

const CURATED_INSTALL_BRANDS: Record<string, SkillBrand[]> = {
  anthropic: ["anthropic"],
  openai: ["openai"],
  vercel: ["vercel"],
  cloudflare: ["cloudflare"],
  microsoft: ["microsoft"],
  huggingface: ["huggingface"],
  mobile: ["expo"],
  stripe: ["stripe"],
  video: ["remotion"],
  community: ["superpowers"],
  firebase: ["firebase"],
  google: ["google"],
  "google-drive": ["googleDrive"],
  nvidia: ["nvidia"],
  supabase: ["supabase"],
  github: ["github"],
  notion: ["notion"],
  linear: ["linear"],
  figma: ["figma"],
  sentry: ["sentry"],
  blender: ["blender"],
  robinhood: ["robinhood"],
};

function SkillBrandIcon({ brands }: { brands?: SkillBrand[] }) {
  if (!brands?.length) return <Package aria-hidden />;
  return (
    <span className="skill-brand-mark" aria-hidden>
      {brands.map((brand) => (
        <img
          key={brand}
          src={SKILL_BRAND_MARKS[brand]}
          alt=""
          data-invert-on-dark={INVERT_ON_DARK.has(brand)}
        />
      ))}
    </span>
  );
}

function McpServerIcon({ server }: { server: IntegratorMcpServer }) {
  const curated =
    server.source === "user"
      ? CURATED_MCP_SERVERS.find((entry) => entry.name === server.name)
      : undefined;
  const brands = curated
    ? CURATED_INSTALL_BRANDS[curated.icon]
    : PLUGIN_GROUP_BRANDS[server.origin];
  return brands?.length ? <SkillBrandIcon brands={brands} /> : <Server aria-hidden />;
}

function SkillCredentialControl({
  skill,
  onChanged,
}: {
  skill: IntegratorSkillInfo;
  onChanged: () => void;
}) {
  const credential = skill.credential;
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (!credential) return null;
  const storageLabel =
    credential.storage === "protectedLocalFile"
      ? "protected developer storage"
      : "the operating system credential store";

  const save = async () => {
    if (!secret.trim() || busy) return;
    setBusy(true);
    setMessage("");
    try {
      await bridge.setIntegratorSkillCredential(credential.id, secret);
      setSecret("");
      setMessage("Saved securely.");
      onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Could not save ${credential.label}.`);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await bridge.clearIntegratorSkillCredential(credential.id);
      setMessage(`Removed from ${storageLabel}.`);
      onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Could not remove ${credential.label}.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="skill-credential-control">
      <span className="skill-credential-status">
        <KeyRound aria-hidden />
        <span>
          <strong>{credential.label}</strong>
          <small>
            {credential.available
              ? credential.configured
                ? `Configured in ${storageLabel}`
                : credential.required
                  ? "Required for this skill"
                  : "Optional — raises limits or unlocks additional data"
              : "Native app required for secure storage"}
          </small>
        </span>
      </span>
      <label className="skill-credential-input">
        <span className="sr-only">{credential.label}</span>
        <input
          type="password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
          }}
          placeholder={credential.configured ? "Paste a replacement key" : "Paste API key"}
          autoComplete="off"
          spellCheck={false}
          disabled={!credential.available || busy}
        />
      </label>
      <div className="skill-credential-actions">
        <button
          className="ghost-button"
          type="button"
          disabled={!credential.available || busy || !secret.trim()}
          onClick={() => void save()}
        >
          {busy ? <LoaderCircle className="spin" /> : <KeyRound />} Save
        </button>
        {credential.configured ? (
          <button
            className="ghost-button"
            type="button"
            disabled={busy}
            onClick={() => void clear()}
          >
            Remove
          </button>
        ) : null}
        <button
          className="text-button"
          type="button"
          onClick={() => void openExternalLink(credential.helpUrl)}
        >
          Get a key <ExternalLink />
        </button>
      </div>
      {message ? (
        <small className="skill-credential-message" role="status">
          {message}
        </small>
      ) : null}
    </div>
  );
}

function SkillSettingsRow({
  skill,
  enabled,
  onToggle,
  onCredentialChanged,
  showNamespace = false,
  onViewPlugin,
  onOpenDetail,
  expanded,
  detailId,
}: {
  skill: IntegratorSkillInfo;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  onCredentialChanged: () => void;
  showNamespace?: boolean;
  onViewPlugin?: () => void;
  /** Opens the skill's full body. The row becomes clickable for this; the
   * switch, credential control, and origin chip keep acting on themselves. */
  onOpenDetail?: () => void;
  expanded?: boolean;
  detailId?: string;
}) {
  const namespace = skill.name.includes(":") ? skill.name.split(":", 1)[0] : undefined;
  const displayName =
    !showNamespace && skill.name.includes(":")
      ? skill.name.split(":").slice(1).join(":")
      : skill.name;
  return (
    <div
      className="setting-row skill-settings-row"
      role={onOpenDetail ? "button" : undefined}
      tabIndex={onOpenDetail ? 0 : undefined}
      aria-expanded={onOpenDetail ? Boolean(expanded) : undefined}
      aria-controls={onOpenDetail && detailId ? detailId : undefined}
      onClick={onOpenDetail}
      onKeyDown={
        onOpenDetail
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpenDetail();
              }
            }
          : undefined
      }
    >
      <span>
        <strong className="skill-settings-name">
          <span>
            {displayName}
            {onViewPlugin && namespace ? (
              <Tooltip label={`View the ${namespace} plugin`} placement="top">
                <button
                  className="origin-chip"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onViewPlugin();
                  }}
                >
                  {namespace}
                </button>
              </Tooltip>
            ) : null}
          </span>
        </strong>
        <small>{skill.description}</small>
        <small className="skill-invocation-count">
          {skill.invocationCount.toLocaleString()}{" "}
          {skill.invocationCount === 1 ? "invocation" : "invocations"}
        </small>
      </span>
      <div
        className="setting-control disclosure-control-pair"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Switch checked={enabled} onChange={onToggle} label={`Enable ${skill.name}`} />
        {onOpenDetail ? (
          <button
            className="disclosure-chevron-button"
            type="button"
            data-open={Boolean(expanded)}
            aria-expanded={Boolean(expanded)}
            aria-controls={detailId}
            aria-label={`${expanded ? "Hide" : "Show"} ${skill.name} instructions`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenDetail();
            }}
          >
            <ChevronDown aria-hidden />
          </button>
        ) : null}
      </div>
      <div
        className="credential-click-guard"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <SkillCredentialControl skill={skill} onChanged={onCredentialChanged} />
      </div>
    </div>
  );
}

function SkillCard({
  skill,
  enabled,
  onToggle,
  onCredentialChanged,
  onViewPlugin,
  onOpenDetail,
}: {
  skill: IntegratorSkillInfo;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  onCredentialChanged: () => void;
  onViewPlugin?: () => void;
  onOpenDetail: () => void;
}) {
  const namespace = skill.name.includes(":") ? skill.name.split(":", 1)[0] : undefined;
  const displayName = namespace ? skill.name.split(":").slice(1).join(":") : skill.name;
  const sourceLabel = SKILL_SOURCE_LABELS[skill.source] ?? skill.source;
  const brands = namespace ? PLUGIN_GROUP_BRANDS[namespace] : undefined;
  return (
    <motion.div
      layout="position"
      role="button"
      tabIndex={0}
      aria-label={`Open ${skill.name}`}
      className="capability-card capability-card--interactive skill-card"
      data-active={enabled}
      onClick={onOpenDetail}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetail();
        }
      }}
    >
      <div className="capability-card-heading">
        <span className="browse-card-tile" aria-hidden>
          {brands ? <SkillBrandIcon brands={brands} /> : <Sparkles />}
        </span>
        <span>
          <strong>
            {displayName}
            {namespace && onViewPlugin ? (
              <Tooltip label={`View the ${namespace} plugin`} placement="top">
                <button
                  className="origin-chip"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onViewPlugin();
                  }}
                >
                  {namespace}
                </button>
              </Tooltip>
            ) : null}
          </strong>
          <small>{sourceLabel}</small>
        </span>
      </div>
      <p className="capability-card-description">{skill.description}</p>
      <div className="capability-card-footer">
        <span>
          {skill.invocationCount.toLocaleString()}{" "}
          {skill.invocationCount === 1 ? "invocation" : "invocations"}
        </span>
        <div
          className="capability-card-action disclosure-control-pair"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Switch checked={enabled} onChange={onToggle} label={`Enable ${skill.name}`} />
          <button
            className="disclosure-chevron-button"
            type="button"
            aria-label={`Open ${skill.name} details`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenDetail();
            }}
          >
            <ChevronRight aria-hidden />
          </button>
        </div>
      </div>
      <div
        className="capability-card-detail"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <SkillCredentialControl skill={skill} onChanged={onCredentialChanged} />
      </div>
    </motion.div>
  );
}

/** One plugin as a first-class capability card. Its master switch is ON only
 * when every bundled skill and MCP server is active; the count pill carries
 * partial state without pretending the whole plugin is enabled. */
function PluginGroupCard({
  group,
  label,
  brands,
  mcpCount = 0,
  enabledMcpCount = 0,
  showSourceLabel = true,
  isEnabled,
  onToggleAll,
  onOpenDetail,
  busy = false,
}: {
  group: { title: string; source: string; skills: IntegratorSkillInfo[] };
  label: string;
  brands?: SkillBrand[];
  mcpCount?: number;
  enabledMcpCount?: number;
  /** Suppressed inside a section where every card already shares one source
   * (e.g. "Built into AI Integrator") — repeating it per card is noise. */
  showSourceLabel?: boolean;
  isEnabled: (skill: IntegratorSkillInfo) => boolean;
  onToggleAll: (enabled: boolean) => void;
  onOpenDetail: () => void;
  busy?: boolean;
}) {
  const enabledCount = group.skills.filter(isEnabled).length + enabledMcpCount;
  const total = group.skills.length + mcpCount;
  const active = total > 0 && enabledCount === total;
  const partial = enabledCount > 0 && !active;
  const invocations = group.skills.reduce((sum, skill) => sum + skill.invocationCount, 0);
  return (
    // A real <button> cannot contain the master-switch <button> below
    // (nested interactive controls are invalid HTML), so the clickable card
    // is a div with button semantics instead.
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      className="skills-plugin-card"
      data-active={active}
      onClick={onOpenDetail}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetail();
        }
      }}
    >
      <span className="skills-plugin-tile" aria-hidden>
        {group.title === "My skills" ? <Folder /> : <SkillBrandIcon brands={brands} />}
      </span>
      <span className="skills-plugin-title">
        <strong>{label}</strong>
        <small>
          {showSourceLabel ? `${SKILL_SOURCE_LABELS[group.source] ?? group.source} · ` : ""}
          {total} {total === 1 ? "skill" : "skills"}
          {mcpCount > 0 ? ` · ${mcpCount} MCP` : ""} · {invocations.toLocaleString()} invoked
        </small>
      </span>
      <span
        className="skills-plugin-controls"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <AnimatePresence initial={false}>
          {partial ? (
            <motion.span
              className="skills-count-pill"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ duration: 0.14, ease: "easeOut" }}
            >
              {enabledCount} of {total} on
            </motion.span>
          ) : null}
        </AnimatePresence>
        <span className="disclosure-control-pair">
          <Switch
            checked={active}
            onChange={onToggleAll}
            label={`${active ? "Disable" : "Enable"} ${label}`}
            disabled={busy}
          />
          <button
            className="disclosure-chevron-button"
            type="button"
            aria-label={`Open ${label} details`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenDetail();
            }}
          >
            <ChevronRight aria-hidden />
          </button>
        </span>
      </span>
    </div>
  );
}

type CapabilityTab = "marketplace" | "plugins" | "skills" | "mcps";
const TAB_ORDER: CapabilityTab[] = ["marketplace", "plugins", "skills", "mcps"];
const capabilityTabSpring = { type: "spring" as const, stiffness: 390, damping: 34, mass: 0.82 };
const capabilityPanelTransition = {
  duration: 0.16,
  ease: [0.22, 1, 0.36, 1] as const,
};
const marketplaceCardSpring = {
  type: "spring" as const,
  stiffness: 330,
  damping: 32,
  mass: 0.86,
};

const CAPABILITY_TABS: Array<{ id: CapabilityTab; label: string; icon: LucideIcon }> = [
  { id: "marketplace", label: "Marketplace", icon: Package },
  { id: "plugins", label: "Plugins", icon: Boxes },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "mcps", label: "MCPs", icon: Server },
];

function CapabilityTabs({
  active,
  onSelect,
}: {
  active: CapabilityTab;
  onSelect: (next: CapabilityTab) => void;
}) {
  const reduceMotion =
    Boolean(useReducedMotion()) || document.documentElement.dataset.motion === "none";
  return (
    <div className="capability-tabs" role="tablist" aria-label="Capability views">
      <LayoutGroup id="capability-tabs">
        {CAPABILITY_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            data-active={active === tab.id}
            onClick={() => onSelect(tab.id)}
          >
            {active === tab.id ? (
              <motion.span
                className="capability-tab-active"
                layoutId={reduceMotion ? undefined : "capability-tab-active"}
                transition={reduceMotion ? { duration: 0 } : capabilityTabSpring}
                aria-hidden="true"
              />
            ) : null}
            <tab.icon aria-hidden />
            <span>{tab.label}</span>
          </button>
        ))}
      </LayoutGroup>
    </div>
  );
}

/** Connect UI for one native credential slot (an env value written as
 * `{{keychain}}` in the server file). The secret is resolved into the launch
 * config per turn without entering the renderer again. */
function McpCredentialControl({
  server,
  slot,
  onChanged,
}: {
  server: string;
  slot: {
    key: string;
    configured: boolean;
    available: boolean;
    storage: "protectedLocalFile" | "osCredentialStore";
  };
  onChanged: () => void;
}) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const storageLabel =
    slot.storage === "protectedLocalFile"
      ? "protected developer storage"
      : "the operating system credential store";
  const save = async () => {
    if (busy || !secret.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      await bridge.setIntegratorMcpCredential(server, slot.key, secret.trim());
      setSecret("");
      setMessage(`Stored in ${storageLabel}.`);
      onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Could not save ${slot.key}.`);
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await bridge.clearIntegratorMcpCredential(server, slot.key);
      setMessage(`Removed from ${storageLabel}.`);
      onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Could not remove ${slot.key}.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="skill-credential-control">
      <span className="skill-credential-status">
        <KeyRound aria-hidden />
        <span>
          <strong>{slot.key}</strong>
          <small>
            {slot.available
              ? slot.configured
                ? `Connected — stored in ${storageLabel}`
                : "Not connected — paste a value to connect this server"
              : "Native app required for secure storage"}
          </small>
        </span>
      </span>
      <label className="skill-credential-input">
        <span className="sr-only">{slot.key}</span>
        <input
          type="password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
          }}
          placeholder={slot.configured ? "Paste a replacement value" : "Paste value"}
          autoComplete="off"
          spellCheck={false}
          disabled={!slot.available || busy}
        />
      </label>
      <div className="skill-credential-actions">
        <button
          className="ghost-button"
          type="button"
          disabled={!slot.available || busy || !secret.trim()}
          onClick={() => void save()}
        >
          {busy ? <LoaderCircle className="spin" /> : <KeyRound />} Connect
        </button>
        {slot.configured ? (
          <button
            className="ghost-button"
            type="button"
            disabled={busy}
            onClick={() => void clear()}
          >
            Disconnect
          </button>
        ) : null}
      </div>
      {message ? (
        <small className="skill-credential-message" role="status">
          {message}
        </small>
      ) : null}
    </div>
  );
}

/** Browser OAuth for remote MCP servers. The native host performs discovery,
 * PKCE, callback handling, refresh, and native credential storage; React receives
 * only connection state. */
function McpAuthorizationControl({
  server,
  onChanged,
}: {
  server: IntegratorMcpServer;
  onChanged: () => void;
}) {
  const authorization = server.authorization ?? {
    state: "notConnected" as const,
    available: true,
  };
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const connected = authorization.state === "connected";
  const connect = async () => {
    if (busy || !authorization.available) return;
    const approved = window.confirm(
      `Sign in to "${server.name}"?\n\nAI Integrator will open the provider's secure authorization page in your browser. Passwords and tokens never enter the chat or this settings page.`,
    );
    if (!approved) return;
    setBusy(true);
    setMessage("");
    try {
      await bridge.connectIntegratorMcp(server.name);
      setMessage("Connected. Authorization is stored in the operating system credential store.");
      onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not connect this MCP server.");
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (busy) return;
    const approved = window.confirm(
      `Disconnect "${server.name}"?\n\nThis removes its local authorization. The MCP server stays installed and keeps its current on/off setting.`,
    );
    if (!approved) return;
    setBusy(true);
    setMessage("");
    try {
      await bridge.disconnectIntegratorMcp(server.name);
      setMessage("Disconnected. The MCP server remains installed.");
      onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not disconnect this MCP server.");
    } finally {
      setBusy(false);
    }
  };
  const status =
    authorization.state === "connected"
      ? "Connected"
      : authorization.state === "needsAttention"
        ? "Sign-in needs attention"
        : "Sign in required";
  return (
    <div className="mcp-authorization-control" data-state={authorization.state}>
      <span className="mcp-authorization-status">
        {authorization.state === "connected" ? (
          <ShieldCheck aria-hidden />
        ) : authorization.state === "needsAttention" ? (
          <TriangleAlert aria-hidden />
        ) : (
          <KeyRound aria-hidden />
        )}
        <span>
          <strong>{status}</strong>
          <small>
            {authorization.available
              ? connected
                ? "Secure OAuth connection"
                : "Continue in your browser"
              : "Native credential storage is unavailable"}
          </small>
        </span>
      </span>
      <div className="mcp-authorization-actions">
        {connected ? (
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() => void disconnect()}
            aria-label={`Disconnect ${server.name}`}
          >
            {busy ? <LoaderCircle className="spin" /> : null}
            Disconnect
          </button>
        ) : (
          <button
            className="ghost-button mcp-authorization-signin"
            type="button"
            disabled={busy || !authorization.available}
            onClick={() => void connect()}
            aria-label={`Sign in to ${server.name}`}
          >
            {busy ? <LoaderCircle className="spin" /> : <ExternalLink />}
            {authorization.state === "needsAttention" ? "Reconnect" : "Sign in"}
          </button>
        )}
      </div>
      {message ? (
        <small className="mcp-authorization-message" role="status">
          {message}
        </small>
      ) : null}
    </div>
  );
}

/** One MCP server row, shared by the MCPs tab (full: origin chip, Remove for
 * user files) and a plugin's detail modal (simplified: no origin chip since
 * the view is already scoped to that plugin, no Remove — a plugin server
 * goes away only when the whole plugin is uninstalled). */
function McpServerRow({
  server,
  enabled,
  onToggle,
  onCredentialChanged,
  onRemove,
  onViewPlugin,
  showOrigin = true,
}: {
  server: IntegratorMcpServer;
  enabled: boolean;
  onToggle: (value: boolean) => void;
  onCredentialChanged: () => void;
  onRemove?: () => void;
  onViewPlugin?: (origin: string) => void;
  showOrigin?: boolean;
}) {
  const subtitle = [
    showOrigin ? (server.source === "user" ? server.origin : "Plugin server") : null,
    server.transport === "remote" ? "Remote connector" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="mcp-server-row">
      <span className="skills-plugin-tile" aria-hidden>
        <McpServerIcon server={server} />
      </span>
      <span className="mcp-server-title">
        <strong>
          {server.name}
          {showOrigin && server.source !== "user" && onViewPlugin ? (
            <Tooltip label={`View the ${server.origin} plugin`} placement="top">
              <button
                className="origin-chip"
                type="button"
                onClick={() => onViewPlugin(server.origin)}
              >
                {server.origin}
              </button>
            </Tooltip>
          ) : null}
        </strong>
        {subtitle ? <small>{subtitle}</small> : null}
        <code>{mcpLaunchPreview(server)}</code>
        {server.transport === "remote" && server.oauth ? (
          <McpAuthorizationControl server={server} onChanged={onCredentialChanged} />
        ) : null}
        {(server.credentials ?? []).map((slot) => (
          <McpCredentialControl
            key={slot.key}
            server={server.name}
            slot={slot}
            onChanged={onCredentialChanged}
          />
        ))}
      </span>
      <div className="mcp-server-actions">
        {onRemove ? (
          <button className="skills-uninstall-button" type="button" onClick={onRemove}>
            <Trash2 /> Remove
          </button>
        ) : null}
        <Switch checked={enabled} onChange={onToggle} label={`Enable ${server.name}`} />
      </div>
    </div>
  );
}

function McpServerCard({
  server,
  enabled,
  onToggle,
  onCredentialChanged,
  onRemove,
  onViewPlugin,
  reduceMotion,
}: {
  server: IntegratorMcpServer;
  enabled: boolean;
  onToggle: (value: boolean) => void;
  onCredentialChanged: () => void;
  onRemove?: () => void;
  onViewPlugin?: (origin: string) => void;
  reduceMotion: boolean;
}) {
  const activationWarning = mcpActivationWarning(server.name);
  const subtitle =
    server.transport === "remote"
      ? "Remote connector"
      : server.source === "user"
        ? "Local connector"
        : "Plugin connector";
  return (
    <motion.article
      layout={reduceMotion ? false : "position"}
      initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.96 }}
      transition={reduceMotion ? { duration: 0 } : marketplaceCardSpring}
      className="capability-card mcp-card"
      data-active={enabled}
    >
      <div className="capability-card-heading">
        <span className="browse-card-tile" aria-hidden>
          <McpServerIcon server={server} />
        </span>
        <span>
          <strong>
            {server.name}
            {server.source !== "user" && onViewPlugin ? (
              <Tooltip label={`View the ${server.origin} plugin`} placement="top">
                <button
                  className="origin-chip"
                  type="button"
                  onClick={() => onViewPlugin(server.origin)}
                >
                  {server.origin}
                </button>
              </Tooltip>
            ) : null}
          </strong>
          <small>{subtitle}</small>
        </span>
      </div>
      <code className="capability-card-command">{mcpLaunchPreview(server)}</code>
      <div className="capability-card-detail">
        {server.transport === "remote" && server.oauth ? (
          <McpAuthorizationControl server={server} onChanged={onCredentialChanged} />
        ) : null}
        {(server.credentials ?? []).map((slot) => (
          <McpCredentialControl
            key={slot.key}
            server={server.name}
            slot={slot}
            onChanged={onCredentialChanged}
          />
        ))}
      </div>
      <div className="capability-card-footer">
        <span className={enabled && activationWarning ? "mcp-high-consequence-status" : undefined}>
          {enabled && activationWarning ? <TriangleAlert aria-hidden /> : null}
          {enabled ? (activationWarning?.activeLabel ?? "Enabled") : "Off until explicitly enabled"}
        </span>
        <div className="capability-card-actions">
          {onRemove ? (
            <button className="skills-uninstall-button" type="button" onClick={onRemove}>
              <Trash2 /> Remove
            </button>
          ) : null}
          <Switch checked={enabled} onChange={onToggle} label={`Enable ${server.name}`} />
        </div>
      </div>
    </motion.article>
  );
}

function CuratedMcpCard({
  entry,
  added,
  busy,
  onAdd,
  reduceMotion,
}: {
  entry: (typeof CURATED_MCP_SERVERS)[number];
  added: boolean;
  busy: boolean;
  onAdd: () => void;
  reduceMotion: boolean;
}) {
  const launch =
    entry.config.url ?? [entry.config.command ?? "", ...(entry.config.args ?? [])].join(" ").trim();
  return (
    <motion.article
      layout={reduceMotion ? false : "position"}
      className="capability-card mcp-card"
      data-active={added}
    >
      <div className="capability-card-heading">
        <span className="browse-card-tile" aria-hidden>
          <SkillBrandIcon brands={CURATED_INSTALL_BRANDS[entry.icon]} />
        </span>
        <span>
          <strong>{entry.label}</strong>
          <small>{entry.config.url ? "Remote connector" : "Local connector"}</small>
        </span>
      </div>
      <p className="capability-card-description">{entry.description}</p>
      <code className="capability-card-command">{launch}</code>
      <div className="capability-card-footer">
        <span>{added ? "Added · starts off" : "Official pinned configuration"}</span>
        <button className="ghost-button" type="button" disabled={busy || added} onClick={onAdd}>
          {added ? <Check /> : <Plus />}
          {added ? "Added" : "Add"}
        </button>
      </div>
    </motion.article>
  );
}

/** The MCPs tab: servers from the user's MCPs folder and plugin bundles.
 * Enabling is always explicit and always confirms the exact command or URL
 * the next turn may launch — an MCP server is a process, not a document. */
function McpSettings({
  settings,
  setSetting,
  mcpOverview,
  onMcpOverview,
  onViewPlugin,
}: {
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
  mcpOverview: IntegratorMcpOverview | null;
  onMcpOverview: (overview: IntegratorMcpOverview) => void;
  onViewPlugin?: (origin: string) => void;
}) {
  const reduceMotion =
    Boolean(useReducedMotion()) || document.documentElement.dataset.motion === "none";
  const overview = mcpOverview;
  const setOverview = onMcpOverview;
  const refreshServers = () => {
    void bridge
      .listIntegratorMcps()
      .then(onMcpOverview)
      .catch(() => undefined);
  };
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingActivation, setPendingActivation] = useState<McpActivationRequest | null>(null);
  const [form, setForm] = useState({
    name: "",
    transport: "stdio" as "stdio" | "remote",
    command: "",
    args: "",
    env: "",
    url: "",
    oauth: false,
  });

  const overrides = readSkillEnablement(settings[MCP_ENABLED_KEY]);
  const isOn = (server: IntegratorMcpServer) => overrides[server.name] ?? server.enabled;
  const toggleServer = (server: IntegratorMcpServer, value: boolean) => {
    if (value) {
      const warning = mcpActivationWarning(server.name);
      if (warning) {
        setPendingActivation({ server, warning });
        return;
      }
      const approved = window.confirm(
        `Enable "${server.name}"?\n\nThe next turn will be allowed to launch:\n${mcpLaunchPreview(server)}`,
      );
      if (!approved) return;
    }
    setSetting(MCP_ENABLED_KEY, withSkillEnablement(overrides, server.name, value));
  };
  const confirmActivation = () => {
    if (!pendingActivation) return;
    const current = readSkillEnablement(settings[MCP_ENABLED_KEY]);
    setSetting(MCP_ENABLED_KEY, withSkillEnablement(current, pendingActivation.server.name, true));
    setPendingActivation(null);
  };
  const save = (name: string, config: IntegratorMcpConfig, note: string) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    void bridge
      .saveIntegratorMcp(name, config)
      .then((next) => {
        setOverview(next);
        setMessage(note);
        setForm({
          name: "",
          transport: "stdio",
          command: "",
          args: "",
          env: "",
          url: "",
          oauth: false,
        });
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : "Could not save this server.");
      })
      .finally(() => setBusy(false));
  };
  const submitForm = () => {
    const name = form.name.trim();
    if (!name) {
      setMessage("Name the server first.");
      return;
    }
    const parsed = parseMcpForm(form);
    if (!parsed.config) {
      setMessage(parsed.error ?? "Could not read the server form.");
      return;
    }
    save(name, parsed.config, `Saved ${name} to your MCPs folder. It starts off.`);
  };
  const importAll = () => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    void bridge
      .importIntegratorMcps()
      .then((result) => {
        setOverview(result.overview);
        const skipped =
          result.skipped.length > 0 ? `; skipped ${result.skipped.length} already present` : "";
        setMessage(
          result.imported.length > 0
            ? `Imported ${result.imported.join(", ")}${skipped}.`
            : `Nothing new to import${skipped}.`,
        );
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : "Could not import servers.");
      })
      .finally(() => setBusy(false));
  };
  const remove = (name: string) => {
    if (busy) return;
    if (!window.confirm(`Remove "${name}" from your MCPs folder?`)) return;
    setBusy(true);
    void bridge
      .removeIntegratorMcp(name)
      .then((next) => {
        setOverview(next);
        setMessage(`Removed ${name}.`);
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : "Could not remove this server.");
      })
      .finally(() => setBusy(false));
  };

  const servers = overview?.servers ?? [];
  const savedNames = new Set(servers.map((server) => server.name));
  return (
    <>
      <McpActivationDialog
        request={pendingActivation}
        onClose={() => setPendingActivation(null)}
        onConfirm={confirmActivation}
      />
      <section className="settings-section">
        <header>
          <h2>MCP servers</h2>
          <p>
            External tools your agents can call. Enabled servers attach to the next Codex, Claude,
            Antigravity, Cursor, or Grok session. If a provider cannot carry a server&apos;s
            transport, the chat reports that incompatibility. Remote servers can be signed into
            directly from their card. Every server starts off.
          </p>
        </header>
        <SettingRow
          label="MCPs folder"
          description="One JSON file per server — hand-editing is always legal; this page is a convenience over it."
        >
          <code className="settings-path">{overview?.mcpsRoot ?? "…"}</code>
        </SettingRow>
        <SettingRow
          label="Import existing servers"
          description="Copies servers configured in Claude Code, Cursor, or Claude Desktop into your MCPs folder. Their configs are read, never written."
        >
          <button className="ghost-button" type="button" disabled={busy} onClick={importAll}>
            {busy ? <LoaderCircle className="spin" /> : <Download />} Import
          </button>
        </SettingRow>
        {servers.length > 0 ? (
          <div className="capability-card-grid">
            <AnimatePresence initial={false} mode="popLayout">
              {servers.map((server) => (
                <McpServerCard
                  key={server.name}
                  server={server}
                  enabled={isOn(server)}
                  onToggle={(value) => toggleServer(server, value)}
                  onCredentialChanged={refreshServers}
                  onViewPlugin={onViewPlugin}
                  onRemove={server.source === "user" ? () => remove(server.name) : undefined}
                  reduceMotion={reduceMotion}
                />
              ))}
            </AnimatePresence>
          </div>
        ) : null}
        {servers.length === 0 ? (
          <p className="skills-empty-state">
            No MCP servers yet. Add one below, import your existing ones, or install a plugin that
            bundles servers.
          </p>
        ) : null}
        {message ? (
          <p className="settings-action-message" role="status">
            {message}
          </p>
        ) : null}
      </section>
      <section className="settings-section">
        <header>
          <h2>Common servers</h2>
          <p>Official, pinned configurations — one click writes the file to your MCPs folder.</p>
        </header>
        <div className="capability-card-grid">
          {CURATED_MCP_SERVERS.map((entry) => (
            <CuratedMcpCard
              key={entry.name}
              entry={entry}
              added={savedNames.has(entry.name)}
              busy={busy}
              onAdd={() => save(entry.name, entry.config, `Added ${entry.label}. It starts off.`)}
              reduceMotion={reduceMotion}
            />
          ))}
        </div>
      </section>
      <section className="settings-section">
        <header>
          <h2>Add your own</h2>
          <p>
            A local command (one token per argument, no shell quoting) or a remote URL. Use a
            keychain placeholder for local-server secrets so values never enter the JSON file.
          </p>
        </header>
        <div className="mcp-form">
          <input
            className="settings-inline-input"
            value={form.name}
            placeholder="server-name"
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
          />
          <Dropdown
            className="compact-select"
            aria-label="Transport"
            value={form.transport}
            options={[
              { value: "stdio", label: "Local command" },
              { value: "remote", label: "Remote URL" },
            ]}
            onChange={(value) =>
              setForm((current) => ({ ...current, transport: value as "stdio" | "remote" }))
            }
          />
          {form.transport === "stdio" ? (
            <>
              <input
                className="settings-inline-input mcp-form-wide"
                value={form.command}
                placeholder="command (e.g. npx)"
                onChange={(event) =>
                  setForm((current) => ({ ...current, command: event.target.value }))
                }
              />
              <input
                className="settings-inline-input mcp-form-wide"
                value={form.args}
                placeholder="arguments (space separated)"
                onChange={(event) =>
                  setForm((current) => ({ ...current, args: event.target.value }))
                }
              />
              <textarea
                className="mcp-form-env"
                value={form.env}
                placeholder={
                  "environment (KEY=value per line; use KEY={{keychain}} to store the secret in your OS keychain)"
                }
                rows={2}
                onChange={(event) =>
                  setForm((current) => ({ ...current, env: event.target.value }))
                }
              />
            </>
          ) : (
            <>
              <input
                className="settings-inline-input mcp-form-wide"
                value={form.url}
                placeholder="https://example.com/mcp"
                onChange={(event) =>
                  setForm((current) => ({ ...current, url: event.target.value }))
                }
              />
              <div className="mcp-form-auth">
                <span>
                  <strong>Browser sign-in</strong>
                  <small>Enable when the server requires OAuth.</small>
                </span>
                <Switch
                  checked={form.oauth}
                  onChange={(oauth) => setForm((current) => ({ ...current, oauth }))}
                  label="Requires browser sign-in"
                />
              </div>
            </>
          )}
          <button
            className="ghost-button"
            type="button"
            disabled={busy || !form.name.trim()}
            onClick={submitForm}
          >
            {busy ? <LoaderCircle className="spin" /> : <Plus />} Save server
          </button>
        </div>
      </section>
    </>
  );
}

/** What to read: a local (installed) skill by name, or one skill file from
 * a not-yet-installed curated repository, fetched fresh from GitHub. */
type SkillDetailTarget =
  | { kind: "local"; name: string; description: string }
  | { kind: "remote"; repository: string; path: string; name: string; description: string };

type SkillBodyState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; body: string; truncated: boolean };

function skillTargetKey(target: SkillDetailTarget): string {
  return target.kind === "remote"
    ? `remote:${target.repository}:${target.path}`
    : `local:${target.name}`;
}

function readableSkillMarkdown(body: string): string {
  const source = body.replace(/^\uFEFF/, "");
  const withoutFrontmatter = source.replace(
    /^---[^\S\r\n]*\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/,
    "",
  );
  return withoutFrontmatter.trim() ? withoutFrontmatter : source;
}

function SkillMarkdownLink({
  href,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!href || event.defaultPrevented || event.button !== 0) return;
    event.preventDefault();
    void openExternalLink(href).catch(() => {
      // A rejected or unsupported URL must never navigate the app webview.
    });
  };

  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick}>
      {children}
    </a>
  );
}

function SkillMarkdownImage({ alt }: { alt?: string }) {
  return (
    <span className="skill-markdown-image" role="note">
      Image reference{alt ? ` · ${alt}` : ""}
    </span>
  );
}

const SKILL_MARKDOWN_COMPONENTS = {
  a: SkillMarkdownLink,
  img: SkillMarkdownImage,
};

function SkillMarkdown({ body }: { body: string }) {
  return (
    <div className="skill-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={SKILL_MARKDOWN_COMPONENTS}>
        {readableSkillMarkdown(body)}
      </ReactMarkdown>
    </div>
  );
}

function InlineSkillDisclosure({ id, target }: { id: string; target: SkillDetailTarget }) {
  const reduceMotion = useReducedMotion();
  const [state, setState] = useState<SkillBodyState>({ status: "loading" });
  const targetKey = skillTargetKey(target);

  useEffect(() => {
    let cancelled = false;
    const load: Promise<RemoteSkillBody | IntegratorSkillBody> =
      target.kind === "remote"
        ? bridge.previewSkillBody(target.repository, target.path)
        : bridge.getIntegratorSkillBody(target.name);
    void load
      .then((result) => {
        if (!cancelled) {
          setState({ status: "ready", body: result.body, truncated: result.truncated });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Could not read this skill.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // Target identity is captured by the stable key; the object is rebuilt
    // during list renders and should not restart an in-flight read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  return (
    <motion.div
      id={id}
      className="skill-detail-disclosure"
      role="region"
      aria-label={`${target.name} instructions`}
      initial={reduceMotion ? false : { height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : {
              height: { duration: 0.24, ease: [0.22, 1, 0.36, 1] },
              opacity: { duration: 0.16, ease: "easeOut" },
            }
      }
    >
      <div className="skill-detail-disclosure-inner">
        <span className="skill-detail-label">Skill instructions</span>
        {state.status === "loading" ? (
          <p className="plugin-modal-loading">
            <LoaderCircle className="spin" aria-hidden />
            Reading the skill…
          </p>
        ) : null}
        {state.status === "error" ? (
          <p className="plugin-modal-error" role="alert">
            <TriangleAlert aria-hidden /> {state.message}
          </p>
        ) : null}
        {state.status === "ready" ? (
          <>
            {state.truncated ? (
              <p className="plugin-modal-truncated">
                This file is unusually large — showing the first portion.
              </p>
            ) : null}
            <SkillMarkdown body={state.body} />
          </>
        ) : null}
      </div>
    </motion.div>
  );
}

/** First-class plugin view: what a plugin is, where it comes from, and the
 * exact skills and MCP servers it ships — for curated catalog entries and
 * installed plugins alike. Management (install / uninstall) lives here so
 * the Skills and MCPs tabs never repeat whole plugin listings. */
function PluginDetailModal({
  folderId,
  curated,
  group,
  servers,
  isEnabled,
  onToggleSkill,
  isServerEnabled,
  onToggleServer,
  onCredentialChanged,
  installBusy,
  uninstalling,
  onInstall,
  onUninstall,
  onClose,
}: {
  folderId: string;
  curated?: (typeof CURATED_PLUGIN_INSTALLS)[number];
  group?: { title: string; source: string; skills: IntegratorSkillInfo[] };
  servers: IntegratorMcpServer[];
  isEnabled: (skill: IntegratorSkillInfo) => boolean;
  onToggleSkill: (skill: IntegratorSkillInfo, enabled: boolean) => void;
  isServerEnabled: (server: IntegratorMcpServer) => boolean;
  onToggleServer: (server: IntegratorMcpServer, enabled: boolean) => void;
  onCredentialChanged: () => void;
  installBusy: boolean;
  uninstalling: string;
  onInstall?: () => void;
  onUninstall?: () => void;
  onClose: () => void;
}) {
  const [openSkill, setOpenSkill] = useState<SkillDetailTarget | null>(null);
  const openSkillKey = openSkill ? skillTargetKey(openSkill) : null;
  const toggleSkillDetail = (target: SkillDetailTarget) => {
    const key = skillTargetKey(target);
    setOpenSkill((current) => (current && skillTargetKey(current) === key ? null : target));
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (openSkill) {
        setOpenSkill(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, openSkill]);
  const label = curated?.label ?? group?.title ?? folderId;
  const brands = curated ? CURATED_INSTALL_BRANDS[curated.icon] : PLUGIN_GROUP_BRANDS[folderId];
  const installed = Boolean(group);

  type PreviewState =
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; data: RemoteSkillsPreview };
  const shouldPreview = !installed && Boolean(curated);
  const [preview, setPreview] = useState<PreviewState | null>(
    shouldPreview ? { status: "loading" } : null,
  );
  useEffect(() => {
    if (!shouldPreview || !curated) return;
    let cancelled = false;
    void bridge
      .previewCuratedPlugin(curated.repository)
      .then((data) => {
        if (!cancelled) setPreview({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPreview({
            status: "error",
            message: error instanceof Error ? error.message : "Could not read skills from GitHub.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch only when the target repository changes, not on every
    // `installed` recompute from unrelated state churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curated?.repository, shouldPreview]);
  return (
    <motion.div
      className="plugin-modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.14 }}
      onClick={onClose}
    >
      <motion.div
        className="plugin-modal"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="plugin-modal-header">
          <span className="skills-plugin-tile plugin-modal-tile" aria-hidden>
            <SkillBrandIcon brands={brands} />
          </span>
          <div>
            <h2>{label}</h2>
            <div className="plugin-modal-chips">
              <span className="plugin-modal-chip" data-kind={installed ? "installed" : "missing"}>
                {installed
                  ? (SKILL_SOURCE_LABELS[group?.source ?? ""] ?? group?.source)
                  : "Not installed"}
              </span>
              {curated ? (
                <span className="plugin-modal-chip">
                  {group ? group.skills.length : curated.skillCount}{" "}
                  {(group ? group.skills.length : curated.skillCount) === 1 ? "skill" : "skills"}
                </span>
              ) : group ? (
                <span className="plugin-modal-chip">
                  {group.skills.length} {group.skills.length === 1 ? "skill" : "skills"}
                </span>
              ) : null}
              {(curated?.mcpCount ?? 0) > 0 || servers.length > 0 ? (
                <span className="plugin-modal-chip">
                  {servers.length > 0 ? servers.length : curated?.mcpCount} MCP
                </span>
              ) : null}
              {curated?.license ? (
                <span className="plugin-modal-chip">{curated.license}</span>
              ) : null}
              {curated ? (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => void openExternalLink(`https://github.com/${curated.repository}`)}
                >
                  {curated.repository} <ExternalLink />
                </button>
              ) : null}
            </div>
          </div>
          <button className="ghost-button plugin-modal-close" type="button" onClick={onClose}>
            <X /> Close
          </button>
        </header>
        {curated ? <p className="plugin-modal-description">{curated.description}</p> : null}
        <div className="plugin-modal-body">
          {group ? (
            <>
              <h3>Skills · {group.skills.length}</h3>
              <div className="plugin-modal-skills">
                {group.skills.map((skill, index) => {
                  const target: SkillDetailTarget = {
                    kind: "local",
                    name: skill.name,
                    description: skill.description,
                  };
                  const targetKey = skillTargetKey(target);
                  const expanded = openSkillKey === targetKey;
                  const detailId = `plugin-skill-${index}`;
                  return (
                    <div
                      className="plugin-skill-disclosure-item"
                      data-expanded={expanded}
                      key={skill.name}
                    >
                      <SkillSettingsRow
                        skill={skill}
                        enabled={isEnabled(skill)}
                        onToggle={(value) => onToggleSkill(skill, value)}
                        onCredentialChanged={onCredentialChanged}
                        onOpenDetail={() => toggleSkillDetail(target)}
                        expanded={expanded}
                        detailId={detailId}
                      />
                      <AnimatePresence initial={false}>
                        {expanded ? (
                          <InlineSkillDisclosure id={detailId} target={target} key={targetKey} />
                        ) : null}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            </>
          ) : curated ? (
            <>
              {preview?.status === "loading" ? (
                <p className="plugin-modal-loading">
                  <LoaderCircle className="spin" aria-hidden />
                  Reading skills from github.com/{curated.repository}…
                </p>
              ) : null}
              {preview?.status === "ready" ? (
                <>
                  <h3>
                    Skills · {preview.data.skills.length}
                    {preview.data.truncated ? ` of ${preview.data.totalFound}` : ""}
                  </h3>
                  <ul className="plugin-modal-list">
                    {preview.data.skills.map((skill, index) => {
                      const target: SkillDetailTarget = {
                        kind: "remote",
                        repository: curated.repository,
                        path: skill.path,
                        name: skill.name,
                        description: skill.description,
                      };
                      const targetKey = skillTargetKey(target);
                      const expanded = openSkillKey === targetKey;
                      const detailId = `plugin-remote-skill-${index}`;
                      return (
                        <li key={skill.path} data-expanded={expanded}>
                          <div
                            className="plugin-modal-list-trigger"
                            role="button"
                            tabIndex={0}
                            aria-expanded={expanded}
                            aria-controls={detailId}
                            onClick={() => toggleSkillDetail(target)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                toggleSkillDetail(target);
                              }
                            }}
                          >
                            <span className="plugin-modal-list-name">
                              <span className="plugin-modal-dot" aria-hidden />
                              <strong>{skill.name}</strong>
                              <ChevronDown data-open={expanded} aria-hidden />
                            </span>
                            <small>{skill.description}</small>
                          </div>
                          <AnimatePresence initial={false}>
                            {expanded ? (
                              <InlineSkillDisclosure
                                id={detailId}
                                target={target}
                                key={targetKey}
                              />
                            ) : null}
                          </AnimatePresence>
                        </li>
                      );
                    })}
                  </ul>
                  {preview.data.truncated ? (
                    <p className="plugin-modal-truncated">
                      Showing the first {preview.data.skills.length} of {preview.data.totalFound}{" "}
                      skills.{" "}
                      <button
                        className="text-button"
                        type="button"
                        onClick={() =>
                          void openExternalLink(`https://github.com/${curated.repository}`)
                        }
                      >
                        View the rest on GitHub <ExternalLink />
                      </button>
                    </p>
                  ) : null}
                  {curated.mcpCount > 0 ? (
                    <p className="plugin-modal-mcp-note">
                      <Server aria-hidden /> Also ships {curated.mcpCount} MCP server{" "}
                      {curated.mcpCount === 1 ? "config" : "configs"} — visible after install.
                    </p>
                  ) : null}
                </>
              ) : null}
              {preview?.status === "error" ? (
                <>
                  <p className="plugin-modal-error" role="alert">
                    <TriangleAlert aria-hidden /> {preview.message}
                  </p>
                  <h3>What you'll get</h3>
                  <ul className="plugin-modal-facts">
                    <li>
                      <Sparkles aria-hidden />
                      <span>
                        <strong>
                          {curated.skillCount} portable{" "}
                          {curated.skillCount === 1 ? "skill" : "skills"}
                        </strong>{" "}
                        — verified against the repository. Every one starts off until you enable it.
                      </span>
                    </li>
                    {curated.mcpCount > 0 ? (
                      <li>
                        <Server aria-hidden />
                        <span>
                          <strong>
                            {curated.mcpCount} MCP server{" "}
                            {curated.mcpCount === 1 ? "config" : "configs"}
                          </strong>{" "}
                          — each needs explicit enablement and confirms what it launches.
                        </span>
                      </li>
                    ) : null}
                    <li>
                      <Download aria-hidden />
                      <span>
                        Cloned with the GitHub CLI from{" "}
                        <strong>github.com/{curated.repository}</strong> — no other network access.
                      </span>
                    </li>
                    <li>
                      <Folder aria-hidden />
                      <span>
                        Lands in{" "}
                        <strong>
                          Documents/AI Integrator/Plugins/{curated.repository.replace("/", "-")}
                        </strong>{" "}
                        — a plain folder you can inspect or delete anytime.
                      </span>
                    </li>
                  </ul>
                </>
              ) : null}
            </>
          ) : null}
          {servers.length > 0 ? (
            <>
              <h3>MCP servers · {servers.length}</h3>
              <div className="plugin-modal-skills">
                {servers.map((server) => (
                  <McpServerRow
                    key={server.name}
                    server={server}
                    enabled={isServerEnabled(server)}
                    onToggle={(value) => onToggleServer(server, value)}
                    onCredentialChanged={onCredentialChanged}
                    showOrigin={false}
                  />
                ))}
              </div>
            </>
          ) : null}
        </div>
        <footer className="plugin-modal-footer">
          {!installed && onInstall ? (
            <button
              className="ghost-button"
              type="button"
              disabled={installBusy}
              onClick={onInstall}
            >
              {installBusy ? <LoaderCircle className="spin" /> : <Download />} Install
            </button>
          ) : null}
          {installed && onUninstall ? (
            <button
              className="skills-uninstall-button"
              type="button"
              disabled={Boolean(uninstalling)}
              onClick={onUninstall}
            >
              <Trash2 /> Uninstall
            </button>
          ) : null}
        </footer>
      </motion.div>
    </motion.div>
  );
}

/** Individual-skill reader used from the flat Skills tab. Plugin bundles
 * keep their inline disclosure inside PluginDetailModal as well. */
function SkillDetailModal({ target, onClose }: { target: SkillDetailTarget; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  type BodyState =
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; body: string; truncated: boolean };
  const [state, setState] = useState<BodyState>({ status: "loading" });
  const targetKey =
    target.kind === "remote" ? `${target.repository}\0${target.path}` : `local:${target.name}`;
  useEffect(() => {
    let cancelled = false;
    const load: Promise<RemoteSkillBody | IntegratorSkillBody> =
      target.kind === "remote"
        ? bridge.previewSkillBody(target.repository, target.path)
        : bridge.getIntegratorSkillBody(target.name);
    void load
      .then((result) => {
        if (!cancelled)
          setState({ status: "ready", body: result.body, truncated: result.truncated });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Could not read this skill.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  return (
    <motion.div
      className="plugin-modal-backdrop skill-modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.14 }}
      onClick={onClose}
    >
      <motion.div
        className="plugin-modal skill-modal"
        role="dialog"
        aria-modal="true"
        aria-label={target.name}
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="plugin-modal-header">
          <div>
            <h2>{target.name}</h2>
            <p>{target.description}</p>
          </div>
          <button className="ghost-button plugin-modal-close" type="button" onClick={onClose}>
            <X /> Close
          </button>
        </header>
        <div className="plugin-modal-body">
          {state.status === "loading" ? (
            <p className="plugin-modal-loading">
              <LoaderCircle className="spin" aria-hidden />
              Reading the full skill…
            </p>
          ) : null}
          {state.status === "error" ? (
            <p className="plugin-modal-error" role="alert">
              <TriangleAlert aria-hidden /> {state.message}
            </p>
          ) : null}
          {state.status === "ready" ? (
            <>
              {state.truncated ? (
                <p className="plugin-modal-truncated">
                  This file is unusually large — showing the first portion.
                </p>
              ) : null}
              <SkillMarkdown body={state.body} />
            </>
          ) : null}
        </div>
      </motion.div>
    </motion.div>
  );
}

function MarketplaceCard({
  entry,
  installed,
  uninstalling,
  reduceMotion,
  onOpen,
  onUninstall,
}: {
  entry: (typeof CURATED_PLUGIN_INSTALLS)[number];
  installed: boolean;
  uninstalling: boolean;
  reduceMotion: boolean;
  onOpen: () => void;
  onUninstall: () => void;
}) {
  return (
    <motion.div
      layout={reduceMotion ? false : "position"}
      layoutId={reduceMotion ? undefined : `marketplace-card-${entry.repository}`}
      transition={reduceMotion ? { duration: 0 } : marketplaceCardSpring}
      role="button"
      tabIndex={0}
      aria-label={entry.label}
      className="browse-card marketplace-card"
      data-installed={installed}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="marketplace-card-heading">
        <span className="browse-card-tile" aria-hidden>
          <SkillBrandIcon brands={CURATED_INSTALL_BRANDS[entry.icon]} />
        </span>
        <strong>{entry.label}</strong>
      </div>
      <small>{entry.description}</small>
      <div className="browse-card-footer">
        <span className="browse-card-state">{installed ? "Installed" : "View & install"}</span>
        {installed ? (
          <button
            className="marketplace-uninstall-button"
            type="button"
            disabled={uninstalling}
            onClick={(event) => {
              event.stopPropagation();
              onUninstall();
            }}
            aria-label={`Uninstall ${entry.label}`}
          >
            {uninstalling ? <LoaderCircle className="spin" /> : <Trash2 />}
            Uninstall
          </button>
        ) : null}
      </div>
    </motion.div>
  );
}

function SkillsSettings({
  settings,
  setSetting,
}: {
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
}) {
  const [overview, setOverview] = useState<IntegratorSkillsOverview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [installRepo, setInstallRepo] = useState("");
  const [installBusy, setInstallBusy] = useState(false);
  const [installMessage, setInstallMessage] = useState("");
  const [uninstalling, setUninstalling] = useState("");
  const [togglingPlugin, setTogglingPlugin] = useState("");
  const reduceMotion =
    Boolean(useReducedMotion()) || document.documentElement.dataset.motion === "none";
  const [tab, setTab] = useState<CapabilityTab>("marketplace");
  const [panel, setPanel] = useState<{ tab: CapabilityTab; direction: number }>({
    tab: "marketplace",
    direction: 0,
  });
  const [, startTabTransition] = useTransition();
  const selectTab = useCallback(
    (next: CapabilityTab) => {
      if (next === tab) return;
      const from = TAB_ORDER.indexOf(tab);
      const to = TAB_ORDER.indexOf(next);
      const direction = to > from ? 1 : -1;
      setTab(next);
      startTabTransition(() => setPanel({ tab: next, direction }));
    },
    [tab],
  );
  const [skillQuery, setSkillQuery] = useState("");
  const [mcpOverview, setMcpOverview] = useState<IntegratorMcpOverview | null>(null);
  /** Plugin folder id whose first-class detail view is open. */
  const [viewPlugin, setViewPlugin] = useState<string | null>(null);
  /** Standalone skill whose full body is open from the flat Skills tab. */
  const [viewSkill, setViewSkill] = useState<SkillDetailTarget | null>(null);

  const refresh = () => {
    // Fetched independently: an MCP inventory hiccup (e.g. mid-rebuild)
    // must never blank the skills and plugins views.
    void bridge
      .listIntegratorSkills()
      .then((next) => {
        startTransition(() => {
          setOverview(next);
          setLoadError("");
        });
      })
      .catch((error: unknown) => {
        setLoadError(
          error instanceof Error ? error.message : "Could not read the local skills inventory.",
        );
      });
    void bridge
      .listIntegratorMcps()
      .then((next) => startTransition(() => setMcpOverview(next)))
      .catch(() => setMcpOverview(null));
  };
  useEffect(refresh, []);

  const skillsEnabledSetting = settings[SKILLS_ENABLED_KEY];
  const overrides = useMemo(
    () => readSkillEnablement(skillsEnabledSetting),
    [skillsEnabledSetting],
  );
  const toggle = (skill: IntegratorSkillInfo, enabled: boolean) =>
    setSetting(SKILLS_ENABLED_KEY, withSkillEnablement(overrides, skill.name, enabled));

  // Mirrors McpSettings' own derivation of the same setting key — both read
  // and write `settings`/`setSetting` from the single top-level source of
  // truth, so the MCPs tab and this cascade/modal never disagree.
  const mcpEnabledSetting = settings[MCP_ENABLED_KEY];
  const mcpOverrides = useMemo(() => readSkillEnablement(mcpEnabledSetting), [mcpEnabledSetting]);
  const isServerEnabled = (server: IntegratorMcpServer) =>
    mcpOverrides[server.name] ?? server.enabled;
  const setServerEnabled = (server: IntegratorMcpServer, enabled: boolean) => {
    if (enabled) {
      const approved = window.confirm(
        `Enable "${server.name}"?\n\nThe next turn will be allowed to launch:\n${mcpLaunchPreview(server)}`,
      );
      if (!approved) return;
    }
    setSetting(MCP_ENABLED_KEY, withSkillEnablement(mcpOverrides, server.name, enabled));
  };
  const serversByOrigin = useMemo(() => {
    const grouped = new Map<string, IntegratorMcpServer[]>();
    for (const server of mcpOverview?.servers ?? []) {
      const servers = grouped.get(server.origin) ?? [];
      servers.push(server);
      grouped.set(server.origin, servers);
    }
    return grouped;
  }, [mcpOverview]);
  const serversForOrigin = (origin: string) => serversByOrigin.get(origin) ?? [];

  /** The plugin's master switch: on cascades to every skill and MCP server
   * it owns; off silences them all. Individual switches (in the Skills tab,
   * the MCPs tab, or this plugin's own detail modal) still refine the
   * result afterward — the cascade is a starting point, not a lock. */
  const toggleGroupAll = async (
    group: { title: string; skills: IntegratorSkillInfo[] },
    label: string,
    enabled: boolean,
  ) => {
    if (togglingPlugin) return;
    setTogglingPlugin(group.title);
    setInstallMessage("");
    try {
      const latestMcpOverview = await bridge.listIntegratorMcps();
      setMcpOverview(latestMcpOverview);
      const servers = latestMcpOverview.servers.filter((server) => server.origin === group.title);
      if (enabled && servers.length > 0) {
        const lines = servers.map((server) => `• ${server.name}: ${mcpLaunchPreview(server)}`);
        const approved = window.confirm(
          `Enable "${label}"?\n\nThis turns on ${group.skills.length} ${
            group.skills.length === 1 ? "skill" : "skills"
          } and ${servers.length} MCP ${
            servers.length === 1 ? "server" : "servers"
          }. The MCP ${servers.length === 1 ? "server" : "servers"} will be allowed to launch:\n${lines.join("\n")}`,
        );
        if (!approved) return;
      }
      if (servers.length > 0) {
        setSetting(MCP_ENABLED_KEY, withSkillsEnablement(mcpOverrides, servers, enabled));
      }
      setSetting(SKILLS_ENABLED_KEY, withSkillsEnablement(overrides, group.skills, enabled));
    } catch (error) {
      setInstallMessage(
        error instanceof Error
          ? `Could not verify the MCP servers bundled with ${label}: ${error.message}. Nothing changed.`
          : `Could not verify the MCP servers bundled with ${label}. Nothing changed.`,
      );
    } finally {
      setTogglingPlugin("");
    }
  };

  const install = (repository: string) => {
    const trimmed = repository.trim();
    if (!trimmed || installBusy) return;
    setInstallBusy(true);
    setInstallMessage("");
    void bridge
      .installIntegratorPlugin(trimmed)
      .then((next) => {
        setOverview(next);
        setInstallRepo("");
        setInstallMessage(`Installed ${trimmed}. Its skills start off; enable the ones you want.`);
        void bridge
          .listIntegratorMcps()
          .then(setMcpOverview)
          .catch(() => undefined);
      })
      .catch((error: unknown) => {
        setInstallMessage(
          error instanceof Error ? error.message : "Could not install this plugin.",
        );
      })
      .finally(() => setInstallBusy(false));
  };

  const uninstall = (pluginId: string, label: string) => {
    if (uninstalling) return;
    if (
      !window.confirm(
        `Uninstall ${label}? This removes its local plugin folder and bundled resources from Documents/AI Integrator/Plugins.`,
      )
    ) {
      return;
    }
    setUninstalling(pluginId);
    setInstallMessage("");
    void bridge
      .uninstallIntegratorPlugin(pluginId)
      .then((next) => {
        setOverview(next);
        setInstallMessage(`Uninstalled ${label}.`);
        void bridge
          .listIntegratorMcps()
          .then(setMcpOverview)
          .catch(() => undefined);
      })
      .catch((error: unknown) => {
        setInstallMessage(
          error instanceof Error ? error.message : "Could not uninstall this plugin.",
        );
      })
      .finally(() => setUninstalling(""));
  };

  const {
    groups,
    mcpCountByOrigin,
    installedGroups,
    integratorGroups,
    curatedByFolder,
    installedMarketplaceEntries,
    availableMarketplaceEntries,
    allSkills,
  } = useMemo(() => {
    const nextGroups = groupSkills(overview?.skills ?? []);
    const nextMcpCountByOrigin = new Map<string, number>();
    for (const [origin, servers] of serversByOrigin) {
      nextMcpCountByOrigin.set(origin, servers.length);
    }
    // A bundle earns its own plugin card only by actually bundling something:
    // more than one skill, or at least one MCP server. A lone skill is just a
    // skill — it belongs in the Skills tab, not dressed up as a plugin.
    const isPluginWorthy = (group: (typeof nextGroups)[number]) =>
      group.skills.length > 1 || (nextMcpCountByOrigin.get(group.title) ?? 0) > 0;
    const pluginGroups = nextGroups.filter(isPluginWorthy);
    const nextInstalledPluginIds = new Set(
      nextGroups.filter((group) => group.source === "plugin").map((group) => group.title),
    );
    const nextCuratedByFolder = new Map(
      CURATED_PLUGIN_INSTALLS.map((entry) => [entry.repository.replace("/", "-"), entry]),
    );
    const marketplaceEntries = CURATED_PLUGIN_INSTALLS.map((entry) => {
      const folderId = entry.repository.replace("/", "-");
      return { entry, folderId, installed: nextInstalledPluginIds.has(folderId) };
    });
    return {
      groups: nextGroups,
      mcpCountByOrigin: nextMcpCountByOrigin,
      installedGroups: pluginGroups.filter((group) => group.source !== "first-party"),
      integratorGroups: pluginGroups.filter((group) => group.source === "first-party"),
      curatedByFolder: nextCuratedByFolder,
      installedMarketplaceEntries: marketplaceEntries.filter((item) => item.installed),
      availableMarketplaceEntries: marketplaceEntries.filter((item) => !item.installed),
      // Skills stay individually discoverable even when their owning bundle
      // also earns a plugin-management card.
      allSkills: nextGroups.flatMap((group) => group.skills),
    };
  }, [overview, serversByOrigin]);
  const normalizedQuery = skillQuery.trim().toLowerCase();
  const filteredSkills = useMemo(
    () =>
      normalizedQuery.length === 0
        ? allSkills
        : allSkills.filter((skill) =>
            `${skill.name} ${skill.description}`.toLowerCase().includes(normalizedQuery),
          ),
    [allSkills, normalizedQuery],
  );

  const openSkill = (skill: IntegratorSkillInfo) =>
    setViewSkill({ kind: "local", name: skill.name, description: skill.description });

  const renderGroup = (group: (typeof groups)[number], showSourceLabel: boolean) => {
    const curated = curatedByFolder.get(group.title);
    const label = curated?.label ?? group.title;
    return (
      <PluginGroupCard
        key={`${group.source}:${group.title}`}
        group={group}
        label={label}
        brands={curated ? CURATED_INSTALL_BRANDS[curated.icon] : PLUGIN_GROUP_BRANDS[group.title]}
        mcpCount={mcpCountByOrigin.get(group.title) ?? 0}
        enabledMcpCount={serversForOrigin(group.title).filter(isServerEnabled).length}
        showSourceLabel={showSourceLabel}
        isEnabled={(skill) => isSkillEnabled(overrides, skill)}
        onToggleAll={(enabled) => void toggleGroupAll(group, label, enabled)}
        onOpenDetail={() => setViewPlugin(group.title)}
        busy={togglingPlugin === group.title}
      />
    );
  };

  const viewedGroup = viewPlugin ? groups.find((group) => group.title === viewPlugin) : undefined;
  const viewedCurated = viewPlugin ? curatedByFolder.get(viewPlugin) : undefined;

  return (
    <>
      <div className="settings-page-heading">
        <span>
          <Sparkles />
        </span>
        <div>
          <h1>Skills and Plugins</h1>
          <p>Discover, install, and manage portable capabilities from one local-first library.</p>
        </div>
      </div>
      {loadError || (overview && !overview.bundledAvailable) ? (
        <p className="settings-action-message" role={loadError ? "status" : "alert"}>
          {loadError ||
            "Built-in skills are missing from this app package. Reinstall AI Integrator or use the complete local build folder."}
        </p>
      ) : null}
      {installMessage ? (
        <p className="settings-action-message" role="status">
          {installMessage}
        </p>
      ) : null}
      <CapabilityTabs active={tab} onSelect={selectTab} />
      <div className="capability-panel-frame">
        <motion.div
          key={panel.tab}
          className="capability-panel"
          initial={reduceMotion ? { opacity: 1 } : { opacity: 0, x: panel.direction * 10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={reduceMotion ? { duration: 0 } : capabilityPanelTransition}
        >
          {panel.tab === "marketplace" ? (
            <section className="settings-section">
              <header>
                <h2>Marketplace</h2>
                <p>Official catalogs you can install. Click a card to see what it ships first.</p>
              </header>
              <LayoutGroup id="marketplace-catalog">
                <motion.div
                  className="marketplace-catalog"
                  layout={!reduceMotion}
                  transition={reduceMotion ? { duration: 0 } : marketplaceCardSpring}
                >
                  <AnimatePresence initial={false} mode="popLayout">
                    {installedMarketplaceEntries.length > 0 ? (
                      <motion.div
                        key="installed-marketplace"
                        className="marketplace-section"
                        layout={!reduceMotion}
                        initial={reduceMotion ? false : { opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                        transition={
                          reduceMotion
                            ? { duration: 0 }
                            : { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
                        }
                      >
                        <h3 className="skills-subsection-title">Installed</h3>
                        <div className="browse-grid">
                          {installedMarketplaceEntries.map(({ entry, folderId }) => (
                            <MarketplaceCard
                              key={entry.repository}
                              entry={entry}
                              installed
                              uninstalling={uninstalling === folderId}
                              reduceMotion={reduceMotion}
                              onOpen={() => setViewPlugin(folderId)}
                              onUninstall={() => uninstall(folderId, entry.label)}
                            />
                          ))}
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                  <motion.div
                    className="marketplace-section"
                    layout={!reduceMotion}
                    transition={reduceMotion ? { duration: 0 } : marketplaceCardSpring}
                  >
                    <h3 className="skills-subsection-title">Available</h3>
                    <div className="browse-grid">
                      {availableMarketplaceEntries.map(({ entry, folderId }) => (
                        <MarketplaceCard
                          key={entry.repository}
                          entry={entry}
                          installed={false}
                          uninstalling={false}
                          reduceMotion={reduceMotion}
                          onOpen={() => setViewPlugin(folderId)}
                          onUninstall={() => undefined}
                        />
                      ))}
                    </div>
                  </motion.div>
                </motion.div>
              </LayoutGroup>
              <SettingRow
                label="From GitHub"
                description="Any repository containing skills/ directories, as owner/name."
              >
                <input
                  className="settings-inline-input"
                  value={installRepo}
                  placeholder="owner/name"
                  onChange={(event) => setInstallRepo(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") install(installRepo);
                  }}
                />
                <button
                  className="ghost-button"
                  type="button"
                  disabled={installBusy || !installRepo.trim()}
                  onClick={() => install(installRepo)}
                >
                  {installBusy ? <LoaderCircle className="spin" /> : <Plus />} Install
                </button>
              </SettingRow>
            </section>
          ) : null}
          {panel.tab === "plugins" ? (
            <section className="settings-section">
              <header>
                <h2>Plugins</h2>
                <p>Everything installed. Click a card to view, toggle, or uninstall it.</p>
              </header>
              <SettingRow
                label="Skills folder"
                description="Standalone skills you author or copy in. Enabled by default."
              >
                <code className="settings-path">{overview?.skillsRoot ?? "…"}</code>
              </SettingRow>
              <SettingRow
                label="Plugins folder"
                description="Installed plugin bundles. Their skills stay off until you enable them."
              >
                <code className="settings-path">{overview?.pluginsRoot ?? "…"}</code>
              </SettingRow>
              <h3 className="skills-subsection-title">Yours &amp; third-party</h3>
              {installedGroups.length > 0 ? (
                installedGroups.map((group) => renderGroup(group, true))
              ) : (
                <p className="skills-empty-state">
                  No user skills or third-party plugins installed yet.
                </p>
              )}
              <h3 className="skills-subsection-title">Built into AI Integrator</h3>
              {integratorGroups.map((group) => renderGroup(group, false))}
            </section>
          ) : null}
          {panel.tab === "skills" ? (
            <section className="settings-section">
              <header>
                <h2>Skills</h2>
                <p>What's yours — hand-authored, made with the skill creator, or built in.</p>
              </header>
              <label className="settings-search capability-search">
                <Search />
                <span className="sr-only">Search skills</span>
                <input
                  value={skillQuery}
                  onChange={(event) => setSkillQuery(event.target.value)}
                  placeholder={`Search ${allSkills.length} skills`}
                />
              </label>
              {filteredSkills.length > 0 ? (
                <div className="capability-card-grid">
                  {filteredSkills.map((skill) => (
                    <SkillCard
                      key={skill.name}
                      skill={skill}
                      enabled={isSkillEnabled(overrides, skill)}
                      onToggle={(value) => toggle(skill, value)}
                      onCredentialChanged={refresh}
                      onViewPlugin={
                        skill.name.includes(":")
                          ? () => setViewPlugin(skill.name.split(":", 1)[0])
                          : undefined
                      }
                      onOpenDetail={() => openSkill(skill)}
                    />
                  ))}
                </div>
              ) : null}
              {filteredSkills.length === 0 ? (
                <p className="skills-empty-state">No skills match “{skillQuery.trim()}”.</p>
              ) : null}
            </section>
          ) : null}
          {panel.tab === "mcps" ? (
            <McpSettings
              settings={settings}
              setSetting={setSetting}
              mcpOverview={mcpOverview}
              onMcpOverview={setMcpOverview}
              onViewPlugin={(origin) => setViewPlugin(origin)}
            />
          ) : null}
        </motion.div>
      </div>
      <AnimatePresence>
        {viewPlugin && (viewedGroup || viewedCurated) ? (
          <PluginDetailModal
            key={viewPlugin}
            folderId={viewPlugin}
            curated={viewedCurated}
            group={viewedGroup}
            servers={(mcpOverview?.servers ?? []).filter((server) => server.origin === viewPlugin)}
            isEnabled={(skill) => isSkillEnabled(overrides, skill)}
            onToggleSkill={toggle}
            isServerEnabled={isServerEnabled}
            onToggleServer={setServerEnabled}
            onCredentialChanged={refresh}
            installBusy={installBusy}
            uninstalling={uninstalling}
            onInstall={viewedCurated ? () => install(viewedCurated.repository) : undefined}
            onUninstall={
              viewedGroup?.source === "plugin"
                ? () => {
                    uninstall(viewedGroup.title, viewedCurated?.label ?? viewedGroup.title);
                    setViewPlugin(null);
                  }
                : undefined
            }
            onClose={() => setViewPlugin(null)}
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {viewSkill ? (
          <SkillDetailModal target={viewSkill} onClose={() => setViewSkill(null)} />
        ) : null}
      </AnimatePresence>
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
        kimi: "Kimi Code",
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
          <h1>Runtimes and Models</h1>
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

const LOG_RETENTION_OPTIONS = [
  { value: "7d", label: "After 7 days" },
  { value: "14d", label: "After 14 days" },
  { value: "30d", label: "After 30 days" },
  { value: "never", label: "Never (size cap only)" },
];

function DiagnosticLogsSettings({
  settings,
  setSetting,
}: {
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
}) {
  const [totals, setTotals] = useState<LogsTotals | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const refreshTotals = useCallback(async () => {
    try {
      setTotals(await bridge.getLogsTotals());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Log totals unavailable.");
    }
  }, []);

  useEffect(() => {
    void refreshTotals();
  }, [refreshTotals]);

  const openFolder = async () => {
    setMessage("");
    setBusy(true);
    try {
      await bridge.openLogsFolder();
      setMessage("Opened Documents › AI Integrator › Logs.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open the logs folder.");
    } finally {
      setBusy(false);
    }
  };

  const clearLogs = async () => {
    if (
      !window.confirm(
        "Delete all diagnostic log files in Documents › AI Integrator › Logs? This cannot be undone.",
      )
    ) {
      return;
    }
    setMessage("");
    setBusy(true);
    try {
      await bridge.clearLogs();
      await refreshTotals();
      setMessage("Diagnostic logs cleared.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not clear diagnostic logs.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <header>
        <h2>Diagnostic logs</h2>
        <p>
          Local, redacted JSONL under Documents › AI Integrator › Logs. Compact incident records
          always capture visible errors and session cut-offs; detailed trails are optional.
        </p>
      </header>
      <SettingRow
        label="Enable detailed logs"
        description="Write verbose lifecycle, probe, and connection trails alongside compact incidents. Off keeps only the fault journal."
        icon={<ScrollText />}
      >
        <Switch
          checked={readSetting(settings, "diagnostics.detailedLogging", false)}
          onChange={(value) => setSetting("diagnostics.detailedLogging", value)}
          label="Enable detailed logs"
        />
      </SettingRow>
      <SettingRow
        label="Delete logs older than"
        description="Aged files are removed on launch and when this setting changes. A 500 MB soft cap also deletes the oldest files first."
      >
        <Dropdown
          aria-label="Diagnostic log retention"
          value={readSetting(settings, "diagnostics.retention", "7d")}
          options={LOG_RETENTION_OPTIONS}
          onChange={(value) => {
            setSetting("diagnostics.retention", value);
            void bridge
              .pruneLogs()
              .then(refreshTotals)
              .catch(() => undefined);
          }}
        />
      </SettingRow>
      <div className="settings-location">
        <FolderOpen />
        <span>
          <strong>{totals?.path ?? "Documents/AI Integrator/Logs"}</strong>
          <small>
            {totals
              ? `${formatBytes(totals.bytes)} · ${totals.fileCount} file${totals.fileCount === 1 ? "" : "s"} · ${totals.incidentFiles} incident · ${totals.detailFiles} detail`
              : "Measuring log footprint…"}
          </small>
        </span>
      </div>
      <div className="data-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={() => void openFolder()}
          disabled={busy}
        >
          <FolderSearch /> Open logs folder
        </button>
        <button
          className="danger-button"
          type="button"
          onClick={() => void clearLogs()}
          disabled={busy}
        >
          <Trash2 /> Clear logs
        </button>
      </div>
      {message ? (
        <p className="settings-action-message" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function PersonalizationSettings({
  settings,
  setSetting,
}: {
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
}) {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newText, setNewText] = useState("");
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const storedName = readSetting(settings, "personalization.name", "");
  const storedAbout = readSetting(settings, "personalization.about", "");
  const profileEnabled = readSetting(settings, "personalization.enabled", true);
  const enabled = readSetting(settings, "memory.enabled", false);

  const refresh = useCallback(async () => {
    const entries = await bridge.listMemories();
    setMemories(entries);
    setDrafts(Object.fromEntries(entries.map((entry) => [entry.id, entry.text])));
  }, []);

  useEffect(() => {
    void refresh().catch((error: unknown) =>
      setMessage(error instanceof Error ? error.message : "Could not load memory."),
    );
  }, [refresh]);

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setMessage("");
    try {
      await action();
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Memory could not be updated.");
    } finally {
      setBusyId("");
    }
  };

  return (
    <>
      <div className="settings-page-heading">
        <span>
          <Brain />
        </span>
        <div>
          <h1>Personalization</h1>
          <p>Choose how Chat addresses you and what it should know about you.</p>
        </div>
      </div>
      <section className="settings-section personalization-profile">
        <header>
          <h2>About you</h2>
          <p>Your profile stays local and is only shared with general Chats when enabled.</p>
        </header>
        <SettingRow label="Name" description="Used for greetings throughout AI Integrator.">
          <input
            className="personalization-name-input"
            value={storedName}
            maxLength={80}
            aria-label="Your name"
            placeholder="What should we call you?"
            onChange={(event) => setSetting("personalization.name", event.target.value)}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value !== storedName) setSetting("personalization.name", value);
            }}
          />
        </SettingRow>
        <div className="personalization-about-row">
          <label htmlFor="personalization-about">About you</label>
          <textarea
            id="personalization-about"
            value={storedAbout}
            maxLength={2_000}
            rows={4}
            placeholder="Your work, interests, goals, or how you like assistants to respond."
            onChange={(event) => setSetting("personalization.about", event.target.value)}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value !== storedAbout) setSetting("personalization.about", value);
            }}
          />
        </div>
        <SettingRow
          label="Use profile in Chats"
          description="Share the name and details above with conversational assistants."
        >
          <Switch
            checked={profileEnabled}
            onChange={(value) => setSetting("personalization.enabled", value)}
            label="Use profile in Chats"
          />
        </SettingRow>
      </section>
      <section className="settings-section memory-settings">
        <header>
          <h2>Memory</h2>
          <p>
            Disabled by default. When enabled, up to 20 active entries are supplied to general
            Chats; no embeddings or API key are used.
          </p>
        </header>
        <SettingRow
          label="Use memory in Chats"
          description="Allow qualifying Chat sessions to read this list and save explicit durable preferences through the bounded Integrator memory tool."
        >
          <Switch
            checked={enabled}
            onChange={(value) => setSetting("memory.enabled", value)}
            label="Use memory in Chats"
          />
        </SettingRow>
        <form
          className="memory-add-row"
          onSubmit={(event) => {
            event.preventDefault();
            const text = newText.trim();
            if (!text) return;
            void run("new", async () => {
              await bridge.createMemory(text);
              setNewText("");
            });
          }}
        >
          <input
            value={newText}
            maxLength={500}
            onChange={(event) => setNewText(event.target.value)}
            placeholder="Add a preference or stable fact"
            aria-label="New memory"
          />
          <button type="submit" disabled={!newText.trim() || Boolean(busyId)}>
            <Plus /> Add
          </button>
        </form>
        <div className="memory-list" aria-label="Saved memories">
          {memories.map((memory) => (
            <div className="memory-row" key={memory.id} data-disabled={memory.state === "disabled"}>
              <textarea
                value={drafts[memory.id] ?? memory.text}
                maxLength={500}
                rows={2}
                aria-label="Memory text"
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [memory.id]: event.target.value }))
                }
                onBlur={() => {
                  const text = (drafts[memory.id] ?? memory.text).trim();
                  if (text && text !== memory.text) {
                    void run(memory.id, () => bridge.updateMemory(memory.id, text));
                  }
                }}
              />
              <small>
                {memory.creator === "agent" ? "Saved from Chat" : "Added by you"}
                {memory.state === "disabled" ? " · Disabled" : ""}
              </small>
              <div className="memory-row-actions">
                <button
                  type="button"
                  disabled={Boolean(busyId)}
                  onClick={() =>
                    void run(memory.id, () =>
                      bridge.setMemoryEnabled(memory.id, memory.state !== "active"),
                    )
                  }
                >
                  {memory.state === "active" ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  className="danger-text-button"
                  disabled={Boolean(busyId)}
                  onClick={() => void run(memory.id, () => bridge.deleteMemory(memory.id))}
                >
                  <Trash2 /> Delete
                </button>
              </div>
            </div>
          ))}
          {memories.length === 0 ? (
            <p className="settings-empty">No memories saved. Chats do not infer a profile.</p>
          ) : null}
        </div>
        <p className="settings-measured-note">
          {memories.filter((memory) => memory.state === "active").length} of 20 active
        </p>
        {message ? (
          <p className="settings-inline-warning" role="alert">
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
  if (section === "composer") {
    return <ComposerSettings settings={settings} setSetting={setSetting} />;
  }
  if (section === "permissions") {
    return <PermissionsSettings settings={settings} setSetting={setSetting} />;
  }

  return (
    <>
      <div className="settings-page-heading">
        <span>
          <MonitorCog />
        </span>
        <div>
          <h1>General</h1>
          <p>Startup behavior, voice typing, and where local data is stored and exported.</p>
        </div>
      </div>
      <section className="settings-section">
        <header>
          <h2>Startup and safety</h2>
          <p>
            What reopens at launch, how interrupted responses resume, and when the app asks before
            acting.
          </p>
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
          <p>The directory where this app keeps its settings, task metadata, and indexes.</p>
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
      <DiagnosticLogsSettings settings={settings} setSetting={setSetting} />
      <section className="settings-section danger-zone">
        <header>
          <h2>Portability and deletion</h2>
          <p>
            Exports omit credentials, secure terminal input, hidden policy data, and raw environment
            values.
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
        next.storage === "protected-local-file"
          ? "Saved in protected developer storage. The key is not exported or shown again."
          : "Saved in the operating system credential store. The key is not exported or shown again.",
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
      setMessage(
        status?.storage === "protected-local-file"
          ? "Removed the OpenAI API key from protected developer storage."
          : "Removed the OpenAI API key from the operating system credential store.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not remove the OpenAI API key.");
    } finally {
      setBusy(false);
    }
  };

  const nativeOnly = status?.storage === "native-only";
  const protectedDevelopment = status?.storage === "protected-local-file";
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
              : protectedDevelopment
                ? "Debug builds use permission-locked developer storage instead of macOS Keychain."
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
        if (!active) return;
        const usableCatalog = entries.filter((entry) => entry.id !== "Provider default");
        setCatalog(usableCatalog);
        // A pinned runtime must name a catalog model — never an empty "Default".
        const current = readSetting<string>(settings, EXPLAIN_SETTINGS.model, "");
        if (!usableCatalog.some((entry) => entry.id === current) && usableCatalog[0]) {
          setSetting(EXPLAIN_SETTINGS.model, usableCatalog[0].id);
          setSetting(EXPLAIN_SETTINGS.effort, "");
        }
      })
      .catch(() => {
        if (active) setCatalog([]);
      });
    return () => {
      active = false;
    };
    // settings[model] is read once on load to decide whether to auto-pick; the
    // setter itself updates it, so listing it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned, setSetting]);

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
  const effort = resolveModelEffort(
    entry,
    readSetting<string>(settings, EXPLAIN_SETTINGS.effort, ""),
  );

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
      <div className="settings-page-heading">
        <span>
          <Lightbulb />
        </span>
        <div>
          <h1>Explain</h1>
          <p>What comes back when you highlight code in a file and choose “Ask about this”.</p>
        </div>
      </div>
      <section className="settings-section">
        <header>
          <h2>Ask about this</h2>
          <p>
            Highlight code in a file and right-click. The archetype replaces the whole instruction,
            not just its tone.
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
            description="Required. Explanations always run on a catalog model for this provider."
          >
            <Dropdown
              aria-label="Explain model"
              value={model || (catalog?.[0]?.id ?? "")}
              options={(catalog ?? []).map((item) => ({ value: item.id, label: item.label }))}
              onChange={(value) => {
                setSetting(EXPLAIN_SETTINGS.model, value);
                setSetting(EXPLAIN_SETTINGS.effort, "");
              }}
              disabled={!catalog || catalog.length === 0}
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
              Tried in order if the one above cannot answer — not installed, timed out, or out of
              usage. Each fallback picks its own default model.
            </small>
          </span>
          <div className="explain-fallback-list">
            <ol className="explain-fallback-chain">
              <li className="explain-fallback-step" data-primary="true">
                <span className="explain-fallback-order" aria-hidden="true">
                  1
                </span>
                {pinnedRuntime ? (
                  <ProviderIcon provider={pinnedRuntime.id} label={pinnedRuntime.name} />
                ) : null}
                <span className="explain-fallback-name">
                  {pinnedRuntime?.name ?? "Current model"}
                </span>
                <span className="explain-fallback-role">Primary</span>
              </li>
              {fallbacks.map((runtimeId, index) => {
                const runtime = usable.find((item) => item.id === runtimeId);
                if (!runtime) return null;
                return (
                  <li key={runtime.id}>
                    <button
                      type="button"
                      className="explain-fallback-step"
                      aria-pressed="true"
                      data-selected="true"
                      onClick={() => toggleFallback(runtime.id)}
                    >
                      <span className="explain-fallback-order" aria-hidden="true">
                        {index + 2}
                      </span>
                      <ProviderIcon provider={runtime.id} label={runtime.name} />
                      <span className="explain-fallback-name">{runtime.name}</span>
                      <span className="explain-fallback-role">Remove</span>
                    </button>
                  </li>
                );
              })}
            </ol>
            {usable.some((runtime) => runtime.id !== pinned && !fallbacks.includes(runtime.id)) ? (
              <div className="explain-fallback-pool" aria-label="Add fallback providers">
                {usable
                  .filter((runtime) => runtime.id !== pinned && !fallbacks.includes(runtime.id))
                  .map((runtime) => (
                    <button
                      key={runtime.id}
                      type="button"
                      className="explain-fallback-add"
                      aria-pressed="false"
                      onClick={() => toggleFallback(runtime.id)}
                    >
                      <Plus aria-hidden="true" />
                      <ProviderIcon provider={runtime.id} label={runtime.name} />
                      <span>{runtime.name}</span>
                    </button>
                  ))}
              </div>
            ) : null}
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
 * Git decorations, who drafts commit subjects, and push safety. Decorations
 * default off: each one either writes something permanent into history or
 * relaxes a safeguard. The commit-message writer is the opposite — Generate
 * needs an explicit model before it will spend a provider turn.
 */
function GitSettings({
  settings,
  setSetting,
  runtimes,
}: {
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
  runtimes: RuntimeConnection[];
}) {
  const decoration = readGitDecorationSettings(settings);
  const force = readPushForce(settings);
  const samplePreview = decorateCommitMessage("fix the parser panic", decoration);

  const [catalog, setCatalog] = useState<ModelCatalogEntry[] | null>(null);
  const usable = useMemo(
    () => runtimes.filter((runtime) => runtime.status !== "not_installed"),
    [runtimes],
  );
  const available = useMemo(() => usable.map((runtime) => runtime.id), [usable]);
  const storedRuntime = readSetting<string>(settings, COMMIT_MESSAGE_SETTINGS.runtime, "");
  const pinned = available.includes(storedRuntime as RuntimeId)
    ? (storedRuntime as RuntimeId)
    : null;
  const pinnedRuntime = pinned ? usable.find((runtime) => runtime.id === pinned) : undefined;
  const fallbacks = normalizeFallbacks(settings[COMMIT_MESSAGE_SETTINGS.fallbacks], available);
  const model = readSetting<string>(settings, COMMIT_MESSAGE_SETTINGS.model, "");
  const entry = catalog?.find((candidate) => candidate.id === model);
  const effortOptions = entry?.efforts ?? [];
  const effort = resolveModelEffort(
    entry,
    readSetting<string>(settings, COMMIT_MESSAGE_SETTINGS.effort, ""),
  );
  const routeReady = resolveCommitMessageRoute(settings, available) !== null;

  // Every read of `catalog` below is itself gated on `pinned` (the model row
  // only renders once a runtime is chosen), so an unpinned catalog going
  // stale in state is invisible rather than a bug — only the fetch needs
  // skipping, not a reset.
  useEffect(() => {
    if (!pinned) return;
    let active = true;
    void bridge
      .listModelCatalog(pinned)
      .then((entries) => {
        if (!active) return;
        const usableCatalog = entries.filter((entry) => entry.id !== "Provider default");
        setCatalog(usableCatalog);
        const current = readSetting<string>(settings, COMMIT_MESSAGE_SETTINGS.model, "");
        if (!usableCatalog.some((item) => item.id === current) && usableCatalog[0]) {
          setSetting(COMMIT_MESSAGE_SETTINGS.model, usableCatalog[0].id);
          setSetting(COMMIT_MESSAGE_SETTINGS.effort, "");
        }
      })
      .catch(() => {
        if (active) setCatalog([]);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned, setSetting]);

  const changeRuntime = (value: string) => {
    setSetting(COMMIT_MESSAGE_SETTINGS.runtime, value);
    setSetting(COMMIT_MESSAGE_SETTINGS.model, "");
    setSetting(COMMIT_MESSAGE_SETTINGS.effort, "");
    setSetting(
      COMMIT_MESSAGE_SETTINGS.fallbacks,
      fallbacks.filter((item) => item !== value),
    );
  };

  const toggleFallback = (runtime: RuntimeId) => {
    setSetting(
      COMMIT_MESSAGE_SETTINGS.fallbacks,
      fallbacks.includes(runtime)
        ? fallbacks.filter((item) => item !== runtime)
        : [...fallbacks, runtime],
    );
  };

  return (
    <>
      <div className="settings-page-heading">
        <span>
          <GitBranch />
        </span>
        <div>
          <h1>Git</h1>
          <p>What AI Integrator writes into your commits, and how far a push may go.</p>
        </div>
      </div>
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
          <h2>Commit messages</h2>
          <p>
            The Generate button in the Git panel drafts a subject through an isolated, tool-denied
            helper — pick who writes it.
          </p>
        </header>
        <SettingRow
          label="Runtime"
          description={
            routeReady
              ? "Drafts run on this provider first, then any fallbacks below."
              : "Choose a provider, then a model. Generate stays off until both are set."
          }
        >
          <Dropdown
            aria-label="Commit message runtime"
            value={pinned ?? ""}
            options={[
              ...(pinned
                ? []
                : [{ value: "", label: "Choose a runtime…", disabled: true as const }]),
              ...usable.map((runtime) => ({
                value: runtime.id,
                label: runtime.name,
                icon: <ProviderIcon provider={runtime.id} label={runtime.name} />,
              })),
            ]}
            onChange={changeRuntime}
            disabled={usable.length === 0}
          />
        </SettingRow>
        {pinned ? (
          <SettingRow
            label="Model"
            description="Required. Commit subjects always run on a catalog model for this provider."
          >
            <Dropdown
              aria-label="Commit message model"
              value={model || (catalog?.[0]?.id ?? "")}
              options={(catalog ?? []).map((item) => ({ value: item.id, label: item.label }))}
              onChange={(value) => {
                setSetting(COMMIT_MESSAGE_SETTINGS.model, value);
                setSetting(COMMIT_MESSAGE_SETTINGS.effort, "");
              }}
              disabled={!catalog || catalog.length === 0}
            />
          </SettingRow>
        ) : null}
        {pinned && effortOptions.length > 0 ? (
          <SettingRow
            label="Reasoning effort"
            description="Only the levels this model advertises are offered."
          >
            <Dropdown
              aria-label="Commit message reasoning effort"
              value={effort ?? ""}
              options={effortOptions.map((option) => ({
                value: option.id,
                label: option.label,
              }))}
              onChange={(value) => setSetting(COMMIT_MESSAGE_SETTINGS.effort, value)}
            />
          </SettingRow>
        ) : null}
        <div className="setting-row setting-row-stacked">
          <span>
            <strong>Fallbacks</strong>
            <small>
              Tried in order if the one above cannot answer — not installed, timed out, or out of
              usage. Each fallback picks its own default model.
            </small>
          </span>
          <div className="explain-fallback-list">
            <ol className="explain-fallback-chain">
              <li className="explain-fallback-step" data-primary="true">
                <span className="explain-fallback-order" aria-hidden="true">
                  1
                </span>
                {pinnedRuntime ? (
                  <ProviderIcon provider={pinnedRuntime.id} label={pinnedRuntime.name} />
                ) : null}
                <span className="explain-fallback-name">
                  {pinnedRuntime?.name ?? "Choose a runtime"}
                </span>
                <span className="explain-fallback-role">Primary</span>
              </li>
              {fallbacks.map((runtimeId, index) => {
                const runtime = usable.find((item) => item.id === runtimeId);
                if (!runtime) return null;
                return (
                  <li key={runtime.id}>
                    <button
                      type="button"
                      className="explain-fallback-step"
                      aria-pressed="true"
                      data-selected="true"
                      onClick={() => toggleFallback(runtime.id)}
                    >
                      <span className="explain-fallback-order" aria-hidden="true">
                        {index + 2}
                      </span>
                      <ProviderIcon provider={runtime.id} label={runtime.name} />
                      <span className="explain-fallback-name">{runtime.name}</span>
                      <span className="explain-fallback-role">Remove</span>
                    </button>
                  </li>
                );
              })}
            </ol>
            {usable.some((runtime) => runtime.id !== pinned && !fallbacks.includes(runtime.id)) ? (
              <div className="explain-fallback-pool" aria-label="Add commit message fallbacks">
                {usable
                  .filter((runtime) => runtime.id !== pinned && !fallbacks.includes(runtime.id))
                  .map((runtime) => (
                    <button
                      key={runtime.id}
                      type="button"
                      className="explain-fallback-add"
                      aria-pressed="false"
                      disabled={!pinned}
                      onClick={() => toggleFallback(runtime.id)}
                    >
                      <Plus aria-hidden="true" />
                      <ProviderIcon provider={runtime.id} label={runtime.name} />
                      <span>{runtime.name}</span>
                    </button>
                  ))}
              </div>
            ) : null}
          </div>
        </div>
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
    props.runtimeActionRequest ? "models-runtimes" : (props.initialSection ?? "general"),
  );
  // This view stays mounted behind the workspace, so a later "open Settings at
  // X" cannot arrive as a fresh mount. Adjusting during render (rather than in
  // an effect) lands the right section in the same commit as the screen change.
  const [appliedSectionRequest, setAppliedSectionRequest] = useState(props.sectionRequest ?? 0);
  if ((props.sectionRequest ?? 0) !== appliedSectionRequest) {
    setAppliedSectionRequest(props.sectionRequest ?? 0);
    setSection(
      props.runtimeActionRequest ? "models-runtimes" : (props.initialSection ?? "general"),
    );
  }
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
  const contentScrollRef = useRef<HTMLDivElement>(null);
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
          if (!key.startsWith("appearance.") && !isInternalBrowserSetting(key)) {
            loaded[key] = setting.value;
          }
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

  useEffect(() => {
    if (contentScrollRef.current) contentScrollRef.current.scrollTop = 0;
  }, [section]);

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
        let keptBrowserIdentityScope = false;
        for (const [key, value] of Object.entries(importedSettings as Record<string, unknown>)) {
          const normalized = key.replace(/^settings\./, "");
          if (isInternalBrowserSetting(normalized)) continue;
          if (normalized === BROWSER_SETTINGS.identityScope) {
            keptBrowserIdentityScope = true;
            continue;
          }
          setSetting(normalized, value);
        }
        if (keptBrowserIdentityScope) {
          setActionMessage(
            "Settings imported. Browser identity scope was kept so no cookie or login merge could be bypassed.",
          );
          return;
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
      <div className="settings-content-scroll" ref={contentScrollRef}>
        <div className="settings-content">
          {section === "appearance" ? (
            <AppearanceSettings
              preferences={props.preferences}
              onChange={props.onChangePreferences}
              onReset={props.onResetPreferences}
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
          {section === "explain" ? (
            <ExplainSettings
              settings={settings}
              setSetting={setSetting}
              runtimes={props.runtimes}
              projectName={props.projects?.find((project) => !project.archived)?.name}
            />
          ) : null}
          {section === "keybindings" ? (
            <KeybindingsSettings settings={settings} setSetting={setSetting} />
          ) : null}
          {section === "browser" ? (
            <BrowserSettings
              settings={settings}
              setSetting={setSetting}
              onIdentityScopeChanged={(scope) => {
                setSettings((current) => ({
                  ...current,
                  [BROWSER_SETTINGS.identityScope]: scope,
                }));
                props.onSettingChanged?.(BROWSER_SETTINGS.identityScope, scope);
              }}
            />
          ) : null}
          {section === "git" ? (
            <GitSettings settings={settings} setSetting={setSetting} runtimes={props.runtimes} />
          ) : null}
          {section === "skills" ? (
            <SkillsSettings settings={settings} setSetting={setSetting} />
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
          {section === "memory" ? (
            <PersonalizationSettings settings={settings} setSetting={setSetting} />
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
