import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AnimatePresence, m as motion } from "motion/react";
import {
  Check,
  ChevronRight,
  Circle,
  Copy,
  FileSearch,
  GitCommit,
  Info,
  MessageCircleQuestion,
  PanelRightOpen,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import { bridge, openExternalLink, attachmentKind, type TranscriptEvent } from "../bridge";
import { DiffView, type DiffSelectionPayload } from "./DiffView";
import { FileIcon } from "./FileIcon";
import { splitAttachmentBlock } from "./conversationFormatting";

const FOLLOW_THRESHOLD_PX = 96;

interface TranscriptProps {
  events: TranscriptEvent[];
  running?: boolean;
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
  /** Opens an observable file in the Files tab of the right rail. */
  onOpenFile?: (path: string) => void;
  /** Selection-to-chat from transcript-embedded diffs. */
  onAddDiffSelection?: (payload: DiffSelectionPayload) => void;
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

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_COMPONENTS = { a: MarkdownLink };

const MarkdownBody = memo(function MarkdownBody({ body }: { body: string }) {
  return (
    <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
      {body}
    </ReactMarkdown>
  );
});

/** Renders plain user text with valid-looking @mention tokens highlighted the
 * same way slash commands are. */
function mentionSegments(text: string): Array<string | { mention: string }> {
  const segments: Array<string | { mention: string }> = [];
  const pattern = /(^|\s)(@[\w./\\-]+)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const start = match.index + match[1].length;
    if (start > cursor) segments.push(text.slice(cursor, start));
    segments.push({ mention: match[2] });
    cursor = start + match[2].length;
  }
  if (cursor < text.length) segments.push(text.slice(cursor));
  return segments;
}

function AttachmentThumb({ path }: { path: string }) {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  const isImage = attachmentKind(name) === "image";
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage || !bridge.readAttachmentPreview) return;
    let active = true;
    void bridge
      .readAttachmentPreview(path)
      .then((dataUrl) => {
        if (active) setPreview(dataUrl);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [isImage, path]);
  return (
    <span
      className={`user-attachment${preview ? " user-attachment--image" : ""}`}
      title={path}
      data-attachment-kind={isImage ? "image" : "file"}
    >
      {preview ? <img src={preview} alt={name} /> : <FileIcon fileName={name} />}
      <span>{name}</span>
    </span>
  );
}

const UserMessage = memo(function UserMessage({
  body,
  nativeSkill,
  timestamp,
  showTimestamp,
}: {
  body: string;
  nativeSkill?: string;
  timestamp: string;
  showTimestamp: boolean;
}) {
  const skillPrefix = nativeSkill ? `/${nativeSkill}` : "";
  const hasVerifiedSkill =
    Boolean(skillPrefix) && (body === skillPrefix || body.startsWith(`${skillPrefix} `));
  const { text, attachments } = splitAttachmentBlock(body);
  const tail = hasVerifiedSkill ? text.slice(skillPrefix.length) : text;
  return (
    <section
      className="turn turn--user"
      aria-label="Your message"
      title={showTimestamp ? formatClock(timestamp) : undefined}
    >
      <p>
        {hasVerifiedSkill ? (
          <strong
            className="native-skill-token"
            aria-label={`Native skill ${skillPrefix}`}
            title="Provider-native skill"
          >
            {skillPrefix}
          </strong>
        ) : null}
        {mentionSegments(tail).map((segment, index) =>
          typeof segment === "string" ? (
            segment
          ) : (
            <strong
              className="context-mention-token"
              key={`${segment.mention}-${index}`}
              title="Context mention"
            >
              {segment.mention}
            </strong>
          ),
        )}
      </p>
      {attachments.length > 0 ? (
        <span className="user-attachments" aria-label="Attached files">
          {attachments.map((path) => (
            <AttachmentThumb key={path} path={path} />
          ))}
        </span>
      ) : null}
    </section>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  id,
  body,
  timestamp,
  modelLabel,
  showTimestamp,
  copied,
  copyFailed,
  isLatestAssistant,
  running,
  canRegenerate,
  canAskAbout,
  onCopy,
  onRegenerate,
  onAskAbout,
}: {
  id: string;
  body: string;
  timestamp: string;
  modelLabel?: string;
  showTimestamp: boolean;
  copied: boolean;
  copyFailed: boolean;
  isLatestAssistant: boolean;
  running: boolean;
  canRegenerate: boolean;
  canAskAbout: boolean;
  onCopy: (id: string, body: string) => void;
  onRegenerate: () => void;
  onAskAbout: (body: string) => void;
}) {
  const clock = showTimestamp ? formatClock(timestamp) : "";
  return (
    <section className="turn turn--assistant" aria-label="Agent response">
      {modelLabel ? (
        <header className="turn-attribution">
          <span className="turn-attribution-model">{modelLabel}</span>
        </header>
      ) : null}
      <MarkdownBody body={body} />
      <div className="message-actions">
        <button
          type="button"
          className={copied ? "is-copied" : undefined}
          onClick={() => onCopy(id, body)}
          aria-label="Copy this response"
          title={copyFailed ? "The system clipboard is unavailable." : "Copy this response"}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
        {canRegenerate && isLatestAssistant && !running ? (
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
        {canAskAbout ? (
          <button
            type="button"
            onClick={() => onAskAbout(body)}
            aria-label="Ask a follow-up about this response"
            title="Ask a follow-up about this response"
          >
            <MessageCircleQuestion aria-hidden="true" />
            <span>Ask about this</span>
          </button>
        ) : null}
        {clock ? (
          <time className="message-time" dateTime={timestamp}>
            {clock}
          </time>
        ) : null}
      </div>
    </section>
  );
});

const NoticeMessage = memo(function NoticeMessage({
  title,
  body,
}: {
  title?: string;
  body: string;
}) {
  return (
    <aside className="inline-notice">
      <Info />
      <span>
        <strong>{title}</strong>
        {body}
      </span>
    </aside>
  );
});

function EventIcon({ event }: { event: TranscriptEvent }) {
  if (event.status === "success") return <Check />;
  if (event.status === "running") return <Circle className="spin-slow" />;
  if (event.kind === "tool") return <TerminalSquare />;
  if (event.kind === "checkpoint") return <GitCommit />;
  if (event.kind === "notice") return <Info />;
  return <FileSearch />;
}

function ActivityEvent({
  event,
  nested = false,
  onOpenFile,
  onAddDiffSelection,
}: {
  event: TranscriptEvent;
  nested?: boolean;
  onOpenFile?: (path: string) => void;
  onAddDiffSelection?: (payload: DiffSelectionPayload) => void;
}) {
  const [expanded, setExpanded] = useState(event.expandedByDefault ?? false);
  const hasChildren = Boolean(event.children?.length);
  const hasDetails = Boolean(event.details?.length);
  const hasDiff = Boolean(event.diff?.lines.length);
  const filePath = event.filePath ?? event.diff?.path;
  const hasLongBody = Boolean(
    event.title && event.body && (event.body.length > 96 || event.body.includes("\n")),
  );
  const expandable = hasChildren || hasDetails || hasLongBody || hasDiff;
  return (
    <div
      className={`activity-event${hasChildren ? " activity-event--group" : ""}${nested ? " activity-event--nested" : ""}`}
      data-status={event.status ?? "neutral"}
    >
      <div className="activity-event-summary">
        <button
          className="activity-event-toggle"
          type="button"
          onClick={() => expandable && setExpanded((value) => !value)}
          aria-expanded={expandable ? expanded : undefined}
          disabled={!expandable}
        >
          <span className="activity-icon">
            <EventIcon event={event} />
          </span>
          <span className="activity-copy">
            <strong>{event.title ?? event.body}</strong>
            {event.title ? <span>{firstLine(event.body)}</span> : null}
          </span>
          {event.changeStats ? (
            <span
              className="activity-diff-stats"
              aria-label={`${event.changeStats.additions} lines added, ${event.changeStats.deletions} lines removed`}
            >
              <i>+{event.changeStats.additions}</i>
              <b>−{event.changeStats.deletions}</b>
            </span>
          ) : null}
          {event.meta ? <span className="activity-meta">{event.meta}</span> : null}
          {expandable ? (
            <ChevronRight
              className={expanded ? "disclosure disclosure--open-right" : "disclosure"}
            />
          ) : null}
        </button>
        {filePath && onOpenFile ? (
          <button
            className="activity-event-open-file"
            type="button"
            onClick={() => onOpenFile(filePath)}
            aria-label={`Open ${filePath} in Files`}
            title="Open in Files"
          >
            <PanelRightOpen aria-hidden="true" />
          </button>
        ) : null}
      </div>
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
              <ActivityEvent
                event={child}
                key={child.id}
                nested
                onOpenFile={onOpenFile}
                onAddDiffSelection={onAddDiffSelection}
              />
            ))}
          </motion.div>
        ) : null}
        {expanded && event.diff ? (
          <motion.div
            className="activity-diff-review"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <DiffView
              file={event.diff}
              variant="inline"
              showReviewActions={false}
              onAddSelection={onAddDiffSelection}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function Transcript({
  events,
  running = false,
  scrollContainerRef,
  onAskAbout,
  modelForEvent,
  showTimestamps = true,
  onRegenerate,
  onOpenFile,
  onAddDiffSelection,
}: TranscriptProps) {
  const [copiedEventId, setCopiedEventId] = useState<string | null>(null);
  const [copyFailureId, setCopyFailureId] = useState<string | null>(null);
  const [hasNewContent, setHasNewContent] = useState(false);
  const [liveStreamOpen, setLiveStreamOpen] = useState(false);
  const clearCopyStatus = useRef<number | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldFollowLatestRef = useRef(true);
  const previousEventsRef = useRef<TranscriptEvent[] | null>(null);
  const previousRunningRef = useRef(running);
  const previousLatestUserIdRef = useRef<string | undefined>(undefined);
  const scheduledFrameRef = useRef<number | undefined>(undefined);
  const askAboutRef = useRef(onAskAbout);
  const regenerateRef = useRef(onRegenerate);
  const openFileRef = useRef(onOpenFile);

  useEffect(() => {
    askAboutRef.current = onAskAbout;
    regenerateRef.current = onRegenerate;
    openFileRef.current = onOpenFile;
  }, [onAskAbout, onOpenFile, onRegenerate]);

  // A fresh turn starts with the live stream folded back to one line.
  useEffect(() => {
    if (!running) setLiveStreamOpen(false);
  }, [running]);

  const scheduleFollow = useCallback(() => {
    if (!shouldFollowLatestRef.current) return;
    if (scheduledFrameRef.current !== undefined) {
      window.cancelAnimationFrame(scheduledFrameRef.current);
    }
    // The container ref is resolved inside the frame, not here: when the
    // transcript and its scroll container mount in the same commit (opening
    // a chat), this runs from a layout effect before the parent's ref is
    // attached, and reading it now would drop the initial scroll-to-bottom.
    scheduledFrameRef.current = window.requestAnimationFrame(() => {
      scheduledFrameRef.current = undefined;
      if (shouldFollowLatestRef.current && scrollContainerRef?.current) {
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

    // Follow state changes only on real scroll events. Probing the position
    // here would read scrollTop 0 on a freshly mounted, already-populated
    // chat and misfile "just opened" as "scrolled away from the latest".
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [scrollContainerRef]);

  const liveActivity = running ? findTrailingActivity(events) : undefined;
  const renderedEventCount = events.length - (liveActivity ? 1 : 0);
  const { lastAssistantId, latestUserId } = findRecentMessageIds(events, renderedEventCount);
  const currentActivity = liveActivity
    ? findActivityLeaf(liveActivity)
    : running
      ? findCurrentActivity(events)
      : undefined;
  const currentActivityLabel = currentActivity
    ? describeCurrentActivity(currentActivity)
    : undefined;
  // Keying the narration on its visible text is what drives the ticker
  // transition: any wording change swaps the node through AnimatePresence.
  const narrationKey = liveActivity
    ? `${firstLine(liveActivity.body)}|${currentActivityLabel ?? ""}`
    : (currentActivityLabel ?? "thinking");

  useLayoutEffect(() => {
    const previousEvents = previousEventsRef.current;
    const isInitialLayout = previousEvents === null;
    const hasNewUserMessage =
      !isInitialLayout &&
      latestUserId !== undefined &&
      latestUserId !== previousLatestUserIdRef.current;
    const hasTranscriptChanged =
      previousRunningRef.current !== running ||
      (previousEvents !== null &&
        transcriptTailChanged(previousEvents, previousRunningRef.current, events, running));
    previousEventsRef.current = events;
    previousRunningRef.current = running;
    previousLatestUserIdRef.current = latestUserId;

    if (isInitialLayout || hasNewUserMessage || shouldFollowLatestRef.current) {
      shouldFollowLatestRef.current = true;
      setHasNewContent(false);
      scheduleFollow();
    } else if (hasTranscriptChanged) {
      setHasNewContent(true);
    }
  }, [events, latestUserId, running, scheduleFollow]);

  useEffect(() => {
    const container = scrollContainerRef?.current;
    const content = contentRef.current;
    if (!container || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => scheduleFollow());
    observer.observe(container);
    observer.observe(content);
    return () => {
      observer.disconnect();
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

  const jumpToLatest = () => {
    shouldFollowLatestRef.current = true;
    setHasNewContent(false);
    if (scrollContainerRef?.current) scrollToLatest(scrollContainerRef.current, "smooth");
  };

  const copyMessage = useCallback(async (id: string, body: string) => {
    if (!navigator.clipboard?.writeText) {
      setCopyFailureId(id);
      return;
    }
    try {
      await navigator.clipboard.writeText(body);
      setCopiedEventId(id);
      setCopyFailureId(null);
      if (clearCopyStatus.current) window.clearTimeout(clearCopyStatus.current);
      clearCopyStatus.current = window.setTimeout(() => setCopiedEventId(null), 2_000);
    } catch {
      setCopyFailureId(id);
    }
  }, []);

  const askAbout = useCallback((body: string) => askAboutRef.current?.(body), []);
  const regenerate = useCallback(() => regenerateRef.current?.(), []);
  const openFile = useCallback((path: string) => openFileRef.current?.(path), []);

  return (
    <div className="transcript" ref={contentRef} aria-label="Task transcript">
      {hasNewContent ? (
        <button className="transcript-jump-latest" type="button" onClick={jumpToLatest}>
          <span aria-hidden="true">↓</span> New activity · Jump to latest
        </button>
      ) : null}
      {events.map((event, index) => {
        if (index >= renderedEventCount) return null;
        if (event.kind === "user") {
          return (
            <UserMessage
              key={event.id}
              body={event.body}
              nativeSkill={event.nativeSkill}
              timestamp={event.timestamp}
              showTimestamp={showTimestamps}
            />
          );
        }
        if (event.kind === "assistant") {
          const isLatestAssistant = event.id === lastAssistantId;
          const modelLabel = modelForEvent?.(event);
          return (
            <AssistantMessage
              key={event.id}
              id={event.id}
              body={event.body}
              timestamp={event.timestamp}
              modelLabel={modelLabel}
              showTimestamp={showTimestamps}
              copied={copiedEventId === event.id}
              copyFailed={copyFailureId === event.id}
              isLatestAssistant={isLatestAssistant}
              running={running}
              canRegenerate={Boolean(onRegenerate)}
              canAskAbout={Boolean(onAskAbout)}
              onCopy={copyMessage}
              onRegenerate={regenerate}
              onAskAbout={askAbout}
            />
          );
        }
        if (event.kind === "notice") {
          return <NoticeMessage key={event.id} title={event.title} body={event.body} />;
        }
        return (
          <ActivityEvent
            event={event}
            key={event.id}
            onOpenFile={onOpenFile ? openFile : undefined}
            onAddDiffSelection={onAddDiffSelection}
          />
        );
      })}

      {running ? (
        <div className="task-now">
          <button
            className="task-now-toggle"
            type="button"
            onClick={() => liveActivity && setLiveStreamOpen((value) => !value)}
            aria-expanded={liveActivity ? liveStreamOpen : undefined}
            disabled={!liveActivity}
            title={liveActivity ? "Show the live activity stream" : undefined}
          >
            <span className="live-indicator" aria-hidden="true" />
            <span className="task-now-line" role="status" aria-live="polite">
              <AnimatePresence initial={false}>
                <motion.span
                  className="task-now-text"
                  key={narrationKey}
                  initial={{ opacity: 0, y: 14, filter: "blur(2px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, y: -14, filter: "blur(2px)" }}
                  transition={{ duration: 0.32, ease: [0.32, 0.72, 0.24, 1] }}
                >
                  {liveActivity ? (
                    <>
                      <strong className="task-now-label">Activity</strong>
                      <span className="task-now-summary">{firstLine(liveActivity.body)}</span>
                      {currentActivityLabel ? (
                        <span className="task-now-current">Working on {currentActivityLabel}</span>
                      ) : null}
                    </>
                  ) : (
                    <span className="task-now-label">
                      {currentActivityLabel ? `Working on ${currentActivityLabel}` : "Thinking…"}
                    </span>
                  )}
                </motion.span>
              </AnimatePresence>
            </span>
            {liveActivity ? (
              <ChevronRight
                className={liveStreamOpen ? "disclosure disclosure--open-right" : "disclosure"}
              />
            ) : null}
          </button>
          <AnimatePresence initial={false}>
            {liveStreamOpen && liveActivity ? (
              <motion.div
                className="task-now-stream"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22 }}
              >
                {(liveActivity.children?.length ? liveActivity.children : [liveActivity]).map(
                  (child) => (
                    <motion.div
                      key={child.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.24, ease: [0.32, 0.72, 0.24, 1] }}
                    >
                      <ActivityEvent
                        event={child}
                        nested
                        onOpenFile={onOpenFile ? openFile : undefined}
                        onAddDiffSelection={onAddDiffSelection}
                      />
                    </motion.div>
                  ),
                )}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}
    </div>
  );
}

function firstLine(body?: string): string {
  if (!body) return "";
  const line = body.split("\n", 1)[0] ?? "";
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

function findRecentMessageIds(
  events: TranscriptEvent[],
  renderedEventCount: number,
): { lastAssistantId?: string; latestUserId?: string } {
  let lastAssistantId: string | undefined;
  let latestUserId: string | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!latestUserId && event.kind === "user") latestUserId = event.id;
    if (!lastAssistantId && index < renderedEventCount && event.kind === "assistant") {
      lastAssistantId = event.id;
    }
    if (lastAssistantId && latestUserId) break;
  }
  return { lastAssistantId, latestUserId };
}

function transcriptTailChanged(
  previousEvents: TranscriptEvent[],
  previousRunning: boolean,
  events: TranscriptEvent[],
  running: boolean,
): boolean {
  if (previousEvents === events) return false;
  if (previousEvents.length !== events.length) return true;
  const previousTail = previousEvents.at(-1);
  const tail = events.at(-1);
  if (!sameEventSurface(previousTail, tail)) return true;
  if (
    !sameEventSurface(
      lastRenderedEvent(previousEvents, previousRunning),
      lastRenderedEvent(events, running),
    )
  ) {
    return true;
  }
  return !sameEventSurface(
    previousTail ? findActivityLeaf(previousTail) : undefined,
    tail ? findActivityLeaf(tail) : undefined,
  );
}

function lastRenderedEvent(
  events: TranscriptEvent[],
  running: boolean,
): TranscriptEvent | undefined {
  const tail = events.at(-1);
  return running && tail && isActivityEvent(tail) ? events.at(-2) : tail;
}

function sameEventSurface(
  previous: TranscriptEvent | undefined,
  current: TranscriptEvent | undefined,
): boolean {
  if (previous === current) return true;
  if (!previous || !current) return false;
  if (
    previous.id !== current.id ||
    previous.kind !== current.kind ||
    previous.activityType !== current.activityType ||
    previous.title !== current.title ||
    previous.body !== current.body ||
    previous.timestamp !== current.timestamp ||
    previous.status !== current.status ||
    previous.meta !== current.meta ||
    previous.filePath !== current.filePath ||
    previous.expandedByDefault !== current.expandedByDefault ||
    previous.children?.length !== current.children?.length ||
    previous.details?.length !== current.details?.length ||
    previous.diff?.lines.length !== current.diff?.lines.length ||
    previous.diff?.additions !== current.diff?.additions ||
    previous.diff?.deletions !== current.diff?.deletions ||
    previous.changeStats?.additions !== current.changeStats?.additions ||
    previous.changeStats?.deletions !== current.changeStats?.deletions
  ) {
    return false;
  }
  const previousDetails = previous.details;
  const currentDetails = current.details;
  if (previousDetails && currentDetails) {
    for (let index = 0; index < previousDetails.length; index += 1) {
      if (
        previousDetails[index].label !== currentDetails[index].label ||
        previousDetails[index].body !== currentDetails[index].body
      ) {
        return false;
      }
    }
  }
  return true;
}

function findCurrentActivity(events: TranscriptEvent[]): TranscriptEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.children?.length) {
      const nested = findCurrentActivity(event.children);
      if (nested) return nested;
    }
    if (
      event.status === "running" &&
      (event.kind === "activity" || event.kind === "tool" || event.kind === "checkpoint")
    ) {
      return event;
    }
  }
  return undefined;
}

function isActivityEvent(event: TranscriptEvent): boolean {
  return (
    event.kind === "activity" ||
    event.kind === "tool" ||
    event.kind === "checkpoint" ||
    event.kind === "approval"
  );
}

function findTrailingActivity(events: TranscriptEvent[]): TranscriptEvent | undefined {
  const last = events[events.length - 1];
  return last && isActivityEvent(last) ? last : undefined;
}

function findActivityLeaf(event: TranscriptEvent): TranscriptEvent {
  const children = event.children;
  return children?.length ? findActivityLeaf(children[children.length - 1]) : event;
}

function describeCurrentActivity(event: TranscriptEvent): string {
  const detail = firstLine(event.body);
  if (event.activityType === "command" && detail) return detail;
  if (event.title && detail && detail !== event.title) return `${event.title} · ${detail}`;
  return event.title ?? detail ?? "the task";
}

