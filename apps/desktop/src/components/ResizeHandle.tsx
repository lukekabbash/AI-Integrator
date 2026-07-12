import { useRef } from "react";

interface ResizeHandleProps {
  axis: "horizontal" | "vertical";
  label: string;
  onResize: (delta: number) => void;
}

export function ResizeHandle({ axis, label, onResize }: ResizeHandleProps) {
  const lastPosition = useRef<number | null>(null);
  const position = (event: PointerEvent) => (axis === "horizontal" ? event.clientX : event.clientY);

  const stop = () => {
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
    onResize(next - previous);
  };
  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
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
      aria-orientation={axis}
      tabIndex={0}
      onPointerDown={start}
      onKeyDown={onKeyDown}
    />
  );
}
