import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  AnimatePresence,
  LazyMotion,
  // domMax, not domAnimation: layout / layoutId animations (SlidingTabIndicator,
  // settings nav, RightRail file lists, etc.) are only in the max feature bundle.
  // TravelingSelection does not use layoutId — it animates measured x/y/size.
  domMax,
  m as motion,
  useReducedMotion,
} from "motion/react";
import {
  ArrowRight,
  ClipboardList,
  Download,
  FileDiff,
  FolderOpen,
  FolderPlus,
  Github,
  HelpCircle,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Search,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  bridge,
  CHAT_PROJECT_ID,
  CHAT_TITLE_PLACEHOLDER,
  GENERAL_CHAT_TITLE_PLACEHOLDER,
  diffFileKey,
  draftOwnerKey,
  formatBridgeError,
  type ApprovalDecision,
  type ApprovalProjection,
  type AutomationDispatch,
  type AutomationTimelineEntry,
  type ComposerDraft,
  type ComposerDraftOwner,
  type ComposerDraftValue,
  type CloneProjectInput,
  type ComposerDraftAttachment,
  type DelegationView,
  type DelegationRouting,
  type DiffFile,
  type GitSnapshot,
  type GithubRepositoryCatalog,
  type NativeActionReference,
  type QueuedMessage,
  type ProjectFileContent,
  type ProjectFileEntry,
  type ProjectFileOpener,
  type ProjectSummary,
  type QuestionOption,
  recordLocalTurnUsage,
  type RuntimeConnection,
  type RuntimeId,
  type RuntimeProjectionEvent,
  type StartTaskInput,
  type SubscriptionQuota,
  type SubscriptionWindow,
  type TaskSummary,
  type TranscriptEvent,
} from "./bridge";
import { mergeSchedulingTranscript } from "./automationTranscript";
import { automationTurnPrompt } from "./automationTurnPrompt";
import {
  composerNoticeExpiry,
  isRuntimeHealthError,
  isRuntimeUpdateRequired,
  type ComposerNotice,
} from "./composerNotices";
import { prettyModelLabel } from "./modelLabel";
import { ComposerDraftStore } from "./composerDraftStore";
import { nextForkTitle } from "./forkTitle";
import type { RuntimeActionRequest, SettingsSection } from "./components/SettingsView";
import type { DiffCommitState } from "./components/DiffView";
import { createDemoSnapshot, createEmptySnapshot, type WorkspaceSnapshot } from "./demoData";
import { reconcileGitSnapshot } from "./gitSnapshot";
import {
  initializeTheme,
  normalizeThemePreferences,
  resetThemePreferences,
  setThemePreferences,
  updateThemePreferences,
  type ThemePreferencePatch,
  type ThemePreferences,
} from "./theme";
import { Composer } from "./components/Composer";
import { ChatWelcome } from "./components/ChatWelcome";
import { DeleteChatModal } from "./components/DeleteChatModal";
import { DeleteArchivedChatsModal } from "./components/DeleteArchivedChatsModal";
import { DeleteProjectModal, type DeleteProjectScope } from "./components/DeleteProjectModal";
import {
  FileWorkspace,
  type FileExplainDelta,
  type FileExplainPayload,
  type FileExplainResult,
  type FileSelectionPayload,
} from "./components/FileView";
import { resolveExplainConfig, resolveExplainRoute } from "./explainSettings";
import { resolveCommitMessageRoute } from "./commitMessageSettings";
import { decorateCommitMessage, readGitDecorationSettings, readPushForce } from "./gitDecoration";
import { WorkPaneToggle, type WorkPaneLaunchKind } from "./components/WorkPaneToggle";
// Eager on purpose: AnimatePresence must see a real motion component as its
// direct child. A lazy element there never finishes its exit, which left a
// closed work pane painted on screen while every other control read "closed".
import { WorkPane } from "./components/WorkPane";
import { useWorkPane, useWorkPaneHeaderAlignment, fileSurfaceId } from "./useWorkPane";
import { useBrowserTabs } from "./useBrowserTabs";
import { resolveRequestedFile, type ProjectFileLocation } from "./components/fileViewSupport";
import { TaskStatusPill } from "./components/TaskStatusPill";
import { SubagentProjectionCache } from "./components/subagentProjectionCache";
import { QueuedMessages } from "./components/QueuedMessages";
import { formatCompactTokenCount } from "./components/conversationFormatting";
import { SlidingTabIndicator } from "./components/SlidingTabIndicator";
import { TaskSidebar } from "./components/TaskSidebar";
import {
  applyRuntimeProjection,
  applyRuntimeProjectionBatch,
  createRuntimeProjectionState,
  createRuntimeTranscriptDeriver,
  hydrateRuntimeProjectionState,
  INTERRUPTED_RESUME_VISIBLE_PROMPT,
  isFrameBatchableRuntimeProjection,
  mergeOlderProjectionHydrate,
  taskActivityUpdate,
  type RuntimeProjectionState,
  type TranscriptDensity,
} from "./runtimeProjection";
import {
  normalizeRuntimeRouteDefaults,
  readRuntimeRouteDefault,
  RUNTIME_ROUTE_DEFAULTS_SETTING,
} from "./routingDefaults";
import {
  clearOptimisticMessageForTask,
  isComposerTurnBusy,
  isTurnActiveError,
  type OptimisticUserMessage,
} from "./appTurnState";
import { SlidingPanelSlot } from "./components/SlidingPanelSlot";
import { Tooltip } from "./components/Tooltip";
import "./styles.css";

const RightRail = lazy(() =>
  import("./components/RightRail").then((module) => ({
    default: module.RightRail,
  })),
);
const SubagentConversation = lazy(() =>
  import("./components/SubagentConversation").then((module) => ({
    default: module.SubagentConversation,
  })),
);

const BrowserSurface = lazy(() =>
  import("./components/BrowserSurface").then((module) => ({ default: module.BrowserSurface })),
);
const ReviewSurface = lazy(() =>
  import("./components/ReviewSurface").then((module) => ({ default: module.ReviewSurface })),
);
const TerminalDrawer = lazy(() =>
  import("./components/TerminalDrawer").then((module) => ({
    default: module.TerminalDrawer,
  })),
);
const EVENT_MODELS_STORAGE_KEY = "integrator.transcript.eventModels";

type ComposerTurnInput = {
  prompt: string;
  draftPrompt?: string;
  attachments?: QueuedMessage["attachments"];
  contextReferences?: QueuedMessage["contextReferences"];
  runtime: RuntimeId;
  model: string;
  effort?: string;
  permission: "read-only" | "project-write" | "ask" | "full-access";
  delegation: "off" | "manual" | "balanced" | "budget-first";
  nativeActionId?: string;
  nativeAction?: NativeActionReference;
  draftRevision?: number;
};

type SendTurnOutcome = "started" | "turn-active" | "failed";
type TaskPermission = ComposerTurnInput["permission"];

function isTaskPermission(value: unknown): value is TaskPermission {
  return (
    value === "read-only" || value === "project-write" || value === "ask" || value === "full-access"
  );
}

function settingsDefaultPermission(settings: Record<string, unknown>): TaskPermission {
  const configured = settings["permissions.defaultProfile"];
  return isTaskPermission(configured) ? configured : "project-write";
}

/** Full access silently handles routine approvals; deliberate gates and failures stay visible. */
function approvalVisibleForPermission(
  approval: ApprovalProjection,
  permission: TaskPermission,
  autoResponseFailed = false,
): boolean {
  if (autoResponseFailed) return true;
  if (permission !== "full-access") return true;
  if (approval.approvalKind === "planReview" || approval.approvalKind === "question") return true;
  if (approval.state === "pending" || approval.state === "responding") return false;
  if (approval.state === "resolved") {
    return approval.decision === "decline" || approval.decision === "cancel";
  }
  return true;
}

const autoApprovalKey = (taskId: string, approvalId: string) => `${taskId}:${approvalId}`;

function queuedMessagePrompt(message: QueuedMessage): string {
  const prompt = message.prompt.trim();
  const attachmentBlock =
    message.attachments.length > 0
      ? `Attached files:\n${message.attachments.map((attachment) => `- ${attachment.path}`).join("\n")}`
      : "";
  const chatReferenceBlock = message.contextReferences?.length
    ? `Referenced chats:\n${message.contextReferences
        .map((reference) => `- @${reference.sourceTitle}`)
        .join("\n")}`
    : "";
  return [prompt, attachmentBlock, chatReferenceBlock].filter(Boolean).join("\n\n");
}

function runtimeLabel(runtime: RuntimeId): string {
  return {
    codex: "Codex",
    cursor: "Cursor",
    claude: "Claude Code",
    grok: "Grok Build",
    kimi: "Kimi Code",
    antigravity: "Antigravity",
    custom: "Custom ACP",
  }[runtime];
}

function sameAutomationTimeline(
  left: AutomationTimelineEntry[],
  right: AutomationTimelineEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const candidate = right[index];
      return (
        candidate?.automation.id === entry.automation.id &&
        candidate.automation.updatedAt === entry.automation.updatedAt &&
        entry.runs.length === candidate.runs.length &&
        entry.runs.every((run, runIndex) => {
          const other = candidate.runs[runIndex];
          return (
            other?.id === run.id &&
            other.status === run.status &&
            other.dispatchRef === run.dispatchRef &&
            other.error === run.error &&
            other.finishedAt === run.finishedAt
          );
        })
      );
    })
  );
}

const SettingsView = lazy(() =>
  import("./components/SettingsView").then((module) => ({
    default: module.SettingsView,
  })),
);
const ScheduledView = lazy(() =>
  import("./components/ScheduledView").then((module) => ({
    default: module.ScheduledView,
  })),
);
const SetupView = lazy(() =>
  import("./components/SetupView").then((module) => ({
    default: module.SetupView,
  })),
);
const Transcript = lazy(() =>
  import("./components/Transcript").then((module) => ({
    default: module.Transcript,
  })),
);

type Screen = "workspace" | "scheduled" | "settings" | "setup";
type CenterView = "task" | "review";

interface ComposerErrorState {
  id: string;
  taskId: string;
  message: string;
}

const SIDEBAR_WIDTH_STORAGE_KEY = "aiintegrator.sidebar-width.v1";
const RIGHT_RAIL_WIDTH_STORAGE_KEY = "aiintegrator.right-rail-width.v1";
const PROJECT_SIDEBAR_META_KEY = "projects.sidebarMeta";
const GIT_CACHE_TTL_MS = 5_000;

/** Archive retention (Settings → Archive). The backend keeps no archived-at
 * timestamp, so archival moments are stamped into this settings map the first
 * time the sweep sees a chat archived — auto-delete counts from that stamp,
 * never from a chat's last activity. */
const ARCHIVED_AT_SETTING_KEY = "archive.archivedAtById";
const ARCHIVE_RETENTION_MS: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "14d": 14 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};
const RETENTION_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
/** Chats mid-turn or waiting on the user are never retention targets. */
const RETENTION_BUSY_STATUSES = new Set(["starting", "running", "waiting"]);
function readArchivedAtMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const map: Record<string, string> = {};
  for (const [id, stamp] of Object.entries(value as Record<string, unknown>)) {
    if (typeof stamp === "string") map[id] = stamp;
  }
  return map;
}

type ProjectSidebarMeta = Record<string, { pinned?: boolean; archived?: boolean }>;
function readProjectSidebarMeta(value: unknown): ProjectSidebarMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const meta: ProjectSidebarMeta = {};
  for (const [projectId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    meta[projectId] = {
      pinned: record.pinned === true,
      archived: record.archived === true,
    };
  }
  return meta;
}

function applyProjectSidebarMeta(
  projects: ProjectSummary[],
  meta: ProjectSidebarMeta,
): ProjectSummary[] {
  return projects.map((project) => ({
    ...project,
    pinned: meta[project.id]?.pinned ?? project.pinned ?? false,
    archived: meta[project.id]?.archived ?? project.archived ?? false,
  }));
}

function projectSidebarMetaFromProjects(projects: ProjectSummary[]): ProjectSidebarMeta {
  const meta: ProjectSidebarMeta = {};
  for (const project of projects) {
    if (project.pinned || project.archived) {
      meta[project.id] = {
        pinned: Boolean(project.pinned),
        archived: Boolean(project.archived),
      };
    }
  }
  return meta;
}

/** Names a provider rate-limit window by its reported duration; common plan
 * windows get friendly names, anything else falls back to the raw span. */
function describeQuotaWindow(window?: SubscriptionWindow): string {
  const mins = window?.windowDurationMins;
  if (!mins) return "current window";
  if (Math.abs(mins - 300) <= 15) return "5-hour window";
  if (Math.abs(mins - 1440) <= 72) return "daily window";
  if (Math.abs(mins - 10080) <= 504) return "weekly window";
  if (mins < 60) return `${mins}-minute window`;
  if (mins < 1440) return `${Math.round(mins / 60)}-hour window`;
  return `${Math.round(mins / 1440)}-day window`;
}

function formatCostEstimate(usd: number): string {
  if (usd > 0 && usd < 0.0001) return "<$0.0001";
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}

function storedDimension(key: string, fallback: number, minimum: number, maximum: number): number {
  if (typeof window === "undefined") return fallback;
  const parsed = Number(window.localStorage.getItem(key));
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function clampDimension(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isNativeHost(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

function initialSnapshot(): WorkspaceSnapshot {
  return isNativeHost() ? createEmptySnapshot() : createDemoSnapshot();
}

function initialScreen(): Screen {
  if (typeof window === "undefined") return "workspace";
  const value = new URLSearchParams(window.location.search).get("screen");
  return value === "scheduled" || value === "settings" || value === "setup" ? value : "workspace";
}

function initialCenterView(): CenterView {
  if (typeof window === "undefined") return "task";
  return new URLSearchParams(window.location.search).get("view") === "review" ? "review" : "task";
}

/** Set only for a secondary window opened via "Open in new window"; pins its
 * initial chat ahead of (and independent from) the shared nav localStorage. */
function initialTaskId(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("taskId") ?? "";
}

function NativeTitlebar({
  context,
  title,
  detail,
  leading,
  tabs,
  resourceTabs,
  titleActive = true,
  onTitleSelect,
  trailing,
  subagentHeaderRef,
  motionScale,
  onOpenProject,
  onNewChat,
  onFocusComposer,
  onCopyConversation,
  onToggleSidebar,
  onToggleTaskTools,
  onToggleTerminal,
  onOpenNewWindow,
  onReviewChanges,
  onOpenSettings,
  onOpenSetup,
}: {
  context?: string;
  title?: string;
  detail?: ReactNode;
  leading?: ReactNode;
  tabs?: ReactNode;
  /** Open file tabs docked beside the chat title, sharing its resource row. */
  resourceTabs?: ReactNode;
  /** False while an open file owns the canvas; the title dims and becomes the
   * way back to the conversation. */
  titleActive?: boolean;
  onTitleSelect?: () => void;
  trailing?: ReactNode;
  subagentHeaderRef?: (node: HTMLDivElement | null) => void;
  motionScale: number;
  onOpenProject: () => void;
  onNewChat: () => void;
  onFocusComposer: () => void;
  onCopyConversation: () => void;
  onToggleSidebar: () => void;
  onToggleTaskTools: () => void;
  onToggleTerminal: () => void;
  /** Opens (or focuses) a mirrored second window pinned to the active chat. */
  onOpenNewWindow: () => void;
  onReviewChanges: () => void;
  onOpenSettings: () => void;
  onOpenSetup: () => void;
}) {
  const [openMenu, setOpenMenu] = useState<"file" | "edit" | "view" | null>(null);
  const windowAction = async (action: "minimize" | "toggleMaximize" | "close") => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow()[action]();
    } catch {
      // Browser previews intentionally keep inert native-window controls.
    }
  };
  return (
    <header className="native-titlebar">
      <div className="titlebar-drag" data-tauri-drag-region />
      <span className="titlebar-workspace-divider" aria-hidden="true" />
      {/* The slot covers the right half of the bar whenever the work pane is
          open, and the end cluster covers the rest. Both are drag regions so
          the window moves from either side of the titlebar; Tauri only starts
          a drag when the press lands on the element carrying the attribute,
          so the tabs and buttons inside them still take their own clicks. */}
      <div className="titlebar-subagent-slot" ref={subagentHeaderRef} data-tauri-drag-region />
      <div className="titlebar-left">
        <div className="titlebar-brand-mini">
          <span>AI</span>
          <div className="titlebar-menu-group">
            <button
              type="button"
              className="titlebar-menu-trigger"
              aria-haspopup="menu"
              aria-expanded={openMenu === "file"}
              onClick={() => setOpenMenu((current) => (current === "file" ? null : "file"))}
            >
              File
            </button>
            {openMenu === "file" ? (
              <div className="titlebar-menu" role="menu" aria-label="File">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onOpenProject();
                    setOpenMenu(null);
                  }}
                >
                  Open project…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onNewChat();
                    setOpenMenu(null);
                  }}
                >
                  New chat
                </button>
              </div>
            ) : null}
          </div>
          <div className="titlebar-menu-group">
            <button
              type="button"
              className="titlebar-menu-trigger"
              aria-haspopup="menu"
              aria-expanded={openMenu === "edit"}
              onClick={() => setOpenMenu((current) => (current === "edit" ? null : "edit"))}
            >
              Edit
            </button>
            {openMenu === "edit" ? (
              <div className="titlebar-menu" role="menu" aria-label="Edit">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onFocusComposer();
                    setOpenMenu(null);
                  }}
                >
                  Focus composer
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onCopyConversation();
                    setOpenMenu(null);
                  }}
                >
                  Copy conversation
                </button>
              </div>
            ) : null}
          </div>
          <div className="titlebar-menu-group">
            <button
              type="button"
              className="titlebar-menu-trigger"
              aria-haspopup="menu"
              aria-expanded={openMenu === "view"}
              onClick={() => setOpenMenu((current) => (current === "view" ? null : "view"))}
            >
              View
            </button>
            {openMenu === "view" ? (
              <div className="titlebar-menu" role="menu" aria-label="View">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onToggleSidebar();
                    setOpenMenu(null);
                  }}
                >
                  Toggle chats
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onToggleTaskTools();
                    setOpenMenu(null);
                  }}
                >
                  Toggle task tools
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onToggleTerminal();
                    setOpenMenu(null);
                  }}
                >
                  Toggle terminal
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onOpenNewWindow();
                    setOpenMenu(null);
                  }}
                >
                  Open in new window
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onOpenSettings();
                    setOpenMenu(null);
                  }}
                >
                  Settings
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onOpenSetup();
                    setOpenMenu(null);
                  }}
                >
                  Runtime setup
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onReviewChanges();
                    setOpenMenu(null);
                  }}
                >
                  Review changes
                </button>
              </div>
            ) : null}
          </div>
          {leading}
        </div>
        {title ? (
          <motion.div
            className="titlebar-title"
            data-active={titleActive}
            layout="position"
            transition={{
              layout: {
                duration: 0.34 * motionScale,
                ease: [0.33, 1, 0.15, 1] as const,
              },
            }}
          >
            <div className="titlebar-heading">
              <h1>
                {onTitleSelect ? (
                  <Tooltip
                    label="Back to the conversation"
                    disabled={titleActive}
                    placement="bottom"
                  >
                    <button
                      className="titlebar-title-button"
                      type="button"
                      onClick={onTitleSelect}
                      aria-current={titleActive ? "page" : undefined}
                      aria-label={titleActive ? undefined : "Back to the conversation"}
                    >
                      <motion.span
                        className="titlebar-title-copy"
                        key={title}
                        initial={
                          motionScale === 0 ? false : { opacity: 0, y: 2, filter: "blur(2px)" }
                        }
                        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                        transition={{ duration: 0.2 * motionScale, ease: [0.2, 0, 0, 1] }}
                      >
                        {title}
                      </motion.span>
                    </button>
                  </Tooltip>
                ) : (
                  <motion.span
                    className="titlebar-title-copy"
                    key={title}
                    initial={motionScale === 0 ? false : { opacity: 0, y: 2, filter: "blur(2px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    transition={{ duration: 0.2 * motionScale, ease: [0.2, 0, 0, 1] }}
                  >
                    {title}
                  </motion.span>
                )}
              </h1>
              {detail ? <span className="titlebar-title-detail">{detail}</span> : null}
            </div>
          </motion.div>
        ) : null}
        {resourceTabs}
      </div>
      {!tabs && !title && context ? <div className="titlebar-context">{context}</div> : null}
      <div className="titlebar-end" data-tauri-drag-region>
        {tabs}
        {trailing}
        <div className="window-controls">
          <button type="button" aria-label="Minimize" onClick={() => void windowAction("minimize")}>
            <Minus />
          </button>
          <button
            type="button"
            aria-label="Maximize or restore"
            onClick={() => void windowAction("toggleMaximize")}
          >
            <Square />
          </button>
          <button type="button" aria-label="Close" onClick={() => void windowAction("close")}>
            <X />
          </button>
        </div>
      </div>
    </header>
  );
}

function EmptyProjectState({ busy, onOpenProject }: { busy: boolean; onOpenProject: () => void }) {
  return (
    <section className="native-empty-state" aria-labelledby="empty-project-title">
      <div className="native-empty-icon" aria-hidden="true">
        <FolderOpen />
      </div>
      <p className="empty-eyebrow">Local-first workspace</p>
      <h1 id="empty-project-title">Open a local project</h1>
      <p className="empty-description">
        Choose a repository you own. AI Integrator stores project trust and sessions locally, and
        your vendor CLI credentials stay with each provider.
      </p>
      <button
        className="empty-primary-action"
        type="button"
        onClick={onOpenProject}
        disabled={busy}
        aria-busy={busy}
      >
        <FolderOpen aria-hidden="true" />
        {busy ? "Opening folder…" : "Open project"}
        {!busy ? <ArrowRight aria-hidden="true" /> : null}
      </button>
      <div className="empty-trust-note">
        <strong>No AI Integrator account required</strong>
        <span>The selected folder stays local and is explicitly trusted before agents use it.</span>
      </div>
    </section>
  );
}

function AddProjectModal({
  busy,
  error,
  onClose,
  onOpenExisting,
  onCreateNew,
  onClone,
}: {
  busy: boolean;
  error: string;
  onClose: () => void;
  onOpenExisting: () => void;
  onCreateNew: (name: string) => void;
  onClone: (input: CloneProjectInput) => void;
}) {
  const [mode, setMode] = useState<"choose" | "create" | "clone">("choose");
  const [name, setName] = useState("");
  const [cloneSource, setCloneSource] = useState<"github" | "url">("github");
  const [catalog, setCatalog] = useState<GithubRepositoryCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedRepository, setSelectedRepository] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [parent, setParent] = useState(() => {
    try {
      return window.localStorage.getItem("integrator.clone.parent") ?? "";
    } catch {
      return "";
    }
  });
  const [folderName, setFolderName] = useState("");
  const [folderNameEdited, setFolderNameEdited] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (mode === "create") nameInputRef.current?.focus();
  }, [mode]);
  const openClone = () => {
    setMode("clone");
    if (!parent) {
      void bridge.getDefaultProjectParent().then((value) => setParent(value));
    }
    if (!catalog && !catalogLoading) {
      setCatalogLoading(true);
      void bridge
        .listGithubRepositories()
        .then(setCatalog)
        .catch((failure: unknown) =>
          setCatalog({
            installed: false,
            authenticated: false,
            repositories: [],
            detail: failure instanceof Error ? failure.message : "GitHub repositories unavailable.",
          }),
        )
        .finally(() => setCatalogLoading(false));
    }
  };
  const trimmedName = name.trim();
  const filteredRepositories = (catalog?.repositories ?? []).filter((repository) => {
    const needle = query.trim().toLocaleLowerCase();
    return (
      !needle ||
      repository.nameWithOwner.toLocaleLowerCase().includes(needle) ||
      repository.description?.toLocaleLowerCase().includes(needle)
    );
  });
  const inferFolderName = (value: string) =>
    value
      .trim()
      .split(/[/:]/)
      .at(-1)
      ?.replace(/\.git$/i, "") ?? "";
  const cloneReady = Boolean(
    parent.trim() &&
    folderName.trim() &&
    (cloneSource === "github" ? selectedRepository : repositoryUrl.trim()),
  );
  const title =
    mode === "choose"
      ? "Add a project"
      : mode === "create"
        ? "Create new project"
        : "Clone repository";
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onClose();
      }}
    >
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-project-title"
      >
        <div className="modal-head">
          <h2 id="add-project-title">{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
          >
            <X />
          </button>
        </div>
        {mode === "choose" ? (
          <div className="modal-options">
            <button type="button" className="modal-option" onClick={onOpenExisting} disabled={busy}>
              <FolderOpen aria-hidden="true" />
              <span>
                <strong>Open local folder</strong>
                <small>Open any folder, with or without Git.</small>
              </span>
            </button>
            <button type="button" className="modal-option" onClick={openClone} disabled={busy}>
              <Download aria-hidden="true" />
              <span>
                <strong>Clone repository</strong>
                <small>Choose from GitHub or paste a repository URL.</small>
              </span>
            </button>
            <button
              type="button"
              className="modal-option"
              onClick={() => setMode("create")}
              disabled={busy}
            >
              <FolderPlus aria-hidden="true" />
              <span>
                <strong>Create new project</strong>
                <small>Make a new folder and initialize a fresh Git repository.</small>
              </span>
            </button>
          </div>
        ) : mode === "create" ? (
          <form
            className="modal-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (trimmedName) onCreateNew(trimmedName);
            }}
          >
            <label htmlFor="new-project-name">Project name</label>
            <input
              id="new-project-name"
              ref={nameInputRef}
              type="text"
              value={name}
              maxLength={120}
              placeholder="my-new-project"
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
            />
            <p className="modal-hint">
              Created in Documents › AI Integrator › Projects and initialized as a Git repository.
            </p>
            {error ? (
              <p className="modal-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="modal-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setMode("choose")}
                disabled={busy}
              >
                Back
              </button>
              <button
                type="submit"
                className="empty-primary-action"
                disabled={busy || !trimmedName}
                aria-busy={busy}
              >
                {busy ? "Creating…" : "Create project"}
              </button>
            </div>
          </form>
        ) : (
          <form
            className="modal-create-form clone-project-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!cloneReady) return;
              onClone({
                remote: cloneSource === "url" ? repositoryUrl.trim() : "",
                parent: parent.trim(),
                folderName: folderName.trim(),
                ...(cloneSource === "github" ? { githubRepository: selectedRepository } : {}),
              });
            }}
          >
            <div className="clone-source-tabs" role="tablist" aria-label="Repository source">
              <button
                type="button"
                role="tab"
                aria-selected={cloneSource === "github"}
                data-active={cloneSource === "github"}
                onClick={() => setCloneSource("github")}
              >
                <Github aria-hidden="true" /> Your repositories
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={cloneSource === "url"}
                data-active={cloneSource === "url"}
                onClick={() => setCloneSource("url")}
              >
                Repository URL
              </button>
            </div>
            {cloneSource === "github" ? (
              <div className="clone-repository-picker">
                {catalogLoading ? <p className="modal-hint">Checking GitHub CLI…</p> : null}
                {catalog?.authenticated ? (
                  <>
                    <label className="clone-search" htmlFor="clone-repository-search">
                      <Search aria-hidden="true" />
                      <input
                        id="clone-repository-search"
                        type="search"
                        value={query}
                        placeholder={`Search ${catalog.account ?? "GitHub"} repositories`}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    </label>
                    <div className="clone-repository-list" role="listbox">
                      {filteredRepositories.map((repository) => (
                        <button
                          key={repository.nameWithOwner}
                          type="button"
                          role="option"
                          aria-selected={selectedRepository === repository.nameWithOwner}
                          data-selected={selectedRepository === repository.nameWithOwner}
                          onClick={() => {
                            setSelectedRepository(repository.nameWithOwner);
                            setFolderName(repository.name);
                            setFolderNameEdited(false);
                          }}
                        >
                          <span>
                            <strong>{repository.nameWithOwner}</strong>
                            <small>{repository.description || "No description"}</small>
                          </span>
                          <small>{repository.private ? "Private" : "Public"}</small>
                        </button>
                      ))}
                    </div>
                  </>
                ) : catalog ? (
                  <div className="clone-cli-state">
                    <strong>GitHub repositories unavailable</strong>
                    <span>{catalog.detail ?? "Sign in with GitHub CLI, or paste a URL."}</span>
                    <button type="button" onClick={() => setCloneSource("url")}>
                      Use a URL
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <label htmlFor="clone-repository-url">
                Repository URL
                <input
                  id="clone-repository-url"
                  type="text"
                  value={repositoryUrl}
                  placeholder="https://github.com/company/project.git"
                  onChange={(event) => {
                    const value = event.target.value;
                    setRepositoryUrl(value);
                    if (!folderNameEdited) setFolderName(inferFolderName(value));
                  }}
                />
              </label>
            )}
            <label htmlFor="clone-folder-name">
              Folder name
              <input
                id="clone-folder-name"
                type="text"
                value={folderName}
                maxLength={120}
                placeholder="project"
                onChange={(event) => {
                  setFolderName(event.target.value);
                  setFolderNameEdited(true);
                }}
              />
            </label>
            <div className="clone-location-row">
              <span>
                <small>Location</small>
                <Tooltip label={parent || "Loading default location…"} placement="top">
                  <strong>{parent || "Loading default location…"}</strong>
                </Tooltip>
              </span>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  void bridge.pickProjectParent().then((selected) => {
                    if (!selected) return;
                    setParent(selected);
                    try {
                      window.localStorage.setItem("integrator.clone.parent", selected);
                    } catch {
                      // Remembering the location is best-effort.
                    }
                  });
                }}
              >
                Change…
              </button>
            </div>
            {error ? (
              <p className="modal-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="modal-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setMode("choose")}
                disabled={busy}
              >
                Back
              </button>
              <button
                type="submit"
                className="empty-primary-action"
                disabled={busy || !cloneReady}
                aria-busy={busy}
              >
                {busy ? "Cloning…" : "Clone repository"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function EmptyTaskState({ project }: { project: ProjectSummary }) {
  return (
    <section className="empty-task-state" aria-labelledby="empty-task-title">
      <span className="empty-task-mark" aria-hidden="true">
        <span className="brand-mark-glyph brand-mark-glyph--lg" />
      </span>
      <span className="empty-task-kicker">{project.name}</span>
      <h2 id="empty-task-title">What are we working on?</h2>
    </section>
  );
}

function isPendingGeneralChat(task: TaskSummary): boolean {
  return (
    task.kind === "chat" &&
    !task.archived &&
    task.status === "draft" &&
    task.title === GENERAL_CHAT_TITLE_PLACEHOLDER
  );
}

/**
 * Grace period before a non-connected notice becomes visible. New tasks pass
 * through reconciling/connecting for a few hundred milliseconds while the
 * provider spawns; flashing a banner for that is noise.
 */
const CONNECTION_NOTICE_DELAY_MS = 800;

function ConnectionNotice({
  state,
  runtime,
  resuming = false,
  quietReconciling = false,
  showDisconnected = false,
}: {
  state: RuntimeProjectionState["connection"];
  runtime: string;
  /** Quiet chrome while an interrupted turn is being continued. */
  resuming?: boolean;
  /** A fresh task has no persisted provider state to explain. */
  quietReconciling?: boolean;
  /** An idle per-turn runtime being stopped is normal, not an alert. */
  showDisconnected?: boolean;
}) {
  const displayState: RuntimeProjectionState["connection"] = resuming
    ? { state: "connecting" }
    : state;
  const active =
    displayState.state !== "connected" &&
    (displayState.state !== "disconnected" || showDisconnected) &&
    !(quietReconciling && displayState.state === "reconciling");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      if (!visible) return;
      const timer = window.setTimeout(() => setVisible(false), 0);
      return () => window.clearTimeout(timer);
    }
    if (visible) return;
    const timer = window.setTimeout(() => setVisible(true), CONNECTION_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [active, visible]);

  if (!active || !visible) return null;
  const shown = displayState;
  const labels = {
    connected: `${runtime} is connected`,
    connecting: resuming ? "Resuming…" : `Connecting to ${runtime}…`,
    disconnected: `${runtime} is disconnected`,
    reconciling: "Reconciling persisted task state…",
    gap: "Some runtime events were missed",
  } as const;
  return (
    <div
      className={`runtime-connection runtime-connection--${shown.state}`}
      role={shown.state === "disconnected" ? "alert" : "status"}
      aria-live="polite"
    >
      <span className="runtime-connection-dot" aria-hidden="true" />
      <span>
        <strong>{labels[shown.state]}</strong>
        {shown.reason && !resuming ? <small>{shown.reason}</small> : null}
      </span>
    </div>
  );
}

function clearVerifiedRuntimeFailures(
  state: RuntimeProjectionState,
  runtime: RuntimeId | undefined,
  verifiedRuntimes: ReadonlySet<RuntimeId>,
): RuntimeProjectionState {
  if (!runtime || !verifiedRuntimes.has(runtime)) return state;
  const errors = state.errors.filter((error) => !isRuntimeHealthError(error.message));
  const connection =
    state.connection.state === "disconnected" ? { state: "connected" as const } : state.connection;
  if (errors.length === state.errors.length && connection === state.connection) return state;
  return { ...state, errors, connection };
}

function runtimeIdForProjectionProvider(provider: RuntimeProjectionEvent["provider"]): RuntimeId {
  return provider === "custom-acp" ? "custom" : provider;
}

function recordRuntimeVerificationEvent(
  event: RuntimeProjectionEvent,
  verifiedRuntimes: Set<RuntimeId>,
): boolean {
  const runtime = runtimeIdForProjectionProvider(event.provider);
  if (event.projection.kind === "connectionChanged") {
    if (event.projection.state === "connected") {
      verifiedRuntimes.add(runtime);
      return true;
    }
    if (event.projection.state === "disconnected") verifiedRuntimes.delete(runtime);
  }
  if (event.projection.kind === "turnError" && isRuntimeHealthError(event.projection.message)) {
    verifiedRuntimes.delete(runtime);
  }
  return false;
}

// Some runtimes leave a pending approval in place after retracting the
// command it was for, instead of transitioning it to "cancelled"/"expired".
// Responding to it is a no-op the backend rejects, so its buttons look dead.
// Recognize the tell (varies by provider wording) and drop it client-side
// rather than showing an approval no click can resolve.
const STALE_APPROVAL_PATTERN = /no longer (?:required|needed|applicable|valid)/i;

function isStaleApproval(approval: ApprovalProjection): boolean {
  return (
    STALE_APPROVAL_PATTERN.test(approval.reason ?? "") ||
    STALE_APPROVAL_PATTERN.test(approval.command ?? "")
  );
}

function ApprovalControl({
  approval,
  busy,
  autoApproving,
  runtime,
  onDecision,
  onSelectOption,
}: {
  approval: ApprovalProjection;
  busy: boolean;
  autoApproving?: boolean;
  /** Which provider raised the approval; tailors plan-review actions. */
  runtime?: RuntimeId;
  onDecision: (decision: ApprovalDecision) => void;
  /** Answer a "question" approval with one of its offered options. ACP has
   *  no elicitation method, so the agent asked through the same permission
   *  channel a command/file-edit gate uses — this is a distinct approval
   *  kind rather than another onDecision value because the answer is one of
   *  N labeled choices, not a binary allow/reject. */
  onSelectOption: (option: QuestionOption) => void;
}) {
  const isCommand = approval.approvalKind === "commandExecution";
  const isPlan = approval.approvalKind === "planReview";
  const isQuestion = approval.approvalKind === "question";
  const failed = approval.state === "responseFailed";
  const changedPaths = approval.fileChanges?.map((change) => change.path) ?? [];
  const options = approval.options ?? [];
  // Cursor builds the approved plan in Agent mode right away, so the accept
  // action is the build action. Claude's accept exits plan mode and keeps
  // per-edit prompts; accept-for-session additionally auto-accepts the edits.
  const planAcceptLabel = runtime === "cursor" ? "Approve & build" : "Approve plan";
  return (
    <section
      className="approval-control"
      data-auto={autoApproving || undefined}
      aria-labelledby={`approval-${approval.id}`}
    >
      <header className="approval-header">
        <div className="approval-icon" aria-hidden="true">
          {isQuestion ? (
            <HelpCircle />
          ) : isPlan ? (
            <ClipboardList />
          ) : isCommand ? (
            <TerminalSquare />
          ) : (
            <FileDiff />
          )}
        </div>
        <div className="approval-heading">
          <span className="approval-kicker">
            {autoApproving ? "Auto-approving — full access is on" : "Approval required"}
          </span>
          <h3 id={`approval-${approval.id}`}>
            {isQuestion
              ? "The agent has a question"
              : isPlan
                ? "Approve this plan?"
                : isCommand
                  ? "Run this command?"
                  : "Apply these file changes?"}
          </h3>
        </div>
      </header>
      <div className="approval-body">
        {isQuestion ? (
          <p>{approval.reason ?? "The agent is waiting for an answer."}</p>
        ) : isPlan ? (
          <>
            {approval.reason ? <p>{approval.reason}</p> : null}
            {approval.planMarkdown ? (
              <pre className="approval-plan">{approval.planMarkdown}</pre>
            ) : (
              <p>The agent finished planning and is waiting for approval to implement.</p>
            )}
          </>
        ) : isCommand ? (
          <code className="approval-command">
            {approval.command ?? approval.reason ?? "The agent is waiting to run a command."}
          </code>
        ) : changedPaths.length > 0 ? (
          <ul className="approval-files">
            {changedPaths.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p>{approval.reason ?? "The agent is waiting to change files."}</p>
        )}
        {isCommand && approval.cwd ? (
          <small className="approval-cwd">in {approval.cwd}</small>
        ) : null}
        {failed && !autoApproving ? (
          <small className="approval-failed" role="alert">
            The last response didn't reach the agent — try again.
          </small>
        ) : null}
      </div>
      <div className="approval-actions">
        {autoApproving ? (
          <span className="approval-auto-note" aria-live="polite">
            Approving…
          </span>
        ) : isQuestion ? (
          <>
            <button
              type="button"
              className="secondary-button approval-decline"
              onClick={() => onDecision("cancel")}
              disabled={busy}
            >
              Skip
            </button>
            {options.map((option) => (
              <button
                key={option.optionId}
                type="button"
                className="secondary-button approval-question-option"
                onClick={() => onSelectOption(option)}
                disabled={busy}
              >
                {option.label}
              </button>
            ))}
          </>
        ) : (
          <>
            <button
              type="button"
              className="secondary-button approval-decline"
              onClick={() => onDecision("decline")}
              disabled={busy}
            >
              {isPlan ? "Keep planning" : "Decline"}
            </button>
            {isCommand ? (
              <Tooltip
                label="Allow this and similar commands for the rest of this session"
                placement="top"
              >
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onDecision("acceptForSession")}
                  disabled={busy}
                >
                  Allow for session
                </button>
              </Tooltip>
            ) : null}
            {isPlan && runtime !== "cursor" ? (
              <Tooltip
                label="Approve the plan and auto-accept the file edits that implement it"
                placement="top"
              >
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onDecision("acceptForSession")}
                  disabled={busy}
                >
                  Approve & auto-edit
                </button>
              </Tooltip>
            ) : null}
            <button
              type="button"
              className="primary-button"
              onClick={() => onDecision("accept")}
              disabled={busy}
              aria-busy={busy}
            >
              {busy
                ? "Responding…"
                : isPlan
                  ? planAcceptLabel
                  : isCommand
                    ? "Run command"
                    : "Allow changes"}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

export default function App() {
  const nativeHost = isNativeHost();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(initialSnapshot);
  const [workspaceLoading, setWorkspaceLoading] = useState(isNativeHost);
  const [gitLoading, setGitLoading] = useState(isNativeHost);
  const [openingProject, setOpeningProject] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [createProjectError, setCreateProjectError] = useState("");
  const [deleteProjectId, setDeleteProjectId] = useState("");
  const [deleteProjectBusy, setDeleteProjectBusy] = useState(false);
  const [deleteProjectError, setDeleteProjectError] = useState("");
  const [deleteTaskId, setDeleteTaskId] = useState("");
  const [deleteTaskBusy, setDeleteTaskBusy] = useState(false);
  const [deleteTaskError, setDeleteTaskError] = useState("");
  const [deleteArchivedChatsProjectId, setDeleteArchivedChatsProjectId] = useState("");
  const [deleteArchivedChatsBusy, setDeleteArchivedChatsBusy] = useState(false);
  const [deleteArchivedChatsError, setDeleteArchivedChatsError] = useState("");
  /** Lazily loaded archived roots — kept out of the hot workspace snapshot. */
  const [archivedTasks, setArchivedTasks] = useState<TaskSummary[]>([]);
  const [archivedTotal, setArchivedTotal] = useState(0);
  const [archivedNextCursor, setArchivedNextCursor] = useState<string | undefined>();
  const [archivedLoading, setArchivedLoading] = useState(false);
  const archivedCatalogReady = useRef(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [switchingTaskId, setSwitchingTaskId] = useState("");
  const [taskActionBusyId, setTaskActionBusyId] = useState("");
  /** A just-created fork, switched to once it lands in the task list. */
  const pendingForkSelection = useRef("");
  /** User message queued for truncate-on-send after Edit returned it to the composer. */
  const pendingEditRef = useRef<{ taskId: string; eventId: string } | null>(null);
  const [newChatDraftKey, setNewChatDraftKey] = useState(0);
  const [promotingDraftTaskId, setPromotingDraftTaskId] = useState("");
  const [operationError, setOperationError] = useState("");
  const [composerError, setComposerError] = useState<ComposerErrorState | null>(null);
  const [operationStatus, setOperationStatus] = useState("");
  const [runtimeState, setRuntimeState] = useState<RuntimeProjectionState | null>(null);
  const [optimisticUserMessage, setOptimisticUserMessage] = useState<OptimisticUserMessage | null>(
    null,
  );
  const clearOptimisticUserMessageForTask = useCallback((taskId: string) => {
    setOptimisticUserMessage((current) => clearOptimisticMessageForTask(current, taskId));
  }, []);
  const [freshTaskIds, setFreshTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const pendingGeneralChatRef = useRef<TaskSummary | undefined>(undefined);
  const [composerDraftStore] = useState(() => new ComposerDraftStore());
  const draftPersistenceFailureShown = useRef(false);
  const pendingDraftWrites = useRef(new Map<string, ComposerDraft>());
  const draftWriterRunning = useRef(false);
  const [delegations, setDelegations] = useState<DelegationView[]>([]);
  const [automationTimeline, setAutomationTimeline] = useState<AutomationTimelineEntry[]>([]);
  // The work pane (files, review, subagents, browser tabs) is owned by the
  // active task, or by the project while drafting a new chat.
  const workPaneOwnerKey = snapshot.activeTaskId
    ? snapshot.activeTaskId
    : snapshot.activeProjectId
      ? `project:${snapshot.activeProjectId}`
      : "";
  const workPane = useWorkPane(workPaneOwnerKey);
  const selectedDelegationId =
    workPane.active?.kind === "subagent" ? workPane.active.delegationId : undefined;
  // Browser tabs are native surfaces the pane hosts; captures land in the composer.
  const browser = useBrowserTabs({
    attachImage: async (file, name) => {
      const attachment = await bridge.savePastedImageAttachment?.(file, name, undefined);
      if (!attachment) return;
      composerAttachmentSequence.current += 1;
      setComposerAttachment({ id: composerAttachmentSequence.current, attachment });
    },
    insertText: (text) => {
      composerInsertSequence.current += 1;
      setComposerInsert({ id: composerInsertSequence.current, text });
    },
  });
  // A tab an agent opened gets a pane tab of its own, so its browsing is
  // something the user watches rather than something happening off screen.
  // It does not steal the foreground: whatever surface is active stays active.
  const surfacedBrowserTabs = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const tab of browser.tabs) {
      if (tab.taskId !== snapshot.activeTaskId) continue;
      if (surfacedBrowserTabs.current.has(tab.id)) continue;
      surfacedBrowserTabs.current.add(tab.id);
      workPane.openBrowser(tab.id, { activate: false, show: true });
    }
  }, [browser.tabs, snapshot.activeTaskId, workPane]);
  // Provider-reported subscription quota keyed by runtime (Codex today).
  // Refreshed per active-task switch; never inferred when a provider is silent.
  const [providerQuota, setProviderQuota] = useState<Record<string, SubscriptionQuota>>({});
  const [respondingApprovalId, setRespondingApprovalId] = useState("");
  // Live composer permission per task. Switching to full access mid-run
  // auto-approves pending and future command approvals for that task.
  const [taskPermissions, setTaskPermissions] = useState<Record<string, TaskPermission>>({});
  const autoApprovedIdsRef = useRef<Set<string>>(new Set());
  const [autoApprovalFailures, setAutoApprovalFailures] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // External composer permission set-requests: mirrors agent-driven mode
  // changes (e.g. an approved plan exit) back into the permission picker.
  // The id is the task:mode pair the request derives from.
  const [permissionRequest, setPermissionRequest] = useState<{
    taskId: string;
    id: string;
    value: TaskPermission;
  } | null>(null);
  // Task whose approved Cursor plan should be built once the planning turn
  // settles. Cleared if the user sends their own message first.
  const pendingPlanBuildRef = useRef("");
  const [stoppingTurn, setStoppingTurn] = useState(false);
  const [resumingTaskId, setResumingTaskId] = useState("");
  const [recoveryFailure, setRecoveryFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const autoResumeAttemptedRef = useRef(new Set<string>());
  /** Worked-for rows that continued after an interruption; quiet (resumed) cue. */
  const resumedWorkedForIdsRef = useRef(new Set<string>());
  const resumeWorkedForBaselineRef = useRef<Set<string> | null>(null);
  const [resumedWorkedForVersion, setResumedWorkedForVersion] = useState(0);
  // Turns the user explicitly stopped. Survives a late interrupted settlement
  // that forgets stopRequested, so Resume cannot undo Stop.
  const userStoppedTurnsRef = useRef(new Set<string>());
  const [queueBusyId, setQueueBusyId] = useState("");
  const queueBusyIdRef = useRef("");
  const priorityQueueIdRef = useRef("");
  const queuePausedTaskIdsRef = useRef(new Set<string>());
  // A native turn-active rejection can arrive before the matching projection.
  // Hold its follow-up until that authoritative active turn becomes visible.
  const queueWaitingForActiveTurnByTaskRef = useRef(new Map<string, number>());
  const queueAwaitingTurnRef = useRef<{ taskId: string; previousTurnId?: string } | undefined>(
    undefined,
  );
  const automationDispatchingRef = useRef(new Set<string>());
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [runtimeActionRequest, setRuntimeActionRequest] = useState<RuntimeActionRequest | null>(
    null,
  );
  const runtimeActionSequence = useRef(0);
  const [centerView, setCenterView] = useState<CenterView>(initialCenterView);
  const [localSettings, setLocalSettings] = useState<Record<string, unknown>>({});
  const taskPermissionsRef = useRef(taskPermissions);
  taskPermissionsRef.current = taskPermissions;
  const autoApprovalFailuresRef = useRef(autoApprovalFailures);
  autoApprovalFailuresRef.current = autoApprovalFailures;
  const localSettingsRef = useRef(localSettings);
  localSettingsRef.current = localSettings;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () =>
      typeof window !== "undefined" && Boolean(window.matchMedia?.("(max-width: 900px)").matches),
  );
  const [rightRailOpen, setRightRailOpen] = useState(
    () => !window.matchMedia?.("(max-width: 980px)").matches,
  );
  const [scheduledRailOpen, setScheduledRailOpen] = useState(false);
  const [scheduledCreateRequest, setScheduledCreateRequest] = useState(0);
  const [openProjectFileRequest, setOpenProjectFileRequest] = useState<
    (ProjectFileLocation & { id: number }) | null
  >(null);
  // First-class canvas file tabs, shown beside the chat title. Contents live
  // here; per-task paths persist through snapshot.openFilesByTask.
  const [openFileTabs, setOpenFileTabs] = useState<ProjectFileContent[]>([]);
  const [activeFileLocation, setActiveFileLocation] = useState<ProjectFileLocation | null>(null);
  const [fileTabOpeningPath, setFileTabOpeningPath] = useState("");
  const fileTabsCache = useRef(new Map<string, { tabs: ProjectFileContent[]; active: string }>());
  const handledFileRequestRef = useRef<number | null>(null);
  // Refs mirror the tab state for the long-lived keyboard shortcut listener.
  const activeFileTabPathRef = useRef("");
  const closeFileTabRef = useRef<(path: string) => void>(() => undefined);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    storedDimension(SIDEBAR_WIDTH_STORAGE_KEY, 272, 220, 420),
  );
  const [rightRailWidth, setRightRailWidth] = useState(() =>
    storedDimension(RIGHT_RAIL_WIDTH_STORAGE_KEY, 356, 300, 520),
  );
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalSurfaceActivated, setTerminalSurfaceActivated] = useState(false);
  const [diffView, setDiffView] = useState<"unified" | "split">("unified");
  const [activeFileKey, setActiveFileKey] = useState(() =>
    snapshot.git.files[0] ? diffFileKey(snapshot.git.files[0]) : "",
  );
  const [projectFiles, setProjectFiles] = useState<ProjectFileEntry[]>([]);
  const [projectFileOpenerState, setProjectFileOpenerState] = useState<{
    projectId: string;
    openers: ProjectFileOpener[];
  }>({ projectId: "", openers: [] });
  const [projectFilesState, setProjectFilesState] = useState<"loading" | "ready" | "unavailable">(
    "unavailable",
  );
  const [reviewedFiles, setReviewedFiles] = useState<Record<string, boolean>>({});
  const [reviewRefreshing, setReviewRefreshing] = useState(false);
  const [reviewLoadError, setReviewLoadError] = useState<{
    fileKey: string;
    message: string;
  } | null>(null);
  const [reviewRetryVersion, setReviewRetryVersion] = useState(0);
  const [preferences, setPreferences] = useState<ThemePreferences>(() => initializeTheme());
  const [composerInsert, setComposerInsert] = useState<{
    id: number;
    text: string;
  } | null>(null);
  const composerInsertSequence = useRef(0);
  const [composerAttachment, setComposerAttachment] = useState<{
    id: number;
    attachment: ComposerDraftAttachment;
  } | null>(null);
  const composerAttachmentSequence = useRef(0);
  const [composerRestore, setComposerRestore] = useState<{
    id: number;
    value: ComposerDraftValue;
  } | null>(null);
  const composerRestoreSequence = useRef(0);
  const projectionBuffer = useRef<RuntimeProjectionEvent[]>([]);
  const projectionReady = useRef(false);
  const projectionTaskId = useRef("");
  const [readyProjectionTaskId, setReadyProjectionTaskId] = useState("");
  const projectionGeneration = useRef(0);
  const navigationGeneration = useRef(0);
  const taskProjectionCache = useRef(new Map<string, RuntimeProjectionState>());
  const [subagentProjectionCache] = useState(() => new SubagentProjectionCache());
  const activeTaskIdRef = useRef<string | undefined>(snapshot.activeTaskId);

  useEffect(() => {
    const message = operationError.trim();
    if (!message) return;
    void bridge.reportDiagnostic?.("incident", {
      level: "error",
      faultId:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `fault-${Date.now()}`,
      layer: "ui",
      op: "ui.operationError",
      outcome: "fail",
      causeClass: "ui-state",
      taskId: activeTaskIdRef.current || undefined,
      projectId: snapshot.activeProjectId || undefined,
      detail: message,
    });
  }, [operationError, snapshot.activeProjectId]);

  useEffect(() => {
    if (!composerError?.message.trim()) return;
    void bridge.reportDiagnostic?.("incident", {
      level: "error",
      faultId:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `fault-${Date.now()}`,
      layer: "ui",
      op: "ui.composerNotice",
      outcome: "fail",
      causeClass: "ui-state",
      taskId: activeTaskIdRef.current || undefined,
      projectId: snapshot.activeProjectId || undefined,
      detail: composerError.message,
    });
  }, [composerError, snapshot.activeProjectId]);
  const activeProjectIdRef = useRef<string | undefined>(snapshot.activeProjectId);
  const taskRuntimeByIdRef = useRef(
    new Map(snapshot.tasks.map((task) => [task.id, task.runtime] as const)),
  );
  const verifiedRuntimesRef = useRef(new Set<RuntimeId>());
  const taskGitCache = useRef(new Map<string, GitSnapshot>());
  const taskGitRefreshedAt = useRef(new Map<string, number>());
  const taskGitGeneration = useRef(new Map<string, number>());
  const taskGitAppliedGeneration = useRef(new Map<string, number>());
  const scheduledTaskGitRefresh = useRef(new Map<string, number>());
  const scheduledProjectGitRefresh = useRef(new Map<string, number>());
  const taskGitInvalidatedPaths = useRef(new Map<string, Set<string> | null>());
  const delegationLineageTaskIdsRef = useRef(
    new Set(snapshot.activeTaskId ? [snapshot.activeTaskId] : []),
  );
  const projectFilesCache = useRef(new Map<string, ProjectFileEntry[]>());
  const activeProjectForFilesRef = useRef<string | undefined>(undefined);
  const composerNoticeSequence = useRef(0);
  const conversationWorkspaceRef = useRef<HTMLDivElement>(null);
  const appRootRef = useRef<HTMLDivElement>(null);
  const subagentPaneRef = useRef<HTMLDivElement>(null);
  const [subagentHeaderTarget, setSubagentHeaderTarget] = useState<HTMLDivElement | null>(null);

  const applyVerifiedRuntimeHealth = useCallback(
    (runtimes: RuntimeConnection[], tasks: TaskSummary[]) => {
      const verified = new Set(
        runtimes.filter((runtime) => runtime.status === "connected").map((runtime) => runtime.id),
      );
      verifiedRuntimesRef.current = verified;
      taskRuntimeByIdRef.current = new Map(tasks.map((task) => [task.id, task.runtime] as const));
      if (verified.size === 0) return;

      setComposerError((current) => {
        if (!current || !isRuntimeHealthError(current.message)) return current;
        const runtime = taskRuntimeByIdRef.current.get(current.taskId);
        return runtime && verified.has(runtime) ? null : current;
      });
      setRuntimeState((current) =>
        current
          ? clearVerifiedRuntimeFailures(
              current,
              taskRuntimeByIdRef.current.get(current.taskId),
              verified,
            )
          : current,
      );
      for (const [taskId, state] of taskProjectionCache.current) {
        taskProjectionCache.current.set(
          taskId,
          clearVerifiedRuntimeFailures(state, taskRuntimeByIdRef.current.get(taskId), verified),
        );
      }
    },
    [],
  );

  const applyTaskGitSnapshot = useCallback(
    (taskId: string, git: GitSnapshot, expectedGeneration?: number): boolean => {
      const currentGeneration = taskGitGeneration.current.get(taskId) ?? 0;
      if (expectedGeneration !== undefined && expectedGeneration !== currentGeneration) {
        return false;
      }
      const appliedGeneration = expectedGeneration ?? currentGeneration + 1;
      if (expectedGeneration === undefined) {
        taskGitGeneration.current.set(taskId, appliedGeneration);
      }
      taskGitAppliedGeneration.current.set(taskId, appliedGeneration);
      taskGitCache.current.set(taskId, git);
      taskGitRefreshedAt.current.set(taskId, Date.now());
      if (activeTaskIdRef.current !== taskId) return true;
      setSnapshot((current) => (current.activeTaskId === taskId ? { ...current, git } : current));
      setActiveFileKey((current) =>
        git.files.some((file) => diffFileKey(file) === current)
          ? current
          : git.files[0]
            ? diffFileKey(git.files[0])
            : "",
      );
      return true;
    },
    [],
  );

  const refreshTaskGitSnapshot = useCallback(
    async (
      taskId: string,
      invalidatedPaths?: ReadonlySet<string>,
    ): Promise<GitSnapshot | undefined> => {
      const generation = (taskGitGeneration.current.get(taskId) ?? 0) + 1;
      taskGitGeneration.current.set(taskId, generation);
      const incoming = await bridge.loadTaskGit(taskId);
      const git = reconcileGitSnapshot(
        taskGitCache.current.get(taskId),
        incoming,
        invalidatedPaths,
      );
      return applyTaskGitSnapshot(taskId, git, generation) ? git : undefined;
    },
    [applyTaskGitSnapshot],
  );

  const invalidateTaskGit = useCallback((taskId: string, paths?: Iterable<string>) => {
    const current = taskGitInvalidatedPaths.current.get(taskId);
    if (paths === undefined || current === null) {
      taskGitInvalidatedPaths.current.set(taskId, null);
    } else {
      const invalidated = current ?? new Set<string>();
      for (const path of paths) invalidated.add(path);
      taskGitInvalidatedPaths.current.set(taskId, invalidated);
    }
    taskGitGeneration.current.set(taskId, (taskGitGeneration.current.get(taskId) ?? 0) + 1);
  }, []);

  const refreshInvalidatedTaskGit = useCallback(
    async (taskId: string): Promise<GitSnapshot | undefined> => {
      const invalidated = taskGitInvalidatedPaths.current.get(taskId);
      taskGitInvalidatedPaths.current.delete(taskId);
      try {
        const pending = refreshTaskGitSnapshot(taskId, invalidated ?? undefined);
        const refreshGeneration = taskGitGeneration.current.get(taskId) ?? 0;
        const git = await pending;
        if (!git && (taskGitAppliedGeneration.current.get(taskId) ?? 0) < refreshGeneration) {
          invalidateTaskGit(taskId, invalidated === null ? undefined : (invalidated ?? []));
        }
        return git;
      } catch (error) {
        invalidateTaskGit(taskId, invalidated === null ? undefined : (invalidated ?? []));
        throw error;
      }
    },
    [invalidateTaskGit, refreshTaskGitSnapshot],
  );

  const scheduleTaskGitRefresh = useCallback(
    (taskId: string, paths: string[]) => {
      invalidateTaskGit(taskId, paths.length > 0 ? paths : undefined);
      const pending = scheduledTaskGitRefresh.current.get(taskId);
      if (pending !== undefined) window.clearTimeout(pending);
      const timer = window.setTimeout(() => {
        scheduledTaskGitRefresh.current.delete(taskId);
        if (activeTaskIdRef.current !== taskId) return;
        void refreshInvalidatedTaskGit(taskId).catch(() => undefined);
      }, 250);
      scheduledTaskGitRefresh.current.set(taskId, timer);
    },
    [invalidateTaskGit, refreshInvalidatedTaskGit],
  );

  const scheduleProjectGitRefresh = useCallback((projectId: string) => {
    const pending = scheduledProjectGitRefresh.current.get(projectId);
    if (pending !== undefined) window.clearTimeout(pending);
    const timer = window.setTimeout(() => {
      scheduledProjectGitRefresh.current.delete(projectId);
      void bridge
        .loadProjectGit(projectId)
        .then((git) =>
          setSnapshot((current) =>
            current.activeProjectId === projectId && !current.activeTaskId
              ? { ...current, git }
              : current,
          ),
        )
        .catch(() => undefined);
    }, 250);
    scheduledProjectGitRefresh.current.set(projectId, timer);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth)),
      150,
    );
    return () => window.clearTimeout(timeout);
  }, [sidebarWidth]);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => window.localStorage.setItem(RIGHT_RAIL_WIDTH_STORAGE_KEY, String(rightRailWidth)),
      150,
    );
    return () => window.clearTimeout(timeout);
  }, [rightRailWidth]);

  const loadPersistedTaskProjection = useCallback(async (taskId: string) => {
    const loaded = await bridge.loadTaskProjection(taskId, { skipRuntimeCheck: true });
    const hydrate = loaded.hydrate ?? {
      items: [],
      plan: [],
      planTruncated: false,
      approvals: [],
      firstSeen: {},
      hasMoreOlder: false,
    };
    return hydrateRuntimeProjectionState(taskId, hydrate, loaded.watermarkSeq, loaded.resetSeq);
  }, []);

  const reconcileTaskProjection = useCallback(
    async (
      taskId: string,
      preserveBufferedEvents = false,
      cachedState?: RuntimeProjectionState,
    ) => {
      const generation = ++projectionGeneration.current;
      projectionReady.current = false;
      projectionTaskId.current = taskId;
      setReadyProjectionTaskId("");
      if (!preserveBufferedEvents) projectionBuffer.current = [];
      setRuntimeState(cachedState ?? null);
      let displayState = cachedState;
      try {
        if (!displayState) {
          displayState = await loadPersistedTaskProjection(taskId);
          if (generation !== projectionGeneration.current) return;
          taskProjectionCache.current.set(taskId, displayState);
          setRuntimeState(displayState);
        }
        const loaded = await bridge.loadTaskProjection(taskId, {
          knownWatermark: displayState.lastSeq,
          knownResetSeq: displayState.resetSeq,
        });
        let next: RuntimeProjectionState;
        if (loaded.cacheMatched) {
          // Watermark + reset epoch match: keep cached display state. Still
          // merge buffered live events and apply runtimeLive settlement below.
          next = displayState;
        } else {
          const hydrate = loaded.hydrate ?? {
            items: [],
            plan: [],
            planTruncated: false,
            approvals: [],
            firstSeen: {},
            hasMoreOlder: false,
          };
          next = hydrateRuntimeProjectionState(
            taskId,
            hydrate,
            loaded.watermarkSeq,
            loaded.resetSeq,
          );
        }
        let runtimeLive = loaded.runtimeLive;
        const bufferedEvents = projectionBuffer.current
          .filter((candidate) => candidate.taskId === taskId && candidate.seq > loaded.watermarkSeq)
          .sort((a, b) => a.seq - b.seq);
        for (const event of bufferedEvents) {
          if (
            (event.projection.kind === "connectionChanged" &&
              event.projection.state !== "disconnected") ||
            (event.projection.kind === "turnChanged" &&
              (event.projection.turn.status === "pending" ||
                event.projection.turn.status === "inProgress"))
          ) {
            runtimeLive = true;
          }
        }
        next = applyRuntimeProjectionBatch(next, bufferedEvents);
        if (generation !== projectionGeneration.current) return;
        projectionBuffer.current = [];
        projectionReady.current = true;
        setReadyProjectionTaskId(taskId);
        if (
          !runtimeLive &&
          (next.connection.state === "reconciling" ||
            next.connection.state === "connecting" ||
            next.connection.state === "connected")
        ) {
          // Persisted connection state cannot prove that its provider process
          // survived. The native snapshot command checks the task-owned
          // runtime; a newer buffered lifecycle event can also prove liveness.
          next = {
            ...next,
            connection: { state: "disconnected" },
          };
        }
        if (
          !runtimeLive &&
          next.turn &&
          (next.turn.status === "inProgress" || next.turn.status === "pending")
        ) {
          // Startup normally settles this before the renderer hydrates. Keep
          // a visual fallback for old stores without making selection mutate
          // the durable task state.
          next = {
            ...next,
            turn: {
              ...next.turn,
              status: "interrupted",
              stopRequested: true,
              completedAt: next.turn.completedAt ?? new Date().toISOString(),
            },
          };
        }
        next = clearVerifiedRuntimeFailures(
          next,
          taskRuntimeByIdRef.current.get(taskId),
          verifiedRuntimesRef.current,
        );
        taskProjectionCache.current.set(taskId, next);
        setRuntimeState(next);
      } catch (error) {
        if (generation !== projectionGeneration.current) return;
        projectionReady.current = false;
        setReadyProjectionTaskId("");
        const reason = error instanceof Error ? error.message : "Could not restore task events";
        const failed = {
          ...(displayState ?? createRuntimeProjectionState(taskId)),
          connection: {
            state: "disconnected",
            reason,
          },
        } satisfies RuntimeProjectionState;
        taskProjectionCache.current.set(taskId, failed);
        setRuntimeState(failed);
        setOperationError(reason);
      }
    },
    [loadPersistedTaskProjection],
  );

  const loadOlderInFlightRef = useRef<string | null>(null);
  const loadOlderTaskProjection = useCallback(async (taskId: string) => {
    const current = taskProjectionCache.current.get(taskId);
    if (!current?.hasMoreOlder || current.oldestLoadedSeq === undefined) return;
    if (projectionTaskId.current !== taskId || !projectionReady.current) return;
    const beforeSeq = current.oldestLoadedSeq;
    const flightKey = `${taskId}:${beforeSeq}`;
    if (loadOlderInFlightRef.current === flightKey) return;
    loadOlderInFlightRef.current = flightKey;
    try {
      const loaded = await bridge.loadTaskProjection(taskId, { beforeSeq });
      if (projectionTaskId.current !== taskId || !projectionReady.current) return;
      const hydrate = loaded.hydrate;
      if (!hydrate) return;
      setRuntimeState((prev) => {
        if (!prev || prev.taskId !== taskId) return prev;
        const next = mergeOlderProjectionHydrate(prev, hydrate);
        taskProjectionCache.current.set(taskId, next);
        return next;
      });
    } catch {
      // Degraded: keep the already-loaded window; user can scroll again later.
    } finally {
      if (loadOlderInFlightRef.current === flightKey) {
        loadOlderInFlightRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    let projectionFrame: number | undefined;
    const scheduledGitRefreshes = scheduledTaskGitRefresh.current;
    const scheduledProjectRefreshes = scheduledProjectGitRefresh.current;
    const invalidatedGitPaths = taskGitInvalidatedPaths.current;
    const frameEvents: RuntimeProjectionEvent[] = [];
    const applyLiveProjectionBatch = (events: RuntimeProjectionEvent[]) => {
      const taskId = projectionTaskId.current;
      const applicable = events.filter((event) => event.taskId === taskId);
      if (applicable.length === 0) return;
      setRuntimeState((current) => {
        let next = current ?? createRuntimeProjectionState(taskId);
        let pending: RuntimeProjectionEvent[] = [];
        const flushPending = () => {
          next = applyRuntimeProjectionBatch(next, pending);
          pending = [];
        };
        for (const event of applicable) {
          if (
            event.projection.kind !== "connectionChanged" &&
            event.projection.kind !== "turnError"
          ) {
            pending.push(event);
            continue;
          }
          flushPending();
          const verified = recordRuntimeVerificationEvent(event, verifiedRuntimesRef.current);
          next = applyRuntimeProjection(next, event);
          if (verified) {
            next = clearVerifiedRuntimeFailures(
              next,
              runtimeIdForProjectionProvider(event.provider),
              verifiedRuntimesRef.current,
            );
          }
        }
        flushPending();
        taskProjectionCache.current.set(taskId, next);
        return next;
      });
    };
    const flushFrameEvents = () => {
      projectionFrame = undefined;
      applyLiveProjectionBatch(frameEvents.splice(0));
    };
    void (async () => {
      try {
        if (nativeHost) {
          unlisten = await bridge.subscribeRuntimeProjections((event) => {
            if (
              (event.projection.kind === "connectionChanged" &&
                event.projection.state !== "reconciling" &&
                event.projection.state !== "connecting") ||
              event.projection.kind === "turnError" ||
              (event.projection.kind === "turnChanged" &&
                event.projection.turn.status !== "pending" &&
                event.projection.turn.status !== "inProgress")
            ) {
              setFreshTaskIds((current) => {
                if (!current.has(event.taskId)) return current;
                const next = new Set(current);
                next.delete(event.taskId);
                return next;
              });
            }
            if (
              event.projection.kind === "itemChanged" &&
              event.projection.item.kind === "fileChange"
            ) {
              const paths = event.projection.item.fileChanges?.map((change) => change.path) ?? [];
              if (event.taskId === activeTaskIdRef.current) {
                scheduleTaskGitRefresh(event.taskId, paths);
              } else {
                invalidateTaskGit(event.taskId, paths.length > 0 ? paths : undefined);
              }
            }
            if (!projectionReady.current) {
              recordRuntimeVerificationEvent(event, verifiedRuntimesRef.current);
            }
            // The turn now settles on a non-retryable error, which frees the
            // queue to drain — straight into whatever wall just stopped the
            // turn, since a usage limit outlives the turn that hit it. Hold the
            // queue instead and leave the messages for the user to send once
            // the limit resets; the queue's own send-now control overrides this.
            if (event.projection.kind === "turnError" && !event.projection.retryable) {
              queuePausedTaskIdsRef.current.add(event.taskId);
            }
            const approval =
              event.projection.kind === "approvalChanged" ? event.projection.approval : undefined;
            const draftPermission = composerDraftStore.read({
              kind: "task",
              taskId: event.taskId,
            })?.permission;
            const taskPermission =
              taskPermissionsRef.current[event.taskId] ??
              (isTaskPermission(draftPermission) ? draftPermission : undefined) ??
              settingsDefaultPermission(localSettingsRef.current);
            const routineFullAccessApproval = Boolean(
              approval &&
              taskPermission === "full-access" &&
              approval.approvalKind !== "planReview" &&
              approval.approvalKind !== "question",
            );
            if (
              approval?.state === "pending" &&
              routineFullAccessApproval &&
              event.taskId !== activeTaskIdRef.current
            ) {
              const approvalKey = autoApprovalKey(event.taskId, approval.id);
              if (
                !autoApprovedIdsRef.current.has(approvalKey) &&
                !autoApprovalFailuresRef.current.has(approvalKey)
              ) {
                autoApprovedIdsRef.current.add(approvalKey);
                void bridge
                  .respondToApproval(event.taskId, approval.id, "acceptForSession")
                  .catch((error: unknown) => {
                    autoApprovedIdsRef.current.delete(approvalKey);
                    setAutoApprovalFailures((current) => new Set(current).add(approvalKey));
                    setComposerError({
                      id: `auto-approval-${approval.id}`,
                      taskId: event.taskId,
                      message:
                        error instanceof Error
                          ? error.message
                          : "Could not automatically approve that action",
                    });
                    setSnapshot((current) => ({
                      ...current,
                      tasks: current.tasks.map((task) =>
                        task.id === event.taskId
                          ? { ...task, status: "waiting", updatedAt: event.occurredAt }
                          : task,
                      ),
                    }));
                  });
              }
            }
            const persistedActivity =
              approval?.state === "pending" && routineFullAccessApproval
                ? { status: "running" as const, updatedAt: event.occurredAt }
                : taskActivityUpdate(event, false);
            if (persistedActivity) {
              setSnapshot((current) => {
                const taskIndex = current.tasks.findIndex((task) => task.id === event.taskId);
                if (taskIndex < 0) return current;
                const liveActivity = taskActivityUpdate(
                  event,
                  current.activeTaskId === event.taskId,
                );
                if (!liveActivity) return current;
                const tasks = [...current.tasks];
                tasks[taskIndex] = { ...tasks[taskIndex], ...liveActivity };
                return { ...current, tasks };
              });
              if (
                persistedActivity.status === "completed" ||
                persistedActivity.status === "failed" ||
                persistedActivity.status === "stopped"
              ) {
                void bridge
                  .setTaskStatus?.(event.taskId, persistedActivity.status)
                  .catch(() => undefined);
                scheduleTaskGitRefresh(event.taskId, []);
              }
            }
            if (event.taskId !== projectionTaskId.current) {
              const cached = taskProjectionCache.current.get(event.taskId);
              if (cached) {
                taskProjectionCache.current.set(
                  event.taskId,
                  applyRuntimeProjection(cached, event),
                );
              }
              return;
            }
            if (!projectionReady.current) {
              projectionBuffer.current.push(event);
              return;
            }
            if (isFrameBatchableRuntimeProjection(event)) {
              // Preserve and apply every normalized projection in sequence,
              // but commit text-only presentation updates once per frame.
              // Tool state, approvals, errors, stop/completion and connection
              // events stay immediate below.
              frameEvents.push(event);
              projectionFrame ??= window.requestAnimationFrame(flushFrameEvents);
              return;
            }
            if (projectionFrame !== undefined) {
              window.cancelAnimationFrame(projectionFrame);
              projectionFrame = undefined;
            }
            applyLiveProjectionBatch([...frameEvents.splice(0), event]);
            if (event.projection.kind === "projectionReset") {
              void reconcileTaskProjection(event.taskId);
            }
          });
          if (!active) {
            unlisten();
            return;
          }
        }
        const [loaded, persistedSettings] = await Promise.all([
          bridge.loadWorkspace(),
          Promise.resolve(bridge.listSettings?.()).catch(() => []),
        ]);
        const deepLinkTaskId = initialTaskId();
        const deepLinkTask = deepLinkTaskId
          ? loaded.tasks.find((task) => task.id === deepLinkTaskId)
          : undefined;
        if (deepLinkTask) {
          loaded.activeTaskId = deepLinkTask.id;
          loaded.activeProjectId = deepLinkTask.projectId;
        }
        const persisted = persistedSettings ?? [];
        if (!active) return;
        // Composer defaults (runtime, effort, permission, Enter behavior) are
        // committed before the workspace renders so its pickers mount with
        // the persisted values instead of racing an async settings load.
        const settingsMap: Record<string, unknown> = {};
        for (const setting of persisted) {
          settingsMap[
            setting.key.startsWith("settings.")
              ? setting.key.slice("settings.".length)
              : setting.key
          ] = setting.value;
        }
        setLocalSettings(settingsMap);
        if (nativeHost) {
          const theme = persisted.find((setting) => setting.key === "appearance.theme")?.value;
          if (theme && typeof theme === "object") {
            setPreferences(
              setThemePreferences(normalizeThemePreferences(theme), {
                persist: false,
              }),
            );
          }
        }
        composerDraftStore.hydrate(loaded.composerDrafts);
        const sidebarMeta = readProjectSidebarMeta(settingsMap[PROJECT_SIDEBAR_META_KEY]);
        setSnapshot({
          ...loaded,
          projects: applyProjectSidebarMeta(loaded.projects, sidebarMeta),
        });
        taskRuntimeByIdRef.current = new Map(
          loaded.tasks.map((task) => [task.id, task.runtime] as const),
        );
        setActiveFileKey(
          (key) => key || (loaded.git.files[0] ? diffFileKey(loaded.git.files[0]) : ""),
        );
        let bootstrapRuntime: RuntimeProjectionState | undefined;
        if (nativeHost && loaded.activeTaskId) {
          const taskId = loaded.activeTaskId;
          activeTaskIdRef.current = taskId;
          projectionTaskId.current = taskId;
          projectionReady.current = false;
          setReadyProjectionTaskId("");
          try {
            bootstrapRuntime = await loadPersistedTaskProjection(taskId);
            if (!active) return;
            taskProjectionCache.current.set(taskId, bootstrapRuntime);
            setRuntimeState(bootstrapRuntime);
          } catch {
            // The authoritative reconciliation below retries and surfaces a
            // durable error without replacing any transcript we already have.
          }
        }
        // First useful paint includes the durable active transcript. Provider
        // discovery and runtime ownership checks continue independently.
        setWorkspaceLoading(false);
        // Badge count only — do not hydrate archived chat rows into the hot set.
        void bridge
          .listArchivedTasks({ limit: 1 })
          .then((page) => {
            if (active) setArchivedTotal(page.total);
          })
          .catch(() => undefined);
        if (nativeHost) {
          void Promise.resolve(bridge.probeRuntimes?.())
            .then((runtimes) => {
              if (!active || !runtimes) return;
              setSnapshot((current) => ({ ...current, runtimes }));
              applyVerifiedRuntimeHealth(runtimes, loaded.tasks);
              // Warm every connected runtime's catalog now so switching
              // runtime in the composer paints from cache, not a CLI probe.
              bridge.prefetchModelCatalogs?.(runtimes);
            })
            .catch(() => undefined);
        }
        if (nativeHost && loaded.activeTaskId) {
          void reconcileTaskProjection(loaded.activeTaskId, true, bootstrapRuntime);
          const taskId = loaded.activeTaskId;
          activeTaskIdRef.current = taskId;
          void refreshInvalidatedTaskGit(taskId)
            .catch(() => undefined)
            .finally(() => {
              if (active) setGitLoading(false);
            });
        } else {
          projectionReady.current = true;
          setReadyProjectionTaskId(loaded.activeTaskId ?? "");
        }
      } catch (error: unknown) {
        if (!active) return;
        setOperationError(error instanceof Error ? error.message : "Could not load the workspace");
      } finally {
        if (active) {
          setWorkspaceLoading(false);
          if (!nativeHost) setGitLoading(false);
        }
      }
    })();
    return () => {
      active = false;
      for (const timer of scheduledGitRefreshes.values()) {
        window.clearTimeout(timer);
      }
      scheduledGitRefreshes.clear();
      for (const timer of scheduledProjectRefreshes.values()) {
        window.clearTimeout(timer);
      }
      scheduledProjectRefreshes.clear();
      invalidatedGitPaths.clear();
      if (projectionFrame !== undefined) window.cancelAnimationFrame(projectionFrame);
      unlisten?.();
    };
  }, [
    applyVerifiedRuntimeHealth,
    composerDraftStore,
    nativeHost,
    loadPersistedTaskProjection,
    reconcileTaskProjection,
    invalidateTaskGit,
    refreshInvalidatedTaskGit,
    scheduleTaskGitRefresh,
  ]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void bridge.persistSession(snapshot), 300);
    return () => window.clearTimeout(timeout);
  }, [snapshot]);

  // Delegated-subagent lineage for the active task. Refreshed on task switch
  // and whenever the native broker reports a delegation change; the events
  // are cheap notifications, so a full re-list keeps the panel authoritative.
  useEffect(() => {
    activeTaskIdRef.current = snapshot.activeTaskId;
    activeProjectIdRef.current = snapshot.activeProjectId;
    delegationLineageTaskIdsRef.current = new Set(
      snapshot.activeTaskId ? [snapshot.activeTaskId] : [],
    );
  }, [snapshot.activeProjectId, snapshot.activeTaskId]);
  const refreshDelegations = useCallback(
    async (taskId: string | undefined) => {
      if (!nativeHost || !taskId) {
        return;
      }
      try {
        // Walk the hidden child-task lineage as well as the active task's
        // direct delegations. The broker remains one-level in v1, but this
        // projection is recursive so descendant-capable runtimes require no
        // UI rewrite and imported lineage remains navigable.
        const rows: DelegationView[] = [];
        const pending = [taskId];
        const visitedTasks = new Set<string>();
        if (activeTaskIdRef.current === taskId) {
          delegationLineageTaskIdsRef.current = visitedTasks;
        }
        while (pending.length > 0 && visitedTasks.size < 64) {
          const parentTaskId = pending.shift();
          if (!parentTaskId || visitedTasks.has(parentTaskId)) continue;
          visitedTasks.add(parentTaskId);
          // Optional-chained: App tests stub the bridge with partial mocks.
          const children = (await bridge.listDelegations?.(parentTaskId)) ?? [];
          rows.push(...children);
          for (const child of children) {
            if (child.childTaskId && !visitedTasks.has(child.childTaskId)) {
              pending.push(child.childTaskId);
            }
          }
        }
        if (activeTaskIdRef.current === taskId) setDelegations(rows);
      } catch {
        if (activeTaskIdRef.current === taskId) setDelegations([]);
      }
    },
    [nativeHost],
  );
  const requestActiveDelegations = useCallback(() => {
    void refreshDelegations(activeTaskIdRef.current);
  }, [refreshDelegations]);
  useEffect(() => {
    // Delegation refresh is an external broker read; its completion updates
    // the rail projection asynchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshDelegations(snapshot.activeTaskId);
  }, [snapshot.activeTaskId, refreshDelegations]);

  // Header quota pill. Providers push rolling rate-limit updates into the
  // native store; a per-task-switch read keeps the pill fresh enough without
  // polling.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        // Optional-chained: App tests stub the bridge with partial mocks.
        const summary = await bridge.getUsageSummary?.();
        if (!active || !summary) return;
        const next: Record<string, SubscriptionQuota> = {};
        for (const row of summary.providers) {
          if (row.subscription) next[row.provider] = row.subscription;
        }
        setProviderQuota(next);
      } catch {
        // Quota stays unknown; the pill renders tokens only.
      }
    })();
    return () => {
      active = false;
    };
  }, [snapshot.activeTaskId]);
  useEffect(() => {
    if (!nativeHost) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await bridge.subscribeDelegationUpdates?.((parentTaskId) => {
        if (active && delegationLineageTaskIdsRef.current.has(parentTaskId)) {
          void refreshDelegations(activeTaskIdRef.current);
        }
      });
      if (!active) unlisten?.();
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, [nativeHost, refreshDelegations]);

  useEffect(() => {
    if (!nativeHost) return;
    let active = true;
    let unlisten: (() => void) | undefined;

    const dispatchAutomation = async (dispatch: AutomationDispatch) => {
      if (!active || automationDispatchingRef.current.has(dispatch.run.id)) return;
      automationDispatchingRef.current.add(dispatch.run.id);
      let dispatchRef: string | undefined;
      let dispatchError: string | undefined;
      try {
        const { automation } = dispatch;
        if (automation.target.kind === "delegation") {
          await bridge.sendDelegationMessage(
            automation.target.delegationId,
            automation.prompt,
            automation.route,
          );
          dispatchRef = `delegation:${automation.target.delegationId}`;
        } else {
          const prompt = automationTurnPrompt(automation);
          const { fallbacks, tools, ...primary } = automation.route;
          const routes = [
            primary,
            ...(fallbacks ?? []).map((fallback) => ({ ...primary, ...fallback })),
          ];
          let lastError: unknown;
          for (const route of routes) {
            try {
              await bridge.sendTurn({
                taskId: automation.taskId,
                prompt,
                ...route,
                ...(tools ? { toolScope: tools } : {}),
              });
              dispatchRef = `task:${automation.taskId}`;
              break;
            } catch (error) {
              const message = formatBridgeError(error, "The scheduled task could not start");
              const busy = /turn.active|already (running|starting)|turn-active/i.test(message);
              if (busy) {
                const queued = await bridge.enqueueMessage({
                  taskId: automation.taskId,
                  prompt,
                  attachments: [],
                  ...primary,
                });
                dispatchRef = `queue:${queued.id}`;
                break;
              }
              lastError = error;
            }
          }
          if (!dispatchRef) throw lastError ?? new Error("No scheduled runtime was available");
        }
      } catch (error) {
        dispatchError = formatBridgeError(error, "The scheduled task could not be dispatched");
      }
      await bridge
        .finishAutomationRun(dispatch.run.id, {
          dispatchRef,
          error: dispatchError,
        })
        .catch(() => undefined);
      automationDispatchingRef.current.delete(dispatch.run.id);
    };

    void (async () => {
      unlisten = await bridge.subscribeAutomationDue((dispatch) => {
        void dispatchAutomation(dispatch);
      });
      if (!active) {
        unlisten?.();
        return;
      }
      const pending = await bridge.pendingAutomationDispatches();
      for (const dispatch of pending) void dispatchAutomation(dispatch);
    })().catch(() => undefined);

    return () => {
      active = false;
      unlisten?.();
    };
  }, [nativeHost]);

  const activeTask =
    snapshot.tasks.find((task) => task.id === snapshot.activeTaskId) ??
    archivedTasks.find((task) => task.id === snapshot.activeTaskId);
  const refreshAutomationTimeline = useCallback(
    async (taskId = activeTaskIdRef.current) => {
      if (!nativeHost || !taskId) {
        setAutomationTimeline((current) => (current.length > 0 ? [] : current));
        return;
      }
      const timeline = await bridge.automationTimeline(taskId);
      if (activeTaskIdRef.current === taskId) {
        setAutomationTimeline((current) =>
          sameAutomationTimeline(current, timeline) ? current : timeline,
        );
      }
    },
    [nativeHost],
  );
  useEffect(() => {
    void refreshAutomationTimeline(activeTask?.id).catch(() =>
      setAutomationTimeline((current) => (current.length > 0 ? [] : current)),
    );
  }, [activeTask?.id, refreshAutomationTimeline]);
  useEffect(() => {
    if (!nativeHost) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void bridge
      .subscribeAutomationChanges((change) => {
        if (active && change.taskId === activeTaskIdRef.current) {
          void refreshAutomationTimeline(change.taskId);
        }
      })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [nativeHost, refreshAutomationTimeline]);

  const cancelScheduledTask = useCallback(
    async (automationId: string) => {
      setOperationError("");
      try {
        await bridge.cancelAutomation(automationId);
        await refreshAutomationTimeline();
        setOperationStatus("Scheduled task cancelled");
      } catch (error) {
        setOperationError(formatBridgeError(error, "The scheduled task could not be cancelled"));
      }
    },
    [refreshAutomationTimeline],
  );
  const activeProjectionUnavailable =
    nativeHost && Boolean(activeTask) && readyProjectionTaskId !== activeTask?.id;
  const rootTasks = useMemo(
    () =>
      snapshot.tasks.filter(
        (task) => !task.parentId && !task.archived && !isPendingGeneralChat(task),
      ),
    [snapshot.tasks],
  );
  useEffect(() => {
    pendingGeneralChatRef.current = snapshot.tasks.find(isPendingGeneralChat);
  }, [snapshot.tasks]);
  const sidebarTasks = useMemo(
    () => [...rootTasks, ...archivedTasks.filter((task) => !task.parentId)],
    [archivedTasks, rootTasks],
  );
  const activeProject =
    activeTask?.kind === "chat"
      ? undefined
      : (snapshot.projects.find((project) => project.id === snapshot.activeProjectId) ??
        snapshot.projects.find((project) => project.id === activeTask?.projectId) ??
        snapshot.projects[0]);
  const activeCheckoutPath = activeTask?.worktree ?? activeProject?.path;
  useEffect(() => {
    if (!nativeHost || !activeCheckoutPath) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void bridge
      .subscribeWorkingTreeChanges(activeCheckoutPath, () => {
        if (!active) return;
        const taskId = activeTaskIdRef.current;
        if (taskId) return scheduleTaskGitRefresh(taskId, []);
        const projectId = activeProjectIdRef.current;
        if (projectId) scheduleProjectGitRefresh(projectId);
      })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, [activeCheckoutPath, nativeHost, scheduleProjectGitRefresh, scheduleTaskGitRefresh]);
  const deleteProjectTarget = deleteProjectId
    ? snapshot.projects.find((project) => project.id === deleteProjectId)
    : undefined;
  const deleteTaskTarget = deleteTaskId
    ? (snapshot.tasks.find((task) => task.id === deleteTaskId) ??
      archivedTasks.find((task) => task.id === deleteTaskId))
    : undefined;
  const deleteArchivedChatsTarget = deleteArchivedChatsProjectId
    ? snapshot.projects.find((project) => project.id === deleteArchivedChatsProjectId)
    : undefined;
  const deleteArchivedChatsCount = deleteArchivedChatsProjectId
    ? archivedTasks.filter((task) => task.projectId === deleteArchivedChatsProjectId).length
    : 0;
  const configuredDefaultRuntime = localSettings["models.defaultRuntime"];
  const favoriteRuntime =
    typeof configuredDefaultRuntime === "string" &&
    snapshot.runtimes.some((runtime) => runtime.id === configuredDefaultRuntime)
      ? (configuredDefaultRuntime as RuntimeId)
      : undefined;
  const storedLastRuntime = localSettings["models.lastRuntime"];
  const lastRuntime =
    typeof storedLastRuntime === "string" &&
    snapshot.runtimes.some((runtime) => runtime.id === storedLastRuntime)
      ? (storedLastRuntime as RuntimeId)
      : snapshot.tasks.find((task) =>
          snapshot.runtimes.some((runtime) => runtime.id === task.runtime),
        )?.runtime;
  const settingsDefaultRuntime =
    favoriteRuntime ??
    lastRuntime ??
    snapshot.runtimes.find((runtime) => runtime.status !== "not_installed")?.id ??
    snapshot.runtimes[0]?.id ??
    "codex";
  const storedRuntimeDefaults = normalizeRuntimeRouteDefaults(
    localSettings[RUNTIME_ROUTE_DEFAULTS_SETTING],
  );
  const settingsDefaultRoute = readRuntimeRouteDefault(localSettings, settingsDefaultRuntime);
  const settingsDefaultModel =
    settingsDefaultRoute.model ??
    snapshot.runtimes
      .find((runtime) => runtime.id === settingsDefaultRuntime)
      ?.models.find((model) => model !== "Provider default") ??
    "Provider default";
  const composerRuntimeDefaults = {
    ...storedRuntimeDefaults,
    [settingsDefaultRuntime]: {
      model: settingsDefaultModel,
      ...(settingsDefaultRoute.effort ? { effort: settingsDefaultRoute.effort } : {}),
    },
  };
  useEffect(() => {
    if (!activeProject || activeTask) return;
    let active = true;
    void bridge
      .loadProjectGit(activeProject.id)
      .then((git) => {
        if (!active) return;
        setSnapshot((current) =>
          current.activeProjectId === activeProject.id && !current.activeTaskId
            ? { ...current, git }
            : current,
        );
      })
      .catch((error: unknown) => {
        if (active) {
          setOperationError(error instanceof Error ? error.message : "Could not load Git state");
        }
      })
      .finally(() => {
        if (active) setGitLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeProject, activeTask]);
  const activeDraftOwner: ComposerDraftOwner | undefined = activeProject
    ? activeTask
      ? { kind: "task", taskId: activeTask.id }
      : { kind: "newChat", projectId: activeProject.id }
    : undefined;
  const activeComposerDraft = activeDraftOwner
    ? composerDraftStore.read(activeDraftOwner)
    : undefined;
  const activeTaskPermission: TaskPermission =
    activeTask?.kind === "chat"
      ? "read-only"
      : activeTask
        ? (taskPermissions[activeTask.id] ??
          activeComposerDraft?.permission ??
          settingsDefaultPermission(localSettings))
        : settingsDefaultPermission(localSettings);
  const activeComposerDraftWithPermission =
    activeComposerDraft && activeTask && taskPermissions[activeTask.id]
      ? { ...activeComposerDraft, permission: taskPermissions[activeTask.id] }
      : activeComposerDraft;
  const autoApproveActive = Boolean(activeTask && activeTaskPermission === "full-access");
  useEffect(() => {
    if (!nativeHost || !activeTask) return;
    // Grok's model and effort are process-launch options. Starting it from an
    // effect can race the first prompt's task promotion and replace the ACP
    // transport before session/new. Admit Grok only from the send path.
    if (activeTask.runtime !== "kimi") return;
    void bridge
      .prepareAcpRuntime?.({
        taskId: activeTask.id,
        runtime: activeTask.runtime,
        model: activeTask.model,
        effort: activeTask.effort,
        permission: activeTaskPermission,
        delegation: activeTask.kind === "chat" ? "off" : "manual",
      })
      .catch(() => undefined);
  }, [
    nativeHost,
    activeTask?.id,
    activeTask?.runtime,
    activeTask?.model,
    activeTask?.effort,
    activeTask?.kind,
    activeTaskPermission,
  ]);
  const persistComposerDraft = (draft: ComposerDraft) => {
    if (typeof bridge.saveComposerDraft !== "function") return;
    pendingDraftWrites.current.set(draftOwnerKey(draft.owner), draft);
    if (draftWriterRunning.current) return;
    draftWriterRunning.current = true;
    queueMicrotask(() => {
      void (async () => {
        try {
          while (pendingDraftWrites.current.size > 0) {
            const [key, next] = pendingDraftWrites.current.entries().next().value as [
              string,
              ComposerDraft,
            ];
            pendingDraftWrites.current.delete(key);
            try {
              await bridge.saveComposerDraft(next);
            } catch {
              if (!draftPersistenceFailureShown.current) {
                draftPersistenceFailureShown.current = true;
                setOperationError(
                  "Draft recovery is temporarily unavailable. Your text remains in this open window.",
                );
              }
            }
          }
        } finally {
          draftWriterRunning.current = false;
        }
      })();
    });
  };
  const updateActiveComposerDraft = (value: ComposerDraftValue): number => {
    if (!activeDraftOwner) return 0;
    const draft = composerDraftStore.update(activeDraftOwner, value);
    persistComposerDraft(draft);
    return draft.revision;
  };
  const activeFile =
    snapshot.git.files.find((file) => diffFileKey(file) === activeFileKey) ?? snapshot.git.files[0];
  const activeProjectIdForFiles = activeProject?.id;
  const projectFileOpeners =
    projectFileOpenerState.projectId === activeProjectIdForFiles
      ? projectFileOpenerState.openers
      : [];
  const contextFilePaths = useMemo(() => projectFiles.map((file) => file.path), [projectFiles]);
  useEffect(() => {
    activeProjectForFilesRef.current = activeProjectIdForFiles;
  }, [activeProjectIdForFiles]);

  useEffect(() => {
    let active = true;
    if (!nativeHost || !activeProjectIdForFiles) return () => undefined;
    void bridge
      .listProjectFileOpeners(activeProjectIdForFiles)
      .then((openers) => {
        if (active)
          setProjectFileOpenerState({
            projectId: activeProjectIdForFiles,
            openers,
          });
      })
      .catch(() => {
        // External apps are an optional native capability. Missing launchers
        // stay absent instead of turning project navigation into an error.
        if (active)
          setProjectFileOpenerState({
            projectId: activeProjectIdForFiles,
            openers: [],
          });
      });
    return () => {
      active = false;
    };
  }, [activeProjectIdForFiles, nativeHost]);

  // A recursive project scan is useful only to the Files surface. Keep it out
  // of project/chat navigation, and retain the bounded result for warm opens.
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      if (!activeProjectIdForFiles) {
        setProjectFiles([]);
        setProjectFilesState("unavailable");
        return;
      }
      const cached = projectFilesCache.current.get(activeProjectIdForFiles);
      setProjectFiles(cached ?? []);
      setProjectFilesState(cached ? "ready" : "unavailable");
    });
    return () => {
      active = false;
    };
  }, [activeProjectIdForFiles]);

  const requestProjectFiles = useCallback(() => {
    const projectId = activeProjectIdForFiles;
    if (!projectId || projectFilesCache.current.has(projectId)) return;
    setProjectFilesState("loading");
    void bridge
      .listProjectFiles(projectId)
      .then((files) => {
        projectFilesCache.current.set(projectId, files);
        if (activeProjectForFilesRef.current !== projectId) return;
        setProjectFiles(files);
        setProjectFilesState("ready");
      })
      .catch((error: unknown) => {
        setProjectFilesState("unavailable");
        setOperationError(
          error instanceof Error ? error.message : "Could not read files for this project",
        );
      });
  }, [activeProjectIdForFiles]);

  // The rail follows the open project (files, usage) even before the first
  // chat exists; only a task switch in flight hides it to avoid stale state.
  const showRightRail = Boolean(rightRailOpen && activeProject);
  const selectedDelegation = delegations.find(
    (delegation) => delegation.id === selectedDelegationId && delegation.childTaskId,
  );
  const subagentOpen = workPane.state.open;
  const activeFileTabPath = workPane.active?.kind === "file" ? workPane.active.path : "";
  useWorkPaneHeaderAlignment(appRootRef, subagentPaneRef, subagentOpen, workPane.state.width);
  const titleContext =
    screen === "settings"
      ? undefined
      : screen === "scheduled"
        ? "Scheduled"
        : screen === "setup"
          ? "Setup"
          : `${activeTask?.kind === "chat" ? "Chat" : (activeProject?.name ?? "Workspace")} · ${activeTask?.title ?? "New chat"}`;

  const setTheme = (patch: ThemePreferencePatch) => {
    setPreferences((current) => {
      const next = updateThemePreferences(current, patch);
      if (nativeHost) void bridge.setSetting("appearance.theme", next);
      return next;
    });
  };

  const resetTheme = () => {
    const next = resetThemePreferences();
    setPreferences(next);
    if (nativeHost) void bridge.setSetting("appearance.theme", next);
  };

  const refreshRuntimes = useCallback(async () => {
    const runtimes = await bridge.probeRuntimes({ force: true });
    setSnapshot((current) => ({ ...current, runtimes }));
    applyVerifiedRuntimeHealth(runtimes, snapshot.tasks);
    // A forced probe drops the catalog of any runtime whose version or auth
    // moved; re-warm so the picker stays instant instead of re-probing lazily.
    bridge.prefetchModelCatalogs?.(runtimes);
    return runtimes;
  }, [applyVerifiedRuntimeHealth, snapshot.tasks]);

  const openRuntimeAction = useCallback(
    (runtime: RuntimeId, kind: RuntimeActionRequest["kind"]) => {
      runtimeActionSequence.current += 1;
      setRuntimeActionRequest({
        id: runtimeActionSequence.current,
        runtime,
        kind,
      });
      setScreen("settings");
    },
    [],
  );

  const selectTask = (taskId: string) => {
    const targetTask =
      snapshot.tasks.find((task) => task.id === taskId) ??
      archivedTasks.find((task) => task.id === taskId);
    if (!targetTask || switchingTaskId === taskId) return;
    // Opening an archived chat keeps it out of the live sidebar list but needs
    // a snapshot row so projection/git hydration can key off activeTaskId.
    if (targetTask.archived && !snapshot.tasks.some((task) => task.id === taskId)) {
      setSnapshot((current) => ({
        ...current,
        tasks: [...current.tasks, targetTask],
      }));
    }
    setComposerError(null);
    if (taskId === snapshot.activeTaskId) {
      setScreen("workspace");
      return;
    }
    const generation = ++navigationGeneration.current;
    const restoredView =
      targetTask.kind !== "chat" && snapshot.centerViewByTask[taskId] === "review"
        ? "review"
        : "task";
    const empty = createEmptySnapshot();
    const cached = nativeHost ? undefined : snapshot.taskContexts[taskId];
    const cachedRuntime = nativeHost ? taskProjectionCache.current.get(taskId) : undefined;
    const activeTaskBeforeSwitch = snapshot.tasks.find((task) => task.id === snapshot.activeTaskId);
    const repositoryFor = (task: TaskSummary | undefined) =>
      task?.worktree ?? snapshot.projects.find((project) => project.id === task?.projectId)?.path;
    const activeRepository = repositoryFor(activeTaskBeforeSwitch);
    const targetRepository = repositoryFor(targetTask);
    const sharesActiveRepository =
      Boolean(activeRepository) && activeRepository === targetRepository;
    const taskCachedGit = nativeHost ? taskGitCache.current.get(taskId) : undefined;
    const cachedGit =
      taskCachedGit ?? (nativeHost && sharesActiveRepository ? snapshot.git : undefined);
    const gitRefreshedAt = taskGitRefreshedAt.current.get(taskId) ?? 0;
    const taskGitIsDirty = taskGitInvalidatedPaths.current.has(taskId);
    const refreshTaskGit =
      nativeHost &&
      targetTask.kind !== "chat" &&
      (taskGitIsDirty ||
        (!sharesActiveRepository &&
          (!taskCachedGit || Date.now() - gitRefreshedAt >= GIT_CACHE_TTL_MS)));
    // Cached conversations commit in the same frame. Authoritative transcript
    // storage still reconciles below; Git only refreshes when checkout identity
    // changes, and a stale cached checkout never gives way to a loading flash.
    setSwitchingTaskId(cachedRuntime ? "" : taskId);
    setGitLoading(refreshTaskGit && !cachedGit);
    if (nativeHost && cachedGit && !taskCachedGit) {
      taskGitCache.current.set(taskId, cachedGit);
      taskGitRefreshedAt.current.set(
        taskId,
        activeTaskBeforeSwitch
          ? (taskGitRefreshedAt.current.get(activeTaskBeforeSwitch.id) ?? Date.now())
          : Date.now(),
      );
    }
    activeTaskIdRef.current = taskId;
    setOperationError("");
    setRuntimeState(cachedRuntime ?? null);
    setCenterView(restoredView);
    const firstCachedFile = cachedGit?.files[0] ?? cached?.git.files[0];
    setActiveFileKey(firstCachedFile ? diffFileKey(firstCachedFile) : "");
    setSnapshot((current) => {
      const currentContext = current.activeTaskId
        ? {
            transcript: current.transcript,
            git: current.git,
            usage: current.usage,
            children: current.children,
          }
        : undefined;
      const contexts = currentContext
        ? { ...current.taskContexts, [current.activeTaskId]: currentContext }
        : current.taskContexts;
      const targetContext = nativeHost ? undefined : contexts[taskId];
      return {
        ...current,
        activeTaskId: taskId,
        activeProjectId: targetTask.projectId,
        lastTaskByProject:
          targetTask.kind === "chat"
            ? current.lastTaskByProject
            : { ...current.lastTaskByProject, [targetTask.projectId]: taskId },
        centerViewByTask: {
          ...current.centerViewByTask,
          ...(current.activeTaskId ? { [current.activeTaskId]: centerView } : {}),
        },
        taskContexts: contexts,
        transcript: targetContext?.transcript ?? [],
        git: cachedGit ?? targetContext?.git ?? empty.git,
        usage: targetContext?.usage ?? empty.usage,
        children: targetContext?.children ?? [],
        tasks: current.tasks.map((task) =>
          task.id === taskId ? { ...task, unread: false } : task,
        ),
      };
    });
    setScreen("workspace");
    if (window.matchMedia?.("(max-width: 760px)").matches) setSidebarCollapsed(true);

    if (nativeHost) {
      void reconcileTaskProjection(taskId, false, cachedRuntime).finally(() => {
        if (generation === navigationGeneration.current) setSwitchingTaskId("");
      });
      if (refreshTaskGit) {
        const pendingRefresh = scheduledTaskGitRefresh.current.get(taskId);
        if (pendingRefresh !== undefined) window.clearTimeout(pendingRefresh);
        scheduledTaskGitRefresh.current.delete(taskId);
        void refreshInvalidatedTaskGit(taskId)
          .catch((error: unknown) => {
            if (generation !== navigationGeneration.current) return;
            setOperationError(error instanceof Error ? error.message : "Could not load Git state");
          })
          .finally(() => {
            if (generation === navigationGeneration.current) setGitLoading(false);
          });
      }
    } else if (generation === navigationGeneration.current) {
      setSwitchingTaskId("");
    }
  };

  const selectProject = (projectId: string) => {
    const projectTasks = snapshot.tasks.filter(
      (task) => task.projectId === projectId && !task.archived,
    );
    const remembered = snapshot.lastTaskByProject[projectId];
    const target =
      projectTasks.find((task) => task.id === remembered) ??
      [...projectTasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    if (target) {
      void selectTask(target.id);
      return;
    }
    ++navigationGeneration.current;
    setGitLoading(nativeHost);
    activeTaskIdRef.current = undefined;
    setNewChatDraftKey((value) => value + 1);
    const empty = createEmptySnapshot();
    setRuntimeState(null);
    setCenterView("task");
    setActiveFileKey("");
    setSnapshot((current) => {
      const contexts = current.activeTaskId
        ? {
            ...current.taskContexts,
            [current.activeTaskId]: {
              transcript: current.transcript,
              git: current.git,
              usage: current.usage,
              children: current.children,
            },
          }
        : current.taskContexts;
      return {
        ...current,
        activeProjectId: projectId,
        activeTaskId: "",
        centerViewByTask: {
          ...current.centerViewByTask,
          ...(current.activeTaskId ? { [current.activeTaskId]: centerView } : {}),
        },
        taskContexts: contexts,
        transcript: [],
        git: empty.git,
        usage: empty.usage,
        children: [],
      };
    });
  };

  const mergeProject = (project: ProjectSummary) => {
    const sameProject = snapshot.activeProjectId === project.id;
    // Opening a different project needs a cold Git check. Same-project merges
    // (re-open / metadata refresh) must not blank the panel into a skeleton.
    if (!sameProject) setGitLoading(nativeHost);
    activeTaskIdRef.current = snapshot.tasks.find((task) => task.projectId === project.id)?.id;
    setSnapshot((current) => {
      const existing = current.projects.find((item) => item.id === project.id);
      const mergedProject: ProjectSummary = {
        ...project,
        pinned: existing?.pinned ?? project.pinned ?? false,
        archived: existing?.archived ?? project.archived ?? false,
      };
      const existingTasks = current.tasks.filter((task) => task.projectId === project.id);
      const stayingOnProject = current.activeProjectId === project.id;
      return {
        ...current,
        projects: [mergedProject, ...current.projects.filter((item) => item.id !== project.id)],
        activeProjectId: project.id,
        activeTaskId: existingTasks[0]?.id ?? "",
        lastTaskByProject: existingTasks[0]
          ? { ...current.lastTaskByProject, [project.id]: existingTasks[0].id }
          : current.lastTaskByProject,
        transcript: stayingOnProject ? current.transcript : [],
        git: stayingOnProject ? current.git : createEmptySnapshot().git,
        usage: stayingOnProject ? current.usage : createEmptySnapshot().usage,
        children: stayingOnProject ? current.children : [],
      };
    });
  };

  const openProject = async (): Promise<ProjectSummary | null> => {
    if (openingProject) return null;
    setOpeningProject(true);
    setOperationError("");
    setOperationStatus("");
    try {
      const project = await bridge.openProject();
      if (!project) return null;
      mergeProject(project);
      setCenterView("task");
      setScreen("workspace");
      setOperationStatus(`${project.name} is ready`);
      return project;
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Could not open that project");
      return null;
    } finally {
      setOpeningProject(false);
    }
  };

  const openExistingProject = async () => {
    const project = await openProject();
    if (project) setAddProjectOpen(false);
  };

  const createNewProject = async (name: string) => {
    if (openingProject) return;
    setOpeningProject(true);
    setCreateProjectError("");
    setOperationError("");
    setOperationStatus("");
    try {
      const project = await bridge.createProject(name);
      mergeProject(project);
      setCenterView("task");
      setScreen("workspace");
      setOperationStatus(`${project.name} is ready`);
      setAddProjectOpen(false);
    } catch (error) {
      setCreateProjectError(formatBridgeError(error, "Could not create the project"));
    } finally {
      setOpeningProject(false);
    }
  };

  const cloneProject = async (input: CloneProjectInput) => {
    if (openingProject) return;
    setOpeningProject(true);
    setCreateProjectError("");
    setOperationError("");
    setOperationStatus("");
    try {
      const project = await bridge.cloneProject(input);
      mergeProject(project);
      setCenterView("task");
      setScreen("workspace");
      setOperationStatus(`${project.name} cloned`);
      setAddProjectOpen(false);
    } catch (error) {
      setCreateProjectError(formatBridgeError(error, "Could not clone the repository"));
    } finally {
      setOpeningProject(false);
    }
  };

  const appendTask = (task: TaskSummary) => {
    const empty = createEmptySnapshot();
    const git =
      task.kind !== "chat" && snapshot.activeProjectId === task.projectId
        ? snapshot.git
        : empty.git;
    setFreshTaskIds((current) => new Set(current).add(task.id));
    activeTaskIdRef.current = task.id;
    if (task.kind !== "chat") {
      taskGitCache.current.set(task.id, git);
      taskGitRefreshedAt.current.set(task.id, Date.now());
    }
    setSnapshot((current) => ({
      ...current,
      activeTaskId: task.id,
      activeProjectId: task.projectId,
      lastTaskByProject:
        task.kind === "chat"
          ? current.lastTaskByProject
          : { ...current.lastTaskByProject, [task.projectId]: task.id },
      centerViewByTask: { ...current.centerViewByTask, [task.id]: "task" },
      tasks: [task, ...current.tasks.filter((item) => item.id !== task.id)],
      transcript: [],
      git,
      usage: empty.usage,
      children: [],
    }));
    if (nativeHost) {
      // A just-created task is known to have no prior provider events. Seed
      // the reducer immediately so the first send can subscribe without a
      // redundant snapshot round-trip or dropping early provider events.
      const initialRuntime = createRuntimeProjectionState(task.id);
      ++projectionGeneration.current;
      projectionBuffer.current = [];
      projectionTaskId.current = task.id;
      projectionReady.current = true;
      setReadyProjectionTaskId(task.id);
      taskProjectionCache.current.set(task.id, initialRuntime);
      setRuntimeState(initialRuntime);
    } else {
      setRuntimeState(null);
    }
    setCenterView("task");
    setActiveFileKey("");
  };

  const createTask = async (
    project: ProjectSummary,
    prompt: string,
    options?: Omit<StartTaskInput, "projectId" | "prompt">,
  ): Promise<TaskSummary | null> => {
    if (creatingTask) return null;
    setCreatingTask(true);
    setOperationError("");
    try {
      const runtime = options?.runtime ?? snapshot.runtimes[0]?.id ?? "codex";
      const runtimeDetails = snapshot.runtimes.find((item) => item.id === runtime);
      const task = await bridge.startTask({
        projectId: project.id,
        prompt,
        runtime,
        model: options?.model ?? runtimeDetails?.models[0] ?? "Provider default",
        effort: options?.effort,
        permission: options?.permission ?? "project-write",
        delegation: options?.delegation ?? "balanced",
        draft: options?.draft,
      });
      if (options?.draft) {
        const projectOwner = { kind: "newChat", projectId: project.id } as const;
        const current = composerDraftStore.read(projectOwner) ?? options.draft;
        const promoted = composerDraftStore.promote(project.id, task.id, current.revision);
        if (promoted) {
          persistComposerDraft(promoted.taskDraft);
          persistComposerDraft(promoted.projectDraft);
          setPromotingDraftTaskId(task.id);
        }
      }
      appendTask(task);
      setOperationStatus("Chat created");
      return task;
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Could not create the task");
      return null;
    } finally {
      setCreatingTask(false);
    }
  };

  const newTask = async (projectId?: string) => {
    if (!projectId) {
      const pendingChat =
        pendingGeneralChatRef.current ?? snapshot.tasks.find(isPendingGeneralChat);
      if (pendingChat) {
        setScreen("workspace");
        if (activeTaskIdRef.current !== pendingChat.id) await selectTask(pendingChat.id);
        window.setTimeout(
          () => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(),
          0,
        );
        return;
      }
      if (creatingTask) return;
      setCreatingTask(true);
      setOperationError("");
      try {
        const task = await bridge.createChat({
          runtime: settingsDefaultRuntime,
          model: settingsDefaultModel,
          ...(settingsDefaultRoute.effort ? { effort: settingsDefaultRoute.effort } : {}),
        });
        ++navigationGeneration.current;
        setScreen("workspace");
        appendTask(task);
        window.setTimeout(
          () => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(),
          0,
        );
      } catch (error) {
        setOperationError(formatBridgeError(error, "Could not create the chat"));
      } finally {
        setCreatingTask(false);
      }
      return;
    }
    const project =
      snapshot.projects.find((item) => item.id === projectId) ?? (await openProject());
    if (!project) return;
    ++navigationGeneration.current;
    const empty = createEmptySnapshot();
    setRuntimeState(null);
    setCenterView("task");
    setScreen("workspace");
    setActiveFileKey("");
    setNewChatDraftKey((value) => value + 1);
    setSnapshot((current) => ({
      ...current,
      activeProjectId: project.id,
      activeTaskId: "",
      centerViewByTask: {
        ...current.centerViewByTask,
        ...(current.activeTaskId ? { [current.activeTaskId]: centerView } : {}),
      },
      taskContexts: current.activeTaskId
        ? {
            ...current.taskContexts,
            [current.activeTaskId]: {
              transcript: current.transcript,
              git: current.git,
              usage: current.usage,
              children: current.children,
            },
          }
        : current.taskContexts,
      transcript: [],
      git: empty.git,
      usage: empty.usage,
      children: [],
    }));
    const composer = document.querySelector<HTMLTextAreaElement>(".composer textarea");
    window.setTimeout(() => composer?.focus(), 0);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        void newTask();
      } else if (key === "w" && activeFileTabPathRef.current) {
        // Cmd/Ctrl+W closes the active canvas file tab; without one the
        // shortcut keeps its native window meaning.
        event.preventDefault();
        closeFileTabRef.current(activeFileTabPathRef.current);
      } else if (key === "k") {
        event.preventDefault();
        setSidebarCollapsed(false);
        window.setTimeout(() => {
          document.querySelector<HTMLButtonElement>(".sidebar-search-button")?.click();
        }, 0);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id, nativeHost]);

  const sendTurn = async (
    input: ComposerTurnInput,
    options?: { resumeInterrupted?: boolean },
  ): Promise<SendTurnOutcome> => {
    const project = activeProject;
    const isChat = activeTask?.kind === "chat";
    if (!project && !isChat) {
      setOperationError("Open a project before starting a task.");
      return "failed";
    }
    const routedInput: ComposerTurnInput = isChat
      ? {
          ...input,
          permission: "read-only",
          delegation: "off",
          nativeAction: undefined,
          nativeActionId: undefined,
        }
      : input;
    const submittedAt = new Date().toISOString();
    setOperationError("");
    setComposerError(null);
    const isNewTask = !activeTask;
    const submittedDraft =
      activeDraftOwner && input.draftRevision !== undefined
        ? composerDraftStore.read(activeDraftOwner)
        : undefined;
    const targetTask =
      activeTask ??
      (project &&
        (await createTask(project, routedInput.prompt, {
          runtime: routedInput.runtime,
          model: routedInput.model,
          effort: routedInput.effort,
          permission: routedInput.permission,
          delegation: routedInput.delegation,
          draft: submittedDraft?.revision === input.draftRevision ? submittedDraft : undefined,
        })));
    if (!targetTask) return "failed";
    setTaskPermissions((current) => ({
      ...current,
      [targetTask.id]: routedInput.permission,
    }));
    setSnapshot((current) => ({
      ...current,
      tasks: current.tasks.map((task) =>
        task.id === targetTask.id
          ? {
              ...task,
              status: "starting",
              unread: false,
              updatedAt: submittedAt,
            }
          : task,
      ),
    }));
    if (isChat && targetTask.status === "draft") {
      await bridge.setTaskStatus?.(targetTask.id, "starting").catch(() => undefined);
    }
    if (nativeHost && !options?.resumeInterrupted) {
      setOptimisticUserMessage({
        taskId: targetTask.id,
        event: {
          id: `optimistic-user-${Date.now()}`,
          kind: "user",
          body: input.prompt,
          nativeSkill: input.nativeAction?.kind === "skill" ? input.nativeAction.name : undefined,
          timestamp: submittedAt,
          status: "neutral",
        },
      });
    }
    let event: TranscriptEvent;
    try {
      const pendingEdit = pendingEditRef.current;
      if (pendingEdit?.taskId === targetTask.id) {
        pendingEditRef.current = null;
        try {
          await bridge.truncateTaskFrom({
            taskId: targetTask.id,
            fromEventId: pendingEdit.eventId,
            saveContext: localSettings["general.saveContextOnEdit"] === true,
          });
          clearOptimisticUserMessageForTask(targetTask.id);
          if (nativeHost) {
            taskProjectionCache.current.delete(targetTask.id);
            await reconcileTaskProjection(targetTask.id);
          } else {
            setSnapshot((current) => {
              const cutoff = current.transcript.findIndex(
                (item) => item.id === pendingEdit.eventId,
              );
              if (cutoff < 0 && current.activeTaskId === targetTask.id) return current;
              const trim = (events: TranscriptEvent[]) => {
                const index = events.findIndex((item) => item.id === pendingEdit.eventId);
                return index < 0 ? events : events.slice(0, index);
              };
              const transcript =
                current.activeTaskId === targetTask.id
                  ? trim(current.transcript)
                  : current.transcript;
              const prior = current.taskContexts[targetTask.id];
              return {
                ...current,
                transcript,
                taskContexts: {
                  ...current.taskContexts,
                  [targetTask.id]: {
                    transcript: prior ? trim(prior.transcript) : transcript,
                    git: prior?.git ?? current.git,
                    usage: prior?.usage ?? current.usage,
                    children: prior?.children ?? current.children,
                  },
                },
              };
            });
          }
        } catch (error) {
          pendingEditRef.current = pendingEdit;
          throw error;
        }
      }
      const { nativeAction } = routedInput;
      const turnInput = {
        prompt: routedInput.prompt,
        attachments: routedInput.attachments,
        runtime: routedInput.runtime,
        model: routedInput.model,
        effort: routedInput.effort,
        permission: routedInput.permission,
        delegation: routedInput.delegation,
        nativeActionId: routedInput.nativeActionId,
        contextReferences: routedInput.contextReferences,
        resumeInterrupted: options?.resumeInterrupted,
      };
      event = await bridge.sendTurn({ ...turnInput, taskId: targetTask.id });
      if (!nativeHost && nativeAction?.kind === "skill") {
        event = { ...event, nativeSkill: nativeAction.name };
      }
      if (
        isNewTask ||
        targetTask.title === CHAT_TITLE_PLACEHOLDER ||
        targetTask.title === GENERAL_CHAT_TITLE_PLACEHOLDER
      ) {
        const titlePrompt = routedInput.draftPrompt?.trim() || routedInput.prompt;
        // Staggered: the title helper boots its own cold provider process,
        // and starting it in the same instant as the real turn's spawn makes
        // the two cold starts contend for CPU/network right when
        // time-to-first-token matters most.
        const TITLE_GENERATION_STAGGER_MS = 2500;
        void new Promise((resolve) => setTimeout(resolve, TITLE_GENERATION_STAGGER_MS))
          .then(() =>
            bridge.generateTaskTitle({
              taskId: targetTask.id,
              prompt: titlePrompt,
              runtime: routedInput.runtime,
              route: { runtime: routedInput.runtime, fallbacks: [] },
            }),
          )
          .then((metadata) => {
            if (!metadata) return;
            setSnapshot((current) => ({
              ...current,
              tasks: current.tasks.map((task) =>
                task.id === targetTask.id &&
                (task.title === CHAT_TITLE_PLACEHOLDER ||
                  task.title === GENERAL_CHAT_TITLE_PLACEHOLDER)
                  ? { ...task, title: metadata.title, updatedAt: metadata.updatedAt }
                  : task,
              ),
            }));
          })
          .catch(() => undefined);
      }
    } catch (error) {
      if (isTurnActiveError(error)) {
        clearOptimisticUserMessageForTask(targetTask.id);
        setSnapshot((current) => ({
          ...current,
          tasks: current.tasks.map((task) =>
            task.id === targetTask.id && task.status === "starting"
              ? { ...task, status: "running" }
              : task,
          ),
        }));
        setPromotingDraftTaskId((current) => (current === targetTask.id ? "" : current));
        return "turn-active";
      }
      composerNoticeSequence.current += 1;
      setComposerError({
        id: `composer-error-${composerNoticeSequence.current}`,
        taskId: targetTask.id,
        message: formatBridgeError(error, "The turn could not be started"),
      });
      clearOptimisticUserMessageForTask(targetTask.id);
      const failedAt = new Date().toISOString();
      setSnapshot((current) => ({
        ...current,
        tasks: current.tasks.map((task) =>
          task.id === targetTask.id && (task.status === "starting" || task.status === "running")
            ? {
                ...task,
                status: "failed",
                unread: current.activeTaskId !== targetTask.id,
                updatedAt: failedAt,
              }
            : task,
        ),
      }));
      if (nativeHost) {
        void bridge.setTaskStatus?.(targetTask.id, "failed").catch(() => undefined);
      }
      setPromotingDraftTaskId((current) => (current === targetTask.id ? "" : current));
      return "failed";
    }
    setLocalSettings((current) => ({ ...current, "models.lastRuntime": routedInput.runtime }));
    void bridge
      .setSetting("settings.models.lastRuntime", routedInput.runtime)
      .catch(() => undefined);
    if (input.draftRevision !== undefined) {
      const cleared = composerDraftStore.clear(
        { kind: "task", taskId: targetTask.id },
        input.draftRevision,
      );
      if (cleared) persistComposerDraft(cleared);
    }
    setPromotingDraftTaskId((current) => (current === targetTask.id ? "" : current));
    try {
      if (bridge.updateTaskRouting) {
        await bridge.updateTaskRouting(targetTask.id, {
          runtime: routedInput.runtime,
          model: routedInput.model,
          effort: routedInput.effort,
        });
      }
    } catch {
      // Routing persistence is best-effort; the turn already started.
    }
    setSnapshot((current) => ({
      ...current,
      tasks: current.tasks.map((task) =>
        task.id === targetTask.id
          ? {
              ...task,
              runtime: routedInput.runtime,
              model: routedInput.model,
              effort: routedInput.effort,
              status: task.status === "starting" ? "running" : task.status,
              updatedAt: new Date().toISOString(),
            }
          : task,
      ),
    }));
    if (nativeHost) return "started";
    const activity: TranscriptEvent = {
      id: `activity-${Date.now()}`,
      kind: "activity",
      title: "Queued for execution",
      body: `${routedInput.runtime} · ${routedInput.model} · ${routedInput.delegation}`,
      timestamp: new Date().toISOString(),
      status: "running",
    };
    setSnapshot((current) => {
      const transcript = [...current.transcript, event, activity];
      const usage = recordLocalTurnUsage(current.usage, {
        eventId: event.id,
        timestamp: event.timestamp,
        prompt: routedInput.prompt,
      });
      return {
        ...current,
        transcript,
        usage,
        taskContexts: {
          ...current.taskContexts,
          [targetTask.id]: {
            transcript,
            git: current.git,
            usage,
            children: current.children,
          },
        },
        tasks: current.tasks.map((task) =>
          task.id === targetTask.id
            ? {
                ...task,
                status: "running",
                runtime: routedInput.runtime,
                model: routedInput.model,
                effort: routedInput.effort,
                updatedAt: new Date().toISOString(),
              }
            : task,
        ),
      };
    });
    return "started";
  };

  const resumeInterruptedTurn = async (): Promise<boolean> => {
    if (!activeTask || resumingTaskId || activeProjectionUnavailable) return false;
    // Stop is an intentional cancel; never resume (auto or manual) from it.
    const stoppedKey =
      runtimeState?.taskId === activeTask.id && runtimeState.turn
        ? `${activeTask.id}:${runtimeState.turn.id}`
        : "";
    if (
      (stoppedKey && userStoppedTurnsRef.current.has(stoppedKey)) ||
      (runtimeState?.taskId === activeTask.id &&
        runtimeState.turn?.status === "interrupted" &&
        runtimeState.turn.stopRequested)
    ) {
      return false;
    }
    const attemptedRecoveryKey =
      runtimeState?.taskId === activeTask.id && runtimeState.turn?.status === "interrupted"
        ? `${activeTask.id}:${runtimeState.turn.id}`
        : activeTask.id;
    const defaultPermission =
      localSettings["permissions.defaultProfile"] === "read-only" ||
      localSettings["permissions.defaultProfile"] === "ask" ||
      localSettings["permissions.defaultProfile"] === "full-access"
        ? localSettings["permissions.defaultProfile"]
        : "project-write";
    const defaultDelegation =
      localSettings["delegation.defaultMode"] === "manual" ||
      localSettings["delegation.defaultMode"] === "balanced" ||
      localSettings["delegation.defaultMode"] === "budget-first"
        ? localSettings["delegation.defaultMode"]
        : "off";
    setResumingTaskId(activeTask.id);
    setRecoveryFailure(null);
    resumeWorkedForBaselineRef.current = new Set(
      projectedTranscript.filter((event) => event.title === "Worked for").map((event) => event.id),
    );
    const outcome = await sendTurn(
      {
        prompt: INTERRUPTED_RESUME_VISIBLE_PROMPT,
        runtime: activeTask.runtime,
        model: activeTask.model ?? "Provider default",
        effort: activeTask.effort,
        permission:
          (taskPermissions[activeTask.id] as StartTaskInput["permission"] | undefined) ??
          defaultPermission,
        delegation: defaultDelegation,
      },
      { resumeInterrupted: true },
    );
    setResumingTaskId("");
    const accepted = outcome === "started";
    if (!accepted) {
      resumeWorkedForBaselineRef.current = null;
      setRecoveryFailure({
        key: attemptedRecoveryKey,
        message: "Couldn’t restore this response. You can retry or send a new message.",
      });
    }
    return accepted;
  };

  const replaceTaskQueue = (taskId: string, messages: QueuedMessage[]) => {
    setSnapshot((current) => ({
      ...current,
      queuedMessages: [
        ...current.queuedMessages.filter((message) => message.taskId !== taskId),
        ...messages,
      ],
    }));
  };

  const refreshTaskQueue = async (taskId: string) => {
    const messages = await bridge.listQueuedMessages(taskId);
    replaceTaskQueue(taskId, messages);
    return messages;
  };

  const enqueueComposerTurn = async (
    task: TaskSummary,
    input: ComposerTurnInput,
  ): Promise<boolean> => {
    try {
      const message = await bridge.enqueueMessage({
        taskId: task.id,
        prompt: input.draftPrompt ?? input.prompt,
        attachments: input.attachments ?? [],
        contextReferences: input.contextReferences,
        runtime: input.runtime,
        model: input.model,
        effort: input.effort,
        permission: task.kind === "chat" ? "read-only" : input.permission,
        delegation: task.kind === "chat" ? "off" : input.delegation,
        nativeActionId: task.kind === "chat" ? undefined : input.nativeActionId,
      });
      setSnapshot((current) => ({
        ...current,
        queuedMessages: [...current.queuedMessages, message],
      }));
      if (input.draftRevision !== undefined) {
        const cleared = composerDraftStore.clear(
          { kind: "task", taskId: task.id },
          input.draftRevision,
        );
        if (cleared) persistComposerDraft(cleared);
      }
      setOperationStatus("Message queued");
      return true;
    } catch (error) {
      setOperationError(formatBridgeError(error, "The message could not be queued"));
      return false;
    }
  };

  const submitComposerTurn = async (input: ComposerTurnInput): Promise<boolean> => {
    const task = activeTask;
    if (task && activeProjectionUnavailable) return false;
    const projectedTurnActive =
      runtimeState?.taskId === task?.id &&
      (runtimeState?.turn?.status === "pending" || runtimeState?.turn?.status === "inProgress");
    const queueBusyForTask = snapshot.queuedMessages.some(
      (message) => message.taskId === task?.id && message.id === queueBusyIdRef.current,
    );
    const turnBusy = Boolean(
      task &&
      isComposerTurnBusy({
        projectedTurnActive,
        optimisticTurnStarting,
        resuming: resumingTaskId === task.id,
        queueBusy: queueBusyForTask,
        queueAwaiting: queueAwaitingTurnRef.current?.taskId === task.id,
      }),
    );
    if (!task || (!turnBusy && !queuePausedTaskIdsRef.current.has(task.id))) {
      const outcome = await sendTurn(input);
      if (outcome !== "turn-active" || !task) return outcome === "started";

      const lastProjectedSeq = runtimeState?.taskId === task.id ? runtimeState.lastSeq : -1;
      queueWaitingForActiveTurnByTaskRef.current.set(task.id, lastProjectedSeq);
      const queued = await enqueueComposerTurn(task, input);
      if (queued) {
        // Pull the native unfinished turn into the renderer before the queue
        // effect can mistake the stale idle projection for an open slot.
        void reconcileTaskProjection(task.id, true);
      } else {
        queueWaitingForActiveTurnByTaskRef.current.delete(task.id);
      }
      return queued;
    }
    return enqueueComposerTurn(task, input);
  };

  const reorderQueuedMessages = async (orderedIds: string[]) => {
    if (!activeTask || queueBusyIdRef.current) return;
    const taskId = activeTask.id;
    const previous = snapshot.queuedMessages.filter((message) => message.taskId === taskId);
    const byId = new Map(previous.map((message) => [message.id, message]));
    replaceTaskQueue(
      taskId,
      orderedIds.flatMap((id, position) => {
        const message = byId.get(id);
        return message ? [{ ...message, position }] : [];
      }),
    );
    try {
      replaceTaskQueue(taskId, await bridge.reorderQueuedMessages(taskId, orderedIds));
    } catch (error) {
      replaceTaskQueue(taskId, previous);
      setOperationError(formatBridgeError(error, "The queue could not be reordered"));
    }
  };

  const restoreQueuedMessage = async (messageId: string) => {
    if (!activeTask || queueBusyIdRef.current) return;
    const taskId = activeTask.id;
    const owner: ComposerDraftOwner = { kind: "task", taskId };
    const currentDraft = composerDraftStore.read(owner);
    let preservedDraft: QueuedMessage | undefined;
    setQueueBusyId(messageId);
    queueBusyIdRef.current = messageId;
    setOperationError("");
    try {
      if (
        currentDraft &&
        (currentDraft.prompt.trim().length > 0 || currentDraft.attachments.length > 0)
      ) {
        preservedDraft = await bridge.enqueueMessage({
          taskId,
          prompt: currentDraft.prompt,
          attachments: currentDraft.attachments,
          contextReferences: currentDraft.contextReferences,
          runtime: currentDraft.runtime,
          model: currentDraft.model,
          effort: currentDraft.effort,
          permission: currentDraft.permission,
          delegation: currentDraft.delegation,
        });
      }
      let message: QueuedMessage;
      try {
        message = await bridge.takeQueuedMessage(taskId, messageId);
      } catch (error) {
        if (preservedDraft) {
          await bridge.takeQueuedMessage(taskId, preservedDraft.id).catch(() => undefined);
        }
        throw error;
      }
      await refreshTaskQueue(taskId);
      const value: ComposerDraftValue = {
        prompt: message.prompt,
        attachments: message.attachments,
        contextReferences: message.contextReferences,
        runtime: message.runtime,
        model: message.model,
        effort: message.effort,
        permission: message.permission,
        delegation: message.delegation,
        selectionStart: message.prompt.length,
        selectionEnd: message.prompt.length,
      };
      persistComposerDraft(composerDraftStore.update(owner, value));
      composerRestoreSequence.current += 1;
      setComposerRestore({ id: composerRestoreSequence.current, value });
      setOperationStatus(preservedDraft ? "Drafts swapped" : "Message returned to the composer");
    } catch (error) {
      setOperationError(formatBridgeError(error, "The message could not be returned"));
      await refreshTaskQueue(taskId).catch(() => undefined);
    } finally {
      queueBusyIdRef.current = "";
      setQueueBusyId("");
    }
  };

  const deleteQueuedMessage = async (messageId: string) => {
    if (!activeTask || queueBusyIdRef.current) return;
    const taskId = activeTask.id;
    setQueueBusyId(messageId);
    queueBusyIdRef.current = messageId;
    setOperationError("");
    try {
      await bridge.takeQueuedMessage(taskId, messageId);
      await refreshTaskQueue(taskId);
      setOperationStatus("Queued message removed");
    } catch (error) {
      setOperationError(formatBridgeError(error, "The queued message could not be removed"));
      await refreshTaskQueue(taskId).catch(() => undefined);
    } finally {
      queueBusyIdRef.current = "";
      setQueueBusyId("");
    }
  };

  const changeCenterView = (view: CenterView) => {
    setCenterView(view);
    // The transcript always owns the canvas; Review opens in the work pane.
    if (view === "review") workPane.openReview();
    if (!activeTask) return;
    setSnapshot((current) => ({
      ...current,
      centerViewByTask: {
        ...current.centerViewByTask,
        [activeTask.id]: view,
      },
    }));
  };

  const evictTaskHotCaches = (taskId: string, projectId?: string) => {
    taskProjectionCache.current.delete(taskId);
    taskGitCache.current.delete(taskId);
    taskGitRefreshedAt.current.delete(taskId);
    taskGitInvalidatedPaths.current.delete(taskId);
    setSnapshot((current) => {
      const { [taskId]: _context, ...taskContexts } = current.taskContexts;
      const { [taskId]: _center, ...centerViewByTask } = current.centerViewByTask;
      const { [taskId]: _files, ...openFilesByTask } = current.openFilesByTask;
      const lastTaskByProject = { ...current.lastTaskByProject };
      if (projectId && lastTaskByProject[projectId] === taskId) {
        const replacement = current.tasks.find(
          (task) =>
            task.id !== taskId && task.projectId === projectId && !task.archived && !task.parentId,
        );
        if (replacement) lastTaskByProject[projectId] = replacement.id;
        else delete lastTaskByProject[projectId];
      }
      return {
        ...current,
        taskContexts,
        centerViewByTask,
        openFilesByTask,
        lastTaskByProject,
      };
    });
  };

  const ensureArchivedCatalog = useCallback(
    async (options?: { reset?: boolean; more?: boolean }) => {
      if (archivedLoading) return;
      if (options?.more) {
        if (!archivedNextCursor) return;
      } else if (!options?.reset && archivedCatalogReady.current) {
        return;
      }
      setArchivedLoading(true);
      try {
        if (options?.reset) {
          archivedCatalogReady.current = false;
          setArchivedTasks([]);
          setArchivedNextCursor(undefined);
          setArchivedTotal(0);
        }
        const page = await bridge.listArchivedTasks({
          cursor: options?.more ? archivedNextCursor : undefined,
          limit: 50,
        });
        setArchivedTasks((current) => {
          if (options?.more) {
            const seen = new Set(current.map((task) => task.id));
            return [...current, ...page.tasks.filter((task) => !seen.has(task.id))];
          }
          return page.tasks;
        });
        setArchivedNextCursor(page.nextCursor);
        setArchivedTotal(page.total);
        archivedCatalogReady.current = true;
      } catch (error) {
        setOperationError(formatBridgeError(error, "Could not load archived chats"));
      } finally {
        setArchivedLoading(false);
      }
    },
    [archivedLoading, archivedNextCursor],
  );

  const updateTaskMetadata = async (
    taskId: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
  ) => {
    if (taskActionBusyId) return;
    setTaskActionBusyId(taskId);
    setOperationError("");
    try {
      const existing =
        snapshot.tasks.find((task) => task.id === taskId) ??
        archivedTasks.find((task) => task.id === taskId);
      const updated = await bridge.updateTaskMetadata(taskId, patch);
      const nextSummary: TaskSummary = {
        ...(existing ?? {
          id: taskId,
          projectId: snapshot.activeProjectId,
          title: updated.title,
          status: "draft" as const,
          runtime: "codex" as const,
          model: "",
          updatedAt: updated.updatedAt,
        }),
        title: updated.title,
        pinned: updated.pinned,
        archived: updated.archived,
        updatedAt: updated.updatedAt,
      };
      if (updated.archived) {
        evictTaskHotCaches(taskId, nextSummary.projectId);
        setSnapshot((current) => ({
          ...current,
          tasks: current.tasks.filter((task) => task.id !== taskId),
        }));
        setArchivedTotal((total) =>
          archivedTasks.some((task) => task.id === taskId) ? total : total + 1,
        );
        setArchivedTasks((current) => {
          const without = current.filter((task) => task.id !== taskId);
          return [nextSummary, ...without].sort(
            (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
          );
        });
        if (snapshot.activeTaskId === taskId) {
          const replacement = snapshot.tasks.find(
            (task) =>
              task.id !== taskId &&
              task.projectId === nextSummary.projectId &&
              !task.archived &&
              !task.parentId,
          );
          if (replacement) void selectTask(replacement.id);
          else {
            const empty = createEmptySnapshot();
            setRuntimeState(null);
            setCenterView("task");
            setActiveFileKey("");
            setSnapshot((current) => ({
              ...current,
              activeProjectId: nextSummary.projectId,
              activeTaskId: "",
              transcript: [],
              git: empty.git,
              usage: empty.usage,
              children: [],
            }));
          }
        }
      } else {
        taskProjectionCache.current.delete(taskId);
        setArchivedTasks((current) => current.filter((task) => task.id !== taskId));
        setArchivedTotal((total) => Math.max(0, total - 1));
        setSnapshot((current) => ({
          ...current,
          tasks: [
            { ...nextSummary, archived: false },
            ...current.tasks.filter((task) => task.id !== taskId),
          ],
        }));
      }
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Could not update that chat");
    } finally {
      setTaskActionBusyId("");
    }
  };

  /**
   * Copies a chat, optionally truncated at `throughEventId`, and switches to
   * the copy. Unlike a new chat, a fork already owns a transcript, so it takes
   * the ordinary select path to hydrate rather than appendTask's empty-history
   * fast path.
   */
  const forkTask = async (taskId: string, throughEventId?: string) => {
    if (taskActionBusyId) return;
    const source = snapshot.tasks.find((task) => task.id === taskId);
    if (!source) return;
    setTaskActionBusyId(taskId);
    setOperationError("");
    try {
      const fork = await bridge.forkTask({
        taskId,
        throughEventId,
        title: nextForkTitle(
          source.title,
          throughEventId ? "Branch" : "Copy",
          // Numbered per project, matching how the sidebar groups chats.
          snapshot.tasks
            .filter((task) => task.projectId === source.projectId)
            .map((task) => task.title),
        ),
      });
      // selectTask resolves the target against this render's task list, so the
      // fork has to appear there before the switch can find it.
      pendingForkSelection.current = fork.id;
      setSnapshot((current) => ({
        ...current,
        tasks: [fork, ...current.tasks.filter((task) => task.id !== fork.id)],
      }));
    } catch (error) {
      setOperationError(formatBridgeError(error, "Could not copy that chat"));
    } finally {
      setTaskActionBusyId("");
    }
  };

  useEffect(() => {
    const forkId = pendingForkSelection.current;
    if (!forkId) return;
    if (!snapshot.tasks.some((task) => task.id === forkId)) return;
    pendingForkSelection.current = "";
    selectTask(forkId);
    // selectTask is redefined every render; the fork landing in the task list
    // is the only signal this waits on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.tasks]);

  const updateProjectMetadata = async (
    projectId: string,
    patch: { pinned?: boolean; archived?: boolean },
  ) => {
    setOperationError("");
    let nextProjects: WorkspaceSnapshot["projects"] = [];
    setSnapshot((current) => {
      nextProjects = current.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              pinned: patch.pinned ?? project.pinned ?? false,
              archived: patch.archived ?? project.archived ?? false,
            }
          : project,
      );
      return { ...current, projects: nextProjects };
    });
    const meta = projectSidebarMetaFromProjects(nextProjects);
    setLocalSettings((current) => ({ ...current, [PROJECT_SIDEBAR_META_KEY]: meta }));
    try {
      await bridge.setSetting(PROJECT_SIDEBAR_META_KEY, meta);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Could not update that project");
    }
    if (patch.archived && snapshot.activeProjectId === projectId) {
      const replacement = nextProjects.find((project) => !project.archived);
      if (replacement) selectProject(replacement.id);
    }
  };

  // Sidebar callbacks must keep stable identities across `runtimeState` stream
  // frames; otherwise memo(TaskSidebar) still re-renders every RAF.
  const sidebarHandlersRef = useRef({
    selectProject,
    selectTask,
    newTask,
    ensureArchivedCatalog,
    updateTaskMetadata,
    forkTask,
    updateProjectMetadata,
  });
  sidebarHandlersRef.current = {
    selectProject,
    selectTask,
    newTask,
    ensureArchivedCatalog,
    updateTaskMetadata,
    forkTask,
    updateProjectMetadata,
  };
  const handleSidebarSelectProject = useCallback((projectId: string) => {
    sidebarHandlersRef.current.selectProject(projectId);
  }, []);
  const handleSidebarSelectTask = useCallback((taskId: string) => {
    void sidebarHandlersRef.current.selectTask(taskId);
  }, []);
  const handleSidebarNewTask = useCallback(() => {
    void sidebarHandlersRef.current.newTask();
  }, []);
  const handleSidebarNewTaskInProject = useCallback((projectId: string) => {
    void sidebarHandlersRef.current.newTask(projectId);
  }, []);
  const handleSidebarEnsureArchived = useCallback(() => {
    void sidebarHandlersRef.current.ensureArchivedCatalog();
  }, []);
  const handleSidebarLoadMoreArchived = useCallback(() => {
    void sidebarHandlersRef.current.ensureArchivedCatalog({ more: true });
  }, []);
  const handleSidebarUpdateTask = useCallback(
    (taskId: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) => {
      void sidebarHandlersRef.current.updateTaskMetadata(taskId, patch);
    },
    [],
  );
  const handleSidebarCopyTask = useCallback((taskId: string) => {
    void sidebarHandlersRef.current.forkTask(taskId);
  }, []);
  const handleSidebarUpdateProject = useCallback(
    (projectId: string, patch: { pinned?: boolean; archived?: boolean }) => {
      void sidebarHandlersRef.current.updateProjectMetadata(projectId, patch);
    },
    [],
  );
  const handleSidebarDeleteProject = useCallback((projectId: string) => {
    setDeleteProjectError("");
    setDeleteProjectId(projectId);
  }, []);
  const handleSidebarDeleteTask = useCallback((taskId: string) => {
    setDeleteTaskError("");
    setDeleteTaskId(taskId);
  }, []);
  const handleSidebarDeleteArchivedChats = useCallback((projectId: string) => {
    setDeleteArchivedChatsError("");
    void sidebarHandlersRef.current
      .ensureArchivedCatalog()
      .then(() => setDeleteArchivedChatsProjectId(projectId));
  }, []);
  const handleSidebarOpenProject = useCallback(() => setAddProjectOpen(true), []);
  const handleSidebarOpenSettings = useCallback(() => {
    setRuntimeActionRequest(null);
    setSettingsSection("general");
    setScreen("settings");
  }, []);
  const handleSidebarOpenSettingsSection = useCallback((section: SettingsSection) => {
    setRuntimeActionRequest(null);
    setSettingsSection(section);
    setScreen("settings");
  }, []);
  const handleSidebarOpenCapabilities = useCallback(
    () => handleSidebarOpenSettingsSection("skills"),
    [handleSidebarOpenSettingsSection],
  );
  const handleSidebarOpenSubagents = useCallback(
    () => handleSidebarOpenSettingsSection("subagents"),
    [handleSidebarOpenSettingsSection],
  );
  const handleLocalSettingChanged = (key: string, value: unknown) => {
    setLocalSettings((current) => ({ ...current, [key]: value }));
    if (
      key !== "permissions.defaultProfile" ||
      !isTaskPermission(value) ||
      !activeTask ||
      activeTask.kind === "chat"
    ) {
      return;
    }

    // A Settings change should fix the task the user came from as well as
    // future tasks. Other existing tasks retain their explicit profile.
    setTaskPermissions((current) => ({ ...current, [activeTask.id]: value }));
    setPermissionRequest((current) => (current?.taskId === activeTask.id ? null : current));
    const owner = { kind: "task", taskId: activeTask.id } as const;
    const draft = composerDraftStore.read(owner);
    if (draft) {
      persistComposerDraft(composerDraftStore.update(owner, { ...draft, permission: value }));
    }
  };
  const handleSidebarOpenScheduled = useCallback(() => {
    setScheduledRailOpen(false);
    setScreen("scheduled");
  }, []);
  const handleSidebarSearchMessages = useCallback(
    (query: string, options?: { includeArchived?: boolean }) =>
      bridge.searchTaskMessages(query, 40, options),
    [],
  );
  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth((current) => clampDimension(current + delta, 220, 420));
  }, []);
  const metadataActionsEnabled = useMemo(() => bridge.supportsTaskMetadata(), []);

  const confirmDeleteProject = async (scope: DeleteProjectScope) => {
    if (!deleteProjectId || deleteProjectBusy) return;
    setDeleteProjectBusy(true);
    setDeleteProjectError("");
    setOperationError("");
    const removedId = deleteProjectId;
    const wasActiveTask =
      Boolean(snapshot.activeTaskId) &&
      snapshot.tasks.some(
        (task) => task.id === snapshot.activeTaskId && task.projectId === removedId,
      );
    try {
      await bridge.removeProject(removedId, { deleteFiles: scope === "disk" });
      const remainingProjects = snapshot.projects.filter((project) => project.id !== removedId);
      const remainingTasks = snapshot.tasks.filter((task) => task.projectId !== removedId);
      const nextActiveProjectId =
        snapshot.activeProjectId === removedId
          ? (remainingProjects.find((project) => !project.archived)?.id ??
            remainingProjects[0]?.id ??
            "")
          : snapshot.activeProjectId;
      const nextActiveTaskId = remainingTasks.some((task) => task.id === snapshot.activeTaskId)
        ? snapshot.activeTaskId
        : (remainingTasks.find((task) => task.projectId === nextActiveProjectId && !task.archived)
            ?.id ?? "");
      const meta = projectSidebarMetaFromProjects(remainingProjects);
      setLocalSettings((settings) => ({ ...settings, [PROJECT_SIDEBAR_META_KEY]: meta }));
      void bridge.setSetting(PROJECT_SIDEBAR_META_KEY, meta).catch(() => undefined);
      const empty = createEmptySnapshot();
      setSnapshot((current) => ({
        ...current,
        projects: remainingProjects,
        tasks: remainingTasks,
        activeProjectId: nextActiveProjectId,
        activeTaskId: nextActiveTaskId,
        transcript: nextActiveTaskId === current.activeTaskId ? current.transcript : [],
        git: nextActiveTaskId === current.activeTaskId ? current.git : empty.git,
        usage: nextActiveTaskId === current.activeTaskId ? current.usage : empty.usage,
        children: nextActiveTaskId === current.activeTaskId ? current.children : [],
      }));
      setDeleteProjectId("");
      if (wasActiveTask) setRuntimeState(null);
    } catch (error) {
      setDeleteProjectError(formatBridgeError(error, "Could not remove that project"));
    } finally {
      setDeleteProjectBusy(false);
    }
  };

  const confirmDeleteTask = async () => {
    if (!deleteTaskId || deleteTaskBusy) return;
    setDeleteTaskBusy(true);
    setDeleteTaskError("");
    setOperationError("");
    const removedId = deleteTaskId;
    const removed =
      snapshot.tasks.find((task) => task.id === removedId) ??
      archivedTasks.find((task) => task.id === removedId);
    const wasActive = snapshot.activeTaskId === removedId;
    try {
      await bridge.removeTask(removedId);
      evictTaskHotCaches(removedId, removed?.projectId);
      const remainingTasks = snapshot.tasks.filter((task) => task.id !== removedId);
      const nextActiveTaskId = wasActive
        ? (remainingTasks.find(
            (task) =>
              task.projectId === (removed?.projectId ?? snapshot.activeProjectId) &&
              !task.archived &&
              !task.parentId,
          )?.id ??
          remainingTasks.find((task) => !task.archived && !task.parentId)?.id ??
          "")
        : snapshot.activeTaskId;
      const empty = createEmptySnapshot();
      setSnapshot((current) => ({
        ...current,
        tasks: remainingTasks,
        activeTaskId: nextActiveTaskId,
        transcript: nextActiveTaskId === current.activeTaskId ? current.transcript : [],
        git: nextActiveTaskId === current.activeTaskId ? current.git : empty.git,
        usage: nextActiveTaskId === current.activeTaskId ? current.usage : empty.usage,
        children: nextActiveTaskId === current.activeTaskId ? current.children : [],
        composerDrafts: current.composerDrafts.filter(
          (draft) => draft.owner.kind !== "task" || draft.owner.taskId !== removedId,
        ),
        queuedMessages: current.queuedMessages.filter((message) => message.taskId !== removedId),
      }));
      if (removed?.archived) {
        setArchivedTasks((current) => current.filter((task) => task.id !== removedId));
        setArchivedTotal((total) => Math.max(0, total - 1));
      }
      setDeleteTaskId("");
      if (wasActive) setRuntimeState(null);
    } catch (error) {
      setDeleteTaskError(formatBridgeError(error, "Could not delete that chat"));
    } finally {
      setDeleteTaskBusy(false);
    }
  };

  /** Deletes only a live project's archived chats — the project, its live
   * chats, and the folder on disk stay put. */
  const confirmDeleteArchivedChats = async () => {
    if (!deleteArchivedChatsProjectId || deleteArchivedChatsBusy) return;
    setDeleteArchivedChatsBusy(true);
    setDeleteArchivedChatsError("");
    setOperationError("");
    const projectId = deleteArchivedChatsProjectId;
    try {
      const projectTargets: TaskSummary[] = [];
      let cursor: string | undefined;
      do {
        const page = await bridge.listArchivedTasks({ cursor, limit: 100 });
        projectTargets.push(...page.tasks.filter((task) => task.projectId === projectId));
        cursor = page.nextCursor;
      } while (cursor);
      const wasActive = projectTargets.some((task) => task.id === snapshot.activeTaskId);
      for (const task of projectTargets) {
        await bridge.removeTask(task.id);
        evictTaskHotCaches(task.id, task.projectId);
      }
      const removedIds = new Set(projectTargets.map((task) => task.id));
      const remainingLive = snapshot.tasks.filter((task) => !removedIds.has(task.id));
      const nextActiveTaskId = wasActive
        ? (remainingLive.find(
            (task) => task.projectId === projectId && !task.archived && !task.parentId,
          )?.id ??
          remainingLive.find((task) => !task.archived && !task.parentId)?.id ??
          "")
        : snapshot.activeTaskId;
      const empty = createEmptySnapshot();
      setSnapshot((current) => ({
        ...current,
        tasks: remainingLive,
        activeTaskId: nextActiveTaskId,
        transcript: nextActiveTaskId === current.activeTaskId ? current.transcript : [],
        git: nextActiveTaskId === current.activeTaskId ? current.git : empty.git,
        usage: nextActiveTaskId === current.activeTaskId ? current.usage : empty.usage,
        children: nextActiveTaskId === current.activeTaskId ? current.children : [],
        composerDrafts: current.composerDrafts.filter(
          (draft) => draft.owner.kind !== "task" || !removedIds.has(draft.owner.taskId),
        ),
        queuedMessages: current.queuedMessages.filter((message) => !removedIds.has(message.taskId)),
      }));
      setArchivedTasks((current) => current.filter((task) => !removedIds.has(task.id)));
      setArchivedTotal((total) => Math.max(0, total - removedIds.size));
      setDeleteArchivedChatsProjectId("");
      if (wasActive) setRuntimeState(null);
    } catch (error) {
      setDeleteArchivedChatsError(
        formatBridgeError(error, "Could not delete those archived chats"),
      );
    } finally {
      setDeleteArchivedChatsBusy(false);
    }
  };

  // ---- Archive retention (Settings → Archive) ----
  // One sweep stamps archival times, auto-archives inactive chats, and
  // auto-deletes expired archived chats. It re-evaluates when tasks or the
  // retention settings change, plus on a slow timer so thresholds can lapse
  // while the app sits open.
  const retentionSweepBusy = useRef(false);
  const [retentionTick, setRetentionTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(
      () => setRetentionTick((tick) => tick + 1),
      RETENTION_SWEEP_INTERVAL_MS,
    );
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    if (retentionSweepBusy.current || workspaceLoading) return;
    const liveTasks = snapshot.tasks.filter((task) => !task.archived);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const readChoice = (key: string) => {
      const value = localSettings[key];
      return typeof value === "string" ? value : "never";
    };
    const archiveMs = ARCHIVE_RETENTION_MS[readChoice("archive.autoArchiveAfter")];
    const deleteMs = ARCHIVE_RETENTION_MS[readChoice("archive.autoDeleteAfter")];
    if (
      !archiveMs &&
      !deleteMs &&
      !Object.keys(readArchivedAtMap(localSettings[ARCHIVED_AT_SETTING_KEY])).length
    ) {
      return;
    }
    retentionSweepBusy.current = true;
    void (async () => {
      try {
        // Archived chats live outside the hot snapshot; page them for stamps
        // and auto-delete. Live auto-archive still uses the hot task list.
        const archived: TaskSummary[] = [];
        let cursor: string | undefined;
        do {
          const page = await bridge.listArchivedTasks({ cursor, limit: 100 });
          archived.push(...page.tasks);
          cursor = page.nextCursor;
        } while (cursor);

        const stamps = readArchivedAtMap(localSettings[ARCHIVED_AT_SETTING_KEY]);
        const nextStamps: Record<string, string> = {};
        let stampsChanged = false;
        for (const task of archived) {
          const existing = stamps[task.id];
          nextStamps[task.id] = existing ?? nowIso;
          if (!existing) stampsChanged = true;
        }
        if (Object.keys(stamps).length !== Object.keys(nextStamps).length) {
          stampsChanged = true;
        }
        if (stampsChanged) {
          setLocalSettings((current) => ({ ...current, [ARCHIVED_AT_SETTING_KEY]: nextStamps }));
          await bridge
            .setSetting(`settings.${ARCHIVED_AT_SETTING_KEY}`, nextStamps)
            .catch(() => undefined);
          return;
        }

        if (!archiveMs && !deleteMs) return;
        const idle = (task: TaskSummary) =>
          task.id !== snapshot.activeTaskId &&
          !task.parentId &&
          !RETENTION_BUSY_STATUSES.has(task.status);
        const toArchive =
          archiveMs && bridge.supportsTaskMetadata()
            ? liveTasks.filter((task) => {
                if (task.pinned || !idle(task)) return false;
                const updatedAt = Date.parse(task.updatedAt);
                return Number.isFinite(updatedAt) && now - updatedAt > archiveMs;
              })
            : [];
        const toDelete = deleteMs
          ? archived.filter((task) => {
              if (!idle(task)) return false;
              const archivedAt = Date.parse(nextStamps[task.id] ?? "");
              return Number.isFinite(archivedAt) && now - archivedAt > deleteMs;
            })
          : [];
        if (!toArchive.length && !toDelete.length) return;

        const archivedIds = new Set<string>();
        for (const task of toArchive) {
          try {
            await bridge.updateTaskMetadata(task.id, { archived: true });
            archivedIds.add(task.id);
            evictTaskHotCaches(task.id, task.projectId);
          } catch {
            // Leave it for the next sweep; retention must never surface errors.
          }
        }
        const removedIds = new Set<string>();
        for (const task of toDelete) {
          try {
            await bridge.removeTask(task.id);
            removedIds.add(task.id);
            evictTaskHotCaches(task.id, task.projectId);
          } catch {
            // Same: skip and retry on a later pass.
          }
        }
        if (archivedIds.size || removedIds.size) {
          setSnapshot((current) => ({
            ...current,
            tasks: current.tasks.filter(
              (task) => !removedIds.has(task.id) && !archivedIds.has(task.id),
            ),
            composerDrafts: current.composerDrafts.filter(
              (draft) => draft.owner.kind !== "task" || !removedIds.has(draft.owner.taskId),
            ),
            queuedMessages: current.queuedMessages.filter(
              (message) => !removedIds.has(message.taskId),
            ),
          }));
          setArchivedTasks((current) => [
            ...toArchive
              .filter((task) => archivedIds.has(task.id))
              .map((task) => ({ ...task, archived: true as const })),
            ...current.filter((task) => !removedIds.has(task.id) && !archivedIds.has(task.id)),
          ]);
          setArchivedTotal((total) => Math.max(0, total + archivedIds.size - removedIds.size));
        }
        if (removedIds.size) {
          const prunedStamps = Object.fromEntries(
            Object.entries(nextStamps).filter(([id]) => !removedIds.has(id)),
          );
          setLocalSettings((current) => ({ ...current, [ARCHIVED_AT_SETTING_KEY]: prunedStamps }));
          void bridge
            .setSetting(`settings.${ARCHIVED_AT_SETTING_KEY}`, prunedStamps)
            .catch(() => undefined);
        }
      } finally {
        retentionSweepBusy.current = false;
      }
    })();
  }, [snapshot.tasks, snapshot.activeTaskId, localSettings, retentionTick, workspaceLoading]);

  const selectFile = (file: DiffFile) => {
    setReviewLoadError(null);
    setActiveFileKey(diffFileKey(file));
    changeCenterView("review");
  };

  /** A transcript file action opens the file as a first-class canvas tab. */
  const openTranscriptFile = (location: ProjectFileLocation) => {
    setOpenProjectFileRequest({ ...location, id: Date.now() });
  };

  /** Tabs belong to the active task, or to the project while drafting a new
   * chat, matching how centerView is remembered per task. */
  const fileTabOwnerKey = workPaneOwnerKey;
  const fileTabOwnerRef = useRef(fileTabOwnerKey);
  const fileTabRestoreGeneration = useRef(0);
  const activeFileTab = activeFileTabPath
    ? openFileTabs.find((tab) => tab.path === activeFileTabPath)
    : undefined;

  const openFileInCanvas = useCallback(
    async (file: Pick<ProjectFileEntry, "path">, location?: ProjectFileLocation) => {
      const project = activeProject;
      if (!project) return;
      setOperationError("");
      const existing = openFileTabs.find((tab) => tab.path === file.path);
      workPane.openFile(file.path, location?.startLine ?? null);
      setActiveFileLocation(location ? { ...location, path: file.path } : null);
      if (existing) return;
      setFileTabOpeningPath(file.path);
      try {
        const content = await bridge.readProjectFile(project.id, file.path);
        setOpenFileTabs((current) => [
          ...current.filter((tab) => tab.path !== content.path),
          content,
        ]);
      } catch (error) {
        failedFileOpens.current.add(file.path);
        setOperationError(
          error instanceof Error ? error.message : "Could not open that project file.",
        );
      } finally {
        setFileTabOpeningPath("");
      }
    },
    [activeProject, openFileTabs, setActiveFileLocation, workPane],
  );
  // A restored or re-activated file tab whose content is not loaded yet reads
  // it on demand; a failed read is not retried until the tab is reopened.
  const failedFileOpens = useRef(new Set<string>());
  useEffect(() => {
    const surface = workPane.active;
    if (surface?.kind !== "file" || fileTabOpeningPath) return;
    if (openFileTabs.some((tab) => tab.path === surface.path)) return;
    if (failedFileOpens.current.has(surface.path)) return;
    void openFileInCanvas({ path: surface.path });
  }, [workPane.active, openFileTabs, fileTabOpeningPath, openFileInCanvas]);

  const closeFileTab = (path: string) => {
    setOpenFileTabs((current) => current.filter((tab) => tab.path !== path));
    failedFileOpens.current.delete(path);
    if (activeFileLocation?.path === path) setActiveFileLocation(null);
    workPane.close(fileSurfaceId(path));
  };
  useEffect(() => {
    activeFileTabPathRef.current = activeFileTabPath;
    closeFileTabRef.current = closeFileTab;
  });

  // Swapping tasks swaps the titlebar file tabs with them: warm tabs come from
  // the in-memory cache, cold ones re-read their persisted paths.
  useEffect(() => {
    if (fileTabOwnerRef.current === fileTabOwnerKey) return;
    fileTabOwnerRef.current = fileTabOwnerKey;
    const generation = ++fileTabRestoreGeneration.current;
    setFileTabOpeningPath("");
    setActiveFileLocation(null);
    const cached = fileTabsCache.current.get(fileTabOwnerKey);
    if (cached) {
      setOpenFileTabs(cached.tabs);
      return;
    }
    setOpenFileTabs([]);
    const stored = snapshot.openFilesByTask[fileTabOwnerKey];
    const project = activeProject;
    if (!stored?.paths.length || !project) return;
    void Promise.all(
      stored.paths.map((path) => bridge.readProjectFile(project.id, path).catch(() => null)),
    ).then((contents) => {
      if (generation !== fileTabRestoreGeneration.current) return;
      if (fileTabOwnerRef.current !== fileTabOwnerKey) return;
      const tabs = contents.filter((content): content is ProjectFileContent => Boolean(content));
      if (!tabs.length) return;
      setOpenFileTabs(tabs);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileTabOwnerKey]);

  // Mirror the open tabs into the snapshot (paths only) and the warm cache, so
  // they survive task switches now and app restarts via stored navigation.
  useEffect(() => {
    const key = fileTabOwnerRef.current;
    if (!key || key !== fileTabOwnerKey) return;
    fileTabsCache.current.set(key, { tabs: openFileTabs, active: activeFileTabPath });
    const paths = openFileTabs.map((tab) => tab.path);
    setSnapshot((current) => {
      const existing = current.openFilesByTask[key];
      if (
        existing
          ? existing.active === activeFileTabPath && existing.paths.join("\n") === paths.join("\n")
          : paths.length === 0
      ) {
        return current;
      }
      return {
        ...current,
        openFilesByTask: {
          ...current.openFilesByTask,
          [key]: { paths, active: activeFileTabPath },
        },
      };
    });
  }, [openFileTabs, activeFileTabPath, fileTabOwnerKey]);

  // Transcript-requested opens resolve loose paths against the project tree,
  // retrying until the bounded scan is ready.
  useEffect(() => {
    if (!openProjectFileRequest) return;
    if (handledFileRequestRef.current === openProjectFileRequest.id) return;
    requestProjectFiles();
    const file = resolveRequestedFile(projectFiles, openProjectFileRequest.path);
    if (!file && projectFilesState !== "ready") return;
    // Mark the request handled inside the timer so a StrictMode remount that
    // clears the pending timeout does not swallow the open or its error.
    const timer = window.setTimeout(() => {
      handledFileRequestRef.current = openProjectFileRequest.id;
      if (!file) {
        setOperationError(`Could not find ${openProjectFileRequest.path} in the project files.`);
        return;
      }
      void openFileInCanvas(file, openProjectFileRequest);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    openProjectFileRequest,
    projectFiles,
    projectFilesState,
    openFileInCanvas,
    requestProjectFiles,
  ]);

  /** Writes an autosaved edit through the trusted-project boundary, then
   * refreshes the tab content and lets Git catch up on the change. */
  const saveFileTab = async (path: string, content: string) => {
    if (!activeProject) throw new Error("Open a project before editing files.");
    const saved = await bridge.writeProjectFile(activeProject.id, path, content);
    setOpenFileTabs((current) => current.map((tab) => (tab.path === saved.path ? saved : tab)));
    if (activeTask) {
      scheduleTaskGitRefresh(activeTask.id, [saved.path]);
    } else {
      scheduleProjectGitRefresh(activeProject.id);
    }
  };

  /** Who answers an "Ask about this" request. Resolved once so the panel's
   * label and the request itself cannot disagree about which agent was asked:
   * an unpinned explainer runtime inherits whatever this chat is using. */
  const explainRoute = useMemo(
    () =>
      resolveExplainRoute(
        localSettings,
        {
          runtime: (activeTask?.runtime as RuntimeId | undefined) ?? settingsDefaultRuntime,
          model: activeTask?.model ?? undefined,
          effort: activeTask?.effort ?? undefined,
        },
        snapshot.runtimes
          .filter((runtime) => runtime.status !== "not_installed")
          .map((runtime) => runtime.id),
      ),
    [
      localSettings,
      activeTask?.runtime,
      activeTask?.model,
      activeTask?.effort,
      settingsDefaultRuntime,
      snapshot.runtimes,
    ],
  );

  /** Right-click "Ask about this" from the file reader: stay on the file
   * canvas and ask the configured explainer to analyze the selection through
   * the isolated helper boundary, streaming the answer into the ask panel as
   * it is written. Add to chat remains the path into the transcript.
   *
   * The archetype, sliders, and route all come from the Explain settings. */
  const explainFileSelection = async (
    payload: FileExplainPayload,
    onDelta: (delta: FileExplainDelta) => void,
  ): Promise<FileExplainResult> => {
    if (!activeProject) {
      throw new Error("Open a project before asking about a selection.");
    }
    const outcome = await bridge.explainSelection(
      activeProject.id,
      explainRoute,
      resolveExplainConfig(localSettings),
      {
        path: payload.path,
        startLine: payload.startLine,
        endLine: payload.endLine,
        text: payload.text,
        fileText: payload.fileText,
        question: payload.question,
        history: payload.history,
      },
      (event) =>
        onDelta({
          kind: event.kind,
          text: event.text,
          agentLabel: runtimeLabel(event.runtime),
        }),
    );
    return {
      text: outcome.text,
      agentLabel: runtimeLabel(outcome.runtime),
      usedFallback: outcome.usedFallback,
    };
  };

  const renameProjectFile = async (file: ProjectFileEntry, newName: string) => {
    if (!activeProject) {
      throw new Error("Open a project before renaming files.");
    }
    await bridge.renameProjectFile(activeProject.id, file.path, newName);
    const parent = file.path.split("/").slice(0, -1).join("/");
    const nextPath = parent ? `${parent}/${newName}` : newName;
    // Keep any open canvas tab pointing at the renamed file.
    setOpenFileTabs((current) =>
      current.map((tab) => (tab.path === file.path ? { ...tab, path: nextPath } : tab)),
    );
    if (workPane.state.surfaces.some((surface) => surface.id === fileSurfaceId(file.path))) {
      const wasActive = workPane.active?.id === fileSurfaceId(file.path);
      workPane.close(fileSurfaceId(file.path));
      workPane.openFile(nextPath, null, { activate: wasActive });
    }
    try {
      const files = await bridge.listProjectFiles(activeProject.id);
      projectFilesCache.current.set(activeProject.id, files);
      setProjectFiles(files);
    } catch {
      // The rename succeeded; the stale list refreshes on the next project load.
    }
    if (activeTask) {
      scheduleTaskGitRefresh(activeTask.id, [file.path, nextPath]);
    } else {
      scheduleProjectGitRefresh(activeProject.id);
    }
  };

  /** Routes text into the main chat composer, which only exists on the Task
   * view of the workspace. */
  const insertIntoComposer = (text: string) => {
    composerInsertSequence.current += 1;
    setComposerInsert({ id: composerInsertSequence.current, text });
    changeCenterView("task");
    setScreen("workspace");
  };

  /** Attaches highlighted lines to the composer as a removable context card
   * labeled `name.ext (start – end)`, like an @mention that carries the
   * selected snippet. */
  const addSelectionAsComposerContext = (payload: FileSelectionPayload) => {
    const name = payload.path.split("/").at(-1) ?? payload.path;
    const range =
      payload.startLine !== undefined
        ? payload.endLine !== undefined && payload.endLine !== payload.startLine
          ? `${payload.startLine} – ${payload.endLine}`
          : `${payload.startLine}`
        : "";
    composerAttachmentSequence.current += 1;
    setComposerAttachment({
      id: composerAttachmentSequence.current,
      attachment: {
        path: payload.path,
        name: range ? `${name} (${range})` : name,
        kind: "file",
        entry: "file",
        selection: {
          startLine: payload.startLine,
          endLine: payload.endLine,
          text: payload.text,
        },
      },
    });
    changeCenterView("task");
    setScreen("workspace");
  };

  /** Drops `@path` into the main chat composer as task context. */
  const mentionProjectFile = (file: ProjectFileEntry) => {
    insertIntoComposer(`@${file.path} `);
  };

  /** Drops `@folder/` into the main chat composer as task context. */
  const mentionProjectFolder = (path: string) => {
    insertIntoComposer(`@${path}/ `);
  };

  /** Quotes highlighted file or diff lines into the composer as an @mention
   * plus a fenced snippet, so questions about the selection stand alone. */
  const addSelectionToChat = (
    payload: {
      path: string;
      startLine?: number;
      endLine?: number;
      text: string;
      intent: "add" | "ask";
    },
    source: "file" | "diff",
  ) => {
    const range =
      payload.startLine === undefined
        ? ""
        : payload.endLine !== undefined && payload.endLine !== payload.startLine
          ? `L${payload.startLine}-${payload.endLine}`
          : `L${payload.startLine}`;
    const label = [source === "diff" ? "diff" : "", range].filter(Boolean).join(" ");
    // A wider fence keeps snippets that themselves contain ``` intact.
    const fence = payload.text.includes("```") ? "````" : "```";
    const block = `@${payload.path}${label ? ` (${label})` : ""}\n${fence}${
      source === "diff" ? "diff" : ""
    }\n${payload.text}\n${fence}\n`;
    insertIntoComposer(payload.intent === "ask" ? `${block}\n` : block);
  };

  const openProjectPathExternal = async (path: string, openerId: string) => {
    if (!activeProject) throw new Error("Open a project before opening files externally.");
    await bridge.openProjectFileExternal(activeProject.id, path, openerId);
  };

  const revealProjectPath = async (path: string) => {
    if (!activeProject) throw new Error("Open a project before revealing files.");
    await bridge.revealProjectFile(activeProject.id, path);
  };

  const resolveProjectAbsolutePath = async (path: string) => {
    if (!activeProject) throw new Error("Open a project before resolving paths.");
    const resolved = await bridge.resolveProjectPath(activeProject.id, path);
    return resolved.absolutePath;
  };

  const duplicateProjectFile = async (file: ProjectFileEntry) => {
    if (!activeProject) throw new Error("Open a project before duplicating files.");
    await bridge.duplicateProjectFile(activeProject.id, file.path);
    try {
      const files = await bridge.listProjectFiles(activeProject.id);
      projectFilesCache.current.set(activeProject.id, files);
      setProjectFiles(files);
    } catch {
      // The duplicate succeeded; the stale list refreshes on the next project load.
    }
    if (activeTask) {
      scheduleTaskGitRefresh(activeTask.id, [file.path]);
    } else {
      scheduleProjectGitRefresh(activeProject.id);
    }
  };

  const revealSidebarTask = useCallback(
    (task: TaskSummary) => {
      const project = snapshot.projects.find((entry) => entry.id === task.projectId);
      void bridge.reportDiagnostic?.("detail", {
        layer: "ui",
        op: "ui.revealTask",
        outcome: "start",
        taskId: task.id,
        projectId: task.projectId,
        code: task.kind ?? "code",
        detail: JSON.stringify({
          kind: task.kind ?? "code",
          hasWorktree: Boolean(task.worktree),
          hasProjectPath: Boolean(project?.path),
          syntheticChatProject: task.projectId === CHAT_PROJECT_ID,
        }),
      });
      void bridge.revealTask(task.id).catch((error) => {
        const message = formatBridgeError(error, "Could not reveal that folder.");
        void bridge.reportDiagnostic?.("incident", {
          level: "error",
          layer: "ui",
          op: "ui.revealTask",
          outcome: "fail",
          code: "reveal-failed",
          causeClass:
            task.kind === "chat" || task.projectId === CHAT_PROJECT_ID
              ? "unpaired-folder"
              : "reveal",
          taskId: task.id,
          projectId: task.projectId,
          detail: message,
        });
        setOperationError(message);
      });
    },
    [snapshot.projects],
  );

  const resolveSidebarTaskFolder = useCallback((task: TaskSummary) => {
    void bridge.reportDiagnostic?.("detail", {
      layer: "ui",
      op: "ui.resolveTaskFolder",
      outcome: "start",
      taskId: task.id,
      projectId: task.projectId,
      code: task.kind ?? "code",
      detail: JSON.stringify({
        kind: task.kind ?? "code",
        hasWorktree: Boolean(task.worktree),
        syntheticChatProject: task.projectId === CHAT_PROJECT_ID,
      }),
    });
    return bridge.resolveTaskFolder(task.id).catch((error) => {
      const message = formatBridgeError(error, "Could not copy that folder path.");
      void bridge.reportDiagnostic?.("incident", {
        level: "error",
        layer: "ui",
        op: "ui.resolveTaskFolder",
        outcome: "fail",
        code: "resolve-failed",
        causeClass: "unpaired-folder",
        taskId: task.id,
        projectId: task.projectId,
        detail: message,
      });
      setOperationError(message);
      throw error;
    });
  }, []);

  const revealSidebarProject = useCallback((project: ProjectSummary) => {
    void bridge.revealAbsolutePath(project.path).catch((error) => {
      setOperationError(formatBridgeError(error, "Could not reveal that project folder."));
    });
  }, []);

  const openGitFileExternal = (file: DiffFile, openerId: string) =>
    openProjectPathExternal(file.path, openerId);

  const revealGitFile = (file: DiffFile) => revealProjectPath(file.path);

  const stageFile = async (file: DiffFile, staged: boolean) => {
    if (activeTask) {
      const git = await bridge.stageFiles(activeTask.id, [file.path], staged);
      applyTaskGitSnapshot(activeTask.id, git);
      return;
    }
    if (!activeProject) return;
    const projectId = activeProject.id;
    const git = await bridge.stageProjectFiles(projectId, [file.path], staged);
    setSnapshot((current) =>
      current.activeProjectId === projectId && !current.activeTaskId
        ? { ...current, git }
        : current,
    );
  };

  /** Commit decorations are applied here rather than in the composer so the
   * message the user edits stays theirs, and rather than natively so
   * `GitService::commit` keeps passing its message through verbatim. */
  const commit = async (raw: string) => {
    const message = decorateCommitMessage(raw, readGitDecorationSettings(localSettings));
    if (activeTask) {
      const git = await bridge.commit(activeTask.id, message);
      applyTaskGitSnapshot(activeTask.id, git);
      return;
    }
    if (!activeProject) return;
    const projectId = activeProject.id;
    const git = await bridge.commitProject(projectId, message);
    setSnapshot((current) =>
      current.activeProjectId === projectId && !current.activeTaskId
        ? { ...current, git }
        : current,
    );
  };

  const generateCommitMessage = async () => {
    if (!activeTask) throw new Error("Open a task before generating a commit message.");
    const route = resolveCommitMessageRoute(
      localSettings,
      snapshot.runtimes
        .filter((runtime) => runtime.status !== "not_installed")
        .map((runtime) => runtime.id),
    );
    if (!route) {
      throw new Error("Choose which model writes commit messages in Git settings.");
    }
    return bridge.generateCommitMessage(activeTask.id, route);
  };

  const push = async () => {
    if (!activeTask && !activeProject) return;
    const preview = activeTask
      ? await bridge.previewPush(activeTask.id)
      : await bridge.previewProjectPush(activeProject!.id);
    if (!preview.remote || !preview.upstream) {
      throw new Error("Push requires an existing tracked upstream branch.");
    }
    const confirmation = {
      expectedHead: preview.head,
      expectedBranch: preview.branch,
      expectedRemote: preview.remote,
      expectedRemoteUrl: preview.sanitizedRemoteUrl,
      expectedUpstream: preview.upstream,
      expectedRefspec: preview.refspec,
      force: readPushForce(localSettings),
    };
    const result = activeTask
      ? await bridge.confirmPush(activeTask.id, confirmation)
      : await bridge.confirmProjectPush(activeProject!.id, confirmation);
    if (result.outcome === "outcomeUncertain") {
      throw new Error(`${result.summary} Refresh Git status before retrying.`);
    }
    if (activeTask) await refreshTaskGitSnapshot(activeTask.id);
    else await refreshGit();
  };

  const loadMoreGitHistory = async () => {
    if (!activeTask) return;
    const taskId = activeTask.id;
    const page = await bridge.loadTaskGitHistory(taskId, snapshot.git.commits.length);
    setSnapshot((current) => {
      if (current.activeTaskId !== taskId) return current;
      const known = new Set(current.git.commits.map((commit) => commit.id));
      const git = {
        ...current.git,
        commits: [
          ...current.git.commits,
          ...page.commits.filter((commit) => !known.has(commit.id)),
        ],
        historyHasMore: page.hasMore,
      };
      taskGitCache.current.set(taskId, git);
      return { ...current, git };
    });
  };

  const refreshGit = async () => {
    if (!activeTask) {
      if (!activeProject) return;
      const git = await bridge.loadProjectGit(activeProject.id);
      setSnapshot((current) => ({ ...current, git }));
      return;
    }
    await refreshTaskGitSnapshot(activeTask.id);
  };

  const applyGitSnapshot = (git: GitSnapshot) => {
    if (activeTask) {
      applyTaskGitSnapshot(activeTask.id, git);
      return;
    }
    setSnapshot((current) => ({ ...current, git }));
  };

  const initializeProjectGit = async () => {
    if (!activeProject) return;
    const project = await bridge.initializeGit(activeProject.id);
    // Reconcile by path as well as id: the active project may be a local
    // placeholder whose id differs from the trusted record the backend
    // returns, and the Git panel keys off the entry that stays active.
    setSnapshot((current) => ({
      ...current,
      projects: current.projects.map((candidate) =>
        candidate.id === project.id || candidate.path === project.path
          ? { ...candidate, gitRepositoryRoot: project.gitRepositoryRoot }
          : candidate,
      ),
    }));
    applyGitSnapshot(await bridge.loadProjectGit(activeProject.id));
  };

  const addGitRemote = async (name: string, url: string) => {
    if (!activeProject) return;
    applyGitSnapshot(await bridge.addGitRemote(activeProject.id, name, url));
  };

  const updateGitRemote = async (name: string, url: string) => {
    if (!activeProject) return;
    applyGitSnapshot(await bridge.updateGitRemote(activeProject.id, name, url));
  };

  const removeGitRemote = async (name: string) => {
    if (!activeProject) return;
    applyGitSnapshot(await bridge.removeGitRemote(activeProject.id, name));
  };

  const fetchGit = async (remote?: string) => {
    if (!activeProject) return;
    applyGitSnapshot(await bridge.fetchGit(activeProject.id, remote));
  };

  const pullGit = async (mode: "fastForwardOnly" | "rebase") => {
    if (!activeProject) return;
    applyGitSnapshot(await bridge.pullGit(activeProject.id, mode));
  };

  const publishGitBranch = async (remote: string) => {
    if (!activeProject) return;
    const result = await bridge.publishGitBranch(activeProject.id, remote);
    if (result.outcome === "outcomeUncertain") throw new Error(result.summary);
    await refreshGit();
  };

  const publishGithubRepository = async (input: {
    nameWithOwner: string;
    visibility: "private" | "public" | "internal";
    remote: string;
  }) => {
    if (!activeProject) return;
    applyGitSnapshot(await bridge.publishGithubRepository(activeProject.id, input));
  };

  const refreshReview = async () => {
    setReviewRefreshing(true);
    setReviewLoadError(null);
    setOperationError("");
    try {
      await refreshGit();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Could not refresh Git changes");
    } finally {
      setReviewRefreshing(false);
    }
  };

  // Native Git overviews intentionally carry status only. Whichever route
  // opens Review (header, restored task, or Git rail) converges here so the
  // selected patch is loaded exactly once and failures become retryable.
  useEffect(() => {
    const taskId = activeTask?.id;
    const projectId = activeProject?.id;
    const file = activeFile;
    if (
      centerView !== "review" ||
      !nativeHost ||
      reviewRefreshing ||
      (!taskId && !projectId) ||
      !file ||
      file.diffLoaded !== false
    ) {
      return;
    }
    let active = true;
    const loadFile = taskId
      ? bridge.loadTaskGitFile(taskId, file)
      : bridge.loadProjectGitFile(projectId!, file);
    void loadFile
      .then((loaded) => {
        if (!active) return;
        setReviewLoadError(null);
        setSnapshot((current) => {
          if (
            taskId
              ? current.activeTaskId !== taskId
              : current.activeTaskId || current.activeProjectId !== projectId
          ) {
            return current;
          }
          const git = {
            ...current.git,
            files: current.git.files.map((candidate) =>
              diffFileKey(candidate) === diffFileKey(loaded) ? loaded : candidate,
            ),
          };
          if (taskId) taskGitCache.current.set(taskId, git);
          return { ...current, git };
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : "Could not load that diff";
        setReviewLoadError({ fileKey: diffFileKey(file), message });
      });
    return () => {
      active = false;
    };
  }, [
    activeFile,
    activeProject?.id,
    activeTask?.id,
    centerView,
    nativeHost,
    reviewRefreshing,
    reviewRetryVersion,
  ]);

  const pendingApproval = activeProjectionUnavailable
    ? undefined
    : runtimeState?.approvals.find(
        (approval) =>
          (approval.state === "pending" || approval.state === "responseFailed") &&
          !isStaleApproval(approval),
      );
  const visiblePendingApproval = activeProjectionUnavailable
    ? undefined
    : runtimeState?.approvals.find((approval) => {
        const approvalKey = activeTask ? autoApprovalKey(activeTask.id, approval.id) : "";
        return (
          (approval.state === "pending" || approval.state === "responseFailed") &&
          !isStaleApproval(approval) &&
          approvalVisibleForPermission(
            approval,
            activeTaskPermission,
            autoApprovalFailures.has(approvalKey),
          )
        );
      });
  const transcriptDensity: TranscriptDensity =
    localSettings["transcript.activityDensity"] === "summary" ||
    localSettings["transcript.activityDensity"] === "verbose"
      ? localSettings["transcript.activityDensity"]
      : "normal";
  const deriveNativeRuntimeTranscript = useMemo(
    () => createRuntimeTranscriptDeriver(transcriptDensity),
    [transcriptDensity],
  );
  const visibleRuntimeState = useMemo(() => {
    if (!runtimeState || activeTaskPermission !== "full-access") return runtimeState;
    const approvals = runtimeState.approvals.filter((approval) => {
      const approvalKey = activeTask ? autoApprovalKey(activeTask.id, approval.id) : "";
      return approvalVisibleForPermission(
        approval,
        activeTaskPermission,
        autoApprovalFailures.has(approvalKey),
      );
    });
    return approvals.length === runtimeState.approvals.length
      ? runtimeState
      : { ...runtimeState, approvals };
  }, [activeTask, activeTaskPermission, autoApprovalFailures, runtimeState]);
  const nativeRuntimeEvents = useMemo(
    () =>
      nativeHost && visibleRuntimeState && visibleRuntimeState.taskId === activeTask?.id
        ? deriveNativeRuntimeTranscript(visibleRuntimeState)
        : [],
    [activeTask?.id, deriveNativeRuntimeTranscript, nativeHost, visibleRuntimeState],
  );
  const optimisticForActiveTask =
    nativeHost && optimisticUserMessage?.taskId === activeTask?.id ? optimisticUserMessage : null;
  const providerHasOptimisticMessage = optimisticForActiveTask
    ? nativeRuntimeEvents.some(
        (event) =>
          event.kind === "user" &&
          event.body === optimisticForActiveTask.event.body &&
          Date.parse(event.timestamp) >=
            Date.parse(optimisticForActiveTask.event.timestamp) - 1_000,
      )
    : false;
  const nativeTurnActive =
    !activeProjectionUnavailable &&
    runtimeState?.taskId === activeTask?.id &&
    (runtimeState?.turn?.status === "pending" || runtimeState?.turn?.status === "inProgress");
  const authoritativeTurnStartedAt =
    runtimeState && runtimeState.taskId === activeTask?.id
      ? runtimeState.turn?.startedAt
      : undefined;
  const optimisticTurnAccepted = Boolean(
    optimisticForActiveTask &&
    authoritativeTurnStartedAt &&
    Date.parse(authoritativeTurnStartedAt) >= Date.parse(optimisticForActiveTask.event.timestamp),
  );
  const projectedTranscript = useMemo(() => {
    const providerEvents = nativeHost
      ? providerHasOptimisticMessage || !optimisticForActiveTask
        ? nativeRuntimeEvents
        : [...nativeRuntimeEvents, optimisticForActiveTask.event].sort(
            (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
          )
      : snapshot.transcript;
    const events = nativeHost
      ? mergeSchedulingTranscript(providerEvents, automationTimeline)
      : providerEvents;
    if (resumedWorkedForIdsRef.current.size === 0) return events;
    return events.map((event) =>
      event.title === "Worked for" && resumedWorkedForIdsRef.current.has(event.id)
        ? { ...event, resumed: true }
        : event,
    );
  }, [
    nativeHost,
    nativeRuntimeEvents,
    optimisticForActiveTask,
    providerHasOptimisticMessage,
    resumedWorkedForVersion,
    snapshot.transcript,
    automationTimeline,
  ]);
  // Transcript edits caption "Committed"/"Pushed" once Git owns them. Git status
  // already lists untracked files, so a path in neither the working tree nor the
  // tracked set is ignored — those keep the action pair instead of claiming a
  // commit that never happened. Keyed as a string so a streaming turn, which
  // rebuilds projectedTranscript on every token, does not re-run `ls-files`.
  const transcriptEditPathKey = useMemo(() => {
    const paths = new Set<string>();
    const collect = (events: TranscriptEvent[]) => {
      for (const event of events) {
        if (event.diff) paths.add(event.diff.path);
        if (event.children) collect(event.children);
      }
    };
    collect(projectedTranscript);
    return [...paths].sort().join("\0");
  }, [projectedTranscript]);
  const [trackedEditPaths, setTrackedEditPaths] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const projectId = activeProject?.id;
    const paths = transcriptEditPathKey ? transcriptEditPathKey.split("\0") : [];
    if (!projectId || paths.length === 0) {
      setTrackedEditPaths(new Set());
      return;
    }
    let cancelled = false;
    void bridge
      .trackedPaths(projectId, paths)
      .then((tracked) => {
        if (!cancelled) setTrackedEditPaths(new Set(tracked));
      })
      .catch(() => {
        // Unknown beats guessing: an empty set leaves every edit actionable.
        if (!cancelled) setTrackedEditPaths(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject?.id, transcriptEditPathKey]);
  const diffCommitState = useCallback(
    (file: DiffFile): DiffCommitState | undefined => {
      const git = snapshot.git;
      if (git.kind !== "repository") return undefined;
      if (git.files.some((entry) => entry.path === file.path)) return "uncommitted";
      if (!trackedEditPaths.has(file.path)) return undefined;
      // No upstream means nothing has been pushed, whatever `ahead` reads.
      if (!git.upstream) return "committed";
      return git.ahead > 0 ? "committed" : "pushed";
    },
    [snapshot.git, trackedEditPaths],
  );
  // Once the provider has projected the user item, its authoritative event
  // replaces the local bubble and the provider's turn state owns the spinner.
  // If startup fails, sendTurn clears the optimistic item and Composer
  // restores the draft instead. Resume has no user bubble — treat resuming
  // as the quiet “still starting” signal until the provider turn is live.
  const optimisticTurnStarting = Boolean(
    (optimisticForActiveTask && !providerHasOptimisticMessage && !optimisticTurnAccepted) ||
    (activeTask && resumingTaskId === activeTask.id && !nativeTurnActive),
  );
  const taskStatusRunningSince = optimisticTurnStarting
    ? optimisticForActiveTask?.event.timestamp
    : nativeTurnActive
      ? (authoritativeTurnStartedAt ?? optimisticForActiveTask?.event.timestamp)
      : undefined;
  const activeQueuedMessages = useMemo(
    () =>
      activeTask
        ? snapshot.queuedMessages
            .filter((message) => message.taskId === activeTask.id)
            .sort((left, right) => left.position - right.position)
        : [],
    [activeTask, snapshot.queuedMessages],
  );
  // A dispatching message whose optimistic bubble is already in the transcript
  // would render twice — as a sent user message and as a queued chip — for as
  // long as bridge.sendTurn takes (the whole connection wait on a fresh turn).
  // Hide the chip for that window; a failed send flips the durable state back
  // to "queued", which makes the chip reappear.
  const visibleQueuedMessages = useMemo(
    () =>
      activeQueuedMessages.filter(
        (message) =>
          message.state !== "dispatching" ||
          !optimisticForActiveTask ||
          optimisticForActiveTask.event.body !== queuedMessagePrompt(message),
      ),
    [activeQueuedMessages, optimisticForActiveTask],
  );
  const runtimeUsage = runtimeState?.usage;
  const tokenBreakdown = runtimeUsage
    ? [
        ["Input", runtimeUsage.inputTokens],
        ["Cache read", runtimeUsage.cachedInputTokens],
        ["Output", runtimeUsage.outputTokens],
        ["Reasoning", runtimeUsage.reasoningOutputTokens],
      ]
        .filter(([, value]) => Number(value) > 0)
        .map(([label, value]) => `${label} ${Number(value).toLocaleString()}`)
        .join(" · ")
    : "";
  const nonCostUsageMetrics = snapshot.usage.metrics.filter(
    (metric) =>
      metric.label !== "API equivalent (vendor)" &&
      metric.label !== "API equivalent (estimate)" &&
      metric.label !== "API cost estimate",
  );
  const displayedUsage = runtimeUsage
    ? {
        ...snapshot.usage,
        tokens: runtimeUsage.totalTokens,
        metrics: [
          ...(runtimeUsage.totalTokens > 0
            ? [
                {
                  label: "Processed tokens",
                  value: runtimeUsage.totalTokens.toLocaleString(),
                  numeric: runtimeUsage.totalTokens,
                  provenance: "vendor_exact" as const,
                  detail: `${activeTask ? runtimeLabel(activeTask.runtime) : "Provider"} reported this cumulative task total.${tokenBreakdown ? ` ${tokenBreakdown}.` : ""} It is not plan usage or a bill.`,
                },
              ]
            : []),
          ...(runtimeUsage.vendorCostMicroUsd !== undefined && runtimeUsage.vendorCostMicroUsd > 0
            ? [
                {
                  label: "API cost estimate",
                  value: formatCostEstimate(runtimeUsage.vendorCostMicroUsd / 1_000_000),
                  numeric: runtimeUsage.vendorCostMicroUsd / 1_000_000,
                  provenance: "estimated" as const,
                  detail:
                    "The Claude CLI computes this locally from token counts. It is not a bill or subscription usage.",
                },
              ]
            : []),
          ...nonCostUsageMetrics.filter(
            (metric) => metric.label !== "Tokens" && metric.label !== "Processed tokens",
          ),
        ],
      }
    : { ...snapshot.usage, metrics: nonCostUsageMetrics };
  // The header pill prefers per-task vendor telemetry, then the provider's
  // account-level quota windows. When neither exists the percent is omitted
  // entirely — a dead "—%" reads as broken rather than unavailable.
  const activeQuota = activeTask ? providerQuota[activeTask.runtime] : undefined;
  const quotaWindow = activeQuota?.primary ?? activeQuota?.secondary;
  const usagePillPercent = displayedUsage.subscriptionPercent ?? quotaWindow?.usedPercent;
  const usagePillTokens = `${displayedUsage.tokens.toLocaleString()} tokens on this task`;
  const usagePillTitle =
    usagePillPercent !== undefined
      ? `${activeTask ? `${activeTask.runtime} ` : ""}subscription: ${Math.round(usagePillPercent)}% of the ${describeQuotaWindow(quotaWindow)} used${
          quotaWindow?.resetsAt
            ? `, resets ${new Date(quotaWindow.resetsAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
            : ""
        } · ${usagePillTokens}`
      : `Plan usage not exposed to AI Integrator · ${usagePillTokens}`;
  const activeRuntimeState = runtimeState?.taskId === activeTask?.id ? runtimeState : undefined;
  const activeTurnStopKey =
    activeTask && activeRuntimeState?.turn ? `${activeTask.id}:${activeRuntimeState.turn.id}` : "";
  const recoverableTurn =
    !activeProjectionUnavailable &&
    activeRuntimeState?.turn?.status === "interrupted" &&
    !activeRuntimeState.turn.stopRequested &&
    !(activeTurnStopKey && userStoppedTurnsRef.current.has(activeTurnStopKey))
      ? activeRuntimeState.turn
      : undefined;
  const activeAgentCount = nativeTurnActive
    ? 1 +
      (nativeHost
        ? delegations.filter((delegation) =>
            ["starting", "running", "waiting", "pending-approval"].includes(delegation.status),
          ).length
        : snapshot.children.filter((agent) => agent.status === "running").length)
    : 0;
  const composerNotices: ComposerNotice[] = [
    ...(activeRuntimeState?.errors ?? []).map((error) => {
      const runtime = activeTask?.runtime;
      return {
        id: `runtime-error-${error.seq}`,
        title: error.retryable ? "Provider retrying" : "Turn error",
        message: error.message,
        variant: error.retryable ? ("warning" as const) : ("error" as const),
        expiresAt: composerNoticeExpiry(error.message, error.occurredAt, displayedUsage.resetAt),
        action:
          runtime && isRuntimeUpdateRequired(error.message)
            ? {
                label: `Update ${runtimeLabel(runtime)}`,
                onSelect: () => openRuntimeAction(runtime, "update"),
              }
            : undefined,
      };
    }),
    ...(composerError && composerError.taskId === activeTask?.id
      ? [
          {
            id: composerError.id,
            title: "Turn error",
            message: composerError.message,
            variant: "error" as const,
            action:
              activeTask && isRuntimeUpdateRequired(composerError.message)
                ? {
                    label: `Update ${runtimeLabel(activeTask.runtime)}`,
                    onSelect: () => openRuntimeAction(activeTask.runtime, "update"),
                  }
                : undefined,
          },
        ]
      : []),
  ];
  const respondToApproval = async (
    approval: ApprovalProjection,
    decision: ApprovalDecision,
    autoResponseKey?: string,
  ) => {
    if (!activeTask || respondingApprovalId || activeProjectionUnavailable) return;
    const approvalKey = autoApprovalKey(activeTask.id, approval.id);
    const recoveringAutoFailure = autoApprovalFailuresRef.current.has(approvalKey);
    setAutoApprovalFailures((current) => {
      if (!current.has(approvalKey)) return current;
      const next = new Set(current);
      next.delete(approvalKey);
      return next;
    });
    setRespondingApprovalId(approval.id);
    setOperationError("");
    try {
      await bridge.respondToApproval(activeTask.id, approval.id, decision);
      if (
        approval.approvalKind === "planReview" &&
        (decision === "accept" || decision === "acceptForSession") &&
        activeTask.runtime === "cursor"
      ) {
        // Cursor parity with its own "Build" action: leave plan mode and
        // start implementing once the planning turn settles.
        try {
          await bridge.setSessionMode(activeTask.id, "agent");
          pendingPlanBuildRef.current = activeTask.id;
        } catch (error) {
          setOperationError(
            error instanceof Error ? error.message : "Could not switch Cursor to Agent mode",
          );
        }
      }
    } catch (error) {
      if (autoResponseKey || recoveringAutoFailure) {
        const failedKey = autoResponseKey ?? approvalKey;
        autoApprovedIdsRef.current.delete(failedKey);
        setAutoApprovalFailures((current) => new Set(current).add(failedKey));
      }
      setOperationError(error instanceof Error ? error.message : "Could not send that decision");
    } finally {
      setRespondingApprovalId("");
    }
  };

  const respondToQuestion = async (approval: ApprovalProjection, option: QuestionOption) => {
    if (!activeTask || respondingApprovalId || activeProjectionUnavailable) return;
    setRespondingApprovalId(approval.id);
    setOperationError("");
    try {
      await bridge.respondToQuestion(activeTask.id, approval.id, option.optionId);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Could not send that answer");
    } finally {
      setRespondingApprovalId("");
    }
  };

  // Full access selected mid-run means "stop asking": answer each new
  // approval once, automatically, instead of parking the turn on a prompt.
  // Plan reviews stay manual: the user chose plan mode to read the plan
  // before anything is built, so full access must not skip that gate.
  // Questions stay manual too: there is no way to synthesize a correct
  // answer to an open multiple-choice question, and auto-accepting one
  // through the binary accept/decline path would silently pick whichever
  // option the agent happened to list first.
  useEffect(() => {
    if (!autoApproveActive || !activeTask || !pendingApproval) return;
    if (pendingApproval.state !== "pending") return;
    if (
      pendingApproval.approvalKind === "planReview" ||
      pendingApproval.approvalKind === "question"
    )
      return;
    if (respondingApprovalId) return;
    const approvalKey = autoApprovalKey(activeTask.id, pendingApproval.id);
    if (autoApprovedIdsRef.current.has(approvalKey) || autoApprovalFailures.has(approvalKey))
      return;
    autoApprovedIdsRef.current.add(approvalKey);
    void respondToApproval(pendingApproval, "acceptForSession", approvalKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- respondToApproval is recreated every render
  }, [
    autoApprovalFailures,
    autoApproveActive,
    activeTask?.id,
    pendingApproval,
    respondingApprovalId,
  ]);

  // Agent-driven mode changes (an approved ExitPlanMode, the launch mode
  // itself) flow back into the per-task permission profile so the next turn
  // relaunches in the mode the session actually reached. Applied with the
  // adjust-state-during-render pattern: the mode projection is the source of
  // truth and the picker state is derived from it exactly once per change.
  const claudeModeId =
    activeTask?.runtime === "claude" && activeRuntimeState?.mode
      ? activeRuntimeState.mode.currentModeId
      : undefined;
  const claudeModeKey = activeTask && claudeModeId ? `${activeTask.id}:${claudeModeId}` : undefined;
  const [syncedClaudeModes, setSyncedClaudeModes] = useState<Record<string, string>>({});
  if (activeTask && claudeModeId && syncedClaudeModes[activeTask.id] !== claudeModeId) {
    setSyncedClaudeModes((current) => ({ ...current, [activeTask.id]: claudeModeId }));
    const mapped =
      claudeModeId === "plan"
        ? ("read-only" as const)
        : claudeModeId === "acceptEdits"
          ? ("project-write" as const)
          : claudeModeId === "bypassPermissions"
            ? ("full-access" as const)
            : ("ask" as const);
    setTaskPermissions((current) =>
      current[activeTask.id] === mapped ? current : { ...current, [activeTask.id]: mapped },
    );
    setPermissionRequest((current) =>
      current?.id === claudeModeKey
        ? current
        : { taskId: activeTask.id, id: claudeModeKey ?? "", value: mapped },
    );
  }

  // An approved Cursor plan builds itself: once the planning turn settles,
  // prompt the (now Agent-mode) session to implement the plan it wrote. The
  // send is deferred a tick so the follow-up turn never starts inside the
  // render that delivered the turn-completed projection.
  const activeTurnStatus = activeRuntimeState?.turn?.status;
  const recoveryKey = activeTask && recoverableTurn ? `${activeTask.id}:${recoverableTurn.id}` : "";
  const recoveryError = recoveryFailure?.key === recoveryKey ? recoveryFailure.message : "";
  const autoResumeEnabled = localSettings["general.autoResumeInterruptedTurns"] === true;
  const recoverableTurnId = recoverableTurn?.id;
  const recoverableStopRequested = recoverableTurn?.stopRequested;
  // Auto-resume (or an in-flight resume) should feel continuous — no interrupt banner.
  // Surface the control again if auto/manual resume failed.
  const showRecoveryControl = Boolean(
    recoverableTurn &&
    ((!autoResumeEnabled && resumingTaskId !== activeTask?.id) || Boolean(recoveryError)),
  );

  useEffect(() => {
    if (!activeTask || !recoverableTurn || recoverableTurn.stopRequested) return;
    if (
      nativeHost &&
      (!projectionReady.current ||
        projectionTaskId.current !== activeTask.id ||
        readyProjectionTaskId !== activeTask.id)
    ) {
      return;
    }
    if (!autoResumeEnabled) return;
    if (activeQueuedMessages.length > 0 || optimisticTurnStarting || resumingTaskId) return;
    if (autoResumeAttemptedRef.current.has(recoveryKey)) return;
    autoResumeAttemptedRef.current.add(recoveryKey);
    void resumeInterruptedTurn();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one attempt per durable interrupted turn
  }, [
    activeQueuedMessages.length,
    activeTask?.id,
    autoResumeEnabled,
    optimisticTurnStarting,
    recoverableStopRequested,
    recoverableTurnId,
    recoveryKey,
    readyProjectionTaskId,
    resumingTaskId,
  ]);

  // After a resumed turn settles, stamp new Worked-for rows with a quiet cue.
  useEffect(() => {
    const baseline = resumeWorkedForBaselineRef.current;
    if (!baseline || !activeTask) return;
    const turn = activeRuntimeState?.turn;
    if (!turn || turn.status === "inProgress" || turn.status === "pending") return;
    let marked = false;
    for (const event of projectedTranscript) {
      if (event.title !== "Worked for" || baseline.has(event.id)) continue;
      if (resumedWorkedForIdsRef.current.has(event.id)) continue;
      resumedWorkedForIdsRef.current.add(event.id);
      marked = true;
    }
    if (marked) setResumedWorkedForVersion((version) => version + 1);
    if (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted") {
      resumeWorkedForBaselineRef.current = null;
    }
  }, [
    activeRuntimeState?.turn?.id,
    activeRuntimeState?.turn?.status,
    activeTask?.id,
    projectedTranscript,
  ]);

  useEffect(() => {
    if (!activeTask || pendingPlanBuildRef.current !== activeTask.id) return;
    if (activeTurnStatus !== "completed") return;
    if (activeQueuedMessages.length > 0 || optimisticTurnStarting) return;
    pendingPlanBuildRef.current = "";
    const build = {
      prompt: "Implement the approved plan.",
      runtime: activeTask.runtime,
      model: activeTask.model ?? "Provider default",
      effort: activeTask.effort,
      permission:
        (taskPermissions[activeTask.id] as
          "read-only" | "project-write" | "ask" | "full-access" | undefined) ?? "project-write",
      delegation: "off" as const,
    };
    const timer = window.setTimeout(() => void sendTurn(build), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on turn settlement for the flagged task
  }, [activeQueuedMessages.length, activeTurnStatus, activeTask?.id, optimisticTurnStarting]);

  // Each reply is stamped with the model that was routed when it first
  // appeared, so switching models later never rewrites past attribution.
  // The stamps are view metadata only, kept out of the session store.
  const [eventModels, setEventModels] = useState<Record<string, string>>(() => {
    try {
      const stored = window.localStorage?.getItem(EVENT_MODELS_STORAGE_KEY);
      return stored ? (JSON.parse(stored) as Record<string, string>) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    const model = activeTask?.model;
    if (!model) return;
    const unstamped = projectedTranscript.filter(
      (event) => event.kind === "assistant" && !eventModels[event.id],
    );
    if (unstamped.length === 0) return;
    // This effect persists derived display metadata, which is intentionally a
    // state update rather than an external subscription.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEventModels((current) => {
      const next = { ...current };
      for (const event of unstamped) next[event.id] = model;
      try {
        window.localStorage?.setItem(EVENT_MODELS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Attribution still works for this session without persistence.
      }
      return next;
    });
  }, [projectedTranscript, activeTask?.model, eventModels]);

  /** Re-sends the prompt behind a turn-final reply using the task's own routing. */
  const regenerateFrom = async (eventId: string) => {
    if (!activeTask) return;
    const assistantIndex = projectedTranscript.findIndex(
      (event) => event.id === eventId && event.kind === "assistant",
    );
    if (assistantIndex < 0) return;
    const priorUser = [...projectedTranscript.slice(0, assistantIndex)]
      .reverse()
      .find((event) => event.kind === "user");
    if (!priorUser) return;
    const defaultPermission =
      localSettings["permissions.defaultProfile"] === "read-only" ||
      localSettings["permissions.defaultProfile"] === "ask" ||
      localSettings["permissions.defaultProfile"] === "full-access"
        ? localSettings["permissions.defaultProfile"]
        : "project-write";
    await sendTurn({
      prompt: priorUser.body,
      runtime: activeTask.runtime ?? settingsDefaultRuntime,
      model: activeTask.model ?? settingsDefaultModel,
      effort: activeTask.effort,
      permission: defaultPermission,
      delegation:
        localSettings["delegation.defaultMode"] === "manual" ||
        localSettings["delegation.defaultMode"] === "balanced" ||
        localSettings["delegation.defaultMode"] === "budget-first"
          ? localSettings["delegation.defaultMode"]
          : "off",
    });
  };

  const stopTurn = async (continueQueue = false) => {
    if (!activeTask || stoppingTurn || activeProjectionUnavailable) return false;
    const taskId = activeTask.id;
    const turnId = runtimeState?.taskId === taskId && runtimeState.turn ? runtimeState.turn.id : "";
    if (turnId) userStoppedTurnsRef.current.add(`${taskId}:${turnId}`);
    // Mark Stop locally before the provider settles so auto-resume cannot treat
    // the coming interrupted status as a crash recovery.
    setRuntimeState((current) => {
      if (current?.taskId !== taskId || !current.turn) return current;
      if (current.turn.stopRequested) return current;
      const next = {
        ...current,
        turn: { ...current.turn, stopRequested: true },
      };
      taskProjectionCache.current.set(taskId, next);
      return next;
    });
    const pauseQueue =
      !continueQueue && snapshot.queuedMessages.some((message) => message.taskId === taskId);
    if (pauseQueue) queuePausedTaskIdsRef.current.add(taskId);
    setStoppingTurn(true);
    setOperationError("");
    try {
      const result = await bridge.stopTurn(taskId);
      if (result.turnId) userStoppedTurnsRef.current.add(`${taskId}:${result.turnId}`);
      setOperationStatus(
        result.settled
          ? "Session was no longer running — marked as stopped"
          : result.alreadyRequested
            ? "Stop was already requested"
            : "Stop requested",
      );
      return true;
    } catch (error) {
      if (turnId) userStoppedTurnsRef.current.delete(`${taskId}:${turnId}`);
      if (pauseQueue) queuePausedTaskIdsRef.current.delete(taskId);
      setOperationError(error instanceof Error ? error.message : "Could not stop this turn");
      return false;
    } finally {
      setStoppingTurn(false);
    }
  };

  /**
   * Pulls a user message back into the composer. Cancels an in-flight turn
   * first so Edit stays available mid-stream; the transcript tip is cleared
   * later, when the (possibly edited) prompt is sent again.
   */
  const editUserMessage = async (eventId: string, body: string) => {
    if (!activeTask || !activeDraftOwner) return;
    const taskId = activeTask.id;
    if (nativeTurnActive || optimisticTurnStarting || stoppingTurn) {
      const stopped = await stopTurn();
      if (!stopped) return;
    }
    const current = composerDraftStore.read(activeDraftOwner);
    const defaultPermission =
      localSettings["permissions.defaultProfile"] === "read-only" ||
      localSettings["permissions.defaultProfile"] === "ask" ||
      localSettings["permissions.defaultProfile"] === "full-access"
        ? localSettings["permissions.defaultProfile"]
        : "project-write";
    const defaultDelegation =
      localSettings["delegation.defaultMode"] === "manual" ||
      localSettings["delegation.defaultMode"] === "balanced" ||
      localSettings["delegation.defaultMode"] === "budget-first"
        ? localSettings["delegation.defaultMode"]
        : "off";
    const value: ComposerDraftValue = {
      prompt: body,
      attachments: current?.attachments ?? [],
      runtime: current?.runtime ?? activeTask.runtime ?? settingsDefaultRuntime,
      model: current?.model ?? activeTask.model ?? settingsDefaultModel,
      effort: current?.effort ?? activeTask.effort,
      permission: current?.permission ?? defaultPermission,
      delegation: current?.delegation ?? defaultDelegation,
      selectionStart: body.length,
      selectionEnd: body.length,
    };
    persistComposerDraft(composerDraftStore.update(activeDraftOwner, value));
    composerRestoreSequence.current += 1;
    setComposerRestore({ id: composerRestoreSequence.current, value });
    pendingEditRef.current = { taskId, eventId };
    setOperationStatus("Message returned to the composer");
  };

  const dispatchQueuedMessage = async (message: QueuedMessage, sendNow = false) => {
    if (!activeTask || message.taskId !== activeTask.id || activeProjectionUnavailable) return;
    if (sendNow) queuePausedTaskIdsRef.current.delete(message.taskId);
    const continuingPriority =
      priorityQueueIdRef.current === message.id && queueBusyIdRef.current === message.id;
    if (queueBusyIdRef.current && !continuingPriority) return;
    queueBusyIdRef.current = message.id;
    setQueueBusyId(message.id);
    setOperationError("");
    let waitingForStop = false;
    try {
      const dispatching = await bridge.setQueuedMessageDispatching(
        message.taskId,
        message.id,
        true,
      );
      setSnapshot((current) => ({
        ...current,
        queuedMessages: current.queuedMessages.map((candidate) =>
          candidate.id === dispatching.id ? dispatching : candidate,
        ),
      }));

      const turn = runtimeState?.taskId === activeTask.id ? runtimeState.turn : undefined;
      if (sendNow && turn?.status === "inProgress") {
        if (!message.nativeActionId && !message.contextReferences?.length) {
          const steered = await bridge.steerTurn(
            activeTask.id,
            turn.id,
            queuedMessagePrompt(message),
          );
          if (steered) {
            await bridge.takeQueuedMessage(message.taskId, message.id);
            await refreshTaskQueue(message.taskId);
            setOperationStatus("Message sent into the active turn");
            return;
          }
        }
        priorityQueueIdRef.current = message.id;
        waitingForStop = await stopTurn(true);
        if (!waitingForStop) throw new Error("The active turn could not be stopped");
        setOperationStatus("Stopping the current turn, then sending this message");
        return;
      }

      priorityQueueIdRef.current = "";
      const outcome = await sendTurn({
        prompt: queuedMessagePrompt(message),
        attachments: message.attachments,
        runtime: message.runtime,
        model: message.model,
        effort: message.effort,
        permission: message.permission,
        delegation: message.delegation,
        nativeActionId: message.nativeActionId,
        contextReferences: message.contextReferences,
      });
      if (outcome === "turn-active") {
        const lastProjectedSeq =
          runtimeState?.taskId === message.taskId ? runtimeState.lastSeq : -1;
        queueWaitingForActiveTurnByTaskRef.current.set(message.taskId, lastProjectedSeq);
        const queued = await bridge.setQueuedMessageDispatching(message.taskId, message.id, false);
        setSnapshot((current) => ({
          ...current,
          queuedMessages: current.queuedMessages.map((candidate) =>
            candidate.id === queued.id ? queued : candidate,
          ),
        }));
        setOperationStatus("Message queued");
        void reconcileTaskProjection(message.taskId, true);
        return;
      }
      if (outcome !== "started") throw new Error("The queued turn could not be started");
      if (nativeHost) {
        queueAwaitingTurnRef.current = {
          taskId: message.taskId,
          previousTurnId: turn?.id,
        };
      }
      await bridge.takeQueuedMessage(message.taskId, message.id);
      await refreshTaskQueue(message.taskId);
      setOperationStatus("Queued message sent");
    } catch (error) {
      await bridge
        .setQueuedMessageDispatching(message.taskId, message.id, false)
        .then((queued) => {
          setSnapshot((current) => ({
            ...current,
            queuedMessages: current.queuedMessages.map((candidate) =>
              candidate.id === queued.id ? queued : candidate,
            ),
          }));
        })
        .catch(() => undefined);
      priorityQueueIdRef.current = "";
      setOperationError(formatBridgeError(error, "The queued message could not be sent"));
    } finally {
      if (!waitingForStop) {
        queueBusyIdRef.current = "";
        setQueueBusyId("");
      }
    }
  };

  useEffect(() => {
    if (!activeTask || workspaceLoading) return;
    if (
      nativeHost &&
      (!projectionReady.current ||
        projectionTaskId.current !== activeTask.id ||
        readyProjectionTaskId !== activeTask.id)
    ) {
      return;
    }
    if (nativeHost && runtimeState?.taskId !== activeTask.id) return;
    const awaitingTurn = queueAwaitingTurnRef.current;
    if (awaitingTurn?.taskId === activeTask.id) {
      const turn = runtimeState?.turn;
      if (
        (turn?.status === "pending" || turn?.status === "inProgress") &&
        turn.id !== awaitingTurn.previousTurnId
      ) {
        queueAwaitingTurnRef.current = undefined;
      } else {
        return;
      }
    }
    const waitingAfterSeq = queueWaitingForActiveTurnByTaskRef.current.get(activeTask.id);
    if (waitingAfterSeq !== undefined) {
      const activeProjection = runtimeState?.taskId === activeTask.id ? runtimeState : undefined;
      const projectionAdvanced = (activeProjection?.lastSeq ?? -1) > waitingAfterSeq;
      const terminalProjection =
        !activeProjection?.turn ||
        activeProjection.turn.status === "completed" ||
        activeProjection.turn.status === "failed" ||
        activeProjection.turn.status === "interrupted";
      if (nativeTurnActive || (projectionAdvanced && terminalProjection)) {
        queueWaitingForActiveTurnByTaskRef.current.delete(activeTask.id);
      } else {
        return;
      }
    }
    if (nativeTurnActive || optimisticTurnStarting) return;
    const priorityId = priorityQueueIdRef.current;
    if (!priorityId && queuePausedTaskIdsRef.current.has(activeTask.id)) return;
    if (queueBusyIdRef.current && queueBusyIdRef.current !== priorityId) return;
    const message =
      (priorityId
        ? activeQueuedMessages.find((candidate) => candidate.id === priorityId)
        : undefined) ?? activeQueuedMessages.find((candidate) => candidate.state === "queued");
    if (!message) {
      if (priorityId) {
        priorityQueueIdRef.current = "";
        queueBusyIdRef.current = "";
        setQueueBusyId("");
      }
      return;
    }
    const timer = window.setTimeout(() => void dispatchQueuedMessage(message), 0);
    return () => window.clearTimeout(timer);
    // Dispatch is intentionally edge-triggered by durable queue and provider projection state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeQueuedMessages,
    activeTask?.id,
    nativeHost,
    nativeTurnActive,
    optimisticTurnStarting,
    readyProjectionTaskId,
    runtimeState?.taskId,
    workspaceLoading,
  ]);

  const focusComposer = () => {
    setScreen("workspace");
    window.setTimeout(
      () => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(),
      0,
    );
  };

  const copyConversation = async () => {
    const content = projectedTranscript
      .map((event) => {
        const label = event.title ? `${event.kind}: ${event.title}` : event.kind;
        return `[${event.timestamp}] ${label}\n${event.body}`;
      })
      .join("\n\n");
    if (!content) {
      setOperationError("There is no conversation content to copy yet");
      return;
    }
    try {
      await navigator.clipboard.writeText(content);
      setOperationStatus("Conversation copied to the clipboard");
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Could not copy the conversation");
    }
  };

  const reviewChanges = () => {
    setOperationError("");
    changeCenterView("review");
    if (nativeHost) {
      // Status may have been loaded before the active agent wrote anything.
      // Entering Review is the explicit freshness boundary.
      void refreshReview();
    } else if (activeFile) {
      selectFile(activeFile);
    }
  };

  // Sidebar open/close animation honors the app's motion preference and the
  // OS reduced-motion setting, mirroring effectiveMotionScale in theme.ts.
  const prefersReducedMotion = useReducedMotion();
  const motionScale =
    preferences.motion === "none"
      ? 0
      : preferences.motion === "reduced" ||
          (preferences.motion === "system" && prefersReducedMotion)
        ? 0.35
        : preferences.motionScale;
  // Work-pane surfaces. The pane owns tabs; App still owns the data behind them.
  const [railTabRequest, setRailTabRequest] = useState<{
    tab: "git" | "agents" | "files" | "usage";
    id: number;
  }>();
  const openWorkPaneLaunch = (kind: WorkPaneLaunchKind) => {
    if (kind === "review") return workPane.openReview();
    if (kind === "browser") {
      const owner = snapshot.activeTaskId ?? workPaneOwnerKey;
      void browser.open(owner).then((tab) => {
        if (tab) workPane.openBrowser(tab.id);
      });
      return;
    }
    setRightRailOpen(true);
    setRailTabRequest({ tab: kind === "files" ? "files" : "agents", id: Date.now() });
  };
  const renderWorkPaneFile = (surface: { path: string; revealLine: number | null }) => {
    const tab = openFileTabs.find((candidate) => candidate.path === surface.path);
    if (!tab) {
      return (
        <div className="route-loading" role="status" aria-live="polite">
          Opening {surface.path.split("/").at(-1)}…
        </div>
      );
    }
    return (
      <FileWorkspace
        key={tab.path}
        file={tab}
        target={activeFileLocation?.path === tab.path ? activeFileLocation : undefined}
        editable={nativeHost}
        onSave={(content) => saveFileTab(tab.path, content)}
        onExplainSelection={explainFileSelection}
        onAddComposerContext={addSelectionAsComposerContext}
        explainAgentLabel={runtimeLabel(explainRoute.runtime)}
      />
    );
  };
  const renderWorkPaneReview = () => (
    <ReviewSurface
      file={activeFile}
      viewMode={diffView}
      onViewModeChange={setDiffView}
      onRefresh={() => void refreshReview()}
      refreshing={reviewRefreshing}
      reviewedKeys={reviewedFiles}
      taskId={activeTask?.id}
      onMarkReviewed={(file) => {
        if (!activeTask) return;
        setReviewedFiles((current) => ({
          ...current,
          [`${activeTask.id}:${diffFileKey(file)}`]: true,
        }));
        setOperationStatus(`${file.path} marked reviewed for this session`);
      }}
      onAddSelection={(payload) => addSelectionToChat(payload, "diff")}
      loadError={reviewLoadError}
      onRetry={() => {
        setReviewLoadError(null);
        setReviewRetryVersion((current) => current + 1);
      }}
      onBack={() => workPane.close("review")}
    />
  );
  const renderWorkPaneBrowser = (tabId: string) => {
    const tab = browser.byId[tabId];
    if (!tab) {
      return (
        <div className="route-loading" role="status" aria-live="polite">
          Opening a browser tab…
        </div>
      );
    }
    return (
      <BrowserSurface
        tab={tab}
        message={browser.message}
        recording={browser.recordingTabId === tabId}
        annotating={browser.annotatingTabId === tabId}
        onBoundsChange={(rect) => browser.setBounds(tabId, rect)}
        onNavigate={(url) => browser.navigate(tabId, url)}
        onHistory={(action) => browser.history(tabId, action)}
        onScreenshot={() => browser.screenshot(tabId)}
        onRecordToggle={() => browser.toggleRecording(tabId)}
        onAnnotate={() => browser.toggleAnnotate(tabId)}
        onPopOut={(popped) => browser.setPoppedOut(tabId, popped)}
        onOpenExternally={() => browser.openExternally(tabId)}
        onClose={() => {
          workPane.close(`browser:${tabId}`);
          void browser.close(tabId);
        }}
      />
    );
  };
  const renderWorkPaneSubagent = (delegationId: string, headerHost: HTMLElement | null) => {
    const delegation = delegations.find((candidate) => candidate.id === delegationId);
    if (!delegation?.childTaskId) {
      return (
        <div className="route-loading" role="status" aria-live="polite">
          This subagent is no longer available.
        </div>
      );
    }
    return (
      <SubagentConversation
        key={delegation.id}
        delegation={delegation}
        headerTarget={headerHost}
        projectionCache={subagentProjectionCache}
        runtimes={snapshot.runtimes}
        contextFiles={contextFilePaths}
        onRequestContextFiles={requestProjectFiles}
        enterToSend={localSettings["composer.enterToSend"] !== false}
        autoResumeInterrupted={localSettings["general.autoResumeInterruptedTurns"] === true}
        rightRailOpen={rightRailOpen}
        terminalOpen={terminalOpen}
        onClose={() => workPane.close(`subagent:${delegation.id}`)}
        onSend={async (id: string, message: string, routing: DelegationRouting) => {
          await bridge.sendDelegationMessage(id, message, routing);
          await refreshDelegations(activeTaskIdRef.current);
        }}
        onStop={async (id) => {
          await bridge.stopDelegation(id);
          await refreshDelegations(activeTaskIdRef.current);
        }}
      />
    );
  };
  const workPaneAttention = delegations.some(
    (delegation) =>
      (delegation.pendingQuestions?.length ?? 0) > 0 &&
      workPane.state.surfaces.some(
        (surface) => surface.kind === "subagent" && surface.delegationId === delegation.id,
      ),
  );
  const panelTransition = {
    width: { duration: 0.34 * motionScale, ease: [0.33, 1, 0.15, 1] as const },
    opacity: { duration: 0.22 * motionScale, ease: "easeOut" as const },
  };
  // Cross-fade between the workspace, settings, and setup screens. Screens are
  // stacked absolutely inside .app-content so the outgoing one fades under the
  // incoming one instead of leaving a blank frame.
  const screenFade = {
    initial: motionScale === 0 ? false : ({ opacity: 0 } as const),
    animate: { opacity: 1 },
    exit: motionScale === 0 ? undefined : ({ opacity: 0 } as const),
    transition: { duration: 0.24 * motionScale, ease: "easeOut" as const },
  };
  const toggleTerminal = () => {
    setTerminalSurfaceActivated(true);
    setTerminalOpen((current) => !current);
  };
  const workspaceToggles = (
    <>
      <button
        className="icon-button subtle"
        type="button"
        onClick={toggleTerminal}
        aria-label="Toggle terminal"
        aria-pressed={terminalOpen}
      >
        <TerminalSquare />
      </button>
      <WorkPaneToggle
        open={workPane.state.open}
        alive={workPane.state.surfaces.length > 0}
        attention={workPaneAttention}
        onClick={() => workPane.toggle()}
      />
      <button
        className="icon-button subtle"
        type="button"
        onClick={() => setRightRailOpen((value) => !value)}
        aria-label={rightRailOpen ? "Close task tools" : "Open task tools"}
        aria-pressed={rightRailOpen}
      >
        {rightRailOpen ? <PanelRightClose /> : <PanelRightOpen />}
      </button>
    </>
  );
  const primarySidebar = (activeDestination: "chats" | "scheduled") => (
    <motion.div
      className="panel-slot panel-slot--left"
      key="chat-sidebar"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: "auto", opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={panelTransition}
    >
      <TaskSidebar
        projects={snapshot.projects}
        tasks={sidebarTasks}
        archivedTotal={archivedTotal}
        archivedLoading={archivedLoading}
        archivedHasMore={Boolean(archivedNextCursor)}
        onEnsureArchived={handleSidebarEnsureArchived}
        onLoadMoreArchived={handleSidebarLoadMoreArchived}
        activeProjectId={snapshot.activeProjectId}
        activeTaskId={snapshot.activeTaskId}
        metadataActionsEnabled={metadataActionsEnabled}
        taskActionBusyId={taskActionBusyId}
        onSearchMessages={handleSidebarSearchMessages}
        onSelectProject={handleSidebarSelectProject}
        onSelectTask={handleSidebarSelectTask}
        onNewTask={handleSidebarNewTask}
        onNewTaskInProject={handleSidebarNewTaskInProject}
        onOpenProject={handleSidebarOpenProject}
        openingProject={openingProject}
        onUpdateTask={handleSidebarUpdateTask}
        onCopyTask={handleSidebarCopyTask}
        onUpdateProject={handleSidebarUpdateProject}
        onDeleteProject={handleSidebarDeleteProject}
        onDeleteTask={handleSidebarDeleteTask}
        onDeleteArchivedChats={handleSidebarDeleteArchivedChats}
        onRevealTask={nativeHost ? revealSidebarTask : undefined}
        onResolveTaskFolder={nativeHost ? resolveSidebarTaskFolder : undefined}
        onRevealProject={nativeHost ? revealSidebarProject : undefined}
        onOpenSettings={handleSidebarOpenSettings}
        onOpenScheduled={handleSidebarOpenScheduled}
        onOpenCapabilities={handleSidebarOpenCapabilities}
        onOpenSubagents={handleSidebarOpenSubagents}
        activeDestination={activeDestination}
        onResize={handleSidebarResize}
        sidebarMenuDirection={preferences.sidebarMenuDirection}
      />
    </motion.div>
  );

  return (
    <LazyMotion features={domMax} strict>
      <div
        ref={appRootRef}
        className="app-root"
        data-sidebar-visible={
          (screen === "workspace" || screen === "scheduled") && !sidebarCollapsed
        }
        data-rail-visible={
          (screen === "workspace" && showRightRail) || (screen === "scheduled" && scheduledRailOpen)
        }
        data-subagent-visible={screen === "workspace" && subagentOpen}
        data-file-active={screen === "workspace" && Boolean(activeFileTab)}
        style={
          {
            "--sidebar-width": `${sidebarWidth}px`,
            "--right-rail-width": `${rightRailWidth}px`,
          } as CSSProperties
        }
      >
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <NativeTitlebar
          context={titleContext}
          title={
            screen === "workspace"
              ? (activeTask?.title ?? "New chat")
              : screen === "scheduled"
                ? "Scheduled"
                : undefined
          }
          titleActive={screen === "scheduled" || !activeFileTab}
          onTitleSelect={
            screen === "workspace"
              ? () => {
                  setActiveFileLocation(null);
                  changeCenterView("task");
                }
              : undefined
          }
          motionScale={motionScale}
          subagentHeaderRef={setSubagentHeaderTarget}
          detail={
            screen === "workspace" && activeProject ? (
              <>
                {activeProject.name} · {snapshot.git.branch}
              </>
            ) : screen === "scheduled" ? (
              <>Runs locally while Integrator is open</>
            ) : undefined
          }
          leading={
            screen === "workspace" || screen === "scheduled" ? (
              <button
                className="icon-button subtle"
                type="button"
                onClick={() => setSidebarCollapsed((value) => !value)}
                aria-label={sidebarCollapsed ? "Open chat navigation" : "Close chat navigation"}
              >
                {sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
              </button>
            ) : undefined
          }
          tabs={
            screen === "workspace" && !subagentOpen && activeTask?.kind !== "chat" ? (
              <div className="titlebar-view-tabs" role="tablist" aria-label="Task view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={centerView === "task"}
                  data-active={centerView === "task"}
                  onClick={() => changeCenterView("task")}
                >
                  {centerView === "task" ? (
                    <SlidingTabIndicator layoutId="workspace-view-tab-indicator" />
                  ) : null}
                  Task
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-label="Review"
                  aria-selected={centerView === "review"}
                  data-active={centerView === "review"}
                  onClick={reviewChanges}
                >
                  {centerView === "review" ? (
                    <SlidingTabIndicator layoutId="workspace-view-tab-indicator" />
                  ) : null}
                  Review{snapshot.git.files.length ? ` ${snapshot.git.files.length}` : ""}
                </button>
              </div>
            ) : undefined
          }
          trailing={
            screen === "scheduled" ? (
              <>
                <button
                  className="scheduled-titlebar-new"
                  type="button"
                  onClick={() => setScheduledCreateRequest((current) => current + 1)}
                >
                  New
                </button>
                <button
                  className="icon-button subtle"
                  type="button"
                  onClick={() => setScheduledRailOpen((open) => !open)}
                  aria-label={
                    scheduledRailOpen
                      ? "Close scheduled task details"
                      : "Open scheduled task details"
                  }
                  aria-pressed={scheduledRailOpen}
                >
                  {scheduledRailOpen ? <PanelRightClose /> : <PanelRightOpen />}
                </button>
              </>
            ) : screen === "workspace" && !subagentOpen ? (
              <>
                <Tooltip label={usagePillTitle} placement="bottom">
                  <button className="usage-compact" type="button" aria-label={usagePillTitle}>
                    {usagePillPercent !== undefined ? (
                      <strong>{Math.round(usagePillPercent)}%</strong>
                    ) : null}
                    <span>{formatCompactTokenCount(displayedUsage.tokens)}</span>
                    <span className="sr-only"> tokens</span>
                  </button>
                </Tooltip>
                {activeTask?.kind !== "chat" ? workspaceToggles : null}
              </>
            ) : undefined
          }
          onOpenProject={() => setAddProjectOpen(true)}
          onNewChat={() => void newTask()}
          onFocusComposer={focusComposer}
          onCopyConversation={() => void copyConversation()}
          onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
          onToggleTaskTools={() => {
            if (screen === "scheduled") {
              setScheduledRailOpen((value) => !value);
              return;
            }
            setRightRailOpen((value) => !value);
          }}
          onToggleTerminal={() => {
            toggleTerminal();
          }}
          onOpenNewWindow={() => {
            if (snapshot.activeTaskId) void bridge.openTaskWindow?.(snapshot.activeTaskId);
          }}
          onReviewChanges={reviewChanges}
          onOpenSettings={handleSidebarOpenSettings}
          onOpenSetup={() => setScreen("setup")}
        />
        <div
          className="app-content"
          style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
        >
          <AnimatePresence initial={false}>
            {screen === "settings" ? (
              <motion.div key="screen-settings" className="app-screen" {...screenFade}>
                <Suspense
                  fallback={
                    <div className="route-loading" role="status" aria-live="polite">
                      Loading Settings…
                    </div>
                  }
                >
                  <SettingsView
                    preferences={preferences}
                    runtimes={snapshot.runtimes}
                    usage={displayedUsage}
                    projects={snapshot.projects}
                    tasks={sidebarTasks}
                    taskActionBusyId={taskActionBusyId}
                    onOpenTask={(taskId) => {
                      setScreen("workspace");
                      void selectTask(taskId);
                    }}
                    onUpdateTask={(taskId, patch) => void updateTaskMetadata(taskId, patch)}
                    onUpdateProject={(projectId, patch) =>
                      void updateProjectMetadata(projectId, patch)
                    }
                    onDeleteTask={(taskId) => {
                      setDeleteTaskError("");
                      setDeleteTaskId(taskId);
                    }}
                    onDeleteProject={(projectId) => {
                      setDeleteProjectError("");
                      setDeleteProjectId(projectId);
                    }}
                    onDeleteArchivedChats={(projectId) => {
                      setDeleteArchivedChatsError("");
                      void ensureArchivedCatalog().then(() =>
                        setDeleteArchivedChatsProjectId(projectId),
                      );
                    }}
                    onEnsureArchived={() => void ensureArchivedCatalog()}
                    onLoadMoreArchived={() => void ensureArchivedCatalog({ more: true })}
                    archivedHasMore={Boolean(archivedNextCursor)}
                    archivedLoading={archivedLoading}
                    onChangePreferences={setTheme}
                    onResetPreferences={resetTheme}
                    runtimeActionRequest={runtimeActionRequest}
                    initialSection={settingsSection}
                    onRefreshRuntimes={refreshRuntimes}
                    onSettingChanged={handleLocalSettingChanged}
                    onBack={() => setScreen("workspace")}
                  />
                </Suspense>
              </motion.div>
            ) : null}
            {screen === "scheduled" ? (
              <motion.div key="screen-scheduled" className="app-screen" {...screenFade}>
                <main
                  className="app-shell"
                  id="main-content"
                  data-sidebar-collapsed={sidebarCollapsed}
                  data-rail-open={scheduledRailOpen}
                  style={
                    {
                      "--right-rail-width": `${rightRailWidth}px`,
                    } as CSSProperties
                  }
                >
                  <AnimatePresence initial={false}>
                    {!sidebarCollapsed ? primarySidebar("scheduled") : null}
                  </AnimatePresence>
                  <Suspense
                    fallback={
                      <div className="route-loading" role="status" aria-live="polite">
                        Loading Scheduled…
                      </div>
                    }
                  >
                    <ScheduledView
                      createRequest={scheduledCreateRequest}
                      railOpen={scheduledRailOpen}
                      onRailOpenChange={setScheduledRailOpen}
                      rightRailWidth={rightRailWidth}
                      onResizeRail={(delta) =>
                        setRightRailWidth((current) => clampDimension(current - delta, 300, 520))
                      }
                      motionScale={motionScale}
                      projects={snapshot.projects}
                      tasks={snapshot.tasks}
                      runtimes={snapshot.runtimes}
                      activeTaskId={snapshot.activeTaskId}
                      defaultRoute={{
                        runtime: settingsDefaultRuntime,
                        model: settingsDefaultModel,
                        ...(settingsDefaultRoute.effort
                          ? { effort: settingsDefaultRoute.effort }
                          : {}),
                      }}
                      onOpenTask={(taskId) => {
                        setScreen("workspace");
                        void selectTask(taskId);
                      }}
                      onTaskCreated={(task) => {
                        // Register the schedule's chat without stealing focus
                        // from the Scheduled screen.
                        setSnapshot((current) => ({
                          ...current,
                          tasks: [task, ...current.tasks.filter((item) => item.id !== task.id)],
                        }));
                      }}
                    />
                  </Suspense>
                </main>
              </motion.div>
            ) : null}
            {screen === "setup" ? (
              <motion.div key="screen-setup" className="app-screen" {...screenFade}>
                <Suspense
                  fallback={
                    <div className="route-loading" role="status" aria-live="polite">
                      Loading Setup…
                    </div>
                  }
                >
                  <SetupView
                    runtimes={snapshot.runtimes}
                    onBack={() => setScreen("workspace")}
                    onRuntimeAction={openRuntimeAction}
                    onCreateProject={() => {
                      setScreen("workspace");
                      setAddProjectOpen(true);
                    }}
                    onFinish={() => setScreen("workspace")}
                  />
                </Suspense>
              </motion.div>
            ) : null}
            {screen === "workspace" ? (
              <motion.div key="screen-workspace" className="app-screen" {...screenFade}>
                <main
                  className="app-shell"
                  id="main-content"
                  data-sidebar-collapsed={sidebarCollapsed}
                  data-rail-open={showRightRail}
                  style={
                    {
                      "--right-rail-width": `${rightRailWidth}px`,
                    } as CSSProperties
                  }
                >
                  {/* Collapsed means fully hidden; the header's corner button is the
                one control that opens it back up. The slot animates the reveal
                while the sidebar keeps its full width, so content slides
                instead of reflowing. */}
                  <AnimatePresence initial={false}>
                    {!sidebarCollapsed ? primarySidebar("chats") : null}
                  </AnimatePresence>
                  <div
                    ref={conversationWorkspaceRef}
                    className="conversation-workspace"
                    data-subagent-open={subagentOpen}
                  >
                    <div className="conversation-workspace-row">
                      <section className="workspace-main">
                        <div className="workspace-announcements">
                          {operationError ? (
                            <div
                              className="operation-message operation-message--error"
                              role="alert"
                            >
                              <span className="operation-message-text">{operationError}</span>
                              <Tooltip label="Dismiss error" placement="top">
                                <button
                                  className="operation-message-dismiss"
                                  type="button"
                                  aria-label="Dismiss operation error"
                                  onClick={() => setOperationError("")}
                                >
                                  <X aria-hidden="true" />
                                </button>
                              </Tooltip>
                            </div>
                          ) : null}
                          {operationStatus ? (
                            <div className="sr-only" role="status" aria-live="polite">
                              {operationStatus}
                            </div>
                          ) : null}
                        </div>
                        <div className="workspace-content" aria-busy={Boolean(switchingTaskId)}>
                          {workspaceLoading ? (
                            <div className="route-loading" role="status" aria-live="polite">
                              Loading your local workspace…
                            </div>
                          ) : !activeProject && !activeTask ? (
                            <EmptyProjectState
                              busy={openingProject}
                              onOpenProject={() => setAddProjectOpen(true)}
                            />
                          ) : (
                            <>
                              <div className="transcript-scroll" ref={transcriptScrollRef}>
                                {nativeHost && runtimeState && !activeProjectionUnavailable ? (
                                  <ConnectionNotice
                                    state={runtimeState.connection}
                                    runtime={runtimeLabel(
                                      activeTask?.runtime ?? settingsDefaultRuntime,
                                    )}
                                    resuming={Boolean(
                                      activeTask && resumingTaskId === activeTask.id,
                                    )}
                                    quietReconciling={Boolean(
                                      activeTask &&
                                      (freshTaskIds.has(activeTask.id) ||
                                        // A task with no persisted events (a new or
                                        // restored draft chat) has nothing to
                                        // reconcile; freshTaskIds only covers tasks
                                        // created in this session.
                                        (runtimeState.lastSeq === 0 &&
                                          runtimeState.items.length === 0 &&
                                          !runtimeState.turn)),
                                    )}
                                    showDisconnected={nativeTurnActive || optimisticTurnStarting}
                                  />
                                ) : null}
                                {activeTask && isPendingGeneralChat(activeTask) ? (
                                  <ChatWelcome
                                    name={
                                      typeof localSettings["personalization.name"] === "string"
                                        ? localSettings["personalization.name"]
                                        : ""
                                    }
                                  />
                                ) : activeTask ? (
                                  <Suspense
                                    fallback={
                                      <div
                                        className="route-loading"
                                        role="status"
                                        aria-live="polite"
                                      >
                                        Loading task…
                                      </div>
                                    }
                                  >
                                    <Transcript
                                      key={activeTask?.id ?? "draft"}
                                      ownerKey={`task:${activeTask.id}`}
                                      events={projectedTranscript}
                                      scrollContainerRef={transcriptScrollRef}
                                      running={nativeTurnActive || optimisticTurnStarting}
                                      hasMoreOlder={runtimeState?.hasMoreOlder}
                                      onLoadOlder={
                                        activeTask
                                          ? () => void loadOlderTaskProjection(activeTask.id)
                                          : undefined
                                      }
                                      modelForEvent={
                                        localSettings["transcript.showModel"] !== false
                                          ? (event) =>
                                              prettyModelLabel(
                                                eventModels[event.id] ?? activeTask.model,
                                              ) || undefined
                                          : undefined
                                      }
                                      showTimestamps={
                                        localSettings["transcript.showTimestamps"] !== false
                                      }
                                      onRegenerate={
                                        activeProjectionUnavailable
                                          ? undefined
                                          : (eventId) => void regenerateFrom(eventId)
                                      }
                                      onBranch={
                                        activeProjectionUnavailable
                                          ? undefined
                                          : (eventId) => void forkTask(activeTask.id, eventId)
                                      }
                                      onEditUserMessage={
                                        activeProjectionUnavailable
                                          ? undefined
                                          : (eventId, body) => void editUserMessage(eventId, body)
                                      }
                                      onCancelScheduledTask={(automationId) =>
                                        void cancelScheduledTask(automationId)
                                      }
                                      onOpenFile={openTranscriptFile}
                                      onAddDiffSelection={(payload) =>
                                        addSelectionToChat(payload, "diff")
                                      }
                                      isDiffApproved={(file) =>
                                        Boolean(
                                          activeTask &&
                                          reviewedFiles[`${activeTask.id}:${diffFileKey(file)}`],
                                        )
                                      }
                                      onApproveDiff={(file) => {
                                        if (!activeTask) return;
                                        setReviewedFiles((current) => ({
                                          ...current,
                                          [`${activeTask.id}:${diffFileKey(file)}`]: true,
                                        }));
                                        setOperationStatus(
                                          `${file.path} marked reviewed for this session`,
                                        );
                                      }}
                                      diffCommitState={diffCommitState}
                                    />
                                  </Suspense>
                                ) : activeProject ? (
                                  <EmptyTaskState project={activeProject} />
                                ) : null}
                              </div>
                              <AnimatePresence initial={false}>
                                {activeTask &&
                                (nativeTurnActive ||
                                  optimisticTurnStarting ||
                                  visibleQueuedMessages.length > 0 ||
                                  Boolean(showRecoveryControl)) ? (
                                  <TaskStatusPill
                                    key="task-status-pill"
                                    runningSince={taskStatusRunningSince}
                                    usage={runtimeUsage}
                                    activeAgentCount={activeAgentCount}
                                    recovery={
                                      showRecoveryControl ? (
                                        <div className="turn-recovery-control" role="status">
                                          <span>
                                            <strong>Response interrupted</strong>
                                            <small>
                                              {recoveryError ||
                                                "The provider can continue from its last safe boundary."}
                                            </small>
                                          </span>
                                          <button
                                            type="button"
                                            disabled={resumingTaskId === activeTask.id}
                                            onClick={() => void resumeInterruptedTurn()}
                                          >
                                            {resumingTaskId === activeTask.id
                                              ? "Resuming…"
                                              : "Resume"}
                                          </button>
                                        </div>
                                      ) : undefined
                                    }
                                    queue={
                                      visibleQueuedMessages.length > 0 ? (
                                        <QueuedMessages
                                          messages={visibleQueuedMessages}
                                          busyId={queueBusyId || undefined}
                                          disabled={
                                            Boolean(queueBusyId) || activeProjectionUnavailable
                                          }
                                          onSendNow={(messageId) => {
                                            const message = visibleQueuedMessages.find(
                                              (candidate) => candidate.id === messageId,
                                            );
                                            if (message) void dispatchQueuedMessage(message, true);
                                          }}
                                          onReturnToComposer={(messageId) =>
                                            void restoreQueuedMessage(messageId)
                                          }
                                          onDelete={(messageId) =>
                                            void deleteQueuedMessage(messageId)
                                          }
                                          onReorder={(orderedIds) =>
                                            void reorderQueuedMessages(orderedIds)
                                          }
                                        />
                                      ) : undefined
                                    }
                                  />
                                ) : null}
                              </AnimatePresence>
                              {visiblePendingApproval ? (
                                <ApprovalControl
                                  approval={visiblePendingApproval}
                                  busy={respondingApprovalId === visiblePendingApproval.id}
                                  autoApproving={false}
                                  runtime={activeTask?.runtime}
                                  onDecision={(decision) =>
                                    void respondToApproval(visiblePendingApproval, decision)
                                  }
                                  onSelectOption={(option) =>
                                    void respondToQuestion(visiblePendingApproval, option)
                                  }
                                />
                              ) : null}
                              <Composer
                                key={
                                  activeTask && promotingDraftTaskId !== activeTask.id
                                    ? activeTask.id
                                    : `draft-${activeProject?.id ?? "chat"}-${newChatDraftKey}`
                                }
                                chatMode={activeTask?.kind === "chat"}
                                taskId={activeTask?.id}
                                runtimes={snapshot.runtimes}
                                defaultRuntime={activeTask?.runtime ?? settingsDefaultRuntime}
                                defaultModel={activeTask?.model ?? settingsDefaultModel}
                                defaultEffort={activeTask?.effort ?? settingsDefaultRoute.effort}
                                runtimeDefaults={composerRuntimeDefaults}
                                defaultPermission={activeTaskPermission}
                                defaultDelegation={
                                  localSettings["delegation.defaultMode"] === "manual" ||
                                  localSettings["delegation.defaultMode"] === "balanced" ||
                                  localSettings["delegation.defaultMode"] === "budget-first"
                                    ? localSettings["delegation.defaultMode"]
                                    : "off"
                                }
                                enterToSend={localSettings["composer.enterToSend"] !== false}
                                initialDraft={activeComposerDraftWithPermission}
                                onDraftChange={(value) => {
                                  updateActiveComposerDraft(value);
                                }}
                                onDraftSubmit={updateActiveComposerDraft}
                                contextFiles={activeTask?.kind === "chat" ? [] : contextFilePaths}
                                contextChats={snapshot.tasks.filter(
                                  (task) =>
                                    task.kind === "chat" &&
                                    !task.archived &&
                                    task.id !== activeTask?.id,
                                )}
                                onRequestContextFiles={
                                  activeTask?.kind === "chat" ? undefined : requestProjectFiles
                                }
                                workingDirectory={activeTask?.worktree ?? activeProject?.path ?? ""}
                                insertRequest={composerInsert}
                                onInsertHandled={(id) =>
                                  setComposerInsert((current) =>
                                    current?.id === id ? null : current,
                                  )
                                }
                                attachmentRequest={composerAttachment}
                                onAttachmentHandled={(id) =>
                                  setComposerAttachment((current) =>
                                    current?.id === id ? null : current,
                                  )
                                }
                                restoreRequest={composerRestore}
                                onRestoreHandled={(id) =>
                                  setComposerRestore((current) =>
                                    current?.id === id ? null : current,
                                  )
                                }
                                notices={composerNotices}
                                running={
                                  Boolean(activeTask) &&
                                  runtimeState?.taskId === activeTask?.id &&
                                  !activeProjectionUnavailable &&
                                  (runtimeState?.turn?.status === "pending" ||
                                    runtimeState?.turn?.status === "inProgress")
                                }
                                stopping={stoppingTurn}
                                onStop={() => void stopTurn()}
                                sendDisabled={activeProjectionUnavailable}
                                onSend={submitComposerTurn}
                                sessionModes={
                                  activeTask?.kind !== "chat" &&
                                  !activeProjectionUnavailable &&
                                  activeTask?.runtime === "cursor"
                                    ? activeRuntimeState?.mode
                                    : undefined
                                }
                                onSessionModeChange={
                                  activeTask && !activeProjectionUnavailable
                                    ? (modeId) =>
                                        void bridge
                                          .setSessionMode(activeTask.id, modeId)
                                          .catch((error) => {
                                            setOperationError(
                                              error instanceof Error
                                                ? error.message
                                                : "Could not switch the agent mode",
                                            );
                                          })
                                    : undefined
                                }
                                routingDisabled={activeProjectionUnavailable}
                                permissionDisabled={
                                  activeProjectionUnavailable || activeTask?.kind === "chat"
                                }
                                delegationDisabled={
                                  activeProjectionUnavailable || activeTask?.kind === "chat"
                                }
                                permissionRequest={
                                  permissionRequest?.taskId === activeTask?.id
                                    ? permissionRequest
                                    : null
                                }
                                onPermissionChange={
                                  activeTask
                                    ? (permission) => {
                                        setTaskPermissions((current) => ({
                                          ...current,
                                          [activeTask.id]: permission,
                                        }));
                                        setPermissionRequest((current) =>
                                          current?.taskId === activeTask.id ? null : current,
                                        );
                                      }
                                    : undefined
                                }
                                onRoutingChange={
                                  activeTask
                                    ? (routing) => {
                                        if (nativeTurnActive || optimisticTurnStarting) return;
                                        setSnapshot((current) => ({
                                          ...current,
                                          tasks: current.tasks.map((task) =>
                                            task.id === activeTask.id
                                              ? {
                                                  ...task,
                                                  runtime: routing.runtime,
                                                  model: routing.model,
                                                  effort: routing.effort,
                                                }
                                              : task,
                                          ),
                                        }));
                                        void bridge
                                          .updateTaskRouting?.(activeTask.id, routing)
                                          .catch(() => {
                                            setOperationError(
                                              "Could not save provider selection for this chat",
                                            );
                                          });
                                      }
                                    : undefined
                                }
                              />
                            </>
                          )}
                        </div>
                      </section>
                      <AnimatePresence initial={false}>
                        {subagentOpen ? (
                          <WorkPane
                            key="work-pane"
                            controller={workPane}
                            headerTarget={subagentHeaderTarget}
                            paneRef={subagentPaneRef}
                            rowRef={conversationWorkspaceRef}
                            panelTransition={panelTransition}
                            delegations={delegations}
                            browserAvailable={browser.available}
                            browserTitles={Object.fromEntries(
                              browser.tabs.map((tab) => [
                                tab.id,
                                tab.title || tab.url.replace(/^https?:\/\//, ""),
                              ]),
                            )}
                            renderBrowser={renderWorkPaneBrowser}
                            trailing={activeTask?.kind !== "chat" ? workspaceToggles : null}
                            onLaunch={openWorkPaneLaunch}
                            renderFile={renderWorkPaneFile}
                            renderReview={renderWorkPaneReview}
                            renderSubagent={renderWorkPaneSubagent}
                          />
                        ) : null}
                      </AnimatePresence>
                    </div>
                    {activeProject && terminalSurfaceActivated ? (
                      <Suspense
                        fallback={
                          <div className="terminal-drawer terminal-loading" role="status">
                            Loading terminal…
                          </div>
                        }
                      >
                        <TerminalDrawer
                          key={activeProject.id}
                          open={terminalOpen}
                          project={activeProject}
                          onClose={() => setTerminalOpen(false)}
                          motionScale={motionScale}
                        />
                      </Suspense>
                    ) : null}
                  </div>
                  <SlidingPanelSlot
                    open={showRightRail}
                    motionScale={motionScale}
                    slotKey="task-tools"
                  >
                    <Suspense
                      fallback={
                        <aside
                          className="right-rail rail-loading"
                          aria-label="Task tools"
                          aria-busy="true"
                        >
                          Loading task tools…
                        </aside>
                      }
                    >
                      <RightRail
                        git={snapshot.git}
                        gitLoading={gitLoading}
                        children={snapshot.children}
                        delegations={nativeHost ? delegations : undefined}
                        onRequestDelegations={nativeHost ? requestActiveDelegations : undefined}
                        selectedDelegationId={selectedDelegation?.id}
                        requestedTab={railTabRequest}
                        onSelectDelegation={(delegationId) => {
                          workPane.openSubagent(delegationId);
                        }}
                        onApproveDelegation={async (delegationId) => {
                          await bridge.approveDelegation(delegationId);
                          await refreshDelegations(activeTaskIdRef.current);
                        }}
                        onDenyDelegation={async (delegationId) => {
                          await bridge.denyDelegation(delegationId);
                          await refreshDelegations(activeTaskIdRef.current);
                        }}
                        onNudgeDelegation={async (delegationId, message) => {
                          await bridge.sendDelegationMessage(delegationId, message);
                          await refreshDelegations(activeTaskIdRef.current);
                        }}
                        onStopDelegation={async (delegationId) => {
                          await bridge.stopDelegation(delegationId);
                          await refreshDelegations(activeTaskIdRef.current);
                        }}
                        usage={displayedUsage}
                        runtime={activeTask?.runtime}
                        subscription={activeQuota}
                        activeFile={activeFile}
                        projectId={activeProject?.id}
                        projectFiles={projectFiles}
                        projectFilesState={projectFilesState}
                        onRequestProjectFiles={requestProjectFiles}
                        onSelectFile={selectFile}
                        onOpenFile={(file) => void openFileInCanvas(file)}
                        activeFilePath={activeFileTabPath}
                        openingFilePath={fileTabOpeningPath}
                        onRenameProjectFile={renameProjectFile}
                        onDuplicateProjectFile={nativeHost ? duplicateProjectFile : undefined}
                        onResolveProjectAbsolutePath={
                          nativeHost ? resolveProjectAbsolutePath : undefined
                        }
                        onMentionProjectFile={mentionProjectFile}
                        onMentionProjectFolder={mentionProjectFolder}
                        fileOpeners={projectFileOpeners}
                        onOpenGitFileExternal={nativeHost ? openGitFileExternal : undefined}
                        onRevealGitFile={nativeHost ? revealGitFile : undefined}
                        onOpenProjectFileExternal={nativeHost ? openProjectPathExternal : undefined}
                        onRevealProjectFile={nativeHost ? revealProjectPath : undefined}
                        onStageFile={stageFile}
                        onStageFiles={async (paths, staged) => {
                          if (activeTask) {
                            const git = await bridge.stageFiles(activeTask.id, paths, staged);
                            applyTaskGitSnapshot(activeTask.id, git);
                            return;
                          }
                          if (!activeProject) return;
                          const projectId = activeProject.id;
                          const git = await bridge.stageProjectFiles(projectId, paths, staged);
                          setSnapshot((current) =>
                            current.activeProjectId === projectId && !current.activeTaskId
                              ? { ...current, git }
                              : current,
                          );
                        }}
                        onCommit={commit}
                        onGenerateCommitMessage={
                          nativeHost && activeTask ? generateCommitMessage : undefined
                        }
                        onPush={push}
                        onReviewChanges={reviewChanges}
                        onRefreshGit={refreshGit}
                        onInitializeGit={initializeProjectGit}
                        onAddRemote={addGitRemote}
                        onUpdateRemote={updateGitRemote}
                        onRemoveRemote={removeGitRemote}
                        onFetch={fetchGit}
                        onPull={pullGit}
                        onPublishBranch={publishGitBranch}
                        onPublishGithub={publishGithubRepository}
                        onLoadMoreGitHistory={loadMoreGitHistory}
                        onResize={(delta) =>
                          setRightRailWidth((current) => clampDimension(current - delta, 300, 520))
                        }
                      />
                    </Suspense>
                  </SlidingPanelSlot>
                </main>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
        {addProjectOpen ? (
          <AddProjectModal
            busy={openingProject}
            error={createProjectError}
            onClose={() => {
              setAddProjectOpen(false);
              setCreateProjectError("");
            }}
            onOpenExisting={() => void openExistingProject()}
            onCreateNew={(name) => void createNewProject(name)}
            onClone={(input) => void cloneProject(input)}
          />
        ) : null}
        <DeleteProjectModal
          project={deleteProjectTarget ?? null}
          busy={deleteProjectBusy}
          error={deleteProjectError}
          onClose={() => {
            if (deleteProjectBusy) return;
            setDeleteProjectId("");
            setDeleteProjectError("");
          }}
          onConfirm={(scope) => void confirmDeleteProject(scope)}
        />
        <DeleteChatModal
          task={deleteTaskTarget ?? null}
          busy={deleteTaskBusy}
          error={deleteTaskError}
          onClose={() => {
            if (deleteTaskBusy) return;
            setDeleteTaskId("");
            setDeleteTaskError("");
          }}
          onConfirm={() => void confirmDeleteTask()}
        />
        <DeleteArchivedChatsModal
          project={deleteArchivedChatsTarget ?? null}
          chatCount={deleteArchivedChatsCount}
          busy={deleteArchivedChatsBusy}
          error={deleteArchivedChatsError}
          onClose={() => {
            if (deleteArchivedChatsBusy) return;
            setDeleteArchivedChatsProjectId("");
            setDeleteArchivedChatsError("");
          }}
          onConfirm={() => void confirmDeleteArchivedChats()}
        />
      </div>
    </LazyMotion>
  );
}
