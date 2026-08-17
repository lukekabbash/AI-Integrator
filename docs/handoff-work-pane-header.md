# Handoff: work-pane header and subagent tab

Two UI changes requested on 2026-08-17, owned by whoever holds `App.tsx` and
`WorkPane.tsx`. Written down because the asks are specific and the person who
received them is not the person implementing them.

## 1. The view tabs belong in the header

`Task | Review 0` must stay in the top-right of the titlebar where it sits
before the work pane opens. Opening the pane currently moves it down alongside
the pane.

Where to look: `WorkPane` portals its tab strip into `.titlebar-subagent-slot`
(`App.tsx`, the `titlebar-subagent-slot` div). That slot is absolutely
positioned from `--subagent-pane-left` to the right edge, so it covers the
titlebar's right side, and the view tabs (`tabs`, rendered in `.titlebar-end`)
end up behind or below it. The strip also receives `trailing={workspaceToggles}`.

What is wanted: the pane's tab strip occupies the slice above the pane only, and
the view tabs and window controls stay in the header, at the top right, in the
same place whether or not the pane is open.

## 2. The subagent tab carries its own detail

Today an open subagent surface adds a subheader row inside the pane
(`.work-pane-subheader`) reading e.g.

```
Subagent 1 · Browser Surface Inventory
Browser code cartographer · grok-4.6 · Completed
```

What is wanted instead:

- No subheader row. All of that text lives on the tab and appears **on hover**
  (the app's `Tooltip`, which already supports a label plus a hint line).
- The tab's glyph becomes the **same icon the subagent rail uses, with its
  animation**, rather than the current static `Bot`.
- A **small bot face** sits on top of it, in the lower-right corner, as a badge.
- The combined glyph must be **no larger** than the current tab icon, so the
  strip's rhythm does not change. Badge the existing box; do not grow it.

Reference: the rail's subagent icon and its animation are the source of truth —
reuse that component rather than redrawing it, so the two stay identical.
