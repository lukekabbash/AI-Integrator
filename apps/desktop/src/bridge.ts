import type { WorkspaceSnapshot } from "./demoData";
import { createDemoSnapshot, createEmptySnapshot } from "./demoData";

export type RuntimeId = "codex" | "cursor" | "claude" | "grok" | "gemini" | "custom";
export type TaskStatus =
  "draft" | "starting" | "running" | "waiting" | "completed" | "failed" | "stopped";
export type UsageProvenance = "vendor_exact" | "local_observed" | "estimated" | "unavailable";

export interface RuntimeConnection {
  id: RuntimeId;
  name: string;
  command: string;
  version?: string;
  account?: string;
  status: "connected" | "login_required" | "not_installed" | "probing" | "degraded";
  fidelity: "native" | "structured" | "acp" | "pty";
  models: string[];
  detail: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  branch: string;
  dirtyFiles: number;
  expanded: boolean;
}

export interface TaskSummary {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  runtime: RuntimeId;
  model: string;
  updatedAt: string;
  unread?: boolean;
  worktree?: string;
}

export interface TranscriptEvent {
  id: string;
  kind: "user" | "assistant" | "activity" | "tool" | "approval" | "checkpoint" | "notice";
  title?: string;
  body: string;
  timestamp: string;
  status?: "running" | "success" | "warning" | "error" | "neutral";
  meta?: string;
  children?: TranscriptEvent[];
}

export interface ChildAgent {
  id: string;
  parentId?: string;
  name: string;
  role: string;
  runtime: RuntimeId;
  model: string;
  status: TaskStatus;
  activity: string;
  elapsed: string;
  usagePercent?: number;
  worktree?: string;
  messages: number;
}

export interface UsageMetric {
  label: string;
  value: string;
  numeric?: number;
  provenance: UsageProvenance;
  detail: string;
}

export interface UsageSnapshot {
  subscriptionPercent?: number;
  resetAt?: string;
  tokens: number;
  equivalentUsd: number;
  actualUsd?: number;
  metrics: UsageMetric[];
}

export interface DiffLine {
  oldNumber?: number;
  newNumber?: number;
  kind: "context" | "add" | "delete" | "hunk";
  content: string;
  tokens?: Array<{
    text: string;
    kind: "keyword" | "string" | "type" | "comment" | "plain" | "function";
  }>;
}

export interface DiffFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  staged: boolean;
  lines: DiffLine[];
}

export interface GitSnapshot {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  worktree: string;
  files: DiffFile[];
  commits: Array<{ id: string; subject: string; relativeTime: string; current?: boolean }>;
}

export interface StartTaskInput {
  projectId: string;
  prompt: string;
  runtime: RuntimeId;
  model: string;
  permission: "read-only" | "project-write" | "ask" | "full-access";
  delegation: "off" | "manual" | "balanced" | "budget-first";
}

export interface SendTurnInput extends Omit<StartTaskInput, "projectId"> {
  taskId: string;
}

export interface AppBridge {
  loadWorkspace(): Promise<WorkspaceSnapshot>;
  openProject(): Promise<ProjectSummary | null>;
  registerProject(path: string): Promise<ProjectSummary>;
  listProjects(): Promise<ProjectSummary[]>;
  probeRuntimes(): Promise<RuntimeConnection[]>;
  beginRuntimeLogin(runtime: RuntimeId): Promise<RuntimeConnection>;
  startTask(input: StartTaskInput): Promise<TaskSummary>;
  sendTurn(input: SendTurnInput): Promise<TranscriptEvent>;
  stageFiles(taskId: string, paths: string[], staged: boolean): Promise<GitSnapshot>;
  commit(taskId: string, message: string): Promise<GitSnapshot>;
  push(taskId: string): Promise<GitSnapshot>;
  persistSession(snapshot: WorkspaceSnapshot): Promise<void>;
}

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

interface NativeTask {
  id: string;
  title: string;
  repositoryPath?: string;
  worktreePath?: string;
  state: "draft" | "ready" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

interface NativeProviderStatus {
  provider: "codex" | "claude" | "gemini" | "cursor" | "grok" | "custom-acp";
  installed: boolean;
  executable?: string;
  version?: string;
  authentication: "authenticated" | "loggedOut" | "unavailable" | "unknown" | "needsAttention";
  transport?: "jsonlStdio" | "acpStdio" | "externalApplication";
  diagnosticCode?: string;
}

interface NativeExport {
  tasks: NativeTask[];
  projects?: TrustedProject[];
  providerSessions: Array<{
    taskId: string;
    provider: NativeProviderStatus["provider"];
    providerThreadId: string;
  }>;
}

interface TrustedProject {
  id: string;
  displayName: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  createdAt: string;
  lastOpenedAt: string;
}

interface NativeRepository {
  root: string;
  branch?: string;
}

interface NativeFileStatus {
  indexStatus: string;
  worktreeStatus: string;
  path: string;
}

interface NativeDiff {
  patch: string;
  truncated: boolean;
}

interface NativePushPreview {
  branch: string;
  remote?: string;
  upstream?: string;
  ahead: number;
  behind: number;
}

const nativeTaskIds = new Map<string, string>();
const repositoryByTaskId = new Map<string, string>();
const codexThreadByTask = new Map<string, string>();
const activeCodexThreads = new Set<string>();
let cachedWorkspace: WorkspaceSnapshot | undefined;
let codexConnected = false;

const DEMO_STORAGE_KEY = "aiintegrator.demo.workspace.v1";

function isTauri(): boolean {
  return typeof window !== "undefined" && Boolean((window as TauriWindow).__TAURI_INTERNALS__);
}

async function nativeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

function readDemoSnapshot(): WorkspaceSnapshot {
  if (typeof window === "undefined") return createDemoSnapshot();
  try {
    const stored = window.localStorage.getItem(DEMO_STORAGE_KEY);
    if (!stored) return createDemoSnapshot();
    const parsed = JSON.parse(stored) as WorkspaceSnapshot;
    return {
      ...parsed,
      activeProjectId:
        parsed.activeProjectId ??
        parsed.tasks.find((task) => task.id === parsed.activeTaskId)?.projectId ??
        parsed.projects[0]?.id ??
        "",
    };
  } catch {
    return createDemoSnapshot();
  }
}

function writeDemoSnapshot(snapshot: WorkspaceSnapshot): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage is an enhancement in browser preview; native persistence remains authoritative.
  }
}

async function invokeOrDemo<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  demo: () => T | Promise<T>,
): Promise<T> {
  if (isTauri()) {
    return nativeInvoke<T>(command, args);
  }
  return demo();
}

function runtimeId(provider: NativeProviderStatus["provider"]): RuntimeId {
  return provider === "custom-acp" ? "custom" : provider;
}

function mapRuntime(status: NativeProviderStatus): RuntimeConnection {
  const id = runtimeId(status.provider);
  const names: Record<RuntimeId, string> = {
    codex: "Codex",
    cursor: "Cursor",
    claude: "Claude Code",
    grok: "Grok",
    gemini: "Gemini",
    custom: "Custom ACP",
  };
  const connected = status.installed && status.authentication === "authenticated";
  return {
    id,
    name: names[id],
    command: status.executable ?? status.provider,
    version: status.version,
    account: connected ? "Vendor CLI session" : undefined,
    status: !status.installed
      ? "not_installed"
      : status.authentication === "loggedOut"
        ? "login_required"
        : connected
          ? "connected"
          : "degraded",
    fidelity:
      status.provider === "codex"
        ? "native"
        : status.transport === "acpStdio"
          ? "acp"
          : status.transport === "jsonlStdio"
            ? "structured"
            : "pty",
    models: [],
    detail: status.diagnosticCode ?? (connected ? "Authenticated local CLI" : "Status unavailable"),
  };
}

function mapTaskStatus(state: NativeTask["state"]): TaskStatus {
  if (state === "ready") return "draft";
  if (state === "cancelled") return "stopped";
  return state;
}

function mapProject(project: TrustedProject): ProjectSummary {
  return {
    id: project.id,
    name: project.displayName,
    path: project.repositoryRoot,
    branch: "",
    dirtyFiles: 0,
    expanded: true,
  };
}

function projectForPath(snapshot: WorkspaceSnapshot, path?: string): ProjectSummary {
  const existing = snapshot.projects.find((project) => project.path === path);
  if (existing) return existing;
  const normalized = path ?? "Local workspace";
  return {
    id: `project-${snapshot.projects.length + 1}`,
    name: normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace",
    path: normalized,
    branch: "",
    dirtyFiles: 0,
    expanded: true,
  };
}

async function loadNativeWorkspace(): Promise<WorkspaceSnapshot> {
  await nativeInvoke("app_bootstrap");
  const [local, providers] = await Promise.all([
    nativeInvoke<NativeExport>("local_export"),
    nativeInvoke<NativeProviderStatus[]>("provider_discover"),
  ]);
  const snapshot = createEmptySnapshot();
  const projects: ProjectSummary[] = (local.projects ?? []).map(mapProject);
  const tasks = local.tasks.map((task) => {
    const project = projectForPath({ ...snapshot, projects }, task.repositoryPath);
    if (!projects.some((item) => item.id === project.id)) projects.push(project);
    nativeTaskIds.set(task.id, task.id);
    if (task.repositoryPath) repositoryByTaskId.set(task.id, task.repositoryPath);
    return {
      id: task.id,
      projectId: project.id,
      title: task.title,
      status: mapTaskStatus(task.state),
      runtime: "codex" as const,
      model: "Provider default",
      updatedAt: task.updatedAt,
      worktree: task.worktreePath,
    };
  });
  for (const session of local.providerSessions) {
    if (session.provider === "codex")
      codexThreadByTask.set(session.taskId, session.providerThreadId);
  }
  const merged: WorkspaceSnapshot = {
    ...snapshot,
    projects,
    tasks,
    activeTaskId: tasks[0]?.id ?? "",
    activeProjectId: tasks[0]?.projectId ?? projects[0]?.id ?? "",
    runtimes: providers.map(mapRuntime),
  };
  cachedWorkspace = merged;
  return merged;
}

function repositoryForTask(taskId: string): string {
  const knownRepository = repositoryByTaskId.get(taskId);
  if (knownRepository) return knownRepository;
  const snapshot = cachedWorkspace ?? readDemoSnapshot();
  const task = snapshot.tasks.find((item) => item.id === taskId);
  const project = snapshot.projects.find((item) => item.id === task?.projectId);
  if (!project?.path) throw new Error(`Task ${taskId} is not paired with a repository`);
  return project.path;
}

async function ensureNativeTask(taskId: string): Promise<string> {
  const mapped = nativeTaskIds.get(taskId);
  if (mapped) return mapped;
  const snapshot = cachedWorkspace ?? readDemoSnapshot();
  const task = snapshot.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  const repositoryPath = repositoryForTask(taskId);
  const created = await nativeInvoke<NativeTask>("task_create", {
    input: { title: task.title, repositoryPath, worktreePath: undefined },
  });
  nativeTaskIds.set(taskId, created.id);
  return created.id;
}

function extractThreadId(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const value = response as { thread?: { id?: unknown }; threadId?: unknown };
  const id = value.thread?.id ?? value.threadId;
  return typeof id === "string" ? id : undefined;
}

async function ensureCodexThread(input: SendTurnInput): Promise<string> {
  const nativeTaskId = await ensureNativeTask(input.taskId);
  const existing = codexThreadByTask.get(nativeTaskId) ?? codexThreadByTask.get(input.taskId);
  const cwd = repositoryForTask(input.taskId);
  if (!codexConnected) {
    await nativeInvoke("codex_connect", { workingDirectory: cwd });
    codexConnected = true;
    activeCodexThreads.clear();
  }
  if (existing) {
    if (!activeCodexThreads.has(existing)) {
      await nativeInvoke("codex_resume_thread", { threadId: existing });
      activeCodexThreads.add(existing);
    }
    return existing;
  }
  const model = input.model.includes(" ") ? undefined : input.model;
  const started = await nativeInvoke<unknown>("codex_start_thread", {
    taskId: nativeTaskId,
    cwd,
    model,
  });
  const threadId = extractThreadId(started);
  if (!threadId) throw new Error("Codex did not return a thread identifier");
  codexThreadByTask.set(nativeTaskId, threadId);
  codexThreadByTask.set(input.taskId, threadId);
  activeCodexThreads.add(threadId);
  return threadId;
}

function diffLines(patch: string): DiffLine[] {
  return patch
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("diff --git") && !line.startsWith("index "))
    .map((line) => {
      if (line.startsWith("@@")) return { kind: "hunk" as const, content: line };
      if (line.startsWith("+++") || line.startsWith("---")) {
        return { kind: "context" as const, content: line };
      }
      if (line.startsWith("+")) return { kind: "add" as const, content: line.slice(1) };
      if (line.startsWith("-")) return { kind: "delete" as const, content: line.slice(1) };
      return { kind: "context" as const, content: line.startsWith(" ") ? line.slice(1) : line };
    });
}

async function refreshNativeGit(taskId: string): Promise<GitSnapshot> {
  const repository = repositoryForTask(taskId);
  const [identity, statuses] = await Promise.all([
    nativeInvoke<NativeRepository>("git_repository", { path: repository }),
    nativeInvoke<NativeFileStatus[]>("git_status", { repository }),
  ]);
  const preview = await nativeInvoke<NativePushPreview>("git_push_preview", { repository }).catch(
    () => undefined,
  );
  const files = await Promise.all(
    statuses.map(async (status): Promise<DiffFile> => {
      const staged = status.indexStatus !== " " && status.indexStatus !== "?";
      const scope = staged ? "staged" : "unstaged";
      const diff = await nativeInvoke<NativeDiff>("git_diff", {
        repository,
        scope,
        path: status.path,
      }).catch(() => ({ patch: "", truncated: false }));
      const lines = diffLines(diff.patch);
      const code = staged ? status.indexStatus : status.worktreeStatus;
      return {
        path: status.path,
        status:
          code === "A" || code === "?"
            ? "added"
            : code === "D"
              ? "deleted"
              : code === "R"
                ? "renamed"
                : "modified",
        additions: lines.filter((line) => line.kind === "add").length,
        deletions: lines.filter((line) => line.kind === "delete").length,
        staged,
        lines,
      };
    }),
  );
  return {
    branch: identity.branch ?? preview?.branch ?? "detached",
    upstream: preview?.upstream ?? "Not published",
    ahead: preview?.ahead ?? 0,
    behind: preview?.behind ?? 0,
    worktree: identity.root,
    files,
    commits: [],
  };
}

export const bridge: AppBridge = {
  loadWorkspace: () => (isTauri() ? loadNativeWorkspace() : Promise.resolve(readDemoSnapshot())),

  openProject: async () => {
    if (isTauri()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Open a Git project",
      });
      if (typeof selected !== "string") return null;
      return bridge.registerProject(selected);
    }

    return bridge.registerProject("C:\\Code\\demo-project");
  },

  registerProject: async (path) => {
    if (isTauri()) {
      const project = await nativeInvoke<TrustedProject>("project_register", { path });
      return mapProject(project);
    }
    const snapshot = readDemoSnapshot();
    const existing = snapshot.projects.find((project) => project.path === path);
    if (existing) return existing;
    return {
      id: `project-${Date.now()}`,
      name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Demo project",
      path,
      branch: "main",
      dirtyFiles: 0,
      expanded: true,
    };
  },

  listProjects: async () => {
    if (isTauri()) {
      return (await nativeInvoke<TrustedProject[]>("project_list")).map(mapProject);
    }
    return readDemoSnapshot().projects;
  },

  probeRuntimes: () =>
    invokeOrDemo<NativeProviderStatus[]>("provider_discover", undefined, () => []).then(
      (statuses) => (isTauri() ? statuses.map(mapRuntime) : readDemoSnapshot().runtimes),
    ),

  beginRuntimeLogin: async (runtime) => {
    if (isTauri()) {
      if (runtime !== "codex") {
        throw new Error(`${runtime} setup is not exposed by the native backend yet`);
      }
      const snapshot = cachedWorkspace ?? readDemoSnapshot();
      const active = snapshot.tasks.find((task) => task.id === snapshot.activeTaskId);
      const workingDirectory = active ? repositoryForTask(active.id) : undefined;
      await nativeInvoke("codex_connect", { workingDirectory });
      codexConnected = true;
      activeCodexThreads.clear();
      const status = (await nativeInvoke<NativeProviderStatus[]>("provider_discover")).find(
        (item) => item.provider === "codex",
      );
      if (!status) throw new Error("Codex was not found after connection");
      return mapRuntime(status);
    }
    const current = readDemoSnapshot().runtimes.find((item) => item.id === runtime);
    if (!current) throw new Error(`Unknown runtime: ${runtime}`);
    return {
      ...current,
      status: "connected",
      account: current.account ?? "Local CLI session",
      detail: "Authenticated by the vendor-owned setup flow.",
    };
  },

  startTask: async (input) => {
    if (isTauri()) {
      const snapshot = cachedWorkspace ?? readDemoSnapshot();
      const project = snapshot.projects.find((item) => item.id === input.projectId);
      if (!project) throw new Error(`Unknown project: ${input.projectId}`);
      const task = await nativeInvoke<NativeTask>("task_create", {
        input: {
          title: input.prompt.slice(0, 240) || "New task",
          repositoryPath: project.path,
          worktreePath: undefined,
        },
      });
      nativeTaskIds.set(task.id, task.id);
      repositoryByTaskId.set(task.id, project.path);
      return {
        id: task.id,
        projectId: input.projectId,
        title: task.title,
        status: mapTaskStatus(task.state),
        runtime: input.runtime,
        model: input.model,
        updatedAt: task.updatedAt,
      };
    }
    return {
      id: `task-${Date.now()}`,
      projectId: input.projectId,
      title: input.prompt.slice(0, 54) || "New task",
      status: "running",
      runtime: input.runtime,
      model: input.model,
      updatedAt: new Date().toISOString(),
      unread: false,
      worktree: `ai/${new Date().toISOString().slice(0, 10)}`,
    };
  },

  sendTurn: async (input) => {
    if (isTauri()) {
      if (input.runtime !== "codex") {
        throw new Error(`${input.runtime} turn execution is not implemented by the native backend`);
      }
      const threadId = await ensureCodexThread(input);
      await nativeInvoke("codex_start_turn", { threadId, prompt: input.prompt });
    }
    return {
      id: `event-${Date.now()}`,
      kind: "user",
      body: input.prompt,
      timestamp: new Date().toISOString(),
      status: "neutral",
    };
  },

  stageFiles: async (taskId, paths, staged) => {
    if (isTauri()) {
      const repository = repositoryForTask(taskId);
      await nativeInvoke(staged ? "git_stage" : "git_unstage", { repository, paths });
      return refreshNativeGit(taskId);
    }
    const git = readDemoSnapshot().git;
    return {
      ...git,
      files: git.files.map((file) => (paths.includes(file.path) ? { ...file, staged } : file)),
    };
  },

  commit: async (taskId, message) => {
    if (isTauri()) {
      const repository = repositoryForTask(taskId);
      await nativeInvoke("git_commit", { repository, message });
      return refreshNativeGit(taskId);
    }
    const git = readDemoSnapshot().git;
    return {
      ...git,
      ahead: git.ahead + 1,
      files: git.files.map((file) => ({ ...file, staged: false })),
      commits: [
        { id: "local", subject: message, relativeTime: "now", current: true },
        ...git.commits.map((commit) => ({ ...commit, current: false })),
      ],
    };
  },

  push: async (taskId) => {
    if (isTauri()) {
      const repository = repositoryForTask(taskId);
      await nativeInvoke("git_push_preview", { repository });
      throw new Error("Push preview is ready, but confirmed native push is not implemented yet");
    }
    return { ...readDemoSnapshot().git, ahead: 0 };
  },

  persistSession: async (snapshot) => {
    cachedWorkspace = snapshot;
    if (!isTauri()) writeDemoSnapshot(snapshot);
  },
};
