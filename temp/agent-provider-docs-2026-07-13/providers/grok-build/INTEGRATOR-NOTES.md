# Grok Build — Integrator dossier

**Research status:** official-first synthesis, captured 2026-07-13.
**Manifest transport:** `acp`.
**Executable/entrypoint:** `grok agent stdio`.

## What the CLI is

Grok Build documents TUI, headless structured output, named/resumable sessions, ACP, models, effort, permissions, plan modes, custom models, MCP/tools, enterprise network configuration, and automatic update checks.

## Command and lifecycle surface

Interactive: grok. Headless: grok -p PROMPT with --model, --session-id, --resume, --continue, --cwd, --output-format plain|json|streaming-json, --always-approve, and --no-alt-screen. ACP: grok agent stdio. Version: grok version; discovery: grok inspect --json and grok models.

## Authentication, updates, and ownership

Use `grok login`, device login, logout, or XAI_API_KEY as documented by xAI. Integrator passes only the advertised ACP auth method (for example cached_token) and never transports the token itself.

Updates remain vendor-owned. Integrator may run a documented version probe, show the observed version and compatibility result, and open the official setup/update flow. It must not silently install, replace, or downgrade a vendor runtime.

## Adapter methodology

1. Discover `grok` from approved executable candidates and record provenance/version.
2. Run a non-secret compatibility/auth probe before showing the route as usable.
3. Spawn with an argv array, exact trusted repository/worktree cwd, allow-listed environment, piped stdin/stdout/stderr, kill-on-drop/process-tree cleanup, bounded output, and no renderer shell authority.
4. Complete the provider handshake or establish the documented structured/PTY route.
5. Persist only normalized task/run/session identity and references; raw provider events remain native-side and redacted.
6. Map messages, plans, files, tools, approvals, usage, and exit state only when the provider actually exposes them.
7. On cancel, timeout, crash, or reconnect, reconcile authoritative provider state before retrying. Unknown side effects are checkpointed and blocked, never blindly replayed.

Prefer ACP for typed session/update/permission events. In automation, pass --no-auto-update to avoid a background updater changing the executable mid-run. Never map --always-approve to default Integrator permissions. Keep xAI auth and account context vendor-owned.

## Security boundary

- No credential values, token caches, MFA input, hardware-key interaction, or secure terminal input enters the renderer, transcript, ledger, diagnostics, or child context.
- Never shell-interpolate prompts, paths, model ids, or provider arguments.
- Child agents inherit no secrets and cannot widen the parent permission/network/worktree boundary.
- Provider MCP servers, hooks, plugins, skills, subagents, remote/daemon modes, and auto-approval flags are separate capabilities, not defaults.
- Hidden reasoning is not stored; only provider-labeled observable summaries are eligible for projection.

## Known gaps and drift risks

Provider settings percentage is not inferable from token counts. ACP extension/event detail, Windows behavior, export/import, and model/effort config option stability require fixtures.

Treat undocumented behavior as unresolved, not as a feature. Re-probe on executable update and invalidate capability/session caches when version, vendor auth context, or transport changes.

## Required conformance fixtures

ACP auth method; session/new and update chunks; plan/permission request; headless streaming-json; resume; auto-update suppression; inspect/models; tool failure; cancellation; session expiry; Windows process tree.

## Evidence classification

- **Documented:** directly stated in the linked vendor/protocol material.
- **Observed:** confirmed by a safe local command or replay fixture against a specific installed version.
- **Inferred:** adapter design consequence; it needs a fixture before certification.
- **Unavailable:** the provider does not expose the field or the source is not stable enough to claim it.

## Integrator verdict

This route is Preview until executable/version detection, auth-state handling, protocol or PTY lifecycle, permission behavior, restart/reconnect, cancellation race, redaction, and Windows/macOS process behavior have passing fixtures. Provider parity is never implied by the vendor name.
