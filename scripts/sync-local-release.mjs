import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditBundledSkills,
  verifyPackagedSkills,
} from "./bundled-skills-contract.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..");

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function syncLocalRelease({
  repoRoot = defaultRepoRoot,
  releaseRoot = path.resolve(repoRoot, "target", "release"),
  destinationRoot = path.resolve(repoRoot, "dist-local"),
  binaryName = "AI Integrator.exe",
  outputBinaryName = "AI Integrator-current.exe",
} = {}) {
  const contract = await auditBundledSkills(repoRoot);
  await verifyPackagedSkills(contract, releaseRoot);
  await mkdir(destinationRoot, { recursive: true });

  const stageRoot = path.resolve(
    destinationRoot,
    `.local-release-${process.pid}-${Date.now()}`,
  );
  const stagedResources = path.resolve(
    stageRoot,
    contract.runtimeResourceDirectory,
  );
  const stagedBinary = path.resolve(stageRoot, outputBinaryName);
  const sourceResources = path.resolve(
    releaseRoot,
    contract.runtimeResourceDirectory,
  );
  const sourceBinary = path.resolve(releaseRoot, binaryName);
  const destinationResources = path.resolve(
    destinationRoot,
    contract.runtimeResourceDirectory,
  );
  const destinationBinary = path.resolve(destinationRoot, outputBinaryName);
  const previousResources = path.resolve(stageRoot, "previous-resources");
  const previousBinary = path.resolve(stageRoot, "previous.exe");
  const destinationBinaryExisted = await pathExists(destinationBinary);
  const destinationResourcesExisted = await pathExists(destinationResources);
  let binaryReplaced = false;
  let resourcesBackedUp = false;
  let resourcesInstalled = false;

  try {
    await mkdir(stageRoot, { recursive: true });
    await cp(sourceResources, stagedResources, { recursive: true });
    await copyFile(sourceBinary, stagedBinary);
    await verifyPackagedSkills(contract, stageRoot);

    const [sourceBytes, stagedBytes] = await Promise.all([
      readFile(sourceBinary),
      readFile(stagedBinary),
    ]);
    if (hash(sourceBytes) !== hash(stagedBytes)) {
      throw new Error(
        "staged local executable differs from the release executable",
      );
    }

    // Copy the executable first. A running Windows build stays untouched and
    // fails here before the matching resource tree is replaced.
    if (destinationBinaryExisted) {
      await copyFile(destinationBinary, previousBinary);
    }
    await copyFile(stagedBinary, destinationBinary);
    binaryReplaced = true;
    if (destinationResourcesExisted) {
      await rename(destinationResources, previousResources);
      resourcesBackedUp = true;
    }
    await rename(stagedResources, destinationResources);
    resourcesInstalled = true;
    await verifyPackagedSkills(contract, destinationRoot);

    const destinationBytes = await readFile(destinationBinary);
    if (hash(sourceBytes) !== hash(destinationBytes)) {
      throw new Error("local executable differs from the release executable");
    }

    return {
      binary: destinationBinary,
      resources: destinationResources,
      plugins: contract.catalog.plugins.length,
      skills: contract.catalog.skills.length,
      sha256: hash(destinationBytes),
    };
  } catch (error) {
    const rollbackFailures = [];
    if (resourcesInstalled) {
      try {
        await rm(destinationResources, { recursive: true, force: true });
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (resourcesBackedUp) {
      try {
        await rename(previousResources, destinationResources);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (binaryReplaced) {
      try {
        if (destinationBinaryExisted) {
          await copyFile(previousBinary, destinationBinary);
        } else {
          await rm(destinationBinary, { force: true });
        }
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        "local release sync failed and rollback was incomplete",
      );
    }
    throw error;
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  if (process.platform !== "win32") {
    throw new Error(
      "sync-local-release currently targets the Windows loose executable",
    );
  }
  const result = await syncLocalRelease();
  console.log(
    `local release synced: ${result.skills} skills across ${result.plugins} plugins; ${result.sha256}`,
  );
}
