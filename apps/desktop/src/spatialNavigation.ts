/**
 * Arrow-key navigation for rails, trees, and strips.
 *
 * The model is a cockpit multi-function display rather than the browser's tab
 * order: the app is a small number of named *regions*, each holding a list of
 * *cells*. A shortcut slews to a region, arrows move the cursor inside it in
 * the direction you press, and activation is whatever the focused control
 * already does. Focus is never lost — entering a region lands on its active
 * cell, and every region can be left the way it was entered.
 *
 * Two attributes carry the whole contract, so lists stay declarative:
 *   `data-nav-region="<name>"`  marks a container that can be slewed to.
 *   `data-nav-item`             marks a focusable cell inside one.
 * A cell may add `data-nav-expanded="true|false"` to accept Right/Left as
 * expand/collapse, and `data-nav-parent="<id>"` plus `data-nav-id="<id>"` so
 * Left on a child jumps to the row that owns it.
 *
 * Arrows inside a region are deliberately NOT user-rebindable: they are the
 * structure of the widget, the way Tab is, and rebinding them would break the
 * same expectations screen readers rely on. What the user can change is
 * whether arrow navigation is on at all, whether it wraps at the ends, and
 * which shortcut slews to each region — those live in the keybinding registry.
 */

/** Settings keys for the two knobs the user gets over arrow navigation. */
export const ARROW_NAVIGATION_SETTING = "keyboard.arrowNavigation";
export const WRAP_NAVIGATION_SETTING = "keyboard.wrapNavigation";

export type NavOrientation = "vertical" | "horizontal";

export type NavIntent = "next" | "previous" | "first" | "last" | "expand" | "collapse";

export const NAV_REGIONS = ["sidebar", "transcript", "workPane", "rightRail"] as const;

export type NavRegion = (typeof NAV_REGIONS)[number];

/**
 * Maps a key to an intent for the given axis. The cross-axis keys still return
 * expand/collapse so a vertical tree can use Left/Right for depth, which is
 * the one place a rail behaves like a tree rather than a list.
 */
export function arrowIntent(key: string, orientation: NavOrientation): NavIntent | null {
  const vertical = orientation === "vertical";
  switch (key) {
    case "ArrowDown":
      return vertical ? "next" : null;
    case "ArrowUp":
      return vertical ? "previous" : null;
    case "ArrowRight":
      return vertical ? "expand" : "next";
    case "ArrowLeft":
      return vertical ? "collapse" : "previous";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return null;
  }
}

/**
 * Where the cursor lands. Returns -1 when the move is impossible — at an end
 * with wrapping off, or in an empty region — so the caller can leave the key
 * to whatever would have handled it.
 */
export function stepIndex(
  current: number,
  count: number,
  intent: NavIntent,
  wrap: boolean,
): number {
  if (count === 0) return -1;
  switch (intent) {
    case "first":
      return 0;
    case "last":
      return count - 1;
    case "next":
    case "previous": {
      const step = intent === "next" ? 1 : -1;
      // No cursor yet: enter from the edge the key points away from.
      if (current < 0) return step > 0 ? 0 : count - 1;
      const next = current + step;
      if (next >= 0 && next < count) return next;
      return wrap ? (next + count) % count : -1;
    }
    default:
      return -1;
  }
}

/**
 * Type-ahead: the next cell after `current` whose label starts with `query`,
 * searching forward and wrapping once. Returns -1 when nothing matches.
 */
export function typeaheadIndex(labels: readonly string[], current: number, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return -1;
  for (let offset = 1; offset <= labels.length; offset += 1) {
    const index = (Math.max(current, 0) + offset) % labels.length;
    if (labels[index]?.trim().toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

/** True for a printable single character worth feeding to type-ahead. */
export function isTypeaheadKey(key: string, hasModifier: boolean): boolean {
  return !hasModifier && key.length === 1 && key !== " " && /\S/.test(key);
}

/**
 * A cell's expanded state, or `null` when it is a leaf. Read from the DOM so a
 * list does not have to thread its tree state through the navigation layer.
 */
export function expandedState(cell: Element | null): boolean | null {
  if (!(cell instanceof HTMLElement)) return null;
  const raw = cell.dataset.navExpanded ?? cell.getAttribute("aria-expanded");
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

/**
 * Whether a cell can hold the cursor. A group that folds shut keeps its rows
 * in the DOM inside a track collapsed to zero height, so a rail that only
 * asked the DOM for `[data-nav-item]` would move focus onto rows nobody can
 * see. The rows themselves keep their own height inside that track, which is
 * why the test walks ancestors rather than measuring the cell.
 *
 * Opacity is deliberately not consulted. It is what the fold animates, and a
 * row half way through a transition — or stalled there because the window is
 * not compositing — is still a row the user means to reach.
 *
 * `collapsed` caches ancestors across one sweep: a rail of fifty rows shares
 * only a handful of them, so this stays one layout pass rather than fifty.
 */
function isNavigable(
  cell: HTMLElement,
  collapsed: Map<HTMLElement, boolean>,
  measurable: boolean,
): boolean {
  if (cell.getAttribute("aria-hidden") === "true") return false;
  if (cell.closest("[inert]")) return false;
  if (
    typeof cell.checkVisibility === "function" &&
    !cell.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })
  ) {
    return false;
  }
  if (!measurable) return true;
  const chain: HTMLElement[] = [];
  for (let node = cell.parentElement; node; node = node.parentElement) {
    const cached = collapsed.get(node);
    if (cached !== undefined) {
      for (const seen of chain) collapsed.set(seen, cached);
      return !cached;
    }
    if (node.dataset.navRegion !== undefined) break;
    chain.push(node);
    const rect = node.getBoundingClientRect();
    if (rect.height === 0 || rect.width === 0) {
      for (const seen of chain) collapsed.set(seen, true);
      return false;
    }
  }
  for (const seen of chain) collapsed.set(seen, false);
  return true;
}

/** Reachable cells of a container, in document order. */
export function navCells(container: ParentNode | null): HTMLElement[] {
  const collapsed = new Map<HTMLElement, boolean>();
  // Without a layout engine there is nothing for the fold test to measure and
  // every ancestor reads as zero, so it is skipped rather than hiding the rail.
  const box = container instanceof HTMLElement ? container.getBoundingClientRect() : null;
  const measurable = Boolean(box && box.height > 0 && box.width > 0);
  return Array.from(container?.querySelectorAll<HTMLElement>("[data-nav-item]") ?? []).filter(
    (cell) => isNavigable(cell, collapsed, measurable),
  );
}

/** Index of the cell that owns `element`, or -1 when focus is outside them. */
export function cellIndexOf(cells: readonly HTMLElement[], element: Element | null): number {
  if (!element) return -1;
  return cells.findIndex((cell) => cell === element || cell.contains(element));
}

/**
 * The cell Left should jump to from `index`: the row named by the child's
 * `data-nav-parent`. Returns -1 when the cell has no parent in this region.
 */
export function parentIndex(cells: readonly HTMLElement[], index: number): number {
  const parent = cells[index]?.dataset.navParent;
  if (!parent) return -1;
  return cells.findIndex((cell) => cell.dataset.navId === parent);
}

/** The cell a region should land on when it is slewed to. */
export function entryCell(container: ParentNode | null): HTMLElement | null {
  const cells = navCells(container);
  return cells.find((cell) => cell.dataset.navActive === "true") ?? cells[0] ?? null;
}

/**
 * Slews to a region: focuses its active cell, or the container itself when it
 * has no cells (an empty rail still takes focus so the next arrow works).
 * Returns false when the region is not on screen, letting a shortcut decline.
 */
export function focusRegion(region: NavRegion, root: ParentNode = document): boolean {
  const container = root.querySelector<HTMLElement>(`[data-nav-region="${region}"]`);
  if (!container) return false;
  const cell = entryCell(container);
  if (cell) {
    cell.focus();
    cell.scrollIntoView({ block: "nearest" });
    return true;
  }
  const focusable = container.querySelector<HTMLElement>(
    "textarea, input, button, [tabindex]:not([tabindex='-1'])",
  );
  (focusable ?? container).focus();
  return true;
}
