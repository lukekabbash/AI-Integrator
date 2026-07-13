# Goose — Integrator dossier

**Research status:** official-first synthesis, captured 2026-07-13.
**Manifest transport:** `acp`.
**Executable/entrypoint:** `goose acp`.

## What the CLI is

Goose documents a Rust local agent, desktop/CLI/API surfaces, MCP extensions, recipes, skills, subagents, ACP server behavior, multiple model providers, permissions, prompt-injection detection, and sandboxing.

## Command and lifecycle surface

Install via official installer/releases. CLI/TUI is `goose`; ACP is documented as a server route. Core surfaces include session, recipe, extension/MCP, provider/model selection, configure, and run modes; exact subcommands are version-specific and must be probed with `goose --help`.

## Authentication, updates, and ownership

Goose owns provider and extension configuration, including API keys or subscription-backed ACP providers. Integrator should use the documented CLI setup and sanitized config/status surfaces, never read secrets or rewrite provider config.

Updates remain vendor-owned. Integrator may run a documented version probe, show the observed version and compatibility result, and open the official setup/update flow. It must not silently install, replace, or downgrade a vendor runtime.

## Adapter methodology

1. Discover `goose` from approved executable candidates and record provenance/version.
2. Run a non-secret compatibility/auth probe before showing the route as usable.
3. Spawn with an argv array, exact trusted repository/worktree cwd, allow-listed environment, piped stdin/stdout/stderr, kill-on-drop/process-tree cleanup, bounded output, and no renderer shell authority.
4. Complete the provider handshake or establish the documented structured/PTY route.
5. Persist only normalized task/run/session identity and references; raw provider events remain native-side and redacted.
6. Map messages, plans, files, tools, approvals, usage, and exit state only when the provider actually exposes them.
7. On cancel, timeout, crash, or reconnect, reconcile authoritative provider state before retrying. Unknown side effects are checkpointed and blocked, never blindly replayed.

Goose's extension ecosystem is powerful and must be treated as a separate authority graph. Do not import all MCP extensions or recipes into an Integrator task automatically. Use explicit cwd, bounded environment, and per-tool approval policy.

## Security boundary

- No credential values, token caches, MFA input, hardware-key interaction, or secure terminal input enters the renderer, transcript, ledger, diagnostics, or child context.
- Never shell-interpolate prompts, paths, model ids, or provider arguments.
- Child agents inherit no secrets and cannot widen the parent permission/network/worktree boundary.
- Provider MCP servers, hooks, plugins, skills, subagents, remote/daemon modes, and auto-approval flags are separate capabilities, not defaults.
- Hidden reasoning is not stored; only provider-labeled observable summaries are eligible for projection.

## Known gaps and drift risks

The public docs are broad but CLI command and ACP details are distributed across the docs and repository. Need a pinned installed version, exact ACP launch args, event/permission fixtures, and Windows/macOS parity evidence.

Treat undocumented behavior as unresolved, not as a feature. Re-probe on executable update and invalidate capability/session caches when version, vendor auth context, or transport changes.

## Required conformance fixtures

ACP initialize; extension discovery; permission allow/deny; recipe load; subagent boundary; provider auth; session resume; MCP failure; prompt-injection warning; process exit; Windows launch.

## Evidence classification

- **Documented:** directly stated in the linked vendor/protocol material.
- **Observed:** confirmed by a safe local command or replay fixture against a specific installed version.
- **Inferred:** adapter design consequence; it needs a fixture before certification.
- **Unavailable:** the provider does not expose the field or the source is not stable enough to claim it.

## Integrator verdict

This route is Preview until executable/version detection, auth-state handling, protocol or PTY lifecycle, permission behavior, restart/reconnect, cancellation race, redaction, and Windows/macOS process behavior have passing fixtures. Provider parity is never implied by the vendor name.
