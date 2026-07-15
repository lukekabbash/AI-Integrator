/**
 * Holds back trailing incomplete markdown so CommonMark does not promote the
 * previous paragraph into a setext heading while list bullets are still streaming.
 *
 * CommonMark treats a lone `-` / `=` line under a paragraph as a setext underline.
 * Mid-stream that looks like a nascent bullet (`Intro\n-`) and flashes the intro
 * as an `<h2>` until the first list-item character arrives.
 */

function isIncompleteMarkerLine(line: string): boolean {
  // Up to 3 spaces of indent, then only a setext underline or bare list marker
  // (no item text yet). Trailing spaces are allowed.
  return /^[ \t]{0,3}(?:=+|-+|[*+]|\d{1,9}[.)])[ \t]*$/.test(line);
}

function isThematicBreakLine(line: string): boolean {
  const trimmed = line.replace(/^[ \t]{0,3}/, "").replace(/[ \t]+$/g, "");
  return /^([-*_])(?:[ \t]*\1){2,}$/.test(trimmed);
}

function isHoldableTrailingLine(line: string): boolean {
  return isIncompleteMarkerLine(line) || isThematicBreakLine(line);
}

function previousLineIsBlank(body: string, lastNewline: number): boolean {
  if (lastNewline <= 0) return true;
  const previousNewline = body.lastIndexOf("\n", lastNewline - 1);
  const previousLine = body.slice(previousNewline + 1, lastNewline);
  return /^[ \t]*$/.test(previousLine);
}

/**
 * Returns markdown that avoids setext/list-marker parse thrash.
 *
 * While `streaming` is true, bare trailing markers (including thematic-break
 * candidates) are held back. Once the turn finishes, a real thematic break
 * after a blank line is allowed through; a lone `-` after a paragraph is still
 * held so aborted streams do not flash an `<h2>`.
 */
export function stabilizeStreamingMarkdown(body: string, streaming = true): string {
  if (!body) return body;

  const lastNewline = body.lastIndexOf("\n");
  if (lastNewline < 0) {
    return isHoldableTrailingLine(body) ? "" : body;
  }

  const lastLine = body.slice(lastNewline + 1);
  if (!isHoldableTrailingLine(lastLine)) return body;

  if (
    !streaming &&
    isThematicBreakLine(lastLine) &&
    previousLineIsBlank(body, lastNewline)
  ) {
    return body;
  }

  // Drop the incomplete marker line and the newline that introduced it.
  return body.slice(0, lastNewline);
}
