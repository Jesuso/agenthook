---
target: Overview page
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/home/nacho/projects/agenthook-ui-overview/ui/src/Overview.tsx"
target_fingerprint: "sha256:2c10170c2bec2835ef60984af09b2e918bfe2fbe52af2117e34258b870efdc4a"
target_path: /home/nacho/projects/agenthook-ui-overview/ui/src/Overview.tsx
timestamp: 2026-10-24T18-16-49Z
slug: ui-src-overview-tsx
---
# Critique: Overview (ui/src/Overview.tsx), after calm-state, drawer reason, colour, metrics, polish passes
Method: dual-agent (A: design review · B: detector + browser overlay). Both profiles, dark + light, 1440 / 600 / 375 px.

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Receiver, live dot, tab-title count, aria-live headline; "interrupted by restart" shows red failed though DESIGN maps interrupted to held |
| 2 | Match system / real world | 3 | Plain copy; bare numeric ids; Dismiss's "ticket stays failed on the board" only in a tooltip |
| 3 | User control and freedom | 3 | 5 s Undo, Ctrl+Z, Esc; the drawer has no actions |
| 4 | Consistency and standards | 2 | All tickets breaks board-row anatomy (lowercase headers, text-sm, redundant profile column, duplicate sr-only h2) |
| 5 | Error prevention | 3 | Deferred dismiss, inline Release |
| 6 | Recognition rather than recall | 3 | Hint shows j/k · ? but not r/d; full reasons only in title attributes |
| 7 | Flexibility and efficiency | 3 | j/k/r/d/Enter/Ctrl+Z; no key to All tickets/Activity; can't act from the drawer |
| 8 | Aesthetic and minimalist | 2 | Seven zones; cost in four places; tiles + caption + History strip |
| 9 | Error recovery | 2 | Reasons are raw log dumps; drawer outcome "—"; no remedy (Re-run is #550) |
| 10 | Help and documentation | 3 | ? sheet, empty-state copy; tooltips mouse-only |
| Total | | 27/40 | Acceptable, edge of Good (was 22 → 25) |

## Design Specificity Verdict
LLM: specific to the product — calm verdict in the headline slot, tab-title count, honest down-state copy, deferred Dismiss with focus kept in the list. Template remnants: three-tile Progress KPI row with an explainer caption; All tickets as a generic data grid.
Detector: CLI clean (all scopes). Browser: flat-type-hierarchy on both views, partly a false positive (it reads h2 elements at 12–13px while the hero h2s hold 28px spans; the real point is the 15px h1). At 375 px only: tight-leading on the History footer (11/14px) and a straggler. No overflow, no contrast failures (A measured every text tier ≥5:1). Last run's dark-glow confirmed absent from app elements.

## Priority Issues
- [P1] Failed rows: raw log dump as reason; title button's accessible name is ~600 chars of postgres log with no state or id; sighted users see it cut mid-line. Fix: short headline reason (first clause), log tail drawer-only; aria-label "{id} {title}, failed: {short reason}". Commands: harden, clarify.
- [P1] The ticket drawer is a dead end: no Dismiss / Release / PR action, failed run outcome "—", a stray "—" glyph. Fix: the row's primary action in the drawer header; outcome "failed". Commands: clarify, layout.
- [P2] Below-the-fold sprawl: tiles + caption + History, cost in four places. Fix: one Progress line ("8 finished today (yesterday 0) · $25.94 · rework 13% · History ▸"), caption into a HelpTip. Command: distill.
- [P2] All tickets breaks the system: profile column under lockProfile, lowercase headers, text-sm, 11 columns, >4 filter controls, duplicate h2. Fix: hide profile column, board-row styling, one h2, fold filters. Commands: layout, distill.
- [P2] No triage gradient: "interrupted by restart" is a red failed pill like a real failure. Fix: tone interrupted as held with the true next step. Commands: colorize, clarify.
- [P3] Progress dl has no dt/dd (reads run-on); chart role=img with generic label and no data alternative; History footer leading at 375 px. Command: audit.

## Persona Red Flags
Alex: r/d not in the hint; no zone-jump keys; open drawer → Esc → find row → act.
Sam: log-dump button names; run-on dl; reasons only in title; toast 6 s bottom-right; chart without text alternative.
Second-screen glancer: All clear + tab count excellent; down state: amber banner outweighs the red count; four identical red pills.

## Minor Observations
"NOW 0" over "Nothing is running."; small ⋯ menu; "1 yesterday 0" lacks a separator; Activity repeats the profile name per line; config path truncates the filename (middle-truncate); toast lingers 1 s past the 5 s undo window; "Catch me up" vs CONTEXT's "Digest".

## Questions to Consider
Should Dismiss lead a failed row before #550, or should failed rows lead to the drawer? Does the Overview need Progress and History at all? When the receiver is down, should everything collapse under "start it"?
