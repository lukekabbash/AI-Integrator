import { useEffect, useState } from "react";

import type { ScreenRect } from "./components/browserDeckModel";

/**
 * Where the live native pages are on screen, in CSS pixels.
 *
 * A pane page is a child webview, not an element: it paints over any HTML that
 * shares its rectangle. Things that float — the compact deck — need to know
 * where those rectangles are so they can keep clear of them at rest. The pane
 * marks its slot with `data-native` while a page is hosted there; this reads
 * every such slot in the document and follows it through layout changes.
 *
 * Reads are batched to one per frame. Rects are rounded so a sub-pixel jitter
 * from a rail animation is not a new answer.
 */
export function useNativePageRects(): ScreenRect[] {
  const [rects, setRects] = useState<ScreenRect[]>(readNativePageRects);
  useEffect(() => {
    if (typeof window === "undefined" || typeof MutationObserver === "undefined") return;
    let frame = 0;
    let pending = false;
    let lastKey = "";
    let observedNodes: Element[] = [];
    const resize =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => schedule());
    const check = () => {
      pending = false;
      const nodes = nativePageNodes();
      if (resize && !sameNodes(nodes, observedNodes)) {
        resize.disconnect();
        for (const node of nodes) resize.observe(node);
        observedNodes = nodes;
      }
      const next = nodes.map(rectOf).filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
      const key = next.map((rect) => `${rect.left}:${rect.top}:${rect.right}:${rect.bottom}`).join("|");
      if (key === lastKey) return;
      lastKey = key;
      setRects(next);
    };
    const schedule = () => {
      if (pending) return;
      pending = true;
      frame = window.requestAnimationFrame(check);
    };
    schedule();
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-native"],
    });
    window.addEventListener("resize", schedule);
    // Rails and sidebars slide; the pane's slot moves without resizing when
    // something beside it does. The end of any transition is a cheap moment
    // to look again.
    window.addEventListener("transitionend", schedule, true);
    return () => {
      window.cancelAnimationFrame(frame);
      mutations.disconnect();
      resize?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("transitionend", schedule, true);
    };
  }, []);
  return rects;
}

function nativePageNodes(): Element[] {
  if (typeof document === "undefined") return [];
  return [...document.querySelectorAll('.browser-viewport[data-native="true"]')];
}

function readNativePageRects(): ScreenRect[] {
  return nativePageNodes()
    .map(rectOf)
    .filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
}

function rectOf(node: Element): ScreenRect {
  const rect = node.getBoundingClientRect();
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    right: Math.round(rect.right),
    bottom: Math.round(rect.bottom),
  };
}

function sameNodes(a: readonly Element[], b: readonly Element[]): boolean {
  return a.length === b.length && a.every((node, index) => node === b[index]);
}
