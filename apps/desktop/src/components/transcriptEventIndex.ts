import type { TranscriptEvent } from "../bridge";

export function createFirstEventIndex(
  events: readonly TranscriptEvent[],
): (eventId: string) => number {
  let firstIndexById: Map<string, number> | undefined;
  return (eventId) => {
    if (!firstIndexById) {
      firstIndexById = new Map();
      for (let index = 0; index < events.length; index += 1) {
        const id = events[index].id;
        if (!firstIndexById.has(id)) firstIndexById.set(id, index);
      }
    }
    return firstIndexById.get(eventId) ?? -1;
  };
}
