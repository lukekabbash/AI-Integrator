import { resolveModelEffort, type ModelCatalogEntry, type RuntimeId } from "./bridge";

/** The fifth permission profile, alongside read-only, project-write, ask and
 * full-access. It is a filter, not a sandbox: routine work proceeds and a
 * second model answers the boundary questions on the user's behalf. */
export const AUTO_REVIEW_PROFILE = "auto";

/** Stored auto-review keys. Like every other setting these live in an untyped
 * bag, so nothing reads them without going through the normalizers below. */
export const AUTO_REVIEW_SETTING = "permissions.autoReviewByRuntime";
export const AUTO_REVIEW_POLICY = "permissions.autoReviewPolicy";
export const AUTO_REVIEW_FALLBACK = "permissions.autoReviewFallback";
export const AUTO_REVIEW_TIMEOUT = "permissions.autoReviewTimeoutMs";

/** What happens when the reviewer cannot answer. Neither value proceeds
 * silently — that is the whole reason the choice is only these two. */
export type AutoReviewFallback = "ask" | "deny";
export const DEFAULT_AUTO_REVIEW_FALLBACK: AutoReviewFallback = "ask";

/**
 * The user's turn is blocked while the reviewer thinks, so latency is the real
 * cost here, not tokens. Ten seconds is long enough for a small model on a
 * bounded prompt and short enough that a stuck reviewer feels like a hiccup
 * rather than a hang. Mirrors `auto_review::DEFAULT_TIMEOUT`.
 */
export const DEFAULT_AUTO_REVIEW_TIMEOUT_MS = 10_000;
const MIN_AUTO_REVIEW_TIMEOUT_MS = 1_000;
const MAX_AUTO_REVIEW_TIMEOUT_MS = 60_000;

/** For the same reason, the reviewer thinks as little as the model allows. A
 * reviewer at high effort can cost more than the work it guards. */
export const DEFAULT_REVIEWER_EFFORT = "low";

/** How many cheap-first suggestions the model picker floats above the full
 * catalog. */
export const SUGGESTED_REVIEWER_COUNT = 3;

/**
 * Who performs the review.
 *
 * `native` hands the decision to a reviewer the runtime already has — only
 * Codex has one. `delegated` means we run the reviewer ourselves and answer the
 * runtime's permission request with the verdict, which is the only option
 * everywhere else. Mirrors `auto_review::ReviewerMode`.
 */
export type ReviewerMode = "native" | "delegated";

/** What is stored for one task runtime. Every field past `enabled` is optional
 * because absent means "inherit", and the resolver below is the only place that
 * decides what each absence inherits from. */
export interface AutoReviewRoute {
  enabled: boolean;
  /** Absent = review on the task's own runtime. */
  reviewerRuntime?: RuntimeId;
  reviewer?: ReviewerMode;
  model?: string;
  effort?: string;
  /** Absent = the global policy. */
  policy?: string;
}

/** The same route with every inheritance already applied. Callers get this, so
 * no caller re-derives a default and no two callers derive it differently. */
export interface ResolvedAutoReviewRoute {
  enabled: boolean;
  reviewerRuntime: RuntimeId;
  reviewer: ReviewerMode;
  model?: string;
  effort?: string;
  policy?: string;
}

export type AutoReviewByRuntime = Partial<Record<RuntimeId, AutoReviewRoute>>;

/**
 * Which runtimes can review inside themselves, and — by being exhaustive — which
 * runtimes exist at all.
 *
 * Codex is the only `true`, and it is the only one because it is the only CLI
 * that ships a reviewer: `approvals_reviewer = "auto_review"`. Claude has a
 * permission seam but nothing behind it to defer to; see the note in
 * `auto_review/mod.rs` for what each runtime actually offers. Mirrors
 * `auto_review::supports_native_reviewer`.
 *
 * Written as an exhaustive record rather than a list so that adding a runtime
 * to `RuntimeId` fails to compile here. A list would still typecheck, and the
 * new runtime would silently be treated as unknown — a bug whose only symptom
 * is a reviewer that quietly stopped being configurable.
 */
const NATIVE_REVIEWER: Record<RuntimeId, boolean> = {
  antigravity: false,
  claude: false,
  codex: true,
  cursor: false,
  custom: false,
  grok: false,
  kimi: false,
};

/**
 * Whether this runtime reviews inside itself.
 *
 * Exported as the single source of truth so the UI can grey out an impossible
 * choice. An unselectable option the app silently ignores is worse than an
 * absent one: it tells the user something is on when nothing is.
 */
export function supportsNativeReviewer(runtime: RuntimeId): boolean {
  return NATIVE_REVIEWER[runtime] === true;
}

/**
 * Cheap-first preference, resolved against whatever the runtime's catalog
 * actually reports.
 *
 * These are fragments of an id, not a model table. `provider_model_catalog.rs`
 * discovers models by parsing each CLI's own output, so a hardcoded list of
 * models rots within a month — but a fragment that no longer matches anything
 * simply falls through to catalog order, which is the correct behaviour for a
 * family that has been retired.
 *
 * - `claude` names the three families directly, cheapest first: Haiku is ample
 *   for an allow/deny on a bounded prompt.
 * - `codex` gets size words rather than model names. Codex's own reviewer
 *   config exposes no model key (`AutoReviewToml` carries `policy` alone), so
 *   there is nothing here worth guessing a wire id for.
 * - Everything else has a short catalog that is already roughly cheap-first.
 */
const REVIEWER_PREFERENCE: Partial<Record<RuntimeId, readonly string[]>> = {
  claude: ["haiku-4-5", "sonnet-5", "opus-5"],
  codex: ["mini", "nano"],
};

export function normalizeAutoReview(value: unknown): AutoReviewByRuntime {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const routes: AutoReviewByRuntime = {};
  for (const [runtime, candidate] of Object.entries(value)) {
    if (!isKnownRuntime(runtime)) continue;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const entry = candidate as Record<string, unknown>;
    const model = readNonEmptyString(entry.model);
    const effort = readNonEmptyString(entry.effort);
    const policy = readNonEmptyString(entry.policy);
    const reviewerRuntime = readRuntimeId(entry.reviewerRuntime);
    const reviewer = readReviewerMode(entry.reviewer, runtime);
    // Anything other than a literal `true` is off. An imported setting that
    // says `"enabled": "yes"` must not turn the reviewer on by accident.
    const enabled = entry.enabled === true;
    // Off with nothing configured is the default written out longhand;
    // dropping it keeps the stored map to what the user actually chose.
    if (!enabled && !model && !effort && !policy && !reviewerRuntime && !reviewer) continue;
    routes[runtime] = { enabled, reviewerRuntime, reviewer, model, effort, policy };
  }
  return routes;
}

/**
 * The reviewer configured for one task runtime, with every inheritance applied.
 *
 * `taskRuntime` is the runtime running the work; the reviewer may be somewhere
 * else entirely — reviewing a Claude task with a cheap Codex model is a
 * supported and reasonable thing to want. Absent means off: auto-review is
 * never on for a runtime the user has not switched it on for.
 */
export function readAutoReviewRoute(
  settings: Record<string, unknown>,
  taskRuntime: RuntimeId,
): ResolvedAutoReviewRoute {
  const stored = normalizeAutoReview(settings[AUTO_REVIEW_SETTING])[taskRuntime];
  const reviewer = stored?.reviewer ?? defaultReviewerMode(taskRuntime);
  return {
    enabled: stored?.enabled ?? false,
    reviewer,
    // A native reviewer is the task runtime reviewing itself, so pointing one
    // at another runtime describes a setup nothing can perform. Collapsing it
    // here means no caller has to notice the combination is incoherent.
    reviewerRuntime: reviewer === "native" ? taskRuntime : (stored?.reviewerRuntime ?? taskRuntime),
    model: stored?.model,
    effort: stored?.effort,
    policy: stored?.policy,
  };
}

/** Native where a native reviewer exists, delegated everywhere else. */
export function defaultReviewerMode(runtime: RuntimeId): ReviewerMode {
  return supportsNativeReviewer(runtime) ? "native" : "delegated";
}

export function readAutoReviewFallback(settings: Record<string, unknown>): AutoReviewFallback {
  return settings[AUTO_REVIEW_FALLBACK] === "deny" ? "deny" : DEFAULT_AUTO_REVIEW_FALLBACK;
}

/** Clamped, because the stored value is a bare number: zero would mean "never
 * review" and a large one would mean "hold the turn open". Mirrors the clamp in
 * `ReviewerConfig::with_timeout_ms` so both sides agree on what was saved. */
export function readAutoReviewTimeoutMs(settings: Record<string, unknown>): number {
  const stored = settings[AUTO_REVIEW_TIMEOUT];
  if (typeof stored !== "number" || !Number.isFinite(stored)) {
    return DEFAULT_AUTO_REVIEW_TIMEOUT_MS;
  }
  return Math.min(
    Math.max(Math.round(stored), MIN_AUTO_REVIEW_TIMEOUT_MS),
    MAX_AUTO_REVIEW_TIMEOUT_MS,
  );
}

/**
 * The globally edited policy, or `undefined` to use the shipped one.
 *
 * A blank textarea means "restore the shipped policy", never "review with no
 * policy": the shipped text is the only copy of the rules, and it lives in
 * `auto_review/policy.md` so it reviews as English in a diff. Sending an empty
 * string would leave the reviewer improvising the rules it enforces.
 */
export function readAutoReviewPolicy(settings: Record<string, unknown>): string | undefined {
  return readNonEmptyString(settings[AUTO_REVIEW_POLICY]);
}

/**
 * The policy one runtime's reviewer actually runs with: the route's own
 * override, then the global policy, then the shipped one.
 *
 * `undefined` is the third level rather than a failure — it means "send no
 * policy override", and the native side resolves that to
 * `auto_review::DEFAULT_POLICY`. Keeping the shipped text on one side of the
 * boundary is what stops the renderer and the reviewer disagreeing about what
 * the rules are.
 */
export function resolveAutoReviewPolicy(
  settings: Record<string, unknown>,
  taskRuntime: RuntimeId,
): string | undefined {
  return readAutoReviewRoute(settings, taskRuntime).policy ?? readAutoReviewPolicy(settings);
}

/**
 * The models to float above the full catalog for one reviewer.
 *
 * Pass the *resolved* reviewer runtime and that runtime's catalog, not the
 * task's — the whole point of a separate reviewer runtime is that the two can
 * differ, and suggesting Claude models for a Codex reviewer would offer models
 * that runtime cannot run.
 *
 * Preference order first, then catalog order to pad, so the picker always
 * offers something even for a runtime we have no opinion about.
 */
export function suggestedReviewerModels(
  reviewerRuntime: RuntimeId,
  catalog: ModelCatalogEntry[],
  count = SUGGESTED_REVIEWER_COUNT,
): ModelCatalogEntry[] {
  const chosen: ModelCatalogEntry[] = [];
  const taken = new Set<string>();
  const take = (entry: ModelCatalogEntry | undefined) => {
    if (!entry || taken.has(entry.id) || chosen.length >= count) return;
    taken.add(entry.id);
    chosen.push(entry);
  };

  for (const fragment of REVIEWER_PREFERENCE[reviewerRuntime] ?? []) {
    take(catalog.find((entry) => matchesFragment(entry.id, fragment)));
  }
  for (const entry of catalog) take(entry);
  return chosen;
}

/** The effort a reviewer starts on: the cheapest the model admits to, with
 * `low` preferred. Models that advertise no efforts get `undefined` rather than
 * a level the provider would reject. */
export function defaultReviewerEffort(entry: ModelCatalogEntry | undefined): string | undefined {
  return resolveModelEffort(entry, DEFAULT_REVIEWER_EFFORT);
}

/**
 * Fold the separators a catalog might use into one, so a fragment written as
 * `haiku-4-5` matches `claude-haiku-4-5` and `Claude Haiku 4.5` alike.
 *
 * Providers do not agree on this. The native catalog reports slugs, but the
 * browser preview's catalog reports display names, and a matcher that only
 * understood hyphens silently fell through to catalog order there — which
 * suggested the most expensive model as the reviewer, the exact opposite of
 * what these preferences exist to do.
 */
function foldSeparators(value: string): string {
  return value.toLowerCase().replace(/[\s._]+/g, "-");
}

/**
 * Match a preference fragment against a catalog id.
 *
 * A fragment matches at the start of the id or at a segment boundary inside it,
 * because catalogs report `claude-haiku-4-5` while the family worth naming is
 * `haiku-4-5`. Requiring a boundary is what keeps `mini` from matching
 * `gemini-3.6-flash`, which a plain substring test would happily do.
 */
function matchesFragment(id: string, fragment: string): boolean {
  const haystack = foldSeparators(id);
  const needle = foldSeparators(fragment);
  if (haystack.startsWith(needle)) return true;
  const at = haystack.indexOf(needle);
  return at > 0 && ["-", "/", ":"].includes(haystack[at - 1] ?? "");
}

function isKnownRuntime(value: unknown): value is RuntimeId {
  return typeof value === "string" && value in NATIVE_REVIEWER;
}

function readRuntimeId(value: unknown): RuntimeId | undefined {
  return isKnownRuntime(value) ? value : undefined;
}

/**
 * Read a stored reviewer mode against the runtime that would perform it.
 *
 * `native` on a runtime with no native reviewer becomes `delegated` rather than
 * an error: the user's intent — review this — is honourable and achievable, and
 * refusing the whole route over the one field we can repair would switch off a
 * reviewer they asked for.
 */
function readReviewerMode(value: unknown, taskRuntime: RuntimeId): ReviewerMode | undefined {
  if (value === "delegated") return "delegated";
  if (value !== "native") return undefined;
  return supportsNativeReviewer(taskRuntime) ? "native" : "delegated";
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
