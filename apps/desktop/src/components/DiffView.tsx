import { Check, FileCode2, MessageSquarePlus, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { highlightCodeLine } from "./codeHighlight";

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  rs: "Rust",
  py: "Python",
  css: "CSS",
  html: "HTML",
  json: "JSON",
  md: "Markdown",
  toml: "TOML",
  yml: "YAML",
  yaml: "YAML",
};

function languageForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXTENSION[extension] ?? "Plain text";
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}
import type { DiffFile, DiffLine } from "../bridge";

type DiffViewMode = "unified" | "split";

const INITIAL_DIFF_ROWS = 400;
const DIFF_ROW_CHUNK = 400;

export interface DiffViewProps {
  file: DiffFile;
  viewMode?: DiffViewMode;
  onViewModeChange?: (mode: DiffViewMode) => void;
  /**
   * Compact unified-only presentation for transcript-embedded diffs: file
   * name instead of the full path, no layout toggle, no review chrome.
   */
  variant?: "full" | "inline";
  /** A persisted review state owned by the task/project store. */
  reviewed?: boolean;
  onMarkReviewed?: (file: DiffFile) => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
  /** Hide task-level review actions when embedded in a transcript activity. */
  showReviewActions?: boolean;
  /** A caller-owned comment flow. It is intentionally absent until persistence exists. */
  onAddLineComment?: (input: { path: string; line: number }) => void;
}

function DiffCode({ line, path }: { line: DiffLine; path: string }) {
  const tokens = useMemo(
    () => line.tokens ?? highlightCodeLine(line.content, path),
    [line.content, line.tokens, path],
  );
  return (
    <>
      {tokens.map((token, index) => (
        <span className={`syntax-${token.kind}`} key={`${token.text}-${index}`}>
          {token.text}
        </span>
      ))}
    </>
  );
}

function CommentButton({
  file,
  line,
  onAddLineComment,
}: {
  file: DiffFile;
  line: DiffLine;
  onAddLineComment?: DiffViewProps["onAddLineComment"];
}) {
  const lineNumber = line.newNumber ?? line.oldNumber;
  if (!onAddLineComment || lineNumber === undefined) return null;

  return (
    <button
      className="line-comment-button"
      type="button"
      onClick={() => onAddLineComment({ path: file.path, line: lineNumber })}
      aria-label={`Comment on line ${lineNumber}`}
    >
      <MessageSquarePlus />
    </button>
  );
}

function ProgressiveDiffControls({
  shown,
  total,
  onShowMore,
  onShowAll,
}: {
  shown: number;
  total: number;
  onShowMore: () => void;
  onShowAll: () => void;
}) {
  if (shown >= total) return null;
  return (
    <div className="diff-progressive-controls">
      <span role="status" aria-live="polite">
        Showing {shown.toLocaleString()} of {total.toLocaleString()} diff rows
      </span>
      <button className="secondary-button" type="button" onClick={onShowMore}>
        Show next {Math.min(DIFF_ROW_CHUNK, total - shown).toLocaleString()} rows
      </button>
      <button className="secondary-button" type="button" onClick={onShowAll}>
        Show all {total.toLocaleString()} rows
      </button>
    </div>
  );
}

function UnifiedDiff({ file, onAddLineComment }: Pick<DiffViewProps, "file" | "onAddLineComment">) {
  const [rowLimit, setRowLimit] = useState(INITIAL_DIFF_ROWS);
  const visibleLines = file.lines.slice(0, rowLimit);
  return (
    <>
      <table className="diff-table diff-table--unified" aria-rowcount={file.lines.length}>
        <colgroup aria-hidden="true">
          <col className="diff-column-number" />
          <col className="diff-column-number" />
          <col className="diff-column-gutter" />
          <col className="diff-column-code" />
        </colgroup>
        <tbody>
          {visibleLines.map((line, index) => {
            if (line.kind === "hunk") {
              return (
                <tr className="diff-line diff-line--hunk" key={`${line.content}-${index}`}>
                  <th colSpan={4} scope="rowgroup">
                    {line.content}
                  </th>
                </tr>
              );
            }
            return (
              <tr
                className={`diff-line diff-line--${line.kind}`}
                key={`${line.oldNumber}-${line.newNumber}-${index}`}
              >
                <td className="diff-line-number">{line.oldNumber ?? ""}</td>
                <td className="diff-line-number">{line.newNumber ?? ""}</td>
                <td className="diff-gutter" aria-hidden="true">
                  {line.kind === "add" ? "+" : line.kind === "delete" ? "−" : " "}
                </td>
                <td className="diff-code">
                  <code>
                    <DiffCode line={line} path={file.path} />
                  </code>
                  <CommentButton file={file} line={line} onAddLineComment={onAddLineComment} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ProgressiveDiffControls
        shown={visibleLines.length}
        total={file.lines.length}
        onShowMore={() => setRowLimit((current) => current + DIFF_ROW_CHUNK)}
        onShowAll={() => setRowLimit(file.lines.length)}
      />
    </>
  );
}

interface SplitRow {
  key: string;
  hunk?: DiffLine;
  oldLine?: DiffLine;
  newLine?: DiffLine;
}

function buildSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === "hunk") {
      rows.push({ key: `hunk-${index}`, hunk: line });
      index += 1;
      continue;
    }
    if (line.kind === "context") {
      rows.push({ key: `context-${index}`, oldLine: line, newLine: line });
      index += 1;
      continue;
    }

    const deleted: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (lines[index]?.kind === "delete") deleted.push(lines[index++]);
    while (lines[index]?.kind === "add") added.push(lines[index++]);

    // Pair adjacent delete/add runs so replacements read as side-by-side changes.
    const length = Math.max(deleted.length, added.length);
    for (let offset = 0; offset < length; offset += 1) {
      rows.push({
        key: `change-${index}-${offset}`,
        oldLine: deleted[offset],
        newLine: added[offset],
      });
    }
  }
  return rows;
}

function SplitCell({
  side,
  line,
  file,
  onAddLineComment,
}: {
  side: "old" | "new";
  line?: DiffLine;
  file: DiffFile;
  onAddLineComment?: DiffViewProps["onAddLineComment"];
}) {
  const kind = line?.kind ?? "empty";
  const number = side === "old" ? line?.oldNumber : line?.newNumber;
  return (
    <>
      <td className={`diff-line-number diff-line-number--${side}`}>{number ?? ""}</td>
      <td className={`diff-split-code diff-split-code--${kind}`}>
        {line ? (
          <>
            <code>
              <DiffCode line={line} path={file.path} />
            </code>
            {side === "new" ? (
              <CommentButton file={file} line={line} onAddLineComment={onAddLineComment} />
            ) : null}
          </>
        ) : null}
      </td>
    </>
  );
}

function SplitDiff({ file, onAddLineComment }: Pick<DiffViewProps, "file" | "onAddLineComment">) {
  const rows = useMemo(() => buildSplitRows(file.lines), [file.lines]);
  const [rowLimit, setRowLimit] = useState(INITIAL_DIFF_ROWS);
  const visibleRows = rows.slice(0, rowLimit);
  return (
    <>
      <table className="diff-table diff-table--split" aria-rowcount={rows.length}>
        <colgroup aria-hidden="true">
          <col className="diff-column-number" />
          <col className="diff-column-code" />
          <col className="diff-column-number" />
          <col className="diff-column-code" />
        </colgroup>
        <tbody>
          {visibleRows.map((row) => {
            if (row.hunk) {
              return (
                <tr className="diff-line diff-line--hunk" key={row.key}>
                  <th colSpan={4} scope="rowgroup">
                    {row.hunk.content}
                  </th>
                </tr>
              );
            }
            return (
              <tr className="diff-line diff-line--split" key={row.key}>
                <SplitCell
                  side="old"
                  line={row.oldLine}
                  file={file}
                  onAddLineComment={onAddLineComment}
                />
                <SplitCell
                  side="new"
                  line={row.newLine}
                  file={file}
                  onAddLineComment={onAddLineComment}
                />
              </tr>
            );
          })}
        </tbody>
      </table>
      <ProgressiveDiffControls
        shown={visibleRows.length}
        total={rows.length}
        onShowMore={() => setRowLimit((current) => current + DIFF_ROW_CHUNK)}
        onShowAll={() => setRowLimit(rows.length)}
      />
    </>
  );
}

export function DiffView({
  file,
  viewMode = "unified",
  onViewModeChange,
  variant = "full",
  reviewed = false,
  onMarkReviewed,
  onRefresh,
  refreshing = false,
  showReviewActions = true,
  onAddLineComment,
}: DiffViewProps) {
  const canMarkReviewed = Boolean(onMarkReviewed);
  const inline = variant === "inline";
  const mode: DiffViewMode = inline ? "unified" : viewMode;
  return (
    <section
      className={`diff-workspace${inline ? " diff-workspace--inline" : ""}`}
      aria-label={`Diff for ${file.path}`}
      data-view={mode}
    >
      <header className="diff-header">
        <div className="diff-file-title">
          <FileCode2 />
          <span>
            <strong title={file.path}>{fileName(file.path)}</strong>
            {inline ? null : (
              <small className="diff-file-meta">
                <span className="diff-file-path">{file.path}</span>
                <span className="diff-file-meta-divider" aria-hidden="true">
                  ·
                </span>
                <span className="diff-comparison" aria-label="Working tree against HEAD">
                  Working tree <span aria-hidden="true">→</span> HEAD
                </span>
              </small>
            )}
          </span>
        </div>
        <div className="diff-summary">
          <span className="diff-add">{file.diffLoaded === false ? "…" : `+${file.additions}`}</span>
          {file.diffLoaded === false ? null : (
            <span className="diff-delete">−{file.deletions}</span>
          )}
        </div>
        {inline ? null : (
          <div className="diff-header-actions">
            {onRefresh ? (
              <button
                className="diff-header-icon-button"
                type="button"
                onClick={() => void onRefresh()}
                disabled={refreshing}
                aria-label={refreshing ? "Refreshing diff" : "Refresh diff"}
                title={refreshing ? "Refreshing diff" : "Refresh diff"}
              >
                <RefreshCw aria-hidden="true" />
              </button>
            ) : null}
            {onViewModeChange ? (
              <div className="diff-layout-toggle" role="group" aria-label="Diff layout">
                <button
                  type="button"
                  data-active={mode === "unified"}
                  onClick={() => onViewModeChange("unified")}
                  aria-pressed={mode === "unified"}
                >
                  Unified
                </button>
                <button
                  type="button"
                  data-active={mode === "split"}
                  onClick={() => onViewModeChange("split")}
                  aria-pressed={mode === "split"}
                >
                  Split
                </button>
              </div>
            ) : null}
            {showReviewActions ? (
              <button
                className="diff-review-button"
                type="button"
                data-reviewed={reviewed}
                onClick={() => void onMarkReviewed?.(file)}
                disabled={!canMarkReviewed}
                title={
                  canMarkReviewed
                    ? undefined
                    : "Review state will be available when it is stored with this task."
                }
              >
                <Check aria-hidden="true" /> {reviewed ? "Reviewed" : "Mark reviewed"}
              </button>
            ) : null}
          </div>
        )}
      </header>

      {file.truncated ? (
        <div className="diff-partial-warning" role="status">
          This diff exceeded the safe local preview limit. The visible review is partial.
        </div>
      ) : null}

      <div className="diff-scroll" data-view={mode}>
        {file.diffLoaded === false ? (
          <div className="route-loading" role="status" aria-live="polite">
            Loading diff…
          </div>
        ) : file.lines.length === 0 ? (
          <div className="diff-empty" role="status">
            No text changes are available for this file. It may be empty or binary.
          </div>
        ) : mode === "split" ? (
          <SplitDiff key={file.path} file={file} onAddLineComment={onAddLineComment} />
        ) : (
          <UnifiedDiff key={file.path} file={file} onAddLineComment={onAddLineComment} />
        )}
      </div>
      {inline ? null : (
        <footer className="diff-footer">
          <span>{reviewed ? "Reviewed" : "Not yet reviewed"}</span>
          <span>{languageForPath(file.path)}</span>
        </footer>
      )}
    </section>
  );
}
