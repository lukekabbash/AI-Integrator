import { describe, expect, it } from "vitest";

import type { IntegratorSkillInfo } from "./bridge";
import {
  groupSkills,
  isSkillEnabled,
  readSkillEnablement,
  withSkillEnablement,
  withSkillsEnablement,
} from "./skillsSettings";

const skill = (patch: Partial<IntegratorSkillInfo>): IntegratorSkillInfo => ({
  name: "integrator:fred",
  description: "FRED data",
  source: "integrator",
  enabled: true,
  defaultEnabled: true,
  ...patch,
});

describe("skill enablement map", () => {
  it("ignores malformed stored values instead of trusting them", () => {
    expect(readSkillEnablement(undefined)).toEqual({});
    expect(readSkillEnablement("on")).toEqual({});
    expect(readSkillEnablement(["gov-data:fred"])).toEqual({});
    expect(readSkillEnablement({ "gov-data:fred": "yes", "integrator:a": false })).toEqual({
      "integrator:a": false,
    });
  });

  it("prefers the explicit override and falls back to the host's enabled state", () => {
    const map = withSkillEnablement({}, "gov-data:fred", true);
    expect(isSkillEnabled(map, skill({ name: "gov-data:fred", defaultEnabled: false }))).toBe(true);
    expect(
      isSkillEnabled({}, skill({ name: "gov-data:fred", enabled: false, defaultEnabled: true })),
    ).toBe(false);
    expect(isSkillEnabled({}, skill({ enabled: true, defaultEnabled: false }))).toBe(true);
  });

  it("keeps an override that matches the default so the decision survives default changes", () => {
    const map = withSkillEnablement({}, "integrator:fred", true);
    expect(map).toEqual({ "integrator:fred": true });
  });

  it("toggles every skill in one plugin without disturbing other plugins", () => {
    const result = withSkillsEnablement(
      { "integrator:mine": false, "gov-data:fred": false },
      [skill({ name: "gov-data:fred" }), skill({ name: "gov-data:bls" })],
      true,
    );
    expect(result).toEqual({
      "integrator:mine": false,
      "gov-data:fred": true,
      "gov-data:bls": true,
    });
  });
});

describe("groupSkills", () => {
  it("groups by plugin namespace with user skills first", () => {
    const groups = groupSkills([
      skill({ name: "gov-data:fred", source: "first-party", defaultEnabled: false }),
      skill({ name: "integrator:mine" }),
      skill({ name: "gov-data:bls", source: "first-party", defaultEnabled: false }),
      skill({ name: "vercel:vercel-docs", source: "plugin", defaultEnabled: false }),
    ]);
    expect(groups.map((group) => group.title)).toEqual(["My skills", "vercel", "gov-data"]);
    expect(groups[2].skills).toHaveLength(2);
  });
});
