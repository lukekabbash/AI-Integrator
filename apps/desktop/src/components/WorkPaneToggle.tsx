/**
 * The work-pane toggle sits in the titlebar, which renders before the pane's
 * lazy chunk loads, so it ships separately from the pane itself.
 */
import "./workPane.css";

/** What the empty pane offers to open. */
export type WorkPaneLaunchKind = "browser" | "files" | "review" | "subagents";

/* -------------------------------------------------------------------------- */
/* Titlebar toggle                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The work-pane toggle: a square with a divider whose right half fills when
 * open. One geometry, one animated fill — a morph, not a swap. A bead marks
 * surfaces alive behind a closed pane.
 */
export function WorkPaneToggle({
  open,
  alive,
  attention,
  onClick,
}: {
  open: boolean;
  alive: boolean;
  attention?: boolean;
  onClick: () => void;
}) {
  const label = open ? "Close work pane" : "Open work pane";
  return (
    <button
      className="icon-button subtle work-pane-toggle"
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={open}
      data-alive={!open && alive ? "true" : undefined}
      data-attention={!open && attention ? "true" : undefined}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <rect
          className="work-pane-toggle-fill"
          x="13"
          y="4"
          width="7"
          height="16"
          rx="1"
          style={{ opacity: open ? 1 : 0 }}
        />
        <rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" />
        <line x1="13" y1="4" x2="13" y2="20" />
      </svg>
      <i className="work-pane-toggle-bead" aria-hidden="true" />
    </button>
  );
}
