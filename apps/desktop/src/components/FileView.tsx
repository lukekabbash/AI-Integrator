import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  AtSign,
  CornerDownLeft,
  FileCode2,
  LoaderCircle,
  MessageCircleQuestion,
  X,
} from "lucide-react";
import { AnimatePresence, m as motion, useReducedMotion } from "motion/react";
import { FileIcon } from "./FileIcon";
import { type SelectionContext, type SelectionPayload } from "./SelectionActionPopover";
import { selectionEndpointElement } from "./conversationFormatting";
import { highlightCodeLine } from "./codeHighlight";
import {
  FILE_TAB_SIZE,
  indentGuideCountsForLines,
  type ProjectFileLocation,
} from "./fileViewSupport";
import type { ProjectFileContent } from "../bridge";

function IndentGuides({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="file-indent-guides" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <span
          className="file-indent-guide"
          key={index}
          style={{ left: `${index * FILE_TAB_SIZE}ch` }}
        />
      ))}
    </span>
  );
}

function FileHighlightLine({
  path,
  line,
  lineNumber,
  guideCount,
  showNewline,
  showLineNumber,
  targeted,
}: {
  path: string;
  line: string;
  lineNumber: number;
  guideCount: number;
  showNewline: boolean;
  showLineNumber: boolean;
  targeted: boolean;
}) {
  return (
    <span
      className="file-code-editor-line"
      data-line={lineNumber}
      data-target={targeted || undefined}
    >
      {[
        showLineNumber ? (
          <span
            className="file-code-line-number"
            key="n"
            data-line={lineNumber}
            aria-hidden="true"
          />
        ) : null,
        <IndentGuides key="g" count={guideCount} />,
        ...highlightCodeLine(line, path).map((token, tokenIndex) => (
          <span className={`syntax-${token.kind}`} key={`t-${tokenIndex}`}>
            {token.text}
          </span>
        )),
        showNewline ? "\n" : null,
      ]}
    </span>
  );
}

/** Selection payload from a file surface, with the file it came from. */
export interface FileSelectionPayload extends SelectionPayload {
  path: string;
}

/** What the explainer needs beyond the selection itself. */
export interface FileExplainPayload extends FileSelectionPayload {
  /** The live editor buffer. Sent rather than read from disk so an explanation
   * describes what is on screen, including unsaved edits. */
  fileText: string;
  /** Follow-up question; absent on the first ask. */
  question?: string;
  /** Prior completed exchanges, oldest first. The helper keeps no session, so
   * a follow-up's context is whatever rides along here. */
  history?: Array<{ question: string; answer: string }>;
}

export interface FileExplainResult {
  text: string;
  /** Who actually answered. The route can fail over to another provider, so
   * this is not necessarily the agent the request was addressed to. */
  agentLabel: string;
  usedFallback: boolean;
}

/** One packet of the ask panel's live answer stream. `attempt` names the
 * provider about to answer and resets the buffer — a fallback must not append
 * to a failed primary's partial output. `delta` appends one chunk. */
export interface FileExplainDelta {
  kind: "attempt" | "delta";
  text: string;
  agentLabel: string;
}

const INITIAL_FILE_LINES = 400;
const FILE_LINE_CHUNK = 400;
const FILE_AUTOSAVE_DELAY_MS = 450;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  rs: "Rust",
  py: "Python",
  css: "CSS",
  html: "HTML",
  json: "JSON",
  md: "Markdown",
  toml: "TOML",
  yml: "YAML",
  yaml: "YAML",
};

function languageForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXTENSION[extension] ?? "Plain text";
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

export function ProgressiveSurfaceControls({
  shown,
  total,
  noun,
  chunk,
  onShowMore,
  onShowAll,
}: {
  shown: number;
  total: number;
  noun: string;
  chunk: number;
  onShowMore: () => void;
  onShowAll: () => void;
}) {
  if (shown >= total) return null;
  return (
    <div className="progressive-surface-controls">
      <span role="status" aria-live="polite">
        Showing {shown.toLocaleString()} of {total.toLocaleString()} {noun}
      </span>
      <button className="secondary-button" type="button" onClick={onShowMore}>
        Show next {Math.min(chunk, total - shown).toLocaleString()} {noun}
      </button>
      <button className="secondary-button" type="button" onClick={onShowAll}>
        Show all {total.toLocaleString()} {noun}
      </button>
    </div>
  );
}

interface SelectionMenuState {
  x: number;
  y: number;
  context: SelectionContext;
}

const SELECTION_MENU_WIDTH = 280;
const MENU_EASE = [0.2, 0, 0, 1] as const;
const MENU_ENTER = { duration: 0.18, ease: MENU_EASE };
const MENU_EXIT = { duration: 0.14, ease: MENU_EASE };

function selectionRangeLabel(payload: SelectionContext): string {
  if (payload.startLine === undefined) return "";
  if (payload.endLine !== undefined && payload.endLine !== payload.startLine) {
    return `${payload.startLine} – ${payload.endLine}`;
  }
  return `${payload.startLine}`;
}

/** One completed question/answer pair shown in the ask panel. The first
 * exchange has no question of its own — it is the initial analysis. */
interface AskExchange {
  question?: string;
  answer: string;
  /** Carried on the result rather than read from the prop: a failed-over
   * answer must not be attributed to the agent that could not give it. */
  answeredBy: string;
  usedFallback: boolean;
}

interface AskPanelState {
  payload: FileSelectionPayload;
  /** Fixed-position anchor, seeded from the context menu and moved by drag. */
  position: { x: number; y: number };
  exchanges: AskExchange[];
  /** The in-flight answer; null when idle. `question` is what is being asked,
   * `text` grows with the stream, `agentLabel` follows the attempt events so a
   * fallback is credited live, not only at the end. */
  live: { text: string; agentLabel: string; question?: string } | null;
  error: string | null;
}

const ASK_PANEL_WIDTH = 440;

/** Keep the panel on screen without pinning it: enough must remain visible to
 * grab the header again. */
function clampAskPosition(x: number, y: number): { x: number; y: number } {
  if (typeof window === "undefined") return { x, y };
  return {
    x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - ASK_PANEL_WIDTH - 8)),
    y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - 120)),
  };
}

/** Floating conversation surface for "Ask about this": opens where the
 * selection menu was, streams the answer in place, and takes follow-up
 * questions about the same selection. Draggable by its header, scrollable in
 * its body, and intentionally separate from Add to chat / the task
 * transcript. */
function SelectionAskPanel({
  state,
  agentLabel,
  onClose,
  onAddToChat,
  onFollowUp,
  onDrag,
}: {
  state: AskPanelState;
  agentLabel: string;
  onClose: () => void;
  onAddToChat?: (payload: FileSelectionPayload) => void;
  onFollowUp: (question: string) => void;
  onDrag: (position: { x: number; y: number }) => void;
}) {
  const reduceMotion = useReducedMotion();
  const still =
    Boolean(reduceMotion) ||
    (typeof document !== "undefined" && document.documentElement.dataset.motion === "none");
  const [question, setQuestion] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const range = selectionRangeLabel(state.payload);
  const title = `${fileName(state.payload.path)}${range ? ` (${range})` : ""}`;
  const busy = state.live !== null;
  const latest = state.exchanges.at(-1);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Follow the stream only while the reader is already at the bottom; a user
  // who scrolled up to reread is never yanked back down by a delta.
  useEffect(() => {
    const body = bodyRef.current;
    if (body && pinnedToBottom.current) body.scrollTop = body.scrollHeight;
  }, [state.live?.text, state.exchanges.length, state.error]);

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button, input")) return;
    event.preventDefault();
    const from = { x: event.clientX, y: event.clientY };
    const origin = state.position;
    // preventDefault on pointerdown does not stop the browser from growing a
    // text selection as the pointer crosses the page, so selection is switched
    // off document-wide for the duration of the drag.
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const onMove = (move: globalThis.PointerEvent) => {
      onDrag(clampAskPosition(origin.x + move.clientX - from.x, origin.y + move.clientY - from.y));
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      document.body.style.userSelect = previousUserSelect;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop, { once: true });
  };

  const submitFollowUp = () => {
    const trimmed = question.trim();
    if (!trimmed || busy) return;
    setQuestion("");
    pinnedToBottom.current = true;
    onFollowUp(trimmed);
  };

  const status = busy
    ? `Explaining with ${state.live?.agentLabel ?? agentLabel}…`
    : state.error
      ? `${agentLabel} could not explain this selection`
      : latest?.usedFallback
        ? `${agentLabel} could not answer, so ${latest.answeredBy} did`
        : latest
          ? `Explained by ${latest.answeredBy}`
          : "";

  return (
    <motion.section
      className="selection-ask-panel"
      role="dialog"
      aria-label={`Ask about ${title}`}
      aria-busy={busy}
      style={{ left: state.position.x, top: state.position.y, width: ASK_PANEL_WIDTH }}
      initial={still ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={
        still
          ? { opacity: 0, transition: { duration: 0 } }
          : { opacity: 0, y: 6, transition: MENU_EXIT }
      }
      transition={still ? { duration: 0 } : MENU_ENTER}
    >
      <header
        className="selection-ask-header"
        onPointerDown={startDrag}
        // The header doubles as the drag handle; announce it as one.
        title="Drag to move"
      >
        <div className="selection-ask-title">
          <MessageCircleQuestion aria-hidden="true" />
          <div>
            <strong>Ask about this</strong>
            <small title={state.payload.path}>{title}</small>
          </div>
        </div>
        <div className="selection-ask-header-actions">
          {onAddToChat ? (
            <button
              type="button"
              aria-label="Add selection to chat"
              title="Add selection to chat"
              onClick={() => onAddToChat(state.payload)}
            >
              <AtSign aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" aria-label="Close explanation" title="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
      </header>
      <p className="selection-ask-agent" role="status" aria-live="polite">
        {status}
      </p>
      <div
        className="selection-ask-body"
        ref={bodyRef}
        onScroll={(event) => {
          const body = event.currentTarget;
          pinnedToBottom.current = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
        }}
      >
        {state.exchanges.map((exchange, index) => (
          <div className="selection-ask-exchange" key={index}>
            {exchange.question ? (
              <p className="selection-ask-question">{exchange.question}</p>
            ) : null}
            <div className="selection-ask-answer">{exchange.answer}</div>
          </div>
        ))}
        {state.live ? (
          <div className="selection-ask-exchange" data-live="true">
            {state.live.question ? (
              <p className="selection-ask-question">{state.live.question}</p>
            ) : null}
            {state.live.text ? (
              <div className="selection-ask-answer">{state.live.text}</div>
            ) : (
              <div className="selection-ask-loading">
                <LoaderCircle aria-hidden="true" className="selection-ask-spinner" />
                <span>Reading the selection…</span>
              </div>
            )}
          </div>
        ) : null}
        {state.error ? (
          <p className="selection-ask-error" role="alert">
            {state.error}
          </p>
        ) : null}
      </div>
      <footer className="selection-ask-footer">
        <input
          value={question}
          aria-label="Follow-up question"
          placeholder={busy ? "Answering…" : "Ask a follow-up…"}
          disabled={busy || (state.exchanges.length === 0 && !state.error)}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitFollowUp();
            }
          }}
        />
        <button
          type="button"
          aria-label="Send follow-up"
          title="Send follow-up"
          disabled={busy || !question.trim()}
          onClick={submitFollowUp}
        >
          <CornerDownLeft aria-hidden="true" />
        </button>
      </footer>
    </motion.section>
  );
}

/** Right-click / Cmd+click menu over a code selection. Actions stay behind
 * an explicit gesture — never autoshow on highlight alone. Stays mounted so
 * AnimatePresence can play a short exit before unmount. */
function SelectionContextMenu({
  menu,
  path,
  onAskAbout,
  onAddComposerContext,
  onClose,
}: {
  menu: SelectionMenuState | null;
  path: string;
  /** The ask panel opens where the menu was, so the gesture hands over its
   * own coordinates. */
  onAskAbout?: (payload: FileSelectionPayload, at: { x: number; y: number }) => void;
  onAddComposerContext?: (payload: FileSelectionPayload) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const still =
    Boolean(reduceMotion) ||
    (typeof document !== "undefined" && document.documentElement.dataset.motion === "none");

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onBlur = () => onClose();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [menu, onClose]);

  const askAbout = () => {
    if (!menu) return;
    onAskAbout?.({ ...menu.context, intent: "ask", path }, { x: menu.x, y: menu.y });
    onClose();
  };

  const addToComposer = () => {
    if (!menu) return;
    onAddComposerContext?.({ ...menu.context, intent: "add", path });
    onClose();
  };

  const rangeLabel = menu ? selectionRangeLabel(menu.context) : "";

  const left = menu
    ? typeof window === "undefined"
      ? menu.x
      : Math.min(menu.x, Math.max(8, window.innerWidth - SELECTION_MENU_WIDTH - 8))
    : 0;
  const top = menu
    ? typeof window === "undefined"
      ? menu.y
      : Math.min(menu.y, Math.max(8, window.innerHeight - 96))
    : 0;

  return createPortal(
    <AnimatePresence>
      {menu ? (
        <motion.div
          key="selection-context-menu"
          ref={menuRef}
          className="compact-action-menu selection-context-menu"
          role="menu"
          aria-label={`Selection actions for ${path}`}
          style={{ left, top }}
          initial={still ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={
            still
              ? { opacity: 0, transition: { duration: 0 } }
              : { opacity: 0, y: 2, transition: MENU_EXIT }
          }
          transition={still ? { duration: 0 } : MENU_ENTER}
          // Acting on the selection must not collapse it first.
          onPointerDown={(event) => event.preventDefault()}
        >
          <div className="selection-context-menu-path" title={path}>
            <FileIcon fileName={path} />
            <span>
              {fileName(path)}
              {rangeLabel ? ` (${rangeLabel})` : ""}
            </span>
          </div>
          {onAskAbout ? (
            <button type="button" role="menuitem" onClick={askAbout}>
              <MessageCircleQuestion aria-hidden="true" /> Ask about this
            </button>
          ) : null}
          {onAddComposerContext ? (
            <button type="button" role="menuitem" onClick={addToComposer}>
              <AtSign aria-hidden="true" /> Add to chat
            </button>
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

/** Full-canvas reader/editor for one unchanged project file: the sibling of
 * the unified Review surface, sharing its header geometry and quiet reading
 * treatment, with no diff or review chrome. */
export function FileWorkspace({
  file,
  target,
  editable = false,
  onSave,
  onExplainSelection,
  onAddComposerContext,
  explainAgentLabel = "your agent",
}: {
  file: ProjectFileContent;
  /** Optional transcript destination to reveal after the file opens. */
  target?: ProjectFileLocation;
  /** True when the native host can write edits back to this file. */
  editable?: boolean;
  onSave?: (content: string) => Promise<void>;
  /** Context menu: open the floating ask panel for the current agent. Deltas
   * stream through the callback while the promise runs; the resolved result
   * remains the authoritative final text. */
  onExplainSelection?: (
    payload: FileExplainPayload,
    onDelta: (delta: FileExplainDelta) => void,
  ) => Promise<FileExplainResult>;
  /** Context menu: the selection becomes a removable composer context card. */
  onAddComposerContext?: (payload: FileSelectionPayload) => void;
  /** Label for the active runtime shown in the explain panel. */
  explainAgentLabel?: string;
}) {
  const lines = useMemo(() => file.content.split("\n"), [file.content]);
  const [lineLimit, setLineLimit] = useState(INITIAL_FILE_LINES);
  const [draft, setDraft] = useState(file.content);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [menu, setMenu] = useState<SelectionMenuState | null>(null);
  const [explain, setExplain] = useState<AskPanelState | null>(null);
  const explainRequestId = useRef(0);
  const linesRef = useRef<HTMLOListElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const mountedRef = useRef(true);
  const draftRef = useRef(file.content);
  const onSaveRef = useRef(onSave);
  const persistedContentRef = useRef(file.content);
  const lastQueuedContentRef = useRef(file.content);
  const saveQueueRef = useRef(Promise.resolve());
  const saveRevisionRef = useRef(0);
  const canEdit = editable && Boolean(onSave) && !file.isBinary && !file.imageDataUrl;
  const dirty = canEdit && draft !== file.content;
  const editorLines = useMemo(() => draft.split("\n"), [draft]);
  const editorGuideCounts = useMemo(() => indentGuideCountsForLines(editorLines), [editorLines]);
  const navigableLineCount = canEdit ? editorLines.length : lines.length;
  const targetStartLine = target?.startLine
    ? Math.min(target.startLine, navigableLineCount)
    : undefined;
  const targetEndLine = targetStartLine
    ? Math.min(Math.max(target?.endLine ?? targetStartLine, targetStartLine), navigableLineCount)
    : undefined;
  const effectiveLineLimit = targetEndLine
    ? Math.max(
        lineLimit,
        Math.min(lines.length, Math.ceil(targetEndLine / FILE_LINE_CHUNK) * FILE_LINE_CHUNK),
      )
    : lineLimit;
  const visibleLines = lines.slice(0, effectiveLineLimit);
  const readerGuideCounts = useMemo(
    () => indentGuideCountsForLines(lines.slice(0, effectiveLineLimit)),
    [effectiveLineLimit, lines],
  );

  useLayoutEffect(() => {
    if (!targetStartLine || !targetEndLine) return;
    if (canEdit) {
      const editor = editorRef.current;
      const highlight = highlightRef.current;
      if (!editor || !highlight) return;
      const startOffset = editorLines
        .slice(0, targetStartLine - 1)
        .reduce((offset, line) => offset + line.length + 1, 0);
      const endOffset =
        editorLines.slice(0, targetEndLine).reduce((offset, line) => offset + line.length + 1, 0) -
        1;
      editor.focus({ preventScroll: true });
      editor.setSelectionRange(startOffset, Math.max(startOffset, endOffset));
      const targetLine = highlight.querySelector<HTMLElement>(`[data-line="${targetStartLine}"]`);
      const scrollTop = Math.max(0, (targetLine?.offsetTop ?? 0) - editor.clientHeight * 0.35);
      editor.scrollTop = scrollTop;
      highlight.scrollTop = scrollTop;
      return;
    }
    linesRef.current
      ?.querySelector<HTMLElement>(`li[data-line="${targetStartLine}"]`)
      ?.scrollIntoView?.({ block: "center" });
  }, [canEdit, editorLines, effectiveLineLimit, targetEndLine, targetStartLine]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  // After edits the browser may clamp scroll without firing scroll; keep the
  // overlay pre locked to the textarea (caret/selection live on the textarea).
  useEffect(() => {
    if (!canEdit) return;
    const editor = editorRef.current;
    const highlight = highlightRef.current;
    if (!editor || !highlight) return;
    highlight.scrollTop = editor.scrollTop;
    highlight.scrollLeft = editor.scrollLeft;
  }, [canEdit, editorLines]);

  const resolveSelection = useCallback((range: Range) => {
    const container = linesRef.current;
    if (!container) return null;
    const startRow = selectionEndpointElement(range.startContainer, "li[data-line]", container);
    const endRow = selectionEndpointElement(range.endContainer, "li[data-line]", container);
    const startLine = startRow ? Number(startRow.dataset.line) : undefined;
    const endLine = endRow ? Number(endRow.dataset.line) : undefined;
    // List markers are CSS counters, so the raw selection text is clean code.
    return { text: range.toString(), startLine, endLine };
  }, []);

  /** Run one ask — the initial analysis or a follow-up — streaming deltas
   * into the panel as they arrive. The request id fences everything: a panel
   * closed or re-asked mid-stream drops the stale request's packets, result,
   * and error alike. */
  const runAsk = useCallback(
    (
      payload: FileSelectionPayload,
      options: {
        question?: string;
        history: Array<{ question: string; answer: string }>;
      },
    ) => {
      if (!onExplainSelection) return;
      const requestId = ++explainRequestId.current;
      setExplain((current) =>
        current
          ? {
              ...current,
              error: null,
              live: { text: "", agentLabel: explainAgentLabel, question: options.question },
            }
          : current,
      );
      void onExplainSelection(
        { ...payload, fileText: draft, question: options.question, history: options.history },
        (delta) => {
          if (requestId !== explainRequestId.current) return;
          setExplain((current) => {
            if (!current?.live) return current;
            return {
              ...current,
              live:
                delta.kind === "attempt"
                  ? { ...current.live, text: "", agentLabel: delta.agentLabel }
                  : { ...current.live, text: current.live.text + delta.text },
            };
          });
        },
      )
        .then((result) => {
          if (requestId !== explainRequestId.current) return;
          setExplain((current) =>
            current
              ? {
                  ...current,
                  live: null,
                  error: null,
                  exchanges: [
                    ...current.exchanges,
                    {
                      question: options.question,
                      answer: result.text,
                      answeredBy: result.agentLabel,
                      usedFallback: result.usedFallback,
                    },
                  ],
                }
              : current,
          );
        })
        .catch((error: unknown) => {
          if (requestId !== explainRequestId.current) return;
          setExplain((current) =>
            current
              ? {
                  ...current,
                  live: null,
                  error:
                    error instanceof Error
                      ? error.message
                      : "The selection could not be explained.",
                }
              : current,
          );
        });
    },
    [onExplainSelection, draft, explainAgentLabel],
  );

  const askAboutSelection = useCallback(
    (payload: FileSelectionPayload, at: { x: number; y: number }) => {
      if (!onExplainSelection) return;
      setExplain({
        payload,
        position: clampAskPosition(at.x, at.y),
        exchanges: [],
        live: null,
        error: null,
      });
      runAsk(payload, { history: [] });
    },
    [onExplainSelection, runAsk],
  );

  const askFollowUp = useCallback(
    (question: string) => {
      if (!explain) return;
      runAsk(explain.payload, {
        question,
        history: explain.exchanges.map((exchange) => ({
          question: exchange.question ?? "",
          answer: exchange.answer,
        })),
      });
    },
    [explain, runAsk],
  );

  const closeExplain = useCallback(() => {
    explainRequestId.current += 1;
    setExplain(null);
  }, []);

  const openSelectionMenu = (event: MouseEvent<HTMLElement>) => {
    if (!onExplainSelection && !onAddComposerContext) return;
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const container = linesRef.current;
    const range = selection.getRangeAt(0);
    if (
      !container ||
      !container.contains(range.startContainer) ||
      !container.contains(range.endContainer)
    ) {
      return;
    }
    const context = resolveSelection(range);
    if (!context || !context.text.trim()) return;
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, context });
  };

  const queueSave = useCallback((content: string) => {
    const saveFile = onSaveRef.current;
    if (!saveFile || content === lastQueuedContentRef.current) return saveQueueRef.current;

    lastQueuedContentRef.current = content;
    const revision = ++saveRevisionRef.current;
    if (mountedRef.current) {
      setSaving(true);
      setSaveError("");
    }

    const operation = saveQueueRef.current.then(async () => {
      if (content === persistedContentRef.current) return;
      try {
        await saveFile(content);
        persistedContentRef.current = content;
        if (mountedRef.current && revision === saveRevisionRef.current) setSaveError("");
      } catch (error) {
        if (lastQueuedContentRef.current === content) {
          lastQueuedContentRef.current = persistedContentRef.current;
        }
        if (mountedRef.current && revision === saveRevisionRef.current) {
          setSaveError(error instanceof Error ? error.message : "The file could not be autosaved.");
        }
      } finally {
        if (mountedRef.current && revision === saveRevisionRef.current) setSaving(false);
      }
    });
    saveQueueRef.current = operation;
    return operation;
  }, []);

  useEffect(() => {
    if (!canEdit || draft === lastQueuedContentRef.current) return;
    const timer = window.setTimeout(() => void queueSave(draft), FILE_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [canEdit, draft, queueSave]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (canEdit && draftRef.current !== lastQueuedContentRef.current) {
        void queueSave(draftRef.current);
      }
    };
  }, [canEdit, queueSave]);

  const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void queueSave(draftRef.current);
    }
  };

  const openEditorSelectionMenu = (event: MouseEvent<HTMLTextAreaElement>) => {
    if (!onExplainSelection && !onAddComposerContext) return;
    const editor = editorRef.current;
    if (!editor || editor.selectionStart === editor.selectionEnd) return;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const text = draft.slice(start, end);
    if (!text.trim()) return;
    event.preventDefault();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      context: {
        text,
        startLine: draft.slice(0, start).split("\n").length,
        endLine: draft.slice(0, end).split("\n").length,
      },
    });
  };

  return (
    <section className="file-workspace" aria-label={`File ${file.path}`}>
      <header className="diff-header file-workspace-header">
        <div className="diff-file-title">
          <FileIcon fileName={file.path} />
          <span>
            <strong title={file.path}>{fileName(file.path)}</strong>
            <small className="diff-file-meta">
              <span className="diff-file-path">{file.path}</span>
              <span className="diff-file-meta-divider" aria-hidden="true">
                ·
              </span>
              <span>{languageForPath(file.path)}</span>
              {!file.isBinary && !file.imageDataUrl ? (
                <>
                  <span className="diff-file-meta-divider" aria-hidden="true">
                    ·
                  </span>
                  <span>
                    {lines.length.toLocaleString()} line{lines.length === 1 ? "" : "s"}
                  </span>
                </>
              ) : null}
              {saving || dirty ? (
                <>
                  <span className="diff-file-meta-divider" aria-hidden="true">
                    ·
                  </span>
                  <span className="file-workspace-dirty">{saving ? "Saving…" : "Edited"}</span>
                </>
              ) : null}
            </small>
          </span>
        </div>
      </header>
      {saveError ? (
        <p className="file-workspace-error" role="alert">
          {saveError}
        </p>
      ) : null}
      {file.imageDataUrl ? (
        <div className="file-workspace-scroll">
          <div className="file-reader-image">
            <img src={file.imageDataUrl} alt={fileName(file.path)} />
          </div>
        </div>
      ) : file.isBinary ? (
        <div className="file-workspace-scroll">
          <p className="empty-compact">This binary file cannot be safely previewed as text.</p>
        </div>
      ) : canEdit ? (
        <div className="file-code-editor">
          <div className="file-code-gutter" aria-hidden="true" />
          <div className="file-code-editor-surface">
            <pre className="file-code-editor-highlight" aria-hidden="true" ref={highlightRef}>
              {editorLines.map((line, lineIndex) => (
                <FileHighlightLine
                  key={`${file.path}-${lineIndex}`}
                  path={file.path}
                  line={line}
                  lineNumber={lineIndex + 1}
                  guideCount={editorGuideCounts[lineIndex] ?? 0}
                  showNewline={lineIndex < editorLines.length - 1}
                  showLineNumber
                  targeted={Boolean(
                    targetStartLine &&
                    targetEndLine &&
                    lineIndex + 1 >= targetStartLine &&
                    lineIndex + 1 <= targetEndLine,
                  )}
                />
              ))}
            </pre>
            <textarea
              className="file-workspace-editor"
              ref={editorRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onEditorKeyDown}
              onScroll={(event) => {
                if (!highlightRef.current) return;
                highlightRef.current.scrollTop = event.currentTarget.scrollTop;
                highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
              }}
              onContextMenu={openEditorSelectionMenu}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey) openEditorSelectionMenu(event);
              }}
              aria-label={`Edit ${file.path}`}
              spellCheck={false}
            />
          </div>
        </div>
      ) : (
        <div className="file-workspace-scroll">
          <ol
            className="file-reader-lines file-workspace-lines"
            aria-label={`Contents of ${file.path}`}
            ref={linesRef}
            onContextMenu={openSelectionMenu}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey) openSelectionMenu(event);
            }}
          >
            {visibleLines.map((line, index) => (
              <li
                key={`${file.path}-${index}`}
                data-line={index + 1}
                data-target={
                  targetStartLine &&
                  targetEndLine &&
                  index + 1 >= targetStartLine &&
                  index + 1 <= targetEndLine
                    ? true
                    : undefined
                }
              >
                <code>
                  {[
                    <IndentGuides key="g" count={readerGuideCounts[index] ?? 0} />,
                    ...highlightCodeLine(line, file.path).map((token, tokenIndex) => (
                      <span className={`syntax-${token.kind}`} key={`t-${tokenIndex}`}>
                        {token.text}
                      </span>
                    )),
                  ]}
                </code>
              </li>
            ))}
          </ol>
          <ProgressiveSurfaceControls
            shown={visibleLines.length}
            total={lines.length}
            noun="lines"
            chunk={FILE_LINE_CHUNK}
            onShowMore={() => setLineLimit(effectiveLineLimit + FILE_LINE_CHUNK)}
            onShowAll={() => setLineLimit(lines.length)}
          />
        </div>
      )}
      <SelectionContextMenu
        menu={menu}
        path={file.path}
        onAskAbout={onExplainSelection ? askAboutSelection : undefined}
        onAddComposerContext={onAddComposerContext}
        onClose={() => setMenu(null)}
      />
      {createPortal(
        <AnimatePresence>
          {explain ? (
            <SelectionAskPanel
              key="selection-ask"
              state={explain}
              agentLabel={explainAgentLabel}
              onClose={closeExplain}
              onFollowUp={askFollowUp}
              onDrag={(position) =>
                setExplain((current) => (current ? { ...current, position } : current))
              }
              onAddToChat={
                onAddComposerContext
                  ? (payload) => onAddComposerContext({ ...payload, intent: "add" })
                  : undefined
              }
            />
          ) : null}
        </AnimatePresence>,
        document.body,
      )}
    </section>
  );
}

/** Empty/error shell shown in the canvas while a file is opening or failed. */
export function FileWorkspaceNotice({
  title,
  message,
  role = "status",
  actions,
}: {
  title: string;
  message?: string;
  role?: "status" | "alert";
  actions?: ReactNode;
}) {
  return (
    <section className="review-empty file-workspace-notice" aria-label={title}>
      <div className="review-empty-icon">
        <FileCode2 aria-hidden="true" />
      </div>
      <h2>{title}</h2>
      {message ? <p role={role}>{message}</p> : null}
      {actions ? <div className="review-empty-actions">{actions}</div> : null}
    </section>
  );
}
