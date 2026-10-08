# Troubleshooting

Symptom-first. Most first-run issues are in the first two sections.

## Where to look

```bash
agenthook status <profile>     # up?, public URL, queue depth, recent runs, last event time
agenthook agents               # live claude -p processes
agenthook follow [session]     # tail an agent transcript read-only
tail -f ~/.agenthook/<profile>/logs/*.log    # per-run agent output
```

The server's own stdout (where you ran `agenthook start`, or `~/.agenthook/<profile>/receiver.log`
when run with `--detach`) carries the routing lines quoted below — `[section]`, `[transition]`,
`[assignee]`, `[reject]`, `[advance]`, `[coalesce]`. Grep those first; they say exactly what the
engine decided.

If a detached receiver died outright, check `~/.agenthook/<profile>/crash.json` — written by the
uncaught-exception/rejection handler with the error, stack, and any refs that were mid-step.

## receiver died with no `crash.json`

On Linux, `start --detach` (and the respawn after a control-socket `restart`) runs the receiver
inside a `systemd-run --user --scope` unit so it survives the launching terminal or session. If
that scope support wasn't available when the receiver started (opted out, no `systemd-run`, no
reachable user manager), the receiver instead stays in the **caller's cgroup scope** — closing the
terminal tab, or the launcher getting OOM-killed and its scope reaped, kills the receiver (and any
in-flight `claude -p` agents) with no log line at all.

Check `agenthook status <profile>`'s `scope` line: a `vte-spawn-*`/`tmux-spawn-*`/`*-terminal-*`
scope means it's tied to that session. Restart it with `agenthook restart` or `start --detach` to
pick up the systemd scope. Opt out with `AGENTHOOK_NO_SYSTEMD_SCOPE=1` if you'd rather manage the
process lifetime yourself (e.g. under your own service manager).

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

## A step failed with `timeout`

The run's reason reads `timeout: exceeded maxMinutes=<n>` or `timeout: no output for
idleMinutes=<n>`. Each step run is capped at `maxMinutes` of wall clock (default 120). An
opt-in `idleMinutes` also kills an agent that has printed nothing for that long. On expiry the
receiver sends SIGTERM, then SIGKILL after ~10 s, and fails the run the normal way: a `failed`
event, the failure lane, and the slot freed. Any verdict file the agent wrote first is ignored.
The run log ends with `[agenthook] killed: <reason>`. Look there for what the agent was waiting
on (often CI on a PR that can't merge). If the step really needs longer, raise `maxMinutes`
(`0` turns the cap off). Only the `claude -p` process is killed; a tool subprocess it started
may outlive it.

## A task is stuck in the hold lane

`hold` parks a task waiting on a human answer (the agent posted a question). Reply on the tracker,
then move/re-file the task into the step's source section again to re-dispatch — agenthook doesn't
poll the hold lane.

## The agent keeps holding on the same question

Older builds gave a re-dispatched agent only the task body, so a human's answer posted as a tracker
comment was never seen and the agent re-asked and held again. The step prompt now tells the agent to
read the task's newest comments first and treat answers as decisions (via the adapter's
`readCommentsHowTo`; the `local` tracker has no comment channel). If you use a custom
`instructionsFile`, say the same there (see `examples/*/INSTRUCTIONS_*.md`). Workaround on an older
build: put the answer in the task body/description.

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

## Overriding the state/registry root (`AGENTHOOK_HOME`)

`~/.agenthook` is where every profile's runtime state lives (`registryDir` in `src/config.js`).
Set `AGENTHOOK_HOME=/some/dir` to point the whole CLI at a different root instead — useful for an
isolated or throwaway profile, or test runs that shouldn't touch your real `~/.agenthook`. `ah ls`
and `ah ui` only see profiles under whichever root is active, so a profile created under an
`AGENTHOOK_HOME` override won't show up without it set the same way. Unset, it defaults to
`~/.agenthook` as before.

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
