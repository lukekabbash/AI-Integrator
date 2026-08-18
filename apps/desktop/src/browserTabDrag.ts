/** The pure half of dragging a browser tab: where the pointer is, what phase
 *  the gesture is in, and what should happen when it lets go.
 *
 *  No React and no bridge in here — the hook (`useTabDrag`) owns the DOM, the
 *  native hit test and the callbacks, and this module owns the rules. Every
 *  function is total and returns a fresh value, so a test can hand it a state
 *  literal and read the answer straight back.
 *
 *  Coordinates are client px (the origin window's viewport) throughout, which
 *  is what the strip rects are measured in. The one exception is the tear-off
 *  point handed to the native side: `drop` reports the pointer it was given,
 *  and the hook substitutes the logical *screen* position it tracked alongside.
 */

/** Which strip the drag started in. A popout knows its own window label. */
export type DragOrigin = { kind: "popout"; label: string } | { kind: "pane" };

/** The press that started it all. */
export interface DragStart {
  tabId: string;
  taskId: string;
  groupId: string;
  origin: DragOrigin;
  /** The tab's index in the origin strip when the press landed. */
  index: number;
  /** Client px. */
  x: number;
  y: number;
}

/** `armed` — pressed but under the threshold, so a click is still a click.
 *  `dragging` — moving inside the origin strip, reordering.
 *  `torn` — pulled off the strip; the drop now depends on what's underneath. */
export type DragPhase = "armed" | "dragging" | "torn";

/** What the native hit test found under the pointer. `null` is empty desktop. */
export type HitTarget = { kind: "popout"; label: string; strip: boolean } | { kind: "main" } | null;

export interface DragState {
  start: DragStart;
  phase: DragPhase;
  pointer: { x: number; y: number };
  /** Where the tab would land in the origin strip, clamped to its group. Only
   *  set while `dragging`. */
  hoverIndex: number | null;
  target: HitTarget;
}

/** A tab's box in the origin strip, in client px. `DOMRect` satisfies it. */
export interface StripRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface MoveOptions {
  /** Travel before a press becomes a drag. Default `DRAG_THRESHOLD`. */
  threshold?: number;
  /** Vertical travel off the strip before the tab tears off. Default
   *  `TEAR_OFF_DISTANCE`. */
  tearOff?: number;
  /** The origin strip's tabs, in strip order. */
  stripRects: readonly StripRect[];
  /** The inclusive index range of the dragged tab's own group in
   *  `stripRects`. A tab cannot be reordered out of its group. */
  groupSpan: [number, number];
  /** The origin window's viewport. Leaving it drags the tab out too. */
  originClient?: { width: number; height: number };
}

export type DropAction =
  | { kind: "reorder"; index: number }
  | { kind: "move"; label: string; index?: number }
  | { kind: "dock" }
  | { kind: "tearOff"; at: { x: number; y: number } }
  | { kind: "none" };

export const DRAG_THRESHOLD = 5;
export const TEAR_OFF_DISTANCE = 40;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** The strip's vertical middle, from the union of its tab boxes. An empty
 *  strip falls back to where the press landed, so nothing tears off by
 *  accident before there is anything to measure. */
function stripCentre(rects: readonly StripRect[], fallback: number): number {
  if (rects.length === 0) return fallback;
  let top = Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
  }
  return (top + bottom) / 2;
}

/** The index the tab would take after being lifted out and put back: count the
 *  midpoints it has passed, ignoring its own box so resting in place reads as
 *  "no change". Clamped into the group's span. */
function hoverIndexFor(
  x: number,
  rects: readonly StripRect[],
  groupSpan: [number, number],
  dragged: number,
): number | null {
  if (rects.length === 0) return null;
  let index = 0;
  for (let position = 0; position < rects.length; position += 1) {
    if (position === dragged) continue;
    const rect = rects[position];
    if (x >= (rect.left + rect.right) / 2) index += 1;
  }
  const last = rects.length - 1;
  const low = clamp(Math.min(groupSpan[0], groupSpan[1]), 0, last);
  const high = clamp(Math.max(groupSpan[0], groupSpan[1]), low, last);
  return clamp(index, low, high);
}

/** A press, not yet a drag. */
export function arm(start: DragStart): DragState {
  return {
    start,
    phase: "armed",
    pointer: { x: start.x, y: start.y },
    hoverIndex: null,
    target: null,
  };
}

/** The pointer moved. Promotes the phase, and while in-strip works out where
 *  the tab would land. Coming back into the strip drops any hit-test target,
 *  because the pointer is over the origin window again. */
export function move(state: DragState, x: number, y: number, options: MoveOptions): DragState {
  const threshold = options.threshold ?? DRAG_THRESHOLD;
  const tearOff = options.tearOff ?? TEAR_OFF_DISTANCE;
  const pointer = { x, y };
  const started =
    state.phase !== "armed" || Math.hypot(x - state.start.x, y - state.start.y) >= threshold;
  if (!started) return { ...state, pointer };

  const client = options.originClient;
  const outside = client ? x < 0 || y < 0 || x > client.width || y > client.height : false;
  const centre = stripCentre(options.stripRects, state.start.y);
  if (outside || Math.abs(y - centre) >= tearOff) {
    return { ...state, phase: "torn", pointer, hoverIndex: null };
  }
  return {
    start: state.start,
    phase: "dragging",
    pointer,
    hoverIndex: hoverIndexFor(x, options.stripRects, options.groupSpan, state.start.index),
    target: null,
  };
}

/** The native hit test answered. Replaces whatever was under the pointer. */
export function target(state: DragState, hit: HitTarget): DragState {
  return { ...state, target: hit };
}

/** What letting go here means. */
export function drop(state: DragState): DropAction {
  if (state.phase === "armed") return { kind: "none" };
  if (state.phase === "dragging") {
    const index = state.hoverIndex;
    if (index === null || index === state.start.index) return { kind: "none" };
    return { kind: "reorder", index };
  }
  const hit = state.target;
  if (hit === null) return { kind: "tearOff", at: { ...state.pointer } };
  if (hit.kind === "main") return { kind: "dock" };
  // Over a popout's strip the tab slots in where the pointer is, when the
  // strip told us an index; anywhere else in that window it appends.
  return hit.strip && state.hoverIndex !== null
    ? { kind: "move", label: hit.label, index: state.hoverIndex }
    : { kind: "move", label: hit.label };
}

/** Escape, a lost pointer, a closing window: the gesture leaves no mark. */
export function cancel(state: DragState): DropAction {
  void state;
  return { kind: "none" };
}
