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
  const [open, setOpen] = useState(modalPresent);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    let frame = 0;
    // Mutations arrive in bursts while the app renders; the question only has
    // to be answered once per frame, and an unchanged answer is a no-op.
    const check = () => {
      frame = 0;
      setOpen(modalPresent());
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(check);
    };
    check();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-modal"],
    });
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  return open;
}

function modalPresent(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('[aria-modal="true"]') !== null;
}
