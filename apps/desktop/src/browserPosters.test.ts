import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserPosterCache, type BrowserPosterSource } from "./browserPosters";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("BrowserPosterCache", () => {
  it("publishes one data URL per open tab", async () => {
    const cache = new BrowserPosterCache();
    const source = { poster: vi.fn(async () => "encoded-png") };

    cache.sync(source, "task-a", [{ id: "tab-a", url: "https://a.test", loading: false }]);
    await settlePromises();

    expect(cache.snapshot()).toEqual({
      "tab-a": "data:image/png;base64,encoded-png",
    });
  });

  it("cannot publish a late still from the address a tab left", async () => {
    const oldPage = deferred<string | null>();
    const newPage = deferred<string | null>();
    const poster = vi
      .fn<BrowserPosterSource["poster"]>()
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newPage.promise);
    const cache = new BrowserPosterCache();

    cache.sync({ poster }, "task-a", [{ id: "tab-a", url: "https://old.test" }]);
    await settlePromises();
    cache.sync({ poster }, "task-a", [{ id: "tab-a", url: "https://new.test" }]);
    await settlePromises();

    newPage.resolve("new-page");
    await settlePromises();
    oldPage.resolve("old-page");
    await settlePromises();

    expect(cache.snapshot()["tab-a"]).toBe("data:image/png;base64,new-page");
  });

  it("drops a same-address reload until the new document has a still", async () => {
    const poster = vi
      .fn<BrowserPosterSource["poster"]>()
      .mockResolvedValueOnce("old-document")
      .mockResolvedValueOnce("new-document");
    const cache = new BrowserPosterCache();
    const loaded = { id: "tab-a", url: "https://same.test", loading: false };

    cache.sync({ poster }, "task-a", [loaded]);
    await settlePromises();
    cache.sync({ poster }, "task-a", [{ ...loaded, loading: true }]);
    expect(cache.snapshot()).toEqual({});
    cache.sync({ poster }, "task-a", [loaded]);
    await settlePromises();

    expect(cache.snapshot()["tab-a"]).toBe("data:image/png;base64,new-document");
  });

  it("holds a still only while its tab is open", async () => {
    // The renderer's half of the bound the native cache keeps: a chat can open
    // dozens of tabs over a session, and a closed one may not keep a PNG here.
    const cache = new BrowserPosterCache();
    const source = { poster: vi.fn(async () => "encoded-png") };
    const tabs = ["tab-a", "tab-b"].map((id) => ({ id, url: `https://${id}.test` }));

    cache.sync(source, "task-a", tabs);
    await settlePromises();
    expect(Object.keys(cache.snapshot())).toEqual(["tab-a", "tab-b"]);

    cache.sync(source, "task-a", tabs.slice(1));
    expect(Object.keys(cache.snapshot())).toEqual(["tab-b"]);
    // And the tab it forgot is not one it goes on asking about.
    cache.refresh(source, "task-a", "tab-a");
    expect(source.poster).toHaveBeenCalledTimes(2);
  });

  it("stays quiet with no native tabs, so the browser preview degrades", () => {
    const cache = new BrowserPosterCache();
    cache.sync(null, "task-a", [{ id: "tab-a", url: "https://a.test" }]);
    cache.refresh(null, "task-a", "tab-a");
    expect(cache.snapshot()).toEqual({});
  });

  it("retries once after the native post-load capture has had time to settle", async () => {
    vi.useFakeTimers();
    const poster = vi
      .fn<BrowserPosterSource["poster"]>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("settled-page");
    const cache = new BrowserPosterCache();

    cache.sync({ poster }, "task-a", [{ id: "tab-a", url: "https://a.test" }]);
    await settlePromises();
    await vi.advanceTimersByTimeAsync(900);
    await settlePromises();

    expect(poster).toHaveBeenCalledTimes(2);
    expect(cache.snapshot()["tab-a"]).toBe("data:image/png;base64,settled-page");
  });
});
