import type {
  ApprovalProjection,
  ConnectionProjection,
  ItemProjection,
  PlanStepProjection,
  RuntimeProjectionEvent,
  RuntimeUsageProjection,
  TranscriptEvent,
  TurnProjection,
} from "./bridge";

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

function itemStatus(item: ItemProjection): TranscriptEvent["status"] {
  if (item.status === "failed") return "error";
  if (item.status === "declined") return "warning";
  if (item.status === "completed") return "success";
  return "running";
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

function itemDetails(item: ItemProjection): TranscriptEvent["details"] {
  const details: NonNullable<TranscriptEvent["details"]> = [];
  if (item.toolInput) details.push({ label: "Input", body: item.toolInput });
  if (item.kind === "mcpTool" && item.output) details.push({ label: "Output", body: item.output });
  return details.length > 0 ? details : undefined;
}

export function runtimeTranscript(state: RuntimeProjectionState): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];

  if (state.plan.length > 0) {
    events.push({
      id: `runtime-plan-${state.taskId}`,
      kind: "activity",
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
    const common = {
      id: item.id,
      body: itemBody(item),
      timestamp: state.firstSeen[item.id] ?? item.updatedAt,
      status: itemStatus(item),
      meta: item.truncated ? "Output truncated" : undefined,
    };
    if (item.kind === "userMessage") events.push({ ...common, kind: "user" });
    else if (item.kind === "agentMessage") events.push({ ...common, kind: "assistant" });
    else if (item.kind === "reasoningSummary") {
      events.push({ ...common, kind: "activity", title: item.title ?? "Reasoning summary" });
    } else {
      events.push({
        ...common,
        kind: "tool",
        title:
          item.title ??
          (item.kind === "commandExecution"
            ? "Command"
            : item.kind === "fileChange"
              ? "File changes"
              : item.kind === "mcpTool"
                ? [item.mcpServer, item.mcpTool].filter(Boolean).join(" · ") || "Tool call"
                : "Activity"),
        details: itemDetails(item),
      });
    }
  }

  for (const approval of state.approvals) {
    events.push({
      id: `runtime-approval-${approval.id}`,
      kind: "approval",
      title: approval.approvalKind === "commandExecution" ? "Command approval" : "File approval",
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
    events.push({
      id: `runtime-diff-${state.diff.seq}`,
      kind: "tool",
      title: state.diff.truncated ? "Turn diff (truncated)" : "Turn diff updated",
      body: state.diff.body,
      timestamp: state.diff.occurredAt,
      status: "success",
    });
  }

  // Interleave chronologically by FIRST appearance: a streaming item keeps
  // receiving updates, so ordering by last-update time would make growing
  // text hop below tool activity that actually happened after it started.
  return events
    .map((event, index) => ({ event, index, time: Date.parse(event.timestamp) || 0 }))
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .map(({ event }) => event);
}
