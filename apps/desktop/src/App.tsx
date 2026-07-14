import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  AnimatePresence,
  LazyMotion,
  // domMax, not domAnimation: layout animations (the traveling selection
  // pill's layoutId) are only included in the max feature bundle.
  domMax,
  m as motion,
  useReducedMotion,
} from "motion/react";
import {
  ArrowRight,
  CircleStop,
  ClipboardList,
  Download,
  FileDiff,
  FolderOpen,
  FolderPlus,
  Github,
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
  CHAT_TITLE_PLACEHOLDER,
  draftOwnerKey,
  formatBridgeError,
  type ApprovalDecision,
  type ApprovalProjection,
  type ComposerDraft,
  type ComposerDraftOwner,
  type ComposerDraftValue,
  type CloneProjectInput,
  type DelegationView,
  type DelegationRouting,
  type DiffFile,
  type GitSnapshot,
  type GithubRepositoryCatalog,
  type NativeActionReference,
  type ProjectFileContent,
  type ProjectFileEntry,
  type ProjectFileOpener,
  type ProjectSummary,
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
import {
  composerNoticeExpiry,
  isRuntimeHealthError,
  isRuntimeUpdateRequired,
  type ComposerNotice,
} from "./composerNotices";
import { ComposerDraftStore } from "./composerDraftStore";
import type { RuntimeActionRequest } from "./components/SettingsView";
import { createDemoSnapshot, createEmptySnapshot, type WorkspaceSnapshot } from "./demoData";
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
import { TaskStatusPill } from "./components/TaskStatusPill";
import { formatCompactTokenCount } from "./components/conversationFormatting";
import { ResizeHandle } from "./components/ResizeHandle";
import { TaskSidebar } from "./components/TaskSidebar";
import {
  applyRuntimeProjection,
  createRuntimeProjectionState,
  runtimeTranscript,
  taskActivityUpdate,
  type RuntimeProjectionState,
} from "./runtimeProjection";
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

const DiffView = lazy(() =>
  import("./components/DiffView").then((module) => ({
    default: module.DiffView,
  })),
);
const TerminalDrawer = lazy(() =>
  import("./components/TerminalDrawer").then((module) => ({
    default: module.TerminalDrawer,
  })),
);
const EVENT_MODELS_STORAGE_KEY = "integrator.transcript.eventModels";

/** Brand-cased words for turning raw model ids into display labels. */
const MODEL_LABEL_WORDS: Record<string, string> = {
  gpt: "GPT",
  glm: "GLM",
  oss: "OSS",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
  deepseek: "DeepSeek",
  codex: "Codex",
  sonnet: "Sonnet",
  haiku: "Haiku",
  opus: "Opus",
  flash: "Flash",
  pro: "Pro",
  mini: "mini",
  nano: "nano",
};

function formatModelLabel(modelId?: string): string {
  if (!modelId || modelId === "Provider default") return "";
  return modelId
    .split(/(\s+|-)/)
    .map((token) => MODEL_LABEL_WORDS[token.toLowerCase()] ?? token)
    .join("");
}

function runtimeLabel(runtime: RuntimeId): string {
  return {
    codex: "Codex",
    cursor: "Cursor",
    claude: "Claude Code",
    grok: "Grok Build",
    antigravity: "Antigravity",
    custom: "Custom ACP",
  }[runtime];
}

const SettingsView = lazy(() =>
  import("./components/SettingsView").then((module) => ({
    default: module.SettingsView,
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

type Screen = "workspace" | "settings" | "setup";
type CenterView = "task" | "review";

function ReviewEmptyState({
  onBack,
  onRefresh,
  refreshing = false,
}: {
  onBack: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return (
    <section className="review-empty" aria-label="Review changes">
      <div className="review-empty-icon">
        <FileDiff />
      </div>
      <h2>No changes to review</h2>
      <p>When the agent or you change this worktree, the unified review will appear here.</p>
      <div className="review-empty-actions">
        {onRefresh ? (
          <button
            className="secondary-button"
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? "Checking…" : "Check again"}
          </button>
        ) : null}
        <button className="secondary-button" type="button" onClick={onBack}>
          Back to task
        </button>
      </div>
    </section>
  );
}

function ReviewLoadErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="review-empty" aria-label="Review unavailable">
      <div className="review-empty-icon">
        <FileDiff />
      </div>
      <h2>Could not load this diff</h2>
      <p role="alert">{message}</p>
      <button className="secondary-button" type="button" onClick={onRetry}>
        Retry
      </button>
    </section>
  );
}

interface ComposerErrorState {
  id: string;
  taskId: string;
  message: string;
}

const SIDEBAR_WIDTH_STORAGE_KEY = "aiintegrator.sidebar-width.v1";
const RIGHT_RAIL_WIDTH_STORAGE_KEY = "aiintegrator.right-rail-width.v1";
const SUBAGENT_PANE_RATIO_STORAGE_KEY = "aiintegrator.subagent-pane-ratio.v1";
const GIT_CACHE_TTL_MS = 5_000;

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
  return value === "settings" || value === "setup" ? value : "workspace";
}

function initialCenterView(): CenterView {
  if (typeof window === "undefined") return "task";
  return new URLSearchParams(window.location.search).get("view") === "review" ? "review" : "task";
}

function NativeTitlebar({
  context,
  title,
  detail,
  leading,
  tabs,
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
  onReviewChanges,
  onOpenSettings,
  onOpenSetup,
}: {
  context: string;
  title?: string;
  detail?: ReactNode;
  leading?: ReactNode;
  tabs?: ReactNode;
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
      <div className="titlebar-subagent-slot" ref={subagentHeaderRef} />
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
        </div>
        {title ? (
          <motion.div
            className="titlebar-title"
            layout="position"
            transition={{
              layout: {
                duration: 0.34 * motionScale,
                ease: [0.33, 1, 0.15, 1] as const,
              },
            }}
          >
            {leading}
            <h1>
              <motion.span
                className="titlebar-title-copy"
                key={title}
                initial={motionScale === 0 ? false : { opacity: 0, y: 2, filter: "blur(2px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                transition={{ duration: 0.2 * motionScale, ease: [0.2, 0, 0, 1] }}
              >
                {title}
              </motion.span>
            </h1>
            {detail ? <span className="titlebar-title-detail">{detail}</span> : null}
          </motion.div>
        ) : null}
      </div>
      {tabs || title ? null : <div className="titlebar-context">{context}</div>}
      <div className="titlebar-end">
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
                <strong title={parent}>{parent || "Loading default location…"}</strong>
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
      <p>
        Describe what you want done. Every task is saved locally first, so nothing is lost if the
        agent disconnects mid-run.
      </p>
    </section>
  );
}

function ConnectionNotice({ state }: { state: RuntimeProjectionState["connection"] }) {
  if (state.state === "connected") return null;
  const labels = {
    connecting: "Connecting to Codex…",
    disconnected: "Codex is disconnected",
    reconciling: "Reconciling persisted task state…",
    gap: "Event gap detected; recovering authoritative history…",
  } as const;
  return (
    <div
      className={`runtime-connection runtime-connection--${state.state}`}
      role={state.state === "disconnected" ? "alert" : "status"}
      aria-live="polite"
    >
      <span className="runtime-connection-dot" aria-hidden="true" />
      <span>
        <strong>{labels[state.state]}</strong>
        {state.reason ? <small>{state.reason}</small> : null}
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

function ApprovalControl({
  approval,
  busy,
  autoApproving,
  runtime,
  onDecision,
}: {
  approval: ApprovalProjection;
  busy: boolean;
  autoApproving?: boolean;
  /** Which provider raised the approval; tailors plan-review actions. */
  runtime?: RuntimeId;
  onDecision: (decision: ApprovalDecision) => void;
}) {
  const isCommand = approval.approvalKind === "commandExecution";
  const isPlan = approval.approvalKind === "planReview";
  const failed = approval.state === "responseFailed";
  const changedPaths = approval.fileChanges?.map((change) => change.path) ?? [];
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
      <div className="approval-icon" aria-hidden="true">
        {isPlan ? <ClipboardList /> : isCommand ? <TerminalSquare /> : <FileDiff />}
      </div>
      <div className="approval-body">
        <span className="approval-kicker">
          {autoApproving ? "Auto-approving — full access is on" : "Approval required"}
        </span>
        <h3 id={`approval-${approval.id}`}>
          {isPlan
            ? "Approve this plan?"
            : isCommand
              ? "Run this command?"
              : "Apply these file changes?"}
        </h3>
        {isPlan ? (
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
              <button
                type="button"
                className="secondary-button"
                onClick={() => onDecision("acceptForSession")}
                disabled={busy}
                title="Allow this and similar commands for the rest of this session"
              >
                Allow for session
              </button>
            ) : null}
            {isPlan && runtime !== "cursor" ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => onDecision("acceptForSession")}
                disabled={busy}
                title="Approve the plan and auto-accept the file edits that implement it"
              >
                Approve & auto-edit
              </button>
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
  const [openingProject, setOpeningProject] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [createProjectError, setCreateProjectError] = useState("");
  const [creatingTask, setCreatingTask] = useState(false);
  const [switchingTaskId, setSwitchingTaskId] = useState("");
  const [taskActionBusyId, setTaskActionBusyId] = useState("");
  const [newChatDraftKey, setNewChatDraftKey] = useState(0);
  const [promotingDraftTaskId, setPromotingDraftTaskId] = useState("");
  const [operationError, setOperationError] = useState("");
  const [composerError, setComposerError] = useState<ComposerErrorState | null>(null);
  const [operationStatus, setOperationStatus] = useState("");
  const [runtimeState, setRuntimeState] = useState<RuntimeProjectionState | null>(null);
  const [optimisticUserMessage, setOptimisticUserMessage] = useState<{
    taskId: string;
    event: TranscriptEvent;
  } | null>(null);
  const [composerDraftStore] = useState(() => new ComposerDraftStore());
  const draftPersistenceFailureShown = useRef(false);
  const pendingDraftWrites = useRef(new Map<string, ComposerDraft>());
  const draftWriterRunning = useRef(false);
  const [delegations, setDelegations] = useState<DelegationView[]>([]);
  const [selectedDelegationId, setSelectedDelegationId] = useState<string | undefined>();
  // Provider-reported subscription quota keyed by runtime (Codex today).
  // Refreshed per active-task switch; never inferred when a provider is silent.
  const [providerQuota, setProviderQuota] = useState<Record<string, SubscriptionQuota>>({});
  const [respondingApprovalId, setRespondingApprovalId] = useState("");
  // Live composer permission per task. Switching to full access mid-run
  // auto-approves pending and future command approvals for that task.
  const [taskPermissions, setTaskPermissions] = useState<Record<string, string>>({});
  const autoApprovedIdsRef = useRef<Set<string>>(new Set());
  // External composer permission set-requests: mirrors agent-driven mode
  // changes (e.g. an approved plan exit) back into the permission picker.
  // The id is the task:mode pair the request derives from.
  const [permissionRequest, setPermissionRequest] = useState<{
    id: string;
    value: "read-only" | "project-write" | "ask" | "full-access";
  } | null>(null);
  // Task whose approved Cursor plan should be built once the planning turn
  // settles. Cleared if the user sends their own message first.
  const pendingPlanBuildRef = useRef("");
  const [stoppingTurn, setStoppingTurn] = useState(false);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [runtimeActionRequest, setRuntimeActionRequest] = useState<RuntimeActionRequest | null>(
    null,
  );
  const runtimeActionSequence = useRef(0);
  const [centerView, setCenterView] = useState<CenterView>(initialCenterView);
  const [localSettings, setLocalSettings] = useState<Record<string, unknown>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () =>
      typeof window !== "undefined" && Boolean(window.matchMedia?.("(max-width: 900px)").matches),
  );
  const [rightRailOpen, setRightRailOpen] = useState(
    () => !window.matchMedia?.("(max-width: 980px)").matches,
  );
  const [openProjectFileRequest, setOpenProjectFileRequest] = useState<{
    path: string;
    id: number;
  } | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    storedDimension(SIDEBAR_WIDTH_STORAGE_KEY, 272, 220, 420),
  );
  const [rightRailWidth, setRightRailWidth] = useState(() =>
    storedDimension(RIGHT_RAIL_WIDTH_STORAGE_KEY, 356, 300, 520),
  );
  const [subagentPaneRatio, setSubagentPaneRatio] = useState(() =>
    storedDimension(SUBAGENT_PANE_RATIO_STORAGE_KEY, 0.5, 0.3, 0.7),
  );
  const [terminalOwner, setTerminalOwner] = useState<"main" | string | null>(null);
  const [terminalSurfaceActivated, setTerminalSurfaceActivated] = useState(false);
  const [diffView, setDiffView] = useState<"unified" | "split">("unified");
  const [activeFilePath, setActiveFilePath] = useState(() => snapshot.git.files[0]?.path ?? "");
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
    path: string;
    message: string;
  } | null>(null);
  const [reviewRetryVersion, setReviewRetryVersion] = useState(0);
  const [preferences, setPreferences] = useState<ThemePreferences>(() => initializeTheme());
  const [composerInsert, setComposerInsert] = useState<{
    id: number;
    text: string;
  } | null>(null);
  const composerInsertSequence = useRef(0);
  const projectionBuffer = useRef<RuntimeProjectionEvent[]>([]);
  const projectionReady = useRef(false);
  const projectionTaskId = useRef("");
  const projectionGeneration = useRef(0);
  const navigationGeneration = useRef(0);
  const taskProjectionCache = useRef(new Map<string, RuntimeProjectionState>());
  const taskRuntimeByIdRef = useRef(
    new Map(snapshot.tasks.map((task) => [task.id, task.runtime] as const)),
  );
  const verifiedRuntimesRef = useRef(new Set<RuntimeId>());
  const taskGitCache = useRef(new Map<string, GitSnapshot>());
  const taskGitRefreshedAt = useRef(new Map<string, number>());
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

  useEffect(() => {
    const timeout = window.setTimeout(
      () => window.localStorage.setItem(SUBAGENT_PANE_RATIO_STORAGE_KEY, String(subagentPaneRatio)),
      150,
    );
    return () => window.clearTimeout(timeout);
  }, [subagentPaneRatio]);

  const reconcileTaskProjection = useCallback(
    async (
      taskId: string,
      preserveBufferedEvents = false,
      cachedState?: RuntimeProjectionState,
    ) => {
      const generation = ++projectionGeneration.current;
      projectionReady.current = false;
      projectionTaskId.current = taskId;
      if (!preserveBufferedEvents) projectionBuffer.current = [];
      setRuntimeState(cachedState ?? createRuntimeProjectionState(taskId));
      try {
        const loaded = await bridge.loadTaskProjection(taskId);
        let next = createRuntimeProjectionState(taskId);
        for (const event of [...loaded.events].sort((a, b) => a.seq - b.seq)) {
          next = applyRuntimeProjection(next, event);
        }
        next = {
          ...next,
          lastSeq: Math.max(next.lastSeq, loaded.watermarkSeq),
        };
        let liveConnectionSeen = false;
        for (const event of projectionBuffer.current
          .filter((candidate) => candidate.taskId === taskId && candidate.seq > loaded.watermarkSeq)
          .sort((a, b) => a.seq - b.seq)) {
          if (event.projection.kind === "connectionChanged") liveConnectionSeen = true;
          next = applyRuntimeProjection(next, event);
        }
        if (generation !== projectionGeneration.current) return;
        projectionBuffer.current = [];
        projectionReady.current = true;
        if (
          !liveConnectionSeen &&
          (next.connection.state === "reconciling" ||
            next.connection.state === "connecting" ||
            next.connection.state === "connected")
        ) {
          // Persisted liveness is stale by definition — a provider process
          // never survives the app — so without a live connection event the
          // task is disconnected until Codex reconnects. Persisted "gap"
          // stays visible: it records that history still needs reconciling.
          next = {
            ...next,
            connection: {
              state: "disconnected",
              reason: "Codex is not connected",
            },
          };
        }
        if (
          !liveConnectionSeen &&
          next.turn &&
          (next.turn.status === "inProgress" || next.turn.status === "pending")
        ) {
          // Same reasoning for the turn itself: without a live provider the
          // persisted "streaming" turn can never finish, so it must not keep
          // the transcript spinner and elapsed timer alive. The backend
          // settles this in the store on snapshot; this covers the window
          // where that write fails or an older database is loaded.
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
        projectionReady.current = true;
        const failed = {
          ...createRuntimeProjectionState(taskId),
          connection: {
            state: "disconnected",
            reason: error instanceof Error ? error.message : "Could not restore task events",
          },
        } satisfies RuntimeProjectionState;
        taskProjectionCache.current.set(taskId, failed);
        setRuntimeState(failed);
      }
    },
    [],
  );

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    let projectionFrame: number | undefined;
    const frameEvents: RuntimeProjectionEvent[] = [];
    const applyLiveProjectionBatch = (events: RuntimeProjectionEvent[]) => {
      const taskId = projectionTaskId.current;
      const applicable = events.filter((event) => event.taskId === taskId);
      if (applicable.length === 0) return;
      setRuntimeState((current) => {
        let next = current ?? createRuntimeProjectionState(taskId);
        for (const event of applicable) {
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
            if (!projectionReady.current) {
              recordRuntimeVerificationEvent(event, verifiedRuntimesRef.current);
            }
            const persistedActivity = taskActivityUpdate(event, false);
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
              }
            }
            if (!projectionReady.current) {
              projectionBuffer.current.push(event);
              return;
            }
            if (event.taskId !== projectionTaskId.current) return;
            const isStreamingText =
              event.projection.kind === "itemChanged" &&
              event.projection.item.status === "inProgress" &&
              (event.projection.item.kind === "agentMessage" ||
                event.projection.item.kind === "reasoningSummary");
            if (isStreamingText) {
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
        const loaded = await bridge.loadWorkspace();
        const persisted = (await Promise.resolve(bridge.listSettings?.()).catch(() => [])) ?? [];
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
        setSnapshot(loaded);
        taskRuntimeByIdRef.current = new Map(
          loaded.tasks.map((task) => [task.id, task.runtime] as const),
        );
        setActiveFilePath((path) => path || loaded.git.files[0]?.path || "");
        // The shell is useful as soon as local projects/tasks/settings exist.
        // Provider discovery and transcript reconciliation are independent,
        // read-only refreshes and must not gate that first paint.
        setWorkspaceLoading(false);
        if (nativeHost) {
          void Promise.resolve(bridge.probeRuntimes?.())
            .then((runtimes) => {
              if (!active || !runtimes) return;
              setSnapshot((current) => ({ ...current, runtimes }));
              applyVerifiedRuntimeHealth(runtimes, loaded.tasks);
            })
            .catch(() => undefined);
        }
        if (nativeHost && loaded.activeTaskId) {
          void reconcileTaskProjection(loaded.activeTaskId, true);
          const taskId = loaded.activeTaskId;
          void Promise.resolve(bridge.loadTaskGit?.(taskId))
            .then((git) => {
              if (!active || !git) return;
              taskGitCache.current.set(taskId, git);
              taskGitRefreshedAt.current.set(taskId, Date.now());
              setSnapshot((current) =>
                current.activeTaskId === taskId ? { ...current, git } : current,
              );
              setActiveFilePath((current) => current || git.files[0]?.path || "");
            })
            .catch(() => undefined);
        } else {
          projectionReady.current = true;
        }
      } catch (error: unknown) {
        if (!active) return;
        setOperationError(error instanceof Error ? error.message : "Could not load the workspace");
      } finally {
        if (active) setWorkspaceLoading(false);
      }
    })();
    return () => {
      active = false;
      if (projectionFrame !== undefined) window.cancelAnimationFrame(projectionFrame);
      unlisten?.();
    };
  }, [applyVerifiedRuntimeHealth, composerDraftStore, nativeHost, reconcileTaskProjection]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void bridge.persistSession(snapshot), 300);
    return () => window.clearTimeout(timeout);
  }, [snapshot]);

  // Delegated-subagent lineage for the active task. Refreshed on task switch
  // and whenever the native broker reports a delegation change; the events
  // are cheap notifications, so a full re-list keeps the panel authoritative.
  const activeTaskIdRef = useRef<string | undefined>(snapshot.activeTaskId);
  useEffect(() => {
    activeTaskIdRef.current = snapshot.activeTaskId;
  }, [snapshot.activeTaskId]);
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
        setDelegations([]);
      }
    },
    [nativeHost],
  );
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
      unlisten = await bridge.subscribeDelegationUpdates?.(() => {
        if (active) void refreshDelegations(activeTaskIdRef.current);
      });
      if (!active) unlisten?.();
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, [nativeHost, refreshDelegations]);

  const activeTask = snapshot.tasks.find((task) => task.id === snapshot.activeTaskId);
  const rootTasks = useMemo(
    () => snapshot.tasks.filter((task) => !task.parentId),
    [snapshot.tasks],
  );
  const activeProject =
    snapshot.projects.find((project) => project.id === snapshot.activeProjectId) ??
    snapshot.projects.find((project) => project.id === activeTask?.projectId) ??
    snapshot.projects[0];
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
    snapshot.git.files.find((file) => file.path === activeFilePath) ?? snapshot.git.files[0];
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

  useLayoutEffect(() => {
    const root = appRootRef.current;
    const pane = subagentPaneRef.current;
    if (!root || !pane || !selectedDelegation) return;

    const alignHeader = () => {
      const rootRect = root.getBoundingClientRect();
      const paneRect = pane.getBoundingClientRect();
      root.style.setProperty(
        "--subagent-pane-left",
        `${Math.max(0, paneRect.left - rootRect.left)}px`,
      );
      root.dataset.subagentLayoutReady = "true";
    };

    alignHeader();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(alignHeader);
    observer?.observe(root);
    observer?.observe(pane);
    window.addEventListener("resize", alignHeader);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", alignHeader);
      delete root.dataset.subagentLayoutReady;
      root.style.removeProperty("--subagent-pane-left");
    };
  }, [selectedDelegation, subagentPaneRatio]);
  const titleContext =
    screen === "settings"
      ? "Settings"
      : screen === "setup"
        ? "Setup"
        : `${activeProject?.name ?? "Workspace"} · ${activeTask?.title ?? "New chat"}`;

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
    const runtimes = await bridge.probeRuntimes();
    setSnapshot((current) => ({ ...current, runtimes }));
    applyVerifiedRuntimeHealth(runtimes, snapshot.tasks);
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
    const targetTask = snapshot.tasks.find((task) => task.id === taskId);
    if (!targetTask || switchingTaskId === taskId) return;
    if (taskId === snapshot.activeTaskId) {
      setScreen("workspace");
      return;
    }
    const generation = ++navigationGeneration.current;
    const restoredView = snapshot.centerViewByTask[taskId] === "review" ? "review" : "task";
    const empty = createEmptySnapshot();
    const cached = nativeHost ? undefined : snapshot.taskContexts[taskId];
    const cachedRuntime = nativeHost ? taskProjectionCache.current.get(taskId) : undefined;
    const cachedGit = nativeHost ? taskGitCache.current.get(taskId) : undefined;
    // Cached conversations commit in the same frame. Authoritative storage
    // and Git refreshes still run below, but neither makes warm navigation
    // wait on SQLite or subprocess startup.
    setSwitchingTaskId(cachedRuntime ? "" : taskId);
    setOperationError("");
    setRuntimeState(cachedRuntime ?? null);
    setSelectedDelegationId(undefined);
    setCenterView(restoredView);
    setActiveFilePath(cachedGit?.files[0]?.path ?? cached?.git.files[0]?.path ?? "");
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
        lastTaskByProject: {
          ...current.lastTaskByProject,
          [targetTask.projectId]: taskId,
        },
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
      const gitRefreshedAt = taskGitRefreshedAt.current.get(taskId) ?? 0;
      if (!cachedGit || Date.now() - gitRefreshedAt >= GIT_CACHE_TTL_MS) {
        void bridge
          .loadTaskGit(taskId)
          .then((git) => {
            taskGitCache.current.set(taskId, git);
            taskGitRefreshedAt.current.set(taskId, Date.now());
            if (generation !== navigationGeneration.current) return;
            setSnapshot((current) =>
              current.activeTaskId === taskId ? { ...current, git } : current,
            );
            setActiveFilePath((current) =>
              git.files.some((file) => file.path === current)
                ? current
                : (git.files[0]?.path ?? ""),
            );
          })
          .catch((error: unknown) => {
            if (generation !== navigationGeneration.current) return;
            setOperationError(error instanceof Error ? error.message : "Could not load Git state");
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
    setNewChatDraftKey((value) => value + 1);
    const empty = createEmptySnapshot();
    setRuntimeState(null);
    setCenterView("task");
    setActiveFilePath("");
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
    setSnapshot((current) => {
      const existingTasks = current.tasks.filter((task) => task.projectId === project.id);
      const sameProject = current.activeProjectId === project.id;
      return {
        ...current,
        projects: [project, ...current.projects.filter((item) => item.id !== project.id)],
        activeProjectId: project.id,
        activeTaskId: existingTasks[0]?.id ?? "",
        lastTaskByProject: existingTasks[0]
          ? { ...current.lastTaskByProject, [project.id]: existingTasks[0].id }
          : current.lastTaskByProject,
        transcript: sameProject ? current.transcript : [],
        git: sameProject ? current.git : createEmptySnapshot().git,
        usage: sameProject ? current.usage : createEmptySnapshot().usage,
        children: sameProject ? current.children : [],
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
    setSnapshot((current) => ({
      ...current,
      activeTaskId: task.id,
      activeProjectId: task.projectId,
      lastTaskByProject: {
        ...current.lastTaskByProject,
        [task.projectId]: task.id,
      },
      centerViewByTask: { ...current.centerViewByTask, [task.id]: "task" },
      tasks: [task, ...current.tasks.filter((item) => item.id !== task.id)],
      transcript: [],
      git: empty.git,
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
      taskProjectionCache.current.set(task.id, initialRuntime);
      setRuntimeState(initialRuntime);
    } else {
      setRuntimeState(null);
    }
    setCenterView("task");
    setActiveFilePath("");
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
    const project =
      (projectId ? snapshot.projects.find((item) => item.id === projectId) : undefined) ??
      activeProject ??
      (await openProject());
    if (!project) return;
    ++navigationGeneration.current;
    const empty = createEmptySnapshot();
    setRuntimeState(null);
    setSelectedDelegationId(undefined);
    setCenterView("task");
    setScreen("workspace");
    setActiveFilePath("");
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

  const sendTurn = async (input: {
    prompt: string;
    runtime: RuntimeId;
    model: string;
    effort?: string;
    permission: "read-only" | "project-write" | "ask" | "full-access";
    delegation: "off" | "manual" | "balanced" | "budget-first";
    nativeActionId?: string;
    nativeAction?: NativeActionReference;
    draftRevision?: number;
  }): Promise<boolean> => {
    const project = activeProject;
    if (!project) {
      setOperationError("Open a project before starting a task.");
      return false;
    }
    setOperationError("");
    setComposerError(null);
    const isNewTask = !activeTask;
    const submittedDraft =
      activeDraftOwner && input.draftRevision !== undefined
        ? composerDraftStore.read(activeDraftOwner)
        : undefined;
    const targetTask =
      activeTask ??
      (await createTask(project, input.prompt, {
        runtime: input.runtime,
        model: input.model,
        effort: input.effort,
        permission: input.permission,
        delegation: input.delegation,
        draft: submittedDraft?.revision === input.draftRevision ? submittedDraft : undefined,
      }));
    if (!targetTask) return false;
    if (isNewTask) {
      void bridge
        .generateTaskTitle({
          taskId: targetTask.id,
          prompt: input.prompt,
          runtime: input.runtime,
        })
        .then((metadata) => {
          if (!metadata) return;
          setSnapshot((current) => ({
            ...current,
            tasks: current.tasks.map((task) =>
              task.id === targetTask.id && task.title === CHAT_TITLE_PLACEHOLDER
                ? { ...task, title: metadata.title, updatedAt: metadata.updatedAt }
                : task,
            ),
          }));
        })
        .catch(() => undefined);
    }
    setTaskPermissions((current) => ({
      ...current,
      [targetTask.id]: input.permission,
    }));
    const submittedAt = new Date().toISOString();
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
    if (nativeHost) {
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
      const { nativeAction, ...turnInput } = input;
      event = await bridge.sendTurn({ ...turnInput, taskId: targetTask.id });
      if (!nativeHost && nativeAction?.kind === "skill") {
        event = { ...event, nativeSkill: nativeAction.name };
      }
    } catch (error) {
      composerNoticeSequence.current += 1;
      setComposerError({
        id: `composer-error-${composerNoticeSequence.current}`,
        taskId: targetTask.id,
        message: formatBridgeError(error, "The turn could not be started"),
      });
      setOptimisticUserMessage(null);
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
      return false;
    }
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
          runtime: input.runtime,
          model: input.model,
          effort: input.effort,
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
              runtime: input.runtime,
              model: input.model,
              effort: input.effort,
              status: task.status === "starting" ? "running" : task.status,
              updatedAt: new Date().toISOString(),
            }
          : task,
      ),
    }));
    if (nativeHost) return true;
    const activity: TranscriptEvent = {
      id: `activity-${Date.now()}`,
      kind: "activity",
      title: "Queued for execution",
      body: `${input.runtime} · ${input.model} · ${input.delegation}`,
      timestamp: new Date().toISOString(),
      status: "running",
    };
    setSnapshot((current) => {
      const transcript = [...current.transcript, event, activity];
      const usage = recordLocalTurnUsage(current.usage, {
        eventId: event.id,
        timestamp: event.timestamp,
        prompt: input.prompt,
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
                runtime: input.runtime,
                model: input.model,
                effort: input.effort,
                updatedAt: new Date().toISOString(),
              }
            : task,
        ),
      };
    });
    return true;
  };

  const changeCenterView = (view: CenterView) => {
    setCenterView(view);
    if (!activeTask) return;
    setSnapshot((current) => ({
      ...current,
      centerViewByTask: {
        ...current.centerViewByTask,
        [activeTask.id]: view,
      },
    }));
  };

  const updateTaskMetadata = async (
    taskId: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
  ) => {
    if (taskActionBusyId) return;
    setTaskActionBusyId(taskId);
    setOperationError("");
    try {
      const updated = await bridge.updateTaskMetadata(taskId, patch);
      const nextTasks = snapshot.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              title: updated.title,
              pinned: updated.pinned,
              archived: updated.archived,
              updatedAt: updated.updatedAt,
            }
          : task,
      );
      setSnapshot((current) => ({ ...current, tasks: nextTasks }));
      if (updated.archived && snapshot.activeTaskId === taskId) {
        const archivedTask = nextTasks.find((task) => task.id === taskId);
        const replacement = nextTasks.find(
          (task) => task.projectId === archivedTask?.projectId && !task.archived,
        );
        if (replacement) void selectTask(replacement.id);
        else if (archivedTask) {
          const empty = createEmptySnapshot();
          setRuntimeState(null);
          setCenterView("task");
          setActiveFilePath("");
          setSnapshot((current) => ({
            ...current,
            activeProjectId: archivedTask.projectId,
            activeTaskId: "",
            transcript: [],
            git: empty.git,
            usage: empty.usage,
            children: [],
          }));
        }
      }
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Could not update that chat");
    } finally {
      setTaskActionBusyId("");
    }
  };

  const selectFile = (file: DiffFile) => {
    setReviewLoadError(null);
    setActiveFilePath(file.path);
    changeCenterView("review");
  };

  const openTranscriptFile = (path: string) => {
    setRightRailOpen(true);
    setOpenProjectFileRequest({ path, id: Date.now() });
  };

  const openProjectFile = async (file: ProjectFileEntry): Promise<ProjectFileContent> => {
    if (!activeProject) {
      throw new Error("Open a project before browsing files.");
    }
    setOperationError("");
    return bridge.readProjectFile(activeProject.id, file.path);
  };

  const renameProjectFile = async (file: ProjectFileEntry, newName: string) => {
    if (!activeProject) {
      throw new Error("Open a project before renaming files.");
    }
    await bridge.renameProjectFile(activeProject.id, file.path, newName);
    try {
      const files = await bridge.listProjectFiles(activeProject.id);
      projectFilesCache.current.set(activeProject.id, files);
      setProjectFiles(files);
    } catch {
      // The rename succeeded; the stale list refreshes on the next project load.
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

  const openGitFileExternal = (file: DiffFile, openerId: string) =>
    openProjectPathExternal(file.path, openerId);

  const revealGitFile = (file: DiffFile) => revealProjectPath(file.path);

  const stageFile = async (file: DiffFile, staged: boolean) => {
    if (!activeTask) return;
    const git = await bridge.stageFiles(activeTask.id, [file.path], staged);
    taskGitCache.current.set(activeTask.id, git);
    taskGitRefreshedAt.current.set(activeTask.id, Date.now());
    setSnapshot((current) => ({ ...current, git }));
  };

  const commit = async (message: string) => {
    if (!activeTask) return;
    const git = await bridge.commit(activeTask.id, message);
    taskGitCache.current.set(activeTask.id, git);
    taskGitRefreshedAt.current.set(activeTask.id, Date.now());
    setSnapshot((current) => ({ ...current, git }));
  };

  const generateCommitMessage = async () => {
    if (!activeTask) throw new Error("Open a task before generating a commit message.");
    await bridge.updateTaskRouting(activeTask.id, {
      runtime: activeTask.runtime,
      model: activeTask.model,
      effort: activeTask.effort,
    });
    return bridge.generateCommitMessage(activeTask.id, activeTask.runtime);
  };

  const push = async () => {
    if (!activeTask) return;
    const preview = await bridge.previewPush(activeTask.id);
    if (!preview.remote || !preview.upstream) {
      throw new Error("Push requires an existing tracked upstream branch.");
    }
    const result = await bridge.confirmPush(activeTask.id, {
      expectedHead: preview.head,
      expectedBranch: preview.branch,
      expectedRemote: preview.remote,
      expectedRemoteUrl: preview.sanitizedRemoteUrl,
      expectedUpstream: preview.upstream,
      expectedRefspec: preview.refspec,
    });
    if (result.outcome === "outcomeUncertain") {
      throw new Error(`${result.summary} Refresh Git status before retrying.`);
    }
    const git = await bridge.loadTaskGit(activeTask.id);
    taskGitCache.current.set(activeTask.id, git);
    taskGitRefreshedAt.current.set(activeTask.id, Date.now());
    setSnapshot((current) => ({ ...current, git }));
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
    const git = await bridge.loadTaskGit(activeTask.id);
    taskGitCache.current.set(activeTask.id, git);
    taskGitRefreshedAt.current.set(activeTask.id, Date.now());
    setSnapshot((current) => ({ ...current, git }));
    setActiveFilePath((current) =>
      git.files.some((file) => file.path === current) ? current : (git.files[0]?.path ?? ""),
    );
  };

  const applyGitSnapshot = (git: GitSnapshot) => {
    if (activeTask) {
      taskGitCache.current.set(activeTask.id, git);
      taskGitRefreshedAt.current.set(activeTask.id, Date.now());
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
    const file = activeFile;
    if (
      centerView !== "review" ||
      !nativeHost ||
      reviewRefreshing ||
      !taskId ||
      !file ||
      file.diffLoaded !== false
    ) {
      return;
    }
    let active = true;
    void bridge
      .loadTaskGitFile(taskId, file)
      .then((loaded) => {
        if (!active) return;
        setReviewLoadError(null);
        setSnapshot((current) => {
          if (current.activeTaskId !== taskId) return current;
          const git = {
            ...current.git,
            files: current.git.files.map((candidate) =>
              candidate.path === loaded.path ? loaded : candidate,
            ),
          };
          taskGitCache.current.set(taskId, git);
          return { ...current, git };
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : "Could not load that diff";
        setReviewLoadError({ path: file.path, message });
      });
    return () => {
      active = false;
    };
  }, [activeFile, activeTask?.id, centerView, nativeHost, reviewRefreshing, reviewRetryVersion]);

  const pendingApproval = runtimeState?.approvals.find(
    (approval) => approval.state === "pending" || approval.state === "responseFailed",
  );
  const nativeRuntimeEvents = useMemo(
    () =>
      nativeHost && runtimeState && runtimeState.taskId === activeTask?.id
        ? runtimeTranscript(runtimeState)
        : [],
    [activeTask?.id, nativeHost, runtimeState],
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
  const projectedTranscript = useMemo(
    () =>
      nativeHost
        ? providerHasOptimisticMessage || !optimisticForActiveTask
          ? nativeRuntimeEvents
          : [...nativeRuntimeEvents, optimisticForActiveTask.event].sort(
              (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
            )
        : snapshot.transcript,
    [
      nativeHost,
      nativeRuntimeEvents,
      optimisticForActiveTask,
      providerHasOptimisticMessage,
      snapshot.transcript,
    ],
  );
  const nativeTurnRunning =
    runtimeState?.taskId === activeTask?.id && runtimeState?.turn?.status === "inProgress";
  // Once the provider has projected the user item, its authoritative event
  // replaces the local bubble and the provider's turn state owns the spinner.
  // If startup fails, sendTurn clears the optimistic item and Composer
  // restores the draft instead.
  const optimisticTurnStarting = Boolean(optimisticForActiveTask && !providerHasOptimisticMessage);
  const runtimeUsage = runtimeState?.usage;
  const displayedUsage = runtimeUsage
    ? {
        ...snapshot.usage,
        tokens: runtimeUsage.totalTokens,
        metrics: [
          {
            label: "Tokens",
            value: runtimeUsage.totalTokens.toLocaleString(),
            numeric: runtimeUsage.totalTokens,
            provenance: "vendor_exact" as const,
            detail: "Persisted provider turn usage",
          },
          ...(runtimeUsage.vendorCostMicroUsd !== undefined
            ? [
                {
                  label: "API equivalent (vendor)",
                  value: `$${(runtimeUsage.vendorCostMicroUsd / 1_000_000).toFixed(4)}`,
                  numeric: runtimeUsage.vendorCostMicroUsd / 1_000_000,
                  provenance: "estimated" as const,
                  detail: "Provider-reported API-equivalent cost estimate; not a vendor bill.",
                },
              ]
            : []),
          ...snapshot.usage.metrics.filter(
            (metric) =>
              metric.label !== "Tokens" &&
              (runtimeUsage.vendorCostMicroUsd === undefined ||
                metric.label !== "API equivalent (estimate)"),
          ),
        ],
      }
    : snapshot.usage;
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
      : `Subscription usage unavailable — this provider does not report it · ${usagePillTokens}`;
  const activeRuntimeState = runtimeState?.taskId === activeTask?.id ? runtimeState : undefined;
  const activeAgentCount = nativeTurnRunning
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
  const respondToApproval = async (approval: ApprovalProjection, decision: ApprovalDecision) => {
    if (!activeTask || respondingApprovalId) return;
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
      setOperationError(error instanceof Error ? error.message : "Could not send that decision");
    } finally {
      setRespondingApprovalId("");
    }
  };

  const autoApproveActive = Boolean(activeTask && taskPermissions[activeTask.id] === "full-access");

  // Full access selected mid-run means "stop asking": answer each new
  // approval once, automatically, instead of parking the turn on a prompt.
  // Plan reviews stay manual: the user chose plan mode to read the plan
  // before anything is built, so full access must not skip that gate.
  useEffect(() => {
    if (!autoApproveActive || !activeTask || !pendingApproval) return;
    if (pendingApproval.state !== "pending") return;
    if (pendingApproval.approvalKind === "planReview") return;
    if (respondingApprovalId) return;
    if (autoApprovedIdsRef.current.has(pendingApproval.id)) return;
    autoApprovedIdsRef.current.add(pendingApproval.id);
    void respondToApproval(pendingApproval, "acceptForSession");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- respondToApproval is recreated every render
  }, [autoApproveActive, activeTask?.id, pendingApproval, respondingApprovalId]);

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
  const [syncedClaudeModeKey, setSyncedClaudeModeKey] = useState<string | undefined>(undefined);
  if (activeTask && claudeModeId && claudeModeKey !== syncedClaudeModeKey) {
    setSyncedClaudeModeKey(claudeModeKey);
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
      current?.id === claudeModeKey ? current : { id: claudeModeKey ?? "", value: mapped },
    );
  }

  // An approved Cursor plan builds itself: once the planning turn settles,
  // prompt the (now Agent-mode) session to implement the plan it wrote. The
  // send is deferred a tick so the follow-up turn never starts inside the
  // render that delivered the turn-completed projection.
  const activeTurnStatus = activeRuntimeState?.turn?.status;
  useEffect(() => {
    if (!activeTask || pendingPlanBuildRef.current !== activeTask.id) return;
    if (activeTurnStatus !== "completed") return;
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
  }, [activeTurnStatus, activeTask?.id]);

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

  /** Re-sends the prompt behind the latest reply using the task's own routing. */
  const regenerateLatest = async () => {
    if (!activeTask) return;
    const lastAssistantIndex = projectedTranscript.reduce(
      (latest, event, index) => (event.kind === "assistant" ? index : latest),
      -1,
    );
    if (lastAssistantIndex < 0) return;
    const priorUser = [...projectedTranscript.slice(0, lastAssistantIndex)]
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
      runtime:
        activeTask.runtime ??
        (localSettings["models.defaultRuntime"] as RuntimeId | undefined) ??
        "codex",
      model:
        activeTask.model ??
        (typeof localSettings["models.defaultModel"] === "string"
          ? localSettings["models.defaultModel"]
          : "Provider default"),
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

  const stopTurn = async () => {
    if (!activeTask || stoppingTurn) return;
    setStoppingTurn(true);
    setOperationError("");
    try {
      const result = await bridge.stopTurn(activeTask.id);
      setOperationStatus(
        result.settled
          ? "Session was no longer running — marked as stopped"
          : result.alreadyRequested
            ? "Stop was already requested"
            : "Stop requested",
      );
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Could not stop this turn");
    } finally {
      setStoppingTurn(false);
    }
  };

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
  const panelTransition = {
    width: { duration: 0.34 * motionScale, ease: [0.33, 1, 0.15, 1] as const },
    opacity: { duration: 0.22 * motionScale, ease: "easeOut" as const },
  };
  const toggleTerminal = useCallback((owner: "main" | string) => {
    setTerminalSurfaceActivated(true);
    setTerminalOwner((current) => (current === owner ? null : owner));
  }, []);

  return (
    <LazyMotion features={domMax} strict>
      <div
        ref={appRootRef}
        className="app-root"
        data-sidebar-visible={screen === "workspace" && !sidebarCollapsed}
        data-rail-visible={screen === "workspace" && showRightRail}
        data-subagent-visible={screen === "workspace" && Boolean(selectedDelegation)}
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
          title={screen === "workspace" ? (activeTask?.title ?? "New chat") : undefined}
          motionScale={motionScale}
          subagentHeaderRef={setSubagentHeaderTarget}
          detail={
            screen === "workspace" && activeProject ? (
              <>
                {activeProject.name} · {snapshot.git.branch}
              </>
            ) : undefined
          }
          leading={
            screen === "workspace" ? (
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
            screen === "workspace" && !selectedDelegation ? (
              <div className="titlebar-view-tabs" role="tablist" aria-label="Task view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={centerView === "task"}
                  data-active={centerView === "task"}
                  onClick={() => changeCenterView("task")}
                >
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
                  Review{snapshot.git.files.length ? ` ${snapshot.git.files.length}` : ""}
                </button>
              </div>
            ) : undefined
          }
          trailing={
            screen === "workspace" && !selectedDelegation ? (
              <>
                <button className="usage-compact" type="button" title={usagePillTitle}>
                  {usagePillPercent !== undefined ? (
                    <strong>{Math.round(usagePillPercent)}%</strong>
                  ) : null}
                  <span>{formatCompactTokenCount(displayedUsage.tokens)}</span>
                  <span className="sr-only"> tokens</span>
                </button>
                {runtimeState?.turn?.status === "inProgress" ? (
                  <button
                    className="stop-turn-button"
                    type="button"
                    onClick={() => void stopTurn()}
                    disabled={stoppingTurn || runtimeState.turn.stopRequested}
                    aria-busy={stoppingTurn}
                  >
                    <CircleStop aria-hidden="true" />
                    {runtimeState.turn.stopRequested || stoppingTurn ? "Stopping…" : "Stop"}
                  </button>
                ) : null}
                <button
                  className="icon-button subtle"
                  type="button"
                  onClick={() => toggleTerminal("main")}
                  aria-label="Toggle terminal"
                  aria-pressed={terminalOwner === "main"}
                >
                  <TerminalSquare />
                </button>
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
            ) : undefined
          }
          onOpenProject={() => setAddProjectOpen(true)}
          onNewChat={() => void newTask()}
          onFocusComposer={focusComposer}
          onCopyConversation={() => void copyConversation()}
          onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
          onToggleTaskTools={() => setRightRailOpen((value) => !value)}
          onToggleTerminal={() => {
            const owner = selectedDelegation?.id ?? "main";
            toggleTerminal(owner);
          }}
          onReviewChanges={reviewChanges}
          onOpenSettings={() => setScreen("settings")}
          onOpenSetup={() => setScreen("setup")}
        />
        <div
          className="app-content"
          style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
        >
          {screen === "settings" ? (
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
                usage={snapshot.usage}
                onChangePreferences={setTheme}
                onResetPreferences={resetTheme}
                runtimeActionRequest={runtimeActionRequest}
                onRefreshRuntimes={refreshRuntimes}
                onSettingChanged={(key, value) =>
                  setLocalSettings((current) => ({ ...current, [key]: value }))
                }
                onBack={() => setScreen("workspace")}
              />
            </Suspense>
          ) : null}
          {screen === "setup" ? (
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
                onFinish={() => setScreen("workspace")}
              />
            </Suspense>
          ) : null}
          {screen === "workspace" ? (
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
                {!sidebarCollapsed ? (
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
                      tasks={rootTasks}
                      activeProjectId={snapshot.activeProjectId}
                      activeTaskId={snapshot.activeTaskId}
                      metadataActionsEnabled={bridge.supportsTaskMetadata()}
                      taskActionBusyId={taskActionBusyId}
                      onSearchMessages={(query) => bridge.searchTaskMessages(query, 40)}
                      onSelectProject={selectProject}
                      onSelectTask={(taskId) => void selectTask(taskId)}
                      onNewTask={() => void newTask()}
                      onNewTaskInProject={(projectId) => void newTask(projectId)}
                      onOpenProject={() => setAddProjectOpen(true)}
                      openingProject={openingProject}
                      onUpdateTask={(taskId, patch) => void updateTaskMetadata(taskId, patch)}
                      onOpenSettings={() => setScreen("settings")}
                      onResize={(delta) =>
                        setSidebarWidth((current) => clampDimension(current + delta, 220, 420))
                      }
                    />
                  </motion.div>
                ) : null}
              </AnimatePresence>
              <div
                ref={conversationWorkspaceRef}
                className="conversation-workspace"
                data-subagent-open={Boolean(selectedDelegation)}
              >
                <section className="workspace-main">
                  <div className="workspace-announcements">
                    {operationError ? (
                      <div className="operation-message operation-message--error" role="alert">
                        <span className="operation-message-text">{operationError}</span>
                        <button
                          className="operation-message-dismiss"
                          type="button"
                          aria-label="Dismiss operation error"
                          title="Dismiss error"
                          onClick={() => setOperationError("")}
                        >
                          <X aria-hidden="true" />
                        </button>
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
                    ) : !activeProject ? (
                      <EmptyProjectState
                        busy={openingProject}
                        onOpenProject={() => setAddProjectOpen(true)}
                      />
                    ) : centerView === "task" ? (
                      <>
                        <div className="transcript-scroll" ref={transcriptScrollRef}>
                          {nativeHost && runtimeState ? (
                            <ConnectionNotice state={runtimeState.connection} />
                          ) : null}
                          {activeTask ? (
                            <Suspense
                              fallback={
                                <div className="route-loading" role="status" aria-live="polite">
                                  Loading task…
                                </div>
                              }
                            >
                              <Transcript
                                key={activeTask?.id ?? "draft"}
                                events={projectedTranscript}
                                scrollContainerRef={transcriptScrollRef}
                                running={nativeTurnRunning || optimisticTurnStarting}
                                modelForEvent={
                                  localSettings["transcript.showModel"] !== false
                                    ? (event) =>
                                        formatModelLabel(
                                          eventModels[event.id] ?? activeTask.model,
                                        ) || undefined
                                    : undefined
                                }
                                showTimestamps={
                                  localSettings["transcript.showTimestamps"] !== false
                                }
                                onRegenerate={() => void regenerateLatest()}
                                onOpenFile={openTranscriptFile}
                                onAddDiffSelection={(payload) =>
                                  addSelectionToChat(payload, "diff")
                                }
                              />
                            </Suspense>
                          ) : (
                            <EmptyTaskState project={activeProject} />
                          )}
                        </div>
                        <AnimatePresence initial={false}>
                          {activeTask && (nativeTurnRunning || optimisticTurnStarting) ? (
                            <TaskStatusPill
                              key="task-status-pill"
                              runningSince={
                                runtimeState?.turn?.startedAt ??
                                optimisticForActiveTask?.event.timestamp
                              }
                              usage={runtimeUsage}
                              activeAgentCount={activeAgentCount}
                            />
                          ) : null}
                        </AnimatePresence>
                        {pendingApproval ? (
                          <ApprovalControl
                            approval={pendingApproval}
                            busy={respondingApprovalId === pendingApproval.id}
                            autoApproving={
                              autoApproveActive && pendingApproval.approvalKind !== "planReview"
                            }
                            runtime={activeTask?.runtime}
                            onDecision={(decision) =>
                              void respondToApproval(pendingApproval, decision)
                            }
                          />
                        ) : null}
                        <Composer
                          key={
                            activeTask && promotingDraftTaskId !== activeTask.id
                              ? activeTask.id
                              : `draft-${activeProject.id}-${newChatDraftKey}`
                          }
                          runtimes={snapshot.runtimes}
                          defaultRuntime={
                            activeTask?.runtime ??
                            (localSettings["models.defaultRuntime"] as RuntimeId | undefined) ??
                            "codex"
                          }
                          defaultModel={
                            activeTask?.model ??
                            (typeof localSettings["models.defaultModel"] === "string"
                              ? localSettings["models.defaultModel"]
                              : "Provider default")
                          }
                          defaultEffort={
                            activeTask?.effort ??
                            (typeof localSettings["models.defaultEffort"] === "string"
                              ? localSettings["models.defaultEffort"]
                              : undefined)
                          }
                          defaultPermission={
                            localSettings["permissions.defaultProfile"] === "read-only" ||
                            localSettings["permissions.defaultProfile"] === "ask" ||
                            localSettings["permissions.defaultProfile"] === "full-access"
                              ? localSettings["permissions.defaultProfile"]
                              : "project-write"
                          }
                          defaultDelegation={
                            localSettings["delegation.defaultMode"] === "manual" ||
                            localSettings["delegation.defaultMode"] === "balanced" ||
                            localSettings["delegation.defaultMode"] === "budget-first"
                              ? localSettings["delegation.defaultMode"]
                              : "off"
                          }
                          enterToSend={localSettings["composer.enterToSend"] !== false}
                          initialDraft={activeComposerDraft}
                          onDraftChange={(value) => {
                            updateActiveComposerDraft(value);
                          }}
                          onDraftSubmit={updateActiveComposerDraft}
                          contextFiles={contextFilePaths}
                          onRequestContextFiles={requestProjectFiles}
                          workingDirectory={activeTask?.worktree ?? activeProject.path}
                          insertRequest={composerInsert}
                          onInsertHandled={(id) =>
                            setComposerInsert((current) => (current?.id === id ? null : current))
                          }
                          notices={composerNotices}
                          running={
                            Boolean(activeTask) &&
                            runtimeState?.taskId === activeTask?.id &&
                            runtimeState?.turn?.status === "inProgress"
                          }
                          stopping={stoppingTurn || Boolean(runtimeState?.turn?.stopRequested)}
                          onStop={() => void stopTurn()}
                          onSend={sendTurn}
                          sessionModes={
                            activeTask?.runtime === "cursor" ? activeRuntimeState?.mode : undefined
                          }
                          onSessionModeChange={
                            activeTask
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
                          permissionRequest={permissionRequest}
                          onPermissionChange={
                            activeTask
                              ? (permission) =>
                                  setTaskPermissions((current) => ({
                                    ...current,
                                    [activeTask.id]: permission,
                                  }))
                              : undefined
                          }
                          onRoutingChange={
                            activeTask
                              ? (routing) => {
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
                    ) : reviewRefreshing && !activeFile ? (
                      <div className="route-loading" role="status" aria-live="polite">
                        Checking this worktree for changes…
                      </div>
                    ) : activeFile && reviewLoadError?.path === activeFile.path ? (
                      <ReviewLoadErrorState
                        message={reviewLoadError.message}
                        onRetry={() => {
                          setReviewLoadError(null);
                          setReviewRetryVersion((current) => current + 1);
                        }}
                      />
                    ) : activeFile ? (
                      <Suspense
                        fallback={
                          <div className="route-loading" role="status" aria-live="polite">
                            Loading review…
                          </div>
                        }
                      >
                        <DiffView
                          file={activeFile}
                          viewMode={diffView}
                          onViewModeChange={setDiffView}
                          onRefresh={() => void refreshReview()}
                          refreshing={reviewRefreshing}
                          reviewed={Boolean(
                            activeTask && reviewedFiles[`${activeTask.id}:${activeFile.path}`],
                          )}
                          onMarkReviewed={() => {
                            if (!activeTask) return;
                            setReviewedFiles((current) => ({
                              ...current,
                              [`${activeTask.id}:${activeFile.path}`]: true,
                            }));
                            setOperationStatus(
                              `${activeFile.path} marked reviewed for this session`,
                            );
                          }}
                          onAddSelection={(payload) => addSelectionToChat(payload, "diff")}
                        />
                      </Suspense>
                    ) : (
                      <ReviewEmptyState
                        onBack={() => changeCenterView("task")}
                        onRefresh={() => void refreshReview()}
                        refreshing={reviewRefreshing}
                      />
                    )}
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
                          open={terminalOwner === "main"}
                          project={activeProject}
                          onClose={() => setTerminalOwner(null)}
                          motionScale={motionScale}
                        />
                      </Suspense>
                    ) : null}
                  </div>
                </section>
                <AnimatePresence initial={false}>
                  {selectedDelegation ? (
                    <motion.div
                      ref={subagentPaneRef}
                      className="subagent-workspace-pane"
                      key={selectedDelegation.id}
                      style={{ width: `${subagentPaneRatio * 100}%` }}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={panelTransition}
                    >
                      <ResizeHandle
                        axis="horizontal"
                        label="Resize subagent conversation"
                        onResize={(delta) => {
                          const width =
                            conversationWorkspaceRef.current?.getBoundingClientRect().width;
                          if (!width) return;
                          setSubagentPaneRatio((current) =>
                            clampDimension(current - delta / width, 0.3, 0.7),
                          );
                        }}
                      />
                      <Suspense
                        fallback={
                          <div className="route-loading" role="status" aria-live="polite">
                            Loading subagent conversation…
                          </div>
                        }
                      >
                        <SubagentConversation
                          delegation={selectedDelegation}
                          headerTarget={subagentHeaderTarget}
                          runtimes={snapshot.runtimes}
                          contextFiles={contextFilePaths}
                          onRequestContextFiles={requestProjectFiles}
                          enterToSend={localSettings["composer.enterToSend"] !== false}
                          rightRailOpen={rightRailOpen}
                          terminalOpen={terminalOwner === selectedDelegation.id}
                          onClose={() => {
                            setSelectedDelegationId(undefined);
                            setTerminalOwner((current) =>
                              current === selectedDelegation.id ? null : current,
                            );
                          }}
                          onToggleRightRail={() => setRightRailOpen((value) => !value)}
                          onToggleTerminal={() => toggleTerminal(selectedDelegation.id)}
                          onSend={async (
                            delegationId: string,
                            message: string,
                            routing: DelegationRouting,
                          ) => {
                            await bridge.sendDelegationMessage(delegationId, message, routing);
                            await refreshDelegations(activeTaskIdRef.current);
                          }}
                          onStop={async (delegationId) => {
                            await bridge.stopDelegation(delegationId);
                            await refreshDelegations(activeTaskIdRef.current);
                          }}
                          terminal={
                            activeProject && terminalSurfaceActivated ? (
                              <Suspense
                                fallback={
                                  <div className="terminal-drawer terminal-loading" role="status">
                                    Loading terminal…
                                  </div>
                                }
                              >
                                <TerminalDrawer
                                  key={`${activeProject.id}:${selectedDelegation.id}`}
                                  open={terminalOwner === selectedDelegation.id}
                                  project={activeProject}
                                  onClose={() => setTerminalOwner(null)}
                                  motionScale={motionScale}
                                />
                              </Suspense>
                            ) : undefined
                          }
                        />
                      </Suspense>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
              <AnimatePresence initial={false}>
                {showRightRail ? (
                  <motion.div
                    className="panel-slot panel-slot--right"
                    key="task-tools"
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: "auto", opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={panelTransition}
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
                        children={snapshot.children}
                        delegations={nativeHost ? delegations : undefined}
                        selectedDelegationId={selectedDelegation?.id}
                        onSelectDelegation={(delegationId) => {
                          setSelectedDelegationId(delegationId);
                          setTerminalOwner(null);
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
                        activeFile={activeFile}
                        projectId={activeProject?.id}
                        projectFiles={projectFiles}
                        projectFilesState={projectFilesState}
                        onRequestProjectFiles={requestProjectFiles}
                        openProjectFileRequest={openProjectFileRequest}
                        onSelectFile={selectFile}
                        onOpenProjectFile={openProjectFile}
                        onRenameProjectFile={renameProjectFile}
                        onMentionProjectFile={mentionProjectFile}
                        onMentionProjectFolder={mentionProjectFolder}
                        onAddFileSelection={(payload) => addSelectionToChat(payload, "file")}
                        fileOpeners={projectFileOpeners}
                        onOpenGitFileExternal={nativeHost ? openGitFileExternal : undefined}
                        onRevealGitFile={nativeHost ? revealGitFile : undefined}
                        onOpenProjectFileExternal={nativeHost ? openProjectPathExternal : undefined}
                        onRevealProjectFile={nativeHost ? revealProjectPath : undefined}
                        onStageFile={stageFile}
                        onStageFiles={async (paths, staged) => {
                          if (!activeTask) return;
                          const git = await bridge.stageFiles(activeTask.id, paths, staged);
                          taskGitCache.current.set(activeTask.id, git);
                          taskGitRefreshedAt.current.set(activeTask.id, Date.now());
                          setSnapshot((current) => ({ ...current, git }));
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
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </main>
          ) : null}
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
      </div>
    </LazyMotion>
  );
}
