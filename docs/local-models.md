# Mixed pipelines / local models

Each pipeline step can run its agent on a different model. A common split: a local model for the
cheap, read-only steps (`triage`, `review`), Claude for `code`. This page is the recipe. A step can
also run a different agent CLI altogether (`agent: "cursor"` or `"hermes"`); see [Agents](agents.md).

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
[Agents](agents.md).

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

An unpriced run keeps its tokens but shows no dollars:

- its `run_end` event has `unpriced: true` and no `costUsd`, so the web UI's ticket cost, Stats
  spend and per-ticket cost leave it out, and the ticket drawer shows `local` in its cost column;
- its `usage.jsonl` record has `unpriced: true` (and `bin` when overridden). `ah usage`,
  `ah status` and `ah ls` leave its cost out of every total. See [Token & cost tracking](usage.md).

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
