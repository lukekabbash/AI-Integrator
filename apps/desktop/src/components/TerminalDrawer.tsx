import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  CircleStop,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  SquareTerminal,
  X,
} from "lucide-react";
import { m } from "motion/react";
import {
  bridge,
  type ProjectSummary,
  type TerminalOutputEvent,
  type TerminalSessionInfo,
} from "../bridge";
import { readXtermTheme } from "../theme";
import { Tooltip } from "./Tooltip";

const DEFAULT_TERMINAL_HEIGHT_PX = 300;
const MIN_TERMINAL_HEIGHT_PX = 180;
const MIN_CHAT_HEIGHT_PX = 180;
const MAX_TERMINALS = 12;

type TerminalPhase = "opening" | "running" | "exited" | "failed";

interface TerminalTab {
  id: number;
  label: string;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function maximumTerminalHeight(): number {
  return Math.max(MIN_TERMINAL_HEIGHT_PX, window.innerHeight - MIN_CHAT_HEIGHT_PX);
}

function terminalTheme(): NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"] {
  return readXtermTheme(getComputedStyle(document.documentElement));
}

function errorMessage(error: unknown, fallback: string): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" &&
            error !== null &&
            "message" in error &&
            typeof error.message === "string"
          ? error.message
          : fallback;
  if (/unknown command.*terminal_|terminal_.*not found/i.test(message)) {
    return "Restart AI Integrator to finish enabling the terminal.";
  }
  if (/unknown terminal session/i.test(message)) {
    return "The terminal session disconnected. Restart it to continue.";
  }
  return message.trim() || fallback;
}

function phaseLabel(phase: TerminalPhase): string {
  if (phase === "running") return "Ready";
  if (phase === "opening") return "Starting…";
  if (phase === "exited") return "Exited";
  return "Unavailable";
}

function TerminalPane({
  id,
  visible,
  label,
  project,
  onCloseDrawer,
  onPhaseChange,
}: {
  id: number;
  visible: boolean;
  label: string;
  project: ProjectSummary;
  onCloseDrawer: () => void;
  onPhaseChange: (id: number, phase: TerminalPhase) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitVisibleRef = useRef<(() => void) | null>(null);
  const visibleRef = useRef(visible);
  const [session, setSession] = useState<TerminalSessionInfo | null>(null);
  const [phase, setPhase] = useState<TerminalPhase>("opening");
  const [failure, setFailure] = useState("");
  const [sessionVersion, setSessionVersion] = useState(0);
  const [hasForegroundProcess, setHasForegroundProcess] = useState(false);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let active = true;
    let sessionId = "";
    let unlisten: (() => void) | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    let initialFitFrame = 0;
    let lastDimensions = "";
    const pending: TerminalOutputEvent[] = [];
    setSession(null);
    setFailure("");
    setPhase("opening");
    onPhaseChange(id, "opening");
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 1,
      disableStdin: true,
      fontFamily: "var(--font-code)",
      fontSize: 12.5,
      lineHeight: 1.4,
      scrollback: 10_000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminalRef.current = terminal;
    terminal.loadAddon(fit);
    terminal.open(host);

    const fitVisibleTerminal = () => {
      if (host.clientWidth < 20 || host.clientHeight < 20) return;
      fit.fit();
      if (!sessionId) return;
      const cols = Math.max(20, terminal.cols);
      const rows = Math.max(5, terminal.rows);
      const dimensions = `${cols}:${rows}`;
      if (dimensions === lastDimensions) return;
      lastDimensions = dimensions;
      void bridge.resizeTerminal(sessionId, { cols, rows }).catch(() => undefined);
    };
    fitVisibleRef.current = fitVisibleTerminal;

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(fitVisibleTerminal);
      resizeObserver.observe(host);
    }
    initialFitFrame = window.requestAnimationFrame(fitVisibleTerminal);

    if (typeof MutationObserver !== "undefined") {
      themeObserver = new MutationObserver(() => {
        terminal.options.theme = terminalTheme();
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["style", "class", "data-theme", "data-appearance"],
      });
    }

    const updatePhase = (next: TerminalPhase) => {
      setPhase(next);
      onPhaseChange(id, next);
    };

    const fail = (error: unknown, fallback: string) => {
      if (!active) return;
      const message = errorMessage(error, fallback);
      terminal.options.disableStdin = true;
      terminal.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
      setFailure(message);
      updatePhase("failed");
    };

    const handleOutput = (event: TerminalOutputEvent) => {
      if (!sessionId) {
        pending.push(event);
        return;
      }
      if (event.sessionId !== sessionId) return;
      if (event.stream === "output") {
        if (event.data) terminal.write(event.data);
        return;
      }
      terminal.options.disableStdin = true;
      terminal.write(
        `\r\n\x1b[2mTerminal exited${event.exitCode == null ? "" : ` with code ${event.exitCode}`}.\x1b[0m\r\n`,
      );
      setSession(null);
      updatePhase("exited");
    };

    const dataDisposable = terminal.onData((data) => {
      if (!sessionId) return;
      void bridge
        .writeTerminal(sessionId, data)
        .catch((error) => fail(error, "The terminal stopped accepting input."));
    });

    void (async () => {
      try {
        unlisten = await bridge.subscribeTerminalOutput(handleOutput);
        const opened = await bridge.openTerminal(project.id, {
          cols: Math.max(20, terminal.cols),
          rows: Math.max(5, terminal.rows),
        });
        if (!active) {
          await bridge.closeTerminal(opened.id).catch(() => undefined);
          return;
        }
        sessionId = opened.id;
        setSession(opened);
        updatePhase("running");
        terminal.options.disableStdin = false;
        for (const event of pending.splice(0)) handleOutput(event);
        fitVisibleTerminal();
        if (visibleRef.current) terminal.focus();
      } catch (error) {
        fail(error, "The terminal could not start.");
      }
    })();

    return () => {
      active = false;
      window.cancelAnimationFrame(initialFitFrame);
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      dataDisposable.dispose();
      unlisten?.();
      terminal.dispose();
      terminalRef.current = null;
      if (fitVisibleRef.current === fitVisibleTerminal) fitVisibleRef.current = null;
      if (sessionId) void bridge.closeTerminal(sessionId).catch(() => undefined);
    };
  }, [id, onPhaseChange, project.id, sessionVersion]);

  useEffect(() => {
    if (!visible) return;
    let settleFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      settleFrame = window.requestAnimationFrame(() => {
        fitVisibleRef.current?.();
        terminalRef.current?.focus();
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(settleFrame);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible || phase !== "running" || !session) {
      setHasForegroundProcess(false);
      return;
    }
    let cancelled = false;
    const poll = () => {
      bridge
        .terminalHasForegroundProcess(session.id)
        .then((busy) => {
          if (!cancelled) setHasForegroundProcess(busy);
        })
        .catch(() => {
          if (!cancelled) setHasForegroundProcess(false);
        });
    };
    poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [visible, phase, session]);

  const stop = () => {
    if (!session) return;
    void bridge.interruptTerminal(session.id).catch((error) => {
      const message = errorMessage(error, "The terminal could not be interrupted.");
      terminalRef.current?.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
      setFailure(message);
    });
  };

  return (
    <section className="terminal-session-pane" aria-label={label} hidden={!visible}>
      <header className="terminal-header">
        <div className="terminal-title">
          <strong>{label}</strong>
          <span>{project.name}</span>
        </div>
        {session?.shell ? <small className="terminal-shell">{session.shell}</small> : null}
        <span className="terminal-status" data-phase={phase} role="status">
          <i aria-hidden="true" />
          {phaseLabel(phase)}
        </span>
        <div className="terminal-actions">
          {phase === "running" && hasForegroundProcess ? (
            <button
              className="terminal-stop"
              type="button"
              onClick={stop}
              aria-label={`Interrupt ${label}`}
            >
              <CircleStop aria-hidden="true" /> Stop
            </button>
          ) : null}
          {phase === "failed" || phase === "exited" ? (
            <button
              className="terminal-restart"
              type="button"
              onClick={() => setSessionVersion((version) => version + 1)}
            >
              <RefreshCw aria-hidden="true" /> Restart
            </button>
          ) : null}
          <button
            className="terminal-close"
            type="button"
            onClick={onCloseDrawer}
            aria-label="Close terminal panel"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="terminal-pty-host" ref={hostRef} />
      {failure ? (
        <p className="terminal-failure" role="alert">
          {failure}
        </p>
      ) : null}
    </section>
  );
}

export function TerminalDrawer({
  open,
  project,
  onClose,
  motionScale = 1,
}: {
  open: boolean;
  project: ProjectSummary;
  onClose: () => void;
  motionScale?: number;
}) {
  const nextTerminalId = useRef(2);
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [height, setHeight] = useState(DEFAULT_TERMINAL_HEIGHT_PX);
  const [resizing, setResizing] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [terminals, setTerminals] = useState<TerminalTab[]>([{ id: 1, label: "Terminal 1" }]);
  const [activeTerminalId, setActiveTerminalId] = useState(1);
  const [phases, setPhases] = useState<Record<number, TerminalPhase>>({ 1: "opening" });

  const addTerminal = useCallback(() => {
    const id = nextTerminalId.current;
    nextTerminalId.current += 1;
    setTerminals((current) => [...current, { id, label: `Terminal ${id}` }]);
    setPhases((current) => ({ ...current, [id]: "opening" }));
    setActiveTerminalId(id);
  }, []);

  useEffect(() => {
    if (open && terminals.length === 0) addTerminal();
  }, [addTerminal, open, terminals.length]);

  useEffect(() => {
    const keepHeightInBounds = () => {
      setHeight((current) => clamp(current, MIN_TERMINAL_HEIGHT_PX, maximumTerminalHeight()));
    };
    window.addEventListener("resize", keepHeightInBounds);
    return () => window.removeEventListener("resize", keepHeightInBounds);
  }, []);

  const handlePhaseChange = useCallback((id: number, phase: TerminalPhase) => {
    setPhases((current) => (current[id] === phase ? current : { ...current, [id]: phase }));
  }, []);

  const closeTerminal = (id: number) => {
    const index = terminals.findIndex((terminal) => terminal.id === id);
    const remaining = terminals.filter((terminal) => terminal.id !== id);
    setTerminals(remaining);
    setPhases((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (activeTerminalId === id) {
      setActiveTerminalId(remaining[Math.min(index, remaining.length - 1)]?.id ?? 0);
    }
    if (remaining.length === 0) onClose();
  };

  const resizeTo = (nextHeight: number) => {
    setHeight(clamp(nextHeight, MIN_TERMINAL_HEIGHT_PX, maximumTerminalHeight()));
  };

  const handleResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: height,
    };
    setResizing(true);
  };

  const handleResizePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    resizeTo(drag.startHeight + drag.startY - event.clientY);
  };

  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
    setResizing(false);
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp") resizeTo(height + 24);
    else if (event.key === "ArrowDown") resizeTo(height - 24);
    else if (event.key === "Home") resizeTo(MIN_TERMINAL_HEIGHT_PX);
    else if (event.key === "End") resizeTo(maximumTerminalHeight());
    else return;
    event.preventDefault();
  };

  return (
    <m.section
      className="terminal-drawer"
      aria-label="Project terminal"
      aria-hidden={open ? undefined : true}
      inert={open ? undefined : true}
      data-resizing={resizing}
      initial={{ height: 0 }}
      animate={{ height: open ? height : 0 }}
      transition={{
        duration: resizing ? 0 : 0.32 * motionScale,
        ease: [0.33, 1, 0.15, 1] as const,
      }}
    >
      <Tooltip label="Drag to resize · Double-click to reset" placement="top">
        <div
          className="terminal-resize-handle"
          role="separator"
          aria-label="Resize terminal panel"
          aria-orientation="horizontal"
          aria-valuemin={MIN_TERMINAL_HEIGHT_PX}
          aria-valuemax={maximumTerminalHeight()}
          aria-valuenow={Math.round(height)}
          tabIndex={0}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onDoubleClick={() => resizeTo(DEFAULT_TERMINAL_HEIGHT_PX)}
          onKeyDown={handleResizeKeyDown}
        >
          <i aria-hidden="true" />
        </div>
      </Tooltip>
      <div className="terminal-drawer-inner">
        <div className="terminal-session-stack">
          {terminals.map((terminal) => (
            <TerminalPane
              key={terminal.id}
              id={terminal.id}
              visible={open && activeTerminalId === terminal.id}
              label={terminal.label}
              project={project}
              onCloseDrawer={onClose}
              onPhaseChange={handlePhaseChange}
            />
          ))}
        </div>
        <aside
          className="terminal-session-rail"
          data-collapsed={railCollapsed}
          aria-label="Terminal sessions"
        >
          <header className="terminal-session-rail-header">
            <Tooltip
              label={railCollapsed ? "Expand terminal list" : "Collapse terminal list"}
              placement="left"
            >
              <button
                type="button"
                onClick={() => setRailCollapsed((current) => !current)}
                aria-label={railCollapsed ? "Expand terminal list" : "Collapse terminal list"}
              >
                {railCollapsed ? (
                  <PanelRightOpen aria-hidden="true" />
                ) : (
                  <PanelRightClose aria-hidden="true" />
                )}
              </button>
            </Tooltip>
            <strong>Terminals</strong>
            <small>{terminals.length}</small>
          </header>
          <div className="terminal-session-list">
            {terminals.map((terminal) => {
              const terminalPhase = phases[terminal.id] ?? "opening";
              return (
                <div
                  className="terminal-session-row"
                  data-active={activeTerminalId === terminal.id}
                  key={terminal.id}
                >
                  <Tooltip label={terminal.label} placement="left">
                    <button
                      className="terminal-session-select"
                      type="button"
                      onClick={() => setActiveTerminalId(terminal.id)}
                      aria-pressed={activeTerminalId === terminal.id}
                      aria-label={terminal.label}
                    >
                      <SquareTerminal aria-hidden="true" />
                      <span>{terminal.label}</span>
                      <i data-phase={terminalPhase} aria-label={phaseLabel(terminalPhase)} />
                    </button>
                  </Tooltip>
                  <Tooltip label={`Close ${terminal.label}`} placement="left">
                    <button
                      className="terminal-session-remove"
                      type="button"
                      onClick={() => closeTerminal(terminal.id)}
                      aria-label={`Close ${terminal.label}`}
                    >
                      <X aria-hidden="true" />
                    </button>
                  </Tooltip>
                </div>
              );
            })}
          </div>
          <Tooltip
            label={`Maximum ${MAX_TERMINALS} terminals`}
            disabled={terminals.length < MAX_TERMINALS}
            placement="left"
          >
            <button
              className="terminal-session-new"
              type="button"
              onClick={addTerminal}
              disabled={terminals.length >= MAX_TERMINALS}
              aria-label="New terminal"
            >
              <Plus aria-hidden="true" />
              <span>New terminal</span>
            </button>
          </Tooltip>
        </aside>
      </div>
    </m.section>
  );
}
