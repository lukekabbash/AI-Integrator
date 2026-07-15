import type { WorkspaceSnapshot } from "./demoData";
import {
  createDemoSnapshot,
  createEmptySnapshot,
  DEMO_GIT_RECENT_COMMITS,
  demoGitHistoryArchive,
} from "./demoData";

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

export interface NativeProviderAction {
  /** Opaque native-host handle. Filesystem paths never cross into the renderer. */
  id: string;
  name: string;
  description: string;
  source: string;
  kind: "skill" | "command";
  invocation: "direct" | "interactiveOnly";
  inputHint?: string;
}

/** Renderer-safe identity for an action selected from the provider-owned catalog. */
export interface NativeActionReference {
  name: string;
  kind: NativeProviderAction["kind"];
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
  /** Canonical Git root when this folder is backed by a repository. */
  gitRepositoryRoot?: string;
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

export interface TaskMessageSearchHit {
  taskId: string;
  snippet: string;
}

export interface TranscriptEvent {
  id: string;
  kind: "user" | "assistant" | "activity" | "tool" | "approval" | "checkpoint" | "notice";
  /** Observable subtype used to summarize contiguous activity loops. */
  activityType?: "reasoning" | "command" | "tool" | "file" | "plan" | "approval" | "other";
  /** File identity and review surface for observable file edits. */
  filePath?: string;
  diff?: DiffFile;
  title?: string;
  body: string;
  /** Present only when the native host verified that this user message invoked a real skill. */
  nativeSkill?: string;
  timestamp: string;
  status?: "running" | "success" | "warning" | "error" | "neutral";
  meta?: string;
  /** Optional source-control style line counts for file/tool activity. */
  changeStats?: { additions: number; deletions: number };
  children?: TranscriptEvent[];
  /** Explicit initial disclosure state; activity groups default to collapsed. */
  expandedByDefault?: boolean;
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
  permission: "read-only" | "project-write";
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

/** Provider route selected for a delegated agent's next turn. */
export interface DelegationRouting {
  runtime: RuntimeId;
  model: string;
  effort?: string;
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
   * only providers that report one (Claude) populate it. Serialized as null
   * by the native store when absent. */
  estimatedCostUsd?: number | null;
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
    kind: "keyword" | "string" | "type" | "comment" | "plain" | "function" | "variable" | "number";
  }>;
}

export interface DiffFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  staged: boolean;
  lines: DiffLine[];
  /** False only for a native status row whose patch is loaded on first open. */
  diffLoaded?: boolean;
  /** False only when line counts are unknown (binary or oversized change). */
  statsLoaded?: boolean;
  /** Native Git bounded the patch before returning it; the review is partial. */
  truncated?: boolean;
}

export function diffFileKey(file: Pick<DiffFile, "path" | "staged">): string {
  return `${file.staged ? "index" : "worktree"}\0${file.path}`;
}

export interface ProjectFileEntry {
  path: string;
  size: number;
}

export interface ProjectFileContent {
  path: string;
  content: string;
  isBinary: boolean;
  /** Inline `data:` URL for image files, so the reader can show a preview. */
  imageDataUrl?: string | null;
}

/** A file the user attached to the composer from anywhere on their computer. */
export interface ContextAttachment {
  /** Absolute path in native builds; the bare file name in browser previews. */
  path: string;
  name: string;
  kind: "image" | "file";
  /** Inline preview for images, as a data: URL. */
  dataUrl?: string;
}

export type ComposerDraftOwner =
  { kind: "newChat"; projectId: string } | { kind: "task"; taskId: string };

export interface ComposerDraftAttachment extends ContextAttachment {
  entry?: "file" | "folder";
  /** Highlighted lines carried as context, labeled `name.ext (start – end)`. */
  selection?: { startLine?: number; endLine?: number; text: string };
}

export interface ComposerDraftValue {
  prompt: string;
  attachments: ComposerDraftAttachment[];
  runtime: RuntimeId;
  model: string;
  effort?: string;
  permission: "read-only" | "project-write" | "ask" | "full-access";
  delegation: "off" | "manual" | "balanced" | "budget-first";
  selectionStart: number;
  selectionEnd: number;
}

export interface ComposerDraft extends ComposerDraftValue {
  owner: ComposerDraftOwner;
  revision: number;
  updatedAt: string;
}

export interface QueueMessageInput {
  taskId: string;
  prompt: string;
  attachments: ComposerDraftAttachment[];
  runtime: RuntimeId;
  model: string;
  effort?: string;
  permission: ComposerDraftValue["permission"];
  delegation: ComposerDraftValue["delegation"];
  nativeActionId?: string;
}

export interface QueuedMessage extends QueueMessageInput {
  id: string;
  position: number;
  state: "queued" | "dispatching";
  createdAt: string;
  updatedAt: string;
}

export function draftOwnerKey(owner: ComposerDraftOwner): string {
  return owner.kind === "newChat" ? `project:${owner.projectId}` : `task:${owner.taskId}`;
}

export function persistableComposerAttachment(
  attachment: ComposerDraftAttachment,
): ComposerDraftAttachment {
  return {
    path: attachment.path,
    name: attachment.name,
    kind: attachment.kind,
    ...(attachment.entry ? { entry: attachment.entry } : {}),
    ...(attachment.selection ? { selection: attachment.selection } : {}),
  };
}

const IMAGE_ATTACHMENT_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "ico",
  "avif",
]);

export function attachmentKind(name: string): "image" | "file" {
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  return IMAGE_ATTACHMENT_EXTENSIONS.has(extension) ? "image" : "file";
}

export interface ProjectFileOpener {
  id: string;
  label: string;
  description: string;
}

export interface GitCommit {
  id: string;
  subject: string;
  relativeTime: string;
  current?: boolean;
  /** Abbreviated parent hashes; two or more mean a merge commit. */
  parents?: string[];
  /** Branch/tag decorations pointing at this commit. */
  refs?: string[];
  /** True when the commit is not reachable from the branch upstream. */
  unpushed?: boolean;
}

export interface GitSnapshot {
  kind: "repository" | "notRepository";
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  worktree: string;
  remotes: GitRemote[];
  files: DiffFile[];
  commits: GitCommit[];
  /** True when older commits exist beyond the loaded graph window. */
  historyHasMore?: boolean;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GithubRepository {
  name: string;
  nameWithOwner: string;
  owner: string;
  description?: string | null;
  private: boolean;
  archived: boolean;
  pushedAt?: string | null;
  url: string;
  sshUrl: string;
  defaultBranch?: string | null;
}

export interface GithubRepositoryCatalog {
  installed: boolean;
  authenticated: boolean;
  account?: string | null;
  hostname?: string | null;
  repositories: GithubRepository[];
  detail?: string | null;
}

export interface CloneProjectInput {
  remote: string;
  parent: string;
  folderName: string;
  githubRepository?: string;
}

export interface PushPreview {
  head: string;
  branch: string;
  remote?: string | null;
  sanitizedRemoteUrl?: string | null;
  upstream?: string | null;
  ahead: number;
  behind: number;
  refspec: string;
  force: false;
}

export interface PushConfirmation {
  expectedHead: string;
  expectedBranch: string;
  expectedRemote: string;
  expectedRemoteUrl?: string | null;
  expectedUpstream: string;
  expectedRefspec: string;
}

export interface PushResult {
  outcome: "pushed" | "upToDate" | "outcomeUncertain";
  head: string;
  branch: string;
  remote: string;
  refspec: string;
  summary: string;
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
  /** Project-level new-chat draft promoted atomically with native task creation. */
  draft?: ComposerDraft;
}

export interface GenerateTaskTitleInput {
  taskId: string;
  prompt: string;
  runtime: RuntimeId;
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
  /** Opaque selection returned by listNativeProviderActions. */
  nativeActionId?: string;
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
  /** Verified provider-native skill invoked by this user item. */
  nativeSkill?: string;
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
  approvalKind: "commandExecution" | "fileChange" | "planReview";
  state:
    "pending" | "responding" | "resolved" | "declined" | "cancelled" | "expired" | "responseFailed";
  decision?: "accept" | "acceptForSession" | "decline" | "cancel";
  itemId?: string;
  approvalId?: string;
  reason?: string;
  command?: string;
  cwd?: string;
  fileChanges?: ItemProjection["fileChanges"];
  /** Full plan document (markdown) for planReview approvals. */
  planMarkdown?: string;
  updatedAt: string;
}

/** One agent-advertised session mode (ACP) or synthesized equivalent. */
export interface ModeOption {
  id: string;
  name: string;
  description?: string;
}

/** The session's current mode plus every mode it can switch into. */
export interface ModeProjection {
  currentModeId: string;
  availableModes: ModeOption[];
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
  | { kind: "modeChanged"; mode: ModeProjection }
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
  /** Native-process liveness attested while the snapshot was loaded. */
  runtimeLive: boolean;
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

export type RuntimeActionKind = "install" | "update" | "login";

export interface RuntimeActionPlan {
  /** Native-resolved identifier; execution re-resolves it instead of trusting renderer argv. */
  id: string;
  provider: RuntimeId;
  kind: RuntimeActionKind;
  method: string;
  label: string;
  command: string;
  description: string;
  sourceUrl: string;
  available: boolean;
  unavailableReason?: string;
  recommended: boolean;
  downloadsAndExecutesCode: boolean;
  modifiesOutsideProjects: boolean;
  environmentNote: string;
}

export interface RuntimeTerminalInfo {
  id: string;
  provider: RuntimeId;
  kind: RuntimeActionKind;
  command: string;
}

export interface RuntimeTerminalOutputEvent {
  sessionId: string;
  stream: "output" | "exit";
  data?: string;
  exitCode?: number | null;
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
  /** Native file picker for composer context attachments (any file on disk).
   * Images arrive with an inline preview data URL; null means cancelled. */
  pickContextAttachments?(): Promise<ContextAttachment[] | null>;
  /** Loads an inline preview for an image path referenced by a chat message. */
  readAttachmentPreview?(path: string): Promise<string | null>;
  exportLocalData(): Promise<unknown>;
  clearLocalData(): Promise<void>;
  loadWorkspace(): Promise<WorkspaceSnapshot>;
  /** Search locally persisted user/assistant message text without loading chat snapshots. */
  searchTaskMessages(query: string, limit?: number): Promise<TaskMessageSearchHit[]>;
  openProject(): Promise<ProjectSummary | null>;
  /** Create `Documents/AI Integrator/Projects/<name>` (deduped), git-init it, and register it. */
  createProject(name: string): Promise<ProjectSummary>;
  getDefaultProjectParent(): Promise<string>;
  pickProjectParent(): Promise<string | null>;
  listGithubRepositories(): Promise<GithubRepositoryCatalog>;
  cloneProject(input: CloneProjectInput): Promise<ProjectSummary>;
  registerProject(path: string): Promise<ProjectSummary>;
  listProjects(): Promise<ProjectSummary[]>;
  probeRuntimes(): Promise<RuntimeConnection[]>;
  beginRuntimeLogin(runtime: RuntimeId): Promise<RuntimeConnection>;
  startTask(input: StartTaskInput): Promise<TaskSummary>;
  /** Revisioned local persistence; stale writes are ignored by the native store. */
  saveComposerDraft(draft: ComposerDraft): Promise<void>;
  enqueueMessage(input: QueueMessageInput): Promise<QueuedMessage>;
  listQueuedMessages(taskId: string): Promise<QueuedMessage[]>;
  reorderQueuedMessages(taskId: string, orderedIds: string[]): Promise<QueuedMessage[]>;
  takeQueuedMessage(taskId: string, messageId: string): Promise<QueuedMessage>;
  setQueuedMessageDispatching(
    taskId: string,
    messageId: string,
    dispatching: boolean,
  ): Promise<QueuedMessage>;
  /** False means the runtime needs an interrupt-then-deliver Send now path. */
  steerTurn(taskId: string, expectedTurnId: string, prompt: string): Promise<boolean>;
  /** Runs one isolated, provider-backed naming attempt for a newly created chat. */
  generateTaskTitle(input: GenerateTaskTitleInput): Promise<TaskNavigationMetadata | null>;
  loadTaskGit(taskId: string): Promise<GitSnapshot>;
  loadProjectGit(projectId: string): Promise<GitSnapshot>;
  loadProjectGitFile(projectId: string, file: DiffFile): Promise<DiffFile>;
  initializeGit(projectId: string): Promise<ProjectSummary>;
  addGitRemote(projectId: string, name: string, url: string): Promise<GitSnapshot>;
  updateGitRemote(projectId: string, name: string, url: string): Promise<GitSnapshot>;
  removeGitRemote(projectId: string, name: string): Promise<GitSnapshot>;
  fetchGit(projectId: string, remote?: string): Promise<GitSnapshot>;
  pullGit(projectId: string, mode: "fastForwardOnly" | "rebase"): Promise<GitSnapshot>;
  publishGitBranch(projectId: string, remote: string): Promise<PushResult>;
  publishGithubRepository(
    projectId: string,
    input: {
      nameWithOwner: string;
      visibility: "private" | "public" | "internal";
      remote: string;
    },
  ): Promise<GitSnapshot>;
  /** One older page of commit history for the Git rail's "Show more". */
  loadTaskGitHistory(
    taskId: string,
    skip: number,
  ): Promise<{ commits: GitCommit[]; hasMore: boolean }>;
  loadTaskGitFile(taskId: string, file: DiffFile): Promise<DiffFile>;
  listProjectFiles(projectId: string): Promise<ProjectFileEntry[]>;
  readProjectFile(projectId: string, path: string): Promise<ProjectFileContent>;
  /** Write manually edited text back to one trusted project file (native builds only). */
  writeProjectFile(projectId: string, path: string, content: string): Promise<ProjectFileContent>;
  /** Explain a highlighted selection through the isolated, tool-denied helper
   * boundary shared with chat naming. Returns plain prose. */
  explainSelection(
    projectId: string,
    runtime: RuntimeId,
    payload: { path: string; startLine?: number; endLine?: number; text: string },
  ): Promise<string>;
  /** Rename a file in place inside the trusted project (native builds only). */
  renameProjectFile(projectId: string, path: string, newName: string): Promise<ProjectFileEntry>;
  /** Native-detected, allowlisted file-opening targets for one trusted project. */
  listProjectFileOpeners(projectId: string): Promise<ProjectFileOpener[]>;
  openProjectFileExternal(projectId: string, path: string, openerId: string): Promise<void>;
  revealProjectFile(projectId: string, path: string): Promise<void>;
  openTerminal(projectId: string): Promise<TerminalSessionInfo>;
  runTerminalCommand(sessionId: string, command: string): Promise<TerminalCommandStarted>;
  interruptTerminal(sessionId: string): Promise<void>;
  closeTerminal(sessionId: string): Promise<void>;
  subscribeTerminalOutput(listener: (event: TerminalOutputEvent) => void): Promise<() => void>;
  listRuntimeActionPlans(runtime: RuntimeId, kind: RuntimeActionKind): Promise<RuntimeActionPlan[]>;
  openRuntimeTerminal(
    planId: string,
    dimensions: { cols: number; rows: number },
  ): Promise<RuntimeTerminalInfo>;
  writeRuntimeTerminal(sessionId: string, data: string): Promise<void>;
  resizeRuntimeTerminal(
    sessionId: string,
    dimensions: { cols: number; rows: number },
  ): Promise<void>;
  closeRuntimeTerminal(sessionId: string): Promise<void>;
  subscribeRuntimeTerminalOutput(
    listener: (event: RuntimeTerminalOutputEvent) => void,
  ): Promise<() => void>;
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
  /** Persists a terminal task lifecycle state; live running/waiting remains projection-owned. */
  setTaskStatus?(taskId: string, status: TaskStatus): Promise<void>;
  sendTurn(input: SendTurnInput): Promise<TranscriptEvent>;
  /** Delegated subagents of a task (native delegation broker; empty in browser mode). */
  listDelegations(taskId: string): Promise<DelegationView[]>;
  approveDelegation(delegationId: string): Promise<void>;
  denyDelegation(delegationId: string): Promise<void>;
  /** User message to a subagent. Terminal children are resumed; active children queue it. */
  sendDelegationMessage(
    delegationId: string,
    message: string,
    routing?: DelegationRouting,
  ): Promise<void>;
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
  /** Switch the live agent session's mode (e.g. Cursor Agent/Plan/Ask). */
  setSessionMode(taskId: string, modeId: string): Promise<void>;
  stopTurn(taskId: string): Promise<{
    turnId: string;
    stopRequested: true;
    alreadyRequested: boolean;
    /** True when a dead session was force-settled instead of interrupted live. */
    settled?: boolean;
  }>;
  stageFiles(taskId: string, paths: string[], staged: boolean): Promise<GitSnapshot>;
  stageProjectFiles(projectId: string, paths: string[], staged: boolean): Promise<GitSnapshot>;
  commit(taskId: string, message: string): Promise<GitSnapshot>;
  commitProject(projectId: string, message: string): Promise<GitSnapshot>;
  /** Draft one bounded staged-diff subject with the task's selected provider. */
  generateCommitMessage(taskId: string, runtime: RuntimeId): Promise<string>;
  /** Read-only push data used to render an explicit confirmation surface. */
  previewPush(taskId: string): Promise<PushPreview>;
  previewProjectPush(projectId: string): Promise<PushPreview>;
  /** Execute only the exact push state returned by previewPush. */
  confirmPush(taskId: string, confirmation: PushConfirmation): Promise<PushResult>;
  confirmProjectPush(projectId: string, confirmation: PushConfirmation): Promise<PushResult>;
  push(taskId: string): Promise<GitSnapshot>;
  persistSession(snapshot: WorkspaceSnapshot): Promise<void>;
  listModels(runtime: RuntimeId): Promise<string[]>;
  listModelCatalog(runtime: RuntimeId): Promise<ModelCatalogEntry[]>;
  /** Provider-owned skills/commands for one explicitly trusted repository. */
  listNativeProviderActions(
    runtime: RuntimeId,
    repository: string,
  ): Promise<NativeProviderAction[]>;
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
  composerDrafts?: ComposerDraft[];
  queuedMessages?: QueuedMessage[];
}

interface NativeBootstrap {
  schemaVersion: number;
  value: LocalAppInfo;
}

interface TrustedProject {
  id: string;
  displayName: string;
  repositoryRoot: string;
  gitRepositoryRoot?: string;
  gitCommonDirectory?: string;
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
  additions?: number | null;
  deletions?: number | null;
  stagedAdditions?: number | null;
  stagedDeletions?: number | null;
  unstagedAdditions?: number | null;
  unstagedDeletions?: number | null;
}

interface NativeDiff {
  patch: string;
  truncated: boolean;
}

interface NativeGitCommit {
  id: string;
  subject: string;
  relativeTime: string;
  current?: boolean;
  parents?: string[];
  refs?: string[];
  unpushed?: boolean;
}

interface NativeGitOverview {
  identity: NativeRepository;
  files: NativeFileStatus[];
  history: NativeGitCommit[];
  remotes: GitRemote[];
  pushPreview?: PushPreview;
}

const nativeTaskIds = new Map<string, string>();
const repositoryByTaskId = new Map<string, string>();
const repositoryByProjectId = new Map<string, string>();
const nativeProjectById = new Map<string, ProjectSummary>();
const nativeGitByTask = new Map<string, GitSnapshot>();
const codexThreadByTask = new Map<string, string>();
const activeCodexThreads = new Set<string>();
const codexConnectedTasks = new Set<string>();
const codexDelegationByTask = new Map<string, StartTaskInput["delegation"]>();
let cachedWorkspace: WorkspaceSnapshot | undefined;
let cachedNativeSettings: LocalSetting[] | undefined;
let codexCatalogConnected = false;

/// Placeholder that defers to the provider CLI's own configured model; it is
/// intentionally spaced so the send path never forwards it as a model id.
export const PROVIDER_DEFAULT_MODEL = "Provider default";
const modelCatalogCache = new Map<RuntimeId, ModelCatalogEntry[]>();
/** Cursor only: thought-level session config option id per model id. */
const cursorEffortConfigByModel = new Map<string, string>();
/** Cursor only: the ACP config option id used for model selection. */
let cursorModelConfigId: string | undefined;
const FALLBACK_MODELS: Partial<Record<RuntimeId, string[]>> = {
  claude: ["claude-opus-4-8", "claude-fable-5", "claude-sonnet-5", "claude-haiku-4-5"],
  antigravity: ["Gemini 3.1 Pro", "Gemini 3.5 Flash"],
  // These are a degraded fallback only. A successfully negotiated Cursor ACP
  // catalog replaces them with the models available to the signed-in account.
  cursor: ["composer-2.5", "cursor-small", "deepseek-v3.1", "deepseek-r1", "auto"],
  grok: ["grok-4.5", "grok-build-0.1"],
  custom: [],
};

const CHAT_TITLE_MAX_LENGTH = 54;
export const CHAT_TITLE_PLACEHOLDER = "Coding session";

/**
 * Keep a new chat's label useful in the rail without copying an entire prompt
 * into it. Native builds use a provider-backed naming worker; this remains the
 * deterministic browser-preview fallback.
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
      isDefault?: unknown;
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
    if (value.isDefault === true) catalog.unshift(item);
    else catalog.push(item);
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
  const currentModel =
    typeof modelOption.currentValue === "string" ? modelOption.currentValue : undefined;
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
  if (!currentModel) return catalog;
  const currentIndex = catalog.findIndex((entry) => entry.id === currentModel);
  if (currentIndex <= 0) return catalog;
  const [current] = catalog.splice(currentIndex, 1);
  return current ? [current, ...catalog] : catalog;
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
  "activeProjectId" | "activeTaskId" | "lastTaskByProject" | "centerViewByTask" | "openFilesByTask"
> & { unreadTaskIds?: string[] };

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
      openFilesByTask: parsed.openFilesByTask ?? {},
      composerDrafts: parsed.composerDrafts ?? [],
      queuedMessages: parsed.queuedMessages ?? [],
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
      openFilesByTask: snapshot.openFilesByTask,
      unreadTaskIds: snapshot.tasks.filter((task) => task.unread).map((task) => task.id),
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
  const updateRequired = status.diagnosticCode === "runtime-update-required";
  const connected =
    status.installed && status.authentication === "authenticated" && !updateRequired;
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
    detail: updateRequired
      ? "This CLI is authenticated but older than Integrator's certified protocol floor."
      : (status.diagnosticCode ?? (connected ? "Authenticated local CLI" : "Status unavailable")),
  };
}

function mapTaskStatus(state: NativeTask["state"]): TaskStatus {
  if (state === "ready") return "draft";
  if (state === "cancelled") return "stopped";
  return state;
}

function mapProject(project: TrustedProject): ProjectSummary {
  repositoryByProjectId.set(project.id, project.repositoryRoot);
  const summary = {
    id: project.id,
    name: project.displayName,
    path: project.repositoryRoot,
    gitRepositoryRoot: project.gitRepositoryRoot,
    branch: "",
    dirtyFiles: 0,
    expanded: true,
  };
  nativeProjectById.set(summary.id, summary);
  return summary;
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
  // Workspace hydration is local SQLite only. Provider discovery may launch
  // version/auth probes and must not hold the first useful paint hostage.
  // App starts that refresh after the shell is visible; opening a workspace
  // never starts or resumes a provider session.
  const local = await nativeInvoke<NativeExport>("local_export");
  const bootstrapSettings = [...(local.settings ?? [])];
  cachedNativeSettings = bootstrapSettings;
  // The app consumes these immediately after loadWorkspace. Expire the
  // one-turn handoff so later settings reads still observe native changes.
  window.setTimeout(() => {
    if (cachedNativeSettings === bootstrapSettings) cachedNativeSettings = undefined;
  }, 0);
  const snapshot = createEmptySnapshot();
  nativeProjectById.clear();
  repositoryByProjectId.clear();
  const projects: ProjectSummary[] = (local.projects ?? []).map(mapProject);
  const projectByPath = new Map(projects.map((project) => [project.path, project]));
  const runtimeByTask = new Map<string, RuntimeId>();
  for (const session of local.providerSessions) {
    const mapped = mapStoredRuntime(session.provider);
    if (mapped) runtimeByTask.set(session.taskId, mapped);
  }
  const tasks = local.tasks.map((task) => {
    const projectPath = task.repositoryPath ?? "Local workspace";
    let project = projectByPath.get(projectPath);
    if (!project) {
      project = projectForPath({ ...snapshot, projects }, task.repositoryPath);
      projects.push(project);
      projectByPath.set(projectPath, project);
    }
    nativeTaskIds.set(task.id, task.id);
    // A writing task is reviewed in its assigned worktree, not the base
    // checkout. Project identity still derives from repositoryPath above.
    const reviewRoot = task.worktreePath ?? task.repositoryPath;
    if (reviewRoot) repositoryByTaskId.set(task.id, reviewRoot);
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
  const lastTaskByProject: Record<string, string> = {};
  for (const task of tasks) lastTaskByProject[task.projectId] ??= task.id;
  for (const session of local.providerSessions) {
    if (session.provider === "codex")
      codexThreadByTask.set(session.taskId, session.providerThreadId);
  }
  const storedNavigation = readStoredNavigation();
  const unreadTaskIds = new Set(storedNavigation.unreadTaskIds ?? []);
  const merged: WorkspaceSnapshot = {
    ...snapshot,
    projects,
    tasks: tasks.map((task) => ({ ...task, unread: unreadTaskIds.has(task.id) })),
    activeTaskId: tasks[0]?.id ?? "",
    activeProjectId: tasks[0]?.projectId ?? projects[0]?.id ?? "",
    lastTaskByProject,
    centerViewByTask: Object.fromEntries(tasks.map((task) => [task.id, "task" as const])),
    openFilesByTask: {},
    runtimes: [],
    composerDrafts: local.composerDrafts ?? [],
    queuedMessages: local.queuedMessages ?? [],
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
    openFilesByTask: { ...merged.openFilesByTask, ...storedNavigation.openFilesByTask },
  };
  restored.tasks = restored.tasks.map((task) =>
    task.id === restored.activeTaskId ? { ...task, unread: false } : task,
  );
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
  const knownRepository = repositoryByProjectId.get(projectId);
  if (knownRepository) return knownRepository;
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
const cursorDelegationByTask = new Map<string, StartTaskInput["delegation"]>();
/** The model and effort last applied to each Cursor session, to skip redundant protocol calls. */
const cursorAppliedSelection = new Map<string, { model?: string; effort?: string }>();
const cursorConnectedTasks = new Set<string>();
const activeAcpProviderByTask = new Map<string, "cursor" | "grok">();
let cursorCatalogConnected = false;
const grokSessionByTask = new Set<string>();
const grokDelegationByTask = new Map<string, StartTaskInput["delegation"]>();
const grokConnectedTasks = new Set<string>();
// Model discovery and Send can ask for the same ACP session at nearly the
// same time. Serialize those transitions so a second `acp_connect` cannot
// replace and shut down the process whose `session/new` is still in flight.
let cursorSessionQueue: Promise<void> = Promise.resolve();

/** Cursor only: per-model reasoning parameters from the model-list RPC. */
let cursorModelParams = new Map<string, CursorModelParams>();

function clearCursorSessionCaches(taskId?: string): void {
  if (taskId) {
    cursorSessionByTask.delete(taskId);
    cursorDelegationByTask.delete(taskId);
    cursorAppliedSelection.delete(taskId);
    return;
  }
  cursorSessionByTask.clear();
  cursorDelegationByTask.clear();
  cursorAppliedSelection.clear();
  modelCatalogCache.delete("cursor");
  cursorModelConfigId = undefined;
  cursorEffortConfigByModel.clear();
  cursorModelParams = new Map();
}

function resetCursorConnectionState(taskId?: string): void {
  if (taskId) {
    cursorConnectedTasks.delete(taskId);
    if (activeAcpProviderByTask.get(taskId) === "cursor") activeAcpProviderByTask.delete(taskId);
    clearCursorSessionCaches(taskId);
    return;
  }
  cursorConnectedTasks.clear();
  for (const [task, provider] of activeAcpProviderByTask) {
    if (provider === "cursor") activeAcpProviderByTask.delete(task);
  }
  clearCursorSessionCaches();
}

function resetGrokConnectionState(taskId?: string): void {
  if (taskId) {
    grokConnectedTasks.delete(taskId);
    grokSessionByTask.delete(taskId);
    grokDelegationByTask.delete(taskId);
    if (activeAcpProviderByTask.get(taskId) === "grok") activeAcpProviderByTask.delete(taskId);
    return;
  }
  grokConnectedTasks.clear();
  grokSessionByTask.clear();
  grokDelegationByTask.clear();
  for (const [task, provider] of activeAcpProviderByTask) {
    if (provider === "grok") activeAcpProviderByTask.delete(task);
  }
}

function updateCursorCatalog(response: unknown): ModelCatalogEntry[] {
  const catalog = extractAcpCatalog(response);
  mergeCursorModelParams(catalog, cursorModelParams);
  if (catalog.length > 0) {
    modelCatalogCache.set("cursor", catalog);
  }
  return catalog;
}

/**
 * Best-effort refresh of per-model reasoning parameters. The stable
 * `session/new` catalog has no thought-level data, so a failed extension call
 * only means the effort picker stays hidden; models still work.
 */
async function refreshCursorModelParams(taskId?: string): Promise<void> {
  try {
    const response = await nativeInvoke<unknown>("acp_list_cursor_models", { taskId });
    const params = extractCursorModelParams(response);
    if (params.size > 0) cursorModelParams = params;
  } catch {
    // Older cursor-agent builds without the extension RPC.
  }
}

async function ensureCursorSessionForTaskUnlocked(
  taskId: string,
  delegation?: StartTaskInput["delegation"],
): Promise<string> {
  const nativeTaskId = await ensureNativeTask(taskId);
  const cwd = repositoryForTask(taskId);
  const delegationMode = delegation ?? "off";
  try {
    if (
      !cursorConnectedTasks.has(nativeTaskId) ||
      activeAcpProviderByTask.get(nativeTaskId) !== "cursor"
    ) {
      await nativeInvoke("acp_connect", {
        provider: "cursor",
        workingDirectory: cwd,
        taskId: nativeTaskId,
      });
      resetGrokConnectionState(nativeTaskId);
      cursorConnectedTasks.add(nativeTaskId);
      activeAcpProviderByTask.set(nativeTaskId, "cursor");
      clearCursorSessionCaches(nativeTaskId);
    }
    if (
      !cursorSessionByTask.has(nativeTaskId) ||
      cursorDelegationByTask.get(nativeTaskId) !== delegationMode
    ) {
      const session = await nativeInvoke<unknown>("acp_start_session", {
        taskId: nativeTaskId,
        cwd,
        delegation: delegationMode,
      });
      cursorSessionByTask.add(nativeTaskId);
      cursorDelegationByTask.set(nativeTaskId, delegationMode);
      cursorAppliedSelection.delete(nativeTaskId);
      await refreshCursorModelParams(nativeTaskId);
      updateCursorCatalog(session);
    }
    return nativeTaskId;
  } catch (error) {
    // A failed ACP handshake/session bind leaves the native process unusable
    // for the cached frontend state. The next attempt must replace it.
    resetCursorConnectionState(nativeTaskId);
    throw error;
  }
}

async function ensureCursorSessionForTask(
  taskId: string,
  delegation?: StartTaskInput["delegation"],
): Promise<string> {
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

async function ensureGrokSession(input: SendTurnInput): Promise<string> {
  const nativeTaskId = await ensureNativeTask(input.taskId);
  const cwd = repositoryForTask(input.taskId);
  if (
    !grokConnectedTasks.has(nativeTaskId) ||
    activeAcpProviderByTask.get(nativeTaskId) !== "grok"
  ) {
    await nativeInvoke("acp_connect", {
      provider: "grok",
      workingDirectory: cwd,
      taskId: nativeTaskId,
    });
    resetCursorConnectionState(nativeTaskId);
    grokConnectedTasks.add(nativeTaskId);
    activeAcpProviderByTask.set(nativeTaskId, "grok");
    grokSessionByTask.delete(nativeTaskId);
  }
  if (
    !grokSessionByTask.has(nativeTaskId) ||
    grokDelegationByTask.get(nativeTaskId) !== input.delegation
  ) {
    await nativeInvoke("acp_start_session", {
      taskId: nativeTaskId,
      cwd,
      delegation: input.delegation,
    });
    grokSessionByTask.add(nativeTaskId);
    grokDelegationByTask.set(nativeTaskId, input.delegation);
  }
  return nativeTaskId;
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

/**
 * Claude Code CLI `--effort` levels (see `claude --help`). Effort is a session
 * flag, so every Claude model entry gets the picker; the CLI ignores it on
 * models without effort support.
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
      if (!codexCatalogConnected) {
        await nativeInvoke("codex_connect", {});
        codexCatalogConnected = true;
      }
      const response = await nativeInvoke<unknown>("codex_list_models", {
        includeHidden: false,
      });
      const catalog = extractCodexCatalog(response);
      if (catalog.length > 0) {
        modelCatalogCache.set(runtime, catalog);
        return catalog;
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
      } else if (!cursorCatalogConnected) {
        await nativeInvoke("acp_connect", { provider: "cursor" });
        cursorCatalogConnected = true;
      }
    } catch {
      cursorCatalogConnected = false;
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
    return (FALLBACK_MODELS.claude ?? []).map((id) => ({
      id,
      label: id,
      efforts: CLAUDE_EFFORTS,
      defaultEffort: CLAUDE_DEFAULT_EFFORT,
    }));
  }
  return toCatalogEntries(FALLBACK_MODELS[runtime] ?? []);
}

async function ensureCodexThread(input: SendTurnInput): Promise<string> {
  const nativeTaskId = await ensureNativeTask(input.taskId);
  const existing = codexThreadByTask.get(nativeTaskId) ?? codexThreadByTask.get(input.taskId);
  const cwd = repositoryForTask(input.taskId);
  if (!codexConnectedTasks.has(nativeTaskId)) {
    await nativeInvoke("codex_connect", { workingDirectory: cwd, taskId: nativeTaskId });
    codexConnectedTasks.add(nativeTaskId);
    if (existing) activeCodexThreads.delete(existing);
  }
  if (existing) {
    const configuredDelegation = codexDelegationByTask.get(nativeTaskId);
    // MCP configuration is fixed when a Codex thread starts. A fresh thread
    // keeps delegation changes truthful, and the task digest carries the
    // conversation across without mutating global Codex settings.
    if (
      configuredDelegation !== input.delegation &&
      (configuredDelegation !== undefined || input.delegation !== "off")
    ) {
      return startNewCodexThread(input, nativeTaskId, cwd);
    }
    if (!activeCodexThreads.has(existing)) {
      try {
        await nativeInvoke("codex_resume_thread", { taskId: nativeTaskId, threadId: existing });
        activeCodexThreads.add(existing);
        codexDelegationByTask.set(nativeTaskId, "off");
        codexDelegationByTask.set(input.taskId, "off");
      } catch (error) {
        if (!isMissingCodexThreadError(error)) throw error;
        forgetCodexThread(input.taskId, nativeTaskId, existing);
      }
    }
    if (activeCodexThreads.has(existing)) return existing;
  }
  return startNewCodexThread(input, nativeTaskId, cwd);
}

function isMissingCodexThreadError(error: unknown): boolean {
  const message = formatBridgeError(error, "").toLowerCase();
  return (
    message.includes("no rollout found for thread id") ||
    /(?:thread|rollout).*(?:not found|does not exist|unknown)/i.test(message)
  );
}

function isCodexConnectionError(error: unknown): boolean {
  const message = formatBridgeError(error, "").toLowerCase();
  return /provider-disconnected|transport (?:closed|failed)|broken pipe|app-server.*(?:closed|exited)/i.test(
    message,
  );
}

function forgetCodexThread(taskId: string, nativeTaskId: string, threadId: string): void {
  if (codexThreadByTask.get(taskId) === threadId) codexThreadByTask.delete(taskId);
  if (codexThreadByTask.get(nativeTaskId) === threadId) codexThreadByTask.delete(nativeTaskId);
  codexDelegationByTask.delete(taskId);
  codexDelegationByTask.delete(nativeTaskId);
  activeCodexThreads.delete(threadId);
}

async function startNewCodexThread(
  input: SendTurnInput,
  nativeTaskId: string,
  cwd: string,
): Promise<string> {
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
    delegation: input.delegation,
  });
  const threadId = extractThreadId(started);
  if (!threadId) throw new Error("Codex did not return a thread identifier");
  codexThreadByTask.set(nativeTaskId, threadId);
  codexThreadByTask.set(input.taskId, threadId);
  codexDelegationByTask.set(nativeTaskId, input.delegation);
  codexDelegationByTask.set(input.taskId, input.delegation);
  activeCodexThreads.add(threadId);
  return threadId;
}

export function parseDiffLines(patch: string): DiffLine[] {
  let oldNumber = 0;
  let newNumber = 0;
  const lines: DiffLine[] = [];
  for (const line of patch.split(/\r?\n/)) {
    if (
      !line ||
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("+++ ") ||
      line.startsWith("--- ") ||
      line.startsWith("\\ No newline")
    ) {
      continue;
    }
    if (line.startsWith("@@")) {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNumber = hunk ? Number(hunk[1]) : 0;
      newNumber = hunk ? Number(hunk[2]) : 0;
      lines.push({ kind: "hunk", content: line });
      continue;
    }
    if (line.startsWith("+")) {
      lines.push({ kind: "add", newNumber: newNumber || undefined, content: line.slice(1) });
      if (newNumber) newNumber += 1;
      continue;
    }
    if (line.startsWith("-")) {
      lines.push({ kind: "delete", oldNumber: oldNumber || undefined, content: line.slice(1) });
      if (oldNumber) oldNumber += 1;
      continue;
    }
    lines.push({
      kind: "context",
      oldNumber: oldNumber || undefined,
      newNumber: newNumber || undefined,
      content: line.startsWith(" ") ? line.slice(1) : line,
    });
    if (oldNumber) oldNumber += 1;
    if (newNumber) newNumber += 1;
  }
  return lines;
}

function summarizeNativeGitFile(
  status: NativeFileStatus,
  staged: boolean,
  code: string,
  additions: number | null | undefined,
  deletions: number | null | undefined,
): DiffFile {
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
    additions: additions ?? 0,
    deletions: deletions ?? 0,
    staged,
    lines: [],
    diffLoaded: false,
    statsLoaded: typeof additions === "number" && typeof deletions === "number",
  };
}

function summarizeNativeGitFiles(status: NativeFileStatus): DiffFile[] {
  const staged = status.indexStatus !== " " && status.indexStatus !== "?";
  const unstaged = status.worktreeStatus !== " ";
  const files: DiffFile[] = [];
  if (staged) {
    files.push(
      summarizeNativeGitFile(
        status,
        true,
        status.indexStatus,
        status.stagedAdditions ?? (unstaged ? undefined : status.additions),
        status.stagedDeletions ?? (unstaged ? undefined : status.deletions),
      ),
    );
  }
  if (unstaged) {
    files.push(
      summarizeNativeGitFile(
        status,
        false,
        status.worktreeStatus,
        status.unstagedAdditions ?? (staged ? undefined : status.additions),
        status.unstagedDeletions ?? (staged ? undefined : status.deletions),
      ),
    );
  }
  return files;
}

const GIT_HISTORY_PAGE = 32;

function notRepositorySnapshot(worktree: string): GitSnapshot {
  return {
    kind: "notRepository",
    branch: "",
    upstream: "",
    ahead: 0,
    behind: 0,
    worktree,
    remotes: [],
    files: [],
    commits: [],
  };
}

// Folders confirmed by the backend this session to hold no Git repository.
// Bounds the re-detection below to one probe per folder.
const verifiedNonRepositoryPaths = new Set<string>();

function rememberProjectGitRoot(path: string, gitRepositoryRoot: string | undefined) {
  for (const [projectId, project] of nativeProjectById) {
    if (project.path === path) {
      nativeProjectById.set(projectId, { ...project, gitRepositoryRoot });
    }
  }
  if (!cachedWorkspace) return;
  cachedWorkspace = {
    ...cachedWorkspace,
    projects: cachedWorkspace.projects.map((candidate) =>
      candidate.path === path ? { ...candidate, gitRepositoryRoot } : candidate,
    ),
  };
}

/**
 * The cached workspace can lag behind the folder on disk: Git may have been
 * initialized in a previous session, outside the app, or under a project row
 * written before repository detection. Before treating a project as "not a
 * repository" (which surfaces the Set up Git state), re-register the trusted
 * folder once so the backend re-detects its repository and heals the record.
 */
async function resolveProjectGitRoot(project: ProjectSummary): Promise<string | undefined> {
  if (project.gitRepositoryRoot) return project.gitRepositoryRoot;
  if (verifiedNonRepositoryPaths.has(project.path)) return undefined;
  try {
    const refreshed = mapProject(
      await nativeInvoke<TrustedProject>("project_register", { path: project.path }),
    );
    rememberProjectGitRoot(project.path, refreshed.gitRepositoryRoot);
    if (refreshed.gitRepositoryRoot) return refreshed.gitRepositoryRoot;
  } catch {
    // Detection failures fall through to the explicit setup state; the next
    // refresh may retry via the button rather than looping here.
  }
  verifiedNonRepositoryPaths.add(project.path);
  return undefined;
}

async function refreshNativeGit(taskId: string): Promise<GitSnapshot> {
  const repository = repositoryForTask(taskId);
  const workspace = cachedWorkspace ?? readDemoSnapshot();
  const task = workspace.tasks.find((candidate) => candidate.id === taskId);
  const project = workspace.projects.find((candidate) => candidate.id === task?.projectId);
  if (project && !(await resolveProjectGitRoot(project))) {
    const snapshot = notRepositorySnapshot(project.path);
    nativeGitByTask.set(taskId, snapshot);
    return snapshot;
  }
  const overview = await nativeInvoke<NativeGitOverview>("git_overview", { repository });
  const snapshot = mapNativeGitOverview(overview);
  nativeGitByTask.set(taskId, snapshot);
  return snapshot;
}

async function loadNativeProjectGit(projectId: string): Promise<GitSnapshot> {
  const workspace = cachedWorkspace ?? readDemoSnapshot();
  const project =
    nativeProjectById.get(projectId) ??
    workspace.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  if (!(await resolveProjectGitRoot(project))) {
    return notRepositorySnapshot(project.path);
  }
  const overview = await nativeInvoke<NativeGitOverview>("git_overview", {
    repository: project.path,
  });
  return mapNativeGitOverview(overview);
}

function mapNativeGitOverview(overview: NativeGitOverview): GitSnapshot {
  const { identity, history: commits, pushPreview: preview } = overview;
  const files = overview.files.flatMap(summarizeNativeGitFiles);
  return {
    kind: "repository" as const,
    branch: identity.branch ?? preview?.branch ?? "detached",
    upstream: preview?.upstream ?? "",
    ahead: preview?.ahead ?? 0,
    behind: preview?.behind ?? 0,
    worktree: identity.root,
    remotes: overview.remotes,
    files,
    commits,
    historyHasMore: commits.length >= GIT_HISTORY_PAGE,
  };
}

async function loadNativeGitFileFromRepository(
  repository: string,
  file: DiffFile,
): Promise<DiffFile> {
  const diff = await nativeInvoke<NativeDiff>("git_diff", {
    repository,
    scope:
      file.status === "added" && !file.staged ? "untracked" : file.staged ? "staged" : "unstaged",
    path: file.path,
  });
  const lines = parseDiffLines(diff.patch);
  const loaded = {
    ...file,
    additions: lines.filter((line) => line.kind === "add").length,
    deletions: lines.filter((line) => line.kind === "delete").length,
    lines,
    diffLoaded: true,
    statsLoaded: true,
    truncated: diff.truncated,
  };
  return loaded;
}

async function loadNativeGitFile(taskId: string, file: DiffFile): Promise<DiffFile> {
  const loaded = await loadNativeGitFileFromRepository(repositoryForTask(taskId), file);
  const snapshot = nativeGitByTask.get(taskId);
  if (snapshot) {
    nativeGitByTask.set(taskId, {
      ...snapshot,
      files: snapshot.files.map((candidate) =>
        diffFileKey(candidate) === diffFileKey(loaded) ? loaded : candidate,
      ),
    });
  }
  return loaded;
}

function browserMessageSearchSnippet(events: TranscriptEvent[], query: string): string | undefined {
  const terms = query
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .slice(0, 8);
  if (!terms.length) return undefined;
  const pending = [...events];
  while (pending.length) {
    const event = pending.shift()!;
    if (event.children?.length) pending.push(...event.children);
    if (event.kind !== "user" && event.kind !== "assistant") continue;
    const text = event.body.replace(/\s+/g, " ").trim();
    const normalized = text.toLocaleLowerCase();
    if (!terms.every((term) => normalized.includes(term))) continue;
    const matchAt = Math.max(0, normalized.indexOf(terms[0]));
    const start = Math.max(0, matchAt - 54);
    const end = Math.min(text.length, matchAt + 116);
    return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
  }
  return undefined;
}

export const bridge: AppBridge = {
  getAppInfo: async () => {
    if (isTauri()) {
      const response = await nativeInvoke<NativeBootstrap>("app_bootstrap");
      return response.value;
    }
    return {
      applicationVersion: "browser-preview",
      domainSchemaVersion: 4,
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
    if (isTauri()) {
      if (cachedNativeSettings) {
        const settings = cachedNativeSettings;
        cachedNativeSettings = undefined;
        return [...settings];
      }
      return nativeInvoke<LocalSetting[]>("setting_list");
    }
    return readBrowserSettings();
  },

  setSetting: async (key, value) => {
    if (isTauri()) {
      const setting = await nativeInvoke<LocalSetting>("setting_set", { key, value });
      if (cachedNativeSettings) {
        cachedNativeSettings = [
          setting,
          ...cachedNativeSettings.filter((candidate) => candidate.key !== setting.key),
        ];
      }
      return setting;
    }
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
      schemaVersion: 4,
      exportedAt: new Date().toISOString(),
      projects: readDemoSnapshot().projects,
      tasks: readDemoSnapshot().tasks,
      settings: readBrowserSettings(),
      providerSessions: [],
      runtimeSessions: [],
      composerDrafts: readDemoSnapshot().composerDrafts,
      queuedMessages: readDemoSnapshot().queuedMessages,
    };
  },

  clearLocalData: async () => {
    if (isTauri()) {
      await nativeInvoke("local_clear");
      cachedNativeSettings = undefined;
      cachedWorkspace = undefined;
      nativeProjectById.clear();
      repositoryByProjectId.clear();
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

  searchTaskMessages: async (query, requestedLimit = 30) => {
    const limit = Math.min(50, Math.max(1, Math.trunc(requestedLimit) || 30));
    if (query.trim().length < 2) return [];
    if (isTauri()) {
      return nativeInvoke<TaskMessageSearchHit[]>("task_search_messages", { query, limit });
    }
    const snapshot = readDemoSnapshot();
    const hits: TaskMessageSearchHit[] = [];
    for (const task of snapshot.tasks) {
      const snippet = browserMessageSearchSnippet(
        snapshot.taskContexts[task.id]?.transcript ?? [],
        query,
      );
      if (snippet) hits.push({ taskId: task.id, snippet });
      if (hits.length === limit) break;
    }
    return hits;
  },

  openProject: async () => {
    if (isTauri()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Open a project folder",
      });
      if (typeof selected !== "string") return null;
      return bridge.registerProject(selected);
    }

    return bridge.registerProject("C:\\Code\\demo-project");
  },

  createProject: async (name) => {
    if (isTauri()) {
      const project = await nativeInvoke<TrustedProject>("project_create", { name });
      return mapProject(project);
    }
    return bridge.registerProject(`C:\\Users\\demo\\Documents\\AI Integrator\\Projects\\${name}`);
  },

  getDefaultProjectParent: async () => {
    if (isTauri()) return nativeInvoke<string>("project_default_parent");
    return "C:\\Users\\demo\\Documents\\AI Integrator\\Projects";
  },

  pickProjectParent: async () => {
    if (isTauri()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose where to clone the project",
      });
      return typeof selected === "string" ? selected : null;
    }
    return "C:\\Users\\demo\\Documents\\AI Integrator\\Projects";
  },

  listGithubRepositories: async () => {
    if (isTauri()) {
      return nativeInvoke<GithubRepositoryCatalog>("github_repository_list");
    }
    return {
      installed: true,
      authenticated: true,
      account: "demo",
      hostname: "github.com",
      repositories: [
        {
          name: "ai-integrator",
          nameWithOwner: "demo/ai-integrator",
          owner: "demo",
          description: "A local-first AI development workspace",
          private: true,
          archived: false,
          url: "https://github.com/demo/ai-integrator",
          sshUrl: "git@github.com:demo/ai-integrator.git",
          defaultBranch: "main",
        },
      ],
    };
  },

  cloneProject: async (input) => {
    if (isTauri()) {
      const project = await nativeInvoke<TrustedProject>("project_clone", { input });
      return mapProject(project);
    }
    return bridge.registerProject(`${input.parent}\\${input.folderName}`);
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
      gitRepositoryRoot: path,
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

  pickContextAttachments: async () => {
    if (isTauri()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        title: "Attach files or images as context",
      });
      const paths = Array.isArray(selected)
        ? selected
        : typeof selected === "string"
          ? [selected]
          : [];
      if (paths.length === 0) return null;
      return Promise.all(
        paths.map(async (path) => {
          const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
          const kind = attachmentKind(name);
          const dataUrl =
            kind === "image"
              ? await nativeInvoke<string | null>("attachment_preview", { path }).catch(() => null)
              : null;
          return { path, name, kind, ...(dataUrl ? { dataUrl } : {}) };
        }),
      );
    }
    // Browser preview: an in-page picker; entries fall back to bare names
    // because the web platform never exposes real paths.
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.onchange = () => {
        const files = [...(input.files ?? [])];
        if (files.length === 0) {
          resolve(null);
          return;
        }
        void Promise.all(
          files.map(async (file) => {
            const kind = attachmentKind(file.name);
            const dataUrl =
              kind === "image"
                ? await new Promise<string | null>((done) => {
                    const reader = new FileReader();
                    reader.onload = () =>
                      done(typeof reader.result === "string" ? reader.result : null);
                    reader.onerror = () => done(null);
                    reader.readAsDataURL(file);
                  })
                : null;
            return { path: file.name, name: file.name, kind, ...(dataUrl ? { dataUrl } : {}) };
          }),
        ).then(resolve);
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  },

  readAttachmentPreview: async (path) => {
    if (!isTauri()) return null;
    if (attachmentKind(path.split(/[\\/]/).filter(Boolean).at(-1) ?? path) !== "image") return null;
    return nativeInvoke<string | null>("attachment_preview", { path }).catch(() => null);
  },

  probeRuntimes: () =>
    invokeOrDemo<NativeProviderStatus[]>("provider_discover", undefined, () => []).then(
      (statuses) => (isTauri() ? statuses.map(mapRuntime) : readDemoSnapshot().runtimes),
    ),

  listModels: async (runtime) => (await loadModelCatalog(runtime)).map((entry) => entry.id),

  listModelCatalog: loadModelCatalog,

  listNativeProviderActions: async (runtime, repository) => {
    if (isTauri()) {
      return nativeInvoke<NativeProviderAction[]>("provider_action_list", {
        provider: runtime,
        repository,
      });
    }
    return runtime === "antigravity"
      ? [
          {
            id: "demo-antigravity-guide",
            name: "antigravity-guide",
            description: "Use Antigravity's built-in guide",
            source: "builtin",
            kind: "skill",
            invocation: "interactiveOnly",
          },
        ]
      : [
          {
            id: `demo-${runtime}-review`,
            name: "review",
            description: `Review changes with ${runtime}`,
            source: "provider",
            kind: "skill",
            invocation: "direct",
          },
        ];
  },

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
      codexCatalogConnected = true;
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
          title: CHAT_TITLE_PLACEHOLDER,
          repositoryPath: project.path,
          worktreePath: undefined,
          runtime: input.runtime,
          model: input.model,
          effort: input.effort,
        },
        draft: input.draft,
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
      title: CHAT_TITLE_PLACEHOLDER,
      status: "running",
      runtime: input.runtime,
      model: input.model,
      effort: input.effort,
      updatedAt: new Date().toISOString(),
      unread: false,
      worktree: `ai/${new Date().toISOString().slice(0, 10)}`,
    };
  },

  generateTaskTitle: async (input) => {
    if (isTauri()) {
      const nativeTaskId = await ensureNativeTask(input.taskId);
      const task = await nativeInvoke<NativeTask | null>("task_generate_title", {
        taskId: nativeTaskId,
        provider: input.runtime === "custom" ? "custom-acp" : input.runtime,
        prompt: input.prompt,
      });
      if (!task) return null;
      return {
        taskId: input.taskId,
        title: task.title,
        pinned: task.pinned,
        archived: task.archived,
        updatedAt: task.updatedAt,
      };
    }
    return {
      taskId: input.taskId,
      title: deriveChatTitle(input.prompt),
      pinned: false,
      archived: false,
      updatedAt: new Date().toISOString(),
    };
  },

  saveComposerDraft: async (draft) => {
    const persisted: ComposerDraft = {
      ...draft,
      attachments: draft.attachments.map(persistableComposerAttachment),
    };
    if (isTauri()) {
      await nativeInvoke("composer_draft_save", { draft: persisted });
      if (cachedWorkspace) {
        cachedWorkspace = {
          ...cachedWorkspace,
          composerDrafts: [
            persisted,
            ...cachedWorkspace.composerDrafts.filter(
              (candidate) => draftOwnerKey(candidate.owner) !== draftOwnerKey(persisted.owner),
            ),
          ],
        };
      }
      return;
    }
    const snapshot = cachedWorkspace ?? readDemoSnapshot();
    const next = {
      ...snapshot,
      composerDrafts: [
        persisted,
        ...snapshot.composerDrafts.filter(
          (candidate) => draftOwnerKey(candidate.owner) !== draftOwnerKey(persisted.owner),
        ),
      ],
    };
    cachedWorkspace = next;
    writeDemoSnapshot(next);
  },

  enqueueMessage: async (input) => {
    const persisted: QueueMessageInput = {
      ...input,
      attachments: input.attachments.map(persistableComposerAttachment),
    };
    const message = isTauri()
      ? await nativeInvoke<QueuedMessage>("queued_message_enqueue", { input: persisted })
      : {
          ...persisted,
          id: `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          position: (cachedWorkspace ?? readDemoSnapshot()).queuedMessages.filter(
            (candidate) => candidate.taskId === input.taskId,
          ).length,
          state: "queued" as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
    const snapshot = cachedWorkspace ?? readDemoSnapshot();
    const next = { ...snapshot, queuedMessages: [...snapshot.queuedMessages, message] };
    cachedWorkspace = next;
    if (!isTauri()) writeDemoSnapshot(next);
    return message;
  },

  listQueuedMessages: async (taskId) => {
    if (isTauri()) {
      const messages = await nativeInvoke<QueuedMessage[]>("queued_message_list", { taskId });
      if (cachedWorkspace) {
        cachedWorkspace = {
          ...cachedWorkspace,
          queuedMessages: [
            ...cachedWorkspace.queuedMessages.filter((message) => message.taskId !== taskId),
            ...messages,
          ],
        };
      }
      return messages;
    }
    return (cachedWorkspace ?? readDemoSnapshot()).queuedMessages
      .filter((message) => message.taskId === taskId)
      .sort((left, right) => left.position - right.position);
  },

  reorderQueuedMessages: async (taskId, orderedIds) => {
    const snapshot = cachedWorkspace ?? readDemoSnapshot();
    const existing = snapshot.queuedMessages.filter((message) => message.taskId === taskId);
    if (
      orderedIds.length !== existing.length ||
      new Set(orderedIds).size !== existing.length ||
      existing.some((message) => !orderedIds.includes(message.id))
    ) {
      throw new Error("Queued message reorder is stale; refresh the chat and try again.");
    }
    const messages = isTauri()
      ? await nativeInvoke<QueuedMessage[]>("queued_message_reorder", { taskId, orderedIds })
      : orderedIds.map((id, position) => ({
          ...existing.find((message) => message.id === id)!,
          position,
          updatedAt: new Date().toISOString(),
        }));
    const next = {
      ...snapshot,
      queuedMessages: [
        ...snapshot.queuedMessages.filter((message) => message.taskId !== taskId),
        ...messages,
      ],
    };
    cachedWorkspace = next;
    if (!isTauri()) writeDemoSnapshot(next);
    return messages;
  },

  takeQueuedMessage: async (taskId, messageId) => {
    const snapshot = cachedWorkspace ?? readDemoSnapshot();
    const message = isTauri()
      ? await nativeInvoke<QueuedMessage>("queued_message_take", { taskId, messageId })
      : snapshot.queuedMessages.find(
          (candidate) => candidate.taskId === taskId && candidate.id === messageId,
        );
    if (!message) throw new Error("That queued message is no longer available.");
    const next = {
      ...snapshot,
      queuedMessages: snapshot.queuedMessages.filter((candidate) => candidate.id !== messageId),
    };
    cachedWorkspace = next;
    if (!isTauri()) writeDemoSnapshot(next);
    return message;
  },

  setQueuedMessageDispatching: async (taskId, messageId, dispatching) => {
    const snapshot = cachedWorkspace ?? readDemoSnapshot();
    const current = snapshot.queuedMessages.find(
      (message) => message.taskId === taskId && message.id === messageId,
    );
    if (!current) throw new Error("That queued message is no longer available.");
    const message = isTauri()
      ? await nativeInvoke<QueuedMessage>("queued_message_set_dispatching", {
          taskId,
          messageId,
          dispatching,
        })
      : {
          ...current,
          state: dispatching ? ("dispatching" as const) : ("queued" as const),
          updatedAt: new Date().toISOString(),
        };
    const next = {
      ...snapshot,
      queuedMessages: snapshot.queuedMessages.map((candidate) =>
        candidate.id === message.id ? message : candidate,
      ),
    };
    cachedWorkspace = next;
    if (!isTauri()) writeDemoSnapshot(next);
    return message;
  },

  steerTurn: async (taskId, expectedTurnId, prompt) => {
    const snapshot = cachedWorkspace ?? readDemoSnapshot();
    if (snapshot.tasks.find((task) => task.id === taskId)?.runtime !== "codex") return false;
    if (!isTauri()) return false;
    await nativeInvoke("codex_steer_turn", { taskId, expectedTurnId, prompt });
    return true;
  },

  loadTaskGit: async (taskId) => {
    if (isTauri()) return refreshNativeGit(taskId);
    const snapshot = readDemoSnapshot();
    return snapshot.taskContexts[taskId]?.git ?? createEmptySnapshot().git;
  },

  loadProjectGit: async (projectId) => {
    if (isTauri()) return loadNativeProjectGit(projectId);
    const snapshot = readDemoSnapshot();
    return snapshot.projects.some((project) => project.id === projectId)
      ? snapshot.git
      : createEmptySnapshot().git;
  },

  loadProjectGitFile: async (projectId, file) => {
    if (isTauri()) {
      return loadNativeGitFileFromRepository(repositoryForProject(projectId), file);
    }
    return file;
  },

  initializeGit: async (projectId) => {
    const path = repositoryForProject(projectId);
    if (!isTauri()) {
      const snapshot = readDemoSnapshot();
      const project = snapshot.projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new Error(`Unknown project: ${projectId}`);
      return { ...project, gitRepositoryRoot: project.path, branch: "main" };
    }
    const project = mapProject(await nativeInvoke<TrustedProject>("project_git_init", { path }));
    verifiedNonRepositoryPaths.delete(project.path);
    // The workspace may know this folder under a different project id (for
    // example a placeholder derived from a task path), so reconcile by path
    // as well — matching only by id would leave the stale record in place.
    if (cachedWorkspace) {
      const known = cachedWorkspace.projects.some(
        (candidate) => candidate.id === project.id || candidate.path === project.path,
      );
      cachedWorkspace = {
        ...cachedWorkspace,
        projects: known
          ? cachedWorkspace.projects.map((candidate) =>
              candidate.id === project.id || candidate.path === project.path
                ? { ...candidate, gitRepositoryRoot: project.gitRepositoryRoot }
                : candidate,
            )
          : [...cachedWorkspace.projects, project],
      };
    }
    return project;
  },

  addGitRemote: async (projectId, name, url) => {
    if (!isTauri()) return bridge.loadProjectGit(projectId);
    await nativeInvoke("git_remote_add", {
      repository: repositoryForProject(projectId),
      name,
      url,
    });
    return loadNativeProjectGit(projectId);
  },

  updateGitRemote: async (projectId, name, url) => {
    if (!isTauri()) return bridge.loadProjectGit(projectId);
    await nativeInvoke("git_remote_update", {
      repository: repositoryForProject(projectId),
      name,
      url,
    });
    return loadNativeProjectGit(projectId);
  },

  removeGitRemote: async (projectId, name) => {
    if (!isTauri()) return bridge.loadProjectGit(projectId);
    await nativeInvoke("git_remote_remove", { repository: repositoryForProject(projectId), name });
    return loadNativeProjectGit(projectId);
  },

  fetchGit: async (projectId, remote) => {
    if (!isTauri()) return bridge.loadProjectGit(projectId);
    const overview = await nativeInvoke<NativeGitOverview>("git_fetch", {
      repository: repositoryForProject(projectId),
      remote,
    });
    return mapNativeGitOverview(overview);
  },

  pullGit: async (projectId, mode) => {
    if (!isTauri()) return bridge.loadProjectGit(projectId);
    const overview = await nativeInvoke<NativeGitOverview>("git_pull", {
      repository: repositoryForProject(projectId),
      mode,
    });
    return mapNativeGitOverview(overview);
  },

  publishGitBranch: async (projectId, remote) => {
    if (!isTauri()) {
      return {
        outcome: "pushed",
        head: "demo",
        branch: "main",
        remote,
        refspec: "refs/heads/main:refs/heads/main",
        summary: "Published demo branch",
      };
    }
    return nativeInvoke<PushResult>("git_publish_branch", {
      repository: repositoryForProject(projectId),
      remote,
    });
  },

  publishGithubRepository: async (projectId, input) => {
    if (!isTauri()) return bridge.loadProjectGit(projectId);
    const overview = await nativeInvoke<NativeGitOverview>("git_publish_github", {
      repository: repositoryForProject(projectId),
      ...input,
    });
    return mapNativeGitOverview(overview);
  },

  loadTaskGitHistory: async (taskId, skip) => {
    if (isTauri()) {
      const repository = repositoryForTask(taskId);
      const page = await nativeInvoke<NativeGitCommit[]>("git_history", {
        repository,
        skip,
        limit: GIT_HISTORY_PAGE,
      });
      const hasMore = page.length >= GIT_HISTORY_PAGE;
      const current = nativeGitByTask.get(taskId);
      if (current) {
        const known = new Set(current.commits.map((commit) => commit.id));
        nativeGitByTask.set(taskId, {
          ...current,
          commits: [...current.commits, ...page.filter((commit) => !known.has(commit.id))],
          historyHasMore: hasMore,
        });
      }
      return { commits: page, hasMore };
    }
    // The demo keeps a small archive so the control is exercisable in the
    // browser build; skip is measured in real commits, so ignore the
    // synthetic working-tree row.
    const realSkip = Math.max(0, skip - 1);
    const alreadyLoaded = Math.max(0, realSkip - DEMO_GIT_RECENT_COMMITS);
    const commits = demoGitHistoryArchive().slice(alreadyLoaded, alreadyLoaded + 4);
    return {
      commits,
      hasMore: alreadyLoaded + commits.length < demoGitHistoryArchive().length,
    };
  },

  loadTaskGitFile: async (taskId, file) => {
    if (isTauri()) return loadNativeGitFile(taskId, file);
    return file;
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

  writeProjectFile: async (projectId, path, content) => {
    if (isTauri()) {
      return nativeInvoke<ProjectFileContent>("project_file_write", {
        repository: repositoryForProject(projectId),
        input: { path, content },
      });
    }
    throw new Error("Editing project files requires the native desktop app.");
  },

  explainSelection: async (projectId, runtime, payload) => {
    if (isTauri()) {
      return nativeInvoke<string>("selection_explain", {
        repository: repositoryForProject(projectId),
        provider: runtime === "custom" ? "custom-acp" : runtime,
        path: payload.path,
        startLine: payload.startLine ?? null,
        endLine: payload.endLine ?? null,
        selection: payload.text,
      });
    }
    // Browser preview: a canned explanation keeps the flow demonstrable
    // without a provider CLI.
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    const lines = payload.text.split("\n").length;
    return `This selection spans ${lines} line${lines === 1 ? "" : "s"} of ${
      payload.path.split("/").at(-1) ?? payload.path
    }. In the desktop app, your current runtime explains the highlighted code here in read-only mode.`;
  },

  renameProjectFile: async (projectId, path, newName) => {
    if (isTauri()) {
      return nativeInvoke<ProjectFileEntry>("project_file_rename", {
        repository: repositoryForProject(projectId),
        input: { path, newName },
      });
    }
    throw new Error("Renaming project files requires the native desktop app.");
  },

  listProjectFileOpeners: async (projectId) => {
    if (!isTauri()) return [];
    return nativeInvoke<ProjectFileOpener[]>("project_file_opener_list", {
      repository: repositoryForProject(projectId),
    });
  },

  openProjectFileExternal: async (projectId, path, openerId) => {
    if (!isTauri()) {
      throw new Error("External file opening requires the native desktop app.");
    }
    await nativeInvoke("project_file_open", {
      repository: repositoryForProject(projectId),
      input: { path, openerId },
    });
  },

  revealProjectFile: async (projectId, path) => {
    if (!isTauri()) {
      throw new Error("Revealing project files requires the native desktop app.");
    }
    await nativeInvoke("project_file_reveal", {
      repository: repositoryForProject(projectId),
      input: { path },
    });
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

  listRuntimeActionPlans: async (runtime, kind) => {
    if (isTauri()) {
      return nativeInvoke<RuntimeActionPlan[]>("runtime_action_plan_list", {
        provider: runtime,
        kind,
      });
    }
    const current = readDemoSnapshot().runtimes.find((candidate) => candidate.id === runtime);
    if (kind !== "install" && !current) return [];
    const command =
      kind === "install"
        ? `Install ${runtime} with its official installer`
        : kind === "login"
          ? `${current?.command ?? runtime} login`
          : `${current?.command ?? runtime} update`;
    return [
      {
        id: `${runtime}:${kind}:preview`,
        provider: runtime,
        kind,
        method: kind === "install" ? "Official installer" : "Vendor CLI",
        label: kind === "install" ? "Install with official installer" : `${kind} with vendor CLI`,
        command,
        description: "Native builds resolve and run this provider-owned action locally.",
        sourceUrl: "",
        available: true,
        recommended: true,
        downloadsAndExecutesCode: kind !== "login",
        modifiesOutsideProjects: true,
        environmentNote:
          "Runs locally with a reduced environment. API-key variables are not inherited.",
      },
    ];
  },

  openRuntimeTerminal: async (planId, dimensions) => {
    if (!isTauri()) {
      throw new Error("Runtime setup commands run only in the native desktop app.");
    }
    return nativeInvoke<RuntimeTerminalInfo>("runtime_terminal_open", {
      planId,
      ...dimensions,
    });
  },

  writeRuntimeTerminal: async (sessionId, data) => {
    if (!isTauri()) return;
    await nativeInvoke("runtime_terminal_write", { sessionId, data });
  },

  resizeRuntimeTerminal: async (sessionId, dimensions) => {
    if (!isTauri()) return;
    await nativeInvoke("runtime_terminal_resize", { sessionId, ...dimensions });
  },

  closeRuntimeTerminal: async (sessionId) => {
    if (!isTauri()) return;
    await nativeInvoke("runtime_terminal_close", { sessionId });
  },

  subscribeRuntimeTerminalOutput: async (listener) => {
    if (!isTauri()) return () => undefined;
    const { listen } = await import("@tauri-apps/api/event");
    return listen<RuntimeTerminalOutputEvent>("runtime-terminal://output", (event) => {
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

  setTaskStatus: async (taskId, status) => {
    const taskState: NativeTask["state"] =
      status === "stopped"
        ? "cancelled"
        : status === "starting"
          ? "running"
          : status === "draft"
            ? "ready"
            : status;
    if (isTauri()) {
      const nativeTaskId = await ensureNativeTask(taskId);
      await nativeInvoke<NativeTask>("task_set_state", {
        taskId: nativeTaskId,
        taskState,
      });
      return;
    }
    const snapshot = cachedWorkspace ?? readDemoSnapshot();
    const next = {
      ...snapshot,
      tasks: snapshot.tasks.map((task) =>
        task.id === taskId ? { ...task, status, updatedAt: new Date().toISOString() } : task,
      ),
    };
    cachedWorkspace = next;
    writeDemoSnapshot(next);
  },

  sendTurn: async (input) => {
    if (isTauri()) {
      if (input.runtime === "codex") {
        const nativeTaskId = await ensureNativeTask(input.taskId);
        let threadId: string | undefined;
        const startTurn = async (targetThreadId: string) =>
          nativeInvoke("codex_start_turn", {
            taskId: nativeTaskId,
            threadId: targetThreadId,
            prompt: input.prompt,
            repository: repositoryForTask(input.taskId),
            nativeActionId: input.nativeActionId,
            delegation: input.delegation,
          });
        try {
          threadId = await ensureCodexThread(input);
          try {
            await startTurn(threadId);
          } catch (error) {
            if (!isMissingCodexThreadError(error)) throw error;
            forgetCodexThread(input.taskId, nativeTaskId, threadId);
            threadId = await ensureCodexThread(input);
            await startTurn(threadId);
          }
        } catch (error) {
          if (isCodexConnectionError(error)) {
            codexConnectedTasks.delete(nativeTaskId);
            if (threadId) activeCodexThreads.delete(threadId);
          }
          throw error;
        }
      } else if (input.runtime === "cursor") {
        try {
          const taskId = await ensureCursorSession(input);
          await applyCursorSelection(taskId, input);
          await nativeInvoke("acp_send_turn", {
            taskId,
            prompt: input.prompt,
            delegation: input.delegation,
            nativeActionId: input.nativeActionId,
          });
        } catch (error) {
          resetCursorConnectionState(input.taskId);
          throw error;
        }
      } else if (input.runtime === "grok") {
        try {
          const taskId = await ensureGrokSession(input);
          await nativeInvoke("acp_send_turn", {
            taskId,
            prompt: input.prompt,
            delegation: input.delegation,
            nativeActionId: input.nativeActionId,
          });
        } catch (error) {
          resetGrokConnectionState(input.taskId);
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
          nativeActionId: input.nativeActionId,
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
    // Delegated child tasks are intentionally hidden from the sidebar
    // snapshot, so their native ids may not be present in nativeTaskIds.
    // delegation_list is read-only and can safely accept that authoritative
    // child task id directly when walking descendant lineage.
    const nativeTaskId = nativeTaskIds.get(taskId) ?? taskId;
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

  sendDelegationMessage: async (delegationId, message, routing) => {
    if (!isTauri()) throw new Error("Delegation requires the native app");
    await nativeInvoke("delegation_send_message", {
      delegationId,
      message,
      routing: routing
        ? {
            runtime: routing.runtime,
            model: realModelId(routing.model),
            effort: routing.effort,
          }
        : undefined,
    });
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
    if (!isTauri()) return { events: [], watermarkSeq: 0, runtimeLive: false };
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

  setSessionMode: async (taskId, modeId) => {
    if (!isTauri()) {
      throw new Error("Session modes are only available during a native provider run");
    }
    const nativeTaskId = await ensureNativeTask(taskId);
    await nativeInvoke("acp_set_mode", { taskId: nativeTaskId, modeId });
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
      const statuses = await nativeInvoke<NativeFileStatus[]>(
        staged ? "git_stage" : "git_unstage",
        { repository, paths },
      );
      const current = nativeGitByTask.get(taskId);
      if (!current) return refreshNativeGit(taskId);
      // Stage/unstage returns authoritative scoped status and line counts.
      // Branch, history and divergence cannot change here, so rebuilding the
      // rest of the overview is unnecessary on the hottest Git interaction.
      const previousByScope = new Map(current.files.map((file) => [diffFileKey(file), file]));
      const git = {
        ...current,
        files: statuses.flatMap(summarizeNativeGitFiles).map((summarized) => {
          const previous = previousByScope.get(diffFileKey(summarized));
          if (!previous || summarized.statsLoaded !== false || previous.statsLoaded === false) {
            return summarized;
          }
          return {
            ...summarized,
            additions: previous.additions,
            deletions: previous.deletions,
            statsLoaded: true,
          };
        }),
      };
      nativeGitByTask.set(taskId, git);
      return git;
    }
    const git = readDemoSnapshot().git;
    return {
      ...git,
      files: git.files.map((file) => (paths.includes(file.path) ? { ...file, staged } : file)),
    };
  },

  stageProjectFiles: async (projectId, paths, staged) => {
    if (isTauri()) {
      await nativeInvoke(staged ? "git_stage" : "git_unstage", {
        repository: repositoryForProject(projectId),
        paths,
      });
      return loadNativeProjectGit(projectId);
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
      files: git.files.filter((file) => !file.staged),
      commits: [
        {
          id: "local",
          subject: message,
          relativeTime: "now",
          current: true,
          parents: git.commits[0] ? [git.commits[0].id] : [],
          unpushed: true,
        },
        ...git.commits.map((commit) => ({ ...commit, current: false })),
      ],
    };
  },

  commitProject: async (projectId, message) => {
    if (isTauri()) {
      await nativeInvoke("git_commit", {
        repository: repositoryForProject(projectId),
        message,
      });
      return loadNativeProjectGit(projectId);
    }
    const git = readDemoSnapshot().git;
    return {
      ...git,
      ahead: git.ahead + 1,
      files: git.files.filter((file) => !file.staged),
      commits: [
        {
          id: "local",
          subject: message,
          relativeTime: "now",
          current: true,
          parents: git.commits[0] ? [git.commits[0].id] : [],
          unpushed: true,
        },
        ...git.commits.map((commit) => ({ ...commit, current: false })),
      ],
    };
  },

  generateCommitMessage: async (taskId, runtime) => {
    if (!isTauri()) {
      throw new Error("Commit-message generation is available only in the native desktop app");
    }
    const nativeTaskId = await ensureNativeTask(taskId);
    return nativeInvoke<string>("git_generate_commit_message", {
      taskId: nativeTaskId,
      provider: runtime === "custom" ? "custom-acp" : runtime,
    });
  },

  previewPush: async (taskId) => {
    if (!isTauri()) {
      throw new Error("Push preview is available only in the native desktop app");
    }
    const repository = repositoryForTask(taskId);
    return nativeInvoke<PushPreview>("git_push_preview", { repository });
  },

  previewProjectPush: async (projectId) => {
    if (!isTauri()) {
      throw new Error("Push preview is available only in the native desktop app");
    }
    return nativeInvoke<PushPreview>("git_push_preview", {
      repository: repositoryForProject(projectId),
    });
  },

  confirmPush: async (taskId, confirmation) => {
    if (!isTauri()) {
      throw new Error("Confirmed push is available only in the native desktop app");
    }
    const repository = repositoryForTask(taskId);
    return nativeInvoke<PushResult>("git_push_confirmed", { repository, confirmation });
  },

  confirmProjectPush: async (projectId, confirmation) => {
    if (!isTauri()) {
      throw new Error("Confirmed push is available only in the native desktop app");
    }
    return nativeInvoke<PushResult>("git_push_confirmed", {
      repository: repositoryForProject(projectId),
      confirmation,
    });
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
      cachedWorkspace = {
        ...snapshot,
        composerDrafts: cachedWorkspace?.composerDrafts ?? snapshot.composerDrafts,
        queuedMessages: cachedWorkspace?.queuedMessages ?? snapshot.queuedMessages,
      };
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
    const merged = {
      ...snapshot,
      taskContexts,
      usage: activeUsage,
      composerDrafts: previous.composerDrafts,
      queuedMessages: previous.queuedMessages,
    };
    cachedWorkspace = merged;
    writeStoredNavigation(merged);
    writeDemoSnapshot(merged);
  },
};
