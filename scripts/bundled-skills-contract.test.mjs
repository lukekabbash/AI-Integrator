import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  auditBundledSkills,
  compareCatalogSnapshots,
  compareFileInventories,
  normalizeResourceTarget,
  parseRuntimeResourceDirectory,
  parseSkillName,
} from "./bundled-skills-contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("checked-in first-party catalog matches runtime and bundle configuration", async () => {
  const contract = await auditBundledSkills(repoRoot);
  assert.equal(contract.runtimeResourceDirectory, "first-party-plugins");
  assert.equal(contract.catalog.plugins.length, 7);
  assert.equal(contract.catalog.skills.length, 16);
});

test("parses runtime and skill metadata without accepting an unsafe target", () => {
  assert.equal(
    normalizeResourceTarget("./first-party-plugins/"),
    "first-party-plugins",
  );
  assert.throws(
    () => normalizeResourceTarget("../plugins"),
    /invalid bundled resource target/,
  );
  assert.equal(
    parseRuntimeResourceDirectory(
      'const BUNDLED_PLUGINS_RESOURCE_DIR: &str = "first-party-plugins";',
    ),
    "first-party-plugins",
  );
  assert.equal(
    parseSkillName("---\nname: fred\ndescription: Economic data\n---\n# FRED"),
    "fred",
  );
});

test("reports catalog drift and packaged payload drift", () => {
  assert.deepEqual(
    compareCatalogSnapshots(
      { plugins: ["a"], skills: ["a:one"] },
      { plugins: ["a", "b"], skills: [] },
    ),
    ["new plugins: b", "missing skills: a:one"],
  );
  assert.deepEqual(
    compareFileInventories(
      [{ path: "SKILL.md", bytes: 10, sha256: "a" }],
      [{ path: "SKILL.md", bytes: 11, sha256: "b" }],
    ),
    ["packaged file differs: SKILL.md"],
  );
});
