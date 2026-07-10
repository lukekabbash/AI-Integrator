# AI Integrator

AI Integrator is a local-first, accountless desktop control plane for the coding agents a user already has installed and pays for. It is one Windows/macOS product built from a shared Tauri 2, Rust, React, and TypeScript codebase. It presents Codex, Cursor, and capability-certified ACP agents through one calm task-oriented interface while preserving vendor-owned runtimes, credentials, models, skills, permissions, and session behavior.

This repository contains the normative v1 product contracts and the native application implementation. AI Integrator requires no hosted task backend, credential proxy, cloud sync, or AI Integrator account.

## Product documents

- [Polished v1 scope](docs/v1-scope.md) — the definitive in/out scope, milestones, release matrix, and acceptance gates.
- [Native architecture](docs/architecture.md) — one-codebase Tauri/Rust topology, security boundary, platform traits, packaging, signing, updating, and performance gates.
- [Local-first contract](docs/local-first-contract.md) — identity, storage, network, vendor authentication, privacy, export/import, and no-backend rules.
- [Design-system contract](docs/design-system-contract.md) — full-screen Settings, right-rail Git, theme/font customization, softer visual language, diffs, and usage presentation.

- [Product specification](docs/product-spec.md) — product thesis, scope, information architecture, runtime architecture, workflows, security, usage accounting, phased delivery, and acceptance gates.
- [User stories](docs/user-stories.md) — personas, journeys, epics, stories, acceptance criteria, edge cases, and launch priorities.
- [Research and design system](docs/research-and-design-principles.md) — source-backed product evolution, reference-image analysis, interaction principles, visual primitives, component inventory, motion tokens, and accessibility requirements.
- [Agent workspace UI/UX primitives](docs/ui-ux-primitives.md) — normative, implementation-grade specification for the shell, navigation, new-task/open/clone semantics, composer, transcript, panes, review, terminal, preview, agents, motion, accessibility, recovery, platform behavior, and design QA.
- [QOL microinteraction catalog (200)](docs/qol-100.md) — exact client behavior, Codex/app-server and ACP mapping, degraded fallback, and acceptance check for the two hundred small details that make the workspace trustworthy.
- [Critical systems primitives](docs/critical-systems-primitives.md) — 72 security, context, repository, terminal, quota, update, secret, remote, accessibility, route/delegation, checkpoint, coordination, Git GUI, and setup-auth invariants with executable acceptance checks.
- [Delivery and criticality matrix](docs/delivery-criticality-matrix.md) — separates MVP/Beta/Later delivery from feature-critical correctness and defines the release gate.
- [Repository coordination and worktree protocol](docs/repo-coordination-protocol.md) — standardized durable/project notes, Git-common task ledgers, run scratch, agent messaging, transcript references, task-worktree pairing, Git GUI, and login/task terminal behavior.
- [Broker MCP contract](docs/broker-mcp-contract.md) — exact local agent-facing peer discovery, delegation, status, messaging, scoped transcript, stop, result, resource, idempotency, and authorization surface.
- [Integration catalog](docs/integration-catalog.md) — install, authentication, protocol, session, permission, usage, platform, and legal notes for supported and candidate runtimes.
- [Native parity matrix](docs/native-parity-matrix.md) — primitive-level Codex and Claude Code behavior for commands, files, diffs, transcripts, thinking, subagents, side chats, worktrees, and keyboard control.
- [Integration manifest example](docs/integration-manifest.example.yaml) — implementation-oriented adapter metadata and capability declarations.

## Product priorities

1. Codex as the richest first-party runtime through `codex app-server`.
2. Cursor as a first-class installed runtime through native ACP, with structured CLI events and PTY as fallbacks.
3. Grok Build as a first-class native ACP runtime.
4. A generic ACP adapter and agent catalog.
5. User-enabled local delegation skills, including an optional Claude CLI skill, without representing those commands as a bundled provider partnership or handling their credentials.

## Core product sentence

> One task surface for every coding agent you already use, with portable skills, controlled delegation, shared permissions, and honest usage visibility.
