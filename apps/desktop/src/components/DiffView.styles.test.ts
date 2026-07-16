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

  it("keeps diff gutters compact and distinct from the file-pane editor gutter", () => {
    expect(rule(".diff-line-number")).toContain("font-size: 9px");
    expect(rule(".diff-line-number")).toContain("font-variant-numeric: tabular-nums");
    expect(rule(".diff-column-number")).toContain("width: 36px");
    expect(rule(".file-code-gutter")).toContain("width: 3.25rem");
    expect(rule(".file-code-line-number")).toContain("position: absolute");
    expect(rule(".file-indent-guide")).toContain("border-left: 1px solid");
    expect(rule(".file-indent-guide")).toContain("height: 1lh");
    expect(rule(".file-indent-guide")).not.toMatch(/border(?:-left)?:\s*[^;]*dashed/);
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

  it("hangs transcript diffs off the activity indent with no rail down their left", () => {
    const review = rule(".activity-diff-review");

    expect(review).toContain("margin: 4px 0 8px 25px");
    expect(review).not.toContain("border-left");
  });

  it("keeps the inline action pair from being squeezed by the file title", () => {
    // .diff-file-title holds flex: 1, so the pair only stays glued to the
    // counts while it refuses to flex.
    expect(rule(".diff-file-title")).toContain("flex: 1");
    expect(rule(".diff-inline-actions")).toContain("flex: none");
    expect(rule(".diff-inline-action")).toContain("white-space: nowrap");
  });
});
