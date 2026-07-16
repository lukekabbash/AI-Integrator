import { describe, expect, it } from "vitest";
import type { RuntimeId } from "./bridge";
import { COMMIT_MESSAGE_SETTINGS, resolveCommitMessageRoute } from "./commitMessageSettings";

const AVAILABLE: RuntimeId[] = ["codex", "claude", "grok"];

describe("resolveCommitMessageRoute", () => {
  it("returns null until both a runtime and a model are chosen", () => {
    expect(resolveCommitMessageRoute({}, AVAILABLE)).toBeNull();
    expect(
      resolveCommitMessageRoute(
        { [COMMIT_MESSAGE_SETTINGS.runtime]: "codex" },
        AVAILABLE,
      ),
    ).toBeNull();
    expect(
      resolveCommitMessageRoute(
        { [COMMIT_MESSAGE_SETTINGS.runtime]: "codex", [COMMIT_MESSAGE_SETTINGS.model]: "   " },
        AVAILABLE,
      ),
    ).toBeNull();
  });

  it("returns the pinned route with fallbacks that exclude the primary", () => {
    expect(
      resolveCommitMessageRoute(
        {
          [COMMIT_MESSAGE_SETTINGS.runtime]: "claude",
          [COMMIT_MESSAGE_SETTINGS.model]: "claude-opus-4-8",
          [COMMIT_MESSAGE_SETTINGS.effort]: "high",
          [COMMIT_MESSAGE_SETTINGS.fallbacks]: ["claude", "codex", "grok"],
        },
        AVAILABLE,
      ),
    ).toEqual({
      runtime: "claude",
      model: "claude-opus-4-8",
      effort: "high",
      fallbacks: ["codex", "grok"],
    });
  });

  it("ignores a runtime that is no longer available", () => {
    expect(
      resolveCommitMessageRoute(
        {
          [COMMIT_MESSAGE_SETTINGS.runtime]: "cursor",
          [COMMIT_MESSAGE_SETTINGS.model]: "any",
        },
        AVAILABLE,
      ),
    ).toBeNull();
  });
});
