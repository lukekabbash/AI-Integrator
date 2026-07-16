import { Fragment, type ReactNode } from "react";
import { m as motion, useReducedMotion } from "motion/react";
import type { DelegationStatus, TaskStatus } from "../bridge";

export type AgentGlyphState = DelegationStatus | TaskStatus;

interface AgentGlyphProps {
  variant: number;
  shade: number;
  provider: string;
  state: AgentGlyphState;
  label: string;
  hovered?: boolean;
}

type MotionFamily =
  "dormant" | "forming" | "working" | "watching" | "interrupted" | "resting" | "failed";

// All ten bodies share the same path structure, so an agent can transform
// without losing its ordinal identity. The runes below stay fixed per ordinal;
// lifecycle motion is a separate layer and never changes who the glyph belongs to.
const bodyPaths = [
  "M16 3.25 C23.8 3.25 28.75 8.2 28.75 16 C28.75 23.8 23.8 28.75 16 28.75 C8.2 28.75 3.25 23.8 3.25 16 C3.25 8.2 8.2 3.25 16 3.25 Z",
  "M16 2.75 C20.2 7.7 24.8 12.2 29.25 16 C24.8 19.8 20.2 24.3 16 29.25 C11.8 24.3 7.2 19.8 2.75 16 C7.2 12.2 11.8 7.7 16 2.75 Z",
  "M16 3.5 C20.5 3.5 24.2 3.5 26.8 5.2 C28.5 9 28.5 23 26.8 26.8 C22.8 28.5 9.2 28.5 5.2 26.8 C3.5 23 3.5 9 5.2 5.2 C7.8 3.5 11.5 3.5 16 3.5 Z",
  "M16 6 C24 6 30 10.2 30 16 C30 21.8 24 26 16 26 C8 26 2 21.8 2 16 C2 10.2 8 6 16 6 Z",
  "M16 2 C21.8 2 26 8 26 16 C26 24 21.8 30 16 30 C10.2 30 6 24 6 16 C6 8 10.2 2 16 2 Z",
  "M16 2.75 C19.4 8.2 24.6 10.6 29.25 16 C24.6 21.4 19.4 23.8 16 29.25 C12.6 23.8 7.4 21.4 2.75 16 C7.4 10.6 12.6 8.2 16 2.75 Z",
  "M16 3 C23.5 1.8 29.7 8.2 27.3 16.4 C25.2 24.4 21.4 30 13.2 27.8 C5.2 28.2 0.9 22.1 3.4 13.9 C5.5 6 9.1 4.4 16 3 Z",
  "M16 2.8 C21.3 6.2 28.4 8.9 29.2 14.4 C26 20 23.6 27.1 18 29.2 C12.4 26 5.3 23.6 2.8 18 C6 12.4 8.4 5.3 16 2.8 Z",
  "M16 3 C21.5 3 23.3 9.8 29 12.2 C28.1 19.1 23.5 21.8 19 28.8 C12 29 9.7 24.2 3 20.5 C2.6 13.8 8.5 10.5 10 4.5 C11.7 3.4 13.6 3 16 3 Z",
  "M16 3.2 C22 3.2 27.3 4.8 29 8.2 C24.5 12.7 24.5 19.3 29 23.8 C27.3 27.2 22 28.8 16 28.8 C10 28.8 4.7 27.2 3 23.8 C7.5 19.3 7.5 12.7 3 8.2 C4.7 4.8 10 3.2 16 3.2 Z",
] as const;

const runes: readonly ReactNode[] = [
  <Fragment key="axis">
    <path d="M16 8.2v4.1M16 19.7v4.1M8.2 16h4.1M19.7 16h4.1" />
    <circle cx="16" cy="16" r="2.05" />
    <path d="m12.25 12.25 1.35 1.35M18.4 18.4l1.35 1.35" />
  </Fragment>,
  <Fragment key="lens">
    <circle cx="16" cy="16" r="3.35" />
    <path d="M16 8.2v3.2M16 20.6v3.2M8.2 16h3.2M20.6 16h3.2" />
    <path d="m10.45 10.45 2.1 2.1M19.45 19.45l2.1 2.1" />
  </Fragment>,
  <Fragment key="cross">
    <path d="m10.1 10.1 11.8 11.8M21.9 10.1 10.1 21.9" />
    <circle cx="16" cy="16" r="2.15" />
    <circle cx="16" cy="16" r="5.8" strokeDasharray="1.1 3.1" />
  </Fragment>,
  <Fragment key="hex">
    <path d="m16 9.2 5.9 3.4v6.8L16 22.8l-5.9-3.4v-6.8L16 9.2Z" />
    <path d="m16 12.2 3.3 1.9v3.8L16 19.8l-3.3-1.9v-3.8L16 12.2Z" />
  </Fragment>,
  <Fragment key="exchange">
    <path d="M9.2 12h9.5l-3-3M22.8 20h-9.5l3 3" />
    <path d="M22.8 12h-2.2M9.2 20h2.2" />
    <circle cx="16" cy="16" r="1.7" />
  </Fragment>,
  <Fragment key="wave">
    <path d="M8 16c2.65-5.5 5.3-5.5 7.95 0s5.3 5.5 7.95 0" />
    <path d="M10.2 22h11.6M10.2 10h11.6" />
    <circle cx="16" cy="16" r="1.4" />
  </Fragment>,
  <Fragment key="cycle">
    <path d="M16 9.1a6.9 6.9 0 1 1-4.9 2.05" />
    <path d="m10.9 8.4.2 2.75 2.75-.15" />
    <circle cx="16" cy="16" r="1.8" />
  </Fragment>,
  <Fragment key="star">
    <path d="M16 8.1c1.15 3.85 2.65 5.35 6.5 6.5-3.85 1.15-5.35 2.65-6.5 6.5-1.15-3.85-2.65-5.35-6.5-6.5 3.85-1.15 5.35-2.65 6.5-6.5Z" />
    <circle cx="23.5" cy="23.5" r="1.25" />
  </Fragment>,
  <Fragment key="constellation">
    <circle cx="16" cy="9.2" r="1.55" />
    <circle cx="10.2" cy="21.4" r="1.55" />
    <circle cx="21.8" cy="21.4" r="1.55" />
    <path d="m15.25 10.6-4.3 9.35M16.75 10.6l4.3 9.35M11.75 21.4h8.5" />
  </Fragment>,
  <Fragment key="gate">
    <path d="m8.7 10.4 5.6 5.6-5.6 5.6M15.3 10.4l5.6 5.6-5.6 5.6" />
    <path d="M24 8.6v14.8M8 8.6v2.1" />
  </Fragment>,
] as const;

function motionFamily(state: AgentGlyphState): MotionFamily {
  switch (state) {
    case "starting":
      return "forming";
    case "running":
      return "working";
    case "pending-approval":
    case "waiting":
      return "watching";
    case "interrupted":
      return "interrupted";
    case "completed":
      return "resting";
    case "failed":
      return "failed";
    default:
      return "dormant";
  }
}

function pathSequence(variant: number, state: AgentGlyphState): string[] {
  const at = (offset: number) => bodyPaths[(variant + offset) % bodyPaths.length];
  switch (state) {
    case "starting":
      return [at(0), at(3), at(6), at(0)];
    case "running":
      return [at(0), at(1), at(4), at(7), at(0)];
    case "pending-approval":
      return [at(0), at(5), at(0)];
    case "waiting":
      return [at(0), at(1), at(0)];
    case "interrupted":
      return [at(0), at(8), at(0)];
    default:
      return [at(0)];
  }
}

function loop(duration: number) {
  return {
    duration,
    ease: "easeInOut" as const,
    repeat: Number.POSITIVE_INFINITY,
  };
}

function pathTransition(state: AgentGlyphState, still: boolean) {
  if (still) return { duration: 0 };
  switch (state) {
    case "starting":
      return loop(2.15);
    case "running":
      return loop(4.1);
    case "pending-approval":
      return loop(6.2);
    case "waiting":
      return loop(5.4);
    case "interrupted":
      return loop(4.8);
    default:
      return { duration: 0.2 };
  }
}

type LayerKeyframes = Partial<Record<"rotate" | "scale" | "opacity" | "x" | "y", number[]>>;

interface LayerMotion {
  animate: LayerKeyframes;
  duration: number;
}

interface MotionProfile {
  body: LayerMotion;
  rune: LayerMotion;
  orbit: LayerMotion;
}

const MOTION_PROFILES: Record<MotionFamily, MotionProfile> = {
  dormant: {
    body: { animate: { opacity: [0.76, 0.86, 0.76] }, duration: 8.4 },
    rune: { animate: { opacity: [0.56, 0.68, 0.56] }, duration: 8.4 },
    orbit: { animate: { opacity: [0.1, 0.18, 0.1] }, duration: 8.4 },
  },
  forming: {
    body: {
      animate: { rotate: [0, 90, 180, 360], scale: [0.82, 1.04, 0.93, 1] },
      duration: 2.15,
    },
    rune: {
      animate: { rotate: [0, -120, -240, -360], scale: [0.62, 1.08, 0.8, 1] },
      duration: 2.15,
    },
    orbit: { animate: { rotate: [0, 180, 360], opacity: [0.2, 0.72, 0.2] }, duration: 2.15 },
  },
  working: {
    body: {
      animate: { rotate: [0, 2.2, -1.2, 0], scale: [0.96, 1.025, 0.985, 0.96] },
      duration: 4.1,
    },
    rune: {
      animate: {
        rotate: [0, -8, 5, -3, 0],
        scale: [0.9, 1.08, 0.96, 1.03, 0.9],
        opacity: [0.66, 1, 0.76, 0.94, 0.66],
      },
      duration: 4.1,
    },
    orbit: { animate: { rotate: [0, 360], opacity: [0.32, 0.72, 0.32] }, duration: 5.6 },
  },
  watching: {
    body: {
      animate: { rotate: [-1.2, 1.2, -1.2], scale: [0.985, 1.01, 0.985] },
      duration: 5.8,
    },
    rune: {
      animate: { rotate: [-3, 3, -3], scale: [0.94, 1, 0.94], opacity: [0.62, 0.92, 0.62] },
      duration: 5.8,
    },
    orbit: {
      animate: { rotate: [-16, 16, -16], opacity: [0.18, 0.48, 0.18] },
      duration: 6.4,
    },
  },
  interrupted: {
    body: { animate: { x: [0, -0.45, 0.25, 0], rotate: [0, -1.8, 0.9, 0] }, duration: 4.8 },
    rune: { animate: { x: [0, 0.5, -0.2, 0], opacity: [0.58, 0.82, 0.62, 0.58] }, duration: 4.8 },
    orbit: { animate: { rotate: [-24, 4, -24], opacity: [0.16, 0.4, 0.16] }, duration: 5.2 },
  },
  resting: {
    body: { animate: { y: [0, -0.28, 0], scale: [1, 1.012, 1] }, duration: 7.2 },
    rune: { animate: { scale: [0.97, 1, 0.97], opacity: [0.78, 0.92, 0.78] }, duration: 7.2 },
    orbit: { animate: { rotate: [-2, 2, -2], opacity: [0.16, 0.28, 0.16] }, duration: 9.6 },
  },
  failed: {
    body: {
      animate: { x: [0, -0.32, 0.26, -0.12, 0], rotate: [0, -0.65, 0.5, 0] },
      duration: 5.2,
    },
    rune: {
      animate: { x: [0, 0.38, -0.32, 0.15, 0], opacity: [0.58, 0.78, 0.62, 0.58] },
      duration: 5.2,
    },
    orbit: { animate: { rotate: [0, -3, 2, 0], opacity: [0.16, 0.34, 0.16] }, duration: 5.2 },
  },
};

function layerMotion(layer: LayerMotion, still: boolean) {
  return still
    ? { animate: {}, transition: { duration: 0 } }
    : { animate: layer.animate, transition: loop(layer.duration) };
}

function hoverPose(family: MotionFamily) {
  const transition = { type: "spring" as const, stiffness: 480, damping: 24, mass: 0.58 };
  switch (family) {
    case "forming":
      return { scale: 1.14, rotate: 11, transition };
    case "working":
      return { scale: 1.16, rotate: 16, transition };
    case "watching":
      return { scale: 1.1, rotate: -5, transition };
    case "interrupted":
      return { scale: 1.11, rotate: -8, x: -0.75, transition };
    case "resting":
      return { scale: 1.12, y: -1.5, transition };
    case "failed":
      return { scale: 1.12, rotate: -6, x: -0.7, transition };
    default:
      return { scale: 1.08, rotate: 2, transition };
  }
}

function stateGeometry(state: AgentGlyphState) {
  switch (state) {
    case "completed":
      return (
        <>
          <circle cx="26.2" cy="25.2" r="3.25" />
          <path d="m24.45 25.2 1.2 1.25 2.35-2.75" />
        </>
      );
    case "failed":
      return (
        <>
          <path d="m24.1 21.9 2.15 2.7-1.55 1.25 2.5 3.15" />
          <path d="m27.15 22.2 1.35-1.25M22.75 27.8l-1.45.85" />
        </>
      );
    case "interrupted":
      return (
        <>
          <path d="m23.15 23.2 2.05-2.05M26.8 26.85l2.05-2.05" />
          <circle cx="26" cy="24" r="0.65" fill="currentColor" stroke="none" />
        </>
      );
    case "stopped":
      return <path d="M23.2 25.7h5.6" />;
    case "denied":
      return <path d="m23.8 23.5 4.4 4.4M28.2 23.5l-4.4 4.4" />;
    case "pending-approval":
      return (
        <>
          <circle cx="25.9" cy="25.8" r="0.85" fill="currentColor" stroke="none" />
          <path d="M23.4 23.4a3.5 3.5 0 0 1 5 0" />
        </>
      );
    default:
      return null;
  }
}

export function AgentGlyph({
  variant,
  shade,
  provider,
  state,
  label,
  hovered = false,
}: AgentGlyphProps) {
  const reduceMotion = useReducedMotion();
  const safeVariant = Math.abs(variant) % bodyPaths.length;
  const still = reduceMotion === true;
  const family = motionFamily(state);
  const profile = MOTION_PROFILES[family];
  const sequence = pathSequence(safeVariant, state);
  const morphing = !still && sequence.length > 1;
  const body = layerMotion(profile.body, still);
  const rune = layerMotion(profile.rune, still);
  const orbit = layerMotion(profile.orbit, still);
  const dash = 2.15 + (safeVariant % 4) * 0.65;

  return (
    <motion.span
      className="agent-glyph"
      data-agent-icon={safeVariant + 1}
      data-provider={provider}
      data-shade={Math.abs(shade) % 3}
      data-state={state}
      data-motion-family={family}
      data-hovered={hovered}
      data-morphing={morphing}
      data-morph-frames={sequence.length}
      role="img"
      aria-label={`${label}, ${state}`}
      animate={
        still
          ? undefined
          : hovered
            ? hoverPose(family)
            : {
                scale: 1,
                rotate: 0,
                x: 0,
                y: 0,
                transition: { type: "spring", stiffness: 420, damping: 28, mass: 0.62 },
              }
      }
    >
      <svg
        viewBox="-1 -1 34 34"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <motion.path
          className="agent-glyph-halo"
          d={bodyPaths[safeVariant]}
          animate={{ d: morphing ? sequence : bodyPaths[safeVariant] }}
          transition={pathTransition(state, still)}
        />
        <motion.g
          className="agent-glyph-orbit"
          animate={orbit.animate}
          transition={orbit.transition}
          style={{ transformOrigin: "16px 16px" }}
        >
          <circle cx="16" cy="16" r="14.25" strokeDasharray={`${dash} ${4.8 + dash}`} />
          <circle cx="16" cy="1.75" r="0.92" fill="currentColor" stroke="none" />
          <circle cx="16" cy="30.25" r="0.58" fill="currentColor" stroke="none" />
        </motion.g>
        <motion.g
          className="agent-glyph-body"
          animate={body.animate}
          transition={body.transition}
          style={{ transformOrigin: "16px 16px" }}
        >
          <motion.path
            d={bodyPaths[safeVariant]}
            animate={{ d: morphing ? sequence : bodyPaths[safeVariant] }}
            transition={pathTransition(state, still)}
          />
        </motion.g>
        <motion.g
          className="agent-glyph-rune"
          animate={rune.animate}
          transition={rune.transition}
          style={{ transformOrigin: "16px 16px" }}
        >
          {runes[safeVariant]}
        </motion.g>
        <motion.circle
          className="agent-glyph-core"
          cx="16"
          cy="16"
          r="0.95"
          fill="currentColor"
          stroke="none"
          animate={
            still
              ? undefined
              : family === "working" || family === "forming"
                ? { scale: [0.75, 1.45, 0.75], opacity: [0.55, 1, 0.55] }
                : { scale: [0.88, 1.08, 0.88], opacity: [0.52, 0.78, 0.52] }
          }
          transition={still ? { duration: 0 } : loop(family === "working" ? 2.05 : 5.6)}
          style={{ transformOrigin: "16px 16px" }}
        />
        <motion.g
          className="agent-glyph-state-mark"
          animate={
            still
              ? undefined
              : family === "failed" || family === "interrupted"
                ? { opacity: [0.45, 0.9, 0.45], x: [0, 0.3, -0.2, 0] }
                : family === "resting"
                  ? { opacity: [0.68, 0.9, 0.68] }
                  : { opacity: [0.46, 0.72, 0.46] }
          }
          transition={still ? { duration: 0 } : loop(family === "failed" ? 4.2 : 6.8)}
        >
          {stateGeometry(state)}
        </motion.g>
      </svg>
    </motion.span>
  );
}
