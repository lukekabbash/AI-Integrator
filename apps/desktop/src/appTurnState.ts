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
