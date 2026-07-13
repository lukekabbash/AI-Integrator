import { useRef } from "react";

interface ResizeHandleProps {
  axis: "horizontal" | "vertical";
  label: string;
  valueNow?: number;
  valueMin?: number;
  valueMax?: number;
  onResize: (delta: number) => void;
}

export function ResizeHandle({
  axis,
  label,
  valueNow,
  valueMin,
  valueMax,
  onResize,
}: ResizeHandleProps) {
  const lastPosition = useRef<number | null>(null);
  const pendingDelta = useRef(0);
  const resizeFrame = useRef<number | null>(null);
  const position = (event: PointerEvent) => (axis === "horizontal" ? event.clientX : event.clientY);

  const flushResize = () => {
    resizeFrame.current = null;
    const delta = pendingDelta.current;
    pendingDelta.current = 0;
    if (delta !== 0) onResize(delta);
  };
  const stop = () => {
    if (resizeFrame.current !== null) {
      window.cancelAnimationFrame(resizeFrame.current);
      flushResize();
    }
    lastPosition.current = null;
    document.body.removeAttribute("data-resizing");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
  };
  const move = (event: PointerEvent) => {
    const previous = lastPosition.current;
    const next = position(event);
    if (previous === null) return;
    lastPosition.current = next;
    const delta = next - previous;
    if (resizeFrame.current === null) {
      // Apply the first movement immediately, then collapse any additional
      // pointer events in the same frame into one React state update.
      onResize(delta);
      resizeFrame.current = window.requestAnimationFrame(flushResize);
    } else {
      pendingDelta.current += delta;
    }
  };
  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    pendingDelta.current = 0;
    lastPosition.current = position(event.nativeEvent);
    document.body.dataset.resizing = "true";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const negative = axis === "horizontal" ? event.key === "ArrowLeft" : event.key === "ArrowUp";
    const positive = axis === "horizontal" ? event.key === "ArrowRight" : event.key === "ArrowDown";
    if (!negative && !positive) return;
    event.preventDefault();
    onResize(positive ? 16 : -16);
  };

  return (
    <div
      className={`resize-handle resize-handle--${axis}`}
      role="separator"
      aria-label={label}
      aria-orientation={axis === "horizontal" ? "vertical" : "horizontal"}
      aria-valuenow={valueNow}
      aria-valuemin={valueMin}
      aria-valuemax={valueMax}
      tabIndex={0}
      onPointerDown={start}
      onKeyDown={onKeyDown}
    />
  );
}
