import type { ExplainRoute, RuntimeId } from "./bridge";
import { normalizeFallbacks } from "./explainSettings";

/** Stored keys for who drafts commit subjects from the Git panel. */
export const COMMIT_MESSAGE_SETTINGS = {
  runtime: "git.commitMessage.runtime",
  model: "git.commitMessage.model",
  effort: "git.commitMessage.effort",
  fallbacks: "git.commitMessage.fallbacks",
} as const;

/**
 * Who writes a generated commit subject. Unlike the explainer, this never
 * inherits the chat route: a missing runtime or model means the setting is
 * incomplete and the generate action should ask the user to finish it.
 */
export function resolveCommitMessageRoute(
  settings: Record<string, unknown>,
  available: RuntimeId[],
): ExplainRoute | null {
  const stored = settings[COMMIT_MESSAGE_SETTINGS.runtime];
  const runtime =
    typeof stored === "string" && (available as string[]).includes(stored)
      ? (stored as RuntimeId)
      : null;
  if (!runtime) return null;
  const model = settings[COMMIT_MESSAGE_SETTINGS.model];
  if (typeof model !== "string" || !model.trim()) return null;
  const effort = settings[COMMIT_MESSAGE_SETTINGS.effort];
  return {
    runtime,
    model: model.trim(),
    effort: typeof effort === "string" && effort.trim() ? effort.trim() : undefined,
    fallbacks: normalizeFallbacks(settings[COMMIT_MESSAGE_SETTINGS.fallbacks], available).filter(
      (item) => item !== runtime,
    ),
  };
}
