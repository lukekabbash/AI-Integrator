import type { ReactNode } from "react";

export type ConversationView = "task" | "review";

interface ConversationHeaderProps {
  title: string;
  detail: ReactNode;
  titleLevel?: 1 | 2;
  leading: ReactNode;
  view: ConversationView;
  viewLabel: string;
  reviewCount?: number;
  onViewChange: (view: ConversationView) => void;
  actions: ReactNode;
}

/**
 * The lead task and every opened subagent use the same conversation chrome.
 * Keeping the view switcher and action slots here prevents the two panes from
 * drifting into different header heights, typography, or control placement.
 */
export function ConversationHeader({
  title,
  detail,
  titleLevel = 2,
  leading,
  view,
  viewLabel,
  reviewCount = 0,
  onViewChange,
  actions,
}: ConversationHeaderProps) {
  const titleNode = titleLevel === 1 ? <h1>{title}</h1> : <h2>{title}</h2>;

  return (
    <header className="conversation-header">
      <div className="conversation-header-title">
        {leading}
        <div className="conversation-header-copy">
          {titleNode}
          <span>{detail}</span>
        </div>
      </div>
      <div className="conversation-view-tabs" role="tablist" aria-label={viewLabel}>
        <button
          type="button"
          role="tab"
          aria-selected={view === "task"}
          data-active={view === "task"}
          onClick={() => onViewChange("task")}
        >
          Task
        </button>
        <button
          type="button"
          role="tab"
          aria-label="Review"
          aria-selected={view === "review"}
          data-active={view === "review"}
          onClick={() => onViewChange("review")}
        >
          Review{reviewCount ? ` ${reviewCount}` : ""}
        </button>
      </div>
      <div className="conversation-header-actions">{actions}</div>
    </header>
  );
}
