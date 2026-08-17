import { Maximize2, Shuffle, X } from "lucide-react";
import { m as motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { BrowserTab } from "../bridge";
import { Tooltip } from "./Tooltip";
import "./browserDeck.css";

/** Cards drawn behind the top one before the rest become a count. */
const VISIBLE_CARDS = 4;

export interface BrowserDeckProps {
  /** This chat's live tabs, in strip order. */
  tabs: BrowserTab[];
  /** Reports where the raised card's page should sit, or null to park it. */
  onBoundsChange: (tabId: string, bounds: DOMRect | null) => void;
  /** Puts the card back in the work pane, at full size. */
  onExpand: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

/**
 * Tabs the work pane is not showing, as a stack of cards in the corner.
 *
 * Closing the pane does not stop an agent mid-page, so the pages it is working
 * on cannot simply vanish — the deck is where they go. The raised card is the
 * live webview at card size; the ones behind it are chrome only, because a
 * native surface paints above HTML and four of them stacked would be four
 * opaque rectangles rather than a deck.
 *
 * That same constraint puts every control *outside* the page rectangle: the
 * title strip above it, the count below. Nothing is ever drawn over a card.
 */
export function BrowserDeck({ tabs, onBoundsChange, onExpand, onClose }: BrowserDeckProps) {
  const [raisedId, setRaisedId] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  // The deck follows the tab list: a tab that closes takes its card with it,
  // and a new one arrives on top, which is where an agent's newest page is.
  const raised = tabs.find((tab) => tab.id === raisedId) ?? tabs.at(-1) ?? null;
  const behind = tabs.filter((tab) => tab.id !== raised?.id).slice(-(VISIBLE_CARDS - 1));
  const hidden = Math.max(0, tabs.length - behind.length - (raised ? 1 : 0));

  const boundsRef = useRef(onBoundsChange);
  useEffect(() => {
    boundsRef.current = onBoundsChange;
  }, [onBoundsChange]);

  // Same placement discipline as the pane: follow the slot rather than hiding
  // and re-showing, and never send a rectangle that has not moved.
  const raisedTabId = raised?.id ?? null;
  const blank = !raised?.url || raised.url === "about:blank";
  useLayoutEffect(() => {
    const node = pageRef.current;
    if (!node || !raisedTabId || blank) return;
    const report = boundsRef.current;
    let frame = 0;
    let last = "";
    const place = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const key = `${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
      if (key === last) return;
      last = key;
      report(raisedTabId, rect);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    schedule();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    observer?.observe(node);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      // Leaving the deck parks the page rather than closing it: the tab keeps
      // running, which is the whole point of the corner.
      report(raisedTabId, null);
    };
  }, [raisedTabId, blank]);

  const cycle = useCallback(() => {
    if (tabs.length < 2) return;
    const at = tabs.findIndex((tab) => tab.id === raised?.id);
    setRaisedId(tabs[(at + 1) % tabs.length]?.id ?? null);
  }, [raised?.id, tabs]);

  if (!raised) return null;

  const label = raised.title || raised.url.replace(/^https?:\/\//, "");
  // "you" is the person's own hold; only an agent's turn is worth marking.
  const agentAt = raised.heldBy && raised.heldBy !== "you" ? raised.heldBy : null;

  return (
    <div className="browser-deck" data-count={tabs.length}>
      <div className="browser-deck-stack">
        {behind.map((tab, index) => (
          <button
            type="button"
            key={tab.id}
            className="browser-deck-card behind"
            style={{ "--depth": String(behind.length - index) } as React.CSSProperties}
            onClick={() => setRaisedId(tab.id)}
            title={tab.title || tab.url}
          >
            <span className="browser-deck-behind-label">
              {tab.title || tab.url.replace(/^https?:\/\//, "")}
            </span>
          </button>
        ))}
        {/* No exit animation: a card on its way out would linger over the
            webview of the card that replaced it, and a native surface paints
            above HTML, so the ghost would sit on top of a live page. The
            incoming card fades in; the outgoing one is simply gone. */}
        <motion.div
          key={raised.id}
          className="browser-deck-card raised"
          data-busy={agentAt ? "true" : undefined}
          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={
            reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34 }
          }
        >
          <div className="browser-deck-bar">
            <span className="browser-deck-title" title={raised.url}>
              {label}
            </span>
            {agentAt ? (
              <span className="browser-deck-who" title={`${agentAt} is working in this tab`}>
                <i aria-hidden="true" />
                {agentAt}
              </span>
            ) : null}
            <div className="browser-deck-actions">
              {tabs.length > 1 ? (
                <Tooltip label="Next tab" placement="top">
                  <button
                    type="button"
                    className="icon-button subtle tiny"
                    aria-label="Next browser tab"
                    onClick={cycle}
                  >
                    <Shuffle aria-hidden="true" />
                  </button>
                </Tooltip>
              ) : null}
              <Tooltip label="Open in the pane" placement="top">
                <button
                  type="button"
                  className="icon-button subtle tiny"
                  aria-label="Open in the pane"
                  onClick={() => onExpand(raised.id)}
                >
                  <Maximize2 aria-hidden="true" />
                </button>
              </Tooltip>
              <Tooltip label="Close tab" placement="top">
                <button
                  type="button"
                  className="icon-button subtle tiny"
                  aria-label="Close browser tab"
                  onClick={() => onClose(raised.id)}
                >
                  <X aria-hidden="true" />
                </button>
              </Tooltip>
            </div>
          </div>
          {/* The webview lands exactly here; nothing may be drawn over it. */}
          <div className="browser-deck-page" ref={pageRef}>
            {blank ? <span className="browser-deck-empty">Empty tab</span> : null}
          </div>
        </motion.div>
      </div>
      {hidden > 0 ? (
        <button type="button" className="browser-deck-more" onClick={cycle}>
          +{hidden} more
        </button>
      ) : null}
    </div>
  );
}
