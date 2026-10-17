# Starting work and operating agents

## Starting vs replaying work

A step's **source stage** — its label (GitHub), section (Asana), or status (Jira) — is its
**inbox**. Forward motion is event-driven: an item **entering** a source stage fires that step.
Nothing in agenthook moves an item *into* an inbox on its own — `catchup`/`reconcile` only
**replay** items already resting in one. To *start* new work, you put it in the inbox.

| Action | What it does | When you reach for it |
|--------|--------------|-----------------------|
| **trigger** (live) | a label/section/status move into a source stage fires that step | the hot path — you, or a prior step's `advance`, move an item in |
| **`run <ref>`** | inject a *new* item: assign it to you + move it into a step's source stage | start a backlog item that has never entered the pipeline ([#11](https://github.com/Jesuso/agenthook/issues/11)) |
| **`reconcile`** | replay *every* item currently resting in a source stage (the one explicit poll) | recover items that entered while the server was down |
| **`catchup <ref>`** | replay *one* such resting item | recover a single missed item |

`reconcile`/`catchup` are **downtime replay only**: they re-fire the step a resting item already
maps to — they never move an item into a stage. If an item isn't in any source stage there's
nothing to replay; use `run` (or move it in by hand) to start it.

**Start a new item.** There's no event for a backlog item *until* it enters a step's source
stage. `run` assigns it to you (fail-closed scoping) and moves it in; the live webhook then fires
the step normally:

```bash
agenthook run <ref>             # assign + enter the FIRST step's source stage (alias: kick)
agenthook run <ref> review      # target a named step's source stage
agenthook run <ref> --no-assign # skip the assign (only if it's already assigned to you)
```

If no server is up, the item just rests in the stage; `agenthook reconcile` picks it up once
it's running.

**Replay a missed item.** Webhooks are push-only and fire on a *transition* (an item moving into a
stage), not a state — so a move missed while the receiver was down can't be recovered by polling
alone. Replay it explicitly through the running server:

```bash
agenthook catchup <ref>           # forge + POST the exact signed event for one resting item
agenthook catchup <ref> --force   # re-run even if already handled
agenthook reconcile               # re-fire every item resting in a source stage (the one explicit poll)
```

## Operating running agents

Each run is a plain agent OS process (`claude -p`, or the step's [agent](agents.md): Cursor's
`agent -p`, `hermes chat`) working in its own git worktree.

```bash
agenthook agents [name]           # list running agents (pid, runtime, ref, live token tally); no secrets needed
agenthook follow [session-id] [--repo <id>]  # tail a live agent read-only (no second process)
agenthook usage                   # per-run token & cost table (--ref <n>, --day, --week)
agenthook cleanup                 # dry run: which worktrees are done and safe to remove
agenthook cleanup --apply         #   remove them (add --force for dirty ones)
```

Every `claude -p` run's token counts and cost are captured to `usage.jsonl` and surfaced by
`agenthook usage` (with `--day`/`--week` rollups) plus token/cost columns on `agents`, `status`,
and `ls`. See [Token & cost tracking](usage.md).

Agents never remove their own worktrees (INSTRUCTIONS §7); `cleanup` is the one place that
does, and only once the PR is merged/closed or the tracker item is completed.

## Event-driven delivery loop

Drive one or more profiles off the event bus instead of polling the board. The loop:

1. One `agenthook tick [--json]` (MCP `tick`) for a baseline: slots, running, queue, held, board,
   PRs, and a `cursor`.
2. One background `agenthook watch --cursor <c> --event <list> --timeout <long, e.g. 1800> --json`
   (MCP `events {cursor, waitS, types}`) as the wait. It blocks (`fs.watch`-driven, no polling)
   until a matching event lands, or the timeout expires. MCP callers cap `waitS` at 120s, so re-arm
   at least that often.
3. On exit 0: act per event (table below), then re-arm `watch` with the printed `cursor`.
4. On exit 2 (timeout): treat it as a **heartbeat** — re-`tick`, then re-arm `watch` from the new
   cursor.

Run **one** watch per supervisor — never two at once against the same profile(s). `watch` is a
byte-offset reader of the append-only `events.jsonl`, so two readers would each see every event,
not half; the real risk is two supervisors **both acting** on the same event (a double merge, a
double `run`). Watching many profiles? Use a single `--all` (or multi-name) watch; its cursor is a
JSON object `{stateKey: offset}` — pass it back whole.

### Event → action

See [events.md](events.md) for every field; this just says what to do.

| event | action |
|---|---|
| `pipeline_done` | PR is ready — check CI/merge state, merge if policy allows |
| `ci_green` | mergeable — merge if policy allows |
| `ci_red` | look at `action`: `rerun`/`bounced`/`deferred` handle themselves; `skipped` may need you |
| `merged` | release the ref's dependents (see epics, below) |
| `blocked` | answer with `@agent` on the ticket, or `release` |
| `failed` | inspect the run log, then `run` again or `dismiss` |
| `move_refused` | ticket is stuck in its stage — fix ownership/assignment, or move it by hand |
| `overlap_held` | wait for `overlap_released`, or reprioritise the blocker |
| `epic_changed` | re-read `epics` — the cached read was dropped |

`epic_changed` is **hidden by default** (like `coalesced`/`digest_start`/`digest_end`) — name it
explicitly in `--event`/`types` or you won't see it.

### What the bus can't see

No event exists for: a PR on a branch that isn't `agent/<ref>`, an issue that was never labeled
into a stage (or isn't assigned to the token owner), or anything that happened while the receiver
was down (`events.jsonl` isn't written; `watch` still runs but stays silent — it just never wakes).
The long `--timeout` heartbeat covers the receiver-was-briefly-down case by re-`tick`ing
periodically regardless; after real downtime, run `agenthook reconcile` once to replay items
resting in a source stage.

### The forge

`merged`, `ci_green`, and `ci_red` come only from a configured [forge](configuration.md#forge-optional--what-happened-to-the-code)
— without one the bus has no merge/CI awareness and you must poll PR state via `tick`/`prs`
instead. `agenthook init` offers the forge block on every init (default yes when the tracker is
GitHub or the origin remote is github.com); `agenthook doctor` warns when a GitHub tracker has no
forge configured.

### Multiple profiles

`agenthook tick --all` / `agenthook watch --all` (or list several names) fan the loop out to every
profile at once: the cursor is `{stateKey: offset}`, and every event carries a `profile` field so
you know which one fired.

### Epic-ordered batches

A ticket's `merged` event is the trigger to `run` its dependents next. Use the MCP `epics` tool
(or `tick {epics:true}`) to see an epic's tickets, their stage, and which ones are waiting on the
one that just merged — see [agent-guide.md](agent-guide.md) for the shapes.
