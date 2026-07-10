import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
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
  type DiffFile,
  type ProjectSummary,
  type RuntimeId,
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

export default function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(initialSnapshot);
  const [workspaceLoading, setWorkspaceLoading] = useState(isNativeHost);
  const [openingProject, setOpeningProject] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [operationStatus, setOperationStatus] = useState("");
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [centerView, setCenterView] = useState<CenterView>(initialCenterView);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [rightRailOpen, setRightRailOpen] = useState(true);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [diffView, setDiffView] = useState<"unified" | "split">("unified");
  const [activeFilePath, setActiveFilePath] = useState(() => snapshot.git.files[0]?.path ?? "");
  const [preferences, setPreferences] = useState<ThemePreferences>(() => initializeTheme());

  useEffect(() => {
    let active = true;
    void bridge
      .loadWorkspace()
      .then((loaded) => {
        if (!active) return;
        setSnapshot(loaded);
        setActiveFilePath((path) => path || loaded.git.files[0]?.path || "");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setOperationError(error instanceof Error ? error.message : "Could not load the workspace");
      })
      .finally(() => {
        if (active) setWorkspaceLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

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
  const showRightRail = Boolean(rightRailOpen && activeProject && activeTask);
  const titleContext =
    screen === "settings"
      ? "Settings"
      : screen === "setup"
        ? "Setup"
        : `${activeProject?.name ?? "Workspace"} · ${activeTask?.title ?? "New task"}`;

  const shellColumns = useMemo(
    () => ({
      gridTemplateColumns: `${sidebarCollapsed ? "50px" : "272px"} minmax(480px, 1fr) ${showRightRail ? "minmax(300px, 356px)" : "0px"}`,
    }),
    [showRightRail, sidebarCollapsed],
  );

  const setTheme = (patch: ThemePreferencePatch) => {
    setPreferences((current) => updateThemePreferences(current, patch));
  };

  const resetTheme = () => setPreferences(resetThemePreferences());

  const selectTask = (taskId: string) => {
    setSnapshot((current) => ({
      ...current,
      activeTaskId: taskId,
      activeProjectId:
        current.tasks.find((task) => task.id === taskId)?.projectId ?? current.activeProjectId,
      tasks: current.tasks.map((task) => (task.id === taskId ? { ...task, unread: false } : task)),
    }));
    setCenterView("task");
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
        transcript: sameProject ? current.transcript : [],
        git: sameProject ? current.git : createEmptySnapshot().git,
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
    setSnapshot((current) => ({
      ...current,
      activeTaskId: task.id,
      activeProjectId: task.projectId,
      tasks: [task, ...current.tasks.filter((item) => item.id !== task.id)],
      transcript: [],
    }));
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
    setCenterView("task");
    setScreen("workspace");
    const project = activeProject ?? (await openProject());
    if (!project) return;
    await createTask(project, "New task");
    const composer = document.querySelector<HTMLTextAreaElement>(".composer textarea");
    window.setTimeout(() => composer?.focus(), 0);
  };

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

  const selectFile = (file: DiffFile) => {
    setActiveFilePath(file.path);
    setCenterView("review");
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
          <main className="app-shell" id="main-content" style={shellColumns}>
            <TaskSidebar
              projects={snapshot.projects}
              tasks={snapshot.tasks}
              activeTaskId={snapshot.activeTaskId}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
              onSelectTask={selectTask}
              onNewTask={() => void newTask()}
              onOpenProject={() => void openProject()}
              openingProject={openingProject}
              onOpenSettings={() => setScreen("settings")}
            />
            <section className="workspace-main">
              <header className="workspace-header">
                <div className="workspace-title">
                  <div>
                    <h1>{activeTask?.title ?? "New task"}</h1>
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
                    onClick={() => setCenterView("task")}
                  >
                    Task
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={centerView === "review"}
                    data-active={centerView === "review"}
                    onClick={() => setCenterView("review")}
                  >
                    Review
                  </button>
                </div>
                <div className="workspace-actions">
                  <button className="usage-compact" type="button" title="Subscription plan usage">
                    <span className="usage-mini-track">
                      <i style={{ width: `${snapshot.usage.subscriptionPercent ?? 0}%` }} />
                    </span>
                    <strong>{snapshot.usage.subscriptionPercent ?? "—"}%</strong>
                    <span>{Math.round(snapshot.usage.tokens / 1000)}k</span>
                  </button>
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
                {workspaceLoading ? (
                  <div className="route-loading" role="status" aria-live="polite">
                    Loading your local workspace…
                  </div>
                ) : !activeProject ? (
                  <EmptyProjectState
                    busy={openingProject}
                    onOpenProject={() => void openProject()}
                  />
                ) : centerView === "task" ? (
                  <>
                    <div className="transcript-scroll">
                      {activeTask ? (
                        <Suspense
                          fallback={
                            <div className="route-loading" role="status" aria-live="polite">
                              Loading task…
                            </div>
                          }
                        >
                          <Transcript events={snapshot.transcript} />
                        </Suspense>
                      ) : (
                        <EmptyTaskState project={activeProject} />
                      )}
                    </div>
                    <Composer
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
                  usage={snapshot.usage}
                  activeFile={activeFile}
                  onSelectFile={selectFile}
                  onStageFile={stageFile}
                  onCommit={commit}
                  onPush={push}
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
