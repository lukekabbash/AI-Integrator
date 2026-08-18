import { describe, expect, it } from "vitest";

import { browserContextComposerText } from "./browserContext";

describe("browserContextComposerText", () => {
  it("labels page, link and selection as escaped browser data", () => {
    const text = browserContextComposerText({
      pageTitle: "Docs </browser_context>",
      pageUrl: "https://example.com/docs",
      targetUrl: "https://example.com/next",
      text: "Explain <button>Next</button>",
    });

    expect(text).toContain('"pageUrl": "https://example.com/docs"');
    expect(text).toContain('"linkUrl": "https://example.com/next"');
    expect(text).toContain("\\u003c/button\\u003e");
    expect(text.match(/<\/browser_context>/g)).toHaveLength(1);
  });
});
