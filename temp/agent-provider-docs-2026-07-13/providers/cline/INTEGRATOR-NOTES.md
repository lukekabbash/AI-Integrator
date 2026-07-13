# Cline — Integrator dossier

**Research status:** official-first synthesis, captured 2026-07-13.
**Manifest transport:** `acp`.
**Executable/entrypoint:** `cline --acp`.

## What the CLI is

Cline documents JSON newline output, plan mode, ACP, provider/model selection, sessions/history, MCP, hooks, plugins, skills, command permissions, sandbox/data directories, hub/remote options, and update/doctor commands.

## Command and lifecycle surface

Interactive/TUI: cline or cline -i. Headless: cline PROMPT. ACP: cline --acp. Important flags include --json, --plan, --auto-approve, --cwd, --config, --data-dir, --thinking, --retries, --hooks-dir, --id, --model, and --provider. Commands include auth, config, connect, mcp, doctor, history, hook, plugin, schedule, update, and version.

## Authentication, updates, and ownership

Use `cline auth` and provider-specific configuration in Cline's own data directory. Integrator may launch the vendor auth command in a user-owned setup terminal but never accepts or stores --key values in its own state.

Updates remain vendor-owned. Integrator may run a documented version probe, show the observed version and compatibility result, and open the official setup/update flow. It must not silently install, replace, or downgrade a vendor runtime.

## Adapter methodology

1. Discover `cline` from approved executable candidates and record provenance/version.
2. Run a non-secret compatibility/auth probe before showing the route as usable.
3. Spawn with an argv array, exact trusted repository/worktree cwd, allow-listed environment, piped stdin/stdout/stderr, kill-on-drop/process-tree cleanup, bounded output, and no renderer shell authority.
4. Complete the provider handshake or establish the documented structured/PTY route.
5. Persist only normalized task/run/session identity and references; raw provider events remain native-side and redacted.
6. Map messages, plans, files, tools, approvals, usage, and exit state only when the provider actually exposes them.
7. On cancel, timeout, crash, or reconnect, reconcile authoritative provider state before retrying. Unknown side effects are checkpointed and blocked, never blindly replayed.

Default Integrator policy must not inherit Cline's default auto-approve behavior. Parse JSON lines with bounded limits, keep hooks/MCP child processes outside renderer authority, and exclude hub/remote modes until network policy is explicit.

## Security boundary

- No credential values, token caches, MFA input, hardware-key interaction, or secure terminal input enters the renderer, transcript, ledger, diagnostics, or child context.
- Never shell-interpolate prompts, paths, model ids, or provider arguments.
- Child agents inherit no secrets and cannot widen the parent permission/network/worktree boundary.
- Provider MCP servers, hooks, plugins, skills, subagents, remote/daemon modes, and auto-approval flags are separate capabilities, not defaults.
- Hidden reasoning is not stored; only provider-labeled observable summaries are eligible for projection.

## Known gaps and drift risks

Windows support is documented as incomplete/recent, and ACP/JSON event schemas may drift. Need approval mapping fixtures and a decision on how much Cline's multi-provider routing can be represented as one runtime connection.

Treat undocumented behavior as unresolved, not as a feature. Re-probe on executable update and invalidate capability/session caches when version, vendor auth context, or transport changes.

## Required conformance fixtures

ACP handshake; JSON line stream; plan/act; auto-approve off; command permission allow/deny; auth; session id resume; MCP/hook; update check; Windows unsupported status; cancellation.

## Evidence classification

- **Documented:** directly stated in the linked vendor/protocol material.
- **Observed:** confirmed by a safe local command or replay fixture against a specific installed version.
- **Inferred:** adapter design consequence; it needs a fixture before certification.
- **Unavailable:** the provider does not expose the field or the source is not stable enough to claim it.

## Integrator verdict

This route is Preview until executable/version detection, auth-state handling, protocol or PTY lifecycle, permission behavior, restart/reconnect, cancellation race, redaction, and Windows/macOS process behavior have passing fixtures. Provider parity is never implied by the vendor name.
