import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "./bridge";
import {
  AUTO_REVIEW_FALLBACK,
  AUTO_REVIEW_POLICY,
  AUTO_REVIEW_REVIEWERS,
  AUTO_REVIEW_SETTING,
  AUTO_REVIEW_TIMEOUT,
  DEFAULT_AUTO_REVIEW_TIMEOUT_MS,
  defaultReviewerEffort,
  defaultReviewerMode,
  normalizeAutoReview,
  normalizeAutoReviewReviewers,
  readAutoReviewFallback,
  readAutoReviewPolicy,
  readAutoReviewReviewers,
  readAutoReviewRoute,
  readAutoReviewTimeoutMs,
  resolveAutoReviewPolicy,
  suggestedReviewerModels,
  supportsNativeReviewer,
} from "./autoReviewSettings";

const model = (id: string, efforts?: string[], defaultEffort?: string): ModelCatalogEntry => ({
  id,
  label: id,
  efforts: efforts?.map((effort) => ({ id: effort, label: effort })),
  defaultEffort,
});

describe("auto-review routes", () => {
  it("keeps one shared ordered reviewer list", () => {
    const stored = [
      { runtime: "claude", model: "claude-haiku-4-5", effort: "low" },
      { runtime: "codex", model: "gpt-5.6-luna" },
      { runtime: "unknown", model: "nope" },
      null,
    ];

    expect(normalizeAutoReviewReviewers(stored)).toEqual([
      { runtime: "claude", model: "claude-haiku-4-5", effort: "low" },
      { runtime: "codex", model: "gpt-5.6-luna", effort: undefined },
    ]);
    expect(readAutoReviewReviewers({ [AUTO_REVIEW_REVIEWERS]: stored })).toEqual(
      normalizeAutoReviewReviewers(stored),
    );
  });

  it("keeps configured runtimes and drops everything it cannot vouch for", () => {
    const stored = {
      claude: { enabled: true, model: "claude-haiku-4-5", effort: "low" },
      codex: { enabled: true },
      grok: { enabled: false, model: "grok-4.5" },
      // Off with nothing else is the default written longhand.
      kimi: { enabled: false },
      // An imported truthy string must not switch a reviewer on.
      cursor: { enabled: "yes", model: "composer-2.5" },
      antigravity: { enabled: true, model: 42, effort: [] },
      // Not a runtime this app has.
      gemini: { enabled: true },
      custom: "nonsense",
    };

    expect(normalizeAutoReview(stored)).toEqual({
      claude: { enabled: true, model: "claude-haiku-4-5", effort: "low" },
      codex: { enabled: true },
      grok: { enabled: false, model: "grok-4.5" },
      cursor: { enabled: false, model: "composer-2.5" },
      antigravity: { enabled: true },
    });
  });

  it("treats anything that is not a map of routes as no routes at all", () => {
    expect(normalizeAutoReview(undefined)).toEqual({});
    expect(normalizeAutoReview(null)).toEqual({});
    expect(normalizeAutoReview("claude")).toEqual({});
    expect(normalizeAutoReview([{ enabled: true }])).toEqual({});
    expect(normalizeAutoReview({})).toEqual({});
  });

  it("reads an unconfigured runtime as off rather than as inherited", () => {
    expect(readAutoReviewRoute({}, "claude")).toEqual({
      enabled: false,
      reviewer: "delegated",
      reviewerRuntime: "claude",
    });
    expect(readAutoReviewRoute({}, "grok")).toEqual({
      enabled: false,
      reviewer: "delegated",
      reviewerRuntime: "grok",
    });
  });
});

describe("the reviewer's own runtime", () => {
  it("reviews a task on another runtime entirely when told to", () => {
    // The point of the feature: a Claude task, reviewed by a cheap Codex model.
    const settings = {
      [AUTO_REVIEW_SETTING]: {
        claude: {
          enabled: true,
          reviewerRuntime: "codex",
          model: "gpt-5.1-codex-mini",
          effort: "low",
        },
      },
    };

    expect(readAutoReviewRoute(settings, "claude")).toEqual({
      enabled: true,
      reviewer: "delegated",
      reviewerRuntime: "codex",
      model: "gpt-5.1-codex-mini",
      effort: "low",
    });
  });

  it("suggests models for the reviewer's runtime, not the task's", () => {
    const settings = {
      [AUTO_REVIEW_SETTING]: { claude: { enabled: true, reviewerRuntime: "codex" } },
    };
    const route = readAutoReviewRoute(settings, "claude");
    const codexCatalog = [model("gpt-5.6-sol"), model("gpt-5.1-codex-mini"), model("gpt-5.5")];

    // Keyed on the resolved reviewer runtime, so the codex preference applies
    // even though the task is a Claude one.
    expect(suggestedReviewerModels(route.reviewerRuntime, codexCatalog, 1)).toEqual([
      model("gpt-5.1-codex-mini"),
    ]);
  });

  it("falls back to the task's own runtime, and drops a reviewer runtime it does not have", () => {
    const settings = {
      [AUTO_REVIEW_SETTING]: {
        grok: { enabled: true, reviewerRuntime: "gemini" },
        kimi: { enabled: true },
      },
    };
    expect(readAutoReviewRoute(settings, "grok").reviewerRuntime).toBe("grok");
    expect(readAutoReviewRoute(settings, "kimi").reviewerRuntime).toBe("kimi");
  });
});

describe("native versus delegated review", () => {
  it("knows which runtimes review inside themselves", () => {
    expect(supportsNativeReviewer("codex")).toBe(true);
    for (const runtime of ["claude", "cursor", "grok", "kimi", "antigravity", "custom"] as const) {
      expect(supportsNativeReviewer(runtime)).toBe(false);
    }
  });

  it("defaults to native only where a native reviewer exists", () => {
    expect(defaultReviewerMode("codex")).toBe("native");
    expect(defaultReviewerMode("claude")).toBe("delegated");
    expect(readAutoReviewRoute({}, "codex").reviewer).toBe("native");
    expect(readAutoReviewRoute({}, "claude").reviewer).toBe("delegated");
  });

  it("normalizes an impossible native choice down to delegated instead of erroring", () => {
    // Claude has a permission seam but no reviewer behind it. Asking for
    // native there is honourable and achievable — just not natively.
    const settings = {
      [AUTO_REVIEW_SETTING]: {
        claude: { enabled: true, reviewer: "native" },
        grok: { enabled: true, reviewer: "sideways" },
      },
    };
    expect(normalizeAutoReview(settings[AUTO_REVIEW_SETTING]).claude?.reviewer).toBe("delegated");
    expect(readAutoReviewRoute(settings, "claude").reviewer).toBe("delegated");
    // An unreadable mode is no choice at all, so the default applies.
    expect(readAutoReviewRoute(settings, "grok").reviewer).toBe("delegated");
  });

  it("keeps a native reviewer pointed at its own runtime", () => {
    // Codex's reviewer is Codex. A reviewer runtime alongside it describes a
    // setup nothing can perform, so it collapses rather than being carried.
    const settings = {
      [AUTO_REVIEW_SETTING]: {
        codex: { enabled: true, reviewer: "native", reviewerRuntime: "claude" },
      },
    };
    expect(readAutoReviewRoute(settings, "codex")).toEqual({
      enabled: true,
      reviewer: "native",
      reviewerRuntime: "codex",
    });
  });

  it("lets a runtime with a native reviewer be delegated anyway", () => {
    const settings = {
      [AUTO_REVIEW_SETTING]: {
        codex: { enabled: true, reviewer: "delegated", reviewerRuntime: "claude" },
      },
    };
    expect(readAutoReviewRoute(settings, "codex")).toEqual({
      enabled: true,
      reviewer: "delegated",
      reviewerRuntime: "claude",
    });
  });
});

describe("auto-review fallback, timeout and policy", () => {
  it("falls back to asking unless the user chose to deny", () => {
    expect(readAutoReviewFallback({})).toBe("ask");
    expect(readAutoReviewFallback({ [AUTO_REVIEW_FALLBACK]: "deny" })).toBe("deny");
    expect(readAutoReviewFallback({ [AUTO_REVIEW_FALLBACK]: "allow" })).toBe("ask");
    expect(readAutoReviewFallback({ [AUTO_REVIEW_FALLBACK]: true })).toBe("ask");
  });

  it("clamps a stored timeout so it can neither disable the reviewer nor hang the turn", () => {
    expect(readAutoReviewTimeoutMs({})).toBe(DEFAULT_AUTO_REVIEW_TIMEOUT_MS);
    expect(readAutoReviewTimeoutMs({ [AUTO_REVIEW_TIMEOUT]: "8000" })).toBe(
      DEFAULT_AUTO_REVIEW_TIMEOUT_MS,
    );
    expect(readAutoReviewTimeoutMs({ [AUTO_REVIEW_TIMEOUT]: Number.NaN })).toBe(
      DEFAULT_AUTO_REVIEW_TIMEOUT_MS,
    );
    expect(readAutoReviewTimeoutMs({ [AUTO_REVIEW_TIMEOUT]: 0 })).toBe(1_000);
    expect(readAutoReviewTimeoutMs({ [AUTO_REVIEW_TIMEOUT]: -5 })).toBe(1_000);
    expect(readAutoReviewTimeoutMs({ [AUTO_REVIEW_TIMEOUT]: 9_999_999 })).toBe(60_000);
    expect(readAutoReviewTimeoutMs({ [AUTO_REVIEW_TIMEOUT]: 4_400.6 })).toBe(4_401);
  });

  it("reads a blank global policy as the shipped one rather than as no policy", () => {
    expect(readAutoReviewPolicy({})).toBeUndefined();
    expect(readAutoReviewPolicy({ [AUTO_REVIEW_POLICY]: "   \n " })).toBeUndefined();
    expect(readAutoReviewPolicy({ [AUTO_REVIEW_POLICY]: 12 })).toBeUndefined();
    expect(readAutoReviewPolicy({ [AUTO_REVIEW_POLICY]: "  deny everything  " })).toBe(
      "deny everything",
    );
  });

  it("resolves the policy route-first, then global, then the shipped one", () => {
    const global = "GLOBAL POLICY";
    const perRuntime = "CLAUDE ONLY POLICY";
    const settings = {
      [AUTO_REVIEW_POLICY]: global,
      [AUTO_REVIEW_SETTING]: {
        claude: { enabled: true, policy: perRuntime },
        grok: { enabled: true },
      },
    };

    // Level one: the route's own override wins.
    expect(resolveAutoReviewPolicy(settings, "claude")).toBe(perRuntime);
    // Level two: no override, so the global policy.
    expect(resolveAutoReviewPolicy(settings, "grok")).toBe(global);
    expect(resolveAutoReviewPolicy(settings, "kimi")).toBe(global);
    // Level three: nothing stored at all. `undefined` means "send no override",
    // which the native side resolves to the shipped DEFAULT_POLICY.
    expect(resolveAutoReviewPolicy({}, "claude")).toBeUndefined();
    expect(
      resolveAutoReviewPolicy({ [AUTO_REVIEW_SETTING]: { claude: { enabled: true } } }, "claude"),
    ).toBeUndefined();
  });

  it("does not store a per-runtime policy under a second key", () => {
    // The override lives inside the route object, so one read of one key
    // produces the whole configuration for a runtime.
    const settings = {
      [AUTO_REVIEW_SETTING]: { claude: { enabled: true, policy: "  ROUTE POLICY  " } },
    };
    expect(readAutoReviewRoute(settings, "claude").policy).toBe("ROUTE POLICY");
    expect(Object.keys(settings)).toEqual([AUTO_REVIEW_SETTING]);
  });
});

describe("suggested reviewer models", () => {
  it("resolves the preference order against the live catalog, cheapest first", () => {
    const catalog = [
      model("claude-fable-5"),
      model("claude-opus-5"),
      model("claude-sonnet-5"),
      model("claude-haiku-4-5"),
    ];
    expect(suggestedReviewerModels("claude", catalog).map((entry) => entry.id)).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-5",
      "claude-opus-5",
    ]);
  });

  it("matches a catalog that reports display names instead of slugs", () => {
    // The browser preview's catalog does exactly this. Before the separators
    // were folded, nothing matched and the picker fell through to catalog
    // order — suggesting the most expensive model as the reviewer.
    const catalog = [
      model("Claude Fable 5"),
      model("Claude Sonnet 5"),
      model("Claude Opus 4.8"),
      model("Claude Haiku 4.5"),
    ];
    expect(suggestedReviewerModels("claude", catalog).map((entry) => entry.id)).toEqual([
      "Claude Haiku 4.5",
      "Claude Sonnet 5",
      "Claude Fable 5",
    ]);
  });

  it("pads from catalog order when a preferred family is no longer offered", () => {
    // The catalog the CLI reports has moved on; nothing in the preference list
    // matches any more, and the picker still has three usable suggestions.
    const catalog = [model("claude-opus-7"), model("claude-fable-7"), model("claude-nova-7")];
    expect(suggestedReviewerModels("claude", catalog).map((entry) => entry.id)).toEqual([
      "claude-opus-7",
      "claude-fable-7",
      "claude-nova-7",
    ]);
  });

  it("matches a fragment only at a segment boundary", () => {
    const catalog = [model("gemini-3.6-flash"), model("gpt-5.6-luna"), model("gpt-5.1-codex-mini")];
    // `mini` must find codex-mini and never the `mini` inside `gemini`.
    expect(suggestedReviewerModels("codex", catalog, 1).map((entry) => entry.id)).toEqual([
      "gpt-5.1-codex-mini",
    ]);
  });

  it("never repeats a model and never invents one", () => {
    const catalog = [model("grok-4.6"), model("grok-4.5")];
    expect(suggestedReviewerModels("grok", catalog).map((entry) => entry.id)).toEqual([
      "grok-4.6",
      "grok-4.5",
    ]);
    expect(suggestedReviewerModels("kimi", [])).toEqual([]);
  });
});

describe("reviewer effort", () => {
  it("starts on low when the model offers it", () => {
    expect(defaultReviewerEffort(model("claude-haiku-4-5", ["low", "medium", "high"]))).toBe("low");
  });

  it("takes the model's own default before the first listed level", () => {
    expect(defaultReviewerEffort(model("gpt-5.6-luna", ["medium", "high"], "high"))).toBe("high");
    expect(defaultReviewerEffort(model("gpt-5.6-terra", ["medium", "high"]))).toBe("medium");
  });

  it("sends no effort at all for a model that advertises none", () => {
    expect(defaultReviewerEffort(model("composer-2.5"))).toBeUndefined();
    expect(defaultReviewerEffort(undefined)).toBeUndefined();
  });
});
