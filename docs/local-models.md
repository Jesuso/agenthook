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
  never trips;
- it exited non-zero with no model output tokens — not a timeout, not a cancel — and the model API
  was unreachable at the connection level, **at any wall time**: `downGraceSeconds` only governs
  the fast-exit signal above, because an agent CLI that keeps retrying a dead backend can run well
  past it with nothing to show for it. Detected from a bounded scan of the run's own output
  (`ECONNREFUSED`/`ENOTFOUND`/`EHOSTUNREACH`/`ETIMEDOUT`/`ECONNRESET`, the egress proxy's `egress: …
  failed`/`cannot resolve` line, or `API Error: 502/503/504`); a sandboxed run instead prefers the
  egress proxy's own `upstream-failures.jsonl` record for the step's `ANTHROPIC_BASE_URL` host.
  Any 4xx `API Error` (bad request, auth, quota) is the model API answering, not a connection
  failure, and never trips — even on a line that also contains one of the tokens above.

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

### Worked example: Claude Code on a local Ollama, spilling to the cloud

This is the maintainers' own dogfood setup, as validated on 2026-11-08. The agent harness is
**Claude Code in both cases**; Ollama is only the inference runner behind it. Claude Code sends
its Messages-API requests wherever `ANTHROPIC_BASE_URL` points, and Ollama (0.14+) answers them
on `/v1/messages`, so the local harness differs from the cloud one only in that URL and the
model name. Tools, worktree, verdict file and the MCP server are Claude Code's, unchanged.

```jsonc
{
  "maxConcurrent": 3,
  "harnesses": {
    // Claude Code → this box's Ollama. Two slots because the GPU serves two 64K contexts
    // (OLLAMA_NUM_PARALLEL=2); a third would queue inside Ollama and look like a stall.
    "local": {
      "model": "qwen3.8:27b-64k",
      "env": { "ANTHROPIC_BASE_URL": "http://192.168.1.20:11434" },
      "maxConcurrent": 2
    },
    // Claude Code → Anthropic, the previous default of the step.
    "cloud": { "model": "claude-sonnet-5" }
  },
  "sandbox": {
    "type": "docker",
    "egress": { "mode": "allowlist", "allow": ["@npm", "192.168.1.20:11434!private"] }
  },
  "tracker": {
    "pipeline": [
      { "id": "triage", "kind": "triage", "model": "claude-opus-5-5" },
      { "id": "code", "harness": ["local", "cloud"], "routing": "first-free", "createsWorktree": true, "maxMinutes": 180 },
      { "id": "review", "kind": "review", "model": "claude-opus-5-5" }
    ]
  }
}
```

Notes from running it:

- **Routing.** With two `code` tickets the first two runs take `local`'s slots; a third spills to
  `cloud` at once (`first-free`) and `tick` shows `local 2/2, cloud 1`. When a local slot frees,
  the next ticket goes local again.
- **Context overhead.** Claude Code's first request already carries its system prompt, tool
  definitions, the repo's `CLAUDE.md` and the step's instructions: about 20–25K tokens before
  the model has read a single file. On a 64K context that is more than a third of the window,
  and Claude Code assumes a 200K window when it decides to compact. Prefer a model tag with a
  96K or 128K context for the `code` step; keep 64K for `triage`/`review`. A 64K window paid for
  it directly: a `code` run on OpenCode + a 64K-context Qwen model compacted 6× in 40 minutes,
  each compaction costing a burst of re-reads to rebuild context — visible as `🗜 compaction` in
  the run log and tallied per run as `compactions` in `ah stats` (#657).
- **Speed.** A 27B model on one consumer GPU wrote the same class of small PR in 11–50 minutes
  where the cloud model took 5–10. Set the step's `maxMinutes` accordingly (180 here).
- **Harmless warning.** The run log starts with
  `[claude-code:unrecognized_model] {"model":"qwen3.8:27b-64k"}`: Claude Code does not know the
  name, but passes it through.
- **Ollama compatibility.** Ollama 0.40 occasionally answers a long tool-use conversation with
  `API Error: 500 no user query found in messages` on `/v1/messages`; Claude Code retries, then
  exits 1 and the run fails as a normal failure (it produced output, so the breaker does not
  trip; the ticket's next attempt reruns it). It is an Ollama bug, not a routing one: rerun, or
  retry the ticket on the cloud harness.
- **Backend down.** With Ollama stopped, a `local` run fails with
  `API Error: 502 … upstream 192.168.1.20:11434 failed: connect ECONNREFUSED`; the breaker marks
  `local` down and the run goes to `cloud` (see [When a harness fails](#when-a-harness-fails)).
  Claude Code retries for a few minutes first, so expect the spill a few minutes after the stop,
  not at once.
- **Firewall.** The container reaches Ollama through the egress proxy at the host's LAN address;
  a host firewall may drop that (`sudo ufw allow in on docker0 to any port 11434 proto tcp`).

### Variant: OpenCode on the same Ollama

OpenCode also runs inside the sandbox (#647), so the same example can spill through an OpenCode
harness on the same Ollama — the `harnesses` block gains a third entry and the `code` step lists
it first:

```jsonc
{
  "harnesses": {
    "oc-local": {
      "agent": "opencode",
      "model": "ollama/qwen3.8:27b-64k",
      "opencodeConfig": "~/.agenthook/<profile>/opencode-lan.json",
      "maxConcurrent": 1
    },
    "local": { "model": "qwen3.8:27b-64k", "env": { "ANTHROPIC_BASE_URL": "http://192.168.1.20:11434" }, "maxConcurrent": 1 },
    "cloud": { "model": "claude-sonnet-5" }
  },
  "tracker": {
    "pipeline": [
      { "id": "code", "harness": ["oc-local", "local", "cloud"], "routing": "first-free", "createsWorktree": true, "maxMinutes": 180 }
    ]
  }
}
```

`local` and `oc-local` share one GPU, so their `maxConcurrent` values should add up to what Ollama
serves in parallel (`OLLAMA_NUM_PARALLEL`): here 1 + 1 on the two-slot server above (`local` drops
from 2 to 1). A third context on a two-slot server would queue inside Ollama and look like a stall.

The harness's `opencodeConfig` is a minimal OpenCode config with the one provider and model:

```jsonc
{
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://192.168.1.20:11434/v1" },
      "models": {
        "qwen3.8:27b-64k": { "limit": { "context": 65536 } }
      }
    }
  }
}
```

See [OpenCode in the sandbox](sandbox.md#opencode-in-the-sandbox) for why this file is copied —
never mounted — into the run's per-run sandbox HOME, and why `localhost` in it reaches the
container, not the host. The `!private` egress rule and the `docker0` firewall note above apply
to this URL too.

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
