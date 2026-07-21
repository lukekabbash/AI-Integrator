import { describe, expect, it } from "vitest";
import type { TranscriptEvent } from "../bridge";
import { createFirstEventIndex } from "./transcriptEventIndex";

function projectedEvent(id: string): TranscriptEvent {
  return {
    id,
    kind: "activity",
    body: id,
    timestamp: "2026-07-20T12:00:00.000Z",
  };
}

describe("createFirstEventIndex", () => {
  it("matches Array.findIndex for repeated and missing event ids", () => {
    const events = ["a", "b", "a", "c", "b"].map(projectedEvent);
    const firstEventIndex = createFirstEventIndex(events);

    for (const id of ["a", "b", "c", "missing"]) {
      expect(firstEventIndex(id)).toBe(events.findIndex((event) => event.id === id));
    }
  });

  it("does not visit the transcript until needed and indexes it only once", () => {
    let eventReads = 0;
    const source = ["a", "b", "c"].map(projectedEvent);
    const events = new Proxy(source, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) eventReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const firstEventIndex = createFirstEventIndex(events);

    expect(eventReads).toBe(0);
    expect(firstEventIndex("b")).toBe(1);
    expect(eventReads).toBe(source.length);
    expect(firstEventIndex("a")).toBe(0);
    expect(firstEventIndex("missing")).toBe(-1);
    expect(eventReads).toBe(source.length);
  });

  it("keeps findIndex equivalence across varied projected timelines", () => {
    let state = 0x10_0f_f1_ce;
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };

    for (let sample = 0; sample < 200; sample += 1) {
      const length = random() % 300;
      const events = Array.from({ length }, () => projectedEvent(`event-${random() % 31}`));
      const firstEventIndex = createFirstEventIndex(events);
      for (let id = 0; id < 32; id += 1) {
        const eventId = `event-${id}`;
        expect(firstEventIndex(eventId)).toBe(events.findIndex((event) => event.id === eventId));
      }
    }
  });
});
