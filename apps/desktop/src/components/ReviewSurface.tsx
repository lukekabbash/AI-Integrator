import { FileDiff } from "lucide-react";
import { lazy, Suspense } from "react";

import { diffFileKey, type DiffFile } from "../bridge";
import type { DiffViewProps } from "./DiffView";

const DiffView = lazy(() => import("./DiffView").then((module) => ({ default: module.DiffView })));

export interface ReviewSurfaceProps {
  file: DiffFile | null | undefined;
  viewMode: DiffViewProps["viewMode"];
  onViewModeChange: (mode: NonNullable<DiffViewProps["viewMode"]>) => void;
  onRefresh: () => void;
  refreshing: boolean;
  reviewedKeys: Record<string, boolean>;
  taskId: string | undefined;
  onMarkReviewed: (file: DiffFile) => void;
  onAddSelection: NonNullable<DiffViewProps["onAddSelection"]>;
  loadError: { fileKey: string; message: string } | null;
  onRetry: () => void;
  onBack: () => void;
}

/** The Review tab of the work pane: one unified diff, or an honest empty/error state. */
export function ReviewSurface({
  file,
  viewMode,
  onViewModeChange,
  onRefresh,
  refreshing,
  reviewedKeys,
  taskId,
  onMarkReviewed,
  onAddSelection,
  loadError,
  onRetry,
  onBack,
}: ReviewSurfaceProps) {
  if (refreshing && !file) {
    return (
      <div className="route-loading" role="status" aria-live="polite">
        Checking this worktree for changes…
      </div>
    );
  }
  if (file && loadError?.fileKey === diffFileKey(file)) {
    return <ReviewLoadErrorState message={loadError.message} onRetry={onRetry} />;
  }
  if (!file) {
    return <ReviewEmptyState onBack={onBack} onRefresh={onRefresh} refreshing={refreshing} />;
  }
  const reviewed = Boolean(taskId && reviewedKeys[`${taskId}:${diffFileKey(file)}`]);
  return (
    <Suspense
      fallback={
        <div className="route-loading" role="status" aria-live="polite">
          Loading review…
        </div>
      }
    >
      <DiffView
        file={file}
        viewMode={viewMode}
        onViewModeChange={onViewModeChange}
        onRefresh={onRefresh}
        refreshing={refreshing}
        reviewed={reviewed}
        onMarkReviewed={() => onMarkReviewed(file)}
        onAddSelection={onAddSelection}
      />
    </Suspense>
  );
}

export function ReviewEmptyState({
  onBack,
  onRefresh,
  refreshing = false,
}: {
  onBack: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return (
    <section className="review-empty" aria-label="Review changes">
      <div className="review-empty-icon">
        <FileDiff />
      </div>
      <h2>No changes to review</h2>
      <p>When the agent or you change this worktree, the unified review will appear here.</p>
      <div className="review-empty-actions">
        {onRefresh ? (
          <button
            className="secondary-button"
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? "Checking…" : "Check again"}
          </button>
        ) : null}
        <button className="secondary-button" type="button" onClick={onBack}>
          Back to task
        </button>
      </div>
    </section>
  );
}

export function ReviewLoadErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <section className="review-empty" aria-label="Review unavailable">
      <div className="review-empty-icon">
        <FileDiff />
      </div>
      <h2>Could not load this diff</h2>
      <p role="alert">{message}</p>
      <button className="secondary-button" type="button" onClick={onRetry}>
        Retry
      </button>
    </section>
  );
}
