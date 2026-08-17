import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LazyMotion, domMax } from "motion/react";
import { describe, expect, it, vi } from "vitest";

import type { BrowserTab } from "../bridge";
import { BrowserDeck } from "./BrowserDeck";

function tab(id: string, title: string, heldBy?: string): BrowserTab {
  return {
    id,
    taskId: "task-1",
    url: `https://example.com/${id}`,
    title,
    loading: false,
    popped_out: false,
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

describe("BrowserDeck", () => {
  it("raises the newest tab and leaves the rest as chrome", () => {
    // Only one card can hold a webview: a native surface paints above HTML, so
    // stacking four of them would hide the deck under the top card.
    const { view } = deck([tab("t1", "One"), tab("t2", "Two"), tab("t3", "Three")]);
    const raised = view.container.querySelector(".browser-deck-card.raised");
    expect(raised).toHaveTextContent("Three");
    expect(raised?.querySelector(".browser-deck-page")).toBeInTheDocument();

    const behind = [...view.container.querySelectorAll(".browser-deck-card.behind")];
    expect(behind.map((card) => card.textContent)).toEqual(["One", "Two"]);
    for (const card of behind) {
      expect(card.querySelector(".browser-deck-page")).toBeNull();
    }
  });

  it("raises the card you click, and the page follows it", () => {
    const { view, onBoundsChange } = deck([tab("t1", "One"), tab("t2", "Two")]);
    onBoundsChange.mockClear();
    fireEvent.click(screen.getByTitle("One"));
    expect(view.container.querySelector(".browser-deck-card.raised")).toHaveTextContent("One");
    // The tab that lost the slot is parked, not closed.
    expect(onBoundsChange).toHaveBeenCalledWith("t2", null);
  });

  it("names the agent working in the raised tab, and never the user", () => {
    // With the pane closed this corner is the only place that can say which
    // page is moving by itself.
    const { view: agent } = deck([tab("t1", "One", "subagent fix-tests")]);
    expect(agent.container.querySelector(".browser-deck-card.raised")).toHaveAttribute(
      "data-busy",
      "true",
    );
    expect(agent.container.querySelector(".browser-deck-who")).toHaveTextContent(
      "subagent fix-tests",
    );

    const { view: mine } = deck([tab("t2", "Two", "you")]);
    expect(mine.container.querySelector(".browser-deck-card.raised")).not.toHaveAttribute(
      "data-busy",
    );
    expect(mine.container.querySelector(".browser-deck-who")).toBeNull();
  });

  it("counts the tabs it cannot show rather than stacking them all", () => {
    const many = ["a", "b", "c", "d", "e", "f"].map((id) => tab(id, id.toUpperCase()));
    const { view } = deck(many);
    expect(view.container.querySelectorAll(".browser-deck-card.behind")).toHaveLength(3);
    expect(screen.getByText("+2 more")).toBeInTheDocument();
  });

  it("parks the page when the deck goes away, and never closes the tab", () => {
    const { view, onBoundsChange, onClose } = deck([tab("t1", "One")]);
    onBoundsChange.mockClear();
    view.unmount();
    expect(onBoundsChange).toHaveBeenCalledWith("t1", null);
    expect(onClose).not.toHaveBeenCalled();
  });
});
