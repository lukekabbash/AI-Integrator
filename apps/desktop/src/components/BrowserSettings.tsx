import { AlertTriangle, ChevronDown, Globe, KeyRound, RotateCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  bridge,
  type BrowserIdentityBucket,
  type BrowserIdentityOverview,
  type BrowserIdentityScope,
  type BrowserIdentitySwitchResult,
  type BrowserSite,
  type SavedLogin,
} from "../bridge";
import { isSearchEngineId, writeSearchEngine, type SearchEngineId } from "../browserOmnibox";
import { Dropdown } from "./Dropdown";
import { SettingRow, Switch } from "./SettingControls";
import { readSetting, type SettingsMap } from "./settingsModel";

export const BROWSER_SETTINGS = {
  agentAccess: "browser.agentAccess",
  lockActiveTab: "browser.lockActiveTab",
  keepSignedIn: "browser.keepSignedIn",
  blockNewWindows: "browser.blockNewWindows",
  externalOpen: "browser.externalOpen",
  dismissConsent: "browser.dismissConsent",
  identityScope: "browser.identityScope",
  /** Set once the one-time "identities are now per project" line is dismissed. */
  identityPerGroupNoticeSeen: "browser.identityPerGroupNoticeSeen",
  searchEngine: "browser.searchEngine",
  /** Popped-out tabs untouched this many days move to Recently closed. */
  popoutStaleDays: "browser.popoutStaleDays",
  /** Popped-out tabs beyond this many (oldest first) move to Recently closed. */
  popoutMaxTabs: "browser.popoutMaxTabs",
} as const;

/** A whole number setting from a text field, kept inside its bounds. */
function clampInt(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function SharedScopeWarning({
  open,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  if (!open) return null;
  const modal = (
    <div
      className="delete-project-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section
        className="delete-project-modal browser-scope-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (!busy) onCancel();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)"),
          );
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="delete-project-header">
          <h2 id={titleId}>Switch to one Shared browser identity?</h2>
          <button
            className="delete-project-close"
            type="button"
            aria-label="Close"
            disabled={busy}
            onClick={onCancel}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="browser-scope-warning" id={descriptionId}>
          <AlertTriangle aria-hidden="true" />
          <div>
            <p>
              Cookies and saved logins from every project and from Chat will be merged into Shared.
              For conflicting entries, the most recently active identity wins.
            </p>
            <ul>
              <li>
                This can combine parts of different account sessions and cause sign-in errors.
              </li>
              <li>If a site breaks, clear its Shared data and sign in again.</li>
              <li>Project and Chat source identities stay intact.</li>
              <li>The new scope applies after Integrator restarts.</li>
            </ul>
          </div>
        </div>
        {error ? (
          <p className="delete-project-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="delete-project-footer">
          <button
            ref={cancelRef}
            className="delete-project-cancel"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="delete-project-confirm"
            type="button"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Merging…" : "Merge and use Shared"}
          </button>
        </footer>
      </section>
    </div>
  );
  return typeof document === "undefined" ? modal : createPortal(modal, document.body);
}

function switchSummary(result: BrowserIdentitySwitchResult): string {
  if (result.configuredScope === "task") {
    return result.restartRequired
      ? "Per-project browser identity will apply after restart."
      : "Browser identity is scoped per project.";
  }
  const conflicts = result.cookieConflicts + result.loginConflicts;
  const merged = result.mergedCookies + result.mergedLogins;
  const partitioned = result.skippedPartitionedCookies
    ? `, ${result.skippedPartitionedCookies} partitioned ${
        result.skippedPartitionedCookies === 1 ? "cookie" : "cookies"
      } kept per project`
    : "";
  return `Shared browser prepared: ${merged} ${merged === 1 ? "entry" : "entries"} merged${
    conflicts ? `, ${conflicts} ${conflicts === 1 ? "conflict" : "conflicts"} resolved` : ""
  }${partitioned}. Restart Integrator to apply it.`;
}

/** Browser policy plus bucketed, metadata-only management of local browser identity. */
export function BrowserSettings({
  settings,
  setSetting,
  onIdentityScopeChanged,
}: {
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
  onIdentityScopeChanged?: (scope: BrowserIdentityScope) => void;
}) {
  const api = bridge.browser;
  const available = Boolean(api);
  const [overview, setOverview] = useState<BrowserIdentityOverview | null>(null);
  const [logins, setLogins] = useState<SavedLogin[]>([]);
  const [sitesByBucket, setSitesByBucket] = useState<
    Record<string, BrowserSite[] | null | undefined>
  >({});
  const [siteErrors, setSiteErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [generation, setGeneration] = useState(0);
  const [loadedGeneration, setLoadedGeneration] = useState<number | null>(available ? null : 0);
  const [busyBucket, setBusyBucket] = useState("");
  const [warningOpen, setWarningOpen] = useState(false);
  const [scopeBusy, setScopeBusy] = useState(false);
  const [scopeError, setScopeError] = useState("");

  const refresh = useCallback(() => {
    setSitesByBucket({});
    setSiteErrors({});
    setExpanded(new Set());
    setGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    const engine = readSetting(settings, BROWSER_SETTINGS.searchEngine, "google");
    if (isSearchEngineId(engine)) writeSearchEngine(engine);
  }, [settings]);

  useEffect(() => {
    if (!api) return;
    let active = true;
    void Promise.all([api.identityOverview(), api.savedLogins()])
      .then(([nextOverview, nextLogins]) => {
        if (!active) return;
        setOverview(nextOverview);
        setLogins(nextLogins);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setOverview(null);
        setLogins([]);
        setMessage(error instanceof Error ? error.message : "Could not read browser identities.");
      })
      .finally(() => active && setLoadedGeneration(generation));
    return () => {
      active = false;
    };
  }, [api, generation]);

  const loadBucketSites = useCallback(
    (bucketId: string) => {
      if (!api) return;
      setSitesByBucket((current) => ({ ...current, [bucketId]: null }));
      setSiteErrors((current) => ({ ...current, [bucketId]: "" }));
      void api
        .bucketSites(bucketId)
        .then((sites) => setSitesByBucket((current) => ({ ...current, [bucketId]: sites })))
        .catch((error: unknown) => {
          setSitesByBucket((current) => ({ ...current, [bucketId]: [] }));
          setSiteErrors((current) => ({
            ...current,
            [bucketId]: error instanceof Error ? error.message : "Could not inspect this bucket.",
          }));
        });
    },
    [api],
  );

  const toggleBucket = (bucketId: string) => {
    const opening = !expanded.has(bucketId);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(bucketId)) next.delete(bucketId);
      else next.add(bucketId);
      return next;
    });
    if (opening && !(bucketId in sitesByBucket)) loadBucketSites(bucketId);
  };

  const reloadOverview = useCallback(async () => {
    if (!api) return;
    const [nextOverview, nextLogins] = await Promise.all([
      api.identityOverview(),
      api.savedLogins(),
    ]);
    setOverview(nextOverview);
    setLogins(nextLogins);
  }, [api]);

  const clearBucket = async (bucketId: string, label: string) => {
    if (!api) return;
    setBusyBucket(bucketId);
    setMessage("");
    try {
      await api.clearBucket(bucketId);
      setSitesByBucket((current) => ({ ...current, [bucketId]: [] }));
      await reloadOverview();
      setMessage(`${label} cookies, storage, and cache cleared. Saved logins were kept.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Could not clear ${label}.`);
    } finally {
      setBusyBucket("");
    }
  };

  const forgetBucket = async (bucketId: string, label: string) => {
    if (!api) return;
    setBusyBucket(bucketId);
    setMessage("");
    try {
      setLogins(await api.forgetBucketLogins(bucketId));
      await reloadOverview();
      setMessage(`${label} saved logins removed from the OS credential store.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Could not forget ${label} logins.`);
    } finally {
      setBusyBucket("");
    }
  };

  /** Clears an older per-task identity in one go: its site data and its saved logins. */
  const clearLegacy = async (bucket: BrowserIdentityBucket) => {
    if (!api) return;
    setBusyBucket(bucket.id);
    setMessage("");
    try {
      if (bucket.profilePresent) await api.clearBucket(bucket.id);
      if (logins.some((login) => login.bucketId === bucket.id)) {
        setLogins(await api.forgetBucketLogins(bucket.id));
      }
      setSitesByBucket((current) => ({ ...current, [bucket.id]: [] }));
      await reloadOverview();
      setMessage(`${bucket.name} cleared: site data and saved logins removed.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Could not clear ${bucket.name}.`);
    } finally {
      setBusyBucket("");
    }
  };

  const setIdentityScope = async (scope: BrowserIdentityScope) => {
    if (!api) return;
    setScopeBusy(true);
    setScopeError("");
    setMessage("");
    try {
      const result = await api.setIdentityScope(scope);
      onIdentityScopeChanged?.(scope);
      setOverview((current) =>
        current
          ? {
              ...current,
              activeScope: result.activeScope,
              configuredScope: result.configuredScope,
              restartRequired: result.restartRequired,
            }
          : current,
      );
      setWarningOpen(false);
      setMessage(switchSummary(result));
      await reloadOverview();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Could not change browser scope.";
      if (scope === "shared") setScopeError(detail);
      else setMessage(detail);
    } finally {
      setScopeBusy(false);
    }
  };

  const flag = (key: string, fallback: boolean) => readSetting(settings, key, fallback) !== false;
  const configuredScope =
    overview?.configuredScope ??
    readSetting<BrowserIdentityScope>(settings, BROWSER_SETTINGS.identityScope, "task");
  const loading = available && loadedGeneration !== generation;
  const noticeSeen =
    readSetting<boolean>(settings, BROWSER_SETTINGS.identityPerGroupNoticeSeen, false) === true;
  const currentBuckets = overview?.buckets.filter((bucket) => !bucket.legacy) ?? [];
  const legacyBuckets = overview?.buckets.filter((bucket) => bucket.legacy) ?? [];

  return (
    <>
      <div className="settings-page-heading">
        <span>
          <Globe />
        </span>
        <div>
          <h1>Browser</h1>
          <p>
            Browser tabs in the work pane, their local identity boundaries, and what agents may do.
          </p>
        </div>
      </div>

      <section className="settings-section">
        <header>
          <h2>Browser identity</h2>
          <p>Choose where cookies, site storage, cache, and saved logins are available.</p>
        </header>
        <div
          className="browser-scope-options"
          role="radiogroup"
          aria-label="Browser identity scope"
        >
          <button
            type="button"
            role="radio"
            aria-checked={configuredScope === "task"}
            data-selected={configuredScope === "task"}
            disabled={!available || scopeBusy}
            onClick={() => void setIdentityScope("task")}
          >
            <strong>Per project (recommended)</strong>
            <small>
              Every task in a project shares one signed-in identity; standalone chats share the Chat
              identity.
            </small>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={configuredScope === "shared"}
            data-selected={configuredScope === "shared"}
            disabled={!available || scopeBusy}
            onClick={() => {
              if (configuredScope !== "shared") {
                setScopeError("");
                setWarningOpen(true);
              }
            }}
          >
            <strong>Shared</strong>
            <small>Every project and chat uses one browser identity after restart.</small>
          </button>
        </div>
        {overview?.restartRequired ? (
          <p className="browser-restart-note" role="status">
            Restart Integrator to apply{" "}
            {overview.configuredScope === "shared" ? "Shared" : "Per project"}. Open tabs keep their
            current identity until then.
          </p>
        ) : null}
        {noticeSeen ? null : (
          <p className="browser-restart-note browser-identity-notice" role="status">
            Browser identities are now per project: tasks in the same project share cookies and
            saved logins, and earlier per-task identities are listed below under older identities.
            <button
              className="secondary-button small"
              type="button"
              onClick={() => setSetting(BROWSER_SETTINGS.identityPerGroupNoticeSeen, true)}
            >
              Got it
            </button>
          </p>
        )}
      </section>

      <section className="settings-section">
        <header>
          <h2>Search</h2>
          <p>The address field searches here when the line is not a URL. Queries are not logged.</p>
        </header>
        <SettingRow
          label="Search engine"
          description="Used from a new tab and from the address field. Bookmarks stay independent of this."
        >
          <Dropdown
            aria-label="Search engine"
            value={readSetting<SearchEngineId>(settings, BROWSER_SETTINGS.searchEngine, "google")}
            onChange={(value) => {
              const engine = isSearchEngineId(value) ? value : "google";
              setSetting(BROWSER_SETTINGS.searchEngine, engine);
              writeSearchEngine(engine);
            }}
            options={[
              { value: "google", label: "Google" },
              { value: "ddg", label: "DuckDuckGo" },
            ]}
          />
        </SettingRow>
      </section>

      <section className="settings-section">
        <header>
          <h2>Browser windows</h2>
          <p>
            Popped-out windows come back after a restart, with their tabs asleep until you click
            them. Tabs you have not touched for a while, or beyond a limit, move to Recently closed
            in their group menu.
          </p>
        </header>
        <SettingRow
          label="Move untouched tabs after"
          description="Days since a popped-out tab was last used. Recently closed keeps its address."
        >
          <input
            className="subagent-number"
            type="number"
            aria-label="Move untouched tabs after (days)"
            min={1}
            max={365}
            value={readSetting<number>(settings, BROWSER_SETTINGS.popoutStaleDays, 7)}
            onChange={(event) =>
              setSetting(BROWSER_SETTINGS.popoutStaleDays, clampInt(event.target.value, 1, 365, 7))
            }
          />
        </SettingRow>
        <SettingRow
          label="Keep at most this many popped-out tabs"
          description="Beyond it, the oldest move to Recently closed so windows stay light."
        >
          <input
            className="subagent-number"
            type="number"
            aria-label="Keep at most this many popped-out tabs"
            min={10}
            max={1000}
            value={readSetting<number>(settings, BROWSER_SETTINGS.popoutMaxTabs, 100)}
            onChange={(event) =>
              setSetting(
                BROWSER_SETTINGS.popoutMaxTabs,
                clampInt(event.target.value, 10, 1000, 100),
              )
            }
          />
        </SettingRow>
      </section>

      <section className="settings-section">
        <header>
          <h2>Agent access</h2>
          <p>Tabs stay task-owned even when their browser identity is Shared.</p>
        </header>
        <SettingRow
          label="Let agents open and drive browser tabs"
          description="Turns on open, read, click, type and wait. Off refuses every browser tool with a reason."
        >
          <Switch
            checked={flag(BROWSER_SETTINGS.agentAccess, true)}
            onChange={(next) => setSetting(BROWSER_SETTINGS.agentAccess, next)}
            label="Let agents open and drive browser tabs"
          />
        </SettingRow>
        <SettingRow
          label="Lock agents out of the tab you are using"
          description="When you click or type in a tab, agents wait until you stop. Off lets them keep working in that same tab alongside you."
        >
          <Switch
            checked={readSetting<boolean>(settings, BROWSER_SETTINGS.lockActiveTab, false)}
            onChange={(next) => setSetting(BROWSER_SETTINGS.lockActiveTab, next)}
            label="Lock agents out of the tab you are using"
          />
        </SettingRow>
        <SettingRow
          label="Decline cookie banners automatically"
          description="Clicks reject on recognized consent dialogs. It never accepts or touches a login wall, age gate, or terms dialog."
        >
          <Switch
            checked={readSetting<boolean>(settings, BROWSER_SETTINGS.dismissConsent, false)}
            onChange={(next) => setSetting(BROWSER_SETTINGS.dismissConsent, next)}
            label="Decline cookie banners automatically"
          />
        </SettingRow>
        <SettingRow
          label="Keep pop-ups inside Integrator"
          description="Loads a new window in the same tab so sign-in hops remain visible."
        >
          <Switch
            checked={flag(BROWSER_SETTINGS.blockNewWindows, true)}
            onChange={(next) => setSetting(BROWSER_SETTINGS.blockNewWindows, next)}
            label="Keep pop-ups inside Integrator"
          />
        </SettingRow>
        <SettingRow
          label="Allow opening tabs in an external browser"
          description="Shows the external-browser action in embedded tabs. Off keeps every browser handoff inside Integrator and tells agents to use only Integrator browser tools."
        >
          <Switch
            checked={flag(BROWSER_SETTINGS.externalOpen, false)}
            onChange={(next) => setSetting(BROWSER_SETTINGS.externalOpen, next)}
            label="Allow opening tabs in an external browser"
          />
        </SettingRow>
      </section>

      <section className="settings-section">
        <header>
          <h2>Browser data by identity</h2>
          <p>
            Cookie values and passwords are never shown here. Saved passwords stay in the OS
            credential store; this view receives metadata only.
          </p>
        </header>
        <SettingRow
          label="Stay signed in between sessions"
          description="Keeps each identity's cookies and site data under Integrator's local data directory."
        >
          <Switch
            checked={flag(BROWSER_SETTINGS.keepSignedIn, true)}
            onChange={(next) => setSetting(BROWSER_SETTINGS.keepSignedIn, next)}
            label="Stay signed in between sessions"
          />
        </SettingRow>
        <div className="browser-sites-header">
          <span className="settings-eyebrow">Projects, then Chat and Shared</span>
          <button
            className="icon-button subtle tiny"
            type="button"
            aria-label="Refresh browser identities"
            disabled={loading}
            onClick={refresh}
          >
            <RotateCw className={loading ? "spin" : undefined} aria-hidden="true" />
          </button>
        </div>
        {!available ? (
          <div className="settings-empty">Browser identities need the desktop app.</div>
        ) : loading && !overview ? (
          <div className="settings-empty">Reading local browser identities…</div>
        ) : !overview?.buckets.length ? (
          <div className="settings-empty">No browser identities are available.</div>
        ) : (
          <div className="browser-buckets">
            {currentBuckets.map((bucket) => {
              const isOpen = expanded.has(bucket.id);
              const sites = sitesByBucket[bucket.id];
              const bucketLogins = logins.filter((login) => login.bucketId === bucket.id);
              const busy = busyBucket === bucket.id;
              const storedSummary = [
                bucket.profilePresent ? "browser data" : "no browser data",
                `${bucketLogins.length} saved ${bucketLogins.length === 1 ? "login" : "logins"}`,
              ].join(" · ");
              return (
                <article className="browser-bucket" key={bucket.id} data-kind={bucket.kind}>
                  <button
                    className="browser-bucket-toggle"
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => toggleBucket(bucket.id)}
                  >
                    <span>
                      <strong>{bucket.name}</strong>
                      <small>
                        {bucket.kind === "project"
                          ? `Project · every task in it · ${storedSummary}`
                          : bucket.kind === "path"
                            ? `Folder without a project · ${storedSummary}`
                            : bucket.kind === "chat"
                              ? `Standalone chats · ${storedSummary}`
                              : bucket.kind === "shared"
                                ? `Shared scope · ${storedSummary}`
                                : `Older per-task identity · ${storedSummary}`}
                      </small>
                    </span>
                    <ChevronDown aria-hidden="true" />
                  </button>
                  {isOpen ? (
                    <div className="browser-bucket-body">
                      {sites === null || sites === undefined ? (
                        <div className="settings-empty">Reading cookie metadata…</div>
                      ) : sites.length ? (
                        <ul className="browser-sites-list">
                          {sites.map((site) => (
                            <li key={`${site.origin}:${site.persistent}`}>
                              <span>
                                <strong>{site.origin}</strong>
                                <small>
                                  {site.cookies} {site.cookies === 1 ? "cookie" : "cookies"} ·{" "}
                                  {site.persistent
                                    ? "kept between sessions"
                                    : "cleared when Integrator closes"}
                                </small>
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {bucketLogins.length ? (
                        <ul className="browser-sites-list browser-login-list">
                          {bucketLogins.map((login) => (
                            <li key={`${login.bucketId}:${login.origin}:${login.username}`}>
                              <span>
                                <strong>
                                  <KeyRound aria-hidden="true" /> {login.origin}
                                </strong>
                                <small>
                                  {login.username}
                                  {login.lastUsedAt
                                    ? ` · last used ${new Date(login.lastUsedAt).toLocaleDateString()}`
                                    : " · never used"}
                                </small>
                              </span>
                              <button
                                className="icon-button subtle tiny"
                                type="button"
                                aria-label={`Forget the login for ${login.username} on ${login.origin}`}
                                disabled={busy}
                                onClick={() => {
                                  setBusyBucket(bucket.id);
                                  void api
                                    ?.forgetLogin(login.bucketId, login.origin, login.username)
                                    .then((next) => {
                                      setLogins(next);
                                      setMessage(`Forgot ${login.username} on ${login.origin}.`);
                                    })
                                    .catch(() => setMessage("Could not forget that login."))
                                    .finally(() => setBusyBucket(""));
                                }}
                              >
                                <Trash2 aria-hidden="true" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {sites?.length === 0 &&
                      bucketLogins.length === 0 &&
                      !siteErrors[bucket.id] ? (
                        <div className="settings-empty">
                          No cookies or saved logins in this identity.
                        </div>
                      ) : null}
                      {siteErrors[bucket.id] ? (
                        <p className="settings-action-message" role="alert">
                          {siteErrors[bucket.id]}
                        </p>
                      ) : null}
                      <div className="settings-action-row browser-bucket-actions">
                        <button
                          className="secondary-button small"
                          type="button"
                          disabled={busy || !bucket.profilePresent}
                          onClick={() => void clearBucket(bucket.id, bucket.name)}
                        >
                          <Trash2 aria-hidden="true" />
                          Clear site data
                        </button>
                        <button
                          className="secondary-button small"
                          type="button"
                          disabled={busy || bucketLogins.length === 0}
                          onClick={() => void forgetBucket(bucket.id, bucket.name)}
                        >
                          <KeyRound aria-hidden="true" />
                          Forget saved logins
                        </button>
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
        {legacyBuckets.length ? (
          <div className="browser-legacy-buckets">
            <button
              className="browser-bucket-toggle"
              type="button"
              aria-expanded={legacyOpen}
              onClick={() => setLegacyOpen((open) => !open)}
            >
              <span>
                <strong>Older per-task identities ({legacyBuckets.length})</strong>
                <small>
                  Cookies and logins from before identities were per project. New tabs never use
                  them; clear each once you no longer need it.
                </small>
              </span>
              <ChevronDown aria-hidden="true" />
            </button>
            {legacyOpen ? (
              <ul className="browser-sites-list browser-legacy-list">
                {legacyBuckets.map((bucket) => {
                  const bucketLogins = logins.filter((login) => login.bucketId === bucket.id);
                  const busy = busyBucket === bucket.id;
                  const empty = !bucket.profilePresent && bucketLogins.length === 0;
                  return (
                    <li key={bucket.id} data-kind={bucket.kind}>
                      <span>
                        <strong>{bucket.name}</strong>
                        <small>
                          {[
                            bucket.kind === "orphan"
                              ? "no longer belongs to anything"
                              : bucket.archived
                                ? "archived or deleted task"
                                : "task",
                            bucket.profilePresent ? "browser data" : "no browser data",
                            `${bucketLogins.length} saved ${
                              bucketLogins.length === 1 ? "login" : "logins"
                            }`,
                          ].join(" · ")}
                        </small>
                      </span>
                      <button
                        className="secondary-button small"
                        type="button"
                        aria-label={`Clear ${bucket.name}`}
                        disabled={busy || empty}
                        onClick={() => void clearLegacy(bucket)}
                      >
                        <Trash2 aria-hidden="true" />
                        Clear
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        ) : null}
        {message ? (
          <p className="settings-action-message" role="status">
            {message}
          </p>
        ) : null}
        <p className="settings-hint">
          A saved password cannot be shown back to you, and no agent can read one. Agents need your
          per-site approval before Integrator types a saved login.
        </p>
      </section>

      <SharedScopeWarning
        open={warningOpen}
        busy={scopeBusy}
        error={scopeError}
        onCancel={() => {
          if (!scopeBusy) setWarningOpen(false);
        }}
        onConfirm={() => void setIdentityScope("shared")}
      />
    </>
  );
}
