import type { WorkspaceSnapshot } from "./demoData";
import {
  createDemoSnapshot,
  createEmptySnapshot,
  DEMO_GIT_RECENT_COMMITS,
  demoGitHistoryArchive,
} from "./demoData";
import { prettyModelLabel, resolveModelLabel } from "./modelLabel";
import type { SpecialistSetting } from "./subagentSettings";

export type RuntimeId = "codex" | "cursor" | "claude" | "grok" | "kimi" | "antigravity" | "custom";
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
  certification?: "certified" | "session_probe_required" | "uncertified";
  capabilities?: {
    sessionResume: boolean;
    authoritativeHistory: boolean;
    structuredToolEvents: boolean;
    hooks: boolean;
    sandboxedWorkspace: boolean;
    subscriptionAuth: boolean;
    skills: boolean;
  };
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

/** One Integrator-plane skill: bounded display metadata plus enablement.
 * Individual skill paths never cross into the renderer. */
export interface IntegratorSkillInfo {
  name: string;
  description: string;
  /** "integrator" (user Skills root), "plugin" (user Plugins root), or
   * "first-party" (bundled with the app). */
  source: string;
  enabled: boolean;
  defaultEnabled: boolean;
  invocationCount: number;
  credential?: IntegratorSkillCredentialInfo;
}

export interface IntegratorSkillCredentialInfo {
  id: string;
  label: string;
  required: boolean;
  configured: boolean;
  available: boolean;
  storage: "protectedLocalFile" | "osCredentialStore";
  helpUrl: string;
}

export interface IntegratorSkillsOverview {
  /** Display paths of the user-visible Documents roots. */
  skillsRoot: string;
  pluginsRoot: string;
  bundledAvailable: boolean;
  skills: IntegratorSkillInfo[];
}

/** One skill read live from a curated repository's SKILL.md, before install. */
export interface RemoteSkillPreview {
  name: string;
  description: string;
  path: string;
}

export interface RemoteSkillsPreview {
  skills: RemoteSkillPreview[];
  /** Real count on GitHub; may exceed `skills.length` when truncated. */
  totalFound: number;
  truncated: boolean;
}

/** One remote skill's full raw SKILL.md text, fetched on demand only when
 * the user explicitly opens it. */
export interface RemoteSkillBody {
  name: string;
  body: string;
  truncated: boolean;
}

/** One local (installed) skill's full raw SKILL.md text. */
export interface IntegratorSkillBody {
  name: string;
  description: string;
  body: string;
  truncated: boolean;
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
  if (runtime.detail === "auth-probe-requires-acp" || runtime.detail === "auth-not-probed") {
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
  pinned?: boolean;
  archived?: boolean;
}

export interface TaskSummary {
  id: string;
  projectId: string;
  /** Persisted natively; omitted only by older browser-preview fixtures (code). */
  kind?: "code" | "chat";
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

export interface ArchivedTaskPage {
  tasks: TaskSummary[];
  nextCursor?: string;
  total: number;
}

export interface SearchTaskMessagesOptions {
  /** When true, include archived chats. Live sidebar search leaves this false. */
  includeArchived?: boolean;
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
  /** Integrator-owned scheduling provenance; rendered as quiet stream activity. */
  scheduling?: {
    automationId: string;
    runId?: string;
    phase: "created" | "starting" | "prompt" | "failed";
    canCancel?: boolean;
    /** Fixed near-term wake time displayed as a live countdown. */
    countdownAt?: string;
  };
  /**
   * Codex (and compatible hosts) classify assistant text as mid-turn commentary
   * or the turn's final answer. Absent when the runtime does not emit a phase.
   */
  phase?: "commentary" | "final_answer";
  timestamp: string;
  status?: "running" | "success" | "warning" | "error" | "neutral";
  meta?: string;
  /** Quiet cue that this Worked-for span continued after an interruption. */
  resumed?: boolean;
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
  | "interrupted"
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
  serviceLevel?: "budget" | "standard" | "premium";
  capabilitySnapshot?: {
    version: number;
    profileId: string;
    profileLabel: string;
    bestFor: string;
    workingGuidance: string;
    accessCeiling: "read-only" | "project-write";
    serviceLevel: "budget" | "standard" | "premium";
    routes: Array<{ runtime: string; model?: string | null; effort?: string | null }>;
    skillIds: string[];
    mcpServerIds: string[];
    createdAt: string;
  };
  /** Present on current native rows; older local/export fixtures default read-only. */
  permission?: "read-only" | "project-write";
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

export interface LogsTotals {
  bytes: number;
  fileCount: number;
  incidentFiles: number;
  detailFiles: number;
  measuredAt: string;
  path: string;
}

export type DiagnosticChannel = "incident" | "detail";

export interface DiagnosticRecord {
  level?: string;
  faultId?: string;
  layer?: string;
  op?: string;
  outcome?: string;
  code?: string;
  causeClass?: string;
  retryable?: boolean;
  projectId?: string;
  taskId?: string;
  runId?: string;
  processId?: string;
  turnId?: string;
  requestId?: string;
  route?: string;
  prevPhase?: string;
  durationMs?: number;
  detail?: string;
  message?: string;
  appVersion?: string;
  [key: string]: unknown;
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
  /** Provider-owned account activity. This can include usage outside
   * Integrator and therefore remains separate from local task history. */
  accountUsage?: ProviderAccountUsage;
  provenance: UsageProvenance;
  detail: string;
}

/** One provider-reported rate-limit window; `resetsAt` is Unix seconds. */
export interface SubscriptionWindow {
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export interface SubscriptionCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string | null;
}

export interface SubscriptionSpendLimit {
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAt: number;
}

export interface SubscriptionQuotaBucket {
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
  primary?: SubscriptionWindow | null;
  secondary?: SubscriptionWindow | null;
  credits?: SubscriptionCredits | null;
  individualLimit?: SubscriptionSpendLimit | null;
  rateLimitReachedType?: string | null;
}

export interface SubscriptionQuota {
  planType?: string;
  primary?: SubscriptionWindow;
  secondary?: SubscriptionWindow;
  buckets?: SubscriptionQuotaBucket[];
  resetCreditsAvailable?: number;
  updatedAt?: string;
}

export interface ProviderAccountUsageSummary {
  lifetimeTokens?: number | null;
  peakDailyTokens?: number | null;
  longestRunningTurnSec?: number | null;
  currentStreakDays?: number | null;
  longestStreakDays?: number | null;
}

export interface ProviderAccountUsage {
  summary: ProviderAccountUsageSummary;
  dailyUsageBuckets: Array<{ startDate: string; tokens: number }>;
  updatedAt: string;
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
  storage: "os-credential-store" | "protected-local-file" | "native-only";
  provider: "openai";
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

export interface ChatContextReference {
  id: string;
  sourceTaskId: string;
  sourceTitle: string;
}

export interface TaskContextReference {
  id: string;
  targetTaskId: string;
  sourceTaskId?: string;
  sourceTitle: string;
  sourceWatermark: number;
  messageCount: number;
  renderedChars: number;
  renderedSha256: string;
  renderedMarkdown: string;
  createdAt: string;
}

export interface ComposerDraftValue {
  prompt: string;
  attachments: ComposerDraftAttachment[];
  contextReferences?: ChatContextReference[];
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
  contextReferences?: ChatContextReference[];
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
}

/** How hard a push may rewrite remote history. `off` is the only mode that
 * cannot destroy a commit the user has never seen. */
export type PushForce = "off" | "lease" | "always";

export interface PushConfirmation {
  expectedHead: string;
  expectedBranch: string;
  expectedRemote: string;
  expectedRemoteUrl?: string | null;
  expectedUpstream: string;
  expectedRefspec: string;
  /** Intent rather than expected state: the force mode the user confirmed.
   * Omitted means `off` — the native side defaults to the safe mode. */
  force?: PushForce;
}

export interface PushResult {
  outcome: "pushed" | "upToDate" | "outcomeUncertain";
  head: string;
  branch: string;
  remote: string;
  refspec: string;
  summary: string;
}

export interface ForkTaskInput {
  taskId: string;
  /** Full title for the copy; callers derive it with `nextForkTitle`. */
  title: string;
  /**
   * Transcript event id of the assistant reply to branch from. The copy keeps
   * that reply and everything before it. Omitted for a whole-chat copy, which
   * excludes the source's unfinished turn when one is still running.
   */
  throughEventId?: string;
}

export interface TruncateTaskFromInput {
  taskId: string;
  /** Transcript event id of the user message being re-sent from. */
  fromEventId: string;
  /**
   * When true, discarded assistant replies below the edit point stay in the
   * next turn's conversation digest even though the chat view clears them.
   */
  saveContext: boolean;
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

export type CreateChatInput = Pick<StartTaskInput, "runtime" | "model" | "effort">;

export interface MemoryEntry {
  id: string;
  text: string;
  state: "active" | "disabled";
  creator: "user" | "agent";
  sourceTaskId?: string;
  sourceItemId?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export interface GenerateTaskTitleInput {
  taskId: string;
  prompt: string;
  runtime: RuntimeId;
  /** Optional override used by native naming; normally mirrors Git's commit-message route. */
  route?: ExplainRoute;
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

export interface SpecialistRuntimeCatalog {
  runtime: RuntimeId;
  models: ModelCatalogEntry[];
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
  attachments?: ComposerDraftAttachment[];
  contextReferences?: ChatContextReference[];
  /** Opaque selection returned by listNativeProviderActions. */
  nativeActionId?: string;
  /** Continue a transport-interrupted turn from its provider-owned session. */
  resumeInterrupted?: boolean;
}

export interface AutomationRoute {
  runtime: RuntimeId;
  model: string;
  effort?: string;
  fallbacks: AutomationFallback[];
  permission: ComposerDraftValue["permission"];
  delegation: ComposerDraftValue["delegation"];
}

export interface AutomationFallback {
  runtime: RuntimeId;
  model: string;
  effort?: string;
}

export type AutomationTarget = { kind: "task" } | { kind: "delegation"; delegationId: string };

export type AutomationTrigger =
  | { kind: "at"; runAt: string }
  | { kind: "interval"; everySeconds: number; anchorAt: string; endAt?: string }
  | {
      kind: "delegationsSettled";
      delegationIds: string[];
      requireAll: boolean;
      timeoutAt?: string;
    };

export interface Automation {
  id: string;
  taskId: string;
  title: string;
  prompt: string;
  target: AutomationTarget;
  trigger: AutomationTrigger;
  route: AutomationRoute;
  source: "user" | "agent";
  recurrenceUserRequest?: string;
  iterationNotes?: boolean;
  nextRunNote?: string;
  status: "active" | "paused" | "running" | "completed" | "needs-attention" | "cancelled";
  nextRunAt?: string;
  lastRunAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  scheduledFor: string;
  status: "claimed" | "dispatched" | "failed";
  dispatchRef?: string;
  error?: string;
  claimedAt: string;
  finishedAt?: string;
}

export interface AutomationDispatch {
  automation: Automation;
  run: AutomationRun;
}

export interface AutomationTimelineEntry {
  automation: Automation;
  runs: AutomationRun[];
}

export interface AutomationWriteInput {
  title: string;
  prompt: string;
  trigger: AutomationTrigger;
  route: AutomationRoute;
  recurrenceUserRequest?: string;
  iterationNotes: boolean;
}

export interface AutomationCreateInput extends AutomationWriteInput {
  taskId: string;
  target: AutomationTarget;
}

export interface AutomationChanged {
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
  /** Verified provider-native skill invoked by this user item. */
  nativeSkill?: string;
  /** Present for agentMessage when the host reports commentary vs final answer. */
  phase?: "commentary" | "final_answer";
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

/** One answer choice offered by a "question" approval. */
export interface QuestionOption {
  optionId: string;
  label: string;
}

export interface ApprovalProjection {
  id: string;
  requestId: { kind: "number"; value: number } | { kind: "string"; value: string };
  approvalKind: "commandExecution" | "fileChange" | "planReview" | "question";
  state:
    "pending" | "responding" | "resolved" | "declined" | "cancelled" | "expired" | "responseFailed";
  decision?: "accept" | "acceptForSession" | "decline" | "cancel" | "select";
  itemId?: string;
  approvalId?: string;
  reason?: string;
  command?: string;
  cwd?: string;
  fileChanges?: ItemProjection["fileChanges"];
  /** Full plan document (markdown) for planReview approvals. */
  planMarkdown?: string;
  /** Answer choices for a "question" approval (ACP has no elicitation
   *  method, so the agent asked through the permission channel instead). */
  options?: QuestionOption[];
  /** Which `options` entry the user picked, once answered. */
  selectedOptionId?: string;
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
  provider: "codex" | "cursor" | "claude" | "antigravity" | "grok" | "kimi" | "custom-acp";
  threadId: string;
  turnId?: string;
  occurredAt: string;
  projection: RuntimeProjection;
}

/** Compact cold-hydrate payload; live updates still use RuntimeProjectionEvent. */
export interface TaskProjectionHydrate {
  turn?: TurnProjection;
  items: ItemProjection[];
  plan: PlanStepProjection[];
  planTruncated: boolean;
  diff?: { body: string; truncated: boolean; seq: number; occurredAt: string };
  usage?: RuntimeUsageProjection;
  approvals: ApprovalProjection[];
  mode?: ModeProjection;
  connection?: ConnectionProjection;
  error?: { message: string; retryable: boolean; seq: number; occurredAt: string };
  firstSeen: Record<string, string>;
  hasMoreOlder: boolean;
  /** Oldest last_event_seq in this page; pass as beforeSeq to load older. */
  beforeSeq?: number;
}

export interface TaskProjectionSnapshot {
  watermarkSeq: number;
  /** Current projection reset epoch; required with watermarkSeq for cache short-circuit. */
  resetSeq: number;
  /** Native-process liveness attested while the snapshot was loaded. */
  runtimeLive: boolean;
  /** Client cache matched known watermark + reset; hydrate omitted. */
  cacheMatched?: boolean;
  hydrate?: TaskProjectionHydrate;
}

export interface LoadTaskProjectionOptions {
  knownWatermark?: number;
  knownResetSeq?: number;
  /** Load items/approvals with last_event_seq < beforeSeq. */
  beforeSeq?: number;
  limit?: number;
  /** Read the durable projection without waiting on native runtime ownership checks. */
  skipRuntimeCheck?: boolean;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface TerminalSessionInfo {
  id: string;
  cwd: string;
  shell: string;
}

export interface TerminalOutputEvent {
  sessionId: string;
  stream: "output" | "exit";
  data?: string;
  exitCode?: number | null;
}

export type RuntimeActionKind = "install" | "update" | "login" | "usage";

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

/** What the selection explainer is asked to do. Each archetype swaps the whole
 * mission rather than modifying one prompt, so `socratic` can forbid the very
 * thing `explanation` requires. `custom` carries the user's own mission. */
export type ExplainArchetype =
  "explanation" | "socratic" | "optimization" | "critique" | "security" | "custom";

/** A user-authored archetype. `id` is what `explain.archetype` stores, so it
 * must not collide with a built-in name. */
export interface CustomArchetype {
  id: string;
  label: string;
  mission: string;
}

export interface ExplainConfig {
  archetype: ExplainArchetype;
  /** Read only when `archetype` is `custom`. */
  customMission?: string;
  /** 1-100. Drives both the answer's length and how much context is gathered. */
  verbosity: number;
  /** 0-3, beginner to expert. */
  technicality: number;
}

export interface ExplainRoute {
  runtime: RuntimeId;
  /** Catalog model id. Required for commit-message generation; for explain,
   * omitted only when the route inherits the chat's already-chosen model. */
  model?: string;
  effort?: string;
  /** Runtimes to try in order once the primary cannot answer. Each runs on its
   * own default model — a model id is not portable to another provider. */
  fallbacks: RuntimeId[];
}

export interface ExplainOutcome {
  text: string;
  /** Who actually answered. Not necessarily the runtime the user picked, since
   * the route fails over, so the panel must label the answer with this. */
  runtime: RuntimeId;
  usedFallback: boolean;
}

/** One completed ask-panel question/answer pair, re-sent with a follow-up so
 * the sessionless helper can answer in context. An empty `question` marks the
 * initial analysis request. */
export interface ExplainExchange {
  question: string;
  answer: string;
}

/** One packet of the ask panel's live stream. `attempt` announces the provider
 * about to answer — the panel must clear its buffer on it, since a fallback
 * must not append to a failed primary's partial output. `delta` appends text. */
export interface ExplainStreamEvent {
  kind: "attempt" | "delta";
  text: string;
  runtime: RuntimeId;
}

export interface AppBridge {
  getAppInfo(): Promise<LocalAppInfo>;
  getStorageTotals(): Promise<StorageTotals>;
  getLogsTotals(): Promise<LogsTotals>;
  openLogsFolder(): Promise<void>;
  clearLogs(): Promise<void>;
  pruneLogs(): Promise<void>;
  reportDiagnostic(channel: DiagnosticChannel, record: DiagnosticRecord): Promise<void>;
  getUsageSummary(): Promise<UsageSummary>;
  listSettings(): Promise<LocalSetting[]>;
  setSetting(key: string, value: unknown): Promise<LocalSetting>;
  getVoiceTypingCredentialStatus?(): Promise<VoiceTypingCredentialStatus>;
  setVoiceTypingCredential?(apiKey: string): Promise<VoiceTypingCredentialStatus>;
  clearVoiceTypingCredential?(): Promise<void>;
  /** Transcribes one finished recording (base64 16-bit LE mono PCM). */
  transcribeVoiceClip?(pcmBase64: string, sampleRate: number): Promise<string>;
  /** Native file picker for composer context attachments (any file on disk).
   * Images arrive with an inline preview data URL; null means cancelled. */
  pickContextAttachments?(chatTaskId?: string): Promise<ContextAttachment[] | null>;
  /** Persists a clipboard image and returns a composer-ready attachment. */
  savePastedImageAttachment?(
    file: Blob,
    fileName?: string,
    chatTaskId?: string,
  ): Promise<ContextAttachment>;
  /** Loads an inline preview for an image path referenced by a chat message. */
  readAttachmentPreview?(path: string): Promise<string | null>;
  exportLocalData(): Promise<unknown>;
  clearLocalData(): Promise<void>;
  loadWorkspace(): Promise<WorkspaceSnapshot>;
  /** Paginated archived root chats for Archive UI (not part of workspace bootstrap). */
  listArchivedTasks(input?: { cursor?: string; limit?: number }): Promise<ArchivedTaskPage>;
  /** Search locally persisted user/assistant message text without loading chat snapshots. */
  searchTaskMessages(
    query: string,
    limit?: number,
    options?: SearchTaskMessagesOptions,
  ): Promise<TaskMessageSearchHit[]>;
  openProject(): Promise<ProjectSummary | null>;
  /** Create `Documents/AI Integrator/Projects/<name>` (deduped), git-init it, and register it. */
  createProject(name: string): Promise<ProjectSummary>;
  getDefaultProjectParent(): Promise<string>;
  pickProjectParent(): Promise<string | null>;
  listGithubRepositories(): Promise<GithubRepositoryCatalog>;
  cloneProject(input: CloneProjectInput): Promise<ProjectSummary>;
  registerProject(path: string): Promise<ProjectSummary>;
  listProjects(): Promise<ProjectSummary[]>;
  /** Detach a project and wipe Integrator history; optionally delete the folder. */
  removeProject(projectId: string, options?: { deleteFiles?: boolean }): Promise<void>;
  probeRuntimes(options?: { force?: boolean }): Promise<RuntimeConnection[]>;
  beginRuntimeLogin(runtime: RuntimeId): Promise<RuntimeConnection>;
  startTask(input: StartTaskInput): Promise<TaskSummary>;
  /** Create a durable, projectless Chat immediately so its empty draft is crash-safe. */
  createChat(input: CreateChatInput): Promise<TaskSummary>;
  listTaskContextReferences(taskId: string): Promise<TaskContextReference[]>;
  listMemories(): Promise<MemoryEntry[]>;
  createMemory(text: string): Promise<MemoryEntry>;
  updateMemory(memoryId: string, text: string): Promise<MemoryEntry>;
  setMemoryEnabled(memoryId: string, enabled: boolean): Promise<MemoryEntry>;
  deleteMemory(memoryId: string): Promise<void>;
  /**
   * Copy a chat into a new one. `throughEventId` keeps the transcript up to and
   * including that assistant reply and drops the rest; omitting it copies the
   * settled conversation and leaves any unfinished turn only in the source.
   * The copy never resumes the source's provider session, so its first prompt
   * opens a fresh one seeded from the copied transcript.
   */
  forkTask(input: ForkTaskInput): Promise<TaskSummary>;
  /**
   * Drop the transcript from a user message onward so that message can be
   * edited and re-sent as the new tip. Always clears provider resume state.
   */
  truncateTaskFrom(input: TruncateTaskFromInput): Promise<void>;
  /** Revisioned local persistence; stale writes are ignored by the native store. */
  saveComposerDraft(draft: ComposerDraft): Promise<void>;
  /** Permanently wipe one chat and its Integrator history. Never touches the project folder. */
  removeTask(taskId: string): Promise<void>;
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
  /**
   * The subset of `paths` Git tracks. Status already reports untracked files,
   * so a path absent from both is ignored rather than committed — the caller
   * needs that difference to avoid captioning an ignored file "Pushed".
   */
  trackedPaths(projectId: string, paths: string[]): Promise<string[]>;
  listProjectFiles(projectId: string): Promise<ProjectFileEntry[]>;
  readProjectFile(projectId: string, path: string): Promise<ProjectFileContent>;
  /** Write manually edited text back to one trusted project file (native builds only). */
  writeProjectFile(projectId: string, path: string, content: string): Promise<ProjectFileContent>;
  /**
   * Subscribe to debounced working-tree mutations for the checkout currently
   * displayed by this window. The native side authorizes and owns the watcher;
   * the renderer receives only an invalidation signal.
   */
  subscribeWorkingTreeChanges(repository: string, listener: () => void): Promise<() => void>;
  /** Explain a highlighted selection through the isolated, tool-denied helper
   * boundary shared with chat naming. Returns plain prose; when `onDelta` is
   * given, answer text also streams through it while the call runs, and the
   * resolved outcome remains the authoritative final text. Follow-ups pass
   * `question` plus the prior `history` — the helper keeps no session, so
   * continuity lives in the prompt. */
  explainSelection(
    projectId: string,
    route: ExplainRoute,
    config: ExplainConfig,
    payload: {
      path: string;
      startLine?: number;
      endLine?: number;
      text: string;
      /** The live editor buffer. The file view is editable, so the selection's
       * own file is sent rather than read from disk: reading it back would
       * explain a stale version whenever there are unsaved edits. */
      fileText?: string;
      question?: string;
      history?: ExplainExchange[];
    },
    onDelta?: (event: ExplainStreamEvent) => void,
  ): Promise<ExplainOutcome>;
  /** The exact prompt the given settings would send. Composed natively by the
   * same function a real explanation uses, so the settings preview cannot drift
   * from what actually reaches the provider. */
  explainPromptPreview(config: ExplainConfig, project?: string): Promise<string>;
  /** Rename a file in place inside the trusted project (native builds only). */
  renameProjectFile(projectId: string, path: string, newName: string): Promise<ProjectFileEntry>;
  /** Duplicate a file beside itself inside the trusted project (native only). */
  duplicateProjectFile(projectId: string, path: string): Promise<ProjectFileEntry>;
  /** Resolve a repository-relative path to a canonical absolute path. */
  resolveProjectPath(
    projectId: string,
    path: string,
  ): Promise<{ absolutePath: string; relativePath: string }>;
  /** Native-detected, allowlisted file-opening targets for one trusted project. */
  listProjectFileOpeners(projectId: string): Promise<ProjectFileOpener[]>;
  openProjectFileExternal(projectId: string, path: string, openerId: string): Promise<void>;
  revealProjectFile(projectId: string, path: string): Promise<void>;
  /** Reveal an absolute project/worktree path in the system file manager. */
  revealAbsolutePath(path: string): Promise<void>;
  /** Reveal the folder paired with a task (chat-runtime, worktree, or repository). */
  revealTask(taskId: string): Promise<void>;
  /** Resolve the folder paired with a task for copy-path actions. */
  resolveTaskFolder(taskId: string): Promise<string>;
  openTerminal(
    projectId: string,
    dimensions: { cols: number; rows: number },
  ): Promise<TerminalSessionInfo>;
  writeTerminal(sessionId: string, data: string): Promise<void>;
  resizeTerminal(sessionId: string, dimensions: { cols: number; rows: number }): Promise<void>;
  interruptTerminal(sessionId: string): Promise<void>;
  terminalHasForegroundProcess(sessionId: string): Promise<boolean>;
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
  /** Opens (or focuses) a second window mirroring this chat; task events broadcast to both. */
  openTaskWindow?(taskId: string): Promise<void>;
  sendTurn(input: SendTurnInput): Promise<TranscriptEvent>;
  listAutomations(taskId?: string): Promise<Automation[]>;
  createAutomation(input: AutomationCreateInput): Promise<Automation>;
  updateAutomation(automationId: string, input: AutomationWriteInput): Promise<Automation>;
  listAutomationRuns(automationId: string): Promise<AutomationRun[]>;
  automationTimeline(taskId: string): Promise<AutomationTimelineEntry[]>;
  pendingAutomationDispatches(): Promise<AutomationDispatch[]>;
  setAutomationPaused(automationId: string, paused: boolean): Promise<Automation>;
  cancelAutomation(automationId: string): Promise<Automation>;
  runAutomationNow(automationId: string): Promise<Automation>;
  finishAutomationRun(
    runId: string,
    outcome: { dispatchRef?: string; error?: string },
  ): Promise<Automation>;
  subscribeAutomationDue(listener: (dispatch: AutomationDispatch) => void): Promise<() => void>;
  subscribeAutomationChanges(listener: (change: AutomationChanged) => void): Promise<() => void>;
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
  loadTaskProjection(
    taskId: string,
    options?: LoadTaskProjectionOptions,
  ): Promise<TaskProjectionSnapshot>;
  respondToApproval(
    taskId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalProjection>;
  /** Answer a "question" approval with one of its offered options. */
  respondToQuestion(
    taskId: string,
    approvalId: string,
    optionId: string,
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
  /** Draft one bounded staged-diff subject through the configured commit-message
   * route (primary model plus ordered fallbacks). */
  generateCommitMessage(taskId: string, route: ExplainRoute): Promise<string>;
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
  getCachedModelCatalog(runtime: RuntimeId): ModelCatalogEntry[] | undefined;
  /** Warm the catalogs of connected runtimes so a picker never waits on a
   *  first probe. Fire-and-forget: failures leave the lazy path unchanged. */
  prefetchModelCatalogs(runtimes: RuntimeConnection[]): void;
  /** Start Grok/Kimi ACP (connect + session) before the user hits send. */
  prepareAcpRuntime(input: {
    taskId: string;
    runtime: RuntimeId;
    model?: string;
    effort?: string;
    permission?: StartTaskInput["permission"];
    delegation?: StartTaskInput["delegation"];
  }): Promise<void>;
  refreshModelCatalog(runtime: RuntimeId): Promise<ModelCatalogEntry[]>;
  invalidateModelCatalog(runtime: RuntimeId): void;
  subscribeModelCatalogs(listener: () => void): () => void;
  /** Provider-owned skills/commands for one explicitly trusted repository. */
  listNativeProviderActions(
    runtime: RuntimeId,
    repository: string,
  ): Promise<NativeProviderAction[]>;
  /** The Integrator-plane skill inventory: user Documents roots plus bundled
   * first-party plugins, with enablement state. */
  listIntegratorSkills(): Promise<IntegratorSkillsOverview>;
  /** Build one complete, disabled specialist from a semantic description.
   * Native discovery supplies the exact Skill and MCP inventory; generated
   * identities are filtered against it before this method returns. */
  generateSpecialist(
    description: string,
    route: ExplainRoute,
    modelCatalogs: SpecialistRuntimeCatalog[],
  ): Promise<SpecialistSetting>;
  /** Clone one GitHub plugin repository (owner/name) into the user's Plugins
   * root via the GitHub CLI. Installed skills start disabled. */
  installIntegratorPlugin(repository: string): Promise<IntegratorSkillsOverview>;
  /** Remove one exact top-level plugin returned by discovery. */
  uninstallIntegratorPlugin(pluginId: string): Promise<IntegratorSkillsOverview>;
  /** Read a curated repository's real skill list from GitHub before install. */
  previewCuratedPlugin(repository: string): Promise<RemoteSkillsPreview>;
  /** Fetch one remote skill's full raw SKILL.md text on demand. */
  previewSkillBody(repository: string, path: string): Promise<RemoteSkillBody>;
  /** Read one local (installed) skill's full raw SKILL.md text. */
  getIntegratorSkillBody(name: string): Promise<IntegratorSkillBody>;
  /** Save or clear a bundled-skill secret in the native OS credential store. */
  setIntegratorSkillCredential(credentialId: string, secret: string): Promise<void>;
  clearIntegratorSkillCredential(credentialId: string): Promise<void>;
  /** MCP servers from the user's MCPs folder plus plugin bundles. */
  listIntegratorMcps(): Promise<IntegratorMcpOverview>;
  /** Write one server file into the user's MCPs folder (form or quick-add). */
  saveIntegratorMcp(name: string, config: IntegratorMcpConfig): Promise<IntegratorMcpOverview>;
  /** Delete one server file from the user's MCPs folder. */
  removeIntegratorMcp(name: string): Promise<IntegratorMcpOverview>;
  /** Copy servers configured in Claude Code / Cursor / Claude Desktop into
   * the MCPs folder. Vendor configs are read, never written. */
  importIntegratorMcps(): Promise<IntegratorMcpImportResult>;
  /** Store or clear a server's keychain-backed env secret. */
  setIntegratorMcpCredential(server: string, key: string, secret: string): Promise<void>;
  clearIntegratorMcpCredential(server: string, key: string): Promise<void>;
  /** Complete or revoke browser OAuth for one discovered remote MCP server.
   * Tokens remain in the native OS credential store. */
  connectIntegratorMcp(server: string): Promise<IntegratorMcpOverview>;
  disconnectIntegratorMcp(server: string): Promise<IntegratorMcpOverview>;
}

/** One MCP server visible to the Integrator plane. `transport` is "stdio"
 * (command + args + env) or "remote" (url). Servers always start disabled —
 * enabling a process is an explicit act. */
export interface IntegratorMcpServer {
  name: string;
  /** "user" (MCPs folder) | "plugin" (installed) | "first-party" (bundled). */
  source: string;
  /** Display origin: plugin folder name, or "MCPs folder". */
  origin: string;
  enabled: boolean;
  /** Native credential slots (env values set to "{{keychain}}"). */
  credentials?: Array<{
    key: string;
    configured: boolean;
    available: boolean;
    storage: "protectedLocalFile" | "osCredentialStore";
  }>;
  /** Native-only OAuth state for remote HTTP servers. */
  authorization?: {
    state: "connected" | "notConnected" | "needsAttention";
    available: boolean;
  };
  /** True only when this remote server is configured for browser OAuth. */
  oauth?: boolean;
  transport: "stdio" | "remote";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

/** Form/quick-add shape accepted by saveIntegratorMcp. */
export interface IntegratorMcpConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  auth?: "oauth";
}

export interface IntegratorMcpOverview {
  mcpsRoot: string;
  servers: IntegratorMcpServer[];
}

export interface IntegratorMcpImportResult {
  imported: string[];
  skipped: string[];
  overview: IntegratorMcpOverview;
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
  kind: "code" | "chat";
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
  provider: "codex" | "claude" | "antigravity" | "cursor" | "grok" | "kimi" | "custom-acp";
  installed: boolean;
  executable?: string;
  version?: string;
  authentication: "authenticated" | "loggedOut" | "unavailable" | "unknown" | "needsAttention";
  transport?: "jsonlStdio" | "acpStdio" | "externalApplication";
  diagnosticCode?: string;
  certification?: "certified" | "sessionProbeRequired" | "uncertified";
  capabilities?: RuntimeConnection["capabilities"];
}

interface NativeAcpSessionCapabilities {
  load: boolean;
  resume: boolean;
  mcpHttp: boolean;
  mcpSse: boolean;
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
  providerResumeStates?: NativeProviderResumeState[];
  composerDrafts?: ComposerDraft[];
  queuedMessages?: QueuedMessage[];
  contextReferences?: TaskContextReference[];
  memories?: MemoryEntry[];
}

interface NativeProviderResumeState {
  taskId: string;
  provider: NativeProviderStatus["provider"];
  sessionRef: string;
  repositoryRoot: string;
  permission: StartTaskInput["permission"];
  delegation: StartTaskInput["delegation"];
  updatedAt: string;
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
const nativeTaskKinds = new Map<string, "code" | "chat">();
const repositoryByTaskId = new Map<string, string>();
const repositoryByProjectId = new Map<string, string>();
const nativeProjectById = new Map<string, ProjectSummary>();
const nativeGitByTask = new Map<string, GitSnapshot>();
const codexThreadByTask = new Map<string, string>();
const activeCodexThreads = new Set<string>();
const codexConnectedTasks = new Set<string>();
const codexDelegationByTask = new Map<string, StartTaskInput["delegation"]>();
const codexMemoryEnabledByTask = new Map<string, boolean>();
const providerResumeByTask = new Map<string, NativeProviderResumeState>();
const providerRouteByTask = new Map<
  string,
  Pick<NativeProviderResumeState, "provider" | "permission" | "delegation">
>();
const acpSessionCertification = new Map<RuntimeId, NativeAcpSessionCapabilities>();
let cachedWorkspace: WorkspaceSnapshot | undefined;
let cachedNativeSettings: LocalSetting[] | undefined;
let codexCatalogConnected = false;
let pendingMcpConfiguration: Promise<void> = Promise.resolve();
let memoryEnabled = false;
const MCP_REVISION_SETTING_KEY = "settings.mcp.integrator.revision";

function trackMcpConfiguration<T>(operation: Promise<T>): Promise<T> {
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  pendingMcpConfiguration = Promise.all([pendingMcpConfiguration, settled]).then(() => undefined);
  return operation;
}

/// Placeholder that defers to the provider CLI's own configured model; it is
/// intentionally spaced so the send path never forwards it as a model id.
export const PROVIDER_DEFAULT_MODEL = "Provider default";
const modelCatalogCache = new Map<RuntimeId, ModelCatalogEntry[]>();
const modelCatalogLoads = new Map<RuntimeId, Promise<ModelCatalogEntry[]>>();
const modelCatalogEpochs = new Map<RuntimeId, number>();
const modelCatalogListeners = new Set<() => void>();
const runtimeFingerprints = new Map<RuntimeId, string>();

function emitModelCatalogChange(): void {
  for (const listener of modelCatalogListeners) listener();
}

function cacheModelCatalog(runtime: RuntimeId, catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  if (modelCatalogCache.get(runtime) === catalog) return catalog;
  modelCatalogCache.set(runtime, catalog);
  emitModelCatalogChange();
  return catalog;
}

function invalidateModelCatalog(runtime: RuntimeId): void {
  modelCatalogEpochs.set(runtime, (modelCatalogEpochs.get(runtime) ?? 0) + 1);
  modelCatalogLoads.delete(runtime);
  if (modelCatalogCache.delete(runtime)) emitModelCatalogChange();
}

function runtimeFingerprint(status: NativeProviderStatus): string {
  return JSON.stringify([
    status.executable ?? "",
    status.version ?? "",
    status.authentication,
    status.diagnosticCode ?? "",
    status.certification ?? "",
  ]);
}

function reconcileRuntimeFingerprints(statuses: NativeProviderStatus[]): void {
  for (const status of statuses) {
    const runtime = runtimeId(status.provider);
    const next = runtimeFingerprint(status);
    const previous = runtimeFingerprints.get(runtime);
    if (previous !== undefined && previous !== next) invalidateModelCatalog(runtime);
    runtimeFingerprints.set(runtime, next);
  }
}

/** Cursor only: thought-level session config option id per model id. */
const cursorEffortConfigByModel = new Map<string, string>();
/** Cursor only: the ACP config option id used for model selection. */
let cursorModelConfigId: string | undefined;
const kimiEffortConfigByModel = new Map<string, string>();
let kimiModelConfigId: string | undefined;
const FALLBACK_MODELS: Partial<Record<RuntimeId, string[]>> = {
  // No claude CLI surface lists models; keep this current with Anthropic's
  // published wire ids until live discovery exists for this runtime.
  claude: [
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-haiku-4-5",
  ],
  antigravity: [
    "Gemini 3.1 Pro",
    "Gemini 3.5 Flash",
    "Claude Sonnet 4.6 (Thinking)",
    "Claude Opus 4.6 (Thinking)",
    "GPT-OSS 120B",
  ],
  // Degraded setup fallback only. Prefer the negotiated Cursor ACP
  // `configOptions` catalog (account- and version-specific). Keep base wire
  // ids here — Cursor exposes thought level separately, not as CLI effort
  // suffixes. Refresh against `agent --list-models` when Cursor's top families
  // change; do not mirror every effort/fast variant.
  cursor: [
    "auto",
    "composer-2.5",
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "cursor-grok-4.5",
    "gemini-3.6-flash",
    "kimi-k3",
  ],
  grok: ["grok-4.6", "grok-4.5"],
  // Kimi replaces this with the account's negotiated ACP catalog on first use.
  kimi: ["kimi-code/k3", "kimi-code/kimi-for-coding", "kimi-code/kimi-for-coding-highspeed"],
  custom: [],
};

const CHAT_TITLE_MAX_LENGTH = 54;
export const CHAT_TITLE_PLACEHOLDER = "Coding session";
export const GENERAL_CHAT_TITLE_PLACEHOLDER = "New chat";
export const CHAT_PROJECT_ID = "__integrator_chats__";

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
  return ids.map((id) => ({ id, label: resolveModelLabel(id) }));
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
        catalog.push({ id: entry, label: resolveModelLabel(entry) });
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
    const providerLabel =
      typeof value.displayName === "string" && value.displayName
        ? value.displayName
        : typeof value.name === "string" && value.name
          ? value.name
          : undefined;
    const item: ModelCatalogEntry = {
      id,
      label: resolveModelLabel(id, providerLabel),
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
export function extractAcpCatalog(
  response: unknown,
  runtime: "cursor" | "kimi" = "cursor",
): ModelCatalogEntry[] {
  const options = acpConfigOptions(response);
  const modelOption =
    options.find((option) => option.category === "model") ??
    options.find((option) => option.id === "model" || option.id === "models");
  if (!modelOption || typeof modelOption.id !== "string") return [];
  const modelValues = acpConfigValues(modelOption.options);
  if (modelValues.length === 0) return [];

  if (runtime === "cursor") {
    cursorModelConfigId = modelOption.id;
    cursorEffortConfigByModel.clear();
  } else {
    kimiModelConfigId = modelOption.id;
    kimiEffortConfigByModel.clear();
  }
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
      label: resolveModelLabel(model.value, model.name),
    };
    if (thoughtOption && typeof thoughtOption.id === "string") {
      const effortConfigs =
        runtime === "cursor" ? cursorEffortConfigByModel : kimiEffortConfigByModel;
      effortConfigs.set(item.id, thoughtOption.id);
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

function extractCursorExtensionCatalog(response: unknown): ModelCatalogEntry[] {
  if (!response || typeof response !== "object") return [];
  const models = (response as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const catalog: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const entry = model as { value?: unknown; name?: unknown };
    if (typeof entry.value !== "string" || !entry.value || seen.has(entry.value)) continue;
    seen.add(entry.value);
    catalog.push({
      id: entry.value,
      label: resolveModelLabel(
        entry.value,
        typeof entry.name === "string" && entry.name ? entry.name : undefined,
      ),
    });
  }
  return catalog;
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

/** True for a secondary window opened via "Open in new window": it mirrors a
 * pinned chat rather than owning the shared nav restore point, so it must
 * not overwrite localStorage with whatever it happens to be showing. */
function isDeepLinkedWindow(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).has("taskId");
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
    const current = createDemoSnapshot();
    const storedRuntimes = new Map(parsed.runtimes.map((runtime) => [runtime.id, runtime]));
    const currentRuntimeIds = new Set(current.runtimes.map((runtime) => runtime.id));
    const runtimes = [
      ...current.runtimes.map((runtime) => ({
        ...runtime,
        ...storedRuntimes.get(runtime.id),
      })),
      ...parsed.runtimes.filter((runtime) => !currentRuntimeIds.has(runtime.id)),
    ];
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
      runtimes,
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

/** The inverse of `runtimeId`: the renderer says `custom`, the native
 * `ProviderKind` spells that variant `custom-acp`. */
function wireProvider(runtime: RuntimeId): NativeProviderStatus["provider"] {
  return runtime === "custom" ? "custom-acp" : runtime;
}

function mapRuntime(status: NativeProviderStatus): RuntimeConnection {
  const id = runtimeId(status.provider);
  const acpSession = acpSessionCertification.get(id);
  const acpProbeEligible = status.certification === "sessionProbeRequired";
  const names: Record<RuntimeId, string> = {
    codex: "Codex",
    cursor: "Cursor",
    claude: "Claude Code",
    grok: "Grok Build",
    kimi: "Kimi Code",
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
      status.provider === "grok"
        ? "grok agent --no-leader --always-approve stdio"
        : status.provider === "kimi"
          ? "kimi acp"
          : (status.executable ?? status.provider),
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
    certification:
      acpSession && acpProbeEligible
        ? acpSession.load
          ? "certified"
          : "uncertified"
        : status.certification === "sessionProbeRequired"
          ? "session_probe_required"
          : (status.certification ?? "uncertified"),
    capabilities: status.capabilities
      ? {
          ...status.capabilities,
          sessionResume: acpSession
            ? acpSession.load || acpSession.resume
            : status.capabilities.sessionResume,
          authoritativeHistory: acpSession?.load ?? status.capabilities.authoritativeHistory,
        }
      : undefined,
    detail: updateRequired
      ? "This CLI is authenticated but older than Integrator's certified protocol floor."
      : status.diagnosticCode === "capability-mismatch"
        ? "This installed CLI is missing a capability required by Integrator's certified route."
        : status.diagnosticCode === "capability-probe-failed"
          ? "Integrator could not verify this CLI's installed capabilities."
          : acpSession?.load && acpProbeEligible
            ? "Installed CLI and ACP session recovery verified."
            : acpSession && acpProbeEligible
              ? "ACP connected, but session/load is unavailable; interrupted history cannot be reconciled authoritatively."
              : status.certification === "sessionProbeRequired" && connected
                ? "Installed CLI verified; session capabilities are checked during the ACP handshake."
                : (status.diagnosticCode ??
                  (connected ? "Authenticated local CLI" : "Status unavailable")),
  };
}

function mapNativeTaskSummary(
  task: NativeTask,
  projectId: string,
  runtimeFallback: RuntimeId = "codex",
): TaskSummary {
  nativeTaskIds.set(task.id, task.id);
  nativeTaskKinds.set(task.id, task.kind);
  const reviewRoot = task.worktreePath ?? task.repositoryPath;
  if (reviewRoot) repositoryByTaskId.set(task.id, reviewRoot);
  return {
    id: task.id,
    projectId,
    kind: task.kind,
    title: task.title,
    status: mapTaskStatus(task.state),
    runtime: mapStoredRuntime(task.runtime) ?? runtimeFallback,
    model: task.model?.trim() || PROVIDER_DEFAULT_MODEL,
    effort: task.effort?.trim() || undefined,
    updatedAt: task.updatedAt,
    worktree: task.worktreePath,
    pinned: task.pinned,
    archived: task.archived,
    parentId: task.parentTaskId,
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
    value === "kimi" ||
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
  nativeTaskKinds.clear();
  repositoryByProjectId.clear();
  const projects: ProjectSummary[] = (local.projects ?? []).map(mapProject);
  const projectByPath = new Map(projects.map((project) => [project.path, project]));
  const runtimeByTask = new Map<string, RuntimeId>();
  codexThreadByTask.clear();
  activeCodexThreads.clear();
  codexDelegationByTask.clear();
  codexMemoryEnabledByTask.clear();
  providerResumeByTask.clear();
  providerRouteByTask.clear();
  memoryEnabled =
    (local.settings ?? []).find((setting) => setting.key === "settings.memory.enabled")?.value ===
    true;
  const mcpRevisionAt = (local.settings ?? []).find(
    (setting) => setting.key === MCP_REVISION_SETTING_KEY,
  )?.updatedAt;
  for (const resume of local.providerResumeStates ?? []) {
    providerRouteByTask.set(resume.taskId, resume);
    // Codex keeps the MCP surface it started with for the life of a thread.
    // A newer MCP revision is therefore pending for that conversation, not a
    // reason to discard its provider history. ACP sessions instead receive
    // their MCP configuration on resume, so they remain revision-bound.
    const isCurrent =
      resume.provider === "codex" ||
      !mcpRevisionAt ||
      Date.parse(resume.updatedAt) >= Date.parse(mcpRevisionAt);
    if (isCurrent) providerResumeByTask.set(resume.taskId, resume);
    if (isCurrent && resume.provider === "codex") {
      codexDelegationByTask.set(resume.taskId, resume.delegation);
    }
  }
  for (const session of local.providerSessions) {
    const mapped = mapStoredRuntime(session.provider);
    if (mapped) runtimeByTask.set(session.taskId, mapped);
  }
  const tasks = local.tasks.map((task) => {
    if (task.kind === "chat") {
      return mapNativeTaskSummary(task, CHAT_PROJECT_ID, runtimeByTask.get(task.id) ?? "codex");
    }
    const projectPath = task.repositoryPath ?? "Local workspace";
    let project = projectByPath.get(projectPath);
    if (!project) {
      project = projectForPath({ ...snapshot, projects }, task.repositoryPath);
      projects.push(project);
      projectByPath.set(projectPath, project);
    }
    // A writing task is reviewed in its assigned worktree, not the base
    // checkout. Project identity still derives from repositoryPath above.
    return mapNativeTaskSummary(task, project.id, runtimeByTask.get(task.id) ?? ("codex" as const));
  });
  const lastTaskByProject: Record<string, string> = {};
  for (const task of tasks) {
    if (task.kind === "code") lastTaskByProject[task.projectId] ??= task.id;
  }
  const kindByTaskId = new Map(local.tasks.map((task) => [task.id, task.kind]));
  for (const session of local.providerSessions) {
    const resume = providerResumeByTask.get(session.taskId);
    if (
      session.provider === "codex" &&
      resume?.provider === "codex" &&
      resume.sessionRef === session.providerThreadId &&
      kindByTaskId.get(session.taskId) !== "chat"
    ) {
      codexThreadByTask.set(session.taskId, session.providerThreadId);
    }
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
  if (nativeTaskKinds.get(taskId) === "chat") return "";
  const knownRepository = repositoryByTaskId.get(taskId);
  if (knownRepository) return knownRepository;
  const snapshot = cachedWorkspace ?? readDemoSnapshot();
  const task = snapshot.tasks.find((item) => item.id === taskId);
  if (task?.kind === "chat") return "";
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
      kind: task.kind,
      title: task.title,
      repositoryPath: task.kind === "chat" ? undefined : repositoryPath,
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

function extractSessionId(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const id = (response as { sessionId?: unknown }).sessionId;
  return typeof id === "string" ? id : undefined;
}

const cursorSessionByTask = new Set<string>();
const cursorDelegationByTask = new Map<string, StartTaskInput["delegation"]>();
/** The model and effort last applied to each Cursor session, to skip redundant protocol calls. */
const cursorAppliedSelection = new Map<string, { model?: string; effort?: string }>();
const cursorConnectedTasks = new Set<string>();
type AcpRuntimeId = "cursor" | "grok" | "kimi";
type StandardAcpRuntimeId = Exclude<AcpRuntimeId, "cursor">;
interface StandardAcpState {
  sessions: Set<string>;
  delegations: Map<string, StartTaskInput["delegation"]>;
  selections: Map<string, { model?: string; effort?: string }>;
  connections: Set<string>;
  queue: Promise<void>;
}
const activeAcpProviderByTask = new Map<string, AcpRuntimeId>();
let cursorCatalogConnected = false;
const createStandardAcpState = (): StandardAcpState => ({
  sessions: new Set(),
  delegations: new Map(),
  selections: new Map(),
  connections: new Set(),
  queue: Promise.resolve(),
});
const standardAcpState: Record<StandardAcpRuntimeId, StandardAcpState> = {
  grok: createStandardAcpState(),
  kimi: createStandardAcpState(),
};
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
  invalidateModelCatalog("cursor");
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

function resetStandardAcpConnectionState(runtime: StandardAcpRuntimeId, taskId?: string): void {
  const state = standardAcpState[runtime];
  if (taskId) {
    state.connections.delete(taskId);
    state.sessions.delete(taskId);
    state.delegations.delete(taskId);
    state.selections.delete(taskId);
    if (activeAcpProviderByTask.get(taskId) === runtime) activeAcpProviderByTask.delete(taskId);
    return;
  }
  state.connections.clear();
  state.sessions.clear();
  state.delegations.clear();
  state.selections.clear();
  for (const [task, provider] of activeAcpProviderByTask) {
    if (provider === runtime) activeAcpProviderByTask.delete(task);
  }
  if (runtime === "kimi") {
    kimiModelConfigId = undefined;
    kimiEffortConfigByModel.clear();
    invalidateModelCatalog("kimi");
  }
}

function invalidateMcpSessionCaches(): void {
  // Codex cannot swap its MCP configuration in place. Keep its current
  // threads on their existing, known-good tool surface; the next new Codex
  // chat gets the revised configuration. Clearing these bindings here used
  // to turn an unrelated settings change into a fresh provider conversation.
  for (const [taskId, resume] of providerResumeByTask) {
    if (resume.provider !== "codex") providerResumeByTask.delete(taskId);
  }
  resetCursorConnectionState();
  resetStandardAcpConnectionState("grok");
  resetStandardAcpConnectionState("kimi");
}

function updateCursorCatalog(response: unknown): ModelCatalogEntry[] {
  const catalog = extractAcpCatalog(response);
  mergeCursorModelParams(catalog, cursorModelParams);
  if (catalog.length > 0) {
    cacheModelCatalog("cursor", catalog);
  }
  return catalog;
}

function updateKimiCatalog(response: unknown): ModelCatalogEntry[] {
  const catalog = extractAcpCatalog(response, "kimi");
  if (catalog.length > 0) cacheModelCatalog("kimi", catalog);
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
    const catalog = extractCursorExtensionCatalog(response);
    mergeCursorModelParams(catalog, params);
    if (catalog.length > 0) cacheModelCatalog("cursor", catalog);
  } catch {
    // Older cursor-agent builds without the extension RPC.
  }
}

async function certifyAcpSession(taskId: string, runtime: AcpRuntimeId): Promise<void> {
  try {
    const capabilities = await nativeInvoke<NativeAcpSessionCapabilities>(
      "acp_session_capabilities",
      { taskId },
    );
    acpSessionCertification.set(runtime, capabilities);
  } catch {
    acpSessionCertification.delete(runtime);
  }
}

async function ensureCursorSessionForTaskUnlocked(
  taskId: string,
  delegation?: StartTaskInput["delegation"],
  permission?: StartTaskInput["permission"],
): Promise<string> {
  const nativeTaskId = await ensureNativeTask(taskId);
  const cwd = repositoryForTask(taskId);
  const delegationMode = delegation ?? "off";
  try {
    await ensureCursorConnectionUnlocked(nativeTaskId, cwd);
    if (
      !cursorSessionByTask.has(nativeTaskId) ||
      cursorDelegationByTask.get(nativeTaskId) !== delegationMode
    ) {
      const saved = providerResumeByTask.get(nativeTaskId);
      const resumable =
        saved?.provider === "cursor" &&
        saved.repositoryRoot === cwd &&
        saved.delegation === delegationMode;
      const startSession = () =>
        nativeInvoke<unknown>("acp_start_session", {
          taskId: nativeTaskId,
          cwd,
          delegation: delegationMode,
          permission,
        });
      let session: unknown;
      if (resumable) {
        try {
          session = await nativeInvoke<unknown>("acp_resume_session", {
            taskId: nativeTaskId,
            cwd,
          });
        } catch (error) {
          if (!isStaleProviderResumeError(error)) throw error;
          providerResumeByTask.delete(nativeTaskId);
          session = await startSession();
        }
      } else {
        session = await startSession();
      }
      const sessionId = extractSessionId(session);
      if (sessionId) {
        providerResumeByTask.set(nativeTaskId, {
          taskId: nativeTaskId,
          provider: "cursor",
          sessionRef: sessionId,
          repositoryRoot: cwd,
          permission: permission ?? "project-write",
          delegation: delegationMode,
          updatedAt: new Date().toISOString(),
        });
      }
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

async function ensureCursorConnectionUnlocked(nativeTaskId: string, cwd: string): Promise<void> {
  if (
    cursorConnectedTasks.has(nativeTaskId) &&
    activeAcpProviderByTask.get(nativeTaskId) === "cursor"
  ) {
    return;
  }
  await nativeInvoke("acp_connect", {
    provider: "cursor",
    workingDirectory: cwd,
    taskId: nativeTaskId,
  });
  await certifyAcpSession(nativeTaskId, "cursor");
  resetStandardAcpConnectionState("grok", nativeTaskId);
  resetStandardAcpConnectionState("kimi", nativeTaskId);
  cursorConnectedTasks.add(nativeTaskId);
  activeAcpProviderByTask.set(nativeTaskId, "cursor");
  clearCursorSessionCaches(nativeTaskId);
}

async function ensureCursorSessionForTask(
  taskId: string,
  delegation?: StartTaskInput["delegation"],
  permission?: StartTaskInput["permission"],
): Promise<string> {
  const operation = cursorSessionQueue.then(() =>
    ensureCursorSessionForTaskUnlocked(taskId, delegation, permission),
  );
  cursorSessionQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

async function ensureCursorSession(input: SendTurnInput): Promise<string> {
  return ensureCursorSessionForTask(input.taskId, input.delegation, input.permission);
}

async function ensureStandardAcpSessionUnlocked(
  input: SendTurnInput,
  runtime: StandardAcpRuntimeId,
): Promise<string> {
  const nativeTaskId = await ensureNativeTask(input.taskId);
  const cwd = repositoryForTask(input.taskId);
  const state = standardAcpState[runtime];
  const launchSelection =
    runtime === "grok" ? { model: realModelId(input.model), effort: input.effort } : undefined;
  const appliedSelection = state.selections.get(nativeTaskId);
  const routingChanged = Boolean(
    launchSelection &&
    state.connections.has(nativeTaskId) &&
    (appliedSelection?.model !== launchSelection.model ||
      appliedSelection?.effort !== launchSelection.effort),
  );
  if (
    !state.connections.has(nativeTaskId) ||
    activeAcpProviderByTask.get(nativeTaskId) !== runtime ||
    routingChanged
  ) {
    await nativeInvoke("acp_connect", {
      provider: runtime,
      workingDirectory: cwd,
      taskId: nativeTaskId,
      ...(launchSelection ?? {}),
    });
    await certifyAcpSession(nativeTaskId, runtime);
    resetCursorConnectionState(nativeTaskId);
    for (const candidate of ["grok", "kimi"] as const) {
      if (candidate !== runtime) resetStandardAcpConnectionState(candidate, nativeTaskId);
    }
    state.connections.add(nativeTaskId);
    activeAcpProviderByTask.set(nativeTaskId, runtime);
    state.sessions.delete(nativeTaskId);
    if (launchSelection) state.selections.set(nativeTaskId, launchSelection);
  }
  if (
    !state.sessions.has(nativeTaskId) ||
    state.delegations.get(nativeTaskId) !== input.delegation
  ) {
    const saved = providerResumeByTask.get(nativeTaskId);
    const resumable =
      saved?.provider === runtime &&
      saved.repositoryRoot === cwd &&
      saved.delegation === input.delegation;
    const startSession = () =>
      nativeInvoke<unknown>("acp_start_session", {
        taskId: nativeTaskId,
        cwd,
        delegation: input.delegation,
        permission: input.permission,
      });
    let session: unknown;
    if (resumable) {
      try {
        session = await nativeInvoke<unknown>("acp_resume_session", {
          taskId: nativeTaskId,
          cwd,
        });
      } catch (error) {
        if (!isStaleProviderResumeError(error)) throw error;
        providerResumeByTask.delete(nativeTaskId);
        session = await startSession();
      }
    } else {
      session = await startSession();
    }
    const sessionId = extractSessionId(session);
    if (sessionId) {
      providerResumeByTask.set(nativeTaskId, {
        taskId: nativeTaskId,
        provider: runtime,
        sessionRef: sessionId,
        repositoryRoot: cwd,
        permission: input.permission,
        delegation: input.delegation,
        updatedAt: new Date().toISOString(),
      });
    }
    state.sessions.add(nativeTaskId);
    state.delegations.set(nativeTaskId, input.delegation);
    if (launchSelection) state.selections.set(nativeTaskId, launchSelection);
    else state.selections.delete(nativeTaskId);
    if (runtime === "kimi") updateKimiCatalog(session);
  }
  return nativeTaskId;
}

async function ensureStandardAcpSession(
  input: SendTurnInput,
  runtime: StandardAcpRuntimeId,
): Promise<string> {
  const state = standardAcpState[runtime];
  const operation = state.queue.then(() => ensureStandardAcpSessionUnlocked(input, runtime));
  state.queue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
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

async function applyKimiSelection(nativeTaskId: string, input: SendTurnInput): Promise<void> {
  const state = standardAcpState.kimi;
  const applied = state.selections.get(nativeTaskId) ?? {};
  const model = realModelId(input.model);
  if (model && applied.model !== model) {
    if (!kimiModelConfigId) {
      throw new Error("Kimi Code did not advertise an ACP model selector for this session");
    }
    try {
      const response = await nativeInvoke<unknown>("acp_set_config_option", {
        taskId: nativeTaskId,
        configId: kimiModelConfigId,
        value: model,
      });
      updateKimiCatalog(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Kimi Code could not switch to model "${model}": ${message}`);
    }
    applied.model = model;
    applied.effort = undefined;
  }
  const configId = model ? kimiEffortConfigByModel.get(model) : undefined;
  if (input.effort && configId && applied.effort !== input.effort) {
    try {
      const response = await nativeInvoke<unknown>("acp_set_config_option", {
        taskId: nativeTaskId,
        configId,
        value: input.effort,
      });
      updateKimiCatalog(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Kimi Code could not set Thinking to "${input.effort}": ${message}`);
    }
    applied.effort = input.effort;
  }
  state.selections.set(nativeTaskId, applied);
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
 * Degraded fallback only: a successfully probed `agy models` catalog replaces
 * this list with live effort-suffixed slugs (`gemini-3.6-flash-high`), split
 * into base model + effort by antigravityCatalog(). These static ids are the
 * display names agy also accepts; the native adapter composes the selected
 * effort back into the `--model` value in either form.
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
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
    defaultEffort: "medium",
  },
  // Third-party models agy proxies. "(Thinking)" is part of the literal model
  // name in agy's registry, not a reasoning level, so those ids carry the
  // suffix verbatim and expose no effort picker.
  {
    id: "Claude Sonnet 4.6 (Thinking)",
    label: "Claude Sonnet 4.6 (Thinking)",
  },
  {
    id: "Claude Opus 4.6 (Thinking)",
    label: "Claude Opus 4.6 (Thinking)",
  },
  {
    id: "GPT-OSS 120B",
    label: "GPT-OSS 120B",
    efforts: [{ id: "medium", label: "Medium" }],
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

/** Documented Grok 4.x effort menus. Unknown slugs stay picker-less until ACP
 * advertises a menu. Do not attach `xhigh` to 4.5 — the API coerces it to high. */
const GROK_4_5_EFFORTS: ModelEffortOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];
const GROK_4_6_EFFORTS: ModelEffortOption[] = [
  ...GROK_4_5_EFFORTS,
  { id: "xhigh", label: "Extra high" },
];
const GROK_DOCUMENTED_EFFORTS: Record<
  string,
  { efforts: ModelEffortOption[]; defaultEffort: string }
> = {
  "grok-4.6": { efforts: GROK_4_6_EFFORTS, defaultEffort: "high" },
  "grok-4.5": { efforts: GROK_4_5_EFFORTS, defaultEffort: "high" },
};

const AGY_EFFORT_ORDER = ["low", "medium", "high"] as const;

/**
 * Groups live `agy models` slugs (`gemini-3.6-flash-high`) into base-model
 * entries with an effort picker. Ids without a trailing effort level
 * (`claude-opus-4-6-thinking`) pass through as plain entries. The default
 * effort prefers medium, then high, matching agy's own picker defaults.
 */
function antigravityCatalog(ids: string[]): ModelCatalogEntry[] {
  const effortsByBase = new Map<string, Set<string>>();
  const order: { base: string; leveled: boolean }[] = [];
  for (const id of ids) {
    const match = /^(.*)-(low|medium|high)$/.exec(id);
    const base = match?.[1] ?? id;
    const leveled = Boolean(match);
    if (!effortsByBase.has(base)) {
      effortsByBase.set(base, new Set());
      order.push({ base, leveled });
    }
    if (match) effortsByBase.get(base)!.add(match[2]!);
  }
  return order.map(({ base, leveled }) => {
    if (!leveled) return { id: base, label: resolveModelLabel(base) };
    const observed = effortsByBase.get(base)!;
    const efforts = AGY_EFFORT_ORDER.filter((level) => observed.has(level));
    return {
      id: base,
      label: resolveModelLabel(base),
      efforts: efforts.map((level) => ({ id: level, label: effortLabel(level) })),
      defaultEffort: observed.has("medium") ? "medium" : (efforts.at(-1) ?? "high"),
    };
  });
}

/** One sanitized entry from the native `claude_list_models` probe. */
type ClaudeModelInfo = { id: string; label: string; efforts: string[] };

/** The CLI appends context/mode notes ("Opus (1M context)") to its picker
 *  names; the picker shows the model, not its context window. */
const CLAUDE_LABEL_SUFFIX = /\s(\(.+\))\s*$/;

/**
 * Claude Code's `list_models` control response reports per-model effort
 * support, so live entries only get the picker where the CLI would honor
 * `--effort`.
 *
 * Labels come from our id-derived formatter, not the CLI's terse `/model`
 * names ("Opus", "Sonnet"), which drop the version number. The CLI's
 * parenthetical is dropped as noise unless two entries would otherwise carry
 * the identical label — e.g. `claude-opus-5` beside `claude-opus-5[1m]`.
 */
function claudeCatalog(models: ClaudeModelInfo[]): ModelCatalogEntry[] {
  const base = models.map(({ id, label }) => prettyModelLabel(id) || label || id);
  const ambiguous = new Set(base.filter((label, index) => base.indexOf(label) !== index));
  return models.map(({ id, label, efforts }, index) => {
    const plain = base[index]!;
    const suffix = ambiguous.has(plain) ? label.match(CLAUDE_LABEL_SUFFIX)?.[1] : undefined;
    const resolved = suffix && !plain.includes(suffix) ? `${plain} ${suffix}` : plain;
    if (efforts.length === 0) return { id, label: resolved };
    return {
      id,
      label: resolved,
      efforts: efforts.map((level) => ({ id: level, label: effortLabel(level) })),
      defaultEffort: efforts.includes(CLAUDE_DEFAULT_EFFORT)
        ? CLAUDE_DEFAULT_EFFORT
        : (efforts.at(-1) ?? CLAUDE_DEFAULT_EFFORT),
    };
  });
}

function grokCatalog(ids: string[]): ModelCatalogEntry[] {
  return ids.map((id) => {
    const documented = GROK_DOCUMENTED_EFFORTS[id];
    return {
      id,
      label: resolveModelLabel(id),
      ...(documented
        ? { efforts: documented.efforts, defaultEffort: documented.defaultEffort }
        : {}),
    };
  });
}

async function discoverModelCatalog(runtime: RuntimeId): Promise<ModelCatalogEntry[]> {
  if (isTauri() && runtime === "claude") {
    try {
      const models = await nativeInvoke<ClaudeModelInfo[]>("claude_list_models");
      const catalog = claudeCatalog(models);
      if (catalog.length > 0) return catalog;
    } catch {
      // Claude Code unavailable or too old to answer `list_models`; fall
      // through to the static catalog.
    }
  }
  if (isTauri() && runtime === "antigravity") {
    try {
      const models = await nativeInvoke<string[]>("antigravity_list_models");
      const catalog = antigravityCatalog(models);
      if (catalog.length > 0) return catalog;
    } catch {
      // agy unavailable or logged out; fall through to the static catalog.
    }
  }
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
      if (catalog.length > 0) return catalog;
    } catch {
      // Codex unavailable right now; fall through to the static catalog.
    }
  }
  if (isTauri() && runtime === "grok") {
    try {
      const models = await nativeInvoke<string[]>("grok_list_models");
      if (models.length > 0) return grokCatalog(models);
    } catch {
      // Grok unavailable or offline; fall through to the documented
      // grok-4.6 / grok-4.5 fallback instead of inventing stale ids.
    }
  }
  if (isTauri() && runtime === "cursor") {
    try {
      const snapshot = cachedWorkspace ?? readDemoSnapshot();
      if (snapshot.activeTaskId) {
        const nativeTaskId = await ensureNativeTask(snapshot.activeTaskId);
        const cwd = repositoryForTask(snapshot.activeTaskId);
        const operation = cursorSessionQueue.then(async () => {
          await ensureCursorConnectionUnlocked(nativeTaskId, cwd);
          await refreshCursorModelParams(nativeTaskId);
        });
        cursorSessionQueue = operation.then(
          () => undefined,
          () => undefined,
        );
        await operation;
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
  if (isTauri() && runtime === "kimi") {
    try {
      const snapshot = cachedWorkspace ?? readDemoSnapshot();
      const activeTask = snapshot.tasks.find((task) => task.id === snapshot.activeTaskId);
      if (activeTask) {
        await ensureStandardAcpSession(
          {
            taskId: activeTask.id,
            prompt: "",
            runtime: "kimi",
            model: activeTask.model,
            effort: activeTask.effort,
            permission: "project-write",
            delegation: "off",
          },
          "kimi",
        );
        const catalog = modelCatalogCache.get("kimi");
        if (catalog?.length) return catalog;
      }
    } catch {
      // Kimi unavailable or logged out; the install/login surfaces remain actionable.
    }
  }
  if (!isTauri()) {
    // The demo snapshot's antigravity ids carry no effort variants; the
    // curated catalog keeps the effort picker visible in browser preview.
    if (runtime === "antigravity") return ANTIGRAVITY_CATALOG;
    const demoModels = readDemoSnapshot().runtimes.find((item) => item.id === runtime)?.models;
    if (demoModels?.length) {
      if (runtime === "grok") return grokCatalog(demoModels);
      return demoModels.map((id) => {
        const label = resolveModelLabel(id);
        if (runtime === "claude") {
          return { id, label, efforts: CLAUDE_EFFORTS, defaultEffort: CLAUDE_DEFAULT_EFFORT };
        }
        return DEMO_EFFORT_RUNTIMES.has(runtime)
          ? { id, label, efforts: DEMO_EFFORTS, defaultEffort: "medium" }
          : { id, label };
      });
    }
  }
  if (runtime === "claude") {
    return (FALLBACK_MODELS.claude ?? []).map((id) => ({
      id,
      label: resolveModelLabel(id),
      efforts: CLAUDE_EFFORTS,
      defaultEffort: CLAUDE_DEFAULT_EFFORT,
    }));
  }
  if (runtime === "grok") return grokCatalog(FALLBACK_MODELS.grok ?? []);
  if (runtime === "antigravity") return ANTIGRAVITY_CATALOG;
  return toCatalogEntries(FALLBACK_MODELS[runtime] ?? []);
}

/**
 * Runtimes whose catalog comes from a standalone CLI probe, so it can be
 * warmed before the user opens a picker. Cursor and Kimi are excluded on
 * purpose: their catalogs are negotiated inside a task-bound ACP session, so
 * probing them early would either spawn a session the user never asked for or
 * cache the degraded static list when no task is active.
 */
const PREFETCHABLE_RUNTIMES: readonly RuntimeId[] = ["claude", "codex", "grok", "antigravity"];

/**
 * Warm the model catalogs for the connected runtimes so switching runtime in
 * the composer paints from cache instead of waiting on a CLI probe. Probes run
 * one at a time — startup already spawns provider discovery, and nothing here
 * is on a user-visible path.
 */
function prefetchModelCatalogs(runtimes: RuntimeConnection[]): void {
  const pending = runtimes.filter(
    (runtime) =>
      runtime.status === "connected" &&
      PREFETCHABLE_RUNTIMES.includes(runtime.id) &&
      modelCatalogCache.get(runtime.id) === undefined,
  );
  void pending.reduce(
    (queue, runtime) =>
      queue.then(() =>
        loadModelCatalog(runtime.id).then(
          () => undefined,
          () => undefined,
        ),
      ),
    Promise.resolve(),
  );
}

async function loadModelCatalog(runtime: RuntimeId): Promise<ModelCatalogEntry[]> {
  const cached = modelCatalogCache.get(runtime);
  if (cached !== undefined) return cached;
  const pending = modelCatalogLoads.get(runtime);
  if (pending) return pending;

  const epoch = modelCatalogEpochs.get(runtime) ?? 0;
  const request = discoverModelCatalog(runtime)
    .then((catalog) => {
      if ((modelCatalogEpochs.get(runtime) ?? 0) !== epoch) {
        if (modelCatalogLoads.get(runtime) === request) modelCatalogLoads.delete(runtime);
        return loadModelCatalog(runtime);
      }
      return cacheModelCatalog(runtime, catalog);
    })
    .finally(() => {
      if (modelCatalogLoads.get(runtime) === request) modelCatalogLoads.delete(runtime);
    });
  modelCatalogLoads.set(runtime, request);
  return request;
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
    const chatMemoryChanged =
      nativeTaskKinds.get(nativeTaskId) === "chat" &&
      codexMemoryEnabledByTask.get(nativeTaskId) !== memoryEnabled;
    // MCP configuration is fixed when a Codex thread starts. A fresh thread
    // keeps delegation changes truthful, and the task digest carries the
    // conversation across without mutating global Codex settings.
    if (
      chatMemoryChanged ||
      (configuredDelegation !== input.delegation &&
        (configuredDelegation !== undefined || input.delegation !== "off"))
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
    message.includes("no longer the active resumable session") ||
    /(?:thread|rollout).*(?:not found|does not exist|unknown)/i.test(message)
  );
}

function isStaleProviderResumeError(error: unknown): boolean {
  const message = formatBridgeError(error, "").toLowerCase();
  return (
    message.includes("no saved provider session") ||
    message.includes("predates the current mcp configuration") ||
    message.includes("no longer the active resumable session")
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
  codexMemoryEnabledByTask.delete(taskId);
  codexMemoryEnabledByTask.delete(nativeTaskId);
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
  if (nativeTaskKinds.get(nativeTaskId) === "chat") {
    codexMemoryEnabledByTask.set(nativeTaskId, memoryEnabled);
    codexMemoryEnabledByTask.set(input.taskId, memoryEnabled);
  }
  activeCodexThreads.add(threadId);
  const resumeState: NativeProviderResumeState = {
    taskId: nativeTaskId,
    provider: "codex",
    sessionRef: threadId,
    repositoryRoot: cwd,
    permission: input.permission,
    delegation: input.delegation,
    updatedAt: new Date().toISOString(),
  };
  providerResumeByTask.set(nativeTaskId, resumeState);
  providerRouteByTask.set(nativeTaskId, resumeState);
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

  getLogsTotals: async () => {
    if (isTauri()) return nativeInvoke<LogsTotals>("logs_totals");
    return {
      bytes: 0,
      fileCount: 0,
      incidentFiles: 0,
      detailFiles: 0,
      measuredAt: new Date().toISOString(),
      path: "Documents/AI Integrator/Logs",
    };
  },

  openLogsFolder: async () => {
    if (!isTauri()) {
      throw new Error("Opening the logs folder requires the native desktop app.");
    }
    await nativeInvoke("logs_open_folder");
  },

  clearLogs: async () => {
    if (isTauri()) {
      await nativeInvoke("logs_clear");
      return;
    }
  },

  pruneLogs: async () => {
    if (isTauri()) {
      await nativeInvoke("logs_prune");
    }
  },

  reportDiagnostic: async (channel, record) => {
    if (!isTauri()) return;
    try {
      await nativeInvoke("diagnostics_report", { channel, record });
    } catch {
      // Diagnostics must never break the user path.
    }
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
      const update = async () => {
        const setting = await nativeInvoke<LocalSetting>("setting_set", { key, value });
        if (key === "settings.memory.enabled") {
          memoryEnabled = value === true;
          invalidateMcpSessionCaches();
        }
        if (key === "settings.mcp.integrator.enabled") invalidateMcpSessionCaches();
        if (cachedNativeSettings) {
          cachedNativeSettings = [
            setting,
            ...cachedNativeSettings.filter((candidate) => candidate.key !== setting.key),
          ];
        }
        return setting;
      };
      return key === "settings.mcp.integrator.enabled" ? trackMcpConfiguration(update()) : update();
    }
    if (key === "settings.memory.enabled") {
      memoryEnabled = value === true;
      invalidateMcpSessionCaches();
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

  transcribeVoiceClip: async (pcmBase64, sampleRate) => {
    if (!isTauri()) {
      throw new Error("Voice typing is available in the native app only.");
    }
    return nativeInvoke<string>("voice_typing_transcribe", { pcmBase64, sampleRate });
  },

  exportLocalData: async () => {
    if (isTauri()) {
      // Workspace bootstrap export is live-only; stitch archived pages back in
      // so Settings → Export remains a complete local backup.
      const base = await nativeInvoke<NativeExport>("local_export");
      const archived: NativeTask[] = [];
      let cursor: string | undefined;
      do {
        const page = await nativeInvoke<{
          tasks: NativeTask[];
          nextCursor?: string;
          total: number;
        }>("task_list_archived", { cursor, limit: 100 });
        archived.push(...page.tasks);
        cursor = page.nextCursor;
      } while (cursor);
      return { ...base, tasks: [...(base.tasks ?? []), ...archived] };
    }
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
      nativeTaskKinds.clear();
      codexMemoryEnabledByTask.clear();
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
    // Mirror native bootstrap: only live chats ride in the hot workspace set.
    const liveTasks = snapshot.tasks.filter((task) => !task.archived);
    const live: WorkspaceSnapshot = {
      ...snapshot,
      tasks: liveTasks,
      activeTaskId: liveTasks.some((task) => task.id === snapshot.activeTaskId)
        ? snapshot.activeTaskId
        : (liveTasks[0]?.id ?? ""),
      activeProjectId: liveTasks.some((task) => task.id === snapshot.activeTaskId)
        ? snapshot.activeProjectId
        : (liveTasks[0]?.projectId ?? snapshot.activeProjectId),
    };
    const restoreLastWorkspace =
      readBrowserSettings().find((setting) => setting.key === "settings.general.openLastWorkspace")
        ?.value !== false;
    return restoreLastWorkspace ? live : { ...live, activeTaskId: "", activeProjectId: "" };
  },

  listArchivedTasks: async (input = {}) => {
    const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 50) || 50));
    if (isTauri()) {
      const page = await nativeInvoke<{
        tasks: NativeTask[];
        nextCursor?: string;
        total: number;
      }>("task_list_archived", {
        cursor: input.cursor,
        limit,
      });
      const workspace = cachedWorkspace ?? createEmptySnapshot();
      const projectByPath = new Map(workspace.projects.map((project) => [project.path, project]));
      const tasks = page.tasks.map((task) => {
        if (task.kind === "chat") return mapNativeTaskSummary(task, CHAT_PROJECT_ID);
        const projectPath = task.repositoryPath ?? "Local workspace";
        let project = projectByPath.get(projectPath);
        if (!project) {
          project = projectForPath(workspace, task.repositoryPath);
          projectByPath.set(projectPath, project);
          if (cachedWorkspace) {
            cachedWorkspace = {
              ...cachedWorkspace,
              projects: cachedWorkspace.projects.some((item) => item.id === project!.id)
                ? cachedWorkspace.projects
                : [...cachedWorkspace.projects, project],
            };
          }
        }
        return mapNativeTaskSummary(task, project.id);
      });
      return {
        tasks,
        nextCursor: page.nextCursor,
        total: page.total,
      };
    }
    const snapshot = readDemoSnapshot();
    const all = snapshot.tasks
      .filter((task) => task.archived && !task.parentId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    let start = 0;
    if (input.cursor) {
      const index = all.findIndex((task) => `${task.updatedAt}\t${task.id}` === input.cursor);
      start = index >= 0 ? index + 1 : 0;
    }
    const slice = all.slice(start, start + limit);
    const last = slice[slice.length - 1];
    return {
      tasks: slice,
      nextCursor:
        start + slice.length < all.length && last ? `${last.updatedAt}\t${last.id}` : undefined,
      total: all.length,
    };
  },

  searchTaskMessages: async (query, requestedLimit = 30, options) => {
    const limit = Math.min(50, Math.max(1, Math.trunc(requestedLimit) || 30));
    const includeArchived = options?.includeArchived === true;
    if (query.trim().length < 2) return [];
    if (isTauri()) {
      return nativeInvoke<TaskMessageSearchHit[]>("task_search_messages", {
        query,
        limit,
        includeArchived,
      });
    }
    const snapshot = readDemoSnapshot();
    const hits: TaskMessageSearchHit[] = [];
    for (const task of snapshot.tasks) {
      if (!includeArchived && task.archived) continue;
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

  removeProject: async (projectId, options) => {
    const deleteFiles = Boolean(options?.deleteFiles);
    if (isTauri()) {
      const project =
        nativeProjectById.get(projectId) ??
        cachedWorkspace?.projects.find((item) => item.id === projectId);
      if (!project) throw new Error(`Project ${projectId} was not found.`);

      // Older tasks can outlive their trusted-project row. They still hydrate
      // into the sidebar by repository path, but their display-only project ID
      // is not a UUID. The native fallback accepts that exact stored path for
      // Integrator-history deletion only; disk deletion remains UUID-gated.
      const nativeProjectId = nativeProjectById.has(projectId) ? projectId : undefined;
      await nativeInvoke("project_remove", {
        projectId: nativeProjectId,
        repositoryPath: nativeProjectId ? undefined : project.path,
        deleteFiles,
      });
      nativeProjectById.delete(projectId);
      repositoryByProjectId.delete(projectId);
      if (cachedWorkspace) {
        cachedWorkspace = {
          ...cachedWorkspace,
          projects: cachedWorkspace.projects.filter((item) => item.id !== projectId),
          tasks: cachedWorkspace.tasks.filter((task) => task.projectId !== projectId),
        };
      }
      return;
    }
    const snapshot = cachedWorkspace ?? readDemoSnapshot();
    const project = snapshot.projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`Project ${projectId} was not found.`);
    const remainingProjects = snapshot.projects.filter((item) => item.id !== projectId);
    const remainingTasks = snapshot.tasks.filter((task) => task.projectId !== projectId);
    const next: WorkspaceSnapshot = {
      ...snapshot,
      projects: remainingProjects,
      tasks: remainingTasks,
      activeProjectId:
        snapshot.activeProjectId === projectId
          ? (remainingProjects[0]?.id ?? "")
          : snapshot.activeProjectId,
      activeTaskId: snapshot.tasks.some(
        (task) => task.id === snapshot.activeTaskId && task.projectId === projectId,
      )
        ? (remainingTasks.find((task) => task.projectId === remainingProjects[0]?.id)?.id ?? "")
        : snapshot.activeTaskId,
    };
    writeDemoSnapshot(next);
    cachedWorkspace = next;
    void deleteFiles;
  },

  pickContextAttachments: async (chatTaskId) => {
    if (isTauri()) {
      if (chatTaskId) {
        return nativeInvoke<ContextAttachment[] | null>("chat_attachment_pick", { chatTaskId });
      }
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

  savePastedImageAttachment: async (file, fileName, chatTaskId) => {
    const mimeType = file.type || "image/png";
    const extension = mimeType.split("/")[1]?.split("+")[0] || "png";
    const name =
      fileName?.trim() ||
      (file instanceof File && file.name.trim() ? file.name : `pasted-image.${extension}`);
    if (isTauri()) {
      const buffer = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      const chunk = 0x8000;
      for (let index = 0; index < buffer.length; index += chunk) {
        binary += String.fromCharCode(...buffer.subarray(index, index + chunk));
      }
      const saved = await nativeInvoke<{
        path: string;
        name: string;
        kind: "image" | "file";
        dataUrl: string;
      }>("attachment_save_paste", {
        bytesBase64: btoa(binary),
        mimeType,
        chatTaskId,
      });
      return {
        path: saved.path,
        name: saved.name,
        kind: "image",
        dataUrl: saved.dataUrl,
      };
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error("Could not read clipboard image."));
      reader.onerror = () => reject(new Error("Could not read clipboard image."));
      reader.readAsDataURL(file);
    });
    // Browser previews have no durable path; keep a unique synthetic path so
    // repeated pastes of the same clipboard name do not collapse into one chip.
    const path = `pasted://${crypto.randomUUID()}/${name}`;
    return { path, name, kind: "image", dataUrl };
  },

  readAttachmentPreview: async (path) => {
    if (!isTauri()) return null;
    if (attachmentKind(path.split(/[\\/]/).filter(Boolean).at(-1) ?? path) !== "image") return null;
    return nativeInvoke<string | null>("attachment_preview", { path }).catch(() => null);
  },

  probeRuntimes: (options) =>
    invokeOrDemo<NativeProviderStatus[]>(
      "provider_discover",
      { force: options?.force ?? false },
      () => [],
    ).then((statuses) => {
      if (!isTauri()) return readDemoSnapshot().runtimes;
      reconcileRuntimeFingerprints(statuses);
      return statuses.map(mapRuntime);
    }),

  listModels: async (runtime) => (await loadModelCatalog(runtime)).map((entry) => entry.id),

  listModelCatalog: loadModelCatalog,

  getCachedModelCatalog: (runtime) => modelCatalogCache.get(runtime),

  prefetchModelCatalogs,

  prepareAcpRuntime: async (input) => {
    if (!isTauri()) return;
    if (input.runtime !== "grok" && input.runtime !== "kimi") return;
    await ensureStandardAcpSession(
      {
        taskId: input.taskId,
        prompt: "",
        runtime: input.runtime,
        model: input.model || PROVIDER_DEFAULT_MODEL,
        effort: input.effort,
        permission: input.permission ?? (input.runtime === "grok" ? "project-write" : "ask"),
        delegation: input.delegation ?? "off",
      },
      input.runtime,
    );
  },

  refreshModelCatalog: async (runtime) => {
    invalidateModelCatalog(runtime);
    return loadModelCatalog(runtime);
  },

  invalidateModelCatalog,

  subscribeModelCatalogs: (listener) => {
    modelCatalogListeners.add(listener);
    return () => modelCatalogListeners.delete(listener);
  },

  listIntegratorSkills: async () => {
    if (isTauri()) {
      return nativeInvoke<IntegratorSkillsOverview>("integrator_skills_overview");
    }
    return {
      skillsRoot: "Documents/AI Integrator/Skills",
      pluginsRoot: "Documents/AI Integrator/Plugins",
      bundledAvailable: true,
      skills: [
        {
          name: "integrator-authoring:skill-creator",
          description: "Create a new portable agent skill from a description of a repeated task",
          source: "first-party",
          enabled: true,
          defaultEnabled: true,
          invocationCount: 3,
        },
        {
          name: "gov-data:fred",
          description: "Fetch US economic time series from FRED",
          source: "first-party",
          enabled: false,
          defaultEnabled: false,
          invocationCount: 1,
          credential: {
            id: "fred-api-key",
            label: "FRED API key",
            required: true,
            configured: false,
            available: false,
            storage: "osCredentialStore",
            helpUrl: "https://fred.stlouisfed.org/docs/api/api_key.html",
          },
        },
      ],
    };
  },

  generateSpecialist: async (description, route, modelCatalogs) => {
    if (!isTauri()) {
      throw new Error("Specialist creation is available only in the native desktop app");
    }
    return nativeInvoke<SpecialistSetting>("specialist_generate", {
      description,
      route: {
        provider: wireProvider(route.runtime),
        model: route.model ?? null,
        effort: route.effort ?? null,
        fallbacks: route.fallbacks.map(wireProvider),
      },
      modelCatalogs: modelCatalogs.map((catalog) => ({
        runtime: wireProvider(catalog.runtime),
        models: catalog.models,
      })),
    });
  },

  installIntegratorPlugin: async (repository) => {
    if (isTauri()) {
      return nativeInvoke<IntegratorSkillsOverview>("integrator_skills_install", { repository });
    }
    throw new Error("Plugin installs need the desktop app; the browser preview is read-only.");
  },

  uninstallIntegratorPlugin: async (pluginId) => {
    if (isTauri()) {
      return nativeInvoke<IntegratorSkillsOverview>("integrator_skills_uninstall", { pluginId });
    }
    throw new Error("Plugin uninstall needs the desktop app; the browser preview is read-only.");
  },

  previewCuratedPlugin: async (repository) => {
    if (isTauri()) {
      return nativeInvoke<RemoteSkillsPreview>("integrator_skills_preview", { repository });
    }
    throw new Error("Live GitHub previews need the desktop app; the browser preview is read-only.");
  },

  previewSkillBody: async (repository, path) => {
    if (isTauri()) {
      return nativeInvoke<RemoteSkillBody>("integrator_skill_preview_body", { repository, path });
    }
    throw new Error("Live GitHub previews need the desktop app; the browser preview is read-only.");
  },

  getIntegratorSkillBody: async (name) => {
    if (isTauri()) {
      return nativeInvoke<IntegratorSkillBody>("integrator_skill_body", { name });
    }
    throw new Error("Reading skill files needs the desktop app; the browser preview is read-only.");
  },

  setIntegratorSkillCredential: async (credentialId, secret) => {
    if (!isTauri()) {
      throw new Error("Secure skill credentials are available in the native app only.");
    }
    await nativeInvoke("integrator_skill_credential_set", { credentialId, secret });
  },

  clearIntegratorSkillCredential: async (credentialId) => {
    if (!isTauri()) return;
    await nativeInvoke("integrator_skill_credential_clear", { credentialId });
  },

  listIntegratorMcps: async () => {
    if (isTauri()) {
      return nativeInvoke<IntegratorMcpOverview>("integrator_mcp_overview");
    }
    return {
      mcpsRoot: "Documents/AI Integrator/MCPs",
      servers: [
        {
          name: "playwright",
          source: "user",
          origin: "MCPs folder",
          enabled: false,
          transport: "stdio",
          command: "npx",
          args: ["@playwright/mcp@latest"],
          env: {},
        },
        {
          name: "stripe-ai:stripe",
          source: "plugin",
          origin: "stripe-ai",
          enabled: false,
          authorization: { state: "notConnected", available: true },
          oauth: true,
          transport: "remote",
          url: "https://mcp.stripe.com",
        },
      ],
    };
  },

  saveIntegratorMcp: async (name, config) => {
    if (isTauri()) {
      return trackMcpConfiguration(
        (async () => {
          const overview = await nativeInvoke<IntegratorMcpOverview>("integrator_mcp_save", {
            name,
            config,
          });
          invalidateMcpSessionCaches();
          return overview;
        })(),
      );
    }
    throw new Error("MCP configuration needs the desktop app; the browser preview is read-only.");
  },

  removeIntegratorMcp: async (name) => {
    if (isTauri()) {
      return trackMcpConfiguration(
        (async () => {
          const overview = await nativeInvoke<IntegratorMcpOverview>("integrator_mcp_remove", {
            name,
          });
          invalidateMcpSessionCaches();
          return overview;
        })(),
      );
    }
    throw new Error("MCP configuration needs the desktop app; the browser preview is read-only.");
  },

  importIntegratorMcps: async () => {
    if (isTauri()) {
      return trackMcpConfiguration(
        (async () => {
          const result = await nativeInvoke<IntegratorMcpImportResult>("integrator_mcp_import");
          invalidateMcpSessionCaches();
          return result;
        })(),
      );
    }
    throw new Error("MCP import needs the desktop app; the browser preview is read-only.");
  },

  setIntegratorMcpCredential: async (server, key, secret) => {
    if (!isTauri()) {
      throw new Error("Secure MCP credentials are available in the native app only.");
    }
    await trackMcpConfiguration(
      (async () => {
        await nativeInvoke("integrator_mcp_credential_set", { server, key, secret });
        invalidateMcpSessionCaches();
      })(),
    );
  },

  clearIntegratorMcpCredential: async (server, key) => {
    if (!isTauri()) return;
    await trackMcpConfiguration(
      (async () => {
        await nativeInvoke("integrator_mcp_credential_clear", { server, key });
        invalidateMcpSessionCaches();
      })(),
    );
  },

  connectIntegratorMcp: async (server) => {
    if (!isTauri()) {
      throw new Error("MCP browser sign-in is available in the native app only.");
    }
    return trackMcpConfiguration(
      (async () => {
        const overview = await nativeInvoke<IntegratorMcpOverview>("integrator_mcp_oauth_connect", {
          server,
        });
        invalidateMcpSessionCaches();
        return overview;
      })(),
    );
  },

  disconnectIntegratorMcp: async (server) => {
    if (!isTauri()) {
      throw new Error("MCP browser sign-in is available in the native app only.");
    }
    return trackMcpConfiguration(
      (async () => {
        const overview = await nativeInvoke<IntegratorMcpOverview>(
          "integrator_mcp_oauth_disconnect",
          { server },
        );
        invalidateMcpSessionCaches();
        return overview;
      })(),
    );
  },

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
      invalidateModelCatalog(runtime);
      if (runtime !== "codex") {
        const statuses = await nativeInvoke<NativeProviderStatus[]>("provider_discover", {
          force: true,
        });
        reconcileRuntimeFingerprints(statuses);
        const status = statuses.find((item) => runtimeId(item.provider) === runtime);
        if (!status) throw new Error(`${runtime} was not found after status check`);
        return mapRuntime(status);
      }
      const snapshot = cachedWorkspace ?? readDemoSnapshot();
      const active = snapshot.tasks.find((task) => task.id === snapshot.activeTaskId);
      const workingDirectory = active ? repositoryForTask(active.id) : undefined;
      await nativeInvoke("codex_connect", { workingDirectory });
      codexCatalogConnected = true;
      const statuses = await nativeInvoke<NativeProviderStatus[]>("provider_discover", {
        force: true,
      });
      reconcileRuntimeFingerprints(statuses);
      const status = statuses.find((item) => item.provider === "codex");
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
          kind: "code",
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
      nativeTaskKinds.set(task.id, "code");
      repositoryByTaskId.set(task.id, project.path);
      return {
        id: task.id,
        projectId: input.projectId,
        kind: "code",
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
      kind: "code",
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

  createChat: async (input) => {
    if (isTauri()) {
      const task = await nativeInvoke<NativeTask>("task_create", {
        input: {
          kind: "chat",
          title: GENERAL_CHAT_TITLE_PLACEHOLDER,
          repositoryPath: undefined,
          worktreePath: undefined,
          runtime: input.runtime,
          model: input.model,
          effort: input.effort,
        },
      });
      nativeTaskIds.set(task.id, task.id);
      nativeTaskKinds.set(task.id, "chat");
      return mapNativeTaskSummary(task, CHAT_PROJECT_ID, input.runtime);
    }
    return {
      id: `chat-${Date.now()}`,
      projectId: CHAT_PROJECT_ID,
      kind: "chat",
      title: GENERAL_CHAT_TITLE_PLACEHOLDER,
      status: "draft",
      runtime: input.runtime,
      model: input.model,
      effort: input.effort,
      updatedAt: new Date().toISOString(),
    };
  },

  listTaskContextReferences: async (taskId) =>
    isTauri()
      ? nativeInvoke<TaskContextReference[]>("task_context_reference_list", {
          taskId: nativeTaskIds.get(taskId) ?? taskId,
        })
      : [],

  listMemories: async () => (isTauri() ? nativeInvoke<MemoryEntry[]>("memory_list") : []),

  createMemory: async (text) => {
    if (!isTauri()) throw new Error("Memory is available in the desktop app.");
    return nativeInvoke<MemoryEntry>("memory_create", { text });
  },

  updateMemory: async (memoryId, text) => {
    if (!isTauri()) throw new Error("Memory is available in the desktop app.");
    return nativeInvoke<MemoryEntry>("memory_update", { memoryId, text });
  },

  setMemoryEnabled: async (memoryId, enabled) => {
    if (!isTauri()) throw new Error("Memory is available in the desktop app.");
    return nativeInvoke<MemoryEntry>("memory_set_enabled", { memoryId, enabled });
  },

  deleteMemory: async (memoryId) => {
    if (!isTauri()) throw new Error("Memory is available in the desktop app.");
    await nativeInvoke("memory_delete", { memoryId });
  },

  forkTask: async (input) => {
    const snapshot = cachedWorkspace ?? readDemoSnapshot();
    const source = snapshot.tasks.find((item) => item.id === input.taskId);
    if (!source) throw new Error(`Unknown chat: ${input.taskId}`);
    if (isTauri()) {
      const nativeTaskId = await ensureNativeTask(input.taskId);
      const task = await nativeInvoke<NativeTask>("task_fork", {
        taskId: nativeTaskId,
        throughEventId: input.throughEventId,
        title: input.title,
      });
      nativeTaskIds.set(task.id, task.id);
      const repository = repositoryByTaskId.get(input.taskId);
      if (repository) repositoryByTaskId.set(task.id, repository);
      return {
        id: task.id,
        projectId: source.projectId,
        title: task.title,
        status: mapTaskStatus(task.state),
        runtime: mapStoredRuntime(task.runtime) ?? source.runtime,
        model: task.model?.trim() || source.model,
        effort: task.effort?.trim() || source.effort,
        updatedAt: task.updatedAt,
      };
    }
    return {
      ...source,
      id: `task-${Date.now()}`,
      title: input.title,
      status: "draft",
      pinned: false,
      archived: false,
      unread: false,
      updatedAt: new Date().toISOString(),
    };
  },

  truncateTaskFrom: async (input) => {
    const snapshot = cachedWorkspace ?? readDemoSnapshot();
    if (!snapshot.tasks.some((item) => item.id === input.taskId)) {
      throw new Error(`Unknown chat: ${input.taskId}`);
    }
    if (isTauri()) {
      const nativeTaskId = await ensureNativeTask(input.taskId);
      await nativeInvoke<void>("task_truncate_from", {
        taskId: nativeTaskId,
        fromEventId: input.fromEventId,
        saveContext: input.saveContext,
      });
      return;
    }
    // Demo host: drop transcript events at and after the edit point.
    const context = snapshot.taskContexts[input.taskId];
    if (!context) return;
    const cutoff = context.transcript.findIndex((event) => event.id === input.fromEventId);
    if (cutoff < 0) throw new Error(`Unknown message: ${input.fromEventId}`);
    snapshot.taskContexts[input.taskId] = {
      ...context,
      transcript: context.transcript.slice(0, cutoff),
    };
    if (snapshot.activeTaskId === input.taskId) {
      snapshot.transcript = snapshot.taskContexts[input.taskId].transcript;
    }
    cachedWorkspace = snapshot;
    writeDemoSnapshot(snapshot);
  },

  generateTaskTitle: async (input) => {
    if (isTauri()) {
      const nativeTaskId = await ensureNativeTask(input.taskId);
      const route = input.route ?? { runtime: input.runtime, fallbacks: [] };
      const task = await nativeInvoke<NativeTask | null>("task_generate_title", {
        taskId: nativeTaskId,
        route: {
          provider: route.runtime === "custom" ? "custom-acp" : route.runtime,
          model: route.model,
          effort: route.effort,
          fallbacks: route.fallbacks.map((runtime) =>
            runtime === "custom" ? "custom-acp" : runtime,
          ),
        },
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

  removeTask: async (taskId) => {
    if (isTauri()) {
      const nativeTaskId = await ensureNativeTask(taskId);
      await nativeInvoke("task_remove", { taskId: nativeTaskId });
      if (cachedWorkspace) {
        cachedWorkspace = {
          ...cachedWorkspace,
          tasks: cachedWorkspace.tasks.filter((task) => task.id !== taskId),
          composerDrafts: cachedWorkspace.composerDrafts.filter(
            (draft) => draft.owner.kind !== "task" || draft.owner.taskId !== taskId,
          ),
          queuedMessages: cachedWorkspace.queuedMessages.filter(
            (message) => message.taskId !== taskId,
          ),
        };
      }
      return;
    }
    const snapshot = cachedWorkspace ?? readDemoSnapshot();
    const remainingTasks = snapshot.tasks.filter((task) => task.id !== taskId);
    const next: WorkspaceSnapshot = {
      ...snapshot,
      tasks: remainingTasks,
      activeTaskId:
        snapshot.activeTaskId === taskId
          ? (remainingTasks.find(
              (task) =>
                task.projectId ===
                  (snapshot.tasks.find((item) => item.id === taskId)?.projectId ??
                    snapshot.activeProjectId) && !task.archived,
            )?.id ??
            remainingTasks[0]?.id ??
            "")
          : snapshot.activeTaskId,
      composerDrafts: snapshot.composerDrafts.filter(
        (draft) => draft.owner.kind !== "task" || draft.owner.taskId !== taskId,
      ),
      queuedMessages: snapshot.queuedMessages.filter((message) => message.taskId !== taskId),
    };
    writeDemoSnapshot(next);
    cachedWorkspace = next;
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

  subscribeWorkingTreeChanges: async (repository, listener) => {
    if (!isTauri()) return () => undefined;
    const watchId = crypto.randomUUID();
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<{ watchId: string }>("git://working-tree-changed", (event) => {
      if (event.payload.watchId === watchId) listener();
    });
    try {
      await nativeInvoke("repository_watch_start", { watchId, repository });
    } catch (error) {
      unlisten();
      throw error;
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      unlisten();
      void nativeInvoke("repository_watch_stop", { watchId }).catch(() => undefined);
    };
  },

  trackedPaths: async (projectId, paths) => {
    if (paths.length === 0) return [];
    if (isTauri()) {
      return nativeInvoke<string[]>("git_tracked_paths", {
        repository: repositoryForProject(projectId),
        paths,
      });
    }
    // The browser demo has no Git: treat every edited path as tracked so the
    // committed/pushed captions still demonstrate.
    return paths;
  },

  explainSelection: async (projectId, route, config, payload, onDelta) => {
    if (isTauri()) {
      // The listener attaches before the invoke so the first delta cannot
      // race past it, and the request id keeps packets from an abandoned
      // earlier ask out of this panel.
      const requestId = onDelta ? crypto.randomUUID() : null;
      let unlisten: (() => void) | undefined;
      if (requestId && onDelta) {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<{
          requestId: string;
          kind: "attempt" | "delta";
          text: string;
          provider: NativeProviderStatus["provider"];
        }>("selection-explain://event", (event) => {
          if (event.payload.requestId !== requestId) return;
          onDelta({
            kind: event.payload.kind,
            text: event.payload.text,
            runtime: runtimeId(event.payload.provider),
          });
        });
      }
      try {
        const outcome = await nativeInvoke<{
          text: string;
          provider: NativeProviderStatus["provider"];
          usedFallback: boolean;
        }>("selection_explain", {
          repository: repositoryForProject(projectId),
          route: {
            provider: wireProvider(route.runtime),
            model: route.model ?? null,
            effort: route.effort ?? null,
            fallbacks: route.fallbacks.map(wireProvider),
          },
          config: {
            archetype: config.archetype,
            customMission: config.customMission ?? null,
            verbosity: config.verbosity,
            technicality: config.technicality,
          },
          path: payload.path,
          startLine: payload.startLine ?? null,
          endLine: payload.endLine ?? null,
          selection: payload.text,
          fileText: payload.fileText ?? null,
          requestId,
          question: payload.question ?? null,
          history: payload.history ?? [],
        });
        return {
          text: outcome.text,
          runtime: runtimeId(outcome.provider),
          usedFallback: outcome.usedFallback,
        };
      } finally {
        unlisten?.();
      }
    }
    // Browser preview: a canned explanation keeps the flow demonstrable
    // without a provider CLI — streamed in chunks so the panel's live path
    // stays demonstrable too.
    const lines = payload.text.split("\n").length;
    const answer = payload.question
      ? `On “${payload.question.slice(0, 80)}”: in the desktop app the ${config.archetype} agent answers follow-ups with the full conversation in context.`
      : `This selection spans ${lines} line${lines === 1 ? "" : "s"} of ${
          payload.path.split("/").at(-1) ?? payload.path
        }. In the desktop app, your ${config.archetype} agent analyzes the highlighted code here in read-only mode.`;
    if (onDelta) {
      onDelta({ kind: "attempt", text: "", runtime: route.runtime });
      const middle = Math.ceil(answer.length / 2);
      for (const chunk of [answer.slice(0, middle), answer.slice(middle)]) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        onDelta({ kind: "delta", text: chunk, runtime: route.runtime });
      }
    } else {
      await new Promise((resolve) => window.setTimeout(resolve, 600));
    }
    return { text: answer, runtime: route.runtime, usedFallback: false };
  },

  explainPromptPreview: async (config, project) =>
    invokeOrDemo(
      "selection_explain_preview",
      {
        config: { ...config, customMission: config.customMission ?? null },
        project: project ?? null,
      },
      () =>
        `You are the isolated ${config.archetype} agent for the project ${JSON.stringify(
          project ?? "your project",
        )}.\n\nThe desktop app composes the real prompt natively; this browser preview is a stand-in.`,
    ),

  renameProjectFile: async (projectId, path, newName) => {
    if (isTauri()) {
      return nativeInvoke<ProjectFileEntry>("project_file_rename", {
        repository: repositoryForProject(projectId),
        input: { path, newName },
      });
    }
    throw new Error("Renaming project files requires the native desktop app.");
  },

  duplicateProjectFile: async (projectId, path) => {
    if (isTauri()) {
      return nativeInvoke<ProjectFileEntry>("project_file_duplicate", {
        repository: repositoryForProject(projectId),
        input: { path },
      });
    }
    throw new Error("Duplicating project files requires the native desktop app.");
  },

  resolveProjectPath: async (projectId, path) => {
    if (isTauri()) {
      return nativeInvoke<{ absolutePath: string; relativePath: string }>("project_path_resolve", {
        repository: repositoryForProject(projectId),
        input: { path },
      });
    }
    const project = readDemoSnapshot().projects.find((entry) => entry.id === projectId);
    const absolutePath = project ? `${project.path.replace(/[\\/]+$/, "")}/${path}` : path;
    return { absolutePath, relativePath: path };
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

  revealAbsolutePath: async (path) => {
    if (!isTauri()) {
      throw new Error("Revealing folders requires the native desktop app.");
    }
    await nativeInvoke("path_reveal", { path });
  },

  revealTask: async (taskId) => {
    if (!isTauri()) {
      throw new Error("Revealing folders requires the native desktop app.");
    }
    await nativeInvoke("task_reveal", { taskId });
  },

  resolveTaskFolder: async (taskId) => {
    if (!isTauri()) {
      throw new Error("Resolving a chat folder requires the native desktop app.");
    }
    return nativeInvoke<string>("task_working_directory", { taskId });
  },

  openTerminal: async (projectId, dimensions) => {
    if (!isTauri()) {
      throw new Error("The terminal is available in the native desktop app.");
    }
    return nativeInvoke<TerminalSessionInfo>("terminal_open", {
      repository: repositoryForProject(projectId),
      ...dimensions,
    });
  },

  writeTerminal: async (sessionId, data) => {
    if (!isTauri()) {
      throw new Error("The terminal is available in the native desktop app.");
    }
    await nativeInvoke("terminal_write", { sessionId, data });
  },

  resizeTerminal: async (sessionId, dimensions) => {
    if (!isTauri()) return;
    await nativeInvoke("terminal_resize", { sessionId, ...dimensions });
  },

  interruptTerminal: async (sessionId) => {
    if (!isTauri()) return;
    await nativeInvoke("terminal_interrupt", { sessionId });
  },

  terminalHasForegroundProcess: async (sessionId) => {
    if (!isTauri()) return false;
    return nativeInvoke<boolean>("terminal_has_foreground_process", { sessionId });
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
          : kind === "usage"
            ? `${current?.command ?? runtime}`
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
      if (cachedWorkspace) {
        let nextTasks = cachedWorkspace.tasks;
        if (task.archived) {
          nextTasks = cachedWorkspace.tasks.filter((item) => item.id !== taskId);
        } else if (cachedWorkspace.tasks.some((item) => item.id === taskId)) {
          nextTasks = cachedWorkspace.tasks.map((item) =>
            item.id === taskId
              ? {
                  ...item,
                  title: task.title,
                  pinned: task.pinned,
                  archived: false,
                  updatedAt: task.updatedAt,
                }
              : item,
          );
        } else {
          const projectPath = task.repositoryPath ?? "Local workspace";
          const project =
            cachedWorkspace.projects.find((item) => item.path === projectPath) ??
            projectForPath(cachedWorkspace, task.repositoryPath);
          const projects = cachedWorkspace.projects.some((item) => item.id === project.id)
            ? cachedWorkspace.projects
            : [...cachedWorkspace.projects, project];
          cachedWorkspace = { ...cachedWorkspace, projects };
          nextTasks = [mapNativeTaskSummary(task, project.id), ...cachedWorkspace.tasks];
        }
        cachedWorkspace = { ...cachedWorkspace, tasks: nextTasks };
      }
      return {
        taskId,
        title: task.title,
        pinned: task.pinned,
        archived: task.archived,
        updatedAt: task.updatedAt,
      };
    }
    const snapshot = cachedWorkspace ?? readDemoSnapshot();
    const full = readDemoSnapshot();
    const task =
      snapshot.tasks.find((item) => item.id === taskId) ??
      full.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Unknown chat: ${taskId}`);
    const updatedAt = new Date().toISOString();
    const archived = input.archived ?? task.archived ?? false;
    const updated: TaskSummary = {
      ...task,
      title: input.title?.trim() || task.title,
      pinned: input.pinned ?? task.pinned ?? false,
      archived,
      updatedAt,
    };
    const without = full.tasks.filter((item) => item.id !== taskId);
    const nextFull: WorkspaceSnapshot = {
      ...full,
      tasks: archived
        ? [...without, updated]
        : [updated, ...without.filter((item) => item.id !== taskId)],
    };
    writeDemoSnapshot(nextFull);
    if (cachedWorkspace) {
      cachedWorkspace = {
        ...cachedWorkspace,
        tasks: archived
          ? cachedWorkspace.tasks.filter((item) => item.id !== taskId)
          : [updated, ...cachedWorkspace.tasks.filter((item) => item.id !== taskId)],
      };
    }
    return {
      taskId,
      title: updated.title,
      pinned: updated.pinned ?? false,
      archived: updated.archived ?? false,
      updatedAt,
    };
  },

  updateTaskRouting: async (taskId, input) => {
    if (isTauri()) {
      const nativeTaskId = await ensureNativeTask(taskId);
      const existingRoute = (cachedWorkspace ?? readDemoSnapshot()).tasks.find(
        (task) => task.id === taskId,
      );
      if (
        input.runtime === "grok" &&
        (existingRoute?.runtime !== input.runtime ||
          existingRoute.model !== input.model ||
          existingRoute.effort !== input.effort)
      ) {
        resetStandardAcpConnectionState("grok", nativeTaskId);
      }
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

  openTaskWindow: async (taskId) => {
    if (isTauri()) {
      await nativeInvoke("open_task_window", { taskId });
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("taskId", taskId);
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  },

  sendTurn: async (input) => {
    if (isTauri()) {
      await pendingMcpConfiguration;
      const resumeTaskId = nativeTaskIds.get(input.taskId) ?? input.taskId;
      const savedResume = input.resumeInterrupted
        ? providerResumeByTask.get(resumeTaskId)
        : undefined;
      const savedRoute = input.resumeInterrupted
        ? (savedResume ?? providerRouteByTask.get(resumeTaskId))
        : undefined;
      const routedInput: SendTurnInput =
        savedRoute && mapStoredRuntime(savedRoute.provider) === input.runtime
          ? {
              ...input,
              permission: savedRoute.permission,
              delegation: savedRoute.delegation,
            }
          : input;
      const attachments = routedInput.attachments?.map(persistableComposerAttachment);
      const attachmentArgs = attachments?.length ? { attachments } : {};
      if (routedInput.runtime === "codex") {
        const nativeTaskId = await ensureNativeTask(routedInput.taskId);
        let threadId: string | undefined;
        const startTurn = async (targetThreadId: string) =>
          nativeInvoke("codex_start_turn", {
            taskId: nativeTaskId,
            threadId: targetThreadId,
            prompt: routedInput.prompt,
            repository: repositoryForTask(routedInput.taskId),
            nativeActionId: routedInput.nativeActionId,
            delegation: routedInput.delegation,
            contextReferences: routedInput.contextReferences,
            resumeInterrupted: routedInput.resumeInterrupted,
            ...attachmentArgs,
          });
        try {
          threadId = await ensureCodexThread(routedInput);
          try {
            await startTurn(threadId);
          } catch (error) {
            if (!isMissingCodexThreadError(error)) throw error;
            forgetCodexThread(routedInput.taskId, nativeTaskId, threadId);
            threadId = await ensureCodexThread(routedInput);
            await startTurn(threadId);
          }
        } catch (error) {
          if (isCodexConnectionError(error)) {
            codexConnectedTasks.delete(nativeTaskId);
            if (threadId) activeCodexThreads.delete(threadId);
            invalidateModelCatalog("codex");
          }
          throw error;
        }
      } else if (routedInput.runtime === "cursor") {
        try {
          const taskId = await ensureCursorSession(routedInput);
          await applyCursorSelection(taskId, routedInput);
          await nativeInvoke("acp_send_turn", {
            taskId,
            prompt: routedInput.prompt,
            delegation: routedInput.delegation,
            nativeActionId: routedInput.nativeActionId,
            contextReferences: routedInput.contextReferences,
            resumeInterrupted: routedInput.resumeInterrupted,
            ...attachmentArgs,
          });
        } catch (error) {
          resetCursorConnectionState(routedInput.taskId);
          invalidateModelCatalog("cursor");
          throw error;
        }
      } else if (routedInput.runtime === "grok" || routedInput.runtime === "kimi") {
        const runtime = routedInput.runtime;
        try {
          const taskId = await ensureStandardAcpSession(routedInput, runtime);
          if (runtime === "kimi") await applyKimiSelection(taskId, routedInput);
          await nativeInvoke("acp_send_turn", {
            taskId,
            prompt: routedInput.prompt,
            delegation: routedInput.delegation,
            nativeActionId: routedInput.nativeActionId,
            contextReferences: routedInput.contextReferences,
            resumeInterrupted: routedInput.resumeInterrupted,
            ...attachmentArgs,
          });
        } catch (error) {
          resetStandardAcpConnectionState(
            runtime,
            nativeTaskIds.get(routedInput.taskId) ?? routedInput.taskId,
          );
          invalidateModelCatalog(runtime);
          throw error;
        }
      } else if (routedInput.runtime === "claude" || routedInput.runtime === "antigravity") {
        const taskId = await ensureNativeTask(routedInput.taskId);
        await nativeInvoke("structured_cli_start_turn", {
          taskId,
          provider: routedInput.runtime,
          cwd: repositoryForTask(routedInput.taskId),
          model: realModelId(routedInput.model),
          effort: routedInput.effort,
          permission: routedInput.permission,
          prompt: routedInput.prompt,
          delegation: routedInput.delegation,
          nativeActionId: routedInput.nativeActionId,
          contextReferences: routedInput.contextReferences,
          resumeInterrupted: routedInput.resumeInterrupted,
          ...attachmentArgs,
        });
      } else {
        throw new Error(
          `${routedInput.runtime} turn execution is not implemented by the native backend`,
        );
      }
      const routedTaskId = nativeTaskIds.get(routedInput.taskId) ?? routedInput.taskId;
      providerRouteByTask.set(routedTaskId, {
        provider: routedInput.runtime,
        permission: routedInput.permission,
        delegation: routedInput.delegation,
      });
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

  listAutomations: async (taskId) => {
    if (!isTauri()) return [];
    return nativeInvoke<Automation[]>("automation_list", {
      taskId: taskId ? (nativeTaskIds.get(taskId) ?? taskId) : undefined,
    });
  },

  createAutomation: async (input) => {
    if (!isTauri()) throw new Error("Automations require the native app");
    return nativeInvoke<Automation>("automation_create", {
      ...input,
      taskId: nativeTaskIds.get(input.taskId) ?? input.taskId,
    });
  },

  updateAutomation: async (automationId, input) => {
    if (!isTauri()) throw new Error("Automations require the native app");
    return nativeInvoke<Automation>("automation_update", { automationId, ...input });
  },

  listAutomationRuns: async (automationId) => {
    if (!isTauri()) return [];
    return nativeInvoke<AutomationRun[]>("automation_run_list", { automationId });
  },

  automationTimeline: async (taskId) => {
    if (!isTauri()) return [];
    return nativeInvoke<AutomationTimelineEntry[]>("automation_timeline", {
      taskId: nativeTaskIds.get(taskId) ?? taskId,
    });
  },

  pendingAutomationDispatches: async () => {
    if (!isTauri()) return [];
    return nativeInvoke<AutomationDispatch[]>("automation_pending_dispatches");
  },

  setAutomationPaused: async (automationId, paused) => {
    if (!isTauri()) throw new Error("Automations require the native app");
    return nativeInvoke<Automation>("automation_set_paused", { automationId, paused });
  },

  cancelAutomation: async (automationId) => {
    if (!isTauri()) throw new Error("Automations require the native app");
    return nativeInvoke<Automation>("automation_cancel", { automationId });
  },

  runAutomationNow: async (automationId) => {
    if (!isTauri()) throw new Error("Automations require the native app");
    return nativeInvoke<Automation>("automation_run_now", { automationId });
  },

  finishAutomationRun: async (runId, outcome) => {
    if (!isTauri()) throw new Error("Automations require the native app");
    return nativeInvoke<Automation>("automation_finish_run", {
      runId,
      dispatchRef: outcome.dispatchRef,
      error: outcome.error,
    });
  },

  subscribeAutomationDue: async (listener) => {
    if (!isTauri()) return () => undefined;
    const { listen } = await import("@tauri-apps/api/event");
    return listen<AutomationDispatch>("automation://due", (event) => {
      listener(event.payload);
    });
  },

  subscribeAutomationChanges: async (listener) => {
    if (!isTauri()) return () => undefined;
    const { listen } = await import("@tauri-apps/api/event");
    return listen<AutomationChanged>("automation://changed", (event) => {
      listener(event.payload);
    });
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

  loadTaskProjection: async (taskId, options) => {
    if (!isTauri()) {
      return {
        watermarkSeq: 0,
        resetSeq: 0,
        runtimeLive: false,
        cacheMatched: false,
        hydrate: {
          items: [],
          plan: [],
          planTruncated: false,
          approvals: [],
          firstSeen: {},
          hasMoreOlder: false,
        },
      };
    }
    return nativeInvoke<TaskProjectionSnapshot>("task_snapshot", {
      taskId,
      knownWatermark: options?.knownWatermark,
      knownResetSeq: options?.knownResetSeq,
      beforeSeq: options?.beforeSeq,
      limit: options?.limit,
      skipRuntimeCheck: options?.skipRuntimeCheck,
    });
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

  respondToQuestion: async (taskId, approvalId, optionId) => {
    if (!isTauri()) {
      throw new Error("Approvals are only available during a native provider run");
    }
    return nativeInvoke<ApprovalProjection>("acp_respond_question", {
      taskId,
      approvalId,
      optionId,
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

  generateCommitMessage: async (taskId, route) => {
    if (!isTauri()) {
      throw new Error("Commit-message generation is available only in the native desktop app");
    }
    if (!route.model?.trim()) {
      throw new Error("Choose a commit-message model in Git settings.");
    }
    const nativeTaskId = await ensureNativeTask(taskId);
    return nativeInvoke<string>("git_generate_commit_message", {
      taskId: nativeTaskId,
      route: {
        provider: wireProvider(route.runtime),
        model: route.model,
        effort: route.effort ?? null,
        fallbacks: route.fallbacks.map(wireProvider),
      },
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
      if (!isDeepLinkedWindow()) writeStoredNavigation(snapshot);
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
