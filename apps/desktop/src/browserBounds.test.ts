import { describe, expect, it, vi } from "vitest";

import {
  BrowserBoundsCoordinator,
  toNativeBrowserBounds,
  type NativeBrowserBounds,
} from "./browserBounds";

const FIRST: NativeBrowserBounds = { x: 10, y: 20, width: 300, height: 200 };
const SECOND: NativeBrowserBounds = { x: 11, y: 20, width: 280, height: 200 };
const LATEST: NativeBrowserBounds = { x: 12, y: 20, width: 240, height: 200 };

describe("BrowserBoundsCoordinator", () => {
  it("rounds physical edges without leaving a scaled gap", () => {
    expect(
      toNativeBrowserBounds({ left: 10.49, top: 20.49, right: 30.51, bottom: 50.51 }, 1),
    ).toEqual({ x: 10, y: 20, width: 21, height: 31 });
  });

  it("serializes a host and sends only its newest pending resize", async () => {
    const releases: Array<() => void> = [];
    const setBounds = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const coordinator = new BrowserBoundsCoordinator({ setBounds }, false);

    coordinator.place("task-a", "tab-a", FIRST, "pane");
    coordinator.place("task-a", "tab-a", SECOND, "pane");
    coordinator.place("task-a", "tab-a", LATEST, "pane");

    expect(setBounds).toHaveBeenCalledTimes(1);
    expect(setBounds).toHaveBeenLastCalledWith("task-a", "tab-a", FIRST, "pane", false);
    releases.shift()?.();
    await vi.waitFor(() => expect(setBounds).toHaveBeenCalledTimes(2));
    expect(setBounds).toHaveBeenLastCalledWith("task-a", "tab-a", LATEST, "pane", false);
    releases.shift()?.();
  });

  it("finishes a rapid tab switch with only the newest tab placement", async () => {
    const releases: Array<() => void> = [];
    const setBounds = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const coordinator = new BrowserBoundsCoordinator({ setBounds }, false);

    coordinator.place("task-a", "tab-a", FIRST, "pane");
    coordinator.place("task-a", "tab-a", null, "pane");
    coordinator.place("task-a", "tab-b", LATEST, "pane");

    expect(setBounds).toHaveBeenCalledTimes(1);
    releases.shift()?.();
    await vi.waitFor(() => expect(setBounds).toHaveBeenCalledTimes(2));
    expect(setBounds).toHaveBeenLastCalledWith("task-a", "tab-b", LATEST, "pane", false);
    releases.shift()?.();
  });

  it("lets a final hide replace every stale queued rectangle", async () => {
    const releases: Array<() => void> = [];
    const setBounds = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const coordinator = new BrowserBoundsCoordinator({ setBounds }, true);

    coordinator.place("task-a", "tab-a", FIRST, "popout");
    coordinator.place("task-a", "tab-a", SECOND, "popout");
    coordinator.place("task-a", "tab-a", null, "popout");

    releases.shift()?.();
    await vi.waitFor(() => expect(setBounds).toHaveBeenCalledTimes(2));
    expect(setBounds).toHaveBeenLastCalledWith("task-a", "tab-a", null, "popout", true);
    releases.shift()?.();
    await Promise.resolve();
    expect(setBounds).toHaveBeenCalledTimes(2);
  });

  it("keeps a pane and compact card visible in independent native slots", () => {
    const setBounds = vi.fn(() => new Promise<void>(() => undefined));
    const coordinator = new BrowserBoundsCoordinator({ setBounds }, false);

    coordinator.place("task-a", "pane-tab", FIRST, "pane");
    coordinator.place("task-a", "deck-tab", LATEST, "deck");

    expect(setBounds).toHaveBeenCalledTimes(2);
    expect(setBounds).toHaveBeenNthCalledWith(1, "task-a", "pane-tab", FIRST, "pane", false);
    expect(setBounds).toHaveBeenNthCalledWith(2, "task-a", "deck-tab", LATEST, "deck", false);
  });
});
