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

Each run is a plain `claude -p` OS process working in its own git worktree.

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
