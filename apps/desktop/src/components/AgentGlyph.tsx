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

interface SigilFrame {
  radii: readonly number[];
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
}

// Straight segments only: these are rose-window, compass, shield, reliquary,
// and heraldic-star frames rather than organic blobs. Every frame has sixteen
// vertices, so morphing moves crisp joints without ever bowing an edge.
const sigilFrames: readonly SigilFrame[] = [
  {
    radii: [
      13.8, 13.1, 13.8, 13.1, 13.8, 13.1, 13.8, 13.1, 13.8, 13.1, 13.8, 13.1, 13.8, 13.1, 13.8,
      13.1,
    ],
  },
  {
    radii: [14.2, 8.4, 14.2, 8.4, 14.2, 8.4, 14.2, 8.4, 14.2, 8.4, 14.2, 8.4, 14.2, 8.4, 14.2, 8.4],
  },
  {
    radii: [
      13.9, 11.2, 9.4, 11.2, 13.9, 11.2, 9.4, 11.2, 13.9, 11.2, 9.4, 11.2, 13.9, 11.2, 9.4, 11.2,
    ],
    rotation: 11.25,
  },
  {
    radii: [
      13.9, 12.4, 13.9, 12.4, 13.9, 12.4, 13.9, 12.4, 13.9, 12.4, 13.9, 12.4, 13.9, 12.4, 13.9,
      12.4,
    ],
    scaleX: 1.04,
    scaleY: 0.68,
  },
  {
    radii: [
      13.9, 12.4, 13.9, 12.4, 13.9, 12.4, 13.9, 12.4, 13.9, 12.4, 13.9, 12.4, 13.9, 12.4, 13.9,
      12.4,
    ],
    scaleX: 0.68,
    scaleY: 1.04,
  },
  { radii: [14.2, 8.1, 9.5, 8.1, 14.2, 8.1, 9.5, 8.1, 14.2, 8.1, 9.5, 8.1, 14.2, 8.1, 9.5, 8.1] },
  {
    radii: [
      13.8, 10.6, 12.8, 8.7, 13.8, 10.6, 12.8, 8.7, 13.8, 10.6, 12.8, 8.7, 13.8, 10.6, 12.8, 8.7,
    ],
    rotation: 11.25,
  },
  {
    radii: [14.3, 9.8, 12.2, 9.1, 14.3, 9.8, 12.2, 9.1, 14.3, 9.8, 12.2, 9.1, 14.3, 9.8, 12.2, 9.1],
    rotation: 22.5,
  },
  {
    radii: [
      14.2, 10.4, 12.8, 8.6, 13.4, 9.2, 14, 10.2, 13.1, 9.1, 12.4, 8.8, 14.1, 10.1, 13.2, 9.4,
    ],
  },
  {
    radii: [13.8, 9.2, 11.8, 13.2, 9, 13.2, 11.8, 9.2, 13.8, 9.2, 11.8, 13.2, 9, 13.2, 11.8, 9.2],
    rotation: 11.25,
  },
] as const;

function sigilPath({ radii, rotation = 0, scaleX = 1, scaleY = 1 }: SigilFrame): string {
  const rotationRadians = (rotation * Math.PI) / 180;
  return `${radii
    .map((radius, index) => {
      const angle = -Math.PI / 2 + rotationRadians + (index / radii.length) * Math.PI * 2;
      const x = Number((16 + Math.cos(angle) * radius * scaleX).toFixed(2));
      const y = Number((16 + Math.sin(angle) * radius * scaleY).toFixed(2));
      return `${index === 0 ? "M" : "L"}${x} ${y}`;
    })
    .join(" ")} Z`;
}

const bodyPaths = sigilFrames.map(sigilPath);

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
    <path d="m9 20 7-11 7 11H9Z" />
    <path d="m9 12 7 11 7-11H9Z" />
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

function mechanicalLoop(duration: number) {
  return { ...loop(duration), ease: [0.72, 0, 0.28, 1] as const };
}

function pathTransition(state: AgentGlyphState, still: boolean) {
  if (still) return { duration: 0 };
  switch (state) {
    case "starting":
      return mechanicalLoop(2.15);
    case "running":
      return mechanicalLoop(4.1);
    case "pending-approval":
      return mechanicalLoop(6.2);
    case "waiting":
      return mechanicalLoop(5.4);
    case "interrupted":
      return mechanicalLoop(4.8);
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
      animate: { rotate: [0, 1.6, -0.8, 0], scale: [0.99, 1.012, 1, 0.99] },
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
      animate: { rotate: [-0.8, 0.8, -0.8] },
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
