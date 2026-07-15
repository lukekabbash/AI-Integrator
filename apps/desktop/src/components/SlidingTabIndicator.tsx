import { m as motion, useReducedMotion } from "motion/react";

interface SlidingTabIndicatorProps {
  layoutId: string;
}

const indicatorSpring = {
  type: "spring" as const,
  stiffness: 460,
  damping: 38,
  mass: 0.7,
};

export function SlidingTabIndicator({ layoutId }: SlidingTabIndicatorProps) {
  const reduceMotion =
    Boolean(useReducedMotion()) ||
    (typeof document !== "undefined" && document.documentElement.dataset.motion === "none");

  return (
    <motion.span
      className="sliding-tab-indicator"
      layoutId={reduceMotion ? undefined : layoutId}
      initial={false}
      transition={reduceMotion ? { duration: 0 } : { layout: indicatorSpring }}
      aria-hidden="true"
    />
  );
}
