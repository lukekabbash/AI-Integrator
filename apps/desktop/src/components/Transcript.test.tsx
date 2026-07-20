// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEvent } from "../bridge";
import { Transcript } from "./Transcript";
import {
  readTranscriptViewportState,
  writeTranscriptViewportState,
} from "./transcriptViewportState";

const event = (id: string, kind: TranscriptEvent["kind"], body: string): TranscriptEvent => ({
  id,
  kind,
  body,
  timestamp: "2026-07-11T12:00:00.000Z",
});

describe("Transcript", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("branches from turn-final replies, not intermediate agent bubbles", () => {
    const onBranch = vi.fn();
    render(
      <Transcript
        events={[
          event("user-1", "user", "first question"),
          event("assistant-1a", "assistant", "partial thought"),
          event("assistant-1b", "assistant", "first answer"),
          event("user-2", "user", "follow up"),
          event("assistant-2", "assistant", "second answer"),
        ]}
        onBranch={onBranch}
      />,
    );

    const branches = screen.getAllByRole("button", { name: "Branch the chat from this response" });
    // Cut points are turn ends: last agent reply before the next user, plus
    // the open trailing reply — not every assistant bubble in a turn.
    expect(branches).toHaveLength(2);
    const interim = document.querySelector('[data-event-id="assistant-1a"]');
    expect(interim?.classList.contains("turn--assistant-interim")).toBe(true);
    expect(interim).toHaveAttribute("aria-label", "Agent progress");
    expect(
      within(interim as HTMLElement).queryByRole("button", { name: "Copy this response" }),
    ).toBeNull();
    fireEvent.click(branches[0]);
    expect(onBranch).toHaveBeenCalledWith("assistant-1b");
    fireEvent.click(branches[1]);
    expect(onBranch).toHaveBeenCalledWith("assistant-2");
  });

  it("streams live agent replies in interim italic until the turn settles", () => {
    const { rerender } = render(
      <Transcript
        events={[
          event("user-1", "user", "fix it"),
          event("assistant-1", "assistant", "Looking into it…"),
        ]}
        running
      />,
    );

    const live = document.querySelector('[data-event-id="assistant-1"]');
    expect(live?.classList.contains("turn--assistant-interim")).toBe(true);
    expect(live).toHaveAttribute("aria-label", "Agent progress");
    expect(screen.queryByRole("button", { name: "Copy this response" })).toBeNull();

    rerender(
      <Transcript
        events={[
          event("user-1", "user", "fix it"),
          event("assistant-1", "assistant", "Looking into it…"),
          event("assistant-2", "assistant", "All fixed."),
        ]}
      />,
    );

    expect(
      document
        .querySelector('[data-event-id="assistant-1"]')
        ?.classList.contains("turn--assistant-interim"),
    ).toBe(true);
    const finalReply = document.querySelector('[data-event-id="assistant-2"]');
    expect(finalReply?.classList.contains("turn--assistant-interim")).toBe(false);
    expect(finalReply).toHaveAttribute("aria-label", "Agent response");
    expect(screen.getByRole("button", { name: "Copy this response" })).toBeInTheDocument();
  });

  it("renders project Markdown links as inline file actions with exact locations", () => {
    const onOpenFile = vi.fn();
    render(
      <Transcript
        events={[
          event(
            "assistant-1",
            "assistant",
            "Updated [App.tsx:12–18](./src/App.tsx#L12-L18), including *[the fallback](./src/fallback.ts#L4)*.",
          ),
        ]}
        onOpenFile={onOpenFile}
      />,
    );

    const appLink = screen.getByRole("link", { name: "App.tsx:12–18" });
    expect(appLink).toHaveClass("assistant-file-link");
    expect(appLink.querySelector(".file-type-icon")).not.toBeNull();
    expect(screen.getByRole("link", { name: "the fallback" }).closest("em")).not.toBeNull();

    fireEvent.click(appLink);
    expect(onOpenFile).toHaveBeenCalledWith({
      path: "src/App.tsx",
      startLine: 12,
      endLine: 18,
    });
  });

  it("streams final_answer phase replies in normal chrome while the turn is still running", () => {
    const onBranch = vi.fn();
    render(
      <Transcript
        events={[
          event("user-1", "user", "fix it"),
          event("assistant-1", "assistant", "Looking into it…"),
          {
            ...event("assistant-2", "assistant", "All fixed."),
            phase: "final_answer",
          },
        ]}
        running
        onBranch={onBranch}
        modelForEvent={() => "Codex"}
      />,
    );

    expect(
      document
        .querySelector('[data-event-id="assistant-1"]')
        ?.classList.contains("turn--assistant-interim"),
    ).toBe(true);
    const finalReply = document.querySelector('[data-event-id="assistant-2"]');
    expect(finalReply?.classList.contains("turn--assistant-interim")).toBe(false);
    expect(finalReply).toHaveAttribute("aria-label", "Agent response");
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy this response" })).toBeInTheDocument();
    // Branch stays withheld until the turn settles, even for final_answer.
    expect(screen.queryByRole("button", { name: "Branch the chat from this response" })).toBeNull();
  });

  it("keeps prior turn-final replies normal when a follow-up turn starts", () => {
    const { rerender } = render(
      <Transcript
        events={[
          event("user-1", "user", "first question"),
          event("assistant-1", "assistant", "first answer"),
        ]}
      />,
    );
    expect(
      document
        .querySelector('[data-event-id="assistant-1"]')
        ?.classList.contains("turn--assistant-interim"),
    ).toBe(false);

    rerender(
      <Transcript
        events={[
          event("user-1", "user", "first question"),
          event("assistant-1", "assistant", "first answer"),
          event("user-2", "user", "follow up"),
        ]}
        running
        onBranch={vi.fn()}
      />,
    );
    expect(
      document
        .querySelector('[data-event-id="assistant-1"]')
        ?.classList.contains("turn--assistant-interim"),
    ).toBe(false);
    expect(screen.getByRole("button", { name: "Copy this response" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Branch the chat from this response" }),
    ).toBeInTheDocument();
  });

  it("offers Regenerate on every turn-final reply", () => {
    const onRegenerate = vi.fn();
    render(
      <Transcript
        events={[
          event("user-1", "user", "first question"),
          event("assistant-1", "assistant", "first answer"),
          event("user-2", "user", "follow up"),
          event("assistant-2", "assistant", "second answer"),
        ]}
        onRegenerate={onRegenerate}
        onBranch={vi.fn()}
      />,
    );
    const regenerates = screen.getAllByRole("button", { name: "Regenerate this response" });
    expect(regenerates).toHaveLength(2);
    fireEvent.click(regenerates[0]);
    expect(onRegenerate).toHaveBeenCalledWith("assistant-1");
    fireEvent.click(regenerates[1]);
    expect(onRegenerate).toHaveBeenCalledWith("assistant-2");
  });

  it("withholds Branch only on the reply that is still streaming", () => {
    const onBranch = vi.fn();
    const { rerender } = render(
      <Transcript
        events={[
          event("user-1", "user", "first question"),
          event("assistant-1", "assistant", "earlier answer"),
          event("user-2", "user", "follow up"),
          event("assistant-2", "assistant", "partial"),
        ]}
        onBranch={onBranch}
        running
      />,
    );
    const whileStreaming = screen.getAllByRole("button", {
      name: "Branch the chat from this response",
    });
    // Prior completed turns stay branchable; only the in-flight reply hides it.
    expect(whileStreaming).toHaveLength(1);
    fireEvent.click(whileStreaming[0]);
    expect(onBranch).toHaveBeenCalledWith("assistant-1");

    rerender(
      <Transcript
        events={[
          event("user-1", "user", "first question"),
          event("assistant-1", "assistant", "earlier answer"),
          event("user-2", "user", "follow up"),
          event("assistant-2", "assistant", "done"),
        ]}
        onBranch={onBranch}
      />,
    );
    expect(
      screen.getAllByRole("button", { name: "Branch the chat from this response" }),
    ).toHaveLength(2);
  });

  it("omits Branch entirely when the host wires no handler", () => {
    render(<Transcript events={[event("assistant-1", "assistant", "answer")]} />);
    expect(screen.queryByRole("button", { name: "Branch the chat from this response" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy this response" })).toBeVisible();
  });

  it("offers Copy and Edit on user messages, including while a turn is streaming", () => {
    const onEditUserMessage = vi.fn();
    render(
      <Transcript
        events={[
          event("user-1", "user", "first question"),
          event("assistant-1", "assistant", "partial"),
        ]}
        onEditUserMessage={onEditUserMessage}
        running
      />,
    );

    expect(screen.getByRole("button", { name: "Copy this message" })).toBeVisible();
    const edit = screen.getByRole("button", { name: "Edit this message" });
    expect(edit).toBeVisible();
    fireEvent.click(edit);
    expect(onEditUserMessage).toHaveBeenCalledWith("user-1", "first question");
  });

  it("omits Edit on user messages when the host wires no handler", () => {
    render(<Transcript events={[event("user-1", "user", "hello")]} />);
    expect(screen.getByRole("button", { name: "Copy this message" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit this message" })).toBeNull();
  });

  it("renders scheduled wakeups as quiet stream activity instead of user messages", () => {
    const onCancelScheduledTask = vi.fn();
    render(
      <Transcript
        events={[
          {
            ...event(
              "scheduled-prompt",
              "user",
              'The user asked you to say hi after 30 seconds.\nReply with "Hi!" only.',
            ),
            title: "Scheduled task started",
            meta: "Say hi in 30s",
            scheduling: {
              automationId: "automation-1",
              runId: "run-1",
              phase: "prompt",
              canCancel: true,
            },
          },
        ]}
        onCancelScheduledTask={onCancelScheduledTask}
      />,
    );

    expect(screen.getByLabelText("Scheduled task started")).toHaveClass("scheduling-message");
    expect(screen.getByLabelText("Scheduled task started")).not.toHaveClass("task-status-pill");
    expect(screen.getByLabelText("Scheduled task started")).toHaveAttribute("data-phase", "prompt");
    expect(screen.getByText("Say hi in 30s")).toBeVisible();
    expect(screen.getByText(/The user asked you to say hi/)).toBeVisible();
    expect(screen.queryByLabelText("Your message")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancelScheduledTask).toHaveBeenCalledWith("automation-1");
  });

  it("counts down a fixed near-term wakeup in place", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T16:00:00Z"));
    render(
      <Transcript
        events={[
          {
            ...event("scheduled-countdown", "activity", "Say hi in 30s"),
            title: "Wake-up scheduled",
            scheduling: {
              automationId: "automation-1",
              phase: "created",
              countdownAt: "2026-07-19T16:00:30Z",
            },
          },
        ]}
      />,
    );

    expect(screen.getByText("Waking up in 30s")).toBeVisible();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText("Waking up in 29s")).toBeVisible();
  });

  it("styles only a verified native skill in a user message", () => {
    const verified = {
      ...event("user-skill", "user", "/skill-creator add release checks"),
      nativeSkill: "skill-creator",
    };
    const plain = event("user-plain", "user", "/skill-creator this is only slash text");

    render(<Transcript events={[verified, plain]} />);

    const messages = screen.getAllByLabelText("Your message");
    const skill = screen.getByLabelText("Native skill /skill-creator");
    expect(skill.tagName).toBe("STRONG");
    expect(skill).toHaveClass("native-skill-token");
    expect(messages[0]).toHaveTextContent("/skill-creator add release checks");
    expect(messages[1].querySelector(".native-skill-token")).toBeNull();
  });

  it("opens Markdown links in a new main-browser tab after consent", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <Transcript
        events={[event("assistant-1", "assistant", "Read [the docs](https://example.com/docs).")]}
      />,
    );

    const link = screen.getByRole("link", { name: "the docs" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    fireEvent.click(link);

    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://example.com/docs",
        "_blank",
        "noopener,noreferrer",
      ),
    );
    expect(confirm).toHaveBeenCalled();
  });

  it("does not open a Markdown link when consent is declined", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(
      <Transcript
        events={[event("assistant-1", "assistant", "Read [the docs](https://example.com/docs).")]}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "the docs" }));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(open).not.toHaveBeenCalled();
  });

  it("does not promote a streaming bullet start into a setext heading", () => {
    const { rerender } = render(
      <Transcript events={[event("assistant-1", "assistant", "Here are the steps:\n-")]} running />,
    );

    let response = screen.getByLabelText("Agent progress");
    expect(response.querySelector("h2")).toBeNull();
    expect(response).toHaveTextContent("Here are the steps:");

    rerender(
      <Transcript
        events={[event("assistant-1", "assistant", "Here are the steps:\n- First")]}
        running
      />,
    );

    response = screen.getByLabelText("Agent progress");
    expect(response.querySelector("h2")).toBeNull();
    expect(within(response).getByRole("list")).toBeInTheDocument();
    expect(within(response).getByRole("listitem")).toHaveTextContent("First");
  });

  it("keeps a finished thematic break but still suppresses aborted setext underlines", () => {
    const { rerender } = render(
      <Transcript events={[event("assistant-1", "assistant", "Done.\n\n---")]} />,
    );
    expect(screen.getByLabelText("Agent response").querySelector("hr")).not.toBeNull();

    rerender(<Transcript events={[event("assistant-1", "assistant", "Here are the steps:\n-")]} />);
    const response = screen.getByLabelText("Agent response");
    expect(response.querySelector("h2")).toBeNull();
    expect(response).toHaveTextContent("Here are the steps:");
  });

  it("renders finished bulleted lists as real list items", () => {
    render(
      <Transcript
        events={[
          event(
            "assistant-1",
            "assistant",
            "Here are the steps:\n- First\n- Second\n\nAnd a nested list:\n- Parent\n  - Child",
          ),
        ]}
      />,
    );

    const response = screen.getByLabelText("Agent response");
    expect(response.querySelector("h2")).toBeNull();
    const items = within(response).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("First");
    expect(items[1]).toHaveTextContent("Second");
    expect(items[2]).toHaveTextContent(/Parent/);
    expect(items[3]).toHaveTextContent("Child");
  });

  it("shows jump-to-latest when new content arrives after scrolling away", async () => {
    const scrollContainerRef = { current: null as HTMLDivElement | null };
    let contentHeight = 220;
    const { rerender } = render(
      <div data-testid="transcript-scroll" ref={scrollContainerRef} style={{ overflowY: "auto" }}>
        <Transcript
          events={[event("assistant-1", "assistant", "First response.")]}
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );
    const scrollContainer = screen.getByTestId("transcript-scroll");
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get: () => contentHeight,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      get: () => 100,
    });
    await waitFor(() => expect(scrollContainer.scrollTop).toBe(120));

    scrollContainer.scrollTop = 0;
    fireEvent.scroll(scrollContainer);

    contentHeight = 420;
    rerender(
      <div data-testid="transcript-scroll" ref={scrollContainerRef} style={{ overflowY: "auto" }}>
        <Transcript
          events={[
            event("assistant-1", "assistant", "First response."),
            event("assistant-2", "assistant", "More streamed response."),
          ]}
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );

    expect(screen.getByRole("button", { name: /Jump to latest/ })).toBeInTheDocument();
  });

  it("keeps the viewport at the bottom while content streams in", async () => {
    const scrollContainerRef = { current: null as HTMLDivElement | null };
    let contentHeight = 220;
    const { rerender } = render(
      <div data-testid="transcript-scroll" ref={scrollContainerRef}>
        <Transcript
          events={[event("assistant-1", "assistant", "First response.")]}
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );
    const scrollContainer = screen.getByTestId("transcript-scroll");
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get: () => contentHeight,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      get: () => 100,
    });
    scrollContainer.scrollTop = 120;
    fireEvent.scroll(scrollContainer);

    contentHeight = 320;
    rerender(
      <div data-testid="transcript-scroll" ref={scrollContainerRef}>
        <Transcript
          events={[
            event("assistant-1", "assistant", "First response."),
            event("assistant-2", "assistant", "Streamed response."),
          ]}
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );

    await waitFor(() => expect(scrollContainer.scrollTop).toBe(220));
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).not.toBeInTheDocument();
  });

  it("opens an already-populated chat scrolled to the latest message", async () => {
    const scrollContainerRef = { current: null as HTMLDivElement | null };
    // Opening a chat mounts the scroll container and the fully loaded
    // transcript in the same commit; the initial follow must still land.
    render(
      <div data-testid="transcript-scroll" ref={scrollContainerRef}>
        <Transcript
          events={[
            event("user-1", "user", "Earlier question."),
            event("assistant-1", "assistant", "Earlier answer."),
            event("assistant-2", "assistant", "Latest answer."),
          ]}
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );
    const scrollContainer = screen.getByTestId("transcript-scroll");
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 500 });
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 100 });

    await waitFor(() => expect(scrollContainer.scrollTop).toBe(400));
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).not.toBeInTheDocument();
  });

  it("follows latest across a shared scroll shell remount despite early top scroll", async () => {
    const scrollContainerRef = { current: null as HTMLDivElement | null };
    let contentHeight = 500;
    const { rerender } = render(
      <div data-testid="transcript-scroll" ref={scrollContainerRef}>
        <Transcript
          key="chat-a"
          ownerKey="task:chat-a"
          events={[event("a-1", "user", "A question"), event("a-2", "assistant", "A answer")]}
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );
    const scrollContainer = screen.getByTestId("transcript-scroll");
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get: () => contentHeight,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      get: () => 100,
    });
    await waitFor(() => expect(scrollContainer.scrollTop).toBe(400));

    // Carry residual scrollTop into the next chat (shared shell does not remount).
    contentHeight = 800;
    scrollContainer.scrollTop = 0;
    rerender(
      <div data-testid="transcript-scroll" ref={scrollContainerRef}>
        <Transcript
          key="chat-b"
          ownerKey="task:chat-b"
          events={[
            event("b-1", "user", "B question"),
            event("b-2", "assistant", "B answer"),
            event("b-3", "assistant", "B latest"),
          ]}
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );
    fireEvent.scroll(scrollContainer);

    await waitFor(() => expect(scrollContainer.scrollTop).toBe(700));
    expect(readTranscriptViewportState("task:chat-b")?.following).not.toBe(false);
  });

  it("ignores near-top scroll during open settle and still follows latest", async () => {
    localStorage.clear();
    const scrollContainerRef = { current: null as HTMLDivElement | null };
    render(
      <div data-testid="transcript-scroll" ref={scrollContainerRef}>
        <Transcript
          ownerKey="task:settle-follow"
          events={[event("u-1", "user", "Question"), event("a-1", "assistant", "Answer")]}
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );
    const scrollContainer = screen.getByTestId("transcript-scroll");
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 500 });
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 100 });
    scrollContainer.scrollTop = 0;
    fireEvent.scroll(scrollContainer);

    await waitFor(() => expect(scrollContainer.scrollTop).toBe(400));
    expect(readTranscriptViewportState("task:settle-follow")?.following).not.toBe(false);
  });

  it("follows latest after empty-to-hydrated open on a shared scroll shell", async () => {
    const scrollContainerRef = { current: null as HTMLDivElement | null };
    let contentHeight = 0;
    const { rerender } = render(
      <div data-testid="transcript-scroll" ref={scrollContainerRef}>
        <Transcript
          ownerKey="task:cold-hydrate"
          events={[]}
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );
    const scrollContainer = screen.getByTestId("transcript-scroll");
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get: () => contentHeight,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      get: () => 100,
    });
    scrollContainer.scrollTop = 0;
    fireEvent.scroll(scrollContainer);

    contentHeight = 600;
    rerender(
      <div data-testid="transcript-scroll" ref={scrollContainerRef}>
        <Transcript
          ownerKey="task:cold-hydrate"
          events={[
            event("u-1", "user", "Hydrated question"),
            event("a-1", "assistant", "Hydrated answer"),
          ]}
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );

    await waitFor(() => expect(scrollContainer.scrollTop).toBe(500));
  });

  it("restores a saved reading anchor despite open-settle scroll noise", async () => {
    localStorage.clear();
    writeTranscriptViewportState("task:restore-mid", {
      following: false,
      anchor: { eventId: "mid-1", offsetPx: 0 },
      expanded: {},
      updatedAt: Date.now(),
    });
    const scrollContainerRef = { current: null as HTMLDivElement | null };
    render(
      <div data-testid="transcript-scroll" ref={scrollContainerRef}>
        <Transcript
          ownerKey="task:restore-mid"
          events={[
            event("early-1", "user", "Early"),
            event("mid-1", "assistant", "Mid answer"),
            event("late-1", "assistant", "Latest answer"),
          ]}
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );
    const scrollContainer = screen.getByTestId("transcript-scroll");
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 100 });
    scrollContainer.scrollTop = 0;
    fireEvent.scroll(scrollContainer);

    await waitFor(() => expect(document.querySelector('[data-event-id="mid-1"]')).not.toBeNull());
    // Must not snap to latest from settle noise.
    await waitFor(() => expect(scrollContainer.scrollTop).toBeLessThan(800));
    expect(readTranscriptViewportState("task:restore-mid")?.following).toBe(false);
  });

  it("does not load older pages during open settle when parked at top", async () => {
    const onLoadOlder = vi.fn();
    const scrollContainerRef = { current: null as HTMLDivElement | null };
    render(
      <div data-testid="transcript-scroll" ref={scrollContainerRef}>
        <Transcript
          ownerKey="task:titan-open"
          events={Array.from({ length: 40 }, (_, index) =>
            event(`e-${index}`, "assistant", `Message ${index}`),
          )}
          hasMoreOlder
          onLoadOlder={onLoadOlder}
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );
    const scrollContainer = screen.getByTestId("transcript-scroll");
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 100 });
    scrollContainer.scrollTop = 0;
    fireEvent.scroll(scrollContainer);

    await waitFor(() => expect(scrollContainer.scrollTop).toBe(1900));
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it("loads older pages after settle with upward intent and anchors the prepend", async () => {
    const onLoadOlder = vi.fn();
    const scrollContainerRef = { current: null as HTMLDivElement | null };
    let contentHeight = 1000;
    const baseEvents = Array.from({ length: 20 }, (_, index) =>
      event(`e-${index}`, "assistant", `Message ${index}`),
    );
    const { rerender } = render(
      <div data-testid="transcript-scroll" ref={scrollContainerRef}>
        <Transcript
          ownerKey="task:paginate"
          events={baseEvents}
          hasMoreOlder
          onLoadOlder={onLoadOlder}
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );
    const scrollContainer = screen.getByTestId("transcript-scroll");
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get: () => contentHeight,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      get: () => 100,
    });
    await waitFor(() => expect(scrollContainer.scrollTop).toBe(900));

    fireEvent.wheel(scrollContainer, { deltaY: -40 });
    scrollContainer.scrollTop = 40;
    fireEvent.scroll(scrollContainer);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    // Still at top after request: latch must not cascade without leaving the band.
    fireEvent.scroll(scrollContainer);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    contentHeight = 1600;
    const olderEvents = Array.from({ length: 10 }, (_, index) =>
      event(`older-${index}`, "assistant", `Older ${index}`),
    );
    rerender(
      <div data-testid="transcript-scroll" ref={scrollContainerRef}>
        <Transcript
          ownerKey="task:paginate"
          events={[...olderEvents, ...baseEvents]}
          hasMoreOlder
          onLoadOlder={onLoadOlder}
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );

    await waitFor(() => expect(scrollContainer.scrollTop).toBe(640));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    // Leave the top band, then re-enter with upward intent for a second page.
    scrollContainer.scrollTop = 200;
    fireEvent.scroll(scrollContainer);
    fireEvent.wheel(scrollContainer, { deltaY: -20 });
    scrollContainer.scrollTop = 30;
    fireEvent.scroll(scrollContainer);
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
  });

  it("ignores reconstructed history while still flagging a changed tail", async () => {
    const scrollContainerRef = { current: null as HTMLDivElement | null };
    const firstResponse = event("assistant-1", "assistant", "First response.");
    const { rerender } = render(
      <div data-testid="transcript-scroll" ref={scrollContainerRef}>
        <Transcript events={[firstResponse]} scrollContainerRef={scrollContainerRef} />
      </div>,
    );
    const scrollContainer = screen.getByTestId("transcript-scroll");
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 220 });
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 100 });
    await waitFor(() => expect(scrollContainer.scrollTop).toBe(120));
    scrollContainer.scrollTop = 0;
    fireEvent.scroll(scrollContainer);

    rerender(
      <div data-testid="transcript-scroll" ref={scrollContainerRef}>
        <Transcript events={[{ ...firstResponse }]} scrollContainerRef={scrollContainerRef} />
      </div>,
    );
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).not.toBeInTheDocument();

    rerender(
      <div data-testid="transcript-scroll" ref={scrollContainerRef}>
        <Transcript
          events={[{ ...firstResponse, body: "First response, now with more detail." }]}
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );
    expect(screen.getByRole("button", { name: /Jump to latest/ })).toBeInTheDocument();
  });

  it("detects streamed text behind the compact live activity row", async () => {
    const scrollContainerRef = { current: null as HTMLDivElement | null };
    const liveActivity: TranscriptEvent = {
      ...event("activity-1", "activity", "1 tool"),
      title: "Activity",
      status: "running",
    };
    const { rerender } = render(
      <div data-testid="transcript-scroll" ref={scrollContainerRef}>
        <Transcript
          events={[event("assistant-1", "assistant", "Starting"), liveActivity]}
          running
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );
    const scrollContainer = screen.getByTestId("transcript-scroll");
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 220 });
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 100 });
    await waitFor(() => expect(scrollContainer.scrollTop).toBe(120));
    scrollContainer.scrollTop = 0;
    fireEvent.scroll(scrollContainer);

    rerender(
      <div data-testid="transcript-scroll" ref={scrollContainerRef}>
        <Transcript
          events={[event("assistant-1", "assistant", "Starting with more detail"), liveActivity]}
          running
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );

    expect(screen.getByRole("button", { name: /Jump to latest/ })).toBeInTheDocument();
  });

  it("observes layout size without installing a transcript subtree observer", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    const resizeObserver = vi.fn();
    const mutationObserver = vi.fn();
    class TestResizeObserver {
      constructor() {
        resizeObserver();
      }
      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;
    }
    class TestMutationObserver {
      constructor() {
        mutationObserver();
      }
      observe = vi.fn();
      takeRecords = vi.fn(() => []);
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("MutationObserver", TestMutationObserver);
    const scrollContainerRef = { current: null as HTMLDivElement | null };

    render(
      <div ref={scrollContainerRef}>
        <Transcript
          events={[event("assistant-1", "assistant", "First response.")]}
          scrollContainerRef={scrollContainerRef}
        />
      </div>,
    );

    expect(resizeObserver).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(mutationObserver).not.toHaveBeenCalled();
  });

  it("keeps the active run status compact while the response arrives", () => {
    const runningSince = "2026-07-11T12:01:00.000Z";
    const { rerender } = render(
      <Transcript events={[event("user-1", "user", "Start the task")]} running />,
    );

    expect(screen.getByText(/Thinking/)).toBeInTheDocument();
    rerender(
      <Transcript
        events={[
          event("user-1", "user", "Start the task"),
          {
            ...event("assistant-1", "assistant", "The response is streaming."),
            timestamp: runningSince,
          },
        ]}
        running
      />,
    );

    expect(screen.getByText(/Thinking/)).toBeInTheDocument();
  });

  it("shows the current command in the live narration line", () => {
    render(
      <Transcript
        events={[
          event("user-1", "user", "Run the checks"),
          {
            ...event("command-1", "tool", "pnpm test\nstill running"),
            activityType: "command",
            title: "Command",
            status: "running",
          },
        ]}
        running
      />,
    );

    expect(screen.getByText("Running pnpm test")).toBeInTheDocument();
  });

  it("shows Reading with a file basename in the live narration line", () => {
    render(
      <Transcript
        events={[
          event("user-1", "user", "Inspect the transcript"),
          {
            ...event("read-1", "tool", "apps/desktop/src/components/Transcript.tsx"),
            activityType: "file",
            title: "Read",
            filePath: "apps/desktop/src/components/Transcript.tsx",
            status: "running",
          },
        ]}
        running
      />,
    );

    expect(screen.getByText("Reading Transcript.tsx")).toBeInTheDocument();
    expect(screen.queryByText(/Working on/)).not.toBeInTheDocument();
  });

  it("shows Editing with a file basename in the live narration line", () => {
    render(
      <Transcript
        events={[
          event("user-1", "user", "Update the styles"),
          {
            ...event("edit-1", "tool", "apps/desktop/src/styles.css"),
            activityType: "file",
            title: "Editing",
            filePath: "apps/desktop/src/styles.css",
            status: "running",
          },
        ]}
        running
      />,
    );

    expect(screen.getByText("Editing styles.css")).toBeInTheDocument();
  });

  it("omits empty JSON placeholders from the live narration line", () => {
    render(
      <Transcript
        events={[
          event("user-1", "user", "Inspect something"),
          {
            ...event("read-1", "tool", "{}"),
            activityType: "tool",
            title: "Read",
            status: "running",
          },
        ]}
        running
      />,
    );

    expect(screen.getByText("Reading a file")).toBeInTheDocument();
    expect(screen.queryByText(/\{\}/)).not.toBeInTheDocument();
  });

  it("moves a trailing activity batch into the single live status row", () => {
    render(
      <Transcript
        events={[
          event("assistant-1", "assistant", "I will make the changes."),
          {
            id: "activity-1",
            kind: "activity",
            title: "Activity",
            body: "3 tools",
            timestamp: "2026-07-11T12:00:01.000Z",
            status: "success",
            children: [
              {
                ...event("tool-1", "tool", "Tool activity"),
                title: "Tool call",
                status: "success",
              },
            ],
          },
        ]}
        running
      />,
    );

    // The batch renders only inside the live status row, not as its own
    // transcript entry.
    expect(document.querySelectorAll(".activity-event--group")).toHaveLength(0);
    expect(screen.getByText("Using a tool")).toBeInTheDocument();

    // Opening the live row streams the batch's children as activity rows.
    fireEvent.click(screen.getByRole("button", { name: /Using a tool/ }));
    const stream = document.querySelector(".task-now-stream");
    expect(stream).not.toBeNull();
    expect(within(stream as HTMLElement).getByText("Tool call")).toBeInTheDocument();
    expect(within(stream as HTMLElement).getByText("Tool activity")).toBeInTheDocument();
  });

  it("expands a grouped activity loop and preserves nested tool details", () => {
    render(
      <Transcript
        events={[
          event("assistant-1", "assistant", "I will inspect the project."),
          {
            id: "group-1",
            kind: "activity",
            title: "Activity",
            body: "2 commands · 1 tool",
            timestamp: "2026-07-11T12:00:01.000Z",
            status: "success",
            children: [
              {
                ...event("command-1", "tool", "pnpm test"),
                activityType: "command",
                title: "Command",
                details: [{ label: "Output", body: "passed" }],
                status: "success",
              },
              {
                ...event("tool-1", "tool", "src/App.tsx"),
                activityType: "tool",
                title: "Read file",
                details: [{ label: "Input", body: "src/App.tsx" }],
                status: "success",
              },
            ],
          },
          event("assistant-2", "assistant", "The checks passed."),
        ]}
      />,
    );

    const group = screen.getByRole("button", { name: /Activity.*2 commands/ });
    expect(group.querySelector(".activity-event-disclosure")).not.toBeNull();
    expect(document.querySelector("button.activity-event-disclosure")).toBeNull();
    expect(screen.queryByText("passed")).not.toBeInTheDocument();
    fireEvent.click(group);
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Command.*pnpm test/ }));
    expect(screen.getByText("passed")).toBeInTheDocument();
  });

  it("shows an edited-file diff inline by default and exposes the Files quick action", () => {
    const onOpenFile = vi.fn();
    render(
      <Transcript
        events={[
          {
            ...event("file-1", "tool", "src/App.tsx"),
            activityType: "file",
            filePath: "src/App.tsx",
            title: "Edited",
            status: "success",
            changeStats: { additions: 1, deletions: 1 },
            expandedByDefault: true,
            diff: {
              path: "src/App.tsx",
              status: "modified",
              additions: 1,
              deletions: 1,
              staged: false,
              lines: [
                { kind: "hunk", content: "@@ -1,1 +1,1 @@" },
                { kind: "delete", oldNumber: 1, content: "old" },
                { kind: "add", newNumber: 1, content: "new" },
              ],
            },
          },
        ]}
        onOpenFile={onOpenFile}
      />,
    );

    const row = document.querySelector('[data-event-id="file-1"]') as HTMLElement;
    expect(within(row).getByText("Edited")).toBeInTheDocument();
    const fileLink = screen.getByRole("button", { name: "Open src/App.tsx in Files" });
    expect(fileLink).toHaveTextContent("App.tsx");
    expect(fileLink).toHaveAttribute("title", "src/App.tsx");
    expect(within(row).queryByText("src/App.tsx")).toBeNull();
    expect(screen.getByLabelText("1 lines added, 1 lines removed")).toBeInTheDocument();
    expect(row.querySelector(".lucide-pencil")).not.toBeNull();
    expect(row.querySelector(".activity-icon-pencil--writing")).toBeNull();
    expect(screen.getByRole("region", { name: "Diff for src/App.tsx" })).toBeInTheDocument();
    expect(document.querySelectorAll(".diff-line--add")).toHaveLength(1);
    expect(document.querySelectorAll(".diff-line--delete")).toHaveLength(1);

    fireEvent.click(fileLink);
    expect(onOpenFile).toHaveBeenCalledWith({ path: "src/App.tsx" });
  });

  it("shows basename for absolute edit paths and keeps the full path on hover and open", () => {
    const onOpenFile = vi.fn();
    const absolute =
      "/Users/lukekabbash/Documents/Code/integrator-3/apps/desktop/src/components/Transcript.tsx";
    render(
      <Transcript
        events={[
          {
            ...event("file-abs", "tool", absolute),
            activityType: "file",
            filePath: absolute,
            title: "Editing",
            status: "running",
            changeStats: { additions: 4, deletions: 0 },
          },
        ]}
        onOpenFile={onOpenFile}
      />,
    );

    const row = document.querySelector('[data-event-id="file-abs"]') as HTMLElement;
    expect(within(row).getByText("Editing")).toBeInTheDocument();
    expect(row.querySelector(".lucide-pencil")).not.toBeNull();
    expect(row.querySelector(".activity-icon-pencil--writing")).not.toBeNull();
    const fileLink = screen.getByRole("button", { name: `Open ${absolute} in Files` });
    expect(fileLink).toHaveTextContent("Transcript.tsx");
    expect(fileLink).toHaveAttribute("title", absolute);
    expect(screen.queryByText(absolute)).toBeNull();
    fireEvent.click(fileLink);
    expect(onOpenFile).toHaveBeenCalledWith({ path: absolute });
  });

  it("keeps Worked for collapsed by default and reveals nested activity on expand", () => {
    render(
      <Transcript
        events={[
          event("user-1", "user", "Please fix it"),
          {
            id: "worked-for-assistant-1",
            kind: "activity",
            title: "Worked for",
            body: "1m 35s",
            timestamp: "2026-07-11T12:00:01.000Z",
            status: "success",
            expandedByDefault: false,
            children: [
              event("assistant-mid", "assistant", "Looking into the failure."),
              {
                ...event("command-1", "tool", "pnpm test"),
                activityType: "command",
                title: "Command",
                status: "success",
              },
              {
                ...event("edit-1", "tool", "src/App.tsx"),
                activityType: "file",
                title: "Edited",
                filePath: "src/App.tsx",
                status: "success",
              },
            ],
          },
          event("assistant-1", "assistant", "Fixed."),
        ]}
      />,
    );

    const row = document.querySelector('[data-event-id="worked-for-assistant-1"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.classList.contains("activity-event--worked-for")).toBe(true);
    expect(within(row).getByText("Worked for")).toBeInTheDocument();
    expect(within(row).getByText("1m 35s")).toBeInTheDocument();
    expect(screen.queryByText("Looking into the failure.")).not.toBeInTheDocument();
    expect(screen.queryByText("pnpm test")).not.toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: /Worked for/ }));
    expect(screen.getByText("Looking into the failure.")).toBeInTheDocument();
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(
      row.querySelector('.activity-nested-assistant[data-event-id="assistant-mid"]'),
    ).not.toBeNull();
  });

  it("shows a quiet resumed cue on Worked for after an interruption", () => {
    render(
      <Transcript
        events={[
          event("user-1", "user", "Please fix it"),
          {
            id: "worked-for-assistant-1",
            kind: "activity",
            title: "Worked for",
            body: "42s",
            timestamp: "2026-07-11T12:00:01.000Z",
            status: "success",
            resumed: true,
            expandedByDefault: false,
            children: [
              {
                ...event("command-1", "tool", "pnpm test"),
                activityType: "command",
                title: "Command",
                status: "success",
              },
            ],
          },
          event("assistant-1", "assistant", "Fixed."),
        ]}
      />,
    );

    const cue = screen.getByLabelText("Resumed after interruption");
    expect(cue.tagName).toBe("EM");
    expect(cue).toHaveTextContent("resumed");
  });
});
