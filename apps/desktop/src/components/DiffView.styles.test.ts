// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  expect(start, `Missing ${selector} CSS rule`).toBeGreaterThanOrEqual(0);
  return styles.slice(start, styles.indexOf("}", start) + 1);
}

describe("DiffView layout contract", () => {
  it("soft-wraps unified and split diffs without a horizontal width floor", () => {
    expect(rule(".diff-scroll")).toContain("overflow-x: hidden");
    expect(rule(".diff-table")).toContain("min-width: 0");
    expect(rule(".diff-table")).toContain("table-layout: fixed");
    expect(rule(".diff-table--split")).toContain("min-width: 0");
    for (const selector of [".diff-code", ".diff-split-code"]) {
      expect(rule(selector)).toContain("white-space: pre-wrap");
      expect(rule(selector)).toContain("overflow-wrap: anywhere");
    }
  });

  it("uses compact Review text and the shared chat size for task-view diffs", () => {
    expect(theme).toContain("--font-size-chat: calc(var(--font-size-body) - 0.5px)");
    expect(theme).toContain("--font-size-review-diff: max(8px, calc(var(--font-size-code) - 4px))");
    expect(rule(".diff-table")).toContain("font-size: var(--font-size-review-diff)");
    expect(rule(".diff-workspace--inline .diff-table")).toContain(
      "font-size: var(--font-size-chat)",
    );
    expect(rule(".turn--assistant")).toContain("font-size: var(--font-size-chat)");
  });

  it("uses a low-chrome compact toolbar and rail-sized file preview text", () => {
    expect(rule(".diff-header")).toContain("min-height: 38px");
    expect(rule(".diff-workspace")).toContain("overflow: hidden");
    expect(rule(".diff-layout-toggle button")).toContain("border: 0");
    expect(rule(".diff-layout-toggle button")).toContain("background: transparent");
    expect(rule(".diff-header-icon-button")).toContain("width: 26px");
    expect(rule(".diff-review-button")).toContain("font-size: 10.5px");
    expect(rule(".file-reader-lines")).toContain("font-size: 10.5px");
  });

  it("keeps the active hunk marker pinned inside the contained code scroller", () => {
    const scroller = rule(".diff-scroll");
    const hunk = rule(".diff-line--hunk > th");

    expect(scroller).toContain("overscroll-behavior: contain");
    expect(scroller).toContain("scroll-padding-top: 26px");
    expect(hunk).toContain("position: sticky");
    expect(hunk).toContain("top: 0");
    expect(hunk).toContain("z-index: 2");
    expect(hunk).toContain("background:");
    expect(styles).toContain("border-color: CanvasText");
    expect(styles).toContain("background: Canvas");
  });
});
