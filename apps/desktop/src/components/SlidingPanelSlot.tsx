import type { ReactNode } from "react";
import { AnimatePresence, m as motion } from "motion/react";

export function SlidingPanelSlot({
  open,
  children,
  motionScale = 1,
  slotKey,
}: {
  open: boolean;
  children: ReactNode;
  motionScale?: number;
  slotKey: string;
}) {
  const transition = {
    width: { duration: 0.34 * motionScale, ease: [0.33, 1, 0.15, 1] as const },
    opacity: { duration: 0.22 * motionScale, ease: "easeOut" as const },
  };

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          className="panel-slot panel-slot--right"
          key={slotKey}
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: "auto", opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={transition}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
