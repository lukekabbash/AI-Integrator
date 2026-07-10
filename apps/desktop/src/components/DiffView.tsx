import { Check, ChevronDown, Columns2, FileCode2, MessageSquarePlus, Rows3 } from "lucide-react";
import type { DiffFile, DiffLine } from "../bridge";

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

export function DiffView({
  file,
  viewMode,
  onViewModeChange,
}: {
  file: DiffFile;
  viewMode: "unified" | "split";
  onViewModeChange: (mode: "unified" | "split") => void;
}) {
  return (
    <section className="diff-workspace" aria-label={`Diff for ${file.path}`}>
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
        <button className="secondary-button" type="button">
          <Check /> Mark reviewed
        </button>
      </header>

      <div className="diff-context-bar">
        <span>Working tree</span>
        <ChevronDown />
        <span className="diff-context-separator">against</span>
        <span>HEAD</span>
        <ChevronDown />
      </div>

      <div className="diff-scroll" data-view={viewMode}>
        <table className="diff-table">
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
                    <button
                      className="line-comment-button"
                      type="button"
                      aria-label={`Comment on line ${line.newNumber ?? line.oldNumber}`}
                    >
                      <MessageSquarePlus />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <footer className="diff-footer">
        <span>Whitespace changes visible</span>
        <span>UTF-8 · LF · TypeScript</span>
      </footer>
    </section>
  );
}
