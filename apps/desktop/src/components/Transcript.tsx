import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  ChevronRight,
  Circle,
  Clock3,
  FileSearch,
  GitCommit,
  Info,
  TerminalSquare,
} from "lucide-react";
import type { TranscriptEvent } from "../bridge";

function EventIcon({ event }: { event: TranscriptEvent }) {
  if (event.status === "success") return <Check />;
  if (event.status === "running") return <Circle className="spin-slow" />;
  if (event.kind === "tool") return <TerminalSquare />;
  if (event.kind === "checkpoint") return <GitCommit />;
  if (event.kind === "notice") return <Info />;
  return <FileSearch />;
}

function ActivityEvent({ event }: { event: TranscriptEvent }) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = Boolean(event.children?.length);
  const hasLongBody = Boolean(
    event.title && event.body && (event.body.length > 96 || event.body.includes("\n")),
  );
  const expandable = hasChildren || hasLongBody;
  return (
    <div className="activity-event" data-status={event.status ?? "neutral"}>
      <button
        className="activity-event-summary"
        type="button"
        onClick={() => expandable && setExpanded((value) => !value)}
        aria-expanded={expandable ? expanded : undefined}
      >
        <span className="activity-icon">
          <EventIcon event={event} />
        </span>
        <span className="activity-copy">
          <strong>{event.title ?? event.body}</strong>
          {event.title ? <span>{firstLine(event.body)}</span> : null}
        </span>
        {event.meta ? <span className="activity-meta">{event.meta}</span> : null}
        {expandable ? (
          <ChevronRight className={expanded ? "disclosure disclosure--open-right" : "disclosure"} />
        ) : null}
      </button>
      <AnimatePresence initial={false}>
        {expanded && hasLongBody && !event.children ? (
          <motion.div
            className="activity-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <pre>{event.body}</pre>
          </motion.div>
        ) : null}
        {expanded && event.children ? (
          <motion.div
            className="activity-children"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            {event.children.map((child) => (
              <div
                className="activity-child"
                key={child.id}
                data-status={child.status ?? "neutral"}
              >
                <span className="activity-icon">
                  <EventIcon event={child} />
                </span>
                <span>{child.body}</span>
                {child.meta ? <small>{child.meta}</small> : null}
              </div>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function Transcript({
  events,
  running = false,
  runningSince,
}: {
  events: TranscriptEvent[];
  running?: boolean;
  runningSince?: string;
}) {
  return (
    <div className="transcript" aria-label="Task transcript">
      {running ? (
        <div className="task-now" role="status" aria-live="polite">
          <span className="live-indicator" aria-hidden="true" />
          <span>Turn in progress</span>
          {runningSince ? (
            <span className="task-now-meta">
              <Clock3 /> {formatElapsed(runningSince)}
            </span>
          ) : null}
        </div>
      ) : null}

      {events.map((event) => {
        if (event.kind === "user") {
          return (
            <section className="turn turn--user" key={event.id} aria-label="Your message">
              <p>{event.body}</p>
            </section>
          );
        }
        if (event.kind === "assistant") {
          return (
            <section className="turn turn--assistant" key={event.id} aria-label="Agent response">
              <div className="assistant-rule" />
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.body}</ReactMarkdown>
              <div className="message-actions">
                <button type="button">Copy</button>
                <button type="button">Ask about this</button>
              </div>
            </section>
          );
        }
        if (event.kind === "notice") {
          return (
            <aside className="inline-notice" key={event.id}>
              <Info />
              <span>
                <strong>{event.title}</strong>
                {event.body}
              </span>
            </aside>
          );
        }
        return <ActivityEvent event={event} key={event.id} />;
      })}

      {running ? (
        <motion.div
          className="running-cursor"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
        >
          <span className="live-indicator" aria-hidden="true" />
          <span>Working…</span>
        </motion.div>
      ) : null}
    </div>
  );
}

function firstLine(body?: string): string {
  if (!body) return "";
  const line = body.split("\n", 1)[0] ?? "";
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

function formatElapsed(since: string): string {
  const elapsedMs = Date.now() - new Date(since).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
