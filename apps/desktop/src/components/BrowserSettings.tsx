import { Globe, KeyRound, RotateCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { bridge, type BrowserSite, type SavedLogin } from "../bridge";
import { SettingRow, Switch } from "./SettingControls";
import { readSetting, type SettingsMap } from "./settingsModel";

export const BROWSER_SETTINGS = {
  agentAccess: "browser.agentAccess",
  keepSignedIn: "browser.keepSignedIn",
  blockNewWindows: "browser.blockNewWindows",
  externalOpen: "browser.externalOpen",
  dismissConsent: "browser.dismissConsent",
} as const;

/**
 * Browser settings. Sign-in state is cookies in a profile directory on this
 * computer — the same thing your everyday browser keeps. Integrator never
 * reads, stores or shows a password, so this page lists the sites holding
 * state and offers to forget them, and nothing more.
 */
export function BrowserSettings({
  settings,
  setSetting,
}: {
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
}) {
  const [sites, setSites] = useState<BrowserSite[]>([]);
  const [logins, setLogins] = useState<SavedLogin[]>([]);
  const [message, setMessage] = useState("");
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState<number | null>(null);
  const available = Boolean(bridge.browser);
  const loading = available && loaded !== generation;

  useEffect(() => {
    const api = bridge.browser;
    let active = true;
    (api?.sites() ?? Promise.resolve<BrowserSite[]>([]))
      .then((next) => {
        if (!active) return;
        setSites(next);
        setLoaded(generation);
      })
      .catch(() => {
        if (!active) return;
        setSites([]);
        setLoaded(generation);
      });
    return () => {
      active = false;
    };
  }, [generation]);

  useEffect(() => {
    let active = true;
    (bridge.browser?.savedLogins() ?? Promise.resolve<SavedLogin[]>([]))
      .then((next) => active && setLogins(next))
      .catch(() => active && setLogins([]));
    return () => {
      active = false;
    };
  }, [generation]);

  const clearAll = useCallback(async () => {
    setMessage("");
    try {
      await bridge.browser?.clearData();
      setGeneration((value) => value + 1);
      setMessage("Signed out everywhere and cleared this browser's cache.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not clear browsing data.");
    }
  }, []);

  const flag = (key: string, fallback: boolean) => readSetting(settings, key, fallback) !== false;

  return (
    <>
      <div className="settings-page-heading">
        <span>
          <Globe />
        </span>
        <div>
          <h1>Browser</h1>
          <p>
            The browser tabs Integrator opens in the work pane, and what agents may do with them.
          </p>
        </div>
      </div>

      <section className="settings-section">
        <header>
          <h2>Agent access</h2>
          <p>
            Browser tabs belong to a task, and an agent can only reach its own task&apos;s tabs.
          </p>
        </header>
        <SettingRow
          label="Let agents open and drive browser tabs"
          description="Turns on open, read a page, click, type and wait — and asks agents to check web work here instead of assuming it worked. Off refuses every browser tool with a reason."
        >
          <Switch
            checked={flag(BROWSER_SETTINGS.agentAccess, true)}
            onChange={(next) => setSetting(BROWSER_SETTINGS.agentAccess, next)}
            label="Let agents open and drive browser tabs"
          />
        </SettingRow>
        <SettingRow
          label="Decline cookie banners automatically"
          description="Clicks the reject control on consent dialogs from vendors Integrator recognises — Cookiebot, OneTrust, Didomi and a few more. Never accepts, and never touches a login wall, an age gate or a terms dialog, which wear the same shape and mean something else."
        >
          <Switch
            checked={readSetting<boolean>(settings, BROWSER_SETTINGS.dismissConsent, false)}
            onChange={(next) => setSetting(BROWSER_SETTINGS.dismissConsent, next)}
            label="Decline cookie banners automatically"
          />
        </SettingRow>
        <SettingRow
          label="Keep pop-ups inside Integrator"
          description="A page that opens a new window loads it in the same tab, so a sign-in hop stays somewhere you can watch."
        >
          <Switch
            checked={flag(BROWSER_SETTINGS.blockNewWindows, true)}
            onChange={(next) => setSetting(BROWSER_SETTINGS.blockNewWindows, next)}
            label="Keep pop-ups inside Integrator"
          />
        </SettingRow>
        <SettingRow
          label="Allow opening tabs in an external browser"
          description="Shows the external-browser action in embedded tabs. Off keeps every browser handoff inside Integrator."
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
          <h2>Signing in</h2>
          <p>
            Sites you sign into stay signed in on this computer, so an automation does not have to
            log in again. Integrator never sees or stores your passwords — sign-in stays between you
            and the site.
          </p>
        </header>
        <SettingRow
          label="Stay signed in between sessions"
          description="Keeps cookies and site data in a profile under Integrator's local data directory."
        >
          <Switch
            checked={flag(BROWSER_SETTINGS.keepSignedIn, true)}
            onChange={(next) => setSetting(BROWSER_SETTINGS.keepSignedIn, next)}
            label="Stay signed in between sessions"
          />
        </SettingRow>
        <div className="browser-sites-header">
          <span className="settings-eyebrow">Sites holding sign-in state</span>
          <button
            className="icon-button subtle tiny"
            type="button"
            aria-label="Refresh site list"
            disabled={loading}
            onClick={() => setGeneration((value) => value + 1)}
          >
            <RotateCw className={loading ? "spin" : undefined} aria-hidden="true" />
          </button>
        </div>
        {sites.length === 0 ? (
          <div className="settings-empty">
            {!available
              ? "Browser tabs need the desktop app."
              : loading
                ? "Reading this browser's cookies…"
                : "No site has stored anything yet. Open a browser tab and sign in; it will appear here."}
          </div>
        ) : (
          <ul className="browser-sites-list">
            {sites.map((site) => (
              <li key={site.origin}>
                <span>
                  <strong>{site.origin}</strong>
                  <small>
                    {site.cookies} {site.cookies === 1 ? "cookie" : "cookies"} ·{" "}
                    {site.persistent ? "kept between sessions" : "cleared when Integrator closes"}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="settings-action-row">
          <button
            className="secondary-button small"
            type="button"
            disabled={!available}
            onClick={() => void clearAll()}
          >
            <Trash2 aria-hidden="true" />
            Sign out everywhere and clear data
          </button>
        </div>
        {message ? (
          <p className="settings-action-message" role="status">
            {message}
          </p>
        ) : null}
      </section>

      <section className="settings-section">
        <header>
          <h2>Saved logins</h2>
          <p>
            Passwords you have asked Integrator to remember. Each one lives in this computer&apos;s
            credential store and is only ever typed into the exact site it was saved for — never a
            subdomain, never after a redirect. Save one from a browser tab: sign in, then choose
            <strong> Save this login</strong> from the tab&apos;s menu.
          </p>
        </header>
        {logins.length === 0 ? (
          <div className="settings-empty">
            {available
              ? "Nothing saved yet."
              : "Saved logins need the desktop app and its credential store."}
          </div>
        ) : (
          <ul className="browser-sites-list">
            {logins.map((login) => (
              <li key={`${login.projectId}:${login.origin}:${login.username}`}>
                <span>
                  <strong>
                    <KeyRound aria-hidden="true" /> {login.origin}
                  </strong>
                  <small>
                    {login.username} ·{" "}
                    {login.projectId === "*" ? "every project" : "this project only"}
                    {login.lastUsedAt
                      ? ` · last used ${new Date(login.lastUsedAt).toLocaleDateString()}`
                      : " · never used"}
                  </small>
                </span>
                <button
                  className="icon-button subtle tiny"
                  type="button"
                  aria-label={`Forget the login for ${login.username} on ${login.origin}`}
                  onClick={() => {
                    void bridge.browser
                      ?.forgetLogin(login.projectId, login.origin, login.username)
                      .then(setLogins)
                      .catch(() => setMessage("Could not forget that login."));
                  }}
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* Said plainly rather than quietly omitted: a reveal is only worth
            anything behind an OS re-authentication gate, and that is its own
            piece of work. */}
        <p className="settings-hint">
          A saved password cannot be shown back to you, and no agent can read one. An agent may ask
          to sign in; you decide per site, and it is told the username at most.
        </p>
        {logins.length > 0 ? (
          <div className="settings-action-row">
            <button
              className="secondary-button small"
              type="button"
              onClick={() => {
                void bridge.browser
                  ?.forgetAllLogins()
                  .then(setLogins)
                  .catch(() => setMessage("Could not forget those logins."));
              }}
            >
              <Trash2 aria-hidden="true" />
              Forget every saved login
            </button>
          </div>
        ) : null}
      </section>
    </>
  );
}
