import { describe, expect, it } from "vitest";
import {
  contextSummary,
  CUSTOM_ARCHETYPE_PREFIX,
  DEFAULT_TECHNICALITY,
  DEFAULT_VERBOSITY,
  EXPLAIN_SETTINGS,
  normalizeCustomArchetypes,
  normalizeFallbacks,
  resolveExplainConfig,
  resolveExplainRoute,
  technicalityLabel,
  verbosityLabel,
} from "./explainSettings";
import type { RuntimeId } from "./bridge";

const AVAILABLE: RuntimeId[] = ["codex", "claude", "grok"];
const ACTIVE = { runtime: "codex" as RuntimeId, model: "gpt-5.5", effort: "medium" };

describe("resolveExplainConfig", () => {
  it("defaults to a plain explanation at the stored defaults", () => {
    expect(resolveExplainConfig({})).toEqual({
      archetype: "explanation",
      verbosity: DEFAULT_VERBOSITY,
      technicality: DEFAULT_TECHNICALITY,
    });
  });

  it("resolves a custom archetype id to the mission it stores", () => {
    const config = resolveExplainConfig({
      [EXPLAIN_SETTINGS.archetype]: `${CUSTOM_ARCHETYPE_PREFIX}a1`,
      [EXPLAIN_SETTINGS.customArchetypes]: [
        { id: `${CUSTOM_ARCHETYPE_PREFIX}a1`, label: "Haiku", mission: "Answer as a haiku." },
      ],
    });
    expect(config.archetype).toBe("custom");
    expect(config.customMission).toBe("Answer as a haiku.");
  });

  it("falls back when the selected custom archetype was deleted", () => {
    // The id outlives the archetype; sending `custom` with no mission would
    // leave the prompt without any instruction at all.
    const config = resolveExplainConfig({
      [EXPLAIN_SETTINGS.archetype]: `${CUSTOM_ARCHETYPE_PREFIX}gone`,
      [EXPLAIN_SETTINGS.customArchetypes]: [],
    });
    expect(config.archetype).toBe("explanation");
    expect(config.customMission).toBeUndefined();
  });

  it("falls back for an archetype name the native side does not know", () => {
    expect(resolveExplainConfig({ [EXPLAIN_SETTINGS.archetype]: "haiku" }).archetype).toBe(
      "explanation",
    );
  });

  it("clamps the sliders rather than forwarding an out-of-range value", () => {
    expect(
      resolveExplainConfig({
        [EXPLAIN_SETTINGS.verbosity]: 5000,
        [EXPLAIN_SETTINGS.technicality]: -3,
      }),
    ).toMatchObject({ verbosity: 100, technicality: 0 });
    expect(
      resolveExplainConfig({
        [EXPLAIN_SETTINGS.verbosity]: "loud",
        [EXPLAIN_SETTINGS.technicality]: null,
      }),
    ).toMatchObject({ verbosity: DEFAULT_VERBOSITY, technicality: DEFAULT_TECHNICALITY });
  });
});

describe("resolveExplainRoute", () => {
  it("inherits the chat's whole route when no runtime is pinned", () => {
    expect(resolveExplainRoute({}, ACTIVE, AVAILABLE)).toEqual({
      runtime: "codex",
      model: "gpt-5.5",
      effort: "medium",
      fallbacks: [],
    });
  });

  it("uses the pinned runtime with its own model and effort", () => {
    expect(
      resolveExplainRoute(
        {
          [EXPLAIN_SETTINGS.runtime]: "claude",
          [EXPLAIN_SETTINGS.model]: "claude-opus-4-8",
          [EXPLAIN_SETTINGS.effort]: "high",
        },
        ACTIVE,
        AVAILABLE,
      ),
    ).toEqual({
      runtime: "claude",
      model: "claude-opus-4-8",
      effort: "high",
      fallbacks: [],
    });
  });

  it("ignores a pinned runtime that is no longer installed", () => {
    // Uninstalling a provider must not silently strand the explainer on it.
    const route = resolveExplainRoute({ [EXPLAIN_SETTINGS.runtime]: "cursor" }, ACTIVE, AVAILABLE);
    expect(route.runtime).toBe("codex");
    expect(route.model).toBe("gpt-5.5");
  });

  it("drops the primary out of its own fallback chain", () => {
    // Retrying the same provider back-to-back only delays the same error.
    const route = resolveExplainRoute(
      {
        [EXPLAIN_SETTINGS.runtime]: "claude",
        [EXPLAIN_SETTINGS.fallbacks]: ["claude", "codex", "grok"],
      },
      ACTIVE,
      AVAILABLE,
    );
    expect(route.fallbacks).toEqual(["codex", "grok"]);
  });

  it("drops the inherited runtime from the chain when nothing is pinned", () => {
    const route = resolveExplainRoute(
      { [EXPLAIN_SETTINGS.fallbacks]: ["codex", "claude"] },
      ACTIVE,
      AVAILABLE,
    );
    expect(route.fallbacks).toEqual(["claude"]);
  });

  it("treats an empty pinned model as the economy default, not as a model id", () => {
    const route = resolveExplainRoute(
      { [EXPLAIN_SETTINGS.runtime]: "claude", [EXPLAIN_SETTINGS.model]: "" },
      ACTIVE,
      AVAILABLE,
    );
    expect(route.model).toBeUndefined();
    expect(route.effort).toBeUndefined();
  });
});

describe("stored value normalizers", () => {
  it("keeps only well-formed custom archetypes", () => {
    expect(
      normalizeCustomArchetypes([
        { id: `${CUSTOM_ARCHETYPE_PREFIX}ok`, label: "Fine", mission: "Do the thing." },
        { id: "explanation", label: "Impostor", mission: "Shadow a built-in." },
        { id: `${CUSTOM_ARCHETYPE_PREFIX}bad`, label: 7, mission: "Wrong shape." },
        null,
      ]),
    ).toEqual([{ id: `${CUSTOM_ARCHETYPE_PREFIX}ok`, label: "Fine", mission: "Do the thing." }]);
    expect(normalizeCustomArchetypes("not an array")).toEqual([]);
  });

  it("drops unavailable and duplicated fallbacks while keeping the order", () => {
    expect(normalizeFallbacks(["grok", "cursor", "grok", "codex"], AVAILABLE)).toEqual([
      "grok",
      "codex",
    ]);
  });
});

describe("slider labels", () => {
  it("names the same bands the native prompt uses", () => {
    expect(verbosityLabel(1)).toBe("Terse");
    expect(verbosityLabel(20)).toBe("Terse");
    expect(verbosityLabel(21)).toBe("Brief");
    expect(verbosityLabel(70)).toBe("Balanced");
    expect(verbosityLabel(90)).toBe("Thorough");
    expect(verbosityLabel(91)).toBe("Exhaustive");
    expect(TECHNICALITY_STOPS.map(technicalityLabel)).toEqual([
      "Beginner",
      "Familiar",
      "Technical",
      "Expert",
    ]);
  });

  it("promises repository reads only where the native budget actually does them", () => {
    expect(contextSummary(1)).toContain("selection alone");
    expect(contextSummary(45)).not.toContain("imported");
    expect(contextSummary(60)).toContain("3 imported");
    expect(contextSummary(100)).toContain("6 imported");
  });
});

const TECHNICALITY_STOPS = [0, 1, 2, 3];
