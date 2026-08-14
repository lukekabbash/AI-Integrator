import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const RUNTIME_RESOURCE_CONSTANT = "BUNDLED_PLUGINS_RESOURCE_DIR";

export function normalizeResourceTarget(target) {
  const normalized = target
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`invalid bundled resource target: ${target}`);
  }
  return normalized;
}

export function parseRuntimeResourceDirectory(source) {
  const expression = new RegExp(
    `const\\s+${RUNTIME_RESOURCE_CONSTANT}\\s*:\\s*&str\\s*=\\s*"([^"]+)"`,
  );
  const match = source.match(expression);
  if (!match) {
    throw new Error(
      `integrator_skills.rs must define ${RUNTIME_RESOURCE_CONSTANT}`,
    );
  }
  return normalizeResourceTarget(match[1]);
}

export function parseSkillName(source, path = "SKILL.md") {
  const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) {
    throw new Error(`${path} is missing YAML frontmatter`);
  }
  const name = frontmatter[1].match(/^name:\s*([^\r\n#]+?)\s*$/m)?.[1];
  if (!name) {
    throw new Error(`${path} is missing a frontmatter name`);
  }
  return name;
}

export function compareCatalogSnapshots(expected, actual) {
  const failures = [];
  for (const key of ["plugins", "skills"]) {
    const expectedValues = expected[key] ?? [];
    const actualValues = actual[key] ?? [];
    const expectedSet = new Set(expectedValues);
    const actualSet = new Set(actualValues);
    const missing = expectedValues.filter((value) => !actualSet.has(value));
    const added = actualValues.filter((value) => !expectedSet.has(value));
    if (missing.length > 0)
      failures.push(`missing ${key}: ${missing.join(", ")}`);
    if (added.length > 0) failures.push(`new ${key}: ${added.join(", ")}`);
  }
  return failures;
}

export function compareFileInventories(expected, actual) {
  const failures = [];
  const expectedByPath = new Map(expected.map((file) => [file.path, file]));
  const actualByPath = new Map(actual.map((file) => [file.path, file]));
  for (const file of expected) {
    const packaged = actualByPath.get(file.path);
    if (!packaged) {
      failures.push(`missing packaged file: ${file.path}`);
    } else if (
      packaged.sha256 !== file.sha256 ||
      packaged.bytes !== file.bytes
    ) {
      failures.push(`packaged file differs: ${file.path}`);
    }
  }
  for (const file of actual) {
    if (!expectedByPath.has(file.path)) {
      failures.push(`unexpected packaged file: ${file.path}`);
    }
  }
  return failures;
}

export async function readCatalog(root) {
  const pluginEntries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));
  const plugins = [];
  const skills = [];

  for (const entry of pluginEntries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(
        `first-party plugin must be a real directory: ${entry.name}`,
      );
    }
    const pluginRoot = resolve(root, entry.name);
    const manifestPath = resolve(pluginRoot, ".claude-plugin", "plugin.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      throw new Error(
        `${entry.name} has no valid .claude-plugin/plugin.json: ${error.message}`,
      );
    }
    if (manifest.name !== entry.name) {
      throw new Error(
        `${entry.name} manifest name is ${JSON.stringify(manifest.name)}`,
      );
    }
    plugins.push(entry.name);

    const files = await walkFiles(pluginRoot);
    const skillFiles = files.filter((path) => path.endsWith("/SKILL.md"));
    if (skillFiles.length === 0) {
      throw new Error(`${entry.name} does not contain a SKILL.md`);
    }
    for (const skillPath of skillFiles) {
      const name = parseSkillName(
        await readFile(resolve(pluginRoot, ...skillPath.split("/")), "utf8"),
        `${entry.name}/${skillPath}`,
      );
      skills.push(`${entry.name}:${name}`);
    }
  }

  const sortedSkills = skills.sort((left, right) => left.localeCompare(right));
  const duplicates = sortedSkills.filter(
    (skill, index) => index > 0 && skill === sortedSkills[index - 1],
  );
  if (duplicates.length > 0) {
    throw new Error(
      `duplicate bundled skill names: ${[...new Set(duplicates)].join(", ")}`,
    );
  }
  return { plugins, skills: sortedSkills };
}

export async function readFileInventory(root) {
  const files = await walkFiles(root);
  return Promise.all(
    files.map(async (path) => {
      const bytes = await readFile(resolve(root, ...path.split("/")));
      return {
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
}

export async function auditBundledSkills(repoRoot) {
  const tauriRoot = resolve(repoRoot, "apps", "desktop", "src-tauri");
  const sourceRoot = resolve(repoRoot, "first-party", "plugins");
  const configPath = resolve(tauriRoot, "tauri.conf.json");
  const runtimePath = resolve(tauriRoot, "src", "integrator_skills.rs");
  const snapshotPath = resolve(
    repoRoot,
    "scripts",
    "bundled-skills.snapshot.json",
  );
  const [configSource, runtimeSource, snapshotSource] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(runtimePath, "utf8"),
    readFile(snapshotPath, "utf8"),
  ]);
  const config = JSON.parse(configSource);
  const resources = config.bundle?.resources;
  if (!resources || Array.isArray(resources) || typeof resources !== "object") {
    throw new Error(
      "tauri.conf.json bundle.resources must be a source-to-target map",
    );
  }

  const canonicalSourceRoot = await realpath(sourceRoot);
  const mappings = [];
  for (const [source, target] of Object.entries(resources)) {
    let canonicalSource;
    try {
      canonicalSource = await realpath(resolve(tauriRoot, source));
    } catch {
      continue;
    }
    if (canonicalSource === canonicalSourceRoot)
      mappings.push({ source, target });
  }
  if (mappings.length !== 1) {
    throw new Error(
      `tauri.conf.json must map first-party/plugins exactly once; found ${mappings.length}`,
    );
  }

  const runtimeResourceDirectory = parseRuntimeResourceDirectory(runtimeSource);
  const configuredTarget = normalizeResourceTarget(mappings[0].target);
  if (configuredTarget !== runtimeResourceDirectory) {
    throw new Error(
      `Tauri bundles skills to ${configuredTarget}, but runtime discovery reads ${runtimeResourceDirectory}`,
    );
  }

  const [actual, expected] = await Promise.all([
    readCatalog(sourceRoot),
    JSON.parse(snapshotSource),
  ]);
  const catalogFailures = compareCatalogSnapshots(expected, actual);
  if (catalogFailures.length > 0) {
    throw new Error(
      `bundled skills snapshot changed; review and update it intentionally:\n${catalogFailures.join("\n")}`,
    );
  }

  return {
    sourceRoot,
    runtimeResourceDirectory,
    mapping: mappings[0],
    catalog: actual,
  };
}

export async function verifyPackagedSkills(contract, resourceRoot) {
  const packagedRoot = resolve(resourceRoot, contract.runtimeResourceDirectory);
  const [sourceFiles, packagedFiles, packagedCatalog] = await Promise.all([
    readFileInventory(contract.sourceRoot),
    readFileInventory(packagedRoot),
    readCatalog(packagedRoot),
  ]);
  const failures = [
    ...compareFileInventories(sourceFiles, packagedFiles),
    ...compareCatalogSnapshots(contract.catalog, packagedCatalog),
  ];
  if (failures.length > 0) {
    throw new Error(
      `packaged bundled skills do not match source:\n${failures.join("\n")}`,
    );
  }
  return { packagedRoot, files: packagedFiles.length };
}

async function walkFiles(root) {
  const files = [];
  async function visit(directory, prefix) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`bundled catalog cannot contain symlinks: ${path}`);
      }
      if (entry.isDirectory()) {
        await visit(resolve(directory, entry.name), path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  await visit(root, "");
  return files;
}
