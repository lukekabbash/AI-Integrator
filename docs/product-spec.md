# AI Integrator — Product Specification

**Status:** Definition-ready  
**Audience:** Product, design, desktop engineering, runtime integration, security, and QA  
**Primary platforms:** Windows and macOS from one shared v1 product and release train; Linux after the local runtime abstraction is stable
**Certified v1 runtimes:** Codex app-server and Cursor ACP; other ACP runtimes remain capability-gated Preview until certified
**Extension path:** Agent Client Protocol (ACP), structured CLI streams, user-configured local CLI skills

## 1. Executive summary

AI Integrator is an accountless, local-first desktop workspace for directing coding agents through one restrained, task-centered interface. It does not replace the agents, proxy their model traffic, pool credentials, require an AI Integrator backend, or pretend that the same named model behaves identically in every harness. It launches and supervises the official runtimes already installed on the user's computer, normalizes their observable activity, and adds a shared layer for:

- Projects, tasks, worktrees, and cloned repositories.
- Compact runtime, model, effort, environment, permission, and budget selection.
- Portable skills and project guidance.
- Controlled delegation between agents.
- Provider-neutral task memory and handoffs.
- Diffs, approvals, artifacts, evidence, and recovery.
- Honest usage accounting and cost-aware routing.

The product succeeds when a user can start with a broad contract, let a high-judgment lead agent delegate bounded work to cheaper or subscription-backed agents, review one coherent result, and continue with another runtime without manually reconstructing context.

## 2. Product thesis

The market already contains multi-agent terminal launchers, Kanban boards, worktree managers, and remote-control apps. “Several CLIs in one window” is not a durable product advantage.

AI Integrator differentiates on five connected problems:

1. **Task continuity:** the task survives a change of runtime, model, computer, session, or worktree.
2. **Portable operating policy:** skills, scope, permissions, acceptance criteria, and delegation rules are expressed once and adapted to each runtime.
3. **Cost-aware delegation:** expensive models provide judgment where it matters; less expensive models and existing subscriptions perform bounded execution.
4. **Evidence and control:** every agent run returns a normalized record of what it read, changed, ran, verified, and could not prove.
5. **Low-friction choice:** selecting a subscription-backed runtime is as lightweight as selecting reasoning effort, not a separate product mode.

### 2.1 Product sentence

> One task surface for every coding agent you already use, with portable skills, controlled delegation, shared permissions, and honest usage visibility.

### 2.2 Experience promise

The user should feel that they are supervising one capable engineering workspace, not operating a switchboard of vendor products.

## 3. Goals and non-goals

### 3.1 Goals

- Make Codex, Cursor, and Grok feel native inside a single coherent task UI.
- Let a task move between runtimes without losing its contract, decisions, repository state, evidence, or pending work.
- Let connected agents safely delegate to one another through a brokered tool.
- Preserve native CLI authentication and local configuration.
- Make runtime/model/effort selection visible but visually secondary to the task.
- Treat permissions, worktree isolation, and deployment boundaries as first-class product controls.
- Provide model- and runtime-level usage reporting with explicit confidence labels.
- Deliver one premium Windows/macOS experience with fast keyboard navigation, platform-native behavior, and excellent reduced-motion support.
- Make adding an ACP agent mostly a manifest and compatibility-test exercise.

### 3.2 Non-goals

- Reimplementing the agent loops of Codex, Cursor, Grok, Claude Code, or other vendors.
- Storing, exchanging, extracting, or replaying vendor OAuth credentials.
- Claiming that model names alone predict behavior; the runtime/harness is part of the execution identity.
- Guaranteeing exact remaining subscription quota when a provider does not expose it.
- Offering every agent feature through one lowest-common-denominator interface.
- Shipping a full IDE or competing with Cursor Tab/autocomplete in the first release.
- Hiding material security or cost differences behind an opaque “Auto” option.
- Marketing user-configured local commands as official provider integrations or partnerships.
- Allowing unconstrained recursive agent spawning.
- Committing task scratch, runtime projections, full transcripts, locks, or local coordination state into the user's repository automatically.
- Giving every child the full parent or sibling transcript when a bounded assignment, result, evidence reference, or requested range is sufficient.
- Requiring an AI Integrator account, hosted task database, cloud transcript sync, credential proxy, or mandatory telemetry pipeline.

## 4. Product principles

### 4.1 Task first, agent second

The user names an outcome and attaches context. Runtime selection supports the outcome; it does not define where the work lives.

### 4.2 Native engines, normalized evidence

Each agent keeps its own prompts, tools, session behavior, and model access. AI Integrator normalizes events, permissions, artifacts, usage, and handoffs without pretending all runtimes are identical.

### 4.3 Progressive disclosure

The default composer shows only the controls needed for the next turn. Detailed permissions, routing, worktree, and model metadata are available in one click or keyboard command.

### 4.4 Safe defaults without ceremony

Project-scoped write access, explicit external-action approval, worktree isolation for parallel writers, and secret protection are defaults. The product must make the safe path faster than broad access.

### 4.5 Evidence over animated activity

Motion indicates state changes; it must never substitute for a concrete status, elapsed time, command, diff, test result, or blocking request.

### 4.6 Provider honesty

Display “Claude Opus via Cursor” and “Claude Opus via Copilot” as different execution paths. Show measured, provider-reported, and estimated usage separately.

### 4.7 Local control plane

The local application owns process supervision, task metadata, policies, and artifacts. Vendor CLIs own authentication and service communication.

### 4.8 Reference before copy

Repository files, task events, transcripts, artifacts, and child results use stable ids, hashes, and ranges. Agents receive the smallest relevant references and projections. Temporary observations remain run-owned until promoted; accepted project knowledge updates its authoritative document rather than accumulating competing summaries.

## 5. Product vocabulary and domain model

The UI must use these nouns consistently.

| Term | Definition |
|---|---|
| Connection | An installed and authenticated runtime or a user-configured local command. |
| Runtime | The agent harness executing a turn, such as Codex, Cursor Agent, or Grok Build. |
| Model path | Runtime + model + service tier, for example “Cursor · Grok 4.5 High.” |
| Project | Durable association with one or more local folders, repositories, remote roots, and project guidance. |
| Task | Durable user outcome containing its contract, messages, runs, artifacts, decisions, and evidence. |
| Turn | One user instruction and the resulting agent activity. |
| Run | One runtime's execution of a turn or delegated subtask. |
| Worktree | Isolated Git checkout assigned to a writing run. |
| Skill | Reusable instructions, references, scripts, or broker tools available to a runtime. |
| Delegation | A parent run commissioning a bounded child run through the local broker. |
| Handoff | Provider-neutral state package used to continue a task with another runtime or environment. |
| Artifact | A file, screenshot, report, preview, diff, commit, or structured result produced by a run. |
| Policy | Permission, scope, budget, deployment, network, and delegation constraints. |
| Evidence | Commands, outputs, tests, screenshots, diffs, citations, and explicit gaps supporting completion claims. |

### 5.1 Core records

The local data model must include:

- `Connection`: id, transport, command, version, auth state, update state, capabilities.
- `RuntimeModel`: runtime id, provider model id, display name, effort modes, tiers, availability.
- `ExecutionRoute`: connection/subscription, runtime, provider model, tier, effort, environment, continuation semantics, billing/usage class.
- `DelegationPolicy`: scope/source/version, eligible profiles/roles/task classes, depth, concurrency, duration/usage budget, permission ceiling, worktree strategy, fallback order, merge authority, return contract.
- `Project`: roots, repositories, default branch policy, environment profile, skill set, permission profile.
- `Task`: title, goal, contract, status, project id, created source, pinned state, current handoff.
- `Turn`: input, attachments, selected execution profile, timestamps, status.
- `AgentRun`: parent run, runtime, model, effort, process/session id, access mode, status, usage.
- `DelegationEdge`: parent, child, assignment, access, budget, return contract.
- `ContextManifest`: contract/instruction/skill/memory/summary/input lineage, size/confidence, native-context visibility, compaction boundaries.
- `EnvironmentProfile`: shell/host/toolchain, non-secret variables, secret references, network/proxy, roots, setup actions, scope/version.
- `SecretReference`: external store/reference, purpose, allowed consumers, scope, expiry/rotation state; never plaintext.
- `WorktreeLease`: canonical repository, path, base/ref, owner, active processes, dirty/lock state, cleanup eligibility.
- `Checkpoint`: causal sequence, route/policy/context versions, repository patch/commit, tools/processes, evidence, usage, children, uncertainty.
- `CoordinationLedger`: Git-common schema/version, task records, canonical current state, accepted decisions/evidence, message log, run scratch/result references, and derived-index status.
- `AgentMessage`: sender/recipient lineage, kind, scoped context references, activation boundary, sequence/idempotency, policy decision, delivery/acknowledgment state.
- `TranscriptReference`: runtime/native/local identity, observable sequence/hash, completeness, redaction/retention class, and authorized cursor ranges; never a hidden-reasoning or credential container.
- `Artifact`: type, path/URI, producer, checksum, preview metadata.
- `EvidenceEvent`: command, test, file operation, permission decision, source, result.
- `UsageEvent`: metric, value, source confidence, runtime, model, task, timestamp.
- `HandoffPackage`: goal, constraints, decisions, rejected approaches, touched files, evidence, gaps, next action.

## 6. Information architecture

### 6.1 Primary application regions

The default desktop window has three persistent regions:

1. **Left navigation:** projects, tasks, task status, search, activity entry points.
2. **Task canvas:** conversation, plan, normalized run events, artifacts, and review.
3. **Composer:** persistent bottom input with compact execution controls.

A fourth region, the **Inspector**, opens on demand at the right for usage, artifacts, sources, delegation, task contract, or run detail. It is not permanently visible below 1440 px.

The normative geometry, state machines, keyboard behavior, motion choreography, platform adaptations, and recovery rules for every workspace region are defined in [Agent workspace UI/UX primitives](ui-ux-primitives.md).

### 6.2 Left navigation hierarchy

The sidebar is hierarchical, but never visually dense.

```text
AI Integrator
  New task
  Search

Pinned
  Lotmind AI
    Mobile intake agent       ● running
    Security follow-up        ◐ waiting

Recent projects
  AI Integrator
  EVE OS

Standalone tasks
  Compare Grok and Sol

Activity
  Approvals (2)
  Completed
```

#### Required behavior

- **New task** is the primary action because the task is the durable unit.
- **Open project** and **Clone repository** live in the New task context menu, command palette, and empty-state composer; they are not competing full-width primary buttons.
- Project rows expand to show active and recent tasks.
- A project row may show one quiet aggregate badge: running count, waiting approval, or error.
- Task status uses icon + accessible label; color alone is insufficient.
- Completed tasks remain accessible but collapse out of the default active view.
- Quick conversational chat, if shipped, is secondary and visually distinct from agent tasks.

### 6.3 Open project vs new task vs clone

The product must resolve context with minimal interruption.

#### New task with an existing project

1. User selects project or uses the current project.
2. Composer appears immediately.
3. Defaults are inherited from the project.
4. Sending creates the durable task and starts its first turn.

#### New task without a project

The user may type before choosing a folder. On send:

- If the request is self-contained and does not require local files, offer **Run standalone**.
- If the request implies local code, show an inline context strip: **Choose folder**, **Clone repository**, **Use recent project**.
- Preserve the draft while context is chosen.

#### Clone and start

- Pasting a Git URL produces a removable “Clone and start” context chip.
- The user chooses destination, branch, and shallow/full clone only if needed.
- Clone progress appears as task setup, not a modal that blocks the application.
- The first agent turn begins only after checkout verification.
- Failed clones retain the task draft and present an actionable retry.

#### Open project

- Folder selection creates or reuses a project by canonical path.
- Detect Git repository, active branch, dirty state, nested repositories, package roots, and existing agent guidance.
- If the folder is not Git-backed, allow read/write tasks but hide worktree-only controls.

### 6.4 Task canvas

The canvas supports three user-facing density modes plus one diagnostic view:

- **Summary:** user messages, final agent messages, artifacts, diffs, and important decisions.
- **Normal:** summary plus grouped tool activity and plan progress.
- **Verbose:** every runtime-delivered tool, file, shell, delegation, permission, plan, and reasoning-summary item.
- **Raw diagnostics:** redacted vendor events or PTY transcript with framing metadata; never the default task view.

The chosen density is per user, not per provider.

Reasoning, activity, and response are separate layers. A reasoning block appears only when the runtime explicitly delivers reasoning content or a reasoning summary. Observable tool activity must not be relabeled as thinking, and AI Integrator never fabricates or reconstructs hidden chain-of-thought.

The canvas must support:

- Inline plan with completed/current/pending steps.
- Collapsible tool groups by semantic phase: discovery, implementation, validation, review.
- Delegation graph with child status and spend.
- Inline approval cards anchored to the requesting run.
- Artifact previews and screenshot comparison.
- Diff review with file/hunk comments.
- A persistent “what is happening now” status when the composer is off-screen.
- Side questions/forks that can read current context without silently altering the main task.

Detailed native command, file, transcript, diff, subagent, session, and keyboard mappings are normative in [Native interaction parity](native-parity-matrix.md). Cross-runtime workspace anatomy and interaction behavior are normative in [Agent workspace UI/UX primitives](ui-ux-primitives.md).

## 7. Composer specification

### 7.1 Default visual structure

```text
┌──────────────────────────────────────────────────────────────┐
│ Ask AI Integrator to build, fix, review, or investigate…     │
│                                                              │
│ + Project write       Branch: Bounded  Codex · GPT-5.6 High ↑│
└──────────────────────────────────────────────────────────────┘
```

The composer is one surface with two layers:

- The upper layer is text and attachments.
- The lower utility row is context on the left and execution on the right.

### 7.2 Compact controls

Visible by default:

- **Add**: file, screenshot, contract, skill, repository, app context.
- **Permission**: named profile such as Read only, Project write, Ask, Full access.
- **Environment**: only when non-default or when switching local/worktree/SSH/cloud matters.
- **Delegation policy**: a compact branch control such as Off, Ask, Bounded, or Auto; hidden inside execution overflow only when delegation is unavailable.
- **Execution route**: combined subscription/connection, runtime, provider model, service tier, and effort.
- **Send/stop**.

Conditionally visible:

- Budget or usage warning.
- Goal indicator.
- Active skill.
- Branch/worktree chip.
- Deployment lock.

### 7.3 Execution-profile selector

There is no global provider mode. The profile is selected per turn and remembered per task.

```text
Recommended
  Auto — follow this task's routing policy

Favorites
  Codex · GPT-5.6 Sol · High
  Cursor · Grok 4.5 · High
  Grok Build · Grok 4.5

Efficient
  Codex · GPT-5.6 Terra · Medium
  Codex · GPT-5.6 Luna · Low

Connected agents
  Kilo · Auto
  OpenCode · selected model
```

Requirements:

- Place the collapsed route pill in the lower-right utility group immediately before voice and Send/stop, matching the low-friction reasoning selector pattern in the supplied Codex reference.
- Group by useful role, not only vendor.
- Always show runtime and model together; provider and subscription route remain inspectable even when shortened from the collapsed label.
- Search model, runtime, role, or subscription.
- Pin favorites and recent profiles.
- Explain unavailable choices without making them appear broken.
- “Auto” must disclose the selected profile before execution starts.
- Show whether usage is subscription-included, provider-reported constrained, API-metered, local, or unknown without exposing credentials.
- Keep provider branding to a small identity glyph; changing routes never recolors or reconstructs the composer.
- While a run is active, a changed route is labeled `Next turn`; it never claims to mutate the active native request.
- Model changes during a task do not erase native session history; adapters determine whether to continue, fork, or hand off.

### 7.4 Delegation-policy selector

The branching control sits directly before the execution-route pill in the lower-right group:

```text
Branch: Off
Branch: Ask
Branch: Bounded · 2
Branch: Auto · 3
```

The collapsed state communicates whether delegation may happen and, when active, the maximum concurrent child count. Its popover contains:

- eligible runtimes, provider models, saved execution profiles, and role preferences;
- task classes that may be delegated, such as repository mapping, implementation, tests, browser verification, or independent review;
- Off, Ask before spawning, Bounded automatic, and policy-driven Auto modes;
- maximum depth, concurrent children, total children, duration, and usage/cost budgets;
- read-only, shared-root, isolated-worktree, and no-external-action boundaries;
- whether a child may delegate, which is off by default and cannot exceed the parent;
- preferred and forbidden provider/runtime/model routes;
- ordered fallback routes and the boundaries that always require renewed consent;
- required return evidence, commit behavior, merge authority, and completion criteria;
- scope and source: task override, project recipe, personal default, or managed policy.

The selector previews the effective policy in plain language: `May send read-only discovery to Codex Mini or Haiku; one child at a time; no recursive delegation; ask before any writer.` During an active run, changes are labeled `Next child` unless the broker can prove they safely constrain an unstarted queued assignment. Existing child permissions and budgets remain bound to their creation snapshot.

### 7.5 Permission selector

Default profiles:

- **Read only:** inspect files and run explicitly read-only tools.
- **Project write:** modify project roots; ask for external/network/destructive actions.
- **Ask:** prompt for every side-effecting tool class not pre-approved.
- **Full access:** broad local access with persistent warning and explicit enablement.

Project-specific named profiles can add:

- Allowed/denied paths and command prefixes.
- Network domains.
- External write rules.
- Secret-read denial.
- Deployment and purchase denial.
- Maximum child delegation depth.

The selector shows the profile name; the detailed policy appears in a popover or Inspector.

### 7.6 Draft preservation

Drafts survive:

- Switching projects or tasks.
- Opening Settings.
- Choosing a folder or cloning.
- Runtime installation/login.
- Application restart.
- Failed setup or provider connection.

## 8. Task lifecycle

### 8.1 Status model

```text
draft
  → setting_up
  → queued
  → running
      ↔ waiting_for_user
      ↔ waiting_for_permission
      ↔ waiting_for_child
      ↔ paused
  → reviewing
  → completed
  → failed | canceled
```

Every status must expose:

- Plain-language verb.
- Runtime currently responsible.
- Elapsed time.
- Whether the user can safely leave.
- Next blocking condition.
- Stop/cancel semantics.

### 8.2 Task contract

Any task can carry a structured contract:

- Goal.
- Assignment/reference files.
- In-scope and out-of-scope work.
- Required branch or worktree behavior.
- External-action prohibitions.
- Security requirements.
- Fallback paths.
- Definition of done.
- Design and UX standards.
- Preferred delegation policy.
- Budget.

The contract is editable with version history. Agents receive the current version and are notified when it changes.

### 8.3 Provider-neutral task memory

AI Integrator derives a task ledger from observable events and explicit agent returns:

- Current goal and acceptance criteria.
- Files inspected, changed, and ruled out.
- Decisions and rejected approaches.
- Commands and tests.
- Branch, commits, worktree, and dirty state.
- Artifacts and screenshots.
- Unresolved failures and uncertainty.
- Pending user choices.
- Recommended next action.

The ledger must distinguish directly observed facts from agent-authored summaries.

### 8.4 Handoff

Switching runtime creates a handoff package and a new run. The user sees:

- What context will be sent.
- What native session state cannot transfer.
- Current repository/worktree state.
- Estimated context size.
- Whether a new native session or resumed session will be used.

A handoff must never claim to transfer hidden reasoning or unavailable provider context.

## 9. Delegation system

### 9.1 Delegation principle

Agents learn when peers are useful through generated skills, but all invocation occurs through one local broker. The skill describes semantic capabilities; it does not teach fragile shell syntax or expose credentials.

### 9.2 Delegate tool

Conceptual request:

```json
{
  "runtime": "codex",
  "modelPath": "gpt-5.6-terra",
  "role": "implementation",
  "task": "Implement phases 2–4 of the attached contract",
  "access": "isolated-write-worktree",
  "budget": {
    "maxMinutes": 45,
    "maxDelegationDepth": 0
  },
  "return": [
    "summary",
    "filesInspected",
    "filesChanged",
    "commands",
    "tests",
    "risks",
    "remainingWork"
  ]
}
```

### 9.3 Generated peer-agent skill

At run start, the broker generates a concise roster containing:

- Connected runtimes and current availability.
- Model paths and supported effort modes.
- Read, write, vision, browser, and review capabilities.
- Cost/usage class: included, constrained, metered, unknown.
- Recommended roles derived from project-local history.
- Current permission and worktree constraints.
- Required child return contract.

The roster is dynamic and versioned. Static skills may add project-specific routing preferences.

### 9.4 Delegation safeguards

- Default maximum depth: 1.
- Hard maximum depth for the first release: 2.
- Maximum concurrent children is policy-controlled.
- A child may not widen its parent's access.
- Parallel writers receive separate worktrees.
- Shared-root writers require file locks or sequential execution.
- Only the designated merge authority can merge or apply child work.
- Child results return to the parent and task ledger even if the child runtime exits unexpectedly.
- Circular delegation is rejected.
- Duplicate assignments are detected and surfaced.
- Budget exhaustion pauses new children before canceling existing useful work.
- External actions and deployments require the task policy, not merely a child's permission mode.

### 9.5 Delegation UI

The default view uses a compact inline branch:

```text
Fable lead
  ├─ Haiku · repository map          done
  ├─ Codex Terra · implementation    testing
  └─ Grok 4.5 · independent review   queued
```

Selecting a child opens its full run transcript in the Inspector or a split pane. The user can steer, stop, or reassign without leaving the parent task.

### 9.6 Agent communication and transcript access

- Parents and children communicate through the local broker, not by overwriting one another's notes or polling copied transcript files.
- A child receives a bounded assignment, context references, policy/worktree snapshot, and return contract—not the full parent transcript by default.
- Parents receive child status, typed questions/notes, attention events, and structured results. Raw transcript ranges are loaded only when requested.
- Parents may read observable descendant transcript ranges. Children request specific parent ranges; sibling transcript access requires explicit parent/user grant.
- Hidden reasoning, secure terminal input, credentials, disallowed files/attachments, and unrelated task/account content never cross the boundary.
- Broker messages and transcript grants are sequenced, idempotent, redacted, auditable, and added to both runs' context manifests.
- The normative filesystem/communication contract is [Repository coordination and worktree protocol](repo-coordination-protocol.md); the callable surface is [Broker MCP contract](broker-mcp-contract.md).

## 10. Skills and customization

### 10.1 Skill layers

1. **Application skills:** installed for the user.
2. **Project skills:** checked into or attached to a project.
3. **Task skills:** attached only to one task.
4. **Generated runtime skills:** peer roster and adapter guidance generated for a run.

### 10.2 Portable skill format

The canonical AI Integrator skill stores:

- Name, description, triggers, and compatibility.
- Instructions.
- References and scripts.
- Requested broker tools.
- Permission needs.
- Runtime-specific projections.
- Verification requirements.

Adapters project the canonical skill into native mechanisms where possible. The UI must label partial compatibility and never silently discard a security requirement.

### 10.3 User-configured Claude CLI skill

Claude is not a first-class launch integration in the initial product.

The product may ship or document an optional, disabled-by-default **Local CLI Delegation** skill that a user can configure to call an already-installed `claude` binary.

Requirements:

- The user explicitly enables and configures the command.
- AI Integrator does not offer Claude account login.
- AI Integrator does not read or copy Claude OAuth tokens.
- The official CLI owns authentication and network calls.
- The connection is labeled **User-configured local command**, not “Claude integration” or “partner.”
- No promise is made about consumer-plan quota or model availability.
- PTY/raw output remains available when structured output is incomplete.
- Commercial release requires terms and counsel review even with this boundary.

The same mechanism supports any user-configured command, subject to permission policy.

## 11. Runtime architecture

### 11.1 Adapter stack

| Runtime | Preferred transport | Fallback | Initial fidelity |
|---|---|---|---|
| Codex | `codex app-server` bidirectional JSON-RPC | Codex CLI PTY | Full |
| Cursor Agent | Native ACP via `cursor-agent acp` | Structured JSONL, then interactive PTY | Full negotiated ACP capability |
| Grok Build | ACP over stdio | Streaming JSON/PTY | Full ACP capability |
| Generic ACP | ACP over stdio | None or configured PTY | Capability-driven |
| User local command | Configured process/PTY | Raw transcript | Basic |

### 11.2 Adapter contract

Every adapter implements:

- Detect installation and version.
- Report authentication status without exposing secrets.
- Reuse a documented existing CLI login when healthy; otherwise offer the vendor-owned login/update command in a user-controlled Setup terminal or browser/device-code flow.
- Discover models and capabilities when officially supported.
- List/create/resume/fork native sessions.
- Start/steer/cancel a run.
- Stream normalized events.
- Handle permission requests.
- Report usage when available.
- Export raw diagnostics.
- Produce a handoff-compatible run summary.
- Provide managed PTY/terminal integration with explicit user-versus-agent stdin ownership when the runtime is interactive.

### 11.3 Capability negotiation

The UI is capability-driven. A runtime manifest can advertise:

- Sessions: list, resume, fork, delete.
- Messaging: streaming, steering, queueing.
- Tools: typed events, terminal, file changes.
- Permissions: bidirectional, predeclared policy, PTY-only.
- Models: list, select, effort, tier.
- Worktrees: native, broker-managed, unsupported.
- Skills: native, projected, prompt-only.
- Delegation: native, broker tool, unsupported.
- Usage: tokens, credits, quota, duration, unknown.

Unsupported controls remain absent rather than disabled throughout the interface.

### 11.4 Local services

- Desktop shell and renderer.
- Local supervisor daemon.
- Runtime adapter workers.
- ACP client.
- PTY service.
- Git/worktree manager.
- Git-common repository coordination ledger and run-projection service.
- Broker MCP server with task/run-scoped authorization.
- Policy engine.
- Usage/event ledger.
- Artifact preview service.
- SQLite metadata store.
- Append-only diagnostic log with redaction.

The renderer never spawns vendor processes directly.

## 12. Usage and cost visibility

### 12.1 Confidence classes

Every number is labeled internally and in detail views as:

- **Provider-reported:** returned by an official runtime/API.
- **Locally measured:** counted from observable events.
- **Estimated:** calculated from model price or historical behavior.
- **Unknown:** not exposed or not reliably measurable.

### 12.2 User-facing surfaces

- Composer usage ring: only when useful or constrained.
- Task usage summary by run.
- Delegation graph spend by child.
- Connection dashboard: recent usage, provider quota if officially exposed, reset time if known.
- Routing history: success, latency, follow-up count, tests passed, and estimated cost by model path.

### 12.3 Auto routing

Auto routing starts as deterministic policy, not machine-learning theater.

Inputs:

- Task role: plan, implement, debug, review, research, visual QA.
- Required capabilities.
- Project and user preferences.
- Permission needs.
- Current connection health.
- Provider-reported or measured usage pressure.
- Cost class and latency target.
- Historical outcomes in this project.

The selected path is shown before execution. The user can pin or override it.

## 13. Git and environment behavior

### 13.1 Dirty-state protection

Before a writing run:

- Detect uncommitted and untracked changes.
- Attribute known AI Integrator changes when possible.
- Never discard or overwrite existing work to create a clean demo.
- Offer current checkout, isolated worktree, or read-only inspection.
- Preserve the user's exact requested branch constraint.

### 13.2 Worktree rules

- Default parallel writers to separate worktrees.
- Name branches predictably with a configurable prefix.
- Show base branch and divergence.
- Warn before archiving with uncommitted changes.
- Keep child worktrees until parent acceptance or explicit cleanup.
- Provide one-click compare, apply, merge, and discard with dry-run information.
- Pair every writing task/child with one visible worktree lease; selecting the child selects the same worktree in Files, Terminal, Review, and Git.
- Resolve one coordination ledger through `git rev-parse --git-common-dir` so linked worktrees reference the same task state rather than copying transcripts/notes.

### 13.3 Git GUI

- Bind Git status, diff, stage/unstage, commit, fetch, pull/rebase/merge, publish branch, push, and PR actions to the selected task/run/worktree lease.
- Stage/unstage and discard work at file/hunk scope with stale-content and dirty-work protection.
- Commit messages are editable drafts; Commit never implies Push unless an explicit policy says so.
- Push preview names remote/host/repository, branch/refspec/upstream, protection, ahead/behind, commits, auth owner, and force status.
- Push, PR, merge, deployment, and cleanup remain distinct explicit actions.
- Timeout/disconnect after push is `Outcome uncertain`; check the remote ref before offering retry.
- Child acceptance opens review/integration; it never silently stages, commits, pushes, merges, or deletes the paired worktree.

### 13.4 Clone rules

- Verify destination remains within the selected parent.
- Do not clone with embedded credentials in visible logs.
- Detect default branch and submodules.
- Let setup scripts run only after policy evaluation.

## 14. Security and trust

### 14.1 Credential boundary

- Vendor credentials remain in vendor-owned stores.
- AI Integrator invokes login/status commands and reads only documented status output.
- If the CLI is already authenticated, use it after health/capability probing. If it is signed out, launch its official login command through a dedicated user-owned Setup terminal or vendor browser/device-code flow and re-probe afterward.
- Setup terminals are not model-visible by default; password, token, MFA, hardware-key, and no-echo input are never persisted or sent to an agent.
- Never print, summarize, synchronize, or export secrets.
- Redact environment variables and command output using configurable patterns.

### 14.2 Permission hierarchy

Effective permission is the intersection of:

1. Optional signed managed-machine policy.
2. Local user profile.
3. Project policy.
4. Task contract.
5. Parent-run access.
6. Child-run request.
7. Runtime-native sandbox.

No lower layer can widen a higher layer.

### 14.3 External action classes

Separate local edits from:

- Network access.
- Git push and PR creation.
- Deployment.
- Production data mutation.
- Messaging/email.
- Purchases or paid resources.
- Credential creation.

Each class has explicit allow/ask/deny policy.

### 14.4 Auditability

Record:

- Effective policy and changes.
- Permission requests and decisions.
- Run/runtime/model identity.
- Delegation lineage.
- Commands and exit status.
- File changes and Git state.
- Tests and artifacts.
- Usage confidence source.
- Transport/runtime errors.

Audit logs must be exportable with secret redaction.

## 15. Failure and recovery

The product must treat failure recovery as a primary experience.

### 15.1 Runtime missing

- Preserve draft.
- Show Install, Locate binary, Retry.
- Use vendor documentation link.
- Never auto-install without confirmation.

### 15.2 Authentication required

- Launch vendor-owned login.
- Poll documented status.
- Return to the preserved task automatically.

### 15.3 Runtime update breaks parsing

- Fall back to PTY/raw mode.
- Mark reduced fidelity.
- Keep stop/cancel and process ownership.
- Export a sanitized compatibility report.

### 15.4 App restart or crash

- Rehydrate tasks and native-session ids.
- Detect orphaned child processes.
- Offer reconnect, terminate, or mark lost.
- Preserve raw event tail and worktree state.

### 15.5 Context or quota exhaustion

- Show which run is constrained.
- Offer compact, handoff, cheaper model path, or wait.
- Never silently switch a paid model path unless the task policy explicitly allows fallback.

## 16. Notifications

Notify only for:

- Permission or user decision required.
- Run failed and cannot self-recover.
- Task completed.
- Budget threshold reached.
- Merge/deployment ready.

Do not notify for routine child completion when the parent remains active unless requested.

## 17. First-release scope

### 17.1 Polished v1 MVP

- One signed Windows/macOS desktop application from a shared Tauri 2, Rust, React, and TypeScript codebase.
- Local projects and standalone tasks.
- Open folder and clone-and-start.
- Hierarchical project/task sidebar.
- Persistent composer and draft recovery.
- Codex app-server adapter.
- Cursor ACP adapter with structured-run and PTY fallbacks.
- Capability-gated Preview discovery for Grok and other ACP adapters; they do not enter the v1 release gate until certified.
- Existing authenticated CLI reuse plus vendor-owned login through browser/device flow or a user-controlled Setup terminal when required.
- Runtime/model/effort selector.
- Lower-right execution-route and delegation-policy composer controls.
- Read-only, project-write, ask, and full-access profiles.
- Task contract and definition of done.
- One-level brokered delegation.
- Broker-managed worktrees.
- Standardized Git-common task ledger, worktree-local run projections, brokered agent mailboxes, and on-demand transcript references.
- Task-paired Git GUI with diff, stage/unstage, commit, publish branch/push, and protected integration/cleanup flows.
- Effective-context manifests, context-pressure truth, safe compaction, and provider-neutral handoff boundaries.
- Supervised interactive terminals with explicit stdin ownership, secret-safe prompts, process-tree cleanup, and Windows/PowerShell/WSL identity.
- Source-aware usage, reset/headroom uncertainty, mid-run limit recovery, boundary-aware fallback, and child-budget reconciliation.
- Runtime/adapter provenance, compatibility gates, safe app/adapter updates, PATH-drift detection, and emergency feature disablement.
- Opaque secret references, scoped environment profiles, deny-by-default child inheritance, `.env` protection, and redaction validation.
- Causal checkpoints, idempotence-aware retry, scoped rollback, and evidence invalidation.
- Normalized events, artifacts, diffs, approvals, and evidence.
- Local measured usage and provider-reported usage where available.
- Portable project/task skills.
- Reduced motion and complete keyboard navigation.
- Full-screen Settings whose category navigation replaces project/task navigation.
- Twelve semantic theme presets plus customizable interface/code fonts, density, radius, motion, and accessible color tokens.
- Local settings/task export and import, data-location controls, redacted diagnostics, and uninstall keep/delete choice.

### 17.2 Beta

- Generic ACP agent catalog.
- Runtime installation/update assistance.
- Automatic provider-neutral handoffs.
- Usage-aware deterministic Auto routing.
- Preview/browser pane and screenshot comparison.
- Side questions/task forks.
- Optional user-configured local CLI skill.

### 17.3 Later

- Any Integrator account/backend re-architecture, including team identity, remote daemon, mobile control, cross-device sync, or hosted audit.
- Schedules/automations.
- Best-of-N worktree comparison.
- Shared skill/delegation recipe marketplace.
- Opt-in local outcome learning.
- Cloud/SSH environments.

## 18. Success metrics

### 18.1 Activation

- User connects one runtime and completes a task.
- User connects a second runtime.
- Time from installation to first useful run.

### 18.2 Core value

- Percentage of multi-runtime users who perform a handoff or delegation weekly.
- Handoffs completed without manual context paste.
- Delegated runs accepted by the parent without reassignment.
- Reduction in expensive-lead token/credit usage for comparable outcomes.
- Tasks completed with evidence and no policy violations.

### 18.3 Quality

- Crash-free sessions.
- Successful process recovery after restart.
- Parser fallback success after unsupported runtime updates.
- Permission request response latency.
- Worktree conflict and accidental overwrite rate.
- Accessibility and keyboard-only completion rate.

### 18.4 Retention signal

The strongest signal is not number of installed agents. It is repeated use of the same task across more than one runtime with accepted evidence.

## 19. Product decisions

### 19.1 Decisions made

- The durable unit is a task.
- Runtime/model selection is per turn and compact.
- Codex and Cursor are the certified v1 launch runtimes; other ACP routes are capability-gated until their conformance suites pass.
- ACP is the primary extension protocol.
- Claude is available only through an optional user-configured local CLI skill in the initial product.
- The broker mediates all cross-agent delegation.
- Auto routing is transparent and deterministic before it becomes adaptive.
- Usage numbers carry provenance/confidence.
- Worktrees are the default isolation mechanism for parallel writers.
- The visual tone is restrained, themeable, softly rounded, and motion-light; dark and light presets are equally supported and purple is not the product accent.
- Tauri 2 with a Rust core and shared React/TypeScript UI is the v1 architecture. Electron is the bounded fallback only if the native PTY/WebView spike fails.

### 19.2 Decisions requiring prototype validation

- Minimum supported Windows/macOS versions, Windows ARM64 launch timing, and signing/updater-key custody.
- Whether the Inspector defaults open above 1600 px.
- Whether standalone tasks live in a separate sidebar group or a synthetic project.
- Whether a task fork appears as a sibling task or child run.
- How much normalized tool activity belongs in Standard density.
- Whether user-configured command skills are permitted in the signed-store build.

## 20. Launch acceptance gates

The MVP is not complete until all gates pass.

### 20.1 Task and navigation

- A user can start from a project, a standalone draft, a local folder, or a Git URL.
- No draft is lost during setup, login, update, restart, or navigation.
- Project and task concepts are visually and semantically distinct.

### 20.2 Runtime fidelity

- Codex supports native session listing/resume, streamed turns, typed tools, permissions, model/effort, and usage.
- Cursor supports structured runs, session resume where exposed, raw fallback, and clear permission limitations.
- Grok supports ACP sessions, streaming, model selection, permissions, and cancel.
- Existing documented CLI authentication is reused without credential import; logged-out setup completes through the vendor flow and returns to the preserved task.
- User task, Setup/login, agent process, and external terminal classes retain distinct ownership, visibility, and persistence behavior.

### 20.3 Delegation

- A lead run can delegate a bounded read or write task to another connected runtime.
- Child access cannot exceed parent policy.
- Parallel write children use separate worktrees.
- Child evidence returns to the parent and task ledger.
- Parent/child messages and scoped transcript reads are authorized, redacted, sequenced, idempotent, and context-manifested; siblings receive no unrestricted transcript access.
- Recursive/circular delegation and budget overflow are prevented.

### 20.4 Git and coordination

- Main checkout and linked worktrees resolve one Git-common coordination ledger; run projections are ignored and regenerable.
- Agents read standardized assignment/state and write only run-owned scratch/notes; shared decisions/evidence/messages/results are broker-validated.
- Every writing child is paired to one visible worktree lease across Files, Terminal, Review, and Git.
- A user can review, stage/unstage, commit, publish/push, and integrate from the selected worktree without invoking the wrong checkout.
- Commit, push, PR, merge, deployment, and cleanup remain separate actions with remote/protection/auth/outcome checks.

### 20.5 Safety

- Secrets are not exposed in UI logs or export fixtures.
- Dirty work is never overwritten by setup or worktree operations.
- Deployment and production mutations remain blocked unless explicitly allowed.
- Full access cannot be enabled accidentally through keyboard focus or a single ambiguous click.
- Coordination/runtime projection files and secure terminal data cannot be staged, committed, pushed, or exported accidentally.

### 20.6 Design

- All components use the design and motion tokens in the companion design document.
- Core components meet the state, persistence, fallback, performance, and test contracts in [Agent workspace UI/UX primitives](ui-ux-primitives.md).
- The MVP-applicable P0 behaviors assigned by the [Delivery and criticality matrix](delivery-criticality-matrix.md) pass their Codex, ACP, no-capability, restart, accessibility, and redaction acceptance checks. Feature-gated P0 behavior becomes mandatory before that Beta/Later feature is enabled; it does not pull the whole parent feature into MVP.
- The app remains fully usable with reduced motion.
- Keyboard-only users can open a project, create a task, select a runtime, approve/deny, review a diff, and stop a run.
- Status is never communicated by animation or color alone.

### 20.7 Critical systems

- Every MVP-applicable C0/C1 item in [Critical systems primitives](critical-systems-primitives.md) passes its happy, degraded, restart/reconnect, and adversarial acceptance fixtures.
- Execution route and delegation policy are visible in the composer before Send and preserved as immutable run/child snapshots.
- Context compaction, repository/worktree operations, terminal input, model fallback, updates, secret use, retry, and rollback never cross an unreviewed authority/data/billing boundary.
- Later C0 requirements gate their associated feature—such as SSH or remote control—rather than expanding MVP scope.

## 21. Primary source basis

- [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
- [Codex projects, chats, and tasks](https://learn.chatgpt.com/docs/projects)
- [Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [Codex Windows app](https://learn.chatgpt.com/docs/windows/windows-app)
- [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Claude Code Desktop](https://code.claude.com/docs/en/desktop)
- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Cursor 3.0](https://cursor.com/changelog/3-0)
- [Cursor CLI](https://docs.cursor.com/en/cli/overview)
- [Cursor ACP registry entry](https://agentclientprotocol.com/registry)
- [Grok Build](https://docs.x.ai/build/overview)
- [Grok modes and commands](https://docs.x.ai/build/modes-and-commands)
- [Agent Client Protocol](https://agentclientprotocol.com/)
- [ACP registry](https://agentclientprotocol.com/registry)
