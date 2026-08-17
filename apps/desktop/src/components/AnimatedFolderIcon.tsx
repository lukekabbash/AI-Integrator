/** Folder icon that opens and shuts with the project it labels.
 *
 * The geometry matches lucide's Folder / FolderOpen at rest, split into two
 * sub-paths: the back pocket (left wall + tab) and the front flap. Each pair
 * of `d` variants keeps an identical command structure — segments that only
 * exist in one state collapse to a point in the other — so the two can be
 * interpolated the day something here knows how to do it.
 *
 * That day is not today, and the icon does not pretend otherwise. Motion does
 * not interpolate path data, and routing `d` through it cost more than the
 * animation it never delivered: on the first paint Motion had no value yet and
 * wrote the string "undefined" into the attribute, so every folder mounted
 * blank for a frame and logged an SVG parse error. React owns `d` now. */

const BACK_CLOSED =
  "M2 18L2 5A2 2 0 0 1 4 3L7.93 3A2 2 0 0 1 9.62 3.9L10.43 5.1A2 2 0 0 0 12.1 6L18 6A2 2 0 0 1 18 6L18 6";
const BACK_OPEN =
  "M2 18L2 5A2 2 0 0 1 4 3L7.93 3A2 2 0 0 1 9.62 3.9L10.43 5.1A2 2 0 0 0 12.1 6L18 6A2 2 0 0 1 20 8L20 10";

const FLAP_CLOSED =
  "M2 16L2 5A2 2 0 0 1 4 3L7.93 3A2 2 0 0 1 9.62 3.9L10.43 5.1A2 2 0 0 0 12.1 6L20 6A2 2 0 0 1 22 8L22 18A2 2 0 0 1 20 20L4 20A2 2 0 0 1 2 18";
const FLAP_OPEN =
  "M6 14L7.5 11.1A2 2 0 0 1 9.24 10L10.5 10A2 2 0 0 1 10.5 10L10.5 10A2 2 0 0 0 10.5 10L20 10A2 2 0 0 1 21.94 12.5L20.4 18.5A2 2 0 0 1 18.45 20L4 20A2 2 0 0 1 2 18";

export function AnimatedFolderIcon({ open, className }: { open: boolean; className?: string }) {
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
      <path d={open ? BACK_OPEN : BACK_CLOSED} />
      <path d={open ? FLAP_OPEN : FLAP_CLOSED} />
    </svg>
  );
}
