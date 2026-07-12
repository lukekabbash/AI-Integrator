# AI Integrator v1 implementation plan

**Branch:** `feature/v1-native-app`
**Target:** polished shareable v1; no disposable public v0
**Execution:** parallel UI/design and native/runtime tracks with root integration and evidence gates

## Workstreams

| Track | Scope | Primary evidence |
|---|---|---|
| Terra — experience | Shared React UI, semantic themes, assets, setup, workspace, transcript, Git rail/diff, Settings, motion, accessibility | browser screenshots, UI tests, keyboard/a11y fixtures, visual-state matrix |
| Sol — native runtime | Rust domain, SQLite, providers, Codex/ACP, PTY/processes, Git/worktrees, Tauri commands/capabilities | Rust tests, protocol replay, process/PTY fixtures, native command integration |
| Root — integration/release | Canonical contracts, schemas, security boundary, CI, packaging, cross-track integration, audits | full checks, clean Git state, signed-development package smoke, completion matrix |

Subagent work is never accepted by status alone. Root reviews diffs, runs the relevant checks, exercises the integrated application, and repairs gaps before a milestone commit.

## Milestones

### 0. Repository and contracts

- [x] Initialize canonical Git repository and preserve the separate dirty `integrator-2` checkout.
- [x] Commit the normative v1 product, architecture, local-first, coordination, Broker, and design contracts.
- [x] Create the implementation branch.
- [x] Pin the installed Codex app-server schema and TypeScript protocol snapshot.
- [x] Remove remaining stale Windows-first, account/backend, purple, and scope contradictions from normative product behavior; the migration map retains the old terms only as search targets.

### 1. Native shell and local data

- [ ] Tauri 2 boots with the shared React UI.
- [x] Renderer capabilities are narrow and typed; no arbitrary shell/filesystem command.
- [ ] SQLite migrations persist settings, projects, tasks, runs, native session ids, usage, and checkpoints.
- [ ] Data paths, export/import, delete, and recovery journals are tested.
- [ ] Windows/macOS platform traits exist for PTY, process trees, paths, secure store, and native integration.

### 2. Runtime setup and Codex

- [x] Detect executable provenance/version and sanitized auth status.
- [ ] Setup screen reuses healthy vendor auth or opens a user-owned official login flow.
- [ ] Codex app-server lifecycle: spawn, initialize, model list, thread list/read/start/resume, turn start, notifications, approvals, steer, stop, cleanup.
- [x] Persist normalized task/native-thread relationship without copying credentials.
- [ ] Version/capability drift degrades visibly and exercises replay fixtures.

### 3. ACP and additional runtimes

- [ ] ACP subprocess initialize/capability/session/prompt/tool/permission/config/cancel contract.
- [ ] Cursor ACP passes the installed Windows standalone-agent smoke matrix (discovery outside stale `PATH`, initialize/session/config, streaming, cancellation, and launcher behavior); cross-platform release certification remains pending.
- [ ] Claude, Grok, Gemini, and generic ACP are Preview until their local conformance fixtures pass.
- [ ] Provider logos appear only as runtime identity with provenance/trademark review.

### 4. Agent-first workspace

- [ ] Project/task sidebar, task search, durable drafts, transcript virtualization, plan/activity/tools, and attention states.
- [ ] Composer context, permission, delegation, runtime/model/effort, usage, stop/send, queue/steer behavior.
- [ ] One-level delegation, child lineage, message/status/result, scoped transcript read, budgets, and worktree lease.
- [ ] Restart recovers the same task/run/worktree and reconciles uncertain operations.

### 5. Files, terminal, review, and Git

- [ ] Integrated PTY with resize, scrollback, input owner, secure/no-echo state, full-screen apps, cancel, and process-tree cleanup.
- [ ] File/context opening and exact repository/worktree identity.
- [ ] Accessible syntax-aware diff with restrained red/green, neutral context, comments, hunk navigation, split/unified, and large-file virtualization.
- [ ] Right-rail Git tab: status groups, commit draft, checks, worktree/branch, history, fetch/sync.
- [ ] Stage/unstage/discard, commit, publish, push preview/push, and timeout reconciliation remain distinct.

### 6. Setup and customization

- [ ] No-signup onboarding and project/runtime readiness flow.
- [x] Full-screen Settings replaces project navigation and restores prior workspace state.
- [x] Twelve complete semantic themes; customizable interface/code fonts, type scale, density, radius, motion, accent, syntax, diff, and terminal tokens.
- [ ] Usage shows provider percentage, tokens, API-equivalent value, actual spend, provenance, freshness, and reset independently.
- [ ] Local settings/theme/task export/import and redacted diagnostics.

### 7. Release certification

- [ ] Unit, UI, Rust, protocol, replay, restart, cancellation-race, adversarial, and large-data fixtures.
- [ ] Windows/macOS keyboard, IME/CJK, screen reader, forced colors/high contrast, reduced motion, scaling, clipboard, and window restoration.
- [ ] Clean-machine installer, update, rollback, uninstall keep/delete, and adapter compatibility tests.
- [ ] Windows signing and macOS Developer ID/Hardened Runtime/notarization wiring; secrets remain release-CI-only.
- [ ] Completion audit maps every `docs/v1-scope.md` requirement to authoritative evidence.

## Local machine constraints currently tracked

- `H:` is exFAT and does not support directory symlinks. Node workspaces are intentionally avoided; frontend dependencies live in `apps/desktop` and Rust remains a Cargo workspace.
- Rust, Node, and WebView2 are installed.
- Visual Studio C++ Build Tools (`cl.exe`/`link.exe`) and the Windows SDK import-library paths needed by `rust-lld` are unavailable in the current session. Frontend and source-level Rust verification can proceed; a local Windows Tauri package cannot be claimed until the native linker gate is satisfied. CI uses supported Windows/macOS runners in parallel.
- Installed today: Codex is authenticated; Cursor's standalone agent is installed, authenticated, and passes the live ACP smoke matrix; Claude is installed but its vendor auth probe reports logged out; Gemini exposes ACP and structured streaming but the current logged-in tier rejects both with `UNSUPPORTED_CLIENT`; Grok is absent. UI/adapters must display these facts rather than imply parity.

## Current integration truth

The polished browser preview is design evidence, not native-runtime evidence. The native bridge now invokes only registered Tauri commands and never converts a native failure into demo success. The browser fallback remains intentionally separate for UI development.

- Implemented foundations: Tauri/Rust/React workspace, narrow command allowlist, SQLite migrations for tasks/settings/provider/runtime sessions and runtime projections, provider discovery/redaction, bounded Codex JSONL supervisor, provider-aware Cursor/Gemini ACP transport, safe Claude/Gemini structured-stream Preview fallback, file-level Git/worktree primitives, full workspace shell, Git rail/diff, setup, full-screen Settings, and twelve semantic themes.
- Daily-use navigation is implemented and tested: one-click project/chat selection, persistent multiple open project/chat tabs, last-chat-per-project restoration, task-scoped transcript/Git/usage/child context, race-safe native hydration, empty New chat drafts that persist only on first Send, search and arrow-key focus, responsive sidebar/inspector behavior, and persistent rename/pin/archive metadata.
- Integrated native subset: bootstrap/export/provider discovery, user-owned project picker, persisted canonical project trust, real task creation and navigation metadata, Codex connect/thread/turn start, persisted typed event projections, approvals/stop controls, repository identity/status/diff, trusted project file listing and bounded read-only preview, file stage/unstage, commit, and push preview. Browser-fallback usage records measured local turns plus clearly labeled token/value estimates; plan percentage remains unavailable until a provider reports it. Every Git/worktree/file command reauthorizes the exact trusted root or a listed paired worktree.
- Explicitly not yet certified: real PTY, Broker/delegation ledger, Claude/Gemini full conformance (both remain Preview), confirmed push, fetch/sync and PR actions, hunk operations, native settings/export UX, signed packaging, and the complete M1 replay fixture.
- CI enforces the renderer/Tauri command-name contract with `npm run check:bridge`; missing native behavior must fail visibly rather than appear successful through fixtures.
- The next Codex persistence, approval, streaming, and restart slice is governed by [codex-event-reducer-contract.md](codex-event-reducer-contract.md).

## Commit policy

Commit at evidence-backed boundaries:

1. contracts/baseline;
2. native shell and domain/storage;
3. workspace/design system;
4. first live Codex loop;
5. Git/terminal/delegation loop;
6. release-candidate fixes and artifacts.

Do not push, publish a release, create a PR, deploy, or alter vendor credentials merely because a local commit is complete.
