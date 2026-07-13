# Claude Code — Integrator dossier

**Research status:** official-first synthesis, captured 2026-07-13.
**Manifest transport:** `structured_process`.
**Executable/entrypoint:** `claude --print PROMPT --output-format stream-json --verbose`.

## What the CLI is

The CLI documents interactive REPL, print/headless execution, sessions, model selection, permission modes, MCP, hooks, skills, subagents, project/user settings, memory/context files, and JSON/stream-JSON output. Its stream is provider-structured but not ACP; event schema and permission control are version-sensitive.

## Command and lifecycle surface

Interactive: claude. One-shot: claude -p PROMPT or stdin pipe. Continuation: -c/--continue. Resume: -r/--resume SESSION_ID. Core flags include --model, --permission-mode, --max-turns, --output-format json|stream-json, --verbose, --system-prompt, --add-dir, and --dangerously-skip-permissions. Update: claude update.

## Authentication, updates, and ownership

Claude Code owns login, subscription/API authentication, and credential storage. The Integrator route is explicitly user-configured and does not expose a login UI or inspect ~/.claude credential files. Run only documented non-secret version/status probes and let the user perform setup in a vendor-owned terminal.

Updates remain vendor-owned. Integrator may run a documented version probe, show the observed version and compatibility result, and open the official setup/update flow. It must not silently install, replace, or downgrade a vendor runtime.

## Adapter methodology

1. Discover `claude` from approved executable candidates and record provenance/version.
2. Run a non-secret compatibility/auth probe before showing the route as usable.
3. Spawn with an argv array, exact trusted repository/worktree cwd, allow-listed environment, piped stdin/stdout/stderr, kill-on-drop/process-tree cleanup, bounded output, and no renderer shell authority.
4. Complete the provider handshake or establish the documented structured/PTY route.
5. Persist only normalized task/run/session identity and references; raw provider events remain native-side and redacted.
6. Map messages, plans, files, tools, approvals, usage, and exit state only when the provider actually exposes them.
7. On cancel, timeout, crash, or reconnect, reconcile authoritative provider state before retrying. Unknown side effects are checkpointed and blocked, never blindly replayed.

Spawn argv directly, never shell-join the prompt, and keep --dangerously-skip-permissions unavailable to the normal Integrator profile. Parse only documented stream events, redact paths and secure input, and never mistake token/cost fields for subscription allowance depletion.

## Security boundary

- No credential values, token caches, MFA input, hardware-key interaction, or secure terminal input enters the renderer, transcript, ledger, diagnostics, or child context.
- Never shell-interpolate prompts, paths, model ids, or provider arguments.
- Child agents inherit no secrets and cannot widen the parent permission/network/worktree boundary.
- Provider MCP servers, hooks, plugins, skills, subagents, remote/daemon modes, and auto-approval flags are separate capabilities, not defaults.
- Hidden reasoning is not stored; only provider-labeled observable summaries are eligible for projection.

## Known gaps and drift risks

No native bidirectional ACP/app-server adapter in this manifest. Plan-review and permission events require a fixture against the installed stream schema. Hooks, MCP server processes, subagents, and provider network access remain vendor-controlled capabilities.

Treat undocumented behavior as unresolved, not as a feature. Re-probe on executable update and invalidate capability/session caches when version, vendor auth context, or transport changes.

## Required conformance fixtures

print text/json/stream-json; stdin prompt; continue/resume; plan permission mode; command/file approval; MCP/hook event; cancellation; nonzero exit; malformed event; session-expired auth; model/effort drift; Windows argv and stderr behavior.

## Evidence classification

- **Documented:** directly stated in the linked vendor/protocol material.
- **Observed:** confirmed by a safe local command or replay fixture against a specific installed version.
- **Inferred:** adapter design consequence; it needs a fixture before certification.
- **Unavailable:** the provider does not expose the field or the source is not stable enough to claim it.

## Integrator verdict

This route is Preview until executable/version detection, auth-state handling, protocol or PTY lifecycle, permission behavior, restart/reconnect, cancellation race, redaction, and Windows/macOS process behavior have passing fixtures. Provider parity is never implied by the vendor name.
