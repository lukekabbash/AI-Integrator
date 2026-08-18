import { describe, expect, it, vi } from "vitest";

import { watchLayoutShift } from "./layoutShift";

describe("watchLayoutShift", () => {
  it("fires when a neighbour's transition ends and stops after dispose", () => {
    const row = document.createElement("div");
    const sidebar = document.createElement("aside");
    const pane = document.createElement("section");
    const slot = document.createElement("div");
    pane.append(slot);
    row.append(sidebar, pane);
    document.body.append(row);

    const onChange = vi.fn();
    const stop = watchLayoutShift(slot, onChange);
    onChange.mockClear();

    sidebar.dispatchEvent(new Event("transitionend", { bubbles: true }));
    expect(onChange).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("resize"));
    expect(onChange).toHaveBeenCalledTimes(2);

    stop();
    sidebar.dispatchEvent(new Event("transitionend", { bubbles: true }));
    expect(onChange).toHaveBeenCalledTimes(2);
    row.remove();
  });
});
