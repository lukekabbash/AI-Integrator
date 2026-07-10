# AI Integrator — Delivery and Criticality Matrix

**Status:** Normative release-gating policy  
**Audience:** Product, engineering, security, design, QA, and release management  
**Companions:** [Product specification](product-spec.md), [Critical systems primitives](critical-systems-primitives.md), [QOL microinteraction catalog](qol-100.md), [Repository coordination protocol](repo-coordination-protocol.md), [Broker MCP contract](broker-mcp-contract.md)

## 1. Why this matrix exists

The catalogs describe two different truths:

1. A behavior may be mandatory for a feature to be safe and truthful.
2. The feature itself may be MVP, Beta, or Later.

`C0 · Later` is not a contradiction: SSH host-key verification is critical, but SSH may ship later. Likewise, a QOL item marked P0 means “do not ship the applicable behavior incorrectly,” not automatically “build the entire parent feature for MVP.” This matrix is authoritative when catalog priority and delivery scope could be confused.

## 2. Release gate

A release may enable a feature only when:

- every applicable **C0/C1** primitive for that phase passes without waiver;
- every applicable P0 QOL behavior assigned to that phase passes;
- required C2/P1 accessibility, keyboard, performance, and recovery gates pass;
- unsupported native behavior has the documented degraded path and visible fidelity label;
- provider/runtime capability was negotiated or probed, not inferred from brand;
- security review approves any new credential, external-action, plugin/hook, browser, update, remote, or delegation authority.

C2/C3 or P1/P2 waivers require an owner, user impact, workaround, expiry, and linked test. C0/C1 and authorization/data-integrity requirements cannot be waived into a public release.

## 3. QOL catalog delivery assignment

The existing item-level P0/P1 label remains local implementation importance. Delivery phase is assigned here.

| QOL items | Delivery | Applicability / note |
|---|---|---|
| 001–060 | MVP | Task entry, composer, runtime configuration, streaming, tools, files, terminal, review, and Git safety |
| 061–066 | MVP | Plan and one-level child supervision |
| 067 | Beta | Side-question/fork parity |
| 068 | MVP | Independent child stop semantics |
| 069 | Later | Best-of-N candidate comparison |
| 070–080 | MVP | Child evidence, lifecycle, recovery, authentication, and attention |
| 081–088 | MVP | Windows-first keyboard/layout/accessibility; macOS parity gates its Beta package |
| 089 | Beta | Dictation/voice |
| 090–107 | MVP | Platform path behavior, power-user access, usage/diagnostics, bootstrap, trust, and imports needed by launch runtimes |
| 108 | Beta | Runtime installation/update assistance; launch still detects and explains missing runtimes |
| 109–115 | MVP | Health, smoke test, instructions, and portable skills |
| 116–120 | Beta | Full plugin/hook/MCP management UI; launch adapters may still use preconfigured MCP safely |
| 121–129 | MVP | Effective settings, policy, and config safety |
| 130 | Beta | Settings export/import package |
| 131–138 | MVP | Tabs/panes/focus/view-state correctness for the launch shell |
| 139–140 | Beta | Multi-window ownership and background-close breadth |
| 141–150 | Beta | Browser, Computer Use, annotations, downloads, and CDP |
| 151–160 | Later | Scheduled/background/remote work and remote ownership |
| 161–166 | MVP | Source and artifact provenance/version correctness |
| 167–169 | Beta | Large/rich artifact viewer, regeneration comparison, and export package |
| 170–175 | MVP | Reference integrity, unread state, notifications, and attention queue |
| 176–179 | Later | Collaborative presence, device registry, acknowledged handoff ownership, mobile review |
| 180–199 | MVP | Account boundaries, backpressure, storage, recovery, audit, and interaction grammar |
| 200 | MVP | Capability/update-change disclosure for launch runtimes and adapters |

## 4. Critical systems delivery assignment

The `Phase` field on each item in [Critical systems primitives](critical-systems-primitives.md) is authoritative. Summary:

| Domain | MVP | Beta | Later |
|---|---|---|---|
| Composer route/delegation | Route identity, activation boundary, one-level bounded policy, budget/access snapshots, safe fallbacks | Rich saved recipes may expand | Recursive/general marketplace routing |
| Context/compaction/memory | Context manifest/pressure, safe compaction, summary lineage, handoff survival | Cross-runtime persistent memory controls | Team/shared memory governance |
| Git/worktrees | Repository identity, dirty preservation, leases, submodule/LFS readiness, protection, conflicts, orphan recovery | Rich visual integration may expand | Remote/cloud worktree fleets |
| Terminal/process | Input owner, secure prompts, TTY, shell boundaries, elevation, process trees, truthful exits | Additional shells/terminal integrations | Remote terminal breadth |
| Quota/fallback | Source-aware usage, reset/headroom truth, exhaustion recovery, consented fallback, delegated budgets | Adaptive routing | Outcome-learned routing |
| Update supply chain | Provenance, compatibility, safe app/adapter updates, kill switches, PATH drift | Managed vendor-runtime installation/update | Enterprise fleet management |
| Secrets/environments | Opaque references, scoped profiles, child deny-by-default, rotation, `.env` protection, sink redaction, secure requests | Vault integrations | Organization-wide secret governance |
| Remote/SSH/network | Local network/destination policy | — | Host identity, SSH trust/agents, forwarding, remote transitions, split-brain recovery |
| Global input/accessibility | Localization-ready shell, keymaps, IME, screen-reader transcript, high contrast/reflow | Voice/dictation | Additional platform certification |
| Checkpoints/retry | Causal checkpoints/retry, idempotency, scoped rollback, evidence invalidation | Revert-to-turn and replay | Distributed rollback/orchestration |
| Coordination/Git/auth | Git-common ledger, run scratch/projections, brokered mail/transcript ranges, worktree-paired Git GUI, existing-login reuse, secure Setup terminal | Rich Git-host/knowledge-promotion integrations | Shared/team coordination service |

## 5. MVP vertical slice

The first release is gated around one complete loop:

```text
open/clone project
→ create task and durable draft
→ reuse existing CLI login or complete vendor login in a user-owned Setup terminal
→ choose permission + delegation + execution route in the composer
→ start Codex/Cursor/Grok run
→ read standardized task state, pair writers to visible worktrees, and supervise terminals/one child
→ message/read child evidence or scoped transcript without copying histories
→ review files/diff/tests/evidence, then stage/commit/publish/push in the selected worktree
→ recover after restart or limit exhaustion
→ hand off or finish without losing repository/context truth
```

Browser, schedules, SSH/remote control, voice, multi-device collaboration, rich marketplace management, and best-of-N comparison do not enter the MVP gate merely because their eventual safety primitives are C0/P0.

## 6. Tracking fields

Every implementation ticket derived from either catalog must carry:

```text
Primitive id
Delivery phase
Criticality / QOL priority
Applicability gate
Owning component
Runtime(s) / platform(s)
Dependencies
Native capability and fallback
Happy-path fixture
Degraded fixture
Restart/reconnect fixture
Security/adversarial fixture when C0
Status and evidence link
```
