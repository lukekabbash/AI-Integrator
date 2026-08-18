// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./browserWindow.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  expect(start, `Missing ${selector} CSS rule`).toBeGreaterThanOrEqual(0);
  return styles.slice(start, styles.indexOf("}", start) + 1);
}

/** Every rule whose selector list mentions `needle`, body included. */
function rulesMentioning(needle: string): string[] {
  const found: string[] = [];
  for (const match of styles.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (match[1].includes(needle)) found.push(match[0]);
  }
  return found;
}

describe("pop-out strip matches the work pane's strip", () => {
  it("answers a tab hover with colour alone, no fill behind the whole tab", () => {
    expect(styles).not.toContain('.browser-window-tab:not([data-active="true"]):hover');
  });

  it("draws no square behind the close and minimize controls", () => {
    const hovers = rulesMentioning(".file-reader-tab-close:hover");
    for (const hover of hovers) {
      expect(hover, "close-button hover should not paint a background").not.toContain("background");
    }
  });

  it("sits + on the tabs' baseline rather than the strip's middle", () => {
    expect(rule(".browser-window-new-tab")).toContain("align-self: flex-end");
  });

  it("scrolls the tab row instead of squashing tabs off the strip", () => {
    expect(rule(".browser-window-tabs")).toContain("overflow-x: auto");
  });

  it("colours every group slot from a theme token", () => {
    for (let index = 1; index <= 8; index += 1) {
      expect(styles, `--color-group-${index} unused`).toContain(`--color-group-${index}`);
    }
  });

  it("tucks minimize in beside close", () => {
    const minimize = rulesMentioning(".browser-window-tab-minimize");
    expect(minimize.some((text) => text.includes("right: 20px"))).toBe(true);
  });

  it("has no window title left in the strip — the first pill is the label", () => {
    expect(styles).not.toContain(".browser-window-title");
  });
});
