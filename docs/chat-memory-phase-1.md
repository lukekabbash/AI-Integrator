# Chat and Memory Phase 1 Contract

This document fixes the Phase 1 and Phase 1.5 product boundary before implementation. It is subordinate to `v1-scope.md`, `architecture.md`, `local-first-contract.md`, and `design-system-contract.md`.

## Product intent

Integrator gains a calm, general-purpose Chat lane beside its project-bound coding tasks. Chat is not a cosmetic composer preset. It is a durable task kind with a narrower native capability envelope, local searchable history, explicit transcript references, and an optional, inspectable memory scratchpad.

The feature remains accountless and local-first. It does not require an Integrator backend, an embedding provider, a vector database, or an API key.

## Phase 1: embedding-free Chat

### Navigation and task identity

- The primary sidebar contains independently collapsible **Projects** and **Chats** sections.
- Project rows contain only code tasks. Chats is a flat, recent-first list of general chats.
- The global **New chat** action creates a durable empty Chat task immediately. Project `+` actions continue to create code tasks on first send.
- After the first successful send, an isolated tool-denied helper on the selected runtime replaces **New chat** with a specific 2-5 word title. Chat naming uses a general-conversation prompt rather than the project-task naming prompt.
- Task kind is persisted as `code` or `chat`; existing rows migrate to `code`.
- Forks preserve task kind. Archive, pin, rename, delete, search, export, and restart behavior work for both kinds.

### Chat surface

- Chat uses the existing open transcript surface: user messages have a bubble; assistant text streams directly onto the background; neither side has an avatar.
- The Chat composer retains prompt text, runtime and model routing, `@` context, `/` skills, the existing `+` attachment picker, clipboard-image paste, and its circular send/stop control.
- User-picked Chat files are copied into task-scoped app storage by the native host. UTF-8 text is injected as bounded quoted context; images use each provider's multimodal input route. Binary documents outside the supported image set fail explicitly rather than granting the agent a filesystem-reading tool.
- Coding-only permission and delegation controls are absent. The host fixes Chat to its commandless policy; the UI does not imply that the user can relax it.
- Git, file, diff, terminal, delegation, and project rails are not mounted for Chat tasks.
- Drafts and queued messages remain crash-safe because an empty Chat task exists before composition begins.

### Native authority boundary

Chat keeps every installed, certified runtime available. The native host applies a provider-specific version of the same boundary; the selector never relaxes Chat authority.

A runtime qualifies only when the native host can:

1. disable its shell/command tool or confine it to an app-owned empty directory under a read-only/no-approval policy;
2. prevent project, Git, arbitrary filesystem, and delegation access;
3. use an app-owned empty working directory chosen by the native host;
4. limit MCP to an explicit Chat-safe tool allow-list; and
5. run without reading repository instructions, hooks, skills, or configuration from a user project.

User-selected attachments are the sole exception to the empty-filesystem rule: the native host copies them into task-scoped app storage, validates count and size limits, and supplies only those copies as quoted text or multimodal input. This does not grant general file browsing or command authority.

Codex app-server starts its Chat thread with:

- `sandbox = read-only`;
- `approvalPolicy = never` so forbidden actions fail instead of opening an approval path;
- ephemeral `features.shell_tool = false`, `features.shell_snapshot = false`, `features.multi_agent = false`, `features.apps = false`, and `features.hooks = false`;
- `web_search = disabled` unless a later, explicit Chat-safe browsing policy is added;
- only the Integrator Chat broker MCP; and
- Chat-specific developer instructions that accurately describe the host restrictions.

The remaining certified runtimes apply the strongest native boundary they expose:

- Cursor is pinned to its advertised `ask` mode with its sandbox enabled. Session creation fails closed if Ask or Plan is not advertised.
- Kimi is pinned to Plan, replaces skill discovery with the app-owned empty Chat directory, and likewise fails closed when the session does not advertise Ask or Plan.
- Claude runs in `dontAsk` with an empty built-in tool list, slash commands and Chrome disabled, safe mode enabled, and only the explicit Integrator Chat MCP configuration.
- Grok runs with an empty built-in tool list, read-only sandbox, `dontAsk`, web search, subagents, and memory disabled, and its Claude/Cursor compatibility scanners disabled for the Chat process.
- Antigravity runs in Plan with its sandbox enabled. An app-owned hook denies every tool call except the exact Integrator scheduling controls and, when memory is opted in, `memory_save`.

All adapters use the app-owned Chat directory, force read-only/no-delegation routing, reject provider-native commands from the renderer, omit project skills and external MCP servers, and receive the same durable Chat instructions. Code tasks keep their current provider capabilities.

### Skills and MCP

- Skills are context instructions, not authority. Only skills explicitly marked Chat-safe appear in Chat autocomplete.
- Provider-native commands and coding-only slash actions do not appear in Chat.
- External MCP servers are disabled in Phase 1 Chat even when globally enabled. A later release may add per-tool Chat certification using MCP annotations plus a user-controlled allow-list; annotations alone are not sufficient authority.
- The only Chat MCP surface is an Integrator-owned, task-scoped broker role. Phase 1.5 adds its bounded memory tool.

### Local search

- Existing SQLite FTS powers cross-chat keyword search without an API key.
- Chat search is kind-filtered and returns matching Chat tasks and snippets. Project-task search remains available in its existing scope.
- Semantic/vector retrieval is explicitly outside Phase 1. No embeddings or RAG keys are requested.

### `@chat` context

- Typing `@` in either Chat or code mode can select a Chat task.
- Selection creates a typed context reference chip; it is not treated as a filesystem attachment.
- On send, the native host resolves the source transcript from SQLite, renders only completed user and assistant messages to legible Markdown, applies a hard size cap, and injects it as hidden host context. Tool logs, raw event JSON, hidden reasoning, approvals, and unfinished output are excluded.
- The visible user message remains the text the user typed. Context is not pasted into the bubble.
- Each send stores immutable provenance: reference id, target task, source Chat, source title, source transcript watermark, rendered character count, hash, and the bounded Markdown snapshot that was actually supplied. The snapshot makes future code-agent handoff reproducible while the source id remains the canonical relationship.
- Oversized transcripts fail explicitly. Phase 1 does not silently truncate; range and summary controls are later work.
- Deleting a source Chat nulls the live relationship but preserves the already-used bounded snapshot and provenance in the target task.

## Phase 1.5: transparent scratchpad memory

Memory is a small, provider-neutral set of durable user facts and preferences. It is not a hidden profile, a transcript summary, or an embeddings index.

### Data and limits

- Memory is disabled by default and can be enabled independently of any API key.
- At most 20 active entries exist across the app.
- Each entry is plain text, at most 500 Unicode scalar values; the total injected memory block is capped at 8,000 characters.
- Entries carry id, text, active/disabled state, creator (`user` or `agent`), optional source task/item, and created/updated/last-used timestamps.
- Phase 1.5 scope is global. Project-specific and per-chat memory scopes are later work; a single scope keeps behavior legible.
- Exact normalized duplicates are rejected. Content that appears to contain credentials or secrets is rejected rather than silently stored or redacted.

### User control

- Settings contains one flat Memory section with an enable switch, active count, add field, and editable rows.
- Users can inspect, edit, disable, re-enable, and delete every entry, including entries proposed by an agent.
- Disabling the feature stops both injection and agent writes; it does not delete entries.
- Export includes memories. Clear-all and task deletion obey the local-first deletion contract.

### Agent writes and injection

- A Chat-safe Integrator MCP tool, `memory_save`, is the only agent write path.
- The broker authenticates the short-lived task-scoped grant, verifies that the source task is a Chat, verifies memory is enabled, applies all size/count/dedup/secret rules transactionally, and returns the stored entry or a clear rejection.
- System instructions limit saves to explicit, durable user preferences or stable facts useful across future chats. They prohibit inferred sensitive traits, secrets, transient requests, assistant conclusions, and transcript summaries.
- Active memories are injected as a bounded, clearly delimited host-context block. They are treated as user-controlled context, never as higher-priority instructions.
- Injection order is deterministic and recent-first. The host records `last_used_at` only for entries actually included.

## Storage and migration

The next schema migration adds:

- `tasks.kind` with a `code | chat` check and `code` default;
- `task_context_references` for immutable `@chat` provenance and snapshots;
- `memories` with state, limits, source attribution, and timestamps; and
- reference-id arrays on drafts and queued messages so selections survive restart and queueing.

All foreign keys use explicit deletion behavior. New indexes cover task kind/recent ordering, context target/source lookup, and active-memory ordering. Migration tests must cover an existing pre-Chat database, idempotent startup, foreign-key integrity, and export/clear behavior.

## Acceptance boundary

Phase 1 and 1.5 are complete when:

- existing installations migrate without changing current tasks;
- a Chat can be created, drafted, sent, streamed, queued, resumed, searched, archived, forked, and deleted across restart;
- the renderer cannot choose a Chat working directory or relax Chat authority;
- a Chat runtime receives no shell, project, external MCP, or delegation tool;
- a code task can `@` a Chat and the exact supplied Markdown snapshot/provenance is durable and legible;
- memory defaults off, enforces its limits natively, is fully user-manageable, and reaches only qualifying Chat sessions;
- focused Rust and UI tests cover happy, degraded, restart, cancellation/queue, and adversarial authority states; and
- the Chats sidebar and Chat composer pass desktop visual inspection without nested-card UI.

## Deferred work

Embedding providers, semantic retrieval, RAG API keys, vector storage, automatic transcript chunking, cross-chat generated summaries, project-scoped memories, and external Chat MCP certification are not part of these phases.
