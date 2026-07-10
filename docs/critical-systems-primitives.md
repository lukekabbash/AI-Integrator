# AI Integrator — Critical Systems Primitives

**Status:** Normative systems contract  
**Audience:** Product, desktop, runtime adapters, security, persistence, accessibility, and QA  
**Research window:** 2026-07-10  
**Companions:** [Product specification](product-spec.md), [Agent workspace UI/UX primitives](ui-ux-primitives.md), [QOL microinteraction catalog](qol-100.md), [Native parity matrix](native-parity-matrix.md), [Repository coordination protocol](repo-coordination-protocol.md), [Broker MCP contract](broker-mcp-contract.md)

These primitives are not a second polish backlog. They define boundaries where an agent workspace can lose context, corrupt a repository, leak secrets, overspend, misroute work, or misrepresent control. A primitive can be critical without being part of MVP: `C0 · Later` means the feature may ship later, but it cannot ship without that invariant.

## 1. Classification

### Delivery phase

| Phase | Meaning |
|---|---|
| **MVP** | Required for the first-release slice or its unavoidable supporting infrastructure |
| **Beta** | Required before the named beta feature becomes available to ordinary users |
| **Later** | Required before the associated later feature ships |

### Criticality

| Level | Meaning |
|---|---|
| **C0** | Security, authorization, secret, irreversible external action, repository/data integrity, billing, or control-ownership boundary |
| **C1** | Core state/lifecycle correctness; failure loses work, lies about execution, or prevents safe recovery |
| **C2** | Material usability, accessibility, performance, or comprehension requirement |
| **C3** | Refinement that may be deferred without making the feature unsafe or deceptive |

### Applicability

- **Always:** applies to the shared shell regardless of runtime.
- **Feature-gated:** mandatory when the associated feature is enabled.
- **Runtime-specific:** enforced when a runtime exposes or emulates the primitive.
- **Platform-specific:** enforced on the named OS/environment.

## 2. Composer execution route and delegation policy

### CS-001 — Execution choice lives in one lower-right route control

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Always

- **Invariant:** The composer’s lower-right group is `Delegation → Route/model → Voice → Send/stop`. One route pill selects connection/subscription, runtime, provider model, service tier, and effort; provider tabs never become the application architecture.
- **State/protocol:** Normalize Codex model catalogs, service tiers, effort, and configuration plus ACP `configOptions` categories such as `model`, `model_config`, and `thought_level`.
- **Degradation:** A PTY adapter may expose a pinned configured route with `Selection not dynamically discoverable`; it cannot pretend a guessed model list is authoritative.
- **Acceptance:** Switching from `Codex · GPT-5.6 · High` to `Cursor · Claude · Medium` takes one popover, preserves the draft, does not navigate, and changes no other task.

### CS-002 — The collapsed route preserves full execution identity

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Always

- **Invariant:** The short label may omit connection or provider when space is tight, but details always reveal connection/account, runtime/harness, provider model id, tier, effort, auth/billing class, availability, and capability age.
- **State/protocol:** Codex implementation/model metadata and ACP agent/config metadata are evidence; Integrator records the launched connection and adapter.
- **Degradation:** Unknown account, billing, or quota fields say `Not exposed`, not `Default`, `Free`, or `Unlimited`.
- **Acceptance:** Identically named models through two subscriptions remain distinguishable before Send and in every run header, handoff, usage record, and diagnostic.

### CS-003 — Route changes have an explicit activation boundary

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Always

- **Invariant:** A selection made while idle targets the next turn. During execution it is labeled `Next turn`, `Fork`, or `Handoff`; it never relabels or mutates the active request unless the runtime confirms an in-place configuration transition.
- **State/protocol:** Codex/ACP configuration updates may occur during generation, but the adapter must report whether they affect current generation, the next model step, or only a future turn.
- **Degradation:** Unknown activation semantics default to next turn/new session.
- **Acceptance:** The transcript and usage ledger preserve the original route for all output generated before the acknowledged boundary.

### CS-004 — Delegation policy is visible before Send

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: delegation

- **Invariant:** The adjacent branch chip exposes Off, Ask, Bounded, and Auto. The closed state indicates whether automatic child creation is possible and shows a quiet concurrency limit/count when active.
- **State/protocol:** Codex supports subagent roles and bounded depth/thread settings; Integrator’s broker normalizes equivalent vendor/ACP/CLI behavior.
- **Degradation:** Runtimes without child-agent support show Off and explain whether brokered cross-runtime delegation remains available.
- **Acceptance:** A lead cannot spawn a child when the visible policy says Off, and `Ask` cannot be converted to automatic approval by a native agent setting.

### CS-005 — Delegation rules resolve through explicit precedence

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: delegation

- **Invariant:** Effective rules merge managed policy, personal defaults, project recipe, task override, parent launch snapshot, and assignment constraints. More restrictive limits win; conflicts are visible.
- **State/protocol:** Persist source, version/hash, and effective value for provider allowlists, roles, depth, concurrency, budget, access, external actions, and return requirements.
- **Degradation:** If a runtime cannot enforce a rule internally, the broker enforces it outside the process or marks that route ineligible.
- **Acceptance:** No child can widen the parent’s permission, budget, provider allowlist, recursion, network, deployment, or external-action boundary.

### CS-006 — Role rules select peers semantically, not by fragile command prose

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Feature-gated: delegation

- **Invariant:** Rules match task class and role—mapping, research, implementation, tests, browser verification, review—not raw shell invocations. They resolve to an eligible execution profile at spawn time.
- **State/protocol:** Generated peer rosters contain current capabilities, cost/usage class, connection health, permissions, worktree support, and required return contract.
- **Degradation:** If no route satisfies all hard constraints, pause with the failed constraints and nearest safe alternatives; never silently relax them.
- **Acceptance:** `Read-only repository mapping` cannot resolve to a write-only or unauthenticated child even if that model is the user's recent favorite.

### CS-007 — Child budgets and access are immutable launch snapshots

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: delegation

- **Invariant:** Each child stores its route, assignment, access, checkout, depth, concurrency lease, time/usage budget, external-action policy, and return schema at creation. Later UI changes target unstarted children unless explicitly tightened safely.
- **State/protocol:** Native Codex `agents.max_depth`, `agents.max_threads`, roles, and job timeouts inform enforcement but never replace broker ceilings.
- **Degradation:** Unknown token/cost accounting uses time/turn limits and conservative stop-before-spawn thresholds.
- **Acceptance:** Reopening or reconnecting reproduces the exact policy that governs every active child and prevents duplicate budget consumption.

### CS-008 — Fallback delegation requires boundary-aware consent

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: routing/delegation

- **Invariant:** An ordered fallback may change model or runtime automatically only inside the approved billing, data, permission, environment, and capability envelope. Crossing subscription→API, local→cloud, read→write, or no-external→external boundaries requires renewed consent.
- **State/protocol:** Record why the preferred route failed, which constraints the fallback satisfies, and the exact child return evidence required.
- **Degradation:** If cost or data-location class is unknown, treat it as a boundary crossing.
- **Acceptance:** Rate limiting cannot silently move a repository or attachment to a metered/cloud provider the task did not authorize.

## 3. Context, memory, and compaction

### CS-009 — Every run has an effective-context manifest

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Always

- **Invariant:** Before Send and in run details, enumerate task contract version, user messages, selected attachments, live/snapshot references, instructions, skills, memory entries, summaries/compactions, native session lineage, tool schemas, and estimated/known size.
- **State/protocol:** Codex status/context information and ACP prompt content help; client-known layers remain separate from vendor-internal context that is not exposed.
- **Degradation:** Unknown native context is labeled `Runtime-managed, not inspectable`; never infer that visible transcript equals sent context.
- **Acceptance:** A user can answer “why did this model know this?” and “why did it forget that?” without viewing hidden reasoning.

### CS-010 — Context pressure is measured with provenance and confidence

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Runtime-specific

- **Invariant:** Display used/remaining context only from provider/runtime reports or a clearly labeled estimate. Separate prompt window, retained transcript, tool-output storage, and account quota.
- **State/protocol:** Codex `/status` exposes remaining context capacity; ACP `usage_update` can report context used/size. Adapters normalize timestamps and confidence.
- **Degradation:** When size is not exposed, show qualitative pressure derived from known payloads without a precise percentage.
- **Acceptance:** The composer never uses one unlabeled ring for context capacity, daily usage, and cost.

### CS-011 — Automatic compaction has a safe, observable trigger

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Runtime-specific

- **Invariant:** Compaction may be manual, runtime-triggered, or Integrator-recommended. It occurs only at a stable turn boundary unless the runtime defines a safe native boundary; pending approvals, tool calls, queued prompts, and unsaved drafts remain outside the summary.
- **State/protocol:** Codex `/compact`, compact prompts, and pre/post compact hooks provide native signals. ACP has no stable compaction primitive, so adapters must not invent native equivalence.
- **Degradation:** Offer a provider-neutral handoff summary/new session when native compaction is unavailable.
- **Acceptance:** Forced pressure during a tool call cannot erase its pending permission, terminal ownership, or unreturned result.

### CS-012 — A compaction summary is versioned evidence with lineage

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Feature-gated: compaction

- **Invariant:** Store source event range, producing runtime/model, trigger, prompt/schema version when known, timestamp, summary hash, preserved facts/constraints, explicit omissions, and superseded summary lineage.
- **State/protocol:** Pre/post compaction hooks and native session events are recorded when exposed; the summary is never presented as verbatim history.
- **Degradation:** If the runtime hides summary text, store the boundary and say `Native compacted state not exposed`.
- **Acceptance:** Users can inspect what was summarized, compare successive compactions, and restore the original local transcript even when the model cannot receive it all again.

### CS-013 — Memory entries have scope, provenance, and purpose

**Phase:** Beta · **Criticality:** C0 · **Applicability:** Feature-gated: memory

- **Invariant:** Every memory says who/what created it, source task/evidence, personal/workspace/project scope, injection/generation state, confidence, sensitivity class, expiration, last use, and whether external context suppresses it.
- **State/protocol:** Codex exposes memory controls/configuration, but cross-runtime memory remains an Integrator-owned layer unless another runtime provides a compatible primitive.
- **Degradation:** Agent-authored suggestions remain pending notes until the user or a deterministic policy promotes them to memory.
- **Acceptance:** A task from Account B or unrelated project cannot receive Account A/project-scoped memory through search, handoff, or cache deduplication.

### CS-014 — Memory conflicts, correction, and deletion are first-class

**Phase:** Beta · **Criticality:** C0 · **Applicability:** Feature-gated: memory

- **Invariant:** Detect incompatible active memories and newer explicit instructions. Let users inspect, edit with version history, scope down, disable injection, expire, and delete; explicit prompt and managed policy always win.
- **State/protocol:** Track deletion separately in Integrator and every native store; qualify remote hard-deletion guarantees.
- **Degradation:** If native memory cannot be enumerated/deleted, disable cross-runtime claims and link to the native control surface.
- **Acceptance:** Correcting a preference does not leave two silently competing injected memories, and deletion receipts identify stores that could not be verified.

### CS-015 — Handoffs state exactly what context survives

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Always

- **Invariant:** A handoff matrix separates transferable task contract, visible messages, local ledger, files/diffs, summaries, explicit memories, native session state, tool state, hidden reasoning, cached provider context, and pending interactions.
- **State/protocol:** Use native resume only when identity/lineage proves it; otherwise start a new session with a versioned provider-neutral package.
- **Degradation:** `Not transferable`, `Snapshot only`, `Recreated`, and `Native resume` are distinct labels.
- **Acceptance:** Switching runtime cannot imply that hidden reasoning, KV cache, native tool state, or unexposed memory moved with the task.

## 4. Git and worktree lifecycle

### CS-016 — Repository identity is verified before any write

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: repository write

- **Invariant:** Resolve canonical root, Git common directory, remote identity, current commit, branch/detached state, worktree id, case/symlink/junction path, submodule nesting, and dirty state before assigning a writer.
- **State/protocol:** Integrator verifies with local Git; runtime-reported cwd is evidence but not sufficient authority.
- **Degradation:** Non-Git folders use explicit directory identity and cannot receive Git merge/branch promises.
- **Acceptance:** Similar clones and nested repositories never share locks, task history, or cleanup merely because their folder names match.

### CS-017 — Dirty-base decisions preserve all existing work

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: repository write

- **Invariant:** Before worktree/branch setup or destructive Git operation, classify tracked/staged/unstaged/untracked/ignored/submodule changes and ownership. Offer use current state, snapshot patch, user-approved commit/stash, isolated worktree from clean base, or cancel.
- **State/protocol:** Never auto-stash, reset, clean, or commit user work solely to satisfy an agent.
- **Degradation:** If status is incomplete or too expensive, block write setup and show the failing Git command.
- **Acceptance:** Every dirty-state fixture—including untracked and submodule changes—survives cancellation, crash, and setup failure byte-for-byte.

### CS-018 — Worktrees have leases, ownership, and reuse rules

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: delegated/isolated write

- **Invariant:** A worktree records owning task/run, base commit, branch/ref, creation state, active processes, locks, last use, and cleanup eligibility. Reuse requires same repository, compatible base/policy, clean/reconciled state, and no active owner.
- **State/protocol:** Broker leases are authoritative even if native runtimes create worktrees internally; native and Integrator worktrees must be reconciled.
- **Degradation:** Unknown ownership makes a worktree inspect-only until adopted explicitly.
- **Acceptance:** Two writers never receive the same writable checkout without an intentional shared-root sequential policy.

### CS-019 — Submodules, LFS, sparse checkouts, and partial clones remain explicit

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Runtime/project-specific

- **Invariant:** Detect and display submodule commit/dirty state, LFS availability/pointer hydration, sparse patterns, shallow/partial clone limits, and missing objects before claiming the checkout is ready.
- **State/protocol:** Setup actions are task events with resumable progress and non-secret Git diagnostics.
- **Degradation:** Missing LFS/submodule credentials or objects become a recorded gap; never substitute production credentials or silently skip required content.
- **Acceptance:** Tests cannot be marked representative when required submodules or LFS assets were absent.

### CS-020 — Protected branches and deployment refs are policy boundaries

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: Git/external write

- **Invariant:** Project policy identifies protected branches/tags/remotes and disallowed push/force/merge/deploy actions. Local full access cannot override outer deployment/external policy.
- **State/protocol:** Branch/ref protection is checked before command approval and again immediately before external mutation.
- **Degradation:** Unknown remote protection defaults to local-only work with no push/merge claim.
- **Acceptance:** A child or replayed command cannot push to main, force-update a ref, deploy, or merge merely because its sandbox permits Git/network access.

### CS-021 — Merge and rebase conflicts are typed decisions with recoverable state

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: integration

- **Invariant:** Show operation, ours/theirs/base commits, conflicted files, index stages, rerere state, uncommitted pre-operation work, and Abort/Continue/Resolve choices. One designated merge authority owns the operation.
- **State/protocol:** Agent suggestions are reviewable patches; users can open three-way views and return to the exact conflict.
- **Degradation:** If the UI cannot represent the conflict safely, pause and open the repository in the configured Git/editor tool without abandoning ownership metadata.
- **Acceptance:** Abort restores the documented pre-operation state and no child independently resolves/continues a parent-owned merge.

### CS-022 — Stale bases, orphaned worktrees, and cleanup are detectable

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: worktrees

- **Invariant:** Compare base against target branch before review/integration, mark stale evidence, and detect missing directories, deleted refs, crashed owners, locked files, active terminals, unpushed commits, and unexported artifacts before cleanup.
- **State/protocol:** Cleanup previews reclaimed bytes and every affected task/reference; deletion is never based on age alone.
- **Degradation:** Ambiguous worktrees move to Recovery, not auto-delete.
- **Acceptance:** An orphan containing unique commits or dirty files cannot be pruned without an explicit export/adopt/discard decision.

## 5. Interactive terminal and process control

### CS-023 — Interactive stdin has one visible owner

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: terminal input

- **Invariant:** Each process session shows whether stdin is controlled by agent, user, scripted response, or nobody. Taking control pauses agent writes; returning control summarizes user input without logging sensitive bytes.
- **State/protocol:** Codex command/process write methods and ACP terminal sessions provide ids; Integrator arbitrates ownership across windows/devices.
- **Degradation:** PTY adapters without ownership hooks require explicit attach/detach and serialize all input.
- **Acceptance:** User and agent keystrokes can never interleave into the same prompt or full-screen program.

### CS-024 — Password and secret prompts never enter ordinary transcript storage

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Always

- **Invariant:** Detect no-echo/credential prompts where possible and provide a secure input surface outside model context, clipboard history, telemetry, screenshots, command echo, draft persistence, and general logs. Show destination process/host and why it asks.
- **State/protocol:** The runtime receives only the necessary bytes through the supervised terminal; agents receive success/failure, not the secret.
- **Degradation:** Unknown interactive credential prompts pause for manual external-terminal takeover rather than asking the model to type a secret.
- **Acceptance:** Seeded credentials are absent from all persistence/search/export/accessibility/screenshot sinks after success, failure, cancel, and crash.

### CS-025 — Full-screen TTY applications have enter/exit and recovery semantics

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Runtime/platform-specific

- **Invariant:** Alternate-screen apps, pagers, editors, REPLs, menus, and raw-mode programs are labeled interactive; transcript rendering switches to a terminal surface with resize, key routing, copy mode, and an always-available escape/takeover path.
- **State/protocol:** Preserve terminal dimensions and process/session id; do not parse raw-screen bytes as normal line output.
- **Degradation:** Unsupported full-screen sessions open in the configured external terminal and remain attached to task lifecycle.
- **Acceptance:** Vim, less, interactive rebase, and a curses menu restore terminal modes and app shortcuts after exit/crash.

### CS-026 — Shell identity includes PowerShell, cmd, WSL, login, and environment boundary

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Platform-specific: Windows/macOS/Linux

- **Invariant:** Every command records executable, shell family/version, login/profile mode, cwd path namespace, environment profile, encoding, architecture, user/elevation, local/WSL/remote placement, and adapter transformations.
- **State/protocol:** A Windows path is not passed blindly into WSL or another shell; quoting and environment conversion are adapter-owned and tested.
- **Degradation:** Unknown shell semantics disable reusable approval-prefix promises and show the literal invocation boundary.
- **Acceptance:** The same displayed command cannot secretly execute under a different shell, user, distro, or host after reconnect.

### CS-027 — Elevation is per operation and cannot become ambient authority

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Platform-specific

- **Invariant:** Show current token/user, requested elevated operation, executable, arguments, working directory, scope, and duration. Elevation launches the smallest helper/process and expires; it does not elevate the whole app, adapter, future turns, or child agents.
- **State/protocol:** Windows UAC/admin and Unix privilege escalation are distinct flows with OS-native confirmation where available.
- **Degradation:** If fine-grained elevation is impossible, require an external manual step and re-probe state afterward.
- **Acceptance:** A successful elevated install cannot grant subsequent unrelated agent commands administrator/root access.

### CS-028 — Process trees stop and clean up as a unit with exceptions visible

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Always

- **Invariant:** Track root process, descendants, detached children, job/process group, ports, files/locks, and supervising runtime. Stop progresses through interrupt, grace, terminate, kill, and cleanup with per-descendant outcome.
- **State/protocol:** Codex/ACP process and terminal controls map to host supervision; release/detach is distinct from kill.
- **Degradation:** Unowned descendants are reported with PID/port and safe manual actions; never claim `Stopped` from root exit alone.
- **Acceptance:** A cancelled dev server or test watcher cannot keep ports, locks, or child processes alive invisibly.

### CS-029 — Terminal completion preserves exit truth and inspectability

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Always

- **Invariant:** Distinguish running, waiting for input, backgrounded, released, exited code/signal, killed, timed out, transport lost, output truncated, and cleanup failed. Keep a bounded live tail plus spill-to-disk provenance.
- **State/protocol:** ACP terminal wait/output/truncated and Codex process notifications provide structured evidence; PTY parsing carries confidence.
- **Degradation:** Missing exit status is `Unknown`, never success inferred from the last line.
- **Acceptance:** Closing a terminal tab changes no process state, and every process outcome remains reopenable from the task.

## 6. Quota, usage, budgets, and fallback

### CS-030 — Usage dimensions retain their source and unit

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Always

- **Invariant:** Track context tokens, generated tokens, cached/prefill tokens, requests, time, credits, currency cost, subscription quota, rate-limit windows, and resets as separate metrics with provider-reported/measured/estimated/unknown confidence.
- **State/protocol:** Codex usage/model/account signals and ACP `usage_update` are normalized without inventing unavailable billing data.
- **Degradation:** A locally measured token estimate cannot be labeled provider charge or remaining subscription capacity.
- **Acceptance:** Aggregation preserves unit, source, confidence, route, model, run, child lineage, and timestamp.

### CS-031 — Reset times are exact when known and bounded when not

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Runtime/account-specific

- **Invariant:** Display provider window name, reset instant/timezone, remaining value, fetch time, and staleness. Relative labels expose exact time; rolling windows are not rendered as fixed calendar resets.
- **State/protocol:** Use official runtime/account data only; cache with age and refresh status.
- **Degradation:** `Reset not exposed` is distinct from no limit.
- **Acceptance:** Account/workspace switching cannot retain the prior account's quota or reset display.

### CS-032 — A run preflights capability and budget headroom without false certainty

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Feature-gated: constrained routes

- **Invariant:** Before expensive/delegated work, compare known remaining limits, estimated task class, context payload, concurrency, and configured budgets. Treat estimates as planning aids, not guarantees.
- **State/protocol:** Auto routing may prefer a route with suitable headroom but must disclose why before execution.
- **Degradation:** Unknown headroom permits manual selection inside hard cost policy but prevents claims such as `Enough quota`.
- **Acceptance:** Auto cannot select an API-metered fallback when the task permits subscription-only execution.

### CS-033 — Mid-run limit exhaustion preserves partial work and causal state

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Always

- **Invariant:** On rate limit/quota/context/budget exhaustion, stop new side effects, settle current tool state, preserve native session/worktree/partial output/usage, identify the exact limit, and offer wait, compact, continue later, change route, handoff, or finish manually.
- **State/protocol:** Stop reason and retry/reset metadata remain attached to the run segment that exhausted them.
- **Degradation:** Generic provider errors remain `Possible limit; not confirmed` until verified.
- **Acceptance:** Retrying after a reset cannot duplicate the last uncertain external action or discard completed child evidence.

### CS-034 — Model/runtime fallback is a reviewed execution transition

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: fallback

- **Invariant:** Show old/new full route, trigger, context/handoff method, capability losses, billing/data-location change, permission compatibility, usage implications, and whether native continuation survives.
- **State/protocol:** In-session agent config updates are recorded separately from Integrator-initiated fallback.
- **Degradation:** Unknown compatibility requires new-session handoff and explicit consent.
- **Acceptance:** Fallback never silently changes provider, account, paid route, context retention, tool access, or external-action authority.

### CS-035 — Delegated budgets reconcile reservations and partial usage

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: delegation

- **Invariant:** Parent budget reserves capacity before spawn, attributes reported/measured usage as events arrive, releases unused reservation, and records unknown/late usage. New children pause before the hard ceiling; useful active work is not erased.
- **State/protocol:** Child budget cannot exceed remaining parent budget and cannot be widened by the child runtime.
- **Degradation:** When tokens/cost are unavailable, enforce concurrency, duration, turn, and spawn counts with explicit uncertainty.
- **Acceptance:** Crash/reconnect cannot double-charge a reservation or forget usage already attributed to a child.

## 7. Runtime and update supply chain

### CS-036 — Every executable and package has verifiable provenance

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Always

- **Invariant:** Record source, publisher, package manager/installer, resolved path, file/package version, signature/notarization state, hash where practical, install time, and whether the runtime/adapter/plugin is bundled, official, managed, local, or unverified.
- **State/protocol:** Runtime self-reported implementation info is compared with the host executable actually launched; it is not the sole proof.
- **Degradation:** Unsigned/local builds remain opt-in with an unverified badge and narrower automatic-update/trust behavior.
- **Acceptance:** A same-named executable earlier on PATH cannot silently replace the approved runtime after restart.

### CS-037 — Update channels and scope are explicit before installation

**Phase:** Beta · **Criticality:** C0 · **Applicability:** Feature-gated: managed updates

- **Invariant:** Show component, current/target version, stable/beta/nightly/managed channel, publisher, signature, release notes, authority changes, compatibility result, download size, restart boundary, and whether running tasks are affected.
- **State/protocol:** App, adapter, runtime, plugin, and skill updates remain separate operations even when presented in one dashboard.
- **Degradation:** When Integrator cannot control the vendor installer, provide the official update route and verify the result afterward.
- **Acceptance:** Enabling beta for one adapter cannot move the desktop app, other runtimes, or plugins to beta.

### CS-038 — Adapter/runtime compatibility is tested, not inferred from version order

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Always

- **Invariant:** Maintain tested version/schema/protocol ranges and required capabilities. Classify full, degraded, blocked-too-old, unverified-new, and failed; name affected features and safe fallback.
- **State/protocol:** Codex schemas and ACP version/capability negotiation supply evidence; PTY parsers require fixture-certified signatures.
- **Degradation:** A future runtime can run conservatively through negotiated known capabilities, but never receives a full-native badge by semver comparison alone.
- **Acceptance:** Updating a CLI cannot silently turn structured permissions into best-effort text parsing while the UI still shows native fidelity.

### CS-039 — Update application is atomic and rollback-aware

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: self-update

- **Invariant:** Verify download and signature before replacement, stage beside current version, quiesce affected processes, preserve compatible config/state, journal migration, health-check new version, and roll back executable plus schema when supported.
- **State/protocol:** Running tasks either continue on the pinned old component or pause with an explicit resumable boundary.
- **Degradation:** One-way state migrations require a verified backup/export and cannot advertise automatic rollback.
- **Acceptance:** Power loss at each update stage yields a runnable old or new version, never a half-replaced runtime or silently reset data store.

### CS-040 — Emergency feature disablement is narrow and auditable

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Always

- **Invariant:** A kill switch names component/capability/version range, source, reason, received time, expiry, and affected tasks. It disables only the unsafe path and preserves read/export/recovery where possible.
- **State/protocol:** Managed policy and signed compatibility metadata may impose restrictions; local UI cannot visually override them.
- **Degradation:** Offline clients use last verified policy until expiry and label staleness.
- **Acceptance:** Disabling one broken MCP write tool or parser cannot erase unrelated runtimes, histories, drafts, or artifacts.

### CS-041 — Runtime path/version changes are reconciled before resume

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Always

- **Invariant:** On launch/resume, compare executable path, hash/version, adapter, protocol/capabilities, config profile, and native session store with the task's last known runtime snapshot.
- **State/protocol:** Classify compatible resume, resume with changed capability, new-session handoff, or blocked; show the delta before mutation.
- **Degradation:** If old native sessions cannot be read by the new runtime, preserve Integrator state and offer provider-neutral continuation.
- **Acceptance:** A package-manager upgrade, PATH reorder, WSL distro change, or rollback cannot resume under a different runtime invisibly.

## 8. Secrets and environment profiles

### CS-042 — Secrets are references and capabilities, never ordinary values

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Always

- **Invariant:** Store provider/keychain/vault reference, purpose, scope, allowed consumers, created/rotated/expiry metadata, and presence/health—not plaintext—in task/project policy. General settings, prompts, skills, handoffs, logs, and exports receive opaque handles or redacted presence.
- **State/protocol:** Vendor CLI auth remains vendor-owned; Integrator does not extract or replay OAuth credentials.
- **Degradation:** File/env secrets that cannot be vaulted remain externally managed and are never copied into Integrator state.
- **Acceptance:** Search, diagnostics, crash dumps, accessibility, screenshots, and database inspection reveal no seeded secret bytes.

### CS-043 — Environment profiles are scoped, diffable execution inputs

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Always

- **Invariant:** A profile defines shell/host, non-secret variables, secret references, PATH/toolchain, network/proxy, writable roots, setup actions, and inheritance at personal/project/task/run scope. Show the effective diff without values for secret fields.
- **State/protocol:** Runtime shell snapshotting may optimize launch but cannot bypass Integrator's scope/policy or stale-profile detection.
- **Degradation:** Unknown inherited environment is labeled and can be replaced with a minimal clean environment.
- **Acceptance:** Switching profile during a run targets a new process/turn and cannot mutate already-running process environment.

### CS-044 — Child secret inheritance is deny-by-default and purpose-bound

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: delegation

- **Invariant:** A child receives no secret merely because the parent can access it. Policy explicitly grants a reference to an eligible runtime/role/tool/host for a purpose and duration; grandchildren inherit nothing unless separately allowed.
- **State/protocol:** The broker resolves/injects only at the consuming boundary and records non-secret use metadata.
- **Degradation:** If a runtime requires broad environment inheritance, that route is ineligible for secret-sensitive children or requires explicit broad-risk consent.
- **Acceptance:** A read-only mapper cannot access deployment, production, package-publish, or unrelated MCP credentials.

### CS-045 — Secret expiration and rotation invalidate dependent capability safely

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: secret-backed actions

- **Invariant:** Track expiry/rotation/revocation when exposed; on change, invalidate cached handles, affected auth/MCP/remote status, scheduled preflight, and unstarted children. Running operations settle without retrying with stale credentials.
- **State/protocol:** Reauthentication returns to the blocked intent without automatic resubmission.
- **Degradation:** Unknown lifetime triggers health checks at safe boundaries without exposing or performing external side effects.
- **Acceptance:** Rotating a credential cannot leave a background adapter or child using a previously cached plaintext copy.

### CS-046 — `.env` and secret-bearing files are protected before model access

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Always

- **Invariant:** Apply deny-read patterns, project policy, file classification, and explicit per-file consent before a runtime/tool/skill can read likely secret files. Directory trust and full project write do not imply secret-read permission.
- **State/protocol:** Codex permission profiles can deny reads; Integrator enforces an outer boundary for every runtime and reports native limitations.
- **Degradation:** A PTY runtime that cannot be sandboxed is not eligible for secret-bearing roots unless the user explicitly accepts the limitation.
- **Acceptance:** Renaming, symlinking, case changes, alternate path syntax, nested worktrees, and generated copies cannot trivially bypass the deny policy.

### CS-047 — Redaction is validated across every output sink

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Always

- **Invariant:** Redact before persistence/render/telemetry for transcripts, terminal output, diffs, tool cards, notifications, diagnostics, exports, clipboard, screenshots/OCR, crash reports, search indexes, and accessibility names. Preserve enough typed metadata to explain the omission.
- **State/protocol:** Runtime-side redaction is defense in depth; Integrator treats all adapter output as potentially secret-bearing.
- **Degradation:** Unscannable binary/encrypted output is quarantined or manually reviewed before share/export.
- **Acceptance:** A generated secret corpus with split tokens, encodings, URLs, headers, stack traces, and terminal control sequences produces no recoverable secret in any sink.

### CS-048 — Secret requests identify consumer, purpose, and consequence

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: secret use

- **Invariant:** A secure request names runtime/tool/process/host, requested secret reference/type, purpose, destination, duration, child lineage, external effect, and alternatives. Allow once, scoped allow, deny, and open external/manual flow are distinct.
- **State/protocol:** Approval records metadata only; secret content never enters the model-visible permission card.
- **Degradation:** Unattributed requests are denied and routed to diagnostics.
- **Acceptance:** An approval for one Git fetch cannot authorize a later publish, different host, different child, or arbitrary shell environment access.

## 9. Remote, SSH, and network identity

### CS-049 — Remote execution identity is always visible and canonical

**Phase:** Later · **Criticality:** C0 · **Applicability:** Feature-gated: remote

- **Invariant:** Show connection profile, hostname/address, user, port, host-key fingerprint, jump/proxy path, remote OS/architecture, workspace canonical path, executor/runtime version, and current control owner in composer/run/terminal/file headers.
- **State/protocol:** Local and remote paths receive separate namespaces and stable remote-root ids.
- **Degradation:** If canonical remote identity cannot be established, permit read-only diagnostics but no write/deploy/secret injection.
- **Acceptance:** Two hosts with the same hostname alias or same path cannot share task, permission, worktree, or artifact identity accidentally.

### CS-050 — SSH host-key trust is explicit and change-sensitive

**Phase:** Later · **Criticality:** C0 · **Applicability:** Feature-gated: SSH

- **Invariant:** First connection shows algorithm/fingerprint and source; accept once/permanently/cancel. A changed key blocks before credentials or commands, shows old/new fingerprints and likely causes, and never offers an ambiguous continue default.
- **State/protocol:** Respect system/user known-host stores without silently weakening strict checking.
- **Degradation:** Managed policy may lock trusted keys/CA; UI explains the source.
- **Acceptance:** DNS alias, jump-host, port, hashed-known-host, and key-rotation fixtures cannot downgrade a changed key to a routine reconnect.

### CS-051 — SSH agents and credentials are delegated minimally

**Phase:** Later · **Criticality:** C0 · **Applicability:** Feature-gated: SSH

- **Invariant:** Show whether auth uses OS agent, keychain, key file, certificate, hardware key, password, or vendor tunnel. Agent forwarding is off by default, scoped per host/hop, and separately approved from connection.
- **State/protocol:** Private key material is never copied into task state or remote environment by Integrator.
- **Degradation:** Hardware/MFA prompts transfer control to the user and resume the blocked connection only.
- **Acceptance:** A remote child cannot use forwarded credentials to authenticate to a second host unless the exact hop is approved.

### CS-052 — Port forwards have ownership, collision, and exposure policy

**Phase:** Later · **Criticality:** C0 · **Applicability:** Feature-gated: remote preview/network

- **Invariant:** Record local/remote/dynamic type, bind address, ports, destination, task/process owner, visibility, authentication, start/stop, and collision resolution. Default local binds to loopback.
- **State/protocol:** Browser previews link to the owning forward and invalidate on reconnect/port change.
- **Degradation:** Non-loopback/public binds require explicit network-policy approval and OS firewall disclosure.
- **Acceptance:** Closing a preview cannot leave an unowned public forward, and reconnect cannot silently bind a different local port while showing the old URL.

### CS-053 — Network and proxy policy is destination-aware

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: network

- **Invariant:** Effective policy identifies enabled mode, domains/IP classes, ports/protocols, DNS/proxy/SOCKS route, local binding, Unix sockets, TLS trust, managed rules, and deny precedence. Approval shows resolved destination and rule source.
- **State/protocol:** Codex permission/network profiles and MCP origins map into the shared policy; runtime-internal network access that cannot be mediated is disclosed.
- **Degradation:** Unknown destination or proxy bypass is denied for automatic/delegated work.
- **Acceptance:** Redirects, DNS rebinding, alternate ports, IP literals, localhost aliases, and proxy changes cannot inherit an unrelated domain approval.

### CS-054 — Network transitions produce offline/reconciling states, not instant failure

**Phase:** Later · **Criticality:** C1 · **Applicability:** Feature-gated: remote

- **Invariant:** Distinguish high latency, packet loss, transport disconnected, host unavailable, auth expired, runtime stopped, and app-server/event-stream lost. Preserve drafts and last acknowledged sequence; queue no mutating input until reconciliation.
- **State/protocol:** Backoff has jitter/cap and exposes next attempt/manual retry; user cancellation stops reconnect.
- **Degradation:** PTY/SSH ambiguity opens read-only with last known state.
- **Acceptance:** Wi-Fi changes and sleep/wake cannot duplicate Send, terminal input, approval, or child spawn.

### CS-055 — Split-brain recovery chooses one authoritative owner

**Phase:** Later · **Criticality:** C0 · **Applicability:** Feature-gated: remote/multi-device

- **Invariant:** Reconcile task/run sequence, lease holder, native session/process ids, checkout/lock state, pending inputs, approvals, and last side effect before restoring control. Conflicts produce Take over, Keep remote owner, Fork read-only snapshot, or Stop both with consequences.
- **State/protocol:** Buffered mutating requests are never replayed automatically after uncertain ownership.
- **Degradation:** If authority cannot be proven, all clients remain read-only while recovery/export stays available.
- **Acceptance:** Two controllers cannot both believe they own a writer, terminal, browser, or approval after partition healing.

## 10. Global input and accessibility correctness

### CS-056 — Localization and RTL change layout without changing semantics

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Always

- **Invariant:** Externalize user-facing text, plural/date/number/byte/duration formatting, and sentence order. Mirror directional layout where appropriate while keeping code, paths, diffs, terminal output, branch graphs, and shortcut glyphs semantically correct.
- **State/protocol:** Runtime-native strings remain attributed and may be untranslated; Integrator actions/status use the selected locale.
- **Degradation:** Missing translations fall back per string with no mixed-direction corruption.
- **Acceptance:** Pseudolocalization at 35–60% expansion and Arabic/Hebrew RTL passes composer, dialogs, sidebars, approvals, tables, diff metadata, and notifications without clipped critical actions.

### CS-057 — Keymaps respect layout, platform, IME, and conflict ownership

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Platform-specific

- **Invariant:** Bind logical actions with platform defaults, support remapping/chords, show produced glyphs, detect conflicts by context, distinguish physical key from character where necessary, and avoid reserved OS/assistive-technology shortcuts.
- **State/protocol:** Runtime-native commands can advertise bindings but cannot hijack global composer/navigation keys silently.
- **Degradation:** Unrepresentable chords remain searchable in the command palette.
- **Acceptance:** US and non-US layouts, dead keys, AltGr, screen-reader modifiers, Vim mode, and terminal focus do not trigger Send/Stop/Approve accidentally.

### CS-058 — IME composition is safe in every editable or searchable surface

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Always

- **Invariant:** Composition suppresses submit, command execution, mention acceptance, inline-rename commit, search navigation, approval shortcuts, queue send, and dialog defaults until compositionend and any committed text is processed.
- **State/protocol:** Draft persistence stores committed text and selection; transient composition is never interpreted as an agent instruction.
- **Degradation:** Surfaces that cannot receive IME safely use a normal native text field instead of a custom editor.
- **Acceptance:** Chinese, Japanese, Korean, Indic, dead-key, emoji, handwriting, and dictation sequences pass every composer, comment, rename, search, terminal secure-input, and feedback field.

### CS-059 — Transcript semantics expose causal structure to screen readers

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Always

- **Invariant:** Use landmarks and headings for task, transcript, composer, inspector, and attention. Messages/tools/approvals/plans/children form labeled groups with status and relationships; token streaming is throttled and does not reannounce the entire message.
- **State/protocol:** Structured runtime ids/status drive names; hidden reasoning is never synthesized into accessibility text.
- **Degradation:** Raw/unstructured output uses a bounded log/document region with line/search navigation.
- **Acceptance:** Screen-reader users can move user message→assistant response→tool→approval→result→child and identify current/blocking/completed state without reading every token delta.

### CS-060 — High contrast, zoom, and reflow preserve hierarchy and control

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Always

- **Invariant:** At 200% desktop zoom and 400% content zoom/reflow, no two-dimensional scrolling is required for ordinary transcript/composer/settings/approval content; diff/code/terminal regions may scroll internally with labeled boundaries. System high-contrast colors retain focus/status distinctions.
- **State/protocol:** Color, animation, position, and icon are never sole state carriers.
- **Degradation:** Complex grids switch to cards/lists before hiding required fields.
- **Acceptance:** Permission target, route, delegation state, risk, and action buttons remain visible/ordered at every supported zoom and contrast mode.

### CS-061 — Voice and dictation expose capture, destination, and privacy state

**Phase:** Beta · **Criticality:** C0 · **Applicability:** Feature-gated: voice

- **Invariant:** Show idle, requesting permission, listening, paused, processing, reviewing transcript, error, and cancelled; identify microphone, locale, local/remote transcription path, retention, and destination composer. Never auto-send recognition.
- **State/protocol:** Voice output enters the ordinary draft/undo/IME pipeline only after transcription review.
- **Degradation:** Unsupported locale/device returns to typed input with the draft untouched.
- **Acceptance:** Switching tasks, locking the device, losing permission, or pressing Escape stops capture and cannot insert/send speech into another composer.

## 11. Execution checkpoints, retry, rollback, and evidence validity

### CS-062 — Checkpoints are causal boundaries, not arbitrary transcript positions

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Always

- **Invariant:** A checkpoint records task/turn/run sequence, contract/context versions, route/policy, repository commit and dirty patch, worktree, active processes, completed/uncertain tools, artifacts, usage, children, and pending interactions at a stable boundary.
- **State/protocol:** Native forks/resume ids augment but do not replace local state evidence.
- **Degradation:** If repository/process state cannot be captured, label the checkpoint conversational-only and forbid rollback claims.
- **Acceptance:** Checkpoints are never offered while a side effect is unresolved unless that uncertainty is explicitly part of the checkpoint.

### CS-063 — Retry begins from the failed cause, not the visible error card

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Always

- **Invariant:** Classify whether to retry transport delivery, capability probe, auth, model request, tool call, terminal command, file write, Git action, artifact render, child assignment, or external action. Reconcile prior outcome before resubmission.
- **State/protocol:** Preserve request/tool/idempotency ids and causal parent; a new attempt is a linked event, not mutation of history.
- **Degradation:** Unknown outcome offers Check status, Continue manually, or Retry anyway with consequence.
- **Acceptance:** Retrying a failed response-render never reruns the model/tool; retrying a model timeout never repeats a confirmed external tool effect.

### CS-064 — Idempotency policy is explicit per operation class

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Always

- **Invariant:** Mark reads/probes, content-addressed writes, replace-with-version, append, create, send/publish/purchase/deploy, and destructive delete separately. Reuse provider idempotency keys where supported and add local deduplication/reconciliation elsewhere.
- **State/protocol:** Tool/app/MCP safety hints inform but do not prove idempotency; adapters own operation-specific evidence.
- **Degradation:** Open-world mutation with uncertain outcome cannot expose one-click automatic retry.
- **Acceptance:** Duplicate delivery fixtures create at most one commit/upload/message/deployment or halt for review when uniqueness cannot be proven.

### CS-065 — Rollback scope and residual effects are previewed

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: rollback

- **Invariant:** Before rollback, list files/patches, Git index/refs, processes, ports, artifacts, memory/ledger changes, child work, config, and external effects. Separate reversible local changes from compensated, irreversible, or unverified effects.
- **State/protocol:** Create a pre-rollback recovery snapshot and preserve user/unrelated changes.
- **Degradation:** If ownership cannot be proven, offer selective patch/recovery guidance instead of destructive rollback.
- **Acceptance:** Rollback never resets/cleans the whole repository or claims to undo a sent message, purchase, publish, or deployment.

### CS-066 — Revert-to-turn creates a new branch of history

**Phase:** Beta · **Criticality:** C0 · **Applicability:** Feature-gated: revert/fork

- **Invariant:** Reverting restores selected Integrator-owned state and agent-owned changes into a new task/run lineage; the original transcript/evidence remains immutable. Show whether the native session forks, restarts, or receives a handoff.
- **State/protocol:** Codex native fork may preserve session history; ACP fork remains draft/adapter-specific, so provider-neutral snapshot is the fallback.
- **Degradation:** Conversation-only revert cannot claim repository/process rollback.
- **Acceptance:** Users can compare original and reverted lineages, and later events never disappear from audit/history.

### CS-067 — Evidence invalidates when its premises change

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Always

- **Invariant:** Tests, screenshots, reviews, diffs, source claims, build artifacts, and completion assertions record input commit/patch, environment/profile, dependency state, route/tool version, timestamp, and scope. Mark stale when relevant files/base/environment/config change.
- **State/protocol:** Invalidation propagates through artifact/source/test lineage without deleting the original result.
- **Degradation:** Unknown dependency relation uses conservative project-level staleness with explanation.
- **Acceptance:** A passing test from before a rebase or file edit cannot remain a current green completion gate silently.

### CS-068 — Replay executes only reviewed, still-valid, idempotent steps

**Phase:** Beta · **Criticality:** C0 · **Applicability:** Feature-gated: replay

- **Invariant:** A replay plan shows included/skipped steps, current inputs, changed premises, permissions, route, secrets, external effects, idempotency, and checkpoint. Default to recomputing reads/tests and skipping uncertain mutations.
- **State/protocol:** Replay creates new run/tool events linked to originals; it never injects old outputs as if newly observed.
- **Degradation:** Unsupported native replay becomes a generated reviewed plan or provider-neutral handoff, not blind command history execution.
- **Acceptance:** No command/tool with changed target, stale approval, expired credential, protected branch, uncertain prior effect, or non-idempotent mutation runs without new confirmation.

## 12. Repository coordination, communication, Git GUI, and setup terminal

### CS-069 — One Git-common ledger prevents redundant task histories

**Phase:** MVP · **Criticality:** C1 · **Applicability:** Feature-gated: Git repository

- **Invariant:** Main checkout and every linked worktree resolve one versioned authoritative coordination root under the Git common directory. Contracts, current state, decisions, evidence, messages, run records, transcript references, checkpoints, artifacts, and leases are stored once; worktrees receive only ignored regenerable projections and run-owned scratch.
- **State/protocol:** Broker is sole writer of shared records. Agents may write their own scratch/typed proposed notes and promote through the broker; existing `AGENTS.md`, specs, and project docs remain authoritative rather than copied.
- **Degradation:** Non-Git folders use a canonical app-data ledger and may expose a local projection; worktree/Git claims are absent.
- **Acceptance:** Three worktrees and five agents recover from one ledger without transcript copies, competing state summaries, committed runtime files, or loss after projection deletion.

### CS-070 — Agent communication and transcript reads are brokered and scoped

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: delegation

- **Invariant:** Parent/child messages carry lineage, kind, context references, activation boundary, sequence, idempotency, policy, and acknowledgment. Parents may range-read observable descendants; children request minimal parent context; sibling transcript access requires explicit grant.
- **State/protocol:** Prefer structured result/evidence and native steering. Transcript reads are cursor/size bounded, redacted, provenance-hashed, and added to both context manifests; they do not create copied transcript files.
- **Degradation:** Without native transcript/messaging, create an explicit summary/context grant or follow-up run and label incomplete history.
- **Acceptance:** Hidden reasoning, secure terminal input, credentials, unauthorized files, unrelated tasks/accounts, and ungranted sibling content never cross the broker boundary.

### CS-071 — Git actions are paired to the visible worktree lease

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Feature-gated: Git write

- **Invariant:** Selecting a task/child binds Files, Terminal, Review, and Git to the same canonical worktree lease. GUI stage/unstage/discard, commit, fetch, publish/push, pull/rebase/merge, PR, integration, and cleanup name that lease and remain separate operations.
- **State/protocol:** Push previews remote host/repository, branch/refspec/upstream, ahead/behind, protection, commits, auth owner, and force state. Accepting a child opens review; only designated merge authority integrates it.
- **Degradation:** When Git host/credential/protection state is unavailable, allow local review/commit but block or externally hand off push/PR with the limitation.
- **Acceptance:** Task switching, stale focus, timeout-after-push, diverged upstream, dirty work, protected branch, and multiple worktree fixtures cannot operate on or retry against the wrong checkout/ref.

### CS-072 — Existing CLI authentication is reused; setup input stays user-owned

**Phase:** MVP · **Criticality:** C0 · **Applicability:** Runtime-specific

- **Invariant:** A documented healthy CLI login proceeds to capability/compatibility probing. When signed out, Integrator launches only the official vendor login action in a dedicated user-owned Setup terminal or browser/device flow; it never imports credentials or asks an agent to authenticate.
- **State/protocol:** Setup terminal has real PTY behavior where required, no model visibility by default, protected no-echo input, cancellable intent preservation, and post-login status/capability re-probe.
- **Degradation:** If login cannot be safely embedded, open the official external terminal/app/browser flow and offer Check status afterward.
- **Acceptance:** Password/token/device/MFA/hardware-key/account selection bytes are absent from transcript, model context, logs, drafts, search, diagnostics, screenshots, accessibility, and child environment across success, cancel, failure, and crash.

## 13. Cross-system acceptance gates

Before the corresponding phase/feature ships:

1. Every primitive has at least one happy-path fixture, one degraded/no-capability fixture, one interruption/restart fixture, and one adversarial boundary fixture.
2. C0 primitives have threat-model review, secret/redaction coverage, and negative authorization tests.
3. Every automatic fallback records old/new execution identity, changed boundaries, and consent evidence.
4. Every persisted object has account/project/task ownership, version/migration, retention, and deletion behavior.
5. Every cross-window/device/runtime mutation has idempotency, lease, sequence, and reconciliation tests.
6. No runtime/provider capability is inferred from its brand name; it is negotiated, probed, configured, or explicitly degraded.

## 14. Primary sources

### Codex / OpenAI

- [Configuration reference: models, agents, memories, permissions, shell, MCP, network, and updates](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml)
- [Developer commands: model, status, usage, compact, memories, agents, permissions, diff, and review](https://learn.chatgpt.com/docs/developer-commands#built-in-slash-commands)
- [Codex app-server API](https://learn.chatgpt.com/docs/app-server#api-overview)
- [Git worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [Authentication](https://learn.chatgpt.com/docs/auth)
- [Permissions](https://learn.chatgpt.com/docs/permissions)
- [Hooks](https://learn.chatgpt.com/docs/hooks)

### Agent Client Protocol

- [Initialization and capability negotiation](https://agentclientprotocol.com/protocol/v1/initialization)
- [Session configuration options](https://agentclientprotocol.com/protocol/v1/session-config-options)
- [Prompt turns, cancellation, usage, and stop reasons](https://agentclientprotocol.com/protocol/v1/prompt-turn)
- [Tool calls, permissions, diffs, and locations](https://agentclientprotocol.com/protocol/v1/tool-calls)
- [Terminal lifecycle](https://agentclientprotocol.com/protocol/v1/terminals)
- [Client filesystem](https://agentclientprotocol.com/protocol/v1/file-system)
- [Session fork Draft RFD](https://agentclientprotocol.com/rfds/session-fork)
