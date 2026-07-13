# GitHub Copilot CLI — Integrator dossier

**Research status:** official-first synthesis, captured 2026-07-13.
**Manifest transport:** `acp`.
**Executable/entrypoint:** `copilot --acp`.

## What the CLI is

GitHub documents ACP, programmatic/print operation, interactive slash commands, supported models, permissions, MCP, plugins, skills, custom agents, hooks, repository instructions, session data, security, monitoring, and enterprise configuration.

## Command and lifecycle surface

Interactive: copilot. Key commands include login, logout, help, init, mcp, plugin, and completion. Machine route: copilot --acp. Important flags include --allow-all-tools, --allow-tool, --allow-all-paths, --allow-all-urls, --model, --output-format, --no-ask-user, and repository attachment options.

## Authentication, updates, and ownership

Use copilot login's OAuth device flow or documented token environment variables. Integrator reports sanitized auth status and never copies GitHub tokens into its own store. Host selection, enterprise policy, and scopes remain GitHub-owned.

Updates remain vendor-owned. Integrator may run a documented version probe, show the observed version and compatibility result, and open the official setup/update flow. It must not silently install, replace, or downgrade a vendor runtime.

## Adapter methodology

1. Discover `copilot` from approved executable candidates and record provenance/version.
2. Run a non-secret compatibility/auth probe before showing the route as usable.
3. Spawn with an argv array, exact trusted repository/worktree cwd, allow-listed environment, piped stdin/stdout/stderr, kill-on-drop/process-tree cleanup, bounded output, and no renderer shell authority.
4. Complete the provider handshake or establish the documented structured/PTY route.
5. Persist only normalized task/run/session identity and references; raw provider events remain native-side and redacted.
6. Map messages, plans, files, tools, approvals, usage, and exit state only when the provider actually exposes them.
7. On cancel, timeout, crash, or reconnect, reconcile authoritative provider state before retrying. Unknown side effects are checkpointed and blocked, never blindly replayed.

Default permission prompts must remain visible through typed Integrator approvals. Do not map --allow-all-tools or --allow-all-paths to the normal profile. GitHub hosts and policies can change the effective model/tool surface, so capability discovery is per connection.

## Security boundary

- No credential values, token caches, MFA input, hardware-key interaction, or secure terminal input enters the renderer, transcript, ledger, diagnostics, or child context.
- Never shell-interpolate prompts, paths, model ids, or provider arguments.
- Child agents inherit no secrets and cannot widen the parent permission/network/worktree boundary.
- Provider MCP servers, hooks, plugins, skills, subagents, remote/daemon modes, and auto-approval flags are separate capabilities, not defaults.
- Hidden reasoning is not stored; only provider-labeled observable summaries are eligible for projection.

## Known gaps and drift risks

ACP extension coverage, session persistence, usage provenance, and Windows behavior require live conformance. GitHub token types and organization policies must be represented only as sanitized capability/auth facts.

Treat undocumented behavior as unresolved, not as a feature. Re-probe on executable update and invalidate capability/session caches when version, vendor auth context, or transport changes.

## Required conformance fixtures

ACP handshake; login-required; allow/deny tool; path/URL allowlist; MCP server startup; hooks; custom agent; session resume; output format; enterprise host; cancellation and process exit.

## Evidence classification

- **Documented:** directly stated in the linked vendor/protocol material.
- **Observed:** confirmed by a safe local command or replay fixture against a specific installed version.
- **Inferred:** adapter design consequence; it needs a fixture before certification.
- **Unavailable:** the provider does not expose the field or the source is not stable enough to claim it.

## Integrator verdict

This route is Preview until executable/version detection, auth-state handling, protocol or PTY lifecycle, permission behavior, restart/reconnect, cancellation race, redaction, and Windows/macOS process behavior have passing fixtures. Provider parity is never implied by the vendor name.
