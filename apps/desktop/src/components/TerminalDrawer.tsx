import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CircleStop } from "lucide-react";
import {
  bridge,
  type ProjectSummary,
  type TerminalOutputEvent,
  type TerminalSessionInfo,
} from "../bridge";

interface TerminalLine {
  id: number;
  kind: "command" | "stdout" | "stderr" | "notice";
  text: string;
}

const MAX_SCROLLBACK_LINES = 2_000;
const INITIAL_RENDERED_LINES = 400;
const SCROLLBACK_CHUNK = 400;
const FOLLOW_THRESHOLD_PX = 48;

function promptFor(shell: string | undefined, cwd: string): string {
  return shell === "PowerShell" ? `PS ${cwd}>` : `${cwd}$`;
}

/**
 * An interactive command runner scoped to the open project. Each command
 * executes in the trusted repository (the backend confines `cd` to it), so
 * this stays a project terminal rather than a general system shell.
 */
export function TerminalDrawer({
  open,
  project,
  onClose,
}: {
  open: boolean;
  project: ProjectSummary;
  onClose: () => void;
}) {
  const [session, setSession] = useState<TerminalSessionInfo | null>(null);
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState("");
  const [cwd, setCwd] = useState(project.path);
  const [history, setHistory] = useState<string[]>([]);
  const [renderedLineLimit, setRenderedLineLimit] = useState(INITIAL_RENDERED_LINES);
  const [frozenEndId, setFrozenEndId] = useState<number | null>(null);
  const historyCursor = useRef(-1);
  const opening = useRef(false);
  const nextLineId = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingLinesRef = useRef<Array<Omit<TerminalLine, "id">>>([]);
  const pendingFrameRef = useRef<number | null>(null);
  const pendingAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  const flushPendingLines = useCallback(() => {
    pendingFrameRef.current = null;
    const pending = pendingLinesRef.current.splice(0);
    if (!pending.length) return;
    const appended = pending.map((line) => ({ ...line, id: nextLineId.current++ }));
    setLines((current) => [...current, ...appended].slice(-MAX_SCROLLBACK_LINES));
  }, []);

  const appendLine = useCallback(
    (kind: TerminalLine["kind"], text: string) => {
      pendingLinesRef.current.push({ kind, text });
      if (pendingFrameRef.current === null) {
        pendingFrameRef.current = window.requestAnimationFrame(flushPendingLines);
      }
    },
    [flushPendingLines],
  );

  useEffect(() => {
    if (!open || session || unavailableReason || opening.current) return;
    opening.current = true;
    let active = true;
    void bridge
      .openTerminal(project.id)
      .then((info) => {
        if (!active) return;
        setSession(info);
        setCwd(info.cwd);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setUnavailableReason(
          error instanceof Error ? error.message : "The terminal could not be opened.",
        );
      })
      .finally(() => {
        opening.current = false;
      });
    return () => {
      active = false;
    };
  }, [open, session, unavailableReason, project.id]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void bridge
      .subscribeTerminalOutput((event: TerminalOutputEvent) => {
        if (event.sessionId !== session.id) return;
        if (event.stream === "exit") {
          setRunning(false);
          setCwd(event.cwd);
          if (event.exitCode === undefined || event.exitCode === null) {
            appendLine("notice", "Command interrupted");
          } else if (event.exitCode !== 0) {
            appendLine("notice", `Exited with code ${event.exitCode}`);
          }
          inputRef.current?.focus();
          return;
        }
        if (event.line !== undefined) {
          appendLine(event.stream === "stderr" ? "stderr" : "stdout", event.line);
        }
      })
      .then((dispose) => {
        if (active) unlisten = dispose;
        else dispose();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [appendLine, session]);

  useEffect(
    () => () => {
      if (pendingFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingFrameRef.current);
      }
      pendingLinesRef.current = [];
    },
    [],
  );

  // The backend session dies with this drawer (project switch or app
  // navigation), never on a visibility toggle, so scrollback survives.
  useEffect(() => {
    if (!session) return;
    return () => {
      void bridge.closeTerminal(session.id).catch(() => undefined);
    };
  }, [session]);

  useEffect(() => {
    const body = bodyRef.current;
    if (body && frozenEndId === null) body.scrollTop = body.scrollHeight;
  }, [frozenEndId, lines]);

  useLayoutEffect(() => {
    const pendingAnchor = pendingAnchorRef.current;
    const body = bodyRef.current;
    if (!pendingAnchor || !body) return;
    pendingAnchorRef.current = null;
    body.scrollTop =
      pendingAnchor.scrollTop + Math.max(0, body.scrollHeight - pendingAnchor.scrollHeight);
  }, [renderedLineLimit]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const runCommand = async () => {
    const command = input.trim();
    if (!command || !session || running) return;
    setInput("");
    historyCursor.current = -1;
    setHistory((current) =>
      current.at(-1) === command ? current : [...current.slice(-99), command],
    );
    appendLine("command", `${promptFor(session.shell, cwd)} ${command}`);
    try {
      const started = await bridge.runTerminalCommand(session.id, command);
      setCwd(started.cwd);
      if (started.runId) setRunning(true);
    } catch (error: unknown) {
      appendLine("stderr", error instanceof Error ? error.message : "The command did not start.");
    }
  };

  const recallHistory = (direction: 1 | -1) => {
    if (history.length === 0) return;
    const cursor =
      historyCursor.current === -1 && direction === -1
        ? history.length - 1
        : Math.min(Math.max(historyCursor.current + direction, 0), history.length - 1);
    if (historyCursor.current === -1 && direction === 1) return;
    historyCursor.current = cursor;
    setInput(history[cursor] ?? "");
  };

  const stop = () => {
    if (!session) return;
    void bridge.interruptTerminal(session.id).catch(() => undefined);
  };

  const frozenIndex =
    frozenEndId === null ? -1 : lines.findIndex((line) => line.id === frozenEndId);
  const visibleEnd = frozenIndex >= 0 ? frozenIndex + 1 : lines.length;
  const visibleStart = Math.max(0, visibleEnd - renderedLineLimit);
  const visibleLines = useMemo(
    () => lines.slice(visibleStart, visibleEnd),
    [lines, visibleEnd, visibleStart],
  );
  const hiddenEarlierCount = visibleStart;
  const pendingLatestCount = lines.length - visibleEnd;

  const revealEarlier = (all: boolean) => {
    const body = bodyRef.current;
    if (body) {
      pendingAnchorRef.current = { scrollHeight: body.scrollHeight, scrollTop: body.scrollTop };
    }
    setRenderedLineLimit(all ? visibleEnd : renderedLineLimit + SCROLLBACK_CHUNK);
  };

  const jumpToLatest = () => {
    setFrozenEndId(null);
    window.requestAnimationFrame(() => {
      if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    });
  };

  if (!open) return null;

  return (
    <section
      className="terminal-drawer"
      aria-label="Project terminal"
      onKeyDown={(event) => {
        // The command input is disabled while a command runs, so the
        // interrupt shortcut must live on the drawer itself.
        if (event.key === "c" && event.ctrlKey && running) {
          event.preventDefault();
          stop();
        }
      }}
    >
      <header className="terminal-header">
        <strong>Terminal</strong>
        <span>
          {project.name}
          {session ? ` · ${session.shell}` : ""}
        </span>
        {running ? (
          <button className="terminal-stop" type="button" onClick={stop} aria-label="Stop command">
            <CircleStop aria-hidden="true" /> Stop
          </button>
        ) : null}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      {hiddenEarlierCount > 0 || pendingLatestCount > 0 ? (
        <div className="terminal-scrollback-controls">
          {hiddenEarlierCount > 0 ? (
            <>
              <span role="status">
                Showing {visibleLines.length.toLocaleString()} of {visibleEnd.toLocaleString()}{" "}
                saved lines
              </span>
              <button
                className="secondary-button"
                type="button"
                onClick={() => revealEarlier(false)}
              >
                Show earlier {Math.min(SCROLLBACK_CHUNK, hiddenEarlierCount).toLocaleString()} lines
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => revealEarlier(true)}
              >
                Show all {visibleEnd.toLocaleString()} saved lines
              </button>
            </>
          ) : null}
          {pendingLatestCount > 0 ? (
            <button className="secondary-button" type="button" onClick={jumpToLatest}>
              {pendingLatestCount.toLocaleString()} new lines · Jump to latest
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        className="terminal-body"
        role="log"
        aria-live="polite"
        ref={bodyRef}
        onScroll={(event) => {
          const body = event.currentTarget;
          const atLatest =
            body.scrollHeight - body.scrollTop - body.clientHeight <= FOLLOW_THRESHOLD_PX;
          if (!atLatest && frozenEndId === null) {
            setFrozenEndId(lines.at(-1)?.id ?? null);
          } else if (atLatest && frozenEndId !== null) {
            setFrozenEndId(null);
          }
        }}
      >
        {unavailableReason ? <p className="terminal-notice">{unavailableReason}</p> : null}
        {!unavailableReason && !session ? (
          <p className="terminal-notice">Opening terminal…</p>
        ) : null}
        {visibleLines.map((line) => (
          <p key={line.id} className={`terminal-line--${line.kind}`}>
            {line.kind === "command" ? (
              <span className="terminal-command">{line.text}</span>
            ) : (
              line.text
            )}
          </p>
        ))}
      </div>
      {session ? (
        <form
          className="terminal-input-row"
          onSubmit={(event) => {
            event.preventDefault();
            void runCommand();
          }}
        >
          <span className="terminal-command" aria-hidden="true">
            {promptFor(session.shell, cwd)}
          </span>
          <input
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp") {
                event.preventDefault();
                recallHistory(-1);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                recallHistory(1);
              }
            }}
            placeholder={running ? "A command is running…" : "Type a command and press Enter"}
            aria-label="Terminal command"
            disabled={running}
            spellCheck={false}
            autoComplete="off"
          />
        </form>
      ) : null}
    </section>
  );
}
