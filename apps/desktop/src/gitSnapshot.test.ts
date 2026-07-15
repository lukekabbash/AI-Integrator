import { describe, expect, it } from "vitest";

import type { DiffFile, GitSnapshot } from "./bridge";
import { reconcileGitSnapshot } from "./gitSnapshot";

function file(path: string, additions = 1): DiffFile {
  return {
    path,
    status: "modified",
    additions,
    deletions: 0,
    staged: false,
    lines: [],
    diffLoaded: false,
  };
}

function snapshot(files: DiffFile[]): GitSnapshot {
  return {
    kind: "repository",
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    worktree: "/repo",
    remotes: [],
    files,
    commits: [],
  };
}

describe("live Git snapshot reconciliation", () => {
  it("returns the existing snapshot when a refresh has no visible changes", () => {
    const previous = snapshot([file("src/existing.ts")]);
    const reconciled = reconcileGitSnapshot(
      previous,
      snapshot([file("src/existing.ts")]),
      new Set(),
    );

    expect(reconciled).toBe(previous);
  });

  it("preserves unaffected loaded rows while adding a new file", () => {
    const loaded = { ...file("src/existing.ts"), diffLoaded: true };
    const previous = snapshot([loaded]);
    const reconciled = reconcileGitSnapshot(
      previous,
      snapshot([file("src/existing.ts"), file("src/new.ts")]),
      new Set(["src/new.ts"]),
    );

    expect(reconciled).not.toBe(previous);
    expect(reconciled.files[0]).toBe(loaded);
    expect(reconciled.files[1]?.path).toBe("src/new.ts");
  });

  it("invalidates a changed path even when its line counts stayed equal", () => {
    const loaded = { ...file("src/changed.ts"), diffLoaded: true };
    const refreshed = file("src/changed.ts");
    const reconciled = reconcileGitSnapshot(
      snapshot([loaded]),
      snapshot([refreshed]),
      new Set(["src/changed.ts"]),
    );

    expect(reconciled.files[0]).toBe(refreshed);
  });
});
