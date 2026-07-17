// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  expect(start, `Missing ${selector} CSS rule`).toBeGreaterThanOrEqual(0);
  return styles.slice(start, styles.indexOf("}", start) + 1);
}

describe("Skills and Plugins icon hierarchy", () => {
  it("contains long skill Markdown without widening the centered modal", () => {
    expect(rule(".plugin-modal")).toContain("min-width: 0");
    expect(rule(".plugin-modal-body")).toContain("min-width: 0");
    expect(rule(".skill-markdown")).toContain("max-width: 100%");
  });

  it("keeps capability icons unboxed and marketplace titles beside their icons", () => {
    for (const selector of [".browse-card-tile", ".skills-plugin-tile"]) {
      expect(rule(selector)).not.toContain("border:");
      expect(rule(selector)).not.toContain("background:");
    }
    expect(rule(".marketplace-card-heading")).toContain("display: flex");
    expect(rule(".marketplace-card-heading")).toContain("align-items: center");
  });

  it("keeps capability tab motion isolated from page-level layout animation", () => {
    expect(rule(".capability-panel")).toContain("contain: layout");
    expect(styles).toContain(
      ".settings-content > .settings-page-heading,\n  .settings-content > .settings-section",
    );
    expect(styles).not.toContain(
      ".settings-content .settings-page-heading,\n  .settings-content .settings-section",
    );
  });

  it("keeps MCP sign-in as a flat card action rather than a nested card", () => {
    expect(rule(".mcp-authorization-control")).toContain("border-top:");
    expect(rule(".mcp-authorization-control")).not.toContain("border-radius:");
    expect(rule(".mcp-authorization-control")).not.toContain("background:");
  });
});
