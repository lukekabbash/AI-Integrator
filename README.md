# AI Integrator

I’m Luke. I have used large language models since they first became available to consumers, and over the years I have learned that the best work rarely comes from asking one model to do everything.

It comes from orchestration.

One agent is better at understanding the system. Another is faster at exploring it. Another is more economical for a long implementation. Sometimes the right move is to let a strong model plan, send bounded work to several agents, bring their evidence back into one place, and then use a different model to review the result. The hard part is no longer access to intelligence. It is directing that intelligence without losing context, control, money, or the thread of the work.

I built AI Integrator because I was doing this manually every day.

## The moment that made it obvious

The model market keeps changing faster than any one coding product can comfortably absorb. In July 2026, three changes landed almost on top of one another:

- [Grok 4.5](https://x.ai/news/grok-4-5) arrived as a fast coding and agentic model at $2 per million input tokens and $6 per million output tokens, while Grok Build made it available through existing SuperGrok and X Premium subscriptions.
- [GPT‑5.6 Sol](https://openai.com/index/gpt-5-6/) arrived in Codex with model tiers for different cost/performance needs and an `ultra` mode that coordinates parallel subagents.
- [Claude Fable 5](https://www.anthropic.com/news/redeploying-fable-5) returned as Anthropic’s model for difficult, long-running work, but moved from plan-included usage toward usage credits.

Those releases did not produce one obvious winner. They produced a portfolio of useful, differently priced intelligence—and a reason to be deliberate about where each task runs.

The products are moving in the same direction. Grok Build now has [long-running goals](https://x.ai/news/introducing-goal) and an [agent dashboard](https://x.ai/news/agent-dashboard) for supervising parallel sessions. OpenAI’s highest GPT‑5.6 effort mode coordinates subagents. Anthropic’s engineering work describes [orchestrator/worker systems](https://www.anthropic.com/engineering/multi-agent-research-system) in which a lead decomposes work, specialized agents explore in separate contexts, and compact results return for synthesis.

That is the important shift: the unit of work is becoming the task and its evidence, not the chat window or the model that happened to start it.

## What AI Integrator is

AI Integrator is the local, accountless workspace I want for doing a significant part of my own work going forward. I plan to keep iterating on it as I use it: preserving what proves useful, deleting what does not, and adapting as models and runtimes change.

At its core, it is a control plane for the coding agents a user already installs and pays for. It lets one durable task move across providers, delegate bounded work to sub-agents, and return the resulting files, decisions, tests, and evidence to one review surface.

```text
state the outcome
→ choose the right runtime, model, and effort
→ give it explicit context and authority
→ delegate bounded work where parallelism helps
→ bring back evidence, not copied transcript soup
→ review one coherent change set
→ commit, push, merge, or deploy as separate decisions
```

The ambition is not “every chatbot in one window.” That would be a switchboard.

The ambition is an agent-native operating environment where:

- the task survives switching models, providers, sessions, and worktrees;
- goals, slash actions, skills, permissions, and acceptance criteria remain attached to the work;
- a lead agent can discover eligible peers and delegate with a bounded contract;
- each child gets the minimum context and authority it needs;
- Git and worktree identity are explicit before anything writes;
- usage from subscriptions, credits, and APIs is shown honestly;
- and the user can always see what happened, what changed, what was verified, and what remains uncertain.

## Why subscriptions matter

Many people already pay OpenAI, Anthropic, xAI, Cursor, or another vendor for an agent runtime. That access is often trapped inside separate applications with separate histories and separate ideas of a task.

Integrator is designed to use those vendor-owned runtimes and the access the user already has, where the vendor permits it. It does not scrape credentials, pool accounts, impersonate an official integration, or quietly reroute model traffic through an Integrator service. Authentication and inference remain with the vendor. Integrator coordinates the local work around them.

This matters economically. Multi-agent systems can improve breadth and speed, but they can also consume dramatically more tokens; Anthropic reports roughly 15× chat token use in one multi-agent research system. Good orchestration therefore is not “spawn as many agents as possible.” It is choosing when another context window is worth paying for, which model deserves the judgment-heavy work, and which subscription-backed or lower-cost runtime can execute a well-bounded assignment.

## What makes this agent-native

Agents are tool calls in a loop. Better models help, but the quality of an agent also depends on the context and feedback each tool call produces for the next one.

Integrator treats that loop as a product-design problem:

- Tool results should return the state needed for the next decision, not a decorative success message.
- Delegated assignments need an objective, boundaries, an output contract, and a budget.
- Child results should return as references and durable artifacts instead of being repeatedly copied through prompts.
- Long-running work needs checkpoints, recovery, cancellation, and honest uncertain states.
- A model should never be told an action succeeded merely because the UI wanted a clean ending.
- The runtime and harness are part of execution identity; the same named model in two products is not assumed to behave identically.

This is why sub-agent orchestration and Git management are central rather than adjacent features. They are the machinery that lets several agents contribute to one controlled body of work.

## Local first, by design

AI Integrator has no required Integrator account, hosted task backend, credential proxy, cloud transcript sync, or mandatory telemetry pipeline.

The native core supervises local processes, tasks, worktrees, permissions, evidence, and recovery. Vendor credentials remain in vendor or operating-system stores. The renderer receives narrow typed commands, never arbitrary shell, filesystem, Git, or credential authority. Every writing run has an explicit repository or worktree identity, and commit, push, merge, deploy, and cleanup remain distinct user-controlled actions.

Local-first does not mean every model runs offline. It means Integrator does not need to become the custodian of the user’s identity, prompts, credentials, or code in order to coordinate the tools they chose.

## Current direction

The v1 is a native Windows and macOS application built with Tauri, Rust, React, and TypeScript.

Its first complete loop is:

1. Open or clone a repository.
2. Connect an installed runtime using its official authentication.
3. Create a durable task with a goal, context, permissions, and execution route.
4. Stream and supervise the run, including approvals and recovery.
5. Delegate one bounded child task into an explicit worktree when useful.
6. Review the resulting evidence and diff.
7. Commit and push as separate, explicit actions.

Codex and Cursor are the first certified runtime paths. Additional ACP and structured-stream runtimes are capability-gated until their actual behavior passes the same conformance bar. Provider names in the UI are not promises of parity.

## Build contracts

This README tells the story. The documents below tell humans and coding agents how to build the product without gradually mutating its boundaries:

- [Product thesis](docs/product-thesis.md) — canonical rationale, agent-first/native meaning, and non-negotiable boundaries.
- [v1 scope](docs/v1-scope.md) — definitive in/out scope, milestones, and release gates.
- [Product specification](docs/product-spec.md) — task model, orchestration, handoffs, usage, workflows, and acceptance behavior.
- [Native architecture](docs/architecture.md) — process topology, typed native boundary, supervision, and platform strategy.
- [Local-first contract](docs/local-first-contract.md) — identity, storage, network, authentication, privacy, and portability.
- [Repository coordination protocol](docs/repo-coordination-protocol.md) — durable state, worktrees, run scratch, messages, evidence, and Git ownership.
- [Broker MCP contract](docs/broker-mcp-contract.md) — narrow agent-facing delegation and coordination tools.
- [Design-system contract](docs/design-system-contract.md) and [workspace primitives](docs/ui-ux-primitives.md) — the production UI behavior and visual system.
- [Implementation plan](docs/implementation-plan.md) — current integration truth, unfinished systems, and verification gates.

These contracts stay in Git because the agent building the application needs the same durable source of truth as the human reviewing it. Historical research may age. Product boundaries, security rules, and acceptance tests must remain reviewable.

## Status

AI Integrator is under active development and is not yet a certified release. The implementation already contains the native shell, local persistence, runtime discovery, early Codex and ACP paths, task navigation, streaming projections, approvals, repository inspection, file review, Git foundations, settings, and semantic themes. Delegation, full PTY behavior, complete restart/recovery certification, signed packaging, and the full release fixture matrix remain active work.

This repository is not a claim that the orchestration problem is solved. It is where I intend to solve it in the open, through use.
