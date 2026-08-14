import type { GitCommit } from "../bridge";

export const COMMIT_GRAPH_MAX_LANES = 6;

export interface CommitGraphEdge {
  from: number;
  to: number;
  node: boolean;
}

export interface CommitGraphRow {
  lane: number;
  incoming: CommitGraphEdge[];
  outgoing: CommitGraphEdge[];
  laneCount: number;
}

/** Assign stable graph lanes while commits join, fork, and leave the visible log. */
export function buildCommitGraph(commits: GitCommit[]): CommitGraphRow[] {
  const lanes: Array<string | null> = [];
  return commits.map((commit) => {
    const expecting = lanes.flatMap((hash, index) => (hash === commit.id ? [index] : []));
    let lane = expecting.length ? expecting[0] : lanes.indexOf(null);
    if (lane === -1) lane = lanes.length;
    const incoming: CommitGraphEdge[] = [];
    lanes.forEach((hash, index) => {
      if (hash === null) return;
      if (hash === commit.id) incoming.push({ from: index, to: lane, node: true });
      else incoming.push({ from: index, to: index, node: false });
    });
    for (const index of expecting) lanes[index] = null;
    const parents = commit.parents ?? [];
    const outgoing: CommitGraphEdge[] = [];
    if (parents.length) {
      lanes[lane] = parents[0];
      outgoing.push({ from: lane, to: lane, node: true });
      for (const parent of parents.slice(1)) {
        let parentLane = lanes.indexOf(parent);
        if (parentLane === -1) {
          parentLane = lanes.indexOf(null);
          if (parentLane === -1) parentLane = lanes.length;
          lanes[parentLane] = parent;
        }
        outgoing.push({ from: lane, to: parentLane, node: true });
      }
    } else {
      lanes[lane] = null;
    }
    lanes.forEach((hash, index) => {
      if (hash === null || index === lane) return;
      if (outgoing.some((edge) => edge.node && edge.to === index)) return;
      outgoing.push({ from: index, to: index, node: false });
    });
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    const laneCount = [...incoming, ...outgoing].reduce(
      (max, edge) => Math.max(max, edge.from + 1, edge.to + 1),
      lane + 1,
    );
    return {
      lane,
      incoming,
      outgoing,
      laneCount: Math.min(laneCount, COMMIT_GRAPH_MAX_LANES),
    };
  });
}

export interface CommitRefChip {
  label: string;
  kind: "local" | "remote" | "tag" | "more";
  title?: string;
}

/** Reduce raw Git decorations to the two useful chips shown in the rail. */
export function collapseCommitRefs(
  refs: string[],
  upstream: string,
  branch: string,
): CommitRefChip[] {
  const remote = upstream.includes("/") ? `${upstream.split("/")[0]}/` : "origin/";
  const names = refs.filter((name) => !name.endsWith("/HEAD"));
  const consumed = new Set<string>();
  if (names.includes(branch)) {
    consumed.add(branch);
    consumed.add(`${remote}${branch}`);
    consumed.add(`origin/${branch}`);
  }
  const chips: CommitRefChip[] = [];
  for (const name of names) {
    if (consumed.has(name)) continue;
    if (name.startsWith("tag: ")) {
      chips.push({ label: name.slice(5), kind: "tag" });
      continue;
    }
    if (name.startsWith(remote) || name.startsWith("origin/")) {
      chips.push({ label: name, kind: "remote" });
      continue;
    }
    const twin = names.find(
      (candidate) => candidate === `${remote}${name}` || candidate === `origin/${name}`,
    );
    if (twin) consumed.add(twin);
    chips.push({ label: name, kind: "local", title: twin ? `${name} · also at ${twin}` : name });
  }
  if (chips.length > 2) {
    const extra = chips.splice(2);
    chips.push({
      label: `+${extra.length}`,
      kind: "more",
      title: extra.map((chip) => chip.label).join(", "),
    });
  }
  return chips;
}
