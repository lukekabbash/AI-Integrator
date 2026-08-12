import type { TranscriptEvent } from "./bridge";

export interface OptimisticUserMessage {
  taskId: string;
  event: TranscriptEvent;
}

export function clearOptimisticMessageForTask(
  current: OptimisticUserMessage | null,
  taskId: string,
): OptimisticUserMessage | null {
  return current?.taskId === taskId ? null : current;
}

export interface ComposerTurnBusyState {
  projectedTurnActive: boolean;
  optimisticTurnStarting: boolean;
  resuming: boolean;
  queueBusy: boolean;
  queueAwaiting: boolean;
}

// Note: the raw presence of an optimistic user message must NOT feed this
// check. That state lives until the next edit/failure for display dedup, so
// counting it kept `busy` true after a successful send and routed every
// follow-up message through the queue detour. `optimisticTurnStarting` is the
// self-resolving "send accepted, turn not yet projected" signal.
export function isComposerTurnBusy(state: ComposerTurnBusyState): boolean {
  return (
    state.projectedTurnActive ||
    state.optimisticTurnStarting ||
    state.resuming ||
    state.queueBusy ||
    state.queueAwaiting
  );
}

/** Native admission is authoritative when the renderer's turn projection lags. */
export function isTurnActiveError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object" && "code" in error && error.code === "turn-active") return true;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" && "message" in error && typeof error.message === "string"
          ? error.message
          : "";
  return /\bturn-active\b|a turn is already (?:running|starting) for this chat/i.test(message);
}
