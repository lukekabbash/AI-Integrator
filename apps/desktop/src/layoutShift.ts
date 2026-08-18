/**
 * Calls back whenever `node` may have moved on screen — not only when it
 * resized.
 *
 * `ResizeObserver` on a box reports its size. A fixed-width column that
 * slides sideways because a sibling (the sidebar, the right rail) grew or
 * shrank never resizes, so an observer on it alone stays silent and anything
 * positioned from its rectangle — the native page over the browser slot, the
 * titlebar tab strip — is left where the box used to be. The neighbours that
 * push a box around are the siblings of each of its ancestors, so those are
 * observed too, up to `<body>`. Their transitions fire the observer every
 * frame, which is what lets a follower ride the slide instead of jumping at
 * the end. A capture-phase `transitionend` / `animationend` catches anything
 * that moved without resizing a watched box.
 *
 * Returns a disposer. `onChange` is the caller's own throttle; it is invoked
 * raw, once per signal.
 */
export function watchLayoutShift(node: Element, onChange: () => void): () => void {
  const observer =
    typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => onChange());
  if (observer) {
    const watched = new Set<Element>();
    const watch = (element: Element | null) => {
      if (!element || watched.has(element)) return;
      watched.add(element);
      observer.observe(element);
    };
    watch(node);
    const stop = typeof document === "undefined" ? null : document.body;
    for (let cursor: Element | null = node; cursor && cursor !== stop; cursor = cursor.parentElement) {
      const parent = cursor.parentElement;
      if (!parent) break;
      watch(parent);
      for (const sibling of parent.children) watch(sibling);
    }
  }
  const settle = () => onChange();
  window.addEventListener("resize", settle);
  window.addEventListener("transitionend", settle, true);
  window.addEventListener("transitioncancel", settle, true);
  window.addEventListener("animationend", settle, true);
  return () => {
    observer?.disconnect();
    window.removeEventListener("resize", settle);
    window.removeEventListener("transitionend", settle, true);
    window.removeEventListener("transitioncancel", settle, true);
    window.removeEventListener("animationend", settle, true);
  };
}
