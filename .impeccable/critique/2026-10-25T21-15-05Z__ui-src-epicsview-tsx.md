---
target: Epics page
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/home/nacho/projects/agenthook-epics-ui/ui/src/EpicsView.tsx"
target_fingerprint: "sha256:2f0977333c9f597afabd2536766238c910f6bb9d20b5d7c12e786e3564dda6a7"
target_path: /home/nacho/projects/agenthook-epics-ui/ui/src/EpicsView.tsx
timestamp: 2026-10-25T21-15-05Z
slug: ui-src-epicsview-tsx
---
# Critique: Epics view at bc09ec4 (round 3 fixes)
Method: dual-agent (A: design review · B: detector + browser overlay)

## Health 28/40 (Good) — up from 27
1 Status 3 · 2 Real world 3 · 3 Control 3 (was 2) · 4 Consistency 2 · 5 Error prevention 2 (was 3) · 6 Recognition 3 (was 2) · 7 Flexibility 3 · 8 Minimalist 3 · 9 Recovery 3 · 10 Help 3

## Detector
CLI clean. Overlay: only em-dash overuse from tracker titles (false positive). All list row aria-describedby ids resolve.

## Priority issues
- [P1] "Awaiting merge" asserts unknown state: CONTEXT.md says finished with no recorded PR is just finished; CAHUI-207 shows 4/4 "no PR recorded" in the top slot. Fix: split by evidence; hollow/Awaiting merge only with a known open PR.
- [P1] Single-key shortcuts with no off switch (WCAG 2.1.4). Fix: toggle in ? sheet, checked by epicsAction/overviewAction.
- [P2] Shortcuts dialog unnamed, no focus move/restore, no visible close.
- [P2] Writes (Re-run, Release…) styled like reads; Re-run one click, no undo; no Dismiss.
- [P3] List under-informs: closed rows lack outcome; tracker status pill reads as progress; no key.
