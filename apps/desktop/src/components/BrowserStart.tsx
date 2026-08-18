import { History, Plus, RadioTower, RotateCw, Star, X } from "lucide-react";
import { m as motion, useReducedMotion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";

import { hostOf, type SearchEngineId } from "../browserOmnibox";
import { bridge, type LocalServer } from "../bridge";
import { removeBrowserBookmark, toggleBrowserBookmark } from "./browserBookmarks";
import { BrowserOmnibox } from "./BrowserOmnibox";
import { TabFavicon } from "./TabFavicon";
import { useBrowserPlaces } from "./useBrowserPlaces";

const railItemSpring = { type: "spring" as const, stiffness: 540, damping: 33, mass: 0.7 };
const pageFade = { duration: 0.18, ease: [0.2, 0, 0, 1] as const };

function relativeTime(at: number): string {
  const seconds = Math.max(1, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function toServerSource(server: LocalServer) {
  return {
    url: server.url,
    title: server.title || server.process || `localhost:${server.port}`,
    hint: `localhost:${server.port}`,
  };
}

/**
 * What a blank tab offers: search, the pages you keep, the pages you were
 * just on, and the local servers that actually answer. `home` is the full
 * new-tab page inside a browser surface; `compact` is the same page scaled
 * to the narrow work-pane launcher.
 */
export function BrowserStart({
  onOpen,
  layout = "compact",
  autoFocus = false,
  showSearch = true,
  engine,
  actions,
}: {
  onOpen: (url: string) => void;
  layout?: "compact" | "home";
  autoFocus?: boolean;
  /** False when the chrome address field is already the search. */
  showSearch?: boolean;
  engine?: SearchEngineId;
  /** Quiet controls that belong to the page (the launcher's Review, say). */
  actions?: ReactNode;
}) {
  const reduceMotion = Boolean(useReducedMotion());
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const { recents, bookmarks } = useBrowserPlaces();

  const [generation, setGeneration] = useState(0);
  const [result, setResult] = useState<{ generation: number; servers: LocalServer[] }>();
  const scanning = result?.generation !== generation;

  useEffect(() => {
    const api = bridge.browser;
    let active = true;
    (api?.localServers(generation > 0) ?? Promise.resolve<LocalServer[]>([]))
      .then((servers) => active && setResult({ generation, servers }))
      .catch(() => active && setResult({ generation, servers: [] }));
    return () => {
      active = false;
    };
  }, [generation]);

  const servers = result?.servers ?? [];
  const web = servers.filter((server) => server.servesWeb);
  const others = servers.filter((server) => !server.servesWeb);
  const shown = showAll ? [...web, ...others] : web;
  const home = layout === "home";

  const rowMotion = (index: number) => ({
    initial: reduceMotion ? false : { opacity: 0, y: 4 },
    animate: { opacity: 1, y: 0 },
    transition: reduceMotion ? { duration: 0 } : { ...railItemSpring, delay: 0.04 + index * 0.015 },
  });

  return (
    <motion.div
      className="browser-start"
      data-layout={layout}
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reduceMotion ? { duration: 0 } : pageFade}
    >
      <div className="browser-start-glow" aria-hidden="true" />
      <div className="browser-start-body">
        {actions ? <div className="browser-start-actions">{actions}</div> : null}

        <div className="browser-start-hero">
          <div className="browser-start-brand" aria-label="AI Integrator">
            <span className="brand-mark-glyph browser-start-brand-glyph" aria-hidden="true" />
            <span className="browser-start-wordmark" aria-hidden="true">
              Integrator
            </span>
          </div>
          {showSearch ? (
            <BrowserOmnibox
              size={home ? "hero" : "chrome"}
              value={query}
              autoFocus={autoFocus}
              engine={engine}
              servers={servers.map(toServerSource)}
              onChange={setQuery}
              onSubmit={(href) => {
                setQuery("");
                onOpen(href);
              }}
            />
          ) : null}
        </div>

        {bookmarks.length > 0 ? (
          <section className="browser-start-bookmarks" aria-label="Bookmarks">
            <ul className="browser-start-tiles">
              {bookmarks.map((bookmark, index) => (
                <motion.li key={bookmark.url} {...rowMotion(index)}>
                  <button
                    type="button"
                    aria-label={`Open ${bookmark.title || hostOf(bookmark.url)}`}
                    onClick={() => onOpen(bookmark.url)}
                    title={bookmark.url}
                  >
                    <span className="browser-start-tile-mark">
                      <TabFavicon src={bookmark.favicon} />
                    </span>
                    <span className="browser-start-tile-label">
                      {bookmark.title || hostOf(bookmark.url)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="browser-start-unpin"
                    aria-label={`Remove ${bookmark.title || hostOf(bookmark.url)}`}
                    onClick={() => removeBrowserBookmark(bookmark.url)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </motion.li>
              ))}
            </ul>
          </section>
        ) : home ? (
          <section className="browser-start-bookmarks" aria-label="Bookmarks">
            <ul className="browser-start-tiles">
              <li>
                <div className="browser-start-tile-ghost" title="Star a page to keep it here">
                  <span className="browser-start-tile-mark">
                    <Plus aria-hidden="true" />
                  </span>
                  <span className="browser-start-tile-label">Add a page</span>
                </div>
              </li>
            </ul>
          </section>
        ) : (
          <p className="browser-start-quiet">Star a page to keep it here.</p>
        )}

        <div className="browser-start-columns">
          {recents.length > 0 ? (
            <section>
              <span className="browser-start-eyebrow">
                <History aria-hidden="true" />
                Recently opened
              </span>
              <ul className="browser-start-list">
                {recents.map((recent, index) => (
                  <motion.li key={recent.url} {...rowMotion(index)}>
                    <button
                      type="button"
                      aria-label={`Open ${recent.title || hostOf(recent.url)}`}
                      onClick={() => onOpen(recent.url)}
                    >
                      <span className="browser-start-mark">
                        <TabFavicon src={recent.favicon} />
                      </span>
                      <span>
                        <strong>{recent.title || hostOf(recent.url)}</strong>
                        <small>
                          {hostOf(recent.url)} · {relativeTime(recent.at)}
                        </small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="browser-start-pin"
                      aria-label={`Bookmark ${recent.title || hostOf(recent.url)}`}
                      onClick={() =>
                        toggleBrowserBookmark(recent.url, recent.title, recent.favicon)
                      }
                    >
                      <Star aria-hidden="true" />
                    </button>
                  </motion.li>
                ))}
              </ul>
            </section>
          ) : null}

          <section>
            <span className="browser-start-eyebrow">
              <RadioTower aria-hidden="true" />
              Local servers
              <button
                type="button"
                className="icon-button subtle tiny browser-start-rescan"
                aria-label="Rescan local ports"
                disabled={scanning}
                onClick={() => setGeneration((value) => value + 1)}
              >
                <RotateCw className={scanning ? "spin" : undefined} aria-hidden="true" />
              </button>
            </span>
            {shown.length === 0 ? (
              <p className="browser-start-quiet">
                {scanning
                  ? "Looking for local servers…"
                  : "Nothing is answering on localhost yet. Start a dev server and it appears here."}
              </p>
            ) : (
              <ul className="browser-start-list">
                {shown.map((server, index) => (
                  <motion.li key={server.port} {...rowMotion(index)}>
                    <button
                      type="button"
                      aria-label={`Open ${server.title || server.process || `localhost:${server.port}`} on localhost:${server.port}`}
                      data-quiet={server.servesWeb ? undefined : "true"}
                      onClick={() => onOpen(server.url)}
                    >
                      <span
                        className="browser-start-mark"
                        data-web={server.servesWeb ? "true" : undefined}
                      >
                        <span className="browser-start-port">{server.port}</span>
                      </span>
                      <span>
                        <strong>
                          {server.title || server.process || `localhost:${server.port}`}
                        </strong>
                        <small>
                          localhost:{server.port}
                          {server.process && (server.title || !server.process)
                            ? ` · ${server.process}`
                            : ""}
                          {server.servesWeb ? "" : " · not answering as a web page"}
                        </small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="browser-start-pin"
                      aria-label={`Bookmark localhost:${server.port}`}
                      onClick={() =>
                        toggleBrowserBookmark(
                          server.url,
                          server.title || server.process || `localhost:${server.port}`,
                        )
                      }
                    >
                      <Star aria-hidden="true" />
                    </button>
                  </motion.li>
                ))}
              </ul>
            )}
            {others.length > 0 ? (
              <button
                type="button"
                className="browser-start-more"
                onClick={() => setShowAll((open) => !open)}
              >
                {showAll
                  ? "Hide other listening ports"
                  : `Show ${others.length} other listening ${others.length === 1 ? "port" : "ports"}`}
              </button>
            ) : null}
          </section>
        </div>
      </div>
    </motion.div>
  );
}
