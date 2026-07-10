# Native interaction parity matrix

**Product:** AI Integrator  
**Source review:** 2026-07-10  
**Focus:** The fine-grained interaction primitives users expect from current Codex and Claude Code surfaces.

“Wrap the CLIs in a GUI” understates the work. The shell process is only the engine boundary. A credible replacement must reproduce the interaction grammar around it: durable tasks, context attachment, native session lifecycle, typed activity, safe approvals, steering, transcript density, file opening, editable previews, diff review, subagent inspection, background work, worktrees, usage, and recovery.

This document defines that parity target. It does not authorize a first-class Claude subscription integration; the legal boundary in [integration-catalog.md](integration-catalog.md) still applies. Claude Code is studied here because its UX primitives are important product references.

For the client-side details that sit between native parity and a polished desktop implementation—drafts, focus, scroll, replay, capability degradation, resizers, notifications, copy behavior, and lifecycle truth—use the [QOL microinteraction catalog (200)](qol-100.md). Context, repository, terminal, quota, update, secret, remote, accessibility, execution-route/delegation, and checkpoint boundaries are normative in [Critical systems primitives](critical-systems-primitives.md), with release assignment in the [Delivery and criticality matrix](delivery-criticality-matrix.md). Shared repo notes, agent mailboxes, transcript references, worktree pairing, and Git GUI behavior are defined in the [Repository coordination protocol](repo-coordination-protocol.md); its agent-callable surface is the [Broker MCP contract](broker-mcp-contract.md).

## 1. Surfaces compared

| Family | Surfaces considered | Best source for implementation |
|---|---|---|
| Codex | ChatGPT desktop app Code/Codex task, Codex CLI, IDE extension | `codex app-server` plus official app and CLI docs |
| Claude Code | Claude Desktop Code tab, Claude Code CLI, VS Code extension, headless/Agent SDK | Official Desktop, commands, interactive-mode, subagent, agent-team, and headless docs |
| AI Integrator | Desktop task UI with runtime adapters | Normalized event ledger plus capability-driven native escape hatches |

The products are not internally uniform. Claude Desktop and Claude CLI have different commands and shortcuts. Codex desktop and Codex CLI also expose different controls. AI Integrator should unify concepts, not pretend every command exists on every surface.

## 2. Canonical primitive vocabulary

| Primitive | Definition |
|---|---|
| Project | A folder/repository boundary and shared local configuration. |
| Task | Durable user-visible unit containing messages, runs, artifacts, agents, and verification. |
| Native session | Vendor-owned conversation/session ID used for resume and native history. |
| Turn | One user instruction plus the agent work it triggers. |
| Activity item | Typed observable action: tool call, command, file change, search, review, or delegation. |
| Reasoning | Only reasoning content or summary explicitly delivered by the runtime. It is not inferred from activity. |
| Plan | Agent-authored proposed steps or tracked checklist. |
| Goal | Persistent completion condition that may continue across turns. |
| Side chat | Ephemeral context-aware question that does not alter main task history. |
| Fork | New conversation branch copied from existing history. |
| Subagent | Delegated worker with an identity and isolated or inherited context. |
| Background task | Shell, agent, or workflow that continues while the main conversation remains usable. |
| Artifact | Generated or modified file that can be opened, previewed, annotated, or exported. |
| Review scope | Git state being inspected: unstaged, staged, commit, branch, or last turn. |
| Permission request | Runtime request for a specific action that policy has not pre-authorized. |
| Handoff | Provider-neutral context package used when native session transfer is impossible. |

## 3. Executive parity matrix

Legend: **Native** means a documented first-party primitive. **Protocol** means AI Integrator can reproduce it through an official structured interface. **Emulate** means the host must own the behavior. **No claim** means the control must be absent or labeled as a fallback.

| Primitive | Codex native | Claude Code native | AI Integrator requirement |
|---|---|---|---|
| New/resume/rename/archive task | Native | Native session lifecycle | Unified task UI; bind one or more native session IDs |
| Branch/fork conversation | `/fork`, app-server `thread/fork` | `/branch`, `/fork`, checkpoints | Native fork when available; handoff fork otherwise |
| Mid-turn steering | App-server `turn/steer` | Submit/redirect while running; Esc/Ctrl+C interrupts | Protocol where available; queued steer with honest status otherwise |
| Stop/cancel | `turn/interrupt`, UI stop | Esc/Ctrl+C, `/stop`, task stop | Must terminate turn, not merely hide output |
| Plan mode | `/plan`, typed `plan` items | `/plan`, task checklist | Common plan card with runtime provenance |
| Persistent goal | `/goal`, goal progress row and API | `/goal` current CLI | Common goal row; no synthetic auto-continuation unless host owns it |
| Context compaction | `/compact`, `contextCompaction` item | `/compact` | Common explicit action and visible completion marker |
| File mention | `/mention`, IDE context, attachments | `@` autocomplete, attachments, `/add-dir` | `@` file picker plus chips; adapters translate |
| Shell shortcut | Integrated terminal / user shell command | `!` shell mode | Terminal pane; direct shell is clearly user-initiated |
| Skill invocation | `$skill`, slash list | slash skill name | One picker; retain runtime/source label |
| Diff review | Review pane, inline comments, Git actions | `/diff`, Desktop diff pane, line comments | Full structured diff workspace independent of transcript |
| Stage/revert hunk | Native app Git controls | Desktop review focuses feedback; Git actions vary | Host Git service owns stage/unstage/revert with safeguards |
| Per-turn diff | Last-turn scope | `/diff` per-turn views | Required when event-to-change attribution is reliable |
| File open/edit | Editor deep link, preview/browser/artifact viewers | File pane, Open in editor, reveal, copy path | File-path menus and editable local file pane |
| Transcript density | Typed app-server items and collapsible activity | Normal/Verbose/Summary; CLI verbose transcript | Normal/Verbose/Summary plus Raw diagnostics |
| Visible thinking | Reasoning summary/content only if emitted | Extended thinking, usually collapsed; verbose expands | Explicit “runtime-provided reasoning”; never infer hidden thought |
| Subagent tree | Native child threads and collaboration items | Subagents, tasks pane, agent teams, agent view | Agent roster/tree with open, steer, stop, result, usage |
| Background shells | Background terminal APIs and `/ps` | `/tasks`, Ctrl+B, Desktop tasks pane | One task drawer for commands, agents, and workflows |
| Worktree isolation | Native desktop worktrees | Automatic Desktop worktrees; CLI `--worktree` | Broker-managed by default; show branch/path/dirty state |
| Model/effort switch | Model list and reasoning selector | `/model`, `/effort`, Desktop menus | One lower-right route selector for connection/runtime/provider-model/tier/effort, capability-filtered |
| Delegation policy | Native roles/subagent settings plus spawned threads | Subagent definitions, tasks pane, agent teams where supported | Adjacent lower-right Off/Ask/Bounded/Auto control with peer, role, depth, concurrency, budget, permission, worktree, fallback, and evidence rules |
| Permissions | Sandbox and bidirectional approvals | Modes and allow/ask/deny rules | Common intent profiles translated to runtime-native policy |
| Usage/status | `/status`, `/usage`, app-server usage and rate limits | usage ring, `/usage`, JSON usage/cost | Separate context, provider quota, measured tokens, and estimates |
| Terminal | Per-task integrated terminal | Integrated terminal and tabs | Per-task terminal with current workspace/worktree identity |
| Preview/browser | Built-in browser and artifact previews | Browser/preview pane and dev-server configuration | P1 shared preview pane; annotate exact element/region |

## 4. Composer and input primitives

### 4.1 Prefix grammar

| Input | Codex | Claude Code | AI Integrator behavior |
|---|---|---|---|
| Plain text | New turn or steer | New turn or redirect | Sends to selected runtime/path; draft persists locally |
| `/` | Native commands, custom prompts, enabled skills | Native commands and skills | Unified searchable command palette with runtime badge |
| `@` | Files/folders, apps by product UI, IDE context | File autocomplete, agents, MCP resources | Context picker grouped by Files, Agents, Apps, MCP, Tasks |
| `$` | Explicit skill invocation | Not the primary Claude convention | Skill picker; projects the correct native syntax |
| `!` | User shell via terminal/native command surfaces | Direct shell mode adds output to session | Run in task terminal; opt-in “attach output to next turn” |
| Paste image | Task attachment | CLI clipboard image chip, Desktop attachment | Image chip with remove, caption, and privacy state |
| Drag file/folder | App attachment/project action | Desktop attachments; folder/project selection | File chip or project-root action based on drop target |

The composer must retain a visible execution route, delegation policy, permission profile, workspace/worktree, and goal state without turning them into large provider toggles. The lower-right group is `Delegation → Route/model → Voice → Send/stop`; a path such as `Cursor · Claude Sonnet · High` is one selection, not three setup screens. Full connection/subscription and provider identity remain one action away.

### 4.2 Draft and queue states

Required states:

- **Draft:** persisted per task before send.
- **Queued:** accepted but waiting for the active turn to end.
- **Steering:** delivered into the active turn through a native steer primitive.
- **Side question:** context-aware but not appended to the main history.
- **Command:** parsed locally or by the runtime; never accidentally sent as prose.
- **Blocked:** waiting for auth, permission, runtime recovery, or required user input.

Codex CLI allows a slash command to be queued for the next turn. Claude accepts interruption and backgrounding patterns. The normalized UI must show whether a message will steer now, queue next, interrupt and replace, or open a side chat before the user submits it.

## 5. Product-relevant native command map

This table intentionally omits novelty and merchandising commands. It captures commands that imply a reusable product primitive. Availability changes by version, plan, platform, and surface; always probe the installed runtime.

| Intent | Codex command | Claude Code command | Normalized UI |
|---|---|---|---|
| Permissions | `/permissions`, `/approve` | `/permissions`, permission-mode shortcut | Permission pill and pending approval card |
| IDE context | `/ide`, `/mention` | `@file`, `/add-dir`, `/cd` | Context drawer and workspace selector |
| Agent inspection | `/agent`, `/subagents` | `/tasks`; ask Claude to manage agents | Agents pane with task tree |
| Apps/MCP | `/apps`, `/mcp`, `/plugins` | `/mcp`, `/plugin` | Sources/tools drawer with runtime scope |
| Skills | `/skills`, `$skill` | `/skills`, `/skill-name` | Skills picker and invocation chip |
| Hooks | `/hooks` | Hooks configured in files; verbose events | Automation/settings surface, not transcript noise |
| Fresh task | `/clear`, `/new` | `/clear` | New task confirmation preserving current work |
| Rename | `/rename` | `/rename` | Editable task title |
| Archive/delete | `/archive`, `/delete` | Close/archive via session surfaces | Separate reversible archive and destructive delete |
| Compact | `/compact` | `/compact` | Context meter action plus timeline marker |
| Copy/export | `/copy` | `/export` | Copy latest, export task, export raw diagnostics |
| Diff | `/diff` | `/diff` | Open Review workspace |
| Review | `/review` | `/security-review`, `/simplify`, review skills | Review action with scope and reviewer path |
| Login/logout | `/logout`; app-server account API | Vendor `/login`/`/logout`, auth commands | Vendor-owned connection settings only |
| Model | `/model`, `/fast` | `/model`, `/fast` | Model/service-tier selector |
| Effort/thinking | model/reasoning selectors | `/effort`, thinking toggle | Effort selector; separate transcript reasoning visibility |
| Plan | `/plan` | `/plan` | Plan mode; plan item card |
| Goal | `/goal` | `/goal` | Persistent goal row with pause/edit/clear |
| Background terminals | `/ps`, `/stop` | `/tasks`, `/background`, `/stop` | Background work drawer |
| Fork/branch | `/fork` | `/branch`, `/fork` | Fork menu explaining context and workspace behavior |
| Side chat | `/side`, `/btw` | `/btw`, Desktop side chat | Temporary right-side chat |
| Resume | `/resume` | `/resume`, `/continue` | Task/session picker and reconnect |
| Desktop handoff | `/app` | `/desktop`, `/app` | Open native client escape hatch |
| Raw/focus transcript | `/raw` | `/focus`, `/tui`, Ctrl+O | Transcript density and raw-source controls |
| Status/usage | `/status`, `/usage` | `/status`, `/usage`/`/stats` | Usage popover with confidence labels |
| Memory | `/memories` | `/memory` | Memory scope and provenance UI |

Sources: [Codex CLI commands](https://learn.chatgpt.com/docs/developer-commands), [Codex desktop slash commands](https://learn.chatgpt.com/docs/reference/slash-commands), [Claude Code commands](https://code.claude.com/docs/en/commands), [Claude interactive mode](https://code.claude.com/docs/en/interactive-mode).

## 6. Files, paths, and context

### 6.1 File path interactions

Every rendered path should be a first-class object, not inert monospace text. The context menu should support:

- Open in AI Integrator file pane.
- Attach as context to the draft.
- Open in configured editor.
- Reveal in Explorer/Finder.
- Open containing folder in task terminal.
- Copy absolute path.
- Copy project-relative path.
- Open diff for this file when changed.
- Ask a side question about the file.

Claude Desktop documents this exact pattern for paths in chat, its diff viewer, and file pane. Its file pane supports spot edits, Save, Discard, external-change conflict warnings, and copying the absolute path. Local and SSH sessions allow direct editing; cloud sessions do not. [Claude Desktop file behavior](https://code.claude.com/docs/en/desktop)

Codex's review pane opens files in the configured editor, supports command-click on a line, and exposes previews/annotations for artifacts and local web pages. [Codex code review](https://learn.chatgpt.com/docs/code-review), [work with files](https://learn.chatgpt.com/docs/artifacts-viewer), [browser](https://learn.chatgpt.com/docs/browser)

### 6.2 File pane requirements

- Syntax highlighting and line numbers.
- Read-only or editable state derived from task permissions.
- Unsaved indicator separate from Git dirty state.
- External modification detection with Compare, Reload, Overwrite, and Save As.
- Breadcrumb path and copy/reveal/open actions.
- Go to line from transcript or diff.
- Selection-to-prompt action creating a line-range chip.
- Large/binary/generated-file guardrails.
- No automatic write merely from opening a file.

### 6.3 Context chips

Each chip records:

```text
kind, display_name, canonical_uri, project_relative_path, line_range,
content_digest, source_runtime, attachment_mode, size, trust_state
```

Attachment mode distinguishes snapshot content, live path reference, selected text, image, generated artifact, and external source. If the file changes after attachment, show **Changed since attached** rather than silently replacing the context.

## 7. Transcript, activity, and reasoning

### 7.1 Three distinct layers

1. **Reasoning:** only vendor-delivered reasoning blocks or summaries.
2. **Activity trace:** observable actions and results: searches, reads, commands, edits, approvals, and delegation.
3. **Response:** commentary, questions, summaries, and final answer.

Do not label the activity trace “Thinking.” Reading a file or running tests is an action, not internal reasoning. Do not synthesize reasoning sentences from tool activity.

### 7.2 Transcript density modes

AI Integrator should match Claude Desktop's useful Normal/Verbose/Summary distinction and add a diagnostic-only Raw mode.

| Mode | Visible by default | Purpose |
|---|---|---|
| Summary | User messages, final responses, changes, approvals, failures, verification | Scan many tasks quickly |
| Normal | Summary plus plans and collapsed activity groups | Daily default |
| Verbose | Every delivered activity item, file read, command, tool call, subagent message, and reasoning summary | Debug and audit |
| Raw | Redacted vendor events or PTY transcript with framing metadata | Adapter diagnostics; never default |

Claude Desktop documents Normal as collapsed tools plus full responses, Verbose as every tool call/file read/intermediate step, and Summary as final responses and changes. Its CLI uses `Ctrl+O` for detailed transcript viewing. [Claude Desktop view modes](https://code.claude.com/docs/en/desktop), [Claude interactive transcript viewer](https://code.claude.com/docs/en/interactive-mode)

### 7.3 Codex typed items

Codex app-server exposes a `ThreadItem` union. The UI mapping should be direct:

| App-server item | Component |
|---|---|
| `userMessage` | User bubble with text/image/local-image chips |
| `agentMessage` | Commentary/final response block using the delivered phase |
| `plan` | Plan card; completed item is authoritative |
| `reasoning` | Collapsible runtime-provided reasoning section |
| `commandExecution` | Command card with cwd, actions, live output, duration, and exit status |
| `fileChange` | Change group with paths, kind, diff, and final status |
| `mcpToolCall` | Tool card with app/server identity and safe arguments/result |
| `dynamicToolCall` | Client-executed tool card |
| `collabToolCall` | Agent/delegation event linked to parent and child threads |
| `webSearch` | Search/open/find activity group |
| `imageView` | Image-open event linked to preview |
| `enteredReviewMode` / `exitedReviewMode` | Review phase marker and findings link |
| `contextCompaction` | Context-compacted timeline marker |

All items have started/completed lifecycle events. The final completed object wins over intermediate deltas. [Codex app-server items](https://learn.chatgpt.com/docs/app-server#items)

### 7.4 Thinking/reasoning visibility rules

Claude Code currently treats extended thinking as runtime output. In the CLI it is collapsed by default for newer adaptive-reasoning models and appears in gray italic text in verbose mode; `Ctrl+O` expands the transcript. Current Claude docs say Fable 5 always decides its own thinking depth and its thinking cannot be turned off with the ordinary toggle. Interactive Anthropic API sessions may receive redacted thinking blocks unless summary display is enabled. [Claude model configuration](https://code.claude.com/docs/en/model-config)

Codex app-server can deliver `reasoning.summary` and `reasoning.content`. AI Integrator rules:

- Display only fields actually delivered by the runtime.
- Label the section **Reasoning from {runtime}** or **Reasoning summary**, never generic “full thoughts.”
- Respect vendor redaction and policy flags.
- Collapsed by default in Normal and Summary modes.
- Never derive missing reasoning from commands, file reads, token timings, or model output.
- Never expose reasoning from one agent to another automatically; delegation receives an intentional task brief or result summary.
- Persist displayable reasoning only if the runtime persists it and product retention settings allow it.
- Usage counts include thinking tokens when the vendor reports them, even if the content is collapsed or redacted.

## 8. Commands, tools, and terminal activity

### 8.1 Command card

Required fields:

```text
command, cwd, shell, process_id, agent_id, permission_source,
started_at, live_output, truncated_bytes, exit_code, duration, status
```

Actions:

- Expand/collapse output.
- Copy command or selected output.
- Open terminal attached to the same process when supported.
- Stop process.
- Retry through a new permission decision.
- Save full output as a local artifact.
- Ask a side question about failure.

Background commands appear both inline at start and in the Background work drawer. Completion should update the original card rather than append an unrelated duplicate.

### 8.2 Tool card

- Human title plus runtime/server identity.
- Safe, summarized input in Normal mode; redacted structured input in Verbose.
- In-progress, succeeded, denied, failed, canceled, and timed-out states.
- Link to created artifacts or changed files.
- Duration and retry count.
- Approval source: preauthorized rule, user allow-once, user persistent rule, automatic reviewer, or runtime policy.

MCP and connector calls must retain provider identity. “Called `create_issue`” is insufficient when two GitHub connections or plugins exist.

### 8.3 Integrated terminal

Both desktop products treat a terminal as a task/workspace primitive. AI Integrator requires:

- Terminal scoped to the active project/worktree and showing that identity in its header.
- Multiple tabs, rename, close, kill, and clear.
- User commands visually distinct from agent commands.
- Chat may read current terminal output only with explicit surface permission and a visible attachment indicator.
- Reusable project actions can launch into the terminal.
- A user-owned Setup terminal runs official interactive CLI login/setup without attaching input/output to model context by default.
- Existing documented CLI login is reused after status/capability probing; Integrator never forces reauthentication or reads credential stores.
- Password/no-echo/MFA/hardware-key input uses vendor/OS/protected user surfaces and never enters transcripts or agent messages.
- Closing a task prompts when live processes remain.
- Process-tree cleanup and recovery after host restart.

Codex exposes a per-task terminal and project actions. Claude Desktop opens terminals in the session working directory and supports additional tabs. [Codex integrated terminal](https://learn.chatgpt.com/docs/integrated-terminal), [Claude Desktop](https://code.claude.com/docs/en/desktop)

## 9. Permissions and approvals

### 9.1 User-facing profiles

- **Read only:** inspect project and run explicitly safe reads; no writes.
- **Project write:** write inside approved roots; ask for risky commands/network.
- **Ask:** conservative interactive approval for actions outside a minimal allowlist.
- **Full access:** only with explicit warning; still show sensitive external actions.
- **Custom:** advanced rule editor translated to native capabilities.

The app owns intent; the runtime owns enforcement. If a runtime cannot enforce a profile, downgrade fidelity and explain the gap before launch.

### 9.2 Approval card

Every request shows:

- Agent/runtime requesting it.
- Exact action and target.
- Why it is needed.
- Effective workspace/worktree.
- Risk tags: write, delete, network, credentials, browser, external side effect.
- Choices supported by that runtime: allow once, always for exact rule, deny, deny with guidance.
- Countdown only if the runtime imposes a real timeout.

Background agents that auto-deny unavailable prompts must report **Denied because agent was backgrounded**, not a generic tool failure. Claude documents this behavior for background subagents; foreground subagent permission prompts pass through interactively. [Claude subagents](https://code.claude.com/docs/en/sub-agents)

### 9.3 Permission inheritance

- Codex subagents inherit the parent sandbox/permission mode unless a permitted custom-agent override applies.
- Claude subagents inherit or are constrained by parent modes; background subagents cannot pause for ungranted permissions.
- AI Integrator must show inherited policy on each agent row and prevent a child from silently broadening it.
- Broker delegation to another runtime receives the intersection of the task profile, delegation rule, and target runtime capability.

## 10. Plans, checklists, goals, and verification

### 10.1 Plan

Plans are mutable agent output, not promises. A plan card includes:

- Source runtime/agent.
- Steps and current statuses.
- Last updated time.
- Whether statuses are native or host-inferred.
- Edit/approve/replace actions when supported.
- Links from completed steps to evidence.

Codex provides typed `plan` items and `/plan`. Claude provides plan mode and a visible task checklist; `Ctrl+T` toggles that checklist in the CLI. Do not merge a checklist and the goal into one concept.

### 10.2 Goal

A goal is persistent completion criteria. Required row:

- Goal text.
- Running, paused, achieved, blocked, or cleared.
- Pause/resume/edit/clear.
- Progress summary and latest verification.
- Remaining budget if host-managed.

Codex documents a goal row above the composer and supports steering while it runs. Current Claude CLI also exposes `/goal`. [Codex long-running work](https://learn.chatgpt.com/docs/long-running-work), [Claude commands](https://code.claude.com/docs/en/commands)

### 10.3 Evidence

The final response does not alone prove completion. Evidence objects include:

- Test/lint/typecheck commands and exit codes.
- Screenshot or preview capture.
- Diff reviewed and remaining dirty files.
- Commit/branch/PR identifiers.
- Security or authorization checks.
- Emulator/adapter gap notes.
- User approval still pending.

## 11. Diff and review workspace

### 11.1 Required scopes

- Unstaged.
- Staged.
- Selected commit.
- Branch versus base.
- Last turn.
- Selected agent/turn when reliable attribution exists.

Codex's app review pane explicitly supports Unstaged, Staged, Commit, Branch, and Last turn. It reflects all repository changes, not only agent edits. [Codex review scopes](https://learn.chatgpt.com/docs/code-review)

Claude CLI `/diff` provides current Git diff and individual-turn diffs; Claude Desktop exposes a file list and diff viewer after a diff-stat indicator appears. [Claude commands](https://code.claude.com/docs/en/commands), [Claude Desktop diff review](https://code.claude.com/docs/en/desktop)

### 11.2 Review interactions

- File list with status, additions/deletions, staged state, and source attribution confidence.
- Unified/split diff.
- Expand context.
- Open file at line.
- Inline comment on a line/range.
- Submit multiple comments as one steering message.
- Stage/unstage/revert all, file, and hunk where Git permits.
- Request review using selected runtime/model.
- Findings filter by severity and file.
- Reply, dismiss with reason, apply fix, and re-review.
- Show stale comments after the underlying hunk changes.

Claude Desktop submits line comments back to the agent as a batch. Codex inline comments become precise review guidance and the user sends a follow-up task. The normalized UI can offer one **Send review feedback** action while preserving native semantics.

### 11.3 Destructive Git safety

- Never revert a hunk without confirmation when it may include user edits.
- Snapshot diff and file hashes before destructive actions.
- Refuse action if the file changed since the diff was rendered; refresh first.
- Explain staged and unstaged portions of the same file.
- Never assume untracked files belong to the current agent.
- Commit/push/PR are separate explicit actions with previews.

## 12. Subagents, side chats, and multi-session work

### 12.1 Agent row

Each subagent entry shows:

```text
display_name, agent_type, runtime, model, effort, task_brief,
parent, workspace/worktree, permission_profile, status,
started_at, current_activity, usage, result_summary
```

Actions: open transcript, send guidance, stop, copy result, attach result to main draft, close/archive, and open changed files/diff.

### 12.2 Codex semantics

Codex exposes subagent activity in desktop, CLI, and IDE. Each subagent has an agent thread that supported clients can open. Users can ask Codex to steer, stop, or close running/completed threads. App-server `collabToolCall` items identify sender, receiver/new thread, tool, prompt, and agent status. Custom agents can choose model, reasoning, sandbox, MCP, skills, and display nicknames. [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Codex app-server items](https://learn.chatgpt.com/docs/app-server#items)

### 12.3 Claude semantics

Claude has several distinct parallel primitives:

| Primitive | Context | Relationship to main session | UI consequence |
|---|---|---|---|
| Normal subagent | Fresh isolated context plus task brief and project memory | Returns result summary | Child row under current session |
| Forked subagent | Inherits full conversation | Runs directive in background and returns result | Child row marked Fork |
| Background shell/agent | Continues concurrently; permission prompts auto-deny if not pregranted | Task status and output | Background work drawer |
| Agent team teammate | Independent Claude Code instance, shared task list and messages | Coordinated by lead | Team graph/task board, CLI/SDK-only reference |
| Agent view session | Independent background session dispatched and monitored via `claude agents` | User attaches when needed | Peer task in sidebar, not a child result |
| Worktree session | Independent conversation and checkout | Parallel user-owned task | Peer task with branch/worktree badge |
| Side chat `/btw` | Reads current context, no tools, discarded from history | No change to main transcript | Temporary side panel |

Claude Desktop's tasks pane shows subagents, background commands, and workflows; selecting an item opens its output/subagent pane or allows stopping it. Agent teams are not available in Desktop. [Claude Desktop](https://code.claude.com/docs/en/desktop), [Claude subagents](https://code.claude.com/docs/en/sub-agents), [agent teams](https://code.claude.com/docs/en/agent-teams), [agent view](https://code.claude.com/docs/en/agent-view)

### 12.4 Side chat behavior

- Opens without interrupting the main task.
- Reads context only through the point it was opened.
- Tool access is off unless a runtime explicitly provides it and the UI labels the difference.
- Response is ephemeral by default.
- **Promote to main** creates a quoted summary/context chip; it does not silently merge hidden history.
- Closing returns focus and composer draft to the main task.

### 12.5 Delegation across runtimes

Cross-runtime delegation is not a native subagent unless the target runtime is actually represented as one. The broker must show:

- Source agent and target runtime/model.
- Task brief and attached context.
- Permission intersection.
- Workspace strategy: same read-only checkout, new worktree, or no filesystem.
- Budget/usage limit.
- Returned result and evidence.
- Whether the result is a summary, patch, commit, review, or recommendation.
- Effective delegation-policy source/version and whether the child may delegate.
- Fallback route order and which billing/data/permission boundary changes require renewed consent.

This preserves the cost-saving workflow the product is built for: a premium planner can delegate bounded exploration to a cheaper model and implementation to Codex without pretending their contexts are magically shared.

## 13. Sessions, branches, checkpoints, and worktrees

### 13.1 Native session lifecycle

Normalized actions:

- New task/session.
- Resume.
- Rename.
- Search.
- Fork/branch.
- Compact.
- Archive/unarchive.
- Delete.
- Export.
- Open in native client.

Codex app-server directly supports start, resume, fork, read/list, name, archive/unarchive, and delete. Claude CLI supports named sessions, resume/continue, branching, export, and background attachment. Native IDs remain internal metadata; the user sees task titles and runtime badges.

### 13.2 Checkpoints and rewind

Claude's IDE surface tracks checkpoints with separate choices to fork conversation, rewind code, or rewind conversation/code together. Claude CLI double-Esc opens rewind from an empty prompt. AI Integrator should implement provider-neutral checkpoints only after it can safely distinguish host edits from runtime/user edits.

Checkpoint UI must say exactly what changes:

- **Fork conversation here:** history branch only; files stay.
- **Restore files to here:** working tree changes; conversation stays.
- **Restore both:** destructive combined rewind.
- **Summarize from here:** retain current files and compact history.

No rewind may overwrite unrecognized external edits without a conflict review. [Claude VS Code checkpoints](https://code.claude.com/docs/en/ide-integrations), [Claude interactive mode](https://code.claude.com/docs/en/interactive-mode)

### 13.3 Worktree card

- Repository and main checkout.
- Worktree absolute path.
- Branch and base ref.
- Owning task/agent.
- Dirty/staged/untracked counts.
- Ahead/behind state.
- Setup status.
- Open folder, terminal, diff, handoff, and cleanup actions.
- Worktree lease id, producing task/run, active process count, conflicts, unpushed/unique commits, and coordination-ledger health.
- Git action bar for stage/unstage, editable commit, fetch, publish/push, pull/rebase/merge preview, and PR when supported.

Selecting a task or child binds Files, Terminal, Review, and Git to this same card/lease. Commit, push, merge/apply, PR, and cleanup are separate operations; accepting a child never triggers them implicitly.

Codex supports local versus worktree handoff and Git controls. Claude Desktop automatically gives parallel Git sessions isolated worktrees; current docs place them under `.claude/worktrees/` by default. AI Integrator should own its worktrees in an app-specific directory and never reuse another vendor's private worktree folder. [Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees), [Claude Desktop parallel sessions](https://code.claude.com/docs/en/desktop)

## 14. Preview, browser, and artifacts

### 14.1 Preview targets

- Local dev server URL.
- Static HTML.
- Image/video.
- PDF.
- Markdown/code file.
- Document, spreadsheet, presentation.

### 14.2 Annotation object

```text
artifact_uri, artifact_digest, target_kind, selector_or_bounds,
page_or_frame, line_range, comment, author, created_at, stale
```

Codex browser annotations can target elements/areas and include style adjustments; file/artifact annotations point ChatGPT at specific content. Claude Desktop supports browser/preview panes and a selection mode. The P1 product should normalize comments into explicit context objects and never rely on screenshot coordinates when a stable DOM selector or line range exists.

### 14.3 Dev-server configuration

- Detect common start commands but require confirmation before saving.
- Store project-local configuration, not global secrets.
- Show server status, port, URL, logs, restart, and stop.
- Keep preview process ownership visible.
- Avoid automatic public tunnels.

## 15. Usage, context, and cost

Four values must remain separate:

1. **Context fill:** current native session context consumption.
2. **Measured tokens:** tokens reported by runtime events/results.
3. **Provider quota:** rate-limit/subscription window reported by provider.
4. **Estimated cost:** calculated from known API rates, never presented as subscription spend.

Codex app-server can return turn usage, account rate limits, and account token-activity summaries. Claude Desktop's usage ring separates per-session context from shared plan usage; structured Claude results can include usage and cost. Cursor's result schema documents session and duration but should be treated as usage-opaque unless newer ACP events report more. [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude Desktop usage](https://code.claude.com/docs/en/desktop), [Claude headless mode](https://code.claude.com/docs/en/headless), [Cursor output format](https://docs.cursor.com/en/cli/reference/output-format)

Usage UI labels every number as Provider reported, Runtime measured, Host measured, Estimated, or Unavailable.

## 16. Keyboard parity

### 16.1 AI Integrator default map

| Action | Default |
|---|---|
| Command palette | `Ctrl+Shift+P` / `Ctrl+K` |
| New task | `Ctrl+N` |
| Search tasks | `Ctrl+G` |
| Find in task | `Ctrl+F` |
| Toggle sidebar | `Ctrl+B` |
| Toggle review | `Ctrl+Shift+G` |
| Toggle bottom panel | `Ctrl+J` |
| Toggle terminal | `Ctrl+`` |
| Open side chat | `Ctrl+;` |
| Stop active turn | `Esc` with visible confirmation state |
| Cycle transcript density | `Ctrl+O` |
| Model picker | configurable; no collision with OS |
| Permission picker | configurable |
| Effort picker | configurable |

These align closely with current Codex desktop and Claude Desktop muscle memory. All shortcuts must be discoverable and remappable; never steal terminal keypresses while the terminal has focus. [Codex desktop commands](https://learn.chatgpt.com/docs/reference/commands), [Claude Desktop shortcuts](https://code.claude.com/docs/en/desktop), [Claude keybindings](https://code.claude.com/docs/en/keybindings)

### 16.2 Context-sensitive behavior

- `Esc` closes a menu first, then stops a turn; it never performs both.
- Terminal focus sends terminal shortcuts to the PTY except app-reserved chords shown in its header.
- Diff focus uses arrows for files/hunks only when the diff navigator is active.
- Composer `Enter` submits; `Shift+Enter` or configured alternate inserts newline.
- Screen-reader focus does not jump when streamed items update.
- A stop action is always reachable without pointer precision.

## 17. Component inventory required for parity

### Persistent shell

- Project/task sidebar.
- Task header with runtime path, workspace/worktree, branch, goal, and status.
- Transcript canvas.
- Persistent composer.
- Right-side contextual pane.
- Bottom terminal/diagnostics panel.

### Transcript

- User message.
- Agent commentary/final response.
- Reasoning block.
- Plan/checklist card.
- Activity group.
- Command card.
- Tool card.
- File-change group.
- Approval card.
- Subagent call/result card.
- Compaction/review/goal timeline markers.
- Failure/retry/reconnect card.

### Right pane tabs

- Outputs/artifacts.
- Agents/background tasks.
- Sources/context.
- Review/diff.
- Usage.

### Overlays and pickers

- Runtime/model/effort path picker.
- Permission profile picker.
- Command/skill palette.
- File/agent/app/MCP mention picker.
- Session resume/fork picker.
- Worktree/handoff dialog.
- Auth-required vendor flow.

## 18. Protocol-to-component mappings

### 18.1 Codex app-server

| User action | Protocol primitive |
|---|---|
| New task | `thread/start` |
| Resume | `thread/resume` |
| Fork | `thread/fork` |
| Load/search | `thread/read`, `thread/list` |
| Rename | `thread/name/set` |
| Archive/delete | `thread/archive`, `thread/unarchive`, `thread/delete` |
| Send | `turn/start` |
| Steer | `turn/steer` |
| Stop | `turn/interrupt` |
| Compact | `thread/compact/start` |
| Review | `review/start` plus review items |
| Model picker | `model/list` |
| Transcript | `item/*`, delta, and `turn/*` notifications |
| Background command | command/process APIs plus output deltas where available |
| Usage | turn completion plus account usage/rate-limit APIs |

### 18.2 ACP

| User action | ACP behavior |
|---|---|
| Connect | `initialize`, negotiate version/capabilities/auth methods |
| New task | `session/new` |
| Send | `session/prompt` |
| Stream | `session/update` notifications |
| Stop | `session/cancel` |
| Permission | Agent request and client response |
| File/terminal | Client capability requests constrained by host policy |
| Model/mode | Only when advertised by the agent |
| Resume/fork | Only when the agent's negotiated surface supports it; otherwise handoff |

### 18.3 Structured stream/PTY

Structured streams may create message, tool, and result cards from documented event types. PTY output stays a terminal transcript. The host may link file paths and detect exit codes, but must not infer approvals, subagents, usage, or edit attribution from terminal text alone.

## 19. Minimum acceptance gates

### P0 — launch credibility

- One seamless composer selects Codex, Cursor, or Grok path without a provider setup mode switch.
- Codex supports native sessions, steer, stop, typed activity, approvals, review, subagents, models, and usage through app-server.
- Cursor and Grok pass ACP initialization, prompt/update, permissions, cancel, and resume tests for advertised capabilities.
- Files open from transcript and diff; local files can be attached and opened externally.
- Review pane supports all Git scopes plus file/hunk safety.
- Normal, Verbose, and Summary transcript modes work; Raw is diagnostic-only.
- Runtime-provided reasoning is separated from activity and final response.
- Subagent/background work can be opened and stopped.
- Task terminal is scoped to the exact workspace/worktree.
- Auth is vendor-owned and diagnostics are secret-free.

### P1 — native-workspace parity

- Side chats and provider-neutral task forks.
- Editable file pane with external-change conflicts.
- Checkpoints/rewind with change ownership protection.
- Browser/preview pane and structured annotations.
- Generic ACP registry catalog and compatibility badges.
- Cross-runtime delegation graph and handoff packages.
- Usage-aware routing with confidence labels.

### Explicit non-parity at launch

- IDE autocomplete/Tab replacement.
- Claude Agent Teams as a first-class connected subscription surface.
- Vendor cloud execution features without official APIs.
- Fabricated full chain-of-thought.
- Universal stage/revert attribution to an agent when the repository changed externally.
- Equal usage precision across providers.

## 20. Scenario test suite

1. Start a Codex task, add two file chips, switch effort, and send without leaving the composer.
2. While Codex runs, send a native steer; confirm it enters the active turn rather than queuing silently.
3. Open a command card, watch output, stop the process, and see the correct canceled terminal state.
4. Open a file path from agent output, make an unsaved spot edit, change the file externally, and resolve the conflict.
5. Review Unstaged, Staged, Branch, and Last turn scopes with a file containing both staged and unstaged hunks.
6. Add three inline comments, send them as one feedback turn, and mark comments stale after edits.
7. Spawn two Codex subagents, open each child thread, steer one, stop the other, and preserve the main draft.
8. Ask a side question while a goal runs; close it without changing main history.
9. Toggle Summary, Normal, Verbose, and Raw; ensure hidden reasoning is never invented.
10. Resume a task after killing and restarting the runtime process.
11. Fork a native session, then fork a runtime without native support through a handoff; label the difference.
12. Deny a background-agent permission request and show the real reason.
13. Open a terminal in a worktree whose path contains spaces; confirm the header and cwd match.
14. Display context fill, provider quota, measured usage, and estimated cost as separate values.
15. Lose ACP connection mid-tool; reconnect or fail with recoverable diagnostics without duplicating final output.

## 21. Primary sources

### Codex

- [App-server protocol and items](https://learn.chatgpt.com/docs/app-server)
- [Desktop slash commands](https://learn.chatgpt.com/docs/reference/slash-commands)
- [CLI developer commands](https://learn.chatgpt.com/docs/developer-commands)
- [Desktop commands and shortcuts](https://learn.chatgpt.com/docs/reference/commands)
- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Code review](https://learn.chatgpt.com/docs/code-review)
- [Integrated terminal](https://learn.chatgpt.com/docs/integrated-terminal)
- [Local environments and Git tools](https://learn.chatgpt.com/docs/environments/local-environment)
- [Work with files](https://learn.chatgpt.com/docs/artifacts-viewer)
- [Browser and annotations](https://learn.chatgpt.com/docs/browser)
- [Long-running work and goals](https://learn.chatgpt.com/docs/long-running-work)

### Claude Code

- [Desktop](https://code.claude.com/docs/en/desktop)
- [All commands](https://code.claude.com/docs/en/commands)
- [Interactive mode](https://code.claude.com/docs/en/interactive-mode)
- [Keyboard shortcuts](https://code.claude.com/docs/en/keybindings)
- [Model configuration and extended thinking](https://code.claude.com/docs/en/model-config)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Agent teams](https://code.claude.com/docs/en/agent-teams)
- [Agent view](https://code.claude.com/docs/en/agent-view)
- [Parallel agents](https://code.claude.com/docs/en/agents)
- [IDE checkpoints](https://code.claude.com/docs/en/ide-integrations)
- [Headless mode](https://code.claude.com/docs/en/headless)
