import type { WorkspaceSnapshot } from "./demoData";
import { createDemoSnapshot, createEmptySnapshot } from "./demoData";

export type RuntimeId = "codex" | "cursor" | "claude" | "grok" | "antigravity" | "custom";
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

/**
 * Keep auth messaging tied to the native probe result. A provider that has
 * been verified should not carry a generic warning merely because it is not
 * Codex; degraded and login-required states remain visible and actionable.
 */
export function runtimeAuthWarning(runtime: RuntimeConnection | undefined): string | undefined {
  if (!runtime) return undefined;
  if (runtime.status === "login_required") {
    return `${runtime.name} reports that its vendor-owned login is required.`;
  }
  if (runtime.status !== "degraded") return undefined;
  if (runtime.detail === "auth-probe-requires-acp") {
    return `${runtime.name} auth is checked during its ACP session handshake.`;
  }
  if (runtime.detail === "client-unsupported") {
    return (
      runtime.name +
      " reports that this installed CLI/account route is unsupported; follow the vendor's migration or configure a supported API-key/Vertex route."
    );
  }
  if (runtime.detail === "auth-probe-timeout") {
    return `${runtime.name} auth check timed out; try Check status again before sending.`;
  }
  if (runtime.detail === "auth-probe-failed" || runtime.detail === "auth-status-unknown") {
    return `${runtime.name} auth check needs attention; try Check status again before sending.`;
  }
  return `${runtime.name} is available but needs attention: ${runtime.detail}.`;
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
  /** Last reasoning-effort selection for this chat when the model supports it. */
  effort?: string;
  updatedAt: string;
  unread?: boolean;
  worktree?: string;
  pinned?: boolean;
  archived?: boolean;
  /** Set for delegated-subagent tasks; they are hidden from the sidebar and
   * surfaced through the parent's Agents rail instead. */
  parentId?: string;
}

export interface TaskNavigationMetadata {
  taskId: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  updatedAt: string;
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
  /** Labeled expandable sections (tool input, output, ...) shown on demand. */
  details?: Array<{ label: string; body: string }>;
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

export type DelegationStatus =
  | "pending-approval"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "stopped"
  | "denied";

/** One delegated subagent as reported by the native delegation broker. */
export interface DelegationView {
  id: string;
  parentTaskId: string;
  childTaskId?: string | null;
  profileId: string;
  profileLabel: string;
  runtime: string;
  model?: string | null;
  effort?: string | null;
  title: string;
  brief: string;
  status: DelegationStatus;
  result?: string | null;
  childSessionRef?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Undelivered child->orchestrator messages (badge count). */
  unreadFromChild: number;
  /** Bodies of the undelivered child messages, e.g. questions awaiting an answer. */
  pendingQuestions: string[];
}

export interface UsageMetric {
  label: string;
  value: string;
  numeric?: number;
  provenance: UsageProvenance;
  detail: string;
}

/**
 * Evidence the browser fallback can collect without asking a provider for
 * credentials, scraping a subscription page, or pretending an estimate is a
 * bill. A turn is de-duplicated by its transcript event id.
 */
export interface LocalUsageEvent {
  id: string;
  timestamp: string;
  promptCharacters: number;
  estimatedInputTokens: number;
  estimatedEquivalentUsd: number;
}

export interface LocalUsageEvidence {
  events: LocalUsageEvent[];
}

export interface UsageSnapshot {
  subscriptionPercent?: number;
  resetAt?: string;
  tokens: number;
  equivalentUsd: number;
  actualUsd?: number;
  metrics: UsageMetric[];
  /** Browser-only, local turn evidence. Never represents vendor telemetry. */
  localObserved?: LocalUsageEvidence;
}

export interface StorageTotals {
  totalBytes: number;
  databaseBytes: number;
  walBytes: number;
  sharedMemoryBytes: number;
  measuredAt: string;
  kind: "sqlite" | "browser-local-storage";
}

export interface ProviderUsageSummary {
  provider: RuntimeId | "unknown";
  taskCount: number;
  turnCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  modelContextWindow?: number;
  /** Vendor-computed API-equivalent cost in USD. An estimate, not a bill;
   * only providers that report one (Claude) populate it. */
  estimatedCostUsd?: number;
  /** Provider-reported subscription windows; only providers that publish
   * quota (Codex) populate it. Never inferred. */
  subscription?: SubscriptionQuota;
  provenance: UsageProvenance;
  detail: string;
}

/** One provider-reported rate-limit window; `resetsAt` is Unix seconds. */
export interface SubscriptionWindow {
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export interface SubscriptionQuota {
  planType?: string;
  primary?: SubscriptionWindow;
  secondary?: SubscriptionWindow;
  updatedAt?: string;
}

export interface UsageSummary {
  providers: ProviderUsageSummary[];
  measuredAt: string;
}

export interface LocalSetting {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface LocalAppInfo {
  applicationVersion: string;
  domainSchemaVersion: number;
  dataDirectory: string;
  localOnly: boolean;
}

export interface VoiceTypingCredentialStatus {
  configured: boolean;
  storage: "os-credential-store" | "native-only";
  provider: "openai";
}

export interface VoiceTypingEvent {
  kind: "delta" | "completed" | "error";
  text: string;
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

export interface ProjectFileEntry {
  path: string;
  size: number;
}

export interface ProjectFileContent {
  path: string;
  content: string;
  isBinary: boolean;
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
  /** Reasoning-effort level id from the model's catalog entry; omitted for the provider default. */
  effort?: string;
  permission: "read-only" | "project-write" | "ask" | "full-access";
  delegation: "off" | "manual" | "balanced" | "budget-first";
}

export interface ModelEffortOption {
  id: string;
  label: string;
}

export interface ModelCatalogEntry {
  id: string;
  label: string;
  /** Discrete reasoning-effort levels the model accepts; absent when the provider exposes none. */
  efforts?: ModelEffortOption[];
  defaultEffort?: string;
}

/**
 * Resolve a saved effort against the selected model's advertised capability.
 * Provider catalogs are authoritative; a saved value is only reused when the
 * current model explicitly supports it.
 */
export function resolveModelEffort(
  entry: ModelCatalogEntry | undefined,
  preferred?: string,
): string | undefined {
  const efforts = entry?.efforts ?? [];
  if (preferred && efforts.some((option) => option.id === preferred)) return preferred;
  if (entry?.defaultEffort && efforts.some((option) => option.id === entry.defaultEffort)) {
    return entry.defaultEffort;
  }
  return efforts[0]?.id;
}

export interface SendTurnInput extends Omit<StartTaskInput, "projectId"> {
  taskId: string;
}

export interface TurnProjection {
  id: string;
  status: "pending" | "inProgress" | "completed" | "failed" | "interrupted";
  stopRequested: boolean;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ItemProjection {
  id: string;
  providerItemId: string;
  kind:
    | "userMessage"
    | "agentMessage"
    | "reasoningSummary"
    | "commandExecution"
    | "fileChange"
    | "mcpTool"
    | "unknown";
  status: "pending" | "inProgress" | "completed" | "failed" | "declined";
  title?: string;
  body?: string;
  command?: string;
  cwd?: string;
  output?: string;
  exitCode?: number;
  fileChanges?: Array<{
    path: string;
    changeKind: "add" | "modify" | "delete" | "rename" | "unknown";
    patch?: string;
  }>;
  mcpServer?: string;
  mcpTool?: string;
  toolInput?: string;
  truncated: boolean;
  updatedAt: string;
}

export interface PlanStepProjection {
  index: number;
  text: string;
  status: "pending" | "inProgress" | "completed";
}

export interface RuntimeUsageProjection {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  modelContextWindow?: number;
  /** Vendor-computed API-equivalent cost in micro-USD (Claude only today). */
  vendorCostMicroUsd?: number;
}

export interface ApprovalProjection {
  id: string;
  requestId: { kind: "number"; value: number } | { kind: "string"; value: string };
  approvalKind: "commandExecution" | "fileChange";
  state:
    "pending" | "responding" | "resolved" | "declined" | "cancelled" | "expired" | "responseFailed";
  decision?: "accept" | "acceptForSession" | "decline" | "cancel";
  itemId?: string;
  approvalId?: string;
  reason?: string;
  command?: string;
  cwd?: string;
  fileChanges?: ItemProjection["fileChanges"];
  updatedAt: string;
}

export type ConnectionProjection = {
  state: "connecting" | "connected" | "disconnected" | "reconciling" | "gap";
  reason?: string;
  processId?: string;
};

export type RuntimeProjection =
  | { kind: "turnChanged"; turn: TurnProjection }
  | { kind: "itemChanged"; item: ItemProjection }
  | { kind: "planChanged"; steps: PlanStepProjection[]; truncated: boolean }
  | { kind: "diffChanged"; diff: string; truncated: boolean }
  | { kind: "usageChanged"; usage: RuntimeUsageProjection }
  | { kind: "approvalChanged"; approval: ApprovalProjection }
  | { kind: "turnError"; message: string; retryable: boolean }
  | {
      kind: "connectionChanged";
      state: ConnectionProjection["state"];
      reason?: string;
      processId?: string;
    }
  | { kind: "projectionReset"; reason: string };

export interface RuntimeProjectionEvent {
  seq: number;
  taskId: string;
  providerSessionId: string;
  provider: "codex" | "cursor" | "claude" | "antigravity" | "grok" | "custom-acp";
  threadId: string;
  turnId?: string;
  occurredAt: string;
  projection: RuntimeProjection;
}

export interface TaskProjectionSnapshot {
  events: RuntimeProjectionEvent[];
  watermarkSeq: number;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface TerminalSessionInfo {
  id: string;
  cwd: string;
  shell: string;
}

export interface TerminalCommandStarted {
  /** Absent when the command completed inline (blank input or a `cd`). */
  runId?: string | null;
  cwd: string;
}

export interface TerminalOutputEvent {
  sessionId: string;
  runId: string;
  stream: "stdout" | "stderr" | "exit";
  line?: string;
  exitCode?: number | null;
  cwd: string;
}

export interface AppBridge {
  getAppInfo(): Promise<LocalAppInfo>;
  getStorageTotals(): Promise<StorageTotals>;
  getUsageSummary(): Promise<UsageSummary>;
  listSettings(): Promise<LocalSetting[]>;
  setSetting(key: string, value: unknown): Promise<LocalSetting>;
  getVoiceTypingCredentialStatus?(): Promise<VoiceTypingCredentialStatus>;
  setVoiceTypingCredential?(apiKey: string): Promise<VoiceTypingCredentialStatus>;
  clearVoiceTypingCredential?(): Promise<void>;
  startVoiceTyping?(): Promise<void>;
  appendVoiceTypingPcm?(pcm: number[]): Promise<void>;
  stopVoiceTyping?(): Promise<void>;
  subscribeVoiceTyping?(listener: (event: VoiceTypingEvent) => void): Promise<() => void>;
  exportLocalData(): Promise<unknown>;
  clearLocalData(): Promise<void>;
  loadWorkspace(): Promise<WorkspaceSnapshot>;
  openProject(): Promise<ProjectSummary | null>;
  /** Pick a parent folder, create `<parent>/<name>`, git-init it, and register it. */
  createProject(name: string): Promise<ProjectSummary | null>;
  registerProject(path: string): Promise<ProjectSummary>;
  listProjects(): Promise<ProjectSummary[]>;
  probeRuntimes(): Promise<RuntimeConnection[]>;
  beginRuntimeLogin(runtime: RuntimeId): Promise<RuntimeConnection>;
  startTask(input: StartTaskInput): Promise<TaskSummary>;
  loadTaskGit(taskId: string): Promise<GitSnapshot>;
  listProjectFiles(projectId: string): Promise<ProjectFileEntry[]>;
  readProjectFile(projectId: string, path: string): Promise<ProjectFileContent>;
  openTerminal(projectId: string): Promise<TerminalSessionInfo>;
  runTerminalCommand(sessionId: string, command: string): Promise<TerminalCommandStarted>;
  interruptTerminal(sessionId: string): Promise<void>;
  closeTerminal(sessionId: string): Promise<void>;
  subscribeTerminalOutput(listener: (event: TerminalOutputEvent) => void): Promise<() => void>;
  supportsTaskMetadata(): boolean;
  updateTaskMetadata(
    taskId: string,
    input: { title?: string; pinned?: boolean; archived?: boolean },
  ): Promise<TaskNavigationMetadata>;
  /** Persist provider/model/effort for a chat so reopen restores the same route. */
  updateTaskRouting(
    taskId: string,
    input: { runtime: RuntimeId; model: string; effort?: string },
  ): Promise<TaskSummary>;
  sendTurn(input: SendTurnInput): Promise<TranscriptEvent>;
  /** Delegated subagents of a task (native delegation broker; empty in browser mode). */
  listDelegations(taskId: string): Promise<DelegationView[]>;
  approveDelegation(delegationId: string): Promise<void>;
  denyDelegation(delegationId: string): Promise<void>;
  /** User nudge to a running subagent; queued and delivered when it is idle. */
  sendDelegationMessage(delegationId: string, message: string): Promise<void>;
  stopDelegation(delegationId: string): Promise<void>;
  subscribeDelegationUpdates(listener: (parentTaskId: string) => void): Promise<() => void>;
  subscribeRuntimeProjections(
    listener: (event: RuntimeProjectionEvent) => void,
  ): Promise<() => void>;
  loadTaskProjection(taskId: string): Promise<TaskProjectionSnapshot>;
  respondToApproval(
    taskId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalProjection>;
  stopTurn(taskId: string): Promise<{
    turnId: string;
    stopRequested: true;
    alreadyRequested: boolean;
    /** True when a dead session was force-settled instead of interrupted live. */
    settled?: boolean;
  }>;
  stageFiles(taskId: string, paths: string[], staged: boolean): Promise<GitSnapshot>;
  commit(taskId: string, message: string): Promise<GitSnapshot>;
  push(taskId: string): Promise<GitSnapshot>;
  persistSession(snapshot: WorkspaceSnapshot): Promise<void>;
  listModels(runtime: RuntimeId): Promise<string[]>;
  listModelCatalog(runtime: RuntimeId): Promise<ModelCatalogEntry[]>;
}

/**
 * Opens a safe external link in a new tab of the user's main browser. Native
 * builds delegate to the narrow Tauri command; browser previews use the
 * browser's own new-tab behavior. Honors the "Confirm external actions"
 * setting (on by default) before anything leaves the app.
 */
export async function openExternalLink(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl, window.location.href);
  if (!url.hostname || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP(S) links can be opened externally.");
  }

  const settings = (await bridge.listSettings().catch(() => [])) ?? [];
  const confirmFirst =
    settings.find((setting) => setting.key === "settings.general.confirmExternalActions")?.value !==
    false;
  if (confirmFirst && !window.confirm(`Open ${url.toString()} in your default browser?`)) {
    return;
  }

  if (isTauri()) {
    await nativeInvoke("open_external_url", { url: url.toString() });
    return;
  }

  const opened = window.open(url.toString(), "_blank", "noopener,noreferrer");
  if (!opened) throw new Error("The browser blocked opening a new tab.");
}

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

interface NativeTask {
  id: string;
  title: string;
  repositoryPath?: string;
  worktreePath?: string;
  state: "draft" | "ready" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  pinned: boolean;
  archived: boolean;
  runtime?: string;
  model?: string;
  effort?: string;
  parentTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

interface NativeProviderStatus {
  provider: "codex" | "claude" | "antigravity" | "cursor" | "grok" | "custom-acp";
  installed: boolean;
  executable?: string;
  version?: string;
  authentication: "authenticated" | "loggedOut" | "unavailable" | "unknown" | "needsAttention";
  transport?: "jsonlStdio" | "acpStdio" | "externalApplication";
  diagnosticCode?: string;
}

interface NativeExport {
  schemaVersion?: number;
  exportedAt?: string;
  tasks: NativeTask[];
  projects?: TrustedProject[];
  settings?: LocalSetting[];
  providerSessions: Array<{
    taskId: string;
    provider: NativeProviderStatus["provider"];
    providerThreadId: string;
  }>;
}

interface NativeBootstrap {
  schemaVersion: number;
  value: LocalAppInfo;
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

/// Placeholder that defers to the provider CLI's own configured model; it is
/// intentionally spaced so the send path never forwards it as a model id.
export const PROVIDER_DEFAULT_MODEL = "Provider default";
const modelCatalogCache = new Map<RuntimeId, ModelCatalogEntry[]>();
/** Cursor only: thought-level session config option id per model id. */
const cursorEffortConfigByModel = new Map<string, string>();
/** Cursor only: the ACP config option id used for model selection. */
let cursorModelConfigId: string | undefined;
const FALLBACK_MODELS: Partial<Record<RuntimeId, string[]>> = {
  codex: [PROVIDER_DEFAULT_MODEL],
  claude: [
    PROVIDER_DEFAULT_MODEL,
    "claude-opus-4-8",
    "claude-fable-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
  ],
  antigravity: [PROVIDER_DEFAULT_MODEL, "Gemini 3.1 Pro", "Gemini 3.5 Flash"],
  // These are a degraded fallback only. A successfully negotiated Cursor ACP
  // catalog replaces them with the models available to the signed-in account.
  cursor: [
    PROVIDER_DEFAULT_MODEL,
    "composer-2.5",
    "cursor-small",
    "deepseek-v3.1",
    "deepseek-r1",
    "auto",
  ],
  grok: [PROVIDER_DEFAULT_MODEL, "grok-4.5", "grok-build-0.1"],
  custom: [PROVIDER_DEFAULT_MODEL],
};

const CHAT_TITLE_MAX_LENGTH = 54;

/**
 * Keep a new chat's label useful in the rail without copying an entire prompt
 * into it. This is intentionally local and deterministic: title generation
 * must not add a second provider request or move prompt text across the native
 * boundary just to name a task.
 */
export function deriveChatTitle(prompt: string, maxLength = CHAT_TITLE_MAX_LENGTH): string {
  const firstLine = prompt
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    .find(Boolean);
  if (!firstLine) return "New task";

  const cleaned = firstLine
    .replace(/^(please|can you|could you|would you|i need you to|help me)\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .trim();
  if (!cleaned) return "New task";
  if (cleaned.length <= maxLength) return cleaned;

  const firstClause = cleaned.split(/[,;:]\s+/)[0]?.trim();
  if (firstClause && firstClause.length >= 18 && firstClause.length <= maxLength) {
    return firstClause;
  }
  return `${cleaned.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function toCatalogEntries(ids: string[]): ModelCatalogEntry[] {
  return ids.map((id) => ({ id, label: id }));
}

function effortLabel(id: string): string {
  const labels: Record<string, string> = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
  };
  return labels[id] ?? (id.length > 0 ? id.charAt(0).toUpperCase() + id.slice(1) : id);
}

/// Codex `model/list` entries carry `supportedReasoningEfforts` and
/// `defaultReasoningEffort` alongside the model id.
export function extractCodexCatalog(response: unknown): ModelCatalogEntry[] {
  if (!response || typeof response !== "object") return [];
  const container = response as { models?: unknown; items?: unknown; data?: unknown };
  const entries = [container.models, container.items, container.data].find(Array.isArray) as
    unknown[] | undefined;
  if (!entries) return [];
  const catalog: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry === "string") {
      if (!seen.has(entry)) {
        seen.add(entry);
        catalog.push({ id: entry, label: entry });
      }
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const value = entry as {
      id?: unknown;
      model?: unknown;
      name?: unknown;
      slug?: unknown;
      displayName?: unknown;
      supportedReasoningEfforts?: unknown;
      defaultReasoningEffort?: unknown;
    };
    const id = [value.id, value.model, value.slug, value.name].find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    );
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const item: ModelCatalogEntry = {
      id,
      label: typeof value.displayName === "string" && value.displayName ? value.displayName : id,
    };
    if (Array.isArray(value.supportedReasoningEfforts)) {
      const efforts = value.supportedReasoningEfforts
        .map((effort) =>
          typeof effort === "string"
            ? effort
            : ((effort as { reasoningEffort?: unknown; effort?: unknown; id?: unknown } | null)
                ?.reasoningEffort ??
              (effort as { effort?: unknown; id?: unknown } | null)?.effort ??
              (effort as { id?: unknown } | null)?.id),
        )
        .filter((effort): effort is string => typeof effort === "string" && effort.length > 0);
      const uniqueEfforts = [...new Set(efforts)];
      if (uniqueEfforts.length > 0) {
        item.efforts = uniqueEfforts.map((effort) => ({
          id: effort,
          label: effortLabel(effort),
        }));
        if (typeof value.defaultReasoningEffort === "string") {
          item.defaultEffort = value.defaultReasoningEffort;
        }
      }
    }
    catalog.push(item);
  }
  return catalog;
}

interface AcpConfigOption {
  id?: unknown;
  category?: unknown;
  currentValue?: unknown;
  options?: unknown;
}

interface AcpConfigValue {
  value: string;
  name?: string;
}

function acpConfigValues(value: unknown): AcpConfigValue[] {
  if (!Array.isArray(value)) return [];
  const values: AcpConfigValue[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { value?: unknown; name?: unknown; options?: unknown };
    if (typeof candidate.value === "string" && candidate.value) {
      values.push({
        value: candidate.value,
        name: typeof candidate.name === "string" && candidate.name ? candidate.name : undefined,
      });
      continue;
    }
    values.push(...acpConfigValues(candidate.options));
  }
  return values;
}

function acpConfigOptions(response: unknown): AcpConfigOption[] {
  if (!response || typeof response !== "object") return [];
  const root = response as {
    configOptions?: unknown;
    session?: { configOptions?: unknown };
  };
  const options = root.configOptions ?? root.session?.configOptions;
  return Array.isArray(options)
    ? options.filter((option): option is AcpConfigOption =>
        Boolean(option && typeof option === "object"),
      )
    : [];
}

/**
 * Parse the stable ACP `session/new` configuration surface. Cursor can expose
 * Composer, frontier-provider, and open-weight models here; do not replace
 * this with a hand-maintained model list or a vendor extension RPC.
 */
export function extractAcpCatalog(response: unknown): ModelCatalogEntry[] {
  const options = acpConfigOptions(response);
  const modelOption =
    options.find((option) => option.category === "model") ??
    options.find((option) => option.id === "model" || option.id === "models");
  if (!modelOption || typeof modelOption.id !== "string") return [];
  const modelValues = acpConfigValues(modelOption.options);
  if (modelValues.length === 0) return [];

  cursorModelConfigId = modelOption.id;
  cursorEffortConfigByModel.clear();
  const thoughtOption = options.find((option) => option.category === "thought_level");
  const efforts = thoughtOption ? acpConfigValues(thoughtOption.options) : [];
  const defaultEffort =
    thoughtOption && typeof thoughtOption.currentValue === "string"
      ? thoughtOption.currentValue
      : undefined;
  const catalog: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const model of modelValues) {
    if (seen.has(model.value)) continue;
    seen.add(model.value);
    const item: ModelCatalogEntry = {
      id: model.value,
      label: model.name ?? model.value,
    };
    if (thoughtOption && typeof thoughtOption.id === "string") {
      cursorEffortConfigByModel.set(item.id, thoughtOption.id);
      const uniqueEfforts = efforts.filter(
        (effort, index) =>
          efforts.findIndex((candidate) => candidate.value === effort.value) === index,
      );
      if (uniqueEfforts.length > 0) {
        item.efforts = uniqueEfforts.map((effort) => ({
          id: effort.value,
          label: effort.name ?? effortLabel(effort.value),
        }));
        item.defaultEffort = defaultEffort;
      }
    }
    catalog.push(item);
  }
  return catalog;
}

/** Per-model reasoning parameters from Cursor's model-list extension RPC. */
export interface CursorModelParams {
  /** The `session/set_config_option` config id (e.g. "effort", "reasoning"). */
  configId: string;
  efforts: ModelEffortOption[];
  defaultEffort?: string;
}

/**
 * Parse `cursor/list_available_models`: `{models: [{value, name, configOptions}]}`.
 * A model's reasoning choices are the multi-level `thought_level` config option
 * ("effort" or "reasoning"); binary thinking on/off toggles are not a picker.
 * Keyed by the plain model name (`value`), which matches the `name` field of
 * the bracketed model ids that `session/new` advertises.
 */
export function extractCursorModelParams(response: unknown): Map<string, CursorModelParams> {
  const params = new Map<string, CursorModelParams>();
  if (!response || typeof response !== "object") return params;
  const models = (response as { models?: unknown }).models;
  if (!Array.isArray(models)) return params;
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const entry = model as { value?: unknown; configOptions?: unknown };
    if (typeof entry.value !== "string" || !entry.value) continue;
    if (!Array.isArray(entry.configOptions)) continue;
    const thoughtOptions = entry.configOptions.filter(
      (option): option is AcpConfigOption =>
        Boolean(option && typeof option === "object") &&
        (option as AcpConfigOption).category === "thought_level",
    );
    const levelOption =
      thoughtOptions.find((option) => option.id === "effort" || option.id === "reasoning") ??
      thoughtOptions.find((option) => acpConfigValues(option.options).length > 2);
    if (!levelOption || typeof levelOption.id !== "string") continue;
    const efforts = acpConfigValues(levelOption.options).map((effort) => ({
      id: effort.value,
      label: effort.name ?? effortLabel(effort.value),
    }));
    if (efforts.length === 0) continue;
    params.set(entry.value, {
      configId: levelOption.id,
      efforts,
      defaultEffort:
        typeof levelOption.currentValue === "string" ? levelOption.currentValue : undefined,
    });
  }
  return params;
}

/**
 * Attach per-model reasoning efforts to a Cursor catalog. Session catalog ids
 * are bracketed ("gpt-5.5[reasoning=medium,…]"); parameters are keyed by the
 * plain name, so match on the label first and the id's bracket-free prefix as
 * a fallback. Records each matched model's effort config id for
 * `session/set_config_option`.
 */
export function mergeCursorModelParams(
  catalog: ModelCatalogEntry[],
  params: Map<string, CursorModelParams>,
): void {
  for (const entry of catalog) {
    const plainId = entry.id.split("[")[0] ?? entry.id;
    const modelParams = params.get(entry.label) ?? params.get(plainId);
    if (!modelParams) continue;
    entry.efforts = modelParams.efforts;
    entry.defaultEffort = modelParams.defaultEffort;
    cursorEffortConfigByModel.set(entry.id, modelParams.configId);
  }
}

// v2: Gemini CLI replaced by the Antigravity runtime; stale v1 demo caches
// would keep showing the retired provider.
const DEMO_STORAGE_KEY = "aiintegrator.demo.workspace.v2";
const NAVIGATION_STORAGE_KEY = "aiintegrator.navigation.v1";
const SETTINGS_STORAGE_KEY = "aiintegrator.settings.v1";
const LOCAL_INPUT_TOKEN_ESTIMATE_PER_USD = 200_000;
const LOCAL_USAGE_METRIC_LABELS = new Set([
  "Local turns",
  "Prompt characters",
  "Input tokens (estimate)",
  "API equivalent (estimate)",
]);

type StoredNavigation = Pick<
  WorkspaceSnapshot,
  "activeProjectId" | "activeTaskId" | "lastTaskByProject" | "centerViewByTask"
>;

function isTauri(): boolean {
  return typeof window !== "undefined" && Boolean((window as TauriWindow).__TAURI_INTERNALS__);
}

export function formatBridgeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown };
    const message = typeof value.message === "string" ? value.message.trim() : "";
    const code = typeof value.code === "string" ? value.code.trim() : "";
    if (message && code) return `${message} (${code})`;
    if (message) return message;
  }
  return fallback;
}

async function nativeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(formatBridgeError(error, `Native command "${command}" failed`));
  }
}

function readDemoSnapshot(): WorkspaceSnapshot {
  if (typeof window === "undefined") return createDemoSnapshot();
  try {
    const stored = window.localStorage.getItem(DEMO_STORAGE_KEY);
    if (!stored) return createDemoSnapshot();
    const parsed = JSON.parse(stored) as WorkspaceSnapshot;
    const activeContext = parsed.activeTaskId
      ? {
          [parsed.activeTaskId]: {
            transcript: parsed.transcript ?? [],
            git: parsed.git ?? createEmptySnapshot().git,
            usage: parsed.usage ?? createEmptySnapshot().usage,
            children: parsed.children ?? [],
          },
        }
      : {};
    return {
      ...parsed,
      taskContexts: parsed.taskContexts ?? activeContext,
      lastTaskByProject: parsed.lastTaskByProject ?? {},
      centerViewByTask: parsed.centerViewByTask ?? {},
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

function readBrowserSettings(): LocalSetting[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({
      key,
      value,
      updatedAt: new Date().toISOString(),
    }));
  } catch {
    return [];
  }
}

function writeBrowserSetting(key: string, value: unknown): LocalSetting {
  const next = Object.fromEntries(
    readBrowserSettings().map((setting) => [setting.key, setting.value]),
  );
  next[key] = value;
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Browser storage is an enhancement; the UI remains usable when unavailable.
  }
  return { key, value, updatedAt: new Date().toISOString() };
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  }).format(value);
}

function estimateInputTokens(prompt: string): number {
  // This is deliberately disclosed as an estimate. The fallback has the
  // local prompt but no tokenizer or provider-side accounting payload.
  return prompt.trim() ? Math.max(1, Math.ceil(prompt.trim().length / 4)) : 0;
}

function hasVendorUsageTelemetry(usage: UsageSnapshot): boolean {
  return (
    usage.subscriptionPercent !== undefined ||
    usage.metrics.some((metric) => metric.provenance === "vendor_exact")
  );
}

function withLocalUsageMetrics(usage: UsageSnapshot, events: LocalUsageEvent[]): UsageSnapshot {
  const turns = events.length;
  const promptCharacters = events.reduce((total, event) => total + event.promptCharacters, 0);
  const estimatedTokens = events.reduce((total, event) => total + event.estimatedInputTokens, 0);
  const estimatedEquivalentUsd = events.reduce(
    (total, event) => total + event.estimatedEquivalentUsd,
    0,
  );
  const existingMetrics = usage.metrics.filter(
    (metric) => !LOCAL_USAGE_METRIC_LABELS.has(metric.label),
  );
  const vendorTelemetryKnown = hasVendorUsageTelemetry(usage);
  const vendorMetrics = vendorTelemetryKnown
    ? existingMetrics
    : [
        {
          label: "Subscription usage",
          value: "Unavailable",
          provenance: "unavailable" as const,
          detail: "No provider plan telemetry has been reported. AI Integrator does not infer it.",
        },
        ...existingMetrics.filter((metric) => metric.provenance !== "unavailable"),
      ];

  return {
    ...usage,
    subscriptionPercent: vendorTelemetryKnown ? usage.subscriptionPercent : undefined,
    resetAt: vendorTelemetryKnown ? usage.resetAt : undefined,
    tokens: estimatedTokens,
    equivalentUsd: estimatedEquivalentUsd,
    metrics: [
      ...vendorMetrics,
      {
        label: "Local turns",
        value: turns.toLocaleString(),
        numeric: turns,
        provenance: "local_observed",
        detail: "Recorded on this device for the active task.",
      },
      {
        label: "Prompt characters",
        value: formatCompactNumber(promptCharacters),
        numeric: promptCharacters,
        provenance: "local_observed",
        detail: "Measured locally before the provider receives a turn.",
      },
      {
        label: "Input tokens (estimate)",
        value: formatCompactNumber(estimatedTokens),
        numeric: estimatedTokens,
        provenance: "estimated",
        detail: "Prompt-character estimate; provider token totals may differ.",
      },
      {
        label: "API equivalent (estimate)",
        value: formatUsd(estimatedEquivalentUsd),
        numeric: estimatedEquivalentUsd,
        provenance: "estimated",
        detail: "Rough input-only equivalent at $5 per million tokens, not a vendor bill.",
      },
    ],
    localObserved: { events },
  };
}

/**
 * Adds one browser-fallback turn to a task's local usage ledger. It never
 * manufactures subscription percentage, reset time, actual spend, or an
 * exact provider token count.
 */
export function recordLocalTurnUsage(
  usage: UsageSnapshot,
  input: { eventId: string; timestamp: string; prompt: string },
): UsageSnapshot {
  const existing = usage.localObserved?.events ?? [];
  if (existing.some((event) => event.id === input.eventId)) {
    return withLocalUsageMetrics(usage, existing);
  }
  const promptCharacters = input.prompt.length;
  const estimatedInputTokens = estimateInputTokens(input.prompt);
  const event: LocalUsageEvent = {
    id: input.eventId,
    timestamp: input.timestamp,
    promptCharacters,
    estimatedInputTokens,
    estimatedEquivalentUsd: estimatedInputTokens / LOCAL_INPUT_TOKEN_ESTIMATE_PER_USD,
  };
  return withLocalUsageMetrics(usage, [...existing, event]);
}

function mergeLocalUsage(
  previous: UsageSnapshot | undefined,
  incoming: UsageSnapshot,
): UsageSnapshot {
  const events = new Map<string, LocalUsageEvent>();
  for (const event of previous?.localObserved?.events ?? []) events.set(event.id, event);
  for (const event of incoming.localObserved?.events ?? []) events.set(event.id, event);
  return events.size ? withLocalUsageMetrics(incoming, [...events.values()]) : incoming;
}

function readStoredNavigation(): Partial<StoredNavigation> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(
      window.localStorage.getItem(NAVIGATION_STORAGE_KEY) ?? "{}",
    ) as Partial<StoredNavigation>;
  } catch {
    return {};
  }
}

function writeStoredNavigation(snapshot: WorkspaceSnapshot): void {
  if (typeof window === "undefined") return;
  try {
    const value: StoredNavigation = {
      activeProjectId: snapshot.activeProjectId,
      activeTaskId: snapshot.activeTaskId,
      lastTaskByProject: snapshot.lastTaskByProject,
      centerViewByTask: snapshot.centerViewByTask,
    };
    window.localStorage.setItem(NAVIGATION_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Navigation persistence is best-effort and never contains credentials or provider payloads.
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
    grok: "Grok Build",
    antigravity: "Antigravity",
    custom: "Custom ACP",
  };
  const connected = status.installed && status.authentication === "authenticated";
  return {
    id,
    name: names[id],
    command:
      status.provider === "grok" ? "grok agent stdio" : (status.executable ?? status.provider),
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

function mapStoredRuntime(value: string | undefined): RuntimeId | undefined {
  if (
    value === "codex" ||
    value === "cursor" ||
    value === "claude" ||
    value === "grok" ||
    value === "antigravity" ||
    value === "custom"
  ) {
    return value;
  }
  if (value === "custom-acp") return "custom";
  // Tasks created before the Antigravity migration stored "gemini".
  if (value === "gemini") return "antigravity";
  return undefined;
}

async function loadNativeWorkspace(): Promise<WorkspaceSnapshot> {
  await nativeInvoke("app_bootstrap");
  const [local, providers] = await Promise.all([
    nativeInvoke<NativeExport>("local_export"),
    nativeInvoke<NativeProviderStatus[]>("provider_discover"),
  ]);
  const snapshot = createEmptySnapshot();
  const projects: ProjectSummary[] = (local.projects ?? []).map(mapProject);
  const runtimeByTask = new Map<string, RuntimeId>();
  for (const session of local.providerSessions) {
    const mapped = mapStoredRuntime(session.provider);
    if (mapped) runtimeByTask.set(session.taskId, mapped);
  }
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
      runtime: mapStoredRuntime(task.runtime) ?? runtimeByTask.get(task.id) ?? ("codex" as const),
      model: task.model?.trim() || PROVIDER_DEFAULT_MODEL,
      effort: task.effort?.trim() || undefined,
      updatedAt: task.updatedAt,
      worktree: task.worktreePath,
      pinned: task.pinned,
      archived: task.archived,
      parentId: task.parentTaskId,
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
    lastTaskByProject: Object.fromEntries(
      projects
        .map((project) => [project.id, tasks.find((task) => task.projectId === project.id)?.id])
        .filter((entry): entry is [string, string] => Boolean(entry[1])),
    ),
    centerViewByTask: Object.fromEntries(tasks.map((task) => [task.id, "task" as const])),
    runtimes: providers.map(mapRuntime),
  };
  // "Restore last workspace" is honored here: when disabled the app starts
  // with nothing active instead of reopening the previous project and chat.
  const restoreLastWorkspace =
    (local.settings ?? []).find((setting) => setting.key === "settings.general.openLastWorkspace")
      ?.value !== false;
  if (!restoreLastWorkspace) {
    const fresh: WorkspaceSnapshot = { ...merged, activeTaskId: "", activeProjectId: "" };
    cachedWorkspace = fresh;
    return fresh;
  }
  const storedNavigation = readStoredNavigation();
  const storedTask = tasks.find((task) => task.id === storedNavigation.activeTaskId);
  const storedProject = projects.find(
    (project) => project.id === (storedTask?.projectId ?? storedNavigation.activeProjectId),
  );
  const restored: WorkspaceSnapshot = {
    ...merged,
    activeTaskId: storedTask?.id ?? merged.activeTaskId,
    activeProjectId: storedProject?.id ?? merged.activeProjectId,
    lastTaskByProject: { ...merged.lastTaskByProject, ...storedNavigation.lastTaskByProject },
    centerViewByTask: { ...merged.centerViewByTask, ...storedNavigation.centerViewByTask },
  };
  cachedWorkspace = restored;
  return restored;
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

function repositoryForProject(projectId: string): string {
  const snapshot = cachedWorkspace ?? readDemoSnapshot();
  const project = snapshot.projects.find((item) => item.id === projectId);
  if (!project?.path) throw new Error(`Project ${projectId} is not registered`);
  return project.path;
}

/**
 * Browser preview only: the demo cannot walk a real repository, so the
 * project view is approximated by every file its tasks have reported.
 */
function demoProjectDiffFiles(snapshot: WorkspaceSnapshot, projectId: string): DiffFile[] {
  const files = new Map<string, DiffFile>();
  const activeTask = snapshot.tasks.find((task) => task.id === snapshot.activeTaskId);
  if (activeTask?.projectId === projectId) {
    for (const file of snapshot.git.files) files.set(file.path, file);
  }
  for (const task of snapshot.tasks) {
    if (task.projectId !== projectId) continue;
    for (const file of snapshot.taskContexts[task.id]?.git.files ?? []) {
      if (!files.has(file.path)) files.set(file.path, file);
    }
  }
  return [...files.values()];
}

async function ensureNativeTask(taskId: string): Promise<string> {
  const mapped = nativeTaskIds.get(taskId);
  if (mapped) return mapped;
  const snapshot = cachedWorkspace ?? readDemoSnapshot();
  const task = snapshot.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  const repositoryPath = repositoryForTask(taskId);
  const created = await nativeInvoke<NativeTask>("task_create", {
    input: {
      title: task.title,
      repositoryPath,
      worktreePath: undefined,
      runtime: task.runtime,
      model: task.model,
      effort: task.effort,
    },
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

const cursorSessionByTask = new Set<string>();
/** The model and effort last applied to each Cursor session, to skip redundant protocol calls. */
const cursorAppliedSelection = new Map<string, { model?: string; effort?: string }>();
let cursorConnected = false;
let cursorBoundTaskId: string | undefined;
// Model discovery and Send can ask for the same ACP session at nearly the
// same time. Serialize those transitions so a second `acp_connect` cannot
// replace and shut down the process whose `session/new` is still in flight.
let cursorSessionQueue: Promise<void> = Promise.resolve();

/** Cursor only: per-model reasoning parameters from the model-list RPC. */
let cursorModelParams = new Map<string, CursorModelParams>();

function clearCursorSessionCaches(): void {
  cursorSessionByTask.clear();
  cursorAppliedSelection.clear();
  modelCatalogCache.delete("cursor");
  cursorModelConfigId = undefined;
  cursorEffortConfigByModel.clear();
  cursorModelParams = new Map();
  cursorBoundTaskId = undefined;
}

function resetCursorConnectionState(): void {
  cursorConnected = false;
  clearCursorSessionCaches();
}

function updateCursorCatalog(response: unknown): ModelCatalogEntry[] {
  const catalog = extractAcpCatalog(response);
  mergeCursorModelParams(catalog, cursorModelParams);
  if (catalog.length > 0) {
    modelCatalogCache.set("cursor", [PROVIDER_DEFAULT_ENTRY, ...catalog]);
  }
  return catalog;
}

/**
 * Best-effort refresh of per-model reasoning parameters. The stable
 * `session/new` catalog has no thought-level data, so a failed extension call
 * only means the effort picker stays hidden; models still work.
 */
async function refreshCursorModelParams(): Promise<void> {
  try {
    const response = await nativeInvoke<unknown>("acp_list_cursor_models", {});
    const params = extractCursorModelParams(response);
    if (params.size > 0) cursorModelParams = params;
  } catch {
    // Older cursor-agent builds without the extension RPC.
  }
}

async function ensureCursorSessionForTaskUnlocked(
  taskId: string,
  delegation?: string,
): Promise<string> {
  const nativeTaskId = await ensureNativeTask(taskId);
  const cwd = repositoryForTask(taskId);
  try {
    if (!cursorConnected || (cursorBoundTaskId && cursorBoundTaskId !== nativeTaskId)) {
      await nativeInvoke("acp_connect", { provider: "cursor", workingDirectory: cwd });
      cursorConnected = true;
      clearCursorSessionCaches();
    }
    if (!cursorSessionByTask.has(nativeTaskId)) {
      const session = await nativeInvoke<unknown>("acp_start_session", {
        taskId: nativeTaskId,
        cwd,
        delegation,
      });
      cursorSessionByTask.add(nativeTaskId);
      cursorBoundTaskId = nativeTaskId;
      cursorAppliedSelection.delete(nativeTaskId);
      await refreshCursorModelParams();
      updateCursorCatalog(session);
    }
    return nativeTaskId;
  } catch (error) {
    // A failed ACP handshake/session bind leaves the native process unusable
    // for the cached frontend state. The next attempt must replace it.
    resetCursorConnectionState();
    throw error;
  }
}

async function ensureCursorSessionForTask(taskId: string, delegation?: string): Promise<string> {
  const operation = cursorSessionQueue.then(() =>
    ensureCursorSessionForTaskUnlocked(taskId, delegation),
  );
  cursorSessionQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

async function ensureCursorSession(input: SendTurnInput): Promise<string> {
  return ensureCursorSessionForTask(input.taskId, input.delegation);
}

/// A model id from the picker that can be forwarded to a provider verbatim.
/// UI placeholders ("Provider default") are intentionally spaced and skipped.
function realModelId(model: string): string | undefined {
  return model && model !== PROVIDER_DEFAULT_MODEL && !model.includes(" ") ? model : undefined;
}

/// Apply the composer's model and reasoning-effort selection to the task's
/// Cursor session before prompting, so every turn honors the picker instead
/// of Cursor's own last-used defaults.
async function applyCursorSelection(nativeTaskId: string, input: SendTurnInput): Promise<void> {
  const applied = cursorAppliedSelection.get(nativeTaskId) ?? {};
  const model = realModelId(input.model);
  if (model && applied.model !== model) {
    const configId = cursorModelConfigId;
    if (!configId) {
      throw new Error("Cursor did not advertise a stable ACP model selector for this session");
    }
    try {
      const response = await nativeInvoke<unknown>("acp_set_config_option", {
        taskId: nativeTaskId,
        configId,
        value: model,
      });
      // The ACP response is authoritative and may replace the available
      // thought-level options after a model change.
      updateCursorCatalog(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cursor could not switch to model "${model}": ${message}`);
    }
    applied.model = model;
    // A model change resets Cursor's parameter state; re-apply effort below.
    applied.effort = undefined;
  }
  const configId = model ? cursorEffortConfigByModel.get(model) : undefined;
  if (input.effort && configId && applied.effort !== input.effort) {
    try {
      await nativeInvoke("acp_set_config_option", {
        taskId: nativeTaskId,
        configId,
        value: input.effort,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cursor could not set reasoning effort "${input.effort}": ${message}`);
    }
    applied.effort = input.effort;
  }
  cursorAppliedSelection.set(nativeTaskId, applied);
}

const PROVIDER_DEFAULT_ENTRY: ModelCatalogEntry = {
  id: PROVIDER_DEFAULT_MODEL,
  label: PROVIDER_DEFAULT_MODEL,
};

/**
 * Claude Code CLI `--effort` levels (see `claude --help`). Effort is a session
 * flag, so every Claude model entry — including "Provider default" — gets the
 * picker; the CLI ignores it on models without effort support.
 */
const CLAUDE_EFFORTS: ModelEffortOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
];
const CLAUDE_DEFAULT_EFFORT = "high";

/**
 * Antigravity (`agy`) has no headless model-list surface (its `models` panel
 * needs a TTY) and silently ignores unknown `--model` values, so this static
 * catalog mirrors the CLI's interactive `/model` picker exactly: model ids are
 * the display names agy accepts, and the reasoning levels listed per model
 * are the "(High)"-style variants the picker offers. The native adapter
 * composes the selected effort back into the `--model` value.
 */
const ANTIGRAVITY_CATALOG: ModelCatalogEntry[] = [
  { id: PROVIDER_DEFAULT_MODEL, label: PROVIDER_DEFAULT_MODEL },
  {
    id: "Gemini 3.1 Pro",
    label: "Gemini 3.1 Pro",
    efforts: [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ],
    defaultEffort: "high",
  },
  {
    id: "Gemini 3.5 Flash",
    label: "Gemini 3.5 Flash",
    efforts: [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
    defaultEffort: "medium",
  },
];

/** Demo-mode runtimes that showcase the reasoning-effort picker. */
const DEMO_EFFORT_RUNTIMES = new Set<RuntimeId>(["codex", "claude"]);
const DEMO_EFFORTS: ModelEffortOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

async function loadModelCatalog(runtime: RuntimeId): Promise<ModelCatalogEntry[]> {
  const cached = modelCatalogCache.get(runtime);
  if (cached) return cached;
  // Curated catalog in every mode: agy exposes no programmatic model list.
  if (runtime === "antigravity") return ANTIGRAVITY_CATALOG;
  if (isTauri() && runtime === "codex") {
    try {
      if (!codexConnected) {
        await nativeInvoke("codex_connect", {});
        codexConnected = true;
        activeCodexThreads.clear();
      }
      const response = await nativeInvoke<unknown>("codex_list_models", {
        includeHidden: false,
      });
      const catalog = extractCodexCatalog(response);
      if (catalog.length > 0) {
        const entries = [PROVIDER_DEFAULT_ENTRY, ...catalog];
        modelCatalogCache.set(runtime, entries);
        return entries;
      }
    } catch {
      // Codex unavailable right now; fall through to the static catalog.
    }
  }
  if (isTauri() && runtime === "cursor") {
    try {
      const snapshot = cachedWorkspace ?? readDemoSnapshot();
      if (snapshot.activeTaskId) {
        await ensureCursorSessionForTask(snapshot.activeTaskId);
        const catalog = modelCatalogCache.get("cursor");
        if (catalog?.length) return catalog;
      } else if (!cursorConnected) {
        await nativeInvoke("acp_connect", { provider: "cursor" });
        cursorConnected = true;
      }
    } catch {
      resetCursorConnectionState();
      // Cursor unavailable or logged out; fall through to the static catalog.
    }
  }
  if (!isTauri()) {
    const demoModels = readDemoSnapshot().runtimes.find((item) => item.id === runtime)?.models;
    if (demoModels?.length) {
      return demoModels.map((id) => {
        if (runtime === "claude") {
          return { id, label: id, efforts: CLAUDE_EFFORTS, defaultEffort: CLAUDE_DEFAULT_EFFORT };
        }
        return DEMO_EFFORT_RUNTIMES.has(runtime)
          ? { id, label: id, efforts: DEMO_EFFORTS, defaultEffort: "medium" }
          : { id, label: id };
      });
    }
  }
  if (runtime === "claude") {
    return (FALLBACK_MODELS.claude ?? [PROVIDER_DEFAULT_MODEL]).map((id) => ({
      id,
      label: id,
      efforts: CLAUDE_EFFORTS,
      defaultEffort: CLAUDE_DEFAULT_EFFORT,
    }));
  }
  return toCatalogEntries(FALLBACK_MODELS[runtime] ?? [PROVIDER_DEFAULT_MODEL]);
}

async function ensureCodexThread(input: SendTurnInput): Promise<string> {
  const nativeTaskId = await ensureNativeTask(input.taskId);
  const existing = codexThreadByTask.get(nativeTaskId) ?? codexThreadByTask.get(input.taskId);
  const cwd = repositoryForTask(input.taskId);
  if (!codexConnected) {
    await nativeInvoke("codex_connect", { workingDirectory: cwd, taskId: nativeTaskId });
    codexConnected = true;
    activeCodexThreads.clear();
  }
  if (existing) {
    if (!activeCodexThreads.has(existing)) {
      await nativeInvoke("codex_resume_thread", { taskId: nativeTaskId, threadId: existing });
      activeCodexThreads.add(existing);
    }
    return existing;
  }
  // UI placeholders ("Auto", "Provider default", …) are not provider model
  // ids; only forward names that look like real model identifiers.
  const model =
    input.model.includes(" ") || input.model.toLowerCase() === "auto" ? undefined : input.model;
  const started = await nativeInvoke<unknown>("codex_start_thread", {
    taskId: nativeTaskId,
    cwd,
    model,
    effort: input.effort,
    permission: input.permission,
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
  getAppInfo: async () => {
    if (isTauri()) {
      const response = await nativeInvoke<NativeBootstrap>("app_bootstrap");
      return response.value;
    }
    return {
      applicationVersion: "browser-preview",
      domainSchemaVersion: 2,
      dataDirectory: "Browser-managed local storage",
      localOnly: true,
    };
  },

  getStorageTotals: async () => {
    if (isTauri()) return nativeInvoke<StorageTotals>("storage_totals");
    const entries = [DEMO_STORAGE_KEY, NAVIGATION_STORAGE_KEY, SETTINGS_STORAGE_KEY].map(
      (key) => window.localStorage.getItem(key) ?? "",
    );
    const bytes = entries.reduce(
      (total, value) => total + new TextEncoder().encode(value).byteLength,
      0,
    );
    return {
      totalBytes: bytes,
      databaseBytes: bytes,
      walBytes: 0,
      sharedMemoryBytes: 0,
      measuredAt: new Date().toISOString(),
      kind: "browser-local-storage",
    };
  },

  getUsageSummary: async () => {
    if (isTauri()) return nativeInvoke<UsageSummary>("usage_summary");
    const snapshot = readDemoSnapshot();
    const grouped = new Map<RuntimeId | "unknown", ProviderUsageSummary>();
    for (const task of snapshot.tasks) {
      const provider = task.runtime ?? "unknown";
      const events = snapshot.taskContexts[task.id]?.usage.localObserved?.events ?? [];
      const inputTokens = events.reduce((total, event) => total + event.estimatedInputTokens, 0);
      const existing = grouped.get(provider) ?? {
        provider,
        taskCount: 0,
        turnCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        provenance: "unavailable",
        detail: "No provider token usage is available in the browser preview.",
      };
      existing.taskCount += 1;
      existing.turnCount += events.length;
      existing.inputTokens += inputTokens;
      existing.totalTokens += inputTokens;
      if (events.length > 0) {
        existing.provenance = "estimated";
        existing.detail =
          "Input tokens are estimated from locally recorded prompts; provider output is unavailable in the browser preview.";
      }
      grouped.set(provider, existing);
    }
    return { providers: [...grouped.values()], measuredAt: new Date().toISOString() };
  },

  listSettings: async () => {
    if (isTauri()) return nativeInvoke<LocalSetting[]>("setting_list");
    return readBrowserSettings();
  },

  setSetting: async (key, value) => {
    if (isTauri()) return nativeInvoke<LocalSetting>("setting_set", { key, value });
    return writeBrowserSetting(key, value);
  },

  getVoiceTypingCredentialStatus: async () => {
    if (isTauri()) {
      return nativeInvoke<VoiceTypingCredentialStatus>("voice_typing_credential_status");
    }
    return { configured: false, storage: "native-only", provider: "openai" };
  },

  setVoiceTypingCredential: async (apiKey) => {
    if (!isTauri()) {
      throw new Error("Secure BYOK storage is available in the native app only.");
    }
    return nativeInvoke<VoiceTypingCredentialStatus>("voice_typing_credential_set", { apiKey });
  },

  clearVoiceTypingCredential: async () => {
    if (isTauri()) await nativeInvoke("voice_typing_credential_clear");
  },

  startVoiceTyping: async () => {
    if (!isTauri()) {
      throw new Error("Voice typing is available in the native app only.");
    }
    await nativeInvoke("voice_typing_start");
  },

  appendVoiceTypingPcm: async (pcm) => {
    if (!isTauri()) {
      throw new Error("Voice typing is available in the native app only.");
    }
    await nativeInvoke("voice_typing_append", { pcm });
  },

  stopVoiceTyping: async () => {
    if (!isTauri()) return;
    await nativeInvoke("voice_typing_stop");
  },

  subscribeVoiceTyping: async (listener) => {
    if (!isTauri()) return () => undefined;
    const { listen } = await import("@tauri-apps/api/event");
    return listen<VoiceTypingEvent>("voice-typing://event", (event) => listener(event.payload));
  },

  exportLocalData: async () => {
    if (isTauri()) return nativeInvoke("local_export");
    return {
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      projects: readDemoSnapshot().projects,
      tasks: readDemoSnapshot().tasks,
      settings: readBrowserSettings(),
      providerSessions: [],
      runtimeSessions: [],
    };
  },

  clearLocalData: async () => {
    if (isTauri()) {
      await nativeInvoke("local_clear");
      return;
    }
    try {
      window.localStorage.removeItem(DEMO_STORAGE_KEY);
      window.localStorage.removeItem(NAVIGATION_STORAGE_KEY);
      window.localStorage.removeItem(SETTINGS_STORAGE_KEY);
    } catch {
      // Keep the command idempotent when browser storage is unavailable.
    }
  },

  loadWorkspace: async () => {
    if (isTauri()) return loadNativeWorkspace();
    const snapshot = readDemoSnapshot();
    const restoreLastWorkspace =
      readBrowserSettings().find((setting) => setting.key === "settings.general.openLastWorkspace")
        ?.value !== false;
    return restoreLastWorkspace ? snapshot : { ...snapshot, activeTaskId: "", activeProjectId: "" };
  },

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

  createProject: async (name) => {
    if (isTauri()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose where to create the project",
      });
      if (typeof selected !== "string") return null;
      const project = await nativeInvoke<TrustedProject>("project_create", {
        parent: selected,
        name,
      });
      return mapProject(project);
    }
    return bridge.registerProject(`C:\\Code\\${name}`);
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

  listModels: async (runtime) => (await loadModelCatalog(runtime)).map((entry) => entry.id),

  listModelCatalog: loadModelCatalog,

  beginRuntimeLogin: async (runtime) => {
    if (isTauri()) {
      if (runtime !== "codex") {
        const status = (await nativeInvoke<NativeProviderStatus[]>("provider_discover")).find(
          (item) => runtimeId(item.provider) === runtime,
        );
        if (!status) throw new Error(`${runtime} was not found after status check`);
        return mapRuntime(status);
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
          title: deriveChatTitle(input.prompt, 240),
          repositoryPath: project.path,
          worktreePath: undefined,
          runtime: input.runtime,
          model: input.model,
          effort: input.effort,
        },
      });
      nativeTaskIds.set(task.id, task.id);
      repositoryByTaskId.set(task.id, project.path);
      return {
        id: task.id,
        projectId: input.projectId,
        title: task.title,
        status: mapTaskStatus(task.state),
        runtime: mapStoredRuntime(task.runtime) ?? input.runtime,
        model: task.model?.trim() || input.model,
        effort: task.effort?.trim() || input.effort,
        updatedAt: task.updatedAt,
      };
    }
    return {
      id: `task-${Date.now()}`,
      projectId: input.projectId,
      title: deriveChatTitle(input.prompt),
      status: "running",
      runtime: input.runtime,
      model: input.model,
      effort: input.effort,
      updatedAt: new Date().toISOString(),
      unread: false,
      worktree: `ai/${new Date().toISOString().slice(0, 10)}`,
    };
  },

  loadTaskGit: async (taskId) => {
    if (isTauri()) return refreshNativeGit(taskId);
    const snapshot = readDemoSnapshot();
    return snapshot.taskContexts[taskId]?.git ?? createEmptySnapshot().git;
  },

  listProjectFiles: async (projectId) => {
    if (isTauri()) {
      return nativeInvoke<ProjectFileEntry[]>("project_file_list", {
        repository: repositoryForProject(projectId),
      });
    }
    return demoProjectDiffFiles(readDemoSnapshot(), projectId).map((file) => ({
      path: file.path,
      size: file.lines.reduce((total, line) => total + line.content.length + 1, 0),
    }));
  },

  readProjectFile: async (projectId, path) => {
    if (isTauri()) {
      return nativeInvoke<ProjectFileContent>("project_file_read", {
        repository: repositoryForProject(projectId),
        input: { path },
      });
    }
    const file = demoProjectDiffFiles(readDemoSnapshot(), projectId).find(
      (candidate) => candidate.path === path,
    );
    if (!file) throw new Error("That file is not available in the browser demo");
    return {
      path,
      content: file.lines.map((line) => line.content).join("\n"),
      isBinary: false,
    };
  },

  openTerminal: async (projectId) => {
    if (!isTauri()) {
      throw new Error("The terminal is available in the native desktop app.");
    }
    return nativeInvoke<TerminalSessionInfo>("terminal_open", {
      repository: repositoryForProject(projectId),
    });
  },

  runTerminalCommand: async (sessionId, command) => {
    if (!isTauri()) {
      throw new Error("The terminal is available in the native desktop app.");
    }
    return nativeInvoke<TerminalCommandStarted>("terminal_run", { sessionId, command });
  },

  interruptTerminal: async (sessionId) => {
    if (!isTauri()) return;
    await nativeInvoke("terminal_interrupt", { sessionId });
  },

  closeTerminal: async (sessionId) => {
    if (!isTauri()) return;
    await nativeInvoke("terminal_close", { sessionId });
  },

  subscribeTerminalOutput: async (listener) => {
    if (!isTauri()) return () => undefined;
    const { listen } = await import("@tauri-apps/api/event");
    return listen<TerminalOutputEvent>("terminal://output", (event) => {
      listener(event.payload);
    });
  },

  supportsTaskMetadata: () => true,

  updateTaskMetadata: async (taskId, input) => {
    if (isTauri()) {
      const nativeTaskId = await ensureNativeTask(taskId);
      const task = await nativeInvoke<NativeTask>("task_update_metadata", {
        taskId: nativeTaskId,
        input,
      });
      return {
        taskId,
        title: task.title,
        pinned: task.pinned,
        archived: task.archived,
        updatedAt: task.updatedAt,
      };
    }
    const snapshot = readDemoSnapshot();
    const task = snapshot.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Unknown chat: ${taskId}`);
    return {
      taskId,
      title: input.title?.trim() || task.title,
      pinned: input.pinned ?? task.pinned ?? false,
      archived: input.archived ?? task.archived ?? false,
      updatedAt: new Date().toISOString(),
    };
  },

  updateTaskRouting: async (taskId, input) => {
    if (isTauri()) {
      const nativeTaskId = await ensureNativeTask(taskId);
      const task = await nativeInvoke<NativeTask>("task_update_routing", {
        taskId: nativeTaskId,
        input: {
          runtime: input.runtime,
          model: input.model,
          effort: input.effort,
        },
      });
      const snapshot = cachedWorkspace ?? readDemoSnapshot();
      const existing = snapshot.tasks.find((item) => item.id === taskId);
      return {
        id: taskId,
        projectId: existing?.projectId ?? "",
        title: task.title,
        status: mapTaskStatus(task.state),
        runtime: mapStoredRuntime(task.runtime) ?? input.runtime,
        model: task.model?.trim() || input.model,
        effort: task.effort?.trim() || input.effort,
        updatedAt: task.updatedAt,
        worktree: task.worktreePath ?? existing?.worktree,
        pinned: task.pinned,
        archived: task.archived,
      };
    }
    const snapshot = cachedWorkspace ?? readDemoSnapshot();
    const task = snapshot.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Unknown chat: ${taskId}`);
    const updated: TaskSummary = {
      ...task,
      runtime: input.runtime,
      model: input.model,
      effort: input.effort,
      updatedAt: new Date().toISOString(),
    };
    const next: WorkspaceSnapshot = {
      ...snapshot,
      tasks: snapshot.tasks.map((item) => (item.id === taskId ? updated : item)),
    };
    cachedWorkspace = next;
    writeDemoSnapshot(next);
    return updated;
  },

  sendTurn: async (input) => {
    if (isTauri()) {
      if (input.runtime === "codex") {
        const threadId = await ensureCodexThread(input);
        await nativeInvoke("codex_start_turn", { threadId, prompt: input.prompt });
      } else if (input.runtime === "cursor") {
        try {
          const taskId = await ensureCursorSession(input);
          await applyCursorSelection(taskId, input);
          await nativeInvoke("acp_send_turn", {
            taskId,
            prompt: input.prompt,
            delegation: input.delegation,
          });
        } catch (error) {
          resetCursorConnectionState();
          throw error;
        }
      } else if (input.runtime === "claude" || input.runtime === "antigravity") {
        const taskId = await ensureNativeTask(input.taskId);
        await nativeInvoke("structured_cli_start_turn", {
          taskId,
          provider: input.runtime,
          cwd: repositoryForTask(input.taskId),
          model: realModelId(input.model),
          effort: input.effort,
          permission: input.permission,
          prompt: input.prompt,
          delegation: input.delegation,
        });
      } else {
        throw new Error(`${input.runtime} turn execution is not implemented by the native backend`);
      }
    }
    const event: TranscriptEvent = {
      id: `event-${Date.now()}`,
      kind: "user",
      body: input.prompt,
      timestamp: new Date().toISOString(),
      status: "neutral",
    };
    if (!isTauri()) {
      const snapshot = readDemoSnapshot();
      const currentContext = snapshot.taskContexts[input.taskId];
      const empty = createEmptySnapshot();
      const usage = recordLocalTurnUsage(currentContext?.usage ?? empty.usage, {
        eventId: event.id,
        timestamp: event.timestamp,
        prompt: input.prompt,
      });
      const next: WorkspaceSnapshot = {
        ...snapshot,
        usage: snapshot.activeTaskId === input.taskId ? usage : snapshot.usage,
        taskContexts: {
          ...snapshot.taskContexts,
          [input.taskId]: {
            transcript: currentContext?.transcript ?? [],
            git: currentContext?.git ?? empty.git,
            usage,
            children: currentContext?.children ?? [],
          },
        },
      };
      cachedWorkspace = next;
      writeDemoSnapshot(next);
    }
    return event;
  },

  listDelegations: async (taskId) => {
    if (!isTauri()) return [];
    const nativeTaskId = await ensureNativeTask(taskId);
    return nativeInvoke<DelegationView[]>("delegation_list", { taskId: nativeTaskId });
  },

  approveDelegation: async (delegationId) => {
    if (!isTauri()) throw new Error("Delegation requires the native app");
    await nativeInvoke("delegation_approve", { delegationId });
  },

  denyDelegation: async (delegationId) => {
    if (!isTauri()) throw new Error("Delegation requires the native app");
    await nativeInvoke("delegation_deny", { delegationId });
  },

  sendDelegationMessage: async (delegationId, message) => {
    if (!isTauri()) throw new Error("Delegation requires the native app");
    await nativeInvoke("delegation_send_message", { delegationId, message });
  },

  stopDelegation: async (delegationId) => {
    if (!isTauri()) throw new Error("Delegation requires the native app");
    await nativeInvoke("delegation_stop_cmd", { delegationId });
  },

  subscribeDelegationUpdates: async (listener) => {
    if (!isTauri()) return () => undefined;
    const { listen } = await import("@tauri-apps/api/event");
    return listen<{ parentTaskId: string }>("delegation://update", (event) => {
      listener(event.payload.parentTaskId);
    });
  },

  subscribeRuntimeProjections: async (listener) => {
    if (!isTauri()) return () => undefined;
    const { listen } = await import("@tauri-apps/api/event");
    return listen<RuntimeProjectionEvent>("runtime://projection", (event) => {
      listener(event.payload);
    });
  },

  loadTaskProjection: async (taskId) => {
    if (!isTauri()) return { events: [], watermarkSeq: 0 };
    return nativeInvoke<TaskProjectionSnapshot>("task_snapshot", { taskId });
  },

  respondToApproval: async (taskId, approvalId, decision) => {
    if (!isTauri()) {
      throw new Error("Approvals are only available during a native provider run");
    }
    return nativeInvoke<ApprovalProjection>("codex_respond_approval", {
      taskId,
      approvalId,
      decision,
    });
  },

  stopTurn: async (taskId) => {
    if (!isTauri()) {
      throw new Error("Stop is only available during a native provider run");
    }
    return nativeInvoke<{
      turnId: string;
      stopRequested: true;
      alreadyRequested: boolean;
      settled?: boolean;
    }>("codex_stop_turn", { taskId });
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
    if (isTauri()) {
      cachedWorkspace = snapshot;
      writeStoredNavigation(snapshot);
      return;
    }

    // The browser fallback writes a local usage event immediately when a turn
    // is submitted. React persists its task snapshot a moment later, so merge
    // the event ledger instead of racing it away with a stale render.
    const previous = readDemoSnapshot();
    const taskContexts = { ...snapshot.taskContexts };
    if (snapshot.activeTaskId) {
      taskContexts[snapshot.activeTaskId] = {
        transcript: snapshot.transcript,
        git: snapshot.git,
        usage: snapshot.usage,
        children: snapshot.children,
      };
    }
    for (const [taskId, context] of Object.entries(taskContexts)) {
      taskContexts[taskId] = {
        ...context,
        usage: mergeLocalUsage(previous.taskContexts[taskId]?.usage, context.usage),
      };
    }
    const activeUsage = snapshot.activeTaskId
      ? (taskContexts[snapshot.activeTaskId]?.usage ?? snapshot.usage)
      : snapshot.usage;
    const merged = { ...snapshot, taskContexts, usage: activeUsage };
    cachedWorkspace = merged;
    writeStoredNavigation(merged);
    writeDemoSnapshot(merged);
  },
};
