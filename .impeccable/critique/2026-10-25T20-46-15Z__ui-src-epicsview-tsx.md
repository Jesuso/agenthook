---
target: Epics page
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/home/nacho/projects/agenthook-epics-ui/ui/src/EpicsView.tsx"
target_fingerprint: "sha256:10049a831b79bca1a382d825bf97c1d4bad3f9b7c5761e47137305ad8a3bb678"
target_path: /home/nacho/projects/agenthook-epics-ui/ui/src/EpicsView.tsx
timestamp: 2026-10-25T20-46-15Z
slug: ui-src-epicsview-tsx
---
# Critique: Epics view after the attention-first redesign (d8152f1)
Method: dual-agent (A: design review · B: detector + browser overlay)

## Health 24/40 (Acceptable) — same total, different spread
1 Status 3 — no "as of"; pace line contradicts itself
2 Real world 3 (was 2) — "finished" means two things; tracker stage "Idea" leaks into rows
3 Control 3 — only way up is the h1 "Epics" link
4 Consistency 2 — two stage-bar implementations disagree; focus rings inconsistent; amber reused for stalled
5 Error prevention 3
6 Recognition 2 — list bar has no legend; drawer/tracker/dead rows look alike; "Details" hides the action
7 Flexibility 1 — no j/k/Enter; only the name is clickable; needs-you pill not a link
8 Minimalist 3 — redundant Done/closed pills, empty ETA slot
9 Recovery 2 (was 3) — 503/504 messages carry no remedy; no retry beside the error
10 Help 2 — help only in title tooltips

## Specificity
IA and copy now product-specific (attention order, every ticket goes somewhere, pace in words); composition still a generic bordered list. Detector: CLI clean; overlay flags repeating-gradient stripes (merged hatch) and em-dash overuse (tracker titles) — both judged false positives as rules, though A also finds the hatch makes merged look dimmer than finished.

## Priority issues
- [P1] Pace line: "4 finished this week… 3 left, no estimate until something finishes" contradicts; legend "finished" = not merged vs pace counting both. Fix: real reason for missing ETA; one meaning of finished. → clarify
- [P1] Needs-you action is "Details"; fallback "Waiting on you." Fix: name the action by kind (Answer…, Re-run…/Review failure); say why when no local row. → clarify
- [P2] Two stage bars disagree (list vs page); hatch dims merged. Fix: one component, merged solid, finished-not-merged the variant, list count text adds remainder. → polish
- [P2] Closed epics outweigh open ones (full green bars, redundant pills). Fix: muted closed rows, hide restating pills. → quieter/polish
- [P2] No power path. Fix: j/k/Enter/? on Epics, whole-row targets, pill deep-links to Needs you. → harden

## Personas
Alex: no keys, row not clickable, no last-activity column, Refresh flicker on every SSE refetch, history undated. Sam: missing focus rings on four links, no live region, title-only explanations, new-tab links unannounced, extra banner landmark, step/age hidden on mobile.

## Minor
Ready-to-close phrased as a question; "11 closed below" while collapsed; title text-[20px] not a token; empty ETA slot; tab title stays "agenthook"; live:false lacks last-known time; narrow list rows wrap raggedly; truncated names only in title.

## Questions
Should epics be a grouping on Overview instead of a tab? Why animate running but not stalled? Is Ready to close a human action deserving more than a green "all good"?
