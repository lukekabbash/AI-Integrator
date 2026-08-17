import { KeyRound } from "lucide-react";

import "./browserSignInPrompt.css";

export interface SignInRequest {
  tabId: string;
  origin: string;
  username: string;
}

export interface BrowserSignInPromptProps {
  request: SignInRequest;
  /** Fills this once. `remember` also allows this origin from now on. */
  onAllow: (remember: boolean) => void;
  onDismiss: () => void;
}

/**
 * An agent asking to sign in somewhere the user has not allowed it to yet.
 *
 * The decision is per site, not per agent: "may anything sign in to this site
 * for me" is a question about the account, and the answer holds for every run
 * afterwards. Saying yes here fills the login now; the agent is meanwhile told
 * to try again, so nothing is left waiting on a person who may be away.
 */
export function BrowserSignInPrompt({ request, onAllow, onDismiss }: BrowserSignInPromptProps) {
  return (
    <div className="browser-signin" role="dialog" aria-label="Sign-in request">
      <div className="browser-signin-head">
        <KeyRound aria-hidden="true" />
        <div>
          <strong>Sign in to {request.origin}?</strong>
          <small>
            An agent asked to use your saved login for <b>{request.username}</b>. It types the
            password without seeing it, and cannot read the page until the form is submitted.
          </small>
        </div>
      </div>
      <div className="browser-signin-actions">
        <button type="button" className="secondary-button small" onClick={onDismiss}>
          Not now
        </button>
        <button type="button" className="secondary-button small" onClick={() => onAllow(false)}>
          Just this once
        </button>
        <button type="button" className="primary-button small" onClick={() => onAllow(true)}>
          Always on this site
        </button>
      </div>
    </div>
  );
}
