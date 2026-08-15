import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditBundledSkills,
  verifyPackagedSkills,
} from "./bundled-skills-contract.mjs";
import { syncLocalRelease } from "./sync-local-release.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("local release sync keeps the executable and all bundled skills together", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "integrator-local-release-"));
  const releaseRoot = path.resolve(root, "release");
  const destinationRoot = path.resolve(root, "dist-local");
  const contract = await auditBundledSkills(repoRoot);

  try {
    await cp(
      contract.sourceRoot,
      path.resolve(releaseRoot, contract.runtimeResourceDirectory),
      { recursive: true },
    );
    await writeFile(
      path.resolve(releaseRoot, "AI Integrator.exe"),
      "release-binary",
    );

    const result = await syncLocalRelease({
      repoRoot,
      releaseRoot,
      destinationRoot,
    });

    assert.equal(result.plugins, 7);
    assert.equal(result.skills, 16);
    assert.equal(
      await readFile(
        path.resolve(destinationRoot, "AI Integrator-current.exe"),
        "utf8",
      ),
      "release-binary",
    );
    await verifyPackagedSkills(contract, destinationRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a lone release executable without touching the current local build", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "integrator-incomplete-release-"),
  );
  const releaseRoot = path.resolve(root, "release");
  const destinationRoot = path.resolve(root, "dist-local");

  try {
    await mkdir(releaseRoot, { recursive: true });
    await mkdir(destinationRoot, { recursive: true });
    await writeFile(
      path.resolve(releaseRoot, "AI Integrator.exe"),
      "incomplete-release",
    );
    await writeFile(
      path.resolve(destinationRoot, "AI Integrator-current.exe"),
      "known-good-release",
    );

    await assert.rejects(
      syncLocalRelease({ repoRoot, releaseRoot, destinationRoot }),
      /first-party-plugins|ENOENT/,
    );
    assert.equal(
      await readFile(
        path.resolve(destinationRoot, "AI Integrator-current.exe"),
        "utf8",
      ),
      "known-good-release",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restores the previous executable when resource replacement fails", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "integrator-release-rollback-"),
  );
  const releaseRoot = path.resolve(root, "release");
  const destinationRoot = path.resolve(root, "dist-local");
  const contract = await auditBundledSkills(repoRoot);
  const originalNow = Date.now;
  const fixedNow = 1_234_567_890;

  try {
    Date.now = () => fixedNow;
    await cp(
      contract.sourceRoot,
      path.resolve(releaseRoot, contract.runtimeResourceDirectory),
      { recursive: true },
    );
    await cp(
      contract.sourceRoot,
      path.resolve(destinationRoot, contract.runtimeResourceDirectory),
      { recursive: true },
    );
    await writeFile(
      path.resolve(releaseRoot, "AI Integrator.exe"),
      "new-release",
    );
    await writeFile(
      path.resolve(destinationRoot, "AI Integrator-current.exe"),
      "known-good-release",
    );
    const conflictingBackup = path.resolve(
      destinationRoot,
      `.local-release-${process.pid}-${fixedNow}`,
      "previous-resources",
    );
    await mkdir(conflictingBackup, { recursive: true });
    await writeFile(path.resolve(conflictingBackup, "blocker"), "occupied");

    await assert.rejects(
      syncLocalRelease({ repoRoot, releaseRoot, destinationRoot }),
      /EEXIST|ENOTEMPTY|EPERM|already exists/,
    );
    assert.equal(
      await readFile(
        path.resolve(destinationRoot, "AI Integrator-current.exe"),
        "utf8",
      ),
      "known-good-release",
    );
    await verifyPackagedSkills(contract, destinationRoot);
  } finally {
    Date.now = originalNow;
    await rm(root, { recursive: true, force: true });
  }
});
