import type { RuntimeId, StartTaskInput } from "./bridge";

type RuntimeTurnControls = {
  runtime: RuntimeId;
  permission: StartTaskInput["permission"];
  delegation: StartTaskInput["delegation"];
};

/** Keep non-Composer retry, resume, queue, and automation paths on controls
 * the selected provider can actually honor. */
export function normalizeRuntimeTurnControls<T extends RuntimeTurnControls>(input: T): T {
  if (input.runtime !== "antigravity") return input;
  const permission = input.permission === "ask" ? "project-write" : input.permission;
  if (permission === input.permission && input.delegation === "off") return input;
  return { ...input, permission, delegation: "off" };
}
