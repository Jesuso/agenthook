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
| `requireVerdict` | On by default: hold the task when the agent exits cleanly without a valid verdict file, instead of advancing it. Weaker models skip the verdict more often — set `false` to opt back out to the old advance-on-clean-exit behavior. |
| `maxConcurrent` | `1` when one GPU serves the model, so runs of this step queue instead of competing. The cap counts inside the global `maxConcurrent`. Several steps sharing one GPU: use a [harness](#several-backends-harnesses) instead. |
| `maxMinutes` / `idleMinutes` | Local models are slower. Raise the wall-clock cap, and the idle cap if you set one. |
| `maxAttempts` | Caps how many times a `changes` verdict can bounce back into a step. |

A weaker model is more likely to loop: a local `review` can keep returning `changes` that `code`
can't satisfy. `maxAttempts` (default 3) bounds that loop, then the task fails to a human.

## Several backends: harnesses

A step's `maxConcurrent` caps one step. When two steps share one local GPU, they can still hit it
at once, and a step can't fall back to another backend when its own is busy. A **harness** fixes
both: a named bundle of agent knobs with its own slot pool, declared once at the top level and
named by any number of steps.

```jsonc
{
  "maxConcurrent": 4,
  "harnesses": {
    "local-qwen": { "agent": "claude", "model": "qwen3-coder", "env": { "ANTHROPIC_BASE_URL": "http://localhost:11434" }, "maxConcurrent": 1 },
    "opus":       { "agent": "claude", "model": "claude-opus-5-5", "maxConcurrent": 3 },
    "deepseek":   { "agent": "opencode", "model": "deepseek/deepseek-v3", "maxConcurrent": 2 }
  },
  "tracker": {
    "pipeline": [
      { "id": "triage", "harness": "opus" },
      { "id": "code",   "harness": ["local-qwen", "deepseek"], "routing": "first-free" },
      { "id": "review", "harness": ["deepseek", "opus"],       "routing": "round-robin" }
    ]
  }
}
```

A harness takes `agent`, `model`, `bin`, `env`, `provider`, `toolsets`, `maxConcurrent`,
`sandbox: { image }`, `cooldownMinutes` and `downGraceSeconds`, all optional. Unset
`maxConcurrent` = bounded only by the global cap.

- **When it's picked.** The queue picks the harness when the job *starts*, never earlier: a
  waiting job has none yet. `first-free` (the default) takes the first listed harness with a free
  slot; `round-robin` rotates through the list and skips full ones. `routing` needs a list.
- **All full.** The job waits (it counts in `slots.capped`, not as holding a global slot), and an
  unrelated job behind it still starts. A job starts only when the global cap, the step's own
  `maxConcurrent` and one of its harnesses all have room.
- **Precedence.** A knob the step sets itself wins over the harness's; a knob neither sets falls
  back to the profile (`agent`, `agentProvider`, `claudeBin`) and the agent's default, as before.
  `env` merges: the harness's, with the step's keys on top. `effort`, `escalate` and `lite` stay
  on the step, so `escalate`/`lite` still override a harness's `model`.
- **Sandbox.** A sandboxed run on a harness with `sandbox.image` uses that image instead of
  `sandbox.image`; the boot check inspects every configured image.
- **Behind the sandbox.** Inside a sandboxed run, `localhost` is the agent's container, not the
  host. Point `ANTHROPIC_BASE_URL` at an address the egress proxy can reach — the host's LAN IP
  (e.g. `http://192.168.1.20:11434`) — and allow it with a `!private` rule:
  `"sandbox": { "egress": { "allow": ["192.168.1.20:11434!private"] } }`. A host firewall may
  still drop traffic from the Docker bridge to that port; with ufw:
  `sudo ufw allow in on docker0 to any port 11434 proto tcp`. Symptom: no `egress denied` line
  for that host in the run log, but the connection times out.
- **Where to see it.** `ah tick --json` shows `slots.harnesses` (`{name: {active, max, state}}`) and
  `harnessUsage` (runs and tokens per harness); `ah status` prints a `harness :` line per harness;
  `run_start`/`run_end`, the usage record and each `runs` row carry `harness`; `running.json`
  records `harness` and `agent`; the digest snapshot sums `last24h.harnesses`. The web UI shows an
  `active/max` chip per harness on the Overview and edits `harnesses` under Basics → Advanced
  (renaming or removing one updates the steps that name it), and a step's `harness`/`routing` in
  its card.
- **Change a cap live.** MCP `set_concurrency {max, harness}` sets one harness's slot cap until
  the next restart (the config file and the global cap are untouched). Lowering it below the
  running count kills nothing; it only gates new starts. `max: 0` is allowed for a harness: it
  drains the harness (no new starts, running agents finish) — the way to keep runs off a dead
  backend before the breaker trips — and `max: n>0` re-enables it.

A step without `harness` behaves exactly as before, and a profile without `harnesses` reports the
same `slots` and events as before. Worktree, verdict and advance never depend on the harness.

### When a harness fails

A health breaker keeps a dead backend (Ollama stopped, a provider refusing, a missing `bin`) from
eating every run routed to it. A run on a harness **trips** it when:

- the agent's own preflight refused or threw (an unenforceable `allow`/`deny` policy, a sandbox
  the agent doesn't support, a credential or sandbox-setup refusal do *not* trip: those are
  config, not backend health);
- the agent CLI could not be spawned at all (e.g. `ENOENT`: the `bin` is missing);
- it exited non-zero within `downGraceSeconds` (default 30) with no model output tokens — not a
  timeout, not a cancel. A run that produced output and then failed (red tests, a `fail` verdict)
  never trips.

A trip marks the harness **down** for `cooldownMinutes` (1–60, default 10) and emits
`harness_down`. While the run's step is under its `maxAttempts` cap, the run that tripped it is not
failed: it ends with `run_end` `outcome: "requeued"`, goes back to the **front** of the queue (its
worktree kept) and starts again on the next harness with room — `first-free` spills to the next
listed one, `round-robin` skips the down one. At the cap it fails as it would without a breaker.
If every harness of a step is down, its jobs wait (counted in `slots.capped`) and never fail.

Once the cooldown passes the harness is **probing**: exactly one run at a time goes to it. A probe
that settles without tripping brings it back **up** (`harness_up`); one that trips puts it down
again with the cooldown doubled, up to 60 minutes. There is no timer: the cooldown is checked
whenever the queue moves (an event, a run finishing, `set_concurrency`, `resume`), so an idle
receiver whose step has every harness down starts the waiting job on the first of those after the
cooldown. `harness_reset {harness}` (MCP / control socket) brings a harness up at once, e.g. after
you restarted Ollama.

The state survives a restart in `harness-health.json` in the state dir (a harness removed from
the config is dropped; one whose cooldown passed while the receiver was down comes back probing).
`tick` shows a line per down or probing harness (`harness local-qwen: down until 14:32Z (spawn
failed: …)`), and `slots.harnesses[name]` carries `state`, plus `until` and `reason` when it isn't
up.

Without `harnesses` there is no breaker; a missing agent `bin` just fails the run (it no longer
crashes the receiver).

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
