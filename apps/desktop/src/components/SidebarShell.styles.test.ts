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

  it("keeps File/Edit/View menus above the sidebar and canvas", () => {
    expect(rule(".native-titlebar")).toContain("z-index: 50");
    expect(rule(".titlebar-menu")).toContain("z-index: 60");
    expect(rule(".native-titlebar:has(.titlebar-menu) .titlebar-left")).toContain(
      "overflow: visible",
    );
  });

  it("keeps file context menus on an elevated surface with a defined entrance", () => {
    const menu = rule(".file-context-menu");
    expect(menu).toContain("background: var(--color-layer-1)");
    expect(menu).toContain("box-shadow: var(--shadow-elevated)");
    expect(menu).toContain("animation: context-menu-in var(--duration-fast) var(--ease-standard)");
    expect(styles).toContain("@keyframes context-menu-in {\n  from {");
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
    expect(styles).not.toContain('.project-group[data-menu-open="true"] .project-header-actions');
    expect(styles).toContain(
      '.project-group[data-project-menu-open="true"] .project-header-actions',
    );
  });

  it("clips project chat lists with grid 0fr/1fr instead of JS height auto", () => {
    expect(rule(".project-chat-list-clip")).toContain("grid-template-rows: 0fr");
    expect(rule(".project-chat-list-clip")).toContain(
      "grid-template-rows 220ms cubic-bezier(0.2, 0.8, 0.2, 1)",
    );
    expect(rule('.project-chat-list-clip[data-open="true"]')).toContain("grid-template-rows: 1fr");
    expect(rule(".project-chat-list-inner")).toContain("overflow: hidden");
    expect(
      rule('.project-chat-list-clip[data-menu-open="true"] .project-chat-list-inner'),
    ).toContain("overflow: visible");
    expect(rule('.project-chat-list[data-menu-open="true"]')).toContain("overflow: visible");
  });

  it("keeps collection carets quiet until the section is hovered or focused", () => {
    expect(rule(".rail-section-disclosure .disclosure")).toContain("opacity: 0");
    expect(
      rule(
        ".rail-section-heading:hover .rail-section-disclosure .disclosure,\n" +
          ".rail-section-disclosure:focus-visible .disclosure",
      ),
    ).toContain("opacity: 1");
  });

  it("animates both collection directions with the same grid track", () => {
    expect(rule(".sidebar-collection-clip")).toContain("grid-template-rows: 0fr");
    expect(rule(".sidebar-collection-clip")).toContain(
      "grid-template-rows 220ms cubic-bezier(0.2, 0.8, 0.2, 1)",
    );
    expect(rule('.sidebar-collection-clip[data-open="true"]')).toContain("grid-template-rows: 1fr");
  });
});
