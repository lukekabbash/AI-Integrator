// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  afterEach(() => vi.restoreAllMocks());

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
});
