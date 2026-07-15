// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge, type TranscriptEvent } from "../bridge";
import { Transcript } from "./Transcript";
import { writeTranscriptViewportState } from "./transcriptViewportState";

let resizeObserverCallbacks: ResizeObserverCallback[] = [];

function activityEvent(index: number, body = `Activity ${index}`): TranscriptEvent {
  return {
    id: `activity-${index}`,
    kind: "tool",
    title: `Tool ${index}`,
    body,
    timestamp: "2026-07-15T12:00:00.000Z",
    status: "success",
  };
}

function renderWithViewport(events: TranscriptEvent[], ownerKey?: string) {
  const scrollRef = { current: null as HTMLDivElement | null };
  const result = render(
    <div
      data-testid="virtual-scroll"
      ref={(node) => {
        scrollRef.current = node;
        if (!node) return;
        Object.defineProperty(node, "clientHeight", { configurable: true, value: 400 });
        Object.defineProperty(node, "offsetHeight", { configurable: true, value: 400 });
        Object.defineProperty(node, "offsetWidth", { configurable: true, value: 800 });
        Object.defineProperty(node, "scrollHeight", {
          configurable: true,
          get: () => {
            const list = node.querySelector<HTMLElement>(".transcript-virtual-list");
            return Number.parseFloat(list?.style.height ?? "") || events.length * 40;
          },
        });
        Object.defineProperty(node, "scrollTo", {
          configurable: true,
          value: (options: ScrollToOptions) => {
            const requested = Number(options.top ?? 0);
            node.scrollTop = Math.max(
              0,
              Math.min(requested, node.scrollHeight - node.clientHeight),
            );
            node.dispatchEvent(new Event("scroll"));
          },
        });
      }}
      style={{ height: 400, overflowY: "auto" }}
    >
      <Transcript ownerKey={ownerKey} events={events} scrollContainerRef={scrollRef} />
    </div>,
  );
  return { ...result, scroll: () => screen.getByTestId("virtual-scroll") };
}

describe("Transcript measured virtualization", () => {
  beforeEach(() => {
    resizeObserverCallbacks = [];
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("transcript-virtual-row") ? 40 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the exact renderer through 250 rows", () => {
    const events = Array.from({ length: 250 }, (_, index) => activityEvent(index));
    renderWithViewport(events);

    expect(document.querySelector(".transcript-virtual-list")).toBeNull();
    expect(document.querySelectorAll(".activity-event")).toHaveLength(250);
  });

  it("bounds mounted rows above the threshold while retaining the full semantic size", async () => {
    const events = Array.from({ length: 1_000 }, (_, index) => activityEvent(index));
    renderWithViewport(events);

    await waitFor(() =>
      expect(document.querySelectorAll(".transcript-virtual-row").length).toBeGreaterThan(0),
    );
    const mountedRows = document.querySelectorAll(".transcript-virtual-row");
    expect(mountedRows.length).toBeLessThan(250);
    expect(document.querySelector(".transcript-virtual-list")).toHaveAttribute("role", "list");
    expect(mountedRows[0]).toHaveAttribute("aria-setsize", "1000");
    expect(document.querySelectorAll(".activity-event").length).toBe(mountedRows.length);
  });

  it("keeps a 100,000-event history DOM-bounded", async () => {
    const events = Array.from({ length: 100_000 }, (_, index) => activityEvent(index));
    renderWithViewport(events);

    await waitFor(() =>
      expect(document.querySelectorAll(".transcript-virtual-row").length).toBeGreaterThan(0),
    );
    expect(document.querySelectorAll(".transcript-virtual-row").length).toBeLessThan(250);
    expect(document.querySelector(".transcript-virtual-list")).toHaveStyle({ height: "3000000px" });
  });

  it("materializes an offscreen find result instead of falling back to the mounted DOM", async () => {
    const events = Array.from({ length: 500 }, (_, index) =>
      activityEvent(
        index,
        index === 173 ? "needle in remote history" : `ordinary activity ${index}`,
      ),
    );
    const { scroll } = renderWithViewport(events);

    await waitFor(() => expect(document.querySelector(".transcript-virtual-list")).not.toBeNull());
    fireEvent.keyDown(scroll(), { key: "f", metaKey: true });
    const input = await screen.findByRole("searchbox", { name: "Find in transcript" });
    fireEvent.change(input, { target: { value: "needle in remote history" } });

    await waitFor(() =>
      expect(
        document.querySelector('[data-event-id="activity-173"][data-search-current="true"]'),
      ).not.toBeNull(),
    );
    expect(screen.getByText("needle in remote history")).toBeInTheDocument();
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
  });

  it("does not repeat native attachment reads when a virtualized row remounts", async () => {
    const preview = vi
      .spyOn(bridge, "readAttachmentPreview")
      .mockResolvedValue("data:image/png;base64,cHJldmlldw==");
    const events = Array.from({ length: 500 }, (_, index) =>
      index === 173
        ? {
            id: "user-with-preview",
            kind: "user" as const,
            body: "Preview target\n\nAttached files:\n- /tmp/preview.png",
            timestamp: "2026-07-15T12:00:00.000Z",
          }
        : activityEvent(index, `ordinary activity ${index}`),
    );
    const { scroll } = renderWithViewport(events);

    fireEvent.keyDown(scroll(), { key: "f", metaKey: true });
    const input = await screen.findByRole("searchbox", { name: "Find in transcript" });
    fireEvent.change(input, { target: { value: "Preview target" } });
    await screen.findByRole("img", { name: "preview.png" });
    expect(preview).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: "ordinary activity 400" } });
    await waitFor(() => expect(screen.queryByRole("img", { name: "preview.png" })).toBeNull());
    fireEvent.change(input, { target: { value: "Preview target" } });
    await screen.findByRole("img", { name: "preview.png" });
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("keeps disclosure state when a measured row leaves and re-enters the window", async () => {
    const events = Array.from({ length: 500 }, (_, index) =>
      index === 173
        ? {
            ...activityEvent(index, "Expandable target"),
            id: "expandable-target",
            kind: "activity" as const,
            title: "Expandable activity",
            children: [activityEvent(900, "Persistent nested detail")],
          }
        : activityEvent(index, `ordinary activity ${index}`),
    );
    const { scroll } = renderWithViewport(events);

    fireEvent.keyDown(scroll(), { key: "f", metaKey: true });
    const input = await screen.findByRole("searchbox", { name: "Find in transcript" });
    fireEvent.change(input, { target: { value: "Expandable target" } });
    const disclosure = await screen.findByRole("button", {
      name: /Expandable activity.*Expandable target/,
    });
    fireEvent.click(disclosure);
    expect(screen.getByText("Persistent nested detail")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "ordinary activity 400" } });
    await waitFor(() => expect(screen.queryByText("Persistent nested detail")).toBeNull());
    fireEvent.change(input, { target: { value: "Expandable target" } });

    expect(await screen.findByText("Persistent nested detail")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Expandable activity.*Expandable target/ }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("reconciles a variable-height disclosure from its measured border box", async () => {
    const events = Array.from({ length: 500 }, (_, index) =>
      index === 173
        ? {
            ...activityEvent(index, "Measured disclosure target"),
            id: "measured-target",
            kind: "activity" as const,
            title: "Measured activity",
            children: [activityEvent(901, "A much taller nested detail")],
          }
        : activityEvent(index),
    );
    const { scroll } = renderWithViewport(events);

    fireEvent.keyDown(scroll(), { key: "f", metaKey: true });
    const input = await screen.findByRole("searchbox", { name: "Find in transcript" });
    fireEvent.change(input, { target: { value: "Measured disclosure target" } });
    const disclosure = await screen.findByRole("button", {
      name: /Measured activity.*Measured disclosure target/,
    });
    const row = disclosure.closest<HTMLElement>(".transcript-virtual-row");
    const list = document.querySelector<HTMLElement>(".transcript-virtual-list");
    expect(row).not.toBeNull();
    expect(list).not.toBeNull();
    const initialHeight = Number.parseFloat(list!.style.height);

    fireEvent.click(disclosure);
    const entry = {
      target: row!,
      borderBoxSize: [{ blockSize: 140, inlineSize: 800 }],
    } as unknown as ResizeObserverEntry;
    await act(async () => {
      resizeObserverCallbacks.forEach((callback) => callback([entry], {} as ResizeObserver));
    });

    await waitFor(() =>
      expect(Number.parseFloat(list!.style.height)).toBeGreaterThan(initialHeight),
    );
  });

  it("pins native selection endpoints while other history is materialized", async () => {
    const events = Array.from({ length: 500 }, (_, index) =>
      activityEvent(
        index,
        index === 173 ? "Selected historical text" : `ordinary activity ${index}`,
      ),
    );
    const { scroll } = renderWithViewport(events);

    fireEvent.keyDown(scroll(), { key: "f", metaKey: true });
    const input = await screen.findByRole("searchbox", { name: "Find in transcript" });
    fireEvent.change(input, { target: { value: "Selected historical text" } });
    const selectedText = await screen.findByText("Selected historical text");
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(selectedText);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    fireEvent.change(input, { target: { value: "ordinary activity 400" } });
    await screen.findByText("ordinary activity 400");
    expect(screen.getByText("Selected historical text")).toBeInTheDocument();
  });

  it("restores a long task by stable event id instead of a stale pixel offset", async () => {
    const events = Array.from({ length: 500 }, (_, index) => activityEvent(index));
    writeTranscriptViewportState("task:restore-test", {
      anchor: { eventId: "activity-173", offsetPx: 0 },
      following: false,
      expanded: {},
      updatedAt: Date.now(),
    });

    renderWithViewport(events, "task:restore-test");

    await waitFor(() =>
      expect(document.querySelector('[data-event-id="activity-173"]')).not.toBeNull(),
    );
    expect(screen.getByText("Activity 173")).toBeInTheDocument();
  });

  it("keeps mid-chat restore despite open-settle scroll noise", async () => {
    const events = Array.from({ length: 500 }, (_, index) => activityEvent(index));
    writeTranscriptViewportState("task:restore-settle-noise", {
      anchor: { eventId: "activity-173", offsetPx: 0 },
      following: false,
      expanded: {},
      updatedAt: Date.now(),
    });

    const { scroll } = renderWithViewport(events, "task:restore-settle-noise");
    scroll().scrollTop = 0;
    fireEvent.scroll(scroll());

    await waitFor(() =>
      expect(document.querySelector('[data-event-id="activity-173"]')).not.toBeNull(),
    );
    expect(screen.getByText("Activity 173")).toBeInTheDocument();
    // Settled restore must not invent follow-to-end from residual top scroll.
    await waitFor(() => {
      const latest = document.querySelector('[data-event-id="activity-499"]');
      expect(latest).toBeNull();
    });
  });

  it("follows latest on shared-parent remount for a virtualized chat", async () => {
    const scrollRef = { current: null as HTMLDivElement | null };
    const shortEvents = Array.from({ length: 10 }, (_, index) => activityEvent(index));
    const longEvents = Array.from({ length: 300 }, (_, index) => activityEvent(index + 1000));

    const { rerender } = render(
      <div
        data-testid="virtual-scroll"
        ref={(node) => {
          scrollRef.current = node;
          if (!node) return;
          Object.defineProperty(node, "clientHeight", { configurable: true, value: 400 });
          Object.defineProperty(node, "scrollHeight", {
            configurable: true,
            get: () => {
              const list = node.querySelector<HTMLElement>(".transcript-virtual-list");
              const count =
                Number(list?.style.height?.replace("px", "")) ||
                (node.querySelectorAll("[data-event-id]").length || 1) * 40;
              return count;
            },
          });
          Object.defineProperty(node, "scrollTo", {
            configurable: true,
            value: (options: ScrollToOptions) => {
              const requested = Number(options.top ?? 0);
              node.scrollTop = Math.max(
                0,
                Math.min(requested, node.scrollHeight - node.clientHeight),
              );
              node.dispatchEvent(new Event("scroll"));
            },
          });
        }}
        style={{ height: 400, overflow: "auto" }}
      >
        <Transcript
          key="short"
          ownerKey="task:virt-a"
          events={shortEvents}
          scrollContainerRef={scrollRef}
        />
      </div>,
    );

    await waitFor(() => expect(scrollRef.current?.scrollTop ?? 0).toBeGreaterThan(0));
    if (scrollRef.current) scrollRef.current.scrollTop = 0;

    rerender(
      <div
        data-testid="virtual-scroll"
        ref={(node) => {
          scrollRef.current = node;
          if (!node) return;
          Object.defineProperty(node, "clientHeight", { configurable: true, value: 400 });
          Object.defineProperty(node, "scrollHeight", {
            configurable: true,
            get: () => {
              const list = node.querySelector<HTMLElement>(".transcript-virtual-list");
              return Number.parseFloat(list?.style.height ?? "") || longEvents.length * 40;
            },
          });
          Object.defineProperty(node, "scrollTo", {
            configurable: true,
            value: (options: ScrollToOptions) => {
              const requested = Number(options.top ?? 0);
              node.scrollTop = Math.max(
                0,
                Math.min(requested, node.scrollHeight - node.clientHeight),
              );
              node.dispatchEvent(new Event("scroll"));
            },
          });
        }}
        style={{ height: 400, overflow: "auto" }}
      >
        <Transcript
          key="long"
          ownerKey="task:virt-b"
          events={longEvents}
          scrollContainerRef={scrollRef}
        />
      </div>,
    );
    fireEvent.scroll(scrollRef.current!);

    await waitFor(() => {
      const container = scrollRef.current!;
      const distance =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      expect(distance).toBeLessThanOrEqual(96);
    });
  });

  it("restores disclosure state from task-local view metadata", () => {
    const group: TranscriptEvent = {
      ...activityEvent(1, "One child"),
      id: "group",
      kind: "activity",
      title: "Activity",
      children: [activityEvent(2, "Persisted child")],
    };
    const first = render(<Transcript ownerKey="task:disclosure-test" events={[group]} />);
    fireEvent.click(screen.getByRole("button", { name: /Activity.*One child/ }));
    expect(screen.getByText("Persisted child")).toBeInTheDocument();
    first.unmount();

    render(<Transcript ownerKey="task:disclosure-test" events={[group]} />);
    expect(screen.getByText("Persisted child")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Activity.*One child/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
