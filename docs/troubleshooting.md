# Troubleshooting

Symptom-first. Most first-run issues are in the first two sections.

## Where to look

```bash
agenthook status <profile>     # up?, public URL, queue depth, recent runs, last event time
agenthook agents               # live claude -p processes
agenthook follow [session]     # tail an agent transcript read-only
tail -f ~/.agenthook/<profile>/logs/*.log    # per-run agent output
```

The server's own stdout (where you ran `agenthook start`, or the detach log) carries the routing
lines quoted below — `[section]`, `[transition]`, `[assignee]`, `[reject]`, `[advance]`,
`[coalesce]`. Grep those first; they say exactly what the engine decided.

## "doctor is green but nothing happens when I move a task"

The single most common cause. `doctor` validates the token, git repo, binaries, and port — **not**
your section gids or the webhook. Check, in order:

1. **TODO gids still in the config.** `init` leaves `sourceSectionGid: "TODO_..."`. If any remain,
   no task position matches a step. Fill them ([asana-setup §3](asana-setup.md#3-section-gids--the-one-thing-you-fill-by-hand) / [jira-setup §2](jira-setup.md#2-statuses-are-your-sections)).
2. **The section/status doesn't match a step.** The task must land in a section whose gid equals
   some step's `sourceSectionGid` (Asana) or whose name equals a `sourceStatus` (Jira, case-
   insensitive). A typo'd status name silently matches nothing.
3. **The task isn't assigned to you.** See the next section.
4. **The webhook isn't delivering.** See "webhook never fires".

## "[assignee] skip … not assigned to us" — or no run at all

agenthook is **fail-closed**: it only acts on items assigned to the token's own account (Asana
`userGid`, Jira account from `/myself`). If the task is assigned to someone else — or to no one — it
is ignored by design, and you'll see `[assignee] skip <ref>` in the server log.

- Assign the task to yourself (the token owner), or
- Set `"assigneeFilter": false` in the `tracker` block to act on **any** assignee (deliberate,
  project-wide).
- Asana: if `userGid` is missing from the config, scoping fails closed and refuses everything —
  re-run `init` or add your `userGid`.

## The webhook never fires

**Asana** creates the webhook automatically on `start`. If nothing arrives:
- Confirm the public URL is reachable: `agenthook status` shows it; open `https://<url>/` — a live
  server responds. If the tunnel is down, `agenthook start` again.
- Ephemeral ngrok rotates its URL each boot, so agenthook **scrubs stale hooks and re-registers**
  every `start`. If you started, then the URL changed, just restart.
- Check the server log for the handshake; a failed handshake means Asana couldn't reach you when
  the hook was created (the listen-before-register order handles this — restart if you see 502s).

**Jira** needs the webhook created **by hand** — agenthook only prints the instructions. If nothing
arrives, you almost certainly haven't created it yet, or pasted a different URL/secret. Re-read the
print-out from `start` and check Jira admin → System → WebHooks. The URL must end in `/jira/`.

## "[reject] bad signature"

The HMAC didn't match.
- **Asana:** the handshake secret is wrong or missing for that path. Stop, `agenthook start` again
  so the handshake re-runs and re-stores the secret.
- **Jira:** the secret pasted into the Jira webhook doesn't match agenthook's stored one. Re-run
  `start`, copy the printed `Secret:` value verbatim into the webhook, save. (Or set an explicit
  `"webhookSecret"` in the config and use that on both sides.)

## Jira: "no available transition to … from the current status"

Jira moves an issue by executing a workflow **transition**, not by setting a status. This log line
means your workflow has no transition from the issue's current status to your target status, so the
move was skipped and the issue stayed put. Fix the **workflow** so the columns your pipeline walks
are actually connected by transitions.

## The agent ran but the task didn't move

- **Non-zero exit** is always treated as `fail` → the task goes to the failure section/status. Read
  the run log in `~/.agenthook/<profile>/logs/` for the agent's error.
- **Clean exit, no verdict file** defaults to `advance`. If it advanced when you expected a hold,
  the step's instructions need to tell the agent to write a `hold`/`changes` verdict.
- **`[advance] … no target section — leaving in place`**: the step's `successSectionGid` (or
  `failureStatus`, etc.) is empty for that outcome. Add the target, or accept that the task parks.

## "[coalesce] … already queued/running — dropping duplicate"

Not an error. One user action can emit two events (e.g. Asana `task added` + `section_changed`)
that resolve to the same `(task, step)`. agenthook runs it once and drops the duplicate. A later
real re-entry (next step, or a `changes` rework) carries a different key and runs normally.

## The rework loop stopped — task went to `fail` after a few rounds

`changes` is capped by `maxAttempts` (default 3) per `(task, step)`. After that, a further
`changes` is forced to `fail` to bound an endless code↔review ping-pong (each loop is a fresh,
billed `claude -p`). Raise `maxAttempts` on the step if you genuinely need more rounds.

## A task is stuck in the hold lane

`hold` parks a task waiting on a human answer (the agent posted a question). Reply on the tracker,
then move/re-file the task into the step's source section again to re-dispatch — agenthook doesn't
poll the hold lane.

## `agenthook start` refuses to boot

- **"port … already listening" / `EADDRINUSE`**: another process (often a previous run) holds the
  port. `agenthook ls` to find live profiles; `agenthook stop` the old one, or change `port`.
- **Profile already running**: `start` refuses if that profile name's pidfile holds a live pid.
  `agenthook status <name>` / `agenthook stop`.

## "no agenthook.config.json found"

Commands discover the config by walking up from the cwd. Run from inside the project, or pass
`--config /abs/path/to/agenthook.config.json`.

## "${SOMEVAR} is not set" on any command

A `${ENV}` ref in the config didn't resolve. Export the var, or put it in a `.env` beside the config
(auto-loaded). `agenthook doctor` surfaces an empty token specifically.

## Recovering missed events

Webhooks fire on a *transition*, not a state, so a delivery missed during downtime can't be
recovered by polling. Replay explicitly:

```bash
agenthook catchup <ref>           # forge + POST the exact signed event for one task
agenthook catchup <ref> --force   # re-run even if already handled
agenthook reconcile               # re-fire every task currently resting in a pipeline section
```

Still stuck? Open an issue with the relevant `[...]` server log lines and `agenthook status` output:
<https://github.com/Jesuso/agenthook/issues>.
