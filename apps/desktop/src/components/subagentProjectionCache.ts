import type { RuntimeProjectionState } from "../runtimeProjection";

const DEFAULT_ENTRY_LIMIT = 12;

export class SubagentProjectionCache {
  readonly #entries = new Map<string, RuntimeProjectionState>();

  constructor(private readonly entryLimit = DEFAULT_ENTRY_LIMIT) {}

  get(taskId: string): RuntimeProjectionState | undefined {
    return this.#entries.get(taskId);
  }

  set(taskId: string, projection: RuntimeProjectionState): RuntimeProjectionState {
    const current = this.#entries.get(taskId);
    if (
      current &&
      (current.resetSeq > projection.resetSeq ||
        (current.resetSeq === projection.resetSeq && current.lastSeq > projection.lastSeq))
    ) {
      return current;
    }
    this.#entries.delete(taskId);
    this.#entries.set(taskId, projection);
    while (this.#entries.size > this.entryLimit) {
      const oldestTaskId = this.#entries.keys().next().value;
      if (!oldestTaskId) return projection;
      this.#entries.delete(oldestTaskId);
    }
    return projection;
  }
}
