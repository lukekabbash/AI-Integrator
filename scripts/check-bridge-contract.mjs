import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridgePath = resolve(root, "apps/desktop/src/bridge.ts");
const tauriPath = resolve(root, "apps/desktop/src-tauri/src/lib.rs");
const tauriBuildPath = resolve(root, "apps/desktop/src-tauri/build.rs");
const capabilityPath = resolve(
  root,
  "apps/desktop/src-tauri/capabilities/default.json",
);

const [bridge, tauri, tauriBuild, capabilitySource] = await Promise.all([
  readFile(bridgePath, "utf8"),
  readFile(tauriPath, "utf8"),
  readFile(tauriBuildPath, "utf8"),
  readFile(capabilityPath, "utf8"),
]);

const handler = tauri.match(/generate_handler!\[([\s\S]*?)\]/)?.[1];
if (!handler) fail("could not locate tauri::generate_handler! registration");

const registered = new Set(
  [...handler.matchAll(/\b([a-z][a-z0-9_]+)\s*,/g)].map((match) => match[1]),
);
if (registered.size === 0) fail("Tauri command registration is empty");

const manifest = tauriBuild.match(
  /const APP_COMMANDS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/,
)?.[1];
if (!manifest) fail("could not locate build.rs APP_COMMANDS manifest");
const manifested = new Set(
  [...manifest.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]),
);
if (manifested.size === 0) fail("Tauri app command manifest is empty");

const missingFromManifest = [...registered]
  .filter((command) => !manifested.has(command))
  .sort();
if (missingFromManifest.length > 0) {
  fail(
    `registered command(s) missing from Tauri app manifest: ${missingFromManifest.join(", ")}`,
  );
}

const staleManifestCommands = [...manifested]
  .filter((command) => !registered.has(command))
  .sort();
if (staleManifestCommands.length > 0) {
  fail(
    `stale Tauri app manifest command(s): ${staleManifestCommands.join(", ")}`,
  );
}

const invoked = new Set();
for (const match of bridge.matchAll(
  /(?:nativeInvoke|invokeOrDemo)(?:<[^>]+>)?\(\s*"([a-z][a-z0-9_]*)"/g,
)) {
  invoked.add(match[1]);
}
for (const match of bridge.matchAll(
  /nativeInvoke(?:<[^>]+>)?\(\s*[^,\n?]+\?\s*"([a-z][a-z0-9_]*)"\s*:\s*"([a-z][a-z0-9_]*)"/g,
)) {
  invoked.add(match[1]);
  invoked.add(match[2]);
}

if (invoked.size === 0)
  fail("bridge does not contain any statically auditable native invokes");

const unregistered = [...invoked]
  .filter((command) => !registered.has(command))
  .sort();
if (unregistered.length > 0) {
  fail(`unregistered native invoke command(s): ${unregistered.join(", ")}`);
}

let capability;
try {
  capability = JSON.parse(capabilitySource);
} catch (error) {
  fail(`could not parse desktop capability: ${error.message}`);
}
if (!Array.isArray(capability.permissions)) {
  fail("desktop capability permissions must be an array");
}

const commandPermission = (command) => `allow-${command.replaceAll("_", "-")}`;
const allowedAppPermissions = new Set(
  capability.permissions.filter((permission) =>
    /^allow-[a-z][a-z0-9-]*$/.test(permission),
  ),
);
const expectedAppPermissions = new Set([...invoked].map(commandPermission));

const missingPermissions = [...expectedAppPermissions]
  .filter((permission) => !allowedAppPermissions.has(permission))
  .sort();
if (missingPermissions.length > 0) {
  fail(
    `native invoke permission(s) missing from desktop capability: ${missingPermissions.join(", ")}`,
  );
}

const staleOrOverbroadPermissions = [...allowedAppPermissions]
  .filter((permission) => !expectedAppPermissions.has(permission))
  .sort();
if (staleOrOverbroadPermissions.length > 0) {
  fail(
    `stale or uninvoked app permission(s) in desktop capability: ${staleOrOverbroadPermissions.join(", ")}`,
  );
}

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
const legacy = legacyCommands.filter((command) =>
  bridge.includes(`"${command}"`),
);
if (legacy.length > 0)
  fail(`legacy bridge command(s) returned: ${legacy.join(", ")}`);

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

const unused = [...registered]
  .filter((command) => !invoked.has(command))
  .sort();
console.log(
  `bridge contract: PASS (${invoked.size} invoked and allowed, ${registered.size} registered and manifested, ${unused.length} registered for future UI use)`,
);

function fail(message) {
  console.error(`bridge contract: FAIL - ${message}`);
  process.exit(1);
}
