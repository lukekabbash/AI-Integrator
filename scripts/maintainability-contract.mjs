import { readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const SOURCE_EXTENSIONS = new Set([".rs", ".ts", ".tsx", ".css"]);
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "dist",
  "generated",
  "node_modules",
  "target",
]);

export function countPhysicalLines(source) {
  if (source.length === 0) return 0;
  const normalized = source.replaceAll("\r\n", "\n");
  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n").length
    : normalized.split("\n").length;
}

export function classifySourcePath(path) {
  const normalized = path.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  const test =
    /\.(?:test|spec)\.[^.]+$/.test(basename) ||
    /(?:^|\/)tests?(?:\/|$)/.test(normalized) ||
    /_tests?\.rs$/.test(basename) ||
    basename === "tests.rs";
  return test ? "test" : "production";
}

export function compareSizeSnapshot(snapshot, measured) {
  const failures = [];
  const exceptions = new Map(
    snapshot.exceptions.map((entry) => [
      entry.path.replaceAll("\\", "/"),
      entry,
    ]),
  );
  const measuredByPath = new Map(measured.map((entry) => [entry.path, entry]));

  for (const entry of measured) {
    const limit =
      entry.kind === "test"
        ? snapshot.maxNewTestLines
        : snapshot.maxNewProductionLines;
    const exception = exceptions.get(entry.path);
    if (entry.lines > limit && !exception) {
      failures.push(
        `${entry.path} is ${entry.lines} lines; new ${entry.kind} modules must stay at or below ${limit}`,
      );
    }
    if (exception && entry.lines !== exception.maxLines) {
      failures.push(
        entry.lines > exception.maxLines
          ? `${entry.path} grew to ${entry.lines} lines; frozen ceiling is ${exception.maxLines}`
          : `${entry.path} shrank to ${entry.lines} lines; lower its frozen ceiling from ${exception.maxLines}`,
      );
    }
  }

  for (const exception of snapshot.exceptions) {
    if (!measuredByPath.has(exception.path)) {
      failures.push(
        `${exception.path} is still allowlisted but no longer exists; remove the stale exception`,
      );
    }
  }
  return failures;
}

export function findNativeCommandsImports(entries, allowedPaths = []) {
  const importPattern = /(?:crate|super)::commands::[A-Za-z_]/;
  const allowed = new Set(
    allowedPaths.map((path) => path.replaceAll("\\", "/")),
  );
  const imports = entries
    .filter(
      ({ path, source }) =>
        path.startsWith("apps/desktop/src-tauri/src/") &&
        path !== "apps/desktop/src-tauri/src/commands.rs" &&
        importPattern.test(source),
    )
    .map(({ path }) => path);
  const importSet = new Set(imports);
  return [
    ...imports
      .filter((path) => !allowed.has(path))
      .map((path) => `${path} imports the commands facade`),
    ...[...allowed]
      .filter((path) => !importSet.has(path))
      .map(
        (path) =>
          `${path} no longer imports commands; remove the stale allowance`,
      ),
  ];
}

export function findUnexpectedBridgeImports(entries, allowedPaths) {
  const bridgeImport = /from\s+["'](?:\.\/|(?:\.\.\/)+)bridge["']/;
  const allowed = new Set(
    allowedPaths.map((path) => path.replaceAll("\\", "/")),
  );
  const imports = entries
    .filter(
      ({ path, source }) =>
        path.startsWith("apps/desktop/src/") &&
        classifySourcePath(path) === "production" &&
        bridgeImport.test(source),
    )
    .map(({ path }) => path);
  const importSet = new Set(imports);
  return [
    ...imports
      .filter((path) => !allowed.has(path))
      .map((path) => `${path} adds a direct dependency on the bridge facade`),
    ...[...allowed]
      .filter((path) => !importSet.has(path))
      .map(
        (path) =>
          `${path} no longer imports bridge; remove the stale allowance`,
      ),
  ];
}

export async function auditMaintainability(repoRoot) {
  const snapshotPath = resolve(
    repoRoot,
    "scripts",
    "maintainability.snapshot.json",
  );
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const roots = [
    resolve(repoRoot, "apps", "desktop", "src"),
    resolve(repoRoot, "apps", "desktop", "src-tauri", "src"),
    resolve(repoRoot, "crates"),
  ];
  const paths = (
    await Promise.all(roots.map((root) => sourceFiles(root)))
  ).flat();
  const entries = await Promise.all(
    paths.map(async (path) => ({
      path: relative(repoRoot, path).replaceAll("\\", "/"),
      source: await readFile(path, "utf8"),
    })),
  );
  const measured = entries.map(({ path, source }) => ({
    path,
    kind: classifySourcePath(path),
    lines: countPhysicalLines(source),
  }));
  const failures = [
    ...compareSizeSnapshot(snapshot, measured),
    ...findNativeCommandsImports(
      entries,
      snapshot.allowedNativeCommandsImports,
    ),
    ...findUnexpectedBridgeImports(entries, snapshot.allowedBridgeImports),
  ];
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  return {
    measured: measured.length,
    exceptions: snapshot.exceptions.length,
    directBridgeImports: snapshot.allowedBridgeImports.length,
  };
}

async function sourceFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(path);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.push(path);
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}
