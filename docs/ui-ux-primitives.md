# AI Integrator — Agent Workspace UI/UX Primitives

**Status:** Normative interaction and visual specification  
**Audience:** Product, design, desktop, frontend, accessibility, adapter, and QA teams  
**Research window:** 2026-07-09 through 2026-07-10  
**Companion documents:** [Product specification](product-spec.md), [User stories](user-stories.md), [Research and design principles](research-and-design-principles.md), [Native parity matrix](native-parity-matrix.md), [QOL microinteraction catalog (200)](qol-100.md), [Critical systems primitives](critical-systems-primitives.md), [Delivery and criticality matrix](delivery-criticality-matrix.md), [Repository coordination protocol](repo-coordination-protocol.md), [Broker MCP contract](broker-mcp-contract.md)

This document defines the concrete primitives needed to make AI Integrator feel restrained, premium, fast, and trustworthy while supervising multiple coding agents. It deliberately goes below the level of screenshots. A screenshot captures one state at one size; the product must also survive streaming, long histories, narrow windows, six concurrent agents, conflicting Git state, missing runtimes, keyboard use, reduced motion, renderer failure, and platform differences.

Where this document conflicts with the earlier reference values in `research-and-design-principles.md`, this document is authoritative for workspace behavior and component geometry. The earlier document remains design research and historical context.

The [QOL microinteraction catalog (200)](qol-100.md) is the itemized implementation backlog for the smallest behaviors implied by this specification. Each item maps the client-owned behavior to Codex/app-server and ACP primitives, states the degraded fallback, and defines an acceptance check.

---

## 1. Evidence model and research method

Recommendations use four evidence classes:

| Code | Meaning | How it may be used |
|---|---|---|
| `O` | Official product documentation or changelog | Evidence of a shipped or documented capability |
| `S` | Direct inspection of open-source UI code at a recorded commit | Evidence of implementation detail or mature edge-case handling |
| `C` | Public issue or user feedback | Evidence of a pain point, not proof of prevalence |
| `R` | AI Integrator product recommendation | A design decision derived from the evidence |

The supplied Codex screenshots were inspected at original resolution. They are evidence of useful composition and density, not a template. Current Codex, Claude Code Desktop, Cursor 3, Zed, OpenCode, Goose, Cline, Kilo Code, OpenHands, GitHub Desktop, VS Code, Apple HIG, and Fluent guidance were compared. Open-source repositories were shallow-cloned and their relevant UI code inspected rather than judged only from marketing images.

### 1.1 Source-inspection snapshot

| Product | Commit inspected | Relevant implementation areas |
|---|---|---|
| Zed | [`76c9396`](https://github.com/zed-industries/zed/tree/76c93968da5b8b8809bdd72e4ad9e7d0e946bad0) | `agent_ui`, `acp_thread`, thread rows, project panel, Git UI, terminal view, UI/theme crates |
| OpenCode | [`d0ba538`](https://github.com/anomalyco/opencode/tree/d0ba5389248e05546849b9f69b7bc417aa5fd5d7) | app shell, session layout, virtual timeline, composer docks, review/file/terminal panes, UI v2 tokens |
| Goose | [`b7eb1e9`](https://github.com/block/goose/tree/b7eb1e9735833a7bf12ab92994a788fbc770f218) | desktop navigation, ACP sessions, progressive message list, composer, usage, themes |
| Cline | [`3266121`](https://github.com/cline/cline/tree/3266121fa1b228597292e955d56307c1b8fde9ce) | virtual transcript, sticky task context, queued prompts, input, approvals, browser/tool rows |
| Kilo Code | [`7c30be6`](https://github.com/Kilo-Org/kilocode/tree/7c30be66e8fb925cd763c260507feaab51d13ff6) | agent manager, multi-model selection, worktree mode, permission/question docks, virtual diff, transcript cache |
| OpenHands | [`d1563c9`](https://github.com/All-Hands-AI/OpenHands/tree/d1563c95260d76aeffcbc79d7fb30a79c32f450d) | conversation shell, event taxonomy, resizable composer, draft persistence, BTW chat, terminal/files/diff |
| GitHub Desktop | [`d908011`](https://github.com/desktop/desktop/tree/d9080117b1fd01193d3eee51ae243714468c8176) | repository identity, clone/add flows, changes/diffs, worktrees, branch safety, accessible resizers |

### 1.2 What source inspection changed

The source pass produced requirements that screenshots alone do not reveal:

- Draft text, queue state, selected file, pane geometry, scroll anchor, transcript density, and focused child run are durable task UI state, not disposable view state. `S`
- Long transcripts require measured virtualization and explicit scroll anchoring. “Scroll to bottom on every chunk” is a bug. `S`
- A queued message and an immediate steering message have different delivery semantics and need separate labels, editing, cancellation, and ordering. `S`
- Pane resizing needs pointer, keyboard, double-click reset, minimum dimensions, persisted geometry, and a live-region announcement. `S`
- Row state is multidimensional: selected, keyboard-focused, hovered, running, waiting, unread, failed, archived, and truncated are not aliases. `S`
- Diff review needs its own selection model, file tree, comment state, virtualized rendering, and navigation history. It cannot be a styled chat attachment. `S`
- Transparent or blurred shells need opaque fallbacks because text fades, hover reveals, and GPU composition behave differently on Windows. `S`, `C`

---

## 2. Product posture: an adaptive agent workbench

The product is not:

- a ChatGPT/Codex visual clone;
- a terminal with bubbles around it;
- a full IDE competing with Cursor or Zed;
- a provider dashboard that asks users to choose a brand before stating a goal;
- a pane playground that requires layout work before useful work;
- a chat history with Git controls attached later.

It is an **adaptive agent workbench**:

1. The durable object is the task.
2. A task may be attached to zero, one, or multiple project roots.
3. A turn selects an execution profile; the profile resolves to runtime, model, effort, environment, isolation, and permissions.
4. Work creates evidence: activities, files, diffs, commands, previews, child runs, approvals, tests, commits, and handoffs.
5. Evidence opens in appropriate panes without turning every task into a full IDE.
6. Users can always get back to the goal, current state, and next required action.

### 2.1 Calm default, deep ceiling

On first open, show only:

- the navigation rail;
- a one-line context statement;
- the task composer;
- recent or active task suggestions if they are genuinely useful.

Do not pre-open terminal, file tree, inspector, usage dashboard, extension marketplace, or model catalog. Those surfaces appear through direct intent or produced evidence.

The ceiling remains high: any task can become a multi-pane workspace with chat, plan, diff, file, terminal, preview, sources, child agents, and task contract. The user should arrive there incrementally, not configure it up front.

### 2.2 One context sentence

Above an empty composer, summarize the effective launch context in plain language:

> Working in **Lotmind AI** on a new worktree · **Auto** will use Codex · project-write access

Every bold phrase is interactive. If no project is selected:

> Start anywhere · choose a folder, paste a Git URL, or ask a question

This sentence replaces a row of large setup toggles. It also exposes hidden defaults before the user sends.

### 2.3 Stable objects and transient views

| Stable object | Transient view |
|---|---|
| Project | Sidebar group, project overview, picker result |
| Checkout/worktree | Context chip, branch menu, terminal cwd |
| Task | Task tab/canvas, sidebar row |
| Turn | User prompt block and resulting activity group |
| Run | Activity group, child-run pane, diagnostic trace |
| Artifact | File tab, preview, output card |
| Review | Diff pane and inline comment layer |
| Approval | Composer dock and activity event |

Never let closing a pane imply deleting the underlying object.

---

## 3. Comparative benchmark: what works and what fails

### 3.1 Codex desktop / ChatGPT Codex

Current official documentation describes Codex in the ChatGPT desktop app as a project/task workspace with local folders, standalone tasks, Git review, worktrees, terminal, browser, previews, skills, plugins, scheduled tasks, and Windows-native or WSL execution. The current project model separates Quick Chat from durable tasks and supports task search, pinning, renaming, and archiving. `O` [Projects](https://learn.chatgpt.com/docs/projects), [Windows app](https://learn.chatgpt.com/docs/windows/windows-app), [Code review](https://learn.chatgpt.com/docs/code-review)

**Works**

- Task-first framing makes long work feel like a unit of execution rather than a disposable chat.
- The central reading column is calm and gives prose, tables, and evidence room to breathe.
- A persistent composer keeps steering close without a floating global command bar.
- Review scopes such as unstaged, staged, commit, branch, and last turn match real developer intent.
- A separate inspector can hold sources, artifacts, plan, and child runs without flooding the transcript.
- Standalone tasks reduce “choose a repo before asking anything” friction.

**Fails or remains fragile**

- A recent-only project/task list is not a reliable history system; public issues report discoverability gaps even when local session data still exists. `C`
- Windows path variants can fracture project identity. `C`
- A UI that says “thinking” after the backend turn has become detached destroys trust because state and control no longer match. `C`
- Large composer drafts can cover too much of the transcript if growth is not capped.
- A floating inspector can feel unrelated to the selected event if selection and anchoring are weak.
- Transparency and GPU effects can introduce flicker or low contrast on some Windows configurations. `C`

**Adopt**

- Durable task framing, review scopes, standalone tasks, quiet transcript, and evidence inspector.

**Do not copy**

- Dependence on a single recent list, ambiguous tiny status glyphs, an inspector with weak selection context, or compositor-heavy decoration.

### 3.2 Claude Code Desktop

Claude Desktop's Code tab now documents automatic worktrees, a session sidebar with filters/grouping, draggable and resizable panes, terminal, file editor, preview, plan, tasks, subagent panes, side chats, transcript-density modes, usage rings, local/SSH/cloud environments, and PR monitoring. `O` [Desktop guide](https://code.claude.com/docs/en/desktop), [Desktop changelog](https://code.claude.com/docs/en/desktop-changelog)

**Works**

- The pane vocabulary corresponds to actual work products instead of generic “cards.”
- Automatic per-session worktrees make parallel editing safer.
- Normal, Verbose, and Summary transcript modes solve different supervision needs.
- Path context menus correctly separate attach, open, reveal, and copy actions.
- A file pane warns when disk contents changed before Save/Discard.
- The tasks pane gives background shell commands, subagents, and workflows a home outside chat.
- Side chat preserves the main thread while using its context.
- Warnings before archiving uncommitted work or quitting with active work are excellent trust details.

**Fails or creates risk**

- Arbitrary draggable layouts can become costly if defaults, reset, and keyboard navigation are weak.
- Automatic worktrees are surprising unless the branch/root is visible before launch and throughout the task.
- Desktop and CLI maintaining separate histories makes “same engine” continuity feel incomplete. `O`, `C`
- A usage ring can conflate per-session context and shared plan quota unless the popover labels both dimensions clearly.
- Automatic copying of gitignored files into worktrees is powerful and security-sensitive; the UI must never casually suggest copying secrets. `O` [Worktrees](https://code.claude.com/docs/en/worktrees)

**Adopt**

- Typed panes, background-task pane, transcript density, side chat, file-conflict warnings, pre-archive safety, and explicit environment selection.

**Modify**

- Use curated layouts and drag-to-rearrange as a power feature, not the initial experience. Make isolation visible and policy-driven rather than silently magical.

### 3.3 Cursor 3

Cursor 3 introduced an Agents Window for local, worktree, cloud, and SSH agents; Design Mode browser annotations; agent tabs and grids; `/worktree`; and `/best-of-n`. Later updates added persistent tiled layout, plan documents, branch selection in the empty state, exact diff-to-file navigation, and local/cloud handoff. `O` [Cursor 3.0](https://cursor.com/changelog/3-0), [Cursor changelog](https://cursor.com/changelog)

**Works**

- It proves an agent-first window can coexist with a full IDE rather than replacing it.
- Branch selection before launch prevents a common class of accidental work.
- Plan tabs behaving as editable documents makes planning concrete and inspectable.
- Grid/tiled agent tabs are effective for comparison and parallel supervision.
- Design Mode turns spatial UI feedback into precise task context.
- Exact navigation from a diff line to the file reduces review friction.

**Fails or creates risk**

- Public feedback shows that aggressively promoting the Agents Window can make code feel secondary and disrupt established workflows. `C`
- Feature differences between Agents Window and editor force users to remember which surface owns which capability. `C`
- Grouping clones by normalized remote can hide checkout identity and surprise users. `C`
- Archive-only cleanup with inconsistent delete semantics produces uncertainty. `C`
- Launching many new surfaces at once amplifies theme, WSL, MCP, keybinding, usage-bar, and takeover inconsistencies. `C`

**Adopt**

- Agent grids, branch-before-launch, plan documents, design annotations, and local/cloud handoff.

**Do not copy**

- Forced promotion, provider-colored marketing chrome, or divergent semantics between the agent and code surfaces.

### 3.4 Zed

Zed is especially relevant because it supports native agents, ACP external agents, and terminal-backed agent threads inside the same editor concepts. `O` [Agents](https://zed.dev/docs/ai/agents), [Agent Panel](https://zed.dev/docs/ai/agent-panel)

**Source-level strengths**

- Thread rows model selected, focused, hovered, truncated, status, worktree metadata, and archived state separately. `S`
- Hover actions use controlled gradient fades with a different strategy when the window is translucent. `S`
- Conversation state persists drafts and logical scroll position. `S`
- The message queue has explicit pause, resume, fast-track, stop, and focus behavior. `S`
- Code blocks constrain horizontal scrolling to the code axis so vertical wheel input continues through the transcript. `S`
- Agent, project, terminal, editor, and review surfaces share the same workspace primitives rather than recreating them inside chat. `S`

**Risks**

- Editor-native density can feel terse or cryptic to non-IDE users.
- Exposing native agent, ACP agent, and terminal thread as three peer choices too early burdens onboarding.

**Adopt**

- State-complete rows, shared workspace primitives, durable view state, and ACP capability negotiation.

### 3.5 OpenCode

**Source-level strengths**

- The current app separates a 344 px default sidebar, 600 px session column, file tree, review, and terminal geometry and persists them. `S`
- Review panes reserve fixed minimum useful widths instead of growing endlessly with the monitor. `S`
- Stored widths are not clamped before the first layout measurement, avoiding a first-frame snap. `S`
- The timeline is projected into measured virtual rows rather than rendering raw events directly. `S`
- Questions, permissions, follow-ups, reverts, and todos dock above the composer as typed interaction surfaces. `S`
- Review includes a resizable file tree, virtualized file preview, inline comments, sticky file headers, and selection state. `S`
- UI v2 uses semantic background, text, icon, border, state, agent-role, and elevation tokens for light and dark modes. `S`
- Tooltips use an initial/skip delay, close immediately, remain keyboard reachable, and suppress themselves while a nested trigger is expanded; toasts have explicit persistence, dismissal, progress, and actions. `S`

**Risks**

- A large number of hidden scroll regions and scrollbar suppression can hurt discoverability and accessibility.
- Dense panes and many specialized docks can feel like an IDE before the user needs one.

**Adopt**

- Typed composer docks, measured timeline, pane minimums, no-first-frame-snap rule, and semantic token layering.

### 3.6 Goose, Cline, Kilo Code, and OpenHands

**Goose** demonstrates responsive auto-collapse that remembers whether the system or user collapsed navigation, a spring-based sidebar shell, project-grouped sessions, ACP session adapters, progressive message rendering, and visible usage/cost controls. Its code also shows how quickly hover translations and many `transition-all` rules can become visual noise. `S`

**Cline** distinguishes queued from steering messages, caps the visible queue, allows per-message cancellation, virtualizes long histories, tracks whether the user is at the bottom, pins the most recent scrolled-past user request, tests IME behavior, and inherits VS Code theme tokens. These are mature transcript mechanics. Its narrow extension origin can also produce deep vertical stacks and too many settings inside chat. `S`

**Kilo Code** contains useful primitives for multi-model candidate selection, worktree mode, a dedicated agent manager, permission and question docks, a transcript cache, virtual review, base-branch selection, comments, and terminals. Its current reconnect handlers deliberately replay pending permissions, questions, suggestions, selections, and MCP/browser state that may have been missed while the event stream was down. It also illustrates the danger of accumulating several overlapping shells and generations of components. `S`

**OpenHands** exposes an explicit event taxonomy, BTW side questions, draft persistence, resizable input, model/profile switches, Git controls, file uploads, terminal, diff, plan, and task tracking. Its floating-help primitive supports focus and pointer activation, Escape/outside dismissal, edge flip/shift, and continuous repositioning. It shows the value of keeping action/observation pairs semantically linked. It also shows how a raw event feed can become visually heavy when every internal event becomes a message. `S`

### 3.7 GitHub Desktop and VS Code

GitHub Desktop remains a strong reference for Git safety and accessibility:

- Add existing, create, and clone are distinct operations with clear destination semantics.
- Branch switches account for local changes and expose stash/overwrite decisions.
- Large or unsupported diffs show explicit warnings rather than blank panes.
- Resizers support pointer input, keyboard increments, double-click reset, clamping, and ARIA live announcements. `S`
- Transient app menus restore focus to the invoking control, asynchronous state is routed through dedicated live regions, and error dialogs distinguish retry by failed operation. `S`
- Image diffs support multiple comparison modes rather than pretending they are text.

VS Code's current UX guidance formalizes primary sidebar, secondary sidebar, editor groups, panel, contextual toolbars, tree views, command palette, notifications, and movable views. It recommends few sidebar views, shallow hierarchy, limited per-row actions, and using panels for supporting content that benefits from horizontal space. `O` [UX overview](https://code.visualstudio.com/api/ux-guidelines/overview), [Views](https://code.visualstudio.com/api/ux-guidelines/views), [Panel](https://code.visualstudio.com/api/ux-guidelines/panel)

---

## 4. Supplied screenshot audit: retain, change, reject

### 4.1 Screenshot 1 — full task workspace

**Retain**

- Calm dark shell with one obvious primary action.
- Project groups with nested tasks.
- Selected task represented by a soft surface rather than a loud brand color.
- Narrow reading measure within a wide canvas.
- Composer utilities grouped along its lower edge.
- Permission/autonomy anchored on the lower-left and model/effort anchored immediately before voice/Send on the lower-right; this makes both consequential choices inspectable without competing with the prompt.
- A secondary inspector for outputs, agents, and sources.

**Change**

- Let users resize the rail; the pictured width works for its labels but wastes room when titles are short.
- Give project, checkout, and task different row anatomy instead of relying mostly on indentation.
- Replace tiny ambiguous activity dots with shape-plus-label tooltips and a dedicated waiting-approval mark.
- Cap composer growth; move long draft editing into an expanded editor without covering most recent evidence.
- Turn the pictured model/effort label into the full execution-route pill (`runtime · model · effort`) and insert one quiet branching-policy control immediately before it. Do not add provider tabs or a second setup row.
- Anchor inspector content to the selected activity, artifact, or task, and show that anchor in its header.
- Use the empty inspector space for structured metadata only when relevant; otherwise collapse the inspector.

**Reject**

- A permanently floating inspector at all widths.
- Bottom-of-sidebar critical actions that can fall below a short or partially off-screen window.
- Global task rows duplicated separately from project task rows without a clear reason.

### 4.2 Screenshot 2 — side-question peek

**Retain**

- Asking a contextual question without steering the main run.
- A small peek result that does not replace the main transcript.
- A visible fork point.

**Change**

- Give the side question a stable title, unread/completed state, and close/promote actions.
- Draw the relationship to the source turn only while selected; permanent connector lines add clutter.
- Open it as a popover for a quick result and promote it to a pane if the exchange grows.
- State explicitly: “Reads task through Turn 6 · does not affect main context.”

**Reject**

- Free-floating cards whose source anchor can scroll away.
- Treating every child agent, side question, and branch as the same kind of fork.

### 4.3 Screenshot 3 — activity transcript

**Retain**

- A compact “worked for…” summary.
- Human-readable grouping of integration use, commands, and searches.
- Visually distinct user steering.
- Final response separated from background activity.

**Change**

- Time labels must describe observed elapsed time, not imply continuous productive reasoning.
- Group repeated low-level events into expandable activity bundles.
- Keep the current activity sticky when its source rows scroll away.
- Distinguish reasoning summaries, tool activity, evidence, approvals, and final answers using anatomy and labels—not only color.
- Give every collapsed group an honest summary: item count, duration, status, and whether anything failed.

**Reject**

- Raw hidden reasoning or simulated thought traces.
- Token-by-token animation as a sign of intelligence.
- A single undifferentiated vertical stream for prompts, approvals, commands, files, child agents, and final answers.

---

## 5. Information model and hierarchy

The visual hierarchy must mirror the real ownership hierarchy:

```text
Workspace application
├─ Connection / runtime inventory
├─ Project
│  ├─ Root or repository
│  │  └─ Checkout / worktree
│  └─ Task
│     ├─ Turn
│     │  └─ Run
│     │     ├─ Activity
│     │     ├─ Artifact
│     │     └─ Child run
│     ├─ Review
│     └─ Handoff
└─ Standalone task
```

### 5.1 Identity rules

Project identity is not a display-name string.

| Entity | Canonical identity | Human label |
|---|---|---|
| Local root | normalized filesystem identity plus volume/file identity when available | folder name and shortened parent |
| Git repository | local root plus repository common-dir identity | repository alias |
| Remote | normalized host/owner/repository URL | `owner/repo` |
| Checkout | repository identity plus absolute worktree path | branch or worktree label |
| Task | application UUID | editable goal-derived title |
| Native session | runtime plus native session id | shown only in diagnostics/details |

Windows normalization must reconcile drive-letter case, slash direction, junctions, symlinks, UNC forms, `\\?\` paths, and WSL roots without collapsing genuinely distinct checkouts. macOS normalization must account for case-insensitive volumes and resolved aliases. The UI always retains the real local path in details.

### 5.2 Vocabulary rules

- **Project** means durable grouping and shared guidance.
- **Folder** means a local filesystem root selected by the user.
- **Repository** means a version-controlled root.
- **Checkout** means the actual directory a run edits.
- **Worktree** is a Git checkout created for isolation.
- **Task** means an outcome-oriented durable thread.
- **Chat** means a lightweight conversation without an execution contract.
- **Run** means one runtime execution, not the whole task.
- **Agent** means a runtime/harness participating in a run; it is not synonymous with model.

Never label a folder picker “Open project” and then silently create a task. Never label a task “project.” Never show a remote repository name without the active local checkout when more than one exists.

---

## 6. The application shell

### 6.1 Regions

The shell supports five regions, of which only two are mandatory:

| Region | Default | Purpose |
|---|---|---|
| Navigation rail | Open | Projects, tasks, global search, high-priority attention |
| Primary canvas | Open | Task transcript, empty state, project overview, settings page |
| Work pane | Closed | File, diff, plan, preview, source, child run |
| Utility panel | Closed | Terminal, logs, problems, background processes |
| Inspector | Closed | Structured metadata for current selection/task |

The primary canvas is never replaced by an opaque “agent mode.” Files and diffs open beside it; terminal opens below or beside it; the inspector supplements it.

Settings is the exception to ordinary workspace navigation: it is a full-screen application route whose category rail replaces the project/task rail. It is not an Inspector, modal, overlay, or right drawer. `Back to workspace` restores the previous project, task, canvas tab, scroll/focus, and right-rail state.

### 6.2 Window classes

| Width | Shell behavior |
|---:|---|
| `< 760 px` | Single region; rail becomes overlay; panes become routed full-screen views |
| `760–1099 px` | Collapsible rail; primary canvas; one overlay work pane |
| `1100–1439 px` | Resizable rail; primary canvas; one split work pane; utility panel below |
| `1440–1799 px` | Rail + primary + work pane; optional inspector overlay |
| `>= 1800 px` | Rail + primary + work pane + optional pinned inspector; utility panel below selected region |

Window breakpoints respond to available content width after OS chrome, not physical display resolution.

### 6.3 Default geometry

| Primitive | Default | Minimum | Maximum |
|---|---:|---:|---:|
| Navigation rail | 280 px | 224 px | `min(400px, 32vw)` |
| Primary task column | 680 px | 480 px | 820 px reading measure |
| Review/file pane | 560 px | 420 px | remaining width |
| Review pane in split-diff mode | 760 px | 640 px | remaining width |
| Inspector | 336 px | 288 px | 480 px |
| Utility panel height | 260 px | 140 px | 55% window height |
| Composer compact height | 104 px | 88 px | 168 px before internal scrolling |

The primary task column may occupy more than 820 px, but prose blocks retain a maximum reading measure while wide tables, plans, and evidence can expand.

### 6.4 Pane behavior

Every resizable boundary must support:

- pointer drag with a 10 px effective hit target and a 1 px visible divider;
- keyboard focus and 8 px increments, 32 px with Shift;
- double-click reset to the layout default;
- a context menu with Reset, Move, Close, and Open in new window where supported;
- live percentage or pixel-size announcement for assistive technology;
- clamping before persistence;
- preservation per project and optional per task;
- no first-frame geometry snap while the container is unmeasured;
- no animated resizing while the pointer is down.

### 6.5 Layout presets

Expose presets after a second pane is opened:

- Focus: canvas only.
- Review: canvas + diff/file.
- Build: canvas + terminal below.
- Visual: canvas + preview + compact inspector.
- Compare: two candidate panes + shared review summary.
- Supervise: canvas + child-run grid + attention list.

Presets are starting points. “Reset layout” returns to the relevant preset, not to a one-size-fits-all factory layout.

### 6.6 Multiple windows and displays

- A task can be opened in a new window without creating a second task.
- Only one window owns composer input for a task at a time; other windows are live read-only until they take control.
- Pane and scroll state are window-local; task drafts and queue state are task-global.
- Closing the last visible window never terminates local or remote work without an explicit quit policy.
- Windows remember display, size, maximized state, rail visibility, and layout preset.
- If a display disappears, restore all windows within the primary display's safe bounds.

---

## 7. Navigation rail and history

### 7.1 Rail anatomy

The rail has four fixed zones and one scrolling zone:

1. **Window drag/title zone:** platform-appropriate title and global command/search entry.
2. **Primary action zone:** one `New task` action; its adjacent chevron opens alternate starts.
3. **Scrolling content:** attention, pinned, projects, and standalone tasks.
4. **Utility zone:** runtimes/connections, skills, usage, settings; accessible even in short windows through a compact menu.
5. **Resize edge:** not part of content navigation.

Do not place account/help as the only bottom-aligned actions if the bottom can be clipped. On short windows, fold utilities into an always-reachable overflow next to the global command entry.

### 7.2 Default sections

Order sections by task urgency, not marketing priority:

```text
New task

Needs attention (only when nonempty)
  Waiting for approval
  Failed or disconnected
  Completed with unread result

Pinned

Projects
  Project
    Active tasks
    Recent tasks (collapsed after threshold)

Standalone
```

“Needs attention” is a derived view. Its rows reference the same tasks; they do not create duplicate task objects. Selecting a row selects the corresponding row under its project when the rail remains open.

### 7.3 Sidebar depth

Keep the rail to two visible hierarchy levels: project and task. Root, repository, checkout, branch, child agent, artifact, and run details belong in row metadata, a project overview, task tabs, or the inspector. This follows Apple and VS Code guidance to avoid deep sidebar trees. `O` [Apple sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars), [VS Code views](https://code.visualstudio.com/api/ux-guidelines/views)

### 7.4 Project row anatomy

From leading to trailing:

1. Disclosure chevron, 16 px.
2. Project avatar or repository glyph, 18 px.
3. Primary label, one line.
4. Optional muted checkout/root summary when the row is expanded and ambiguous.
5. One aggregate attention indicator.
6. Hover/focus overflow action.

Rules:

- The row height is 32 px compact, 36 px comfortable.
- The project name truncates in the middle only for path-like labels; ordinary names truncate at the end.
- A project may show at most one aggregate: `2 running`, `Approval`, `1 failed`, or `3 unread`, in that priority order.
- Expansion state is independent of selection.
- Double-click does not create a task; it opens the project overview.
- Right-click offers New task, Open overview, Reveal folder, Open in editor, Pin, Rename alias, and Remove from Integrator.
- Removing a project never deletes the folder or task history without a separate explicit choice.

### 7.5 Task row anatomy

From leading to trailing:

1. 16 px state slot.
2. Title.
3. Optional compact runtime glyph only while active or when runtime identity is needed.
4. Unread dot or waiting badge.
5. Hover/focus actions.

The state slot uses shape and motion sparingly:

| State | Visual |
|---|---|
| Draft | hollow neutral circle |
| Queued/setup | two-step static progress glyph; rotate only in the active row |
| Running | low-amplitude rotating arc in the active row; static arc elsewhere |
| Waiting approval | amber diamond with `!` tooltip |
| Waiting user input | neutral question-mark diamond |
| Completed unread | filled accent dot plus bold title |
| Completed read | check only on hover/details; otherwise no icon |
| Failed | red outlined octagon or error glyph |
| Disconnected | broken-link glyph |
| Stopping | static stop-square with “Stopping” tooltip |
| Archived | absent from default sections |

Color is secondary to shape. No pulsing rows.

### 7.6 Row interaction states

Each row renders these states independently:

- Rest.
- Hover.
- Keyboard focus.
- Selected in active window.
- Open in another window.
- Drag source.
- Drag target before/after/inside.
- Context menu open.
- Truncated.
- Renaming.
- Unread.
- Attention.
- Disabled during migration or restore.

Selection uses a quiet filled surface. Keyboard focus adds an immediate 1.5 px focus outline inside the row and must remain visible on the selected surface. Hover may reveal actions but may not shift label geometry. A gradient fade behind trailing actions is allowed only when its background is computed from the actual row surface; opaque fallback is required for translucent windows.

### 7.7 Hover actions

Show no more than two inline actions:

- Active task: stop or open current activity.
- Inactive task: archive.
- All rows: overflow.

Pin, rename, duplicate, move, export, delete, reveal, and diagnostic actions live in overflow or the command palette. Hover actions remain keyboard reachable through the same row action menu.

### 7.8 Search, filter, and command entry

`Ctrl/Cmd+K` opens the command palette; `Ctrl/Cmd+G` focuses task/project search. Search indexes:

- project alias, path, remote, and branch;
- task title and goal;
- user prompts and final answers;
- artifact names;
- commit/PR identifiers;
- runtime/model only as optional filters.

Results group by Projects, Tasks, Files, Commands, and Settings. They show the owning project and checkout to disambiguate clones. Search never depends on the currently materialized “recent” list.

Filters are composable chips: status, project, environment, runtime, date, pinned, archived. The rail shows filters only while search is active or the user pins a filter view.

### 7.9 Archive, remove, and delete

Use consistent verbs:

- **Archive task:** hide from active navigation; preserve transcript, artifacts, and references.
- **Delete task record:** remove Integrator-owned record after confirmation; do not delete Git work by default.
- **Remove project:** stop showing a root in Integrator; preserve files and task records unless explicitly selected.
- **Delete worktree:** filesystem operation with dirty/unpushed commit protection.
- **Forget native session link:** diagnostic recovery action; preserve Integrator task.

Archive must be reversible. Delete must state exactly which records, worktrees, branches, and local files are affected. A generic trash icon may not mean different operations in different views.

### 7.10 History reliability

- History uses durable indexed storage, not a capped recent-items cache.
- The rail may virtualize rows but search must query the complete index.
- On restart, restore selection by stable task id, then canonical project id—not display order.
- If a native runtime loses its history, retain the Integrator transcript/evidence and label native resume unavailable.
- If a project path is temporarily offline, preserve it with an Offline root state; do not silently remove tasks.
- If two project identities are merged, retain aliases and an audit entry.

---

## 8. New task, open project, chat, and clone

The product should not ask users to choose among four large modes. The first useful action is to state intent; context can be supplied before or after typing.

### 8.1 Primary action semantics

Clicking **New task**:

- opens a blank task draft;
- inherits the currently selected project when invoked within a project;
- otherwise uses the most recent valid project only if the user setting enables that behavior;
- focuses the composer;
- does not create a durable task record until meaningful text/context exists or the user explicitly saves the draft.

The adjacent menu contains:

- New standalone task.
- Open folder and start.
- Clone repository and start.
- Quick chat.
- Import native session.

Keyboard `Ctrl/Cmd+N` repeats the last chosen new-task type only when the result is unambiguous; default is a project task inside a selected project and a standalone draft elsewhere.

### 8.2 Context inference

When a user types before selecting a project:

- Do not interrupt immediately.
- Detect local-code intent only after enough evidence, such as referenced paths, “this repo,” build/test verbs, or attached code.
- Show a quiet setup strip above the control row: `This sounds like project work · Choose folder · Clone · Continue standalone`.
- Preserve every character and attachment while setup changes.
- Never infer a filesystem root and grant access without user confirmation.

### 8.3 Open folder and start

1. System folder picker opens.
2. The application canonicalizes the root and checks for an existing project.
3. A compact context strip shows root, Git/branch state, guidance files found, and runtime availability.
4. If the folder is already open under another alias, reuse the project and explain it quietly.
5. Sending creates the task in that project.

Opening a folder alone opens the project overview; it does not start a runtime or create a branch.

### 8.4 Clone and start

The clone flow is inline and resumable:

```text
Repository URL        [________________________________]
Destination           [Choose a destination folder]
Branch                 [Default branch ▾]
After clone            [Use current branch ▾]
```

Advanced disclosure contains depth, recursive submodules, LFS, credential helper, and custom remote name. Do not show these by default.

Clone progress appears as setup activity in the draft task:

- resolving destination;
- authenticating through Git/OS helper;
- receiving objects;
- checking out;
- discovering project guidance;
- ready.

The composer remains editable. Cancel leaves the draft and offers Remove partial clone or Keep files. Retry never duplicates the destination silently.

### 8.5 Branch and isolation before send

For a Git project, the context sentence or chip always exposes:

- current checkout label;
- dirty state;
- isolation choice;
- base branch if a new worktree/branch will be created.

Default isolation policy:

| Situation | Default |
|---|---|
| Read-only question | Current checkout, read-only |
| One write task, clean checkout, no parallel writer | Current checkout with confirmation inherited from project policy |
| Another task may write same checkout | New worktree |
| Compare/best-of-N | One worktree per candidate |
| Non-Git folder | Current folder; explain that worktree isolation is unavailable |

Changing runtime must not silently change isolation. If a runtime cannot operate in the selected environment, show the mismatch before send.

### 8.6 Quick chat

Quick chat is intentionally lightweight:

- no implicit filesystem access;
- no worktree;
- no task contract;
- no background delegation;
- one-click `Add to task` that creates a durable task and carries over visible messages plus selected context.

Quick chat may use the same composer shell, but its header says `Quick chat` and its permission chip is `No project access`. It must not look identical to a task with full access.

### 8.7 Project overview

Selecting a project header opens an overview rather than an empty chat. It contains:

- root(s), remote(s), current checkouts, and dirty state;
- active and recent tasks;
- project guidance and attached skills;
- runtime compatibility and preferred execution profile;
- open branches/worktrees created by Integrator;
- recent verified outcomes;
- one compact New task composer.

This is the answer to “open project” without forcing users into a file explorer or silently opening the latest chat.

---

## 9. Composer primitive

### 9.1 Composer anatomy

The composer is one component with seven internal regions:

1. Context/setup strip.
2. Attachment and mention shelf.
3. Editable prompt body.
4. Queued/steering shelf.
5. Approval/question/revert dock.
6. Control row.
7. Submit/stop control.

Only regions 3, 6, and 7 are present in the smallest state. Additional regions appear without moving the composer away from the bottom anchor.

### 9.2 Geometry

- Outer horizontal inset: 16 px narrow, 24 px standard, 32 px wide.
- Maximum composer width: 820 px in transcript mode; it may align to the full primary pane in plan/table mode.
- Outer radius: 16 px standard, 14 px compact.
- Border: 1 px semantic base; focused border uses focus token without layout change.
- Body padding: 14 px top, 14 px sides, 8 px before controls.
- Control row height: 32 px.
- Compact minimum height: 88 px.
- Body grows from one to six visual lines.
- At 168 px total height, the prompt body scrolls internally.
- `Ctrl/Cmd+Shift+Enter` opens expanded editor; the same command returns to compact view.

The expanded editor is a centered sheet or primary-pane document, not a taller bottom card. It shows line numbers only for pasted structured text when requested. Closing it preserves selection and scroll.

### 9.3 Prompt body behavior

- `Enter` submits; `Shift+Enter` inserts newline. A setting can invert this, and the placeholder reflects it.
- IME composition suppresses submit until composition ends.
- Tab navigates controls; it does not insert a tab unless the expanded editor is in code mode.
- Undo/redo is scoped to the draft and survives mention-chip conversions.
- Spellcheck is on for prose and off inside code spans/blocks.
- Pasted paths become mentions only after validation and an undoable conversion.
- Pasted images show thumbnails; large text shows a file/text attachment chip rather than freezing the editor.
- URLs remain text unless the user chooses Attach page or a supported paste rule is enabled.
- The caret never jumps when streaming events arrive above the composer.

### 9.4 Placeholder text

Placeholder responds to context, but does not rotate or animate:

- Project task: `Describe the outcome for Lotmind AI…`
- Standalone: `Ask a question or choose a project…`
- Running task: `Steer the current run or queue the next instruction…`
- Waiting approval: prompt body remains available; dock says approval needed.
- Offline runtime: `Your draft is safe. Reconnect or choose another runtime…`

Avoid clever examples that disappear before they can be read.

### 9.5 Context and attachments

Each item is a removable chip with type, short label, and state:

- file;
- folder;
- selection/range;
- image/PDF;
- URL/source;
- task contract;
- prior task/handoff;
- Git diff/commit/PR;
- skill;
- pane selection.

Chip rules:

- Show at most two rows before horizontal or contained vertical overflow.
- Preserve full canonical target in tooltip/details.
- Indicate missing, stale, unreadable, too large, excluded by policy, or upload pending.
- Removing a chip does not delete the source.
- Folder mentions show estimated scope and whether the runtime receives full content, an index, or just the path.
- Selected text shows file and line range and becomes stale when the file changes; the user can refresh or send the captured snapshot.

### 9.6 Slash commands and mentions

`/` opens commands; `@` opens context. They are separate menus and separate parsers.

Command menu groups:

- Task: plan, compact, handoff, review, summarize.
- Run: steer, queue, stop, retry, fork.
- Context: attach file/folder/diff/task.
- Layout: open terminal/diff/preview/agents.
- Runtime-native: commands advertised by the active adapter.

Runtime-native commands show the owning runtime and capability impact. Unsupported commands are hidden from the default list but searchable under “Unavailable” with a reason. The menu retains keyboard selection while results stream from file indexing.

Mention results use frecency plus current file/project relevance, never provider sponsorship. Each result shows name, shortened path/owner, type glyph, and scope. Directories load incrementally and keep selection stable as children arrive.

### 9.7 Control row

Leading group:

- Add/context button.
- Permission chip.
- Environment/checkout chip only when not already obvious or non-default.
- Goal/contract indicator when attached.

Trailing group:

- Queue/steer disclosure while running.
- Delegation-policy chip.
- Execution-route chip.
- Optional voice button.
- Send/stop button.

The trailing order is stable: `Delegation → Route/model → Voice → Send/stop`. It follows the supplied Codex reference's lower-right model selector while adding one adjacent branching control instead of a provider mode bar. At narrow widths, retain Add, permission status glyph, route, and Send. Keep a branching badge when delegation is active; move environment, goal, voice, and inactive delegation labels into overflow. Effective permission and active delegation must remain inspectable in one action.

### 9.8 Execution-route picker

The collapsed chip reads like reasoning effort, not a provider mode:

- `Auto`.
- `Codex · GPT-5.6 · High`.
- `Claude Code · Opus · Medium`.
- `Cursor · Composer · Fast`.
- `Grok Build · Grok · High`.

The popover has two layers:

1. Recommended profiles with plain-language fit and current availability.
2. Advanced matrix for runtime, model, effort, environment, isolation, and fallback.

Every profile row can disclose:

- capability fit;
- subscription or API route;
- observed/estimated usage pressure;
- native session continuation behavior;
- unavailable features;
- project preference;
- why Auto selected it.

Selection is a route, not merely a model id. The full identity is `connection/subscription → runtime/harness → provider model → service tier → effort`. Search spans every component. The collapsed lower-right pill favors `Runtime · Model · Effort`; hover/focus/details reveal the connection, provider, billing/usage class, and native continuation behavior.

When an active run prevents an in-place model change, selecting a new route creates an explicit `Next turn`, `Fork`, or `Provider-neutral handoff` intent. It never rewrites the displayed identity of the running segment.

Provider color appears only as a small identity glyph. The whole composer does not recolor when the runtime changes.

### 9.9 Delegation-policy picker

The lower-right branching control has four first-level states:

| State | Meaning |
|---|---|
| `Off` | This turn and its children cannot spawn brokered peers |
| `Ask` | The lead proposes a child; the user approves assignment, route, scope, and budget |
| `Bounded` | The lead may spawn only assignments matching the visible policy |
| `Auto` | A deterministic routing recipe may select peers and fallbacks inside hard limits |

The collapsed chip uses a branching glyph plus a short label/count, never a cluster of provider logos. The popover exposes eligible peer profiles, role rules, task classes, maximum depth/concurrency/children/runtime, usage budget, fallback order, permission ceiling, worktree strategy, child-delegation permission, merge authority, and required evidence. A one-sentence preview translates the result into user language.

Saved policy scope is explicit: task, project, personal, or managed. Narrower policy wins; no child can widen parent access, budget, allowed providers, network/external actions, or delegation depth. During a run, changes show `Next child`; active and already-approved children retain their immutable launch snapshot. A policy diff is available from every child card.

### 9.10 Permission picker

Collapsed label states the effective boundary, not an abstract mode name:

- `Read only`.
- `Write project`.
- `Ask for risky actions`.
- `Full local access`.

The popover summarizes:

- readable roots;
- writable roots;
- network policy;
- external app/browser control;
- command policy;
- destructive action policy;
- inherited project/task rules;
- runtime limitations.

Changing permissions affects the next not-yet-started operation. Active approvals remain bound to the permission snapshot that produced them. An adapter's native “bypass” mode never overrides Integrator's outer policy.

### 9.11 Submit, running, and stop

Button states:

| State | Control |
|---|---|
| Empty invalid | muted send, disabled with reason |
| Ready | send arrow |
| Setup needed | send arrow; click opens missing setup inline |
| Submitting | progress arc; input remains readable |
| Running, draft empty | stop square |
| Running, draft nonempty | split control: `Steer`/`Queue` plus stop |
| Stop requested | disabled stop with `Stopping…` label in status area |
| Runtime detached | reconnect/recover action; stop shown only if process control exists |

Never replace Stop with Send just because the UI lost the activity subscription. Backend turn state and process state are separately reconciled.

### 9.12 Queued and steering messages

When a run is active, sending offers:

- **Steer now:** deliver at the next runtime-supported interruption point.
- **Send next:** enqueue after the current turn ends.

The queue shelf shows:

- delivery type;
- one-line content;
- attachment count;
- target run if not the main run;
- drag handle for queue order where supported;
- Edit, Send now, Convert, and Cancel.

Cap the shelf at 112 px and show a summary when collapsed: `2 queued · 1 steering`. Cancellation is optimistic but visibly reconciles if the runtime already consumed the message. Stopping a run pauses the queue; it never silently drains messages into a replacement runtime.

### 9.13 Composer docks

Typed docks appear directly above the composer controls:

- Approval request.
- Clarifying question.
- Multi-choice selection.
- Revert/checkpoint offer.
- Runtime reconnect.
- Merge/conflict decision.
- Usage/quota block.
- Policy violation.

Only the highest-priority blocking dock is expanded. Others show as a compact stack count. The prompt body remains usable so a user can explain a choice. Docks retain the requesting run, capability, command/path, risk, scope, and expiry.

### 9.14 Draft durability

Persist per task:

- text and selection;
- attachments and their captured/stale state;
- context chips;
- expanded/compact editor state;
- queue entries and order;
- intended delivery type;
- selected profile and permissions for the next turn;
- selected delegation policy and its immutable source/version;
- scroll position inside a long draft.

Persist after 250 ms idle and immediately on task/window switch. Never write secret field values into general draft storage. If an attachment path no longer exists, keep a missing chip rather than silently dropping it.

---

## 10. Task transcript and timeline

### 10.1 Transcript layers

The transcript is a projection over typed task events. It has three density modes:

| Mode | Shows |
|---|---|
| Summary | User turns, important decisions, changed files, verification, failures, final answers |
| Normal | Summary plus grouped tools, approvals, key commands, sources, child-run milestones |
| Verbose | Normal plus every runtime-delivered tool, file read, command, delegation, and exposed reasoning-summary item |
| Raw diagnostics | All observable adapter events and redacted protocol framing; never hidden reasoning |

Changing density is instant and preserves the nearest semantic anchor, not raw pixel scroll.

### 10.2 Turn anatomy

Each turn contains:

1. User request.
2. Optional task-contract delta.
3. Run header with execution profile and environment.
4. Activity groups.
5. Approvals/questions and responses.
6. Evidence summary.
7. Final response or stop/failure outcome.

The run header collapses into the activity summary after completion. A task with multiple runtimes in one turn shows a run segment per runtime, connected by explicit delegation or handoff events.

### 10.3 Content measure

- Prose: 68–82 characters per line, maximum 760 px.
- Code: may expand to pane width and scroll horizontally.
- Tables: may expand; first column can pin only in dedicated table view.
- Long paths: wrap at separators or middle-truncate in labels; never visually overflow.
- User messages: maximum 760 px and visually distinct without giant speech bubbles.
- Activity rows: full available primary-column width.

### 10.4 Virtualization and measurement

- Virtualize after 250 rendered rows or equivalent cost threshold.
- Row keys derive from stable event ids, not array indices.
- Store measured heights by content version and density mode.
- Reconcile inserted/updated streaming events without resetting the visible anchor.
- Keep 1.5 viewport overscan above and below for smooth keyboard search.
- Allow browser/text selection across nonvirtualized visible rows; provide Copy turn/Copy transcript for longer spans.
- Search results can materialize remote rows and return to the prior anchor.

### 10.5 Scroll behavior

The transcript has four scroll states:

- **Following:** user is at end; new content stays visible.
- **Reading:** user moved away; new content does not move the viewport.
- **Anchored:** a selected event/file/comment remains at a stable visual position while nearby content updates.
- **Restoring:** task reopens at saved semantic anchor plus offset.

Rules:

- Enter Reading after 48 px of intentional upward movement or text selection.
- In Reading, show a compact `↓ 6 new events` control above the composer.
- Clicking it scrolls to the first unread event; a second click follows the end.
- Image/code expansion above the viewport compensates scroll position.
- Switching density preserves event id and relative offset.
- On task return, restore the last read anchor; if the task finished while away, show an unread divider before new results.

### 10.6 Sticky request context

When the active run's user request scrolls fully above the viewport, show a one-line sticky summary:

> Current request · Implement mobile intake overnight agent

Click expands a peek with the full request and attachments. It is not another transcript copy and disappears when the original request returns. For long autonomous tasks, this prevents tool activity from obscuring the assignment.

### 10.7 Streaming

- Batch visual updates to at most one per animation frame and prefer 30 Hz for text chunks.
- Do not animate each token.
- Render a stable paragraph/block and append chunks without re-running entrance motion.
- Reserve expected media dimensions before load.
- Syntax highlighting may lag behind streaming; do not block text visibility.
- If the adapter sends corrections, update the block and expose a subtle “updated” marker in diagnostics.
- Keep the composer and selected pane out of the transcript's layout reflow path.

### 10.8 Collapsed activity groups

A collapsed group always says:

- what kind of work occurred;
- item count;
- elapsed range;
- outcome;
- any failure/warning count.

Examples:

- `Read 12 files · 18s`.
- `Ran 4 commands · 1 failed · 42s`.
- `Edited 7 files · +284 −96`.
- `Searched 6 sources · 2m`.
- `Delegated 3 child runs · 2 complete, 1 waiting`.

Groups never collapse away an unresolved approval, error, policy block, or user response.

### 10.9 Final responses

Final-response anatomy:

- outcome lead;
- concise change/result summary;
- verification evidence;
- gaps/risks;
- artifact links;
- next action only when genuinely useful.

It has Copy, Save as handoff, Continue with, Review changes, and Mark complete actions. It does not repeat the full activity log. A provider's native final is preserved in Raw diagnostics; the Normal view may normalize its surrounding metadata but not rewrite its substantive claims as verified facts.

### 10.10 Reasoning visibility

The product shows:

- adapter-provided reasoning summaries when explicitly exposed for display;
- plans and plan revisions;
- observable actions;
- decisions inferred from explicit messages, labeled as derived;
- elapsed and waiting time.

It never claims to show private chain-of-thought, fabricates “thinking steps,” or uses decorative inner-monologue text. A “Worked for 2m 24s” label means the run was active for that wall-clock interval; it is not a measure of cognitive effort.

---

## 11. Activity, attention, and agent primitives

### 11.1 Activity event taxonomy

All adapters normalize observable events into:

- lifecycle;
- message;
- plan;
- file read;
- file edit;
- command/process;
- search/source;
- browser/computer use;
- approval/question;
- child run;
- artifact/preview;
- Git/review;
- usage;
- warning/error;
- handoff.

Unknown native events render as `Runtime event` with redacted structured details in Raw diagnostics, never as guessed file or command activity.

### 11.2 Current-activity bar

When work is active, a 28–32 px status bar sits immediately above the composer or at the top of the primary canvas when the composer is not visible:

> Codex · Running tests · 1m 12s

It includes:

- runtime/child identity;
- present-tense observable activity;
- elapsed time;
- waiting or retry state;
- disclosure to the active event;
- stop control if controllable.

Text changes crossfade once per meaningful phase, not per event. The bar never cycles vague phrases like “Thinking harder.”

### 11.3 Attention priority

Priority order:

1. Security/policy block.
2. Destructive or external-action approval.
3. Merge/conflict decision.
4. Clarifying question blocking progress.
5. Runtime failure/disconnect.
6. Completed unread result.
7. Usage pressure warning.
8. Informational milestone.

Only priorities 1–5 may trigger OS notifications by default. The sidebar “Needs attention” section follows the same order.

### 11.4 Child-run representation

A child run is not merely an indented chat message. Its compact card shows:

- role/title;
- runtime and model;
- read/write scope;
- target checkout/worktree;
- status and elapsed time;
- latest observable activity;
- usage confidence;
- returned result/evidence count.

Actions: Peek, Open pane, Steer, Stop, Reassign, Compare, Promote result. Destructive cleanup remains in overflow.

### 11.5 Child-run peek and pane

- Hover or keyboard peek shows a noninteractive summary after 350 ms; it closes without animation on pointer departure.
- Click opens an interactive popover anchored to the card if content is short.
- More than one exchange, a terminal, diff, or long output promotes to a typed pane.
- The pane header always states `Child of <task/run>` and scope.
- Closing the pane does not stop the child.
- A child waiting for the user promotes its approval to the parent attention queue while retaining its origin.
- The pane contains Summary, Activity, Messages, Transcript, Files/Review, Terminal, and Result only when those surfaces have content/capability; it does not pre-render seven empty tabs.
- Messages use the broker mailbox and show delivery as steered current turn, queued next turn, follow-up run, delivered, or rejected.
- Transcript opens the authorized native/local observable stream on demand with range/cursor loading. Parent/child/sibling grants, redactions, gaps, and source sequence are visible.
- Child scratch remains private; accepted notes/evidence/results appear as typed task records rather than a copied scratch or transcript dump.

### 11.6 Agent grid

For three or more concurrent child/candidate runs, use a grid instead of a transcript stack.

Grid card minimum width: 300 px. Each card contains status, latest milestone, changed-file count, tests, elapsed time, and stop/peek. Live terminals are not rendered in every card; a selected card owns the detail pane.

Grid motion is restrained:

- Cards do not reorder while running.
- Completion changes state in place.
- User can sort manually or after all candidates settle.
- A newly waiting card gets one focus-safe highlight, no pulse.

### 11.7 Candidate comparison

Comparison has aligned columns for:

- approach/plan;
- changed files and diff stats;
- verification results;
- runtime/model/effort;
- elapsed time;
- usage/cost confidence;
- policy deviations;
- reviewer findings;
- checkout/branch.

The system may ask an independent judge agent, but never auto-select a winner solely from candidate self-evaluation. Accepting a candidate opens its review and merge/apply workflow; it does not silently delete other worktrees.

### 11.8 Side questions

A side question:

- reads the main task up to a recorded fork event;
- cannot write files or steer the main run by default;
- gets a distinct speech-bubble-with-branch glyph;
- appears in a lightweight side-question list, not the child-agent grid;
- can be promoted to task note, queued instruction, or delegated assignment with preview.

The UI explicitly labels its context and non-effect on the main task.

---

## 12. Files, context, and editor primitive

### 12.1 Path interaction

Click behavior depends on target:

- Text/code file: open in file pane at line/range.
- Image, HTML, PDF: open preview pane.
- Directory: reveal/select in file tree; do not dump the directory into chat.
- Missing path: show recovery popover with original checkout and search alternatives.
- External URL: open safe preview or system browser according to setting.

Context menu:

- Attach to next prompt.
- Open in Integrator.
- Open in preferred editor.
- Reveal in Finder/Explorer.
- Copy relative path.
- Copy absolute path.
- Copy permalink when Git context permits.
- Compare with task start/current branch.

### 12.2 File pane header

Header includes:

- file icon and relative path;
- dirty/read-only/stale state;
- checkout identity if ambiguous;
- breadcrumbs on demand;
- Open externally;
- Attach;
- More.

Tabs truncate file names but retain full relative path in tooltip. Preview tabs are italic or otherwise structurally marked and are replaced by the next single-click file; double-click or edit pins them.

### 12.3 File editing scope

Integrator is a spot editor, not a full IDE:

- syntax highlighting;
- search in file;
- go to line;
- selection and copy;
- small edits;
- Save/Discard;
- open in preferred editor for deeper editing.

If the file changes on disk after opening:

- clean buffer reloads with a nonblocking notice;
- dirty buffer shows a conflict bar with Compare, Keep mine, Reload, and Save as;
- Save never overwrites silently;
- the task transcript records user edits as user-originated, not agent-originated.

### 12.4 File tree

The file tree is a pane view, not permanent navigation. It supports:

- Files and Changed tabs;
- compact folders setting;
- fuzzy filter;
- ignored/hidden-file toggle with policy warning;
- Git status decorations;
- task-touched markers;
- multi-select for attachment;
- reveal active file;
- keyboard tree semantics.

It does not show more than three inline actions per row. Large repositories use incremental directory loading; filtering indicates whether results are indexed or currently loaded.

### 12.5 Context provenance

Every context item can disclose:

- source object/path/URL;
- captured at time and content hash when applicable;
- live reference versus snapshot;
- character/token estimate;
- selection method: user, project rule, skill, agent, or auto retrieval;
- runtime delivery mode;
- exclusions/redactions;
- stale state.

This is critical when the same task moves between runtimes with different context systems.

### 12.6 Large-context behavior

- Do not imply a full folder was sent if only an index or summary was used.
- Show `Indexed`, `Attached`, `Referenced`, or `Unavailable`, not one generic paperclip.
- Warn before attaching huge generated directories; offer narrower selection.
- Deduplicate overlapping folder/file selections.
- Preserve user-pinned context across turns; auto-retrieved context is turn-scoped unless pinned.
- When a runtime compacts context, retain Integrator's context manifest and show what may need reattachment.

---

## 13. Diff and review primitive

### 13.1 Review is a workspace mode, not a message card

Opening Review creates a work pane with:

1. Scope and base controls.
2. Changed-file tree.
3. Diff canvas.
4. Comment/findings layer.
5. Review action bar.

A compact diff summary may appear in the transcript, but accepting, rejecting, commenting, staging, and navigation occur in the review pane.

### 13.2 Review scopes

Support these scopes when the repository/runtime can provide them:

- Last run.
- Last turn.
- Task start to working tree.
- Unstaged.
- Staged.
- Selected commit.
- Branch against base.
- Candidate against candidate.
- Pull request.

The scope label always names both ends, for example `feature/mobile-intake ↔ origin/main`, not merely `Branch`. “Last turn” uses agent edit provenance and must say when manual or other-agent edits overlap.

### 13.3 Review header

Header contains:

- scope selector;
- base/compare branch or commit;
- checkout identity;
- changed files and line statistics;
- stale state;
- layout toggle: unified/split;
- whitespace toggle;
- refresh;
- open externally;
- overflow.

Changing scope with unresolved draft comments asks whether to retain, re-anchor, or discard them. Refresh preserves the selected file and nearest line when possible.

### 13.4 Changed-file tree

File rows show:

- status glyph: added, modified, deleted, renamed, copied, binary, conflict;
- relative path;
- `+` and `−` counts where meaningful;
- unresolved comment/finding count;
- staged/accepted state only when the action exists in this scope.

Group by directory by default; offer flat list and status grouping. Renames display old → new in details. Selection follows review navigation, not filesystem selection.

### 13.5 Diff canvas

- Unified layout minimum: 420 px.
- Split layout minimum: 640 px; fall back to unified below it.
- Line-number gutters remain selectable and support comment ranges.
- Sticky file headers identify path and file status.
- Collapsed unchanged regions show line count and expand in both directions.
- Horizontal scrolling is per code viewport; vertical scrolling belongs to the diff pane.
- Syntax highlighting is subdued relative to additions/deletions.
- Addition/deletion backgrounds remain distinguishable in high contrast and color-deficiency simulations.
- Very large files use virtualized hunks and an explicit “partial diff” warning when the backend truncates.

### 13.6 Binary and rich diffs

| Type | Default review |
|---|---|
| Image | two-up with dimensions and size; optional swipe/onion/difference modes |
| PDF | page thumbnails plus changed-page comparison if available; otherwise before/after |
| Markdown | source diff plus rendered before/after toggle |
| Notebook | cell-aware diff when supported; raw JSON only in diagnostics |
| Lockfile | summarized dependency changes plus raw opt-in |
| Generated/minified | warning and collapsed by default |
| Submodule | old/new commit, subject, and remote link |
| Unsupported binary | metadata and external-open action |

Never display an empty canvas when content is too large or unsupported; explain the limitation and next action.

### 13.7 Comments and annotations

An inline comment is a first-class draft object:

- anchored to file, side, commit/content hash, and line range;
- editable and removable before send;
- visibly stale if the diff changes;
- keyboard reachable from a findings list;
- optionally dictated through voice;
- targetable to main run, selected child, or external PR.

Sending review feedback previews the payload and target. The agent receives structured file/range/comment context when supported; otherwise the adapter renders a faithful textual projection and labels the downgrade.

### 13.8 Accept, reject, stage, and revert

These verbs are not interchangeable:

- **Accept suggestion:** approve an agent proposal not yet applied.
- **Apply hunk:** write a proposed patch.
- **Revert hunk/file:** restore selected working-tree changes after a preview.
- **Stage hunk/file:** Git index operation.
- **Discard changes:** destructive working-tree operation with protection.
- **Resolve comment:** review-state operation.

Every action names its scope and availability. Bulk actions display file/hunk counts. Destructive actions provide immediate Undo when technically safe; otherwise confirm with concrete consequences.

### 13.9 Review findings

Automated review findings use:

- severity;
- confidence;
- file/range;
- concise title;
- explanation;
- suggested action;
- evidence/source runtime;
- resolved/dismissed/false-positive state.

Findings never masquerade as compiler/test failures. A user can filter by severity, runtime, resolved state, and file. Dismissing a finding records a reason locally and does not alter code.

### 13.10 Diff-to-file navigation

Clicking a file line opens the file pane at the exact corresponding working-tree line and leaves a back-stack entry. If the line no longer maps, show the nearest match and an “original line unavailable” marker. `Alt+Left` returns to the diff position.

### 13.11 Task-paired Git action bar

The Review/Git pane is bound to the selected task/run/worktree lease. Its footer/action bar progressively exposes:

- stage/unstage selected file or hunks;
- editable commit summary and description;
- Commit to the selected worktree;
- Fetch and refresh;
- Publish branch or Push with upstream/remote/commit preview;
- Pull/Rebase/Merge only after strategy and dirty/conflict preview;
- Open/Create pull request when the Git host integration supports it;
- Compare/apply/merge child work through the designated merge authority.

Commit and Push never collapse into one ambiguous default action. Push names remote host/repository, branch/refspec, ahead/behind, force/protection state, and auth owner. A timeout after push checks the remote before retry. Selecting a child changes the Git/Review/Files/Terminal context together; it never operates on the last-focused checkout accidentally.

---

## 14. Terminal, commands, and background processes

### 14.1 Terminal placement

The terminal is a utility panel by default because it benefits from horizontal space and is supporting functionality. It may be moved to a side pane or new window. Agent command summaries remain in the transcript; full interactive terminal sessions live in the terminal panel.

Terminal types are visibly labeled User task terminal, Setup/login terminal, Agent process, or External terminal. Setup/login is user-owned and not model-visible by default.

### 14.2 Terminal header

Each tab shows:

- title or process name;
- shell/runtime glyph;
- checkout/environment;
- running/exit status;
- unread output dot;
- close action.

The panel toolbar contains New, Split, Kill, Clear, Search, and More. `New` inherits the selected task checkout and environment after showing them in the menu.

### 14.3 Agent-run command primitive

A command activity contains:

- exact redacted command or safe summary according to policy;
- working directory;
- environment/runtime;
- start and elapsed time;
- live/exit state and exit code;
- truncated output summary;
- Open terminal/log, Copy, Stop, and Retry actions.

If a command contains secret-bearing arguments or environment variables, redact values at ingestion and mark `Sensitive values hidden`. The raw diagnostic export follows the same redaction policy.

### 14.4 Process states

Use explicit states:

- Starting.
- Running.
- Awaiting input.
- Backgrounded.
- Stop requested.
- Exited successfully.
- Exited with code.
- Terminated by user.
- Timed out.
- Lost connection.
- Unknown after restore.

“Stopped” appears only after process termination is observed or the runtime confirms it. A sent cancel request is `Stop requested`.

### 14.5 Output behavior

- Stream output in bounded chunks and virtualize scrollback.
- Preserve ANSI semantics but map colors to readable theme tokens.
- When the user scrolls away, show unread line count; do not snap back.
- Search and copy work across retained scrollback.
- Default retention is bounded per process with spill-to-disk logs under the app data directory.
- Truncation displays retained range and log location/action.
- Background processes do not produce continuous global animations.

### 14.6 Interactive input and takeover

If an agent-started command requests input:

- adapter marks the process interactive;
- task attention says what is waiting;
- user can Provide input, Open terminal, or Terminate;
- takeover transfers input ownership visibly;
- returning control to the agent requires explicit action when the runtime supports it.

Never render a hidden password prompt inside a transcript. Use a secure native input surface and send the value directly to the process without storing it in task history.

### 14.7 Terminal safety

- Closing a running terminal tab asks Keep running, Stop, or Cancel unless policy defines a default.
- Quitting the app summarizes running local processes and remote tasks separately.
- A shell tab clearly identifies PowerShell, Command Prompt, Git Bash, WSL, zsh, bash, or remote shell.
- On Windows, agent environment and user terminal environment can differ; show both when they do.
- Retrying a command previews cwd, environment, and permission changes since the original run.

---

## 15. Browser, preview, and design-feedback primitive

### 15.1 Preview types

The preview pane supports:

- local dev server;
- static HTML;
- image;
- PDF;
- Markdown/rendered artifact;
- app screenshot;
- remote URL where policy permits;
- agent computer-use session.

Its header identifies type, source, environment, and control ownership.

### 15.2 Browser preview toolbar

Minimal toolbar:

- Back/forward.
- Reload.
- Address/source label.
- Viewport preset.
- Select element/design feedback.
- Screenshot.
- Open externally.
- More.

Developer controls such as console, network, cookies, and device emulation live under More or a dedicated diagnostics pane.

### 15.3 Viewport presets

Default presets:

- Responsive.
- Mobile 390 × 844.
- Tablet 768 × 1024.
- Desktop 1440 × 900.
- Full pane.

Display dimensions and zoom. Presets resize the viewport, not the whole app window. User-defined presets persist per project.

### 15.4 Design mode

Design feedback supports:

- point selection;
- element selection;
- rectangular area selection;
- text selection;
- screenshot region;
- multi-selection;
- annotation note.

Captured context includes screenshot crop, viewport, URL/route, DOM locator when available, accessible name/role, computed box, and timestamp. The composer chip reads `Button “Submit” · /checkout · mobile` rather than an opaque screenshot id.

Selection affordances:

- one 1 px accent outline;
- an external label that avoids covering the element;
- translucent area fill below 12% opacity;
- no persistent animated marching ants;
- high-contrast alternate outline;
- Escape cancels; Enter attaches; modifier-click adds.

### 15.5 User versus agent control

Computer-use ownership is always visible:

- `Agent controlling`.
- `User controlling`.
- `Control paused`.
- `Waiting for approval`.

Pointer/keyboard takeover pauses agent input before accepting user input. The user can Resume agent; it never resumes on a timer after manual takeover. Sensitive fields block screenshots and agent input according to policy.

### 15.6 Preview lifecycle

- Detect dev-server URLs from process output but ask before exposing network-wide bindings.
- If the server exits, keep the last frame with a disconnected state and Restart action.
- Reload does not restart the server.
- Route and scroll position persist per task.
- Screenshot capture records viewport and source commit/working-tree state.
- Visual evidence can be attached to a review finding or completion criterion.

### 15.7 Rich artifact annotations

Images and PDFs support point/rectangle annotations and threaded comments. Markdown/HTML supports element or text-range annotations. Annotations are stored separately from source files until explicitly applied or exported.

---

## 16. Plan, goal, task contract, and completion

### 16.1 Goal header

A task's goal appears as a compact editable title and optional one-sentence contract summary. It is visible at the top of the task but does not occupy a hero card.

Header elements:

- task title;
- project/checkout breadcrumb;
- status;
- pinned/archived state;
- contract indicator;
- layout/views menu;
- overflow.

Renaming the task changes navigation label only. Editing the goal or contract creates a visible task-contract revision.

### 16.2 Plan as a document

Plans open in a typed work pane with document semantics:

- editable rows/sections;
- unsaved/dirty state;
- Save and Discard;
- revision history;
- export to Markdown;
- link to source run;
- checkable steps only when steps represent verifiable work;
- comments/annotations;
- attach plan revision to next prompt.

An agent plan is not automatically truth. The user can edit it; the next run receives the accepted revision and a diff of changes where supported.

### 16.3 Progress semantics

Progress is state, not theater:

- Pending.
- In progress.
- Blocked.
- Completed, unverified.
- Verified.
- Skipped with reason.

Do not show percentages unless the denominator is real. A five-step plan may show `3 of 5` only when the steps remain stable enough for that number to mean something.

### 16.4 Task contract pane

Sections:

- Goal/outcome.
- Required branch/checkout.
- Scope and exclusions.
- Security/authorization constraints.
- Design/UX standards.
- Verification requirements.
- Evidence requirements.
- Commit/deploy policy.
- Fallback/emulator behavior.
- Handoff requirements.

Every section records source: user prompt, attached file, project policy, optional signed managed-machine policy, or derived summary. Derived text is editable and labeled.

### 16.5 Completion ledger

The completion pane aligns requirements with evidence:

| Requirement | State | Evidence | Source |
|---|---|---|---|
| Tests pass | Verified/failed/missing | command + exit + timestamp | run |
| Mobile screenshot | Verified/missing | artifact | run/user |
| No deploy | Observed policy | blocked action/audit | policy |
| Commit created | Verified | commit hash | Git |
| Handoff written | Verified | file/artifact | run |

The task can be marked complete with gaps only after the user acknowledges them. “Verified complete” requires all required evidence.

### 16.6 Checkpoints and reverts

Runtime-native checkpoints are labeled as agent snapshots, not Git commits. Show what they include and exclude. Restoring previews affected files and warns that manual edits may not be included. Prefer Git for durable reviewable state; checkpoints are a convenience recovery mechanism.

---

## 17. Runtime connection, installation, and login

### 17.1 Runtime inventory

Connections page uses one row/card per runtime adapter:

- runtime name and verified executable/version;
- connection status;
- authentication owner/method without secret values;
- transport: ACP, app server, structured CLI, PTY, extension bridge;
- environment support;
- capability summary;
- update/compatibility state;
- Test, Configure, Reconnect, and Details.

Do not render hundreds of model cards on this page. Models belong in execution-profile selection after a runtime is connected.

### 17.2 Status vocabulary

- Not detected.
- Detected, not configured.
- Login required.
- Connecting.
- Ready.
- Ready with reduced fidelity.
- Update recommended.
- Incompatible version.
- Permission blocked.
- Disconnected.
- Failed health check.

“Connected” means a current health check succeeded, not merely that an executable exists.

### 17.3 Detection

Detection checks standard install locations, PATH, configured custom paths, editor extensions, ACP manifests, and known local app bridges. Results show the exact executable/bridge path and version in details. Auto-detection never executes an untrusted repository-local binary without approval.

### 17.4 Installation assistance

For missing runtimes:

- link to vendor-owned official install path;
- show copyable official command where appropriate;
- offer Refresh after install;
- never silently install global CLIs or modify shell profiles;
- explain Windows/macOS prerequisites such as Git, WSL, or app permissions.

### 17.5 Login flow

- First probe documented auth status. A healthy existing CLI login goes directly to capability/compatibility verification; do not force reauthentication.
- Use the vendor CLI/app's owned browser/device-code flow.
- When the vendor login is interactive, launch it in a dedicated Setup terminal with user-owned stdin, real PTY behavior, and no model attachment.
- Show which executable initiated login.
- Keep secret/token contents out of the UI and logs.
- Route password, no-echo, MFA, hardware-key, and account/workspace selection through vendor/OS/secure user surfaces; never ask an agent to enter them.
- Display `Waiting for vendor login…` with Cancel and Open browser again.
- On callback, run a health/capabilities check before saying Ready.
- Return to the preserved draft/task and prior selection.
- If login succeeds in one surface but the adapter uses a different config scope, explain the mismatch explicitly.

### 17.6 Reduced fidelity

A runtime can be usable through PTY parsing while lacking structured capabilities. The UI must label:

- what is available;
- what is inferred;
- what is unavailable;
- what will appear as raw terminal output;
- whether resume, approval, diff attribution, usage, or model selection is reliable.

Never show a structured control that the adapter cannot enforce.

### 17.7 Capability negotiation

At connection and session start, cache a versioned manifest for:

- session create/resume/fork;
- model/effort selection;
- permission modes;
- structured tools/events;
- prompt queue/steer;
- cancellation;
- files/diffs/comments;
- terminal/process control;
- browser/computer use;
- subagents;
- skills/MCP;
- usage metrics;
- worktree/environment support;
- native commands.

UI availability derives from the active session manifest, not a static provider-name check.

---

## 18. Usage, cost, and model selection

### 18.1 Usage principles

- Provider-reported values are labeled Reported.
- Locally observed tokens/time/events are labeled Observed.
- Calculated costs or quota pressure are labeled Estimated.
- Missing provider quota is `Not exposed`, never `Unlimited`.
- Subscription and API billing routes are never combined into one fake balance.

### 18.2 Compact usage primitive

The composer may show one quiet usage indicator when it affects choice:

- `72% context`.
- `Plan usage high`.
- `~$0.18 API`.
- `Usage unavailable` only inside details, not as constant chrome.

If a ring is used, it represents exactly one dimension. Context and subscription-period usage require separate arcs with a legend or, preferably, separate bars in the popover.

When available, the compact control may summarize `12% · 215k · ≈$1.84`. These are separate measurements, not a combined balance: provider-period allowance, tokens, API-equivalent value, and actual incremental spend each retain their own source, freshness, window, and reset. Never synthesize a percentage without a documented denominator and never present an API-equivalent estimate as spend.

### 18.3 Usage popover

Sections:

- Current run: runtime, model, elapsed, tokens/calls/cost when exposed.
- Task total: per-runtime breakdown.
- Context: current window use and compaction events.
- Plan/subscription: vendor-reported period state.
- Confidence and last updated.
- Open full usage.

Numbers do not animate count-up. Updates crossfade only if the popover is open.

### 18.4 Model/profile comparison

The advanced picker compares models on task-relevant dimensions:

- runtime/harness;
- capability fit;
- context/attachment support;
- effort/latency intent;
- tool/subagent support;
- current availability;
- subscription/API route;
- user/project preference;
- recent local outcomes;
- estimated usage confidence.

Do not publish universal “smartest” ranks. Recommendations say why: `Best fit: visual review + browser`, `Cheaper reader`, `Native continuation available`, or `Required by project policy`.

### 18.5 Mid-task model/runtime changes

Before switching, show one of:

- `Continue native session`.
- `Fork native session`.
- `Create provider-neutral handoff`.
- `Start fresh with attached task ledger`.

The switch preview states what transfers: visible transcript, plan, task contract, selected context, files, diff, and evidence; and what does not: hidden/native context, unsupported tool state, or vendor-specific checkpoints.

### 18.6 Auto routing disclosure

Auto's collapsed label stays `Auto`. Its details list:

- selected profile;
- top decision factors;
- rejected alternatives with concise reason;
- fallback rules;
- whether historical local outcomes influenced the choice;
- usage freshness.

The user can pin one factor or override for one turn, task, or project. Auto never changes an active run's runtime mid-turn.

---

## 19. Inspector, notifications, and auxiliary surfaces

### 19.1 Inspector purpose

The Inspector shows structured detail for the current selection or task. It is not a miscellaneous right sidebar. Its header always states its anchor:

- `Task details`.
- `Run: Codex implementation`.
- `Command: npm test`.
- `File: src/intake.ts`.
- `Source: Vercel docs`.
- `Child: Security review`.

Changing transcript selection updates the Inspector only when follow-selection is enabled. Otherwise a pin glyph says it is pinned to a prior object.

### 19.2 Inspector sections

Potential sections:

- Overview.
- Goal/contract.
- Current state.
- Environment/checkout.
- Artifacts.
- Sources.
- Child runs.
- Usage.
- Permissions/policy.
- Native runtime metadata.
- Audit trail.

Render only sections with content. The first three may be expanded; the rest are collapsed by default. Do not put primary approval actions in the Inspector because it may be closed.

### 19.3 Source primitive

A source row shows:

- title/domain or local document label;
- source type;
- fetched/read timestamp;
- scope used;
- link/open action;
- citation/use count;
- stale/error state.

Web sources open in safe preview or system browser. Local sources open in file/preview panes. A task export includes source URLs and captured metadata, not copyrighted full-page copies by default.

### 19.4 Artifact primitive

Artifact rows show:

- type glyph and name;
- producing run/user;
- path or storage location;
- created/updated time;
- verification or stale state;
- Open, Attach, Reveal, Export actions.

Artifacts group into Changed files, Screenshots/previews, Reports/handoffs, Build outputs, and Other. “Outputs” is not a catch-all label without types.

### 19.5 In-app notifications

Use three levels:

- **Inline:** local to the action/component; default for validation and recoverable errors.
- **Toast:** confirms a completed background action or offers brief Undo.
- **Attention center:** durable waiting/failure/result items across tasks.

Toasts never report long-running progress. They last 4–8 seconds depending on actionability, pause on hover/focus, and remain in the attention center if action is required.

### 19.6 OS notifications

Default notification events:

- approval required;
- user input required;
- local task failed while app unfocused;
- remote/local task completed while app unfocused;
- security/policy block;
- scheduled task result according to its policy.

Notifications include task and project, not sensitive prompt contents by default. Clicking deep-links to the exact attention event. Completion notifications group by project during bursts.

### 19.7 Global attention center

The attention center is a filtered list, not an activity feed. Each item has urgency, project/task, requesting run, age, concise request/outcome, and action. Resolving it updates every reference. Items do not duplicate if both a child and parent surface the same approval.

---

## 20. Visual foundation and component tokens

The visual system should feel premium because geometry, contrast, timing, and state are consistent—not because it uses blur, gradients, or oversized rounded cards.

### 20.1 Surface hierarchy

Use at most five perceivable surface levels:

| Token | Dark seed | Light seed | Role |
|---|---:|---:|---|
| `surface.canvas` | `#0D0F12` | `#F7F8FA` | main window background |
| `surface.rail` | `#111318` | `#F1F3F6` | navigation |
| `surface.layer1` | `#15181D` | `#FFFFFF` | composer, panes, selected content regions |
| `surface.layer2` | `#1A1E24` | `#F7F8FA` | menus, cards, nested controls |
| `surface.overlay` | `#20252C` | `#FFFFFF` | popovers, dialogs, floating inspector |

Seed values are starting points. Final values must meet contrast in native Windows/macOS rendering and under transparency fallback.

Never encode semantic status by swapping the entire surface to saturated color. Status uses a restrained icon/edge/tint within the neutral hierarchy.

### 20.2 Text roles

| Token | Dark seed | Light seed | Minimum use |
|---|---:|---:|---|
| `text.primary` | `#F1F3F5` | `#17191C` | body, selected labels |
| `text.secondary` | `#B5BAC2` | `#555B64` | metadata that remains important |
| `text.tertiary` | `#858C96` | `#717985` | timestamps, hints above 12 px |
| `text.disabled` | `#626973` | `#9AA1AA` | disabled only, never instructions |
| `text.inverse` | `#111318` | `#FFFFFF` | contrast controls |
| `text.link` | `#7EB0FF` | `#215FB7` | links/actions |

Body text targets WCAG AA. Tertiary text is never smaller than 12 px and is not the only carrier of state.

### 20.3 Borders and dividers

| Token | Dark | Light | Use |
|---|---:|---:|---|
| `border.subtle` | white 7% | black 7% | region separation |
| `border.base` | white 11% | black 11% | controls/cards |
| `border.strong` | white 18% | black 20% | selected/important boundaries |
| `border.focus` | `#6EA8FF` | `#2169D5` | focus only |
| `border.danger` | `#E06B75` | `#B4232F` | destructive/error |

Hairlines may render at 0.5 device-independent pixels only where the platform/rendering stack guarantees stable snapping. Otherwise use 1 px at low contrast.

### 20.4 Semantic status colors

| State | Foreground | Background tint | Shape requirement |
|---|---|---|---|
| Accent/active | blue | 8–12% | none |
| Success/verified | green | 8–10% | check |
| Warning/waiting | amber | 8–12% | diamond or triangle |
| Error/failed | red | 8–12% | octagon/error glyph |
| Info/remote | cyan | 8–10% | circle/info glyph |
| Plan | muted cyan/blue | <= 8% | plan/document glyph |
| Review | muted green | <= 8% | review glyph |

Agent roles may use muted semantic accents in detailed views, but runtime brands never own success/error colors.

### 20.5 Typography

Font stacks:

- Windows UI: `Segoe UI Variable`, `Segoe UI`, system sans.
- macOS UI: `SF Pro Text`, system sans.
- Cross-platform fallback: `Inter`, system sans.
- Code: `Cascadia Code` on Windows, `SF Mono` on macOS, then project/user preferred monospace.

| Token | Size / line | Weight | Use |
|---|---:|---:|---|
| `type.caption` | 11 / 16 | 500 | compact labels, only when contrast permits |
| `type.meta` | 12 / 17 | 400–500 | timestamps, chips, secondary rows |
| `type.control` | 13 / 18 | 500 | buttons, sidebar rows, tabs |
| `type.body` | 14 / 21 | 400 | transcript and settings |
| `type.bodyLarge` | 15 / 23 | 400 | long-form final responses |
| `type.subtitle` | 16 / 22 | 600 | pane/document titles |
| `type.title` | 20 / 26 | 600 | empty/project overview only |
| `type.hero` | 28 / 34 | 600 | rare onboarding; never active task UI |

Avoid all-caps section headers in dense rails. Use sentence case and weight/spacing hierarchy.

### 20.6 Spacing

Base grid is 4 px; 2 px is permitted for optical adjustment.

| Token | Value | Typical use |
|---|---:|---|
| `space.0` | 0 | reset |
| `space.0_5` | 2 px | optical/icon alignment |
| `space.1` | 4 px | tight internal gap |
| `space.1_5` | 6 px | compact icon/text |
| `space.2` | 8 px | row/card internals |
| `space.3` | 12 px | control groups |
| `space.4` | 16 px | component padding |
| `space.5` | 20 px | transcript group separation |
| `space.6` | 24 px | pane/canvas inset |
| `space.8` | 32 px | section separation |
| `space.12` | 48 px | empty-state structure |

Repeated row spacing must use tokens; optical exceptions get comments and visual tests.

### 20.7 Radii

| Token | Value | Use |
|---|---:|---|
| `radius.1` | 4 px | tiny buttons, status pills |
| `radius.2` | 6 px | rows, inputs, tabs |
| `radius.3` | 10 px | menus, cards, docks |
| `radius.4` | 14 px | panes, expanded cards |
| `radius.5` | 16 px | composer/dialog |
| `radius.pill` | 999 px | true pills only: compact filters/status |

Not every rectangle is a pill. Sidebar selection uses 6–8 px, not a full capsule, unless the platform shell specifically calls for it.

The default visual preset uses soft 8–12 px radii for interactive surfaces, composer, menus, terminal, and review panes. Users may select sharper or softer radius presets; transcript paragraphs and routine activity rows remain open surfaces rather than cards.

### 20.8 Elevation

Prefer borders and surface contrast over shadow. Use four levels:

- Level 0: flat canvas/rail.
- Level 1: raised composer or contained pane; 0.5–1 px edge plus subtle 1–2 px shadow.
- Level 2: popover/menu; 8–16 px soft shadow plus edge.
- Level 3: modal/dragged pane; 16–32 px shadow plus scrim.

Dark shadows use sufficient opacity to separate, but an upper light edge prevents muddy floating panels. Do not apply shadow to every activity card.

### 20.9 Icons

- Base optical size: 16 px; primary toolbar: 18 px; empty state: 24 px maximum.
- Stroke family must be consistent within a surface.
- Filled variants indicate selected/active only where the icon set supports it cleanly.
- Provider logos are never substitutes for action icons.
- Icon-only controls have tooltip, accessible name, and at least 28 × 28 px hit target; 32 × 32 preferred.
- Destructive actions pair icon with text in menus/dialogs.
- Windows and macOS may use platform-native glyphs for window/sidebar/toolbar concepts while preserving semantics.

### 20.10 Density modes

Support Comfortable and Compact globally; allow transcript density separately.

| Primitive | Comfortable | Compact |
|---|---:|---:|
| Sidebar row | 36 px | 30–32 px |
| Toolbar/control | 32–36 px | 28–30 px |
| Transcript gap | 20 px | 14–16 px |
| Pane tab | 36 px | 30 px |
| Activity row | 30–34 px | 26–30 px |

Density changes geometry, not font contrast or hit-target accessibility. Touch/pen contexts force minimum targets regardless of compact mode.

### 20.11 Transparency and materials

macOS may use a restrained native sidebar material. Windows may use Mica/Acrylic only when supported and stable. Requirements:

- transparency is decorative and optional;
- high contrast and battery saver can disable it;
- every translucent surface has a tested opaque token mapping;
- text contrast is measured against worst-case composited background;
- hover action fades do not expose mismatched opaque rectangles;
- no blur behind streaming transcript content;
- user can disable transparency independently of reduced motion.

---

## 21. Motion and animation choreography

Motion communicates causality, location, and status. It does not simulate intelligence or decorate waiting. Fluent recommends short, focused motion and a no-motion option; animations should stay constrained to the element in focus. `O` [Fluent Motion](https://fluent2.microsoft.design/motion)

### 21.1 Motion principles

- **Causal:** movement begins where the action occurred and ends where the result lives.
- **Local:** do not animate unrelated regions.
- **Interruptible:** controls respond during motion; a new action can reverse it.
- **Stable:** no layout shift for streaming, hover, status, or icon changes.
- **Sparse:** one focal transition per user action.
- **Honest:** activity motion represents an observed active state, not hidden thought.
- **Compositor-safe:** use opacity and transform; animate layout only for small contained disclosures.
- **Accessible:** reduced motion is equivalent, not degraded.

### 21.2 Duration tokens

| Token | Value | Use |
|---|---:|---|
| `motion.none` | 0 ms | focus, critical state, reduced-motion replacement |
| `motion.press` | 70 ms | pressed feedback |
| `motion.hover` | 100 ms | hover color/action reveal |
| `motion.select` | 120 ms | row/tab selection tint |
| `motion.popover` | 150 ms | menu/tooltip/popover enter |
| `motion.disclosure` | 180 ms | small accordion/queue/dock |
| `motion.pane` | 220 ms | pane/rail open-close |
| `motion.layout` | 280 ms | preset transition, grid reflow after explicit action |
| `motion.milestone` | 360 ms | one-time onboarding/completion illustration only |

Exits use 70–80% of entrance duration. User-driven resize and drag have no smoothing delay.

### 21.3 Easing tokens

| Token | Curve | Use |
|---|---|---|
| `ease.standard` | `cubic-bezier(.2, 0, 0, 1)` | most enters/layout |
| `ease.exit` | `cubic-bezier(.4, 0, 1, 1)` | exits |
| `ease.emphasized` | `cubic-bezier(.2, .8, .2, 1)` | small focal movement |
| `ease.linear` | linear | progress rotation only |

Spring motion is allowed for direct-manipulation settling only, with no overshoot above 2 px. Do not use bouncy springs for panels, messages, or approvals.

### 21.4 Shell motion matrix

| Primitive | Trigger | Animation | Reduced motion |
|---|---|---|---|
| Rail open | command/click | translate from leading edge + opacity, 220 ms | instant |
| Rail close | command/click | translate 12 px toward edge + opacity, 160 ms | instant |
| Rail auto-collapse | window crosses threshold | same as close after layout stabilizes | instant |
| Pane open from path/event | select artifact | 8 px source-direction translate + opacity, 220 ms | instant; focus moves |
| Pane close | close | 6 px toward source + opacity, 160 ms | instant |
| Inspector follow-selection | select event | content crossfade 100 ms; shell stays fixed | instant replace |
| Layout preset | explicit preset | shared dividers interpolate, 280 ms | instant |
| Resize drag | pointer/keyboard | none during drag; optional 100 ms snap only at reset | instant |
| New window | command | OS-native | OS-native |

Never animate the full transcript sideways when opening a pane if that would cause text reflow throughout the visible history. Fix the primary column measure, reveal the pane from reserved/remaining space, then reflow only at the final breakpoint when necessary.

### 21.5 Navigation motion matrix

| Primitive | Animation |
|---|---|
| Row hover | background color 100 ms; actions opacity 100 ms; no translation |
| Row select | surface/border color 120 ms; focus ring is immediate |
| Project disclosure | chevron rotate 120 ms; children clip/opacity 180 ms |
| New task row | insert at source position with 4 px vertical settle, 180 ms |
| Archive row | opacity 120 ms, then height collapse 160 ms; no animation during bulk archive |
| Unread arrival | one 120 ms tint transition; no pulse |
| Attention promotion | section appears with clipped height 180 ms; row does not fly between sections |
| Search results | crossfade list 100 ms; selection remains stable |
| Rename | label/input crossfade 70 ms; width fixed |
| Drag reorder | direct movement; neighbors translate; settle <= 180 ms |

When many task statuses update simultaneously, update colors/icons in place without per-row animations.

### 21.6 Composer motion matrix

| Primitive | Animation |
|---|---|
| Focus | border/focus ring immediate; shadow 100 ms |
| Grow one line | height follows content without spring, <= 100 ms; disable during rapid typing |
| Expand editor | shared composer-to-sheet transform, 220 ms if stable |
| Context chip add | opacity + 4 px scale/translate, 150 ms |
| Context chip remove | opacity 100 ms; shelf closes after exit |
| Setup strip | clip from composer edge + opacity, 180 ms |
| Slash/@ menu | scale from 98% + opacity, 150 ms |
| Profile label change | text crossfade 100 ms; control width fixed during transition |
| Send | button press 70 ms; user message appears without flying bubble |
| Send → Stop | glyph path/crossfade 120 ms; hit target fixed |
| Queue shelf open | clipped height + opacity, 180 ms |
| Approval dock | clipped height + 4 px upward settle, 180 ms |
| Validation error | border/tint immediate; no shake |

Do not animate composer position when the transcript receives content. Do not recolor it with the active provider.

### 21.7 Transcript motion matrix

| Primitive | Animation |
|---|---|
| User turn committed | 4 px upward settle + opacity, 150 ms once |
| Streaming text | no entrance per chunk |
| New activity row | opacity 100 ms; only if currently following |
| Activity group collapse | height/clip 180 ms; preserve scroll anchor |
| Tool status change | icon crossfade 100 ms; text stable |
| New-events button | opacity + 4 px rise, 150 ms |
| Sticky request | opacity 120 ms; no slide across content |
| Final response | section opacity 150 ms; no celebration by default |
| Search match navigation | one 180 ms background highlight fade |
| Retry replacement | old outcome remains; new run segment enters normally |

The transcript must remain readable at 60 Hz while activity streams. If animation competes with ingestion, animation loses.

### 21.8 Agent and activity motion matrix

| Primitive | Animation |
|---|---|
| Active indicator | 1 rotation / 1.2 s only on selected/current item; static elsewhere |
| Waiting approval | no pulse; state icon/tint change 120 ms |
| Child starts | card opacity + 4 px settle, 180 ms |
| Child completes | icon/text crossfade 120 ms; card stays in place |
| Grid explicit sort | cards translate to new positions, 280 ms |
| Grid live updates | no reorder or continuous motion |
| Side-question peek | opacity + 6 px from anchor, 150 ms |
| Candidate selected | border/tint 120 ms |
| Stop requested | progress indicator becomes static stopping state after one clear transition |

### 21.9 Review, file, terminal, and preview motion

- Diff scope change: crossfade 120 ms after content is ready; keep header/file tree stable.
- Diff hunk expand: clipped height 180 ms while maintaining anchor.
- Inline comment open: 4 px expansion 150 ms; focus moves immediately.
- File tab select: underline/tint 100 ms; content crossfade only if load exceeds one frame.
- File external-change warning: bar clips in 180 ms; no shake.
- Terminal tab activity: icon/state crossfade; terminal text never animates.
- Terminal panel open: 220 ms from bottom; terminal resizes after final geometry or in throttled steps.
- Preview viewport change: direct resize with a 150 ms settle only after choosing a preset, not during drag.
- Design selection: outline appears immediately; label opacity 100 ms.
- Screenshot captured: local 100 ms shutter tint confined to preview; no full-window flash.

### 21.10 Toasts, dialogs, and errors

- Toast enters 8 px from its edge + opacity, 180 ms; exits 120 ms.
- Modal scrim fades 150 ms; dialog scales 98% to 100% and fades 180 ms.
- Confirmation focus is available immediately.
- Errors do not shake, flash, or repeatedly pulse.
- Undo toast's countdown is not an animated draining bar unless the user can pause it and reduced motion disables it.
- Success check motion is optional and used only for explicit user-triggered milestones, not every command.

### 21.11 No-motion zones

Never animate:

- focus rings;
- password/secret fields;
- terminal output lines;
- code caret or text selection beyond native behavior;
- live diff line changes during typing;
- numeric usage count-up;
- background task rows continuously;
- provider logos;
- warnings repeatedly;
- every token or “thinking” word;
- scroll position without direct navigation intent;
- pane resize under pointer;
- recovery/restored state before it is trustworthy.

### 21.12 Reduced motion mapping

When OS reduced motion or app No motion is active:

- all transforms become instant state changes;
- opacity transitions are <= 80 ms or instant;
- spinners become static progress glyphs plus text/elapsed time;
- layout/pane/disclosure changes are instant;
- scrolling uses `auto`, not smooth;
- design selection and focus remain immediate;
- no information relies on animation order, direction, or repetition;
- video/preview autoplay is disabled unless explicitly started.

### 21.13 Motion performance contract

- Target 60 fps; 120 fps on capable displays is welcome but not required.
- Animate compositor properties only except contained disclosure height.
- No `transition: all` in production components.
- A motion token and property allowlist are required for every animation.
- Cancel stale transitions on task switch and window resize.
- Limit simultaneous non-progress animations to three; bulk updates become instant.
- Disable decorative motion automatically during renderer stress, remote desktop, battery saver, or software rendering.
- Visual regression tests capture pre, mid, and post state for pane, composer, disclosure, and modal transitions.

---

## 22. Input, keyboard, and accessibility contract

Accessibility is part of the component API. Fluent's current foundation targets WCAG 2.1 AA and emphasizes clear hierarchy and predictable navigation. `O` [Fluent accessibility](https://fluent2.microsoft.design/accessibility)

### 22.1 Landmarks and document structure

Expose stable landmarks:

- Application navigation.
- Task header.
- Task transcript/log.
- Composer.
- Work pane.
- Utility panel.
- Inspector.
- Attention center.

Only one main landmark exists per window. Pane headings are real headings in logical order. Transcript turns are grouped articles or list items with accessible labels; raw tool fragments are not hundreds of undifferentiated live nodes.

### 22.2 Focus model

- Focus order follows visual order within each region.
- `F6` cycles major regions forward; `Shift+F6` reverses.
- Opening a modal traps focus; closing restores the invoking control.
- Opening a pane from a file/event focuses the pane heading or requested line according to intent.
- Closing a pane restores focus to the source event/path when it still exists; otherwise the task canvas.
- Task switching restores the last focused region and semantic item per task, unless the switch was caused by an attention deep-link.
- Focus is never moved merely because new streaming content arrived.
- Focus rings appear immediately and survive selected/hover/error states.

### 22.3 Default keyboard map

| Shortcut | Windows | macOS | Action |
|---|---|---|---|
| New task | `Ctrl+N` | `Cmd+N` | new task in current context |
| Open folder | `Ctrl+O` | `Cmd+O` | open local root/project |
| Global commands | `Ctrl+K` | `Cmd+K` | command palette |
| Find task/project | `Ctrl+G` | `Cmd+G` | global search |
| In-view find | `Ctrl+F` | `Cmd+F` | transcript/file/diff/terminal search |
| Toggle rail | `Ctrl+Shift+L` | `Cmd+Shift+L` | navigation rail |
| Toggle review | `Ctrl+Shift+D` | `Cmd+Shift+D` | diff/review pane |
| Toggle preview | `Ctrl+Shift+P` | `Cmd+Shift+P` | preview pane; avoid conflict through remapping if OS/app reserves it |
| Toggle terminal | `Ctrl` + backtick | `Ctrl` + backtick | utility terminal |
| Toggle Inspector | `Ctrl+Shift+I` | `Cmd+Shift+I` | Inspector |
| Focus composer | `Ctrl+L` | `Cmd+L` | composer, unless preview Design Mode owns the chord |
| Expanded composer | `Ctrl+Shift+Enter` | `Cmd+Shift+Enter` | expand/collapse draft editor |
| Stop run | `Esc` twice or explicit mapped command | same | first Escape dismisses overlays, second requests stop with status feedback |
| Next/previous task | `Ctrl+Tab` / `Ctrl+Shift+Tab` | same | task history order |
| Cycle transcript density | `Ctrl+Alt+O` | `Ctrl+Option+O` | Summary/Normal/Verbose/Raw diagnostics |
| Cycle panes | `Alt+F6` | `Option+F6` | open panes |

Every shortcut is discoverable, searchable, remappable, and conflict-checked. Display platform-correct glyphs/text.

### 22.4 Composite widgets

- Sidebar and file trees use tree semantics with arrow-key navigation.
- Tabs use roving `tabindex`, Left/Right navigation, Home/End, and a close command.
- Menus use Up/Down, typeahead, submenu delay, Escape, and return focus.
- Grids expose row/column names and an alternate list view.
- Diff lines provide line-range navigation without requiring pointer gutters.
- Resizers are focusable separators with `aria-valuenow/min/max` and keyboard increments.
- Drag-and-drop has Move to… menus and keyboard reorder commands.
- Tooltips never contain required interactive content.

### 22.5 Screen-reader live regions

Use separate, throttled channels:

- **Polite task status:** phase changes such as `Tests started`, `Approval required`, `Run completed`.
- **Assertive safety:** destructive approval, security block, connection loss affecting control.
- **Resize feedback:** pane percentage after keyboard adjustment.
- **Queue feedback:** message queued, steering delivered, cancellation reconciled.

Do not announce streaming tokens, elapsed seconds, spinner changes, or every tool event. Batch repetitive activity: `Read 8 more files`.

### 22.6 Zoom and reflow

- Support 80–200% application zoom; 100–400% text zoom where platform/runtime permits.
- At 200%, all core actions remain available without two-dimensional page scrolling.
- Regions reflow according to effective CSS/device-independent width.
- Fixed heights become minimums; text may wrap.
- Composer controls collapse into labeled overflow before overlapping.
- Popovers remain inside the viewport and can become sheets on narrow widths.
- Code/diffs may scroll horizontally inside their own semantic viewport.

### 22.7 Contrast and color independence

- Normal text: 4.5:1 minimum; large text: 3:1.
- Interactive component boundaries and focus: 3:1 against adjacent colors.
- Addition/deletion, running/waiting/error, selected/focused, and read/unread differ by shape, label, weight, or border as well as hue.
- High-contrast mode uses OS/system colors where possible and removes low-opacity tints.
- Transparency, subtle shadow, and gradient fades are disabled in forced-colors mode.

### 22.8 Motor and pointer accessibility

- Primary pointer targets are at least 32 × 32 px desktop; destructive or mobile targets 40–44 px.
- Tiny visible icons may sit inside larger hit targets.
- Hover-only actions are duplicated in row menus and keyboard commands.
- No precision drag is required; pane presets and Move to… menus are equivalents.
- Double-click shortcuts always have a single-click/menu alternative.
- Time-limited approvals warn and can be extended where the runtime allows.

### 22.9 Language, IME, and bidirectionality

- Composer and inline edit controls are tested with Chinese, Japanese, Korean, dead keys, emoji, dictation, and paste.
- Submit is disabled during active composition.
- Path/code fragments remain left-to-right inside RTL UI.
- Leading/trailing icons mirror only when meaning is directional.
- Dates, durations, numbers, and shortcuts localize.
- Runtime-native text may remain untranslated but its UI framing is localized.
- Truncation algorithms do not split grapheme clusters.

### 22.10 Cognitive accessibility

- Use stable nouns and verbs.
- Put one primary action in an empty/error state.
- Show consequences before destructive actions.
- Preserve drafts and user position.
- Avoid rotating placeholder tips, auto-advancing tours, and celebratory interruptions.
- Use plain status text alongside technical details.
- Keep provider/runtime complexity behind progressive disclosure.

---

## 23. Windows and macOS platform behavior

The product shares information architecture and semantics while respecting platform conventions. It should not look like a web page wearing different window buttons.

### 23.1 Windows

- Use a custom title bar only if drag regions, Snap Layouts, system menu, accessibility, and high contrast remain correct.
- Preserve standard minimize, maximize/restore, close targets and Windows 11 spacing.
- Mica/Acrylic is optional; provide opaque fallback and software-rendering mode.
- Menus use Windows ordering and `Ctrl` labels.
- Folder paths display backslashes in native path details; relative code paths may use repository convention.
- Reveal action is `Show in File Explorer`.
- Default code font is Cascadia Code when available.
- Shell choices are explicit: PowerShell, Command Prompt, Git Bash, WSL.
- Native Windows and WSL environments show distinct badges and path mappings.
- Drag/drop handles files from Explorer and Unicode/long paths.
- Test multiple scaling factors, mixed-DPI displays, remote desktop, integrated/discrete GPU switching, and high contrast.
- Taskbar progress is reserved for determinate setup such as clone/download; approvals use badges/notifications, not progress bars.

### 23.2 macOS

- Respect traffic-light placement and title-bar safe area.
- Use `Cmd` for application commands; retain Ctrl + backtick where terminal convention warrants it.
- Reveal action is `Show in Finder`.
- Use native sheets only for window-scoped blocking choices; most approvals remain inline in the task.
- Sidebar material may follow macOS appearance and accent, but project/runtime icons remain semantically clear.
- Full-screen and Split View transitions use OS behavior.
- Services, Share, Open With, Quick Look, and standard text editing shortcuts should work where applicable.
- Request Accessibility, Screen Recording, and other OS permissions at the moment of need with preflight explanation.
- Test Intel/Apple Silicon where supported, Retina/non-Retina external displays, Stage Manager, and reduced transparency.

### 23.3 Shared cross-platform rules

- Task/project identity, transcript structure, permissions, review semantics, and adapter capabilities do not change by OS.
- Shortcut display, title bar, menus, materials, file terminology, shell options, and system permissions do change.
- Deep links open the same semantic object.
- A project moved between platforms can keep portable task metadata while local roots are reattached explicitly.
- Do not normalize Windows and macOS paths into the same local project solely because a remote URL matches.

---

## 24. Performance, resilience, and state recovery

Smoothness is primarily the absence of dropped input, layout shift, and state mismatch.

### 24.1 Performance budgets

| Interaction | Target |
|---|---:|
| Window first useful frame, warm | <= 700 ms |
| Window first useful frame, cold | <= 1.8 s on supported baseline |
| Composer keystroke to paint | p95 <= 16 ms, p99 <= 32 ms |
| Row hover/focus response | <= 50 ms perceived |
| Task switch to cached frame | <= 100 ms |
| Task switch requiring load | skeleton/status <= 100 ms; content progressively |
| Command palette open | <= 100 ms |
| Local search first results | <= 150 ms |
| Streaming event to visible update | <= 100 ms while following |
| Scroll frame | 60 fps target with no long task > 50 ms |
| Stop-control acknowledgement | <= 100 ms local UI; backend confirmation separately timed |

### 24.2 Renderer isolation

- Adapter/process I/O runs outside the UI renderer.
- Markdown, syntax highlighting, diff parsing, search indexing, image decoding, and large JSON shaping use workers/background services.
- Terminal rendering is isolated from transcript rendering.
- One malformed native event cannot crash the task canvas; render a diagnostic error boundary.
- A runaway pane or preview can be reloaded independently.
- GPU acceleration has a user-visible fallback and automatic safe-mode prompt after repeated renderer crashes.

### 24.3 Event ingestion and backpressure

- Append normalized events to durable storage before or alongside UI projection according to transaction guarantees.
- Batch high-frequency tool/output chunks.
- Bound in-memory queues and spill process logs to disk.
- Preserve lifecycle, approval, error, and completion events ahead of low-value output under pressure.
- Record dropped/coalesced diagnostic counts.
- Rebuild the transcript projection from durable events after renderer restart.
- Do not block process supervision on transcript rendering.

### 24.4 State layers

| Layer | Examples | Lifetime |
|---|---|---|
| Durable task state | goal, turns, runs, evidence, queue, draft | until user deletes |
| Durable workspace state | projects, aliases, layouts, preferences | until user changes/removes |
| Recoverable view state | scroll anchor, open tabs, selected file, density | session plus restart |
| Ephemeral interaction | hover, open tooltip, drag preview | current frame/action |
| Native runtime state | process/session ids, capabilities | reconciled, never sole source of truth |

Do not persist ephemeral hover/focus artifacts. Do not make native session history the only durable task record.

### 24.5 Restart recovery

On restart:

1. Restore window shell and cached task frame.
2. Mark previously active runs `Reconnecting` or `Recovering`, not `Running` without evidence.
3. Reattach to supervised processes/app servers where possible.
4. Query native session/turn state.
5. Reconcile approvals, queue entries, process state, and completion.
6. Restore semantic scroll/focus anchors.
7. Surface mismatches with actions.

Possible reconciliation outcomes:

- Reattached and active.
- Native run completed while app was closed.
- Native session resumable but no active run.
- Process exists but structured connection is lost.
- Session missing; Integrator record retained.
- State ambiguous; offer diagnostics, resume/fork, or stop process.

### 24.6 Stuck-state protection

UI state and backend state are distinct:

- `activitySubscriptionState`.
- `nativeTurnState`.
- `processState`.
- `controlChannelState`.

If activity updates stop but the process lives, show `Activity stream interrupted` with elapsed since last event and Reconnect/Open terminal/Stop. Never leave a permanent unqualified `Thinking…` state. Stop remains available through any confirmed control path.

### 24.7 Offline and remote behavior

- Local drafts, history, diffs, and cached artifacts remain readable offline.
- Remote tasks show last sync time and connection state.
- Steering queued while offline is labeled local pending and requires confirmation if task state changed before reconnect.
- Never claim a remote stop succeeded until acknowledged.
- Conflicting edits to task title/notes merge field-wise; conflicting prompts are never auto-sent.

### 24.8 Storage and retention

- Store task metadata in a transactional local database.
- Store large logs/artifacts in content-addressed files with references.
- Encrypt sensitive metadata at rest where platform facilities permit.
- Redact before persistence, not merely at display time.
- Make retention configurable by artifact/log class.
- Cleanup reports reclaimable size and affected tasks before deletion.
- Exports omit credentials, secure inputs, hidden policy data, and raw environment values.

---

## 25. Loading, empty, error, and microcopy primitives

### 25.1 Loading states

Use the least disruptive representation:

- Under 150 ms: no indicator.
- 150–800 ms: local static/small progress indicator in the affected region.
- Over 800 ms: short status text and elapsed only if useful.
- Determinate setup: progress bar with stage and cancel when supported.
- Unknown long work: current observable phase, not a fake percentage.

Skeletons are for stable known layouts such as task rows or file metadata. Do not skeletonize streaming prose or terminal output.

### 25.2 Empty states

Every empty state answers:

1. What is this surface?
2. Why is it empty?
3. What is the one most useful action?

Examples:

- No tasks: `Start with an outcome. Choose a folder only when the work needs one.` + focused composer.
- Empty project: `No tasks in this project yet.` + New task.
- No changes: `No changes in this review scope.` + Change scope.
- No child runs: `No delegated work in this task.` No promotional button.
- No search results: echo query and active filters; Clear filters.

### 25.3 Error anatomy

An actionable error contains:

- plain-language title;
- affected object/action;
- known cause or `Cause not yet known`;
- whether work/draft/state is safe;
- primary recovery action;
- secondary diagnostics/copy details;
- stable error id for support.

Example:

> **Codex activity stream disconnected**  
> The local process is still running, but new structured events have not arrived for 38 seconds. Your task and draft are safe.  
> `Reconnect` · `Open terminal` · `Stop process` · `Copy diagnostics`

### 25.4 Unknown, none, zero, and stale

- `0` means measured zero.
- `None` means the concept is applicable and empty.
- `Not exposed` means provider does not supply it.
- `Unavailable` means capability cannot be used now.
- `Unknown` means expected state could not be determined.
- `Stale` means a previously known value may no longer be current and includes last-updated time.

Never display `0 tokens`, `No usage`, or `Complete` when the real state is unknown.

### 25.5 Verb rules

Use verbs by actual effect:

- Open: reveal existing object/view.
- Start: initiate execution.
- Create: make durable object.
- Add/Attach: associate context without moving/deleting source.
- Clone: create local Git copy.
- Continue: preserve task/native context as described.
- Retry: repeat failed operation with preview if inputs changed.
- Resume: continue paused/stopped resumable session.
- Stop: request/confirm execution termination.
- Cancel: abandon pending UI/setup operation.
- Archive: hide but preserve.
- Remove: detach from Integrator or collection.
- Delete: destroy named data.
- Discard/Revert: destructive content change with explicit scope.

### 25.6 Time language

- Running: elapsed updates at 1 s only in detailed active view, 5–10 s elsewhere.
- Completed: `Finished in 2m 24s`; tooltip shows timestamps.
- Waiting: separate active and waiting durations when known.
- Relative dates become absolute in tooltip/details.
- Do not use `just now` for security/audit records without timestamp access.

### 25.7 Confirmation rules

No confirmation for reversible, local, low-impact actions with Undo. Confirm when:

- deleting durable task/history;
- deleting dirty worktree or unpushed commits;
- discarding file/hunk changes without safe undo;
- granting broad permission or bypass mode;
- sending external messages/deploying/publishing;
- quitting while local processes require a decision;
- archiving a task with uncommitted isolated work when archive affects cleanup.

Confirmation copy names the object and consequence. Avoid `Are you sure?` without context.

---

## 26. Core component contract matrix

Every implementation story must specify state, keyboard, persistence, capability fallback, telemetry, and tests. This table is the minimum inventory.

| Component | Required states | Persistent state | Capability fallback | Critical tests |
|---|---|---|---|---|
| Project row | rest/hover/focus/selected/expanded/attention/offline/rename | expand, pin, alias | local-only metadata | keyboard tree, truncation, path merge |
| Task row | draft/running/waiting/unread/failed/stopping/archived | title, pin, read, archive | Integrator record survives native loss | simultaneous states, focus, status reconciliation |
| Empty composer | no project/project/clone setup/offline | draft/context/profile | quick chat or raw task | IME, paste, switch/restart |
| Active composer | ready/running/queue/steer/approval/error | draft, queue, next profile | runtime-supported delivery only | race, cancel, stop, stale approval |
| Profile picker | loading/available/recommended/unavailable/stale | task/project override | hide unsupported axes | keyboard, why-Auto, mid-task switch |
| Permission picker | inherited/overridden/blocked/native mismatch | task snapshot | outer policy prevails | escalation, runtime bypass, screen reader |
| Transcript | loading/following/reading/restored/searching/diagnostic | density, anchor | raw framed events | 100k events, selection, new-event anchor |
| Activity group | pending/running/complete/warn/fail/collapsed | disclosure | generic runtime event | bulk stream, failure visibility |
| Approval dock | active/expired/answered/cancelled/orphaned | decision/audit, not secret | native text prompt if safe | double-submit, origin, expiry |
| Child card | queued/running/waiting/complete/failed/detached | title/scope/result | transcript-only child | grid stability, attention promotion |
| File pane | loading/clean/dirty/stale/conflict/missing/read-only | tab, cursor, scroll | open external | external edit, checkout switch |
| File tree | loading/indexed/filtering/offline/huge | width, disclosure | attach path manually | incremental load, keyboard, symlinks |
| Review pane | empty/loading/stale/partial/conflict/commenting | scope, layout, file, comments | external diff/raw patch | huge diff, binary, stale anchors |
| Terminal | starting/running/input/background/exited/lost | tabs, cwd, scroll where safe | raw process log | secret prompt, close running, reconnect |
| Preview | loading/live/disconnected/user-control/agent-control | route, viewport, scroll | open browser/file | takeover, screenshot, sensitive field |
| Plan pane | loading/clean/dirty/stale/revision | accepted revision | Markdown artifact | user edits, adapter projection |
| Inspector | task/selection/pinned/empty/stale | pinned anchor, sections | details dialog | selection churn, narrow window |
| Toast | info/success/warn/error/undo | none; durable action goes to attention | inline status | timing, hover pause, screen reader |
| Resizer | rest/hover/focus/drag/keyboard/min/max | clamped size | presets | double-click reset, ARIA announcement |
| Runtime card | detecting/login/ready/degraded/incompatible/error | executable/config reference | PTY/manual config | version drift, wrong config scope |
| Usage view | reported/observed/estimated/stale/not-exposed | filters only | hide unavailable metric | confidence labels, zero vs unknown |

### 26.1 Component implementation template

For every primitive, document:

```text
Purpose
Owning stable object
Anatomy
Variants
State machine
Inputs and events
Keyboard/focus behavior
Screen-reader behavior
Motion token and reduced-motion mapping
Persistence and restoration
Capability negotiation/fallback
Security/redaction
Performance budget
Analytics/telemetry with privacy review
Unit, integration, visual, accessibility, and stress tests
```

No component is implementation-ready with only a default-state mockup.

---

## 27. Anti-patterns and rejected design directions

### 27.1 Structural anti-patterns

- Provider tabs as the primary application architecture.
- A mandatory “agent mode” before entering a task.
- Separate disconnected histories for GUI, CLI, ACP, and editor bridge when identifiers can be linked.
- A single recent list pretending to be durable history.
- Remote URL as the only project identity.
- Child agents nested indefinitely in the navigation rail.
- Files, terminal, preview, diff, and plan rendered as oversized chat cards only.
- Pane layouts with no defaults, reset, or keyboard alternative.

### 27.2 Composer anti-patterns

- Six large dropdowns before the user can type.
- Provider-colored composer shells.
- Silent permission/profile changes.
- Long draft expanding until it covers the task.
- Ambiguous Enter behavior during IME composition.
- Steering and queued instructions treated as the same thing.
- Stop control disappearing when the activity stream breaks.
- Login/setup that destroys the draft.

### 27.3 Transcript anti-patterns

- Raw tool events as equal-weight messages.
- Decorative chain-of-thought simulations.
- Token-by-token cursor theater.
- Auto-scroll that fights a user reading earlier content.
- Collapsing failures inside a successful activity summary.
- Giant user speech bubbles for assignment contracts.
- Unbounded DOM histories.
- Hidden scrollbars in every nested region.

### 27.4 Visual anti-patterns

- Constant glass/blur behind fast-changing content.
- Low-contrast tiny gray text as the only state carrier.
- Pills for every control and card for every row.
- Multiple accent colors competing with semantic status.
- Provider logos used as action/state icons.
- Hover translation on dense rows.
- `transition: all`.
- Pulsing running rows or blinking approvals.
- Celebration motion for routine completions.

### 27.5 Trust anti-patterns

- Showing estimated usage as provider-reported.
- Saying “stopped” after merely sending cancel.
- Saying “complete” without required evidence.
- Hiding the checkout/worktree that will be edited.
- Deleting worktree/branch as a side effect of archive.
- Showing structured controls a PTY adapter cannot enforce.
- Copying ignored secret files into worktrees without explicit project policy.
- Rewriting native output into a stronger claim.

---

## 28. Product evolution and the durable lessons

This timeline matters because the products are converging on similar primitives from different starting points. AI Integrator should capture the durable convergence, not the latest arrangement of controls.

### 28.1 Codex evolution

| Period | Product shift | UI implication |
|---|---|---|
| May 2025 | Repository/branch selected before an isolated cloud task; results emphasized terminal evidence, tests, patches, and PRs | Isolation and evidence preceded desktop polish; task was already more than chat |
| Feb–Mar 2026 | Dedicated desktop app became a command center for parallel agents, project-grouped threads, worktrees, review, skills, and automations; Windows followed | Navigation became supervision; worktree and current state needed persistent visibility |
| Apr 2026 | Standalone tasks allowed intent before folder/project selection | New task should be primary; location can resolve inline when required |
| May–Jun 2026 | Goals, app/browser context, SSH, scheduled work, richer previews, remote continuity, memories, and subagent visibility expanded the task object | Goal, environment, policy, evidence, and continuity need stable primitives |
| Jul 9 2026 | Codex experience moved into the unified ChatGPT desktop app while retaining a dedicated coding surface; multi-repo projects, inline diff editing, and PR review side panel were highlighted | A coding workspace can coexist with general chat/work without sharing one undifferentiated history or mode |

Sources: `O` [Codex announcement](https://openai.com/index/introducing-codex/), [Codex app](https://openai.com/index/introducing-the-codex-app/), [What's new](https://learn.chatgpt.com/docs/whats-new#use-codex-in-the-chatgpt-desktop-app), [Projects](https://learn.chatgpt.com/docs/projects)

**Durable direction:** task-first shell, project optional at entry, evidence and review native to the task, coding surface coexisting with general conversation, and explicit continuity across environments.

### 28.2 Claude Code evolution

| Period | Product shift | UI implication |
|---|---|---|
| Terminal-first foundation | Permissions, project memory, skills, hooks, MCP, commands, subagents, and local session history lived in a CLI | GUI must preserve native configuration and power rather than invent a thinner agent |
| Early Desktop Code surface | Same engine exposed in a visual session manager with worktree isolation and diff review | Session list and visual review became first-class, but CLI/Desktop history boundaries surfaced |
| Apr 14 2026 redesign | Sidebar redesigned for parallel work; panes became draggable; terminal and file editor were integrated | Agent workbench is spatial and artifact-based, not only conversational |
| Apr–May 2026 hardening | Multi-tab terminal, session-management tools, queue fixes, persistent permission choices, PR stack, archive/quit safety, and recovery fixes | Premium quality lives in queue, session, dirty-state, and recovery details |
| Current Desktop | Chat, diff, preview, terminal, file, plan, tasks, subagent; side chats; Normal/Verbose/Summary; local/SSH/cloud; Dispatch and PR monitoring | Typed panes, density modes, background tasks, side questions, and environment choice are now baseline concepts |

Sources: `O` [Claude Desktop guide](https://code.claude.com/docs/en/desktop), [Desktop redesign](https://claude.com/blog/claude-code-desktop-redesign), [Desktop changelog](https://code.claude.com/docs/en/desktop-changelog), [Worktrees](https://code.claude.com/docs/en/worktrees)

**Durable direction:** GUI and CLI share engine/config, parallel sessions require isolation, transcript density is user-controlled, and background agents/processes need their own pane and attention model.

### 28.3 Cursor evolution

| Period | Product shift | UI implication |
|---|---|---|
| Editor assistant/Composer | Agent interaction was close to files and manual editing | Code adjacency and precise file/diff navigation remain valuable |
| Unified foreground/background agent sidebar | Local and background work moved toward one supervision surface | Agent state should be unified without hiding execution location |
| Cursor 3.0, Apr 2 2026 | Separate Agents Window across local/worktree/cloud/SSH; Design Mode; agent grids; `/worktree`; `/best-of-n` | Dedicated supervision window can coexist with IDE; spatial feedback and candidate comparison are first-class |
| Cursor 3.1 and later | Persistent tiled layout, voice state, branch selector before launch, exact diff-to-file navigation, plan documents, async subagents, local/cloud handoff | Layout, branch, plan, voice, navigation, and handoff became durable primitives rather than one-off features |

Sources: `O` [Cursor 3.0](https://cursor.com/changelog/3-0), [Cursor changelog](https://cursor.com/changelog), [Review](https://docs.cursor.com/en/agent/review)

**Durable direction:** keep code one action away, allow an agent-first window without forcing it, expose branch before launch, treat plans as documents, and compare parallel candidates in isolated workspaces.

### 28.4 Open-source convergence

The inspected open-source clients independently converge on:

- virtualized, measured transcripts;
- durable draft and scroll state;
- typed approval/question/revert docks;
- explicit queues;
- resizable persisted panes;
- separate file/review/terminal surfaces;
- semantic event taxonomies;
- capability-driven adapters and ACP;
- light/dark semantic tokens;
- project/session grouping;
- worktree or workspace identity.

The convergence suggests these are infrastructure, not optional polish. The main opportunity is to integrate them into a calmer and more consistent object model.

---

## 29. Prototype and usability validation program

### 29.1 Prototype order

Build behavioral prototypes before high-fidelity skins:

1. Navigation identity/history and empty-task flow.
2. Composer growth, setup strip, profile/permission chips, queue/steer.
3. Virtual transcript with follow/read/restore anchors.
4. Pane open/resize/reset and file/diff navigation.
5. Approval, stop, disconnect, and restart reconciliation.
6. Child-run cards/grid and attention promotion.
7. Motion and platform material after geometry/state stabilizes.

### 29.2 Critical usability tasks

Recruit both IDE-heavy and agent-first users. Test whether they can:

1. Start a question without choosing a project.
2. Turn that draft into project work without losing text.
3. Clone a repository, see the destination/branch, and start safely.
4. Explain which checkout, runtime, model, and permissions the next turn will use.
5. Find a six-month-old task not visible in Recents.
6. Distinguish project, task, run, child, and quick chat.
7. Queue one message and steer another while work is running.
8. Read earlier content without auto-scroll fighting them.
9. Return to the exact unread result after switching tasks.
10. Open a referenced file, review a diff, comment, and return to the source event.
11. Stop a run and tell the difference between requested and confirmed stop.
12. Recover after a simulated activity-stream disconnect.
13. Compare two isolated candidate runs without confusing branches.
14. Archive a task without fearing code deletion.
15. Operate the workflow by keyboard and screen reader.

### 29.3 Stress fixtures

Every prototype build includes fixtures for:

- 250 projects and 20,000 tasks.
- Similar repository names and three clones of one remote.
- Windows drive, UNC, long-path, junction, and WSL roots.
- 100,000 normalized transcript events.
- 10 MB command output and a process that waits for input.
- 2,000-file diff, binary/image/PDF changes, rename, conflict, truncated diff.
- 16 concurrent child runs with burst completions.
- 20 queued/steering prompts with attachments.
- Offline remote task, expired approval, missing native session.
- 200% zoom, 400% text, forced colors, reduced motion, reduced transparency.
- 760 px, 1100 px, 1440 px, 1800 px widths and mixed-DPI monitors.
- GPU acceleration failure/software renderer.

### 29.4 Design QA matrix

For every core screen, capture:

- dark, light, high contrast;
- comfortable and compact density;
- rest, hover, keyboard focus, selected, disabled, error, loading;
- Windows opaque/Mica and macOS opaque/material;
- normal and reduced/no motion;
- 100%, 150%, and 200% zoom;
- English, long localized strings, RTL, and CJK;
- empty, typical, crowded, stale, disconnected, and restored data.

### 29.5 Success criteria

- 90% of target users correctly predict what New task, Open folder, Clone, and Quick chat do after one use.
- 90% can identify checkout/runtime/permission before send in under 10 seconds.
- No participant believes Archive deletes source work.
- No participant loses a draft during setup, login, task switch, or restart tests.
- Users reading earlier content are never auto-scrolled away.
- Keyboard users complete the P0 workflow without pointer or focus trap.
- Screen-reader announcements during a 60-second run remain understandable and below the defined event-rate budget.
- Composer input p95, task switch, and scroll budgets hold in stress fixtures.
- Reduced-motion users receive identical state information.

---

## 30. Implementation sequence and release gates

### 30.1 Foundation gate

Ship no polished motion before:

- canonical project/checkout/task identity is stable;
- task event model is typed and durable;
- draft, queue, scroll anchor, and layout persistence work;
- adapter capability negotiation works;
- focus/keyboard and token foundations exist;
- renderer can recover without losing task state.

### 30.2 P0 shell

- Application shell and platform title bars.
- Navigation/history/search.
- New task/open folder/clone/quick chat semantics.
- Composer with context, profile, permissions, draft preservation.
- Normal transcript with typed activities and robust scrolling.
- Approvals, questions, stop, reconnect.
- One file pane and one unified review pane.
- Runtime inventory/login/reduced-fidelity state.
- Opaque dark/light/high-contrast themes and reduced motion.

### 30.3 P1 workbench

- File tree and tabs.
- Split/unified review, comments, binary/rich diffs.
- Terminal panel and background process state.
- Plan/contract/completion ledger.
- Inspector with artifacts/sources/usage.
- Side questions.
- Child-run cards and attention center.
- Curated layout presets.

### 30.4 P2 orchestration

- Agent grid and candidate comparison.
- Preview/browser and design annotations.
- Multi-repo tasks.
- Local/remote/SSH handoff.
- Advanced Auto routing and local outcome signals.
- Movable panes/new windows.
- Voice/dictation where platform support is reliable.

### 30.5 Premium-feel release gate

The app is not premium-ready until:

- no hover changes row geometry;
- no streaming changes composer position;
- no task switch loses draft, selection, or reading position;
- no running state lacks an observable phase or honest unknown state;
- no destructive verb has ambiguous scope;
- no pane lacks keyboard resize/reset/close;
- no status depends on color or animation;
- no light/dark/platform surface exposes a transparency patch or focus-contrast failure;
- all core animations meet duration/property rules and disappear cleanly under reduced motion;
- stress fixtures remain interactive;
- Windows software rendering and macOS reduced transparency remain fully usable.

---

## 31. Decision summary

The recommended product shape is:

- A task-first desktop workbench with a resizable two-level project/task rail.
- One quiet primary transcript and a compact bottom composer.
- A plain-language context sentence instead of large provider/project/permission toggles.
- New task as the primary action; open folder, clone, quick chat, and import as alternate starts.
- Project overview when opening a project; no silent chat creation.
- Runtime/model/effort chosen through execution profiles as casually as reasoning effort, with deep inspectability.
- Capability-driven controls for Codex, Cursor, ACP agents, and reduced-fidelity CLIs.
- Files, diffs, plans, terminal, preview, sources, and agents as typed panes that appear progressively.
- Durable history, drafts, queues, scroll anchors, layouts, and recovery state.
- Structured child-run supervision and comparison without background animation noise.
- Restrained neutral surfaces, semantic state, small geometry, precise focus, and platform-aware materials.
- Motion concentrated at causal boundaries—panes, disclosures, queue/dock appearance, selection—not in streaming or “thinking.”
- Opaque, reduced-motion, high-contrast, keyboard, and screen-reader experiences treated as primary implementations.

---

## 32. Research sources

### 32.1 Codex / OpenAI

- [Codex in the ChatGPT desktop app — What's new](https://learn.chatgpt.com/docs/whats-new#use-codex-in-the-chatgpt-desktop-app)
- [Codex quickstart](https://learn.chatgpt.com/docs/quickstart)
- [Projects, chats, and tasks](https://learn.chatgpt.com/docs/projects)
- [Codex Windows app](https://learn.chatgpt.com/docs/windows/windows-app)
- [Code review](https://learn.chatgpt.com/docs/code-review)
- [Artifacts viewer](https://learn.chatgpt.com/docs/artifacts-viewer)
- [Commands and shortcuts](https://learn.chatgpt.com/docs/reference/commands)
- [Introducing Codex](https://openai.com/index/introducing-codex/)
- [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
- Public issue evidence: [Windows GPU flicker and contrast](https://github.com/openai/codex/issues/24904), [sidebar history discoverability](https://github.com/openai/codex/issues/20833), [project grouping/path identity](https://github.com/openai/codex/issues/23193), [stuck thinking/control state](https://github.com/openai/codex/issues/24287), [sidebar transparency](https://github.com/openai/codex/issues/21171)

### 32.2 Claude Code / Anthropic

- [Claude Code Desktop guide](https://code.claude.com/docs/en/desktop)
- [Claude Code Desktop redesign](https://claude.com/blog/claude-code-desktop-redesign)
- [Desktop changelog](https://code.claude.com/docs/en/desktop-changelog)
- [Desktop quickstart](https://code.claude.com/docs/en/desktop-quickstart)
- [Worktrees](https://code.claude.com/docs/en/worktrees)
- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- Public issue evidence: [CLI/Desktop history continuity](https://github.com/anthropics/claude-code/issues/61967), [stale/missing session data](https://github.com/anthropics/claude-code/issues/48334), [multi-agent hierarchy request](https://github.com/anthropics/claude-code/issues/24537), [sidebar loading failures](https://github.com/anthropics/claude-code/issues/34678)

### 32.3 Cursor

- [Cursor 3.0 — New Cursor Interface](https://cursor.com/changelog/3-0)
- [Cursor changelog](https://cursor.com/changelog)
- [Review changes](https://docs.cursor.com/en/agent/review)
- [Files and folders as context](https://docs.cursor.com/context/%40-symbols/%40-files-and-folders)
- [Agent checkpoints](https://docs.cursor.com/en/agent/chat/checkpoints)
- Public feedback evidence: [Agents Window promotion](https://forum.cursor.com/t/please-stop-pushing-the-agent-window-so-aggressively-in-ide/160204), [layout customization](https://forum.cursor.com/t/agents-window-customize-layout/158646), [Agents Window/editor parity](https://forum.cursor.com/t/why-are-some-features-available-in-the-code-editor-but-not-in-the-agent-window/158314), [archive/delete semantics](https://forum.cursor.com/t/agents-sidebar-archive-only-no-delete-need-permanent-cleanup/163637), [workspace/clone identity](https://forum.cursor.com/t/cursor-3-how-to-close-workspace/156890), [Cursor 3 launch polish](https://forum.cursor.com/t/glass-alpha-bugs-list-feedback/155365)

### 32.4 Open-source implementations

- [Zed inspected tree](https://github.com/zed-industries/zed/tree/76c93968da5b8b8809bdd72e4ad9e7d0e946bad0)
- [OpenCode inspected tree](https://github.com/anomalyco/opencode/tree/d0ba5389248e05546849b9f69b7bc417aa5fd5d7)
- [Goose inspected tree](https://github.com/block/goose/tree/b7eb1e9735833a7bf12ab92994a788fbc770f218)
- [Cline inspected tree](https://github.com/cline/cline/tree/3266121fa1b228597292e955d56307c1b8fde9ce)
- [Kilo Code inspected tree](https://github.com/Kilo-Org/kilocode/tree/7c30be66e8fb925cd763c260507feaab51d13ff6)
- [OpenHands inspected tree](https://github.com/All-Hands-AI/OpenHands/tree/d1563c95260d76aeffcbc79d7fb30a79c32f450d)
- [GitHub Desktop inspected tree](https://github.com/desktop/desktop/tree/d9080117b1fd01193d3eee51ae243714468c8176)
- [Zed agents](https://zed.dev/docs/ai/agents)
- [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel)

### 32.5 Platform and interaction guidance

- [Apple HIG — Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [Apple HIG — Motion](https://developer.apple.com/design/human-interface-guidelines/motion)
- [Apple HIG — Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Fluent 2 — Motion](https://fluent2.microsoft.design/motion)
- [Fluent 2 — Accessibility](https://fluent2.microsoft.design/accessibility)
- [VS Code UX overview](https://code.visualstudio.com/api/ux-guidelines/overview)
- [VS Code views](https://code.visualstudio.com/api/ux-guidelines/views)
- [VS Code sidebars](https://code.visualstudio.com/api/ux-guidelines/sidebars)
- [VS Code panel](https://code.visualstudio.com/api/ux-guidelines/panel)
- [VS Code webviews](https://code.visualstudio.com/api/ux-guidelines/webviews)
