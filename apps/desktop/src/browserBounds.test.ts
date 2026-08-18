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

    await vi.waitFor(() => expect(setBounds).toHaveBeenCalledTimes(1));
    expect(setBounds).toHaveBeenLastCalledWith(
      "task-a",
      "tab-a",
      LATEST,
      "pane",
      false,
      expect.any(Number),
      expect.any(Number),
    );
    releases.shift()?.();
    await Promise.resolve();
    expect(setBounds).toHaveBeenCalledTimes(1);
  });

  it("finishes a rapid tab switch with only the newest tab placement", async () => {
    const releases: Array<() => void> = [];
    const setBounds = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const coordinator = new BrowserBoundsCoordinator({ setBounds }, false);

    coordinator.place("task-a", "tab-a", FIRST, "pane");
    coordinator.place("task-a", "tab-a", null, "pane");
    coordinator.place("task-a", "tab-b", LATEST, "pane");

    await vi.waitFor(() => expect(setBounds).toHaveBeenCalledTimes(1));
    expect(setBounds).toHaveBeenLastCalledWith(
      "task-a",
      "tab-b",
      LATEST,
      "pane",
      false,
      expect.any(Number),
      expect.any(Number),
    );
    releases.shift()?.();
  });

  it("lets a final hide replace every stale queued rectangle", async () => {
    const releases: Array<() => void> = [];
    const setBounds = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const coordinator = new BrowserBoundsCoordinator({ setBounds }, true);

    coordinator.place("task-a", "tab-a", FIRST, "popout");
    coordinator.place("task-a", "tab-a", SECOND, "popout");
    coordinator.place("task-a", "tab-a", null, "popout");

    await vi.waitFor(() => expect(setBounds).toHaveBeenCalledTimes(1));
    expect(setBounds).toHaveBeenLastCalledWith(
      "task-a",
      "tab-a",
      null,
      "popout",
      true,
      expect.any(Number),
      expect.any(Number),
    );
    releases.shift()?.();
    await Promise.resolve();
    expect(setBounds).toHaveBeenCalledTimes(1);
  });

  it("keeps a pane and compact card visible in independent native slots", async () => {
    const setBounds = vi.fn(() => new Promise<void>(() => undefined));
    const coordinator = new BrowserBoundsCoordinator({ setBounds }, false);

    coordinator.place("task-a", "pane-tab", FIRST, "pane");
    coordinator.place("task-a", "deck-tab", LATEST, "deck");

    await vi.waitFor(() => expect(setBounds).toHaveBeenCalledTimes(2));
    expect(setBounds).toHaveBeenCalledTimes(2);
    expect(setBounds).toHaveBeenNthCalledWith(
      1,
      "task-a",
      "pane-tab",
      FIRST,
      "pane",
      false,
      expect.any(Number),
      expect.any(Number),
    );
    expect(setBounds).toHaveBeenNthCalledWith(
      2,
      "task-a",
      "deck-tab",
      LATEST,
      "deck",
      false,
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("gives every deck card its own lane so all of them stay placed", async () => {
    // Two cards reporting in the same commit must both reach the native side;
    // a single deck lane would drop the first as superseded geometry.
    const setBounds = vi.fn(() => new Promise<void>(() => undefined));
    const coordinator = new BrowserBoundsCoordinator({ setBounds }, false);

    coordinator.place("task-a", "card-1", FIRST, "deck");
    coordinator.place("task-a", "card-2", LATEST, "deck");

    await vi.waitFor(() => expect(setBounds).toHaveBeenCalledTimes(2));
    const calls = setBounds.mock.calls as unknown as Array<unknown[]>;
    expect(calls.map((call) => call[1])).toEqual(["card-1", "card-2"]);
  });

  it("sends a new chat owner without waiting for a slow old placement", async () => {
    const releases: Array<() => void> = [];
    const setBounds = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const coordinator = new BrowserBoundsCoordinator({ setBounds }, false);

    coordinator.place("task-a", "tab-a", FIRST, "pane");
    await vi.waitFor(() => expect(setBounds).toHaveBeenCalledTimes(1));
    coordinator.place("task-b", "tab-b", LATEST, "pane");

    await vi.waitFor(() => expect(setBounds).toHaveBeenCalledTimes(2));
    const calls = setBounds.mock.calls as unknown as Array<unknown[]>;
    const firstRevision = calls[0]?.[6] as number | undefined;
    const secondRevision = calls[1]?.[6] as number | undefined;
    expect(secondRevision).toBeGreaterThan(firstRevision ?? 0);
    releases.forEach((release) => release());
  });
});
