# AI Integrator — Research and Design System

**Purpose:** Record the product research and define implementation-grade visual, interaction, motion, and accessibility primitives for the desktop application.

This is the concise research and brand foundation. The exhaustive, normative workspace specification—including open-project/new-task/clone semantics, component state machines, pane geometry, motion placement, platform behavior, performance, recovery, and QA—is [Agent workspace UI/UX primitives](ui-ux-primitives.md).

## 1. Research method and limits

This document synthesizes:

- The three supplied screenshots of the current ChatGPT Codex desktop experience.
- Current official product documentation and changelogs as of July 10, 2026.
- Current protocol documentation for Codex app-server, Cursor CLI, Grok Build, and ACP.
- Direct source inspection of current Zed, OpenCode, Goose, Cline, Kilo Code, OpenHands, and GitHub Desktop UI implementations at recorded commits.
- Established motion and accessibility guidance.

Vendor marketing claims are treated as product intent, not independent proof. Exact UI layouts will continue to change. AI Integrator should copy durable interaction principles, not pixel-copy a vendor surface.

## 2. Evolution of the reference products

### 2.1 Codex: repo task runner to task-centered agent command center

#### May 2025: isolated cloud task

The original Codex product centered on choosing a repository/branch and submitting an independent cloud task. “Ask” and “Code” were distinct actions. The result emphasized terminal evidence, tests, a committed patch, and pull-request review.

Durable lesson:

- Isolation and verifiable evidence were foundational before desktop polish.
- The initial mental model was “send work to a sandbox,” not “chat with a model.”

#### February–March 2026: desktop command center

The Codex desktop app reframed the product around supervising multiple long-running agents. Threads were grouped by projects, worktrees isolated parallel changes, and review occurred beside the conversation. Skills and automations made the application broader than code generation. Windows support followed in March.

Durable lesson:

- As models work longer, the interface changes from conversation history to activity supervision.
- Project grouping and worktree isolation are prerequisites for parallelism.
- Review belongs in the same task context as the instructions.

#### April 2026: task before project

Standalone tasks removed the requirement to choose a project folder before beginning. Project-backed tasks remained appropriate for shared files and durable context.

Durable lesson:

- Users should be allowed to express intent before resolving storage/location.
- The system can request a folder or repository only when the task needs one.

#### May–June 2026: richer context and continuity

Goal mode, appshots, browser annotations, mobile access, SSH, hooks, standalone tasks, scheduled work, richer previews, memories, remote handoff, and improved subagent visibility broadened the task object.

Durable lesson:

- A serious task needs a goal, context, location, policy, evidence, and continuity across surfaces.
- Mobile/remote experiences are primarily for steering, approving, and reviewing—not reproducing the entire desktop.

#### July 2026: Codex inside the unified ChatGPT desktop app

On July 9, the dedicated coding experience moved into the unified ChatGPT desktop app alongside Chat and Work while retaining project/task workflows. Current documentation highlights multi-repository projects, inline diff editing, and PR review in a side panel.

Durable lesson:

- General chat and coding work can share one application without collapsing into one undifferentiated mode.
- The coding task still needs its own durable project, environment, review, and evidence semantics.

### 2.2 Claude Code: terminal agent to composable workspace

Claude Code began as a terminal-first coding agent with permissions, project memory, skills, hooks, MCP, and subagents. Claude Desktop later exposed the same underlying engine through a Code tab.

The current desktop workspace adds:

- Automatic worktree isolation for parallel sessions.
- Rearrangeable chat, diff, browser, terminal, file, plan, task, and subagent panes.
- Side chats that inherit context without steering the main thread.
- Summary, normal, and verbose activity density.
- Context and plan-usage rings.
- Local, SSH, and cloud environments.
- App preview, browser testing, computer use, PR monitoring, connectors, skills, and plugins.
- Dispatch, which decides whether work belongs in Cowork or a Code session.

Durable lessons:

- Advanced users value spatial composition, but a default layout must remain calm.
- Side questions need context isolation.
- A usage ring is useful when it answers a concrete limit question.
- Dispatch demonstrates that intent can route to the correct execution surface automatically.
- The terminal and GUI can share an engine/configuration without sharing every session detail.

### 2.3 Cursor: editor assistant to agent window

Cursor evolved from autocomplete and Composer inside the editor toward a separate Agents Window in Cursor 3.0.

Cursor 3.0 introduced:

- Parallel agents across repositories and local, worktree, cloud, and SSH environments.
- An agent-centered window that can coexist with the IDE.
- Design Mode for annotating exact elements in a rendered interface.
- Agent tabs arranged side-by-side or in a grid.
- Worktree and best-of-N commands.
- Better long-job monitoring, Await behavior, subagents, browser fallback, and transcript search.

Durable lessons:

- Agent supervision benefits from a dedicated window rather than permanent compression into an IDE sidebar.
- The IDE remains valuable for precise manual edits; the agent workspace should open into it cleanly.
- Visual UI feedback should attach exact rendered elements to a prompt.
- Best-of-N is useful only when candidates are isolated and comparison is structured.

### 2.4 Grok Build and ACP

Grok Build is intentionally available as an interactive TUI, structured headless process, and ACP agent. It exposes sessions, models, effort, plan mode, permissions, worktrees, export/import, and custom models.

ACP standardizes a client-to-agent relationship over JSON-RPC. The important architectural result is that AI Integrator can implement session, prompt, stream, cancel, permission, model, and capability behavior once for many compatible agents.

Durable lesson:

- The extension system should be protocol-first and capability-driven.
- A raw terminal remains the universal escape hatch.

## 3. Supplied reference-image analysis

### 3.1 Image 1: full Codex desktop task

Observed structure:

- Dark, low-chroma application shell.
- Narrow left project/task sidebar.
- Large central task canvas with generous line length and spacing.
- Persistent bottom composer with permission, goal, model/effort, voice, and send controls.
- Right floating Inspector card for outputs, subagents, and sources.
- Very limited use of accent color.

What works:

- The task content owns the visual hierarchy.
- The composer remains available without dominating the page.
- Model and permission controls are compact and near the send action.
- Supporting metadata is spatially separated into the Inspector.
- Sidebar statuses use small dots and muted labels rather than large cards.

Risks to avoid:

- Long undifferentiated task lists become visually noisy.
- Project tasks, standalone tasks, and general chats can blur together without stronger semantic grouping.
- A permanently floating Inspector can reduce usable canvas width on common laptop screens.
- Tiny low-contrast secondary text can become inaccessible.

### 3.2 Image 2: side-question preview

Observed structure:

- A small preview card appears beside the main canvas when another task/question is referenced.
- The preview uses the same surface language as the rest of the app.
- The main thread remains visually stable.

What works:

- Context can be consulted without navigating away.
- The preview is anchored to the source location and remains subordinate.

Product implication:

- AI Integrator should support peek previews for tasks, child runs, files, approvals, and source records.
- Peeks should promote to the Inspector or a split only on explicit action.

### 3.3 Image 3: activity summary

Observed structure:

- Work duration appears as quiet metadata.
- Tool usage is summarized in a single line.
- User steering appears inline during an active turn.
- Commentary and final output remain readable without rendering every low-level event.

What works:

- The activity summary answers “what happened” without turning the task into a terminal log.
- Mid-turn steering feels like a normal part of the conversation.

Product implication:

- Standard density should group transport/tool events by meaning.
- Trace density should remain available for debugging.
- User steering must be clearly associated with the in-flight run.

## 4. Design character

AI Integrator should feel:

- **Restrained:** no decorative gradients, animated glows, oversized cards, or constant status motion.
- **Premium:** precise alignment, excellent type, stable layout, deliberate spacing, crisp borders, and predictable interaction.
- **Calm under concurrency:** six running agents should not produce six competing animations.
- **Technical without being terminal-like:** commands and evidence remain accessible, but the default interface speaks in tasks, files, tests, and decisions.
- **Fast:** input feedback is immediate, panels do not block, and exits are faster than entrances.
- **Honest:** uncertain usage, unsupported capabilities, and partial handoffs are labeled plainly.

### 4.1 Anti-patterns

- Provider-colored application modes.
- A card dashboard for every feature.
- Animated neural-network backgrounds.
- Bouncing or pulsing agent avatars.
- Indeterminate spinners lasting more than a startup beat.
- Repeated success confetti.
- Permission severity communicated only through red/orange color.
- Hidden provider switching.
- “Magic” Auto routing with no disclosed selection.
- Streaming every token, file read, and shell line into the default conversation.

## 5. Foundation tokens

Values are initial implementation targets and must be tuned against rendered prototypes.

### 5.1 Color

Use neutral surfaces with one product accent and semantic colors reserved for state.

#### Dark theme

| Token | Value | Use |
|---|---:|---|
| `color.bg.canvas` | `#0D1015` | Main task canvas |
| `color.bg.sidebar` | `#111318` | Navigation |
| `color.bg.surface` | `#171A20` | Composer, panels |
| `color.bg.surfaceRaised` | `#1D2128` | Menus, popovers |
| `color.bg.selected` | `#252931` | Selected rows |
| `color.border.subtle` | `rgba(255,255,255,.07)` | Structural separators |
| `color.border.default` | `rgba(255,255,255,.11)` | Controls |
| `color.text.primary` | `#F1F3F5` | Primary copy |
| `color.text.secondary` | `#A8AFBA` | Metadata |
| `color.text.tertiary` | `#737B88` | Low-priority labels |
| `color.accent` | `#6DABFF` | Focused product accent; theme presets replace this through semantic tokens |
| `color.success` | `#53B987` | Completed/passed |
| `color.warning` | `#D7A756` | Budget/attention |
| `color.danger` | `#E07178` | Failed/denied/destructive |
| `color.info` | `#6EA8E8` | Informational state |

Requirements:

- Text contrast meets WCAG AA.
- Accent is not used for ordinary body links if it compromises readability.
- Provider identity uses a small icon/badge, not full-row color.
- Focus rings remain visible in both themes.

### 5.2 Typography

Use the platform UI font by default:

- Windows: Segoe UI Variable.
- macOS: SF Pro.
- Linux: Inter or system UI.
- Monospace: user-configurable; default to platform developer monospace.

| Token | Size/line | Weight | Use |
|---|---|---:|---|
| `type.display` | 24/32 | 600 | Empty-state title only |
| `type.title` | 18/26 | 600 | Task/project title |
| `type.heading` | 15/22 | 600 | Section heading |
| `type.body` | 14/21 | 400 | Conversation and UI copy |
| `type.bodyStrong` | 14/21 | 600 | Emphasis |
| `type.meta` | 12/18 | 450 | Status and metadata |
| `type.code` | 12.5/19 | 400 | Commands, diffs, traces |

Rules:

- Main response width targets 72–86 characters.
- Avoid all-caps navigation labels.
- Use tabular numerals for usage, elapsed time, and line numbers.
- Do not reduce metadata below 12 px at 100% scale.

### 5.3 Spacing

Base unit: 4 px.

`space.1=4`, `2=8`, `3=12`, `4=16`, `5=20`, `6=24`, `8=32`, `10=40`, `12=48`.

Rules:

- Dense control groups: 4–8 px.
- Sidebar rows: 8 px vertical, 10–12 px horizontal.
- Conversation blocks: 20–28 px separation.
- Pane padding: 16–24 px.
- Empty states: at least 40 px breathing room.

### 5.4 Radius

| Token | Value | Use |
|---|---:|---|
| `radius.xs` | 4 px | Tags, status |
| `radius.sm` | 7 px | Rows, small controls |
| `radius.md` | 10 px | Menus, cards |
| `radius.lg` | 14 px | Composer, Inspector |
| `radius.round` | 999 px | Compact pills only |

Avoid applying rounded cards to every section. Most task content should sit directly on the canvas.

### 5.5 Elevation

Use border and tonal difference before shadow.

- Level 0: canvas.
- Level 1: sidebar/composer/pane with subtle border.
- Level 2: menu/popover with 1 px border and soft 16–32 px shadow.
- Level 3: modal only.

No glass blur behind frequently used controls. It harms text stability and GPU efficiency.

### 5.6 Icons

- 16 px standard; 14 px metadata; 18–20 px primary icon buttons.
- 1.5 px optical stroke.
- Filled status symbols are reserved for active severity.
- Every icon-only control has tooltip and accessible name.
- Provider icons retain identity at 14–16 px but never set the surrounding surface color.

## 6. Layout primitives

### 6.1 Desktop breakpoints

| Window width | Layout |
|---|---|
| 1024–1279 | Collapsible sidebar; Inspector overlays; single canvas |
| 1280–1599 | 248 px sidebar; centered canvas; Inspector overlays or 300 px split |
| 1600–1919 | 260 px sidebar; canvas; optional 320 px Inspector |
| 1920+ | 272 px sidebar; max-width canvas; persistent Inspector if pinned |

Minimum supported window: 960 × 640. Below that, show a deliberate compact mode.

### 6.2 Sidebar

- Default width: 252 px.
- Resizable: 220–340 px.
- Collapsed rail: 48 px.
- Project rows are 34–38 px.
- Nested task indentation: 18 px.
- One status column aligned at the trailing edge.
- Header and New task remain fixed; project list scrolls.

### 6.3 Task canvas

- Content column max: 920 px.
- Text column max: 760 px.
- Wide artifacts/diffs can break out to 1200 px or open a review pane.
- Composer aligns with text column, not the whole canvas.
- Preserve scroll position when peeking at child runs or artifacts.

### 6.4 Inspector

Modes:

- Overlay peek: 280–340 px.
- Pinned split: 320–420 px.
- Full review: replaces or splits the canvas.

Tabs:

- Activity.
- Delegation.
- Artifacts.
- Changes.
- Usage.
- Contract.
- Sources.

Do not show empty tabs.

## 7. Component inventory

### 7.1 Navigation components

- App/workspace switcher.
- New task button and context menu.
- Search/command trigger.
- Project group.
- Project row.
- Task row.
- Task status glyph.
- Activity/approval counter.
- Account/help footer.

### 7.2 Composer components

- Autosizing text input.
- Attachment/contract chip.
- Add menu.
- Permission chip.
- Environment/worktree chip.
- Runtime/model/effort chip.
- Budget/usage chip.
- Goal/skill indicator.
- Send/stop button.
- Queued-follow-up indicator.
- Inline setup strip.

### 7.3 Task components

- User message.
- Agent final message.
- Commentary/progress note.
- Phase activity group.
- Plan.
- Tool event.
- Terminal event.
- File event.
- Test result.
- Approval request.
- Clarifying question.
- Delegation branch.
- Child-run summary.
- Artifact card.
- Screenshot comparison.
- Diff summary.
- Completion/handoff summary.
- Error and recovery card.

### 7.4 Review components

- File tree with change counts.
- Unified/split diff.
- Hunk actions.
- Inline comment.
- Test/evidence rail.
- Apply/merge/discard controls.
- Worktree comparison.
- Best-of-N candidate comparison.

### 7.5 Connection components

- Runtime connection row.
- Install/login/update action.
- Capability summary.
- Version compatibility warning.
- Model availability list.
- Usage confidence legend.
- Raw terminal fallback action.

## 8. Motion system

Motion exists to explain state and preserve spatial context. It is not a reward layer for routine agent activity.

### 8.1 Principles

- **Immediate:** feedback begins in the same frame as input.
- **Brief:** high-frequency interactions stay below 150 ms.
- **Spatially coherent:** panels originate from their trigger or edge.
- **Interruptible:** the user never waits for motion before acting.
- **Singular:** one focal animation per meaningful state change.
- **Accessible:** reduced motion is a fully supported mode.
- **Performance-safe:** animate opacity and transform; avoid layout thrashing and blur.

This aligns with Apple guidance to keep feedback brief and optional and Atlassian guidance to reserve motion for clarity, use 50–150 ms for interactions, 150–400 ms for transitions, and make exits faster than entrances.

### 8.2 Duration tokens

| Token | Duration | Use |
|---|---:|---|
| `motion.instant` | 0 ms | Focus, critical feedback |
| `motion.micro` | 70 ms | Pressed state |
| `motion.fast` | 110 ms | Hover reveal, row selection |
| `motion.control` | 150 ms | Menu/popover enter |
| `motion.panel` | 220 ms | Inspector/pane enter |
| `motion.layout` | 280 ms | Sidebar collapse, split resize settle |
| `motion.milestone` | 360 ms | First-run or one-time completion transition |

Exits use the next shorter token unless spatial continuity would be lost.

### 8.3 Easing tokens

| Token | Curve | Use |
|---|---|---|
| `ease.enter` | `cubic-bezier(.16,1,.3,1)` | Fast arrival, soft landing |
| `ease.exit` | `cubic-bezier(.4,0,1,1)` | Quick dismissal |
| `ease.move` | `cubic-bezier(.65,0,.35,1)` | Reposition/layout |
| `ease.linear` | `linear` | Determinate progress only |

Avoid bouncy springs for routine controls. If used for a low-frequency branded moment, overshoot must be under 2%.

### 8.4 Required motion placements

#### Sidebar

- Hover: background color, 70–110 ms.
- Selection: background/border crossfade, 110 ms.
- Project expand: chevron + clipped height, 150 ms; reduced motion is instant.
- New running task insertion: 150 ms fade/translate 4 px.
- Status change: color/icon crossfade; no perpetual pulse.

#### Composer

- Focus: border/accent crossfade, 110 ms.
- Autosize: 150 ms only for discrete line-count changes; direct while dragging.
- Attachment insertion: 150 ms scale from 98% + fade.
- Context/setup strip: 180–220 ms from composer edge.
- Send → stop: icon morph/crossfade, 110 ms.
- Runtime change: label crossfade, 110 ms; never animate provider colors across the composer.

#### Task activity

- New progress note: 150 ms fade with 4 px vertical movement.
- Tool-group expansion: 180–220 ms with content clipping.
- Plan step completion: checkmark draw/crossfade once, 180 ms.
- Delegation child spawn: branch line reveals once over 220 ms.
- Child status update: glyph crossfade, 110 ms.
- Completion: one restrained accent sweep inside the status glyph, maximum 360 ms.

#### Panels and review

- Inspector enter: 220 ms from right with simultaneous canvas resize if pinned.
- Inspector exit: 150 ms.
- Peek card: 150 ms fade/scale from anchor.
- Diff view change: crossfade; do not slide large code blocks.
- Modal: 220 ms fade/scale from 98%; exit 150 ms.

### 8.5 Where motion must not appear

- Continuous shimmer across running tasks.
- Animated model/provider logos.
- Token-by-token cursor animation when chunks already stream rapidly.
- Looping progress on every subagent.
- Pulsing sidebar rows.
- Layout movement when only a numeric usage value changes.
- Large background parallax.
- Blur interpolation.
- Error shaking.

### 8.6 Long-running feedback

For work longer than two seconds:

- Replace the startup spinner with a verb: Starting, Reading, Planning, Running tests, Waiting.
- Show elapsed time after five seconds.
- Show the responsible runtime.
- Use determinate progress only when there is a meaningful denominator.
- A subtle 1.2-second spinner may accompany a status label, but it must not be the only state cue.
- After 30 seconds without an observable event, show “No new events” plus last known activity; do not imply the agent is progressing.

### 8.7 Reduced motion

When the OS requests reduced motion:

- Set all layout and positional transitions to 0 ms.
- Replace translation/scale with immediate state or a 70 ms opacity crossfade.
- Disable animated branch drawing, icon morphs, and milestone effects.
- Keep focus, errors, and completion immediately visible.
- Ensure no information depends on animation order.

## 9. Interaction states

Every interactive component must define:

- Rest.
- Hover.
- Focus-visible.
- Pressed.
- Selected.
- Disabled with reason.
- Loading.
- Error.
- High-contrast.
- Reduced motion.

### 9.1 Focus

- 2 px visible focus ring offset by 1 px.
- Focus appears immediately, not after animation.
- Roving tabindex for project/task lists.
- Escape returns focus to the originating control.
- Opening a menu focuses the selected/default item.

### 9.2 Keyboard model

Minimum shortcuts:

- Ctrl/Cmd+N: new task.
- Ctrl/Cmd+O: open project.
- Ctrl/Cmd+Shift+O: clone repository.
- Ctrl/Cmd+K: command/search.
- Ctrl/Cmd+Enter: send.
- Esc: stop active response or close transient surface.
- Ctrl/Cmd+Shift+M: model/runtime menu.
- Ctrl/Cmd+Shift+P: permissions.
- Ctrl/Cmd+Shift+D: diff/review.
- Ctrl+`: terminal/raw runtime.
- Alt+Up/Down: previous/next task.
- Ctrl/Cmd+;: side question.

All shortcuts are discoverable and remappable where platform conventions allow.

## 10. State color and status language

| State | Icon | Color | Preferred label |
|---|---|---|---|
| Draft | hollow circle | tertiary | Draft |
| Setting up | progress arc | info | Preparing project |
| Queued | clock | secondary | Queued |
| Running | two-frame activity glyph | info | Reading / Implementing / Testing |
| Waiting user | question | warning | Needs your answer |
| Waiting approval | shield | warning | Approval required |
| Waiting child | branch | info | Waiting for 2 agents |
| Paused | pause | secondary | Paused |
| Reviewing | diff/check | accent | Reviewing changes |
| Completed | check | success | Completed |
| Failed | x | danger | Failed |
| Canceled | slash | secondary | Canceled |

Do not label every active state “Thinking.”

## 11. Premium-feel checklist

Before calling a screen polished, verify:

- Baselines align across icons, labels, and metadata.
- Click targets are at least 32 × 32 desktop and 44 × 44 touch.
- No accidental double border where panels meet.
- Menu widths fit labels without excessive empty space.
- Hover does not shift layout.
- Scrollbars are stable and do not cover content.
- Long names truncate with full tooltip.
- Empty/loading/error states occupy the same spatial frame.
- Streaming content does not cause the composer to jump.
- Text selection and copying work in all transcripts.
- Diffs use stable line-height and tab sizing.
- Every destructive action names the affected project/task/worktree.
- The UI remains useful with animation disabled.

## 12. Design validation scenarios

Prototypes must be tested with:

1. Empty first run with no runtimes installed.
2. One project and one idle task.
3. Twenty projects and hundreds of tasks.
4. Six parallel tasks with mixed running/waiting/completed states.
5. A long task with five child agents.
6. A permission request while the user is reading another task.
7. A 500-file diff.
8. A runtime parser failure requiring PTY fallback.
9. 200% Windows scaling.
10. Keyboard-only navigation.
11. Screen reader with live progress.
12. OS reduced-motion setting.
13. High-contrast mode.
14. Narrow 1024 px window.
15. Offline/reconnecting runtime.

## 13. Research-derived product recommendations

- Use **New task** as the primary sidebar action.
- Keep **Open project** and **Clone repository** one level below it but accessible by shortcut.
- Permit typing before choosing a project; resolve required context inline.
- Keep runtime/model/effort in one execution-profile selector.
- Use an on-demand Inspector instead of a permanently crowded right rail.
- Support Summary, Normal, and Verbose density, with Raw diagnostics separated from the ordinary transcript.
- Model side questions as context-reading forks that do not alter the main task.
- Default parallel writers to worktrees.
- Add visual annotation and screenshot comparison after core runtime fidelity.
- Make usage visible near model selection but do not show false precision.
- Treat motion tokens as part of the component contract.

## 14. Sources

### Product evolution

- [Introducing Codex (May 2025)](https://openai.com/index/introducing-codex/)
- [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
- [Codex projects, chats, and tasks](https://learn.chatgpt.com/docs/projects)
- [Codex what's new](https://learn.chatgpt.com/docs/whats-new)
- [Codex Windows app](https://learn.chatgpt.com/docs/windows/windows-app)
- [Work with Codex from anywhere](https://openai.com/index/work-with-codex-from-anywhere/)
- [Claude Code Desktop](https://code.claude.com/docs/en/desktop)
- [Claude Desktop changelog](https://code.claude.com/docs/en/desktop-changelog)
- [Cursor 3.0](https://cursor.com/changelog/3-0)
- [Grok Build](https://docs.x.ai/build/overview)
- [Grok modes and commands](https://docs.x.ai/build/modes-and-commands)

### Protocols

- [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Cursor CLI](https://docs.cursor.com/en/cli/overview)
- [Agent Client Protocol](https://agentclientprotocol.com/)
- [ACP registry](https://agentclientprotocol.com/registry)

### Inspected open-source interfaces

- [Zed](https://github.com/zed-industries/zed)
- [OpenCode](https://github.com/anomalyco/opencode)
- [Goose](https://github.com/block/goose)
- [Cline](https://github.com/cline/cline)
- [Kilo Code](https://github.com/Kilo-Org/kilocode)
- [OpenHands](https://github.com/All-Hands-AI/OpenHands)
- [GitHub Desktop](https://github.com/desktop/desktop)

### Motion and accessibility

- [Apple Human Interface Guidelines: Motion](https://developer.apple.com/design/human-interface-guidelines/motion)
- [Apple Human Interface Guidelines: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Atlassian Design System: Motion](https://atlassian.design/foundations/motion)
- [Atlassian Design System: Applying motion](https://atlassian.design/foundations/motion/applying-motion)
