/**
 * Naming for copied and branched chats: `{base}: Copy 1`, `{base}: Branch 2`.
 *
 * The marker trails the name so the sidebar leads with identity, and the row
 * renders the two halves separately so an ellipsis eats the name rather than
 * the marker that distinguishes the copy from its original.
 */

export type ForkKind = "Copy" | "Branch";

/** Mirrors the store's own limit, which rejects anything longer. */
const TITLE_MAX_CHARS = 240;

const FORK_TITLE = /^(.*\S)\s*:\s*(Copy|Branch)\s+(\d+)$/;

export interface ParsedForkTitle {
  /** The source title with the fork marker stripped. */
  base: string;
  kind: ForkKind;
  index: number;
}

/** Splits a fork marker off a title, or returns null for an ordinary one. */
export function parseForkTitle(title: string): ParsedForkTitle | null {
  const match = FORK_TITLE.exec(title.trim());
  if (!match) return null;
  const index = Number(match[3]);
  if (!Number.isSafeInteger(index) || index < 1) return null;
  return { base: match[1], kind: match[2] as ForkKind, index };
}

/** The title without its fork marker, so copies of copies stay one level deep. */
export function forkTitleBase(title: string): string {
  return parseForkTitle(title)?.base ?? title.trim();
}

function clampToTitleLimit(base: string, suffix: string): string {
  const full = `${base}${suffix}`;
  if (full.length <= TITLE_MAX_CHARS) return full;
  // Truncating the base rather than the suffix keeps the copy distinguishable
  // from its original, which is the whole point of the marker.
  return `${base.slice(0, Math.max(1, TITLE_MAX_CHARS - suffix.length)).trimEnd()}${suffix}`;
}

/**
 * Names a new fork of `sourceTitle`, numbering past any existing fork of the
 * same base and kind in `existingTitles`.
 *
 * Copies of copies strip and increment rather than nest, so forking
 * `Parser: Copy 1` yields `Parser: Copy 2`, not `Parser: Copy 1: Copy 1`.
 * Kinds count separately, so `Parser: Copy 1` and `Parser: Branch 1` coexist.
 */
export function nextForkTitle(
  sourceTitle: string,
  kind: ForkKind,
  existingTitles: Iterable<string>,
): string {
  const base = forkTitleBase(sourceTitle);
  let highest = 0;
  for (const title of existingTitles) {
    const parsed = parseForkTitle(title);
    if (parsed?.kind === kind && parsed.base === base) {
      highest = Math.max(highest, parsed.index);
    }
  }
  return clampToTitleLimit(base, `: ${kind} ${highest + 1}`);
}
