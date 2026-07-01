# Token & cost tracking

agenthook captures token usage and cost from every `claude -p` run and surfaces the data in
`ah usage`, `ah agents`, `ah status`, and `ah ls`. This page explains where the data comes from,
where it lives, and how to read each view.

## How capture works

Every `claude -p` spawn includes `--output-format stream-json --verbose`. That flag makes the CLI
emit one JSON object per line on stdout. agenthook parses that stream live:

- **Per-run log rendering** — `assistant` events containing text content blocks are rendered as
  human-readable text in the per-run log (under `~/.agenthook/<name>/logs/`). The raw JSONL never
  appears in the log; only the extracted assistant text does. `ah follow` is unchanged — it still
  tails the Claude transcript directory (derived from `repoPath`), not the per-run log.
- **Token/cost tally** — on a clean exit, the stream emits a `result` event. agenthook reads its
  `usage` fields and `total_cost_usd`, then appends one `UsageRecord` to `usage.jsonl`.

`total_cost_usd` is the `claude` CLI's own cost figure, surfaced verbatim. agenthook does not
compute or estimate costs itself.

## Where records live

`usage.jsonl` sits in the central state directory for the profile:

```
~/.agenthook/<name>/usage.jsonl
```

It is append-only, one JSON object per line. Each line is a `UsageRecord`:

| Field         | Type     | Description                                              |
|---------------|----------|----------------------------------------------------------|
| `ref`         | string   | The task identifier (issue number, Asana gid, …)        |
| `stepId`      | string   | The pipeline step that ran (`code`, `review`, …)        |
| `model`       | string?  | Model that ran (from the step config or `modelUsage`)   |
| `startedAt`   | string   | ISO timestamp — when the run was spawned                 |
| `endedAt`     | string   | ISO timestamp — when the run exited                     |
| `durationMs`  | number?  | `result.duration_ms` if reported by the CLI             |
| `input`       | number   | `usage.input_tokens`                                    |
| `output`      | number   | `usage.output_tokens`                                   |
| `cacheRead`   | number   | `usage.cache_read_input_tokens`                         |
| `cacheCreate` | number   | `usage.cache_creation_input_tokens`                     |
| `costUsd`     | number?  | `result.total_cost_usd` (the CLI's own cost figure)     |
| `sessionId`   | string?  | `result.session_id`                                     |

## `ah usage`

```bash
ah usage                    # per-run table, newest last
ah usage --ref <n>          # filter to one task's runs
ah usage --day              # group by UTC calendar day
ah usage --week             # group by ISO week (wins over --day if both given)
ah usage --limit <n>        # cap rows shown (totals are still over the full set)
```

**Default per-run table** columns: `Ref`, `Step`, `Model`, `Input`, `Output`, `CacheRead`,
`CacheCreate`, `$`. A `TOTAL` row is appended.

```
Ref   Step    Model                Input   Output  CacheRead  CacheCreate       $
42    code    claude-sonnet-5      12 340   3 210      8 100          420   $0.04
42    review  claude-sonnet-5       9 100   1 820      9 100            0   $0.02
─────────────────────────────────────────────────────────────────────────────────
TOTAL                              21 440   5 030     17 200          420   $0.06
```

**Rollup tables** (`--day` / `--week`) columns: `Period`, `Runs`, `Input`, `Output`, `CacheRead`,
`CacheCreate`, `$`, `Models`. The `Models` column shows a per-model token breakdown for that period.

If `usage.jsonl` doesn't exist yet (no runs have completed), `ah usage` prints:

```
no usage recorded yet
```

## Surfaced columns in other commands

Token and cost data appears wherever you look at running or past work:

### `ah agents`

Each live agent line includes a `tok=<in>k/<out>k [$<cost>]` field:

```
42  code  claude-sonnet-5  tok=12k/3k [$0.04]  …
```

The tally is read live from `running.json` (updated as the stream parses). If no live data exists,
it falls back to the last `usage.jsonl` record for that ref. Shown as `-` when neither is available.

### `ah status`

A usage summary line appears at the profile level:

```
usage : 21 440 tokens, $0.06 over 2 run(s)
```

Recent-run entries in `ah status` also show a per-run annotation:

```
[run] 42 code  … [21k tok, $0.06]
```

### `ah ls`

The profile list adds `TOKENS` and `COST` columns. Both are blank when `usage.jsonl` is absent or
unreadable — the command never errors on a missing file.

## Log-format note

Before token tracking, the per-run log contained raw `claude -p` output. It now contains rendered
assistant text extracted from the `stream-json` stream. The format change is automatic; no config is
needed. `ah follow` is unaffected — it tails the Claude transcript directory, which has not changed.
