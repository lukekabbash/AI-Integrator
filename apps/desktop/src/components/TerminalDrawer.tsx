import { useEffect, useRef, useState } from "react";
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
  const historyCursor = useRef(-1);
  const opening = useRef(false);
  const nextLineId = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const appendLine = (kind: TerminalLine["kind"], text: string) => {
    setLines((current) => [
      ...current.slice(-(MAX_SCROLLBACK_LINES - 1)),
      { id: nextLineId.current++, kind, text },
    ]);
  };

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
  }, [session]);

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
    if (body) body.scrollTop = body.scrollHeight;
  }, [lines]);

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
      <div className="terminal-body" role="log" aria-live="polite" ref={bodyRef}>
        {unavailableReason ? <p className="terminal-notice">{unavailableReason}</p> : null}
        {!unavailableReason && !session ? <p className="terminal-notice">Opening terminal…</p> : null}
        {lines.map((line) => (
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
