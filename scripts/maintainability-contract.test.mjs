import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  auditMaintainability,
  classifySourcePath,
  compareSizeSnapshot,
  countPhysicalLines,
  findNativeCommandsImports,
  findUnexpectedBridgeImports,
} from "./maintainability-contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("checked-in source satisfies frozen maintainability ceilings", async () => {
  const result = await auditMaintainability(repoRoot);
  assert.ok(result.measured > 100);
  assert.ok(result.exceptions > 0);
});

test("classifies and ratchets new versus grandfathered modules", () => {
  assert.equal(countPhysicalLines("one\ntwo\n"), 2);
  assert.equal(classifySourcePath("src/view.test.tsx"), "test");
  assert.equal(classifySourcePath("src/tests.rs"), "test");
  assert.equal(classifySourcePath("src/view.tsx"), "production");

  const snapshot = {
    maxNewProductionLines: 1000,
    maxNewTestLines: 1500,
    exceptions: [
      { path: "src/legacy.ts", maxLines: 2000 },
      { path: "src/shrunk.ts", maxLines: 500 },
    ],
  };
  assert.deepEqual(
    compareSizeSnapshot(snapshot, [
      { path: "src/legacy.ts", kind: "production", lines: 2001 },
      { path: "src/new.ts", kind: "production", lines: 1001 },
      { path: "src/shrunk.ts", kind: "production", lines: 450 },
    ]),
    [
      "src/legacy.ts grew to 2001 lines; frozen ceiling is 2000",
      "src/new.ts is 1001 lines; new production modules must stay at or below 1000",
      "src/shrunk.ts shrank to 450 lines; lower its frozen ceiling from 500",
    ],
  );
});

test("rejects reverse native imports and new direct bridge coupling", () => {
  assert.deepEqual(
    findNativeCommandsImports([
      {
        path: "apps/desktop/src-tauri/src/settings.rs",
        source: "use crate::commands::CommandError;",
      },
    ]),
    ["apps/desktop/src-tauri/src/settings.rs imports the commands facade"],
  );
  assert.deepEqual(
    findUnexpectedBridgeImports(
      [
        {
          path: "apps/desktop/src/components/NewLeaf.tsx",
          source: 'import type { Task } from "../bridge";',
        },
      ],
      [],
    ),
    [
      "apps/desktop/src/components/NewLeaf.tsx adds a direct dependency on the bridge facade",
    ],
  );
  assert.deepEqual(
    findNativeCommandsImports([], ["apps/desktop/src-tauri/src/delegation.rs"]),
    [
      "apps/desktop/src-tauri/src/delegation.rs no longer imports commands; remove the stale allowance",
    ],
  );
  assert.deepEqual(
    findUnexpectedBridgeImports(
      [],
      ["apps/desktop/src/components/OldLeaf.tsx"],
    ),
    [
      "apps/desktop/src/components/OldLeaf.tsx no longer imports bridge; remove the stale allowance",
    ],
  );
});
