/**
 * Recents and bookmarks are installation chrome: same list in every task,
 * chat, and pop-out. A custom event covers same-window writes; `storage`
 * covers the other renderer.
 */

export const BROWSER_PLACES_EVENT = "aiintegrator-browser-places";

export function notifyBrowserPlaces(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(BROWSER_PLACES_EVENT));
}

export function subscribeBrowserPlaces(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key && !event.key.startsWith("aiintegrator.browser-")) return;
    onChange();
  };
  window.addEventListener(BROWSER_PLACES_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(BROWSER_PLACES_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
