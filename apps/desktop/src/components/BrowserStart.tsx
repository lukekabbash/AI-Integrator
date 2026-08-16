import { Globe, History, RadioTower, RotateCw } from "lucide-react";
import { m as motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

import { bridge, type LocalServer } from "../bridge";
import { readBrowserRecents } from "./browserRecents";

const railItemSpring = { type: "spring" as const, stiffness: 560, damping: 34, mass: 0.7 };

function relativeTime(at: number): string {
  const seconds = Math.max(1, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * What a blank tab offers: the pages you were just on, and the local servers
 * that actually answer. Listeners that are not web servers stay behind an
 * explicit disclosure — a machine has dozens and none of them are your app.
 */
export function BrowserStart({ onOpen }: { onOpen: (url: string) => void }) {
  const reduceMotion = Boolean(useReducedMotion());
  const [showAll, setShowAll] = useState(false);
  const [recents] = useState(readBrowserRecents);

  // A scan is one request keyed by generation; loading is derived from whether
  // the newest generation has answered, so the effect never sets state twice.
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

  return (
    <div className="browser-start">
      {recents.length > 0 ? (
        <section>
          <span className="browser-start-eyebrow">
            <History aria-hidden="true" />
            Recently opened
          </span>
          <ul className="browser-start-list">
            {recents.map((recent, index) => (
              <motion.li
                key={recent.url}
                initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={
                  reduceMotion ? { duration: 0 } : { ...railItemSpring, delay: index * 0.015 }
                }
              >
                <button type="button" onClick={() => onOpen(recent.url)}>
                  <span className="browser-start-mark">
                    <Globe aria-hidden="true" />
                  </span>
                  <span>
                    <strong>{recent.title || hostOf(recent.url)}</strong>
                    <small>
                      {hostOf(recent.url)} · {relativeTime(recent.at)}
                    </small>
                  </span>
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
              : "No local server is answering yet. Start your dev server, or type an address above."}
          </p>
        ) : (
          <ul className="browser-start-list">
            {shown.map((server, index) => (
              <motion.li
                key={server.port}
                initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={
                  reduceMotion ? { duration: 0 } : { ...railItemSpring, delay: index * 0.015 }
                }
              >
                <button
                  type="button"
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
                    <strong>{server.title || server.process || `localhost:${server.port}`}</strong>
                    <small>
                      localhost:{server.port}
                      {server.process && (server.title || !server.process)
                        ? ` · ${server.process}`
                        : ""}
                      {server.servesWeb ? "" : " · not answering as a web page"}
                    </small>
                  </span>
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
  );
}
