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
| `pulled` | a free slot pulled the item from its step's opt-in queue stage (moved via `enterStage(…, {assign:false})`; its `enqueued` follows when the webhook lands) | `from` (the queue stage: section gid / status / label), `rank` (0-based board position) |
| `run_start` | `claude -p` spawns for a step | `model` (string \| null) |
| `run_end` | step finishes (any outcome) | `outcome` (`advance`\|`hold`\|`changes`\|`fail`), `costUsd?` (number) |
| `pipeline_done` | task advances into a terminal step (`manual + drainWorktree`, e.g. `done`) | `name`, `url` |
| `blocked` | verdict is `hold` | `reason` (string \| null), `name`, `url` |
| `failed` | verdict is `fail` (incl. a `changes` forced to fail by the loop cap) or a run interrupted by restart | `reason` (string \| null), `name`, `url` (no name/url for restart) |
| `merged` | a [forge](asana-setup.md#completing-tasks-on-merge-forge) saw the task's `agent/<ref>` PR merge (after the task is moved + completed) | `name`, `url` (`step` = the `completeOnMerge` step, or `""`) |
| `ci_red` | a [forge](asana-setup.md#red-ci-on-agent-prs) saw a red CI run on the task's `agent/<ref>` PR and acted | `action` (`rerun`\|`deferred`\|`bounced`\|`skipped`), `runId`, `attempt`, `sha`, `pr`, `target?` (`step` = the step it bounced from, or `""`; a bounce forced to `fail` by the loop cap emits `failed` instead) |

`pipeline_done` is the signal that a ticket is fully finished and its PR is ready for merge.
`blocked` and `failed` are the needs-attention signals.

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

- `events` defaults to `["blocked","failed","pipeline_done"]`; any event name is accepted.
- slack: `{ text }` to the incoming-webhook URL. telegram: Bot API `sendMessage`. webhook: the raw
  event JSON plus a `profile` field.
- Text: `[agenthook:<profile>] <event> <ref> "<name>" (step <step>)`, then `reason`, then `url`.
- Required fields are validated at config load (`slack`/`webhook` → `url`; `telegram` → `botToken` + `chatId`).
- **Best-effort:** fire-and-forget, 5s timeout, failures only `console.warn` (never the URL/token);
  no retries or queuing; never affects the pipeline.
