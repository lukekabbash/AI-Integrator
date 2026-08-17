import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { LazyMotion, domMax } from "motion/react";
import { describe, expect, it } from "vitest";

import { AnimatedFolderIcon } from "./AnimatedFolderIcon";

function paths(container: HTMLElement) {
  return [...container.querySelectorAll("path")].map((path) => path.getAttribute("d") ?? "");
}

function renderIcon(open: boolean) {
  return render(
    <LazyMotion features={domMax} strict>
      <AnimatedFolderIcon open={open} />
    </LazyMotion>,
  );
}

describe("AnimatedFolderIcon", () => {
  it("paints real geometry on the first frame", () => {
    // Motion used to own `d` and had nothing to paint on mount, so it wrote the
    // string "undefined": a blank icon for a frame and an SVG parse error per
    // folder. React owns the attribute now, so the first paint is the drawing.
    const { container } = renderIcon(false);
    const drawn = paths(container);
    expect(drawn).toHaveLength(2);
    for (const d of drawn) expect(d).toMatch(/^M[\d\s.]/);
  });

  it("never hands the DOM a path it cannot parse", () => {
    for (const open of [false, true]) {
      for (const d of paths(renderIcon(open).container)) {
        expect(d).not.toMatch(/undefined|NaN/);
        // Every command is a letter followed by numbers; nothing else is legal.
        expect(d.replace(/[\d\s.-]/g, "")).toMatch(/^[MLA]+$/);
      }
    }
  });

  it("shows a different flap open than closed", () => {
    const closed = paths(renderIcon(false).container);
    const opened = paths(renderIcon(true).container);
    expect(opened).not.toEqual(closed);
    for (const d of opened) expect(d).toMatch(/^M[\d\s.]/);
  });

  it("follows the open state when it changes", () => {
    // The icon has to tell the truth about the folder underneath it on every
    // flip, not just the state it was born in.
    const { container, rerender } = renderIcon(false);
    const closed = paths(container);
    rerender(
      <LazyMotion features={domMax} strict>
        <AnimatedFolderIcon open />
      </LazyMotion>,
    );
    expect(paths(container)).not.toEqual(closed);
    rerender(
      <LazyMotion features={domMax} strict>
        <AnimatedFolderIcon open={false} />
      </LazyMotion>,
    );
    expect(paths(container)).toEqual(closed);
  });
});
