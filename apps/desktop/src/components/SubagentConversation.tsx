import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { CircleStop, PanelRightClose, PanelRightOpen, TerminalSquare, X } from "lucide-react";
import {
  bridge,
  type DelegationRouting,
  type DelegationView,
  type GitSnapshot,
  type RuntimeConnection,
  type RuntimeProjectionEvent,
  type TranscriptEvent,
} from "../bridge";
import {
  applyRuntimeProjection,
  createRuntimeProjectionState,
  runtimeTranscript,
  type RuntimeProjectionState,
} from "../runtimeProjection";
import { Composer } from "./Composer";
import { ConversationHeader } from "./ConversationHeader";
import { TaskStatusPill } from "./TaskStatusPill";
import { formatCompactTokenCount } from "./conversationFormatting";
import { Dropdown } from "./Dropdown";

const Transcript = lazy(() =>
  import("./Transcript").then((module) => ({ default: module.Transcript })),
);
const DiffView = lazy(() => import("./DiffView").then((module) => ({ default: module.DiffView })));

interface SubagentConversationProps {
  delegation: DelegationView;
  runtimes: RuntimeConnection[];
  contextFiles?: string[];
  /** Requests the bounded project scan the first time an @-token is typed. */
  onRequestContextFiles?: () => void;
  enterToSend?: boolean;
  rightRailOpen?: boolean;
  terminalOpen?: boolean;
  onClose: () => void;
  onToggleRightRail?: () => void;
  onToggleTerminal?: () => void;
  onSend?: (delegationId: string, message: string, routing: DelegationRouting) => Promise<void>;
  onStop?: (delegationId: string) => Promise<void>;
  terminal?: ReactNode;
}

function activeStatus(status: DelegationView["status"]): boolean {
  return status === "starting" || status === "running" || status === "waiting";
}

function statusLabel(status: DelegationView["status"]): string {
  return status
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function SubagentConversation({
  delegation,
  runtimes,
  contextFiles,
  onRequestContextFiles,
  enterToSend,
  rightRailOpen = true,
  terminalOpen = false,
  onClose,
  onToggleRightRail,
  onToggleTerminal,
  onSend,
  onStop,
  terminal,
}: SubagentConversationProps) {
  const [projection, setProjection] = useState<RuntimeProjectionState | null>(null);
  const [loading, setLoading] = useState(Boolean(delegation.childTaskId));
  const [loadError, setLoadError] = useState("");
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState("");
  const [centerView, setCenterView] = useState<"task" | "review">("task");
  const [git, setGit] = useState<GitSnapshot | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [reviewRefreshVersion, setReviewRefreshVersion] = useState(0);
  const [reviewFilePath, setReviewFilePath] = useState("");
  const [diffView, setDiffView] = useState<"unified" | "split">("unified");
  const [reviewedFiles, setReviewedFiles] = useState<Record<string, boolean>>({});
  const [optimisticMessages, setOptimisticMessages] = useState<TranscriptEvent[]>([]);
  const [selectedRouting, setSelectedRouting] = useState<DelegationRouting>({
    runtime: delegation.runtime as DelegationRouting["runtime"],
    model: delegation.model || "",
    effort: delegation.effort ?? undefined,
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const childTaskId = delegation.childTaskId ?? undefined;

  useEffect(() => {
    if (!childTaskId) return;

    let disposed = false;
    let ready = false;
    let unlisten: (() => void) | undefined;
    const buffered: RuntimeProjectionEvent[] = [];
    void (async () => {
      try {
        unlisten = await bridge.subscribeRuntimeProjections((event) => {
          if (event.taskId !== childTaskId) return;
          if (!ready) {
            buffered.push(event);
            return;
          }
          setProjection((current) =>
            applyRuntimeProjection(current ?? createRuntimeProjectionState(childTaskId), event),
          );
        });
        if (disposed) {
          unlisten();
          return;
        }

        const snapshot = await bridge.loadTaskProjection(childTaskId);
        let next = createRuntimeProjectionState(childTaskId);
        for (const event of snapshot.events.sort((a, b) => a.seq - b.seq)) {
          next = applyRuntimeProjection(next, event);
        }
        for (const event of buffered
          .filter((candidate) => candidate.seq > snapshot.watermarkSeq)
          .sort((a, b) => a.seq - b.seq)) {
          next = applyRuntimeProjection(next, event);
        }
        if (!disposed) {
          ready = true;
          setProjection(next);
        }
      } catch (error) {
        if (!disposed) {
          setLoadError(error instanceof Error ? error.message : "Could not load this transcript");
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [childTaskId]);

  useEffect(() => {
    if (!childTaskId || centerView !== "review") return;
    let disposed = false;
    void Promise.resolve().then(() => {
      if (!disposed) setReviewLoading(true);
    });
    void bridge
      .loadTaskGit(childTaskId)
      .then((snapshot) => {
        if (disposed) return;
        setGit(snapshot);
        setReviewFilePath((current) =>
          snapshot.files.some((file) => file.path === current)
            ? current
            : (snapshot.files[0]?.path ?? ""),
        );
      })
      .catch((error) => {
        if (!disposed) {
          setReviewError(error instanceof Error ? error.message : "Could not load this review");
        }
      })
      .finally(() => {
        if (!disposed) setReviewLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [childTaskId, centerView, delegation.status, reviewRefreshVersion]);

  const projectedEvents = useMemo(
    () => (projection ? runtimeTranscript(projection) : []),
    [projection],
  );
  const visibleOptimisticMessages = optimisticMessages.filter(
    (optimistic) =>
      !projectedEvents.some(
        (event) =>
          event.kind === "user" &&
          event.body === optimistic.body &&
          Date.parse(event.timestamp) >= Date.parse(optimistic.timestamp) - 1_000,
      ),
  );
  const events = [...projectedEvents, ...visibleOptimisticMessages].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
  const turnRunning = projection?.turn?.status === "inProgress" && activeStatus(delegation.status);
  const canMessage = Boolean(
    onSend &&
    childTaskId &&
    delegation.status !== "pending-approval" &&
    delegation.status !== "denied" &&
    delegation.status !== "starting",
  );
  const supportedRuntimes = runtimes.filter((runtime) =>
    ["codex", "claude", "antigravity", "cursor", "grok"].includes(runtime.id),
  );
  const reviewFile = git?.files.find((file) => file.path === reviewFilePath) ?? git?.files[0];
  const totalTokens = projection?.usage?.totalTokens ?? 0;

  useEffect(() => {
    if (
      centerView !== "review" ||
      !childTaskId ||
      reviewLoading ||
      !reviewFile ||
      reviewFile.diffLoaded !== false
    ) {
      return;
    }
    let disposed = false;
    void bridge
      .loadTaskGitFile(childTaskId, reviewFile)
      .then((loaded) => {
        if (disposed) return;
        setReviewError("");
        setGit((current) =>
          current
            ? {
                ...current,
                files: current.files.map((candidate) =>
                  candidate.path === loaded.path ? loaded : candidate,
                ),
              }
            : current,
        );
      })
      .catch((error) => {
        if (!disposed) {
          setReviewError(error instanceof Error ? error.message : "Could not load this diff");
        }
      });
    return () => {
      disposed = true;
    };
  }, [centerView, childTaskId, reviewFile, reviewLoading]);

  const refreshReview = () => {
    setReviewError("");
    setReviewLoading(true);
    setReviewRefreshVersion((current) => current + 1);
  };

  const send = async (input: {
    prompt: string;
    runtime: DelegationRouting["runtime"];
    model: string;
    effort?: string;
  }): Promise<boolean> => {
    if (!onSend || !canMessage) return false;
    const message = input.prompt.trim();
    const routing = { runtime: input.runtime, model: input.model, effort: input.effort };
    const optimistic: TranscriptEvent = {
      id: `delegation-message-${delegation.id}-${Date.now()}`,
      kind: "user",
      body: message,
      timestamp: new Date().toISOString(),
      status: "neutral",
      meta: turnRunning
        ? "Queued until the subagent is idle"
        : activeStatus(delegation.status)
          ? "Sending"
          : "Reopening subagent",
    };
    setActionError("");
    setSelectedRouting(routing);
    setOptimisticMessages((current) => [...current, optimistic]);
    try {
      await onSend(delegation.id, message, routing);
      return true;
    } catch (error) {
      setOptimisticMessages((current) => current.filter((event) => event.id !== optimistic.id));
      setActionError(error instanceof Error ? error.message : "Could not message this subagent");
      return false;
    }
  };

  const stop = async () => {
    if (!onStop || stopping) return;
    setStopping(true);
    setActionError("");
    try {
      await onStop(delegation.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not stop this subagent");
    } finally {
      setStopping(false);
    }
  };

  return (
    <section className="subagent-conversation" aria-label={`${delegation.title} transcript`}>
      <ConversationHeader
        title={delegation.title}
        detail={
          <>
            {delegation.profileLabel} · {selectedRouting.model || selectedRouting.runtime} ·{" "}
            {statusLabel(delegation.status)}
          </>
        }
        leading={
          <span
            className={`agent-avatar agent-avatar--${selectedRouting.runtime}`}
            aria-hidden="true"
          >
            {delegation.profileLabel.slice(0, 1)}
          </span>
        }
        view={centerView}
        viewLabel="Subagent view"
        reviewCount={git?.files.length}
        onViewChange={(view) => {
          setCenterView(view);
          if (view === "review") {
            setReviewError("");
            setReviewLoading(true);
          }
        }}
        actions={
          <>
            <span
              className="usage-compact conversation-token-count"
              aria-label={`${totalTokens.toLocaleString()} tokens`}
              title={`${totalTokens.toLocaleString()} tokens used by this subagent`}
            >
              {formatCompactTokenCount(totalTokens)}
            </span>
            {activeStatus(delegation.status) && onStop ? (
              <button
                className="stop-turn-button subagent-stop-button"
                type="button"
                onClick={() => void stop()}
                disabled={stopping}
                aria-label={stopping ? "Stopping subagent" : "Stop subagent"}
              >
                <CircleStop aria-hidden="true" />
                <span>{stopping ? "Stopping…" : "Stop"}</span>
              </button>
            ) : null}
            {onToggleTerminal ? (
              <button
                className="icon-button subtle"
                type="button"
                onClick={onToggleTerminal}
                aria-label="Toggle terminal"
                aria-pressed={terminalOpen}
              >
                <TerminalSquare aria-hidden="true" />
              </button>
            ) : null}
            {onToggleRightRail ? (
              <button
                className="icon-button subtle"
                type="button"
                onClick={onToggleRightRail}
                aria-label={rightRailOpen ? "Close task tools" : "Open task tools"}
                aria-pressed={rightRailOpen}
              >
                {rightRailOpen ? (
                  <PanelRightClose aria-hidden="true" />
                ) : (
                  <PanelRightOpen aria-hidden="true" />
                )}
              </button>
            ) : null}
            <button
              className="icon-button subtle"
              type="button"
              onClick={onClose}
              aria-label="Close subagent transcript"
            >
              <X aria-hidden="true" />
            </button>
          </>
        }
      />
      {centerView === "task" ? (
        <>
          <div className="transcript-scroll subagent-transcript-scroll" ref={scrollRef}>
            {!childTaskId ? (
              <div className="subagent-conversation-empty">
                This subagent has not started a task yet. Approve it to create its transcript.
              </div>
            ) : loading ? (
              <div className="subagent-conversation-empty" role="status">
                Loading subagent transcript…
              </div>
            ) : loadError ? (
              <div className="subagent-conversation-empty" role="alert">
                {loadError}
              </div>
            ) : events.length > 0 ? (
              <Suspense
                fallback={<div className="subagent-conversation-empty">Rendering transcript…</div>}
              >
                <Transcript
                  events={events}
                  running={turnRunning}
                  scrollContainerRef={scrollRef}
                  modelForEvent={() => selectedRouting.model || delegation.profileLabel}
                />
              </Suspense>
            ) : (
              <div className="subagent-conversation-empty">No transcript events yet.</div>
            )}
          </div>
          <AnimatePresence initial={false}>
            {turnRunning ? (
              <TaskStatusPill
                key="subagent-status-pill"
                runningSince={projection?.turn?.startedAt}
                usage={projection?.usage}
              />
            ) : null}
          </AnimatePresence>
          {canMessage ? (
            <div className="subagent-composer-wrap">
              {actionError ? (
                <div className="subagent-composer-error" role="alert">
                  {actionError}
                </div>
              ) : null}
              <Composer
                key={delegation.id}
                runtimes={supportedRuntimes}
                defaultRuntime={selectedRouting.runtime}
                defaultModel={selectedRouting.model}
                defaultEffort={selectedRouting.effort}
                defaultPermission="project-write"
                defaultDelegation="off"
                enterToSend={enterToSend}
                contextFiles={contextFiles}
                onRequestContextFiles={onRequestContextFiles}
                running={turnRunning}
                stopping={stopping}
                onStop={() => void stop()}
                routingDisabled={turnRunning}
                permissionDisabled
                delegationDisabled
                sessionModes={projection?.mode}
                onSessionModeChange={
                  childTaskId
                    ? (modeId) => {
                        void bridge.setSessionMode(childTaskId, modeId).catch((error) => {
                          setActionError(
                            error instanceof Error
                              ? error.message
                              : "Could not switch the subagent mode",
                          );
                        });
                      }
                    : undefined
                }
                messageLabel={`Message ${delegation.title}`}
                sendLabel={`Send message to ${delegation.title}`}
                onRoutingChange={setSelectedRouting}
                onSend={send}
              />
            </div>
          ) : (
            <div className="subagent-conversation-unavailable">
              {delegation.status === "pending-approval"
                ? "Approve this subagent before messaging it."
                : delegation.status === "denied"
                  ? "This delegation was denied."
                  : "This subagent is still starting."}
              {actionError ? <span role="alert">{actionError}</span> : null}
            </div>
          )}
        </>
      ) : (
        <div className="subagent-review-workspace">
          {reviewLoading ? (
            <div className="subagent-conversation-empty" role="status">
              Loading subagent review…
            </div>
          ) : reviewError ? (
            <div className="subagent-conversation-empty" role="alert">
              <span>{reviewError}</span>
              <button className="secondary-button" type="button" onClick={refreshReview}>
                Retry
              </button>
            </div>
          ) : reviewFile ? (
            <>
              {git && git.files.length > 1 ? (
                <div className="subagent-review-toolbar">
                  <Dropdown
                    aria-label="Subagent review file"
                    value={reviewFile.path}
                    onChange={setReviewFilePath}
                    options={git.files.map((file) => ({ value: file.path, label: file.path }))}
                    compact
                  />
                </div>
              ) : null}
              <Suspense
                fallback={<div className="subagent-conversation-empty">Rendering review…</div>}
              >
                <DiffView
                  file={reviewFile}
                  viewMode={diffView}
                  onViewModeChange={setDiffView}
                  onRefresh={refreshReview}
                  refreshing={reviewLoading}
                  reviewed={Boolean(reviewedFiles[reviewFile.path])}
                  onMarkReviewed={() =>
                    setReviewedFiles((current) => ({ ...current, [reviewFile.path]: true }))
                  }
                />
              </Suspense>
            </>
          ) : (
            <div className="subagent-conversation-empty">No subagent changes to review.</div>
          )}
        </div>
      )}
      {terminal}
    </section>
  );
}
