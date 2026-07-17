import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const env = { ...process.env };

delete env.CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER;
delete env.CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER;

const result = spawnSync(
  "npm",
  [
    "--prefix",
    "apps/desktop",
    "run",
    "tauri",
    "--",
    "dev",
    ...(watch ? [] : ["--no-watch"]),
  ],
  {
    cwd: root,
    env,
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
