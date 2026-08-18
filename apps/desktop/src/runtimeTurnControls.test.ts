import { describe, expect, it } from "vitest";

import { normalizeRuntimeTurnControls } from "./runtimeTurnControls";

describe("normalizeRuntimeTurnControls", () => {
  it("normalizes stale Antigravity controls on non-Composer send paths", () => {
    expect(
      normalizeRuntimeTurnControls({
        runtime: "antigravity",
        permission: "ask",
        delegation: "balanced",
        prompt: "retry",
      }),
    ).toEqual({
      runtime: "antigravity",
      permission: "project-write",
      delegation: "off",
      prompt: "retry",
    });
  });

  it("preserves controls for providers with interactive approval and delegation", () => {
    const input = {
      runtime: "claude" as const,
      permission: "ask" as const,
      delegation: "balanced" as const,
    };
    expect(normalizeRuntimeTurnControls(input)).toBe(input);
  });
});
