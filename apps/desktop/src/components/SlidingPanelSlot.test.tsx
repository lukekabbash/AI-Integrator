// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { domAnimation, LazyMotion } from "motion/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SlidingPanelSlot } from "./SlidingPanelSlot";

afterEach(() => {
  delete document.body.dataset.resizing;
  vi.restoreAllMocks();
});

describe("SlidingPanelSlot", () => {
  it("keeps the rail mounted through its open and close glide", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 320,
    } as DOMRect);
    const renderSlot = (open: boolean) => (
      <LazyMotion features={domAnimation}>
        <SlidingPanelSlot open={open} width={320} slotKey="tools">
          <aside>Tools</aside>
        </SlidingPanelSlot>
      </LazyMotion>
    );
    const { container, rerender } = render(renderSlot(false));

    rerender(renderSlot(true));
    const entering = container.querySelector(".panel-slot--right");
    expect(entering).toBeInTheDocument();
    expect(entering).toHaveStyle({ width: "0px" });
    await waitFor(
      () => expect(container.querySelector(".panel-slot--right")).toHaveStyle({ width: "320px" }),
      { timeout: 1_500 },
    );

    rerender(renderSlot(false));
    expect(container.querySelector(".panel-slot--right")).toBeInTheDocument();
    await waitFor(
      () => expect(container.querySelector(".panel-slot--right")).not.toBeInTheDocument(),
      { timeout: 1_500 },
    );
  });

  it("animates to the rendered rail width instead of auto", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 320,
    } as DOMRect);

    const renderSlot = (open: boolean) => (
      <LazyMotion features={domAnimation}>
        <SlidingPanelSlot open={open} width={356} motionScale={0} slotKey="tools">
          <aside>Tools</aside>
        </SlidingPanelSlot>
      </LazyMotion>
    );
    const { container, rerender } = render(renderSlot(true));

    await waitFor(() => {
      expect(container.querySelector(".panel-slot--right")).toHaveStyle({ width: "320px" });
    });

    rerender(renderSlot(false));
    await waitFor(() => {
      expect(container.querySelector(".panel-slot--right")).not.toBeInTheDocument();
    });
  });

  it("tracks drag resizing without applying the open-close tween", async () => {
    let renderedWidth = 320;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width: renderedWidth }) as DOMRect,
    );
    const renderSlot = (width: number) => (
      <LazyMotion features={domAnimation}>
        <SlidingPanelSlot open width={width} slotKey="tools">
          <aside>Tools</aside>
        </SlidingPanelSlot>
      </LazyMotion>
    );
    const { container, rerender } = render(renderSlot(320));
    await waitFor(() => {
      expect(container.querySelector(".panel-slot--right")).toHaveStyle({ width: "320px" });
    });

    document.body.dataset.resizing = "true";
    renderedWidth = 400;
    rerender(renderSlot(400));
    await waitFor(() => {
      expect(container.querySelector(".panel-slot--right")).toHaveStyle({ width: "400px" });
    });
  });

  it("remeasures when a lazy fallback is replaced by the real rail", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return {
        width: this.textContent === "Loading tools" ? 356 : 280,
      } as DOMRect;
    });
    const renderSlot = (loaded: boolean) => (
      <LazyMotion features={domAnimation}>
        <SlidingPanelSlot open width={356} motionScale={0} slotKey="tools">
          {loaded ? <aside>Tools</aside> : <div>Loading tools</div>}
        </SlidingPanelSlot>
      </LazyMotion>
    );
    const { container, rerender } = render(renderSlot(false));

    await waitFor(() => {
      expect(container.querySelector(".panel-slot--right")).toHaveStyle({ width: "356px" });
    });

    rerender(renderSlot(true));
    await waitFor(() => {
      expect(container.querySelector(".panel-slot--right")).toHaveStyle({ width: "280px" });
    });
  });

  it("tracks responsive viewport width without applying the open-close tween", async () => {
    let renderedWidth = 356;
    let finishViewportResize: () => void = () => undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      finishViewportResize = () => callback(performance.now());
      return 42;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width: renderedWidth }) as DOMRect,
    );
    const { container } = render(
      <LazyMotion features={domAnimation}>
        <SlidingPanelSlot open width={356} slotKey="tools">
          <aside>Tools</aside>
        </SlidingPanelSlot>
      </LazyMotion>,
    );
    await waitFor(() => {
      expect(container.querySelector(".panel-slot--right")).toHaveStyle({ width: "356px" });
    });

    renderedWidth = 280;
    fireEvent(window, new Event("resize"));
    await waitFor(() => {
      expect(container.querySelector(".panel-slot--right")).toHaveStyle({ width: "280px" });
    });

    act(finishViewportResize);
  });

  it("keeps close and later open glides after a cancelled viewport resize frame", async () => {
    let renderedWidth = 320;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 42);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width: renderedWidth }) as DOMRect,
    );
    const renderSlot = (open: boolean) => (
      <LazyMotion features={domAnimation}>
        <SlidingPanelSlot open={open} width={320} slotKey="tools">
          <aside>Tools</aside>
        </SlidingPanelSlot>
      </LazyMotion>
    );
    const { container, rerender } = render(renderSlot(true));
    await waitFor(() => {
      expect(container.querySelector(".panel-slot--right")).toHaveStyle({ width: "320px" });
    });

    renderedWidth = 280;
    fireEvent(window, new Event("resize"));
    await waitFor(() => {
      expect(container.querySelector(".panel-slot--right")).toHaveStyle({ width: "280px" });
    });

    // Close before the mocked viewport-reset frame runs. A stale suppression
    // flag used to make this exit and every later toggle instantaneous.
    rerender(renderSlot(false));
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    expect(container.querySelector(".panel-slot--right")).toBeInTheDocument();
    await waitFor(
      () => expect(container.querySelector(".panel-slot--right")).not.toBeInTheDocument(),
      { timeout: 1_500 },
    );

    renderedWidth = 320;
    rerender(renderSlot(true));
    expect(container.querySelector(".panel-slot--right")).toHaveStyle({ width: "0px" });
    await waitFor(
      () => expect(container.querySelector(".panel-slot--right")).toHaveStyle({ width: "320px" }),
      { timeout: 1_500 },
    );
  });

  it("cancels a pending viewport measurement when the slot unmounts", async () => {
    const cancelAnimationFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 320,
    } as DOMRect);
    const { unmount } = render(
      <LazyMotion features={domAnimation}>
        <SlidingPanelSlot open width={320} slotKey="tools">
          <aside>Tools</aside>
        </SlidingPanelSlot>
      </LazyMotion>,
    );

    fireEvent(window, new Event("resize"));
    unmount();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
  });
});
