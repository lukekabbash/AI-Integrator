import type { RuntimeId } from "./bridge";

export const RUNTIME_ROUTE_DEFAULTS_SETTING = "models.defaultsByRuntime";

export interface RuntimeRouteDefault {
  model?: string;
  effort?: string;
}

export type RuntimeRouteDefaults = Partial<Record<RuntimeId, RuntimeRouteDefault>>;

export function normalizeRuntimeRouteDefaults(value: unknown): RuntimeRouteDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const defaults: RuntimeRouteDefaults = {};
  for (const [runtime, candidate] of Object.entries(value)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const entry = candidate as Record<string, unknown>;
    const model = typeof entry.model === "string" && entry.model ? entry.model : undefined;
    const effort = typeof entry.effort === "string" && entry.effort ? entry.effort : undefined;
    if (!model && !effort) continue;
    defaults[runtime as RuntimeId] = { model, effort };
  }
  return defaults;
}

/**
 * Read a runtime-specific route, falling back to the pre-v2 global model and
 * effort only for the runtime they belonged to. This keeps imported and
 * existing settings useful while new writes move to the per-runtime map.
 */
export function readRuntimeRouteDefault(
  settings: Record<string, unknown>,
  runtime: RuntimeId,
): RuntimeRouteDefault {
  const explicit = normalizeRuntimeRouteDefaults(settings[RUNTIME_ROUTE_DEFAULTS_SETTING])[runtime];
  if (explicit) return explicit;
  if (settings["models.defaultRuntime"] !== runtime) return {};
  return {
    model:
      typeof settings["models.defaultModel"] === "string" && settings["models.defaultModel"]
        ? settings["models.defaultModel"]
        : undefined,
    effort:
      typeof settings["models.defaultEffort"] === "string" && settings["models.defaultEffort"]
        ? settings["models.defaultEffort"]
        : undefined,
  };
}
