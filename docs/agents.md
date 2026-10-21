# Agents: Claude, Cursor, Hermes, OpenCode

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
      { "id": "review", "agent": "cursor" },
      { "id": "fix", "agent": "opencode", "model": "ollama/qwen3.8:27b-64k" }
    ]
  }
}
```

An unknown `agent` fails at config load. `ah doctor` checks that each step's binary is on PATH
and labels it with the steps that use it (e.g. `cursor binary on PATH: agent (steps: review)`).

## The adapters

| | `claude` | `cursor` | `hermes` | `opencode` |
|---|---|---|---|---|
| Default binary | `claudeBin` (default `claude`) | `agent` | `hermes` | `opencode` |
| Invocation | `claude -p <prompt> --output-format stream-json --verbose …` | `agent -p --output-format stream-json --trust --model <m> … <prompt>` | `hermes chat -Q --max-turns 200 --query-file <file> [-m <m>] [--provider <p>] [--reasoning <e>] [--run-budget <s>] --ignore-rules --source tool -t terminal,file` (isolated, the default; see [Hermes isolation](#hermes-isolation)) | `opencode run --format json [--auto] [-m <provider/model>] [--variant <e>] -- <prompt>` |
| Stdout | stream-json | stream-json | plain text | JSONL events |
| Live token tally (`ah agents`, UI) | yes | at the end of the run (the `result` event) | no (best-effort, after the run — see below) | yes, per model step (`step_finish`) |
| Cost | priced (`costUsd`), unless the run is on a local model | always `unpriced` | always `unpriced` | priced only when OpenCode reports a non-zero cost, else `unpriced` |
| `follow` | yes | yes | no (no transcripts) | no (sessions live in OpenCode's database) |
| `resume` | yes | yes (`agent --resume <id>`) | no | yes (`opencode -s <id>`, ids from `usage.jsonl`) |
| `requireVerdict` default | `true` | `true` | `true` | `true` |

An **unpriced** run has no `costUsd`: agenthook has no price table for that agent (or the run
used a local model, see [Mixed pipelines / local models](local-models.md)). The UI shows
"unpriced" in its cost cell, and `run_end` events carry `"unpriced": true`. Cursor runs still
record token counts; Hermes has no live tally during the run, but recovers real counts
afterwards via `hermes sessions export` (best-effort — see [Hermes token capture](#hermes-token-capture)
below), and these then get an `estUsd` from the rate table like any other unpriced run. OpenCode
runs record token counts, and they are priced only when OpenCode's own summed `cost` is above
zero (a paid provider). A zero or missing
cost (a local or free model) makes the run `unpriced`, so agenthook never shows made-up dollars.

### Estimated cost (`estUsd`)

An unpriced run whose model has a known rate gets an **estimate** instead: what its tokens would
cost at API prices. It is a separate figure (`estUsd`, `costBasis: "rate-table"`) and is never
added to `costUsd`, which always means "reported by the agent". Everywhere a total is shown, the
two stay apart: `$12.40 + ~$3.10 est.`, and a run's cost cell reads `~$0.42 est.`

- **Built-in rates** (`src/pricing.js`, `PRICING_VERSION` 2026-10-06): the Claude family at
  Anthropic's first-party API prices (5-minute cache writes). A Cursor or OpenCode run on a Claude
  model is therefore estimated with no config.
- **Any other model** gets no estimate until you map it in the `pricing` config
  ([configuration.md](configuration.md)), e.g. `"qwen3.8*": {"input": 2, "output": 10}`. Patterns
  are case-insensitive globs (`*` only); an exact name beats a glob, a longer glob beats a shorter
  one, and your `pricing` beats the built-in table. For OpenCode's `provider/model` the full string
  is tried first, then the part after the last `/`.
- **No guesses.** An unknown model, or a run that reported no tokens (Hermes), stays
  "no estimate" — never $0. Totals count those runs (`N runs no estimate`).
- **Stamped at write time.** Dispatch writes `estUsd`/`costBasis` on the run's `usage.jsonl`
  record and its `run_end` event, together with the model and token counts, so a later rate change
  never re-prices history. Older `run_end` rows without tokens are joined to `usage.jsonl` (same
  ref + step, within 5 s) when the Stats are read; no history file is rewritten.

### Per-agent flags and limits

- **`model`**: passed as `--model` (claude, cursor) or `-m` (hermes, opencode). OpenCode's model
  names the provider too: `provider/model`, e.g. `ollama/qwen3.8:27b-64k`. Unset uses the CLI's
  default; Cursor's default is `auto`.
- **`effort`**: claude (`--effort`), hermes (`--reasoning`) and opencode (`--variant`). OpenCode's
  variants are provider-specific, so the value is passed through as-is. Cursor has no effort flag,
  so dispatch drops it with a warning; an out-of-set value (claude, hermes) is dropped with a
  warning too.
- **`provider`** (step) / **`agentProvider`** (profile default): the inference provider hermes
  should use (`--provider`, a name from `config.yaml`'s `providers:`, or a built-in). A step's
  `provider` overrides `agentProvider`. Claude, Cursor and OpenCode have no provider flag (OpenCode
  takes it inside `-m provider/model`), so dispatch drops it with a warning. Without it, a step
  `model` hermes can't serve on your default provider (e.g. a local Ollama model under the user's
  `openai-codex` default) silently fails or no-ops — see the
  [local Qwen recipe](#a-local-qwen-recipe-hermes--ollama) below.
- **`fullAuto`**: adds each CLI's skip-permissions flag. That is `--dangerously-skip-permissions`
  (claude), `--force` (cursor), `--yolo` (hermes) or `--auto` (opencode). It is code execution from
  a webhook, unsandboxed unless the profile sets `sandbox` ([sandbox.md](sandbox.md); only claude
  runs sandboxed). Without `fullAuto`, claude runs pinned to `dontAsk`
  ([permissions](sandbox.md#permissions-inside-and-outside-the-sandbox)); the other CLIs keep their
  own default. See the security posture in the [README](../README.md).
- **`bin`**: a step `bin` overrides the agent's default binary, e.g. a wrapper script.
- **`maxMinutes`**: besides the receiver's own SIGTERM timer, hermes gets it as `--run-budget`
  (whole seconds, floored to at least 1) so it can wrap up on its own before the kill; the
  receiver's timer stays authoritative regardless. Claude, Cursor and OpenCode ignore it.
  `idleMinutes` and the receiver's `maxMinutes` timer apply to every agent.
- **Background subagents (claude)**: claude's headless print mode otherwise kills a background
  subagent 10 minutes after its last turn, even mid-edit. Every claude run gets
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` by default (the adapter's `env` hook), so background
  subagents are no longer bounded by that ceiling — only by `maxMinutes`/`idleMinutes`. A step's
  own `env` can still override it.
- **Prompt**: Hermes has no inline-prompt flag. Dispatch writes the prompt to
  `~/.agenthook/<stateKey>/prompts/<ref>-<step>.md` (mode 0600), passes it via `--query-file`, and
  removes it after the run. So the prompt is not visible in `ps`. `ah agents` finds a Hermes run
  by its pid in the profile's `running.json` instead.
- **Verdict**: every agent gets `AGENTHOOK_VERDICT_FILE` and should write its verdict there. Every
  agent defaults to `requireVerdict: true`; Hermes keeps that default explicitly since its
  plain-text output gives no other signal. `ah doctor` warns when a Hermes step sets
  `requireVerdict: false`.

### Agent environment

An agent does **not** inherit the receiver's environment. The receiver loads your `.env` (tracker
token, ingress authtoken, App private key, webhook secrets) into its own process; an agent a webhook
started would otherwise read all of it with one `env` call. Instead it gets an allowlist
(`src/agent-env.js`), the union of:

1. **Process basics**: `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `TZ`, locale (`LANG`, `LC_*`),
   terminal (`TERM`, `COLORTERM`, `NO_COLOR`), `XDG_*`, `DBUS_SESSION_BUS_ADDRESS`, proxies
   (`HTTP(S)_PROXY`, `NO_PROXY`, …), CA bundles (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_*`),
   `SSH_AUTH_SOCK`, toolchain dirs (`JAVA_HOME`, `GOPATH`, `CARGO_HOME`, `NVM_DIR`, `VIRTUAL_ENV`, …)
   and the Windows process basics (matched case-insensitively there).
2. **The agent CLI's own variables**:

   | Agent | Passed | Also reaches its login through |
   |---|---|---|
   | `claude` | `ANTHROPIC_*`, `CLAUDE_*` (minus the parent Claude Code session's own: `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_CODE_SESSION_*`/`MESSAGING_*`/`BRIDGE_*`, …) | `HOME` (`~/.claude`, macOS Keychain) |
   | `cursor` | `CURSOR_API_KEY` | `HOME` (`~/.cursor`) |
   | `opencode` | `OPENCODE_*` | `HOME` / `XDG_*` (`opencode auth login`) |
   | `hermes` | `HERMES_HOME` | `HOME` (`~/.hermes`); an isolated step gets its own `HERMES_HOME` |

3. **The tracker token its prompt names**: `GITHUB_TOKEN` (github, github-projects),
   `JIRA_API_TOKEN`, `LINEAR_API_KEY`, `ASANA_TOKEN`; none for `local`. The prompts tell the agent
   to comment with it, so it stays until the receiver posts comments itself.
4. **The forge's**: with `forge.type: "github"`, `GH_TOKEN` and `GITHUB_TOKEN`, so `gh pr create`
   works without `gh auth login`.
5. **Your `agentEnvPassthrough`** (`NAME` or `PREFIX*`; `"*"` = inherit everything, the 0.9
   behaviour).

On top, unfiltered and in this order: the adapter's own env (an isolated hermes step's
`HERMES_HOME`), then the step's `env`, then `AGENTHOOK_VERDICT_FILE`. A step `env` can therefore set
any name, including a stripped one, for that step only. Hermes' post-run `sessions export` gets the
same env as the run.

**What to add.** Run `ah doctor`: it lists the credentials no longer passed, the ones agents still
get and why, and warns about what a run likely needs — `AWS_*` for claude on Bedrock
(`CLAUDE_CODE_USE_BEDROCK`), `GOOGLE_APPLICATION_CREDENTIALS` / `CLOUD_ML_REGION` /
`GOOGLE_CLOUD_PROJECT` on Vertex, provider keys (`OPENAI_API_KEY`, …) for OpenCode or a
non-isolated Hermes step, `GIT_SSH_COMMAND` / `GIT_ASKPASS` / `GIT_CONFIG_*` for git. It also runs
`gh auth status` with the env an agent gets. It prints names, never values.

**What this does not stop.** It closes the *environment* path only. The filesystem is open: an
agent can still read `.env`, the config, `~/.ssh` and `~/.config/gh` from disk, and `HOME` is the
real one. It is not a boundary. To confine an agent, run it in the
[sandboxed container](sandbox.md).

### Hermes isolation

> **Experimental.** The Hermes adapter is new; see [token capture](#hermes-token-capture) below
> for how its cost numbers work.

Hermes steps are **isolated** by default (step `isolated`, default `true`), so one ticket can't
read or write another ticket's Hermes memory or skills, or your own:

- **Own home.** The agent runs with `HERMES_HOME=~/.agenthook/<stateKey>/hermes-home` (mode 0700),
  shared by the profile's isolated hermes steps. Only your `config.yaml` is copied there (mode
  0600), from `$HERMES_HOME` if the receiver has one, else `~/.hermes`. It is re-copied before
  a run whenever its sha256 changes. Nothing else is copied: no `auth.json`, `.env`, memories,
  skills, sessions or `state.db`. Sessions land in the isolated home's `state.db`, not yours.
- **Minimal tools.** `-t terminal,file` by default. Set step `toolsets` (e.g.
  `["terminal", "file", "web"]`) to change it. Dropping memory, skills, session_search, cron and
  delegation cut a trivial task's prompt from about 15,500 to 5,200 input tokens.
- **No user rules.** `--ignore-rules` skips `AGENTS.md`, `SOUL.md`, memory injection and
  preloaded skills. `--source tool` keeps the run out of your session lists.
- **Local providers only.** No credentials are copied, so an isolated run can only reach a
  provider that needs none: a `providers:` entry in `config.yaml` whose URL is on loopback
  (`127.0.0.1`, `localhost`, `::1`), e.g. Ollama. The effective provider is the step's `provider`,
  else `agentProvider`, else `config.yaml`'s `model.provider`. If it is a cloud provider (e.g. an
  `openai-codex` default), the run fails before any agent starts, with
  `hermes step is isolated and has no credentials; use a local provider or set isolated:false`.
  A missing `config.yaml` fails the same way:
  `hermes step is isolated but <home>/config.yaml is missing; create it or set isolated:false`.
  If agenthook can't tell from `config.yaml` (it reads it with a small built-in scanner), the run
  goes ahead and Hermes reports any error itself. `ah doctor` warns about both cases ahead of time.
- **Escape hatch.** `isolated: false` runs Hermes exactly as before: your real home, no
  `--ignore-rules`/`--source`, and `-t` only if `toolsets` is set. Use it for a cloud provider. A
  step `env` that sets `HERMES_HOME` also wins: agenthook then leaves that home to you.
- **Resume.** `ah resume <ref>` lists Hermes sessions from the session ids in `usage.jsonl` and
  prints `cd <worktree> && HERMES_HOME=<isolated home> hermes chat --resume <id>`; `--exec` sets
  the same `HERMES_HOME`.

### Hermes token capture

> **Experimental.** The Hermes adapter is new and still settling; treat its cost numbers as
> best-effort.

`hermes chat -Q` prints plain text with no usage data, so a Hermes run's live tally is always
zero. After the run exits (and only when it produced a session id), dispatch runs `hermes
sessions export --session-id <id> --format jsonl <file>` in the same `HERMES_HOME` the run used,
bounded to 10s, in a scratch dir under the state dir (never the repo or worktree, removed
afterwards). A successful export overlays its `input_tokens`/`output_tokens`/
`cache_read_tokens`/`cache_write_tokens` onto the run's zero tally, and its `model` only when the
step resolved none of its own. The export's own `estimated_cost_usd` is ignored — Hermes stays
`unpriced`, and a dollar figure (`estUsd`) comes only from the [rate table](#estimated-cost-estusd),
same as any other unpriced run with real tokens. Any failure (the export errors, times out, or the
run had no session id) just leaves the tally at zero and logs one line; it never affects the
run's verdict or outcome.

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
format in the step's `instructionsFile`. Hermes runs have no transcripts, so `follow` doesn't cover
them; read the run log in the UI or `logs/` instead. `ah resume` does (see
[Hermes isolation](#hermes-isolation)). The step runs isolated, so it needs a local `provider`, or
`isolated: false` for a cloud one.

### A local Qwen recipe (Hermes + Ollama)

A step `model` like `qwen3.8:27b-96k` is served by Ollama, not your Hermes account's default
provider — set `provider` so Hermes routes to it:

```jsonc
{
  "id": "code",
  "agent": "hermes",
  "provider": "ollama-launch",
  "model": "qwen3.8:27b-96k"
}
```

No wrapper script needed (a step `bin` pointing at a shim that appended `--provider ollama-launch`
was the only way to do this before `provider` existed). The step runs [isolated](#hermes-isolation)
by default, which suits a local model: `provider` must name the `providers:` entry in your
`config.yaml` (here `ollama-launch` → `http://127.0.0.1:11434/v1`). Without it, the run falls
back to your `config.yaml` default; if that is a cloud provider, the run fails before it starts. Memory note: a 17 GB-weights / 98K-context
model got OOM-killed on a loaded machine — size `maxConcurrent` and the model's context to what
the host actually has free.

### A local Qwen step (OpenCode + Ollama)

OpenCode reaches Ollama through its own provider config, so the model alone picks it:

```jsonc
{
  "id": "code",
  "agent": "opencode",
  "model": "ollama/qwen3.8:27b-64k",
  "requireVerdict": true
}
```

`requireVerdict` defaults to `true`, which is especially important for weak local models: a clean
exit with no verdict file holds the task instead of advancing it. Free and local models report a cost of zero, so these
runs show as "unpriced". `ah follow` does not cover OpenCode runs (its sessions live in OpenCode's
own database, which agenthook does not read); read the run log in the UI or `logs/` instead.
`ah resume <ref>` still lists them, from the session ids in `usage.jsonl`, and prints
`cd <worktree> && opencode -s <id>`, which reopens the session in OpenCode's TUI.

## Adding an adapter

An agent adapter is one module in `src/agents/` implementing `AgentAdapter` (`src/types.js`):

- `describe()` → `{name, stdout, promptFile?}`. `stdout` is `"stream-json"` or `"text"`.
  `promptFile: true` makes dispatch write the prompt to a file and pass it as `promptFile`.
- `buildArgs({prompt, model, effort, provider, fullAuto, promptFile, maxMs, toolsets, isolated})` → the argv after the binary. Drop
  unsupported options with a warning instead of passing them through.
- `createParser()` → an incremental stdout parser: `push(chunk)` / `flush()` return log text, plus
  `tally`, `result` and `sessionId`. Optional `pushStderr` reads stderr (Hermes gets its session id
  there). It must never throw.
- `usageRecord(result|null, ctx)` → the `usage.jsonl` record. Set `unpriced: true` when there is
  no price table for it.
- `sessions` → `{transcriptDir, resumeCommand, files, cwdDirs}` for `follow`/`resume`, or `null`.
  An agent with `sessions: null` can still be resumed through an optional top-level
  `resumeCommand(id)`: `ah resume` then takes its session ids from `usage.jsonl` (OpenCode).
- `defaults` → `{bin?, requireVerdict?}`. A step's own `bin`/`requireVerdict` wins.
- Optional `env({cfg, step})` → extra environment for the agent, at spawn and in `ah resume`. A
  step's own `env` wins over it (Hermes: the isolated `HERMES_HOME`).
- Optional `describe().policy` → `{allow, deny}`: which step [`allow`/`deny` policies](configuration.md#step-policy-allow--deny)
  `buildArgs` enforces (it gets them with `cwd` and `verdictFile`). Leave it unset and a step
  that sets one is refused before spawn (only claude sets it today).
- Optional `preflight({cfg, step, provider})` → runs before spawn; a returned reason fails the run
  without starting the agent (Hermes: prepares the isolated home and refuses a cloud provider).

`src/agents/claude.js` documents the interface in full. Then:

1. Register it in `AGENTS` (`src/agents/index.js`), and add its name to `AGENT_NAMES` and its
   default binary to `AGENT_DEFAULT_BINS` (`src/agents/names.js`). Those two are import-free,
   so config validation, the config schema and `ah agents` can use them without the registry.
   `test/agent-adapters.test.js` checks that both match the registry.
2. If its argv is not `<bin> -p …`, `<bin> chat … --query-file …` or `<bin> run --format json …`, extend `agentMatcher` in
   `src/commands/agents.js` so `ah agents` can see it.
3. Add offline tests in the style of `test/agent-adapters.test.js`: argv, parser (split chunks,
   garbage lines), usage record. Then run `npm run typecheck` and `npm test`.
