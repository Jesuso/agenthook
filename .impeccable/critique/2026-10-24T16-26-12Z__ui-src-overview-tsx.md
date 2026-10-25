---
target: Overview page
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:/home/nacho/projects/agenthook/ui/src/Overview.tsx"
target_fingerprint: "sha256:f441042bd0a619cbce00f3a54e2a819c41e26b85168f424d471befbc26241a60"
target_path: /home/nacho/projects/agenthook/ui/src/Overview.tsx
timestamp: 2026-10-24T16-26-12Z
slug: ui-src-overview-tsx
---
Method: dual-agent (A: design review · B: detector + browser overlay)

# Critique: Overview (ui/src/Overview.tsx), v0.12.0 live build
Viewed: Agenthook (up, 2/3 agents, Needs you empty) and cahui-svc-test (down, 4 failed). Dark + light, 1440 and ~518 px.

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | Green "Live" (UI stream) beside a down profile; no up/down in header |
| 2 | Match system / real world | 3 | Table says "done" (CONTEXT avoid-term); two rework numbers (12% 48h vs 6% History) |
| 3 | User control and freedom | 2 | Dismiss one-click, no confirm/undo; Release has Cancel/Esc |
| 4 | Consistency and standards | 2 | Mixed h2 styles (12px caps / 16px sentence / lowercase); Dismiss vs dismiss; two focus rings |
| 5 | Error prevention | 2 | Only filled accent button is Refresh (spends money), cost only in hover title |
| 6 | Recognition rather than recall | 3 | Rows carry step/age/reason; History dual y-axis needs legend |
| 7 | Flexibility and efficiency | 1 | No shortcuts; All-tickets rows open on mouse click only |
| 8 | Aesthetic and minimalist | 2 | Quota twice; 5-day-old digest biggest block; History always expanded |
| 9 | Error recovery | 2 | Failed rows: raw truncated reason, only Dismiss; no retry path |
| 10 | Help and documentation | 3 | Good inline microcopy |
| Total | | 22/40 | Acceptable |

## Design Specificity Verdict
LLM: competent, tokenized, but structurally generic admin dashboard (tiles, card, list, tiles, chart, table, feed). Authored touches: slot pips, free-slot rows, inline Release panel, honest "needs 10+ runs". Contradicts PRODUCT principle 1: top tiles describe the machine; Needs you is a 12px muted label below the digest.
Detector: static scan exit 0 (Tailwind-in-TSX largely opaque to static scan). Browser overlay: 4x low-contrast from one token text-faint #6b7483 (3.8:1 surface, 4.1:1 page bg, 11-12px: DigestPanel footer, StatsStrip caption, History line); 1x flat-type-hierarchy (h1 15 / h2 12 / body 14). A and B agree on hierarchy; B overrules A's "faint 3:1 by design" as AA failure.

## Priority Issues
- [P0] Needs you not the headline; digest outranks it. Fix: lead tile "Needs you N" (failed/held tone, else "All clear"), list directly under header, digest below Now, collapse when >1 day old with stale chip. Commands: layout, bolder.
- [P1] Profile liveness untruthful/invisible. Fix: up/down pill in Overview header; AppBar dot -> "UI connected" or show only unhealthy; down banner "receiver is down — start with ah serve". Command: clarify.
- [P1] Keyboard/SR/contrast gaps vs AA + keyboard-first: table rows mouse-only; Dismiss buttons unnamed (Overview.tsx:255); default 1px focus on tabs/select/segmented; no shortcuts; drawer close drops focus to body; no aria-live on Needs you/Now; text-faint fails AA; no skip link. Fix: button title cell, aria-label per ticket, shared focus ring, focus return, live region, raise text-faint >=4.5:1, j/k/r/d + ? sheet. Commands: harden, audit.
- [P1] Narrow width crushes actionable text (title ~80px, reason "sandbox (d…"; Now truncates title not model/cost). Fix: stack rows <640px, drop model/cost on narrow. Command: adapt.
- [P2] Spend button styled primary; Dismiss no undo; failed rows no fix path. Fix: secondary Refresh with "~$0.05", undo toast, Retry/move-back. Commands: clarify, harden.

## Persona Red Flags
Alex: no shortcuts; ~16 tabs to History; table mouse-only; Follow log hover-hidden; quota twice.
Sam: unnamed Dismiss buttons; "free slot" x N noise, pips aria-hidden; 11px faint staleness fails contrast; thin tab focus; H1 accessible name includes config path; no skip link.
Second-screen glancer: sees prose + blue button; headline number small grey; up vs down indistinguishable; failed/held small pills; page silhouette never changes when something needs you.

## Minor Observations
Two rework scopes unlabeled; PR ready uses done green; orphan Progress tile at narrow; Queued duplicated; disabled Catch me up looks enabled in light; scroll-margin-top missing under sticky header; "Activity 0 · expand" reads broken and differs from details pattern.

## Questions to Consider
Why not start with Needs you and say "all clear" big? Should a stale digest show by default? What remains if History, table and Activity move behind tabs?
