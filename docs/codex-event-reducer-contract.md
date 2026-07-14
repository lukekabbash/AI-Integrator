# Codex event reducer and recovery contract

**Protocol fixture:** Codex app-server 0.144.0
**Authority:** Rust reducer plus local SQLite projections
**Renderer boundary:** normalized, sequenced projections only; raw provider JSON never crosses into React

This contract defines the smallest restart-safe Codex execution loop for v1. It complements the provider-neutral architecture and the pinned schemas under `protocol/generated/codex/0.144.0`.

## Initial event surface

The first certified reducer handles:

- `thread/started`, `turn/started`, `item/started`, `item/completed`, and `turn/completed`;
- agent-message and command-output deltas;
- file-change patch, turn plan, turn diff, and token-usage updates;
- retryable and terminal errors plus `serverRequest/resolved`;
- command-execution and file-change approval requests;
- protocol violations, provider exit, and broadcast receiver lag.

Initial item projections cover user messages, agent messages, plans, reasoning summaries, command execution, file changes, and MCP tool status. Unknown items become bounded neutral activity entries. Hidden reasoning, terminal stdin, provider environment variables, credentials, and raw MCP arguments/results are not transcript data.

Completed item and turn objects replace delta-built projections after applying the same redaction and size limits.

## Normalized renderer envelope

Every renderer event contains a monotonic database sequence, task and provider-session identity, provider thread, optional turn identity, timestamp, and one projection variant:

- turn changed;
- item changed;
- plan changed;
- diff changed;
- usage changed;
- approval changed;
- mode changed;
- turn error;
- connection changed;
- projection reset.

Mode changed carries the session's current mode plus every advertised mode (id, name, optional description) as a full snapshot. Sources: the ACP `session/new` `modes` field and `current_mode_update` notifications (Cursor Agent/Plan/Ask), client-side `session/set_mode` calls, and Claude's stream-json `system`/`status` permission-mode reports (synthesized from the CLI's fixed vocabulary). Providers without modes emit none and the renderer hides the mode picker.

Stable UI identifiers derive from provider identity, for example `codex:{thread}:{turn}:{item}`. React deduplicates by sequence only; equal consecutive delta text is valid and must not be hash-deduplicated.

## Persistence transaction

Migration 2 adds normalized turn, item, approval, and bounded event-log tables keyed to existing provider/runtime sessions. Each accepted provider event is processed in one transaction:

1. Validate the known method and required identities.
2. Redact and bound the audit representation.
3. Insert the event row and obtain its monotonic sequence.
4. Update turn, item, approval, plan, diff, or usage projections.
5. Commit.
6. Emit the normalized projection containing that sequence.

The task snapshot API returns projections, a `watermarkSeq`, and an in-process `runtimeLive` attestation. The renderer registers its event listener first, buffers events while loading the snapshot, then applies only sequences newer than the watermark. Reopening a live task preserves its projected turn ID and `startedAt`; absence of a new connection event during navigation is not evidence that the task stopped.

## Request identifiers and approvals

Codex JSON-RPC `RequestId` is a tagged string-or-number value. The adapter, Tauri commands, database, and renderer must preserve its original kind and exact value; coercing it to `u64` is invalid.

Transport correlation uses provider session plus request kind/value. Logical correlation also includes thread, turn, item, approval kind, and optional `approvalId`; item identity alone is insufficient.

Approval state is:

```text
pending -> responding -> resolved
        \-> declined
        \-> cancelled
        \-> expired
        \-> response_failed
```

The reducer persists `responding` and the decision before sending the JSON-RPC response. `serverRequest/resolved` is final confirmation. Requests belonging to a dead app-server process expire and may be superseded by a newly issued transport request.

Approval kinds are command execution, file change, and plan review. Plan-review approvals carry the full plan document (markdown, bounded at 256 KiB) and gate the transition from planning to implementation: Claude's `ExitPlanMode` `can_use_tool` control request (allow exits plan mode; allow-for-session additionally switches the session to `acceptEdits`) and Cursor's blocking `cursor/create_plan` extension request (success accepts the plan; the error result carries the rejection so the agent keeps planning). Plan reviews are never auto-approved by the full-access profile — the user chose plan mode to read the plan before anything is built.

## Stop and completion authority

Persist the turn ID returned by `turn/start`. Stop is idempotent while requested:

1. Persist `stopRequested`.
2. Call `turn/interrupt(threadId, turnId)`.
3. Do not infer interruption from the RPC response.
4. Treat `turn/completed` with interrupted status as authoritative.
5. If the provider reports the turn already complete, reconcile with `thread/read`.

## Reconnect and gap recovery

On startup or reconnect:

1. Register the normalized Tauri listener.
2. Load the task snapshot and watermark while buffering newer events.
3. Connect Codex in the trusted repository/worktree.
4. Load the persisted provider session.
5. Resume the provider thread.
6. Reduce returned populated turns as an authoritative replacement snapshot.
7. If history is incomplete or receiver lag was recorded, read the thread with turns.
8. Preserve an in-progress turn and wait for events; never start a duplicate turn.
9. Expire approvals tied to the previous app-server process.

A lagged broadcast receiver records a gap and reconciles; it does not end the forwarding loop. Provider exit means disconnected until reconciliation, not automatic task failure. Each app-server process gets a new runtime session while the provider thread keeps its stable provider session.

## Bounds and redaction

P0 retention limits:

| Content | Limit |
|---|---:|
| Bounded audit payload | 256 KiB |
| User or agent item body | 2 MiB |
| Command output | 1 MiB: first 128 KiB plus latest 896 KiB |
| Diff | 4 MiB |
| Plan | 256 steps, 4 KiB each |
| Error, reason, or command text | 16 KiB |
| Path | 4 KiB |
| Approval request ID | 512 bytes |
| One renderer projection | 512 KiB |

Redaction covers authorization headers, cookies, bearer/API tokens, `.env` assignments, private-key blocks, credential-bearing URLs, and likely high-entropy secrets. Streaming redaction retains an overlap window so secrets split across chunks cannot bypass detection. Truncation is always explicit.

## Required replay fixtures

1. Text happy path.
2. Chunked command success.
3. Approved file change.
4. String request ID with two approval IDs for one item.
5. Declined approval.
6. Stop/completion race.
7. Interrupted turn.
8. Retryable error followed by success.
9. Terminal turn failure.
10. Exit, resume, and authoritative reconciliation.
11. Broadcast lag followed by thread-read reconciliation.
12. Hostile oversized/redaction payloads, malformed identities, terminal stdin, and unknown methods.

The first live Codex milestone is complete only when one persisted task can start or resume, stream assistant/tool/file events, approve or decline, stop, survive restart, and reconstruct its transcript from SQLite plus authoritative provider reconciliation.
