/**
 * Stills of browser tabs, one per tab, held for this window.
 *
 * A native page is a child webview the OS positions over a slot, so the slot
 * itself is empty HTML: switching tabs shows the app's own background until
 * the webview arrives, and a card behind the raised one in the deck cannot
 * hold a second live page at all. Both want the same thing — the last picture
 * taken of that tab — so both read it from here.
 *
 * The picture is fetched per tab rather than carried on the tab snapshot: that
 * snapshot streams on every browser event, and a base64 PNG per tab inside it
 * would push megabytes through IPC every time a title changed.
 */

/** The one native call this needs; `null` when there are no native tabs. */
export interface BrowserPosterSource {
  poster(taskId: string, tabId: string): Promise<string | null>;
  /** A fresh capture rather than the cached still; absent on older natives. */
  refreshPoster?(taskId: string, tabId: string): Promise<string | null>;
}

/** The parts of a tab that decide whether its still is still the right one. */
export interface PosterTab {
  id: string;
  url: string;
  loading?: boolean;
}

interface PosterEntry {
  /** Data URL for the still, or "" while the first fetch is out. */
  url: string;
  /** The address it was fetched for: a page that moved on needs a new one. */
  forUrl: string;
  pending: boolean;
  attempts: number;
  request: number;
}

const NO_POSTERS: Readonly<Record<string, string>> = Object.freeze({});
/** The native capture settles 700 ms after load; one later read picks it up. */
const POSTER_RETRY_MS = 900;

export class BrowserPosterCache {
  private readonly entries = new Map<string, PosterEntry>();
  private readonly listeners = new Set<() => void>();
  private view = NO_POSTERS;
  private requestSequence = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** A stable object between changes, so React may compare it by identity. */
  readonly snapshot = (): Readonly<Record<string, string>> => this.view;

  /**
   * Keeps one still per open tab and forgets the rest. A tab whose address has
   * moved on is asked again, because its old picture is of another page.
   */
  sync(
    source: BrowserPosterSource | null,
    taskId: string | null,
    tabs: readonly PosterTab[],
  ): void {
    const open = new Set(tabs.map((tab) => tab.id));
    let changed = false;
    for (const id of [...this.entries.keys()]) {
      if (open.has(id)) continue;
      this.entries.delete(id);
      changed = true;
    }
    if (changed) this.publish();
    if (!source || !taskId) return;
    for (const tab of tabs) {
      const entry = this.entries.get(tab.id);
      // A same-address reload is still a new document. Drop its old picture
      // while loading, then the finished snapshot will start a fresh fetch.
      if (tab.loading) {
        if (entry) {
          this.entries.delete(tab.id);
          this.publish();
        }
        continue;
      }
      if (entry?.forUrl === tab.url) continue;
      this.fetch(source, taskId, tab);
    }
  }

  /**
   * Asks again for one tab at a lifecycle boundary such as parking it. Native
   * capture is independent of placement, so this read can never delay a move.
   */
  refresh(source: BrowserPosterSource | null, taskId: string, tabId: string): void {
    const entry = this.entries.get(tabId);
    // A tab nothing has asked about yet belongs to `sync`, which knows its
    // address; asking here would record the wrong one and fetch twice.
    if (!source || !entry || entry.pending) return;
    this.fetch(source, taskId, { id: tabId, url: entry.forUrl });
  }

  /**
   * Takes a new still now and paints it. For the moments a page must stand
   * down while it is still the page the person is looking at — the address
   * field's suggestions opening over it, the compact deck resting on it — so
   * what shows underneath is the page as it is, not as it loaded.
   */
  warm(source: BrowserPosterSource | null, taskId: string, tabId: string): void {
    const entry = this.entries.get(tabId);
    if (!source?.refreshPoster || !entry) return;
    const request = ++this.requestSequence;
    const forUrl = entry.forUrl;
    void Promise.resolve()
      .then(() => source.refreshPoster?.(taskId, tabId) ?? null)
      .then((base64) => {
        const current = this.entries.get(tabId);
        // A page that moved on, or a newer read, wins.
        if (!base64 || !current || current.forUrl !== forUrl || current.request > request) return;
        this.entries.set(tabId, { ...current, url: `data:image/png;base64,${base64}`, request });
        this.publish();
      })
      .catch(() => undefined);
  }

  private fetch(source: BrowserPosterSource, taskId: string, tab: PosterTab): void {
    const previous = this.entries.get(tab.id);
    const samePage = previous?.forUrl === tab.url;
    const attempts = samePage ? previous.attempts + 1 : 1;
    const request = ++this.requestSequence;
    this.entries.set(tab.id, {
      // Never paint a previous address under the new page.
      url: samePage ? (previous?.url ?? "") : "",
      forUrl: tab.url,
      pending: true,
      attempts,
      request,
    });
    // Through a resolved promise so a source that throws, or one without this
    // call at all, ends as "no still" rather than as an unhandled rejection.
    void Promise.resolve()
      .then(() => source.poster(taskId, tab.id))
      .then((base64) => this.settle(source, taskId, tab, request, base64 ?? null))
      .catch(() => this.settle(source, taskId, tab, request, null));
  }

  private settle(
    source: BrowserPosterSource,
    taskId: string,
    tab: PosterTab,
    request: number,
    base64: string | null,
  ): void {
    const entry = this.entries.get(tab.id);
    // The tab closed, navigated, or `sync` dropped it while the call was out.
    if (!entry || entry.forUrl !== tab.url || entry.request !== request) return;
    // A tab that has never been on screen has no still yet; keeping the one it
    // had beats blanking a card that is already showing a picture.
    const url = (base64 ? `data:image/png;base64,${base64}` : "") || entry.url;
    this.entries.set(tab.id, { ...entry, url, pending: false });
    if ((this.view[tab.id] ?? "") !== url) this.publish();

    if (url || entry.attempts >= 2) return;
    window.setTimeout(() => {
      const current = this.entries.get(tab.id);
      if (!current || current.forUrl !== tab.url || current.pending || current.url) return;
      this.fetch(source, taskId, tab);
    }, POSTER_RETRY_MS);
  }

  private publish(): void {
    const view: Record<string, string> = {};
    for (const [id, entry] of this.entries) {
      if (entry.url) view[id] = entry.url;
    }
    this.view = Object.keys(view).length === 0 ? NO_POSTERS : view;
    for (const listener of this.listeners) listener();
  }
}

/** This window's stills. One cache per renderer; windows never share one. */
export const browserPosters = new BrowserPosterCache();
