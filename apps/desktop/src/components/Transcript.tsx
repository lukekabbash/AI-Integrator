import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer, type Range } from "@tanstack/react-virtual";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AnimatePresence, m as motion } from "motion/react";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  Copy,
  CornerDownLeft,
  GitBranch,
  Info,
  Layers,
  MessageCircleQuestion,
  Pencil,
  RefreshCw,
  Search,
  TerminalSquare,
  Wrench,
  X,
} from "lucide-react";
import { bridge, openExternalLink, attachmentKind, type TranscriptEvent } from "../bridge";
import { DiffView, type DiffSelectionPayload } from "./DiffView";
import { FileIcon } from "./FileIcon";
import { Tooltip } from "./Tooltip";
import { splitAttachmentBlock } from "./conversationFormatting";
import { stabilizeStreamingMarkdown } from "./streamStableMarkdown";
import {
  readTranscriptViewportState,
  writeTranscriptViewportState,
  type TranscriptAnchor,
  type TranscriptViewportState,
} from "./transcriptViewportState";

const FOLLOW_THRESHOLD_PX = 96;
const VIRTUALIZATION_THRESHOLD = 250;
const MINIMUM_ROW_HEIGHT_PX = 26;
const OVERSCAN_VIEWPORTS = 1.5;

interface TranscriptProps {
  events: TranscriptEvent[];
  /** Stable task/delegation identity used for local viewport restoration. */
  ownerKey?: string;
  /** Emergency fallback for platform-specific rendering issues. */
  virtualizationEnabled?: boolean;
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
  /** Copies the chat up to this reply into a new one to follow up in. */
  onBranch?: (eventId: string) => void;
  /**
   * Returns a user message to the composer for editing. Allowed while a turn
   * is streaming — the host cancels first, then restores the prompt.
   */
  onEditUserMessage?: (eventId: string, body: string) => void;
  /** Opens an observable file in the Files tab of the right rail. */
  onOpenFile?: (path: string) => void;
  /** Selection-to-chat from transcript-embedded diffs. */
  onAddDiffSelection?: (payload: DiffSelectionPayload) => void;
}

interface AttachmentPreviewCache {
  values: Map<string, string | null>;
  requests: Map<string, Promise<string | null>>;
}

function loadAttachmentPreview(
  cache: AttachmentPreviewCache,
  path: string,
): Promise<string | null> {
  if (cache.values.has(path)) return Promise.resolve(cache.values.get(path) ?? null);
  const pending = cache.requests.get(path);
  if (pending) return pending;
  if (!bridge.readAttachmentPreview) return Promise.resolve(null);

  const request = bridge
    .readAttachmentPreview(path)
    .then((preview) => {
      cache.values.set(path, preview);
      cache.requests.delete(path);
      return preview;
    })
    .catch(() => {
      cache.values.set(path, null);
      cache.requests.delete(path);
      return null;
    });
  cache.requests.set(path, request);
  return request;
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

const MarkdownBody = memo(function MarkdownBody({
  body,
  streaming = false,
}: {
  body: string;
  /** When true, also hold thematic-break candidates until the stream settles. */
  streaming?: boolean;
}) {
  const source = stabilizeStreamingMarkdown(body, streaming);
  return (
    <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
      {source}
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

function AttachmentThumb({
  path,
  previewCache,
}: {
  path: string;
  previewCache: AttachmentPreviewCache;
}) {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  const isImage = attachmentKind(name) === "image";
  const [preview, setPreview] = useState<string | null>(
    () => previewCache.values.get(path) ?? null,
  );
  useEffect(() => {
    if (!isImage) return;
    let active = true;
    void loadAttachmentPreview(previewCache, path).then((dataUrl) => {
      if (active) setPreview(dataUrl);
    });
    return () => {
      active = false;
    };
  }, [isImage, path, previewCache]);
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
  id,
  body,
  nativeSkill,
  timestamp,
  showTimestamp,
  previewCache,
  copied,
  copyFailed,
  canEdit,
  onCopy,
  onEdit,
}: {
  id: string;
  body: string;
  nativeSkill?: string;
  timestamp: string;
  showTimestamp: boolean;
  previewCache: AttachmentPreviewCache;
  copied: boolean;
  copyFailed: boolean;
  canEdit: boolean;
  onCopy: (id: string, body: string) => void;
  onEdit: (id: string, body: string) => void;
}) {
  const skillPrefix = nativeSkill ? `/${nativeSkill}` : "";
  const hasVerifiedSkill =
    Boolean(skillPrefix) && (body === skillPrefix || body.startsWith(`${skillPrefix} `));
  const { text, attachments } = splitAttachmentBlock(body);
  const tail = hasVerifiedSkill ? text.slice(skillPrefix.length) : text;
  const clock = showTimestamp ? formatClock(timestamp) : "";
  return (
    <div className="turn-user-wrap">
      <section className="turn turn--user" data-event-id={id} aria-label="Your message">
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
              <AttachmentThumb key={path} path={path} previewCache={previewCache} />
            ))}
          </span>
        ) : null}
      </section>
      <div className="message-footer message-footer--user">
        {clock ? (
          <time className="message-time" dateTime={timestamp}>
            {clock}
          </time>
        ) : null}
        <div className="message-actions">
          <Tooltip
            label={
              copyFailed ? "Clipboard unavailable" : copied ? "Copied" : "Copy message"
            }
          >
            <button
              type="button"
              className={copied ? "is-copied" : undefined}
              onClick={() => onCopy(id, body)}
              aria-label="Copy this message"
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </button>
          </Tooltip>
          {canEdit ? (
            <Tooltip label="Edit" hint="Return to composer and continue from here">
              <button
                type="button"
                onClick={() => onEdit(id, body)}
                aria-label="Edit this message"
              >
                <CornerDownLeft aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </div>
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
  canBranch,
  canAskAbout,
  onCopy,
  onRegenerate,
  onBranch,
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
  canBranch: boolean;
  canAskAbout: boolean;
  onCopy: (id: string, body: string) => void;
  onRegenerate: () => void;
  onBranch: (id: string) => void;
  onAskAbout: (body: string) => void;
}) {
  const clock = showTimestamp ? formatClock(timestamp) : "";
  const showTurnActions = canBranch && !running;
  return (
    <section className="turn turn--assistant" data-event-id={id} aria-label="Agent response">
      {modelLabel ? (
        <header className="turn-attribution">
          <span className="turn-attribution-model">{modelLabel}</span>
        </header>
      ) : null}
      <MarkdownBody body={body} streaming={running} />
      <div className="message-footer message-footer--assistant">
        <div className="message-actions">
          <Tooltip
            label={
              copyFailed ? "Clipboard unavailable" : copied ? "Copied" : "Copy response"
            }
          >
            <button
              type="button"
              className={copied ? "is-copied" : undefined}
              onClick={() => onCopy(id, body)}
              aria-label="Copy this response"
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </button>
          </Tooltip>
          {showTurnActions ? (
            <Tooltip label="Branch" hint="Continue in a copy that ends here">
              <button
                type="button"
                onClick={() => onBranch(id)}
                aria-label="Branch the chat from this response"
              >
                <GitBranch aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}
          {showTurnActions && canRegenerate && isLatestAssistant ? (
            <Tooltip label="Regenerate" hint="Run the same prompt again">
              <button
                type="button"
                onClick={onRegenerate}
                aria-label="Regenerate this response"
              >
                <RefreshCw aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}
          {showTurnActions && canAskAbout ? (
            <Tooltip label="Ask about this" hint="Draft a follow-up in the composer">
              <button
                type="button"
                onClick={() => onAskAbout(body)}
                aria-label="Ask a follow-up about this response"
              >
                <MessageCircleQuestion aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}
        </div>
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
  id,
  title,
  body,
}: {
  id: string;
  title?: string;
  body: string;
}) {
  return (
    <aside className="inline-notice" data-event-id={id}>
      <Info />
      <span>
        <strong>{title}</strong>
        {body}
      </span>
    </aside>
  );
});

function activityGlyphKind(
  event: TranscriptEvent,
): "edit" | "read" | "search" | "command" | "tool" | "activity" | "approval" | "reasoning" | "other" {
  const title = event.title ?? "";
  if (/^(Read|Reads|Reading)\b/i.test(title)) return "read";
  if (/^(Search|Searches|Searching|Searched)\b/i.test(title)) return "search";
  if (/^(Edit|Edits|Editing|Edited|Creat|Creating|Created|Added|Deleted|Renamed|Changed)\b/i.test(title)) {
    return "edit";
  }
  if (event.activityType === "file") return "edit";
  if (event.activityType === "command" || /^(Command|Commands|Running)\b/i.test(title)) {
    return "command";
  }
  if (event.activityType === "approval" || event.kind === "approval") return "approval";
  if (event.activityType === "reasoning") return "reasoning";
  if (event.activityType === "tool") return "tool";
  if (
    event.kind === "activity" ||
    /^(Activity|Working|Worked)\b/i.test(title) ||
    Boolean(event.children?.length)
  ) {
    return "activity";
  }
  return "other";
}

function EventIcon({ event }: { event: TranscriptEvent }) {
  if (event.status === "error") return <X aria-hidden="true" />;
  if (event.status === "warning") return <Info aria-hidden="true" />;

  const running = event.status === "running";
  const kind = activityGlyphKind(event);
  const activeClass = running ? "activity-icon--active" : undefined;

  switch (kind) {
    case "edit":
      return (
        <Pencil
          className={running ? "activity-icon-pencil--writing" : undefined}
          aria-hidden="true"
        />
      );
    case "read":
      return <BookOpen className={activeClass} aria-hidden="true" />;
    case "search":
      return <Search className={activeClass} aria-hidden="true" />;
    case "command":
      return running ? (
        <Circle className="spin-slow" aria-hidden="true" />
      ) : (
        <TerminalSquare aria-hidden="true" />
      );
    case "tool":
      return running ? (
        <Circle className="spin-slow" aria-hidden="true" />
      ) : (
        <Wrench aria-hidden="true" />
      );
    case "approval":
      return <MessageCircleQuestion className={activeClass} aria-hidden="true" />;
    case "reasoning":
      return running ? (
        <Circle className="spin-slow" aria-hidden="true" />
      ) : (
        <Info aria-hidden="true" />
      );
    case "activity":
      return running ? (
        <Circle className="spin-slow" aria-hidden="true" />
      ) : (
        <Layers aria-hidden="true" />
      );
    default:
      return running ? <Circle className="spin-slow" aria-hidden="true" /> : null;
  }
}

interface ActivityEventProps {
  event: TranscriptEvent;
  nested?: boolean;
  isExpanded: (event: TranscriptEvent) => boolean;
  onExpandedChange: (eventId: string, expanded: boolean) => void;
  onOpenFile?: (path: string) => void;
  onAddDiffSelection?: (payload: DiffSelectionPayload) => void;
}

const ActivityEvent = memo(function ActivityEventRow({
  event,
  nested = false,
  isExpanded,
  onExpandedChange,
  onOpenFile,
  onAddDiffSelection,
}: ActivityEventProps): React.ReactElement {
  const expanded = isExpanded(event);
  const hasChildren = Boolean(event.children?.length);
  const hasDetails = Boolean(event.details?.length);
  const hasDiff = Boolean(event.diff?.lines.length);
  const filePath = event.filePath ?? event.diff?.path;
  const displayBody = activityDisplayBody(event);
  const pathOnlyBody = Boolean(filePath && event.body === filePath);
  const hasLongBody = Boolean(
    event.title &&
      event.body &&
      !pathOnlyBody &&
      (event.body.length > 96 || event.body.includes("\n")),
  );
  const expandable = hasChildren || hasDetails || hasLongBody || hasDiff;
  const canOpenFile = Boolean(filePath && onOpenFile && event.title);
  const isWorkedFor = event.title === "Worked for";
  const toggleExpanded = () => {
    if (expandable) onExpandedChange(event.id, !expanded);
  };
  return (
    <motion.div
      className={`activity-event${hasChildren ? " activity-event--group" : ""}${nested ? " activity-event--nested" : ""}${isWorkedFor ? " activity-event--worked-for" : ""}`}
      data-event-id={event.id}
      data-status={event.status ?? "neutral"}
      initial={isWorkedFor ? { opacity: 0, y: -6 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={isWorkedFor ? { opacity: 0, height: 0, marginBottom: 0 } : undefined}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="activity-event-summary">
        <div
          className="activity-event-toggle"
          role={expandable ? "button" : undefined}
          tabIndex={expandable ? 0 : undefined}
          aria-expanded={expandable ? expanded : undefined}
          onClick={toggleExpanded}
          onKeyDown={(keyboardEvent) => {
            if (!expandable) return;
            if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
              keyboardEvent.preventDefault();
              toggleExpanded();
            }
          }}
        >
          <span className="activity-icon">
            <EventIcon event={event} />
          </span>
          <span className="activity-copy">
            <strong>{event.title ?? event.body}</strong>
            {canOpenFile && filePath && onOpenFile ? (
              <button
                className="activity-file-name"
                type="button"
                title={filePath}
                aria-label={`Open ${filePath} in Files`}
                onClick={(clickEvent) => {
                  clickEvent.stopPropagation();
                  onOpenFile(filePath);
                }}
                onKeyDown={(keyboardEvent) => keyboardEvent.stopPropagation()}
              >
                {displayBody}
              </button>
            ) : event.title ? (
              <span title={pathOnlyBody && filePath ? filePath : undefined}>{displayBody}</span>
            ) : null}
          </span>
          {event.changeStats || event.meta ? (
            <span className="activity-event-meta">
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
            </span>
          ) : null}
          <span className="activity-event-disclosure" aria-hidden="true">
            {expandable ? (
              <ChevronRight
                className={expanded ? "disclosure disclosure--open-right" : "disclosure"}
              />
            ) : null}
          </span>
        </div>
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
            {event.children.map((child) =>
              child.kind === "assistant" ? (
                <section
                  className="activity-nested-assistant"
                  data-event-id={child.id}
                  key={child.id}
                  aria-label="Agent response"
                >
                  <MarkdownBody body={child.body} streaming={false} />
                </section>
              ) : (
                <ActivityEvent
                  event={child}
                  key={child.id}
                  nested
                  isExpanded={isExpanded}
                  onExpandedChange={onExpandedChange}
                  onOpenFile={onOpenFile}
                  onAddDiffSelection={onAddDiffSelection}
                />
              ),
            )}
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
    </motion.div>
  );
});

interface RowMargins {
  top: number;
  bottom: number;
}

function transcriptRowMargins(event: TranscriptEvent): RowMargins {
  if (event.kind === "assistant") return { top: 10, bottom: 18 };
  if (event.kind === "user") return { top: 0, bottom: 16 };
  if (event.kind === "notice") return { top: 10, bottom: 10 };
  return { top: 0, bottom: 2 };
}

function transcriptRowSpacing(events: TranscriptEvent[], index: number, count: number) {
  const current = transcriptRowMargins(events[index]);
  const previous = index > 0 ? transcriptRowMargins(events[index - 1]) : undefined;
  return {
    paddingTop: previous ? Math.max(previous.bottom, current.top) : current.top,
    paddingBottom: index === count - 1 ? current.bottom : 0,
  };
}

function estimateTranscriptRowSize(event: TranscriptEvent): number {
  const explicitLines = event.body.split("\n").length;
  const wrappedLines = Math.ceil(event.body.length / 82);
  const lines = Math.max(explicitLines, wrappedLines);
  if (event.kind === "assistant") return Math.min(520, 54 + lines * 21);
  if (event.kind === "user") return Math.min(320, 34 + lines * 20);
  if (event.kind === "notice") return Math.min(220, 38 + lines * 18);
  return event.expandedByDefault ? 96 : 28;
}

const TRANSCRIPT_SEARCH_TEXT = new WeakMap<TranscriptEvent, string>();

function transcriptSearchText(event: TranscriptEvent): string {
  const cached = TRANSCRIPT_SEARCH_TEXT.get(event);
  if (cached !== undefined) return cached;
  const text = [
    event.title,
    event.body,
    event.meta,
    event.filePath,
    event.diff?.path,
    event.diff?.lines.map((line) => line.content).join("\n"),
    event.details?.map((detail) => `${detail.label}\n${detail.body}`).join("\n"),
    event.children?.map((child) => transcriptSearchText(child)).join("\n"),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  TRANSCRIPT_SEARCH_TEXT.set(event, text);
  return text;
}

function sameNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function Transcript({
  events,
  ownerKey,
  virtualizationEnabled: virtualizationAllowed = true,
  running = false,
  scrollContainerRef,
  onAskAbout,
  modelForEvent,
  showTimestamps = true,
  onRegenerate,
  onBranch,
  onEditUserMessage,
  onOpenFile,
  onAddDiffSelection,
}: TranscriptProps) {
  const [initialViewportState] = useState(() => readTranscriptViewportState(ownerKey));
  const [copiedEventId, setCopiedEventId] = useState<string | null>(null);
  const [copyFailureId, setCopyFailureId] = useState<string | null>(null);
  const [hasNewContent, setHasNewContent] = useState(false);
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>(
    () => initialViewportState?.expanded ?? {},
  );
  const [pinnedIndices, setPinnedIndices] = useState<number[]>([]);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchMatch, setActiveSearchMatch] = useState(0);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [liveStream, setLiveStream] = useState({ running, open: false });
  if (liveStream.running !== running) {
    setLiveStream({ running, open: false });
  }
  const liveStreamOpen = liveStream.open;
  const clearCopyStatus = useRef<number | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement>(null);
  const virtualListRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchReturnAnchorRef = useRef<TranscriptAnchor | undefined>(undefined);
  const previewCacheRef = useRef<AttachmentPreviewCache>({
    values: new Map(),
    requests: new Map(),
  });
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const renderedEventCountRef = useRef(events.length);
  const shouldFollowLatestRef = useRef(initialViewportState?.following ?? true);
  const previousEventsRef = useRef<TranscriptEvent[] | null>(null);
  const previousRunningRef = useRef(running);
  const previousLatestUserIdRef = useRef<string | undefined>(undefined);
  const scheduledFrameRef = useRef<number | undefined>(undefined);
  const restoreFrameRef = useRef<number | undefined>(undefined);
  const saveViewportTimerRef = useRef<number | undefined>(undefined);
  const viewportStateRef = useRef<TranscriptViewportState>(
    initialViewportState ?? {
      following: true,
      expanded: {},
      updatedAt: Date.now(),
    },
  );
  const askAboutRef = useRef(onAskAbout);
  const regenerateRef = useRef(onRegenerate);
  const branchRef = useRef(onBranch);
  const editUserRef = useRef(onEditUserMessage);
  const openFileRef = useRef(onOpenFile);
  const addDiffSelectionRef = useRef(onAddDiffSelection);

  const liveActivity = running ? findTrailingActivity(events) : undefined;
  const renderedEventCount = events.length - (liveActivity ? 1 : 0);
  renderedEventCountRef.current = renderedEventCount;
  const virtualizationEnabled =
    virtualizationAllowed &&
    renderedEventCount > VIRTUALIZATION_THRESHOLD &&
    Boolean(scrollContainerRef);
  const setContentNode = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      if (virtualizationEnabled) {
        const container = scrollContainerRef?.current ?? node?.parentElement;
        setScrollElement(container instanceof HTMLDivElement ? container : null);
      }
    },
    [scrollContainerRef, virtualizationEnabled],
  );
  const { lastAssistantId, latestUserId } = findRecentMessageIds(events, renderedEventCount);
  const turnFinalAssistantIds = useMemo(
    () => findTurnFinalAssistantIds(events, renderedEventCount),
    [events, renderedEventCount],
  );
  const currentActivity = liveActivity
    ? findActivityLeaf(liveActivity)
    : running
      ? findCurrentActivity(events)
      : undefined;
  const currentActivityLabel = currentActivity
    ? describeCurrentActivity(currentActivity)
    : undefined;
  // Connection wait stays generic — the live indicator already signals an
  // active run, and naming the runtime here raced the connection banner.
  const waitingLabel = "Connecting";
  // Keying the narration on its visible text is what drives the ticker
  // transition: any wording change swaps the node through AnimatePresence.
  const narrationKey = liveActivity
    ? `${firstLine(liveActivity.body)}|${currentActivityLabel ?? ""}`
    : (currentActivityLabel ?? waitingLabel);
  const deferredSearchQuery = useDeferredValue(searchQuery.trim().toLocaleLowerCase());
  const searchMatches = useMemo(() => {
    if (!searchOpen || !deferredSearchQuery) return [];
    const matches: number[] = [];
    for (let index = 0; index < renderedEventCount; index += 1) {
      if (transcriptSearchText(events[index]).includes(deferredSearchQuery)) matches.push(index);
    }
    return matches;
  }, [deferredSearchQuery, events, renderedEventCount, searchOpen]);
  const normalizedActiveSearchMatch =
    searchMatches.length > 0 ? activeSearchMatch % searchMatches.length : 0;
  const activeSearchIndex = searchMatches[normalizedActiveSearchMatch];
  const searchMatchSet = useMemo(() => new Set(searchMatches), [searchMatches]);

  const getItemKey = useCallback((index: number) => eventsRef.current[index]?.id ?? index, []);
  const estimateSize = useCallback((index: number) => {
    const source = eventsRef.current;
    const event = source[index];
    if (!event) return MINIMUM_ROW_HEIGHT_PX;
    const spacing = transcriptRowSpacing(source, index, renderedEventCountRef.current);
    return estimateTranscriptRowSize(event) + spacing.paddingTop + spacing.paddingBottom;
  }, []);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const viewportHeight = scrollContainerRef?.current?.clientHeight ?? 0;
      const extraRows = Math.ceil((viewportHeight * OVERSCAN_VIEWPORTS) / MINIMUM_ROW_HEIGHT_PX);
      const first = Math.max(0, range.startIndex - extraRows);
      const last = Math.min(range.count - 1, range.endIndex + extraRows);
      const indexes = new Set(pinnedIndices);
      if (activeSearchIndex !== undefined) indexes.add(activeSearchIndex);
      for (let index = first; index <= last; index += 1) indexes.add(index);
      return [...indexes]
        .filter((index) => index >= 0 && index < range.count)
        .sort((a, b) => a - b);
    },
    [activeSearchIndex, pinnedIndices, scrollContainerRef],
  );

  // TanStack Virtual is intentionally imperative; React Compiler skips this
  // component while the rest of the renderer remains compiler-compatible.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: renderedEventCount,
    getScrollElement: () => scrollElement,
    estimateSize,
    getItemKey,
    rangeExtractor,
    scrollMargin,
    overscan: 0,
    enabled: virtualizationEnabled,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: FOLLOW_THRESHOLD_PX,
    useFlushSync: false,
  });

  useEffect(() => {
    askAboutRef.current = onAskAbout;
    regenerateRef.current = onRegenerate;
    branchRef.current = onBranch;
    editUserRef.current = onEditUserMessage;
    openFileRef.current = onOpenFile;
    addDiffSelectionRef.current = onAddDiffSelection;
  }, [onAddDiffSelection, onAskAbout, onBranch, onEditUserMessage, onOpenFile, onRegenerate]);

  const queueViewportSave = useCallback(() => {
    if (!ownerKey) return;
    viewportStateRef.current.updatedAt = Date.now();
    if (saveViewportTimerRef.current !== undefined) {
      window.clearTimeout(saveViewportTimerRef.current);
    }
    saveViewportTimerRef.current = window.setTimeout(() => {
      saveViewportTimerRef.current = undefined;
      writeTranscriptViewportState(ownerKey, viewportStateRef.current);
    }, 180);
  }, [ownerKey]);

  const captureVisibleAnchor = useCallback((): TranscriptAnchor | undefined => {
    const container = scrollContainerRef?.current;
    const content = contentRef.current;
    if (!container || !content) return undefined;
    const rows = virtualizationEnabled
      ? Array.from(content.querySelectorAll<HTMLElement>(".transcript-virtual-row"))
      : Array.from(content.children).filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement && Boolean(child.dataset.eventId),
        );
    const viewport = container.getBoundingClientRect();
    const visible = rows
      .map((row) => ({ row, rect: row.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > viewport.top && rect.top < viewport.bottom)
      .sort((left, right) => left.rect.top - right.rect.top)[0];
    const eventId = visible?.row.dataset.eventId;
    return eventId ? { eventId, offsetPx: visible.rect.top - viewport.top } : undefined;
  }, [scrollContainerRef, virtualizationEnabled]);

  const restoreAnchor = useCallback(
    (anchor: TranscriptAnchor): boolean => {
      if (!(scrollContainerRef?.current ?? scrollElement)) return false;
      const index = eventsRef.current.findIndex((event) => event.id === anchor.eventId);
      if (index < 0) return false;
      if (virtualizationEnabled) rowVirtualizer.scrollToIndex(index, { align: "start" });

      const alignMeasuredRow = () => {
        const container = scrollContainerRef?.current;
        const content = contentRef.current;
        if (!container || !content) return;
        const row = Array.from(content.querySelectorAll<HTMLElement>("[data-event-id]")).find(
          (candidate) => candidate.dataset.eventId === anchor.eventId,
        );
        if (!row) return;
        const currentOffset =
          row.getBoundingClientRect().top - container.getBoundingClientRect().top;
        container.scrollTop += currentOffset - anchor.offsetPx;
      };

      restoreFrameRef.current = window.requestAnimationFrame(() => {
        if (virtualizationEnabled) {
          restoreFrameRef.current = window.requestAnimationFrame(() => {
            restoreFrameRef.current = undefined;
            alignMeasuredRow();
          });
        } else {
          restoreFrameRef.current = undefined;
          alignMeasuredRow();
        }
      });
      return true;
    },
    [rowVirtualizer, scrollContainerRef, scrollElement, virtualizationEnabled],
  );

  const openTranscriptSearch = useCallback(() => {
    if (!searchOpen) searchReturnAnchorRef.current = captureVisibleAnchor();
    setSearchOpen(true);
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [captureVisibleAnchor, searchOpen]);

  const closeTranscriptSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setActiveSearchMatch(0);
    const anchor = searchReturnAnchorRef.current;
    searchReturnAnchorRef.current = undefined;
    if (anchor) restoreAnchor(anchor);
  }, [restoreAnchor]);

  const moveSearchMatch = useCallback(
    (direction: 1 | -1) => {
      if (searchMatches.length === 0) return;
      setActiveSearchMatch(
        (current) => (current + direction + searchMatches.length) % searchMatches.length,
      );
    },
    [searchMatches.length],
  );

  const updateScrollMargin = useCallback(() => {
    if (!virtualizationEnabled) return;
    const container = scrollContainerRef?.current;
    const list = virtualListRef.current;
    if (!container || !list) return;
    const next =
      list.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop;
    setScrollMargin((current) => (Math.abs(current - next) > 0.5 ? next : current));
  }, [scrollContainerRef, virtualizationEnabled]);

  const isActivityExpanded = useCallback(
    (event: TranscriptEvent) => expandedEvents[event.id] ?? event.expandedByDefault ?? false,
    [expandedEvents],
  );
  const setActivityExpanded = useCallback(
    (eventId: string, expanded: boolean) => {
      setExpandedEvents((current) => {
        if (current[eventId] === expanded) return current;
        const next = { ...current, [eventId]: expanded };
        viewportStateRef.current.expanded = next;
        queueViewportSave();
        return next;
      });
    },
    [queueViewportSave],
  );

  useEffect(() => {
    const container = scrollContainerRef?.current;
    if (!virtualizationEnabled || !container) return;
    const handleFindShortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLocaleLowerCase() !== "f" ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      openTranscriptSearch();
    };
    container.addEventListener("keydown", handleFindShortcut);
    return () => container.removeEventListener("keydown", handleFindShortcut);
  }, [openTranscriptSearch, scrollContainerRef, virtualizationEnabled]);

  useEffect(() => {
    if (!searchOpen || activeSearchIndex === undefined) return;
    shouldFollowLatestRef.current = false;
    viewportStateRef.current.following = false;
    rowVirtualizer.scrollToIndex(activeSearchIndex, { align: "center" });
  }, [activeSearchIndex, rowVirtualizer, searchOpen]);

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
      viewportStateRef.current.following = shouldFollow;
      if (!shouldFollow) {
        viewportStateRef.current.anchor = captureVisibleAnchor() ?? viewportStateRef.current.anchor;
      }
      queueViewportSave();
    };

    // Follow state changes only on real scroll events. Probing the position
    // here would read scrollTop 0 on a freshly mounted, already-populated
    // chat and misfile "just opened" as "scrolled away from the latest".
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [captureVisibleAnchor, queueViewportSave, scrollContainerRef]);

  useEffect(() => {
    const content = contentRef.current;
    if (!virtualizationEnabled || !content) return;

    const indexForNode = (node: Node | null): number | undefined => {
      const element = node instanceof Element ? node : node?.parentElement;
      const row = element?.closest<HTMLElement>(".transcript-virtual-row");
      if (!row || !content.contains(row)) return undefined;
      const index = Number(row.dataset.index);
      return Number.isInteger(index) ? index : undefined;
    };
    const updatePinnedRows = () => {
      const selection = window.getSelection();
      const next = new Set<number>();
      const activeIndex = indexForNode(document.activeElement);
      if (activeIndex !== undefined) next.add(activeIndex);
      if (selection && !selection.isCollapsed) {
        const anchorIndex = indexForNode(selection.anchorNode);
        const focusIndex = indexForNode(selection.focusNode);
        if (anchorIndex !== undefined) next.add(anchorIndex);
        if (focusIndex !== undefined) next.add(focusIndex);
        if (next.size > 0) {
          shouldFollowLatestRef.current = false;
          viewportStateRef.current.following = false;
          viewportStateRef.current.anchor =
            captureVisibleAnchor() ?? viewportStateRef.current.anchor;
          queueViewportSave();
        }
      }
      const sorted = [...next].sort((a, b) => a - b);
      setPinnedIndices((current) => (sameNumbers(current, sorted) ? current : sorted));
    };

    document.addEventListener("selectionchange", updatePinnedRows);
    content.addEventListener("focusin", updatePinnedRows);
    content.addEventListener("focusout", updatePinnedRows);
    return () => {
      document.removeEventListener("selectionchange", updatePinnedRows);
      content.removeEventListener("focusin", updatePinnedRows);
      content.removeEventListener("focusout", updatePinnedRows);
    };
  }, [captureVisibleAnchor, queueViewportSave, virtualizationEnabled]);

  useLayoutEffect(() => {
    const previousEvents = previousEventsRef.current;
    const isInitialLayout = previousEvents === null;
    if (
      isInitialLayout &&
      !shouldFollowLatestRef.current &&
      initialViewportState?.anchor &&
      virtualizationEnabled &&
      !scrollElement
    ) {
      return;
    }
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

    if (
      isInitialLayout &&
      !shouldFollowLatestRef.current &&
      initialViewportState?.anchor &&
      restoreAnchor(initialViewportState.anchor)
    ) {
      setHasNewContent(false);
    } else if (isInitialLayout || hasNewUserMessage || shouldFollowLatestRef.current) {
      shouldFollowLatestRef.current = true;
      viewportStateRef.current.following = true;
      setHasNewContent(false);
      scheduleFollow();
    } else if (hasTranscriptChanged) {
      setHasNewContent(true);
    }
  }, [
    events,
    initialViewportState,
    latestUserId,
    restoreAnchor,
    running,
    scheduleFollow,
    scrollElement,
    virtualizationEnabled,
  ]);

  useLayoutEffect(() => {
    updateScrollMargin();
  }, [events, hasNewContent, updateScrollMargin]);

  useEffect(() => {
    const container = scrollContainerRef?.current;
    const content = contentRef.current;
    if (!container || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateScrollMargin();
      scheduleFollow();
    });
    observer.observe(container);
    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, [scheduleFollow, scrollContainerRef, updateScrollMargin]);

  useEffect(
    () => () => {
      if (clearCopyStatus.current) window.clearTimeout(clearCopyStatus.current);
      if (saveViewportTimerRef.current !== undefined) {
        window.clearTimeout(saveViewportTimerRef.current);
        saveViewportTimerRef.current = undefined;
      }
      if (scheduledFrameRef.current !== undefined) {
        window.cancelAnimationFrame(scheduledFrameRef.current);
      }
      if (restoreFrameRef.current !== undefined) {
        window.cancelAnimationFrame(restoreFrameRef.current);
      }
      if (ownerKey) writeTranscriptViewportState(ownerKey, viewportStateRef.current);
    },
    [ownerKey],
  );

  const jumpToLatest = () => {
    shouldFollowLatestRef.current = true;
    viewportStateRef.current.following = true;
    setHasNewContent(false);
    queueViewportSave();
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
  const branch = useCallback((id: string) => branchRef.current?.(id), []);
  const editUser = useCallback(
    (id: string, body: string) => editUserRef.current?.(id, body),
    [],
  );
  const openFile = useCallback((path: string) => openFileRef.current?.(path), []);
  const addDiffSelection = useCallback(
    (payload: DiffSelectionPayload) => addDiffSelectionRef.current?.(payload),
    [],
  );

  const renderTranscriptEvent = (event: TranscriptEvent) => {
    if (event.kind === "user") {
      return (
        <UserMessage
          key={event.id}
          id={event.id}
          body={event.body}
          nativeSkill={event.nativeSkill}
          timestamp={event.timestamp}
          showTimestamp={showTimestamps}
          previewCache={previewCacheRef.current}
          copied={copiedEventId === event.id}
          copyFailed={copyFailureId === event.id}
          canEdit={Boolean(onEditUserMessage)}
          onCopy={copyMessage}
          onEdit={editUser}
        />
      );
    }
    if (event.kind === "assistant") {
      const isLatestAssistant = event.id === lastAssistantId;
      return (
        <AssistantMessage
          key={event.id}
          id={event.id}
          body={event.body}
          timestamp={event.timestamp}
          modelLabel={modelForEvent?.(event)}
          showTimestamp={showTimestamps}
          copied={copiedEventId === event.id}
          copyFailed={copyFailureId === event.id}
          isLatestAssistant={isLatestAssistant}
          running={isLatestAssistant && running}
          canRegenerate={Boolean(onRegenerate)}
          canBranch={Boolean(onBranch) && turnFinalAssistantIds.has(event.id)}
          canAskAbout={Boolean(onAskAbout)}
          onCopy={copyMessage}
          onRegenerate={regenerate}
          onBranch={branch}
          onAskAbout={askAbout}
        />
      );
    }
    if (event.kind === "notice") {
      return <NoticeMessage key={event.id} id={event.id} title={event.title} body={event.body} />;
    }
    return (
      <ActivityEvent
        event={event}
        key={event.id}
        isExpanded={isActivityExpanded}
        onExpandedChange={setActivityExpanded}
        onOpenFile={onOpenFile ? openFile : undefined}
        onAddDiffSelection={onAddDiffSelection ? addDiffSelection : undefined}
      />
    );
  };

  const virtualItems = virtualizationEnabled ? rowVirtualizer.getVirtualItems() : [];

  return (
    <div
      className={`transcript${virtualizationEnabled ? " transcript--virtualized" : ""}`}
      ref={setContentNode}
      aria-label="Task transcript"
    >
      {searchOpen ? (
        <div className="transcript-search-shell">
          <div className="transcript-search" role="search" aria-label="Find in transcript">
            <Search aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setActiveSearchMatch(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeTranscriptSearch();
                if (event.key === "Enter") moveSearchMatch(event.shiftKey ? -1 : 1);
              }}
              placeholder="Find in transcript"
              aria-label="Find in transcript"
            />
            <span className="transcript-search-count" aria-live="polite">
              {searchQuery
                ? searchMatches.length > 0
                  ? `${normalizedActiveSearchMatch + 1} of ${searchMatches.length}`
                  : "No results"
                : ""}
            </span>
            <button
              type="button"
              onClick={() => moveSearchMatch(-1)}
              disabled={searchMatches.length === 0}
              aria-label="Previous transcript result"
            >
              <ChevronUp aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => moveSearchMatch(1)}
              disabled={searchMatches.length === 0}
              aria-label="Next transcript result"
            >
              <ChevronDown aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={closeTranscriptSearch}
              aria-label="Close transcript search"
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
      {hasNewContent ? (
        <button className="transcript-jump-latest" type="button" onClick={jumpToLatest}>
          <span aria-hidden="true">↓</span> New activity · Jump to latest
        </button>
      ) : null}
      {virtualizationEnabled ? (
        <div
          className="transcript-virtual-list"
          ref={virtualListRef}
          role="list"
          style={{ height: rowVirtualizer.getTotalSize() }}
        >
          {virtualItems.map((virtualRow) => {
            const event = events[virtualRow.index];
            if (!event) return null;
            const spacing = transcriptRowSpacing(events, virtualRow.index, renderedEventCount);
            return (
              <div
                className="transcript-virtual-row"
                key={virtualRow.key}
                ref={rowVirtualizer.measureElement}
                role="listitem"
                aria-posinset={virtualRow.index + 1}
                aria-setsize={renderedEventCount}
                data-index={virtualRow.index}
                data-event-id={event.id}
                data-search-match={searchMatchSet.has(virtualRow.index) ? "true" : undefined}
                data-search-current={virtualRow.index === activeSearchIndex ? "true" : undefined}
                style={{
                  paddingTop: spacing.paddingTop,
                  paddingBottom: spacing.paddingBottom,
                  transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                }}
              >
                {renderTranscriptEvent(event)}
              </div>
            );
          })}
        </div>
      ) : (
        events.slice(0, renderedEventCount).map(renderTranscriptEvent)
      )}

      {running ? (
        <div className="task-now">
          <button
            className="task-now-toggle"
            type="button"
            onClick={() =>
              liveActivity && setLiveStream((current) => ({ ...current, open: !current.open }))
            }
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
                      {currentActivityLabel ? (
                        `Working on ${currentActivityLabel}`
                      ) : (
                        <>
                          Connecting
                          <span className="task-now-ellipsis" aria-hidden="true">
                            <span>.</span>
                            <span>.</span>
                            <span>.</span>
                          </span>
                        </>
                      )}
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
                        isExpanded={isActivityExpanded}
                        onExpandedChange={setActivityExpanded}
                        onOpenFile={onOpenFile ? openFile : undefined}
                        onAddDiffSelection={onAddDiffSelection ? addDiffSelection : undefined}
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

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

/** Collapse absolute/relative file paths to basename in activity rows; keep
 *  full path on filePath / hover / open-file for identity and search. */
function activityDisplayBody(event: TranscriptEvent): string {
  const body = firstLine(event.body);
  const path = event.filePath ?? event.diff?.path;
  if (!path) return body;
  if (event.activityType === "file" || body === path || body === firstLine(path)) {
    return fileName(path);
  }
  return body;
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

/** Assistant replies that close a turn: last agent message before the next
 *  user message, plus the open trailing reply at the end of the transcript. */
function findTurnFinalAssistantIds(
  events: TranscriptEvent[],
  renderedEventCount: number,
): Set<string> {
  const ids = new Set<string>();
  let pendingAssistantId: string | undefined;
  const limit = Math.min(events.length, renderedEventCount);
  for (let index = 0; index < limit; index += 1) {
    const event = events[index];
    if (event.kind === "assistant") {
      pendingAssistantId = event.id;
      continue;
    }
    if (event.kind === "user" && pendingAssistantId) {
      ids.add(pendingAssistantId);
      pendingAssistantId = undefined;
    }
  }
  if (pendingAssistantId) ids.add(pendingAssistantId);
  return ids;
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
  const detail = activityDisplayBody(event);
  if (event.activityType === "command" && detail) return detail;
  if (event.title && detail && detail !== event.title) return `${event.title} · ${detail}`;
  return event.title ?? detail ?? "the task";
}
