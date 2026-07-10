# AI Integrator — Broker MCP Contract

**Status:** Normative MVP protocol surface  
**Audience:** Broker, runtime adapters, skill authors, security, and conformance QA  
**Companions:** [Repository coordination protocol](repo-coordination-protocol.md), [Product specification](product-spec.md), [Critical systems primitives](critical-systems-primitives.md)

## 1. Scope

The Broker MCP gives a parent agent a small semantic interface for discovering eligible peers and commissioning, supervising, communicating with, and collecting bounded child work. It is not the desktop control plane, a generic model proxy, a credential broker, a remote shell, a filesystem server, or a replacement for Codex app-server/ACP/native runtime sessions.

The local desktop/broker remains authoritative for task identity, policy intersection, routing, process/session supervision, worktree leases, usage budgets, messages, transcripts, evidence, Git integration, and audit.

## 2. MVP transport and session binding

- MVP transport is local stdio launched/supervised by Integrator for the active runtime session.
- No unauthenticated TCP listener, LAN bind, or user-supplied bearer token is required for local MVP.
- Each MCP connection is bound out-of-band to one local installation/profile, project, task, parent run, runtime connection/vendor-auth-context fingerprint, policy snapshot, and control lease.
- Tool callers cannot select an arbitrary installation, project, parent task, run, or vendor auth context in arguments.
- v1 uses local process-bound stdio only. Any remote transport belongs to a future backend/identity re-architecture, not the current Broker contract.
- Initialize exposes server name/version plus capabilities for transcript ranges, native steering, native child sessions, worktree isolation, usage attribution, and result schemas.

## 3. Tool surface

| Tool | Mutation | Purpose |
|---|---|---|
| `peers_list` | No | List currently eligible peer execution profiles and hard limits |
| `delegate_start` | Yes | Create one bounded child assignment |
| `child_status` | No | Read current child lifecycle, attention, usage, checkout, and evidence summary |
| `child_message` | Yes | Send scoped guidance, question/answer, or context grant/request |
| `child_transcript_read` | No | Read an authorized, redacted observable transcript range on demand |
| `child_stop` | Yes | Stop the selected child; descendants require explicit separate scope |
| `child_result` | No | Read the structured result/evidence envelope |

`child_close`, archive, cleanup, merge, commit, push, deployment, and external actions are not MCP MVP tools. They remain user/broker/Git UI operations with their own authority and preview.

## 4. Common envelope

Every mutating request includes:

```json
{
  "idempotencyKey": "01J...",
  "expectedPolicyVersion": "sha256:...",
  "clientRequestTime": "2026-07-10T18:20:00Z"
}
```

Every response includes:

```json
{
  "requestId": "req_01J...",
  "taskId": "task_01J...",
  "parentRunId": "run_01J...",
  "sequence": 42,
  "policyVersion": "sha256:...",
  "serverTime": "2026-07-10T18:20:01Z"
}
```

Duplicate idempotency keys with the same canonical request return the prior result. Reuse with different content fails `IDEMPOTENCY_CONFLICT`.

## 5. `peers_list`

Input:

```json
{
  "role": "implementation",
  "requiredCapabilities": ["write", "terminal", "review"],
  "access": "isolated-write-worktree",
  "includeUnavailable": false
}
```

Output rows contain:

```json
{
  "profileId": "profile_codex_terra_high",
  "connectionLabel": "Codex subscription",
  "runtime": "codex",
  "providerModel": "gpt-5.6-terra",
  "effort": ["low", "medium", "high"],
  "roles": ["implementation", "review"],
  "capabilities": ["read", "write", "terminal", "review", "native_child_thread"],
  "usageClass": "included_constrained",
  "availability": "ready",
  "maxDepth": 1,
  "maxConcurrency": 2,
  "worktree": "broker_managed",
  "fidelity": "native",
  "unavailableReasons": []
}
```

The tool is read-only. It returns only peers allowed by the current effective policy unless `includeUnavailable` is authorized, in which case forbidden/unsupported profiles have reasons and cannot be passed successfully to `delegate_start`.

## 6. `delegate_start`

Input:

```json
{
  "idempotencyKey": "01J...",
  "expectedPolicyVersion": "sha256:...",
  "role": "implementation",
  "assignment": "Implement phases 2–4 of contract version 7.",
  "preferredProfileId": "profile_codex_terra_high",
  "allowedProfileIds": ["profile_codex_terra_high", "profile_cursor_composer"],
  "contextRefs": [
    { "uri": "aiintegrator://task/current/contract", "version": 7 },
    { "uri": "aiintegrator://task/current/file/src/intake/schema.ts", "contentHash": "sha256:..." }
  ],
  "access": "isolated-write-worktree",
  "budget": {
    "maxMinutes": 45,
    "maxTurns": 20,
    "maxUsage": null,
    "maxDelegationDepth": 0
  },
  "fallback": {
    "allowInsideCurrentBillingAndDataBoundary": true,
    "requireConsentForBoundaryChange": true
  },
  "return": [
    "summary",
    "filesInspected",
    "filesChanged",
    "commands",
    "tests",
    "artifacts",
    "risks",
    "remainingWork"
  ]
}
```

Output:

```json
{
  "childId": "child_01J...",
  "runId": "run_01J...",
  "resolvedProfileId": "profile_codex_terra_high",
  "route": {
    "runtime": "codex",
    "providerModel": "gpt-5.6-terra",
    "effort": "high"
  },
  "policySnapshot": "sha256:...",
  "worktreeLeaseId": "lease_01J...",
  "status": "setting_up"
}
```

The broker validates role/capabilities, parent budget, depth/concurrency, duplicate assignment, context authorization, secret policy, access intersection, route/billing/data boundary, repository state, and worktree lease before creating the child. Failure creates no partial child unless the response explicitly returns a recoverable `setupId`.

## 7. `child_status`

Input accepts one authorized `childId` and optional `sinceSequence`.

Output contains:

- lifecycle and last acknowledged sequence;
- route and immutable policy snapshot;
- assignment and context versions;
- current plain-language activity;
- waiting approval/question/credential/user-input state;
- worktree lease, branch, base, dirty/conflict/commit/upstream state;
- time/usage reservation and observed usage with confidence;
- changed-file/test/artifact counts;
- last important note/evidence ids;
- result availability and recoverability.

It never streams raw token deltas or copies the full transcript.

## 8. `child_message`

Input:

```json
{
  "idempotencyKey": "01J...",
  "expectedPolicyVersion": "sha256:...",
  "childId": "child_01J...",
  "kind": "guidance",
  "body": "Preserve the existing API shape and add regression coverage.",
  "contextRefs": [],
  "delivery": "steer_if_supported_else_next_turn"
}
```

Allowed kinds are `guidance`, `question`, `answer`, `context_request`, `context_grant`, `status_request`, `result_correction`, and `stop_or_scope_change`.

The response states `steered_current_turn`, `queued_next_turn`, `created_followup_run`, `delivered_to_mailbox`, or `rejected`, with the exact activation boundary. A message cannot widen access, budget, route allowlists, secret grants, worktree scope, or external-action policy; use a reviewed policy/task update outside MCP for that.

## 9. `child_transcript_read`

Input:

```json
{
  "childId": "child_01J...",
  "cursor": null,
  "maxItems": 50,
  "maxBytes": 65536,
  "density": "normal",
  "includeToolOutput": "summaries",
  "purpose": "Resolve failing-test context"
}
```

Output includes authorized observable items, source sequence/hash, next cursor, truncation, redaction classes, and whether native history is complete. It may include delivered messages, typed activities/results, terminal summaries, and runtime-provided reasoning summaries when policy allows.

It never exposes:

- hidden chain of thought or inferred reasoning;
- secure/no-echo terminal input;
- credentials, tokens, cookies, or secret environment values;
- attachments/files outside the requesting run's authorized scope;
- unrelated tasks/accounts/projects;
- deleted/retention-expired content;
- another child/sibling transcript without explicit parent/user grant.

Parents may read descendants by default under task policy. Children request parent ranges through `context_request`; siblings receive result/evidence or explicitly granted ranges, not unrestricted transcript access.

## 10. `child_stop`

Input:

```json
{
  "idempotencyKey": "01J...",
  "expectedPolicyVersion": "sha256:...",
  "childId": "child_01J...",
  "includeDescendants": false,
  "reason": "Assignment superseded",
  "cleanup": "preserve_for_review"
}
```

Default scope is the selected child only. Descendant stop requires explicit permission and returns the affected set before/with confirmation according to client policy. Stop transitions through request, settling, process termination, child-session reconciliation, and cleanup; it preserves worktree, scratch, evidence, partial result, and uncertain side effects for review.

## 11. `child_result`

Returns one immutable versioned result envelope:

```json
{
  "childId": "child_01J...",
  "runId": "run_01J...",
  "status": "completed_with_gaps",
  "summary": "Implemented schema validation and tests.",
  "filesInspected": [],
  "filesChanged": [],
  "commands": [],
  "tests": [],
  "artifacts": [],
  "commits": [],
  "risks": [],
  "gaps": [],
  "remainingWork": [],
  "evidenceRefs": [],
  "transcriptRef": "aiintegrator://task/current/run/run_01J/transcript",
  "route": {},
  "policySnapshot": "sha256:...",
  "contextManifest": "sha256:...",
  "worktreeLeaseId": "lease_01J...",
  "usage": [],
  "completedAt": "2026-07-10T19:00:00Z"
}
```

Agent claims without evidence remain labeled unverified. Reading a result does not accept, merge, commit, push, close, archive, or clean up the child.

## 12. Resources

MVP read-only resource URI families:

```text
aiintegrator://task/current/contract
aiintegrator://task/current/state
aiintegrator://task/current/context-manifest
aiintegrator://task/current/run/<run-id>/assignment
aiintegrator://task/current/run/<run-id>/result
aiintegrator://task/current/run/<run-id>/transcript
aiintegrator://task/current/artifact/<artifact-id>
aiintegrator://task/current/file/<percent-encoded-relative-path>
```

Resources enforce the same task/run/path/policy scope as tools. File resources require canonical repository-relative paths and content/version hashes. Resources are references into the broker ledger/repository; they do not duplicate full artifacts or transcripts into every child.

## 13. Error taxonomy

| Code | Meaning |
|---|---|
| `POLICY_CHANGED` | Expected policy version is stale; review effective diff |
| `NOT_AUTHORIZED` | Caller/task lineage cannot access target/action |
| `CAPABILITY_UNAVAILABLE` | No native/brokered primitive supports the request safely |
| `ROUTE_UNAVAILABLE` | Selected/allowed profile is unhealthy, logged out, incompatible, or over limit |
| `BOUNDARY_CONSENT_REQUIRED` | Fallback changes billing, provider, data location, permission, or external-action boundary |
| `DEPTH_LIMIT` / `CONCURRENCY_LIMIT` / `BUDGET_LIMIT` | Effective delegation ceiling reached |
| `DUPLICATE_ASSIGNMENT` | Equivalent live/completed assignment exists; returns reference when allowed |
| `IDEMPOTENCY_CONFLICT` | Key reused with different canonical input |
| `CONTEXT_DENIED` | Requested context/transcript/file is outside scope or secret policy |
| `WORKTREE_UNAVAILABLE` | Safe lease cannot be created/reused |
| `CHILD_NOT_FOUND` | Unknown, deleted, expired, or inaccessible child |
| `CHILD_TERMINAL` | Child already completed/failed/cancelled for requested mutation |
| `TRANSCRIPT_INCOMPLETE` | Native/local transcript gap exists; cursor/result explains limitation |
| `OUTCOME_UNCERTAIN` | Prior mutation may have succeeded; reconcile before retry |

Errors contain retryability, safe next actions, public explanation, diagnostic id, and no secret content.

## 14. Security and conformance

- Mutating tools require idempotency and current policy version.
- Tool safety annotations mark read-only versus mutating behavior; clients still enforce policy independently.
- The server never exposes vendor credentials or accepts raw tokens/passwords as arguments.
- Transcript and resource reads are redacted before serialization.
- All tools write append-only broker audit events with caller, target, decision, sequence, and result.
- Unknown tool arguments are rejected for security-sensitive mutations; versioned extensions live under a bounded namespaced metadata field and cannot grant authority.
- Broker restart reconstructs idempotency, leases, messages, and children from the Git-common coordination ledger.
- Conformance fixtures cover duplicate requests, stale policy, denied context, sibling transcript access, child crash, reconnect, nested stop, worktree failure, budget exhaustion, and uncertain external outcome.
