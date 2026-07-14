# AI Integrator v1 scope

**Release description:** a shareable, dependable, local-first desktop application that lets one person supervise and coordinate installed coding agents through one task-oriented interface.  
**Platforms:** Windows and macOS, same version and product.  
**Identity:** local OS-user installation; no AI Integrator account.

## 1. Product contract

> Open a repository, choose the installed agent/model/effort you already pay for, delegate bounded work when useful, observe and control it, review the resulting code, and safely commit or push—all without moving credentials or project history into an AI Integrator cloud.

The v1 must be a deliberately narrow, complete product rather than rough scaffolding. “MVP” describes delivery scope, not an excuse to leave the core loop untrustworthy.

## 2. Definitive v1 scope

### 2.1 Application shell and navigation

- Signed native Windows and macOS installers from one codebase and release train.
- Project/task navigation, search, task naming/pinning/archive, and empty-state project selection.
- Open an existing folder/repository, clone into a user-selected location, or create a standalone local task.
- Durable drafts and crash-safe task/session restoration.
- Full-screen Settings route. Its category navigation replaces project/task navigation and Back restores the exact previous task/view.
- Keyboard navigation, command entry, screen-reader semantics, non-US keymaps, IME/CJK, reduced motion, high contrast, reflow, and scaling certification.

### 2.2 Runtime connections

Certified launch routes:

1. Codex through official app-server.
2. Cursor through ACP, with documented structured-stream fallback when negotiated ACP capabilities are missing.

Each certified route must support detection/version, sanitized auth status, official setup flow, session start/resume, streamed events, cancellation, permissions, model/config discovery, error recovery, and conformance fixtures.

Additional ACP agents may be detected and shown as Preview only when capability negotiation is truthful. Grok, Claude, Gemini, and generic ACP breadth do not gate v1. A provider name never implies parity.

### 2.3 Tasks and execution

- One durable provider-neutral task can contain multiple provider-native runs.
- Runtime, connection, model, effort, permission profile, worktree, and usage provenance remain explicit.
- The composer keeps runtime/model/effort in the lower right and permission/delegation profile in the lower left.
- Stream text, plans, typed tools, files, approvals, terminal/process state, artifacts, evidence, and observable provider-supplied status/reasoning summaries.
- Hidden chain-of-thought, secure terminal input, credentials, and disallowed files are never exposed as transcript content.
- Stop, steer/queue where supported, retry from safe boundary, resume, and crash reconciliation.

### 2.4 One-level orchestration

- One lead can delegate to at most one concurrent writing child in the default v1 profile; the architecture and UI support a configurable maximum up to four after certification.
- Parent assigns a bounded contract, context references, permission ceiling, budget, worktree strategy, and return schema.
- Broker tools: peer listing, child start/status/message/scoped-transcript-read/stop/result.
- Shared state uses the Git-common coordination ledger. Run scratch remains run-owned and ignored.
- Parent/child messages, status, decisions, evidence, and transcript ranges are referenced rather than copied.
- Child completion opens review; it never silently stages, commits, pushes, merges, deploys, or deletes its worktree.

### 2.5 Files, terminals, review, and Git

- File/context opening and citations with exact repository/worktree identity.
- Integrated real PTY terminal with resize, scrollback, process ownership, user/agent stdin transfer, secure input, PowerShell/WSL and macOS shell behavior.
- Task Setup terminal is user-owned and not model-visible by default.
- Syntax-aware unified/split diffs with neutral context, restrained green additions, restrained red deletions, stronger changed spans, line numbers, comments, and virtualized large-file handling.
- Git is a tab in the contextual right rail, not the primary product identity.
- Git tab includes worktree/branch, staged/unstaged/untracked groups, commit draft, checks, compact history, fetch/sync status, and Review changes.
- Stage/unstage/discard at file and hunk scope; editable commit; publish branch; push preview; push; optional PR handoff.
- Commit and Push are always distinct. Destructive/remote outcomes require explicit scope and reconciliation after timeouts.

### 2.6 Usage and budgets

Every displayed value is an independent measurement:

| Measure | Example | Required provenance |
|---|---|---|
| Provider-period allowance | `38% used · resets in 2h 14m` | vendor exact or unavailable |
| Tokens | `184k input · 31k output · 96k cached` | vendor exact, locally observed, or unavailable |
| API-equivalent value | `≈ $1.84` | estimated with pricing/version basis |
| Actual incremental spend | `$0.00 · subscription-backed` | provider exact/locally known or unavailable |

- Never infer subscription percentage without a documented denominator/window.
- Never label API-equivalent value as actual spend.
- Budget rules may limit percentage, tokens, estimated value, actual spend, duration, children, or concurrency separately.
- Composer indicator can compact available dimensions, but its popover exposes provenance, freshness, window/reset, and unknown fields.

### 2.7 Appearance and customization

- Default Graphite theme: neutral/charcoal with sparse steel-blue active states; no purple product accent.
- Twelve coordinated preset families: Graphite, Ash, Midnight, Slate, Ocean, Forest, Sand, Ember, Rosewood, Arctic, Paper, High Contrast.
- All colors use semantic tokens, including surfaces, text, borders, focus, status, diff, terminal ANSI mapping, and syntax roles.
- User-selectable interface and code fonts, sizes, weights, line heights, ligatures, density, panel spacing, corner radius, motion, and accent.
- Presets must satisfy contrast/accessibility tests; custom tokens warn on failure and offer reset.
- Softer 8–12 px component radii and gentle elevation are used only where layers/actions need grouping. Transcript content remains an open reading surface, not card soup.

### 2.8 Local data and portability

- Local SQLite metadata/index plus repository-associated Git-common coordination ledger.
- Clear data-location screen, storage totals, retention, delete, and redacted diagnostic export.
- Settings export/import, task package export, schema migrations, backup guidance, and uninstall keep/delete choice are v1.
- No Integrator cloud sync or recipient/presence model.

## 3. Explicitly out of v1

- AI Integrator accounts, billing, hosted database, cloud task service, credential proxy, cloud transcript sync, share links, or mandatory telemetry.
- Team workspaces, RBAC/SSO, centralized policy/audit, pooled budgets, live collaboration, mobile remote control, or cross-device control leases.
- Hosted runners, cloud secret vault, push-notification backend, and always-on remote schedules.
- Full IDE/editor replacement, autocomplete, language server ownership, debugger, or Cursor Tab competitor.
- Browser/preview automation, design mode, best-of-N, recursive delegation, learned/automatic routing, marketplace commerce, and production deployment actions.
- SSH/remote workspaces for the v1 gate.
- Automatic runtime installation/updating. v1 detects and guides official setup; vendors own their runtime/update/auth flows.
- Linux packaging until the platform abstraction and release process are stable.

## 4. Milestones

### M0 — foundation proof (internal, not a product release)

- Repository/CI/schema skeleton.
- Tauri/Rust/React boundary.
- Codex + Cursor process/auth/session spike.
- PTY, Git worktree/diff, replay, recovery, packaging, accessibility, and updater proof.
- Threat model and vendor-wrapping review.

Exit: every hard technical risk has executable evidence. M0 quality may be rough because it is discarded or hardened before product work.

### M1 — complete core loop

```text
install
→ open/clone repository
→ detect or set up Codex/Cursor
→ create durable task
→ choose runtime/model/effort/permissions
→ run and approve tools
→ delegate one bounded child into a paired worktree
→ communicate/read scoped transcript
→ restart and recover
→ review syntax-aware diff
→ stage and commit
→ preview and push
→ export task/diagnostics
```

Exit: the full loop passes through replay fixtures and live disposable repositories on both platforms.

### M2 — product polish and release candidate

- Final navigation, full-screen Settings, right-rail Git, themes/fonts, empty/loading/error/recovery states.
- Performance, accessibility, IME, localization expansion, high contrast, screen-reader, reduced-motion, and keyboard certification.
- Clean-machine install/update/rollback and uninstall/data-retention tests.
- Security/adversarial fixtures, redaction validation, uncertain-outcome reconciliation, and dependency/license review.
- User documentation and connection troubleshooting.

Exit: release-candidate gate passes on Windows x64, macOS arm64, and macOS Intel unless Intel is explicitly waived before implementation.

### M3 — releasable v1

- Signed/notarized immutable artifacts.
- Static stable update channel and retained rollback artifact.
- Published privacy/local-data statement, supported-runtime/version matrix, known limitations, and issue-report template.
- No release-blocking critical defects and all v1-applicable P0/C0/C1 gates green.

## 5. Release acceptance gates

### Product

- A new user completes the M1 loop without creating an AI Integrator account.
- Runtime/provider differences are visible and unsupported actions are absent, not fake-disabled.
- Settings/navigation/theme choices persist and restore without disturbing task state.
- Git identity and selected worktree are unambiguous in every writing/review action.

### Reliability

- App, renderer, adapter, terminal, and machine restart fixtures reconcile without duplicate turns, duplicate commands, lost worktree leases, or false completion.
- Cancellation races, stream gaps, output truncation, stale diffs, auth expiry, quota exhaustion, and push-timeout uncertainty have tested states.
- Large transcript/diff/terminal fixtures remain interactive within frozen budgets.

### Security and privacy

- Renderer authority is allowlisted; no arbitrary command bridge exists.
- Credential/no-echo input never reaches transcripts, logs, agents, exports, or crash payloads.
- Signed update/rollback, executable provenance, project trust, symlink/junction/path escape, environment inheritance, Git protection, and MCP replay tests pass.
- All application data is locally discoverable, exportable, deletable, and covered by uninstall choice.

### Cross-platform

- Critical flows have semantic parity on Windows and macOS.
- PTY, filesystem/path identity, keychain, signing, notifications, shortcuts, IME, screen reader, window restoration, and updater behavior pass platform-specific fixtures.
- A platform-specific limitation is labeled and capability-gated; it does not create a second product taxonomy.

## 6. Decisions still required before release certification

1. Minimum supported Windows and macOS versions.
2. Windows ARM64 day-one versus fast-follow.
3. Certificate, Apple Developer, notarization, and updater-key custody.
4. Product license and whether v1 is free/open beta; paid licensing would introduce commerce/account infrastructure and is outside this accountless contract.
5. Exact Cursor ACP version floor and Claude/Grok Preview certification targets.
6. Local crash reporting policy: default off plus user-export is recommended; any automatic third-party reporting requires explicit opt-in and a privacy update.
