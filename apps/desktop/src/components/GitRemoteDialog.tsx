import { useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Trash2, X } from "lucide-react";
import type { GitSnapshot } from "../bridge";

export type GitRemoteDialogMode = "manage" | "connect" | "github" | "branch";

interface GitRemoteDialogProps {
  mode: GitRemoteDialogMode;
  git: GitSnapshot;
  onClose: () => void;
  onError: (message: string) => void;
  onAdd?: (name: string, url: string) => Promise<void>;
  onUpdate?: (name: string, url: string) => Promise<void>;
  onRemove?: (name: string) => Promise<void>;
  onFetch?: (remote?: string) => Promise<void>;
  onPublishBranch?: (remote: string) => Promise<void>;
  onPublishGithub?: (input: {
    nameWithOwner: string;
    visibility: "private" | "public" | "internal";
    remote: string;
  }) => Promise<void>;
}

export function GitRemoteDialog({
  mode,
  git,
  onClose,
  onError,
  onAdd,
  onUpdate,
  onRemove,
  onFetch,
  onPublishBranch,
  onPublishGithub,
}: GitRemoteDialogProps) {
  const [screen, setScreen] = useState(mode);
  const [busy, setBusy] = useState(false);
  const [remoteName, setRemoteName] = useState(git.remotes.length ? "upstream" : "origin");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [githubName, setGithubName] = useState("");
  const [githubVisibility, setGithubVisibility] = useState<"private" | "public" | "internal">(
    "private",
  );
  const [selectedRemote, setSelectedRemote] = useState(git.remotes[0]?.name ?? "origin");
  const selectedRemoteDetails = git.remotes.find((remote) => remote.name === selectedRemote);

  const run = async (action: () => Promise<void>, close = false) => {
    if (busy) return;
    setBusy(true);
    onError("");
    try {
      await action();
      if (close) onClose();
    } catch (error) {
      onError(error instanceof Error ? error.message : "The Git action could not be completed.");
    } finally {
      setBusy(false);
    }
  };

  const title =
    screen === "manage"
      ? "Manage remotes"
      : screen === "connect"
        ? git.remotes.some((remote) => remote.name === remoteName)
          ? `Edit ${remoteName}`
          : "Connect remote"
        : screen === "github"
          ? "Publish to GitHub"
          : "Publish branch";

  // Rendered through a portal so the dialog centers over the whole app and
  // dims it, exactly like the project modals, instead of being clipped to
  // the right rail that opened it.
  return createPortal(
    <div
      className="git-dialog-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="git-remote-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-remote-dialog-title"
      >
        <header>
          <h3 id="git-remote-dialog-title">{title}</h3>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
          >
            <X />
          </button>
        </header>
        {screen === "manage" ? (
          <div className="git-remote-list">
            {git.remotes.length ? (
              git.remotes.map((remote) => (
                <div key={remote.name} className="git-remote-row">
                  <span>
                    <strong>{remote.name}</strong>
                    <small title={remote.fetchUrl}>{remote.fetchUrl}</small>
                  </span>
                  <div>
                    <button
                      type="button"
                      onClick={() => void run(() => onFetch?.(remote.name) ?? Promise.resolve())}
                      disabled={!onFetch || busy}
                    >
                      Fetch
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRemoteName(remote.name);
                        setRemoteUrl(remote.fetchUrl);
                        setScreen("connect");
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="danger-text"
                      onClick={() => {
                        if (window.confirm(`Remove ${remote.name} from this local repository?`)) {
                          void run(() => onRemove?.(remote.name) ?? Promise.resolve());
                        }
                      }}
                      disabled={!onRemove || busy}
                      aria-label={`Remove ${remote.name}`}
                    >
                      <Trash2 />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <p className="empty-compact">No remotes connected.</p>
            )}
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setRemoteName(git.remotes.length ? "upstream" : "origin");
                setRemoteUrl("");
                setScreen("connect");
              }}
            >
              <Plus /> Add remote
            </button>
          </div>
        ) : screen === "connect" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const action = git.remotes.some((remote) => remote.name === remoteName)
                ? onUpdate
                : onAdd;
              if (action) void run(() => action(remoteName.trim(), remoteUrl.trim()), true);
            }}
          >
            <label>
              Remote name
              <input
                value={remoteName}
                onChange={(event) => setRemoteName(event.target.value)}
                placeholder="origin"
                disabled={busy}
              />
            </label>
            <label>
              Repository URL
              <input
                value={remoteUrl}
                onChange={(event) => setRemoteUrl(event.target.value)}
                placeholder="https://github.com/company/project.git"
                disabled={busy}
              />
            </label>
            <p>Credentials stay with Git and your credential manager.</p>
            <div className="git-dialog-actions">
              <button
                type="button"
                onClick={() => (git.remotes.length ? setScreen("manage") : onClose())}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={!remoteName.trim() || !remoteUrl.trim() || busy}
              >
                {busy ? "Saving…" : "Save remote"}
              </button>
            </div>
          </form>
        ) : screen === "github" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (onPublishGithub) {
                void run(
                  () =>
                    onPublishGithub({
                      nameWithOwner: githubName.trim(),
                      visibility: githubVisibility,
                      remote: "origin",
                    }),
                  true,
                );
              }
            }}
          >
            <label>
              Repository
              <input
                value={githubName}
                onChange={(event) => setGithubName(event.target.value)}
                placeholder="owner/project"
                disabled={busy}
              />
            </label>
            <label>
              Visibility
              <select
                value={githubVisibility}
                onChange={(event) =>
                  setGithubVisibility(event.target.value as typeof githubVisibility)
                }
                disabled={busy}
              >
                <option value="private">Private</option>
                <option value="public">Public</option>
                <option value="internal">Internal</option>
              </select>
            </label>
            <p>
              Uses your active GitHub CLI sign-in. Publishing creates the remote; pushing remains a
              separate action.
            </p>
            <div className="git-dialog-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={!githubName.trim() || busy}
              >
                {busy ? "Publishing…" : "Create repository"}
              </button>
            </div>
          </form>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (onPublishBranch) void run(() => onPublishBranch(selectedRemote), true);
            }}
          >
            <label>
              Remote
              <select
                value={selectedRemote}
                onChange={(event) => setSelectedRemote(event.target.value)}
              >
                {git.remotes.map((remote) => (
                  <option key={remote.name} value={remote.name}>
                    {remote.name}
                  </option>
                ))}
              </select>
            </label>
            <p>
              This pushes {git.branch} to {selectedRemote}
              {selectedRemoteDetails?.pushUrl ? ` (${selectedRemoteDetails.pushUrl})` : ""} and sets
              its upstream.
            </p>
            <div className="git-dialog-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="primary-button" disabled={!selectedRemote || busy}>
                {busy ? "Publishing…" : "Publish branch"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>,
    document.body,
  );
}
