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

/**
 * A GFM delimiter row (e.g. `|---|---|`), which is specific enough to the
 * table grammar that matching one on a line proves the line is a table.
 * Ordinary text or code containing `||` (e.g. `a || b`) never matches this.
 */
const TABLE_DELIMITER_ROW = /\|(?:\s*:?-+:?\s*\|){2,}/;

function repairGluedTableRow(line: string): string {
  if (!TABLE_DELIMITER_ROW.test(line)) return line;
  // Row boundaries glued together always look like `|` immediately followed
  // by the next row's `|` (any cell padding stays outside the pair), so
  // splitting on that is safe once the line is confirmed to be a table. The
  // lookahead keeps the match zero-width so back-to-back boundaries (an
  // empty cell landing exactly on a row seam) still both split.
  return line.replace(/\|(?=\|)/g, "|\n");
}

const TABLE_ROW_LINE = /^\s*\|.*\|\s*$/;

/**
 * A table absorbs any non-blank line that follows it with no blank line in
 * between, folding trailing prose into a phantom extra row instead of
 * letting it end the table. Insert the blank line providers omit so prose
 * right after a table stays a paragraph.
 */
function ensureBlankLineAfterTables(lines: string[]): string[] {
  const result: string[] = [];
  let tableRun: string[] = [];
  let runHasDelimiter = false;

  for (const line of lines) {
    if (TABLE_ROW_LINE.test(line)) {
      tableRun.push(line);
      if (TABLE_DELIMITER_ROW.test(line)) runHasDelimiter = true;
      continue;
    }
    if (tableRun.length > 0) {
      result.push(...tableRun);
      if (runHasDelimiter && line.trim() !== "") result.push("");
      tableRun = [];
      runHasDelimiter = false;
    }
    result.push(line);
  }
  result.push(...tableRun);
  return result;
}

/**
 * Some providers stream a whole GFM table (header, delimiter, and data rows)
 * without the newlines CommonMark needs to tell the rows apart, and without
 * the blank line that keeps trailing prose from being absorbed as another
 * row. remark-gfm then either can't recognize a table at all and prints the
 * raw pipes/dashes as literal text, or folds the next sentence into it as a
 * phantom row. Both repairs are scoped to lines a confirmed delimiter row
 * proves are actually part of a table, so neither can touch unrelated
 * content (e.g. `a || b` in a code sample) elsewhere in the message.
 */
export function repairStreamedTables(body: string): string {
  if (!body.includes("|")) return body;
  const rowsSplit = body.split("\n").map(repairGluedTableRow).join("\n");
  return ensureBlankLineAfterTables(rowsSplit.split("\n")).join("\n");
}
