# Qwen Code — Integrator dossier

**Research status:** official-first synthesis, captured 2026-07-13.
**Manifest transport:** `acp`.
**Executable/entrypoint:** `qwen --acp --experimental-skills`.

## What the CLI is

Qwen Code documents terminal agent behavior, settings/configuration layers, context files, MCP, skills, subagents, headless automation, ACP, model/provider selection, and IDE integration. Experimental flags must be opt-in and clearly labeled.

## Command and lifecycle surface

Interactive: qwen. Headless prompt and stream-json routes are documented. ACP: qwen --acp; the manifest uses --experimental-skills only when the installed build advertises that flag. Use qwen --version and qwen --help as compatibility probes.

## Authentication, updates, and ownership

Use Qwen Code's documented login/token-plan/API-key routes. Integrator must not inspect Qwen credential files or assume an OAuth/free-tier entitlement; auth and provider selection remain vendor-owned and version-sensitive.

Updates remain vendor-owned. Integrator may run a documented version probe, show the observed version and compatibility result, and open the official setup/update flow. It must not silently install, replace, or downgrade a vendor runtime.

## Adapter methodology

1. Discover `qwen` from approved executable candidates and record provenance/version.
2. Run a non-secret compatibility/auth probe before showing the route as usable.
3. Spawn with an argv array, exact trusted repository/worktree cwd, allow-listed environment, piped stdin/stdout/stderr, kill-on-drop/process-tree cleanup, bounded output, and no renderer shell authority.
4. Complete the provider handshake or establish the documented structured/PTY route.
5. Persist only normalized task/run/session identity and references; raw provider events remain native-side and redacted.
6. Map messages, plans, files, tools, approvals, usage, and exit state only when the provider actually exposes them.
7. On cancel, timeout, crash, or reconnect, reconcile authoritative provider state before retrying. Unknown side effects are checkpointed and blocked, never blindly replayed.

Never pass credentials in argv. Keep `--experimental-skills` capability-gated because experimental skill execution widens the tool surface. ACP stdout must remain protocol-only; shell/tool approvals stay in native policy.

## Security boundary

- No credential values, token caches, MFA input, hardware-key interaction, or secure terminal input enters the renderer, transcript, ledger, diagnostics, or child context.
- Never shell-interpolate prompts, paths, model ids, or provider arguments.
- Child agents inherit no secrets and cannot widen the parent permission/network/worktree boundary.
- Provider MCP servers, hooks, plugins, skills, subagents, remote/daemon modes, and auto-approval flags are separate capabilities, not defaults.
- Hidden reasoning is not stored; only provider-labeled observable summaries are eligible for projection.

## Known gaps and drift risks

Qwen docs and releases change quickly, including auth availability and IDE/ACP behavior. Need exact current command help, stream schema, session persistence, usage fields, and Windows conformance.

Treat undocumented behavior as unresolved, not as a feature. Re-probe on executable update and invalidate capability/session caches when version, vendor auth context, or transport changes.

## Required conformance fixtures

ACP handshake; experimental skill absent/present; auth required; model config; headless stream-json; MCP; permission; session resume; malformed event; update notice; Windows launch.

## Evidence classification

- **Documented:** directly stated in the linked vendor/protocol material.
- **Observed:** confirmed by a safe local command or replay fixture against a specific installed version.
- **Inferred:** adapter design consequence; it needs a fixture before certification.
- **Unavailable:** the provider does not expose the field or the source is not stable enough to claim it.

## Integrator verdict

This route is Preview until executable/version detection, auth-state handling, protocol or PTY lifecycle, permission behavior, restart/reconnect, cancellation race, redaction, and Windows/macOS process behavior have passing fixtures. Provider parity is never implied by the vendor name.
