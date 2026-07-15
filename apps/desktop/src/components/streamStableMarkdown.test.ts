import { describe, expect, it } from "vitest";
import { stabilizeStreamingMarkdown } from "./streamStableMarkdown";

describe("stabilizeStreamingMarkdown", () => {
  it("holds back a trailing bare dash so setext headings do not flash", () => {
    expect(stabilizeStreamingMarkdown("Here are the steps:\n-")).toBe("Here are the steps:");
    expect(stabilizeStreamingMarkdown("Here are the steps:\n- ")).toBe("Here are the steps:");
    expect(stabilizeStreamingMarkdown("Here are the steps:\n---")).toBe("Here are the steps:");
    expect(stabilizeStreamingMarkdown("Here are the steps:\n=")).toBe("Here are the steps:");
  });

  it("holds back bare *, +, and ordered markers without item text", () => {
    expect(stabilizeStreamingMarkdown("Intro\n* ")).toBe("Intro");
    expect(stabilizeStreamingMarkdown("Intro\n+")).toBe("Intro");
    expect(stabilizeStreamingMarkdown("Intro\n1. ")).toBe("Intro");
    expect(stabilizeStreamingMarkdown("Intro\n12)")).toBe("Intro");
  });

  it("keeps complete list items and nested continuations", () => {
    expect(stabilizeStreamingMarkdown("Here are the steps:\n- First")).toBe(
      "Here are the steps:\n- First",
    );
    expect(stabilizeStreamingMarkdown("Here are the steps:\n- First\n- Second")).toBe(
      "Here are the steps:\n- First\n- Second",
    );
    expect(stabilizeStreamingMarkdown("Intro\n- First\n-")).toBe("Intro\n- First");
    expect(stabilizeStreamingMarkdown("Intro\n- First\n- ")).toBe("Intro\n- First");
  });

  it("holds thematic-break candidates while streaming, then allows them when finished", () => {
    expect(stabilizeStreamingMarkdown("Done.\n\n---", true)).toBe("Done.\n");
    expect(stabilizeStreamingMarkdown("Done.\n\n---", false)).toBe("Done.\n\n---");
  });

  it("still holds a lone dash after a paragraph when the turn has finished", () => {
    expect(stabilizeStreamingMarkdown("Here are the steps:\n-", false)).toBe("Here are the steps:");
  });

  it("leaves ordinary paragraphs and single-line content alone", () => {
    expect(stabilizeStreamingMarkdown("Just a sentence.")).toBe("Just a sentence.");
    expect(stabilizeStreamingMarkdown("- already an item")).toBe("- already an item");
    expect(stabilizeStreamingMarkdown("")).toBe("");
  });
});
