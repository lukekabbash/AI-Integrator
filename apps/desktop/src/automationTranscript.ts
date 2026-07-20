import type { Automation, AutomationRun, AutomationTimelineEntry, TranscriptEvent } from "./bridge";
import { automationTurnPrompt } from "./automationTurnPrompt";

const ACTIVE_STATUSES = new Set<Automation["status"]>([
  "active",
  "paused",
  "running",
  "needs-attention",
]);

function durationLabel(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function createdPresentation(automation: Automation): { title: string; countdownAt?: string } {
  const { trigger } = automation;
  if (trigger.kind === "interval") {
    return { title: `Scheduled every ${durationLabel(trigger.everySeconds)}` };
  }
  if (trigger.kind === "delegationsSettled") {
    return {
      title: trigger.requireAll
        ? "Waking up when the subagents finish"
        : "Waking up when a subagent finishes",
    };
  }
  const delayMs = Date.parse(trigger.runAt) - Date.parse(automation.createdAt);
  const countdownAt =
    automation.status === "active" && delayMs > 0 && delayMs <= 86_400_000
      ? trigger.runAt
      : undefined;
  return {
    title: automation.status === "paused" ? "Wake-up paused" : "Wake-up scheduled",
    countdownAt,
  };
}

function schedulingEvent(
  automation: Automation,
  run: AutomationRun | undefined,
  phase: NonNullable<TranscriptEvent["scheduling"]>["phase"],
  title: string,
  body: string,
  timestamp: string,
  countdownAt?: string,
): TranscriptEvent {
  return {
    id: run ? `automation-run-${run.id}` : `automation-created-${automation.id}`,
    kind: "activity",
    activityType: "other",
    title,
    body,
    timestamp,
    status: phase === "failed" ? "error" : phase === "starting" ? "running" : "neutral",
    scheduling: {
      automationId: automation.id,
      runId: run?.id,
      phase,
      canCancel: ACTIVE_STATUSES.has(automation.status),
      countdownAt,
    },
  };
}

function firstPromptForRun(
  events: TranscriptEvent[],
  automation: Automation,
  run: AutomationRun,
  used: Set<string>,
): TranscriptEvent | undefined {
  const claimedAt = Date.parse(run.claimedAt) - 1_000;
  const currentPrompt = automationTurnPrompt(automation);
  const iterativePrefix = `${automation.prompt.trim()}\n\nIteration context appended by scheduling:\n`;
  const iterativeId = `automationId \`${automation.id}\``;
  return events.find(
    (event) =>
      event.kind === "user" &&
      !used.has(event.id) &&
      (event.body === currentPrompt ||
        (automation.iterationNotes === true &&
          event.body.startsWith(iterativePrefix) &&
          event.body.includes(iterativeId))) &&
      Date.parse(event.timestamp) >= claimedAt,
  );
}

/**
 * Adds locally persisted scheduling receipts to a provider transcript. Matching
 * dispatched prompts by exact text keeps queued wakeups recognizable after a
 * restart without exposing scheduling metadata to provider runtimes.
 */
export function mergeSchedulingTranscript(
  events: TranscriptEvent[],
  timeline: AutomationTimelineEntry[],
): TranscriptEvent[] {
  const scheduled: TranscriptEvent[] = [];
  const replacements = new Map<string, TranscriptEvent>();
  const usedPrompts = new Set<string>();

  for (const { automation, runs } of timeline) {
    const created = createdPresentation(automation);
    scheduled.push(
      schedulingEvent(
        automation,
        undefined,
        "created",
        created.title,
        automation.title,
        automation.createdAt,
        created.countdownAt,
      ),
    );

    for (const run of [...runs].sort((left, right) =>
      left.claimedAt.localeCompare(right.claimedAt),
    )) {
      const promptEvent =
        run.status === "dispatched"
          ? firstPromptForRun(events, automation, run, usedPrompts)
          : undefined;
      if (promptEvent) {
        usedPrompts.add(promptEvent.id);
        replacements.set(promptEvent.id, {
          ...promptEvent,
          body: automation.prompt,
          title: "Scheduled task started",
          meta: automation.title,
          scheduling: {
            automationId: automation.id,
            runId: run.id,
            phase: "prompt",
            canCancel: ACTIVE_STATUSES.has(automation.status),
          },
        });
        continue;
      }
      if (run.status === "failed") {
        scheduled.push(
          schedulingEvent(
            automation,
            run,
            "failed",
            "Couldn’t start scheduled task",
            run.error ?? automation.lastError ?? automation.title,
            run.finishedAt ?? run.claimedAt,
          ),
        );
        continue;
      }
      scheduled.push(
        schedulingEvent(
          automation,
          run,
          "starting",
          run.dispatchRef?.startsWith("queue:")
            ? "Scheduled task is waiting"
            : "Starting scheduled task",
          automation.title,
          run.claimedAt,
        ),
      );
    }
  }

  return [...events.map((event) => replacements.get(event.id) ?? event), ...scheduled].sort(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
}
