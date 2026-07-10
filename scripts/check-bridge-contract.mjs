import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridgePath = resolve(root, "apps/desktop/src/bridge.ts");
const tauriPath = resolve(root, "apps/desktop/src-tauri/src/lib.rs");

const [bridge, tauri] = await Promise.all([
  readFile(bridgePath, "utf8"),
  readFile(tauriPath, "utf8"),
]);

const handler = tauri.match(/generate_handler!\[([\s\S]*?)\]/)?.[1];
if (!handler) fail("could not locate tauri::generate_handler! registration");

const registered = new Set(
  [...handler.matchAll(/\b([a-z][a-z0-9_]+)\s*,/g)].map((match) => match[1]),
);
if (registered.size === 0) fail("Tauri command registration is empty");

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
  `bridge contract: PASS (${invoked.size} invoked, ${registered.size} registered, ${unused.length} registered for future UI use)`,
);

function fail(message) {
  console.error(`bridge contract: FAIL - ${message}`);
  process.exit(1);
}
