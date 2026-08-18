import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LazyMotion, domMax } from "motion/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserTab } from "../bridge";
import { BrowserDeck } from "./BrowserDeck";
import { clampDeckOffset } from "./browserDeckModel";

function tab(id: string, title: string, heldBy?: string): BrowserTab {
  return {
    id,
    taskId: "task-1",
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

const cardTitles = (container: HTMLElement) =>
  [...container.querySelectorAll(".browser-deck-card .browser-deck-title")].map(
    (node) => node.textContent,
  );

describe("BrowserDeck", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("gives every tab a live card with its own page, newest nearest the corner", () => {
    // Native pages cannot overlap, so they are a column rather than a fan; but
    // every one of them shows, none is a picture of itself.
    const { view } = deck([tab("t1", "One"), tab("t2", "Two"), tab("t3", "Three")]);
    expect(cardTitles(view.container)).toEqual(["One", "Two", "Three"]);
    for (const card of view.container.querySelectorAll(".browser-deck-card")) {
      expect(card.querySelector(".browser-deck-page")).toBeInTheDocument();
    }
    expect(view.container.querySelector(".browser-deck-strip")).toBeNull();
  });

  it("paints each card's still under its page until the page arrives", () => {
    const { view } = deck([tab("t1", "One"), tab("t2", "Two")], {
      posters: { t1: "data:image/png;base64,ONE" },
    });
    const [first, second] = [...view.container.querySelectorAll(".browser-deck-page")];
    expect(first?.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,ONE");
    expect(second?.querySelector("img")).toBeNull();
  });

  it("puts the pane's active browser nearest the corner when the pane closes", () => {
    const { view } = deck([tab("t1", "One"), tab("t2", "Two"), tab("t3", "Three")], {
      preferredTabId: "t2",
    });
    expect(cardTitles(view.container)).toEqual(["One", "Three", "Two"]);
  });

  it("turns the oldest tabs into strips past the column's limit, and a click revives one", () => {
    const many = ["a", "b", "c", "d", "e", "f"].map((id) => tab(id, id.toUpperCase()));
    const { view, onBoundsChange } = deck(many);
    expect(cardTitles(view.container)).toEqual(["C", "D", "E", "F"]);
    const strips = [...view.container.querySelectorAll(".browser-deck-strip")];
    expect(strips.map((strip) => strip.textContent)).toEqual(["A", "B"]);

    onBoundsChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    expect(cardTitles(view.container)).toEqual(["D", "E", "F", "A"]);
    // The card that left the column is parked, not closed.
    expect(onBoundsChange).toHaveBeenCalledWith("c", null);
  });

  it("names the agent working in a tab, and never the user", () => {
    // With the pane closed this corner is the only place that can say which
    // page is moving by itself.
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

  it("parks every page when the deck goes away, and never closes a tab", () => {
    const { view, onBoundsChange, onClose } = deck([tab("t1", "One"), tab("t2", "Two")]);
    onBoundsChange.mockClear();
    view.unmount();
    expect(onBoundsChange).toHaveBeenCalledWith("t1", null);
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

  it("starts in the bottom-right and follows the grip when dragged, remembering where", () => {
    const { view } = deck([tab("t1", "One")]);
    const root = view.container.querySelector<HTMLElement>(".browser-deck");
    expect(root?.style.right).toBe("18px");
    expect(root?.style.bottom).toBe("18px");

    const grip = screen.getByRole("button", { name: "Move browser cards" });
    grip.setPointerCapture = vi.fn();
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 500, clientY: 500 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 400, clientY: 460 });
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 400, clientY: 460 });
    // Left by 100 grows `right`; up by 40 grows `bottom`. jsdom measures the
    // deck at 0×0, so nothing clamps here.
    expect(root?.style.right).toBe("118px");
    expect(root?.style.bottom).toBe("58px");
    expect(JSON.parse(localStorage.getItem("integrator.browserDeck.offset") ?? "{}")).toEqual({
      right: 118,
      bottom: 58,
    });

    view.unmount();
    const again = deck([tab("t1", "One")]);
    expect(again.view.container.querySelector<HTMLElement>(".browser-deck")?.style.right).toBe(
      "118px",
    );
  });

  it("clamps the offset so the deck stays inside the window", () => {
    const size = { width: 320, height: 240 };
    const viewport = { width: 1000, height: 800 };
    expect(clampDeckOffset({ right: -20, bottom: -5 }, size, viewport)).toEqual({
      right: 0,
      bottom: 0,
    });
    // 1000 - 320 = 680 right; 800 - 50 title bar - 240 = 510 bottom.
    expect(clampDeckOffset({ right: 5000, bottom: 5000 }, size, viewport)).toEqual({
      right: 680,
      bottom: 510,
    });
  });
});
