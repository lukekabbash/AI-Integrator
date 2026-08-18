import { useLayoutEffect, useRef, useState } from "react";
import { m as motion, useReducedMotion } from "motion/react";

interface SelectionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TravelingSelectionProps {
  activeKey: string;
  className: string;
  layoutKey: string;
  visible?: boolean;
  /** Vertical lists clip the pill at the container's right edge so a wide row
      cannot spill out. A horizontal strip scrolls instead, where that clamp
      would shrink every tab past the fold to nothing. */
  clampWidth?: boolean;
  pace?: "settled" | "quick";
}

const selectionSpring = {
  type: "spring" as const,
  stiffness: 460,
  damping: 38,
  mass: 0.7,
};
/** A tab strip is short and the tabs are small, so the same travel reads as
 *  sluggish at the list's pace. Same shape, stiffer and lighter. */
const quickSelectionSpring = {
  type: "spring" as const,
  stiffness: 900,
  damping: 44,
  mass: 0.45,
};

function sameBounds(left: SelectionBounds | null, right: SelectionBounds): boolean {
  return (
    left?.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function measureTarget(
  target: HTMLElement,
  container: HTMLElement,
  clampWidth: boolean,
): SelectionBounds {
  let x = 0;
  let y = 0;
  let current: HTMLElement | null = target;
  while (current && current !== container) {
    x += current.offsetLeft;
    y += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }

  if (current !== container) {
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    x = targetRect.left - containerRect.left + container.scrollLeft;
    y = targetRect.top - containerRect.top + container.scrollTop;
  }

  const targetWidth = target.offsetWidth || target.getBoundingClientRect().width;
  const availableWidth =
    clampWidth && container.clientWidth ? Math.max(0, container.clientWidth - x) : targetWidth;
  return {
    x: Math.max(0, x),
    y,
    width: Math.min(targetWidth, availableWidth),
    height: target.offsetHeight || target.getBoundingClientRect().height,
  };
}

export function TravelingSelection({
  activeKey,
  className,
  layoutKey,
  visible = true,
  clampWidth = true,
  pace = "settled",
}: TravelingSelectionProps) {
  const reduceMotion =
    Boolean(useReducedMotion()) ||
    (typeof document !== "undefined" && document.documentElement.dataset.motion === "none");
  const [bounds, setBounds] = useState<SelectionBounds | null>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const visibleRef = useRef(visible);
  useLayoutEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useLayoutEffect(() => {
    const container = markerRef.current?.parentElement;
    if (!container || !activeKey) {
      setBounds(null);
      return;
    }

    const target = Array.from(
      container.querySelectorAll<HTMLElement>("[data-traveling-selection]"),
    ).find((element) => element.dataset.travelingSelection === activeKey);
    if (!target) {
      setBounds(null);
      return;
    }

    let measureFrame = 0;
    const measure = () => {
      if (!target.isConnected || !container.contains(target)) {
        setBounds(null);
        return;
      }
      // While fading out (e.g. its folder is sliding shut) the pill stays
      // frozen in place instead of chasing the moving rows.
      if (!visibleRef.current) return;
      const next = measureTarget(target, container, clampWidth);
      setBounds((current) => (sameBounds(current, next) ? current : next));
    };
    const scheduleMeasure = () => {
      window.cancelAnimationFrame(measureFrame);
      measureFrame = window.requestAnimationFrame(measure);
    };

    measure();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(container);
    resizeObserver?.observe(target);
    const mutationObserver = new MutationObserver(scheduleMeasure);
    mutationObserver.observe(container, { childList: true, subtree: true });
    window.addEventListener("resize", scheduleMeasure);

    return () => {
      window.cancelAnimationFrame(measureFrame);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [activeKey, layoutKey, reduceMotion, clampWidth]);

  if (!bounds) return <span ref={markerRef} hidden aria-hidden="true" />;

  const spring = pace === "quick" ? quickSelectionSpring : selectionSpring;
  return (
    <motion.span
      ref={markerRef}
      className={`traveling-selection ${className}`}
      initial={false}
      animate={{
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        opacity: visible ? 1 : 0,
      }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : {
              x: spring,
              y: spring,
              width: spring,
              height: spring,
              opacity: { duration: visible ? 0.08 : 0.07, ease: "easeOut" },
            }
      }
      aria-hidden="true"
    />
  );
}
