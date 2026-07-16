import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { createPortal } from "react-dom";
import { PanelRightClose, PanelRightOpen, TerminalSquare, X } from "lucide-react";
import {
  bridge,
  diffFileKey,
  type DelegationRouting,
  type DelegationView,
  type GitSnapshot,
  type RuntimeConnection,
  type RuntimeProjectionEvent,
  type TranscriptEvent,
} from "../bridge";
import {
  applyRuntimeProjectionBatch,
  createRuntimeProjectionState,
  createRuntimeTranscriptDeriver,
  hydrateRuntimeProjectionState,
  isFrameBatchableRuntimeProjection,
  type RuntimeProjectionState,
} from "../runtimeProjection";
import { Composer } from "./Composer";
import { SlidingTabIndicator } from "./SlidingTabIndicator";
import { TaskStatusPill } from "./TaskStatusPill";
import { formatCompactTokenCount } from "./conversationFormatting";
import { Dropdown } from "./Dropdown";

const Transcript = lazy(() =>
  import("./Transcript").then((module) => ({ default: module.Transcript })),
);
const DiffView = lazy(() => import("./DiffView").then((module) => ({ default: module.DiffView })));

interface SubagentConversationProps {
  delegation: DelegationView;
  headerTarget?: HTMLElement | null;
  runtimes: RuntimeConnection[];
  contextFiles?: string[];
  /** Requests the bounded project scan the first time an @-token is typed. */
  onRequestContextFiles?: () => void;
  enterToSend?: boolean;
  /** When true, automatically resume a transport-interrupted child once. */
  autoResumeInterrupted?: boolean;
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
  if (status === "interrupted") return "Interrupted";
  return status
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function SubagentConversation({
  delegation,
  headerTarget,
  runtimes,
  contextFiles,
  onRequestContextFiles,
  enterToSend,
  autoResumeInterrupted = false,
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
  const [resuming, setResuming] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [actionError, setActionError] = useState("");
  const [centerView, setCenterView] = useState<"task" | "review">("task");
  const [git, setGit] = useState<GitSnapshot | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [reviewRefreshVersion, setReviewRefreshVersion] = useState(0);
  const [reviewFileKey, setReviewFileKey] = useState("");
  const [diffView, setDiffView] = useState<"unified" | "split">("unified");
  const [reviewedFiles, setReviewedFiles] = useState<Record<string, boolean>>({});
  const [optimisticMessages, setOptimisticMessages] = useState<TranscriptEvent[]>([]);
  const [selectedRouting, setSelectedRouting] = useState<DelegationRouting>({
    runtime: delegation.runtime as DelegationRouting["runtime"],
    model: delegation.model || "",
    effort: delegation.effort ?? undefined,
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoResumeAttemptedRef = useRef(new Set<string>());
  // User/orchestrator Stop must never look like crash recovery on reopen.
  const userStoppedTurnsRef = useRef(new Set<string>());
  const childTaskId = delegation.childTaskId ?? undefined;

  useEffect(() => {
    if (!childTaskId) return;

    let disposed = false;
    let ready = false;
    let unlisten: (() => void) | undefined;
    let projectionFrame: number | undefined;
    const buffered: RuntimeProjectionEvent[] = [];
    const frameEvents: RuntimeProjectionEvent[] = [];
    const applyEvents = (events: RuntimeProjectionEvent[]) => {
      if (events.length === 0) return;
      setProjection((current) => {
        return applyRuntimeProjectionBatch(
          current ?? createRuntimeProjectionState(childTaskId),
          events,
        );
      });
    };
    const flushFrameEvents = () => {
      projectionFrame = undefined;
      applyEvents(frameEvents.splice(0));
    };
    void (async () => {
      try {
        unlisten = await bridge.subscribeRuntimeProjections((event) => {
          if (event.taskId !== childTaskId) return;
          if (!ready) {
            buffered.push(event);
            return;
          }
          if (isFrameBatchableRuntimeProjection(event)) {
            frameEvents.push(event);
            projectionFrame ??= window.requestAnimationFrame(flushFrameEvents);
            return;
          }
          if (projectionFrame !== undefined) {
            window.cancelAnimationFrame(projectionFrame);
            projectionFrame = undefined;
          }
          applyEvents([...frameEvents.splice(0), event]);
        });
        if (disposed) {
          unlisten();
          return;
        }

        const snapshot = await bridge.loadTaskProjection(childTaskId);
        const hydrate = snapshot.hydrate ?? {
          items: [],
          plan: [],
          planTruncated: false,
          approvals: [],
          firstSeen: {},
          hasMoreOlder: false,
        };
        let next = hydrateRuntimeProjectionState(
          childTaskId,
          hydrate,
          snapshot.watermarkSeq,
          snapshot.resetSeq,
        );
        next = applyRuntimeProjectionBatch(
          next,
          buffered
            .filter((candidate) => candidate.seq > snapshot.watermarkSeq)
            .sort((a, b) => a.seq - b.seq),
        );
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
      if (projectionFrame !== undefined) window.cancelAnimationFrame(projectionFrame);
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
        setReviewFileKey((current) =>
          snapshot.files.some((file) => diffFileKey(file) === current)
            ? current
            : snapshot.files[0]
              ? diffFileKey(snapshot.files[0])
              : "",
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

  const deriveProjectedEvents = useMemo(() => createRuntimeTranscriptDeriver(), []);
  const projectedEvents = useMemo(
    () => (projection ? deriveProjectedEvents(projection) : []),
    [deriveProjectedEvents, projection],
  );
  const visibleOptimisticMessages = useMemo(
    () =>
      optimisticMessages.filter(
        (optimistic) =>
          !projectedEvents.some(
            (event) =>
              event.kind === "user" &&
              event.body === optimistic.body &&
              Date.parse(event.timestamp) >= Date.parse(optimistic.timestamp) - 1_000,
          ),
      ),
    [optimisticMessages, projectedEvents],
  );
  const events = useMemo(
    () =>
      visibleOptimisticMessages.length === 0
        ? projectedEvents
        : [...projectedEvents, ...visibleOptimisticMessages].sort(
            (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
          ),
    [projectedEvents, visibleOptimisticMessages],
  );
  const turnRunning = projection?.turn?.status === "inProgress" && activeStatus(delegation.status);
  const turnStopKey =
    childTaskId && projection?.turn ? `${childTaskId}:${projection.turn.id}` : "";
  const intentionallyStopped =
    delegation.status === "stopped" ||
    Boolean(projection?.turn?.stopRequested) ||
    (turnStopKey !== "" && userStoppedTurnsRef.current.has(turnStopKey));
  // Only process-loss Interrupted is resumeable. Stopped (user or orchestrator)
  // and stopRequested turns stay idle when the pane opens — never auto-restart.
  const showResume =
    Boolean(onSend) &&
    !turnRunning &&
    !intentionallyStopped &&
    delegation.status === "interrupted";
  const showResumeControl =
    showResume && (!autoResumeInterrupted || Boolean(recoveryError)) && !resuming;
  const recoveryKey = showResume
    ? `${delegation.id}:${projection?.turn?.id ?? "status"}`
    : "";
  const canMessage = Boolean(
    onSend &&
    childTaskId &&
    delegation.status !== "pending-approval" &&
    delegation.status !== "denied" &&
    delegation.status !== "starting",
  );
  const supportedRuntimes = useMemo(
    () =>
      runtimes.filter((runtime) =>
        ["codex", "claude", "antigravity", "cursor", "grok"].includes(runtime.id),
      ),
    [runtimes],
  );
  const reviewFile =
    git?.files.find((file) => diffFileKey(file) === reviewFileKey) ?? git?.files[0];
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
                  diffFileKey(candidate) === diffFileKey(loaded) ? loaded : candidate,
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
    const isResume = message === "Resume from here";
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
    if (!isResume) {
      setOptimisticMessages((current) => [...current, optimistic]);
    }
    try {
      await onSend(delegation.id, message, routing);
      return true;
    } catch (error) {
      if (!isResume) {
        setOptimisticMessages((current) => current.filter((event) => event.id !== optimistic.id));
      }
      setActionError(error instanceof Error ? error.message : "Could not message this subagent");
      return false;
    }
  };

  const resumeInterrupted = async (): Promise<boolean> => {
    if (!showResume || resuming || intentionallyStopped) return false;
    setResuming(true);
    setRecoveryError("");
    const accepted = await send({
      prompt: "Resume from here",
      runtime: selectedRouting.runtime,
      model: selectedRouting.model || "Provider default",
      effort: selectedRouting.effort,
    });
    setResuming(false);
    if (!accepted) {
      setRecoveryError("Couldn’t restore this subagent. You can retry or send a new message.");
    }
    return accepted;
  };

  useEffect(() => {
    if (!showResume || !autoResumeInterrupted || resuming) return;
    if (autoResumeAttemptedRef.current.has(recoveryKey)) return;
    autoResumeAttemptedRef.current.add(recoveryKey);
    void resumeInterrupted();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one attempt per interrupted child boundary
  }, [autoResumeInterrupted, recoveryKey, resuming, showResume]);

  const stop = async () => {
    if (!onStop || stopping) return;
    if (turnStopKey) userStoppedTurnsRef.current.add(turnStopKey);
    setProjection((current) => {
      if (!current?.turn || current.turn.stopRequested) return current;
      return {
        ...current,
        turn: { ...current.turn, stopRequested: true },
      };
    });
    setStopping(true);
    setActionError("");
    try {
      await onStop(delegation.id);
    } catch (error) {
      if (turnStopKey) userStoppedTurnsRef.current.delete(turnStopKey);
      setActionError(error instanceof Error ? error.message : "Could not stop this subagent");
    } finally {
      setStopping(false);
    }
  };

  return (
    <section className="subagent-conversation" aria-label={`${delegation.title} transcript`}>
      {headerTarget
        ? createPortal(
            <div className="titlebar-subagent-header">
              <div className="titlebar-subagent-copy">
                <h2>{delegation.title}</h2>
                <span>
                  {delegation.profileLabel} · {selectedRouting.model || selectedRouting.runtime} ·{" "}
                  {statusLabel(delegation.status)}
                </span>
              </div>
              <div className="titlebar-view-tabs" role="tablist" aria-label="Subagent view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={centerView === "task"}
                  data-active={centerView === "task"}
                  onClick={() => setCenterView("task")}
                >
                  {centerView === "task" ? (
                    <SlidingTabIndicator layoutId={`subagent-view-tab-${delegation.id}`} />
                  ) : null}
                  Task
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-label="Review"
                  aria-selected={centerView === "review"}
                  data-active={centerView === "review"}
                  onClick={() => {
                    setCenterView("review");
                    setReviewError("");
                    setReviewLoading(true);
                  }}
                >
                  {centerView === "review" ? (
                    <SlidingTabIndicator layoutId={`subagent-view-tab-${delegation.id}`} />
                  ) : null}
                  Review{git?.files.length ? ` ${git.files.length}` : ""}
                </button>
              </div>
              <div className="titlebar-subagent-actions">
                <span
                  className="usage-compact conversation-token-count"
                  aria-label={`${totalTokens.toLocaleString()} tokens`}
                  title={`${totalTokens.toLocaleString()} tokens used by this subagent`}
                >
                  {formatCompactTokenCount(totalTokens)}
                </span>
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
              </div>
            </div>,
            headerTarget,
          )
        : null}
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
                  ownerKey={`task:${childTaskId}`}
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
            {turnRunning || showResumeControl || resuming ? (
              <TaskStatusPill
                key="subagent-status-pill"
                runningSince={
                  turnRunning || resuming ? projection?.turn?.startedAt : undefined
                }
                usage={projection?.usage}
                recovery={
                  showResumeControl ? (
                    <div className="turn-recovery-control" role="status">
                      <span>
                        <strong>Subagent interrupted</strong>
                        <small>
                          {recoveryError ||
                            "The provider can continue from its last safe boundary."}
                        </small>
                      </span>
                      <button
                        type="button"
                        disabled={resuming}
                        onClick={() => void resumeInterrupted()}
                      >
                        {resuming ? "Resuming…" : "Resume"}
                      </button>
                    </div>
                  ) : undefined
                }
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
                    value={diffFileKey(reviewFile)}
                    onChange={setReviewFileKey}
                    options={git.files.map((file) => ({
                      value: diffFileKey(file),
                      label: `${file.path} — ${file.staged ? "staged" : "unstaged"}`,
                    }))}
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
                  reviewed={Boolean(reviewedFiles[diffFileKey(reviewFile)])}
                  onMarkReviewed={() =>
                    setReviewedFiles((current) => ({
                      ...current,
                      [diffFileKey(reviewFile)]: true,
                    }))
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
