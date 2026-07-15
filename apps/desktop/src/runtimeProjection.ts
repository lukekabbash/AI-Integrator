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
    return { status: "failed", updatedAt: event.occurredAt, unread: !taskIsActive };
  }
  return null;
}

export interface RuntimeProjectionState {
  taskId: string;
  lastSeq: number;
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
}

export function createRuntimeProjectionState(taskId: string): RuntimeProjectionState {
  return {
    taskId,
    lastSeq: 0,
    items: [],
    plan: [],
    planTruncated: false,
    approvals: [],
    connection: { state: "reconciling", reason: "Loading persisted task state" },
    errors: [],
    firstSeen: {},
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
        turn: projection.turn,
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
      // Only the most recent error is actionable; older ones read as noise.
      return {
        ...next,
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

function toolAction(item: ItemProjection): "read" | "write" | "edit" | "search" | "other" {
  const name = [item.mcpTool, item.title].filter(Boolean).join(" ").toLowerCase();
  if (/\b(read|cat|open|view)\b/.test(name)) return "read";
  if (/\b(write|create|save)\b/.test(name)) return "write";
  if (/\b(edit|patch|replace|update)\b/.test(name)) return "edit";
  if (/\b(search|grep|glob|find|list)\b/.test(name)) return "search";
  return "other";
}

/** "web_search" / "fetchUrl" / "apply-patch" → "Web search" / "Fetch url" / "Apply patch". */
function humanizeToolName(name?: string): string | undefined {
  if (!name) return undefined;
  const words = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!words) return undefined;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
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
  const fallback = item.body || item.toolInput?.split("\n", 1)[0] || "Tool activity";
  if (action === "read") return { title: "Read", body: path ?? fallback };
  if (action === "write") return { title: "Wrote", body: path ?? fallback, changeStats };
  if (action === "edit") return { title: "Edited", body: path ?? fallback, changeStats };
  if (action === "search") return { title: "Searched", body: toolQuery(input) ?? path ?? fallback };
  const toolName = humanizeToolName(item.mcpTool);
  return {
    title:
      (toolName && item.mcpServer ? `${toolName} · ${item.mcpServer}` : toolName) ||
      item.title ||
      "Tool call",
    body: path ?? fallback,
    changeStats,
  };
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
      item.toolInput?.split("\n", 1)[0] ||
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
  if (elapsed < 1_000) return "<1s";
  const seconds = Math.floor(elapsed / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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

function activityGroupStatus(children: TranscriptEvent[]): TranscriptEvent["status"] {
  if (children.some((child) => child.status === "error")) return "error";
  if (children.some((child) => child.status === "warning")) return "warning";
  if (children.some((child) => child.status === "running")) return "running";
  return "success";
}

function groupActivityEvents(events: TranscriptEvent[]): TranscriptEvent[] {
  const grouped: TranscriptEvent[] = [];
  let batch: TranscriptEvent[] = [];

  const flush = () => {
    if (batch.length === 0) return;
    if (batch.length === 1) {
      grouped.push(batch[0]);
      batch = [];
      return;
    }
    const status = activityGroupStatus(batch);
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
      activityType: "other",
      title: status === "running" ? "Working" : "Activity",
      body: activityGroupSummary(batch),
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
    const groupable =
      (event.kind === "activity" ||
        event.kind === "tool" ||
        event.kind === "checkpoint" ||
        event.kind === "approval") &&
      !event.children?.length &&
      !event.diff &&
      (event.kind === "approval" || (event.status !== "error" && event.status !== "warning"));
    if (groupable) batch.push(event);
    else {
      flush();
      grouped.push(event);
    }
  }
  flush();
  return grouped;
}

function deriveItemTranscriptEvents(
  item: ItemProjection,
  timestamp: string,
  status: TranscriptEvent["status"],
): TranscriptEvent[] {
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
  if (item.kind === "agentMessage") return [{ ...common, kind: "assistant" }];
  if (item.kind === "reasoningSummary") {
    return [
      {
        ...common,
        kind: "activity",
        activityType: "reasoning",
        title: item.title ?? "Reasoning summary",
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

  if (state.turn?.status === "interrupted") {
    events.push({
      id: `runtime-turn-interrupted-${state.turn.id}`,
      kind: "notice",
      title: "Response interrupted",
      body: "The agent was stopped before it finished this response. Send a new message to continue.",
      timestamp:
        state.turn.completedAt ??
        state.items[state.items.length - 1]?.updatedAt ??
        new Date().toISOString(),
      status: "warning",
    });
  }

  // Interleave chronologically by FIRST appearance: a streaming item keeps
  // receiving updates, so ordering by last-update time would make growing
  // text hop below tool activity that actually happened after it started.
  return groupActivityEvents(
    events
      .map((event, index) => ({ event, index, time: Date.parse(event.timestamp) || 0 }))
      .sort((a, b) => a.time - b.time || a.index - b.index)
      .map(({ event }) => event),
  );
}

export function runtimeTranscript(state: RuntimeProjectionState): TranscriptEvent[] {
  return buildRuntimeTranscript(state, deriveItemTranscriptEvents);
}

export function createRuntimeTranscriptDeriver(): (
  state: RuntimeProjectionState,
) => TranscriptEvent[] {
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
    return buildRuntimeTranscript(state, (item, timestamp, status) => {
      const cached = itemCache.get(item);
      if (cached?.timestamp === timestamp && cached.status === status) return cached.events;
      const events = deriveItemTranscriptEvents(item, timestamp, status);
      itemCache.set(item, { timestamp, status, events });
      return events;
    });
  };
}
