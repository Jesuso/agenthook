# Setting agenthook up for the first time

Read this when there is no `agenthook.config.json` in the repo or above it (`agenthook status`
says so), or when the user asks to "try agenthook", "set it up", or run tickets on local models.
Once a profile exists and is running, go back to `SKILL.md` → authoring / supervising.

The fastest path is a **local board**: no tracker account, no token, no tunnel. Start there even
if the user will later connect Jira, Linear, GitHub or Asana; the pipeline is the same.

## 1. Check the prerequisites

```bash
sh <this skill's directory>/scripts/ensure-cli.sh   # installs the agenthook CLI if it is missing (needs Node ≥ 22)
git -C <repo> log -1    # the repo needs at least one commit: agents work in worktrees branched from it
```

`ensure-cli.sh` prints where `agenthook` is; if it says the CLI is not on `PATH`, use the full path
it prints in every command below. If it reports a missing Node, tell the user and stop.

No repository or no commit yet (a new project)? `init --yes` will not create them for you:

```bash
git init && git commit --allow-empty -m "Initial commit"
```

The agent CLI the steps spawn must be installed and working on its own: `claude` by default;
`opencode`, `hermes` or `cursor` if the user picks one (step 3).

## 2. Scaffold the profile

Run inside the repo the agents will work on:

```bash
agenthook init --local --yes
```

This writes `agenthook.config.json`, `INSTRUCTIONS_CODE.md` and `INSTRUCTIONS_REVIEW.md` (never
overwrites existing files). Pipeline: `code` → `review` → `done`; failures land in `blocked`,
questions in `held`.

**`fullAuto` is the user's decision, never yours — and `--yes` leaves it off.** Without it a
headless agent cannot edit files (unless the repo's agent settings allow it), so the first ticket
does nothing useful. With it, agents run unattended, unsandboxed, with permission prompts skipped;
on a local board only the user can add tickets, which is why most people say yes for a first try.
Ask the user in one line with that trade-off, and on an explicit yes scaffold with
`agenthook init --local --yes --full-auto` (add `--force` if you already scaffolded without it).
A per-run sandbox (`"sandbox": {"type": "podman"}` or `"docker"`) limits each run to its worktree.

## 3. Pick the agent CLI and the model

Two choices, both the user's. **Ask; do not default silently** — the scaffold's default (`claude`
on the user's Anthropic account) is only right when the user wants cloud Claude.

**Cloud Claude:** nothing to change. Skip to step 4.

**Local models** (Ollama, or any server the agent CLI can reach). First see which agent CLIs
(*harnesses*) are installed, since the receiver can only spawn those:

```bash
for b in opencode hermes claude agent; do command -v "$b" >/dev/null && echo "$b"; done   # `agent` is Cursor's CLI
```

Then ask the user three things, in one message, with your recommendation:

1. **Which harness.** Recommend the first installed one in this order:
   - `opencode` — lightest prompt; the best fit for a local model.
   - `hermes` — also light; needs a Hermes provider that points at the server.
   - `claude` — works (Ollama 0.14+ serves `/v1/messages`), but its own prompt and tools cost
     20–25K tokens before it reads a file: over a third of a 64K window, so it compacts often.
     Say so if it is the only one installed.
   - `cursor` — do not offer it for a local model unless the user says theirs is set up for one.
2. **Which model tag** (`ollama list` shows them), and its context window.
3. **How many requests the server serves in parallel** (`OLLAMA_NUM_PARALLEL`; 1 if they do not know).

Never guess any of the three. Then edit `agenthook.config.json`. `agent` can be set once at the
top level; `model`, `contextTokens` and `env` go on each pipeline step (`code` and `review`):

- **OpenCode:** `"agent": "opencode"`, and per step `"model": "ollama/<tag>"`,
  `"contextTokens": <window>`. OpenCode reaches the server through *its own* provider config, so
  check it knows the model: `opencode models | grep '<tag>'`. Nothing printed → the user's
  OpenCode config (`~/.config/opencode/opencode.json`) needs this provider; show it and ask
  before editing their file:

  ```json
  { "provider": { "ollama": { "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": { "<tag>": { "limit": { "context": 65536 } } } } } }
  ```

  (With a per-run sandbox, put that JSON in a file and name it in the step's `opencodeConfig`
  instead: a sandboxed run does not see the user's own config.)
- **Hermes:** `"agent": "hermes"`, and per step `"model": "<tag>"`, `"provider": "<the Hermes
  provider that points at the server>"`, `"contextTokens": <window>`.
- **Claude Code:** per step `"model": "<tag>"`,
  `"env": {"ANTHROPIC_BASE_URL": "http://localhost:11434"}`, `"contextTokens": <window>`.

Set the top-level `maxConcurrent` to the parallel count from question 3.

Rules that keep local runs from stalling:

- Sum of `maxConcurrent` across everything that shares one GPU ≤ the server's parallel slots.
  One more than that queues inside the server and looks like a hang.
- Prefer a ≥ 64K context for `code`; the agent CLI's own prompt and tools cost 20K+ before it
  reads a file. Set `contextTokens` so `tick` shows `ctx used/max`.
- Raise `maxMinutes` (local runs are several times slower than cloud ones).

Full recipes: <https://github.com/Jesuso/agenthook/blob/master/docs/local-models.md> and
<https://github.com/Jesuso/agenthook/blob/master/docs/agents.md>.

## 4. Check, start, first ticket

```bash
agenthook doctor                # fix what it reports; `doctor --fix` applies the safe local fixes
agenthook start --detach
agenthook ticket add "<goal, written for an agent>" --body "<acceptance criteria, files, out of scope>"
agenthook watch --ref <ref> --event enqueued,run_start --timeout 60
```

Split a bigger goal into small tickets and chain them with `--blocked-by <ref,ref>` (each waits
until its blockers reach `done`). Write each body as in [authoring](authoring.md).

## 5. Hand the result back

When a ticket reaches `done`, its work is on branch `agent/<ref>`:
`git log -p HEAD..agent/<ref>`. Merging is the user's call (`git merge agent/<ref>`).
Watch progress with `agenthook ui` (dashboard) or `agenthook watch --actionable`;
held / blocked tickets → [supervising](supervising.md). `agenthook stop` stops the receiver.

Moving to a real tracker later: the user runs `agenthook init --remote` in a terminal (it is an
interactive wizard that needs the tracker's token; do not drive it yourself), then
<https://github.com/Jesuso/agenthook/blob/master/docs/getting-started.md>.
