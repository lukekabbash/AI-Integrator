import { useEffect, useState } from "react";
import { AnimatePresence, m as motion } from "motion/react";
import type { RuntimeUsageProjection } from "../bridge";

interface TaskStatusPillProps {
  /** Turn start time; the pill renders nothing without it. */
  runningSince?: string;
  usage?: RuntimeUsageProjection;
  activeAgentCount?: number;
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens} tokens`;
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k tokens`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}m tokens`;
}

function formatElapsed(since: string, nowMs: number): string {
  const elapsedMs = nowMs - new Date(since).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "";
  if (elapsedMs < 60_000) return `${(elapsedMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The hand sweeps one revolution per minute, so its angle IS the elapsed
 *  time within the current minute — a live second hand for the turn. */
function ClockFace() {
  return (
    <svg className="pill-clock" viewBox="0 0 12 12" aria-hidden="true">
      <circle
        cx="6"
        cy="6"
        r="4.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        opacity="0.55"
      />
      <line
        className="pill-clock-hand"
        x1="6"
        y1="6.4"
        x2="6"
        y2="3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Floating run vitals — elapsed time, live tokens, and agent count — pinned
 *  just above the composer while a turn is in flight. */
export function TaskStatusPill({ runningSince, usage, activeAgentCount }: TaskStatusPillProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Tenth-of-a-second ticks while the timer reads in seconds; once it rolls
  // over to minutes the label only moves once a minute, so ease way off.
  useEffect(() => {
    if (!runningSince) return;
    let timeout: number;
    const tick = () => {
      const now = Date.now();
      setNowMs(now);
      const elapsedMs = now - new Date(runningSince).getTime();
      timeout = window.setTimeout(tick, elapsedMs < 60_000 ? 100 : 30_000);
    };
    tick();
    return () => window.clearTimeout(timeout);
  }, [runningSince]);

  if (!runningSince) return null;

  const elapsed = formatElapsed(runningSince, nowMs);
  // Crossfade only when the unit rolls over (s → m → h m); within a unit the
  // digits update in place under tabular-nums.
  const elapsedUnit = elapsed.replace(/[\d.]+/g, "");

  return (
    <div className="task-status-anchor">
      <motion.div
        className="task-status-pill"
        initial={{ opacity: 0, y: 8, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.96 }}
        transition={{ duration: 0.28, ease: [0.32, 0.72, 0.24, 1] }}
      >
        <span className="task-status-pill-item">
          <ClockFace />
          <AnimatePresence initial={false} mode="wait">
            <motion.span
              className="task-status-pill-elapsed"
              key={elapsedUnit}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
            >
              {elapsed}
            </motion.span>
          </AnimatePresence>
        </span>
        {usage ? (
          <span className="task-status-pill-item">{formatTokens(usage.totalTokens)}</span>
        ) : null}
        {activeAgentCount ? (
          <span className="task-status-pill-item">
            {activeAgentCount} {activeAgentCount === 1 ? "agent" : "agents"}
          </span>
        ) : null}
      </motion.div>
    </div>
  );
}
