import { describe, expect, it } from "vitest";

import {
  buildOmniboxSuggestions,
  looksLikeUrl,
  resolveOmniboxInput,
  SEARCH_ENGINES,
} from "./browserOmnibox";

describe("looksLikeUrl", () => {
  it("treats hosts, localhost, and schemes as addresses", () => {
    expect(looksLikeUrl("github.com")).toBe(true);
    expect(looksLikeUrl("https://linear.app/issue/1")).toBe(true);
    expect(looksLikeUrl("localhost:5173")).toBe(true);
    expect(looksLikeUrl("127.0.0.1:3000/app")).toBe(true);
    expect(looksLikeUrl("docs.react.dev/learn")).toBe(true);
  });

  it("sends words and phrases to search", () => {
    expect(looksLikeUrl("how to center a div")).toBe(false);
    expect(looksLikeUrl("react")).toBe(false);
    expect(looksLikeUrl("c++")).toBe(false);
    expect(looksLikeUrl("")).toBe(false);
  });
});

describe("resolveOmniboxInput", () => {
  it("returns empty for a blank field", () => {
    expect(resolveOmniboxInput("   ")).toEqual({ kind: "empty" });
    expect(resolveOmniboxInput("about:blank")).toEqual({ kind: "empty" });
  });

  it("passes addresses through for native normalize", () => {
    expect(resolveOmniboxInput("github.com")).toEqual({ kind: "url", href: "github.com" });
    expect(resolveOmniboxInput("localhost:5173")).toEqual({
      kind: "url",
      href: "localhost:5173",
    });
  });

  it("builds a Google search URL by default", () => {
    expect(resolveOmniboxInput("how to center a div")).toEqual({
      kind: "search",
      query: "how to center a div",
      engine: "google",
      href: SEARCH_ENGINES.google.searchUrl("how to center a div"),
    });
  });

  it("can search DuckDuckGo", () => {
    expect(resolveOmniboxInput("flexbox", "ddg")).toEqual({
      kind: "search",
      query: "flexbox",
      engine: "ddg",
      href: SEARCH_ENGINES.ddg.searchUrl("flexbox"),
    });
  });
});

describe("buildOmniboxSuggestions", () => {
  it("leads with search or go, then matching places", () => {
    const suggestions = buildOmniboxSuggestions(
      "git",
      {
        bookmarks: [{ url: "https://github.com", title: "GitHub" }],
        recents: [{ url: "https://gitlab.com", title: "GitLab" }],
        servers: [{ url: "http://localhost:5173", title: "vite", hint: "localhost:5173" }],
      },
      "google",
    );

    expect(suggestions[0]).toMatchObject({ kind: "search", title: "git" });
    expect(suggestions.map((entry) => entry.kind)).toEqual(["search", "recent", "bookmark"]);
  });

  it("lists places when the field is empty", () => {
    const suggestions = buildOmniboxSuggestions("", {
      bookmarks: [{ url: "https://github.com", title: "GitHub" }],
      recents: [{ url: "https://linear.app", title: "Linear" }],
      servers: [{ url: "http://localhost:5173", title: "vite", hint: "localhost:5173" }],
    });

    expect(suggestions.map((entry) => entry.kind)).toEqual(["recent", "bookmark", "server"]);
    expect(suggestions[0]).toMatchObject({ title: "Linear" });
  });

  it("dedupes a typed address against a bookmark", () => {
    const suggestions = buildOmniboxSuggestions(
      "github.com",
      { bookmarks: [{ url: "github.com", title: "GitHub" }] },
      "google",
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.kind).toBe("url");
  });
});
