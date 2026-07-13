# Antigravity — Integrator dossier

**Shipped app provider kind:** `antigravity`  
**Executable:** `agy`  
**Transport:** structured local process; one final JSON result object per turn,
not ACP and not a streaming event protocol in the current adapter.  
**Current app source:** `crates/integrator-runtime/src/structured_cli.rs`,
`crates/integrator-runtime/src/providers.rs`, and
`apps/desktop/src-tauri/src/runtime_setup.rs`.

## Current CLI surface

The official CLI is installed as `agy` on macOS/Linux and Windows. It supports
interactive TUI use, `--continue`, `--conversation ID`, `--add-dir`, model
selection, sandbox/permission flags, MCP/plugins/skills/hooks, and subagents.
The app intentionally uses its structured print route rather than driving the
TUI. Antigravity has no certified ACP launch command in the current code.

## Authentication and updates

The CLI uses the OS secure keyring and falls back to Google browser sign-in,
including a URL/code flow for SSH sessions. `/logout` is vendor-owned. The
current native discovery code probes `~/.gemini/oauth_creds.json` only to derive
a sanitized authenticated/logged-out state; the credential contents never cross
the renderer or enter the corpus. Setup and update commands are vendor-owned;
Integrator may offer the official installer and version probe but must not copy
or manage Google tokens.

## Adapter methodology

1. Discover `agy` and run `agy --version` with a bounded, redacted probe.
2. Use the exact trusted repository/worktree as cwd and a reduced environment.
3. Launch the structured child with argv, piped stdout/stderr, bounded lines, and
   process-tree cleanup; stdout is treated as JSONL and stderr as diagnostics.
4. Compose the selected effort into the documented Antigravity model-name form
   (`Low`, `Medium`, or `High`) because the CLI does not expose a separate effort
   flag. Never forward unknown effort values.
5. Pass `--conversation` only for a validated provider session identity.
6. Parse the provider result into normalized text/tool/result/usage projections.
   Do not invent streaming deltas, typed approvals, quota percentage, or ACP
   capabilities that the current route does not expose.
7. Reconcile after cancellation, timeout, process exit, or restart before retry.

## Security boundary

- `--dangerously-skip-permissions` is only reachable through the explicit full-
  access profile; it is never the default.
- MCP, plugins, skills, hooks, and subagents widen the child authority graph and
  need explicit capability/policy treatment.
- Renderer input cannot supply arbitrary executable paths, credential values, or
  filesystem paths. The native host resolves provider-owned action handles.
- Antigravity usage/model fields are not evidence of Google AI plan depletion;
  show unavailable unless the provider reports a documented denominator/window.
- Hidden reasoning and secure terminal input remain outside transcript storage.

## Current gaps

No certified ACP route, no typed bidirectional permission protocol, no programmatic
model list, and no streaming event contract are currently implemented for this
provider. The route is therefore structured/Preview even though the CLI itself
has a richer TUI. Conformance must cover final JSON, error JSON, malformed output,
resume, permission modes, MCP failure, cancellation races, credentials missing,
Windows PowerShell/CMD installation, and model-effort composition.

## Evidence classification

CLI features come from the official Antigravity documentation and repository
sources listed in `SOURCES.md`; the transport and security statements above also
describe the actual Integrator implementation. Re-probe after every `agy` update.
