# AI Integrator product thesis

**Status:** canonical product rationale
**Audience:** contributors, coding agents, runtime-adapter authors, and future maintainers

## Why this exists

AI Integrator was made for people who already use several coding agents and already pay for access to them. The useful question is no longer “which single model should I use?” It is:

> Which installed runtime is the right instrument for this part of the task, and how can the work move between runtimes without losing context, control, or proof?

The motivating experience was orchestrating across providers as new models and pricing appeared: Grok 4.5 at a competitive cost point alongside GPT-5.6 Sol, with Fable 5 moving from plan-included usage toward usage credits. The names and prices may change. The underlying product problem does not: people have provider subscriptions, different runtimes have different strengths, and the user should be able to compose them deliberately instead of manually copying prompts between isolated products.

This is not a reseller, a model wrapper, or a new hosted agent service. It is a local control plane for the agent runtimes the user has chosen.

## The product thesis

AI Integrator is agent-first and agent-native:

- **Agent-first:** the durable unit is a task that can be planned, executed, delegated, reviewed, resumed, and handed off. The provider is an execution choice inside that task.
- **Agent-native:** each provider keeps its own runtime, authentication, model access, tools, skills, permission semantics, and session behavior. Integrator adds coordination around those native systems instead of flattening them into a fake common agent.
- **Subscription-aware:** existing vendor subscriptions are a meaningful input to routing and budgeting. Integrator may show provider-reported, locally observed, estimated, or unavailable usage, but it never invents quota or calls an estimate actual spend.
- **Orchestration-native:** a lead agent can give a bounded contract to another agent, with scoped context, policy ceilings, budget, worktree ownership, and a return schema. The child returns evidence; it does not silently take over the parent task.
- **Repository-native:** Git, worktrees, diffs, tests, commits, and pushes are part of the task lifecycle. Writing authority is explicit, and commit, push, merge, deploy, and cleanup remain separate actions.

## What Integrator adds

The providers already know how to run their own agent loops. Integrator supplies the missing coordination layer:

1. A provider-neutral task contract containing the goal, constraints, acceptance criteria, context references, and current decisions.
2. A runtime/model/effort choice that is visible at the point of execution.
3. A local broker for bounded delegation and peer-agent communication.
4. A shared evidence and review surface for files, tools, tests, approvals, artifacts, and Git state.
5. Durable local state so work can survive a restart or a runtime handoff.
6. Honest usage and budget dimensions so cost-saving choices remain observable.
7. A security boundary that keeps credentials and arbitrary authority with the vendor runtime or the native supervisor.

The goal is not to make every runtime look identical. The goal is to make differences usable, inspectable, and safe.

## The intended operating loop

```text
state the outcome and constraints
→ select or let the user choose a capable runtime
→ run with an explicit permission and repository scope
→ delegate bounded investigation or implementation when useful
→ receive referenced results and evidence
→ review one coherent change set
→ verify tests and unresolved claims
→ commit, push, or hand off as distinct explicit actions
```

Slash commands, goals, skills, task contracts, and handoffs belong to this same task model. They should work across runtimes where the runtime exposes an equivalent capability, and they should be visibly capability-gated where it does not. A missing capability is a real state, not an invitation to simulate success in the UI.

## Non-negotiable boundaries

- No required Integrator account, hosted task backend, credential proxy, cloud transcript sync, or mandatory telemetry.
- Vendor authentication remains vendor-owned; credentials and secure terminal input never enter renderer state, logs, transcripts, exports, or the Git coordination ledger.
- The renderer receives typed, allowlisted commands only. It never receives arbitrary shell, filesystem, Git, or credential authority.
- Every writing run has an explicit repository/worktree identity and policy ceiling.
- Parent and child runs use references before copied context. Scratch is run-owned; shared state is broker-owned.
- Unsupported or uncertain behavior is labeled and reconciled rather than presented as completed work.

## How to use the rest of this repository

Read this document first when changing the product direction. Then use the normative contracts for implementation:

- [`v1-scope.md`](v1-scope.md) owns release scope and acceptance gates.
- [`architecture.md`](architecture.md) owns process boundaries and native topology.
- [`local-first-contract.md`](local-first-contract.md) owns storage, identity, network, privacy, and portability.
- [`product-spec.md`](product-spec.md) owns the domain model and end-to-end behavior.
- [`repo-coordination-protocol.md`](repo-coordination-protocol.md) and [`broker-mcp-contract.md`](broker-mcp-contract.md) own multi-agent coordination.
- [`design-system-contract.md`](design-system-contract.md) and [`ui-ux-primitives.md`](ui-ux-primitives.md) own the UI behavior and visual system.

Research and design-history documents explain why some decisions were made. They are useful context, but they do not override the normative contracts above.
