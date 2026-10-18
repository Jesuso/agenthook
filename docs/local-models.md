# Mixed pipelines / local models

Each pipeline step can run its agent on a different model. A common split: a local model for the
cheap, read-only steps (`triage`, `review`), Claude for `code`. This page is the recipe. A step can
also run a different agent CLI altogether (`agent: "cursor"`, `"hermes"` or `"opencode"`); see [Agents](agents.md).

## Pointing a step at a local model

Claude Code talks to any Anthropic-compatible Messages endpoint named by `ANTHROPIC_BASE_URL`.
Point one step at your local server with the step's `env`, and name the local model with the
step's `model`:

```jsonc
{
  "id": "triage",
  "model": "qwen3-coder",
  "env": { "ANTHROPIC_BASE_URL": "http://localhost:11434" }
}
```

For example, Ollama 0.14 or later serves `/v1/messages`. Use a model with a context window of at
least 32K tokens: the standing instructions, the ticket and the repo reads add up quickly.

Running the step on **Hermes** instead of Claude Code against a local Ollama model is simpler —
Hermes' `--provider` flag picks the inference provider directly, no `ANTHROPIC_BASE_URL`
wrapper needed. See the [local Qwen recipe](agents.md#a-local-qwen-recipe-hermes--ollama) in
[Agents](agents.md). The step runs [isolated](agents.md#hermes-isolation) by default (its own
`HERMES_HOME`, no credentials), which suits a local model. Set `provider` to the `providers:` entry
in your Hermes `config.yaml` that points at Ollama, e.g. `ollama-launch`; otherwise the run uses
your `config.yaml` default, and a cloud default fails before the run starts.

If you'd rather keep that wiring out of the config, put it in a wrapper script on PATH (say
`claude-local`, which exports `ANTHROPIC_BASE_URL` and runs `claude "$@"`) and set the step's
`bin` to it:

```jsonc
{ "id": "review", "bin": "claude-local" }
```

## Which steps suit a local model

Read-only steps are the best fit:

- **triage**: reads the ticket and the code, writes a spec and a verdict.
- **review**: reads the diff, runs the tests, writes a verdict and findings.

Steps that write code (`code`, a `createsWorktree` step) gain the most from a stronger model.

## Knobs that matter

| Step key | Why |
|----------|-----|
| `bin` | The agent CLI for this step (default the top-level `claudeBin`). |
| `env` | Extra environment for this step's agent only, e.g. `ANTHROPIC_BASE_URL`. |
| `model` | The model name your endpoint serves. |
| `requireVerdict` | Hold the task when the agent exits cleanly without a valid verdict file, instead of advancing it. Weaker models skip the verdict more often. |
| `maxConcurrent` | `1` when one GPU serves the model, so runs of this step queue instead of competing. The cap counts inside the global `maxConcurrent`. |
| `maxMinutes` / `idleMinutes` | Local models are slower. Raise the wall-clock cap, and the idle cap if you set one. |
| `maxAttempts` | Caps how many times a `changes` verdict can bounce back into a step. |

A weaker model is more likely to loop: a local `review` can keep returning `changes` that `code`
can't satisfy. `maxAttempts` (default 3) bounds that loop, then the task fails to a human.

## Cost reporting

`claude` prices every run from its own Claude price table, so a run on a local model still
reports a dollar figure that means nothing. agenthook treats a run as **unpriced** when its step
sets a `bin` other than `claudeBin`, or when the model that ran is not a Claude model (a
`claude-…` id, a Bedrock/Vertex `anthropic.claude-…` id, or an alias such as `opus`, `sonnet`,
`haiku`, `default`). Setting only `env` with a Claude model name does not mark a run unpriced.

An unpriced run keeps its tokens but shows no reported dollars:

- its `run_end` event has `unpriced: true` and no `costUsd`, so the web UI's reported ticket cost,
  Stats spend and per-ticket cost leave it out. Map the model in the `pricing` config (e.g.
  `"qwen3.8*": {"input": 2, "output": 10}`) to get an API-equivalent `~$x est.` beside them,
  never added in — see [Agents → Estimated cost](agents.md#estimated-cost-estusd);
- its `usage.jsonl` record has `unpriced: true` (and `bin` when overridden). `ah usage`,
  `ah status` and `ah ls` leave its cost out of every total. See [Token & cost tracking](usage.md).

## Energy

A local run's real cost is electricity. A step that sets `"energy": true` gets its run's
**measured** energy — kWh and dollars at your rate — as a third figure beside the reported
`costUsd` and the `~$x est.` estimate. It is never added to either, and `costBasis` is unchanged.
The profile names the price and where power is read from:

```json
"energy": { "usdPerKwh": 0.15, "source": { "type": "hwmon", "name": "amdgpu" } }
```

`source` is one of:

| `type` | Reads | Notes |
|---|---|---|
| `hwmon` | `/sys/class/hwmon/*/name` = `name` (default `amdgpu`), then `power1_average` (else `power1_input`), µW | Every node with that name is summed (multi-GPU). The `hwmonN` index is never hard-coded; it moves between boots. |
| `command` | `cmd` run via `/bin/sh -c`; the first number on each stdout line is watts, lines summed | e.g. `nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits` (one line per GPU). 2 s budget per reading; the process group is killed on timeout. |
| `watts` | a constant `watts` (> 0) | No meter: e.g. `{"type":"watts","watts":250}` for a box you measured at the wall once. |

```json
"energy": { "usdPerKwh": 0.15, "source": { "type": "command", "cmd": "nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits" } }
```

The receiver reads power about once a second while at least one opted-in run is active — never
while idle. Each window between two readings is credited at their mean draw. When opted-in runs
overlap, each window is split between them by time share, so concurrent runs never double count.

A measured run's `run_end` event and `usage.jsonl` record carry `energyKwh`, `energyUsd` and
`energySource`. They show up in `ah usage` (a `· energy $… (… Wh)` suffix and an `energy total:`
line), `ah events`, the MCP `events`/`runs` tools, and the web UI (run list, ticket spend, Stats
strip and per-day tooltip). If a reading fails, the run still finishes and advances normally. It
gets no energy fields (or only the windows that read) and one `energy reading failed: …` line in
its run log.

Measured on an AMD RX 7900 XTX (`hwmon`, `amdgpu`): idle 8–14 W. A 27 s OpenCode + Qwen3.8 run
averaged 257 W (peak 351 W), so 1.91 Wh ≈ **$0.0003** at $0.15/kWh, against ≈ $0.04 for the same
tokens at API rates.

Caveats:

- **Gross draw.** The figure includes the device's idle draw during the run. It is not just the
  marginal cost of the model.
- **`hwmon` is GPU-only.** CPU, RAM and PSU losses are not counted, so it undercounts the wall.
  RAPL (`/sys/class/powercap`) needs root, so it is not a built-in source. Wrap a meter or a
  smart plug in a `command` instead.
- **Machine-wide.** Any other work on the GPU while an opted-in run is active, including runs of
  steps without `energy: true`, is attributed to the opted-in runs.

## Example

A GitHub-labels pipeline with local `triage` and `review` and a Claude `code` step:

```jsonc
{
  "tracker": {
    "type": "github",
    "pipeline": [
      {
        "id": "triage",
        "kind": "triage",
        "sourceLabel": "agent:triage",
        "successLabel": "agent:code",
        "failureLabel": "agent:failed",
        "holdLabel": "agent:held",
        "model": "qwen3-coder",
        "env": { "ANTHROPIC_BASE_URL": "http://localhost:11434" },
        "requireVerdict": true,
        "maxConcurrent": 1,
        "maxMinutes": 240
      },
      {
        "id": "code",
        "sourceLabel": "agent:code",
        "successLabel": "agent:review",
        "failureLabel": "agent:failed",
        "holdLabel": "agent:held",
        "createsWorktree": true,
        "model": "opus"
      },
      {
        "id": "review",
        "kind": "review",
        "sourceLabel": "agent:review",
        "successLabel": "agent:done",
        "failureLabel": "agent:failed",
        "holdLabel": "agent:held",
        "model": "qwen3-coder",
        "env": { "ANTHROPIC_BASE_URL": "http://localhost:11434" },
        "requireVerdict": true,
        "maxConcurrent": 1,
        "maxMinutes": 240,
        "maxAttempts": 3
      },
      { "id": "done", "manual": true, "sourceLabel": "agent:done", "drainWorktree": true }
    ]
  }
}
```
