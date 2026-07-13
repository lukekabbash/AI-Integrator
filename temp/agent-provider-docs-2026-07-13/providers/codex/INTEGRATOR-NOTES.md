# Codex — Integrator dossier

**Research status:** official-first synthesis, captured 2026-07-13.
**Manifest transport:** `codex_app_server`.
**Executable/entrypoint:** `codex app-server --stdio`.

## What the CLI is

The app-server exposes threads, turns, items, models, reasoning-effort choices, skills, terminal/process execution, file changes, plans, approvals, MCP/app/plugin surfaces, account state, rate limits, and token usage when the installed build advertises them. Stable and experimental methods must be negotiated and version-pinned.

## Command and lifecycle surface

CLI discovery: codex --version. Protocol launch: codex app-server --stdio. Schema generation: codex app-server generate-ts --out DIR and generate-json-schema --out DIR; --experimental is a separate compatibility surface. Native lifecycle uses initialize/initialized, thread/start|resume|fork|read|list, turn/start|interrupt, and streamed item notifications.

## Authentication, updates, and ownership

Use app-server account endpoints or the vendor CLI's documented login flow. Integrator passes only auth method identifiers and receives sanitized status; it never reads ~/.codex/auth.json or carries API-key values through the renderer.

Updates remain vendor-owned. Integrator may run a documented version probe, show the observed version and compatibility result, and open the official setup/update flow. It must not silently install, replace, or downgrade a vendor runtime.

## Adapter methodology

1. Discover `codex` from approved executable candidates and record provenance/version.
2. Run a non-secret compatibility/auth probe before showing the route as usable.
3. Spawn with an argv array, exact trusted repository/worktree cwd, allow-listed environment, piped stdin/stdout/stderr, kill-on-drop/process-tree cleanup, bounded output, and no renderer shell authority.
4. Complete the provider handshake or establish the documented structured/PTY route.
5. Persist only normalized task/run/session identity and references; raw provider events remain native-side and redacted.
6. Map messages, plans, files, tools, approvals, usage, and exit state only when the provider actually exposes them.
7. On cancel, timeout, crash, or reconnect, reconcile authoritative provider state before retrying. Unknown side effects are checkpointed and blocked, never blindly replayed.

The app-server is bidirectional JSON-RPC over local JSONL. Preserve string-versus-number request IDs, cap message size, drain stderr separately, keep cwd explicit, and treat server requests as approval-bearing side effects. Do not use experimental websocket listeners for v1; local IPC is the intended boundary.

## Security boundary

- No credential values, token caches, MFA input, hardware-key interaction, or secure terminal input enters the renderer, transcript, ledger, diagnostics, or child context.
- Never shell-interpolate prompts, paths, model ids, or provider arguments.
- Child agents inherit no secrets and cannot widen the parent permission/network/worktree boundary.
- Provider MCP servers, hooks, plugins, skills, subagents, remote/daemon modes, and auto-approval flags are separate capabilities, not defaults.
- Hidden reasoning is not stored; only provider-labeled observable summaries are eligible for projection.

## Known gaps and drift risks

Generated schemas must be captured per installed version. Provider quota is first-class only when the app-server reports it. Remote-control, experimental APIs, raw reasoning, and unsandboxed process modes remain capability-gated or excluded.

Treat undocumented behavior as unresolved, not as a feature. Re-probe on executable update and invalidate capability/session caches when version, vendor auth context, or transport changes.

## Required conformance fixtures

initialize ordering; thread resume/fork; model/list and effort; item deltas; command/file approvals; interrupt race; rate-limit reset; malformed or oversized JSON; provider exit and thread/read reconciliation; stable-versus-experimental schema drift.

## Evidence classification

- **Documented:** directly stated in the linked vendor/protocol material.
- **Observed:** confirmed by a safe local command or replay fixture against a specific installed version.
- **Inferred:** adapter design consequence; it needs a fixture before certification.
- **Unavailable:** the provider does not expose the field or the source is not stable enough to claim it.

## Integrator verdict

This route is Preview until executable/version detection, auth-state handling, protocol or PTY lifecycle, permission behavior, restart/reconnect, cancellation race, redaction, and Windows/macOS process behavior have passing fixtures. Provider parity is never implied by the vendor name.
