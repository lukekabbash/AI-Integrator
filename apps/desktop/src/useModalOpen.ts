import { useEffect, useState } from "react";

/**
 * Whether a modal dialog is on screen in this window.
 *
 * A native browser tab is a real webview over the app, not an element in it, so
 * it paints above every dialog and no backdrop can blur it. Nothing in CSS
 * fixes that; the page has to step aside while a dialog is up. The surfaces
 * park their tab when this turns true and place it again when it turns false,
 * which leaves the page's own still in the DOM — under the backdrop, blurred
 * with everything else.
 *
 * The signal is the dialog's own `aria-modal`, so an overlay opts in by being
 * an accessible modal rather than by remembering to tell the browser about
 * itself. Each window observes its own document: a dialog in the main window
 * never disturbs a popped-out browser.
 */
export function useModalOpen(): boolean {
  return useDocumentFlag(modalPresent, observeModals);
}

/**
 * Whether the in-pane native page must stand down. A dialog covers it, and so
 * does dragging the compact deck across it — the deck is HTML, the page is a
 * child webview, and the webview would swallow the cards mid-drag.
 */
export function useNativePageParked(): boolean {
  return useDocumentFlag(nativePageShouldPark, observeNativePagePark);
}

export const NATIVE_PAGE_DECK_OCCLUSION_ATTR = "data-browser-deck-occluding";

export function setNativePageDeckOccluding(on: boolean) {
  if (typeof document === "undefined") return;
  document.documentElement.toggleAttribute(NATIVE_PAGE_DECK_OCCLUSION_ATTR, on);
}

function modalPresent(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('[aria-modal="true"]') !== null;
}

function nativePageShouldPark(): boolean {
  if (typeof document === "undefined") return false;
  return (
    modalPresent() || document.documentElement.hasAttribute(NATIVE_PAGE_DECK_OCCLUSION_ATTR)
  );
}

function observeModals(observer: MutationObserver) {
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-modal"],
  });
}

function observeNativePagePark(observer: MutationObserver) {
  observeModals(observer);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [NATIVE_PAGE_DECK_OCCLUSION_ATTR],
  });
}

function useDocumentFlag(
  read: () => boolean,
  observe: (observer: MutationObserver) => void,
): boolean {
  const [on, setOn] = useState(read);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    let frame = 0;
    // Mutations arrive in bursts while the app renders; the question only has
    // to be answered once per frame, and an unchanged answer is a no-op. The
    // guard is its own flag rather than the frame handle: a callback that runs
    // before `requestAnimationFrame` returns would otherwise leave the handle
    // assigned behind it and drop every later burst.
    let pending = false;
    const check = () => {
      pending = false;
      setOn(read());
    };
    const schedule = () => {
      if (pending) return;
      pending = true;
      frame = window.requestAnimationFrame(check);
    };
    setOn(read());
    const observer = new MutationObserver(schedule);
    observe(observer);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [read, observe]);
  return on;
}
