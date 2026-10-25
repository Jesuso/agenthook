---
target: Epics page
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/home/nacho/projects/agenthook-epics-ui/ui/src/EpicsView.tsx"
target_fingerprint: "sha256:b71a322d1e88da0ac852d82917708f54903b7dddf8d9e74fe8c9335ef75eda6a"
target_path: /home/nacho/projects/agenthook-epics-ui/ui/src/EpicsView.tsx
timestamp: 2026-10-25T21-04-18Z
slug: ui-src-epicsview-tsx
---
# Critique: Epics view after round 2 (truth, actions, one bar, keys)
Method: dual-agent (A: design review · B: detector + browser overlay)

## Health 27/40 (Good) — up from 24
1 Status 3 — no "updated Xs ago" after silent refetch
2 Real world 3 — "untracked" vs "Not on the board"
3 Control 2 — u/back re-collapses disclosures, focus lost
4 Consistency 2 — fold "Finished and merged" holds "not merged" rows; label drift
5 Error prevention 3
6 Recognition 2 — colour key lookup; meaning in title tooltips
7 Flexibility 3 (was 1) — j/k/u/? work; no filter, no jump-to-needs-you
8 Minimalist 3 — list key floats like a stray row; inverted h1/h2 sizes
9 Recovery 3 (was 2) — Try again, start command, 404 back link
10 Help 3 (was 2) — ? sheet, ETA explains basis

## Detector
CLI clean (4 files). Overlay: stripes finding gone; only em-dash overuse, all from tracker titles (false positive).

## Priority issues
- [P1] Finished-not-merged (PRs awaiting the human) hidden in a fold titled "Finished and merged", no PR links. Fix: open "Awaiting merge" section above Backlog with PR links; fold becomes "Merged".
- [P1] Screen readers: counts glued to headings ("Backlog3"); list row link announces no state. Fix: separators/aria text; aria-describedby with pill, bar, note.
- [P2] Return trip loses place; Release Cancel drops focus. Fix: persist disclosure state, refocus origin row, return focus to Release.
- [P2] Detached list key; thin bar makes hollow ring illegible in dark. Fix: drop list key or move to header; bar h-3 on page.
- [P2] Copy drift: one label map; "No open epics." + auto-open Closed.
