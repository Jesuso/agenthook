# Epics

## Key files

- `src/epics.js` — pure `epicStats` (progress by bucket, needs-you, velocity, ETA) joining an `Epic` + its `EpicTicket`s with `ui/rows.js` `TicketRow`s and `ui/stats.js` `readHistory`; `isNeedsYou` mirrors `ui/src/summary.ts`; `ticketBucket` is the per-ticket decision, `epicDetail` adds it per ticket,
  `localEpics` groups `refmeta.epic` for the UI's receiver-down fallback, `EPIC_REF_RE` guards refs before any tracker URL. No I/O.
- `src/epic-changed.js` — emits a read-only `{kind:'epic_changed', ref:<epic>}` signal outside the
  queue (GitHub only today — see [trackers.md](trackers.md)), dropping ops' epics cache.

See [trackers.md](trackers.md) for how Jira, GitHub, and GitHub Projects v2 each define an epic
and its tickets, and [agent-api-mcp.md](agent-api-mcp.md) for the `readEpics` live-then-local
fallback and the MCP `epics` tool.
