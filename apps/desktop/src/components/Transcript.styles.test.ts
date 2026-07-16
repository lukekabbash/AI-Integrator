// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  expect(start, `Missing ${selector} CSS rule`).toBeGreaterThanOrEqual(0);
  return styles.slice(start, styles.indexOf("}", start) + 1);
}

describe("activity event disclosure alignment", () => {
  it("pins the caret to the trailing grid seat and right-aligns it", () => {
    expect(rule(".activity-event-toggle")).toContain(
      "grid-template-columns: 18px minmax(0, 1fr) auto 18px",
    );
    expect(rule(".activity-event-meta")).toContain("grid-column: 3");
    expect(rule(".activity-event-disclosure")).toContain("grid-column: 4");
    expect(rule(".activity-event-disclosure")).toContain("justify-items: end");
  });
});
