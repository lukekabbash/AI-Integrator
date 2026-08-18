/**
 * What the address field does with a line of typing: open it as a page, or
 * search. The renderer resolves this before navigate so the native side still
 * only sees http(s). Queries are never logged.
 */

export type SearchEngineId = "google" | "ddg";

export interface SearchEngine {
  id: SearchEngineId;
  label: string;
  searchUrl: (query: string) => string;
}

export const SEARCH_ENGINES: Record<SearchEngineId, SearchEngine> = {
  google: {
    id: "google",
    label: "Google",
    searchUrl: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  },
  ddg: {
    id: "ddg",
    label: "DuckDuckGo",
    searchUrl: (query) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
  },
};

export const DEFAULT_SEARCH_ENGINE: SearchEngineId = "google";
export const SEARCH_ENGINE_STORAGE_KEY = "aiintegrator.browser-search-engine.v1";

export function isSearchEngineId(value: unknown): value is SearchEngineId {
  return value === "google" || value === "ddg";
}

export function readSearchEngine(): SearchEngineId {
  if (typeof window === "undefined") return DEFAULT_SEARCH_ENGINE;
  try {
    const stored = window.localStorage.getItem(SEARCH_ENGINE_STORAGE_KEY);
    return isSearchEngineId(stored) ? stored : DEFAULT_SEARCH_ENGINE;
  } catch {
    return DEFAULT_SEARCH_ENGINE;
  }
}

export const SEARCH_ENGINE_EVENT = "aiintegrator-browser-search-engine";

export function writeSearchEngine(id: SearchEngineId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SEARCH_ENGINE_STORAGE_KEY, id);
    window.dispatchEvent(new Event(SEARCH_ENGINE_EVENT));
  } catch {
    // Same as recents: a lost preference is not worth an error.
  }
}

export function searchEngineOf(id: SearchEngineId | undefined): SearchEngine {
  return SEARCH_ENGINES[id && isSearchEngineId(id) ? id : DEFAULT_SEARCH_ENGINE];
}

const LOCAL_HOST =
  /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#].*)?$/i;
const DOTTED_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i;
const IPV4_HOST = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#].*)?$/;

export function looksLikeUrl(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return true;
  return LOCAL_HOST.test(trimmed) || DOTTED_HOST.test(trimmed) || IPV4_HOST.test(trimmed);
}

export type OmniboxResolution =
  | { kind: "empty" }
  | { kind: "url"; href: string }
  | { kind: "search"; href: string; query: string; engine: SearchEngineId };

export function resolveOmniboxInput(
  input: string,
  engine: SearchEngineId = DEFAULT_SEARCH_ENGINE,
): OmniboxResolution {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "about:blank") return { kind: "empty" };
  if (looksLikeUrl(trimmed)) return { kind: "url", href: trimmed };
  const chosen = searchEngineOf(engine);
  return { kind: "search", href: chosen.searchUrl(trimmed), query: trimmed, engine: chosen.id };
}

export function hostOf(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).host;
  } catch {
    return url;
  }
}

export type OmniboxSuggestionKind = "search" | "url" | "bookmark" | "recent" | "server";

export interface OmniboxSuggestionSource {
  url: string;
  title: string;
  hint?: string;
  favicon?: string;
}

export interface OmniboxSuggestion {
  id: string;
  kind: OmniboxSuggestionKind;
  title: string;
  hint: string;
  href: string;
  favicon?: string;
}

function matchesQuery(query: string, value: string): boolean {
  return !query || value.toLowerCase().includes(query);
}

function sourceHint(entry: OmniboxSuggestionSource): string {
  return entry.hint || hostOf(entry.url);
}

export function buildOmniboxSuggestions(
  input: string,
  sources: {
    bookmarks?: OmniboxSuggestionSource[];
    recents?: OmniboxSuggestionSource[];
    servers?: OmniboxSuggestionSource[];
  },
  engine: SearchEngineId = DEFAULT_SEARCH_ENGINE,
  limit = 8,
): OmniboxSuggestion[] {
  const trimmed = input.trim();
  const query = trimmed.toLowerCase();
  const resolved = resolveOmniboxInput(trimmed, engine);
  const suggestions: OmniboxSuggestion[] = [];
  const seen = new Set<string>();

  const push = (suggestion: OmniboxSuggestion) => {
    if (suggestions.length >= limit) return;
    const key = suggestion.href;
    if (!key || seen.has(key)) return;
    seen.add(key);
    suggestions.push(suggestion);
  };

  if (resolved.kind === "search") {
    push({
      id: "search",
      kind: "search",
      title: trimmed,
      hint: `Search ${searchEngineOf(resolved.engine).label}`,
      href: resolved.href,
    });
  } else if (resolved.kind === "url") {
    push({
      id: "url",
      kind: "url",
      title: hostOf(resolved.href) || resolved.href,
      hint: "Open this address",
      href: resolved.href,
    });
  }

  const take = (
    kind: Exclude<OmniboxSuggestionKind, "search" | "url">,
    entries: OmniboxSuggestionSource[] | undefined,
  ) => {
    for (const entry of entries ?? []) {
      if (!matchesQuery(query, `${entry.title} ${entry.url} ${sourceHint(entry)}`)) continue;
      push({
        id: `${kind}:${entry.url}`,
        kind,
        title: entry.title || hostOf(entry.url),
        hint: sourceHint(entry),
        href: entry.url,
        favicon: entry.favicon,
      });
    }
  };

  // Recents first: the field is a jump list, then the pages you keep.
  take("recent", sources.recents);
  take("bookmark", sources.bookmarks);
  take("server", sources.servers);
  return suggestions;
}
