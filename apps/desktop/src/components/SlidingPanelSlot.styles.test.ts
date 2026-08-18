// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("SlidingPanelSlot layout contract", () => {
  it("keeps the outer slot in control of right-rail width", () => {
    expect(styles).not.toMatch(
      /\.scheduled-workspace\s*>\s*\.panel-slot--right\s*\{[^}]*flex:\s*0\s+0\s+var\(/s,
    );
    expect(styles).not.toMatch(/\.right-rail\s*\{[^}]*transition:\s*[^}]*width/s);
  });
});
