import type { NativeProviderAction } from "../bridge";

/** Session-persistent slash-menu cache so enabled skills render instantly
 * while the authoritative provider list refreshes in the background. A
 * cached action whose handle went stale fails loudly at send with the
 * existing "choose it again" flow. */
const NATIVE_ACTION_CACHE_KEY = "aiintegrator.native-actions.v1";
const NATIVE_ACTION_CACHE_LIMIT = 24;

export function readNativeActionCache(): Record<string, NativeProviderAction[]> {
  try {
    const raw = window.localStorage?.getItem(NATIVE_ACTION_CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const cache: Record<string, NativeProviderAction[]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      cache[key] = value.filter(
        (action): action is NativeProviderAction =>
          Boolean(action) &&
          typeof action === "object" &&
          typeof (action as { name?: unknown }).name === "string" &&
          typeof (action as { id?: unknown }).id === "string",
      );
    }
    return cache;
  } catch {
    return {};
  }
}

export function writeNativeActionCache(cache: Record<string, NativeProviderAction[]>) {
  try {
    const bounded = Object.fromEntries(Object.entries(cache).slice(-NATIVE_ACTION_CACHE_LIMIT));
    window.localStorage?.setItem(NATIVE_ACTION_CACHE_KEY, JSON.stringify(bounded));
  } catch {
    // The cache is a warm-start optimization only.
  }
}
