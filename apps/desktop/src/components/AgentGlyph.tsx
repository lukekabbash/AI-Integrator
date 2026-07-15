import { m as motion, useReducedMotion } from "motion/react";
import type { DelegationStatus, TaskStatus } from "../bridge";

export type AgentGlyphState = DelegationStatus | TaskStatus;

interface AgentGlyphProps {
  variant: number;
  shade: number;
  provider: string;
  state: AgentGlyphState;
  label: string;
}

const glyphs = [
  <>
    <circle cx="12" cy="12" r="6.25" />
    <path d="M12 2.75v3M12 18.25v3M2.75 12h3M18.25 12h3" />
  </>,
  <>
    <path d="m12 3 7.5 14H4.5L12 3Z" />
    <circle cx="12" cy="13" r="2.25" />
  </>,
  <>
    <path d="M12 2.75v18.5M2.75 12h18.5M5.45 5.45l13.1 13.1M18.55 5.45l-13.1 13.1" />
    <circle cx="12" cy="12" r="2.1" />
  </>,
  <>
    <path d="m12 3.25 7.6 4.38v8.74L12 20.75l-7.6-4.38V7.63L12 3.25Z" />
    <path d="m8.3 9.85 3.7-2.1 3.7 2.1v4.3l-3.7 2.1-3.7-2.1v-4.3Z" />
  </>,
  <>
    <path d="M4 7.25h8.3l-2.8-2.8M20 16.75h-8.3l2.8 2.8" />
    <path d="M4 16.75h4.1M20 7.25h-4.1" />
    <circle cx="12" cy="12" r="2.15" />
  </>,
  <>
    <path d="M3 12c2.25-5.4 4.5-5.4 6.75 0s4.5 5.4 6.75 0S21 6.6 21 12" />
    <path d="M6.5 17.25h11" />
  </>,
  <>
    <path d="M12 3.25a8.75 8.75 0 1 1-6.2 2.56" />
    <path d="M12 7.25a4.75 4.75 0 1 1-3.35 1.39" />
    <circle cx="12" cy="12" r="1.4" />
  </>,
  <>
    <path d="M12 2.75c1.3 4.25 2.65 5.6 6.9 6.9-4.25 1.3-5.6 2.65-6.9 6.9-1.3-4.25-2.65-5.6-6.9-6.9 4.25-1.3 5.6-2.65 6.9-6.9Z" />
    <path d="M18.25 15.75c.55 1.8 1.2 2.45 3 3-1.8.55-2.45 1.2-3 3-.55-1.8-1.2-2.45-3-3 1.8-.55 2.45-1.2 3-3Z" />
  </>,
  <>
    <circle cx="12" cy="4.25" r="2" />
    <circle cx="5" cy="17.5" r="2" />
    <circle cx="19" cy="17.5" r="2" />
    <path d="m10.9 6-4.8 9.65M13.1 6l4.8 9.65M7 17.5h10" />
  </>,
  <>
    <path d="m4 7.25 4.75 4.75L4 16.75M11.25 7.25 16 12l-4.75 4.75" />
    <path d="M19.75 5v14" />
  </>,
] as const;

function glyphMotion(state: AgentGlyphState, still: boolean) {
  if (still) return { animate: {}, transition: { duration: 0 } };
  switch (state) {
    case "starting":
      return {
        animate: { rotate: [0, 180, 360], scale: [0.9, 1.06, 1] },
        transition: {
          duration: 1.5,
          ease: "easeInOut" as const,
          repeat: Number.POSITIVE_INFINITY,
        },
      };
    case "running":
      return {
        animate: { rotate: [0, 4, -3, 0], scale: [1, 1.045, 1] },
        transition: {
          duration: 2.4,
          ease: "easeInOut" as const,
          repeat: Number.POSITIVE_INFINITY,
        },
      };
    case "waiting":
    case "pending-approval":
      return {
        animate: { opacity: [0.52, 1, 0.52] },
        transition: {
          duration: 2.8,
          ease: "easeInOut" as const,
          repeat: Number.POSITIVE_INFINITY,
        },
      };
    default:
      return { animate: {}, transition: { duration: 0.16 } };
  }
}

export function AgentGlyph({ variant, shade, provider, state, label }: AgentGlyphProps) {
  const reduceMotion = useReducedMotion();
  const motionState = glyphMotion(state, reduceMotion === true);
  const safeVariant = Math.abs(variant) % glyphs.length;

  return (
    <span
      className="agent-glyph"
      data-agent-icon={safeVariant + 1}
      data-provider={provider}
      data-shade={shade % 3}
      data-state={state}
      role="img"
      aria-label={`${label}, ${state}`}
    >
      <motion.svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        animate={motionState.animate}
        transition={motionState.transition}
        style={{ transformOrigin: "12px 12px" }}
      >
        {glyphs[safeVariant]}
      </motion.svg>
    </span>
  );
}
