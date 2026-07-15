import { diffFileKey, type DiffFile, type GitSnapshot } from "./bridge";

function sameFileSummary(left: DiffFile, right: DiffFile): boolean {
  return (
    left.path === right.path &&
    left.status === right.status &&
    left.staged === right.staged &&
    left.additions === right.additions &&
    left.deletions === right.deletions &&
    left.statsLoaded === right.statsLoaded
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Keeps live Git refreshes surgical. Paths reported by the provider are
 * invalidated so an open diff can reload; every unaffected row retains its
 * object identity and loaded patch. If nothing visible changed, the previous
 * snapshot itself is returned and React has no update to render.
 */
export function reconcileGitSnapshot(
  previous: GitSnapshot | undefined,
  incoming: GitSnapshot,
  invalidatedPaths?: ReadonlySet<string>,
): GitSnapshot {
  if (!previous || previous.kind !== incoming.kind) return incoming;

  const previousFiles = new Map(previous.files.map((file) => [diffFileKey(file), file]));
  const files = incoming.files.map((file) => {
    if (!invalidatedPaths || invalidatedPaths.has(file.path)) return file;
    const existing = previousFiles.get(diffFileKey(file));
    return existing && sameFileSummary(existing, file) ? existing : file;
  });
  const remotes = sameValue(previous.remotes, incoming.remotes)
    ? previous.remotes
    : incoming.remotes;
  const commits = sameValue(previous.commits, incoming.commits)
    ? previous.commits
    : incoming.commits;
  const filesUnchanged =
    files.length === previous.files.length &&
    files.every((file, index) => file === previous.files[index]);

  if (
    filesUnchanged &&
    remotes === previous.remotes &&
    commits === previous.commits &&
    previous.branch === incoming.branch &&
    previous.upstream === incoming.upstream &&
    previous.ahead === incoming.ahead &&
    previous.behind === incoming.behind &&
    previous.worktree === incoming.worktree &&
    previous.historyHasMore === incoming.historyHasMore
  ) {
    return previous;
  }

  return { ...incoming, files, remotes, commits };
}
