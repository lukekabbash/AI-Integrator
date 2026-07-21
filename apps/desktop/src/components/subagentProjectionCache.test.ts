import { describe, expect, it } from "vitest";
import { createRuntimeProjectionState } from "../runtimeProjection";
import { SubagentProjectionCache } from "./subagentProjectionCache";

describe("SubagentProjectionCache", () => {
  it("bounds retained child transcripts and keeps recently updated entries", () => {
    const cache = new SubagentProjectionCache(2);
    cache.set("task-1", createRuntimeProjectionState("task-1"));
    cache.set("task-2", createRuntimeProjectionState("task-2"));
    cache.set("task-1", { ...createRuntimeProjectionState("task-1"), lastSeq: 3 });
    cache.set("task-1", { ...createRuntimeProjectionState("task-1"), lastSeq: 2 });
    cache.set("task-3", createRuntimeProjectionState("task-3"));

    expect(cache.get("task-1")?.lastSeq).toBe(3);
    expect(cache.get("task-2")).toBeUndefined();
    expect(cache.get("task-3")).toBeDefined();
  });
});
