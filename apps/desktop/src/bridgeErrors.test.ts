import { describe, expect, it } from "vitest";
import { formatBridgeError, isStaleProviderResumeError } from "./bridgeErrors";

describe("isStaleProviderResumeError", () => {
  it("treats a mismatched saved handle as stale so the turn can start fresh", () => {
    expect(
      isStaleProviderResumeError({
        code: "not-found",
        message: "The saved provider session does not match this task and workspace",
      }),
    ).toBe(true);
    expect(
      isStaleProviderResumeError({
        code: "unauthorized",
        message: "The saved provider session does not match this task and workspace (unauthorized)",
      }),
    ).toBe(true);
    expect(
      isStaleProviderResumeError({
        code: "unauthorized",
        message: "provider working directory does not match this task's project/worktree",
      }),
    ).toBe(false);
  });

  it("keeps the existing missing-session and MCP-revision cases", () => {
    expect(
      isStaleProviderResumeError({
        code: "not-found",
        message: "This task has no saved provider session to resume",
      }),
    ).toBe(true);
    expect(
      isStaleProviderResumeError({
        code: "not-found",
        message: "The saved provider session predates the current MCP configuration",
      }),
    ).toBe(true);
    expect(formatBridgeError({ code: "not-found", message: "nope" }, "fallback")).toBe(
      "nope (not-found)",
    );
  });
});
