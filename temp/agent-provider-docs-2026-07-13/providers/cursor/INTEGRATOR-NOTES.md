# Cursor Agent — Integrator dossier

**Research status:** official-first synthesis, captured 2026-07-13.
**Manifest transport:** `acp`.
**Executable/entrypoint:** `cursor-agent acp`.

## What the CLI is

Cursor documents interactive and print modes, model selection, sessions, login/logout, ACP, Composer model/config discovery, tool approvals, and structured stream output. Stable ACP configOptions are preferred over non-portable provider extensions.

## Command and lifecycle surface

Interactive: cursor-agent. Print mode: cursor-agent -p PROMPT with --output-format text|json|stream-json. Resume with --resume, list with ls, choose --model, and use --force only under an explicit widened permission profile. ACP: cursor-agent acp; newer builds may expose `agent acp` as the canonical executable.

## Authentication, updates, and ownership

Use cursor-agent login/logout or the documented CURSOR_API_KEY path. Integrator can run the vendor command in a user-owned setup terminal, but never reads Cursor token stores or places API keys in argv/transcripts.

Updates remain vendor-owned. Integrator may run a documented version probe, show the observed version and compatibility result, and open the official setup/update flow. It must not silently install, replace, or downgrade a vendor runtime.

## Adapter methodology

1. Discover `cursor-agent` from approved executable candidates and record provenance/version.
2. Run a non-secret compatibility/auth probe before showing the route as usable.
3. Spawn with an argv array, exact trusted repository/worktree cwd, allow-listed environment, piped stdin/stdout/stderr, kill-on-drop/process-tree cleanup, bounded output, and no renderer shell authority.
4. Complete the provider handshake or establish the documented structured/PTY route.
5. Persist only normalized task/run/session identity and references; raw provider events remain native-side and redacted.
6. Map messages, plans, files, tools, approvals, usage, and exit state only when the provider actually exposes them.
7. On cancel, timeout, crash, or reconnect, reconcile authoritative provider state before retrying. Unknown side effects are checkpointed and blocked, never blindly replayed.

Spawn ACP with exact cwd and separate stderr; keep `--force` out of the default route. Treat `cursor/list_available_models` as an optional extension, never the source of truth. The local supervisor owns stdin and process cleanup.

## Security boundary

- No credential values, token caches, MFA input, hardware-key interaction, or secure terminal input enters the renderer, transcript, ledger, diagnostics, or child context.
- Never shell-interpolate prompts, paths, model ids, or provider arguments.
- Child agents inherit no secrets and cannot widen the parent permission/network/worktree boundary.
- Provider MCP servers, hooks, plugins, skills, subagents, remote/daemon modes, and auto-approval flags are separate capabilities, not defaults.
- Hidden reasoning is not stored; only provider-labeled observable summaries are eligible for projection.

## Known gaps and drift risks

ACP provider extensions and model config option IDs drift. Usage and plan allowance are not exposed by the CLI contract. Native Windows launch requires conformance against the vendor shim.

Treat undocumented behavior as unresolved, not as a feature. Re-probe on executable update and invalidate capability/session caches when version, vendor auth context, or transport changes.

## Required conformance fixtures

ACP initialize/session config options; model and thought-level changes; permission request; plan review extension; print stream; resume; login/logout; process exit; Windows shim quoting; unknown extension.

## Evidence classification

- **Documented:** directly stated in the linked vendor/protocol material.
- **Observed:** confirmed by a safe local command or replay fixture against a specific installed version.
- **Inferred:** adapter design consequence; it needs a fixture before certification.
- **Unavailable:** the provider does not expose the field or the source is not stable enough to claim it.

## Integrator verdict

This route is Preview until executable/version detection, auth-state handling, protocol or PTY lifecycle, permission behavior, restart/reconnect, cancellation race, redaction, and Windows/macOS process behavior have passing fixtures. Provider parity is never implied by the vendor name.
