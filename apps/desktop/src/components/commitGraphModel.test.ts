import { describe, expect, it } from "vitest";
import type { GitCommit } from "../bridge";
import { buildCommitGraph, collapseCommitRefs } from "./commitGraphModel";

function commit(id: string, parents: string[] = []): GitCommit {
  return { id, parents, subject: id, relativeTime: "now" };
}

describe("commit graph model", () => {
  it("keeps forked parent lanes connected through a later merge", () => {
    const rows = buildCommitGraph([
      commit("tip", ["left", "right"]),
      commit("left", ["base"]),
      commit("right", ["base"]),
      commit("base"),
    ]);

    expect(rows.map((row) => ({ lane: row.lane, laneCount: row.laneCount }))).toEqual([
      { lane: 0, laneCount: 2 },
      { lane: 0, laneCount: 2 },
      { lane: 1, laneCount: 2 },
      { lane: 0, laneCount: 2 },
    ]);
    expect(rows[3]?.incoming.filter((edge) => edge.node)).toEqual([
      { from: 0, to: 0, node: true },
      { from: 1, to: 0, node: true },
    ]);
  });

  it("folds current and remote twins without hiding distinct refs", () => {
    expect(
      collapseCommitRefs(
        ["main", "origin/main", "feature", "origin/feature", "tag: v1", "origin/HEAD"],
        "origin/main",
        "main",
      ),
    ).toEqual([
      { label: "feature", kind: "local", title: "feature · also at origin/feature" },
      { label: "v1", kind: "tag" },
    ]);
    expect(collapseCommitRefs(["one", "two", "three"], "origin/main", "main")).toEqual([
      { label: "one", kind: "local", title: "one" },
      { label: "two", kind: "local", title: "two" },
      { label: "+1", kind: "more", title: "three" },
    ]);
  });
});
