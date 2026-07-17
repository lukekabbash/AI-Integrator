import { describe, expect, it } from "vitest";
import {
  normalizeStreamedMarkdown,
  repairStreamedTables,
  stabilizeStreamingMarkdown,
} from "./streamStableMarkdown";

describe("normalizeStreamedMarkdown", () => {
  it("repairs numbered headings that arrive without markdown whitespace", () => {
    expect(normalizeStreamedMarkdown("Intro. ###1. First gridPhoto tiles\n###2. Second")).toBe(
      "Intro.\n\n### 1. First grid\n\nPhoto tiles\n### 2. Second",
    );
  });

  it("repairs glued sentence starts without changing inline code", () => {
    expect(
      normalizeStreamedMarkdown(
        "fetchesFolder extract uses `downloadItemsAsZip` and possibleKeep direct play",
      ),
    ).toBe("fetches\n\nFolder extract uses `downloadItemsAsZip` and possible\n\nKeep direct play");
  });

  it("separates a glued bold fix label and list item", () => {
    expect(
      normalizeStreamedMarkdown(
        "The fetch is slow. **Fix:** use a cache\nroute-split- **AbortController**",
      ),
    ).toBe("The fetch is slow.\n\n**Fix:** use a cache\nroute-split\n- **AbortController**");
  });

  it("does not rewrite fenced code", () => {
    const code = "```md\n###1. literal\nroute-split- **literal**\n```";
    expect(normalizeStreamedMarkdown(code)).toBe(code);
  });

  it("leaves ordinary prose without numbered headings alone", () => {
    expect(normalizeStreamedMarkdown("Use ### as a literal marker.")).toBe(
      "Use ### as a literal marker.",
    );
  });
});

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

describe("repairStreamedTables", () => {
  it("splits a header/delimiter/rows table glued onto one line", () => {
    const glued =
      "Every provider has two faces:\n" +
      "| Role | Shape | Examples ||------|--------|----------|| **Wire** | slug | `gpt-5.6-sol` || **Display** | title case | `GPT5.6 Sol` |\n" +
      "And each product invents its own dialect:";
    expect(repairStreamedTables(glued)).toBe(
      "Every provider has two faces:\n" +
        "| Role | Shape | Examples |\n" +
        "|------|--------|----------|\n" +
        "| **Wire** | slug | `gpt-5.6-sol` |\n" +
        "| **Display** | title case | `GPT5.6 Sol` |\n" +
        "\n" +
        "And each product invents its own dialect:",
    );
  });

  it("inserts the blank line a table needs so trailing prose isn't absorbed as a phantom row", () => {
    // Already has real newlines between rows, just no blank line after the
    // last one — remark-gfm would otherwise fold "Done." into the table.
    const table = "| A | B |\n|---|---|\n| 1 | 2 |\nDone.";
    expect(repairStreamedTables(table)).toBe("| A | B |\n|---|---|\n| 1 | 2 |\n\nDone.");
  });

  it("splits chained seams even when a cell lands empty on one", () => {
    // Header + delimiter + row + (empty-first-cell row), all glued on one line.
    // The lone "|" left over from the empty cell doesn't look like a row, so
    // it (and the fragment after it) fall out of the table as plain text —
    // an imperfect but harmless read of a pathological, real-world-unseen input.
    const glued = "|h1|h2||---|---||a1|a2|||b2|";
    expect(repairStreamedTables(glued)).toBe("|h1|h2|\n|---|---|\n|a1|a2|\n\n|\n|b2|");
  });

  it("leaves boolean `||` in code alone when no delimiter row is present", () => {
    const code = "Use `if (a || b)` to short-circuit.";
    expect(repairStreamedTables(code)).toBe(code);
  });

  it("leaves an already-correct table alone", () => {
    const table = "| A | B |\n|---|---|\n| 1 | 2 |";
    expect(repairStreamedTables(table)).toBe(table);
  });

  it("leaves text without any pipes alone", () => {
    expect(repairStreamedTables("Just a sentence.")).toBe("Just a sentence.");
  });
});
