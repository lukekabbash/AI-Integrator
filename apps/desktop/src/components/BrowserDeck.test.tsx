import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LazyMotion, domMax } from "motion/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NATIVE_PAGE_DECK_OCCLUSION_ATTR } from "../useModalOpen";
import type { BrowserTab } from "../bridge";
import { BrowserDeck } from "./BrowserDeck";
import { clampDeckOffset } from "./browserDeckModel";

function tab(id: string, title: string, heldBy?: string): BrowserTab {
  return {
    id,
    taskId: "task-1",
    groupId: "project:test",
    groupName: "Test project",
    groupKind: "project",
    url: `https://example.com/${id}`,
    title,
    loading: false,
    poppedOut: false,
    hidden: true,
    sleeping: false,
    ...(heldBy ? { heldBy } : {}),
  } as BrowserTab;
}

function deck(tabs: BrowserTab[], overrides: Partial<Parameters<typeof BrowserDeck>[0]> = {}) {
  const onBoundsChange = vi.fn();
  const onExpand = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <LazyMotion features={domMax} strict>
      <BrowserDeck
        tabs={tabs}
        onBoundsChange={onBoundsChange}
        onExpand={onExpand}
        onClose={onClose}
        {...overrides}
      />
    </LazyMotion>,
  );
  return { view, onBoundsChange, onExpand, onClose };
}

const faceTitle = (container: HTMLElement) =>
  container.querySelector(".browser-deck-card[data-depth='0'] .browser-deck-title")?.textContent;

/** Waits for a card that left the front to finish leaving, and for the new
 *  face to have its page placed. */
const settled = async (container: HTMLElement) => {
  await waitFor(() => {
    expect(container.querySelectorAll(".browser-deck-card[data-depth='0']")).toHaveLength(1);
    expect(container.querySelector(".browser-deck-card[data-depth='0']")).toHaveAttribute(
      "data-live",
      "true",
    );
  });
};

const peekTitles = (container: HTMLElement) =>
  [...container.querySelectorAll(".browser-deck-card[data-peek='true'] .browser-deck-title")].map(
    (node) => node.textContent,
  );

describe("BrowserDeck", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute(NATIVE_PAGE_DECK_OCCLUSION_ATTR);
  });

  it("keeps one live face and peeks the cards immediately behind it", () => {
    const { view, onBoundsChange } = deck([tab("t1", "One"), tab("t2", "Two"), tab("t3", "Three")]);
    expect(faceTitle(view.container)).toBe("Three");
    expect(peekTitles(view.container)).toEqual(["One", "Two"]);
    expect(view.container.querySelectorAll(".browser-deck-card[data-depth='0']")).toHaveLength(1);
    expect(view.container.querySelector(".browser-deck-strip")).toBeNull();
    expect(onBoundsChange).not.toHaveBeenCalledWith("t1", expect.anything());
    expect(onBoundsChange).not.toHaveBeenCalledWith("t2", expect.anything());
  });

  it("paints each card's still under its page until the page arrives", () => {
    const { view } = deck([tab("t1", "One"), tab("t2", "Two")], {
      posters: { t1: "data:image/png;base64,ONE", t2: "data:image/png;base64,TWO" },
    });
    const face = view.container.querySelector(
      ".browser-deck-card[data-depth='0'] .browser-deck-page",
    );
    const peek = view.container.querySelector(
      ".browser-deck-card[data-peek='true'] .browser-deck-page",
    );
    expect(face?.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,TWO");
    expect(peek?.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,ONE");
  });

  it("puts the pane's active browser on the face when the pane closes", () => {
    const { view } = deck([tab("t1", "One"), tab("t2", "Two"), tab("t3", "Three")], {
      preferredTabId: "t2",
    });
    expect(faceTitle(view.container)).toBe("Two");
  });

  it("cycles with the face arrows and parks the card that leaves the front", async () => {
    const many = ["a", "b", "c", "d", "e", "f"].map((id) => tab(id, id.toUpperCase()));
    const { view, onBoundsChange } = deck(many);
    expect(faceTitle(view.container)).toBe("F");
    expect(peekTitles(view.container)).toEqual(["D", "E"]);
    await settled(view.container);

    const prev = screen.getByRole("button", { name: "Previous browser card" });
    const next = screen.getByRole("button", { name: "Next browser card" });
    // The arrows sit over the face's title strip but belong to the stack, so
    // they survive the face being swapped out under them and keep focus.
    expect(prev.closest(".browser-deck-card")).toBeNull();
    expect(prev.closest(".browser-deck-nav")).not.toBeNull();
    expect(prev.closest(".browser-deck-stack")).not.toBeNull();
    expect(view.container.querySelector(".browser-deck-count")).toHaveTextContent("6/6");
    next.focus();

    onBoundsChange.mockClear();
    fireEvent.click(next);
    // The old face parks at once and shuffles out under the pile; the new
    // face is placed once it has slid into place.
    expect(onBoundsChange).toHaveBeenCalledWith("f", null);
    await settled(view.container);
    expect(faceTitle(view.container)).toBe("E");
    expect(peekTitles(view.container)).toEqual(["C", "D"]);
    expect(view.container.querySelector(".browser-deck-count")).toHaveTextContent("5/6");
    expect(document.activeElement).toBe(next);

    fireEvent.click(prev);
    await settled(view.container);
    expect(faceTitle(view.container)).toBe("F");
  });

  it("turns the pile with the wheel over the strip and with the arrow keys", () => {
    const { view } = deck([tab("a", "A"), tab("b", "B"), tab("c", "C")]);
    const bar = view.container.querySelector<HTMLElement>(
      ".browser-deck-card[data-depth='0'] .browser-deck-bar",
    )!;
    fireEvent.wheel(bar, { deltaY: 60 });
    expect(faceTitle(view.container)).toBe("B");
    // A second notch inside the rest window is ignored, so a flick is one card.
    fireEvent.wheel(bar, { deltaY: 60 });
    expect(faceTitle(view.container)).toBe("B");

    const stack = view.container.querySelector<HTMLElement>(".browser-deck-stack")!;
    fireEvent.keyDown(stack, { key: "ArrowRight" });
    expect(faceTitle(view.container)).toBe("A");
    fireEvent.keyDown(stack, { key: "ArrowLeft" });
    expect(faceTitle(view.container)).toBe("B");
  });

  it("hides the arrows and count on a deck of one", () => {
    deck([tab("only", "Only")]);
    expect(screen.queryByRole("button", { name: "Next browser card" })).toBeNull();
    expect(document.querySelector(".browser-deck-count")).toBeNull();
  });

  it("brings a peeked card to the front when it is clicked", () => {
    const { view } = deck([tab("t1", "One"), tab("t2", "Two"), tab("t3", "Three")]);
    fireEvent.click(view.container.querySelector(".browser-deck-card[data-peek='true']")!);
    expect(faceTitle(view.container)).toBe("One");
  });

  it("opens the face in the pane on a title-bar double-click", () => {
    const { view, onExpand } = deck([tab("t1", "One")]);
    fireEvent.doubleClick(view.container.querySelector(".browser-deck-bar")!);
    expect(onExpand).toHaveBeenCalledWith("t1");
  });

  it("names the agent working in a tab, and never the user", () => {
    const { view: agent } = deck([tab("t1", "One", "subagent fix-tests")]);
    expect(agent.container.querySelector(".browser-deck-card")).toHaveAttribute(
      "data-busy",
      "true",
    );
    expect(agent.container.querySelector(".browser-deck-who")).toHaveTextContent(
      "subagent fix-tests",
    );

    const { view: mine } = deck([tab("t2", "Two", "you")]);
    expect(mine.container.querySelector(".browser-deck-card")).not.toHaveAttribute("data-busy");
    expect(mine.container.querySelector(".browser-deck-who")).toBeNull();
  });

  it("parks the face when the deck goes away, and never closes a tab", async () => {
    const { view, onBoundsChange, onClose } = deck([tab("t1", "One"), tab("t2", "Two")]);
    await settled(view.container);
    onBoundsChange.mockClear();
    view.unmount();
    expect(onBoundsChange).toHaveBeenCalledWith("t2", null);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps recent agent work protected but lets an idle card close", () => {
    const protectedDeck = deck([tab("agent-tab", "Agent page")], {
      protectedTabIds: new Set(["agent-tab"]),
    });
    expect(
      screen.getByRole("button", { name: "Browser tab preserved for recent agent work" }),
    ).toBeDisabled();
    expect(protectedDeck.onClose).not.toHaveBeenCalled();
    protectedDeck.view.unmount();

    const idleDeck = deck([tab("idle-tab", "Idle page")]);
    fireEvent.click(screen.getByRole("button", { name: "Close browser tab" }));
    expect(idleDeck.onClose).toHaveBeenCalledWith("idle-tab");
  });

  it("starts in the bottom-right and follows the face header when dragged", async () => {
    const { view } = deck([tab("t1", "One")]);
    const root = view.container.querySelector<HTMLElement>(".browser-deck");
    expect(root?.style.right).toBe("18px");
    expect(root?.style.bottom).toBe("18px");

    const bar = view.container.querySelector<HTMLElement>(".browser-deck-bar")!;
    bar.setPointerCapture = vi.fn();
    const face = () => view.container.querySelector(".browser-deck-card[data-depth='0']");
    await settled(view.container);
    fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 500, clientY: 500 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 400, clientY: 460 });
    expect(document.documentElement).toHaveAttribute(NATIVE_PAGE_DECK_OCCLUSION_ATTR);
    expect(root).toHaveAttribute("data-phase", "dragging");
    // In the air the face is its own still; the page never chases the pointer.
    expect(face()).not.toHaveAttribute("data-live");
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 400, clientY: 460 });
    expect(root?.style.right).toBe("118px");
    expect(root?.style.bottom).toBe("58px");
    expect(JSON.parse(localStorage.getItem("integrator.browserDeck.offset") ?? "{}")).toEqual({
      right: 118,
      bottom: 58,
    });
    // It lands after the settle: the pane's page is released and the face is live again.
    expect(root).toHaveAttribute("data-phase", "settling");
    expect(document.documentElement).toHaveAttribute(NATIVE_PAGE_DECK_OCCLUSION_ATTR);
    await waitFor(() => expect(root).toHaveAttribute("data-phase", "rest"));
    expect(document.documentElement).not.toHaveAttribute(NATIVE_PAGE_DECK_OCCLUSION_ATTR);
    await waitFor(() => expect(face()).toHaveAttribute("data-live", "true"));

    view.unmount();
    const again = deck([tab("t1", "One")]);
    expect(again.view.container.querySelector<HTMLElement>(".browser-deck")?.style.right).toBe(
      "118px",
    );
  });

  it("rests where it is dropped, and parks the page while it sits on it", async () => {
    // A pane page is a native webview: the deck cannot paint over a live one,
    // so when it rests on the slot the page stands down (its still shows
    // under the cards, refreshed by the surface) and comes back when the deck
    // moves off. The deck itself goes wherever it is put.
    const pane = document.createElement("div");
    pane.className = "browser-viewport";
    pane.dataset.native = "true";
    pane.getBoundingClientRect = () =>
      ({ left: 200, top: 100, right: 600, bottom: 700, width: 400, height: 600 }) as DOMRect;
    document.body.appendChild(pane);
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    try {
      const { view } = deck([tab("t1", "One")]);
      const root = view.container.querySelector<HTMLElement>(".browser-deck")!;
      root.getBoundingClientRect = () =>
        ({ width: 336, height: 218, left: 0, top: 0, right: 336, bottom: 218 }) as DOMRect;
      const bar = view.container.querySelector<HTMLElement>(".browser-deck-bar")!;
      bar.setPointerCapture = vi.fn();

      // Dropped over the transcript, right of nothing: it stays exactly there
      // and the page is left alone.
      fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 900, clientY: 700 });
      fireEvent.pointerMove(bar, { pointerId: 1, clientX: 900, clientY: 640 });
      fireEvent.pointerUp(bar, { pointerId: 1, clientX: 900, clientY: 640 });
      expect(root.style.right).toBe("18px");
      expect(root.style.bottom).toBe("78px");
      await waitFor(() => expect(root).toHaveAttribute("data-phase", "rest"));
      await waitFor(() =>
        expect(document.documentElement).not.toHaveAttribute("data-browser-deck-occluding"),
      );

      // Dropped on the page (deck left edge at 1000-500-336 = 164, over
      // x 200..600): it stays there, and the page parks under it.
      fireEvent.pointerDown(bar, { button: 0, pointerId: 2, clientX: 900, clientY: 640 });
      fireEvent.pointerMove(bar, { pointerId: 2, clientX: 418, clientY: 640 });
      fireEvent.pointerUp(bar, { pointerId: 2, clientX: 418, clientY: 640 });
      expect(root.style.right).toBe("500px");
      expect(root.style.bottom).toBe("78px");
      await waitFor(() => expect(root).toHaveAttribute("data-phase", "rest"));
      await waitFor(() =>
        expect(document.documentElement).toHaveAttribute("data-browser-deck-occluding"),
      );
      expect(JSON.parse(localStorage.getItem("integrator.browserDeck.offset") ?? "{}")).toEqual({
        right: 500,
        bottom: 78,
      });
    } finally {
      pane.remove();
      document.documentElement.removeAttribute("data-browser-deck-occluding");
    }
  });

  it("clamps the offset so the deck stays inside the window", () => {
    const size = { width: 320, height: 240 };
    const viewport = { width: 1000, height: 800 };
    expect(clampDeckOffset({ right: -20, bottom: -5 }, size, viewport)).toEqual({
      right: 0,
      bottom: 0,
    });
    expect(clampDeckOffset({ right: 5000, bottom: 5000 }, size, viewport)).toEqual({
      right: 680,
      bottom: 510,
    });
  });
});
