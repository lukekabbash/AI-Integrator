# AI Integrator — User Stories and Acceptance Criteria

**Priority key**

- **P0:** required for the first usable release.
- **P1:** required for public beta.
- **P2:** later expansion.

## 1. Personas

### 1.1 Solo multi-subscription builder

Pays for ChatGPT/Codex, Cursor, and possibly Grok or Copilot. Chooses different agents for planning, implementation, UI work, and review. Their pain is repeated setup, scattered sessions, lost context, and uncertain usage.

### 1.2 Technical lead supervising parallel work

Owns architecture and quality while several agent runs explore, implement, test, or review in parallel. Their pain is cognitive load, conflicting edits, weak handoffs, and insufficient evidence.

### 1.3 Product-minded founder or designer

Can describe outcomes and assess UI quality but does not want to manage terminal sessions, worktrees, or model-specific configuration. Their pain is translating product intent into safe technical execution.

### 1.4 Runtime power user

Maintains custom skills, MCP servers, hooks, local CLIs, models, and routing preferences. Their pain is incompatibility and repeated configuration across harnesses.

### 1.5 Security-conscious team administrator

Needs deterministic boundaries, audit trails, secret protection, and clear external-action approvals. Their pain is inconsistent permission systems across agents.

## 2. North-star journey

1. The user opens AI Integrator and sees recent projects and active tasks.
2. They create a task and attach an assignment-contract Markdown file.
3. They choose a project or paste a Git URL without losing the draft.
4. The composer inherits project permissions and offers a compact execution profile.
5. A high-judgment lead agent reads the contract and delegates repository discovery to cheap readers and implementation to Codex.
6. Each child runs with bounded access and returns structured evidence.
7. The user sees a calm delegation graph, usage by run, current blockers, and one consolidated diff.
8. The lead reviews the implementation against the contract.
9. The user switches the task to another runtime for an independent review without manually pasting context.
10. The task completes with tests, screenshots, commits, gaps, and a provider-neutral handoff.

## 3. Epic A — Onboarding and connections

### US-A1 — Detect installed runtimes

**Priority:** P0  
**As a** new user  
**I want** AI Integrator to detect installed Codex, Cursor Agent, and Grok Build runtimes  
**So that** I can start without finding binary paths manually.

**Acceptance criteria**

- The application checks documented binary names and configured search paths.
- It reports binary path, version, transport options, and compatibility.
- It does not read credential files.
- Missing runtimes show Locate, Install instructions, and Dismiss.
- Detection can be rerun.
- A failed or slow binary does not block the rest of onboarding.

### US-A2 — Complete vendor-owned login

**Priority:** P0  
**As a** user with an installed but signed-out runtime  
**I want** to launch its official login flow  
**So that** AI Integrator never handles my password or OAuth token.

**Acceptance criteria**

- Login invokes the documented vendor command.
- A healthy existing CLI login goes directly to capability/compatibility probing; Integrator does not force a second login.
- The vendor owns browser/device authorization.
- Interactive login may run in a dedicated user-controlled Setup terminal with a real PTY and no model visibility.
- AI Integrator polls only documented status output.
- The current draft and setup choices remain intact.
- Canceling login returns safely to the connection screen.
- Logs redact tokens, codes, callback URLs containing secrets, and sensitive environment values.
- Password/no-echo input, MFA, hardware-key prompts, and account/workspace selection remain in vendor, OS, or protected user-input surfaces and are never sent to an agent.

### US-A3 — Understand reduced-fidelity mode

**Priority:** P0  
**As a** user whose CLI version is unsupported  
**I want** a raw-terminal fallback  
**So that** I can continue working while the structured adapter catches up.

**Acceptance criteria**

- The product explains which rich features are temporarily unavailable.
- It can launch the official interactive runtime in a managed PTY.
- Stop, detach, reconnect, and terminate remain available.
- Raw mode is visually labeled.
- A sanitized compatibility report can be exported.

### US-A4 — Add an ACP agent

**Priority:** P1  
**As a** power user  
**I want** to add an ACP-compatible command  
**So that** I can use Kilo, Kiro, OpenCode, Cline, Goose, or another compatible agent.

**Acceptance criteria**

- The user supplies command, arguments, environment references, and optional display metadata.
- AI Integrator performs ACP initialization and capability negotiation.
- Unsupported capabilities are omitted from the UI.
- The command cannot receive secrets unless explicitly mapped through a secure reference.
- The connection can be disabled or removed without deleting native sessions.

### US-A5 — Enable a local Claude CLI delegation skill

**Priority:** P1  
**As a** user who already has Claude CLI installed and authenticated  
**I want** to enable a local command skill  
**So that** another agent may delegate a bounded task to my local CLI.

**Acceptance criteria**

- The feature is disabled by default.
- The user explicitly selects or confirms the local command.
- It is labeled User-configured local command.
- AI Integrator does not offer Claude account login or read Claude OAuth tokens.
- The skill clearly states available fidelity and usage limitations.
- Permission and delegation policies still apply.
- Removing the skill removes AI Integrator configuration only.

## 4. Epic B — Projects, tasks, and repositories

### US-B1 — Start a task immediately

**Priority:** P0  
**As a** user with an idea  
**I want** to type before choosing a folder  
**So that** setup does not interrupt intent.

**Acceptance criteria**

- New task focuses the composer immediately.
- The draft is autosaved.
- If local files are required, context selection appears inline on send.
- Choosing context never clears the draft.
- Self-contained work can run as a standalone task.

### US-B2 — Open a local project

**Priority:** P0  
**As a** developer  
**I want** to open a folder as a project  
**So that** related tasks share the correct file roots and guidance.

**Acceptance criteria**

- Canonical paths prevent duplicate projects for the same folder.
- Git root, branch, dirty state, nested repositories, and guidance files are detected.
- Project defaults are shown before the first writing turn.
- Non-Git folders remain usable with worktree features hidden.
- The project appears in the sidebar with its tasks nested beneath it.

### US-B3 — Clone and start from a Git URL

**Priority:** P0  
**As a** user receiving a repository link  
**I want** to clone and start a task in one flow  
**So that** repository setup feels like context selection rather than a separate tool.

**Acceptance criteria**

- A pasted supported Git URL becomes a Clone and start chip.
- The user selects a safe destination.
- Clone output is available but collapsed by default.
- Embedded credentials are never displayed.
- Checkout and repository health are verified before the agent starts.
- Failure preserves the task and offers retry/edit destination.

### US-B4 — Distinguish projects, tasks, and chats

**Priority:** P0  
**As a** user returning after several days  
**I want** clear hierarchy  
**So that** I know whether I am opening a codebase, an outcome, or a casual conversation.

**Acceptance criteria**

- Projects are folder/repository containers.
- Tasks are outcome-oriented records nested under projects or Standalone.
- Quick chat, if available, is in a distinct section.
- Search results label type and location.
- Rename, pin, archive, and delete use the correct noun.

### US-B5 — Preserve dirty work

**Priority:** P0  
**As a** developer with uncommitted changes  
**I want** the product to detect and protect them  
**So that** an agent cannot erase or silently overwrite my work.

**Acceptance criteria**

- Dirty and untracked files are detected before writing.
- The product offers current checkout, isolated worktree, or read-only inspection.
- It never invokes destructive reset/checkout automatically.
- Conflicting files are identified before applying child changes.
- Existing work remains intact after task cancellation or setup failure.

### US-B6 — Return to active work quickly

**Priority:** P0  
**As a** user with many tasks  
**I want** running and waiting tasks surfaced  
**So that** I can respond without scanning every project.

**Acceptance criteria**

- Sidebar filters include Running, Needs attention, Completed, and All.
- Aggregate counts are quiet and accurate.
- Selecting a notification opens the exact blocking event.
- The prior reading position is restored when returning.

### US-B7 — Reuse standardized task knowledge across worktrees

**Priority:** P0  
**As a** user running several agents in one repository  
**I want** one standardized task ledger and small per-run scratch files  
**So that** agents continue from accepted knowledge instead of repeatedly rediscovering and copying the same context.

**Acceptance criteria**

- Durable project knowledge may live in an explicitly adopted `.aiintegrator/` directory that references rather than copies existing authoritative docs.
- Temporary task/run state lives once under the Git common directory and is shared by linked worktrees.
- Each run owns only its scratch/notes projection; it cannot overwrite parent or sibling notes.
- Contract, current state, decisions, evidence, messages, results, transcript references, checkpoints, and worktree leases have standardized versioned files.
- Full transcripts and artifacts are referenced by id/hash/range rather than copied into every worktree.
- Scratch facts become shared only through broker validation/promotion, and project-durable notes require explicit acceptance.
- `.aiintegrator/.runtime/` projections are excluded from Git and can be regenerated.

## 5. Epic C — Composer and execution selection

### US-C1 — Choose runtime/model like reasoning effort

**Priority:** P0  
**As a** multi-subscription user  
**I want** one compact execution-profile selector  
**So that** choosing Codex, Cursor, or Grok is not a disruptive mode switch.

**Acceptance criteria**

- Every option shows runtime + model + tier/effort.
- The collapsed route selector is in the lower-right composer group immediately before voice and Send/stop.
- Favorite and recent profiles appear first.
- Search works across model, runtime, provider, and role.
- The selection is per turn and remembered per task.
- Choosing a runtime does not navigate away or rebuild the screen.
- The user can inspect connection and usage details without leaving the task.
- Changing the route during execution clearly targets the next turn, fork, or handoff rather than relabeling the current run.

### US-C2 — Use transparent Auto routing

**Priority:** P1  
**As a** user who does not want to benchmark every model  
**I want** Auto to choose a suitable connected execution path  
**So that** routine choices become effortless.

**Acceptance criteria**

- Auto evaluates task role, capability, policy, availability, usage pressure, and project preference.
- The selected execution path is shown before the run starts.
- The user can cancel or change it.
- A concise explanation is available.
- Auto never silently crosses a metered-cost or external-action boundary.

### US-C3 — Set permissions without opening Settings

**Priority:** P0  
**As a** user starting a sensitive task  
**I want** a compact permission selector in the composer  
**So that** autonomy is clear before I send.

**Acceptance criteria**

- Read only, Project write, Ask, and Full access are visible profiles.
- The effective project policy is summarized.
- Full access requires explicit enablement and cannot be selected accidentally.
- Changing permissions mid-task affects the next tool/run as documented.
- Child runs cannot exceed parent permissions.

### US-C4 — Attach a task contract

**Priority:** P0  
**As a** user with a product brief or issue  
**I want** to attach it as the assignment contract  
**So that** success criteria persist beyond the first prompt.

**Acceptance criteria**

- Markdown/text/PDF contract files can be attached.
- The user can mark one artifact as authoritative contract.
- The contract view extracts goal, constraints, and definition of done for confirmation.
- The original file remains accessible.
- Editing the structured contract creates a version.
- Every run records which contract version it received.

### US-C5 — Preserve and queue follow-up prompts

**Priority:** P0  
**As a** user observing an active run  
**I want** to steer or queue a follow-up  
**So that** I do not wait or lose an idea.

**Acceptance criteria**

- Adapters supporting steering receive the message in flight.
- Other adapters queue it for the next turn.
- The UI clearly labels Steer now versus Send next.
- Queued prompts can be edited or removed.
- The transcript records when the instruction became active.

### US-C6 — Set delegation rules from the composer

**Priority:** P0  
**As a** user combining expensive lead models with cheaper or subscription-backed workers  
**I want** a compact delegation-policy control beside the execution route  
**So that** I can decide who may delegate to whom without opening Settings or writing routing prose every turn.

**Acceptance criteria**

- The lower-right composer group contains `Delegation → Route/model → Voice → Send/stop` in that order.
- Collapsed delegation states are Off, Ask, Bounded, and Auto, with a quiet active-child limit/count when relevant.
- The popover controls eligible runtimes/models, roles, task classes, depth, concurrency, duration, usage budget, fallbacks, worktree isolation, child delegation, merge authority, and required return evidence.
- A plain-language preview explains the effective rule before Send.
- Scope and provenance distinguish task override, project recipe, personal default, and managed policy.
- A child cannot widen parent permissions, provider allowlists, external-action policy, budget, or depth.
- Mid-run edits say `Next child`; existing child launch snapshots remain inspectable.

## 6. Epic D — Running and supervising work

### US-D1 — Understand current activity

**Priority:** P0  
**As a** user supervising a long task  
**I want** a precise current-status line  
**So that** I know whether the agent is progressing or blocked.

**Acceptance criteria**

- Status uses a verb such as Reading, Implementing, Testing, Waiting, or Reviewing.
- Runtime/model and elapsed time are available.
- The last observable event is shown after prolonged silence.
- Indeterminate animation is not the only signal.
- The status is available from the sidebar and task canvas.

### US-D2 — Choose transcript density

**Priority:** P0  
**As a** user balancing oversight and readability  
**I want** Summary, Normal, and Verbose views  
**So that** I can scan normally and debug when necessary.

**Acceptance criteria**

- Summary shows messages, final changes, artifacts, and important decisions.
- Normal groups tools by phase.
- Verbose exposes every runtime-delivered activity item and reasoning summary.
- Raw diagnostics are a separate redacted view and are never the default.
- Reasoning, observable activity, and final response are labeled separately.
- Missing reasoning is never inferred from tool activity.
- Changing density does not alter model context.
- The choice persists per user.

### US-D3 — Answer an approval in context

**Priority:** P0  
**As a** user  
**I want** approvals anchored to the requesting run  
**So that** I understand exactly what I am authorizing.

**Acceptance criteria**

- The card names runtime, child/parent, command/tool, scope, and reason.
- Allow once, allow for session/profile where supported, and deny are distinct.
- The default focus is not the broadest allow action.
- Decisions are logged.
- Notifications deep-link to the request.
- Expired requests cannot be approved accidentally.

### US-D4 — Ask a side question

**Priority:** P1  
**As a** user reading a result  
**I want** to ask a contextual question without steering the main task  
**So that** I can learn without derailing execution.

**Acceptance criteria**

- The side question can read the main task up to the fork point.
- Its messages do not enter the main task context unless promoted.
- It opens as a peek, Inspector, or split.
- The user can convert a useful result into a main-task note or child assignment.

### US-D5 — Stop safely

**Priority:** P0  
**As a** user who sees unwanted activity  
**I want** stop semantics I can trust  
**So that** I can prevent additional actions.

**Acceptance criteria**

- Stop interrupts the current run where supported.
- Stop all terminates or interrupts descendants after confirmation.
- The UI distinguishes cancel request sent, process stopped, and cleanup complete.
- Partial changes and worktree state remain reviewable.
- No merge, push, deployment, or child spawn begins after stop acceptance.

### US-D6 — Open and reuse a referenced file

**Priority:** P0  
**As a** user reading an agent response  
**I want** every file path to be actionable  
**So that** I can inspect, edit, attach, or locate the file without hunting for it.

**Acceptance criteria**

- Clicking a local text file opens it at the referenced line in the file pane or configured editor.
- The path menu includes Attach as context, Open in, Reveal in Explorer/Finder, Open containing folder in terminal, and Copy path.
- The file pane distinguishes unsaved edits from Git dirty state.
- External modification triggers a Compare, Reload, Overwrite, or Save As decision.
- Selecting lines can create a line-range context chip for the next prompt.
- Binary, very large, missing, and outside-permission files get explicit fallback states.

### US-D7 — Use a task or setup terminal safely

**Priority:** P0  
**As a** developer or user completing CLI setup  
**I want** an integrated terminal tied to the correct task/worktree or login flow  
**So that** I can work interactively without leaving the app or exposing credentials to an agent.

**Acceptance criteria**

- New task terminals inherit the selected task, worktree, environment, and shell after showing that identity.
- Setup/login terminals are user-owned, not model-visible by default, and return to the blocked connection after completion.
- Agent process terminals visibly show agent/user stdin ownership and support explicit takeover/return.
- Password/no-echo input uses a protected surface and is absent from transcripts, logs, drafts, search, diagnostics, and accessibility output.
- PTY apps, resize, tabs/splits, search/copy, detach, process-tree stop, and truthful exit state work on supported platforms.
- Attaching terminal output to a prompt is explicit, bounded, and redacted.

## 7. Epic E — Delegation and peer-agent skills

### US-E1 — Delegate to another connected agent

**Priority:** P0  
**As a** lead agent  
**I want** a brokered delegate tool  
**So that** I can commission bounded specialist work safely.

**Acceptance criteria**

- The request includes runtime/model role, assignment, access, budget, and return contract.
- The broker validates connection, capability, policy, and budget.
- A child run is created with lineage.
- The parent receives child status and structured result.
- The child never receives vendor credentials from AI Integrator.

### US-E2 — Give each agent a dynamic peer roster

**Priority:** P0  
**As a** connected lead model  
**I want** a concise generated skill describing available peers  
**So that** I know when and how to delegate.

**Acceptance criteria**

- The roster includes only currently connected/allowed peers.
- It describes capabilities, cost class, permission boundary, and recommended roles.
- It uses semantic delegate tools rather than raw command instructions.
- It is regenerated when connections or policy change.
- It is small enough not to pollute every prompt.

### US-E3 — Use cheap readers before an expensive lead explores

**Priority:** P1  
**As a** cost-conscious user  
**I want** repository mapping and log triage routed to efficient agents  
**So that** the lead spends tokens on judgment rather than mechanical discovery.

**Acceptance criteria**

- A routing recipe can assign read-only discovery to configured efficient profiles.
- Readers return files inspected, relevant excerpts/references, exclusions, and uncertainty.
- The parent receives a deduplicated result.
- Readers cannot write or recursively delegate unless explicitly allowed.
- Usage savings and added latency are visible.

### US-E4 — Delegate implementation to Codex

**Priority:** P0  
**As a** user using another lead model  
**I want** implementation delegated to Codex  
**So that** I can use Codex persistence and my existing subscription for execution.

**Acceptance criteria**

- The child receives the contract, bounded assignment, repository state, and required evidence.
- A writing child receives a worktree unless current-checkout access was explicitly chosen.
- Codex model and effort are selectable or policy-driven.
- Tests, screenshots, commands, diffs, commits, gaps, and remaining work return in the child contract.
- The parent can request a follow-up on the same native child session.

### US-E5 — Prevent delegation storms

**Priority:** P0  
**As a** user  
**I want** bounded delegation  
**So that** agents cannot consume unlimited quota or create uncontrolled concurrency.

**Acceptance criteria**

- Default depth is one.
- Concurrency, duration, and optional usage budgets are enforceable.
- Circular and duplicate delegation is detected.
- A child cannot widen its own depth or budget.
- Reaching a threshold pauses new delegation and asks the designated supervisor.
- Existing useful child results are preserved.

### US-E6 — Compare candidates in isolated worktrees

**Priority:** P2  
**As a** technical lead  
**I want** two agents to solve the same task independently  
**So that** I can compare evidence rather than debate models abstractly.

**Acceptance criteria**

- Each candidate has the same base commit and contract.
- Each writes to an isolated worktree.
- Comparison includes diff size, tests, screenshots, elapsed time, usage, and review findings.
- No candidate is auto-merged solely from model self-rating.
- The user can choose, combine through a new task, or discard.

### US-E7 — Inspect and control a child agent

**Priority:** P0  
**As a** user supervising delegated work  
**I want** to open, steer, and stop each child independently  
**So that** delegation stays observable and controllable.

**Acceptance criteria**

- Each child shows runtime, model, effort, brief, workspace/worktree, inherited permissions, status, current activity, elapsed time, usage confidence, and result.
- Opening a child shows its native transcript when available, with a clear summary-only fallback otherwise.
- Guidance is delivered to the native child session when supported; otherwise it creates an explicit follow-up run.
- Stop affects only the selected child unless Stop all is confirmed.
- A background child that could not request permission reports that exact reason.
- Closing a completed child does not delete its evidence or lineage.

### US-E8 — Communicate with children and inspect transcripts on demand

**Priority:** P0  
**As a** lead agent or supervising user  
**I want** brokered messages and scoped transcript reads  
**So that** agents can coordinate without copying every conversation or leaking unrelated context.

**Acceptance criteria**

- Children receive bounded assignments/context references, not the full parent transcript by default.
- Parent/child guidance, questions, answers, context requests/grants, and corrections have delivery/activation state and idempotency.
- Parents may read observable descendant transcript ranges; children request minimal parent ranges; sibling access requires explicit grant.
- Transcript reads are cursor/range/size bounded, redacted, and added to both runs' context manifests.
- Hidden reasoning, secure terminal input, credentials, unauthorized files, and unrelated task/account content are never exposed.
- Native steering/messaging is used when supported; otherwise the UI labels a queued or follow-up run boundary.
- Structured results/evidence are preferred over transcript scraping for routine coordination.

## 8. Epic F — Review, evidence, and handoff

### US-F1 — Review one consolidated diff

**Priority:** P0  
**As a** user  
**I want** changes grouped by task and run  
**So that** multiple agents do not create an incoherent review experience.

**Acceptance criteria**

- Files identify producing run/worktree.
- The user can switch among Unstaged, Staged, Commit, Branch, Last turn, and reliable per-agent/per-turn scopes.
- The user can review unified or split.
- Stage, unstage, and revert work at diff, file, and hunk level with stale-file protection.
- Evidence and tests relevant to a file are linked.
- Inline comments can be batched, routed to the responsible run or lead, and marked stale when their hunk changes.
- Applying/merging shows target and conflicts before mutation.

### US-F2 — Verify definition of done

**Priority:** P0  
**As a** user with an assignment contract  
**I want** completion checked requirement by requirement  
**So that** “done” means more than the agent stopping.

**Acceptance criteria**

- Each contract requirement is marked proven, contradicted, incomplete, weak, or missing.
- Evidence links to observable records or artifacts.
- An agent-authored claim without evidence is labeled unverified.
- The task cannot show Verified complete while required items remain missing.
- The user may explicitly accept a documented gap.

### US-F3 — Switch runtime without manual context paste

**Priority:** P0  
**As a** multi-agent user  
**I want** to continue the task with another runtime  
**So that** I can get a second opinion or use a specialist.

**Acceptance criteria**

- The handoff includes goal, constraints, decisions, rejected paths, files, Git state, evidence, gaps, and next action.
- Observed facts and generated summary are distinguished.
- The UI explains that hidden reasoning/native context cannot transfer.
- The user previews and edits the package.
- The new run is linked to the prior lineage.

### US-F4 — Produce a durable final handoff

**Priority:** P0  
**As a** user ending a work session  
**I want** a concise handoff artifact  
**So that** a human or future agent can continue accurately.

**Acceptance criteria**

- It includes current branch/worktree and commit state.
- It lists completed work, validation, artifacts, gaps, and next commands/actions.
- It avoids secrets and sensitive raw output.
- It can be saved to the project or copied.
- The artifact records source runs and contract version.

### US-F5 — Inspect screenshots and UI fidelity

**Priority:** P1  
**As a** product-minded user  
**I want** before/after screenshots and annotations  
**So that** visual quality is reviewed as evidence.

**Acceptance criteria**

- Runs can attach screenshots with viewport and route metadata.
- Before/after or reference/output images can be compared.
- The user can annotate a region and send it to a run.
- Mobile and desktop viewport requirements can be tracked separately.
- Image evidence is included in completion audit.

### US-F6 — Commit and push the selected worktree visually

**Priority:** P0  
**As a** user reviewing agent work  
**I want** GitHub Desktop-style diff, commit, publish, and push controls paired to each task/worktree  
**So that** I can finish work safely without hunting for branches or typing routine Git commands.

**Acceptance criteria**

- Selecting a task/child selects the same worktree in Files, Terminal, Review, and Git.
- The pane shows canonical path, branch/base, lease owner, dirty/staged/untracked/conflict counts, ahead/behind, upstream, unpushed commits, and staleness.
- Stage/unstage/discard operates at file/hunk scope with stale and existing-work protection.
- Commit summary/description are editable; generated messages remain drafts.
- Commit, Publish branch, Push, Pull/Rebase/Merge, Create/Open PR, and cleanup are separate actions.
- Push previews remote host/repository, refspec/upstream, protection, commits, auth owner, and force status.
- A timeout after push checks remote state before retry and cannot duplicate an external mutation.
- Accepting child work opens review/integration; it does not silently commit, push, merge, or delete the worktree.

## 9. Epic G — Usage and routing

### US-G1 — See usage by run

**Priority:** P0  
**As a** cost-conscious user  
**I want** usage attributed to each runtime/model child  
**So that** I understand where the task spent resources.

**Acceptance criteria**

- Tokens, requests, credits, duration, and tool calls are shown when available.
- Every metric is labeled provider-reported, locally measured, estimated, or unknown.
- Parent and child usage roll up without double counting.
- The user can inspect raw source metadata.

### US-G2 — See subscription pressure honestly

**Priority:** P1  
**As a** user on several subscriptions  
**I want** remaining quota shown only when reliable  
**So that** I do not route work based on invented precision.

**Acceptance criteria**

- Official remaining/reset values are labeled provider-reported.
- If a provider exposes no quota, the UI says Not exposed.
- Local trends may be shown as estimates with methodology.
- AI Integrator never scrapes private credential endpoints to manufacture a number.

### US-G3 — Create a cost-aware routing recipe

**Priority:** P1  
**As a** power user  
**I want** rules such as “Fable plans, Codex implements, Grok reviews”  
**So that** my preferred workflow repeats without a long prompt.

**Acceptance criteria**

- Recipes assign roles to execution profiles and fallbacks.
- They include maximum depth, concurrency, access, and budget.
- The user can apply a recipe per task/project.
- Every automatic selection is visible.
- A missing runtime triggers an allowed fallback or asks the user.

### US-G4 — Learn from local outcomes

**Priority:** P2  
**As a** repeat user  
**I want** routing informed by my projects' outcomes  
**So that** Auto improves for my work rather than relying on generic rankings.

**Acceptance criteria**

- Outcome signals include completion, accepted diff, tests, follow-up count, latency, and usage.
- Learning is local and inspectable by default.
- The user can reset or disable it.
- Model changes/version drift decay older evidence.
- Security-sensitive task contents are not uploaded for this feature.

## 10. Epic H — Skills and policy

### US-H1 — Create a portable project skill

**Priority:** P1  
**As a** project owner  
**I want** to define design, testing, and handoff practices once  
**So that** each runtime follows the same important standards.

**Acceptance criteria**

- The skill has instructions, references, scripts, permissions, and verification needs.
- The UI shows compatibility per runtime.
- Runtime projections are previewable.
- Security requirements cannot be silently dropped.
- Project skills are versioned and shareable through files.

### US-H2 — Enforce a no-deploy task

**Priority:** P0  
**As a** user working locally  
**I want** deployment blocked by task policy  
**So that** an autonomous agent cannot publish a demo accidentally.

**Acceptance criteria**

- Known deployment commands/tools are denied or require explicit override.
- Child agents inherit the prohibition.
- A model instruction cannot override it.
- The blocked event explains the policy.
- Local builds and emulators remain available.

### US-H3 — Protect secrets

**Priority:** P0  
**As a** user  
**I want** deny-read and redaction policies  
**So that** agents and logs do not expose credentials.

**Acceptance criteria**

- Sensitive path patterns can be denied.
- Environment values matching secret patterns are redacted.
- Clipboard/export uses the same redaction.
- Permission requests never reveal the secret value.
- Tests cover common token/key formats and user-defined patterns.

### US-H4 — Require emulator/fallback behavior

**Priority:** P1  
**As a** user without production credentials  
**I want** the task to use approved emulator/adapter paths  
**So that** work continues safely instead of weakening authorization.

**Acceptance criteria**

- The contract can define fallback paths.
- Credential absence routes to fallback or records a gap.
- Production access is not broadened to make a demo work.
- The completion report names unverified production behavior.

## 11. Epic I — Reliability and accessibility

### US-I1 — Recover after application restart

**Priority:** P0  
**As a** user running long work  
**I want** the application to reconnect after restart  
**So that** sessions and worktrees are not lost.

**Acceptance criteria**

- Task metadata and native session ids are durable.
- Orphaned processes are detected.
- Reconnect, terminate, and mark lost are explicit choices.
- Last event and worktree state are visible.
- Drafts and queued prompts survive.

### US-I2 — Use the full workflow by keyboard

**Priority:** P0  
**As a** keyboard user  
**I want** complete navigation and actions without a mouse  
**So that** the app remains efficient and accessible.

**Acceptance criteria**

- The user can create/open/clone, choose profile, send, steer, approve, review, and stop.
- Focus order follows visual order.
- Focus is always visible.
- Shortcuts are discoverable and do not conflict with text editing.
- Popovers restore focus to their trigger.

### US-I3 — Use reduced motion

**Priority:** P0  
**As a** motion-sensitive user  
**I want** the app to honor OS reduced-motion settings  
**So that** agent activity is comfortable to supervise.

**Acceptance criteria**

- Positional, scaling, branch-drawing, and milestone animations are removed.
- Necessary feedback remains immediate.
- No information depends on motion.
- All core journeys pass with animation disabled.

### US-I4 — Use a screen reader

**Priority:** P0  
**As a** screen-reader user  
**I want** meaningful landmarks and controlled live updates  
**So that** streaming agents do not overwhelm navigation.

**Acceptance criteria**

- Sidebar, task canvas, composer, and Inspector are landmarks.
- Status changes use polite live regions.
- Raw token streams are not announced continuously.
- Approval required and completion are announced once.
- Diff lines and file states have accessible labels.

### US-I5 — Remain responsive under concurrency

**Priority:** P0  
**As a** user supervising multiple agents  
**I want** smooth input and navigation  
**So that** background logs cannot freeze the UI.

**Acceptance criteria**

- Renderer work is isolated from process/event ingestion.
- Large logs and diffs are virtualized.
- Background tasks do not animate continuously.
- Composer input latency remains below the agreed performance budget.
- Event backpressure and dropped-detail behavior are observable.

## 12. Epic J — Workspace UI quality and continuity

The detailed component behavior for these stories is normative in [Agent workspace UI/UX primitives](ui-ux-primitives.md). The itemized edge cases and protocol fallbacks are normative in the [QOL microinteraction catalog (200)](qol-100.md). Security, context, repository, terminal, quota, update, secret, remote, accessibility, routing/delegation, and checkpoint invariants are normative in [Critical systems primitives](critical-systems-primitives.md); their release phase is governed by the [Delivery and criticality matrix](delivery-criticality-matrix.md). Standardized project/task/run notes, Git-common storage, worktree projections, agent messaging, transcript access, and Git GUI behavior are normative in [Repository coordination and worktree protocol](repo-coordination-protocol.md); the agent-callable delegation surface is [Broker MCP contract](broker-mcp-contract.md).

### US-J1 — Start without choosing an application mode

**Priority:** P0  
**As a** user with an outcome in mind  
**I want** to type first and resolve project/runtime details inline  
**So that** setup does not interrupt intent.

**Acceptance criteria**

- The default state contains one composer and one plain-language context sentence.
- New task is the primary action; Open folder, Clone, Quick chat, and Import are alternate starts.
- A likely code request can request project context without losing or blocking the draft.
- Project, checkout, isolation, runtime, model, and permission defaults are inspectable before send.
- No provider-selection wall or mandatory project picker precedes typing.

### US-J2 — Return to the exact working state

**Priority:** P0  
**As a** user switching among long-running tasks  
**I want** each task to remember where I was  
**So that** concurrency does not create navigation tax.

**Acceptance criteria**

- Draft text, selection, attachments, queue, transcript density, semantic scroll anchor, open files, selected diff, and relevant pane geometry survive task switching and restart.
- New streaming content never moves a task that is in Reading state.
- Returning to a completed task lands at its first unread result with an option to return to the prior reading anchor.
- Restore does not claim a run is active until native/process state is reconciled.

### US-J3 — Find durable history and distinguish checkouts

**Priority:** P0  
**As a** user with several clones and many old tasks  
**I want** complete search and unambiguous project identity  
**So that** I open the correct work.

**Acceptance criteria**

- Search indexes durable history beyond the materialized recent list.
- Results include owning project and checkout when names collide.
- Windows path variants, junctions, UNC paths, and WSL roots are normalized without collapsing distinct checkouts.
- Remote URL grouping never hides the active local path/branch.
- Offline or missing roots remain visible with recovery actions.

### US-J4 — Open work products as useful panes

**Priority:** P1  
**As a** user reviewing an agent's work  
**I want** files, diffs, terminal, preview, plan, and child runs in appropriate panes  
**So that** I can inspect deeply without turning the transcript into an IDE dump.

**Acceptance criteria**

- Paths open the correct typed pane and support Open externally, Reveal, Attach, and Copy path.
- Resizers support pointer, keyboard, double-click reset, minimum dimensions, and accessible announcements.
- Curated Focus, Review, Build, Visual, Compare, and Supervise presets are available.
- Closing a pane does not delete or stop its underlying object.
- Pane state restores without first-frame geometry snap.

### US-J5 — Read a stable streaming transcript

**Priority:** P0  
**As a** user supervising active work  
**I want** streaming activity to remain calm and anchored  
**So that** I can read, select, and steer without layout jumps.

**Acceptance criteria**

- Long histories use measured virtualization and stable event ids.
- Token chunks do not trigger entrance animations.
- Following and Reading states are distinct; a new-events control reports unseen activity.
- Repeated events collapse into honest summaries that retain failures and unresolved approvals.
- The current request and current observable activity remain recoverable when source rows scroll away.
- The composer does not move when transcript content streams.

### US-J6 — Understand queue, steer, stop, and recovery state

**Priority:** P0  
**As a** user directing a live run  
**I want** control semantics to match backend reality  
**So that** I do not send or stop work by accident.

**Acceptance criteria**

- Steer now and Send next are separately labeled and editable/cancellable.
- Stop requested, process stopped, cleanup complete, disconnected, and unknown states are distinct.
- Stop remains available through any confirmed control path if the activity subscription fails.
- Expired or already-consumed queue/approval actions reconcile visibly.
- No indefinite unqualified Thinking state is possible.

### US-J7 — Use restrained platform-native visuals

**Priority:** P0  
**As a** Windows or macOS user  
**I want** the app to feel native, quiet, and precise  
**So that** long sessions remain comfortable.

**Acceptance criteria**

- Windows and macOS share semantics but use platform-correct title bars, shortcuts, menus, materials, paths, and permission flows.
- Opaque themes are complete; transparency/material is optional and has no contrast dependency.
- Hover reveals do not move content, running rows do not pulse, and provider changes do not recolor the composer.
- Motion uses named duration/property tokens and is confined to causal transitions.
- Software rendering, reduced transparency, forced colors, reduced motion, and no-motion modes remain fully usable.

### US-J8 — Archive and delete without ambiguity

**Priority:** P0  
**As a** user managing many tasks and worktrees  
**I want** cleanup verbs to name their exact scope  
**So that** I never fear losing code unexpectedly.

**Acceptance criteria**

- Archive preserves task history and is reversible.
- Remove project does not delete the folder.
- Delete task, delete worktree, delete branch, discard changes, and forget native link are distinct actions.
- Dirty worktrees and unpushed commits receive specific protection.
- Bulk actions preview counts and consequences.

## 13. Launch story map

### P0 walking skeleton

1. Detect/connect Codex, Cursor, and Grok.
2. Open project or clone while preserving a task draft.
3. Start a task with contract, permissions, and execution profile.
4. Observe normalized activity and answer approvals.
5. Delegate one bounded child task.
6. Review evidence and consolidated diff.
7. Hand off to another runtime.
8. Complete with verified checklist and durable handoff.

### P1 beta depth

- Generic ACP catalog.
- Auto routing and recipes.
- Cheap-reader discovery.
- Visual screenshot review.
- Side questions.
- Portable skill management.
- Honest subscription-pressure dashboard.
- Optional local CLI skill.

### P2 expansion

- Best-of-N.
- Remote/mobile.
- Team policy.
- Schedules.
- Local outcome learning.
- Recipe/skill marketplace.

## 14. Explicitly rejected stories

The following are intentionally not product stories for the initial scope:

- “As a user, I want AI Integrator to log into every provider using my subscription credentials.”
- “As a user, I want the same model name to behave identically across runtimes.”
- “As a user, I want an exact remaining quota even if the provider does not expose it.”
- “As an agent, I want unlimited recursive delegation.”
- “As a user, I want Full access enabled by default.”
- “As a user, I want a built-in Claude subscription integration marketed as official.”
- “As a user, I want AI Integrator to replace my IDE's autocomplete.”

These conflict with security, provider honesty, scope, or product differentiation.
