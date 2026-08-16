# Soft Tactile Design Language

**Status:** Portable art direction. Extracted from the shipped AI Integrator desktop UI.  
**Audience:** Anyone building another product that should look and feel like this one.  
**Companions in this repo:** [Design-system contract](design-system-contract.md) (product freeze), [UI/UX primitives](ui-ux-primitives.md) (workspace IA). Those stay here. This file is the part you copy.

This is the unnamed layer under the chrome: the jelly. Softly raised chips, rails that are not flat slabs, menus that spring into place, icons that morph instead of swapping, and a press that sinks a half-pixel like gel. It is not glassmorphism. It is not skeuomorphic plastic. It is not “everything is a rounded card.”

The feel is a **recipe plus discipline**. Same highlight percentage. Same spring mass. Same press distances. Depth on chrome, flat on reading surfaces. If you keep the character and invent new numbers, you will get generic bounce by the second screen.

Sections 0–24 are the system: material, type, springs, icons. Sections 25–48 are the micro-language: yield slots, tree guides, shared glyph cells, optical 1px lies, the blur allowlist, and the loops that are actually allowed. The second half is why a copy that “uses the tokens” can still feel like a different product.

---

## 0. How to use this file

1. Treat the named recipes as source of truth. Do not approximate a highlight or a spring “by eye” if the number is here.
2. Copy the CSS and spring objects. Then restyle color. The material and motion stay; the palette can change.
3. If a control is not listed, compose it from an existing recipe. Do not invent a second elevation language.
4. Product information architecture is out of scope. Do not import Integrator’s settings route, composer layout, Git rail, or agent glyphs unless you are building Integrator.
5. Reduced motion is part of the language, not an afterthought. Every spring has a `duration: 0` twin.

**Implementation note.** Integrator uses CSS variables plus Motion (`motion/react`) springs. Another stack can reproduce this with CSS springs, WAAPI, or a different library. The numbers matter more than the library.

---

## 1. Character

The product is **calm, restrained, premium, and softly tactile**.

- Reading surfaces are the largest quiet area. Chrome is the only place that shows depth.
- Structure comes from typography, spacing, and continuous surfaces. Borders and cards appear only when they clarify ownership or action.
- Motion confirms a spatial or state change. It never performs thinking theater. A spinner that exists to look busy is a failure.
- Controls feel like small gel objects: a faint inner highlight, a short drop shadow, a press that compresses, a hover that lifts the shadow a few pixels. They do not wobble. They overshoot once and settle.
- Selection travels. A shared pill moves between rows. The row itself does not grow a new card.
- Icons are line marks at 1.7–2.0 stroke. They morph, rotate, or squish. They do not crossfade between two SVGs.

One sentence you can hold while designing:

> Chrome has a body. Content does not.

---

## 2. What this is not

These are the fastest ways to kill the feel. If you catch yourself doing one, stop and use a recipe from this file instead.

| Trap | Why it fails | Do this instead |
|---|---|---|
| Card every row | The UI becomes a stack of tiles. The jelly needs continuous rails. | Quiet rows. Traveling selection. Hairlines only when ownership is unclear. |
| Glass / blur everywhere | Reads as a 2020 dashboard, not gel. Text fades on Windows software rendering. | Opaque surfaces. Blur is a short allowlist: see §25. |
| Neon glow, purple gradient, sparkle | Novelty color. The language is mineral, not candy. | One accent. Status colors stay muted. No decorative glow. |
| Bounce-for-fun | Elastic loops feel like a toy. | One overshoot, then settle. Loops only for live status (breathing dots). |
| Height-per-row animation | Forces layout every frame. Sidebars judder. | Animate `opacity`, `transform`, and slot `width`. Keep inner panels at full width. |
| Swap icons on state change | The mark pops. The gel is gone. | Morph matching SVG path geometry, or rotate the same mark. |
| Elevation on reading surfaces | Transcripts and settings copy start to float. | Elevation is reserved for composer, menu, tooltip, drag item, modal. |
| Color-only press | Flat software. No body. | Always pair color with `scale` or `translateY`. |
| Second radius language | Mixed corners are the clearest “vibe coded” signal. | One radius ramp. Every control uses a token from it. |
| Thinking theater | Motion that exists while the machine thinks, not because the UI changed. | Status dots breathe. Everything else waits for a real state change. |

---

## 3. The one spatial rule

**Depth on chrome. Flat on content.**

Chrome means: sidebar rail, settings nav, buttons, icon buttons, composer shell, menus, tooltips, switches, approval cards, floating dialogs.

Content means: transcript paragraphs, settings copy, tool output, diffs, terminal text, file contents, empty-state prose.

If you catch a paragraph sitting on a raised card with an inner highlight, you have broken the rule. If you catch a primary button with no drop shadow and no press scale, you have also broken the rule.

---

## 4. Scales

Use a **2px grid** with a **4px rhythm**. Comfortable defaults below. Compact multiplies control heights by `0.82` and tightens padding; it does not invent new radii or shadows.

### 4.1 Space

| Token | Default | Use |
|---|---:|---|
| `space.row` | 8px | Gaps between stacked rows |
| `space.control-x` | 10px | Horizontal padding inside controls |
| `space.control-y` | 7px | Vertical padding inside controls |
| `panel.gap` | 12px | Gaps between major regions |
| Rail pad x | 6px | Sidebar / settings nav inset. Rows work the full rail width. |
| Composer column | 24px side inset, 780px cap | Floating composer and anything that must sit on the same column |

Panel spacing presets, if you expose them:

| Preset | `--panel-gap` |
|---|---|
| Tight | 8px |
| Balanced (default) | 12px |
| Airy | 20px |

Do not introduce 7px, 11px, or 13px gaps “because it looked better.” If a gap is not on this list, it is a one-off and you should be able to say why.

### 4.2 Control heights

| Size | Comfortable | Compact | Use |
|---|---:|---:|---|
| `sm` | 28px | 24px | Compact icon buttons, tiny rail tools |
| `md` | 34px | 28px | Primary / secondary buttons, New-action chips |
| `lg` | 40px | 34px | Rare. Destructive confirms, empty-state actions |
| Row | 36px | 30px | Navigation rows |
| Icon button | 32px | — | Default square. Tiny variant is 26px. |
| Switch | 38 × 22 | — | Do not scale the switch down in compact. Hit target stays. |
| Dropdown trigger | 32px | 29px compact variant | Shared menu surface |
| Menu option | 30px min | — | Same in both densities |

Minimum hit target is 24px. Font changes cannot go below that.

### 4.3 Radius

Default user preset is **Soft**. Ship the four presets as a coordinated ramp, not as a single number.

| Preset | `xs` | `sm` | `md` | `lg` |
|---|---:|---:|---:|---:|
| Square | 0 | 2 | 4 | 6 |
| Subtle | 3 | 5 | 7 | 9 |
| **Soft (default)** | **4** | **6** | **10** | **12** |
| Round | 6 | 9 | 14 | 18 |

Aliases used in components:

| Alias | Token | Use |
|---|---|---|
| `--radius-control` | `sm` | Buttons, inputs, icon buttons, dropdowns |
| `--radius-row` | `sm + 2px` | Navigation rows, chat rows, settings nav items |
| `--radius-panel` | `md` | Rails’ outer corners, empty-state outlines |
| `--radius-composer` | `md` | Composer shell, approval card, queue shelf |
| `--radius-full` | 999px | Status dots, switch track, scrollbar thumbs only |

Numeric override, if you expose one: the user sets `md`; `xs = max(0, md - 6)`, `sm = max(0, md - 4)`, `lg = min(28, md + 2)`.

`full` is never a button. Pill buttons are a different product.

### 4.4 Type

One interface font. One code font. No third display face.

Default interface stack:

```text
Inter, "Segoe UI Variable", "SF Pro Text", -apple-system, BlinkMacSystemFont, sans-serif
```

Default code stack:

```text
"Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace
```

| Role | Size | Weight | Line height | Tracking |
|---|---:|---:|---:|---|
| Body | 14px | 400 | 1.55 | 0 |
| Chat / transcript | 13.5px | 400 | 1.55 | 0 |
| Code / terminal | 13px | 400 | 1.5 | 0 |
| Button label | 13px | 600 | inherit | 0 |
| Brand / product name | 13.5px | 680 | inherit | −0.015em |
| Section page title | 14–16px | 650–680 | inherit | −0.015em to −0.02em |
| Nav row label | 12.5px | 520–600 | inherit | −0.01em |
| Secondary / hint | 10–10.5px | 400–570 | inherit | 0 |
| Eyebrow / overline | 9.5–10px | 650 | inherit | 0.04em to 0.07em, uppercase |
| Keyboard chip | 10px / 16px | 400 | 16px | 0 |
| Menu option | 11px | 400, 600 if selected | inherit | 0 |

Weights that appear everywhere: **400, 520, 550, 560, 570, 580, 600, 620, 650, 680**. Do not use 900. Do not use 300 for body. Titles are tight, not light.

Eyebrows are the only uppercase. They are short (`CHAT`, `LATER`, `TOOLS`) and they sit at reduced contrast, not at primary text.

### 4.5 Duration

Base durations at motion scale `1`. Multiply every duration by `--motion-scale`.

| Token | Base | Use |
|---|---:|---|
| `--duration-instant` | 80ms | Press scale. Must feel immediate. |
| `--duration-fast` | 140ms | Color, border, shadow, most hovers |
| `--duration-moderate` | 220ms | Panel width, emphasized icon turns, content enter |
| `--duration-slow` | 340ms | Slot open/close, drawer width |
| `--duration-cursor` | 900ms | Streaming caret blink only |

Motion scale:

| Preference | Scale |
|---|---:|
| Full | 1 (user may set 0.25–2) |
| System + OS reduce | 0.35 |
| Reduced | 0.35 |
| None | 0 |

At `0`, springs become `{ duration: 0 }` and looping animations stop. Do not leave a 1ms “technical” animation that still plays.

### 4.6 Easing

| Name | Curve | Use |
|---|---|---|
| Standard | `cubic-bezier(0.2, 0, 0, 1)` | Almost everything. Color, fade, short enter. |
| Emphasized | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Icon turns, switch knob, panel width when you want a hint of spring without Motion. |
| Panel slot | `cubic-bezier(0.33, 1, 0.15, 1)` | Sidebar / rail / drawer width. Decelerates hard. No overshoot. |
| Modal glide | `cubic-bezier(0.16, 1, 0.3, 1)` | Dialog cards that should not spring. |
| Flap (jelly) | `cubic-bezier(0.3, 1.4, 0.4, 1)` | Icon path morphs that need one overshoot. 300ms. |
| Exit | `cubic-bezier(0.4, 0, 1, 1)` | Short leave. 100–160ms. No overshoot on the way out. |
| Loop | `cubic-bezier(0.72, 0, 0.28, 1)` | Status glyph cycles. Symmetric. |

In Motion arrays those are `[0.2, 0, 0, 1]`, `[0.2, 0.8, 0.2, 1]`, `[0.33, 1, 0.15, 1]`, `[0.16, 1, 0.3, 1]`, `[0.3, 1.4, 0.4, 1]`, `[0.4, 0, 1, 1]`.

Default CSS variables:

```css
--ease-standard: cubic-bezier(0.2, 0, 0, 1);
--ease-emphasized: cubic-bezier(0.2, 0.8, 0.2, 1);
```

Do not use `ease`, `ease-in-out`, or `bounce` in new work. They are a different language.

---

## 5. Material physics

The 3D is four stacked effects. Miss one and the surface goes flat. Add a fifth (blur, noise, specular sweep) and it goes cheap.

### 5.1 The gel stack

1. **Fill** — a semantic surface token, not a raw hex.
2. **Falloff** — a short vertical gradient so the surface is not one slab. Rails only. Controls use a tighter two-stop mix.
3. **Inner highlight** — `inset 0 1px 0` at 3–7% of text-primary (or white on dark floating cards). This is the gel skin.
4. **Drop** — 1–2px contact shadow on chips; 10–34px on floating shells. Never both a huge drop and a thick border.

Press then **sinks** the object (`translateY(0.5px)` or `scale(0.96–0.985)`) and slightly flattens the highlight. Hover **lifts** the drop a few pixels and raises the highlight 2 percentage points.

### 5.2 Highlight recipe

Use `color-mix`. Do not pick a hex for the sheen.

```css
/* Rails, stable chrome */
box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-text-primary) 4%, transparent);

/* Raised chips at rest */
box-shadow:
  inset 0 1px 0 color-mix(in srgb, var(--color-text-primary) 5%, transparent),
  0 1px 2px color-mix(in srgb, black 18%, transparent);

/* Raised chips on hover */
box-shadow:
  inset 0 1px 0 color-mix(in srgb, var(--color-text-primary) 7%, transparent),
  0 2px 6px color-mix(in srgb, black 22%, transparent);

/* Floating composer / approval cards */
box-shadow:
  0 12px 34px color-mix(in srgb, black 18%, transparent),
  inset 0 1px color-mix(in srgb, white 3%, transparent);
```

Highlight percentages that are legal: **3, 4, 5, 7**. If you want 12%, you are drawing a stripe, not a skin.

On light themes, keep the same percentages. The mix against `text-primary` (dark ink) still reads as a top edge. Drop shadows shift to a warm gray, not pure black:

```css
--shadow-elevated: 0 12px 32px rgb(37 42 45 / 13%), 0 1px 2px rgb(37 42 45 / 10%);
```

Dark default:

```css
--shadow-elevated: 0 10px 30px rgb(0 0 0 / 22%), 0 1px 2px rgb(0 0 0 / 28%);
--shadow-composer: 0 5px 18px rgb(0 0 0 / 16%), 0 0 0 1px var(--color-border-subtle);
```

### 5.3 Falloff recipe

Rails only. A 150px vertical mix from panel into rail. Same numbers on the chat sidebar and the settings nav. Copy both or the two rails will disagree.

```css
background: linear-gradient(
  180deg,
  color-mix(in srgb, var(--color-surface-panel) 55%, var(--color-rail)) 0%,
  var(--color-rail) 150px
);
```

Do not fall off the whole window. Do not use a radial spotlight. Do not put this gradient on a button.

### 5.4 Chip fill recipe

```css
background: linear-gradient(
  180deg,
  color-mix(in srgb, var(--color-layer-2) 55%, var(--color-layer-1)),
  var(--color-layer-1)
);
```

Hover flattens to `var(--color-layer-2)`. Active mixes in a breath of accent-soft. The gradient is the rest state; hover is the lift.

### 5.5 Border recipe

Hairlines first. A control at rest uses `border-subtle` or a 70% mix of `border-base`. Hover uses `border-strong`. Focus is a 2px ring at `focus.ring`, offset 2px, never a glow blob.

```css
border: 1px solid color-mix(in srgb, var(--color-border-base) 70%, transparent);
```

Primary filled buttons carry **no lighter ring**. The fill is the shape. `border: 1px solid transparent` so the box does not shift against outlined siblings.

### 5.6 When to elevate

| Surface | Elevation |
|---|---|
| Canvas, transcript, settings page | None. Canvas color. |
| Sidebar / settings rail | Falloff + 4% inset. No drop. |
| Raised chip (New chat, primary) | Inset 5% + 1–2px drop |
| Composer, approval, queue shelf | Inset 3% white + 12–34px drop |
| Menu, tooltip, compact action menu | `--shadow-elevated` |
| Modal | 24px / 60px drop, 45% black. Larger than menus on purpose. |
| Dragged row | `--shadow-elevated` while held |

If two adjacent surfaces both have a 30px drop, one of them should lose it.

---

## 6. Surface recipes

### 6.1 Rail

The left rail (and the settings nav that replaces it) is a continuous slab with a whisper of vertical falloff, a top-edge highlight, a hairline on the inner edge, and a rounded outer corner.

```css
.rail {
  width: var(--sidebar-width, 272px);
  padding: 12px 6px 8px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--color-surface-panel) 55%, var(--color-rail)) 0%,
    var(--color-rail) 150px
  );
  border-right: 1px solid var(--color-border-subtle);
  border-top-right-radius: var(--radius-panel);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-text-primary) 4%, transparent);
  overflow: hidden;
}
```

Rows sit flush to the rail width. The scrollbar is a 3px hover-reveal on the **outer** edge so it never shoulders the labels. Do not inset the list in a nested card.

Opening and closing the rail animates a **slot**, not the panel:

- The slot’s `width` / `min-width` eases on `--duration-slow` with the panel-slot curve.
- The panel inside keeps its full width.
- The result is a reveal, not a squishy reflow.

While the user drags a resize handle, kill the width transition. A rail that eases behind the pointer feels broken, not tactile.

### 6.2 Raised chip

The New-action button is the canonical gel object. Every “create” control should be this, not a flat ghost.

```css
.raised-chip {
  height: 34px;
  padding: 0 7px 0 9px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid color-mix(in srgb, var(--color-border-base) 70%, transparent);
  border-radius: var(--radius-control);
  color: var(--color-text-primary);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--color-layer-2) 55%, var(--color-layer-1)),
    var(--color-layer-1)
  );
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--color-text-primary) 5%, transparent),
    0 1px 2px color-mix(in srgb, black 18%, transparent);
  transition:
    border-color var(--duration-fast) var(--ease-standard),
    box-shadow var(--duration-fast) var(--ease-standard),
    background var(--duration-fast) var(--ease-standard);
}

.raised-chip:hover {
  background: var(--color-layer-2);
  border-color: var(--color-border-strong);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--color-text-primary) 7%, transparent),
    0 2px 6px color-mix(in srgb, black 22%, transparent);
}

.raised-chip:active {
  transform: translateY(0.5px);
  background: color-mix(in srgb, var(--color-layer-2) 88%, var(--color-accent-soft));
}
```

Label: 12.5px / 600 / −0.01em. Leading icon at 15px, 0.88 opacity. Optional `kbd` on the trailing edge.

### 6.3 Floating composer

A single elevated shell. Not a toolbar. Not a card around the page.

```css
.composer {
  width: min(100%, 780px);
  margin: 0 auto;
  border: 1px solid transparent;
  border-radius: var(--radius-composer);
  background: var(--color-layer-1);
  box-shadow:
    0 12px 34px color-mix(in srgb, black 18%, transparent),
    inset 0 1px color-mix(in srgb, white 3%, transparent);
}

.composer:focus-within {
  border-color: color-mix(in srgb, var(--color-focus) 42%, var(--color-border-base));
}
```

Anything that must sit on the same column (approval, queue shelf) uses the same width cap, the same 24px side inset, and the same radius so the top curve continues the composer rather than stacking a different-shaped card on it.

The queue tucks **behind** the composer. The composer’s rounded bottom covers the shelf’s bottom corners. That continuity is the gel. Two stacked capsules with a gap is not.

### 6.4 Elevated menu

One menu surface for every select, overflow, and compact action list.

```css
.menu {
  min-width: max(100%, 174px);
  max-height: min(320px, calc(100vh - 24px));
  padding: 5px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-control);
  background: var(--color-elevated);
  box-shadow: var(--shadow-elevated);
  transform-origin: top right; /* flip to the open edge */
}
```

Enter with the **menu spring**. Exit in 120ms on the standard curve, slightly smaller (`scale: 0.98`) and 4px toward the origin. Options are 30px min, radius `control - 2px`, hover = `accent-soft`. Selected option is weight 600 with a trailing check at accent color.

`transform-origin` must match the trigger edge. A menu that springs from the wrong corner looks like it is falling out of the ceiling.

Because animated cards create stacking contexts, an open menu must lift its **whole containing card** above later siblings (`z-index: 60` on the open dropdown, `40` on the ancestor card).

### 6.5 Tooltip

Smaller than a menu. No interactive chrome. Portal it so overflow-clipped ancestors cannot clip it.

```css
.tooltip {
  max-width: 280px;
  padding: 5px 9px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-elevated);
  box-shadow: var(--shadow-elevated);
  pointer-events: none;
}
```

Label: 11px / 550 / 1.35. Enter with the **tooltip spring** from `scale: 0.92` plus a 4px offset away from the anchor. Exit in 100ms to `scale: 0.96`.

### 6.6 Modal

Opaque elevated card. Optional 3px backdrop blur over a 62% canvas mix. Always keep the opaque fallback.

```css
.modal-backdrop {
  background: color-mix(in srgb, var(--color-canvas) 62%, transparent);
  backdrop-filter: blur(3px);
}

.modal-card {
  width: min(440px, calc(100vw - 48px));
  padding: 20px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-elevated);
  box-shadow: 0 24px 60px rgb(0 0 0 / 0.45);
}
```

Enter: backdrop fades on `--duration-fast`. Card uses either the **modal spring** or a 400ms modal-glide from `translateY(12px) scale(0.965)`. No overshoot on the card. The gel is in the shadow and the radius, not in a bounce.

Title: 16px / 680 / −0.02em.

### 6.7 Quiet row

Navigation rows, settings items, file rows. No border. No drop. Radius `--radius-row`. Hover is a translucent layer-2 wash. Active is either the traveling pill or a soft accent wash — not both a pill and a left stripe unless you are marking a different dimension (for example a running task).

```css
.quiet-row {
  min-height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--radius-row);
  color: var(--color-text-secondary);
  background: transparent;
}

.quiet-row:hover {
  color: var(--color-text-primary);
  background: color-mix(in srgb, var(--color-layer-2) 72%, transparent);
}
```

Do not wrap each row in a card. Do not give idle rows a 1px border. The rail is the surface; the row is a hit area.

### 6.8 Hairline divider

Drawn as an overlay, not as margin collapse. The row below stays a clean hoverable pill.

```css
.row-with-rule::before {
  content: "";
  position: absolute;
  top: -5px;
  left: 6px;
  right: 6px;
  height: 1px;
  background: color-mix(in srgb, var(--color-border-subtle) 70%, transparent);
  pointer-events: none;
}
```

Inset 6px from the rail pad so the line does not run wall to wall. Full-bleed rules look like a different product.

---

## 7. Control recipes

### 7.1 Primary, secondary, ghost

Shared geometry, three fills.

```css
.button {
  min-height: 34px;
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border-radius: var(--radius-control);
  font-size: 13px;
  font-weight: 600;
}

.button-primary {
  border: 1px solid transparent;
  background: var(--color-accent);
  color: var(--color-accent-text);
  box-shadow: 0 1px 2px color-mix(in srgb, black 24%, transparent);
}

.button-primary:hover { background: var(--color-accent-hover); }
.button-primary:active { background: var(--color-accent-pressed); }

.button-secondary {
  border: 1px solid var(--color-border-base);
  background: var(--color-layer-1);
  color: var(--color-text-primary);
}

.button-secondary:hover {
  background: var(--color-layer-2);
  border-color: var(--color-border-strong);
}

.button-ghost {
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
}

.button-ghost:hover {
  background: var(--color-layer-2);
  color: var(--color-text-primary);
}
```

Press scale (see §14): primary / secondary / ghost go to **0.985**. Disabled primary is a quiet chip — 14% accent on layer-1, muted text, no shadow — not a washed-out fill that hides the label. Disabled secondary is opacity 0.46.

Small secondary: 30px height, 9px padding, 12px type.

Icons inside buttons: 16×16.

### 7.2 Icon button

```css
.icon-button {
  width: 32px;
  height: 32px;
  padding: 0;
  display: inline-grid;
  place-items: center;
  border: 1px solid var(--color-border-base);
  border-radius: var(--radius-control);
  background: var(--color-layer-1);
  color: var(--color-text-secondary);
}

.icon-button:hover {
  color: var(--color-text-primary);
  background: var(--color-layer-2);
  border-color: var(--color-border-strong);
}

.icon-button.subtle {
  border-color: transparent;
  background: transparent;
}

.icon-button.tiny {
  width: 26px;
  height: 26px;
  border: 0;
  background: transparent;
}

.icon-button svg {
  width: 16px;
  height: 16px;
  stroke-width: 1.7;
}
```

Press scale: **0.96**. Subtle icons in a brand row sit at 0.72 opacity and go to 1 on hover. Tiny icons in section headings sit at 0.7 and go to 1. That opacity step is the hover; they do not grow a fill unless they are a real tool.

### 7.3 Switch

A gel pill. The track is 38×22, radius 999. The knob is 16×16, inset 2px.

```css
.switch {
  width: 38px;
  height: 22px;
  border: 1px solid var(--color-border-strong);
  border-radius: 999px;
  background: var(--color-layer-2);
}

.switch span {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: var(--color-text-secondary);
}

.switch[data-checked="true"] {
  border-color: var(--color-accent);
  background: var(--color-accent);
}

.switch[data-checked="true"] span {
  transform: translateX(16px);
  background: var(--color-accent-text);
}
```

The jelly is the **hold squish**:

```css
.switch span {
  transition:
    transform var(--duration-moderate) var(--ease-emphasized),
    width var(--duration-fast) var(--ease-standard),
    background var(--duration-fast) var(--ease-standard);
}

.switch:not(:disabled):active span { width: 19px; }
.switch[data-checked="true"]:not(:disabled):active span {
  transform: translateX(13px); /* 16px travel minus the extra 3px of width */
}
```

Do not animate the track with a bounce. The knob is the body.

### 7.4 Dropdown trigger

Same 32px control as a secondary button, but it owns a chevron that rotates 180° on open (`--duration-fast`, standard ease). Open and hover share one treatment: primary text, strong border, layer-2 fill, and a 2px accent ring at 14% opacity.

```css
.dropdown-trigger:hover,
.dropdown[data-open="true"] .dropdown-trigger {
  color: var(--color-text-primary);
  border-color: var(--color-border-strong);
  background: var(--color-layer-2);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 14%, transparent);
}
```

Compact trigger: 29px, transparent rest, no border until hover. Used in dense toolbars so the closed state does not look like a row of pills.

### 7.5 Keyboard chip

```css
kbd {
  min-width: 24px;
  padding: 1px 5px;
  border: 1px solid var(--color-border-base);
  border-radius: 5px;
  color: var(--color-text-tertiary);
  background: color-mix(in srgb, var(--color-layer-2) 72%, transparent);
  font: 10px/16px var(--font-interface);
  text-align: center;
}
```

Radius 5px is intentional and stays 5px across presets. It is a tiny hardware-key mark, not a control. Do not put `kbd` on a 12px radius.

### 7.6 Status dots

6×6, radius 999. Idle is muted text at 55%. Live states get a 2px halo at 16–18% of the status color. Unread is a 5×5 accent dot with no halo.

Running / starting **breathe** (see §15). Waiting uses the warning halo. Failed uses the danger halo. Completed is success at 70% with no halo. Unread holds still.

Do not pulse unread. Unread is a fact, not an alarm.

---

## 8. Selection language

Selection is a **traveling pill**, not a paint job on the row.

One list-owned layer sits above row backgrounds and below row content. It moves with the **selection spring**. The active row stays transparent so hover and the pill do not fight.

```css
.traveling-selection {
  position: absolute;
  top: 0;
  left: 0;
  border-radius: var(--radius-row);
  background: var(--color-selection-active);
  pointer-events: none;
  z-index: 0;
}

.row { position: relative; z-index: 1; }
.row[data-active="true"] { background: transparent; }
.row:hover { background: color-mix(in srgb, var(--color-layer-2) 78%, transparent); }
.row[data-active="true"]:hover { background: transparent; }
```

Measure the active row relative to the list container. Animate `x`, `y`, `width`, `height` on the pill. Do not remount the pill. Do not fade it out and back in on each change.

Use the same pill on every vertical nav that shares metrics (chat list, settings categories, file trees if they are row-height siblings). A settings nav that paints a background while the chat list travels is two products in one window.

Left accent stripe (`inset 2px 0 var(--color-accent)`) is a **second dimension**: “this row is the current task,” not “this row is selected in a list.” Do not use both on the same list unless the stripe means something the pill does not.

In-place settle (`translateX(-2px)` → 0 on `--duration-fast`) is allowed only on trees that cannot own a shared pill. Prefer the pill.

---

## 9. Type recipes in situ

These pairings show up so often they are part of the look.

**Brand lockup.** 13.5px / 680 / −0.015em. The mark stays neutral on dark presets (`text-primary`). On light presets the mark mixes 68% accent into primary so it does not vanish on ivory.

**Row title + hint.** Title 12.5px / 520–600 / −0.01em, one line, ellipsis. Hint 10–10.5px / tertiary, one line. Gap 2–3px. Never a third line in a rail.

**Section eyebrow.** 10px / 650 / 0.07em / uppercase / tertiary at 88%. Height 26px. A disclosure chevron sits beside it at 10px and stays opacity 0 until the heading is hovered.

**Empty state.** Strong 12px / 650. Small 10.5px / tertiary. Dashed border at 70% of `border-strong`, radius panel, 14×12 padding. Hover tints the dash toward accent.

**Modal option.** 13px padding, 11px radius (near `md`), 13px gap to a 20px icon. Hover is an 8% accent wash and a 55% accent border. No drop shadow on the option; the modal already has one.

Do not use a display size above 16px in chrome. This language has no hero.

---

## 10. Color discipline

This file does not ship a palette. Palettes are product-specific. The discipline is portable.

- Components never own a literal hex. Tokens live in one theme layer. Tests may assert hex. Components may not.
- Surfaces are a stack: `canvas → rail → panel → layer1 → layer2 → elevated`. Each step is a small lift, not a new hue.
- Text is three steps: primary, secondary, muted. Inverse exists for filled accent.
- Accent is one family: primary, hover, pressed, subtle, text. A secondary accent is allowed for sliders and rare emphasis. It is not a second brand.
- Status (success, warning, danger, info) is muted and mineral. Each has a surface tint for banners. Do not use saturated traffic-light colors.
- Diff red/green is restrained and never hue-alone: signs, gutters, labels, and screen-reader text stay present.
- Mix with `color-mix(in srgb, …)` against tokens. That is how the gel stays theme-proof.
- Purple, violet, and magenta are not reserved product semantics. An accent may be cool or warm. It must not be a novelty gradient.

Focus ring, selection, and accent are three different tokens. A focused row is not a selected row is not an accent chip.

Forced colors: map to system keywords (`Canvas`, `CanvasText`, `Highlight`, `LinkText`). Shadows become `none`. The language survives as shape and motion, not as sheen.

---

## 11. Motion character

Motion has one job: **confirm that something moved or changed.**

It may:

- open a menu, rail, or drawer;
- move a selection pill;
- morph an icon that represents the new state;
- settle a newly mounted row or panel;
- breathe on a live status dot.

It may not:

- run while a model is “thinking” with no other state change;
- delay a selection;
- hide content behind an entrance;
- bounce more than once;
- animate `height` on a list of rows;
- fight a user’s drag.

The body of the motion is **gel**, not rubber. High stiffness, high damping, mass around 0.7. It overshoots a few percent and dies. If you can count two oscillations, the damping is too low.

---

## 12. Named springs

Use these objects. Do not invent a fourth mass. If a new surface needs motion, pick the nearest named spring.

```ts
export const springs = {
  menu:     { type: "spring", stiffness: 540, damping: 33, mass: 0.7 },
  droplet:  { type: "spring", stiffness: 540, damping: 32, mass: 0.7 },
  settle:   { type: "spring", stiffness: 540, damping: 38, mass: 0.7 },
  row:      { type: "spring", stiffness: 460, damping: 40, mass: 0.7 },
  selection:{ type: "spring", stiffness: 460, damping: 38, mass: 0.7 },
  modal:    { type: "spring", stiffness: 460, damping: 36, mass: 0.75 },
  dialog:   { type: "spring", stiffness: 460, damping: 38, mass: 0.74 },
  layout:   { type: "spring", stiffness: 430, damping: 34, mass: 0.72 },
  tab:      { type: "spring", stiffness: 390, damping: 34, mass: 0.82 },
  sheet:    { type: "spring", stiffness: 330, damping: 32, mass: 0.86 },
  railItem: { type: "spring", stiffness: 560, damping: 34, mass: 0.7 },
  railFold: { type: "spring", stiffness: 560, damping: 44, mass: 0.6 },
  tooltip:  { type: "spring", stiffness: 640, damping: 34, mass: 0.6 },
  glyph:    { type: "spring", stiffness: 480, damping: 24, mass: 0.58 },
} as const;
```

How to choose:

| Spring | Feels like | Use for |
|---|---|---|
| `menu` | Snaps open, tiny overshoot | Dropdowns, overflow menus, checklists |
| `droplet` | Same family, slightly livelier | Small chips that land into a shelf |
| `settle` | Same snap, more damping | Expanding a block to auto height |
| `row` | Softer than menu | Row expand / collapse |
| `selection` | Soft travel | Traveling pill, sliding tab indicator |
| `modal` | Heavier | Confirm dialogs |
| `dialog` | Modal’s sibling | Activation / permission dialogs |
| `layout` | Shared-layout morph | Pills that change width with their label |
| `tab` | Heavier layout | Segmented tabs that carry more mass |
| `sheet` | Slowest, heaviest | Large capability / settings sheets |
| `railItem` | Tight | Files / Git rows entering a rail |
| `railFold` | Tight and dry | Rail section fold. Almost no bounce. |
| `tooltip` | Fastest snap | Tooltips. Mass 0.6 so they do not lag the pointer. |
| `glyph` | Liveliest | Status marks on a 32px glyph. Do not use on panels. |

Reduced-motion twin for every spring:

```ts
const transition = reduceMotion ? { duration: 0 } : springs.menu;
```

Do not scale stiffness by motion scale. Either play the spring or do not. Scaling a spring by 0.35 makes it feel sick, not calm.

---

## 13. Named CSS transitions

When you are not in Motion, use the duration tokens and the two easings. A global baseline keeps idle controls from snapping:

```css
button,
input,
select,
textarea,
kbd,
[role="option"],
[role="menuitem"] {
  transition:
    color var(--duration-fast) var(--ease-standard),
    background-color var(--duration-fast) var(--ease-standard),
    border-color var(--duration-fast) var(--ease-standard),
    box-shadow var(--duration-fast) var(--ease-standard);
}
```

Do **not** put `transform` or `opacity` on that baseline. Those belong to springs. A baseline transform will fight inline spring styles and the gel dies.

Richer controls add transform on `--duration-instant` for press, and opacity when they fade. Interactive rows that share the sidebar language:

```css
.interactive {
  transition:
    color var(--duration-fast) var(--ease-standard),
    background var(--duration-fast) var(--ease-standard),
    border-color var(--duration-fast) var(--ease-standard),
    box-shadow var(--duration-fast) var(--ease-standard),
    opacity var(--duration-fast) var(--ease-standard),
    transform var(--duration-instant) var(--ease-standard);
}
```

---

## 14. Press and hover physics

| Control | Hover | Press |
|---|---|---|
| Raised chip | Stronger border, 7% inset, 2×6 drop | `translateY(0.5px)` |
| Primary / secondary / ghost | Fill / border step | `scale(0.985)` |
| Icon button, rail tab, menu option | Fill / color step | `scale(0.96)` |
| Git stage, file-tree row | Fill / color step | `scale(0.96)` |
| Queue / droplet action | — | `scale(0.9)` |
| Switch knob | — | Width 16 → 19px |
| Capability card | `translateY(-1px)` | Back to 0 |
| Settings gear icon | `rotate(45deg)` | Continues to `225deg` while the route launches |
| Quiet row | Layer-2 wash, primary text | No scale. The row is a surface, not a chip. |

Press must feel instant. That is why press uses `--duration-instant` (80ms) or a spring, never `--duration-moderate`.

Do not combine `scale(0.96)` and `translateY(0.5px)` on the same control. Pick one family: chips sink, compact squares squash.

`scale(0.9)` is reserved for tiny trailing actions (a queued-message dismiss). It is too much for a 34px button.

---

## 15. Enter and exit

Every entrance is a short settle from slightly below and slightly small. Every exit is faster and smaller than the entrance.

| Surface | Enter | Exit |
|---|---|---|
| Menu / dropdown | `opacity 0, y ±6, scale 0.96` → rest on `menu` spring | 120ms standard, `y ±4, scale 0.98` |
| Tooltip | `opacity 0, scale 0.92, 4px from anchor` on `tooltip` spring | 100ms, `scale 0.96` |
| Modal card | `translateY(12px) scale(0.965)`, 400ms modal-glide or `modal` spring | Instant unmount or 120ms fade |
| Modal backdrop | Fade, `--duration-fast` | Fade, `--duration-fast` |
| Panel body | `translateY(4px)`, `--duration-fast` | None. The slot closes. |
| Content / settings section | `translateY(5px)`, `--duration-moderate` | None |
| Context menu (CSS) | `translateY(-3px) scale(0.98)`, `--duration-fast` | None |
| Chat row cascade | `opacity 0, y -5, scale 0.985`, 180ms standard | 120ms exit, `ease [0.4, 0, 1, 1]` |
| Commit / file row | `translateX(-4px)`, `--duration-fast` | None |
| Composer / approval | `translateY(6px)`, 180ms | None |
| Route screen | Cross-fade in the same box. Exiting screen stays mounted underneath. | Fade |

Do not run a second entrance on a rail whose slot is already animating width. Double-move is the most common way this language goes wrong.

Menu items may cascade **behind** a springing panel: 280ms standard, `translateY(-5px)`, 24ms stagger, cap after the sixth item (144ms). The panel springs; the items do not each spring.

---

## 16. Icon language

Icons are **marks**, not illustrations.

- Stroke 1.7 on chrome icon-buttons. Stroke 2.0 on 24px morphing marks (folder).
- Size: 16 default, 15 in sidebar actions, 13 in compact dropdowns, 11 in inline diffs, 10 on disclosures and meta rows.
- `stroke-linecap: round`, `stroke-linejoin: round`. Square caps look mechanical.
- Color is `currentColor`. The parent row owns the color step.
- Opacity at rest is 0.85–0.88 on rail icons, 0.72 on quiet brand-row tools. Hover brings them to 1.
- No filled brand-color icons in chrome. Filled marks are for status dots and the rare empty-state glyph.

### 16.1 Morph, do not swap

If two states of an icon can share a path command structure, interpolate `d`. Segments that exist in only one state collapse to a point in the other. That is what lets the folder flap swing instead of popping between `Folder` and `FolderOpen`.

If they cannot share geometry, **rotate or translate the same mark**. Settings uses one gear. Disclosure uses one chevron. Dropdown uses one chevron. None of them swap SVGs.

### 16.2 Motion is the loading cue

When a control launches a route or a fold, the icon keeps moving through the wait. The settings gear turns past the 45° hover tease to 225° over 550ms emphasized while the screen cross-fades. You do not add a spinner next to it.

If the action can fail, the icon must be able to return. Do not leave it mid-rotation on an error.

### 16.3 No decorative motion on idle marks

An icon at rest is still. Breathing is for status dots and for glyphs that represent a running agent. A folder in a closed project group does not idle-animate.

---

## 17. Icon recipes

### 17.1 Folder flap

Two paths: back pocket and front flap. Closed and open variants share commands. Duration 300ms. Flap curve `[0.3, 1.4, 0.4, 1]`. Reduced motion: `duration: 0` (snap to the new `d`).

This is the reference jelly mark. If you add another morphing icon, copy this transition. Do not invent a second overshoot.

### 17.2 Settings gear

```css
.gear {
  transition: transform var(--duration-moderate) var(--ease-emphasized);
}
.row:hover .gear { transform: rotate(45deg); }
.row[data-launching="true"] .gear {
  transform: rotate(225deg);
  transition: transform 0.55s var(--ease-emphasized);
  color: var(--color-accent);
  opacity: 1;
}
```

45° is a tease. 225° is the trip. Both are the same mark.

### 17.3 Disclosure chevron

At rest: `rotate(-90deg)`, tertiary, 13×13 (10×10 inside an eyebrow). Open: `rotate(0deg)`. Open-right variant: `rotate(90deg)`. Transition: `--duration-fast` + emphasized.

In eyebrows the chevron is opacity 0 until hover or focus-visible. In rows it stays visible.

### 17.4 Dropdown chevron

13×13. Closed 0°. Open `rotate(180deg)`. Standard ease, `--duration-fast`. `duration: 0` when motion is none.

### 17.5 Switch knob

See §7.3. The knob is the icon. It translates 16px, squishes to 19px while held, and uses emphasized easing on the travel.

### 17.6 Agent / status glyph (optional)

If you need a 32–34px status mark: a faint blurred halo behind the stroke (`filter: blur(7px)`, opacity 0 on rest, 0.13–0.18 on hover, scale 0.76 → 1.18). Working states keep a 0.045 rest halo. Failed hover may squash (`scale(1.28, 0.92)`). This is the liveliest legal motion. Do not put it on a settings row.

Provider-tinted glyphs are product-specific. The halo recipe is portable; the palette is not.

---

## 18. Stagger and cascade

Lists may cascade. They may not wave.

```ts
const chatRowVariants = {
  hidden: { opacity: 0, y: -5, scale: 0.985 },
  visible: (stagger: number) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: 0.18,
      ease: [0.2, 0, 0, 1],
      delay: Math.min(stagger, 5) * 0.014,
    },
  }),
};
```

Rules:

- Stagger **14ms**.
- Cap the index at **5** (70ms). Row 40 waits the same as row 5.
- Animate `opacity` and `transform` only. The previous height-per-row attempt made the sidebar judder.
- Settings sections may delay 30ms and 60ms on the second and third blocks. Stop there.
- Menu items delay 24ms and cap at 144ms.

If the list is a refresh of the same rows, do not re-cascade. Entrance is for newly appearing rows.

---

## 19. Reduced motion

Three layers, all required.

**1. Scale the CSS durations.** `--motion-scale` multiplies instant / fast / moderate / slow. Reduced and system-reduce use `0.35`. None uses `0`.

**2. Kill springs.** Every Motion call branches:

```ts
transition={reduceMotion ? { duration: 0 } : springs.menu}
```

Also honor a product override (`data-motion="none"` on `:root`) in addition to `useReducedMotion()`. Users who want motion off in this app but not in the OS must win.

**3. Kill loops.** Streaming dots, attention throbs, status breath, gear spins, folder flaps: `animation: none` / `duration: 0`. The streaming caret may keep a step blink at 900ms; it is a cursor, not a celebration.

`data-motion="none"` also forces `scroll-behavior: auto` and sets animation / transition durations to 1ms with a single iteration so leftover keyframes cannot play.

Do not ship a “reduced” spring that still overshoots. Reduced means **crossfade or snap**.

---

## 20. Implementation notes

### 20.1 Tokens, not hex

Put the gel stack in CSS variables and recipes. A component that writes `#ffffff14` for a highlight will break the first light theme.

### 20.2 Slot, then panel

Animated open/close of a sidebar, right rail, or drawer is a slot whose width changes. The child keeps its design width. Overflow hidden on the slot. This is the anti-squish rule. Comment it in code so the next person does not “fix” it by animating the panel width.

### 20.3 Transform origin

Menus, tooltips, and overflow lists spring from the edge they opened from. Top-right default. Flip to top-left, bottom-right, or bottom-left with the placement. Wrong origin is immediately visible.

### 20.4 Stacking

Animated rows create stacking contexts. An open menu inside a card must lift the card. Portals (tooltips, overflow that would clip) escape to `document.body` and anchor from the trigger rect.

### 20.5 Hover-reveal scrollbars

Quiet surfaces (transcript, sidebar) use a transparent thumb that appears on hover / focus-within. Global thumbs are 10px, padded to 3px via a transparent border, radius full. Sidebar thumbs are 3px and ride the outer edge.

### 20.6 Focus

`:focus-visible` is a 2px `focus.ring` outline, offset 2px. Some compact rows use a 1px inset ring to avoid colliding with the traveling pill. Never rely on a color-only focus.

### 20.7 Density

Compact shrinks heights and padding. It does not shrink radii, shadows, highlight percentages, or spring mass. The gel stays; the chrome gets tighter.

### 20.8 Platform chrome

macOS sidebar material and Windows Mica/Acrylic are optional enhancements. The recipes above are the opaque fallback and the source of truth. If the OS material is off or the GPU is weak, the rail falloff and inset highlight still have to do the work.

### 20.9 What not to animate

- `height` on a list of rows
- `width` on a panel that also has wrapping text (animate the slot)
- `top` / `left` for selection (use transform on a measured pill)
- Filter blur on hover for ordinary controls
- Box-shadow on every frame of a 60-row cascade

---

## 21. Copying this into another project

Do these in order. Stop when the new UI feels related. You do not need Integrator’s screens.

1. **Install the tokens.** Radius ramp, duration ramp, two easings, surface stack, text stack, border pair, accent family, `--shadow-elevated`. Soft radius as default.
2. **Apply the one spatial rule.** Chrome may use §5. Content may not.
3. **Build four controls from recipes:** raised chip, icon button, quiet row, switch. If those four feel right, the rest will follow.
4. **Install the named springs.** Menu, selection, modal, tooltip. That is enough to start. Add `row` and `layout` when you have lists and shared-layout pills.
5. **Add traveling selection** to the first vertical nav. Do not paint active rows.
6. **Morph or rotate icons.** One folder or one gear is enough to set the tone. Ban SVG swaps in review.
7. **Wire reduced motion** before you ship the first spring.
8. **Restyle color last.** A new palette on these recipes will still feel like this. These recipes on a new motion language will not.

Acceptance check in the new product:

- A primary action sinks or squashes. It does not only change color.
- A sidebar is a continuous rail with falloff, not a column of cards.
- A menu springs from its trigger corner and exits faster than it entered.
- An icon that has two states morphs or rotates. It does not pop.
- A switch knob widens while held.
- Selection moves. It does not appear.
- `prefers-reduced-motion: reduce` produces snaps and fades, not small bounces.
- A paragraph of reading text has no drop shadow and no inner highlight.

If seven of those eight pass and the eighth is a documented exception, you are in the language. If four pass, you have a mood board.

---

## 22. What not to copy from Integrator

Leave these here. They are this product, not this style.

- Settings as a full-screen route that replaces the project rail
- Composer control layout (context left, runtime right)
- Git right-rail information architecture
- Diff red/green semantics beyond “do not use hue alone”
- The twenty-plus theme presets and their hex dumps
- Agent glyphs, provider colors, provider wordmarks
- Usage rings, token counts, approval dock placement
- Titlebar / window-chrome decisions
- The 16k-line `styles.css` as a dump

If you need Integrator’s workspace behavior, use [ui-ux-primitives.md](ui-ux-primitives.md). If you need Integrator’s token names and presets, use [design-system-contract.md](design-system-contract.md). If you need the feel, use this file.

---

## 23. Review checklist

Use this on a PR in any repo that claims the language.

**Material**

- [ ] No literal hex on a component
- [ ] Inner highlights are 3–7% mixes, not custom alphas
- [ ] Rails use the 150px falloff + 4% inset, not a flat fill
- [ ] Raised chips use the two-stop fill + inset + drop
- [ ] Composer-class shells use the 3% white inset + large drop
- [ ] Reading surfaces have no elevation
- [ ] One radius ramp. No ad-hoc 11px / 16px / 20px on new work
- [ ] Primary filled buttons have no lighter ring

**Motion**

- [ ] New springs are a named spring, not a new stiffness
- [ ] Press uses 0.96 / 0.985 / 0.5px, not a new scale
- [ ] Menus use `menu` in and 120ms out
- [ ] No height-per-row animation
- [ ] No second entrance on a slot that already animates width
- [ ] `transform-origin` matches the open edge
- [ ] Reduced motion snaps; loops die

**Icons**

- [ ] Stroke 1.7–2.0, round caps
- [ ] State change morphs or rotates
- [ ] Launching actions use the icon as the loading cue
- [ ] Idle marks do not loop

**Type**

- [ ] One interface font, one code font
- [ ] Titles 650–680 with negative tracking
- [ ] Eyebrows uppercase, 9.5–10px, wide tracking, tertiary
- [ ] No chrome type above 16px

**Selection**

- [ ] Vertical nav uses a traveling pill
- [ ] Active row background is transparent under the pill
- [ ] Hover wash yields to the pill

If a diff adds a new highlight percentage, a new spring mass, or a new press scale, it is a language change. Treat it like a token change. Do not merge it as a local tweak.

---

## 24. Source map

These are the Integrator files the recipes were distilled from. Use them when a number here and a number in code disagree — code wins, then come back and update this file.

| Recipe | Source |
|---|---|
| Tokens, radius presets, motion scale | `apps/desktop/src/theme.css`, `apps/desktop/src/theme.ts` |
| Rail, raised chip, quiet row, settings nav | `apps/desktop/src/styles.css` (`.task-sidebar`, `.new-task-button`, `.settings-navigation`) |
| Composer / approval / queue | `apps/desktop/src/styles.css` (`.composer`, `.approval-control`, `.queued-messages-surface`) |
| Buttons, icon button, switch squish | `apps/desktop/src/styles.css` (`.primary-button`, `.icon-button`, `.switch`) |
| Global press / enter / loops | `apps/desktop/src/styles.css` (`prefers-reduced-motion: no-preference` block) |
| Yield slots, tree guide, pin nudge | `apps/desktop/src/styles.css` (`.project-header-meta`, `.project-chat-list`, `.chat-pin-button`) |
| Shared glyph cell | `apps/desktop/src/styles.css` (`.git-file-glyph`) |
| Resize grip | `apps/desktop/src/styles.css` (`.resize-handle`) |
| File tabs | `apps/desktop/src/styles.css` (`.titlebar-file-tabs`) |
| Voice HUD / send stack | `apps/desktop/src/styles.css` (`.composer-voice-hud`, `.composer-send-stack`) |
| Menu spring | `apps/desktop/src/components/Dropdown.tsx`, `TaskSidebar.tsx` |
| Selection spring | `apps/desktop/src/components/TravelingSelection.tsx` |
| Folder flap | `apps/desktop/src/components/AnimatedFolderIcon.tsx` |
| Tooltip spring | `apps/desktop/src/components/Tooltip.tsx` |
| Droplet / queue | `apps/desktop/src/components/QueuedMessages.tsx` |
| Title cross-fade | `apps/desktop/src/App.tsx` (`.titlebar-title-copy`) |
| Sliding tab | `apps/desktop/src/components/SlidingTabIndicator.tsx` |
| Row cascade | `apps/desktop/src/components/TaskSidebar.tsx` (`chatRowVariants`) |
| Product freeze | `docs/design-system-contract.md` |

The folder icon is the only place the shipped code currently says “jelly” out loud. The rest of the app already speaks it. This file is that language, written down.

---

## 25. Blur allowlist

Blur is not a material. It is a **floating-layer exception**. If you catch yourself adding `backdrop-filter` to a sidebar, a settings section, or a button, you have left the language.

| Surface | Blur | Fallback |
|---|---|---|
| Modal / dialog backdrop | 3px over 62% canvas mix | The mix alone. Must stay readable with blur off. |
| Search modal backdrop | 6px over 58% canvas mix | Same. Search is a command palette, not a page. |
| Status pill, queue shelf, recovery shelf | 10px over 82% layer-1 | The 82% mix + 2×12 drop. These sit over live transcript. |
| Everything else | None | Opaque token. |

Windows software rendering and `transparency` disabled must still work. The mix and the drop do the work. The blur is a bonus on capable GPUs.

Do not stack blur on blur. A pill over a blurred modal is two exceptions colliding. Close one.

---

## 26. Yield slots

A lot of the jelly is **one seat that two things take turns occupying**. The count yields to actions. The file icon yields to stage. The pin yields to the overflow. Nothing grows a second column on hover. The row’s width does not change. The occupant swaps.

This is the most portable “how does this app feel alive” rule after the gel stack. If hover adds a new 24px column and shoves the title, you have broken it.

### 26.1 Count yields to tools

Project headers keep a 48×24 meta seat on the right. At rest it holds a 24px tabular count. On hover / focus-within / open menu, the count fades and scales out; a 24+24 pair (`…` and `+`) fades and scales in.

```css
.meta-seat { position: relative; width: 48px; height: 24px; }

.count {
  position: absolute;
  top: 0;
  right: 0;
  width: 24px;
  height: 24px;
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  transition:
    opacity var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-emphasized);
}

.actions {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: 24px 24px;
  opacity: 0;
  transform: translateY(-1px) scale(0.88);
  pointer-events: none;
  transition:
    opacity var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-emphasized);
}

.header:hover .count,
.meta:focus-within .count,
.group[data-menu-open="true"] .count {
  opacity: 0;
  transform: scale(0.82);
  pointer-events: none;
}

.header:hover .actions,
.meta:focus-within .actions,
.group[data-menu-open="true"] .actions {
  opacity: 1;
  transform: translateY(-1px) scale(1);
  pointer-events: auto;
}
```

The −1px lift is optical. The MoreHorizontal glyph sits a hair low against the chat-row `…`. Do not “fix” it to 0 without looking at both seats side by side.

The count’s seat is the `+`. The `…` takes the left 24. Ellipsis on the left, add in the count’s seat. Do not swap that.

### 26.2 Pin nudges, it does not jump

The pin shares a vertical with the project count and the chat `…`. At rest it sits `translate(20px, -50%)` so it occupies the trailing control column. On hover it slides 20px left — tight to the `…`, not a full control-width jump.

```css
.pin {
  position: absolute;
  top: 50%;
  right: 24px; /* hover seat: 4px into the 24px `…` box */
  width: 24px;
  height: 24px;
  transform: translate(20px, -50%); /* rest: right 24 − 20 = 4, flush */
  transition:
    transform 0.16s cubic-bezier(0.2, 0, 0, 1),
    color var(--duration-fast),
    background var(--duration-fast);
}

.row:hover .pin,
.row:focus-within .pin,
.row[data-menu-open="true"] .pin {
  transform: translate(0, -50%);
}
```

Search rows have no `…`, so the pin stays put. Do not animate a pin that has nowhere to yield.

### 26.3 Overflow scales in

The `…` on a chat row is opacity 0 and `scale(0.96)` at rest, `pointer-events: none`. Hover / focus / open: opacity 1, scale 1, pointer-events auto. Transition uses `--duration-moderate` + emphasized on transform, `--duration-fast` + standard on opacity. It arrives like a small gel drop, not a fade.

```css
.more {
  opacity: 0;
  transform: translateY(-50%) scale(0.96);
  pointer-events: none;
}

.row:hover .more,
.row:focus-within .more,
.more[aria-expanded="true"] {
  opacity: 1;
  transform: translateY(-50%) scale(1);
  pointer-events: auto;
}
```

The more button does **not** grow a fill on hover. Color goes primary. Background stays transparent. A fill here fights the traveling pill.

### 26.4 Shared glyph cell

The file-type icon and the stage/unstage action share one 20×22 cell. Hovering the row (or focusing the button) morphs the icon into the action. Same seat. Cross-scale, not a swap of two side-by-side marks.

```css
.glyph { position: relative; width: 20px; height: 22px; }

.file-icon {
  transition:
    opacity var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard);
}

.row:hover .file-icon,
.glyph:focus-within .file-icon {
  opacity: 0;
  transform: scale(0.55);
}

.action {
  position: absolute;
  inset: 0;
  opacity: 0;
  transform: scale(0.55);
  transition:
    opacity var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard);
}

.row:hover .action,
.glyph:focus-within .action {
  opacity: 1;
  transform: scale(1);
}
```

`0.55` is the yield scale. Use it whenever one mark hands a seat to another. Do not use `0.96` (that is press) and do not use `0` (that is a pop).

The outgoing mark scales down as the incoming mark scales up. They cross in the same 140ms. That cross is the gel.

### 26.5 Disclosure yields in eyebrows only

Section eyebrows hide the chevron at opacity 0. Hover or focus-visible brings it to 1. In ordinary rows the chevron stays visible — hiding it there makes the tree unreadable.

---

## 27. Tree guide

Nested lists do not get a per-row left border. A **single continuous 1px guide** runs down the list. Rows no longer carry their own left edge, so the traveling pill sits clear of the line.

```css
.tree::before {
  content: "";
  position: absolute;
  top: 3px;
  bottom: 8px;
  left: 12px; /* 24px disclosure column → center */
  width: 1px;
  background: color-mix(in srgb, var(--color-border-subtle) 90%, transparent);
  pointer-events: none;
}
```

Activity dots sit **on** the guide, not inside the row. A rail-colored 2px ring lifts the 6px dot off the line it rides.

```css
.dot-slot {
  position: absolute;
  top: 50%;
  left: -5px; /* centers a 6px dot on a guide at -2px */
  width: 6px;
  height: 6px;
  margin-top: -3px;
  pointer-events: none;
}

.dot {
  border-radius: var(--radius-full);
  box-shadow: 0 0 0 2px var(--color-rail);
}
```

A chat only earns a dot while streaming, waiting on an approval, or holding an unread reply. Idle chats have no dot. The line stays; the bead appears.

| Dot | Fill | Motion |
|---|---|---|
| Streaming | info 62% mixed into rail | `dot-throb-dim` 2.6s — opacity 0.45↔0.95, scale 0.9↔1.06 |
| Attention (needs the user) | warning | `dot-throb-bright` 1.5s — halo 0→4px at 16–45% warning |
| Unread | accent | Still |
| Unread failed | danger | Still |

Unread holds still. Attention is the only insistent pulse. Do not use the bright throb for “something happened.” That is what unread is for.

Fold the tree with **grid-track interpolation**, not `height: auto`:

```css
.clip {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition:
    grid-template-rows 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.clip[data-open="true"] {
  grid-template-rows: 1fr;
  opacity: 1;
}

.clip-inner { min-height: 0; overflow: hidden; }
```

When a menu inside the clip is open, set `overflow: visible` on the inner so the menu is not cropped. The track stays open.

---

## 28. Resize grip

The handle is not a seam. It is calm chrome that agrees with the scrollbar thumb.

- Hit area 8px, fully **inside** its panel so the animated slot’s overflow clip cannot hide it.
- Visible grip: 3×44, radius 999, centered in the hit area.
- Rest: transparent, `scale(0.55)`.
- Hover / focus: `scale(1)`, thumb tint — muted text at 45%.
- Dragging: same scale, accent at 55%, still translucent. Never a hard opaque line.

```css
.handle::after {
  border-radius: 99px;
  background-color: transparent;
  transform: scale(0.55);
  transition:
    background-color var(--duration-fast) var(--ease-emphasized),
    transform var(--duration-fast) var(--ease-emphasized);
}

.handle:hover::after,
.handle:focus-visible::after {
  transform: scale(1);
  background-color: color-mix(in srgb, var(--color-text-muted) 45%, transparent);
}

body[data-resizing="true"] .handle::after {
  transform: scale(1);
  background-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
}
```

While `data-resizing="true"` is on the body, **kill width transitions** on the rail. A rail that eases behind the pointer is the opposite of tactile.

The 0.55 rest scale is the same number as the shared glyph cell. Idle chrome is slightly small; attention brings it to 1.

---

## 29. Continuous silhouettes

Two adjacent surfaces must read as **one body** when they share a job. If they read as two stacked capsules, the gel is gone.

### 29.1 Composer + queue + recovery

The composer is z-index 7. The status/queue group is z-index 6, bottom-anchored, same 780px column, 24px side inset. When a queue exists, the group sits `bottom: -18px` so its rounded bottom tucks behind the composer. The two curves become one silhouette.

Queue rows are **divisions of that silhouette**, not their own pills. A 1px subtle border between rows. No per-row radius. Cap the stack at ~168px (~4 rows) and scroll inside so a long queue does not shove the shelf up the page.

New rows grow **upward** from the lower-right edge (`transform-origin: 100% 100%` on the row, `50% 100%` on the shelf). They enter on the `droplet` spring from `scale: 0.96, y: 8`. Exit direction is recorded at click time:

| Exit | Motion |
|---|---|
| Send now (up) | `y: -8, scale: 0.96`, 180ms exit curve |
| Return to composer (down) | `y: 12, scale: 0.9` |
| Discard | `x: 8, scale: 0.96` |

The run-vitals pill sits above the shelf and gets gently nudged as rows appear. It is a 999-radius chip, 11px tabular, 82% layer-1, 10px blur, 2×12 drop. It is the one legal pill that floats over the transcript.

### 29.2 File tabs + canvas

Open-file tabs dock beside the chat title, **bottom-aligned**, radius `8px 8px 0 0`. The active tab paints a 2px `layer-1` strip on its bottom edge at `bottom: -1px` so it reads as connected to the canvas, not as a chip hovering above it.

Tabs flex `0 1 168px`, min 56, max 220. A container query at 62px hides the label and centers the icon. The strip never wraps to a second titlebar line; it scrolls horizontally with the scrollbar hidden. Cursor is grab / grabbing.

The chat title remains the way home. Changing the title cross-fades with a 2px rise and a 2px blur, 200ms standard, keyed on the title string. Layout of the title cluster uses the panel-slot curve at 340ms. This is the rare legal blur — on **text during a title change**, not on a surface.

### 29.3 Titlebar divider

A 1px workspace divider sits under the titlebar at opacity 0. It only appears when a subagent pane is visible, and it insets to the sidebar / rail widths so it does not draw across chrome the user is not in. Do not leave a permanent hairline under the titlebar; the canvas and the bar are one sheet until a second workspace opens.

---

## 30. Hover-reveal catalog

Quiet chrome reveals tools on hover. The reveal is the interaction. A tool that is always visible in a rail row is a different density.

| Seat | Rest | Hover / focus / open |
|---|---|---|
| Project count | Visible, tabular 9.5px | Opacity 0, scale 0.82 |
| Project `…` / `+` | Opacity 0, scale 0.88, −1px | Opacity 1, scale 1, −1px |
| Chat `…` | Opacity 0, scale 0.96 | Opacity 1, scale 1 |
| Chat pin | Translated 20px into the `…` seat | Translated 0, tight to `…` |
| Eyebrow disclosure | Opacity 0 | Opacity 1 |
| Sidebar scrollbar | Transparent thumb | Muted 40–64% |
| Transcript scrollbar | Same | Same |
| Resize grip | Transparent, scale 0.55 | Thumb tint, scale 1 |
| Git file icon | Visible | Scale 0.55, opacity 0 |
| Git stage action | Opacity 0, scale 0.55 | Opacity 1, scale 1 |
| Brand-row icon button | Opacity 0.72 | 1 |
| Section heading icon | Opacity 0.7 | 1 |

Pointer-events stay `none` on hidden occupants so a hover on empty chrome does not accidentally click a 0-opacity button. Open state (`aria-expanded`, `data-menu-open`) keeps the occupant visible after the pointer leaves.

---

## 31. Optical corrections

The language includes a handful of **sub-pixel lies**. They are load-bearing. Document them so nobody “cleans them up.”

| Lie | Why |
|---|---|
| Project actions `translateY(-1px)` | MoreHorizontal sits low against the chat-row `…` |
| Project meta `margin-right: 5px` | 3px sat a hair too far out vs the heading inset and the chat `…` at 4px |
| Pin rest `translate(20px)` not 24px | A full 24px jump feels like a different control arriving |
| Chat `…` at `right: 4px` | Aligns with the project `+` seat |
| Tree guide at `left: 12px` | Center of the 24px disclosure column |
| Dot at `left: -5px` | Centers 6px on a guide that lives at −2px relative to the row |
| File-tab connector at `bottom: -1px` | Seals the gap to the canvas hairline |
| `kbd` radius locked at 5px | Hardware-key mark. Does not follow the radius preset |
| Modal option radius 11px | Near `md` on Soft. A one-off that should have been `md`; do not add a 13th |

If you are tempted to round these to the grid, look at the pair they were tuned against first.

---

## 32. Floating chrome

Small surfaces that escape their parent. All of them use the elevated-menu family, not the raised-chip family.

### 32.1 Autocomplete

Docks 6px above the composer, inset 10px from the composer’s sides. Max-height 264px. Radius 10px (`md`). Padding 4px. Shadow `0 16px 40px` at 40% black — heavier than a menu because it sits over the transcript. Options 11.5px, radius 7px, 6×9 padding.

Suggestion names use the **same accent-bold as the token they will insert** (accent, weight 650). The popup previews the draft. Disabled suggestions drop to secondary / 500.

### 32.2 Selection popover

Fixed, z-index 80, `translateX(-50%)` over a text selection. Padding 3px, gap 2px, radius 9px, shadow `0 10px 28px` at 38% black. Buttons 11px, 4×8, radius 6px, 12px accent icon. Hover is accent-soft, not layer-2 — this popover is an action, not a nav row.

### 32.3 Search palette

Not a page. A 600px elevated card, radius `lg`, shadow elevated, dropped from `min(14vh, 112px)` under a 6px-blur / 58% canvas backdrop. Header is a 40px quiet field. Results reuse chat-row shells so the palette and the sidebar speak the same row language. Search is the one place a chat row may show a second meta line (9.5px / 1.1). Tree rows stay single-line; status lives in the dot and the tooltip.

### 32.4 Titlebar menu

Min-width 156px, padding 5px, gap 2px, radius 9px, shadow `0 12px 30px` at 32% black. Items 28px / 11px / radius 6px. Origin top-left, 5px below the trigger, 5px left-shifted so it hangs from the menu label, not from the window edge.

### 32.5 Jump-to-latest

Sticky pill inside the transcript, `top: 28px` so it clears the transcript’s top fade mask. Radius 999, 11px / 600, 96% layer-2, 6×18 drop. Hover tints the border toward accent. This is a wayfinding chip, not a primary button.

### 32.6 Quiet search field

Settings search and sidebar search share a recipe: 30px, transparent border, 55% layer-1 fill. Hover lifts the fill to 72%. Focus-within adds a 45% focus/strong border and a 3px ring at 14% focus. The icon stays 14px tertiary until focus.

Do not put a permanent border on a search field at rest. Rest is a quiet well. Focus is the only time it becomes a control.

---

## 33. Segmented controls and sliding tabs

Two selection languages for compact chrome. Neither is a traveling pill. Do not mix all three in one toolbar.

**Segmented** (diff layout, density-like choices): 2px padding, control radius, layer-1 well, 1px base border. Buttons 28px / 11px, radius `control - 3px`. Active is layer-2 plus an inset 1px subtle ring. Compact is 26px / 9.5px / 12px icon. The active segment is a recessed gel chip inside the well.

**Sliding underline** (titlebar view tabs, rail tabs): a 2px accent bar, radius `2px 2px 0 0`, inset 8px from the tab cluster. It uses the **selection spring** via `layoutId`. Reduced motion drops `layoutId` so the bar teleports. The bar is the traveler; the buttons only change type color.

Do not put a traveling pill and a sliding underline on the same set of tabs.

---

## 34. Composer internals

The shell is §6.3. The guts have their own rules.

### 34.1 Control row

Context / permission / attach on the left. Runtime / model / effort / mic / send on the right. At `container composer (max-width: 620px)` the optional cluster hides, overflow collapses into a menu, effort loses its leading icon and locks to 68px, model/route use `cqw`, mic collapses to a 19px caret.

The composer is a container. Density changes with its own width, not only with the window.

### 34.2 Send / stop

Send is a filled accent chip. Disabled is opacity 0.38, not the washed primary-disabled chip — this one is an icon, not a label. Stop is danger 82% on layer-1 with a 60% danger border, 10px filled square.

When a draft coexists with a running turn, stop **stacks** `bottom: calc(100% + 8px)` above send. It does not consume row height and it does not cover send. Two states, one seat on the x-axis, a second seat on the y-axis only while both are live.

### 34.3 Mic and device caret

Recording fills the mic and tints the well danger 12% (18% hover). Transcribing is tertiary, not animated. The device picker is a bare 11px caret hugging the mic (`margin-left: -6px`), label hidden. Names exist only inside the open menu. A closed composer does not show “MacBook Pro Microphone.”

### 34.4 Voice HUD

Pinned to the composer’s top-right (9 / 13). Pointer-events none. Three 3×14 bars, radius 2px, danger fill, `scaleY` from 0.18, transform-origin center. **Bar heights come from an animation frame, never from React state.** A 10px / 650 tabular timer sits beside them and turns warning when time is short. The hint is 10px / 550 tertiary.

This is the one place motion is driven by a signal (input level), not by a state change. It still dies under reduced motion.

### 34.5 Status lines

Footnotes and connection status **float over** the footnote strip. They do not stack below the composer. Appearing or disappearing text must not shift the composer. If a status needs more than one line, it is a notice card, not a footnote.

### 34.6 Token mirror

Skill and mention tokens are accent / 700 in a mirror layer under a transparent textarea. Selection on the textarea stays color-transparent so the browser cannot flash unstyled glyphs over the accent mirror. If you skip the mirror, the tokens will pop on select and the gel is gone.

---

## 35. Title and route motion

Screens stack in one box (`.app-screen { position: absolute; inset: 0 }`). The exiting screen keeps its layout underneath while the next one fades in. You do not unmount-then-mount a workspace. You do not slide the whole app.

The settings gear’s 225° turn is the loading cue for that cross-fade. Do not add a second spinner.

Title copy, when the string changes:

```ts
initial={{ opacity: 0, y: 2, filter: "blur(2px)" }}
animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
transition={{ duration: 0.2 * motionScale, ease: [0.2, 0, 0, 1] }}
```

`filter: blur` is legal here and nowhere else on chrome. At motion scale 0, `initial` is `false`.

---

## 36. Live marks that may loop

Loops are a short allowlist. Everything else is a one-shot.

| Mark | Duration | Curve | What it means |
|---|---|---|---|
| Status breathe (rail dots running/starting) | 2.4s | standard | Work is in flight |
| Chat dot dim throb | 2.6s | standard | This chat is streaming |
| Chat dot bright throb | 1.5s | standard | This chat needs you |
| Activity icon breathe | 1.4s | ease-in-out | This tool event is live |
| Pencil write | 0.85s | ease-in-out | The model is editing. Origin 70% 80%. −14° → −22° + 0.4/0.6px → −10° |
| Clock hand | 60s linear | linear | One revolution per minute, locked to the elapsed label |
| Settings / status spin | 0.9s / 1.2s | linear | A settings save or a connection wait. Prefer the gear recipe. |
| Git skeleton sheen | 1.9s | standard | 105° band, 3% text-primary, −70% → 70% |
| Agent glyph mechanical loop | 2.15–6.2s | `[0.72, 0, 0.28, 1]` | State-specific path motion on the 32px glyph |
| Voice bars | rAF | — | Input level |
| Streaming caret | 900ms steps(2) | — | Insertion point |

Pencil write is the most literal jelly loop: the mark itself is writing. Copy the origin and the three keyframes. A spinning pencil is wrong.

Clock sweep is the most literal time loop: the hand’s angle **is** the seconds in the label. Do not use a 1s spinner next to a clock.

Skeleton sheen is 3% — the same family as the inner highlight. A 20% sheen is a different product.

Agent glyph loops are product-specific choreography. The portable rule: if you need a 32px status mark, give each state a duration in the 2–6s band and a mechanical (not bounce) ease. Resting states do not loop.

---

## 37. Loading, not theater

| State | Treatment |
|---|---|
| Route / rail loading | 11px tertiary, centered. Rail gets 24px pad. Route min-height 220px. No spinner required. |
| Settings save | `.spin` 0.9s linear on the acting icon, or the gear 225° |
| Git refresh | Whole panel opacity 0.92. No sheen on live data. |
| Git first paint | Skeleton geometry that matches the real rows (34px files, 47px commits, 9px graph nodes, 1px guide at 18% accent). Sheen 1.9s. Enter 140ms fade. |
| Disabled primary | Quiet 14% accent chip, muted text, no shadow |
| Disabled send | Opacity 0.38 |
| Disabled secondary | Opacity 0.46 |
| Disabled icon / pin | Opacity 0.55, cursor default |
| Disabled menu option | Opacity 0.48, cursor not-allowed |
| Disabled autocomplete | Opacity 0.58 |
| Dragged queue row | Opacity 0.45 |
| Drop target | `accent-soft` wash |

Skeletons mimic the **real layout**, including the tree guide and graph nodes. A stack of 8px gray bars is not this language.

---

## 38. Danger language

Danger is quiet until it is the action.

- Stop / destructive fill: danger 82% on layer-1, 60% danger border.
- Recording well: danger 12% (18% hover). The mic fills.
- Menu item: danger text. Hover is danger 12% on layer-2, not a red fill.
- Unread-failed dot: danger, still.
- Failed chat meta (search only): danger text.
- Failed status dot: danger + 16% halo.

Do not use a red raised chip for “Delete” in a row. The menu item is enough. A red chip in a rail is an alarm, and this language has one alarm: the attention throb.

---

## 39. Capability and browse cards

These are the rare **content-adjacent** cards. They live in settings / marketplace, not in the transcript.

- 13px padding, 11px radius, 7px gap, 1px subtle border, layer-1 fill.
- Interactive hover: border mixes 48% accent, fill mixes 58% layer-2, `translateY(-1px)` in 160ms.
- Active press returns to `translateY(0)`.
- Selected: 34% accent border, no lift.
- Focus-visible: 2px accent outline, offset 2px.
- Tile 30×24, glyph 18px.

This is the one place the shipped CSS still says `ease` instead of `--ease-standard`. Treat that as drift. New cards use the standard curve and `--duration-fast`.

Do not put these cards in a rail. Do not put an inner highlight on them. They are outlined tiles, not gel chips.

---

## 40. Attachments and inline chips

User attachments under a sent message: 10.5px, 3×7 padding (3px if image), 8px radius, 72% layer-1, 1px subtle, 6px gap, max 220px. Images 200×140, 6px radius. They are echoes, not cards. No drop shadow.

Inline diff actions: 20px height, 10px / 500, radius `control - 3px`, 11px icon. Hover is layer-2. Reviewed tints to diff-add text. Once Git owns the edit, the pair becomes a caption (`.diff-inline-state`), not a control.

---

## 41. Z-index scale

Do not invent 999. Use the seats.

| Seat | Z | Why |
|---|---|---|
| Traveling pill | 0 | Under row content |
| Row content / titlebar menus under content | 1 | Default |
| Pin, more, file-tab active, sliding bits | 2–4 | Above the row, below menus |
| Queue / recovery / jump-to-latest | 6 | Over transcript, under composer |
| Composer | 7 | Owns the column |
| Approval | 8 | Over the status shelf |
| Resize handle | 12 | Inside the panel, above its content |
| Project group with open menu | 20 | Sibling groups must not cover the menu |
| Titlebar / subagent slot | 25–50 | Over the workspace |
| Dropdown menu | 50 | |
| Open dropdown (lifts the card) | 60 | Ancestor card 40 |
| Autocomplete | 40 | Above composer chrome, below dialogs |
| Chat overflow (portaled) | 45 | |
| Titlebar File/Edit/View | 60 | |
| Agent / file context, selection popover | 80 | |
| Modal, tooltip, search backdrop | 90–110 | Search 110 so it can open over a modal |
| MCP / permission overlay | 120 | Highest product chrome |
| Skip link | 1000 | Accessibility escape |

Animated cards create stacking contexts. An open menu must lift its **owner** (`data-menu-open` on the project group, `z-index: 60` on the open dropdown). Portals (chat overflow, tooltips) escape to `document.body` and anchor from the trigger rect, with a flip-up when the row is near the rail bottom.

---

## 42. Tabular numbers and clocks

Any figure that will change width while live is `font-variant-numeric: tabular-nums`: elapsed time, usage, project counts, voice timer, file line numbers.

The run-vitals clock hand rotates once per 60s, origin at the 12×12 view’s center (6, 6). The label beside it is the same clock. If they disagree, the icon is decoration and must go.

Line numbers in the file reader are 10px tabular tertiary. The line hover is a 70% layer-2 wash. Do not highlight the number independently of the line.

---

## 43. Menu law

- A separator never leads, trails, or doubles up. Hidden items do not leave two rules in a row.
- Danger items use §38. They do not get a filled red row.
- Disabled items stay in the menu when the action exists but is unavailable. The tooltip may receive hover when the item cannot (`pointer-events` on the wrapper). Do not omit the item and surprise the user.
- Compact action menus: 4px padding, control radius, elevated shadow, 32px items, row radius.
- Commit / split menus spring the panel and cascade the items 24ms behind it (§15). Do not also run `context-menu-in` on a springing panel — the keyframe and the spring will double-play.

Overflow placement: measure room below vs above the trigger inside the rail. Flip up when below is tighter. Width ~200px. Chat actions ~258px tall; project actions ~204px. Portal when the rail clips.

---

## 44. Brand mark

The mark is a white alpha PNG used as a **mask**, painted with `--brand-mark-ink`. It is never drawn as a white image (invisible on light themes) and never drawn as a colored PNG (breaks the next preset).

- Frame 28×28, radius 8px, no fill.
- Glyph 23×18 inside the frame.
- Dark presets: ink = `text-primary`.
- Light presets: ink = 68% accent mixed into primary.
- Name: 13.5 / 680 / −0.015em.

The mark does not animate. Theme color belongs to the interface around the identity, not inside it.

---

## 45. Transcript-adjacent motion

The transcript is a reading surface. It still has a few chrome moments:

- New turns enter with `content-enter` (`translateY(5px)`, `--duration-fast`).
- Live narration is a **single line**. Wording changes ticker through a fixed-height window. The row does not grow.
- Search matches get an inset 3px accent stripe at 42%. The current match is solid accent. Hue is not the only signal; the stripe is.
- Wide pre / table blocks scroll themselves. The transcript never pans sideways as a whole.
- The top of the transcript may fade with a mask. Anything that must stay readable (jump-to-latest, recovery) sits below that mask (`top: 28px`) or above it in z.

Do not card the bubbles. User and agent turns are typography plus a quiet metadata line (model + time, 10-ish, tertiary). Actions are icon-only; labels live in the tooltip.

---

## 46. Complete keyframe list

If it is not in this table, do not add a new named keyframe without adding it here.

| Name | From | To / beat | Used on |
|---|---|---|---|
| `status-breathe` | opacity 1 | 0.55 at 50% | Rail running dots |
| `dot-throb-dim` | opacity 0.45, scale 0.9 | 0.95 / 1.06 | Streaming chat dot |
| `dot-throb-bright` | halo 0 | halo 4px | Attention chat dot |
| `scheduled-dot-throb` | — | 1.6s standard | Scheduled rail |
| `activity-icon-breathe` | opacity 0.55 | 1 | Live tool icon |
| `activity-pencil-write` | −14° | −22° then −10°, sub-px translate | Writing pencil |
| `clock-sweep` | 0° | 360° / 60s | Elapsed hand |
| `status-spin` | — | 360° / 1.2s | Connection wait |
| `settings-spin` | — | 360° / 0.9s | Settings save |
| `selection-ask-spin` | — | — | Ask-user spinner |
| `terminal-status-pulse` | — | — | Terminal live |
| `git-skeleton-enter` | opacity 0 | 1 / 140ms | Skeleton mount |
| `git-skeleton-sheen` | translateX −70% | 70% / 1.9s | Skeleton band |
| `backdrop-in` / `modal-backdrop-in` | opacity 0 | 1 | Modal / search |
| `modal-settle` / `modal-card-in` | y 8–12, scale 0.965–0.97 | rest | Modal card |
| `panel-enter` | y 4 | 0 | Rail panel body |
| `content-enter` | y 5 | 0 | Turns, settings sections |
| `row-slide-in` | x −4 | 0 | Commit / file rows |
| `commit-menu-item-in` | y −5 | 0, 24ms stagger | Menu items behind a spring |
| `context-menu-in` / `enter` | y −3, scale 0.98 | rest | CSS-only menus |
| `approval-enter` | y 6 | 0 / 180ms | Approval card |
| `runtime-connection-in` | — | — | Runtime chip |
| `task-now-in` | — | — | Live narration |
| `task-now-ellipsis-dot` | — | — | Narration ellipsis |
| `selection-settle` | x −2 | 0 | Trees without a pill |
| `theme-cursor-blink` | opacity 1 | 0 at 50%, steps(2) | Streaming caret |

Prefer a named spring over a new keyframe. Keyframes are for CSS-only surfaces and for loops.

---

## 47. Known drift

The shipped app is the source, not a saint. These are places the code and the language currently disagree. When you touch them, move them toward the language. When you copy the language, do **not** copy the drift.

| Drift | In code | In this language |
|---|---|---|
| Capability card easing | `0.16s ease` | `--duration-fast` + `--ease-standard` |
| Composer radius fallback | `var(--radius-composer, 16px)` | Token is `--radius-md` (10 on Soft). 16 is leftover. |
| Modal option radius | 11px literal | `--radius-md` |
| Titlebar menu radius | 9px literal | `--radius-control` |
| Autocomplete radius | 10px / 7px literals | `--radius-md` / `calc(var(--radius-control) - 2px)` |
| Selection popover radius | 9px / 6px literals | `--radius-control` / `--radius-sm` |
| File-tab top radius | 8px literal | Near `--radius-sm` + 2. Acceptable as a connected-tab shape |
| `kbd` radius | 5px literal | Keep. Hardware-key exception |
| Agent glyph loops | `easeInOut` in one helper | Mechanical `[0.72, 0, 0.28, 1]` for loops |
| A few `z-index` jumps | 8, 19, 25, 70 | Snap to the scale in §41 when you touch the file |

Literal radii that track Soft’s `sm`/`md` will go wrong the moment a user picks Square or Round. That is why the language wants tokens.

---

## 48. Deeper acceptance

On top of §21 and §23, a port is not done until these also pass:

- [ ] Hover does not change a row’s width. Occupants yield a seat.
- [ ] Nested lists use one guide line. Dots sit on the line with a rail-colored ring.
- [ ] Folds use grid-track interpolation, not `height: auto`.
- [ ] Resize grips scale from 0.55 and tint like the scrollbar, then warm to accent while dragging.
- [ ] Rails do not ease while the pointer is dragging them.
- [ ] Composer + queue share one silhouette. Queue rows are divisions, not pills.
- [ ] File tabs connect to the canvas with a 2px underside, radius only on top.
- [ ] One mark hands a seat to another at scale 0.55, 140ms, same cell.
- [ ] Pin nudges 20px, not 24px.
- [ ] Overflow `…` scales 0.96 → 1 and does not paint a fill.
- [ ] Search fields are borderless wells until focus.
- [ ] Autocomplete tokens preview the draft’s accent-bold.
- [ ] Voice bars are rAF transforms, not React state.
- [ ] Title changes may blur 2px. Surfaces may not.
- [ ] Loops are on the §36 list or they do not ship.
- [ ] Skeletons copy real geometry, including guides.
- [ ] Danger in a menu is text + 12% wash, not a red chip.
- [ ] Blur is on the §25 allowlist.
- [ ] `font-variant-numeric: tabular-nums` on every live figure.
- [ ] Open menus lift their owner or portal out.
- [ ] Optical −1px / 5px / 20px lies are preserved or retuned in pairs, not rounded away.

If a new control needs a rule that is not in this file, write the rule here first. A one-off that feels right today is how the language dies tomorrow.

