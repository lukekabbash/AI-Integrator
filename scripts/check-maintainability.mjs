import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { auditMaintainability } from "./maintainability-contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const result = await auditMaintainability(repoRoot);
  console.log(
    `maintainability contract: PASS (${result.measured} source files, ${result.exceptions} frozen size exceptions, ${result.directBridgeImports} existing bridge dependencies)`,
  );
} catch (error) {
  console.error(`maintainability contract: FAIL\n${error.message}`);
  process.exit(1);
}
