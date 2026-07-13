import { useCallback, useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AtSign, MessageCircleQuestion } from "lucide-react";

/** Context resolved from a text selection inside a code surface. */
export interface SelectionContext {
  text: string;
  startLine?: number;
  endLine?: number;
}

export interface SelectionPayload extends SelectionContext {
  /** "ask" pre-positions the composer for a follow-up question. */
  intent: "add" | "ask";
}

interface PopoverState {
  context: SelectionContext;
  top: number;
  left: number;
}

const POPOVER_MARGIN = 8;

/** Floating "Add to chat / Ask about this" pill anchored above a text
 * selection inside `containerRef`. The host resolves the selection into a
 * SelectionContext (text plus line numbers); a null resolution hides the
 * pill. Rendering happens in a body portal so scroll containers never clip
 * it, and pointerdown is swallowed so acting on a selection keeps it. */
export function SelectionActionPopover({
  containerRef,
  resolve,
  onAction,
  label,
}: {
  containerRef: RefObject<HTMLElement | null>;
  resolve: (range: Range) => SelectionContext | null;
  onAction: (payload: SelectionPayload) => void;
  /** Accessible name distinguishing simultaneous popovers (file vs diff). */
  label: string;
}) {
  const [state, setState] = useState<PopoverState | null>(null);

  const refresh = useCallback(() => {
    const container = containerRef.current;
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setState(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (
      !container.contains(range.startContainer) ||
      !container.contains(range.endContainer) ||
      !range.toString().trim()
    ) {
      setState(null);
      return;
    }
    const context = resolve(range);
    if (!context || !context.text.trim()) {
      setState(null);
      return;
    }
    // jsdom's Range has no layout; anchor at the margin there so tests can
    // still exercise the action flow.
    const rect =
      typeof range.getBoundingClientRect === "function"
        ? range.getBoundingClientRect()
        : { top: 0, left: 0, width: 0 };
    setState({
      context,
      top: Math.max(POPOVER_MARGIN, rect.top - 40),
      left: Math.max(POPOVER_MARGIN, rect.left + rect.width / 2),
    });
  }, [containerRef, resolve]);

  useEffect(() => {
    let frame: number | undefined;
    const schedule = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        refresh();
      });
    };
    document.addEventListener("selectionchange", schedule);
    // Reposition (or dismiss) when the selected content scrolls away.
    document.addEventListener("scroll", schedule, true);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("scroll", schedule, true);
    };
  }, [refresh]);

  if (!state) return null;

  const act = (intent: "add" | "ask") => {
    onAction({ ...state.context, intent });
    window.getSelection()?.removeAllRanges();
    setState(null);
  };

  return createPortal(
    <div
      className="selection-popover"
      role="toolbar"
      aria-label={label}
      style={{ top: state.top, left: state.left }}
      // Acting on the selection must not collapse it first.
      onPointerDown={(event) => event.preventDefault()}
    >
      <button type="button" onClick={() => act("add")}>
        <AtSign aria-hidden="true" /> Add to chat
      </button>
      <button type="button" onClick={() => act("ask")}>
        <MessageCircleQuestion aria-hidden="true" /> Ask about this
      </button>
    </div>,
    document.body,
  );
}
