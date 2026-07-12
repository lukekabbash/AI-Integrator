import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ArrowRight,
  CircleStop,
  FolderOpen,
  FolderPlus,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  bridge,
  formatBridgeError,
  type ApprovalDecision,
  type ApprovalProjection,
  type DelegationView,
  type DiffFile,
  type ProjectFileContent,
  type ProjectFileEntry,
  type ProjectSummary,
  recordLocalTurnUsage,
  type RuntimeId,
  type RuntimeProjectionEvent,
  type StartTaskInput,
  type TaskSummary,
  type TranscriptEvent,
} from "./bridge";
import { composerNoticeExpiry, type ComposerNotice } from "./composerNotices";
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
import { TaskSidebar } from "./components/TaskSidebar";
import { TerminalDrawer } from "./components/TerminalDrawer";
import {
  applyRuntimeProjection,
  createRuntimeProjectionState,
  runtimeTranscript,
  type RuntimeProjectionState,
} from "./runtimeProjection";
import "./styles.css";

const RightRail = lazy(() =>
  import("./components/RightRail").then((module) => ({ default: module.RightRail })),
);

const DiffView = lazy(() =>
  import("./components/DiffView").then((module) => ({ default: module.DiffView })),
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
  if (!modelId || modelId === "Provider default") return modelId ?? "";
  return modelId
    .split(/(\s+|-)/)
    .map((token) => MODEL_LABEL_WORDS[token.toLowerCase()] ?? token)
    .join("");
}

const SettingsView = lazy(() =>
  import("./components/SettingsView").then((module) => ({ default: module.SettingsView })),
);
const SetupView = lazy(() =>
  import("./components/SetupView").then((module) => ({ default: module.SetupView })),
);
const Transcript = lazy(() =>
  import("./components/Transcript").then((module) => ({ default: module.Transcript })),
);

type Screen = "workspace" | "settings" | "setup";
type CenterView = "task" | "review";

interface ComposerErrorState {
  id: string;
  taskId: string;
  message: string;
}

const SIDEBAR_WIDTH_STORAGE_KEY = "aiintegrator.sidebar-width.v1";
const RIGHT_RAIL_WIDTH_STORAGE_KEY = "aiintegrator.right-rail-width.v1";

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
                Open projectâ€¦
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
      <div className="titlebar-context">{context}</div>
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
      <h1 id="empty-project-title">Open a local Git project</h1>
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
        <span>The selected repository is verified by the native Git service before use.</span>
      </div>
    </section>
  );
}

function AddProjectModal({
  busy,
  onClose,
  onOpenExisting,
  onCreateNew,
}: {
  busy: boolean;
  onClose: () => void;
  onOpenExisting: () => void;
  onCreateNew: (name: string) => void;
}) {
  const [mode, setMode] = useState<"choose" | "create">("choose");
  const [name, setName] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (mode === "create") nameInputRef.current?.focus();
  }, [mode]);
  const trimmedName = name.trim();
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
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="add-project-title">
        <div className="modal-head">
          <h2 id="add-project-title">{mode === "choose" ? "Add a project" : "Create new project"}</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose} disabled={busy}>
            <X />
          </button>
        </div>
        {mode === "choose" ? (
          <div className="modal-options">
            <button type="button" className="modal-option" onClick={onOpenExisting} disabled={busy}>
              <FolderOpen aria-hidden="true" />
              <span>
                <strong>Open local folder</strong>
                <small>Choose an existing Git repository on this machine.</small>
              </span>
            </button>
            <button type="button" className="modal-option" onClick={() => setMode("create")} disabled={busy}>
              <FolderPlus aria-hidden="true" />
              <span>
                <strong>Create from scratch</strong>
                <small>Make a new folder and initialize a fresh Git repository.</small>
              </span>
            </button>
          </div>
        ) : (
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
              You'll pick where to put it next; the folder is created there and git-initialized.
            </p>
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setMode("choose")} disabled={busy}>
                Back
              </button>
              <button type="submit" className="empty-primary-action" disabled={busy || !trimmedName} aria-busy={busy}>
                {busy ? "Creating…" : "Choose location & create"}
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
        <img src="/brand/ai-integrator-mark-light.png" alt="" />
      </span>
      <span className="empty-task-kicker">{project.name}</span>
      <h2 id="empty-task-title">What are we working on?</h2>
      <p>
        Describe what you want done. Every task is saved locally first, so nothing is lost if the
        agent disconnects mid-run.
      </p>
      <div className="empty-task-hints" aria-label="Task prompt suggestions">
        <span>Say what done looks like</span>
        <span>@ mentions a file</span>
        <span>You review every diff before it lands</span>
      </div>
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

function ApprovalControl({
  approval,
  busy,
  onDecision,
}: {
  approval: ApprovalProjection;
  busy: boolean;
  onDecision: (decision: ApprovalDecision) => void;
}) {
  const isCommand = approval.approvalKind === "commandExecution";
  return (
    <section className="approval-control" aria-labelledby={`approval-${approval.id}`}>
      <div>
        <span className="approval-kicker">Approval required</span>
        <h3 id={`approval-${approval.id}`}>
          {isCommand ? "Run this command?" : "Apply these file changes?"}
        </h3>
        <p>
          {isCommand
            ? (approval.command ?? approval.reason ?? "Codex is waiting to run a command.")
            : (approval.fileChanges?.map((change) => change.path).join(", ") ??
              approval.reason ??
              "Codex is waiting to change files.")}
        </p>
        {isCommand && approval.cwd ? (
          <small className="approval-cwd">in {approval.cwd}</small>
        ) : null}
      </div>
      <div className="approval-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => onDecision("decline")}
          disabled={busy}
        >
          Decline
        </button>
        {isCommand ? (
          <button
            type="button"
            className="secondary-button"
            onClick={() => onDecision("acceptForSession")}
            disabled={busy}
          >
            Allow for session
          </button>
        ) : null}
        <button
          type="button"
          className="primary-button"
          onClick={() => onDecision("accept")}
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? "Responding…" : isCommand ? "Run command" : "Allow changes"}
        </button>
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
  const [creatingTask, setCreatingTask] = useState(false);
  const [switchingTaskId, setSwitchingTaskId] = useState("");
  const [taskActionBusyId, setTaskActionBusyId] = useState("");
  const [newChatDraftKey, setNewChatDraftKey] = useState(0);
  const [operationError, setOperationError] = useState("");
  const [composerError, setComposerError] = useState<ComposerErrorState | null>(null);
  const [operationStatus, setOperationStatus] = useState("");
  const [runtimeState, setRuntimeState] = useState<RuntimeProjectionState | null>(null);
  const [delegations, setDelegations] = useState<DelegationView[]>([]);
  const [respondingApprovalId, setRespondingApprovalId] = useState("");
  const [stoppingTurn, setStoppingTurn] = useState(false);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [centerView, setCenterView] = useState<CenterView>(initialCenterView);
  const [localSettings, setLocalSettings] = useState<Record<string, unknown>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () =>
      typeof window !== "undefined" && Boolean(window.matchMedia?.("(max-width: 900px)").matches),
  );
  const [rightRailOpen, setRightRailOpen] = useState(
    () => !window.matchMedia?.("(max-width: 980px)").matches,
  );
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    storedDimension(SIDEBAR_WIDTH_STORAGE_KEY, 272, 220, 420),
  );
  const [rightRailWidth, setRightRailWidth] = useState(() =>
    storedDimension(RIGHT_RAIL_WIDTH_STORAGE_KEY, 356, 300, 520),
  );
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [diffView, setDiffView] = useState<"unified" | "split">("unified");
  const [activeFilePath, setActiveFilePath] = useState(() => snapshot.git.files[0]?.path ?? "");
  const [projectFiles, setProjectFiles] = useState<ProjectFileEntry[]>([]);
  const [projectFilesState, setProjectFilesState] = useState<"loading" | "ready" | "unavailable">(
    "unavailable",
  );
  const [reviewedFiles, setReviewedFiles] = useState<Record<string, boolean>>({});
  const [preferences, setPreferences] = useState<ThemePreferences>(() => initializeTheme());
  const projectionBuffer = useRef<RuntimeProjectionEvent[]>([]);
  const projectionReady = useRef(false);
  const projectionTaskId = useRef("");
  const projectionGeneration = useRef(0);
  const navigationGeneration = useRef(0);
  const composerNoticeSequence = useRef(0);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem(RIGHT_RAIL_WIDTH_STORAGE_KEY, String(rightRailWidth));
  }, [rightRailWidth]);

  const reconcileTaskProjection = useCallback(
    async (taskId: string, preserveBufferedEvents = false) => {
      const generation = ++projectionGeneration.current;
      projectionReady.current = false;
      projectionTaskId.current = taskId;
      if (!preserveBufferedEvents) projectionBuffer.current = [];
      setRuntimeState(createRuntimeProjectionState(taskId));
      try {
        const loaded = await bridge.loadTaskProjection(taskId);
        let next = createRuntimeProjectionState(taskId);
        for (const event of [...loaded.events].sort((a, b) => a.seq - b.seq)) {
          next = applyRuntimeProjection(next, event);
        }
        next = { ...next, lastSeq: Math.max(next.lastSeq, loaded.watermarkSeq) };
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
            connection: { state: "disconnected", reason: "Codex is not connected" },
          };
        }
        setRuntimeState(next);
      } catch (error) {
        if (generation !== projectionGeneration.current) return;
        projectionReady.current = true;
        setRuntimeState({
          ...createRuntimeProjectionState(taskId),
          connection: {
            state: "disconnected",
            reason: error instanceof Error ? error.message : "Could not restore task events",
          },
        });
      }
    },
    [],
  );

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        if (nativeHost) {
          unlisten = await bridge.subscribeRuntimeProjections((event) => {
            if (!projectionReady.current) {
              projectionBuffer.current.push(event);
              return;
            }
            if (event.taskId !== projectionTaskId.current) return;
            setRuntimeState((current) =>
              applyRuntimeProjection(current ?? createRuntimeProjectionState(event.taskId), event),
            );
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
        setSnapshot(loaded);
        setActiveFilePath((path) => path || loaded.git.files[0]?.path || "");
        if (nativeHost && loaded.activeTaskId) {
          await reconcileTaskProjection(loaded.activeTaskId, true);
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
      unlisten?.();
    };
  }, [nativeHost, reconcileTaskProjection]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void bridge.persistSession(snapshot), 300);
    return () => window.clearTimeout(timeout);
  }, [snapshot]);

  // Delegated-subagent lineage for the active task. Refreshed on task switch
  // and whenever the native broker reports a delegation change; the events
  // are cheap notifications, so a full re-list keeps the panel authoritative.
  const activeTaskIdRef = useRef<string | undefined>(undefined);
  activeTaskIdRef.current = snapshot.activeTaskId;
  const refreshDelegations = useCallback(
    async (taskId: string | undefined) => {
      if (!nativeHost || !taskId) {
        setDelegations([]);
        return;
      }
      try {
        // Optional-chained: App tests stub the bridge with partial mocks.
        const rows = (await bridge.listDelegations?.(taskId)) ?? [];
        if (activeTaskIdRef.current === taskId) setDelegations(rows);
      } catch {
        setDelegations([]);
      }
    },
    [nativeHost],
  );
  useEffect(() => {
    void refreshDelegations(snapshot.activeTaskId);
  }, [snapshot.activeTaskId, refreshDelegations]);
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
  const activeProject =
    snapshot.projects.find((project) => project.id === snapshot.activeProjectId) ??
    snapshot.projects.find((project) => project.id === activeTask?.projectId) ??
    snapshot.projects[0];
  const activeFile =
    snapshot.git.files.find((file) => file.path === activeFilePath) ?? snapshot.git.files[0];
  const activeProjectIdForFiles = activeProject?.id;

  // The Files panel is a view of the open project, not of any single chat:
  // it loads as soon as a project is open and only reloads when the open
  // project itself changes.
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      if (!activeProjectIdForFiles) {
        setProjectFiles([]);
        setProjectFilesState("unavailable");
        return;
      }
      setProjectFilesState("loading");
      try {
        const files = await bridge.listProjectFiles(activeProjectIdForFiles);
        if (!active) return;
        setProjectFiles(files);
        setProjectFilesState("ready");
      } catch (error) {
        if (!active) return;
        setProjectFiles([]);
        setProjectFilesState("unavailable");
        setOperationError(
          error instanceof Error ? error.message : "Could not read files for this project",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [activeProjectIdForFiles]);

  // The rail follows the open project (files, usage) even before the first
  // chat exists; only a task switch in flight hides it to avoid stale state.
  const showRightRail = Boolean(rightRailOpen && activeProject && !switchingTaskId);
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

  const connectRuntime = async (runtime: RuntimeId) => {
    const updated = await bridge.beginRuntimeLogin(runtime);
    setSnapshot((current) => ({
      ...current,
      runtimes: current.runtimes.map((candidate) =>
        candidate.id === runtime ? updated : candidate,
      ),
    }));
    return updated;
  };

  const selectTask = async (taskId: string) => {
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
    setSwitchingTaskId(taskId);
    setOperationError("");
    setRuntimeState(null);
    setCenterView(restoredView);
    setActiveFilePath(cached?.git.files[0]?.path ?? "");
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
        lastTaskByProject: { ...current.lastTaskByProject, [targetTask.projectId]: taskId },
        centerViewByTask: {
          ...current.centerViewByTask,
          ...(current.activeTaskId ? { [current.activeTaskId]: centerView } : {}),
        },
        taskContexts: contexts,
        transcript: targetContext?.transcript ?? [],
        git: targetContext?.git ?? empty.git,
        usage: targetContext?.usage ?? empty.usage,
        children: targetContext?.children ?? [],
        tasks: current.tasks.map((task) =>
          task.id === taskId ? { ...task, unread: false } : task,
        ),
      };
    });
    setScreen("workspace");

    if (nativeHost) {
      const [, git] = await Promise.all([
        reconcileTaskProjection(taskId),
        bridge.loadTaskGit(taskId).catch((error: unknown) => {
          setOperationError(error instanceof Error ? error.message : "Could not load Git state");
          return empty.git;
        }),
      ]);
      if (generation === navigationGeneration.current) {
        setSnapshot((current) => (current.activeTaskId === taskId ? { ...current, git } : current));
        setActiveFilePath(git.files[0]?.path ?? "");
      }
    }
    if (generation === navigationGeneration.current) {
      setSwitchingTaskId("");
      if (window.matchMedia?.("(max-width: 760px)").matches) setSidebarCollapsed(true);
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
    setOperationError("");
    setOperationStatus("");
    try {
      const project = await bridge.createProject(name);
      if (!project) return;
      mergeProject(project);
      setCenterView("task");
      setScreen("workspace");
      setOperationStatus(`${project.name} is ready`);
      setAddProjectOpen(false);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Could not create the project");
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
      lastTaskByProject: { ...current.lastTaskByProject, [task.projectId]: task.id },
      centerViewByTask: { ...current.centerViewByTask, [task.id]: "task" },
      tasks: [task, ...current.tasks.filter((item) => item.id !== task.id)],
      transcript: [],
      git: empty.git,
      usage: empty.usage,
      children: [],
    }));
    setRuntimeState(null);
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
      });
      appendTask(task);
      if (nativeHost) await reconcileTaskProjection(task.id);
      setOperationStatus(`Created ${task.title}`);
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
          const input = document.querySelector<HTMLInputElement>(".sidebar-search input");
          input?.focus();
          input?.select();
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
  }) => {
    const project = activeProject;
    if (!project) {
      setOperationError("Open a project before starting a task.");
      return;
    }
    setOperationError("");
    setComposerError(null);
    const targetTask =
      activeTask ??
      (await createTask(project, input.prompt, {
        runtime: input.runtime,
        model: input.model,
        effort: input.effort,
        permission: input.permission,
        delegation: input.delegation,
      }));
    if (!targetTask) return;
    let event: TranscriptEvent;
    try {
      event = await bridge.sendTurn({ ...input, taskId: targetTask.id });
    } catch (error) {
      composerNoticeSequence.current += 1;
      setComposerError({
        id: `composer-error-${composerNoticeSequence.current}`,
        taskId: targetTask.id,
        message: formatBridgeError(error, "The turn could not be started"),
      });
      return;
    }
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
              status: nativeHost ? task.status : "running",
              updatedAt: new Date().toISOString(),
            }
          : task,
      ),
    }));
    if (nativeHost) return;
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
  };

  const login = async (runtime: RuntimeId) => {
    const updated = await bridge.beginRuntimeLogin(runtime);
    setSnapshot((current) => ({
      ...current,
      runtimes: current.runtimes.map((item) => (item.id === runtime ? updated : item)),
    }));
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
    setActiveFilePath(file.path);
    changeCenterView("review");
  };

  const openProjectFile = async (file: ProjectFileEntry): Promise<ProjectFileContent> => {
    if (!activeProject) {
      throw new Error("Open a project before browsing files.");
    }
    setOperationError("");
    return bridge.readProjectFile(activeProject.id, file.path);
  };

  const stageFile = async (file: DiffFile, staged: boolean) => {
    if (!activeTask) return;
    const git = await bridge.stageFiles(activeTask.id, [file.path], staged);
    setSnapshot((current) => ({ ...current, git }));
  };

  const commit = async (message: string) => {
    if (!activeTask) return;
    const git = await bridge.commit(activeTask.id, message);
    setSnapshot((current) => ({ ...current, git }));
  };

  const push = async () => {
    if (!activeTask) return;
    const git = await bridge.push(activeTask.id);
    setSnapshot((current) => ({ ...current, git }));
  };

  const pendingApproval = runtimeState?.approvals.find(
    (approval) => approval.state === "pending" || approval.state === "responseFailed",
  );
  const projectedTranscript =
    nativeHost && runtimeState && runtimeState.taskId === activeTask?.id
      ? runtimeTranscript(runtimeState)
      : snapshot.transcript;
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
  const activeRuntimeState = runtimeState?.taskId === activeTask?.id ? runtimeState : undefined;
  const composerNotices: ComposerNotice[] = [
    ...(activeRuntimeState?.errors ?? []).map((error) => ({
      id: `runtime-error-${error.seq}`,
      title: error.retryable ? "Provider retrying" : "Turn error",
      message: error.message,
      variant: error.retryable ? ("warning" as const) : ("error" as const),
      expiresAt: composerNoticeExpiry(error.message, error.occurredAt, displayedUsage.resetAt),
    })),
    ...(composerError && composerError.taskId === activeTask?.id
      ? [
          {
            id: composerError.id,
            title: "Turn error",
            message: composerError.message,
            variant: "error" as const,
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
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Could not send that decision");
    } finally {
      setRespondingApprovalId("");
    }
  };

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
    if (!activeFile) {
      setOperationError("No changed file is available to review for this task");
      return;
    }
    changeCenterView("review");
  };

  return (
    <div className="app-root">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <NativeTitlebar
        context={titleContext}
        onOpenProject={() => setAddProjectOpen(true)}
        onNewChat={() => void newTask()}
        onFocusComposer={focusComposer}
        onCopyConversation={() => void copyConversation()}
        onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
        onToggleTaskTools={() => setRightRailOpen((value) => !value)}
        onToggleTerminal={() => setTerminalOpen((value) => !value)}
        onReviewChanges={reviewChanges}
        onOpenSettings={() => setScreen("settings")}
        onOpenSetup={() => setScreen("setup")}
      />
      <div className="app-content">
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
              onConnectRuntime={connectRuntime}
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
              onLogin={login}
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
                "--sidebar-width": `${sidebarCollapsed ? 52 : sidebarWidth}px`,
                "--right-rail-width": `${rightRailWidth}px`,
              } as CSSProperties
            }
          >
            <TaskSidebar
              projects={snapshot.projects}
              tasks={snapshot.tasks.filter((task) => !task.parentId)}
              activeProjectId={snapshot.activeProjectId}
              activeTaskId={snapshot.activeTaskId}
              collapsed={sidebarCollapsed}
              metadataActionsEnabled={bridge.supportsTaskMetadata()}
              taskActionBusyId={taskActionBusyId}
              onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
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
            <section className="workspace-main">
              <header className="workspace-header">
                <div className="workspace-title">
                  <div>
                    <h1>{activeTask?.title ?? "New chat"}</h1>
                    <span>
                      {activeProject?.name} · {snapshot.git.branch}
                    </span>
                  </div>
                </div>
                <div className="workspace-view-tabs" role="tablist" aria-label="Task view">
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
                    aria-selected={centerView === "review"}
                    data-active={centerView === "review"}
                    onClick={() => changeCenterView("review")}
                  >
                    Review
                  </button>
                </div>
                <div className="workspace-actions">
                  <button className="usage-compact" type="button" title="Subscription plan usage">
                    <span className="usage-mini-track">
                      <i style={{ width: `${displayedUsage.subscriptionPercent ?? 0}%` }} />
                    </span>
                    <strong>{displayedUsage.subscriptionPercent ?? "—"}%</strong>
                    <span>{Math.round(displayedUsage.tokens / 1000)}k</span>
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
                    onClick={() => setTerminalOpen((value) => !value)}
                    aria-label="Toggle terminal"
                  >
                    <TerminalSquare />
                  </button>
                  <button
                    className="icon-button subtle"
                    type="button"
                    onClick={() => setRightRailOpen((value) => !value)}
                    aria-label={rightRailOpen ? "Close task tools" : "Open task tools"}
                  >
                    {rightRailOpen ? <PanelRightClose /> : <PanelRightOpen />}
                  </button>
                </div>
              </header>
              <div className="workspace-announcements">
                {operationError ? (
                  <div className="operation-message operation-message--error" role="alert">
                    {operationError}
                  </div>
                ) : null}
                {operationStatus ? (
                  <div className="sr-only" role="status" aria-live="polite">
                    {operationStatus}
                  </div>
                ) : null}
              </div>
              <div className="workspace-content">
                {workspaceLoading || switchingTaskId ? (
                  <div className="route-loading" role="status" aria-live="polite">
                    {switchingTaskId ? "Opening chat…" : "Loading your local workspace…"}
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
                            running={
                              runtimeState?.taskId === activeTask.id &&
                              runtimeState?.turn?.status === "inProgress"
                            }
                            runningSince={runtimeState?.turn?.startedAt}
                            modelForEvent={
                              localSettings["transcript.showModel"] !== false
                                ? (event) =>
                                    formatModelLabel(
                                      eventModels[event.id] ?? activeTask.model,
                                    ) || undefined
                                : undefined
                            }
                            showTimestamps={localSettings["transcript.showTimestamps"] !== false}
                            onRegenerate={() => void regenerateLatest()}
                          />
                        </Suspense>
                      ) : (
                        <EmptyTaskState project={activeProject} />
                      )}
                    </div>
                    {pendingApproval ? (
                      <ApprovalControl
                        approval={pendingApproval}
                        busy={respondingApprovalId === pendingApproval.id}
                        onDecision={(decision) => void respondToApproval(pendingApproval, decision)}
                      />
                    ) : null}
                    <Composer
                      key={activeTask?.id ?? `draft-${activeProject.id}-${newChatDraftKey}`}
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
                      notices={composerNotices}
                      running={
                        Boolean(activeTask) &&
                        runtimeState?.taskId === activeTask?.id &&
                        runtimeState?.turn?.status === "inProgress"
                      }
                      stopping={
                        stoppingTurn || Boolean(runtimeState?.turn?.stopRequested)
                      }
                      onStop={() => void stopTurn()}
                      onSend={sendTurn}
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
                              void bridge.updateTaskRouting?.(activeTask.id, routing).catch(() => {
                                setOperationError(
                                  "Could not save provider selection for this chat",
                                );
                              });
                            }
                          : undefined
                      }
                    />
                  </>
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
                      reviewed={Boolean(
                        activeTask && reviewedFiles[`${activeTask.id}:${activeFile.path}`],
                      )}
                      onMarkReviewed={() => {
                        if (!activeTask) return;
                        setReviewedFiles((current) => ({
                          ...current,
                          [`${activeTask.id}:${activeFile.path}`]: true,
                        }));
                        setOperationStatus(`${activeFile.path} marked reviewed for this session`);
                      }}
                    />
                  </Suspense>
                ) : null}
                {activeProject ? (
                  <TerminalDrawer
                    key={activeProject.id}
                    open={terminalOpen}
                    project={activeProject}
                    onClose={() => setTerminalOpen(false)}
                  />
                ) : null}
              </div>
            </section>
            {showRightRail ? (
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
                  onOpenDelegationTask={
                    // Child tasks created after workspace load are not in the
                    // sidebar snapshot yet; only offer navigation when known.
                    (taskId) => {
                      if (snapshot.tasks.some((task) => task.id === taskId)) {
                        void selectTask(taskId);
                      }
                    }
                  }
                  usage={displayedUsage}
                  activeFile={activeFile}
                  projectId={activeProject?.id}
                  projectFiles={projectFiles}
                  projectFilesState={projectFilesState}
                  onSelectFile={selectFile}
                  onOpenProjectFile={openProjectFile}
                  onStageFile={stageFile}
                  onCommit={commit}
                  onPush={push}
                  onClose={() => setRightRailOpen(false)}
                  onResize={(delta) =>
                    setRightRailWidth((current) => clampDimension(current - delta, 300, 520))
                  }
                />
              </Suspense>
            ) : (
              <div />
            )}
          </main>
        ) : null}
      </div>
      {addProjectOpen ? (
        <AddProjectModal
          busy={openingProject}
          onClose={() => setAddProjectOpen(false)}
          onOpenExisting={() => void openExistingProject()}
          onCreateNew={(name) => void createNewProject(name)}
        />
      ) : null}
    </div>
  );
}
