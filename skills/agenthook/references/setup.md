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

Both are the user's choice. **Ask; do not default silently.** The scaffold's default (`claude` on
the user's Anthropic account) is right only if that is what they want; then skip to step 4.

For anything else — another agent CLI, another provider, a local model — find out what is
installed, since the receiver can only spawn those:

```bash
for b in claude opencode hermes agent; do command -v "$b" >/dev/null && echo "$b"; done   # `agent` is Cursor's CLI
```

Then ask the user, in one message:

1. **Which agent CLI** (*harness*) the steps should run, from the installed ones.
2. **Which model**, as that CLI names it.
3. For a model served on their own machine: **its context window** and **how many requests the
   server handles in parallel**.

What already works on this machine is the best guide: if you or the user know a CLI + model
pairing that runs well here, propose it. Otherwise lay out the options without ranking them by
your own assumptions; one fact worth stating is that agent CLIs differ in how much of the context
window their own prompt and tools take, which matters most on small local windows. Never guess
an answer the user did not give.

Then edit `agenthook.config.json`. `agent` can be set once at the top level; `model`,
`contextTokens`, `provider` and `env` go on each pipeline step (`code` and `review`):

- **Claude Code** (`"agent": "claude"`, the default): `"model": "<name>"`; for a server that
  speaks the Anthropic API, `"env": {"ANTHROPIC_BASE_URL": "<server url>"}`.
- **OpenCode** (`"agent": "opencode"`): `"model": "<provider>/<name>"`. OpenCode resolves the
  provider from *its own* config, so confirm it lists the model (`opencode models`). If it does
  not, the user's OpenCode config needs that provider and model; show what you would add and
  ask before editing their file.
- **Hermes** (`"agent": "hermes"`): `"model": "<name>"`, `"provider": "<a provider Hermes has configured>"`.
- **Cursor** (`"agent": "cursor"`): `"model": "<name>"`.

For a local model also set `contextTokens` to its window on each step (so `tick` shows
`ctx used/max`) and the top-level `maxConcurrent` to the server's parallel count. More agents
than the server serves at once queue inside it and look like a hang; several things sharing one
GPU share that budget. Local runs are slower than cloud ones: raise the step's `maxMinutes` if
runs time out.

Full recipes, with worked examples: <https://github.com/Jesuso/agenthook/blob/master/docs/local-models.md> and
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
