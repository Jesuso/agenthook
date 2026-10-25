---
target: Epics page
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/home/nacho/projects/agenthook-epics-ui/ui/src/EpicsView.tsx"
target_fingerprint: "sha256:727a093fc17067bd8f3cfd55d217abeaa603c404d830c08c50fb938cc8117c42"
target_path: /home/nacho/projects/agenthook-epics-ui/ui/src/EpicsView.tsx
timestamp: 2026-10-25T20-20-18Z
slug: ui-src-epicsview-tsx
---
# Critique: Epics page (EpicsView.tsx list + EpicPage.tsx)
Method: dual-agent (A: design review · B: detector + browser overlay)

## Health 24/40 (Acceptable)
1 Status 3 — no "as of"; no reason when ETA missing
2 Real world 2 — banned "done"/"completed" (EpicStageBar aria-label, Completed (k) disclosure, completed pill, StatusBadge "done")
3 Control 3 — back link buried in h1; Completed open state not remembered
4 Consistency 2 — ticket rows break board-row anatomy; ready-to-close chip shifts columns; mixed heading voice
5 Error prevention 3
6 Recognition 2 — stage bar colour-only, merged = finished green, no legend on list
7 Flexibility 1 — no keys/filter/sort; backlog/untracked rows without local row are dead text
8 Minimalist 3 — empty reserved columns while titles truncate; 0-ticket page renders empty cards
9 Recovery 3 — error replaces last good data; epic 404 has no way back
10 Help 2 — nothing explains velocity/ETA

## Specificity
Half authored: stage bar (merged→finished→running→needs you→backlog→untracked, striped running) is product-specific; the rest is a generic Jira/Linear epic roll-up, not the Air Traffic Board. Detector: CLI clean (0); overlay: list views clean, epic page FLAT TYPE HIERARCHY (epic title h2 15px/600 = page h1 15px/600; card h2 12px). Agrees with A's heading finding.

## Priority issues
- [P1] Needs-you tickets on epic page lack reason/age/action; rows without a local row do nothing. Fix: reuse Overview Needs-you row; every id links to tracker. → layout/clarify
- [P1] List sorts ready-to-close above epics with needs-you tickets (epics.ts splitCompleted). Fix: needsYou → running → readyToClose → rest; needs-you count leads the row, toned by worst kind. → layout
- [P2] Terminology: done/completed. Fix: "N of M finished", "Closed (k)", drop redundant pill, map done→finished. → clarify
- [P2] A11y: opacity-60 on completed block, colour-only bar, low-contrast backlog, sparkline data hover-only, flat heading outline, double tab stops per row. → audit/typeset
- [P2] Empty/edge: no "No open epics" state; 0-ticket epic still shows bar+velocity; "yet" on closed epic; unsupported copy doesn't name tracker. → harden/onboard

## Personas
Alex: no keyboard nav, filter or sort; dead rows; badge links same as name. Sam: flat h2 outline; two tab stops to one href; "done" read aloud; no aria-live on refresh.

## Minor
Duplicate ProfileMark; tracker status pill ("Idea" at 8/11) draws eye; no displayId on list; narrow widths leave ragged blank fixed columns; sparkline lacks baseline/today; history (finished+merged) takes most of epic page height.

## Questions
Default epic page to Needs you + Running + Backlog with history collapsed? Is Velocity/ETA a PM habit the product rejects? Ready to close: one-step action, or Overview item?
