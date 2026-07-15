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

// Every outline uses the same M + four cubic curves + Z structure. Motion can
// therefore interpolate the path itself instead of merely rotating a static
// icon. Each agent starts from a stable identity and cycles through a
// different route across this shared shape vocabulary while it is active.
const morphPaths = [
  "M12 3 C17.5 3 21 6.5 21 12 C21 17.5 17.5 21 12 21 C6.5 21 3 17.5 3 12 C3 6.5 6.5 3 12 3 Z",
  "M12 2.5 C15 6 18 9 21.5 12 C18 15 15 18 12 21.5 C9 18 6 15 2.5 12 C6 9 9 6 12 2.5 Z",
  "M12 3 C15 3 17 3 19 3 C21 7 21 17 19 21 C15 21 9 21 5 21 C3 17 3 7 5 3 C7 3 9 3 12 3 Z",
  "M12 5 C18 5 22 8 22 12 C22 16 18 19 12 19 C6 19 2 16 2 12 C2 8 6 5 12 5 Z",
  "M12 2 C16 2 19 6 19 12 C19 18 16 22 12 22 C8 22 5 18 5 12 C5 6 8 2 12 2 Z",
  "M12 2.5 C15 7.5 18 8.5 21.5 12 C18 15.5 15 16.5 12 21.5 C9 16.5 6 15.5 2.5 12 C6 8.5 9 7.5 12 2.5 Z",
  "M12 3 C18 2 22 8 20 13 C18 19 16 22 10 20 C4 20 1 16 3 10 C5 4 7 4 12 3 Z",
  "M12 2.5 C16 5 21 7 21.5 11 C19 15 17 20 13 21.5 C9 19 4 17 2.5 13 C5 9 7 4 12 2.5 Z",
  "M12 3 C16 3 17 8 21 10 C20 15 17 17 14 21 C9 21 7 18 3 15 C3 10 7 8 8 4 C9 3 10 3 12 3 Z",
  "M12 3 C16 3 20 4 21 7 C18 10 18 14 21 17 C20 20 16 21 12 21 C8 21 4 20 3 17 C6 14 6 10 3 7 C4 4 8 3 12 3 Z",
] as const;

const motifs = [
  <>
    <path d="M12 6.5v3M12 14.5v3M6.5 12h3M14.5 12h3" />
    <circle cx="12" cy="12" r="1.35" />
  </>,
  <>
    <circle cx="12" cy="12" r="2.25" />
    <path d="M12 6.75v2M12 15.25v2" />
  </>,
  <>
    <path d="M8 8l8 8M16 8l-8 8" />
    <circle cx="12" cy="12" r="1.3" />
  </>,
  <path d="m12 7.25 4.15 2.4v4.7L12 16.75l-4.15-2.4v-4.7L12 7.25Z" />,
  <>
    <path d="M7 9h7l-2.25-2.25M17 15h-7l2.25 2.25" />
    <circle cx="12" cy="12" r="1.3" />
  </>,
  <>
    <path d="M6.25 12c1.9-4 3.8-4 5.7 0s3.8 4 5.7 0" />
    <path d="M8 16.5h8" />
  </>,
  <>
    <path d="M12 7.25a4.75 4.75 0 1 1-3.35 1.39" />
    <circle cx="12" cy="12" r="1.25" />
  </>,
  <>
    <path d="M12 6.25c.8 2.65 1.85 3.7 4.5 4.5-2.65.8-3.7 1.85-4.5 4.5-.8-2.65-1.85-3.7-4.5-4.5 2.65-.8 3.7-1.85 4.5-4.5Z" />
    <circle cx="17.5" cy="17.5" r="1" />
  </>,
  <>
    <circle cx="12" cy="7.5" r="1.25" />
    <circle cx="8" cy="15.5" r="1.25" />
    <circle cx="16" cy="15.5" r="1.25" />
    <path d="m11.35 8.7-2.7 5.6M12.65 8.7l2.7 5.6M9.25 15.5h5.5" />
  </>,
  <>
    <path d="m7.25 8.25 3.75 3.75-3.75 3.75M12 8.25 15.75 12 12 15.75" />
    <path d="M17.5 7v10" />
  </>,
] as const;

function morphingState(state: AgentGlyphState): boolean {
  return (
    state === "starting" ||
    state === "running" ||
    state === "waiting" ||
    state === "interrupted"
  );
}

function pathSequence(variant: number, state: AgentGlyphState): string[] {
  const at = (offset: number) => morphPaths[(variant + offset) % morphPaths.length];
  switch (state) {
    case "starting":
      return [at(0), at(3), at(6), at(0)];
    case "running":
      return [at(0), at(1), at(4), at(7), at(0)];
    case "waiting":
    case "interrupted":
      return [at(0), at(1), at(0)];
    default:
      return [at(0)];
  }
}

function pathTransition(state: AgentGlyphState, still: boolean) {
  if (still || !morphingState(state)) return { duration: 0 };
  return {
    duration: state === "starting" ? 1.8 : state === "running" ? 3.6 : 4.2,
    ease: "easeInOut" as const,
    repeat: Number.POSITIVE_INFINITY,
  };
}

function motifMotion(state: AgentGlyphState, still: boolean) {
  if (still) return { animate: {}, transition: { duration: 0 } };
  switch (state) {
    case "starting":
      return {
        animate: { rotate: [0, 120, 240, 360], scale: [0.72, 1, 0.82, 0.72] },
        transition: {
          duration: 1.8,
          ease: "easeInOut" as const,
          repeat: Number.POSITIVE_INFINITY,
        },
      };
    case "running":
      return {
        animate: {
          rotate: [0, 12, -8, 7, 0],
          scale: [0.86, 1.08, 0.92, 1.03, 0.86],
          opacity: [0.58, 1, 0.68, 0.94, 0.58],
        },
        transition: {
          duration: 3.6,
          ease: "easeInOut" as const,
          repeat: Number.POSITIVE_INFINITY,
        },
      };
    case "waiting":
    case "interrupted":
    case "pending-approval":
      return {
        animate: { rotate: [0, 30, 0], scale: [0.86, 1, 0.86], opacity: [0.5, 1, 0.5] },
        transition: {
          duration: 4.2,
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
  const safeVariant = Math.abs(variant) % morphPaths.length;
  const still = reduceMotion === true;
  const sequence = pathSequence(safeVariant, state);
  const morphing = !still && morphingState(state);
  const motif = motifMotion(state, still);

  return (
    <span
      className="agent-glyph"
      data-agent-icon={safeVariant + 1}
      data-provider={provider}
      data-shade={shade % 3}
      data-state={state}
      data-morphing={morphing}
      data-morph-frames={sequence.length}
      role="img"
      aria-label={`${label}, ${state}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <motion.path
          className="agent-glyph-morph"
          d={morphPaths[safeVariant]}
          animate={{ d: morphing ? sequence : morphPaths[safeVariant] }}
          transition={pathTransition(state, still)}
        />
        <motion.g
          animate={motif.animate}
          transition={motif.transition}
          style={{ transformOrigin: "12px 12px" }}
        >
          {motifs[safeVariant]}
        </motion.g>
      </svg>
    </span>
  );
}
