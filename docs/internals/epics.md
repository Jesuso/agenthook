# Epics

## Key files

- `src/epics.js` — pure `epicStats` (progress by bucket, needs-you, velocity, ETA) joining an `Epic` + its `EpicTicket`s with `ui/rows.js` `TicketRow`s and `ui/stats.js` `readHistory`; `isNeedsYou` mirrors `ui/src/summary.ts`; `ticketBucket` is the per-ticket decision, `epicDetail` adds it per ticket,
  `localEpics` groups `refmeta.epic` for the UI's receiver-down fallback, `EPIC_REF_RE` guards refs before any tracker URL. No I/O.
- Each `EpicTicket` carries its own tracker web URL (`url`, null/absent when unknown) — never derived
  from the epic's URL. Each tracker's `mapEpicTickets`/`mapProjectEpicTickets` fills it from data its
  API already returns (Asana: `permalink_url`; GitHub: `html_url`; GitHub Projects v2: the sub-issue's
  `url`; Jira: `${baseUrl}/browse/${key}`). `localEpics` carries it through from `refmeta[ref].url`
  (dispatch records the tracker's `task.url` there per run). The UI (`ui/src/EpicPage.tsx`) links a
  ticket row straight off `t.url` through `safeUrl`.
- Each `EpicTicket` also carries `terminal` (ADR 0008): it rests in a manual step's source stage, the
  pipeline's terminal stage — done on the board. The adapter passes the manual steps' source stages
  into its pure mapper: Asana by section **gid** (`memberships.section.gid`; `stage` is the section
  name), Jira and GitHub Projects v2 by status name, GitHub by the matched pipeline label.
  `ticketBucket` counts a ticket `done` only on the board's word (`completed`, `terminal`, a `done`
  row, or a history ending `board_done`/`pipeline_done`) — a merged PR never is; PR facts only add
  Needs-you reasons (`TicketRow.prNeeds`).
- `src/epic-changed.js` — emits a read-only `{kind:'epic_changed', ref:<epic>}` signal outside the
  queue (GitHub only today — see [trackers.md](trackers.md)), dropping ops' epics cache.

See [trackers.md](trackers.md) for how Jira, GitHub, and GitHub Projects v2 each define an epic
and its tickets, and [agent-api-mcp.md](agent-api-mcp.md) for the `readEpics` live-then-local
fallback and the MCP `epics` tool.
