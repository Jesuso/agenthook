# Supervising a pipeline

One cheap read tells you everything:

```
agenthook tick --json            # MCP: tick
```

`held[]` + `failed[]` is the **needs-you** list. `running[]` has `ageS`; `board[]` lists tickets
resting in a source stage without an agent (missed webhook, or waiting for a slot); `prs[]` has
CI state; `events[]` since `cursor`. Keep `etag` and `cursor`.

## Act, in this order

1. **held** → `why` says what the agent asked. For the full reasoning read the run log: MCP
   `runs {ref, tail: 80}`; from a shell `agenthook resume <ref>` lists the ticket's sessions and
   `agenthook follow` tails a live one.
   - You can answer from your own context → `release` (MCP `release {ref, comment}`; shell: reply on
     the ticket with the trigger word, e.g. `@agent <instruction>`, as the receiver's own account).
     Write the comment as an instruction: concrete, self-contained, no secrets.
   - It needs a human decision (product, credentials, destructive) → put the choice to the user.
   - `why: "no valid verdict"` → the agent exited without a verdict file: read the tail, then
     `release` (re-runs the step) or `run --force` (fresh start).
2. **failed** → read the tail. Transient/infra → `agenthook run <ref> --force` (or `catchup`).
   Config cause (`GitHub run token:`, sandbox credentials, egress denied) → the user fixes config,
   then re-run. Real defect → fix or rewrite the ticket. Noise → `dismiss`.
3. **move_refused** event → the run ended but the ticket stayed: `not_ours` = assignee wrong;
   `owner_check_failed` = tracker erroring; fix, then `agenthook catchup <ref>`.
4. **red PR** (`prs[].ci == failure`) → with a forge configured the receiver already reruns or
   bounces it; intervene only if it keeps bouncing. `conflict:true` is never auto-fixed.
5. **free slots + board has resting tickets** → `agenthook reconcile` replays them.
6. **stuck agent** (`ageS` far above normal) → read the tail; `agenthook cancel <ref>` if wrong.

## Wait, don't poll

```
agenthook watch --json --cursor <cursor> --timeout 1800 \
  --event pipeline_done,blocked,failed,move_refused,ci_green,ci_red,merged
```

exits 0 with `{events, cursor}` on the first matching event, 2 on timeout. (MCP:
`events {cursor, waitS: 120, types: [...]}`.) Then `tick` again with the new cursor
(`ifNoneMatch: etag` → `{unchanged:true}` = nothing to do). Several profiles: `--all` /
`profiles: ["*"]`; the cursor becomes an object — pass it back whole.

## Merge when green

Wait for `ci_green` (carries `mergeable`); `mergeable:null` → re-read `prs`. Only `ci: success`
is green. On GitHub, closing the ticket's issue (not just merging) is what releases dependents.

## Maintenance

`agenthook pause` → wait for `slots.active == 0` → `agenthook restart`. `set_concurrency` (MCP)
changes the cap until restart.

## Report

One line per ticket: `ID — step — what happened — what you did / what you need`.
