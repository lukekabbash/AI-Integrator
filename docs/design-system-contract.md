# AI Integrator v1 design-system contract

This document freezes the latest visual and interaction decisions. Detailed component/state/accessibility primitives remain in the main UI/UX catalog. The portable material and motion recipes — the tactile / jelly chrome — live in [soft-tactile-design-language.md](soft-tactile-design-language.md).

## 1. Experience character

AI Integrator is agent-first, calm, restrained, premium, and softly tactile. It is not a conventional IDE, analytics dashboard, sci-fi control center, or collection of rounded cards.

- Transcript/task work remains the largest quiet reading surface.
- Progressive disclosure keeps runtime complexity available without dominating the composer.
- Continuous surfaces and typography establish structure; borders/cards are used only when they clarify ownership or action.
- Motion confirms spatial/state change and never performs “thinking theater.”

## 2. Navigation

### Workspace

- Left rail: projects and durable tasks.
- Primary canvas: task transcript, evidence, produced file/diff/terminal/review surfaces.
- Right contextual rail: Agents, Files, Git, Sources, Outputs/usage when applicable.
- Bottom composer: context/permission/delegation left; runtime/model/effort and usage right.

### Settings

- Settings is a full-screen application route.
- Opening Settings replaces the project/task left rail with settings-category navigation.
- It is not a right drawer, modal, overlay, or inspector tab.
- `Back to workspace` restores the previous project, task, canvas tab, scroll/focus, and right-rail state.
- Categories, in order: General, Personalization, Appearance, Composer, Keyboard, Runtimes and Models, Skills and Plugins, Subagents, Permissions, Git, Browser, Explain, Usage and Budgets, Archives.
- Keyboard owns every global shortcut. The registry in `keybindings.ts` is the single source of truth: a command appears in this category only if the workspace dispatches it, and any surface that advertises a shortcut resolves the label from the same table rather than hard-coding it. Bindings are stored portably (`Mod` resolves to Command or Control) and matched on the physical key, so a rebind survives a layout change. Escape is reserved for closing things and is not bindable.
- Keyboard movement is two layers, and they do not overlap. A *shortcut* slews to a pane — the chat rail, the transcript, the composer, the work pane — and is rebindable. *Arrows* move the cursor inside whichever pane holds focus and are structural, like Tab: Up and Down step rows, Right opens a group, Left closes it or steps out to the group that owns the row, Home and End reach the ends, and a typed letter jumps to the next row starting with it. Arrows are never rebindable; what the user controls is whether the cursor is on at all and whether it wraps at the ends.
- A rail opts in with two attributes — `data-nav-region` on the container, `data-nav-item` on each cell — and never by writing its own arrow handler. Rows a fold has collapsed stay in the DOM but leave the cursor's reach, so the keyboard can only land somewhere the eye can follow.
- Personalization owns the optional local display name, user-authored Chat profile, and the transparent bounded memory list. Empty profile fields send nothing; profile sharing and memory remain independently controllable.
- No Account or Integrator Billing category exists in v1. Vendor identities/plans live under Runtimes and Models and Usage.
- Runtimes and Models owns the optional favorite runtime, per-runtime model/config preferences, connection health, and the user-approved install, authentication, and update terminal flows. With no favorite, new chats inherit the last-used runtime. When a terminal flow is active, routing controls recede so the selected runtime and full terminal stage dominate.

## 3. Git and review

Git is a contextual right-rail tab inspired by the compact information architecture of source-control sidebars, without changing the product into an IDE.

The Git tab contains:

- selected repository/worktree/branch/base identity;
- editable commit-message draft;
- separate Commit button and explicit Publish/Push controls;
- staged, unstaged, and untracked groups with counts;
- per-file status and actions;
- Review changes, checks, ahead/behind/remote state;
- compact local history/graph when useful;
- unresolved review count and agent-review entry point.

Selecting a changed file opens the real review canvas in the primary area. It does not squeeze a full diff into the narrow rail.

Diff semantics:

- additions: restrained green background/gutter;
- deletions: restrained red background/gutter;
- changed token spans: stronger but contrast-safe variants;
- unchanged context: neutral surface;
- syntax highlighting remains visible but subdued beneath change semantics;
- line numbers, hunk boundaries, whitespace mode, split/unified mode, inline comments, partial/truncated warnings, and keyboard navigation;
- do not rely on hue alone: signs, gutter geometry, labels, and screen-reader descriptions remain present.

## 4. Shape and elevation

Default radius tokens:

| Token         | Default | Use                                                   |
| ------------- | ------: | ----------------------------------------------------- |
| `radius.xs`   |    4 px | tiny indicators, code-token labels                    |
| `radius.sm`   |    6 px | rows, chips, compact controls                         |
| `radius.md`   |   10 px | composer, menus, terminal/diff panes, settings groups |
| `radius.lg`   |   12 px | major transient panels                                |
| `radius.full` |  999 px | status dots/rings only                                |

- Default user preset is `Soft (10px)` and can be changed.
- Do not wrap transcript paragraphs, every tool line, or each setting row in a card.
- Elevation is reserved for a composer, popover/menu, drag item, modal approval, or floating transient layer.
- Hairlines and tonal surface changes are preferred for stable layout regions.

## 5. Semantic color system

The default product accent is not purple. Purple/violet/magenta are not reserved product semantic colors.

Required tokens include:

```text
surface.canvas, surface.sidebar, surface.panel, surface.elevated
text.primary, text.secondary, text.muted, text.inverse
border.subtle, border.strong, focus.ring, selection.active
accent.primary, accent.hover, accent.pressed
status.success, status.warning, status.danger, status.info
diff.added, diff.addedStrong, diff.removed, diff.removedStrong, diff.context
syntax.keyword, syntax.string, syntax.type, syntax.function, syntax.variable, syntax.comment
terminal ANSI 0–15 mapped through theme-aware accessible colors
```

No component owns a literal hex color outside the token-definition/test layer.

## 6. Presets and customization

v1 ships twelve coordinated presets:

1. Graphite — neutral near-black, steel-blue accent.
2. Ash — softer neutral gray.
3. Midnight — blue-black, cool accent.
4. Slate — cool dark gray.
5. Ocean — deep blue-black, ocean accent.
6. Forest — charcoal/evergreen, moss accent.
7. Sand — warm taupe/cream.
8. Ember — warm charcoal/rust.
9. Rosewood — deep warm red-brown, not magenta.
10. Arctic — cool pale surfaces.
11. Paper — warm ivory and graphite.
12. High Contrast — certified high-contrast dark/light behavior.

Each preset defines every semantic color token, syntax palette, terminal mapping, focus/selection state, and OS chrome fallback. Presets are not an accent-color swap.

User customization:

- interface font and fallback chain;
- code/terminal font and fallback chain;
- body/code size, weight, line height, ligatures;
- comfortable/compact density and panel spacing;
- radius preset and advanced numeric override;
- motion preference/speed and streaming cursor;
- sidebar overflow-menu direction (left or right of the `…` trigger);
- every semantic color token with preview/reset;
- export/import a versioned theme file.

Accessibility:

- live contrast checks and warnings for custom tokens;
- preview includes transcript, selected row, focus ring, approval, terminal, syntax, and red/green diff;
- high-contrast/forced-colors override remains usable even when it cannot preserve the selected preset exactly;
- font changes cannot reduce minimum hit targets or bypass reflow tests.

## 7. Composer controls

- Lower left: context/add, effective permission, delegation profile.
- Lower right: runtime/model/effort selector, compact usage, microphone if available, Stop/Send.
- Provider/model choice feels as lightweight as reasoning effort. No large provider switch or colorful provider-logo row is visible by default.
- Collapsed route identity favors `Runtime · Model · Effort`; details reveal connection, vendor auth context, capability/degraded status, billing/usage class, and continuation semantics.

## 8. Usage presentation

Compact format may read:

```text
12% · 215k · ≈$1.84
```

Only available dimensions appear. The popover/full view labels each:

- `Provider allowance` with bucket and reset;
- `Tokens` split into input/output/cached when available;
- `API-equivalent value` with estimate/pricing basis;
- `Actual incremental spend` and subscription-backed/unknown state.

Every row shows source (`Provider reported`, `Adapter measured`, `Estimated`, `Not exposed`) and freshness. A ring represents one dimension only; multiple dimensions use separate bars/rows.

## 9. Cross-platform behavior

- Windows and macOS share component semantics, layout, tokens, state machines, and acceptance tests.
- OS-native titlebar/menu/window, shortcuts, notification, font fallbacks, file pickers, scrollbars, and material effects may differ.
- macOS sidebar material and Windows Mica/Acrylic are optional enhancements with opaque stable fallbacks.
- Themes are tested on both WebView stacks, high contrast, software rendering, wide gamut/ordinary displays, and transparency disabled.
- Platform differences never create Windows-only or Mac-only information architecture.

## 10. Design acceptance set

Before v1 visual freeze, approve interactive prototypes for:

1. project/task workspace and composer;
2. active agent with one child and communication;
3. Git right rail plus large red/green syntax-aware review;
4. integrated task terminal and user-owned Setup terminal;
5. full-screen Settings: Appearance;
6. full-screen Settings: Runtimes and Models/Subagents/Usage;
7. crash/reconnect/uncertain action recovery;
8. Graphite, Forest, and Paper presets plus High Contrast;
9. narrow window, 200% scaling, screen reader, IME, and keyboard-only flows.
