import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, resolve } from "node:path";
import {
  commandSignatureLines,
  compareSignatureLines,
  duplicates,
  parseBridgeInvocations,
  parseManifestCommands,
  parseRegisteredCommands,
  parseRustCommands,
  validateInvocationArguments,
} from "./bridge-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rendererSource = resolve(root, "apps/desktop/src");
const nativeSource = resolve(root, "apps/desktop/src-tauri/src");
const bridgeRootPath = resolve(rendererSource, "bridge.ts");
const bridgeModulesPath = resolve(rendererSource, "bridge");
const tauriPath = resolve(nativeSource, "lib.rs");
const tauriBuildPath = resolve(root, "apps/desktop/src-tauri/build.rs");
const capabilityPath = resolve(
  root,
  "apps/desktop/src-tauri/capabilities/default.json",
);
const snapshotPath = resolve(root, "scripts/bridge-contract.snapshot.json");

const bridgePaths = [
  bridgeRootPath,
  ...(await sourceFiles(bridgeModulesPath, new Set([".ts", ".tsx"]), true)),
];
const rustPaths = await sourceFiles(nativeSource, new Set([".rs"]));
const [
  tauri,
  tauriBuild,
  capabilitySource,
  snapshotSource,
  bridgeSources,
  rustSources,
] = await Promise.all([
  readFile(tauriPath, "utf8"),
  readFile(tauriBuildPath, "utf8"),
  readFile(capabilityPath, "utf8"),
  readFile(snapshotPath, "utf8"),
  readSources(bridgePaths),
  readSources(rustPaths),
]);

const registeredList = parseOrFail(() => parseRegisteredCommands(tauri));
const manifestedList = parseOrFail(() => parseManifestCommands(tauriBuild));
rejectDuplicates("Tauri registration", registeredList);
rejectDuplicates("Tauri app manifest", manifestedList);
const registered = new Set(registeredList);
const manifested = new Set(manifestedList);
if (registered.size === 0) fail("Tauri command registration is empty");
if (manifested.size === 0) fail("Tauri app command manifest is empty");

assertSameSet(
  registered,
  manifested,
  "registered command(s) missing from Tauri app manifest",
  "stale Tauri app manifest command(s)",
);

const rustCommands = rustSources.flatMap(({ path, source }) =>
  parseOrFail(() => parseRustCommands(source, displayPath(path))),
);
rejectDuplicates(
  "#[tauri::command] handler",
  rustCommands.map((command) => command.name),
);
const commandMap = new Map(
  rustCommands.map((command) => [command.name, command]),
);
const defined = new Set(commandMap.keys());
assertSameSet(
  registered,
  defined,
  "registered command(s) missing a #[tauri::command] handler",
  "unregistered #[tauri::command] handler(s)",
);

const invocations = bridgeSources.flatMap(({ path, source }) =>
  parseOrFail(() => parseBridgeInvocations(source, displayPath(path))),
);
const invoked = new Set(invocations.map((invocation) => invocation.command));
if (invoked.size === 0) {
  fail("bridge sources do not contain any statically auditable native invokes");
}
const unregistered = difference(invoked, registered);
if (unregistered.length > 0) {
  fail(`unregistered native invoke command(s): ${unregistered.join(", ")}`);
}

const argumentAudit = validateInvocationArguments(commandMap, invocations);
if (argumentAudit.failures.length > 0) fail(argumentAudit.failures.join("\n"));

let capability;
try {
  capability = JSON.parse(capabilitySource);
} catch (error) {
  fail(`could not parse desktop capability: ${error.message}`);
}
if (!Array.isArray(capability.permissions)) {
  fail("desktop capability permissions must be an array");
}
rejectDuplicates("desktop capability permission", capability.permissions);

const commandPermission = (command) => `allow-${command.replaceAll("_", "-")}`;
const allowedAppPermissions = new Set(
  capability.permissions.filter((permission) =>
    /^allow-[a-z][a-z0-9-]*$/.test(permission),
  ),
);
const expectedAppPermissions = new Set([...invoked].map(commandPermission));
assertSameSet(
  expectedAppPermissions,
  allowedAppPermissions,
  "native invoke permission(s) missing from desktop capability",
  "stale or uninvoked app permission(s) in desktop capability",
);

const deniedInvokedCommands = [...invoked]
  .map((command) => `deny-${command.replaceAll("_", "-")}`)
  .filter((permission) => capability.permissions.includes(permission))
  .sort();
if (deniedInvokedCommands.length > 0) {
  fail(
    `invoked command(s) explicitly denied: ${deniedInvokedCommands.join(", ")}`,
  );
}

const legacyCommands = [
  "runtime_probe_all",
  "runtime_begin_login",
  "task_start",
  "task_send_turn",
  "git_set_staged",
  "git_push",
  "session_persist",
];
const legacy = legacyCommands.filter((command) => invoked.has(command));
if (legacy.length > 0)
  fail(`legacy bridge command(s) returned: ${legacy.join(", ")}`);

auditDemoFallback(bridgeSources);
if (process.argv.includes("--print-snapshot")) {
  console.log(
    JSON.stringify(
      { version: 1, signatures: commandSignatureLines(rustCommands) },
      null,
      2,
    ),
  );
  process.exit(0);
}
auditSnapshot(snapshotSource, rustCommands);

const unused = difference(registered, invoked);
const incompleteArgumentAudits =
  invocations.length - argumentAudit.fullyAudited;
console.log(
  `bridge contract: PASS (${invoked.size} invoked and allowed, ${registered.size} registered/manifested/defined, ${argumentAudit.fullyAudited} fully audited invocation signatures, ${incompleteArgumentAudits} spread/dynamic invocation signatures, ${unused.length} registered for future UI use)`,
);

function auditDemoFallback(sources) {
  const bridge = sources.find(({ path }) => path === bridgeRootPath)?.source;
  if (!bridge) fail("could not read the root bridge facade");
  const invokeOrDemoBody = bridge.match(
    /async function invokeOrDemo[\s\S]*?\n}\n\nfunction runtimeId/,
  )?.[0];
  if (!invokeOrDemoBody)
    fail("could not audit invokeOrDemo native fallback policy");
  if (/\bcatch\b/.test(invokeOrDemoBody)) {
    fail(
      "invokeOrDemo catches native failures; native commands must never fall back to demo success",
    );
  }
  if (
    !/if \(isTauri\(\)\) \{\s*return nativeInvoke<T>\(command, args\);\s*}/.test(
      invokeOrDemoBody,
    )
  ) {
    fail("invokeOrDemo no longer routes native calls directly to nativeInvoke");
  }
  if (/using safe demo fallback|native failure[\s\S]{0,80}demo/i.test(bridge)) {
    fail("native demo-fallback marker found in bridge");
  }
}

function auditSnapshot(snapshotSource, commands) {
  let snapshot;
  try {
    snapshot = JSON.parse(snapshotSource);
  } catch (error) {
    fail(`could not parse bridge contract snapshot: ${error.message}`);
  }
  if (snapshot.version !== 1 || !Array.isArray(snapshot.signatures)) {
    fail("bridge contract snapshot must contain version 1 signatures");
  }
  rejectDuplicates("bridge contract snapshot signature", snapshot.signatures);
  const actual = commandSignatureLines(commands);
  const delta = compareSignatureLines(snapshot.signatures, actual);
  if (delta.removed.length > 0 || delta.added.length > 0) {
    const details = [
      ...delta.removed.map((line) => `- ${line}`),
      ...delta.added.map((line) => `+ ${line}`),
    ];
    fail(`native command signature snapshot changed:\n${details.join("\n")}`);
  }
}

async function readSources(paths) {
  return Promise.all(
    paths.map(async (path) => ({ path, source: await readFile(path, "utf8") })),
  );
}

async function sourceFiles(directory, extensions, optional = false) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (optional && error.code === "ENOENT") return [];
    throw error;
  }
  const paths = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      paths.push(...(await sourceFiles(path, extensions)));
    else if (
      extensions.has(extname(entry.name)) &&
      !/\.(?:test|spec)\.[^.]+$/.test(entry.name)
    ) {
      paths.push(path);
    }
  }
  return paths;
}

function assertSameSet(left, right, missingLabel, extraLabel) {
  const missing = difference(left, right);
  if (missing.length > 0) fail(`${missingLabel}: ${missing.join(", ")}`);
  const extra = difference(right, left);
  if (extra.length > 0) fail(`${extraLabel}: ${extra.join(", ")}`);
}

function rejectDuplicates(label, values) {
  const repeated = duplicates(values);
  if (repeated.length > 0)
    fail(`duplicate ${label}(s): ${repeated.join(", ")}`);
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

function parseOrFail(parse) {
  try {
    return parse();
  } catch (error) {
    fail(error.message);
  }
}

function displayPath(path) {
  return relative(root, path).replaceAll("\\", "/");
}

function fail(message) {
  console.error(`bridge contract: FAIL - ${message}`);
  process.exit(1);
}
