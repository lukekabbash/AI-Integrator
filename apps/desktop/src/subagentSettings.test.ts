import { describe, expect, it } from "vitest";
import {
  createSpecialist,
  DEFAULT_SPECIALISTS,
  normalizeSpecialists,
  SPECIALIST_LEVELS,
} from "./subagentSettings";

describe("subagent specialist settings", () => {
  it("uses the safe built-ins only when the setting has never been written", () => {
    expect(normalizeSpecialists(undefined)).toEqual(DEFAULT_SPECIALISTS);
    expect(DEFAULT_SPECIALISTS.every((specialist) => specialist.access === "read-only")).toBe(true);
    expect(DEFAULT_SPECIALISTS.every((specialist) => specialist.serviceLevels.length === 3)).toBe(
      true,
    );
  });

  it("preserves an explicitly empty specialist roster", () => {
    expect(normalizeSpecialists([])).toEqual([]);
  });

  it("migrates a legacy provider profile into one Standard service", () => {
    const [specialist] = normalizeSpecialists([
      {
        id: "legacy-reviewer",
        label: "Legacy reviewer",
        runtime: "claude",
        model: "claude-sonnet",
        effort: "high",
        instruction: "Review the actual diff.",
      },
    ]);

    expect(specialist.workingGuidance).toBe("Review the actual diff.");
    expect(specialist.access).toBe("project-write");
    expect(specialist.serviceLevels.map((service) => service.level)).toEqual(SPECIALIST_LEVELS);
    expect(specialist.serviceLevels.filter((service) => service.enabled)).toEqual([
      expect.objectContaining({
        level: "standard",
        primary: {
          runtime: "claude",
          model: "claude-sonnet",
          effort: "high",
        },
      }),
    ]);
  });

  it("normalizes exact capabilities and bounded ordered fallbacks", () => {
    const [specialist] = normalizeSpecialists([
      {
        id: "ui-review",
        label: "UI review",
        access: "read-only",
        skillIds: ["design-principles", "design-principles"],
        mcpServerIds: ["figma", "figma"],
        serviceLevels: [
          {
            level: "premium",
            enabled: true,
            primary: { runtime: "claude", model: "opus" },
            fallbacksEnabled: true,
            fallbacks: [
              { runtime: "codex", model: "gpt-5" },
              { runtime: "cursor" },
              { runtime: "grok" },
              { runtime: "antigravity" },
              { runtime: "claude" },
            ],
          },
        ],
      },
    ]);

    expect(specialist.skillIds).toEqual(["design-principles"]);
    expect(specialist.mcpServerIds).toEqual(["figma"]);
    expect(
      specialist.serviceLevels.find((service) => service.level === "premium")?.fallbacks,
    ).toHaveLength(4);
    expect(
      specialist.serviceLevels.find((service) => service.level === "premium")?.fallbacks[0],
    ).toEqual({ runtime: "codex", model: "gpt-5" });
  });

  it("creates new specialists read-only with Standard as their only offered level", () => {
    const specialist = createSpecialist(7);
    expect(specialist.id).toBe("specialist-local-7");
    expect(specialist.access).toBe("read-only");
    expect(
      specialist.serviceLevels.filter((service) => service.enabled).map((service) => service.level),
    ).toEqual(["standard"]);
  });
});
