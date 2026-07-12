import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  ChevronRight,
  Circle,
  Clock3,
  Copy,
  FileSearch,
  GitCommit,
  Info,
  MessageCircleQuestion,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import { openExternalLink, type TranscriptEvent } from "../bridge";

const FOLLOW_THRESHOLD_PX = 96;

interface TranscriptProps {
  events: TranscriptEvent[];
  running?: boolean;
  runningSince?: string;
  /** The scroll viewport owned by the workspace shell. */
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  /** Moves a selected answer into the caller-owned composer draft. */
  onAskAbout?: (message: string) => void;
  /** Resolves the display name of the model that produced a given reply. */
  modelForEvent?: (event: TranscriptEvent) => string | undefined;
  /** Per-message clock times in the reply action row. Defaults to on. */
  showTimestamps?: boolean;
  /** Re-runs the prompt that produced the latest assistant reply. */
  onRegenerate?: () => void;
}

function formatClock(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function scrollToLatest(container: HTMLDivElement, behavior: ScrollBehavior = "auto") {
  const top = Math.max(0, container.scrollHeight - container.clientHeight);
  if (typeof container.scrollTo === "function") {
    container.scrollTo({ top, behavior });
  } else {
    container.scrollTop = top;
  }
}

function transcriptSignature(events: TranscriptEvent[], running: boolean): string {
  return `${running ? "running" : "idle"}|${events
    .map((event) => `${event.id}:${event.body}:${event.status ?? ""}`)
    .join("|")}`;
}

function MarkdownLink({
  href,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!href || event.defaultPrevented || event.button !== 0) return;
    event.preventDefault();
    void openExternalLink(href).catch(() => {
      // Keep a failed external open from navigating the workspace away.
    });
  };

  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick}>
      {children}
    </a>
  );
}

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
  const hasDetails = Boolean(event.details?.length);
  const hasLongBody = Boolean(
    event.title && event.body && (event.body.length > 96 || event.body.includes("\n")),
  );
  const expandable = hasChildren || hasDetails || hasLongBody;
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
        {expanded && hasDetails ? (
          <motion.div
            className="activity-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            {event.details?.map((detail) => (
              <div className="activity-detail" key={detail.label}>
                <span className="activity-detail-label">{detail.label}</span>
                <pre>{detail.body}</pre>
              </div>
            ))}
          </motion.div>
        ) : null}
        {expanded && hasLongBody && !hasDetails && !event.children ? (
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
  scrollContainerRef,
  onAskAbout,
  modelForEvent,
  showTimestamps = true,
  onRegenerate,
}: TranscriptProps) {
  const [copiedEventId, setCopiedEventId] = useState<string | null>(null);
  const [, setElapsedTick] = useState(0);
  const [copyFailureId, setCopyFailureId] = useState<string | null>(null);
  const [hasNewContent, setHasNewContent] = useState(false);
  const clearCopyStatus = useRef<number | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldFollowLatestRef = useRef(true);
  const previousSignatureRef = useRef<string | null>(null);
  const previousEventIdsRef = useRef<Set<string>>(new Set());
  const scheduledFrameRef = useRef<number | undefined>(undefined);

  const scheduleFollow = useCallback(() => {
    const container = scrollContainerRef?.current;
    if (!container || !shouldFollowLatestRef.current) return;
    if (scheduledFrameRef.current !== undefined) {
      window.cancelAnimationFrame(scheduledFrameRef.current);
    }
    scheduledFrameRef.current = window.requestAnimationFrame(() => {
      scheduledFrameRef.current = undefined;
      if (shouldFollowLatestRef.current && scrollContainerRef.current) {
        scrollToLatest(scrollContainerRef.current);
      }
    });
  }, [scrollContainerRef]);

  useEffect(() => {
    const container = scrollContainerRef?.current;
    if (!container) return;

    const handleScroll = () => {
      const distanceFromLatest =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const shouldFollow = distanceFromLatest <= FOLLOW_THRESHOLD_PX;
      shouldFollowLatestRef.current = shouldFollow;
      if (shouldFollow) setHasNewContent(false);
    };

    handleScroll();
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [scrollContainerRef]);

  useLayoutEffect(() => {
    const signature = transcriptSignature(events, running);
    const previousSignature = previousSignatureRef.current;
    const isInitialLayout = previousSignature === null;
    const previousEventIds = previousEventIdsRef.current;
    const hasNewUserMessage = events.some(
      (event) => event.kind === "user" && !previousEventIds.has(event.id),
    );
    previousSignatureRef.current = signature;
    previousEventIdsRef.current = new Set(events.map((event) => event.id));

    if (isInitialLayout || hasNewUserMessage || shouldFollowLatestRef.current) {
      shouldFollowLatestRef.current = true;
      setHasNewContent(false);
      scheduleFollow();
    } else if (previousSignature !== signature) {
      setHasNewContent(true);
    }
  }, [events, running, scheduleFollow]);

  useEffect(() => {
    const container = scrollContainerRef?.current;
    const content = contentRef.current;
    if (!container || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => scheduleFollow());
    observer.observe(container);
    observer.observe(content);
    const mutations =
      typeof MutationObserver === "undefined" ? undefined : new MutationObserver(scheduleFollow);
    mutations?.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      mutations?.disconnect();
    };
  }, [scheduleFollow, scrollContainerRef]);

  useEffect(
    () => () => {
      if (clearCopyStatus.current) window.clearTimeout(clearCopyStatus.current);
      if (scheduledFrameRef.current !== undefined) {
        window.cancelAnimationFrame(scheduledFrameRef.current);
      }
    },
    [],
  );

  // The elapsed label has minute granularity; keep it moving on quiet turns
  // where no transcript events arrive to trigger a render.
  useEffect(() => {
    if (!running || !runningSince) return;
    const interval = window.setInterval(() => setElapsedTick((tick) => tick + 1), 30_000);
    return () => window.clearInterval(interval);
  }, [running, runningSince]);

  const lastAssistantId = [...events].reverse().find((event) => event.kind === "assistant")?.id;

  const jumpToLatest = () => {
    shouldFollowLatestRef.current = true;
    setHasNewContent(false);
    if (scrollContainerRef?.current) scrollToLatest(scrollContainerRef.current, "smooth");
  };

  const copyMessage = async (event: TranscriptEvent) => {
    if (!navigator.clipboard?.writeText) {
      setCopyFailureId(event.id);
      return;
    }
    try {
      await navigator.clipboard.writeText(event.body);
      setCopiedEventId(event.id);
      setCopyFailureId(null);
      if (clearCopyStatus.current) window.clearTimeout(clearCopyStatus.current);
      clearCopyStatus.current = window.setTimeout(() => setCopiedEventId(null), 2_000);
    } catch {
      setCopyFailureId(event.id);
    }
  };

  return (
    <div className="transcript" ref={contentRef} aria-label="Task transcript">
      {hasNewContent ? (
        <button className="transcript-jump-latest" type="button" onClick={jumpToLatest}>
          <span aria-hidden="true">↓</span> New activity · Jump to latest
        </button>
      ) : null}
      {events.map((event) => {
        if (event.kind === "user") {
          return (
            <section
              className="turn turn--user"
              key={event.id}
              aria-label="Your message"
              title={showTimestamps ? formatClock(event.timestamp) : undefined}
            >
              <p>{event.body}</p>
            </section>
          );
        }
        if (event.kind === "assistant") {
          const isLatestAssistant = event.id === lastAssistantId;
          const clock = showTimestamps ? formatClock(event.timestamp) : "";
          const modelLabel = modelForEvent?.(event);
          return (
            <section className="turn turn--assistant" key={event.id} aria-label="Agent response">
              {modelLabel ? (
                <header className="turn-attribution">
                  <span className="turn-attribution-model">{modelLabel}</span>
                </header>
              ) : null}
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
                {event.body}
              </ReactMarkdown>
              <div className="message-actions">
                <button
                  type="button"
                  className={copiedEventId === event.id ? "is-copied" : undefined}
                  onClick={() => void copyMessage(event)}
                  aria-label="Copy this response"
                  title={
                    copyFailureId === event.id
                      ? "The system clipboard is unavailable."
                      : "Copy this response"
                  }
                >
                  {copiedEventId === event.id ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  <span>{copiedEventId === event.id ? "Copied" : "Copy"}</span>
                </button>
                {onRegenerate && isLatestAssistant && !running ? (
                  <button
                    type="button"
                    onClick={onRegenerate}
                    aria-label="Regenerate this response"
                    title="Run the same prompt again"
                  >
                    <RefreshCw aria-hidden="true" />
                    <span>Regenerate</span>
                  </button>
                ) : null}
                {onAskAbout ? (
                  <button
                    type="button"
                    onClick={() => onAskAbout(event.body)}
                    aria-label="Ask a follow-up about this response"
                    title="Ask a follow-up about this response"
                  >
                    <MessageCircleQuestion aria-hidden="true" />
                    <span>Ask about this</span>
                  </button>
                ) : null}
                {clock ? (
                  <time className="message-time" dateTime={event.timestamp}>
                    {clock}
                  </time>
                ) : null}
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
          className="task-now"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
        >
          <span className="live-indicator" aria-hidden="true" />
          <span>Turn in progress</span>
          {runningSince ? (
            <span className="task-now-meta">
              <Clock3 /> {formatElapsed(runningSince)}
            </span>
          ) : null}
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
