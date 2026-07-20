import { describe, expect, it } from "vitest";
import type { Automation, AutomationTimelineEntry, TranscriptEvent } from "./bridge";
import { mergeSchedulingTranscript } from "./automationTranscript";
import { automationTurnPrompt } from "./automationTurnPrompt";

const automation: Automation = {
  id: "automation-1",
  taskId: "task-1",
  title: "Review the build",
  prompt: "Review the latest build.",
  target: { kind: "task" },
  trigger: { kind: "at", runAt: "2026-07-19T16:20:00Z" },
  route: {
    runtime: "codex",
    model: "gpt-5.6",
    fallbacks: [],
    permission: "project-write",
    delegation: "off",
  },
  source: "agent",
  status: "completed",
  createdAt: "2026-07-19T16:00:00Z",
  updatedAt: "2026-07-19T16:20:01Z",
};

function user(id: string, body: string, timestamp: string): TranscriptEvent {
  return { id, kind: "user", body, timestamp };
}

describe("mergeSchedulingTranscript", () => {
  it("attaches a live countdown only while a near-term fixed wakeup is active", () => {
    const [receipt] = mergeSchedulingTranscript(
      [],
      [{ automation: { ...automation, status: "active" }, runs: [] }],
    );

    expect(receipt).toMatchObject({
      title: "Wake-up scheduled",
      scheduling: { countdownAt: "2026-07-19T16:20:00Z" },
    });
  });

  it("shows a plain-language receipt and marks the wakeup without a user-authored bubble", () => {
    const timeline: AutomationTimelineEntry[] = [
      {
        automation,
        runs: [
          {
            id: "run-1",
            automationId: automation.id,
            scheduledFor: "2026-07-19T16:20:00Z",
            status: "dispatched",
            dispatchRef: "task:task-1",
            claimedAt: "2026-07-19T16:20:00Z",
            finishedAt: "2026-07-19T16:20:01Z",
          },
        ],
      },
    ];
    const result = mergeSchedulingTranscript(
      [
        user("request", "Wake up in twenty minutes.", "2026-07-19T15:59:55Z"),
        user("wake", automation.prompt, "2026-07-19T16:20:00Z"),
      ],
      timeline,
    );

    expect(result.map((event) => event.title)).toContain("Wake-up scheduled");
    expect(result.find((event) => event.id === "wake")?.scheduling?.phase).toBe("prompt");
    expect(result.find((event) => event.id === "wake")?.title).toBe("Scheduled task started");
  });

  it("recognizes an augmented iterative prompt while keeping its protocol out of the chat badge", () => {
    const iterative = {
      ...automation,
      trigger: {
        kind: "interval" as const,
        everySeconds: 60,
        anchorAt: "2026-07-19T16:20:00Z",
      },
      iterationNotes: true,
      nextRunNote: "Inspect the retry path next.",
    };
    const dispatchedPrompt = automationTurnPrompt(iterative);
    const timeline: AutomationTimelineEntry[] = [
      {
        automation: {
          ...iterative,
          nextRunNote: "The retry path is confirmed; inspect cancellation next.",
        },
        runs: [
          {
            id: "run-iterative",
            automationId: iterative.id,
            scheduledFor: "2026-07-19T16:20:00Z",
            status: "dispatched",
            dispatchRef: "task:task-1",
            claimedAt: "2026-07-19T16:20:00Z",
            finishedAt: "2026-07-19T16:20:01Z",
          },
        ],
      },
    ];

    const result = mergeSchedulingTranscript(
      [user("wake-iterative", dispatchedPrompt, "2026-07-19T16:20:00Z")],
      timeline,
    );
    const prompt = result.find((event) => event.id === "wake-iterative");

    expect(prompt?.title).toBe("Scheduled task started");
    expect(prompt?.body).toBe(iterative.prompt);
    expect(prompt?.body).not.toContain("automation_leave_note");
  });

  it("does not relabel an identical message sent before the scheduled run", () => {
    const timeline: AutomationTimelineEntry[] = [
      {
        automation: { ...automation, status: "running" },
        runs: [
          {
            id: "run-1",
            automationId: automation.id,
            scheduledFor: "2026-07-19T16:20:00Z",
            status: "claimed",
            claimedAt: "2026-07-19T16:20:00Z",
          },
        ],
      },
    ];
    const result = mergeSchedulingTranscript(
      [user("manual", automation.prompt, "2026-07-19T16:10:00Z")],
      timeline,
    );

    expect(result.find((event) => event.id === "manual")?.scheduling).toBeUndefined();
    expect(result.map((event) => event.title)).toContain("Starting scheduled task");
  });

  it("surfaces a failed dispatch without pretending that a prompt ran", () => {
    const result = mergeSchedulingTranscript(
      [],
      [
        {
          automation: {
            ...automation,
            status: "needs-attention",
            lastError: "Runtime unavailable",
          },
          runs: [
            {
              id: "run-1",
              automationId: automation.id,
              scheduledFor: "2026-07-19T16:20:00Z",
              status: "failed",
              error: "Runtime unavailable",
              claimedAt: "2026-07-19T16:20:00Z",
              finishedAt: "2026-07-19T16:20:01Z",
            },
          ],
        },
      ],
    );

    expect(result.at(-1)).toMatchObject({
      title: "Couldn’t start scheduled task",
      body: "Runtime unavailable",
      status: "error",
    });
  });
});
