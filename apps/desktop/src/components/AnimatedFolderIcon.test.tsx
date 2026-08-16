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
    // Motion owns `d`; with nothing to paint it wrote the string "undefined"
    // and the icon rendered nothing while the console filled with SVG errors.
    const { container } = renderIcon(false);
    const drawn = paths(container);
    expect(drawn).toHaveLength(2);
    for (const d of drawn) expect(d).toMatch(/^M[\d\s.]/);
  });

  it("shows a different flap open than closed", () => {
    const closed = paths(renderIcon(false).container);
    const opened = paths(renderIcon(true).container);
    expect(opened).not.toEqual(closed);
    for (const d of opened) expect(d).toMatch(/^M[\d\s.]/);
  });

  it("follows the open state when it changes", () => {
    // Motion drops `animate` updates for `d`, so the icon must not depend on
    // them to tell the truth about the folder underneath it.
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
