# Event bus — `events.jsonl`

agenthook appends one JSON line per lifecycle transition to
`~/.agenthook/<profile>/events.jsonl`. The file is **append-only** and
**never rewritten**; consumers can `tail -f` it or use `ah events --follow`
(forthcoming) to react to pipeline progress without polling the board.

## Line format

```json
{ "ts": "<ISO-8601>", "event": "<name>", "ref": "<task-ref>", "step": "<step-id>", ...extra }
```

Every line carries `ts`, `event`, `ref`, and `step`. Additional fields depend on the event type.

## Event catalog

| event | when | extra fields |
|---|---|---|
| `enqueued` | job **accepted** into the queue after dedup (engine `intake`), or is re-enqueued from `queue.json` on boot | `restored?` (`true` on boot restore), `kind?` (the job kind — `"pipeline"`, `"merge"`, or `"ci"`; `"pipeline"` when omitted, i.e. an old event written before this field existed; a CI/merge job's enqueue does not run the agent, so UI readers must not treat it as a re-run) |
| `coalesced` | a duplicate webhook for a ref+step already queued/running was dropped (tracker webhooks commonly fire several times for one board move) — a refusal while draining emits nothing. Not in the sinks' default set, and **hidden by default** in `ah events`, `ah watch`, the MCP `events` tool, and the UI feed | — |
| `digest_start` / `digest_end` | an on-demand Digest ran (`ah ui` "Catch me up", src/digest.js); ref/step are empty. `digest_end` carries `outcome` (`ok`/`fail`), `lang` (the language it was written in) and `costUsd` or `reason`. Not in the sinks' default set, and **hidden by default** like `coalesced` | — |
| `summary_end` | a ticket summary ran for the `ah ui` drawer (src/summarize.js) — only on an actual run, never on a cache hit; ref/step are empty. Not in the sinks' default set, and **hidden by default** like `coalesced` | `outcome` (`ok`/`fail`), `lang`, `costUsd` or `reason` |
| `dequeued` | an operator `cancel` (MCP / control socket) dropped a job still waiting in the queue (a `failed` with reason `cancelled by operator` follows when the ticket is moved to the failure lane — also emitted for a cancelled *held* ref) | `by` (`"operator"`) |
| `dismissed` | an operator `dismiss` acknowledged a failed/cancelled ticket (the dashboard then stops showing it as needing attention; a later run counts again). Not in the sinks' default set | `by` (`"operator"`) |
| `pulled` | a free slot pulled the item from its step's opt-in queue stage (moved via `enterStage(…, {assign:false})`; its `enqueued` follows when the webhook lands) | `from` (the queue stage: section gid / status / label), `rank` (0-based board position) |
| `run_start` | `claude -p` spawns for a step | `model` (string \| null) |
| `run_end` | step finishes (any outcome) | `outcome` (`advance`\|`hold`\|`changes`\|`fail`), `costUsd?` (number, reported by the agent), `unpriced?` (`true` for a [local-model](local-models.md) or non-Claude-agent run, which then has no `costUsd`), `costBasis?` (`reported` \| `rate-table`), `estUsd?` (an unpriced run's API-equivalent estimate, [agents.md](agents.md#estimated-cost-estusd); never summed into `costUsd`), and when the agent reported a result `model?`, `input`, `output`, `cacheRead`, `cacheCreate` (token counts); a step with `energy: true` adds `energyKwh?`, `energyUsd?`, `energySource?` (`hwmon`\|`command`\|`watts`) — measured electricity, never summed into `costUsd`/`estUsd` ([local-models.md](local-models.md#energy)); a sandboxed run whose egress proxy refused a host adds `egressDenied?` (`["<host>:<port>", …]`, most-denied first, at most 20 — [sandbox.md](sandbox.md#egress); the outcome is unchanged) and, when the proxy's own denied-log cap was hit, `egressDeniedTruncated?` (number — count of denials dropped from the log) |
| `pipeline_done` | task advances into a terminal step (`manual + drainWorktree`, e.g. `done`) | `name`, `url` |
| `board_done` | the ticket is done on the board. `via:"flag"`: the tracker delivered its own done flag flipping on a ticket of ours (GitHub issue closed, Asana task completed, Jira done-category status, Linear completed/canceled state; once per delivery, `step` is `""`). `via:"stage"`: the ticket entered any manual step's source stage, with or without `drainWorktree` (`step` = that step). A signal only: no agent, no board move. See [internals/trackers.md](internals/trackers.md#done-signal) | `via` (`flag`\|`stage`), `name`, `url` (stage only) |
| `verdict_missing` | a clean exit with a missing/unparseable/unrecognized verdict file, right before the hold it forces (`requireVerdict` defaults to `true`) | `reason` (`"no valid verdict"`) |
| `blocked` | verdict is `hold` | `reason` (string \| null), `name`, `url` |
| `failed` | verdict is `fail` (incl. a `changes` forced to fail by the loop cap) or a run interrupted by restart | `reason` (string \| null), `name`, `url` (no name/url for restart) |
| `move_refused` | a verdict's move did not happen: the adapter's `advance` refused it (fail-closed owner check — `not_ours`, or `owner_check_failed` when the assignee read still failed after retrying 5xx/429/network errors) or threw. Follows `run_end`/`blocked`/`failed`; the ticket is **still in its stage** and the next step will not fire. Also emitted from the red-CI bounce, route-hold and restart-recovery moves | `outcome` (the verdict that was refused), `reason` (`not_ours`\|`owner_check_failed`\|`move_error`), `detail` (error message, ≤200 chars) |
| `merged` | a [forge](asana-setup.md#completing-tasks-on-merge-forge) saw the task's `agent/<ref>` PR merge (after the merge bridge moved + completed the task, or skipped that because the board closes it itself) | `name`, `url` (`step` = the `completeOnMerge` step, or `""`) |
| `ci_green` | a [forge](asana-setup.md#red-ci-on-agent-prs) saw a green `workflow_run` on the task's `agent/<ref>` PR and the whole check-run roll-up for that head is `success` (same roll-up as the MCP `prs` tool). Emitted once per `(ref, sha)`; a signal only — nothing moves. `forge.greenCi:false` disables | `pr`, `sha`, `mergeable`, `mergeState` (`step` is `""`). Not emitted when a non-Actions check is the last to finish (no `workflow_run` fires for it) |
| `ci_red` | a [forge](asana-setup.md#red-ci-on-agent-prs) saw a red CI run on the task's `agent/<ref>` PR and acted | `action` (`rerun`\|`deferred`\|`bounced`\|`skipped`), `runId`, `attempt`, `sha`, `pr`, `target?` (`step` = the step it bounced from, or `""`; a bounce forced to `fail` by the loop cap emits `failed` instead) |
| `overlap_held` | [`overlapGuard`](architecture.md#file-overlap-guard-overlapguard-opt-in): the task's predicted paths overlap another in-flight task's lock, so its step waits in its source stage (no agent, no move) | `blockedBy` (the ref holding the lock) |
| `overlap_released` | `overlapGuard`: the blocker left the pipeline and the waiting task is re-offered to its step | `blockedBy` |
| `epic_skipped` | a pipeline job reached an item that is an epic; no agent ran, nothing moved | `name`, `url` |
| `epic_changed` | **GitHub and Jira trackers**: the hook delivered an epic-structure change. GitHub: a `sub_issues` event (sub-issue added/removed, parent added/removed) whose parent is an epic in this repo, or an issue `typed`/`untyped` to/from the epic type (or still an epic via its label). Jira: a child gained/lost/changed its parent (changelog `IssueParentAssociation`, for both the old and the new epic), an issue was created or deleted under an epic, or an epic was created or retyped. A read-only signal: no agent, no board write; the receiver drops its cached epics read so the next `epics` call (and the UI's Epics view, which refetches on it) is fresh. Once per delivery. Not in the sinks' default set, and **hidden by default** like `coalesced` | — (`ref` = the epic, `step` is `""`) |
| `quota_pause` | the opt-in [quota pacer](operating.md#claude-quota-readout-and-pacing) saw a Claude quota reading at or above a `quota` threshold: new runs stop starting (running agents finish, jobs still queue) until the window resets. Also audited to `control-audit.jsonl` (actor `quota`) (`ref`/`step` = `""`) | `window` (`sevenDay`\|`fiveHour`), `utilization`, `threshold`, `resetsAt` (ISO) |
| `quota_resume` | the quota pause was lifted. `reason`: `reset` (the window's reset time passed), `below` (a newer reading is under the threshold) or `operator` (a `resume` overrode it until the window resets). The queue restarts only if no operator pause, restart or decommission holds it (`ref`/`step` = `""`) | `window`, `reason` |
| `restart_requested` | a control-socket `restart {when:"idle"}` was accepted: new runs pause (jobs still queue to `queue.json`) until active agents reach 0 (`ref`/`step` = `""`) | `active`, `queued` |
| `restarting` | active agents reached 0 — the receiver exits gracefully and respawns detached on the same config, then runs one reconcile (`ref`/`step` = `""`) | `queued` (jobs left in `queue.json` for the new process) |
| `decommission_requested` | a control-socket `decommission {when:"idle"}` was accepted: new runs pause (jobs still queue to `queue.json`) until active agents reach 0 (`ref`/`step` = `""`) | `active`, `queued`, `unregister` (boolean) |
| `decommissioning` | active agents reached 0 and the webhooks were unregistered (best-effort) — the receiver exits gracefully without a respawn and archives its state dir to `~/.agenthook-archive/<key>-<YYYY-MM-DDTHH-MM-SS>/` (`ref`/`step` = `""`) | `queued` (jobs left in the archived `queue.json`), `unregister` (`{tracker, forge, errors?}`: `ok`\|`failed`\|`none`, or `skipped` for both when not requested) |
| `sandbox_reaped` | boot force-removed sandbox containers/networks a killed receiver left running (`[recover] reaped …`, [sandbox.md](sandbox.md)); emitted only when something was reaped (`ref`/`step` = `""`) | `containers`, `networks` (counts), `runs` (the distinct `"<ref>/<step>"` values read from the removed containers' labels, best-effort — may be `[]`) |

Both decommission events land in the **archived** `events.jsonl` (the state dir moves after them).

`pipeline_done` is the signal that a ticket is fully finished and its PR is ready for merge.
`blocked`, `failed` and `move_refused` are the needs-attention signals.

## Guarantees

- **Best-effort, never fatal.** A write failure logs a warning; the pipeline continues unaffected.
- **Blind to the tracker.** Events are emitted from the engine/dispatch layer, so every tracker
  (Asana, Jira, GitHub, GitHub Projects) gets the same stream.
- **One emitter, one profile.** Each profile writes its own `events.jsonl`; events from different
  profiles are in different files.

## Sinks

Opt-in, top-level `sinks` in `agenthook.config.json` forwards events to chat/webhooks. Absent = off.

```json
"sinks": [
  { "type": "slack",    "url": "${SLACK_WEBHOOK_URL}" },
  { "type": "telegram", "botToken": "${TELEGRAM_BOT_TOKEN}", "chatId": "123456" },
  { "type": "webhook",  "url": "https://example.com/hook", "events": ["blocked"] }
]
```

- `events` defaults to `["blocked","failed","move_refused","pipeline_done"]`; any event name is accepted.
- slack: `{ text }` to the incoming-webhook URL. telegram: Bot API `sendMessage`. webhook: the raw
  event JSON plus a `profile` field.
- Text: `[agenthook:<profile>] <event> <ref> "<name>" (step <step>)`, then `reason`, then `url`.
- Required fields are validated at config load (`slack`/`webhook` → `url`; `telegram` → `botToken` + `chatId`).
- **Best-effort:** fire-and-forget, 5s timeout, failures only `console.warn` (never the URL/token);
  delivered in emit order per sink; up to 100 pending per sink, oldest dropped beyond that; no retries.
