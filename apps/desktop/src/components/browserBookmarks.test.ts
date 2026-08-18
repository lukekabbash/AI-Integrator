// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  isBrowserBookmarked,
  readBrowserBookmarks,
  removeBrowserBookmark,
  toggleBrowserBookmark,
} from "./browserBookmarks";

afterEach(() => {
  window.localStorage.clear();
});

describe("browserBookmarks", () => {
  it("pins and unpins a page across the installation", () => {
    expect(toggleBrowserBookmark("https://github.com", "GitHub")).toBe(true);
    expect(isBrowserBookmarked("https://github.com")).toBe(true);
    expect(readBrowserBookmarks()[0]).toMatchObject({
      url: "https://github.com",
      title: "GitHub",
    });

    expect(toggleBrowserBookmark("https://github.com", "GitHub")).toBe(false);
    expect(isBrowserBookmarked("https://github.com")).toBe(false);
  });

  it("ignores about:blank and empty addresses", () => {
    expect(toggleBrowserBookmark("about:blank", "New tab")).toBe(false);
    expect(toggleBrowserBookmark("", "Nope")).toBe(false);
    expect(readBrowserBookmarks()).toEqual([]);
  });

  it("removes a pin without touching the others", () => {
    toggleBrowserBookmark("https://a.example", "A");
    toggleBrowserBookmark("https://b.example", "B");
    removeBrowserBookmark("https://a.example");
    expect(readBrowserBookmarks().map((entry) => entry.url)).toEqual(["https://b.example"]);
  });
});
