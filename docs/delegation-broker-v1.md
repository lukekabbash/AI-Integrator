# Delegation Broker v1 — async cross-provider subagents

Status: Implemented (v1 slice of `broker-mcp-contract.md`)

## Goal

Give any orchestrator session a model-facing tool surface to delegate work to
subagents running on _other_ providers, governed by a user-defined policy in
settings. Delegation is fully asynchronous: it never blocks or interrupts the
user's conversation. Orchestrators can check in on and nudge children;
children can ask questions of / report to the orchestrator.

## Architecture

```
┌────────────── Tauri app (one process) ───────────────┐
│ Broker host: TCP JSON-RPC on 127.0.0.1:<ephemeral>   │
│  · token-authenticated, loopback only                │
│  · orchestrator tools: peers_list, delegate_start,   │
│    delegation_status, delegation_message,            │
│    delegation_result, delegation_stop                │
│  · child tools: orchestrator_ask, orchestrator_report,│
│    task_complete                                     │
│ Child runtimes: HashMap<delegation_id, ChildRuntime> │
│  (structured CLI for claude/agy, app-server for      │
│   codex, ACP for cursor/grok)                        │
└──────────────▲───────────────────────────────────────┘
               │ line-delimited JSON-RPC + token
┌──────────────┴──────────────┐
│ integrator.exe --broker-mcp │  ← stdio MCP server, spawned by the
│ (thin bridge, no Tauri)     │    provider CLI from injected MCP config
└─────────────────────────────┘
```

The provider CLI spawns `<current exe> --broker-mcp` as a stdio MCP server.
Env vars in the MCP config carry the broker address, an auth token, the role
(`orchestrator` | `child`), and the scope id (parent task id, or delegation
id for children). The bridge forwards `tools/call` to the broker host.

## Delegation modes (composer dropdown, now functional)

- `off` — no broker MCP injected, no delegation preamble. Default.
- `manual` — tools injected; every `delegate_start` creates a delegation in
  `pending-approval`; the user approves/denies in the Agents rail panel.
- `balanced` — model delegates freely within policy caps.
- `budget-first` — same, but `peers_list` orders profiles cheapest-first and
  the preamble instructs the model to prefer the cheapest capable profile.

The default mode comes from settings (`settings.delegation.defaultMode`) and
seeds the composer dropdown; the per-turn value is forwarded to the turn
commands.

## Policy (user settings, "Subagents" settings section)

- `settings.delegation.defaultMode` — default composer mode.
- `settings.delegation.maxConcurrent` — cap on concurrently running children
  per parent task (default 3). Enforced by the broker, not the model.
- `settings.delegation.instruction` — free-text user policy appended to the
  orchestrator preamble (the "custom instruction").
- `settings.delegation.profiles` — JSON array of delegation targets:
  `{ id, label, runtime, model, effort?, instruction?, preferredChildProfileIds?, costTier: low|medium|high, enabled }`.
  `peers_list` returns only enabled profiles; `delegate_start` validates the
  profile id against this list. The model never picks raw runtime/model pairs.
  A profile instruction is injected into the child preamble as that specialist's
  standing role and quality bar. Preferred child profiles are exposed as
  downstream planning metadata; recursive launching remains disabled by the
  one-level v1 policy.

## Async message model

Two queues per delegation (`delegation_messages`, sender = `orchestrator` |
`child` | `user`):

- **To child** (orchestrator `delegation_message`, or user message from the
  rail/conversation pane): queued; delivered as the child's next turn the
  moment the child is idle (turn settled). Completed, failed, stopped, or
  process-disconnected children can be reopened under the same durable child
  task. Never interrupts a running child turn.
- **To orchestrator** (`orchestrator_ask` / `orchestrator_report`): queued;
  never interrupts the user's conversation. Delivered when (a) the
  orchestrator calls `delegation_status`/`delegation_result`, or (b) the
  user's next turn starts — undelivered child messages are prepended to the
  wire prompt as a `<delegation-update>` block. They are also always visible
  in the Agents rail.

## Child lifecycle

`delegate_start` → policy check → child `Task` row (`parent_task_id` set,
same repo/worktree as the parent) → child runtime spawned → first turn =
child preamble + brief (+ parent conversation digest). Turn settles →
deliver queued messages as next turn, else `waiting`. Child calls
`task_complete(summary)` → `completed` with stored result. `delegation_stop`
or user Stop → `stopped`. A new user message reopens that same child task and
starts a fresh provider driver when necessary. Child provider events flow
through the existing pumps, so child transcripts are real tasks: clicking a
child in the rail opens its full transcript immediately left of the right rail,
beside the orchestrator conversation. Child tasks are hidden from the task
sidebar.

## Provider support matrix (v1)

| Provider    | As orchestrator (tools)         | As child target                                                                         |
| ----------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| Claude      | yes (`--mcp-config`)            | yes (child tools too)                                                                   |
| Cursor      | yes (ACP `mcpServers`)          | yes (child tools via ACP `mcpServers`; Agent mode pinned; unattended auto-allow)        |
| Codex       | no (deferred: config injection) | yes (approval policy `never`, no child tools — results captured from transcript digest) |
| Antigravity | no                              | yes (no child tools)                                                                    |
| Grok        | no                              | yes (no child tools; unattended auto-allow)                                             |

Children without child tools still receive nudges (injected as turns) and
still produce results (digest capture on completion); they just can't ask
questions mid-flight.

ACP children (Cursor/Grok) run one long-lived agent process per child
session. `session/prompt` resolves at turn end, so the delegation settles
from the prompt future itself rather than a watcher. Because no one watches
a child's approvals, the ACP pump answers `session/request_permission`
immediately (narrowest allow option; cancel if the request advertises no
allow) and auto-accepts `cursor/create_plan` — the ACP analog of the Codex
child's approval policy `never`. Cursor children are pinned to the Agent
session mode so a brief executes instead of being planned or answered
read-only, and profile model/effort pins apply through the stable
`session/set_config_option` surface (effort via the Cursor model-list
extension); values the agent does not advertise are dropped, never failed.

## Persistence (migration 6)

- `tasks.parent_task_id` (nullable, FK tasks.id)
- `delegations` (id, parent_task_id, child_task_id, profile fields, title,
  brief, status, result, child_session_ref, timestamps)
- `delegation_messages` (id, delegation_id, sender, body, created_at,
  delivered_at)

## UI

- Composer: dropdown default now driven by settings; value forwarded on
  every turn.
- Agents rail panel: live lineage from recursive `delegation_list` reads,
  unread child questions, Approve/Deny (manual mode), Stop, and selection of a
  half-width sibling conversation pane. The pane sits left of the persistent
  right rail, so the two conversations are adjacent and the task-tool tabs
  remain visible. Child projection events use the same transcript renderer and
  the same Composer component as the orchestrator. At idle/terminal boundaries
  the user can change among supported child providers, models, and efforts;
  active turns must be stopped before rerouting. `delegation://update` Tauri
  events trigger refresh.
- Settings → Subagents: mode default, concurrency cap, custom instruction,
  profile editor, per-specialist instructions, and preferred downstream helper
  preferences.

## Security notes

- Broker binds loopback only; every connection must present the per-app-run
  random token before any tool dispatch.
- Orchestrator tools are scoped to the task id baked into that session's MCP
  env; child tools to their delegation id. No cross-task reach.
- Delegated children run under the same trusted-project boundary as the
  parent task (same repo/worktree paths already trusted by the user).
- v1 runs children in the parent worktree; concurrent write conflicts are
  possible if the orchestrator parallelizes overlapping edits. Worktree
  leases are the planned follow-up (see `repo-coordination-protocol.md`).

## Deferred (explicitly out of v1)

Codex/agy orchestrator tool injection; per-delegation worktree leases;
mid-session MCP hot-attach; cross-repo delegation; token budget metering per
delegation. (Cursor/Grok children shipped post-v1 — see the support matrix.)
