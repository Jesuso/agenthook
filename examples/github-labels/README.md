# GitHub Issues (labels) example

A complete, copy-paste-runnable agenthook profile for **GitHub Issues**, where the pipeline is
driven by **issue labels**. An issue carrying a step's `sourceLabel` fires that step; on a clean
finish the receiver swaps it for the next step's label, which fires the next step.

```
agent:triage ──► agent:code ──► agent:review ──► agent:done
   triage          code           review          done (terminal)
```

| Step     | Label fired on  | Does                                                        |
| -------- | --------------- | ---------------------------------------------------------- |
| `triage` | `agent:triage`  | turns a raw issue into an implementable spec               |
| `code`   | `agent:code`    | implements it in a receiver-owned worktree, opens a draft PR |
| `review` | `agent:review`  | reviews the PR (can bounce back to `code` with `changes`)  |
| `done`   | `agent:done`    | terminal, `manual` — drops the worktree, closes the issue  |

`agent:blocked` (failure) and `agent:needs-info` (hold) are the off-ramps.

## Run it

1. **Copy this directory** into the project whose issues should drive the pipeline (or anywhere —
   the config is self-contained):

   ```bash
   cp -r examples/github-labels ~/my-agenthook-profile
   cd ~/my-agenthook-profile
   ```

2. **Set the secrets.** Put them in a `.env` beside the config (auto-loaded) or export them:

   ```bash
   # .env
   GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   # repo + admin:repo_hook (classic)
   NGROK_AUTHTOKEN=xxxxxxxxxxxxxxxxxxxxxxxx
   ```

3. **Fill the placeholders** in `agenthook.config.json`:
   - `tracker.repository` → `YOUR_ORG/YOUR_REPO` (the repo whose issues drive the pipeline).
   - `repoPath` → the absolute path to the repo the agents should work in.

4. **Start:**

   ```bash
   agenthook doctor   # token resolves, repo is git, port free
   agenthook start    # brings up ngrok, creates the repo webhook, serves
   ```

5. Add `agent:triage` (or jump straight to `agent:code`) to an issue you're assigned, then
   `agenthook follow` to watch the agent.

## Good to know

- **Labels are created for you.** Boot's `ensureLabels` creates every `agent:*` label this pipeline
  names on the repo (idempotent — existing labels are left untouched), so you don't pre-create them.
- **Ephemeral ngrok is fine.** GitHub lets the token create the webhook, so agenthook re-creates it
  at the new URL on every boot — no stable domain required.
- **Assignee scoping.** The receiver acts only on issues assigned to the token owner (fail-closed).
  Assign the bot account, or set `tracker.assigneeFilter: false` to act on any assignee.
- **`fullAuto` is off** by default (agents prompt for permission). Turn it on only on a trusted host
  or in a container — it runs unsandboxed code on a verified webhook.

Full reference: [`docs/github-setup.md`](../../docs/github-setup.md).
