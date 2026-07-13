# OpenCode — Integrator dossier

**Research status:** official-first synthesis, captured 2026-07-13.
**Manifest transport:** `acp`.
**Executable/entrypoint:** `opencode acp --cwd WORKSPACE`.

## What the CLI is

OpenCode documents a terminal UI, ACP server, provider routing, agents, sessions, commands, MCP, permissions, tools, config layers, auth, model catalog, and usage/stats. It is an open ecosystem with fast-moving CLI and extension surfaces.

## Command and lifecycle surface

Interactive: opencode. ACP: opencode acp --cwd WORKSPACE. Command families include auth, agent, config, mcp, models, session, stats, run, serve, and upgrade depending on version. Provider catalog and model configuration are dynamic.

## Authentication, updates, and ownership

OpenCode manages provider credentials via `opencode auth login/list/logout` and documented environment/config inputs. Integrator must not read auth.json or copy provider keys; use only vendor command status and capability probes.

Updates remain vendor-owned. Integrator may run a documented version probe, show the observed version and compatibility result, and open the official setup/update flow. It must not silently install, replace, or downgrade a vendor runtime.

## Adapter methodology

1. Discover `opencode` from approved executable candidates and record provenance/version.
2. Run a non-secret compatibility/auth probe before showing the route as usable.
3. Spawn with an argv array, exact trusted repository/worktree cwd, allow-listed environment, piped stdin/stdout/stderr, kill-on-drop/process-tree cleanup, bounded output, and no renderer shell authority.
4. Complete the provider handshake or establish the documented structured/PTY route.
5. Persist only normalized task/run/session identity and references; raw provider events remain native-side and redacted.
6. Map messages, plans, files, tools, approvals, usage, and exit state only when the provider actually exposes them.
7. On cancel, timeout, crash, or reconnect, reconcile authoritative provider state before retrying. Unknown side effects are checkpointed and blocked, never blindly replayed.

The ACP child must receive only the exact workspace cwd and approved environment. Do not expose OpenCode's server/remote endpoints or arbitrary MCP config editing through the renderer. Treat `stats` as observed vendor data, not subscription allowance.

## Security boundary

- No credential values, token caches, MFA input, hardware-key interaction, or secure terminal input enters the renderer, transcript, ledger, diagnostics, or child context.
- Never shell-interpolate prompts, paths, model ids, or provider arguments.
- Child agents inherit no secrets and cannot widen the parent permission/network/worktree boundary.
- Provider MCP servers, hooks, plugins, skills, subagents, remote/daemon modes, and auto-approval flags are separate capabilities, not defaults.
- Hidden reasoning is not stored; only provider-labeled observable summaries are eligible for projection.

## Known gaps and drift risks

Official documentation is split between opencode.ai and the evolving repository/site. ACP events, session persistence, Windows paths, and provider-specific tool permissions need versioned capture.

Treat undocumented behavior as unresolved, not as a feature. Re-probe on executable update and invalidate capability/session caches when version, vendor auth context, or transport changes.

## Required conformance fixtures

ACP initialize/session/prompt; auth-required; provider/model config; permission request; MCP startup; session resume; stats; server excluded; malformed JSON; cancellation; Windows cwd.

## Evidence classification

- **Documented:** directly stated in the linked vendor/protocol material.
- **Observed:** confirmed by a safe local command or replay fixture against a specific installed version.
- **Inferred:** adapter design consequence; it needs a fixture before certification.
- **Unavailable:** the provider does not expose the field or the source is not stable enough to claim it.

## Integrator verdict

This route is Preview until executable/version detection, auth-state handling, protocol or PTY lifecycle, permission behavior, restart/reconnect, cancellation race, redaction, and Windows/macOS process behavior have passing fixtures. Provider parity is never implied by the vendor name.
