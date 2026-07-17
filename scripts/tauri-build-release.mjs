import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };

if (
  process.platform === "darwin" &&
  !env.APPLE_SIGNING_IDENTITY &&
  !env.APPLE_CERTIFICATE
) {
  const identities = spawnSync(
    "/usr/bin/security",
    ["find-identity", "-v", "-p", "codesigning"],
    { encoding: "utf8" },
  );
  const identity = identities.stdout
    ?.split("\n")
    .map(
      (line) =>
        line.match(
          /"((?:Developer ID Application|Apple Distribution):[^"]+)"/,
        )?.[1],
    )
    .find(Boolean);

  if (!identity) {
    console.error(
      "A distributable macOS build requires a Developer ID Application or Apple Distribution identity.",
    );
    console.error(
      "Install the production certificate or provide Tauri's APPLE_CERTIFICATE signing variables.",
    );
    process.exit(1);
  }
  env.APPLE_SIGNING_IDENTITY = identity;
}

const result = spawnSync(
  "npm",
  ["--prefix", "apps/desktop", "run", "tauri", "--", "build"],
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
