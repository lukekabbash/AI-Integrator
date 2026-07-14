import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { CircleStop, X } from "lucide-react";
import { bridge, type RuntimeActionPlan, type RuntimeTerminalOutputEvent } from "../bridge";

function terminalTheme(): NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"] {
  const styles = getComputedStyle(document.documentElement);
  const color = (name: string) => styles.getPropertyValue(name).trim();
  return {
    background: color("--color-terminal-surface"),
    foreground: color("--color-terminal-text"),
    cursor: color("--color-terminal-text"),
    selectionBackground: color("--color-selection-active"),
    black: color("--color-terminal-ansi0"),
    red: color("--color-terminal-ansi1"),
    green: color("--color-terminal-ansi2"),
    yellow: color("--color-terminal-ansi3"),
    blue: color("--color-terminal-ansi4"),
    magenta: color("--color-terminal-ansi5"),
    cyan: color("--color-terminal-ansi6"),
    white: color("--color-terminal-ansi7"),
    brightBlack: color("--color-terminal-ansi8"),
    brightRed: color("--color-terminal-ansi9"),
    brightGreen: color("--color-terminal-ansi10"),
    brightYellow: color("--color-terminal-ansi11"),
    brightBlue: color("--color-terminal-ansi12"),
    brightMagenta: color("--color-terminal-ansi13"),
    brightCyan: color("--color-terminal-ansi14"),
    brightWhite: color("--color-terminal-ansi15"),
  };
}

export function RuntimeSetupTerminal({
  plan,
  onClose,
  onExit,
}: {
  plan: RuntimeActionPlan;
  onClose: () => void;
  onExit: (exitCode: number | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
  const [phase, setPhase] = useState<"opening" | "running" | "finished" | "failed">("opening");
  const [failure, setFailure] = useState("");

  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let active = true;
    let sessionId = "";
    let unlisten: (() => void) | undefined;
    let resizeObserver: ResizeObserver | undefined;
    const pending: RuntimeTerminalOutputEvent[] = [];
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "var(--font-code)",
      fontSize: 12,
      lineHeight: 1.45,
      scrollback: 4_000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    terminal.writeln(`\x1b[2m$ ${plan.command}\x1b[0m`);

    const handleOutput = (event: RuntimeTerminalOutputEvent) => {
      if (!sessionId) {
        pending.push(event);
        return;
      }
      if (event.sessionId !== sessionId) return;
      if (event.stream === "output") {
        if (event.data) terminal.write(event.data);
        return;
      }
      const exitCode = event.exitCode ?? null;
      terminal.options.disableStdin = true;
      terminal.writeln(
        exitCode === 0
          ? "\r\n\x1b[32mCommand finished. Checking the runtime again…\x1b[0m"
          : `\r\n\x1b[31mCommand exited with code ${exitCode ?? "unknown"}.\x1b[0m`,
      );
      setPhase("finished");
      onExitRef.current(exitCode);
    };

    const dataDisposable = terminal.onData((data) => {
      if (sessionId) void bridge.writeRuntimeTerminal(sessionId, data).catch(() => undefined);
    });
    void (async () => {
      try {
        unlisten = await bridge.subscribeRuntimeTerminalOutput(handleOutput);
        const session = await bridge.openRuntimeTerminal(plan.id, {
          cols: Math.max(20, terminal.cols),
          rows: Math.max(5, terminal.rows),
        });
        if (!active) {
          await bridge.closeRuntimeTerminal(session.id).catch(() => undefined);
          return;
        }
        sessionId = session.id;
        setPhase("running");
        for (const event of pending.splice(0)) handleOutput(event);
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(() => {
            fit.fit();
            void bridge
              .resizeRuntimeTerminal(sessionId, {
                cols: Math.max(20, terminal.cols),
                rows: Math.max(5, terminal.rows),
              })
              .catch(() => undefined);
          });
          resizeObserver.observe(host);
        }
        terminal.focus();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "The runtime command could not start.";
        terminal.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
        terminal.options.disableStdin = true;
        setFailure(message);
        setPhase("failed");
      }
    })();

    return () => {
      active = false;
      resizeObserver?.disconnect();
      dataDisposable.dispose();
      unlisten?.();
      terminal.dispose();
      if (sessionId) void bridge.closeRuntimeTerminal(sessionId).catch(() => undefined);
    };
  }, [plan]);

  return (
    <section className="runtime-setup-terminal" aria-label={`${plan.provider} setup terminal`}>
      <header>
        <span>
          <strong>{plan.label}</strong>
          <small>
            {phase === "opening"
              ? "Opening terminal…"
              : phase === "running"
                ? "Running locally"
                : phase === "finished"
                  ? "Finished"
                  : "Could not start"}
          </small>
        </span>
        {phase === "running" ? (
          <button
            className="secondary-button"
            type="button"
            onClick={onClose}
            aria-label="Stop runtime command"
          >
            <CircleStop aria-hidden="true" /> Stop
          </button>
        ) : null}
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
          aria-label="Close setup terminal"
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="runtime-setup-terminal-host" ref={hostRef} />
      <footer>
        <span>
          User-owned terminal · not attached to an agent or transcript · use the vendor browser for
          passwords, MFA, or keys
        </span>
        {failure ? <span role="alert">{failure}</span> : null}
      </footer>
    </section>
  );
}
