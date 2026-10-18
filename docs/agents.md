# Agents: Claude, Cursor, Hermes

Each pipeline step spawns a headless coding-agent CLI. By default that is Claude Code
(`claude -p`), but a step can run another agent instead. The agent is picked per step:
`step.agent`, else the profile's top-level `agent`, else `claude`.

```jsonc
{
  "agent": "claude",               // profile default (optional)
  "tracker": {
    "pipeline": [
      { "id": "triage", "agent": "hermes" },
      { "id": "code" },            // runs the profile default
      { "id": "review", "agent": "cursor" }
    ]
  }
}
```

An unknown `agent` fails at config load. `ah doctor` checks that each step's binary is on PATH
and labels it with the steps that use it (e.g. `cursor binary on PATH: agent (steps: review)`).

## The adapters

| | `claude` | `cursor` | `hermes` |
|---|---|---|---|
| Default binary | `claudeBin` (default `claude`) | `agent` | `hermes` |
| Invocation | `claude -p <prompt> --output-format stream-json --verbose …` | `agent -p --output-format stream-json --trust --model <m> … <prompt>` | `hermes chat -Q --max-turns 200 --query-file <file> [-m <m>] [--provider <p>] [--reasoning <e>] [--run-budget <s>]` |
| Stdout | stream-json | stream-json | plain text |
| Live token tally (`ah agents`, UI) | yes | at the end of the run (the `result` event) | no (Hermes reports no usage) |
| Cost | priced (`costUsd`), unless the run is on a local model | always `unpriced` | always `unpriced` |
| `follow` / `resume` | yes | yes (`agent --resume <id>`) | no (no transcripts) |
| `requireVerdict` default | `false` | `false` | `true` |

An **unpriced** run has no `costUsd`: agenthook has no price table for that agent (or the run
used a local model, see [Mixed pipelines / local models](local-models.md)). The UI shows
"unpriced" in its cost cell, and `run_end` events carry `"unpriced": true`. Cursor runs still
record token counts; Hermes runs record none.

### Per-agent flags and limits

- **`model`**: passed as `--model` (claude, cursor) or `-m` (hermes). Unset uses the CLI's
  default; Cursor's default is `auto`.
- **`effort`**: claude (`--effort`) and hermes (`--reasoning`). Cursor has no effort flag, so
  dispatch drops it with a warning; an out-of-set value is dropped with a warning too.
- **`provider`** (step) / **`agentProvider`** (profile default): the inference provider hermes
  should use (`--provider`, a name from `config.yaml`'s `providers:`, or a built-in). A step's
  `provider` overrides `agentProvider`. Claude and Cursor have no provider flag, so dispatch drops
  it with a warning. Without it, a step `model` hermes can't serve on your default provider (e.g.
  a local Ollama model under the user's `openai-codex` default) silently fails or no-ops — see the
  [local Qwen recipe](local-models.md#a-local-qwen-recipe-hermes--ollama) below.
- **`fullAuto`**: adds each CLI's skip-permissions flag. That is `--dangerously-skip-permissions`
  (claude), `--force` (cursor) or `--yolo` (hermes). It is still unsandboxed code execution from
  a webhook; see the security posture in the [README](../README.md).
- **`bin`**: a step `bin` overrides the agent's default binary, e.g. a wrapper script.
- **`maxMinutes`**: besides the receiver's own SIGTERM timer, hermes gets it as `--run-budget`
  (whole seconds, floored to at least 1) so it can wrap up on its own before the kill; the
  receiver's timer stays authoritative regardless. Claude and Cursor ignore it.
- **Prompt**: Hermes has no inline-prompt flag. Dispatch writes the prompt to
  `~/.agenthook/<stateKey>/prompts/<ref>-<step>.md` (mode 0600), passes it via `--query-file`, and
  removes it after the run. So the prompt is not visible in `ps`. `ah agents` finds a Hermes run
  by its pid in the profile's `running.json` instead.
- **Verdict**: every agent gets `AGENTHOOK_VERDICT_FILE` and should write its verdict there. Hermes
  defaults to `requireVerdict: true`: its plain-text output gives no other signal, so a clean exit
  with no verdict file holds the task instead of advancing it. `ah doctor` warns when a Hermes
  step sets `requireVerdict: false`.

## Recipes

### A Cursor review step

Review with a different model family than the one that wrote the code:

```jsonc
{
  "id": "review",
  "kind": "review",
  "agent": "cursor",
  "model": "auto",
  "sourceLabel": "agent:review",
  "successLabel": "agent:done",
  "failureLabel": "agent:failed",
  "holdLabel": "agent:held",
  "requireVerdict": true,
  "maxAttempts": 3
}
```

Install the Cursor CLI (it puts `agent` on PATH) and sign in once from a terminal; the receiver
runs it as your user, so it uses that login. Cursor bills its own account, so these runs show as "unpriced" in agenthook.

### A Hermes triage step

Triage with Hermes (Nous Research's agent CLI). `model` is optional and passed through as `-m`:

```jsonc
{
  "id": "triage",
  "kind": "triage",
  "agent": "hermes",
  "sourceLabel": "agent:triage",
  "successLabel": "agent:code",
  "failureLabel": "agent:failed",
  "holdLabel": "agent:held"
}
```

Leave `requireVerdict` unset (Hermes defaults it to `true`). Put the triage rules and the verdict
format in the step's `instructionsFile`. Hermes runs have no transcripts, so `follow`/`resume`
don't cover them; read the run log in the UI or `logs/` instead.

### A local Qwen recipe (Hermes + Ollama)

A step `model` like `qwen3.8:27b-96k` is served by Ollama, not your Hermes account's default
provider — set `provider` so Hermes routes to it (see [local-models.md](local-models.md) for the
`providers:` entry this names):

```jsonc
{
  "id": "code",
  "agent": "hermes",
  "provider": "ollama-launch",
  "model": "qwen3.8:27b-96k"
}
```

No wrapper script needed (a step `bin` pointing at a shim that appended `--provider ollama-launch`
was the only way to do this before `provider` existed). Memory note: a 17 GB-weights / 98K-context
model got OOM-killed on a loaded machine — size `maxConcurrent` and the model's context to what
the host actually has free.

## Adding an adapter

An agent adapter is one module in `src/agents/` implementing `AgentAdapter` (`src/types.js`):

- `describe()` → `{name, stdout, promptFile?}`. `stdout` is `"stream-json"` or `"text"`.
  `promptFile: true` makes dispatch write the prompt to a file and pass it as `promptFile`.
- `buildArgs({prompt, model, effort, provider, fullAuto, promptFile, maxMs})` → the argv after the binary. Drop
  unsupported options with a warning instead of passing them through.
- `createParser()` → an incremental stdout parser: `push(chunk)` / `flush()` return log text, plus
  `tally`, `result` and `sessionId`. Optional `pushStderr` reads stderr (Hermes gets its session id
  there). It must never throw.
- `usageRecord(result|null, ctx)` → the `usage.jsonl` record. Set `unpriced: true` when there is
  no price table for it.
- `sessions` → `{transcriptDir, resumeCommand, files, cwdDirs}` for `follow`/`resume`, or `null`.
- `defaults` → `{bin?, requireVerdict?}`. A step's own `bin`/`requireVerdict` wins.

`src/agents/claude.js` documents the interface in full. Then:

1. Register it in `AGENTS` (`src/agents/index.js`), and add its name to `AGENT_NAMES` and its
   default binary to `AGENT_DEFAULT_BINS` (`src/agents/names.js`). Those two are import-free,
   so config validation, the config schema and `ah agents` can use them without the registry.
   `test/agent-adapters.test.js` checks that both match the registry.
2. If its argv is not `<bin> -p …` or `<bin> chat … --query-file …`, extend `agentMatcher` in
   `src/commands/agents.js` so `ah agents` can see it.
3. Add offline tests in the style of `test/agent-adapters.test.js`: argv, parser (split chunks,
   garbage lines), usage record. Then run `npm run typecheck` and `npm test`.
