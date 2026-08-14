import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  auditBundledSkills,
  verifyPackagedSkills,
} from "./bundled-skills-contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let resourceRoot;
if (args.length > 0) {
  if (args.length !== 2 || args[0] !== "--resource-root") {
    console.error(
      "usage: node scripts/check-bundled-skills.mjs [--resource-root <path>]",
    );
    process.exit(2);
  }
  resourceRoot = resolve(repoRoot, args[1]);
}

try {
  const contract = await auditBundledSkills(repoRoot);
  const packaged = resourceRoot
    ? await verifyPackagedSkills(contract, resourceRoot)
    : undefined;
  const payload = packaged ? `, ${packaged.files} packaged files verified` : "";
  console.log(
    `bundled skills contract: PASS (${contract.catalog.plugins.length} plugins, ${contract.catalog.skills.length} skills${payload})`,
  );
} catch (error) {
  console.error(`bundled skills contract: FAIL\n${error.message}`);
  process.exit(1);
}
