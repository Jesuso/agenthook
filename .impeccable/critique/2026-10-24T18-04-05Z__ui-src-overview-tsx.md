---
target: Overview page
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/home/nacho/projects/agenthook-ui-overview/ui/src/Overview.tsx"
target_fingerprint: "sha256:17abb1448b3c3015e0b4d9b8848c865be7ea42471ebbef5374dc9ac75f6d72b3"
target_path: /home/nacho/projects/agenthook-ui-overview/ui/src/Overview.tsx
timestamp: 2026-10-24T18-04-05Z
slug: ui-src-overview-tsx
---
# Critique: Overview (ui/src/Overview.tsx), branch ui/overview-impeccable after layout/clarify/harden/adapt/polish
Method: dual-agent (A: design review · B: detector + browser overlay). Viewed cahui-svc-test (down, 4 failed) and Agenthook (up, all clear), dark + light, 1280 / 600 / 375 px.

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Receiver/slots/queue clear; tab title stays "agenthook", no count when backgrounded |
| 2 | Match system / real world | 3 | CONTEXT terms honoured; raw sandbox errors shown as the human reason |
| 3 | User control and freedom | 3 | 5 s Undo (button + Ctrl+Z); only last dismiss undoable via toast |
| 4 | Consistency and standards | 2 | Three disclosure patterns; receiver-down red in status line, amber in banner; fullAuto shield borrows held amber |
| 5 | Error prevention | 2 | Failed row's one action is Dismiss: the safe path (re-run) is missing |
| 6 | Recognition rather than recall | 3 | j/k hint helps; bare ids ("7") read like row numbers; toast "Dismissed 7" |
| 7 | Flexibility and efficiency | 3 | j/k/Enter/r/d/Ctrl+Z/?; no key for All tickets, Activity, next profile |
| 8 | Aesthetic and minimalist | 2 | Quota twice, free slots twice, digest restates live zones, History always open |
| 9 | Error recovery | 2 | Failed tickets show reason, no next step; drawer omits the failure reason |
| 10 | Help and documentation | 2 | Good ? sheet; nothing on what "failed" asks or what reconcile does |
| Total | | 25/40 | Acceptable (was 22/40) |

## Design Specificity Verdict
LLM: mostly authored for this product above the fold (tone-coloured "N need you", stopped banner with exact commands, inline Release, deferred Dismiss, slot pips, mono machine text). Below the fold reverts to generic SaaS metrics: Progress tiles + 250 px History chart outweigh Needs you on a calm profile and duplicate the Stats tab.
Detector: CLI 1 advisory (design-system-font-size, HelpTip.tsx:58 text-[10px]); --scope layout clean. Browser overlay (Chrome [Human] tab + Playwright light/375): flat-type-hierarchy on both views (h1 15px, section h2 12px caps, body 14px, ratio 1.17 < 1.25); at 375 px tight-leading 1.27x on 11px captions and two stragglers. dark-glow #ffba00 is a false positive (the overlay's own marker). No contrast failures; no horizontal overflow at 375 px. A and B agree the calm-state headline and type scale are weak.

## Priority Issues
- [P1] Failed ticket has no recovery path: only Dismiss; raw sandbox error as reason. Fix: primary "Re-run" (or "Open log at error"), Dismiss secondary (keep d); one-line human reason, raw lines in drawer; repeat reason in drawer header. Commands: clarify, harden.
- [P1] Calm state under-weighted; secondary zones dominate. Fix: "All clear" in the 28px headline slot with success tone; collapse History by default (or move to Stats); fold free-slot rows into the summary line when idle; needs count in document.title. Commands: distill, layout, typeset.
- [P2] Colour rule breaks: receiver-down red vs amber banner; fullAuto shield in held amber. Fix: one tone for receiver-down; neutral/consequence treatment for the shield. Command: colorize.
- [P2] Redundant / disagreeing metrics: rework 13% (48 h) vs 6% (14 d) unlabeled; quota twice; digest restates Needs you/Moving. Fix: label windows or show one; drop summary-line quota; hide digest live-state lines or mark as snapshot. Command: clarify.
- [P3] Disclosure + type drift: details triangle vs Show/Hide; 10px chart ticks + HelpTip; 11px captions at 1.27 leading; disabled digest reason only in title. Command: polish.

## Persona Red Flags
Alex: no re-run key; four failures = j,d x4; no key for All tickets/Activity/profile switch; bare ids in toast.
Sam: h1 accessible name runs profile into config path; "4need you" (no space between spans); disabled-digest reason tooltip-only; focus ring on title, not row.
Second-screen glancer: calm board reads as charts, not "done"; liveness cues are 2px dots; nothing in tab title/favicon when something needs you.

## Minor Observations
Profile path truncates at narrow widths; toast covers History range control; "queued" sub-label is a second heading voice; "Nothing is running." vs three "free slot" rows; PR ready shares done green; digest staleness threshold 24 h is long; "Nothing needs you" while receiver is down reads as relief.

## Questions to Consider
Should History leave the Overview? Is Dismiss the action to make easiest on a failure? Should "receiver down" reframe "Nothing needs you" — someone must restart it?
