// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEvent } from "../bridge";
import { Transcript } from "./Transcript";

const event = (id: string, kind: TranscriptEvent["kind"], body: string): TranscriptEvent => ({
  id,
  kind,
  body,
  timestamp: "2026-07-11T12:00:00.000Z",
});

describe("Transcript", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
      <Transcript
        events={[event("assistant-1", "assistant", "Here are the steps:\n-")]}
        running
      />,
    );

    let response = screen.getByLabelText("Agent response");
    expect(response.querySelector("h2")).toBeNull();
    expect(response).toHaveTextContent("Here are the steps:");

    rerender(
      <Transcript
        events={[event("assistant-1", "assistant", "Here are the steps:\n- First")]}
        running
      />,
    );

    response = screen.getByLabelText("Agent response");
    expect(response.querySelector("h2")).toBeNull();
    expect(within(response).getByRole("list")).toBeInTheDocument();
    expect(within(response).getByRole("listitem")).toHaveTextContent("First");
  });

  it("keeps a finished thematic break but still suppresses aborted setext underlines", () => {
    const { rerender } = render(
      <Transcript events={[event("assistant-1", "assistant", "Done.\n\n---")]} />,
    );
    expect(screen.getByLabelText("Agent response").querySelector("hr")).not.toBeNull();

    rerender(
      <Transcript events={[event("assistant-1", "assistant", "Here are the steps:\n-")]} />,
    );
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

  it("shows jump-to-latest when new content arrives after scrolling away", () => {
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

  it("ignores reconstructed history while still flagging a changed tail", () => {
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

  it("detects streamed text behind the compact live activity row", () => {
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

    expect(screen.getByText(/Connecting/)).toBeInTheDocument();
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

    expect(screen.getByText(/Connecting/)).toBeInTheDocument();
  });

  it("shows Connecting without inventing reasoning activity", () => {
    render(
      <Transcript events={[event("user-1", "user", "Start the task")]} running />,
    );

    expect(screen.getByText(/Connecting/)).toBeInTheDocument();
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
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

    expect(screen.getByText("Working on pnpm test")).toBeInTheDocument();
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
    expect(screen.getByText("Activity")).toBeInTheDocument();
    expect(screen.getByText("3 tools")).toBeInTheDocument();
    expect(document.querySelector(".task-now-current")).toHaveTextContent(
      "Working on Tool call · Tool activity",
    );

    // Opening the live row streams the batch's children as activity rows.
    fireEvent.click(screen.getByRole("button", { name: /Activity.*3 tools/ }));
    const stream = document.querySelector(".task-now-stream");
    expect(stream).not.toBeNull();
    expect(
      within(stream as HTMLElement).getByRole("button", { name: /Tool call.*Tool activity/ }),
    ).toBeInTheDocument();
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

    expect(screen.getByRole("region", { name: "Diff for src/App.tsx" })).toBeInTheDocument();
    expect(document.querySelectorAll(".diff-line--add")).toHaveLength(1);
    expect(document.querySelectorAll(".diff-line--delete")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Open src/App.tsx in Files" }));
    expect(onOpenFile).toHaveBeenCalledWith("src/App.tsx");
  });
});
