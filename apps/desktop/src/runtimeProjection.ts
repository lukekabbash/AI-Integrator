import { parseDiffLines } from "./bridge";
import type {
  ApprovalProjection,
  ConnectionProjection,
  DiffFile,
  ItemProjection,
  ModeProjection,
  PlanStepProjection,
  RuntimeProjectionEvent,
  RuntimeUsageProjection,
  TaskProjectionHydrate,
  TaskStatus,
  TranscriptEvent,
  TurnProjection,
} from "./bridge";

export interface TaskActivityUpdate {
  status: TaskStatus;
  updatedAt: string;
  unread?: boolean;
}

export function isFrameBatchableRuntimeProjection(event: RuntimeProjectionEvent): boolean {
  return (
    event.projection.kind === "itemChanged" &&
    event.projection.item.status === "inProgress" &&
    (event.projection.item.kind === "agentMessage" ||
      event.projection.item.kind === "reasoningSummary")
  );
}

/**
 * Projects provider activity into the compact task state used by the sidebar.
 * This deliberately reacts only to lifecycle and attention events: streaming
 * text chunks must not reorder the project tree or create notification noise.
 */
export function taskActivityUpdate(
  event: RuntimeProjectionEvent,
  taskIsActive: boolean,
): TaskActivityUpdate | null {
  const projection = event.projection;
  if (projection.kind === "turnChanged") {
    switch (projection.turn.status) {
      case "pending":
        return { status: "starting", updatedAt: event.occurredAt };
      case "inProgress":
        return { status: "running", updatedAt: event.occurredAt };
      case "completed":
        return { status: "completed", updatedAt: event.occurredAt, unread: !taskIsActive };
      case "failed":
        return { status: "failed", updatedAt: event.occurredAt, unread: !taskIsActive };
      case "interrupted":
        return { status: "stopped", updatedAt: event.occurredAt };
    }
  }
  if (projection.kind === "approvalChanged") {
    return {
      status:
        projection.approval.state === "pending" || projection.approval.state === "responseFailed"
          ? "waiting"
          : "running",
      updatedAt: event.occurredAt,
    };
  }
  if (projection.kind === "turnError") {
    if (projection.retryable) return null;
    return { status: "failed", updatedAt: event.occurredAt, unread: !taskIsActive };
  }
  return null;
}

export interface RuntimeProjectionState {
  taskId: string;
  lastSeq: number;
  /** Projection reset epoch from the last successful hydrate; used with lastSeq for cache if-match. */
  resetSeq: number;
  turn?: TurnProjection;
  items: ItemProjection[];
  plan: PlanStepProjection[];
  planTruncated: boolean;
  diff?: { body: string; truncated: boolean; seq: number; occurredAt: string };
  usage?: RuntimeUsageProjection;
  approvals: ApprovalProjection[];
  /** Session mode state, present only for providers that advertise modes. */
  mode?: ModeProjection;
  connection: ConnectionProjection;
  errors: Array<{ seq: number; message: string; retryable: boolean; occurredAt: string }>;
  /**
   * When each item/approval id was first observed. A streaming item keeps
   * bumping its updatedAt, so the transcript orders by first appearance to
   * keep events where they originally happened.
   */
  firstSeen: Record<string, string>;
  /** True when older item/approval pages remain beyond the loaded window. */
  hasMoreOlder: boolean;
  /** Oldest loaded last_event_seq; cursor for load-older. */
  oldestLoadedSeq?: number;
}

export function createRuntimeProjectionState(taskId: string): RuntimeProjectionState {
  return {
    taskId,
    lastSeq: 0,
    resetSeq: 0,
    items: [],
    plan: [],
    planTruncated: false,
    approvals: [],
    connection: { state: "reconciling", reason: "Loading persisted task state" },
    errors: [],
    firstSeen: {},
    hasMoreOlder: false,
  };
}

/**
 * Build display state from a compact hydrate DTO without replaying event envelopes.
 * Live streaming continues to use applyRuntimeProjection / applyRuntimeProjectionBatch.
 */
export function hydrateRuntimeProjectionState(
  taskId: string,
  hydrate: TaskProjectionHydrate,
  watermarkSeq: number,
  resetSeq: number,
): RuntimeProjectionState {
  const firstSeen: Record<string, string> = {};
  for (const [id, occurredAt] of Object.entries(hydrate.firstSeen ?? {})) {
    firstSeen[id] = typeof occurredAt === "string" ? occurredAt : String(occurredAt);
  }
  return {
    taskId,
    lastSeq: watermarkSeq,
    resetSeq,
    turn: hydrate.turn,
    items: hydrate.items ?? [],
    plan: hydrate.plan ?? [],
    planTruncated: hydrate.planTruncated ?? false,
    diff: hydrate.diff,
    usage: hydrate.usage,
    approvals: hydrate.approvals ?? [],
    mode: hydrate.mode,
    connection: hydrate.connection ?? {
      state: "reconciling",
      reason: "Loading persisted task state",
    },
    errors: hydrate.error
      ? [
          {
            seq: hydrate.error.seq,
            message: hydrate.error.message,
            retryable: hydrate.error.retryable,
            occurredAt: hydrate.error.occurredAt,
          },
        ]
      : [],
    firstSeen,
    hasMoreOlder: hydrate.hasMoreOlder ?? false,
    oldestLoadedSeq: hydrate.beforeSeq,
  };
}

/** Merge an older page into already-loaded state without clobbering live updates. */
export function mergeOlderProjectionHydrate(
  state: RuntimeProjectionState,
  hydrate: TaskProjectionHydrate,
): RuntimeProjectionState {
  const existingItemIds = new Set(state.items.map((item) => item.id));
  const existingApprovalIds = new Set(state.approvals.map((approval) => approval.id));
  const olderItems = (hydrate.items ?? []).filter((item) => !existingItemIds.has(item.id));
  const olderApprovals = (hydrate.approvals ?? []).filter(
    (approval) => !existingApprovalIds.has(approval.id),
  );
  const firstSeen = { ...state.firstSeen };
  for (const [id, occurredAt] of Object.entries(hydrate.firstSeen ?? {})) {
    if (!firstSeen[id]) {
      firstSeen[id] = typeof occurredAt === "string" ? occurredAt : String(occurredAt);
    }
  }
  return {
    ...state,
    items: [...olderItems, ...state.items],
    approvals: [...olderApprovals, ...state.approvals],
    firstSeen,
    hasMoreOlder: hydrate.hasMoreOlder ?? false,
    oldestLoadedSeq: hydrate.beforeSeq ?? state.oldestLoadedSeq,
  };
}

function recordFirstSeen(
  firstSeen: Record<string, string>,
  id: string,
  occurredAt: string,
): Record<string, string> {
  if (firstSeen[id]) return firstSeen;
  return { ...firstSeen, [id]: occurredAt };
}

function replaceById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

export function applyRuntimeProjection(
  state: RuntimeProjectionState,
  event: RuntimeProjectionEvent,
): RuntimeProjectionState {
  if (event.taskId !== state.taskId || event.seq <= state.lastSeq) return state;
  const next = { ...state, lastSeq: event.seq };
  const projection = event.projection;

  switch (projection.kind) {
    case "turnChanged":
      return {
        ...next,
        turn: {
          ...projection.turn,
          // Once the user presses Stop, later interrupted settlements must not
          // clear that intent — auto-resume keys off stopRequested.
          stopRequested:
            projection.turn.stopRequested ||
            (state.turn?.id === projection.turn.id && Boolean(state.turn.stopRequested)),
        },
        // A freshly started turn is a new attempt; stale errors from prior
        // attempts should not keep stacking at the bottom of the transcript.
        errors:
          projection.turn.status === "inProgress" && projection.turn.id !== state.turn?.id
            ? []
            : state.errors,
      };
    case "itemChanged":
      return {
        ...next,
        items: replaceById(state.items, projection.item),
        firstSeen: recordFirstSeen(state.firstSeen, projection.item.id, event.occurredAt),
      };
    case "planChanged":
      return { ...next, plan: projection.steps, planTruncated: projection.truncated };
    case "diffChanged":
      return {
        ...next,
        diff: {
          body: projection.diff,
          truncated: projection.truncated,
          seq: event.seq,
          occurredAt: event.occurredAt,
        },
      };
    case "usageChanged":
      return { ...next, usage: projection.usage };
    case "approvalChanged":
      return {
        ...next,
        approvals: replaceById(state.approvals, projection.approval),
        firstSeen: recordFirstSeen(state.firstSeen, projection.approval.id, event.occurredAt),
      };
    case "modeChanged":
      return { ...next, mode: projection.mode };
    case "turnError":
      return {
        ...next,
        // A provider that will not retry has abandoned the turn, and some
        // never follow up with a `turn/completed` saying so. Settling here
        // keeps the turn from sitting in `inProgress` forever, which pins the
        // composer to stop instead of send and stalls the queue.
        turn:
          !projection.retryable && next.turn?.status === "inProgress"
            ? {
                ...next.turn,
                status: "failed",
                error: projection.message,
                completedAt: event.occurredAt,
              }
            : next.turn,
        // Only the most recent error is actionable; older ones read as noise.
        errors: [
          {
            seq: event.seq,
            message: projection.message,
            retryable: projection.retryable,
            occurredAt: event.occurredAt,
          },
        ],
      };
    case "connectionChanged":
      return {
        ...next,
        connection: {
          state: projection.state,
          reason: projection.reason,
          processId: projection.processId,
        },
      };
    case "projectionReset":
      return {
        ...createRuntimeProjectionState(state.taskId),
        lastSeq: event.seq,
        resetSeq: event.seq,
        connection: { state: "reconciling", reason: projection.reason },
      };
  }
}

function applyItemProjectionRun(
  state: RuntimeProjectionState,
  events: readonly RuntimeProjectionEvent[],
  start: number,
  end: number,
): RuntimeProjectionState {
  let lastSeq = state.lastSeq;
  let items: ItemProjection[] | undefined;
  let itemIndexes: Map<string, number> | undefined;
  let firstSeen = state.firstSeen;
  let firstSeenChanged = false;

  for (let index = start; index < end; index += 1) {
    const event = events[index];
    if (event.taskId !== state.taskId || event.seq <= lastSeq) continue;

    const projection = event.projection;
    if (projection.kind !== "itemChanged") continue;
    lastSeq = event.seq;

    if (!items || !itemIndexes) {
      items = [...state.items];
      itemIndexes = new Map<string, number>();
      for (const [itemIndex, item] of items.entries()) {
        if (!itemIndexes.has(item.id)) itemIndexes.set(item.id, itemIndex);
      }
    }

    const itemIndex = itemIndexes.get(projection.item.id);
    if (itemIndex === undefined) {
      itemIndexes.set(projection.item.id, items.length);
      items.push(projection.item);
    } else {
      items[itemIndex] = projection.item;
    }

    if (!firstSeen[projection.item.id]) {
      if (!firstSeenChanged) {
        firstSeen = { ...firstSeen };
        firstSeenChanged = true;
      }
      firstSeen[projection.item.id] = event.occurredAt;
    }
  }

  if (!items) return state;
  return { ...state, lastSeq, items, firstSeen };
}

/**
 * Reduces an ordered publication without repeatedly copying the full item
 * collection for a streaming burst. Every non-item transition remains on the
 * canonical single-event reducer, so lifecycle and reset semantics stay in
 * one place.
 */
export function applyRuntimeProjectionBatch(
  state: RuntimeProjectionState,
  events: readonly RuntimeProjectionEvent[],
): RuntimeProjectionState {
  let next = state;
  let index = 0;

  while (index < events.length) {
    if (events[index].projection.kind !== "itemChanged") {
      next = applyRuntimeProjection(next, events[index]);
      index += 1;
      continue;
    }

    const start = index;
    while (index < events.length && events[index].projection.kind === "itemChanged") index += 1;
    next =
      index - start === 1
        ? applyRuntimeProjection(next, events[start])
        : applyItemProjectionRun(next, events, start, index);
  }

  return next;
}

function itemStatus(item: ItemProjection, turnSettled: boolean): TranscriptEvent["status"] {
  if (item.status === "failed") return "error";
  if (item.status === "declined") return "warning";
  if (item.status === "completed") return "success";
  // An unfinished item under a settled turn was cut off and will never
  // complete; a live spinner would misreport it as still streaming.
  return turnSettled ? "neutral" : "running";
}

function countChangedLines(text?: string): { additions: number; deletions: number } {
  if (!text) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function lineCount(text?: string): number {
  if (!text) return 0;
  return text
    .split(/\r?\n/)
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1).length;
}

function parseToolInput(input?: string): Record<string, unknown> {
  if (!input) return {};
  try {
    const value: unknown = JSON.parse(input);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toolPath(input: Record<string, unknown>): string | undefined {
  const candidate = [input.path, input.filePath, input.file_path, input.filename, input.file].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return candidate?.trim();
}

type ToolAction = "read" | "write" | "edit" | "search" | "execute" | "other";

const TOOL_ACTIONS: Readonly<Record<string, ToolAction>> = {
  read: "read",
  read_file: "read",
  view_file: "read",
  write: "write",
  write_file: "write",
  write_to_file: "write",
  edit: "edit",
  apply_patch: "edit",
  replace_file_content: "edit",
  multi_replace_file_content: "edit",
  search: "search",
  web_search: "search",
  websearch: "search",
  grep: "search",
  glob: "search",
  find: "search",
  list_dir: "search",
  list_files: "search",
  bash: "execute",
  shell: "execute",
  execute: "execute",
  run_command: "execute",
};

const INTEGRATOR_TOOL_COPY: Readonly<Record<string, readonly [string, string]>> = {
  peers_list: ["Checking subagent configuration", "Checked subagent configuration"],
  delegate_start: ["Starting a subagent", "Started a subagent"],
  delegation_status: ["Checking subagent progress", "Checked subagent progress"],
  delegation_message: ["Sending guidance to a subagent", "Sent guidance to a subagent"],
  delegation_result: ["Collecting the subagent result", "Collected the subagent result"],
  delegation_stop: ["Stopping a subagent", "Stopped a subagent"],
};

const PROVIDER_TOOL_COPY: Readonly<Record<string, readonly [string, string]>> = {
  list_permissions: ["Checking tool permissions", "Checked tool permissions"],
};

function normalizedToolName(item: ItemProjection): string {
  return (item.mcpTool ?? item.title ?? "").trim().toLowerCase();
}

function toolAction(item: ItemProjection): ToolAction {
  return TOOL_ACTIONS[normalizedToolName(item)] ?? "other";
}

function semanticToolTitle(item: ItemProjection): string | undefined {
  const name = normalizedToolName(item);
  const copy =
    item.mcpServer?.toLowerCase() === "integrator"
      ? INTEGRATOR_TOOL_COPY[name]
      : PROVIDER_TOOL_COPY[name];
  if (!copy) return undefined;
  const running = item.status === "pending" || item.status === "inProgress";
  return copy[running ? 0 : 1];
}

function toolQuery(input: Record<string, unknown>): string | undefined {
  const candidate = [input.pattern, input.query, input.q].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return candidate?.trim();
}

function toolSummary(
  item: ItemProjection,
  input: Record<string, unknown>,
  path: string | undefined,
  action: ReturnType<typeof toolAction>,
): {
  title: string;
  body: string;
  changeStats?: { additions: number; deletions: number };
} {
  const patchStats = countChangedLines(item.output);
  const oldText = typeof input.oldString === "string" ? input.oldString : input.old_string;
  const newText = typeof input.newString === "string" ? input.newString : input.new_string;
  const inputStats =
    typeof oldText === "string" || typeof newText === "string"
      ? {
          additions: lineCount(typeof newText === "string" ? newText : undefined),
          deletions: lineCount(typeof oldText === "string" ? oldText : undefined),
        }
      : undefined;
  const changeStats =
    patchStats.additions || patchStats.deletions
      ? patchStats
      : (inputStats ??
        (action === "write" && typeof input.content === "string"
          ? { additions: lineCount(input.content), deletions: 0 }
          : undefined));
  const fallback = item.body || toolInputPreview(item.toolInput);
  const semanticTitle = semanticToolTitle(item);
  if (semanticTitle) return { title: semanticTitle, body: path ?? fallback ?? "", changeStats };
  const running = item.status === "pending" || item.status === "inProgress";
  if (action === "read")
    return { title: running ? "Reading" : "Read", body: path ?? fallback ?? "" };
  if (action === "write")
    return { title: running ? "Creating" : "Created", body: path ?? fallback ?? "", changeStats };
  if (action === "edit")
    return { title: running ? "Editing" : "Edited", body: path ?? fallback ?? "", changeStats };
  if (action === "search")
    return {
      title: running ? "Searching" : "Searched",
      body: toolQuery(input) ?? path ?? fallback ?? "",
    };
  if (action === "execute")
    return {
      title: running ? "Running a command" : "Ran a command",
      body: fallback ?? "",
    };
  return {
    title: "Runtime event",
    body: path ?? fallback ?? "",
    changeStats,
  };
}

/** First line of tool input when it is human-meaningful; skip empty JSON shells. */
function toolInputPreview(toolInput?: string): string | undefined {
  if (!toolInput) return undefined;
  const first = toolInput.split("\n", 1)[0]?.trim();
  if (!first) return undefined;
  if (first === "{}" || first === "[]" || first === "{" || first === "[") return undefined;
  if (/^\{\s*\}$/.test(first) || /^\[\s*\]$/.test(first)) return undefined;
  return first;
}

function itemBody(item: ItemProjection): string {
  if (item.kind === "commandExecution") {
    const parts = [item.command, item.output].filter(Boolean);
    return parts.join("\n\n") || "Command activity";
  }
  if (item.kind === "fileChange") {
    const files = item.fileChanges?.map((change) => `${change.changeKind} ${change.path}`) ?? [];
    return files.join("\n") || item.body || "File changes";
  }
  if (item.kind === "mcpTool") {
    return (
      item.body ||
      [item.mcpServer, item.mcpTool].filter(Boolean).join(" · ") ||
      toolInputPreview(item.toolInput) ||
      "Tool call"
    );
  }
  return item.body || item.title || "Activity";
}

function itemChangeStats(
  item: ItemProjection,
  toolChangeStats?: { additions: number; deletions: number },
): { additions: number; deletions: number } | undefined {
  if (item.fileChanges?.length) {
    const stats = item.fileChanges.reduce(
      (total, change) => {
        const patch = countChangedLines(change.patch);
        return {
          additions: total.additions + patch.additions,
          deletions: total.deletions + patch.deletions,
        };
      },
      { additions: 0, deletions: 0 },
    );
    return stats.additions || stats.deletions ? stats : undefined;
  }
  return toolChangeStats;
}

function itemDetails(item: ItemProjection): TranscriptEvent["details"] {
  const details: NonNullable<TranscriptEvent["details"]> = [];
  if (item.kind === "commandExecution") {
    if (item.command) details.push({ label: "Command", body: item.command });
    if (item.cwd) details.push({ label: "Working directory", body: item.cwd });
    if (item.output) details.push({ label: "Output", body: item.output });
  }
  if (item.kind === "fileChange") {
    for (const change of item.fileChanges ?? []) {
      details.push({
        label: `${change.changeKind} ${change.path}`,
        body: change.patch || `${change.changeKind} ${change.path}`,
      });
    }
  }
  if (item.toolInput) details.push({ label: "Input", body: item.toolInput });
  if (item.kind === "mcpTool" && item.output) details.push({ label: "Output", body: item.output });
  return details.length > 0 ? details : undefined;
}

function diffStatusForChange(
  changeKind: NonNullable<ItemProjection["fileChanges"]>[number]["changeKind"],
): DiffFile["status"] {
  if (changeKind === "add") return "added";
  if (changeKind === "delete") return "deleted";
  if (changeKind === "rename") return "renamed";
  return "modified";
}

function diffFileFromPatch(
  path: string,
  patch: string | undefined,
  status: DiffFile["status"] = "modified",
): DiffFile | undefined {
  if (!patch?.trim()) return undefined;
  const lines = parseDiffLines(patch);
  if (!lines.some((line) => line.kind === "add" || line.kind === "delete")) return undefined;
  return {
    path,
    status,
    additions: lines.filter((line) => line.kind === "add").length,
    deletions: lines.filter((line) => line.kind === "delete").length,
    staged: false,
    lines,
  };
}

function syntheticEditPatch(
  oldText: string | undefined,
  newText: string | undefined,
): string | undefined {
  if (oldText === undefined && newText === undefined) return undefined;
  const oldLines = oldText?.split(/\r?\n/) ?? [];
  const newLines = newText?.split(/\r?\n/) ?? [];
  return [
    `@@ -1,${Math.max(1, oldLines.length)} +1,${Math.max(1, newLines.length)} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

function toolDiff(
  item: ItemProjection,
  input: Record<string, unknown>,
  path: string | undefined,
  action: ReturnType<typeof toolAction>,
): DiffFile | undefined {
  if (!path || (action !== "edit" && action !== "write")) return undefined;
  const oldText =
    typeof input.oldString === "string"
      ? input.oldString
      : typeof input.old_string === "string"
        ? input.old_string
        : undefined;
  const newText =
    typeof input.newString === "string"
      ? input.newString
      : typeof input.new_string === "string"
        ? input.new_string
        : typeof input.content === "string"
          ? input.content
          : undefined;
  const patch = item.output?.includes("@@") ? item.output : syntheticEditPatch(oldText, newText);
  return diffFileFromPatch(
    path,
    patch,
    action === "write" && oldText === undefined ? "added" : "modified",
  );
}

function deriveToolPresentation(item: ItemProjection): {
  summary: ReturnType<typeof toolSummary>;
  path: string | undefined;
  diff: DiffFile | undefined;
} {
  const input = parseToolInput(item.toolInput);
  const path = toolPath(input);
  const action = toolAction(item);
  return {
    summary: toolSummary(item, input, path, action),
    path,
    diff: toolDiff(item, input, path, action),
  };
}

function fileChangeVerb(
  changeKind: NonNullable<ItemProjection["fileChanges"]>[number]["changeKind"],
): string {
  if (changeKind === "add") return "Added";
  if (changeKind === "delete") return "Deleted";
  if (changeKind === "rename") return "Renamed";
  if (changeKind === "modify") return "Edited";
  return "Changed";
}

function formatActivityDuration(children: TranscriptEvent[]): string {
  const timestamps = children
    .map((child) => Date.parse(child.timestamp))
    .filter((value) => Number.isFinite(value));
  if (timestamps.length < 2) return "<1s";
  const elapsed = Math.max(0, Math.max(...timestamps) - Math.min(...timestamps));
  return formatElapsedClock(elapsed);
}

/** Wall-clock duration for “Worked for …” / activity meta (Codex-style). */
function formatElapsedClock(elapsedMs: number): string {
  if (elapsedMs < 1_000) return "<1s";
  const totalSeconds = Math.floor(elapsedMs / 1_000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

type ActivityGroupFamily = "edit" | "mixed";

function isEditEvent(event: TranscriptEvent): boolean {
  if (/^Read/i.test(event.title ?? "")) return false;
  if (/^(Search|Searching|Searched)/i.test(event.title ?? "")) return false;
  if (event.activityType === "file") return true;
  return /^(Edit|Editing|Edited|Creat|Creating|Created|Added|Deleted|Renamed|Changed)/i.test(
    event.title ?? "",
  );
}

function activityGroupFamily(event: TranscriptEvent): ActivityGroupFamily {
  return isEditEvent(event) ? "edit" : "mixed";
}

function activityGroupSummary(children: TranscriptEvent[]): string {
  const counts = new Map<string, number>();
  for (const child of children) {
    const type = child.activityType ?? "other";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const labels: Array<[string, string, string]> = [
    ["command", "command", "commands"],
    ["tool", "tool", "tools"],
    ["file", "file change", "file changes"],
    ["approval", "approval", "approvals"],
    ["reasoning", "summary", "summaries"],
    ["other", "activity", "activities"],
  ];
  return labels
    .flatMap(([type, singular, plural]) => {
      const count = counts.get(type) ?? 0;
      if (!count) return [];
      return [`${count} ${count === 1 ? singular : plural}`];
    })
    .join(" · ");
}

function activityGroupTitle(
  family: ActivityGroupFamily,
  status: TranscriptEvent["status"],
): string {
  const running = status === "running";
  if (family === "edit") return running ? "Editing" : "Edits";
  return running ? "Working" : "Activity";
}

function activityGroupBody(family: ActivityGroupFamily, children: TranscriptEvent[]): string {
  if (family === "edit") {
    const count = children.length;
    return `${count} ${count === 1 ? "file" : "files"}`;
  }
  return activityGroupSummary(children);
}

function activityGroupActivityType(family: ActivityGroupFamily): TranscriptEvent["activityType"] {
  return family === "edit" ? "file" : "other";
}

function activityGroupStatus(children: TranscriptEvent[]): TranscriptEvent["status"] {
  if (children.some((child) => child.status === "error")) return "error";
  if (children.some((child) => child.status === "warning")) return "warning";
  if (children.some((child) => child.status === "running")) return "running";
  return "success";
}

export type TranscriptDensity = "summary" | "normal" | "verbose";
const ACTIVITY_GROUP_LIMIT = 50;

function groupActivityEvents(
  events: TranscriptEvent[],
  density: TranscriptDensity,
): TranscriptEvent[] {
  if (density === "verbose") return events;
  const grouped: TranscriptEvent[] = [];
  let batch: TranscriptEvent[] = [];

  const flush = () => {
    if (batch.length === 0) return;
    if (batch.length === 1 && density !== "summary") {
      grouped.push(batch[0]);
      batch = [];
      return;
    }
    const status = activityGroupStatus(batch);
    const family = activityGroupFamily(batch[0]);
    const additions = batch.reduce(
      (total, child) => total + (child.changeStats?.additions ?? 0),
      0,
    );
    const deletions = batch.reduce(
      (total, child) => total + (child.changeStats?.deletions ?? 0),
      0,
    );
    grouped.push({
      id: `activity-group-${batch[0].id}`,
      kind: "activity",
      activityType: activityGroupActivityType(family),
      title: activityGroupTitle(family, status),
      body: activityGroupBody(family, batch),
      timestamp: batch[0].timestamp,
      status,
      meta: `${formatActivityDuration(batch)} · ${status === "success" ? "complete" : status}`,
      changeStats: additions || deletions ? { additions, deletions } : undefined,
      children: batch,
      expandedByDefault: false,
    });
    batch = [];
  };

  for (const event of events) {
    const family = activityGroupFamily(event);
    // Pending approvals stay visible as their own rows so turn collapse cannot
    // bury attention inside a “Worked for” bucket.
    const groupable =
      (event.kind === "activity" || event.kind === "tool" || event.kind === "checkpoint") &&
      !event.children?.length &&
      (family === "edit" || !event.diff) &&
      event.status !== "error" &&
      event.status !== "warning";
    if (groupable) {
      if (batch.length > 0 && activityGroupFamily(batch[0]) !== family) flush();
      batch.push(event);
      if (batch.length >= ACTIVITY_GROUP_LIMIT) flush();
    } else {
      flush();
      grouped.push(event);
    }
  }
  flush();
  return grouped;
}

function isUnresolvedAttention(event: TranscriptEvent): boolean {
  return event.kind === "approval" && (event.status === "warning" || event.status === "error");
}

function isTurnCollapsible(event: TranscriptEvent): boolean {
  if (event.kind === "user" || event.kind === "notice") return false;
  if (isUnresolvedAttention(event)) return false;
  // Mid-turn assistant replies fold into Worked for in chronological order;
  // the final assistant is never passed here.
  if (event.kind === "assistant") return true;
  return (
    event.kind === "activity" ||
    event.kind === "tool" ||
    event.kind === "checkpoint" ||
    event.kind === "approval"
  );
}

function workedForDuration(children: TranscriptEvent[], turn: TurnProjection | undefined): string {
  const started = turn?.startedAt ? Date.parse(turn.startedAt) : Number.NaN;
  const completed = turn?.completedAt ? Date.parse(turn.completedAt) : Number.NaN;
  if (Number.isFinite(started) && Number.isFinite(completed) && completed >= started) {
    return formatElapsedClock(completed - started);
  }
  return formatActivityDuration(children);
}

function makeWorkedForEvent(
  children: TranscriptEvent[],
  finalAssistantId: string,
  turn: TurnProjection | undefined,
  segmentKey: string,
  resumed = false,
): TranscriptEvent {
  const status = activityGroupStatus(children);
  const additions = children.reduce(
    (total, child) => total + (child.changeStats?.additions ?? 0),
    0,
  );
  const deletions = children.reduce(
    (total, child) => total + (child.changeStats?.deletions ?? 0),
    0,
  );
  return {
    id: `worked-for-${finalAssistantId}${segmentKey}`,
    kind: "activity",
    activityType: "other",
    title: "Worked for",
    body: workedForDuration(children, turn),
    timestamp: children[0]?.timestamp ?? turn?.completedAt ?? new Date(0).toISOString(),
    status,
    resumed: resumed || undefined,
    changeStats: additions || deletions ? { additions, deletions } : undefined,
    children,
    expandedByDefault: false,
  };
}

/**
 * After a turn settles — and for every earlier completed turn while a new one
 * is running — fold mid-turn agent activity (including interim assistant
 * messages) into collapsed “Worked for …” row(s) above each final reply.
 *
 * Important: do not gate the entire transcript on the *current* turn's
 * settled flag. Sending a follow-up must not unwrap prior Worked-for rows.
 */
function collapseSettledTurnActivity(
  events: TranscriptEvent[],
  options: {
    turnSettled: boolean;
    density: TranscriptDensity;
    turn?: TurnProjection;
  },
): TranscriptEvent[] {
  if (options.density === "verbose" || events.length === 0) {
    return events;
  }

  const result: TranscriptEvent[] = [];
  let index = 0;
  while (index < events.length) {
    const event = events[index];
    if (event.kind !== "user") {
      result.push(event);
      index += 1;
      continue;
    }

    result.push(event);
    index += 1;
    const spanStart = index;
    let finalAssistantIndex = -1;
    let nextUserIndex = -1;
    for (let cursor = spanStart; cursor < events.length; cursor += 1) {
      if (events[cursor].kind === "user") {
        nextUserIndex = cursor;
        break;
      }
      if (events[cursor].kind === "assistant") finalAssistantIndex = cursor;
    }
    if (finalAssistantIndex < 0) {
      while (index < events.length && events[index].kind !== "user") {
        result.push(events[index]);
        index += 1;
      }
      continue;
    }

    // Collapse completed prior turns always. Collapse the latest turn only once
    // it has settled — otherwise live activity stays visible while running.
    const isPriorTurn = nextUserIndex >= 0;
    const shouldCollapse = isPriorTurn || options.turnSettled;
    if (!shouldCollapse) {
      while (index <= finalAssistantIndex) {
        result.push(events[index]);
        index += 1;
      }
      continue;
    }

    const finalAssistant = events[finalAssistantIndex];
    let segment = 0;
    let pending: TranscriptEvent[] = [];
    const allowTurnClock = options.turnSettled && !isPriorTurn;
    const flushPending = () => {
      if (pending.length === 0) return;
      const suffix = segment === 0 ? "" : `-${segment}`;
      const body =
        segment === 0 && allowTurnClock
          ? workedForDuration(pending, options.turn)
          : formatActivityDuration(pending);
      result.push({
        ...makeWorkedForEvent(pending, finalAssistant.id, options.turn, suffix),
        body,
      });
      segment += 1;
      pending = [];
    };

    for (let cursor = spanStart; cursor < finalAssistantIndex; cursor += 1) {
      const mid = events[cursor];
      if (isTurnCollapsible(mid)) {
        pending.push(mid);
      } else {
        flushPending();
        result.push(mid);
      }
    }
    flushPending();
    result.push(finalAssistant);
    index = finalAssistantIndex + 1;
  }
  return result;
}

/** Wire-only resume placeholder; never rendered as a user bubble. */
export const INTERRUPTED_RESUME_VISIBLE_PROMPT = "Resume from here";

function deriveItemTranscriptEvents(
  item: ItemProjection,
  timestamp: string,
  status: TranscriptEvent["status"],
): TranscriptEvent[] {
  if (item.kind === "userMessage" && item.body?.trim() === INTERRUPTED_RESUME_VISIBLE_PROMPT) {
    return [];
  }
  const hasFileChanges =
    (item.kind === "fileChange" || item.kind === "mcpTool") && Boolean(item.fileChanges?.length);
  const toolPresentation =
    item.kind === "mcpTool" && !hasFileChanges ? deriveToolPresentation(item) : undefined;
  const common = {
    id: item.id,
    body: itemBody(item),
    nativeSkill: item.nativeSkill,
    timestamp,
    status,
    meta: item.truncated ? "Output truncated" : undefined,
    changeStats: itemChangeStats(item, toolPresentation?.summary.changeStats),
  };

  if (item.kind === "userMessage") return [{ ...common, kind: "user" }];
  if (item.kind === "agentMessage") {
    return [{ ...common, kind: "assistant", phase: item.phase }];
  }
  if (item.kind === "reasoningSummary") {
    const summary = item.body?.trim();
    if (!summary) return [];
    const providerLabel = item.title === "Reasoning summary";
    return [
      {
        ...common,
        kind: "activity",
        activityType: "reasoning",
        body: summary,
        title: providerLabel ? undefined : item.title,
        meta: providerLabel
          ? [common.meta, "Reasoning summary"].filter(Boolean).join(" · ")
          : common.meta,
      },
    ];
  }
  if (item.kind === "unknown") {
    const legacyWebSearch = item.body?.trim() === "Unsupported item type: webSearch";
    const running = item.status === "pending" || item.status === "inProgress";
    return [
      {
        ...common,
        kind: legacyWebSearch ? "tool" : "activity",
        activityType: legacyWebSearch ? "tool" : "other",
        title: legacyWebSearch ? (running ? "Searching" : "Searched") : "Provider activity",
        body: legacyWebSearch ? "Web search" : "Additional provider activity",
        expandedByDefault: false,
      },
    ];
  }
  if (hasFileChanges) {
    return (item.fileChanges ?? []).map((change, index) => ({
      ...common,
      id: `${item.id}:file:${index}`,
      kind: "tool",
      activityType: "file",
      filePath: change.path,
      diff: diffFileFromPatch(change.path, change.patch, diffStatusForChange(change.changeKind)),
      title: fileChangeVerb(change.changeKind),
      body: change.path,
      expandedByDefault: false,
    }));
  }

  const summary = toolPresentation?.summary;
  const diff = toolPresentation?.diff;
  return [
    {
      ...common,
      kind: "tool",
      activityType:
        item.kind === "commandExecution"
          ? "command"
          : item.kind === "fileChange"
            ? "file"
            : item.kind === "mcpTool"
              ? "tool"
              : "other",
      title:
        summary?.title ??
        item.title ??
        (item.kind === "commandExecution"
          ? "Command"
          : item.kind === "fileChange"
            ? "File changes"
            : item.kind === "mcpTool"
              ? [item.mcpServer, item.mcpTool].filter(Boolean).join(" · ") || "Tool call"
              : "Activity"),
      body: summary?.body ?? common.body,
      filePath: toolPresentation?.path,
      diff,
      details: diff ? undefined : itemDetails(item),
      expandedByDefault: false,
    },
  ];
}

type ItemTranscriptDeriver = (
  item: ItemProjection,
  timestamp: string,
  status: TranscriptEvent["status"],
) => readonly TranscriptEvent[];

function buildRuntimeTranscript(
  state: RuntimeProjectionState,
  deriveItem: ItemTranscriptDeriver,
  density: TranscriptDensity,
): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const turnSettled =
    state.turn !== undefined &&
    state.turn.status !== "inProgress" &&
    state.turn.status !== "pending";

  if (state.plan.length > 0) {
    events.push({
      id: `runtime-plan-${state.taskId}`,
      kind: "activity",
      activityType: "plan",
      title: state.planTruncated ? "Plan (truncated)" : "Plan",
      body: `${state.plan.filter((step) => step.status === "completed").length} of ${state.plan.length} steps complete`,
      timestamp: state.items[0]?.updatedAt ?? new Date(0).toISOString(),
      status: state.plan.every((step) => step.status === "completed") ? "success" : "running",
      children: state.plan.map((step) => ({
        id: `runtime-plan-${state.taskId}-${step.index}`,
        kind: "activity",
        body: step.text,
        timestamp: state.items[0]?.updatedAt ?? new Date(0).toISOString(),
        status:
          step.status === "completed"
            ? "success"
            : step.status === "inProgress"
              ? "running"
              : "neutral",
      })),
    });
  }

  for (const item of state.items) {
    events.push(
      ...deriveItem(
        item,
        state.firstSeen[item.id] ?? item.updatedAt,
        itemStatus(item, turnSettled),
      ),
    );
  }

  for (const approval of state.approvals) {
    events.push({
      id: `runtime-approval-${approval.id}`,
      kind: "approval",
      activityType: "approval",
      title:
        approval.approvalKind === "commandExecution"
          ? "Command approval"
          : approval.approvalKind === "planReview"
            ? "Plan approval"
            : "File approval",
      body: approval.reason ?? `Approval is ${approval.state}.`,
      timestamp: state.firstSeen[approval.id] ?? approval.updatedAt,
      status:
        approval.state === "pending" || approval.state === "responding"
          ? "warning"
          : approval.state === "resolved"
            ? "success"
            : "neutral",
    });
  }

  if (state.diff) {
    const diffStats = countChangedLines(state.diff.body);
    events.push({
      id: `runtime-diff-${state.diff.seq}`,
      kind: "tool",
      activityType: "file",
      title: state.diff.truncated ? "Turn diff (truncated)" : "Turn diff updated",
      body: state.diff.body,
      timestamp: state.diff.occurredAt,
      status: "success",
      changeStats: diffStats.additions || diffStats.deletions ? diffStats : undefined,
    });
  }

  // Interleave chronologically by FIRST appearance: a streaming item keeps
  // receiving updates, so ordering by last-update time would make growing
  // text hop below tool activity that actually happened after it started.
  const ordered = events
    .map((event, index) => ({ event, index, time: Date.parse(event.timestamp) || 0 }))
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .map(({ event }) => event);
  return collapseSettledTurnActivity(groupActivityEvents(ordered, density), {
    turnSettled,
    density,
    turn: state.turn,
  });
}

export function runtimeTranscript(
  state: RuntimeProjectionState,
  density: TranscriptDensity = "normal",
): TranscriptEvent[] {
  return buildRuntimeTranscript(state, deriveItemTranscriptEvents, density);
}

export function createRuntimeTranscriptDeriver(
  density: TranscriptDensity = "normal",
): (state: RuntimeProjectionState) => TranscriptEvent[] {
  let cachedTaskId: string | undefined;
  let itemCache = new WeakMap<
    ItemProjection,
    {
      timestamp: string;
      status: TranscriptEvent["status"];
      events: readonly TranscriptEvent[];
    }
  >();

  return (state) => {
    if (cachedTaskId !== state.taskId) {
      cachedTaskId = state.taskId;
      itemCache = new WeakMap();
    }
    return buildRuntimeTranscript(
      state,
      (item, timestamp, status) => {
        const cached = itemCache.get(item);
        if (cached?.timestamp === timestamp && cached.status === status) return cached.events;
        const events = deriveItemTranscriptEvents(item, timestamp, status);
        itemCache.set(item, { timestamp, status, events });
        return events;
      },
      density,
    );
  };
}
