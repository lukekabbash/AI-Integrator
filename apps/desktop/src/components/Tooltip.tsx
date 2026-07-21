import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m as motion } from "motion/react";

export type TooltipPlacement = "top" | "bottom" | "right" | "left" | "bottom-left" | "top-left";

interface TooltipProps {
  label: ReactNode;
  /** Optional second line rendered smaller and dimmer (e.g. a shortcut hint). */
  hint?: ReactNode;
  /** Allows longer supporting copy to wrap inside the themed bubble. */
  multiline?: boolean;
  placement?: TooltipPlacement;
  /** Delay before showing, in ms. Hiding is immediate. */
  delay?: number;
  disabled?: boolean;
  children: ReactElement;
}

const GAP = 7;
const EDGE = 6;

function motionDisabled(): boolean {
  if (typeof document === "undefined") return true;
  return (
    document.documentElement.dataset.motion === "none" ||
    (typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
  );
}

/** Entry offset for the settle animation: the bubble eases in from the anchor. */
function restingOffset(placement: TooltipPlacement): { x: number; y: number } {
  switch (placement) {
    case "top":
      return { x: 0, y: 4 };
    case "bottom":
      return { x: 0, y: -4 };
    case "right":
      return { x: -4, y: 0 };
    case "left":
      return { x: 4, y: 0 };
    case "bottom-left":
      return { x: 4, y: -4 };
    case "top-left":
      return { x: 4, y: 4 };
  }
}

/**
 * In-theme hover tooltip. Wraps a single element and shows a themed bubble on
 * hover/focus, replacing native `title` tooltips. Rendered in a portal so it
 * survives `overflow: hidden` ancestors (the sidebar, rail panels).
 */
export function Tooltip({
  label,
  hint,
  multiline = false,
  placement = "top",
  delay = 420,
  disabled = false,
  children,
}: TooltipProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [pendingTarget, setPendingTarget] = useState<Element | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number | null>(null);
  const interactive = multiline;

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);
  const hide = useCallback(() => {
    cancelHide();
    if (!interactive) {
      setPendingTarget(null);
      setAnchor(null);
      return;
    }
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setPendingTarget(null);
      setAnchor(null);
    }, 120);
  }, [cancelHide, interactive]);

  useEffect(() => () => cancelHide(), [cancelHide]);

  useEffect(() => {
    if (disabled || !pendingTarget) return;
    // Measure when the bubble actually opens. The sidebar and other panels can
    // still be settling during the hover delay, so an eagerly captured rect
    // leaves the tooltip behind its moving anchor.
    const timer = window.setTimeout(() => {
      if (pendingTarget.isConnected) setAnchor(pendingTarget.getBoundingClientRect());
      setPendingTarget(null);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [delay, disabled, pendingTarget]);

  useEffect(() => {
    if (!anchor) return;
    // Any scroll or press elsewhere invalidates the stored anchor rect.
    const onScroll = () => hide();
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
    };
  }, [anchor, hide]);

  const scheduleShow = (target: Element) => {
    if (disabled) return;
    cancelHide();
    setPendingTarget(target);
  };

  if (!isValidElement(children)) return children;
  const childProps = children.props as Record<string, unknown>;

  const trigger = cloneElement(children, {
    onMouseEnter: (event: React.MouseEvent) => {
      if (typeof childProps.onMouseEnter === "function") childProps.onMouseEnter(event);
      scheduleShow(event.currentTarget);
    },
    onMouseLeave: (event: React.MouseEvent) => {
      if (typeof childProps.onMouseLeave === "function") childProps.onMouseLeave(event);
      hide();
    },
    onFocus: (event: React.FocusEvent) => {
      if (typeof childProps.onFocus === "function") childProps.onFocus(event);
      // Keyboard-driven focus only; pointer clicks already show hover intent.
      let keyboardFocus = false;
      try {
        keyboardFocus = event.currentTarget.matches(":focus-visible");
      } catch {
        keyboardFocus = false;
      }
      if (keyboardFocus) scheduleShow(event.currentTarget);
    },
    onBlur: (event: React.FocusEvent) => {
      if (typeof childProps.onBlur === "function") childProps.onBlur(event);
      hide();
    },
    onPointerDown: (event: React.PointerEvent) => {
      if (typeof childProps.onPointerDown === "function") childProps.onPointerDown(event);
      hide();
    },
  } as Partial<unknown>);

  return (
    <>
      {trigger}
      {typeof document === "undefined"
        ? null
        : createPortal(
            <AnimatePresence>
              {anchor ? (
                <TooltipBubble
                  key="tooltip"
                  anchor={anchor}
                  placement={placement}
                  label={label}
                  hint={hint}
                  multiline={multiline}
                  onMouseEnter={cancelHide}
                  onMouseLeave={hide}
                  bubbleRef={bubbleRef}
                />
              ) : null}
            </AnimatePresence>,
            document.body,
          )}
    </>
  );
}

function TooltipBubble({
  anchor,
  placement,
  label,
  hint,
  multiline,
  onMouseEnter,
  onMouseLeave,
  bubbleRef,
}: {
  anchor: DOMRect;
  placement: TooltipPlacement;
  label: ReactNode;
  hint?: ReactNode;
  multiline: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  bubbleRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const resolvedPlacement: TooltipPlacement =
    placement === "bottom-left" && anchor.top + anchor.height / 2 > window.innerHeight / 2
      ? "top-left"
      : placement;

  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!bubble) return;
    const size = bubble.getBoundingClientRect();
    let left: number;
    let top: number;
    switch (resolvedPlacement) {
      case "top":
        left = anchor.left + anchor.width / 2 - size.width / 2;
        top = anchor.top - size.height - GAP;
        break;
      case "bottom":
        left = anchor.left + anchor.width / 2 - size.width / 2;
        top = anchor.bottom + GAP;
        break;
      case "right":
        left = anchor.right + GAP;
        top = anchor.top + anchor.height / 2 - size.height / 2;
        break;
      case "left":
        left = anchor.left - size.width - GAP;
        top = anchor.top + anchor.height / 2 - size.height / 2;
        break;
      case "bottom-left":
        left = anchor.left - size.width - GAP;
        top = anchor.bottom + GAP;
        break;
      case "top-left":
        left = anchor.left - size.width - GAP;
        top = anchor.top - size.height - GAP;
        break;
    }
    left = Math.min(Math.max(EDGE, left), window.innerWidth - size.width - EDGE);
    top = Math.min(Math.max(EDGE, top), window.innerHeight - size.height - EDGE);
    setPosition({ left, top });
  }, [anchor, bubbleRef, resolvedPlacement]);

  const still = motionDisabled();
  const from = restingOffset(resolvedPlacement);

  return (
    <motion.div
      ref={bubbleRef}
      className={`app-tooltip${multiline ? " app-tooltip--multiline" : ""}`}
      role="tooltip"
      data-placement={resolvedPlacement}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        visibility: position ? "visible" : "hidden",
      }}
      initial={still ? false : { opacity: 0, scale: 0.92, x: from.x, y: from.y }}
      animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
      exit={still ? undefined : { opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
      transition={{ type: "spring", stiffness: 640, damping: 34, mass: 0.6 }}
    >
      <div className="app-tooltip-label">{label}</div>
      {hint ? <span className="app-tooltip-hint">{hint}</span> : null}
    </motion.div>
  );
}
