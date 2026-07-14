import { describe, expect, it } from "vitest";
import { normalizeRuntimeRouteDefaults, readRuntimeRouteDefault } from "./routingDefaults";

describe("runtime route defaults", () => {
  it("keeps legacy model and effort attached to their original runtime", () => {
    const settings = {
      "models.defaultRuntime": "claude",
      "models.defaultModel": "claude-sonnet",
      "models.defaultEffort": "high",
    };

    expect(readRuntimeRouteDefault(settings, "claude")).toEqual({
      model: "claude-sonnet",
      effort: "high",
    });
    expect(readRuntimeRouteDefault(settings, "codex")).toEqual({});
  });

  it("prefers the per-runtime map and drops malformed imported entries", () => {
    const settings = {
      "models.defaultRuntime": "codex",
      "models.defaultModel": "legacy-model",
      "models.defaultsByRuntime": {
        codex: { model: "gpt-codex", effort: "medium" },
        claude: { model: "claude-sonnet" },
        cursor: "invalid",
      },
    };

    expect(readRuntimeRouteDefault(settings, "codex")).toEqual({
      model: "gpt-codex",
      effort: "medium",
    });
    expect(normalizeRuntimeRouteDefaults(settings["models.defaultsByRuntime"])).toEqual({
      codex: { model: "gpt-codex", effort: "medium" },
      claude: { model: "claude-sonnet", effort: undefined },
    });
  });
});
