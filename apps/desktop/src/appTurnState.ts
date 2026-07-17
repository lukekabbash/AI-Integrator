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
  optimisticMessage: boolean;
}

export function isComposerTurnBusy(state: ComposerTurnBusyState): boolean {
  return (
    state.projectedTurnActive ||
    state.optimisticTurnStarting ||
    state.resuming ||
    state.queueBusy ||
    state.queueAwaiting ||
    state.optimisticMessage
  );
}
