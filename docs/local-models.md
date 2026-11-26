# Mixed pipelines / local models

Each pipeline step can run its agent on a different model. A common split: a local model for the
cheap, read-only steps (`triage`, `review`), Claude for `code`. This page is the recipe. A step can
also run a different agent CLI altogether (`agent: "cursor"`, `"hermes"`, `"opencode"` or `"pi"`); see [Agents](agents.md).

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
| `contextTokens` | A local model's context window is the binding constraint (e.g. 64K). Set it on the step or the harness (the step's own wins) so `status`/`tick`/the UI show `ctx used/max` while a run is live — an opencode harness with `opencodeConfig` gets it automatically from that config's `limit.context`, so you only need this for other agents or an override. |

A weaker model is more likely to loop: a local `review` can keep returning `changes` that `code`
can't satisfy. `maxAttempts` (default 3) bounds that loop, then the task fails to a human.

A second way a weak/local model stalls is ending its turn with a **question** instead of a verdict —
"Want me to go ahead?", "Should I apply the fix?" — because it's unsure and there's no one to ask.
With `requireVerdict` on (the default) that still holds the task, but instead of the generic
`"no valid verdict"` the held reason (and the `blocked`/`verdict_missing` events) read
`no verdict: the agent ended by asking a question instead of acting: "<the line>"`, quoting the
question so you can see exactly what it wanted to know. The fix is the same as for a normal
hold: answer it with `release {ref, comment}` (the comment lands in the resumed run's prompt) or
re-instruct with `run {ref, force:true}`. Every step prompt already tells the agent it is
unattended and must not stop to ask, but smaller models still do — this reason names when that
happened.

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

A harness takes `agent`, `model`, `effort`, `bin`, `env`, `provider`, `toolsets`, `maxConcurrent`,
`sandbox: { image }`, `cooldownMinutes` and `downGraceSeconds`, all optional. Unset
`maxConcurrent` = bounded only by the global cap. A step's `harness` list element may also be an
object instead of a name: `{ "name": "local-qwen", "model": "qwen3-coder", "effort": "high" }`
pins that harness's `model`/`effort` for runs routed to it alone — the strongest lever, meant for
a step that lists several backends and wants a different model/effort on each.

- **When it's picked.** The queue picks the harness when the job *starts*, never earlier: a
  waiting job has none yet. `first-free` (the default) takes the first listed harness with a free
  slot; `round-robin` rotates through the list and skips full ones. `routing` needs a list.
- **All full.** The job waits (it counts in `slots.capped`, not as holding a global slot), and an
  unrelated job behind it still starts. A job starts only when the global cap, the step's own
  `maxConcurrent` and one of its harnesses all have room.
- **Reserve (#745).** A harness some step lists as its *only* harness ("exclusive") gets an
  automatic reserve of 1 slot whenever another step lists it as one option among several — so a
  spill from that other step can never take the exclusive step's last slot. `harnesses.<name>.reserve`
  overrides the automatic value (an integer ≥ 0; `0` turns the reserve off); it's ignored, with a
  doctor note, on a non-exclusive or uncapped harness. The rule only counts an *open* alternative:
  a harness that's down (health or quota) or drained to `maxConcurrent: 0` doesn't count, so a job
  whose other harnesses are all down/drained may use every slot on the exclusive one, first come
  first served. Separately, whatever the reserve, the queue always prefers a startable job with no
  open alternative over one that has — so a spilling job never jumps ahead of a job that can only
  use that one harness. `ah tick`/`agenthook status` show a waiting job's `why` and count; `ah doctor`
  prints each exclusive harness's effective reserve.
- **Precedence.** Per `model` and `effort`, independently: an object entry's pin in the step's
  `harness` list wins over everything else for that harness alone, then `escalate` (the stored
  difficulty's tier), then `lite` (when the description carries its headings), then the step's own
  `model`/`effort`, then the harness's. Any other knob a step sets wins over the harness's; a knob
  neither sets falls back to the profile (`agent`, `agentProvider`, `claudeBin`) and the agent's
  default. `env` merges: the harness's, with the step's keys on top. So `escalate`/`lite` still
  override a harness's `model`/`effort`, but an entry pin overrides them too.
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

### Remote worker (experimental, #689)

A harness can run its agent on another machine instead of the host or the sandbox — add
`remote`:

```jsonc
{
  "harnesses": {
    "worker-1": {
      "remote": {
        "host": "10.0.0.5",
        "user": "agenthook",
        "identityFile": "/home/me/.ssh/agenthook_worker",
        "workDir": "/home/agenthook/work/some-repo"
      }
    }
  }
}
```

Full writeup — the trust model, worker setup, what never crosses, current limits, and
`agenthook doctor`'s preflight for it — is in [docs/remote.md](remote.md). Protocol detail:
[docs/internals/dispatch.md](internals/dispatch.md#the-ssh-executor-srcdispatchexecutor-sshjs-689-launchkillenv-690-code-transport).

### When a harness fails

A health breaker keeps a dead backend (Ollama stopped, a provider refusing, a missing `bin`) from
eating every run routed to it. A run on a harness **trips** it when:

- the agent's own preflight refused or threw (an unenforceable `allow`/`deny` policy, a sandbox
  the agent doesn't support, a credential or sandbox-setup refusal do *not* trip: those are
  config, not backend health);
- the agent CLI could not be spawned at all (e.g. `ENOENT`: the `bin` is missing);
- **the remote worker was unreachable** (a remote harness, #828): ssh could not get a connection
  at all — `Connection refused`, `Connection timed out` (every ssh call now carries a 10s
  `ConnectTimeout`), `No route to host`, `Could not resolve hostname`, or the connection dropped
  with nothing yet delivered. The `harness_down` reason is `worker unreachable: <host> (<detail>)`.
  An ssh **auth** or **host-key** failure is the worker answering but misconfigured: it refuses the
  run (`ssh auth failed on <host>: …` / `ssh host key failed on <host>: …`) and never trips;
- it exited non-zero within `downGraceSeconds` (default 30) with no model output tokens — not a
  timeout, not a cancel. A run that produced output and then failed (red tests, a `fail` verdict)
  never trips; a remote run that produced output before the link dropped (a mid-run connection
  loss) never trips either;
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
`harness_down`. The run that tripped it is not failed: it ends with `run_end`
`outcome: "requeued"`, goes back to the **front** of the queue (its worktree kept) and starts
again on the next harness with room — `first-free` spills to the next listed one,
`round-robin` skips the down one. A trip **never counts as an attempt** (#828): the step's
`maxAttempts` cap is for real runs, so a worker that stays down past it keeps its jobs queued,
not failed — each trip requeues and the attempt counter is restored to its pre-run value.
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
failed: …) — fix the cause, then harness_reset local-qwen`), and `slots.harnesses[name]` carries
`state`, plus `until` and `reason` when it isn't up.

A fast-exit trip's `reason` can carry the agent's own last error line after the receiver's own
"no output" observation, e.g. `exited 1 with no output after 3s: Failed to authenticate: OAuth
token revoked` — the agent's real complaint, not just the fact that it produced nothing (#688).
The line is redacted (secret-shaped env values and common token shapes become `***`) and the whole
reason stays bounded to ~300 chars; the other trip reasons already carry a specific cause and never
append it.

This is the one web-UI case that routing noise is not: a spill (a step's other harness picking up
the work because one is full, `first-free`/`round-robin`) is normal and never shown, but a harness
that **stops accepting work when it should** is surfaced. The web UI's Needs-you zone lists every
down/probing harness above the ticket rows — its name, the `state` pill, the `reason` and (while
down) `until`, plus the hint "Fix the cause, then run `harness_reset <name>`" — and counts it in the
headline and the Home card's needs-you figure. There is nothing to dismiss or click: the row
disappears on its own once `harness_up` fires. The slot chips next to the agent pips tint the same
way, with the reason in their tooltip, as a glance-level flag.

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
        "qwen3.8:27b-64k": {
          "limit": { "context": 65536 },
          "interleaved": { "field": "reasoning" },
          "variants": {
            "low": { "reasoningEffort": "low" },
            "medium": { "reasoningEffort": "medium" },
            "high": { "reasoningEffort": "high" }
          }
        }
      }
    }
  }
}
```

The `interleaved` entry lets a reasoning model see its own earlier thinking: OpenCode only sends
the model's earlier reasoning back on later turns when the model entry declares `interleaved`, and
it is off by default for a model under an OpenAI-compatible provider — without it, the model no
longer sees what it already reasoned and tends to write its plan again. On one replayed ticket
(Qwen3.8 27B, same prompt, hidden tests 94/94 in every run), two runs with the setting took 17.4
and 21.2 minutes with 81,025 and 95,292 reasoning characters; two default runs took 24.4 and 30.8
minutes with 120,993 and 138,863. That is about 30% less time and reasoning on average, from two
runs per side on a single ticket, and runs of the same setup differ from each other by about 20%
— read it as a direction, not a precise figure. The trade is context: with the reasoning staying
in the prompt, peak context was 112k and 119k tokens with the setting against 95k in the first
default run, so a long ticket reaches compaction sooner (see
[Small windows and compaction](#small-windows-and-compaction)). The field name `reasoning` is what
an Ollama OpenAI-compatible endpoint returns; another server may use `reasoning_content` — match
the server.

A step's `effort` becomes `opencode run --variant <effort>`, which OpenCode resolves against
this `variants` map — with no matching entry it has nothing to resolve, and no reasoning effort
is ever sent. The *names* here (`low`/`medium`/`high`) must equal the step's `effort` values
exactly; the `reasoningEffort` *values* must be levels this model server actually accepts (check
the server's docs — a value it rejects fails the request, it doesn't degrade gracefully). `ah
doctor` flags a declared model that's missing the variant a step's `effort` needs.

See [OpenCode in the sandbox](sandbox.md#opencode-in-the-sandbox) for why this file is copied —
never mounted — into the run's per-run sandbox HOME, and why `localhost` in it reaches the
container, not the host. The `!private` egress rule and the `docker0` firewall note above apply
to this URL too.

An unattended run can't act on tool output it didn't ask for (a permission prompt) or doesn't
need (web search, task delegation) — turn those off in the same `opencodeConfig` with a
`permission` block (OpenCode 1.19.5; `tools` is deprecated in its favor):

```jsonc
{
  "permission": { "webfetch": "deny", "skill": "deny", "task": "deny", "todowrite": "deny" }
}
```

agenthook copies `opencodeConfig` verbatim, so any key OpenCode's schema accepts works here with
no agenthook change — verify key names against the installed CLI's own schema/docs before relying
on one, since they can change between OpenCode versions.

### Variant: Pi on the same Ollama

Pi (Earendil's coding-agent CLI) also runs inside the sandbox (#752), so the same example can spill
through a Pi harness on the same Ollama — the `harnesses` block gains an entry and the `code` step
lists it:

```jsonc
{
  "harnesses": {
    "pi-local": {
      "agent": "pi",
      "model": "ollama/qwen3.8:27b-64k",
      "piConfigDir": "~/.agenthook/<profile>/pi-lan",
      "maxConcurrent": 1
    },
    "local": { "model": "qwen3.8:27b-64k", "env": { "ANTHROPIC_BASE_URL": "http://192.168.1.20:11434" }, "maxConcurrent": 1 },
    "cloud": { "model": "claude-sonnet-5" }
  },
  "tracker": {
    "pipeline": [
      { "id": "code", "harness": ["pi-local", "local", "cloud"], "routing": "first-free", "createsWorktree": true, "maxMinutes": 180 }
    ]
  }
}
```

The harness's `piConfigDir` is a host dir holding Pi's `models.json` (and optionally
`settings.json`); the run's model is `provider/id`, naming the provider below:

```jsonc
{
  "providers": {
    "ollama": {
      "baseUrl": "http://192.168.1.20:11434/v1",
      "models": [
        { "id": "qwen3.8:27b-64k", "name": "Qwen3.8 27B", "contextWindow": 65536, "api": "openai-completions" }
      ]
    }
  }
}
```

agenthook copies `piConfigDir`'s files verbatim — never mounted — into the run's per-run sandbox
HOME at `.pi/agent/` (see [Pi in the sandbox](sandbox.md#pi-in-the-sandbox)). A bad `piConfigDir`
(missing, not a directory, an oversized or invalid file) refuses the run before anything spawns.
Pi also runs on a **remote** worker (`harnesses.<name>.remote`): the same contract + standing
files via `--append-system-prompt`, the `--offline`/`PI_OFFLINE=1` env, and the worker's **own**
`~/.pi/agent` — there a step's `piConfigDir` is ignored (warned, never copied); see
[Pi on the worker](remote.md#pi-on-the-worker).
Pi takes no allow/deny policy and its print mode has no permission prompt, so a pi step must run
sandboxed; see [Agents](agents.md#a-local-model-step-pi--ollama).

#### Compaction survival (verified)

The unattended contract and a step's standing instructions are written to files in the run's
sandbox HOME and passed with `--append-system-prompt`, not appended to the one-shot run prompt.
Unlike a run-prompt line, an `--append-system-prompt` file is re-read into the system prompt and
**survives compaction** — verified on Pi 1.5.2 through a logging proxy across four compactions: a
marker string in an `--append-system-prompt` file was still in the system prompt of every agent
request after each one. The check used a marker, not the contract text itself; the contract and
standing files travel by the same flag.
This is why a pi run gets its contract as an `--append-system-prompt` file (one per file) rather
than in the run prompt.

A `models.json` whose `contextWindow` leaves no room for output does not let pi compact: the turn
ends with `stopReason: "length"` and pi exits 0. That is the existing `verdict_missing` path (the
run log gets `⚠ turn ended: stopReason length (context window full)`, the task is held, and — because
`sandboxResume` is false — there is no repair resume), so no special handling is needed.

### Small windows and compaction

A 64k window like `qwen3.8:27b-64k` above compacts often. When OpenCode auto-compacts, it appends
a synthetic user message with a hardcoded, unconfigurable string: "Continue if you have next
steps, or stop and ask for clarification if you are unsure how to proceed." A small model reading
that after losing most of its context tends to take the second option and ends the run on a
question — fatal in an unattended run, since nobody answers it (#712).

OpenCode rebuilds its system prompt from the config `instructions` list on every step, so unlike
the one-shot run prompt, an `instructions` file survives compaction. A **sandboxed** opencode run
(`oc-local` above) carries the unattended contract — never ask, what the compaction-continue
message means here, and the verdict file/format — as exactly such a file, wired into that run's
`opencode.json` `instructions` (see [OpenCode in the sandbox](sandbox.md#opencode-in-the-sandbox)).
A sandboxed run also gets the step's standing instructions (repo + step `instructionsFile` text)
as a second `instructions` file (`agenthook-standing.md`), so the gate commands, "read narrowly",
"rework: read the latest review", and other step-specific guidance survive compaction too. When
that file is written, the standing text is **dropped from the run prompt** — the model sees it
once, in the system prompt via `instructions`, not twice — and the one-shot prompt keeps only the
`=== TICKET ===` marker and the ticket text. When the standing text exceeds 16 KB it is not
written to a file; a `console.warn` naming the step is emitted instead, and in that case the
standing text stays in the run prompt (the only copy). The ticket text itself is never in the
standing file. A **host or ssh** opencode run gets the contract only in the one-shot run prompt,
same as before; it has no agenthook-owned config to add `instructions` to.

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
