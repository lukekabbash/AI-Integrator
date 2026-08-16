import { m as motion, useReducedMotion } from "motion/react";

/** Folder icon whose front flap swings open and shut instead of swapping.
 *
 * The geometry matches lucide's Folder / FolderOpen at rest, split into two
 * sub-paths: the back pocket (left wall + tab) and the front flap. Each pair
 * of `d` variants shares an identical command structure — segments that only
 * exist in one state collapse to a point in the other — which is what lets
 * Motion interpolate the path and morph the flap. */

const BACK_CLOSED =
  "M2 18L2 5A2 2 0 0 1 4 3L7.93 3A2 2 0 0 1 9.62 3.9L10.43 5.1A2 2 0 0 0 12.1 6L18 6A2 2 0 0 1 18 6L18 6";
const BACK_OPEN =
  "M2 18L2 5A2 2 0 0 1 4 3L7.93 3A2 2 0 0 1 9.62 3.9L10.43 5.1A2 2 0 0 0 12.1 6L18 6A2 2 0 0 1 20 8L20 10";

const FLAP_CLOSED =
  "M2 16L2 5A2 2 0 0 1 4 3L7.93 3A2 2 0 0 1 9.62 3.9L10.43 5.1A2 2 0 0 0 12.1 6L20 6A2 2 0 0 1 22 8L22 18A2 2 0 0 1 20 20L4 20A2 2 0 0 1 2 18";
const FLAP_OPEN =
  "M6 14L7.5 11.1A2 2 0 0 1 9.24 10L10.5 10A2 2 0 0 1 10.5 10L10.5 10A2 2 0 0 0 10.5 10L20 10A2 2 0 0 1 21.94 12.5L20.4 18.5A2 2 0 0 1 18.45 20L4 20A2 2 0 0 1 2 18";

// Back-out curve: the flap overswings a touch before settling, per the
// app-wide jelly motion language.
const flapTransition = { duration: 0.3, ease: [0.3, 1.4, 0.4, 1] as const };

/** Morphs matching SVG path geometry while respecting reduced motion. */
export function AnimatedFolderIcon({ open, className }: { open: boolean; className?: string }) {
  const reduceMotion =
    Boolean(useReducedMotion()) ||
    (typeof document !== "undefined" && document.documentElement.dataset.motion === "none");
  const transition = reduceMotion ? { duration: 0 } : flapTransition;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* `initial` is what gets painted, and it has to be here: Motion owns the
          `d` attribute, so without it the browser parses the string
          "undefined" and the icon renders nothing at all.

          The key is what keeps the icon truthful. Motion in this version never
          writes `d` again after mount — `animate` updates are dropped, so a
          folder would keep the geometry it was born with while the project
          under it opened and closed. Remounting on the state flip paints the
          right shape every time; `animate` stays so the morph starts working
          the day Motion interpolates path data. */}
      <motion.path
        key={`back-${open}`}
        initial={{ d: open ? BACK_OPEN : BACK_CLOSED }}
        animate={{ d: open ? BACK_OPEN : BACK_CLOSED }}
        transition={transition}
      />
      <motion.path
        key={`flap-${open}`}
        initial={{ d: open ? FLAP_OPEN : FLAP_CLOSED }}
        animate={{ d: open ? FLAP_OPEN : FLAP_CLOSED }}
        transition={transition}
      />
    </svg>
  );
}
