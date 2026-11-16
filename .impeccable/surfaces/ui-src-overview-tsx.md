---
version: 1
slug: "ui-src-overview-tsx"
primary_target: "ui/src/Overview.tsx"
related_targets: []
---

THESIS
The profile Overview is a departures board: one row per ticket, the pipeline as fixed columns, each row drawn up to the step it is in. It uses the whole window at every width.

OWN-WORLD
The existing world, The Air Traffic Board (DESIGN.md): flat tonal surfaces, hairline rows, status hues for state only, one row per ticket with columns that align. No new palette, type or material.

STORY
Glance: the headline count, then the lit rows that need you with their action. Next: what runs and what waits, and where in the pipeline. Then reading (digest, progress, activity) in a rail; All tickets is a drill-down.

FIRST VIEWPORT
Profile header and machine state line; "N need you" (or All clear); the board card: summary and step headers, Needs-you rows, running, queued, Finished today. From 1536px a right rail with Catch me up, Progress, Activity.

FORM
seed:eb10e3d65148c689
One subgrid for all rows: state, id, title (4 shares), a column per step (1 share, min its name), clock, action. Step columns appear when the card is 56rem wide; below, rows name their step. Targets: 480, 640, 1280, 1920, 2560.

FINISH
No horizontal scroll at any target width; both themes; state never by hue alone (dot shape plus word); keyboard j/k walks needs rows then board rows; calm state reads calm (All clear plus a one-line board).
