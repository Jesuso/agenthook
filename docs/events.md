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
| `enqueued` | job enters the queue after dedup (engine `intake`), or is re-enqueued from `queue.json` on boot | `restored?` (`true` on boot restore) |
| `run_start` | `claude -p` spawns for a step | `model` (string \| null) |
| `run_end` | step finishes (any outcome) | `outcome` (`advance`\|`hold`\|`changes`\|`fail`), `costUsd?` (number) |
| `pipeline_done` | task advances into a terminal step (`manual + drainWorktree`, e.g. `done`) | — |
| `blocked` | verdict is `hold` | `reason` (string \| null) |
| `failed` | verdict is `fail` | `reason` (string \| null) |

`pipeline_done` is the signal that a ticket is fully finished and its PR is ready for merge.
`blocked` and `failed` are the needs-attention signals.

## Guarantees

- **Best-effort, never fatal.** A write failure logs a warning; the pipeline continues unaffected.
- **Blind to the tracker.** Events are emitted from the engine/dispatch layer, so every tracker
  (Asana, Jira, GitHub, GitHub Projects) gets the same stream.
- **One emitter, one profile.** Each profile writes its own `events.jsonl`; events from different
  profiles are in different files.
