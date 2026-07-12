import { Check, Columns2, FileCode2, MessageSquarePlus, Rows3 } from "lucide-react";

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
import type { DiffFile, DiffLine } from "../bridge";

type DiffViewMode = "unified" | "split";

export interface DiffViewProps {
  file: DiffFile;
  viewMode: DiffViewMode;
  onViewModeChange: (mode: DiffViewMode) => void;
  /** A persisted review state owned by the task/project store. */
  reviewed?: boolean;
  onMarkReviewed?: (file: DiffFile) => void | Promise<void>;
  /** A caller-owned comment flow. It is intentionally absent until persistence exists. */
  onAddLineComment?: (input: { path: string; line: number }) => void;
}

function DiffCode({ line }: { line: DiffLine }) {
  if (!line.tokens) return <>{line.content || " "}</>;
  return (
    <>
      {line.tokens.map((token, index) => (
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

function UnifiedDiff({ file, onAddLineComment }: Pick<DiffViewProps, "file" | "onAddLineComment">) {
  return (
    <table className="diff-table diff-table--unified">
      <tbody>
        {file.lines.map((line, index) => {
          if (line.kind === "hunk") {
            return (
              <tr className="diff-line diff-line--hunk" key={`${line.content}-${index}`}>
                <td colSpan={4}>{line.content}</td>
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
                  <DiffCode line={line} />
                </code>
                <CommentButton file={file} line={line} onAddLineComment={onAddLineComment} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
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
              <DiffCode line={line} />
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
  return (
    <table className="diff-table diff-table--split">
      <tbody>
        {buildSplitRows(file.lines).map((row) => {
          if (row.hunk) {
            return (
              <tr className="diff-line diff-line--hunk" key={row.key}>
                <td colSpan={4}>{row.hunk.content}</td>
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
  );
}

export function DiffView({
  file,
  viewMode,
  onViewModeChange,
  reviewed = false,
  onMarkReviewed,
  onAddLineComment,
}: DiffViewProps) {
  const canMarkReviewed = Boolean(onMarkReviewed);
  return (
    <section className="diff-workspace" aria-label={`Diff for ${file.path}`} data-view={viewMode}>
      <header className="diff-header">
        <div className="diff-file-title">
          <FileCode2 />
          <span>
            <strong>{file.path.split("/").at(-1)}</strong>
            <small>{file.path}</small>
          </span>
        </div>
        <div className="diff-summary">
          <span className="diff-add">+{file.additions}</span>
          <span className="diff-delete">−{file.deletions}</span>
        </div>
        <div className="segmented compact" aria-label="Diff layout">
          <button
            type="button"
            data-active={viewMode === "unified"}
            onClick={() => onViewModeChange("unified")}
            aria-pressed={viewMode === "unified"}
          >
            <Rows3 /> Unified
          </button>
          <button
            type="button"
            data-active={viewMode === "split"}
            onClick={() => onViewModeChange("split")}
            aria-pressed={viewMode === "split"}
          >
            <Columns2 /> Split
          </button>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void onMarkReviewed?.(file)}
          disabled={!canMarkReviewed}
          title={
            canMarkReviewed
              ? undefined
              : "Review state will be available when it is stored with this task."
          }
        >
          <Check /> {reviewed ? "Reviewed" : "Mark reviewed"}
        </button>
      </header>

      <div className="diff-context-bar">
        <span>Working tree</span>
        <span className="diff-context-separator">against</span>
        <span>HEAD</span>
      </div>

      <div className="diff-scroll" data-view={viewMode}>
        {viewMode === "split" ? (
          <SplitDiff file={file} onAddLineComment={onAddLineComment} />
        ) : (
          <UnifiedDiff file={file} onAddLineComment={onAddLineComment} />
        )}
      </div>
      <footer className="diff-footer">
        <span>{reviewed ? "Reviewed" : "Not yet reviewed"}</span>
        <span>{languageForPath(file.path)}</span>
      </footer>
    </section>
  );
}
