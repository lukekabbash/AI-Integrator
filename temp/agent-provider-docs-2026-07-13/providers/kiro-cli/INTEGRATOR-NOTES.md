# Kiro CLI — Integrator dossier

**Research status:** official-first synthesis, captured 2026-07-13.
**Manifest transport:** `acp`.
**Executable/entrypoint:** `kiro-cli acp`.

## What the CLI is

Kiro documents custom agents, MCP, hooks, steering, autocomplete, headless CI, sessions/resume, model listing, effort levels, trust-tools, plan mode, code intelligence, specs, and capability-based permissions in newer CLI versions.

## Command and lifecycle surface

Install via the official macOS/Windows script or package. Interactive: kiro-cli or kiro-cli chat. Headless: kiro-cli chat --no-interactive PROMPT. ACP: kiro-cli acp. Commands include agent, chat, settings, login, logout, whoami, doctor, issue, uninstall, and version; --help-all exposes the installed tree.

## Authentication, updates, and ownership

Kiro uses browser authentication and documented API-key headless flows. Integrator may open the official setup flow and report sanitized `whoami`/version state, but must not read Kiro token stores or add keys to its own environment.

Updates remain vendor-owned. Integrator may run a documented version probe, show the observed version and compatibility result, and open the official setup/update flow. It must not silently install, replace, or downgrade a vendor runtime.

## Adapter methodology

1. Discover `kiro-cli` from approved executable candidates and record provenance/version.
2. Run a non-secret compatibility/auth probe before showing the route as usable.
3. Spawn with an argv array, exact trusted repository/worktree cwd, allow-listed environment, piped stdin/stdout/stderr, kill-on-drop/process-tree cleanup, bounded output, and no renderer shell authority.
4. Complete the provider handshake or establish the documented structured/PTY route.
5. Persist only normalized task/run/session identity and references; raw provider events remain native-side and redacted.
6. Map messages, plans, files, tools, approvals, usage, and exit state only when the provider actually exposes them.
7. On cancel, timeout, crash, or reconnect, reconcile authoritative provider state before retrying. Unknown side effects are checkpointed and blocked, never blindly replayed.

Do not map --trust-all-tools to the default Integrator profile. Separate Kiro's API-key headless flow from browser auth, preserve exact cwd, and keep hooks/agents/MCP config vendor-owned. Auto-update should be observed and reported, not silently controlled by Integrator.

## Security boundary

- No credential values, token caches, MFA input, hardware-key interaction, or secure terminal input enters the renderer, transcript, ledger, diagnostics, or child context.
- Never shell-interpolate prompts, paths, model ids, or provider arguments.
- Child agents inherit no secrets and cannot widen the parent permission/network/worktree boundary.
- Provider MCP servers, hooks, plugins, skills, subagents, remote/daemon modes, and auto-approval flags are separate capabilities, not defaults.
- Hidden reasoning is not stored; only provider-labeled observable summaries are eligible for projection.

## Known gaps and drift risks

Kiro CLI 3.0 is a moving/early-access surface. ACP command and permission schemas need versioned fixtures; Windows install/update and log paths need native tests. Feature availability differs by CLI version.

Treat undocumented behavior as unresolved, not as a feature. Re-probe on executable update and invalidate capability/session caches when version, vendor auth context, or transport changes.

## Required conformance fixtures

ACP initialization; chat headless; model list JSON; session resume; trust-tools allow/deny; agent config validation; MCP startup; hooks; auto-update; doctor error; Windows PowerShell launch.

## Evidence classification

- **Documented:** directly stated in the linked vendor/protocol material.
- **Observed:** confirmed by a safe local command or replay fixture against a specific installed version.
- **Inferred:** adapter design consequence; it needs a fixture before certification.
- **Unavailable:** the provider does not expose the field or the source is not stable enough to claim it.

## Integrator verdict

This route is Preview until executable/version detection, auth-state handling, protocol or PTY lifecycle, permission behavior, restart/reconnect, cancellation race, redaction, and Windows/macOS process behavior have passing fixtures. Provider parity is never implied by the vendor name.
