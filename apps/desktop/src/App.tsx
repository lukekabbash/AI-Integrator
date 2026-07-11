import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CircleStop,
  FolderOpen,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Settings,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  bridge,
  type ApprovalDecision,
  type ApprovalProjection,
  type DiffFile,
  type ProjectSummary,
  type RuntimeId,
  type RuntimeProjectionEvent,
  type StartTaskInput,
  type TaskSummary,
  type TranscriptEvent,
} from "./bridge";
import { createDemoSnapshot, createEmptySnapshot, type WorkspaceSnapshot } from "./demoData";
import {
  initializeTheme,
  resetThemePreferences,
  updateThemePreferences,
  type ThemePreferencePatch,
  type ThemePreferences,
} from "./theme";
import { Composer } from "./components/Composer";
import { TaskSidebar } from "./components/TaskSidebar";
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

function NativeTitlebar({ context }: { context: string }) {
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
        <span>File</span>
        <span>Edit</span>
        <span>View</span>
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

function TerminalDrawer({ onClose }: { onClose: () => void }) {
  return (
    <section className="terminal-drawer" aria-label="Task terminal">
      <header className="terminal-header">
        <strong>Task terminal</strong>
        <span>PowerShell 7 · user input</span>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="terminal-body" role="log" aria-live="polite">
        <p>
          <span className="terminal-command">PS H:\Code\integrator-3&gt;</span> npm run check
        </p>
        <p>
          <span className="terminal-success">✓</span> TypeScript project references are valid
        </p>
        <p>
          <span className="terminal-success">✓</span> Native bridge capabilities negotiated
        </p>
        <p className="terminal-prompt">
          <span>PS H:\Code\integrator-3&gt;</span>
          <span>_</span>
        </p>
      </div>
    </section>
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

function EmptyTaskState({ project }: { project: ProjectSummary }) {
  return (
    <section className="empty-task-state" aria-labelledby="empty-task-title">
      <span className="empty-task-kicker">{project.name}</span>
      <h2 id="empty-task-title">What should the first agent do?</h2>
      <p>
        Describe the outcome below. Sending creates a durable local task before the selected CLI
        receives the turn.
      </p>
      <div className="empty-task-hints" aria-label="Task prompt suggestions">
        <span>Explain the goal and constraints</span>
        <span>Use @ to add files</span>
        <span>Review changes before committing</span>
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
  const [creatingTask, setCreatingTask] = useState(false);
  const [switchingTaskId, setSwitchingTaskId] = useState("");
  const [taskActionBusyId, setTaskActionBusyId] = useState("");
  const [newChatDraftKey, setNewChatDraftKey] = useState(0);
  const [operationError, setOperationError] = useState("");
  const [operationStatus, setOperationStatus] = useState("");
  const [runtimeState, setRuntimeState] = useState<RuntimeProjectionState | null>(null);
  const [respondingApprovalId, setRespondingApprovalId] = useState("");
  const [stoppingTurn, setStoppingTurn] = useState(false);
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [centerView, setCenterView] = useState<CenterView>(initialCenterView);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () =>
      typeof window !== "undefined" && Boolean(window.matchMedia?.("(max-width: 900px)").matches),
  );
  const [rightRailOpen, setRightRailOpen] = useState(
    () => !window.matchMedia?.("(max-width: 980px)").matches,
  );
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [diffView, setDiffView] = useState<"unified" | "split">("unified");
  const [activeFilePath, setActiveFilePath] = useState(() => snapshot.git.files[0]?.path ?? "");
  const [preferences, setPreferences] = useState<ThemePreferences>(() => initializeTheme());
  const projectionBuffer = useRef<RuntimeProjectionEvent[]>([]);
  const projectionReady = useRef(false);
  const projectionTaskId = useRef("");
  const projectionGeneration = useRef(0);
  const navigationGeneration = useRef(0);

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
        if (!active) return;
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

  const activeTask = snapshot.tasks.find((task) => task.id === snapshot.activeTaskId);
  const activeProject =
    snapshot.projects.find((project) => project.id === snapshot.activeProjectId) ??
    snapshot.projects.find((project) => project.id === activeTask?.projectId) ??
    snapshot.projects[0];
  const activeFile =
    snapshot.git.files.find((file) => file.path === activeFilePath) ?? snapshot.git.files[0];
  const showRightRail = Boolean(rightRailOpen && activeProject && activeTask && !switchingTaskId);
  const titleContext =
    screen === "settings"
      ? "Settings"
      : screen === "setup"
        ? "Setup"
        : `${activeProject?.name ?? "Workspace"} · ${activeTask?.title ?? "New chat"}`;

  const setTheme = (patch: ThemePreferencePatch) => {
    setPreferences((current) => updateThemePreferences(current, patch));
  };

  const resetTheme = () => setPreferences(resetThemePreferences());

  const selectTask = async (taskId: string) => {
    const targetTask = snapshot.tasks.find((task) => task.id === taskId);
    if (!targetTask || switchingTaskId === taskId) return;
    if (taskId === snapshot.activeTaskId) {
      setScreen("workspace");
      return;
    }
    const generation = ++navigationGeneration.current;
    const restoredView = snapshot.centerViewByTask[taskId] ?? "task";
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

  const newTask = async () => {
    const project = activeProject ?? (await openProject());
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
    permission: "read-only" | "project-write" | "ask" | "full-access";
    delegation: "off" | "manual" | "balanced" | "budget-first";
  }) => {
    const project = activeProject;
    if (!project) {
      setOperationError("Open a project before starting a task.");
      return;
    }
    setOperationError("");
    const targetTask =
      activeTask ??
      (await createTask(project, input.prompt, {
        runtime: input.runtime,
        model: input.model,
        permission: input.permission,
        delegation: input.delegation,
      }));
    if (!targetTask) return;
    let event: TranscriptEvent;
    try {
      event = await bridge.sendTurn({ ...input, taskId: targetTask.id });
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "The turn could not be started");
      return;
    }
    if (nativeHost) return;
    const activity: TranscriptEvent = {
      id: `activity-${Date.now()}`,
      kind: "activity",
      title: "Queued for execution",
      body: `${input.runtime} · ${input.model} · ${input.delegation}`,
      timestamp: new Date().toISOString(),
      status: "running",
    };
    setSnapshot((current) => ({
      ...current,
      transcript: [...current.transcript, event, activity],
      tasks: current.tasks.map((task) =>
        task.id === targetTask.id
          ? {
              ...task,
              status: "running",
              runtime: input.runtime,
              model: input.model,
              updatedAt: new Date().toISOString(),
            }
          : task,
      ),
    }));
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
      centerViewByTask: { ...current.centerViewByTask, [activeTask.id]: view },
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
  const displayedUsage = runtimeState?.usage
    ? {
        ...snapshot.usage,
        tokens: runtimeState.usage.totalTokens,
        metrics: [
          {
            label: "Tokens",
            value: runtimeState.usage.totalTokens.toLocaleString(),
            numeric: runtimeState.usage.totalTokens,
            provenance: "vendor_exact" as const,
            detail: "Persisted Codex turn usage",
          },
          ...snapshot.usage.metrics.filter((metric) => metric.label !== "Tokens"),
        ],
      }
    : snapshot.usage;

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

  const stopTurn = async () => {
    if (!activeTask || stoppingTurn) return;
    setStoppingTurn(true);
    setOperationError("");
    try {
      const result = await bridge.stopTurn(activeTask.id);
      setOperationStatus(result.alreadyRequested ? "Stop was already requested" : "Stop requested");
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Could not stop this turn");
    } finally {
      setStoppingTurn(false);
    }
  };

  return (
    <div className="app-root">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <NativeTitlebar context={titleContext} />
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
          >
            <TaskSidebar
              projects={snapshot.projects}
              tasks={snapshot.tasks}
              activeProjectId={snapshot.activeProjectId}
              activeTaskId={snapshot.activeTaskId}
              collapsed={sidebarCollapsed}
              metadataActionsEnabled={bridge.supportsTaskMetadata()}
              taskActionBusyId={taskActionBusyId}
              onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
              onSelectProject={selectProject}
              onSelectTask={(taskId) => void selectTask(taskId)}
              onNewTask={() => void newTask()}
              onOpenProject={() => void openProject()}
              openingProject={openingProject}
              onUpdateTask={(taskId, patch) => void updateTaskMetadata(taskId, patch)}
              onOpenSettings={() => setScreen("settings")}
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
                    onClick={() => setScreen("setup")}
                    aria-label="Runtime setup"
                  >
                    <Settings />
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
                    onOpenProject={() => void openProject()}
                  />
                ) : centerView === "task" ? (
                  <>
                    <div className="transcript-scroll">
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
                            events={projectedTranscript}
                            running={
                              runtimeState?.taskId === activeTask.id &&
                              runtimeState?.turn?.status === "inProgress"
                            }
                            runningSince={runtimeState?.turn?.startedAt}
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
                      defaultRuntime={activeTask?.runtime ?? "codex"}
                      defaultModel={activeTask?.model ?? "GPT-5.6 Sol"}
                      onSend={sendTurn}
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
                    />
                  </Suspense>
                ) : null}
                {terminalOpen ? <TerminalDrawer onClose={() => setTerminalOpen(false)} /> : null}
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
                  usage={displayedUsage}
                  activeFile={activeFile}
                  onSelectFile={selectFile}
                  onStageFile={stageFile}
                  onCommit={commit}
                  onPush={push}
                  onClose={() => setRightRailOpen(false)}
                />
              </Suspense>
            ) : (
              <div />
            )}
          </main>
        ) : null}
      </div>
    </div>
  );
}
