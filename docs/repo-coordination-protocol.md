# AI Integrator — Repository Coordination and Worktree Protocol

**Status:** Normative harness contract  
**Audience:** Desktop, broker, runtime adapters, Git, persistence, security, and QA  
**Companions:** [Product specification](product-spec.md), [Broker MCP contract](broker-mcp-contract.md), [Critical systems primitives](critical-systems-primitives.md), [Agent workspace UI/UX primitives](ui-ux-primitives.md)

## 1. Purpose

AI Integrator must let humans, lead agents, and child agents continue work without repeatedly re-reading the repository, restating the assignment, copying transcripts, or creating competing summary files. The coordination layer therefore uses:

- one durable project knowledge surface that may be committed;
- one local authoritative task ledger shared by every worktree;
- one small run-owned scratch area per agent;
- references to transcripts and artifacts instead of copies;
- brokered messages and context requests instead of agents editing each other's notes;
- an explicit promotion path from scratch → task evidence/decision → durable project knowledge.

This protocol complements `AGENTS.md`, runtime config, and existing project documentation. It never copies or replaces them merely to make Integrator appear self-contained.

## 2. Storage topology

### 2.1 Durable, commit-eligible project layer

Projects may opt into a tracked directory at the repository root:

```text
.aiintegrator/
  project.yaml
  policy.yaml
  knowledge/
  templates/
  .runtime/             # always local/ignored; never committed
```

Rules:

- `project.yaml` references authoritative files, commands, environments, test entrypoints, design sources, and ownership. It does not duplicate their contents.
- `policy.yaml` contains portable delegation, worktree, evidence, deployment, and secret-read policy that the project intentionally shares.
- `knowledge/` contains only user/maintainer-promoted durable notes or decisions. Task scratch and full transcripts never land here automatically.
- `templates/` may define task contracts, return schemas, or role recipes.
- Integrator never creates or commits the durable layer without explicit project adoption.
- Existing `AGENTS.md`, `.codex/`, `.cursor/`, skills, hooks, MCP configuration, `CONTRIBUTING.md`, and product specs remain authoritative in their own scopes. `project.yaml` links to them.

### 2.2 Git-common local task layer

For Git repositories, the authoritative local coordination root is:

```text
<git-common-dir>/aiintegrator/v1/
```

Resolve `<git-common-dir>` with `git rev-parse --git-common-dir`, then canonicalize it. This location is shared by the main checkout and all Git worktrees, but is not part of commits or ordinary diffs.

```text
<git-common-dir>/aiintegrator/v1/
  repo.json
  tasks/
    <task-id>/
      task.yaml
      contract.md
      state.md
      context-manifest.json
      decisions.jsonl
      evidence.jsonl
      messages.jsonl
      artifacts.json
      checkpoints/
        <checkpoint-id>.json
      runs/
        <run-id>/
          run.yaml
          assignment.md
          scratch.md
          notes.jsonl
          status.json
          result.json
          transcript.ref.json
  worktrees/
    <lease-id>.json
  locks/
  derived/
    index.sqlite
```

The human-readable records are authoritative. `derived/index.sqlite` accelerates search and may be rebuilt; it is never the sole copy of a contract, decision, evidence event, message, result, or lease.

### 2.3 Worktree-local run projection

Each run receives a small, generated projection inside its assigned checkout:

```text
<worktree>/.aiintegrator/.runtime/runs/<run-id>/
  active.json
  assignment.md
  scratch.md
  state.md
```

- Integrator adds `/.aiintegrator/.runtime/` to the Git common `info/exclude` rather than editing the project's `.gitignore` silently.
- `active.json` points to the task, run, lease, contract/context versions, broker session, and authoritative coordination root.
- `assignment.md` is a bounded projection of the canonical assignment.
- `state.md` is a bounded, read-only projection of the current task state relevant to this run.
- `scratch.md` is run-owned and synchronized to the authoritative run directory. No other agent writes it.
- Projections can be deleted and regenerated. They never contain credentials, hidden reasoning, or the only copy of evidence.

For non-Git folders, use a canonical app-data repository id for the authoritative ledger and the same `.aiintegrator/.runtime/` projection when the user permits it. Worktree and Git actions remain unavailable.

## 3. Canonical record responsibilities

| Record | Writer | Purpose | Must not contain |
|---|---|---|---|
| `task.yaml` | Broker | Task identity, project, phase/status, current contract/state versions | Transcript copies, secrets |
| `contract.md` | User/lead through broker | Goal, scope, constraints, definition of done | Running diary |
| `state.md` | Broker from accepted events | One current concise state: done, active, blocked, next | Repeated transcript, unverified claims without labels |
| `context-manifest.json` | Broker | Exact references/instructions/skills/memories/summaries sent to runs | Hidden runtime context presented as known |
| `decisions.jsonl` | Broker | Append-only accepted decisions with provenance and supersession | Every thought or discarded idea |
| `evidence.jsonl` | Broker/adapters | Typed commands, tests, files, diffs, screenshots, citations, gaps | Raw unredacted secrets |
| `messages.jsonl` | Broker | Parent/child/sibling communication envelopes and delivery state | Vendor credentials, hidden reasoning |
| `artifacts.json` | Broker | Content-addressed artifact references and versions | Duplicate artifact bytes |
| `run.yaml` | Broker | Immutable run launch snapshot: route, policy, assignment, checkout | Mutable current status |
| `scratch.md` | Owning run | Temporary observations and recovery notes | Cross-run authoritative decisions |
| `notes.jsonl` | Owning run/broker | Typed proposed facts, decisions, questions, and evidence refs | Copied parent transcript |
| `status.json` | Broker/adapter | Current run lifecycle and last acknowledged event | Long history |
| `result.json` | Broker from child return | Structured result and evidence references | Full transcript copy |
| `transcript.ref.json` | Broker/adapter | Native/local transcript identity, sequence, hash, visibility, cursor | Transcript body or hidden reasoning |
| worktree lease | Git manager | Repository/worktree/base/branch/owner/process/dirty/cleanup state | Secrets |

## 4. Anti-redundancy rules

1. **Reference before copying.** Use task/run/event/artifact/file/content hashes and line/turn ranges. Copy an excerpt only when the consumer cannot access the source and the excerpt is required.
2. **One current state.** `state.md` is replaced atomically; agents do not create `status-final-2.md`, personal handoff variants, or parallel summaries.
3. **Append only new information.** A decision or evidence event receives a stable id. Corrections use `supersedes`; they do not restate the full history.
4. **Scratch is private to a run.** Children may not edit the parent or sibling scratch file. Shared facts move through broker messages and promotion.
5. **Transcripts remain transcripts.** Store one native/local transcript and references to it. A summary cites the exact sequence range and summary producer/version.
6. **Durable knowledge is promoted deliberately.** Task completion may propose project knowledge; a human or policy-authorized maintainer accepts, edits, or rejects it.
7. **Existing project docs win.** If a fact belongs in `README`, `CONTRIBUTING`, a product spec, or `AGENTS.md`, update that source rather than creating an Integrator paraphrase.
8. **Content-address repeated attachments/artifacts.** Multiple tasks may reference the same bytes without duplicating them across worktrees.
9. **Bound every file.** Scratch, output tails, and JSONL logs rotate/compact with provenance; compaction never deletes the canonical evidence/transcript range it summarizes while retention allows it.

## 5. Agent note protocol

Agents receive the exact run projection path and this write contract:

- Read `assignment.md`, `state.md`, and the context manifest before broad exploration.
- Use `scratch.md` for tentative notes needed for crash recovery.
- Emit typed notes for `fact`, `decision_proposal`, `question`, `risk`, `evidence_ref`, `gap`, and `next_action`.
- Cite repository paths/lines, task events, commands, artifacts, or transcript ranges instead of pasting large bodies.
- Before repeating discovery, search accepted task evidence/decisions and relevant child results.
- Finish with `result.json` through the broker return schema; do not produce a second handoff file unless the assignment requests a repository artifact.
- Never write credentials, secure terminal input, hidden reasoning, or another run's private context into notes.

Example note envelope:

```json
{
  "id": "note_01J...",
  "type": "fact",
  "runId": "run_01J...",
  "createdAt": "2026-07-10T18:20:00Z",
  "content": "Mobile intake validation is centralized in IntakeSchema.",
  "references": [
    { "kind": "file", "path": "src/intake/schema.ts", "line": 42, "contentHash": "sha256:..." }
  ],
  "confidence": "observed",
  "supersedes": null
}
```

The broker validates size, type, references, redaction, ownership, and duplicate/supersession relationships before accepting a shared note.

## 6. Parent, child, and sibling communication

### 6.1 Default information flow

- A child receives the bounded assignment, selected context references, effective policy, worktree lease, and required return contract—not the full parent transcript.
- A parent receives child status, typed questions, important notes, permission/attention events, and the structured result—not continuous copied transcript text.
- Siblings do not read or message each other directly by default. The parent/broker may relay a scoped message or authorize a specific transcript/context request.
- The user can inspect every observable child transcript from the child pane, subject to account/task authorization and redaction.

### 6.2 Messaging

Messages have sender/recipient run ids, task lineage, kind, body, context references, delivery target, sequence, idempotency key, policy decision, and delivery/acknowledgment state.

Supported kinds:

- `guidance`
- `question`
- `answer`
- `context_request`
- `context_grant`
- `status_request`
- `result_correction`
- `stop_or_scope_change`

Native child messaging/steering is used when available. Otherwise the broker creates an explicit follow-up turn/run and labels the boundary. File-based message logs are persistence/audit, not the transport agents poll independently.

### 6.3 Transcript access

Transcript reads are on-demand and range-based:

- Parent may read observable descendant transcript ranges.
- Child may request a parent range; the broker grants only the minimum relevant, policy-allowed content.
- Sibling access requires explicit parent/user authorization and defaults to summary/result/evidence rather than raw transcript.
- Reads use cursor, maximum items/bytes, density, and redaction class.
- Returned content includes delivered user/assistant messages, structured tool/activity results, and runtime-provided reasoning summaries only when policy allows.
- Hidden reasoning, secure terminal input, credentials, disallowed attachments, and unrelated account/project content are never exposed.
- Each grant records source sequence/hash and appears in both runs' context manifests.

## 7. Worktree pairing

Every writing run is paired to exactly one `WorktreeLease`. Read-only runs may share a checkout if policy allows; concurrent writers may not.

The task/child row and run header always show:

- repository and canonical worktree path;
- branch or detached ref;
- base branch/commit and divergence;
- lease owner and run;
- clean/dirty/conflict state;
- unpushed commits and upstream state;
- active processes/terminals;
- last fetch/status time and staleness;
- Open folder, terminal, files, review, Git, and cleanup actions.

Selecting a child selects its paired worktree in Files, Terminal, Review, and Git panes. The user never needs to locate the checkout manually. Opening the worktree in Cursor, VS Code, Explorer/Finder, or a terminal preserves the same task/run association.

Lifecycle:

```text
requested
→ creating
→ ready/clean
→ assigned
→ dirty/committed/conflicted
→ accepted | rejected | orphaned
→ cleanup_eligible
→ deleted
```

No cleanup occurs while there are dirty files, conflicts, active processes, unique/unpushed commits, unexported artifacts, unresolved review comments, or an unacknowledged child result.

## 8. Git GUI contract

The Git pane is bound to the selected task/run/worktree, not to whichever folder was most recently focused.

### 8.1 Required MVP actions

- Fetch and refresh repository status.
- Inspect Unstaged, Staged, Commit, Branch against base, Last turn, and producing-run scopes where provenance is reliable.
- Stage/unstage file or hunk with stale-content protection.
- Discard selected working-tree changes only after exact preview/confirmation and with safe undo when possible.
- Write/edit a commit summary and optional description.
- Commit selected staged changes in the paired worktree.
- Amend only when explicitly enabled and the target commit/remote implications are shown.
- Publish a branch or push its configured upstream after remote/branch/protection/auth checks.
- Pull/rebase/merge only through a previewed strategy with dirty/conflict protection.
- Copy commit id, open on remote, create/open pull request when the connected Git host supports it.
- Compare/apply/merge a child branch into the designated target under one merge authority.

### 8.2 Commit and push safety

- Commit and Push are separate actions. Committing never pushes automatically unless an explicit project/task policy says so.
- Push preview names remote URL/host, repository, branch/refspec, upstream, ahead/behind state, force mode, protection policy, commits, and auth owner.
- Force push is off by default and cannot be delegated merely through Full local access.
- Secrets and generated coordination/runtime files are checked before stage/commit/push.
- The UI warns about files outside the producing run, but does not hide them.
- Agent-generated commit messages are drafts; the user can edit them and sees the evidence used to generate them.
- Successful push records remote/ref/commit evidence. Timeout or disconnect yields `Outcome uncertain` and checks remote state before Retry.

### 8.3 Pairing with child review

The child card, Git pane, and Review pane share the same lease id. Accepting a child opens its diff and integration plan; it does not silently stage, commit, merge, push, or delete the worktree. Rejected work remains inspectable until explicit cleanup.

## 9. Runtime authentication and terminal access

### 9.1 Existing login

If a detected CLI reports authenticated through its documented status/API, Integrator marks the connection Ready after a capability/compatibility probe. It does not reauthenticate, import tokens, or copy credentials.

### 9.2 Logged-out runtime

If login is required, Integrator may:

1. show the official vendor login command/action;
2. launch it in a dedicated Setup terminal owned by the user;
3. allow the vendor CLI to open its browser/device-code flow;
4. display non-secret progress and waiting state;
5. let the user cancel without losing the task/draft;
6. re-run documented auth, capability, and compatibility probes after completion.

The user completes password, OAuth, device confirmation, MFA, hardware-key, or account/workspace selection through vendor/OS-owned surfaces. Integrator never asks an agent to perform credential entry and never reads undocumented credential files.

### 9.3 Terminal classes

| Terminal | Owner/default context | Model visibility | Persistence |
|---|---|---|---|
| Setup/login | User; runtime setup directory | None by default | Redacted status only; secure input never stored |
| Task terminal | User; selected task/worktree/environment | None unless output is explicitly attached | Bounded scrollback/log under task policy |
| Agent process terminal | Agent until takeover; exact run/worktree | Structured activity/safe output according to policy | Run-linked bounded log |
| External terminal | User in configured terminal app | None unless imported explicitly | Owned by external app; Integrator tracks launch metadata only |

All integrated terminals support a real PTY where the platform/runtime permits it, interactive/full-screen programs, resize, search, copy, split/tabs, explicit stdin ownership, process-tree stop, and truthful exit state. Secure/no-echo prompts use a protected input surface and send bytes directly to the process without model/transcript/draft/log exposure.

## 10. Security and consistency invariants

- Broker is the sole writer of shared task records, messages, leases, and accepted evidence/decisions.
- Agents own only their run scratch/notes and repository files allowed by their worktree policy.
- Every shared mutation has task/run identity, sequence, idempotency key, source, timestamp, and redaction state.
- File paths are canonicalized; symlink/junction/case aliases cannot cross project, worktree, or secret boundaries.
- `.aiintegrator/.runtime/` is excluded from Git and secret/staging scans verify that it is not committed.
- Transcript references cannot escape task/account lineage.
- Coordination storage never grants authority; policy/broker/runtime sandbox remains authoritative.
- Deleting/archiving a task, transcript, worktree, branch, coordination ledger, or durable project knowledge are distinct operations.

## 11. Required fixtures

1. Two child readers share a checkout, write separate scratch files, and return deduplicated evidence.
2. Two writing children receive separate worktrees and cannot write through each other's canonical/alias paths.
3. Parent requests a child transcript range; child requests parent context; sibling access is denied until explicitly granted.
4. Broker restart replays message/lease state without duplicate delivery, child spawn, commit, or push.
5. A child crashes after writing scratch but before result; the next run recovers notes without treating them as accepted facts.
6. A promoted project decision updates the authoritative project document and supersedes the temporary note instead of copying it indefinitely.
7. Commit/push GUI handles dirty, staged+unstaged, protected branch, diverged upstream, auth expiry, timeout-after-push, and secret-file fixtures.
8. Existing CLI login works without reauthentication; logged-out CLI completes browser/device-code/interactive setup terminal flow without exposing credentials.
9. Main checkout plus multiple linked worktrees resolve one Git-common ledger and never commit `.runtime` projections.
10. Cleanup refuses dirty, active, conflicted, unpushed, unique-commit, unreviewed-result, and uncertain-push worktrees.
