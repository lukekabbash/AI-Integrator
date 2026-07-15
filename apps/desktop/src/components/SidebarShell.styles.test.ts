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

  it("lifts a project group above siblings while its chat menu is open", () => {
    expect(rule(".project-group")).toContain("z-index: 1");
    expect(rule('.project-group[data-menu-open="true"]')).toContain("z-index: 20");
  });

  it("keeps the project chat count on the trailing edge with ellipsis left of +", () => {
    expect(rule(".project-count")).toContain("right: 0");
    expect(rule(".project-count")).toContain("width: 24px");
    expect(styles).toContain(".project-more-button {\n  grid-column: 1;");
    expect(styles).toContain(".project-new-chat {\n  grid-column: 2;");
  });

  it("scooches the project pin left of the count the same way chat pins yield to …", () => {
    expect(rule(".project-pin")).toContain("width: 11px");
    expect(rule(".project-pin-button")).toContain("right: 44px");
    expect(rule(".project-pin-button")).toContain("transform: translate(20px, -50%)");
    expect(
      rule(
        ".project-group-header:hover .project-pin-button,\n" +
          ".project-header-meta:focus-within .project-pin-button,\n" +
          '.project-group[data-project-menu-open="true"] .project-pin-button',
      ),
    ).toContain("transform: translate(0, -50%)");
  });

  it("keeps project header action chrome off chat-menu stacking", () => {
    // data-menu-open still lifts z-index for chat menus; only
    // data-project-menu-open may reveal …/+ / pin scooch.
    expect(rule('.project-group[data-menu-open="true"]')).toContain("z-index: 20");
    expect(styles).not.toContain(
      '.project-group[data-menu-open="true"] .project-header-actions',
    );
    expect(styles).toContain(
      '.project-group[data-project-menu-open="true"] .project-header-actions',
    );
  });
});
