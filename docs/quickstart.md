# Quickstart — a first run in five commands

No tracker account, no token, no tunnel. `agenthook init --local` sets up a profile whose board is
a local file (the `local` tracker), so you can watch a ticket go **code → review → done** in any git
repo on your machine. When you're ready for a real board, follow the
[Getting Started guide](getting-started.md).

You need Node ≥ 22, `git`, and the [`claude` CLI](https://claude.com/claude-code), logged in.

## 1. Install

```bash
npm i -g @jesuso/agenthook      # or run ad-hoc: npx @jesuso/agenthook <cmd>
```

## 2. Scaffold a local profile

Run it inside the repo you want agents to work on. The repo needs at least one commit, because
agents work in git worktrees branched from it.

```bash
cd ~/my-project
agenthook init --local          # --yes skips the confirmation; --name <n> picks the profile name
```

This writes `agenthook.config.json` plus two starter instruction files, `INSTRUCTIONS_CODE.md` and
`INSTRUCTIONS_REVIEW.md` (existing files are never overwritten). The pipeline has three steps:

| Step | Stage | What happens |
|------|-------|--------------|
| `code` | `code` | an agent makes the change in its own worktree and commits on branch `agent/<ref>` |
| `review` | `review` | a second agent reads the diff; `changes` sends it back to `code` |
| `done` | `done` | the worktree is removed; the branch `agent/<ref>` stays |

Failures land in `blocked`, questions in `held`. Edit the instruction files to tune what each
agent does.

> ⚠️ **fullAuto.** Without permission prompts a headless agent can't edit files, so the `code`
> step needs either `fullAuto` (agents run `claude --dangerously-skip-permissions`, **unsandboxed**,
> in this repo) or a `.claude/settings.json` in the repo that allows Edit/Write/Bash. `init --local`
> asks, defaulting to **No**; `--full-auto` turns it on non-interactively (`--yes` never does). Only
> enable it on a repo and host you trust, or run inside the [sandbox](sandbox.md).

`agenthook doctor` checks the profile; a fresh one reports no problems.

## 3. Start the receiver

```bash
agenthook start --detach
```

## 4. Add a ticket

```bash
agenthook ticket add "add a subtract(a, b) function to math.js, with a test"
agenthook ticket add "fix the flaky date test" --file notes.md     # body from a file (or --body "…")
agenthook ticket ls                                                # ref, stage, title
```

The running receiver fires the `code` step at once. `--step review` adds a ticket straight to
review. If the receiver is stopped, the ticket rests in its stage; after `agenthook start`, run
`agenthook reconcile` to fire it.

## 5. Watch it, then read the result

```bash
agenthook ui                    # local dashboard (or: agenthook events --follow)
git log -p HEAD..agent/<ref>    # the change, once the ticket reaches done
```

Merge the branch yourself when you like it (`git merge agent/<ref>`).

## 6. Stop

```bash
agenthook stop
```

## Next

- Bind a real board (Asana, Jira, GitHub Issues or Projects): [Getting Started](getting-started.md).
- Every config key: [configuration.md](configuration.md). How the local tracker works:
  [providers.md § Local](providers.md#local-srctrackerslocaljs).
