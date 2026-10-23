# Agent-facing surface: `agent-api.js`, MCP, control ops

The **agent-facing surface** (docs/mcp.md; usage guide for agents `docs/agent-guide.md`, served by
the MCP `guide` tool — update it when a tool, event or error message changes).

## Key files

- `src/guide.js` — `loadGuide` (agent-guide.md by `##` topic) + `renderAuthoring(cfg)`: the dynamic `authoring` topic, pure over the loaded config with a per-provider facts table (`PROVIDERS`: stage keys, epic rule, blocker support — keep in sync with `src/trackers/<kind>.js`). Served by the MCP `guide` tool and `agenthook guide`. `src/skill-install.js` + `src/commands/skill.js` — the portable skill in `skills/agenthook/` (open SKILL.md format), its agent-dir table, version stamp, `skill install|ls`; `doctor` warns on a stale copy, `init` offers the install.
- `src/agent-api.js` + `src/mcp/*` + `src/ops.js` — `agent-api.js`
  is the pure read model over a state dir (`readStatus` slots/running/queue/held with an `etag`,
  `readEventsSince`/`waitForEvents` byte-offset cursors — `waitForEvents` is `fs.watch`-driven, never
  polling —, `readRuns`/`readRunLogTail`, `readTick`, `pickProfile` multiplexing); reads work with the
  receiver down. `readEpics(entry, {ref?, fresh?, tz?})` is live-then-local: the receiver's `epics` op
  when up, else `readLocalEpics` (the `ah ui` receiver-down fallback, also used by `GET /api/epics`) —
  `live()` tags a down socket error `{code:'down'}` so `readEpics` can fall back without string-matching
  the message. Backs the MCP `epics` tool and `agenthook epics`; `tick {epics:true}` adds its list
  (minus per-day `velocity.days`) or `epicsError`. `mcp/server.js` is a zero-dep stdio JSON-RPC MCP transport, `mcp/tools.js` the tool
  table (`--read-only` unlists + refuses every write). Live-only reads (`board`, `prs`) and all writes go
  over `control.sock` to `ops.js` (`createOps`, wired in `engine.js`, passed to `startControl({commands})`):
  `pause/resume/set_concurrency/cancel/run/release/reconcile/pull/ticket_add`, each audited to `control-audit.jsonl`
  (0600, comment/body text never logged), refusals exposed to the caller (`e.expose`). `cancel` = `queue.remove`
  + `runClaude.cancel(ref)` (SIGTERM→SIGKILL; resolves as `fail`, "cancelled by operator"). `release`
  reuses `resumeJob` (the `@agent` gate — see [dispatch.md](dispatch.md)); `run` is `agenthook run`'s move incl. `entryBlock`. Forge
  `listAgentPrs` (github) backs `prs`. The read `epics` (`{ref?, fresh?, tz?}`) lists every epic + its tickets
  (`listEpics` then `listEpicTickets` per epic; no readers → `supported:false`) and joins them with local rows/history
  through `epics.js` (see [epics.md](epics.md)) outside the cache. `board`/`prs`/`epics` are cached ~30 s (`ttlCache`) — an explicit tool call
  is the only trigger, so the no-implicit-polling rule holds.
