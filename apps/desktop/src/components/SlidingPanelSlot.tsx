import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, m as motion } from "motion/react";

export function SlidingPanelSlot({
  open,
  children,
  width,
  motionScale = 1,
  slotKey,
}: {
  open: boolean;
  children: ReactNode;
  width: number;
  motionScale?: number;
  slotKey: string;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(width);
  const [viewportResizing, setViewportResizing] = useState(false);
  const activelyResizing =
    typeof document !== "undefined" && document.body.dataset.resizing === "true";

  useLayoutEffect(() => {
    if (!open) return;
    const slot = slotRef.current;
    if (!slot) {
      setMeasuredWidth(width);
      return;
    }

    let observedPanel: HTMLElement | null = null;
    const measure = () => {
      const panel = slot.firstElementChild;
      if (!(panel instanceof HTMLElement)) {
        setMeasuredWidth(width);
        return;
      }
      if (panel !== observedPanel) {
        if (observedPanel) resizeObserver?.unobserve(observedPanel);
        observedPanel = panel;
        resizeObserver?.observe(panel);
      }
      const nextWidth = panel.getBoundingClientRect().width;
      setMeasuredWidth(nextWidth > 0 ? nextWidth : width);
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const childObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(measure);

    measure();
    childObserver?.observe(slot, { childList: true });
    let resizeFrame: number | null = null;
    const measureViewport = () => {
      setViewportResizing(true);
      measure();
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        setViewportResizing(false);
      });
    };
    window.addEventListener("resize", measureViewport);
    return () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
        // `open` and stored width changes rerun this effect. Do not leave a
        // cancelled viewport frame suppressing later open/close motion.
        setViewportResizing(false);
      }
      resizeObserver?.disconnect();
      childObserver?.disconnect();
      window.removeEventListener("resize", measureViewport);
    };
  }, [open, slotKey, width]);

  const transition = {
    width: {
      duration: activelyResizing || viewportResizing ? 0 : 0.34 * motionScale,
      ease: [0.33, 1, 0.15, 1] as const,
    },
    opacity: { duration: 0.22 * motionScale, ease: "easeOut" as const },
  };

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          ref={slotRef}
          className="panel-slot panel-slot--right"
          key={slotKey}
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: measuredWidth, opacity: 1 }}
          exit={{
            width: 0,
            opacity: 0,
            // Measurement suppression is only for live viewport/drag updates;
            // a deliberate close must always retain the panel glide.
            transition: {
              width: {
                duration: 0.34 * motionScale,
                ease: [0.33, 1, 0.15, 1] as const,
              },
              opacity: { duration: 0.22 * motionScale, ease: "easeOut" as const },
            },
          }}
          transition={transition}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
