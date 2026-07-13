# Aider — Integrator dossier

**Research status:** official-first synthesis, captured 2026-07-13.
**Manifest transport:** `pty`.
**Executable/entrypoint:** `aider`.

## What the CLI is

Aider documents Git-aware pair programming, repo map, code/architect/ask modes, file/read-only context, shell/test commands, model aliases, reasoning options, web/images, voice, watch-files, scripting, and broad OpenAI-compatible provider support.

## Command and lifecycle surface

Interactive: aider FILES. One-shot: --message/--message-file with --exit. Core controls include --model, --file, --read, --config, --env-file, --yes-always, --reasoning-effort, --show-repo-map, --apply, --verbose, and --shell-completions. In-chat commands include /add, /ask, /code, /architect, /run, /test, /undo, /reset, and /quit.

## Authentication, updates, and ownership

Aider accepts provider API keys through command flags, environment variables, .env, or .aider.conf.yml. Integrator must not inject or persist those secrets; the safe route is a user-owned setup terminal and PTY secure-input transfer outside model context.

Updates remain vendor-owned. Integrator may run a documented version probe, show the observed version and compatibility result, and open the official setup/update flow. It must not silently install, replace, or downgrade a vendor runtime.

## Adapter methodology

1. Discover `aider` from approved executable candidates and record provenance/version.
2. Run a non-secret compatibility/auth probe before showing the route as usable.
3. Spawn with an argv array, exact trusted repository/worktree cwd, allow-listed environment, piped stdin/stdout/stderr, kill-on-drop/process-tree cleanup, bounded output, and no renderer shell authority.
4. Complete the provider handshake or establish the documented structured/PTY route.
5. Persist only normalized task/run/session identity and references; raw provider events remain native-side and redacted.
6. Map messages, plans, files, tools, approvals, usage, and exit state only when the provider actually exposes them.
7. On cancel, timeout, crash, or reconnect, reconcile authoritative provider state before retrying. Unknown side effects are checkpointed and blocked, never blindly replayed.

Aider has no typed bidirectional permission protocol in this route. PTY output is text and tool actions cannot be safely normalized as provider events. Keep --yes-always disabled, own PTY stdin and secure input, and surface the runtime as fallback/Preview.

## Security boundary

- No credential values, token caches, MFA input, hardware-key interaction, or secure terminal input enters the renderer, transcript, ledger, diagnostics, or child context.
- Never shell-interpolate prompts, paths, model ids, or provider arguments.
- Child agents inherit no secrets and cannot widen the parent permission/network/worktree boundary.
- Provider MCP servers, hooks, plugins, skills, subagents, remote/daemon modes, and auto-approval flags are separate capabilities, not defaults.
- Hidden reasoning is not stored; only provider-labeled observable summaries are eligible for projection.

## Known gaps and drift risks

No ACP or stable structured event stream is part of this manifest. Usage is generally estimated or unavailable, and model/provider API keys are inherently user-configured. Windows PTY behavior requires a native spike.

Treat undocumented behavior as unresolved, not as a feature. Re-probe on executable update and invalidate capability/session caches when version, vendor auth context, or transport changes.

## Required conformance fixtures

PTY startup; secure input; /ask versus /code; file/read-only context; shell command prompt; cancellation; process tree; nonzero exit; config/env redaction; Windows console behavior; transcript truncation.

## Evidence classification

- **Documented:** directly stated in the linked vendor/protocol material.
- **Observed:** confirmed by a safe local command or replay fixture against a specific installed version.
- **Inferred:** adapter design consequence; it needs a fixture before certification.
- **Unavailable:** the provider does not expose the field or the source is not stable enough to claim it.

## Integrator verdict

This route is Preview until executable/version detection, auth-state handling, protocol or PTY lifecycle, permission behavior, restart/reconnect, cancellation race, redaction, and Windows/macOS process behavior have passing fixtures. Provider parity is never implied by the vendor name.
