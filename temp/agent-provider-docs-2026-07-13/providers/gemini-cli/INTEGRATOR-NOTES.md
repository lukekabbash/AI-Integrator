# Gemini CLI — Integrator dossier

**Research status:** official-first synthesis, captured 2026-07-13.
**Manifest transport:** `acp`.
**Executable/entrypoint:** `gemini --acp`.

## What the CLI is

Gemini CLI documents a CLI frontend plus local core, built-in filesystem/shell/web tools, MCP, extensions, GEMINI.md context, .geminiignore, trusted folders, sandboxing, checkpoints, token caching, themes, telemetry controls, and session save/resume. ACP mode is a separate machine protocol route.

## Command and lifecycle surface

Interactive: gemini. Headless: gemini -p PROMPT or piped stdin. ACP: gemini --acp. Important surfaces include slash commands, --model, --output-format stream-json, --sandbox, --checkpointing, --include-directories, --yolo, settings, extensions, and MCP configuration.

## Authentication, updates, and ownership

Use Gemini CLI's official OAuth/API-key/application-credential flow. Integrator must not reuse OAuth tokens or inspect ~/.gemini credentials; it may pass only documented auth method choices and sanitized status. The CLI's own settings and trusted-folder rules remain authoritative.

Updates remain vendor-owned. Integrator may run a documented version probe, show the observed version and compatibility result, and open the official setup/update flow. It must not silently install, replace, or downgrade a vendor runtime.

## Adapter methodology

1. Discover `gemini` from approved executable candidates and record provenance/version.
2. Run a non-secret compatibility/auth probe before showing the route as usable.
3. Spawn with an argv array, exact trusted repository/worktree cwd, allow-listed environment, piped stdin/stdout/stderr, kill-on-drop/process-tree cleanup, bounded output, and no renderer shell authority.
4. Complete the provider handshake or establish the documented structured/PTY route.
5. Persist only normalized task/run/session identity and references; raw provider events remain native-side and redacted.
6. Map messages, plans, files, tools, approvals, usage, and exit state only when the provider actually exposes them.
7. On cancel, timeout, crash, or reconnect, reconcile authoritative provider state before retrying. Unknown side effects are checkpointed and blocked, never blindly replayed.

The shell passthrough is equivalent to terminal execution and must not be exposed through the renderer. Respect trusted-folder and sandbox state, pass an exact cwd, and treat --yolo as a user-visible widened permission profile. Keep Google credentials inside the vendor process.

## Security boundary

- No credential values, token caches, MFA input, hardware-key interaction, or secure terminal input enters the renderer, transcript, ledger, diagnostics, or child context.
- Never shell-interpolate prompts, paths, model ids, or provider arguments.
- Child agents inherit no secrets and cannot widen the parent permission/network/worktree boundary.
- Provider MCP servers, hooks, plugins, skills, subagents, remote/daemon modes, and auto-approval flags are separate capabilities, not defaults.
- Hidden reasoning is not stored; only provider-labeled observable summaries are eligible for projection.

## Known gaps and drift risks

ACP capability negotiation and session/update schema need versioned fixtures. Headless stream output is a fallback, not evidence of full typed permission parity. Usage stats and token caching do not prove provider-period allowance.

Treat undocumented behavior as unresolved, not as a feature. Re-probe on executable update and invalidate capability/session caches when version, vendor auth context, or transport changes.

## Required conformance fixtures

ACP initialize/session/prompt; headless stream-json; trusted-folder rejection; sandbox/checkpoint; MCP startup failure; tool approval; cancellation; model list drift; OAuth/API-key auth states; Windows shell separation.

## Evidence classification

- **Documented:** directly stated in the linked vendor/protocol material.
- **Observed:** confirmed by a safe local command or replay fixture against a specific installed version.
- **Inferred:** adapter design consequence; it needs a fixture before certification.
- **Unavailable:** the provider does not expose the field or the source is not stable enough to claim it.

## Integrator verdict

This route is Preview until executable/version detection, auth-state handling, protocol or PTY lifecycle, permission behavior, restart/reconnect, cancellation race, redaction, and Windows/macOS process behavior have passing fixtures. Provider parity is never implied by the vendor name.
