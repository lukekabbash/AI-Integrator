# Kilo — Integrator dossier

**Research status:** official-first synthesis, captured 2026-07-13.
**Manifest transport:** `acp`.
**Executable/entrypoint:** `kilo acp`.

## What the CLI is

Kilo documents multi-provider model routing, modes, skills, MCP, sessions, export/import, local review, permissions allow/ask/deny, ACP, gateway profile/team state, and optional remote/daemon surfaces.

## Command and lifecycle surface

Install globally with @kilocode/cli. TUI: kilo. One-shot: kilo run MESSAGE. Protocol: kilo acp. Other documented commands include auth, models, stats, session, export/import, mcp, agent, config, upgrade, uninstall, serve, daemon, and completion.

## Authentication, updates, and ownership

Kilo uses `/connect`, `kilo auth`, gateway login, and provider-specific credentials. Integrator should only expose sanitized auth state and let Kilo own its credential/config stores; remote mode is outside the local-only v1 route.

Updates remain vendor-owned. Integrator may run a documented version probe, show the observed version and compatibility result, and open the official setup/update flow. It must not silently install, replace, or downgrade a vendor runtime.

## Adapter methodology

1. Discover `kilo` from approved executable candidates and record provenance/version.
2. Run a non-secret compatibility/auth probe before showing the route as usable.
3. Spawn with an argv array, exact trusted repository/worktree cwd, allow-listed environment, piped stdin/stdout/stderr, kill-on-drop/process-tree cleanup, bounded output, and no renderer shell authority.
4. Complete the provider handshake or establish the documented structured/PTY route.
5. Persist only normalized task/run/session identity and references; raw provider events remain native-side and redacted.
6. Map messages, plans, files, tools, approvals, usage, and exit state only when the provider actually exposes them.
7. On cancel, timeout, crash, or reconnect, reconcile authoritative provider state before retrying. Unknown side effects are checkpointed and blocked, never blindly replayed.

Exclude remote, web, daemon, database, and gateway controls from the default adapter until separately reviewed. ACP should run with a trusted cwd and bounded environment. Credential paths and provider keys remain Kilo-owned.

## Security boundary

- No credential values, token caches, MFA input, hardware-key interaction, or secure terminal input enters the renderer, transcript, ledger, diagnostics, or child context.
- Never shell-interpolate prompts, paths, model ids, or provider arguments.
- Child agents inherit no secrets and cannot widen the parent permission/network/worktree boundary.
- Provider MCP servers, hooks, plugins, skills, subagents, remote/daemon modes, and auto-approval flags are separate capabilities, not defaults.
- Hidden reasoning is not stored; only provider-labeled observable summaries are eligible for projection.

## Known gaps and drift risks

Kilo inherits portions of OpenCode configuration and its ACP extensions may evolve quickly. Usage is available via `kilo stats` but must be treated as provider-reported/estimated per field. Windows and older CPU variants need launch fixtures.

Treat undocumented behavior as unresolved, not as a feature. Re-probe on executable update and invalidate capability/session caches when version, vendor auth context, or transport changes.

## Required conformance fixtures

ACP handshake; /connect auth; model/mode options; allow/ask/deny; session export/import; stats provenance; MCP startup; upgrade notice; remote disabled; process exit; Windows executable discovery.

## Evidence classification

- **Documented:** directly stated in the linked vendor/protocol material.
- **Observed:** confirmed by a safe local command or replay fixture against a specific installed version.
- **Inferred:** adapter design consequence; it needs a fixture before certification.
- **Unavailable:** the provider does not expose the field or the source is not stable enough to claim it.

## Integrator verdict

This route is Preview until executable/version detection, auth-state handling, protocol or PTY lifecycle, permission behavior, restart/reconnect, cancellation race, redaction, and Windows/macOS process behavior have passing fixtures. Provider parity is never implied by the vendor name.
