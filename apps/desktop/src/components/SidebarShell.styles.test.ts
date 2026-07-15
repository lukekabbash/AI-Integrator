// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  expect(start, `Missing ${selector} CSS rule`).toBeGreaterThanOrEqual(0);
  return styles.slice(start, styles.indexOf("}", start) + 1);
}

describe("sidebar shell corners", () => {
  it("uses the appearance panel radius for the two inner top corners", () => {
    expect(rule(".task-sidebar")).toContain("border-top-right-radius: var(--radius-panel)");
    expect(rule(".right-rail")).toContain("border-top-left-radius: var(--radius-panel)");
    expect(rule(".settings-navigation")).toContain("border-top-right-radius: var(--radius-panel)");
  });

  it("rounds only the top-level Review and file headers", () => {
    const header = rule(
      ".workspace-content > .diff-workspace > .diff-header,\n" +
        ".workspace-content > .file-workspace > .file-workspace-header",
    );

    expect(header).toContain("border-top-left-radius: var(--radius-panel)");
    expect(header).toContain("border-top-right-radius: var(--radius-panel)");
  });

  it("keeps the titlebar joins free of decorative seam rules", () => {
    expect(styles).not.toContain(".native-titlebar::before");
    expect(styles).not.toContain(".native-titlebar::after");
    expect(styles).not.toContain(".titlebar-title::before");
  });

  it("reserves the open sidebar width so the chat title keeps its canvas edge", () => {
    expect(rule('[data-sidebar-visible="true"] .titlebar-brand-mini')).toContain(
      "width: calc(var(--sidebar-width, 272px) - 18px)",
    );
  });
});
