export type SpecialistAccess = "read-only" | "project-write";
export type SpecialistServiceLevel = "budget" | "standard" | "premium";

export interface SpecialistRoute {
  runtime: string;
  model?: string;
  effort?: string;
}

export interface SpecialistService {
  level: SpecialistServiceLevel;
  enabled: boolean;
  primary: SpecialistRoute;
  fallbacksEnabled: boolean;
  fallbacks: SpecialistRoute[];
}

export interface SpecialistSetting {
  id: string;
  label: string;
  bestFor: string;
  workingGuidance: string;
  access: SpecialistAccess;
  serviceLevels: SpecialistService[];
  skillIds: string[];
  mcpServerIds: string[];
  enabled: boolean;
}

export const SPECIALIST_LEVELS: SpecialistServiceLevel[] = ["budget", "standard", "premium"];

function service(level: SpecialistServiceLevel, runtime: string): SpecialistService {
  return {
    level,
    enabled: level === "standard",
    primary: { runtime },
    fallbacksEnabled: false,
    fallbacks: [],
  };
}

export const DEFAULT_SPECIALISTS: SpecialistSetting[] = [
  {
    id: "codex-default",
    label: "Codex (OpenAI)",
    bestFor: "Implementation, tests, and careful repository work.",
    workingGuidance: "",
    access: "read-only",
    serviceLevels: SPECIALIST_LEVELS.map((level) => service(level, "codex")),
    skillIds: [],
    mcpServerIds: [],
    enabled: true,
  },
  {
    id: "claude-default",
    label: "Claude",
    bestFor: "Review, synthesis, and nuanced product reasoning.",
    workingGuidance: "",
    access: "read-only",
    serviceLevels: SPECIALIST_LEVELS.map((level) => service(level, "claude")),
    skillIds: [],
    mcpServerIds: [],
    enabled: true,
  },
  {
    id: "antigravity-default",
    label: "Antigravity (Gemini)",
    bestFor: "Broad exploration and alternate implementation approaches.",
    workingGuidance: "",
    access: "read-only",
    serviceLevels: SPECIALIST_LEVELS.map((level) => service(level, "antigravity")),
    skillIds: [],
    mcpServerIds: [],
    enabled: true,
  },
  {
    id: "cursor-default",
    label: "Cursor",
    bestFor: "Focused codebase navigation and implementation.",
    workingGuidance: "",
    access: "read-only",
    serviceLevels: SPECIALIST_LEVELS.map((level) => service(level, "cursor")),
    skillIds: [],
    mcpServerIds: [],
    enabled: true,
  },
  {
    id: "grok-default",
    label: "Grok Build",
    bestFor: "Fast mechanical work and second-pass verification.",
    workingGuidance: "",
    access: "read-only",
    serviceLevels: SPECIALIST_LEVELS.map((level) => service(level, "grok")),
    skillIds: [],
    mcpServerIds: [],
    enabled: true,
  },
  {
    id: "kimi-default",
    label: "Kimi Code",
    bestFor: "Long-context repository work and an independent coding pass.",
    workingGuidance: "",
    access: "read-only",
    serviceLevels: SPECIALIST_LEVELS.map((level) => service(level, "kimi")),
    skillIds: [],
    mcpServerIds: [],
    enabled: true,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeRoute(value: unknown, fallbackRuntime: string): SpecialistRoute {
  if (!isRecord(value)) return { runtime: fallbackRuntime };
  return {
    runtime: optionalText(value.runtime) ?? fallbackRuntime,
    model: optionalText(value.model),
    effort: optionalText(value.effort),
  };
}

function normalizeServices(value: unknown, runtime: string): SpecialistService[] {
  if (!Array.isArray(value)) return SPECIALIST_LEVELS.map((level) => service(level, runtime));
  const byLevel = new Map<SpecialistServiceLevel, SpecialistService>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !SPECIALIST_LEVELS.includes(candidate.level as SpecialistServiceLevel)
    ) {
      continue;
    }
    const level = candidate.level as SpecialistServiceLevel;
    byLevel.set(level, {
      level,
      enabled: candidate.enabled !== false,
      primary: normalizeRoute(candidate.primary, runtime),
      fallbacksEnabled: candidate.fallbacksEnabled === true,
      fallbacks: Array.isArray(candidate.fallbacks)
        ? candidate.fallbacks.map((route) => normalizeRoute(route, runtime)).slice(0, 4)
        : [],
    });
  }
  return SPECIALIST_LEVELS.map((level) => byLevel.get(level) ?? service(level, runtime));
}

/** Legacy provider profiles become one specialist with a Standard route.
 * Explicit empty arrays remain empty: removing every specialist is valid. */
export function normalizeSpecialists(value: unknown): SpecialistSetting[] {
  if (!Array.isArray(value)) return DEFAULT_SPECIALISTS;
  const seen = new Set<string>();
  const specialists: SpecialistSetting[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const id = optionalText(candidate.id);
    const runtime = optionalText(candidate.runtime) ?? "codex";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const modern = Array.isArray(candidate.serviceLevels);
    specialists.push({
      id,
      label: optionalText(candidate.label) ?? "Untitled specialist",
      bestFor: typeof candidate.bestFor === "string" ? candidate.bestFor : "",
      workingGuidance:
        typeof candidate.workingGuidance === "string"
          ? candidate.workingGuidance
          : typeof candidate.instruction === "string"
            ? candidate.instruction
            : "",
      access:
        candidate.access === "project-write" || (!modern && candidate.access !== "read-only")
          ? "project-write"
          : "read-only",
      serviceLevels: modern
        ? normalizeServices(candidate.serviceLevels, runtime)
        : SPECIALIST_LEVELS.map((level) => ({
            ...service(level, runtime),
            enabled: level === "standard",
            primary: {
              runtime,
              model: optionalText(candidate.model),
              effort: optionalText(candidate.effort),
            },
          })),
      skillIds: Array.isArray(candidate.skillIds)
        ? [
            ...new Set(
              candidate.skillIds.filter((item): item is string => typeof item === "string"),
            ),
          ]
        : [],
      mcpServerIds: Array.isArray(candidate.mcpServerIds)
        ? [
            ...new Set(
              candidate.mcpServerIds.filter((item): item is string => typeof item === "string"),
            ),
          ]
        : [],
      enabled: candidate.enabled !== false,
    });
  }
  return specialists;
}

export function createSpecialist(sequence: number): SpecialistSetting {
  return {
    id: `specialist-local-${sequence}`,
    label: "New specialist",
    bestFor: "",
    workingGuidance: "",
    access: "read-only",
    serviceLevels: SPECIALIST_LEVELS.map((level) => service(level, "codex")),
    skillIds: [],
    mcpServerIds: [],
    enabled: true,
  };
}

export function serviceLabel(level: SpecialistServiceLevel): string {
  return level[0].toUpperCase() + level.slice(1);
}
