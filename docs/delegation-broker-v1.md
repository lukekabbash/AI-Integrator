# Delegation broker — cross-provider specialists

Status: Implemented

## Outcome

AI Integrator exposes saved **Specialists** to an orchestrating runtime. A
specialist is a durable routing and capability policy, not a second account or
an unrestricted clone of the parent:

```text
Settings profile
→ orchestrator selects profile ID + service level + access request
→ host validates and freezes the effective specialist snapshot
→ one supported child runtime launches asynchronously
→ parent and child coordinate through the task-scoped local broker
→ transcript, messages, route, and result remain recoverable in SQLite
```

The renderer never launches a provider executable or constructs an MCP
configuration. It edits typed settings; the native host resolves and enforces
the launch.

## Specialist profile

`settings.delegation.profiles` stores a bounded array of profiles:

```text
id
label
enabled
bestFor                 orchestrator-facing routing note
workingGuidance         child-only standing instructions
access                  read-only | project-write ceiling
serviceLevels[]         Budget | Standard | Premium
  enabled
  primary               runtime + optional model + effort
  fallbacksEnabled
  fallbacks[]            ordered, maximum four
skillIds[]               exact installed Skill/Plugin-skill identities
mcpServerIds[]           exact enabled MCP server identities
```

Profiles are normalized and bounded by the host (64 profiles, 128 identities
per capability family, four fallbacks per service level). Legacy runtime,
model, effort, and instruction fields migrate into the Standard service level
and Working guidance.

`peers_list` reveals only enabled profiles, Best for, enabled service levels,
access ceilings, and capability counts. Working guidance is deliberately
child-only. `delegate_start` accepts a profile ID rather than arbitrary runtime
or capability configuration.

## Service levels and fallbacks

Budget, Standard, and Premium describe the cost/quality tier the orchestrator
should choose. Each enabled tier owns an independent primary route and ordered
fallback list.

- An explicit requested tier must exist and be enabled; it never silently
  downgrades.
- With no explicit tier, Balanced prefers Standard and Budget-first prefers
  Budget, then chooses from the remaining enabled tiers deterministically.
- Fallbacks are attempted only when an earlier route is unavailable before a
  child launches. They are not load balancing and do not replace a runtime
  mid-turn.
- Turning fallbacks off forces that tier to exactly one runtime/provider.

## Frozen launch contract

Before manual approval or launch, the host persists a
`DelegationCapabilitySnapshot` containing:

- profile identity and label;
- Best for and child-only Working guidance;
- access ceiling and requested effective permission;
- selected service level and ordered routes;
- exact Skill/Plugin-skill and MCP server IDs;
- snapshot version and timestamp.

Running or resumed children read this snapshot, never the mutable Settings
profile. Editing or deleting a specialist therefore changes only future
delegations. Missing Skill identities and missing or disabled MCP selections
fail closed with a user-visible diagnostic.

## Local broker and tools

The Tauri process owns a loopback JSON-RPC broker. Each provider session gets a
fresh random grant bound server-side to an exact role, scope, and delegation
mode. The stdio MCP bridge receives the opaque grant and cannot choose a
different task, child, role, or mode.

Orchestrator sessions receive:

- `peers_list`
- `delegate_start`
- `delegation_status`
- `delegation_message`
- `delegation_thread`
- `delegation_result`
- `delegation_stop`

Child sessions receive:

- `orchestrator_ask`
- `orchestrator_report`
- `task_complete`

`delegation_thread` returns the recent persisted child transcript for the
calling parent task. It uses the same broker scope check as status, messaging,
result, and stop; an orchestrator cannot inspect another task's child by
supplying an ID.

The broker also exposes `skill_data_request`, the narrow built-in read-only
data connector. Its credentials are resolved in the native process and never
returned through MCP.

## Messaging and transcript behavior

Messages are durable rows with sender `orchestrator`, `child`, or `user`.

- `orchestrator_ask` and `orchestrator_report` enqueue child-to-parent updates.
  They appear in the Agents rail and are included in the parent's next prompt
  as a delegation update; they never interrupt the user's active turn.
- `delegation_message` and the child conversation composer enqueue
  parent/user-to-child guidance. If the child is busy, delivery waits for its
  current turn to settle. It never steers a half-finished child turn.
- `delegation_thread` lets the parent model inspect the same persisted child
  conversation the user can open beside the parent chat.
- Terminal or disconnected children can be reopened under their existing
  child task and provider session reference when the provider supports resume.

The child must call `task_complete(summary)` for an explicit deliverable. The
host also persists the real provider transcript, so a completed result can be
paired with a bounded transcript digest.

## Provider projection

| Runtime | Parent broker | Child broker | Specialist Skills | Selected MCPs |
| --- | --- | --- | --- | --- |
| Codex | thread-start config | thread-start config | native skill projection | thread-start config |
| Claude | merged `--mcp-config` | merged `--mcp-config` | per-session plugin dirs | merged config |
| Antigravity | private control overlay | private control overlay | projected index + read scope | private overlay |
| Cursor | ACP `mcpServers` | ACP `mcpServers` | bounded prompt projection | ACP `mcpServers` |
| Grok | ACP `mcpServers` | ACP `mcpServers` | bounded prompt projection | ACP `mcpServers` |

All five child paths receive the same coordination contract when the local
broker is available. The legacy sentinel parser remains only as a degraded
transport for a provider path that cannot load the broker; it is not the
normal behavior advertised to a child.

Skill and MCP projection is exact: a child receives only identities captured
in its frozen snapshot and still available at launch. A plugin-level picker
action expands to the plugin's currently installed Skill identities; newly
installed sibling Skills are never inherited by an existing specialist.
Plugin assignment is therefore a convenience for selecting exact components,
not an indivisible or future-growing authority bundle.

## Persistence and recovery

Migration 20 adds `service_level` and `capability_snapshot_json` to
`delegations` and backfills legacy rows with a version-zero Standard snapshot.
The existing child task, message, status, result, provider-session reference,
and parent/child relationship remain durable.

On restart, active children are marked interrupted rather than falsely
completed. The Agents rail retains their lineage and transcript. A user or
parent message can resume the same durable child; it does not create a hidden
replacement task.

## Settings experience

Settings → Subagents uses one continuous roster/editor surface:

- compact global safeguards and optional delegation guidance;
- one selected specialist at a time;
- provider icons in the roster and runtime pickers;
- Best for and collapsed child-only Working guidance;
- Budget/Standard/Premium routes with optional ordered fallbacks;
- read-only/project-write access ceiling;
- a full-width **Equipped capabilities** section, grouped into whole
  **Plugins**, individual **Skills**, and **MCP servers**, with counts,
  readiness, search, and explicit removal;
- a frozen-snapshot note at the bottom.

Installed Skills and Plugins can be assigned even when they are off for normal
orchestrator chats. Those enablement settings remain separate: ordinary chats
receive the globally enabled inventory, while a specialist receives only its
explicitly frozen Skill IDs. Removing a specialist assignment or uninstalling
the Skill revokes it for future launches.

Delegation mode remains in the composer. Settings does not duplicate that
choice, and there are no Preferred helper or recursive-delegation controls.

## Security boundary

- Broker transport is loopback-only and every provider session has a unique,
  server-bound grant.
- Parent tools are task-scoped; child tools are delegation-scoped.
- Access is a ceiling. The parent may request less, never more.
- Capability IDs are host-resolved from installed Skill inventory and enabled
  MCP inventory, then frozen before launch; the model cannot submit commands,
  paths, secrets, or arbitrary MCP definitions in `delegate_start`.
- The certified concurrency setting is clamped to four, and only one
  project-writing child may be active for a parent task at a time. Read-only
  specialists can still run in parallel within the configured cap.
- Provider projection files live only in Integrator-owned app data with
  owner-only permissions and are pruned on startup. Selected third-party MCP
  servers may still receive their configured credentials and act with their
  own external authority; assignment is therefore an explicit trust decision,
  not an extension of the workspace sandbox.
- Shared state is broker-owned and child scratch/transcripts are task-owned.

## Deliberately deferred

- recursive specialist delegation;
- per-delegation token budgets or accounting contracts;
- mid-turn automatic provider failover;
- isolated worktree leases for concurrent writing children;
- per-tool filtering inside an assigned third-party MCP server;
- per-call approval and uncertain-outcome reconciliation for externally
  mutating MCP tools.
