import { useCallback, useRef, type KeyboardEvent, type RefObject } from "react";
import {
  type NavOrientation,
  arrowIntent,
  cellIndexOf,
  expandedState,
  isTypeaheadKey,
  navCells,
  parentIndex,
  stepIndex,
  typeaheadIndex,
} from "./spatialNavigation";

const TYPEAHEAD_WINDOW_MS = 700;

export interface RailCursorOptions {
  /** Off returns a no-op handler, so the setting can disable this outright. */
  enabled?: boolean;
  /** Stop at the ends instead of wrapping around. */
  wrap?: boolean;
  orientation?: NavOrientation;
  /** Called for Right on an expandable cell that is currently collapsed. */
  onExpand?: (cell: HTMLElement) => void;
  /** Called for Left on an expandable cell that is currently expanded. */
  onCollapse?: (cell: HTMLElement) => void;
  /** Off skips first-letter jumping, e.g. where a field owns typing. */
  typeahead?: boolean;
}

/**
 * Wires arrow navigation onto a container of `[data-nav-item]` cells. See
 * `spatialNavigation.ts` for the attribute contract and why arrows are not
 * user-rebindable.
 *
 * The handler only claims a key when it actually moves the cursor, so a rail
 * that has run out of rows still lets the page scroll.
 */
export function useRailCursor(
  containerRef: RefObject<HTMLElement | null>,
  options: RailCursorOptions = {},
): (event: KeyboardEvent<HTMLElement>) => void {
  const {
    enabled = true,
    wrap = true,
    orientation = "vertical",
    onExpand,
    onCollapse,
    typeahead = true,
  } = options;
  const typeaheadRef = useRef({ query: "", at: 0 });

  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!enabled || event.defaultPrevented) return;
      const container = containerRef.current;
      if (!container) return;
      const cells = navCells(container);
      if (cells.length === 0) return;
      const current = cellIndexOf(cells, document.activeElement);

      const move = (index: number) => {
        const cell = cells[index];
        if (!cell) return;
        event.preventDefault();
        cell.focus();
        cell.scrollIntoView({ block: "nearest" });
      };

      const intent = arrowIntent(event.key, orientation);
      if (intent) {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (intent === "expand" || intent === "collapse") {
          const cell = cells[current];
          if (!cell) return;
          const expanded = expandedState(cell);
          if (intent === "expand" && expanded === false) {
            event.preventDefault();
            onExpand?.(cell);
            return;
          }
          if (intent === "collapse" && expanded === true) {
            event.preventDefault();
            onCollapse?.(cell);
            return;
          }
          // A leaf, or a group already in that state: Left climbs to the row
          // that owns this one, which is how you get out of a project.
          if (intent === "collapse") {
            const parent = parentIndex(cells, current);
            if (parent >= 0) move(parent);
          }
          return;
        }
        const next = stepIndex(current, cells.length, intent, wrap);
        if (next >= 0) move(next);
        return;
      }

      if (!typeahead) return;
      if (!isTypeaheadKey(event.key, event.altKey || event.ctrlKey || event.metaKey)) return;
      const now = event.timeStamp || Date.now();
      const buffer = typeaheadRef.current;
      const query =
        now - buffer.at < TYPEAHEAD_WINDOW_MS ? `${buffer.query}${event.key}` : event.key;
      typeaheadRef.current = { query, at: now };
      const labels = cells.map((cell) => cell.dataset.navLabel ?? cell.textContent ?? "");
      // Repeating one letter cycles through the rows that start with it; a run
      // of different letters refines the prefix without leaving the match.
      const cycling = query.length > 1 && [...query].every((letter) => letter === query[0]);
      const needle = cycling ? (query[0] ?? "") : query;
      const match = typeaheadIndex(
        labels,
        cycling || query.length === 1 ? current : current - 1,
        needle,
      );
      if (match >= 0) move(match);
    },
    [containerRef, enabled, onCollapse, onExpand, orientation, typeahead, wrap],
  );
}
