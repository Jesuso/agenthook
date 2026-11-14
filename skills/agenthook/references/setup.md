# Setting agenthook up for the first time

Read this when there is no `agenthook.config.json` in the repo or above it (`agenthook status`
says so), or when the user asks to "try agenthook", "set it up", or run tickets on local models.
Once a profile exists and is running, go back to `SKILL.md` → authoring / supervising.

The fastest path is a **local board**: no tracker account, no token, no tunnel. Start there even
if the user will later connect Jira, Linear, GitHub or Asana; the pipeline is the same.

## 1. Check the prerequisites

```bash
node --version          # ≥ 22
agenthook --version     # missing → npm i -g @jesuso/agenthook (or npx @jesuso/agenthook <cmd>)
git -C <repo> log -1    # the repo needs at least one commit: agents work in worktrees branched from it
```

New project? `git init`, add a README, commit it, then continue.

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

**`fullAuto` is the user's decision, never yours.** Without it a headless agent cannot edit files
unless the repo's agent settings allow it. With it, agents run unattended with permission prompts
skipped. Ask the user, state that trade-off in one line, and pass `--full-auto` only on an explicit
yes. A per-run sandbox (`"sandbox": {"type": "podman"}` or `"docker"`) limits each run to its worktree.

## 3. Pick the model (cloud or local)

Default: the `claude` CLI on the user's Anthropic account. Nothing to change.

**Local models** (Ollama or any server the agent CLI can reach) are set per step or per *harness*
in `agenthook.config.json`. Ask the user which model tag and how many requests their server serves
in parallel (`OLLAMA_NUM_PARALLEL`); never guess either.

- Claude Code on Ollama (0.14+ serves `/v1/messages`):
  `{"model": "<tag>", "env": {"ANTHROPIC_BASE_URL": "http://localhost:11434"}}`.
- OpenCode: `"agent": "opencode"`, `"model": "ollama/<tag>"`, plus an `opencodeConfig` file that
  declares the Ollama provider and the model's `limit.context`.
- Hermes: `"agent": "hermes"` with `provider` set to the Hermes provider that points at Ollama.

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

Moving to a real tracker later: `agenthook init` (without `--local`), pick the tracker, then
<https://github.com/Jesuso/agenthook/blob/master/docs/getting-started.md>.
