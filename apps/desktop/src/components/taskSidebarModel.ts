import type { TaskSummary } from "../bridge";

const STATUS_LABEL: Record<TaskSummary["status"], string> = {
  draft: "Draft",
  starting: "Starting",
  running: "Running",
  waiting: "Waiting for input",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

const ACTIVE_STATUSES = new Set<TaskSummary["status"]>([
  "starting",
  "running",
  "waiting",
  "failed",
]);

export type ChatDotKind = "streaming" | "attention" | "unread" | "unread-failed";

export const CHAT_DOT_LABEL: Record<ChatDotKind, string> = {
  streaming: "Streaming",
  attention: "Needs your input",
  unread: "Unread reply",
  "unread-failed": "Failed, unread",
};

/** Keep idle rows quiet; dots represent live work, required input, or unread output. */
export function chatDotKind(task: TaskSummary): ChatDotKind | null {
  if (task.status === "waiting") return "attention";
  if (task.status === "starting" || task.status === "running") return "streaming";
  if (task.unread) return task.status === "failed" ? "unread-failed" : "unread";
  return null;
}

export function sortTasks(tasks: TaskSummary[]): TaskSummary[] {
  return [...tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function modKeyLabel(): string {
  return isApplePlatform() ? "⌘" : "Ctrl";
}

export function formatRelativeUpdated(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 45_000) return "Just now";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function chatMeta(
  task: TaskSummary,
  options?: { showProject?: boolean; projectName?: string },
): string {
  const prefix = options?.showProject ? `${options.projectName ?? "Project"} · ` : "";
  if (ACTIVE_STATUSES.has(task.status)) return `${prefix}${STATUS_LABEL[task.status]}`;
  const relative = formatRelativeUpdated(task.updatedAt);
  return relative ? `${prefix}${relative}` : `${prefix}${STATUS_LABEL[task.status]}`;
}

export function lastPathSegment(value: string): string {
  return (
    value
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .filter(Boolean)
      .at(-1) ?? value
  );
}

export function pathRelativeToRoot(absolute: string, root?: string): string {
  if (!root) return lastPathSegment(absolute);
  const normalized = absolute.replace(/\\/g, "/");
  const rootNorm = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.toLowerCase() === rootNorm.toLowerCase()) return ".";
  const prefix = `${rootNorm.toLowerCase()}/`;
  if (normalized.toLowerCase().startsWith(prefix)) {
    return normalized.slice(rootNorm.length).replace(/^\/+/, "");
  }
  return lastPathSegment(absolute);
}
