import type { PushForce } from "./bridge";

/** Stored git keys. Every one defaults off or empty: this file only ever adds
 * something the user explicitly asked for. */
export const GIT_SETTINGS = {
  coAuthor: "git.coAuthor",
  forcePush: "git.forcePush",
  commitPrefixEnabled: "git.commitPrefixEnabled",
  commitPrefix: "git.commitPrefix",
} as const;

export const DEFAULT_COMMIT_PREFIX = "ai-integrator-push:";

/** The identity written when the co-author trailer is on. The address is a
 * `noreply` form because a trailer becomes part of permanent history and must
 * not imply a mailbox that could receive replies. */
export const CO_AUTHOR_TRAILER = "Co-authored-by: AI Integrator <ai-integrator@users.noreply.github.com>";

export interface GitDecorationSettings {
  coAuthor: boolean;
  commitPrefixEnabled: boolean;
  commitPrefix: string;
}

export function readGitDecorationSettings(settings: Record<string, unknown>): GitDecorationSettings {
  const value = settings[GIT_SETTINGS.commitPrefix];
  return {
    coAuthor: settings[GIT_SETTINGS.coAuthor] === true,
    commitPrefixEnabled: settings[GIT_SETTINGS.commitPrefixEnabled] === true,
    commitPrefix: typeof value === "string" ? value : DEFAULT_COMMIT_PREFIX,
  };
}

export function readPushForce(settings: Record<string, unknown>): PushForce {
  const value = settings[GIT_SETTINGS.forcePush];
  return value === "lease" || value === "always" ? value : "off";
}

/**
 * Git reads trailers only from a message's final paragraph, so a new trailer
 * either joins an existing block or starts one after a blank line.
 *
 * The paragraph is what matters, not the last line: a subject can itself be
 * trailer-shaped — the default commit prefix `ai-integrator-push:` is — and
 * gluing the trailer under a one-line subject would make Git read the subject
 * as part of the trailer block.
 */
function appendTrailer(message: string, trailer: string): string {
  if (message.includes(trailer)) return message;
  const lines = message.split("\n");
  const blankIndex = lines.lastIndexOf("");
  const finalParagraph = blankIndex === -1 ? [] : lines.slice(blankIndex + 1);
  const joinsExistingBlock =
    finalParagraph.length > 0 &&
    finalParagraph.every((line) => /^[A-Za-z][A-Za-z0-9-]*:\s/.test(line.trim()));
  return `${message}${joinsExistingBlock ? "\n" : "\n\n"}${trailer}`;
}

/**
 * Apply the user's commit decorations. Both are idempotent: the same message
 * can pass through twice — an edited retry, a generated draft the user then
 * commits — without growing a second prefix or a duplicate trailer.
 */
export function decorateCommitMessage(
  message: string,
  settings: GitDecorationSettings,
): string {
  let decorated = message.trim();
  if (!decorated) return decorated;
  const prefix = settings.commitPrefix.trim();
  if (settings.commitPrefixEnabled && prefix && !decorated.startsWith(prefix)) {
    decorated = `${prefix} ${decorated}`;
  }
  if (settings.coAuthor) {
    decorated = appendTrailer(decorated, CO_AUTHOR_TRAILER);
  }
  return decorated;
}
