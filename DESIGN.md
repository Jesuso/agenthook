---
name: agenthook
description: A status board for a pipeline of coding agents — quiet at rest, lit only where a human is needed.
colors:
  accent: "#5b9bff"
  accent-fg: "#0b0d10"
  success: "#3fb950"
  bg: "#0b0d10"
  surface: "#12161b"
  surface-raised: "#1a2027"
  overlay: "#212831"
  border-subtle: "#1c2128"
  border: "#2a313a"
  border-strong: "#3d4651"
  fg: "#e6e9ef"
  muted: "#9ba4b4"
  faint: "#6b7483"
  status-running: "#6cb0ff"
  status-running-bg: "#10243d"
  status-queued: "#a3b1c6"
  status-queued-bg: "#1b2330"
  status-held: "#e3b341"
  status-held-bg: "#2e2410"
  status-failed: "#ff7b72"
  status-failed-bg: "#351616"
  status-done: "#7fc79a"
  status-done-bg: "#142a1d"
  status-idle: "#9ba4b4"
  status-idle-bg: "#1a1f26"
  profile-sky: "#58b4e8"
  profile-indigo: "#8190f5"
  profile-violet: "#a98af0"
  profile-pink: "#ee7fb6"
  profile-teal: "#35c0a8"
  profile-cyan: "#3cc3d8"
  profile-slate: "#8d9db3"
  profile-stone: "#b8a48a"
typography:
  stat:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: "32px"
  heading:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "28px"
  title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "22px"
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
  section-label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: "16px"
    letterSpacing: "0.025em"
  meta:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "14px"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
rounded:
  sm: "3px"
  md: "5px"
  lg: "8px"
  full: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-raised}"
  nav-tab:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
  nav-tab-active:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.fg}"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "12px"
  pill-neutral:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0 8px"
  status-badge-held:
    backgroundColor: "{colors.status-held-bg}"
    textColor: "{colors.status-held}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 6px"
  status-badge-failed:
    backgroundColor: "{colors.status-failed-bg}"
    textColor: "{colors.status-failed}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 6px"
  status-badge-running:
    backgroundColor: "{colors.status-running-bg}"
    textColor: "{colors.status-running}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 6px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
---

# Design System: agenthook

## Overview

**Creative North Star: "The Air Traffic Board"**

The dashboard is a departures board for agent work. Every ticket is a flight: one row, the same
columns in the same place every time (state, id, title, step and age, the one action), so the eye
learns the board once and then only reads what changed. Colour means state and nothing else. A calm
board is a dark, even field of quiet rows; when something needs a human, that row is the only thing
on the screen that lights up. It is built to sit on a second monitor and be read in a glance from
across the desk.

Density is high and type is small (13px body), because the operator is technical and the board must
hold a whole profile without scrolling. Restraint is the default: flat tonal surfaces, hairline
borders, outline buttons, uppercase section labels in a muted tone. Emphasis is rationed so it keeps
its meaning.

The board is meant to feel humane, not clinical. Warmth comes first through words and moments:
plain-language reasons on every held or failed row, an explicit "all clear" when nothing needs you,
a quiet confirmation after an action instead of a row silently vanishing. The current palette is a
cool slate; a shift toward warm neutrals is the recorded direction (see Colors), not yet the
implementation. Dark is primary and light is first-class: both follow the system scheme, and every
text and status tier holds WCAG AA in both.

**Key Characteristics:**
- One ticket, one row, columns that line up across every list.
- Status hues reserved for state; profile hues reserved for identity.
- Flat, tonal, hairline-bordered; shadows only on floating layers.
- Monospace for ids, paths, durations, money; sans for everything a person reads.
- Small and dense, but never below AA; the faintest tier is furniture, not content.
- Warmth through copy and acknowledgement, not decoration.

## Colors

A cool slate field with one clear blue accent, a strict five-hue status language, and a separate
eight-hue identity palette that deliberately avoids the status hues. Frontmatter values are the dark
scheme (primary); light-scheme values live in `.impeccable/design.json` and in `ui/src/index.css`,
which is the source of truth and is enforced by `ui/src/tokens.test.ts`.

### Primary
- **Runway Blue** (accent): links, the active selection in segmented controls, focus rings, and the
  single filled button on a surface. Paired with Runway Ink (accent-fg) for text on it.

### Secondary
- **Clearance Green** (success): positive confirmation (a successful save, a merged PR). Not the same
  as the "done" status hue.

### Neutral
- **Night Apron** (bg): the page field behind everything.
- **Hangar Slate** (surface): cards, the app bar, the board's rows.
- **Raised Slate** (surface-raised): hover fills, neutral pills, the active nav tab.
- **Overlay Slate** (overlay): drawers, menus, popovers.
- **Hairline / Rule / Strong Rule** (border-subtle, border, border-strong): internal dividers, card
  outlines, emphasised edges.
- **Board White** (fg): titles and body text.
- **Dim Lamp** (muted): secondary text, section labels, meta that carries content (7:1 on surface).
- **Unlit** (faint): placeholders, separators, disabled. Holds 3:1 only.

### Status (state language)
- **Running** (status-running): blue, its dot pulses (static under reduced motion).
- **Queued** (status-queued): slate.
- **Held / Interrupted / Stalled** (status-held): amber, "waiting on a human or a restart".
- **Failed** (status-failed): red.
- **Done** (status-done): muted green, "agents finished" (copy says *Finished*).
- **Idle / Cancelled** (status-idle): neutral.
Each has an opaque `-bg` partner for badges.

Receiver liveness borrows two of them by meaning, never for decoration: **up** is `success` green,
**down** is held amber ("waiting on a restart"), in the status line and the stopped banner alike.
Standing profile properties (the fullAuto shield) use full-strength neutral, not a status hue.

### Profile identity
Sky, Indigo, Violet, Pink, Teal, Cyan, Slate, Stone (profile-*). Used for a profile's tinted emoji
tile, top bar or chip. No red, amber or green, so identity never reads as state.

### Named Rules
**The Colour Is State Rule.** A status hue appears only to say a ticket's state. Never decorate with
it, never use it on a button, never use it for a profile.

**The Identity Is Not State Rule.** Profile hues mark which profile you are looking at and nothing
else. They are held at 3:1 on every surface and kept off the status hues.

**The Unlit Rule.** Faint (#6b7483) is furniture: placeholders, separators, disabled controls. Any
text a person needs to read, including timestamps, costs and captions, uses Dim Lamp (muted) or
brighter. Faint at 11-12px on content fails AA.

**The Warm Drift Rule (provisional).** The recorded direction is to move the neutral surfaces from
cool slate toward warm neutrals in a future pass, keeping every AA guarantee and the status and
identity palettes intact. Until that pass lands, use the tokens as they are; don't hand-tint
individual surfaces.

## Typography

**Body Font:** the system sans stack (ui-sans-serif, system-ui, sans-serif)
**Label/Mono Font:** ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace

**Character:** A native, unbranded sans that disappears into the reading, paired with a system
monospace for anything a machine produced. The pairing is the board's split between what a person
reads and what the system reports.

### Hierarchy
- **Stat** (600, 28px, 32px): headline numbers in tiles. The largest type on the board.
- **Heading** (600, 20px, 28px): the subject of a detail page (an epic's name), under the 15px page title. Only one per page.
- **Title** (600, 15px, 22px): page and profile headings, the app name.
- **Body** (400, 13px, 20px): ticket titles, digest prose, reasons.
- **Label** (500, 12px, 16px): buttons, pills, badges, nav tabs, form controls.
- **Section label** (600, 12px, 0.025em, uppercase, muted): zone headings ("Now", "Progress").
- **Meta** (400, 11px, 14px): timestamps and counts beside content. Never the only carrier of
  meaning, never in faint.
- **Mono** (13px, or label size inline): ticket ids, paths, durations, model names, money.

### Named Rules
**The Machine Speaks Mono Rule.** Ids, paths, durations, costs and model names are monospace;
anything a person wrote or reads as language is sans.

**The One Heading Voice Rule.** Zone headings share one style. Don't mix uppercase labels with
sentence-case or lowercase headings on the same page.

## Layout

A single centered column (max width 72rem / `max-w-6xl`) under a sticky 44px app bar, with 24px
between zones and 8-12px inside them. Spacing is a 4px base scale. Lists are full-width rows inside a
bordered card, divided by hairlines, with fixed-width columns for state, step and age, and the action
so they align down the board; the title column flexes. Breakpoints follow Tailwind's defaults
(`sm` 640px, `md` 768px, `lg` 1024px); the app bar wraps its nav below `lg`. Tiles flow in a wrapping
row. The layout is tuned for a wide second screen first; narrow widths must keep the title and
reason readable before they keep secondary columns.

## Elevation & Depth

Flat by default. Depth is tonal: Night Apron, then Hangar Slate, then Raised Slate, then Overlay
Slate, each a step lighter, with hairline borders doing the separating. Shadows exist only on layers
that float above the board.

### Shadow Vocabulary
- **Float** (`shadow-lg`): menus, tooltips, popovers.
- **Drawer** (`shadow-xl`): the ticket drawer and modal dialogs.

### Named Rules
**The Flat Board Rule.** Nothing on the board itself casts a shadow. If it sits in the page flow, it
is separated by tone and hairline, not elevation.

## Shapes

Gently rounded and small: 3px on badges and inputs, 5px on buttons and tabs, 8px on cards and
panels, fully round on pills and status dots. Borders are 1px hairlines. The emoji profile tile is a
rounded square with an inset ring in the profile hue.

## Components

### Buttons
Flat, quiet, legible.
- **Shape:** gently rounded (5px).
- **Primary:** Runway Blue fill with Runway Ink text, 4px x 12px. One per surface, reserved for the
  consequential action.
- **Secondary:** hairline outline, Board White text, 2px x 8px; Raised Slate fill on hover. The
  default for row actions (Release…, Dismiss, PR #n).
- **Ghost / link:** muted text, Raised Slate on hover (app-bar links, quiet actions).
- **Focus:** 2px Runway Blue outline on `:focus-visible`, everywhere.
- **Disabled:** 50% opacity.

### Status badges and pills
- **Status badge:** a dot plus the state word in the status hue on its `-bg`, 3px corners. The
  running dot pulses.
- **Pill:** fully round, label size; neutral (muted on Raised Slate with a hairline) for counts,
  versions and step names.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** Hangar Slate.
- **Shadow Strategy:** none (see The Flat Board Rule).
- **Border:** 1px Rule; header separated by a Hairline.
- **Internal Padding:** 12px.

### Inputs / Fields
- **Style:** Hangar Slate fill, 1px Rule border, 3px corners, body-size text. Editors use CodeMirror
  in the mono face.
- **Focus:** 2px Runway Blue outline.

### Navigation
- **App bar:** sticky, Hangar Slate, bottom hairline. App name in Title weight; view tabs are label
  size, muted, capitalised; the active tab gets Raised Slate and Board White. Profile switcher is a
  compact select beside the profile's emoji tile.

### Board row (signature)
The unit of the whole system. State badge, mono ticket id (linked to the tracker), title with a
one-line reason beneath it, "step · age" in muted, and one action button in a fixed-width column.
Clicking the title opens the ticket drawer. Every list of tickets (Needs you, Now, All tickets)
follows this anatomy.

### Slot pips (signature)
A row of small dots showing busy versus free agent slots for a profile, beside "n / max".

## Do's and Don'ts

### Do:
- **Do** keep every ticket list on the board-row anatomy, with columns aligned down the list.
- **Do** use status hues only for state, and profile hues only for identity.
- **Do** put timestamps, costs and captions in muted (#9ba4b4) or brighter; keep faint for furniture.
- **Do** use monospace for ids, paths, durations, money and model names.
- **Do** give every interactive element the 2px Runway Blue `:focus-visible` outline.
- **Do** keep surfaces flat and tonal; shadows only on menus, popovers and drawers.
- **Do** say something humane when a list is empty or an action completes ("all clear", "released,
  re-running code").
- **Do** check every new colour against `ui/src/tokens.test.ts` in both schemes.

### Don't:
- **Don't** put faint (#6b7483) on any text a person must read.
- **Don't** use a filled accent button for more than one action per surface, or for an action that
  only reads.
- **Don't** colour a profile, a button or a decoration with a status hue.
- **Don't** mix heading styles (uppercase label, sentence case, lowercase) within one page.
- **Don't** add shadows to cards or rows on the board.
- **Don't** hand-tint surfaces toward warm before the Warm Drift pass; change the tokens, not the
  components.
