import { Globe, History, RadioTower, Search, Star, X } from "lucide-react";
import {
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";

import {
  buildOmniboxSuggestions,
  looksLikeUrl,
  readSearchEngine,
  resolveOmniboxInput,
  SEARCH_ENGINE_EVENT,
  searchEngineOf,
  type OmniboxSuggestion,
  type SearchEngineId,
} from "../browserOmnibox";
import { TabFavicon } from "./TabFavicon";
import { useBrowserPlaces } from "./useBrowserPlaces";

export interface BrowserOmniboxSource {
  url: string;
  title: string;
  hint?: string;
  favicon?: string;
}

export interface BrowserOmniboxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (href: string) => void;
  /** chrome sits in the toolbar; hero is the start-page invitation. */
  size?: "chrome" | "hero";
  placeholder?: string;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onFocus?: () => void;
  onBlur?: () => void;
  onEscape?: () => void;
  onSelect?: () => void;
  onSuggestOpenChange?: (open: boolean) => void;
  engine?: SearchEngineId;
  servers?: BrowserOmniboxSource[];
  bookmark?: { url: string; title: string; favicon?: string };
  onToggleBookmark?: () => void;
  trailing?: ReactNode;
}

function suggestionLabel(kind: OmniboxSuggestion["kind"]): string {
  switch (kind) {
    case "search":
      return "Search";
    case "url":
      return "Go";
    case "bookmark":
      return "Bookmark";
    case "recent":
      return "Recent";
    case "server":
      return "Local";
  }
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return text;
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + needle.length)}</mark>
      {text.slice(index + needle.length)}
    </>
  );
}

function SuggestionGlyph({ suggestion }: { suggestion: OmniboxSuggestion }) {
  if (suggestion.kind !== "search" && suggestion.favicon) {
    return <TabFavicon src={suggestion.favicon} />;
  }
  switch (suggestion.kind) {
    case "search":
      return <Search aria-hidden="true" />;
    case "url":
      return <Globe aria-hidden="true" />;
    case "bookmark":
      return <Star aria-hidden="true" />;
    case "recent":
      return <History aria-hidden="true" />;
    case "server":
      return <RadioTower aria-hidden="true" />;
  }
}

export function BrowserOmnibox({
  value,
  onChange,
  onSubmit,
  size = "chrome",
  placeholder,
  autoFocus = false,
  inputRef,
  onFocus,
  onBlur,
  onEscape,
  onSelect,
  onSuggestOpenChange,
  engine,
  servers = [],
  bookmark,
  onToggleBookmark,
  trailing,
}: BrowserOmniboxProps) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [engineId, setEngineId] = useState<SearchEngineId>(() => engine ?? readSearchEngine());
  const { recents, bookmarks } = useBrowserPlaces();
  const bookmarked = Boolean(bookmark && bookmarks.some((entry) => entry.url === bookmark.url));
  const chosen = searchEngineOf(engine ?? engineId);
  const queryLooksLikeUrl = looksLikeUrl(value);
  const typed = value.trim().length > 0;

  // A caller that names the engine wins outright; otherwise follow the saved
  // choice as it changes in Settings.
  useEffect(() => {
    if (engine) return;
    const sync = () => setEngineId(readSearchEngine());
    window.addEventListener(SEARCH_ENGINE_EVENT, sync);
    return () => window.removeEventListener(SEARCH_ENGINE_EVENT, sync);
  }, [engine]);

  const suggestions = useMemo(
    () =>
      buildOmniboxSuggestions(
        value,
        {
          bookmarks: bookmarks.map((entry) => ({
            url: entry.url,
            title: entry.title,
            favicon: entry.favicon,
          })),
          recents: recents.map((entry) => ({
            url: entry.url,
            title: entry.title,
            favicon: entry.favicon,
          })),
          servers,
        },
        chosen.id,
      ),
    [bookmarks, chosen.id, recents, servers, value],
  );

  // A focused, empty field stays quiet — the list is an answer to typing, or
  // to an explicit arrow key, not a greeting.
  const [armed, setArmed] = useState(false);
  const [focused, setFocused] = useState(false);
  const showList = open && (typed || armed) && suggestions.length > 0;
  // The list can shrink under the cursor (a bookmark removed elsewhere), so
  // the cursor is clamped where it is read rather than reset by an effect.
  const cursor = Math.min(highlight, Math.max(0, suggestions.length - 1));

  useEffect(() => {
    onSuggestOpenChange?.(showList);
  }, [onSuggestOpenChange, showList]);

  useEffect(() => {
    if (!showList) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [showList]);

  useImperativeHandle(inputRef, () => innerRef.current as HTMLInputElement, []);

  const submitHref = (href: string) => {
    const resolved = href || resolveOmniboxInput(value, chosen.id);
    const next = typeof resolved === "string" ? resolved : resolved.kind === "empty" ? "" : resolved.href;
    if (!next) return;
    setOpen(false);
    onSelect?.();
    onSubmit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setArmed(false);
      onEscape?.();
      return;
    }
    if (event.key === "ArrowDown" && suggestions.length) {
      event.preventDefault();
      setOpen(true);
      // The first arrow on a quiet field only reveals the list; the cursor
      // stays on the top entry until the next press.
      if (showList) setHighlight((current) => (current + 1) % suggestions.length);
      setArmed(true);
      return;
    }
    if (event.key === "ArrowUp" && suggestions.length) {
      event.preventDefault();
      setOpen(true);
      if (showList) setHighlight((current) => (current - 1 + suggestions.length) % suggestions.length);
      setArmed(true);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const picked = showList ? suggestions[cursor] : undefined;
      submitHref(picked?.href ?? "");
    }
  };

  const hint =
    placeholder ??
    (size === "hero" ? `Search ${chosen.label} or enter a URL` : "Search or enter a URL");

  return (
    <div
      ref={rootRef}
      className="browser-omnibox"
      data-size={size}
      data-open={showList ? "true" : undefined}
    >
      <div className="browser-omnibox-field">
        <span className="browser-omnibox-leading" aria-hidden="true">
          {queryLooksLikeUrl ? <Globe /> : <Search />}
        </span>
        <input
          ref={innerRef}
          type="text"
          value={value}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          autoFocus={autoFocus}
          role="combobox"
          aria-label={hint}
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList ? `${listId}-${cursor}` : undefined}
          placeholder={hint}
          onFocus={() => {
            setOpen(true);
            setFocused(true);
            onFocus?.();
          }}
          onBlur={() => {
            setArmed(false);
            setFocused(false);
            onBlur?.();
          }}
          onChange={(event) => {
            onChange(event.target.value);
            setHighlight(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        {size === "hero" ? (
          <span className="browser-omnibox-engine" aria-hidden="true">
            {chosen.label}
          </span>
        ) : !queryLooksLikeUrl && typed ? (
          <span className="browser-omnibox-engine" data-quiet="true" aria-hidden="true">
            {chosen.label}
          </span>
        ) : null}
        {/* Clearing is for something being typed; a resting address shows
            its star and nothing else, the way a browser's does. */}
        {typed && (focused || size === "hero") ? (
          <button
            type="button"
            className="icon-button subtle tiny browser-omnibox-clear"
            aria-label="Clear"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange("");
              setHighlight(0);
              setOpen(true);
              innerRef.current?.focus();
            }}
          >
            <X aria-hidden="true" />
          </button>
        ) : null}
        {bookmark && onToggleBookmark ? (
          <button
            type="button"
            className="icon-button subtle tiny browser-omnibox-star"
            aria-label={bookmarked ? "Remove bookmark" : "Bookmark this page"}
            aria-pressed={bookmarked}
            data-on={bookmarked ? "true" : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onToggleBookmark}
          >
            <Star aria-hidden="true" />
          </button>
        ) : null}
        {trailing}
      </div>
      {showList ? (
        <ul
          className="browser-omnibox-list"
          id={listId}
          role="listbox"
          aria-label={typed ? "Suggestions" : "Jump to a page"}
        >
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.id} role="presentation">
              <button
                type="button"
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === cursor}
                data-active={index === cursor ? "true" : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => submitHref(suggestion.href)}
              >
                <span className="browser-omnibox-mark" data-kind={suggestion.kind}>
                  <SuggestionGlyph suggestion={suggestion} />
                </span>
                <span>
                  <strong>
                    <Highlighted text={suggestion.title} query={value} />
                  </strong>
                  <small>
                    <Highlighted text={suggestion.hint} query={value} />
                  </small>
                </span>
                <em>{index === cursor ? "↵" : suggestionLabel(suggestion.kind)}</em>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
