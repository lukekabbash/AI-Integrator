import type { CustomArchetype, ExplainArchetype, ExplainConfig, ExplainRoute, RuntimeId } from "./bridge";

/** Stored explainer keys. The values live in the same untyped settings bag as
 * everything else, so every read goes through the normalizers below. */
export const EXPLAIN_SETTINGS = {
  archetype: "explain.archetype",
  customArchetypes: "explain.customArchetypes",
  verbosity: "explain.verbosity",
  technicality: "explain.technicality",
  runtime: "explain.runtime",
  model: "explain.model",
  effort: "explain.effort",
  fallbacks: "explain.fallbacks",
} as const;

export interface BuiltInArchetype {
  id: Exclude<ExplainArchetype, "custom">;
  label: string;
  hint: string;
}

export const BUILT_IN_ARCHETYPES: BuiltInArchetype[] = [
  { id: "explanation", label: "Explanation", hint: "What it does, how it works, what is easy to misread" },
  { id: "socratic", label: "Socratic", hint: "Questions that lead you to the answer instead of stating it" },
  { id: "optimization", label: "Optimization", hint: "Complexity, allocation, IO, and wasted work" },
  { id: "critique", label: "Critique", hint: "Bugs and unhandled edges, most severe first" },
  { id: "security", label: "Security", hint: "Attacker-controlled input and the concrete consequence" },
];

/** Sentinel for the dropdown's trailing "New archetype" row. Never stored: it
 * is an action, and treating it as a value would persist a nonexistent
 * archetype the native side would reject. */
export const NEW_ARCHETYPE_OPTION = "__new__";

/** Custom archetype ids are namespaced so they can never collide with a
 * built-in name, now or when a new built-in is added later. */
export const CUSTOM_ARCHETYPE_PREFIX = "custom:";

export const DEFAULT_CUSTOM_MISSION = "Explain what this code does and why it matters.";
export const DEFAULT_CUSTOM_LABEL = "My archetype";

/** Sentinel for "whatever the chat is already using". Stored as the empty
 * string so an unset setting and an explicit inherit are the same thing. */
export const INHERIT_RUNTIME = "";

export const DEFAULT_VERBOSITY = 40;
export const DEFAULT_TECHNICALITY = 2;

export function isCustomArchetypeId(id: string): boolean {
  return id.startsWith(CUSTOM_ARCHETYPE_PREFIX);
}

export function normalizeCustomArchetypes(value: unknown): CustomArchetype[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is CustomArchetype =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as CustomArchetype).id === "string" &&
      isCustomArchetypeId((item as CustomArchetype).id) &&
      typeof (item as CustomArchetype).label === "string" &&
      typeof (item as CustomArchetype).mission === "string",
  );
}

export function normalizeFallbacks(value: unknown, available: RuntimeId[]): RuntimeId[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((item): item is RuntimeId => {
    if (typeof item !== "string" || seen.has(item)) return false;
    seen.add(item);
    return (available as string[]).includes(item);
  });
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

export function readVerbosity(settings: Record<string, unknown>): number {
  return clamp(settings[EXPLAIN_SETTINGS.verbosity], 1, 100, DEFAULT_VERBOSITY);
}

export function readTechnicality(settings: Record<string, unknown>): number {
  return clamp(settings[EXPLAIN_SETTINGS.technicality], 0, 3, DEFAULT_TECHNICALITY);
}

/**
 * The configuration one explanation runs with, resolving a stored custom
 * archetype id to the mission it holds.
 *
 * Shared by the settings preview and the real request on purpose: the preview's
 * whole value is being the same prompt, so both sides must derive the config
 * from storage identically.
 */
export function resolveExplainConfig(settings: Record<string, unknown>): ExplainConfig {
  const stored = settings[EXPLAIN_SETTINGS.archetype];
  const archetype = typeof stored === "string" ? stored : "explanation";
  const verbosity = readVerbosity(settings);
  const technicality = readTechnicality(settings);
  if (!isCustomArchetypeId(archetype)) {
    const builtIn = BUILT_IN_ARCHETYPES.find((item) => item.id === archetype);
    return { archetype: builtIn?.id ?? "explanation", verbosity, technicality };
  }
  // A custom archetype the user deleted leaves the id behind; fall back rather
  // than sending a mission-less custom prompt.
  const custom = normalizeCustomArchetypes(settings[EXPLAIN_SETTINGS.customArchetypes]).find(
    (item) => item.id === archetype,
  );
  if (!custom) return { archetype: "explanation", verbosity, technicality };
  return { archetype: "custom", customMission: custom.mission, verbosity, technicality };
}

/**
 * Who answers one explanation. `active` is the route the chat is already using;
 * an unset explainer runtime inherits it, which is what "Current model" means.
 */
export function resolveExplainRoute(
  settings: Record<string, unknown>,
  active: { runtime: RuntimeId; model?: string; effort?: string },
  available: RuntimeId[],
): ExplainRoute {
  const stored = settings[EXPLAIN_SETTINGS.runtime];
  const pinned =
    typeof stored === "string" && stored !== INHERIT_RUNTIME && (available as string[]).includes(stored)
      ? (stored as RuntimeId)
      : null;
  if (!pinned) {
    return {
      runtime: active.runtime,
      model: active.model,
      effort: active.effort,
      fallbacks: normalizeFallbacks(settings[EXPLAIN_SETTINGS.fallbacks], available).filter(
        (runtime) => runtime !== active.runtime,
      ),
    };
  }
  const model = settings[EXPLAIN_SETTINGS.model];
  const effort = settings[EXPLAIN_SETTINGS.effort];
  return {
    runtime: pinned,
    model: typeof model === "string" && model ? model : undefined,
    effort: typeof effort === "string" && effort ? effort : undefined,
    fallbacks: normalizeFallbacks(settings[EXPLAIN_SETTINGS.fallbacks], available).filter(
      (runtime) => runtime !== pinned,
    ),
  };
}

/**
 * Names for the verbosity bands.
 *
 * These mirror the bands in `code_explain.rs::verbosity_directive`. If they
 * drift the label misdescribes the answer, though the prompt preview stays
 * truthful because it is composed natively.
 */
export function verbosityLabel(value: number): string {
  if (value <= 20) return "Terse";
  if (value <= 45) return "Brief";
  if (value <= 70) return "Balanced";
  if (value <= 90) return "Thorough";
  return "Exhaustive";
}

/** Mirrors `code_explain.rs::technicality_directive`. */
export const TECHNICALITY_LABELS = ["Beginner", "Familiar", "Technical", "Expert"];

export function technicalityLabel(value: number): string {
  return TECHNICALITY_LABELS[Math.min(Math.max(value, 0), 3)] ?? "Technical";
}

/** What the verbosity slider buys in context, mirroring
 * `explain_context.rs::ContextBudget::for_verbosity`. Shown under the slider so
 * the cost of a long answer is visible before it is paid. */
export function contextSummary(verbosity: number): string {
  if (verbosity < 30) return "Sends the selection alone.";
  if (verbosity < 60) return "Adds the lines around the selection.";
  if (verbosity < 80) return "Adds surrounding lines, plus definitions from up to 3 imported files.";
  return "Adds surrounding lines, plus definitions from up to 6 imported files.";
}
