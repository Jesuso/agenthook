# Launch post drafts

Drafts for the maintainer to post (or drop). Every claim below is grounded in the repo docs; the
one number — the demo's cost — was measured on the run recorded in `docs/img/quickstart.gif`.

## Show HN

**Title:** Show HN: agenthook – move a ticket, a Claude Code agent picks it up

**Body:**

agenthook turns a task board into a pipeline of coding agents. You define stages (say code →
review), each with its own standing instructions. When a ticket lands in a stage, the tracker's
webhook fires and agenthook runs a headless `claude -p` in a git worktree of its own. The agent
ends with a verdict: advance, send back for rework (capped), hold to ask you a question, or fail.
The receiver moves the ticket to match, which starts the next stage. No polling loop.

It works with Asana, Jira, GitHub Issues, GitHub Projects v2 and Linear, or a local board with no
account. The webhook reaches you through ngrok, cloudflared, Tailscale Funnel or your own HTTPS
URL, and an optional GitHub or GitLab forge notices merges and red CI. A local dashboard shows
what needs you, what is running and what it costs.

Try it in any git repo, no token or tunnel:

    npm i -g @jesuso/agenthook
    agenthook init --local
    agenthook start --detach
    agenthook ticket add "add a subtract(a, b) function to math.js, with a test"
    agenthook ui

https://github.com/Jesuso/agenthook

## Short version (r/ClaudeAI, X)

**r/ClaudeAI:**

I built agenthook: move a ticket into a column and a Claude Code agent picks it up, works in its
own git worktree, and hands the ticket to the next stage (code → review → done). Push, not
polling. Asana, Jira, GitHub, Linear, or a local board — try it in five commands, no token:
https://github.com/Jesuso/agenthook

**X (≤ 280 chars):**

agenthook: move a ticket, a Claude Code agent picks it up — own git worktree, code → review →
done, then the next stage fires. Webhooks, no polling. Asana, Jira, GitHub, Linear or a local board.
Five commands, no token: https://github.com/Jesuso/agenthook

## Likely questions

**Isn't a webhook that runs an agent on my machine dangerous?**
Yes, if you turn it on carelessly — so it is off by default. Without `fullAuto` the agent runs
permission-gated. With `fullAuto: true` it runs `claude -p --dangerously-skip-permissions`, which
is **not** sandboxed: a verified webhook leads to code execution on the host, gated by the HMAC
signature and a non-guessable URL. The receiver also acts only on tickets assigned to its own
identity (fail-closed), and the rework loop is capped. For `fullAuto`, the recommended path is the
container in `docs/sandbox.md`, which mounts only the repo. Threat model:
`docs/architecture.md#security-posture`.

**Why webhooks instead of a polling loop?**
A push starts the stage the moment the ticket moves, and nothing runs while you're idle. The
trade-off is real: if the receiver is down when an event fires, the provider may give up on it.
For those gaps there is a targeted replay — `agenthook catchup <ref>` for one item and
`agenthook reconcile` for every ticket resting in a pipeline stage — rather than a timer.
`docs/architecture.md` covers this in detail.

**What does it cost?**
agenthook is free (MIT); the agents use your own Claude subscription or API usage. Each run's
tokens and cost are recorded — `agenthook usage` and the dashboard's Stats page show them per
step, per ticket and per day. The recorded demo (one code run and one review run on a toy repo)
cost $0.43 as reported by the `claude` CLI; real tickets vary with the repo and the instructions.

**Which trackers, agents, tunnels and forges?**
Trackers: Asana, Jira, GitHub Issues (labels as stages), GitHub Projects v2 (status columns),
Linear (workflow states), and a local board for trying it out. Agents: Claude Code by default,
plus Cursor, Hermes and OpenCode per step (`docs/agents.md`). Ingress: ngrok, cloudflared,
Tailscale Funnel, or a `hosted` URL you front yourself (`docs/configuration.md`). Forge
(optional): GitHub or GitLab, for merged PRs/MRs and red CI. Each tracker, ingress, forge and
agent is one adapter file.

**Do I need ngrok, with a URL that rotates every start?**
No. A named cloudflared tunnel gives a stable `https://<hostname>`, and Tailscale Funnel serves on
your machine's stable `*.ts.net` name with one path per profile, so several profiles share it. A
quick cloudflared tunnel needs no account but rotates like ngrok. All in `docs/configuration.md`.

**GitLab? Linear?**
Yes. Linear is a tracker: one team's workflow states are the stages, and the team webhook is
created for you when the key belongs to an admin (`docs/linear-setup.md`). GitLab is a forge: a
merged MR completes the ticket, and a red pipeline is retried once, then sent back for rework
(`docs/gitlab.md`). GitLab issues as a tracker are not supported.

**Can I avoid a personal access token?**
On GitHub, yes: a GitHub App with narrow, per-repo permissions. agenthook mints hour-long
installation tokens from the App's key, so no long-lived token sits in `.env`
(`docs/github-app.md`). The agents still push and open PRs with their own `gh` credentials.

**My Projects v2 board is user-owned. Does it work?**
Not with push events. GitHub sends `projects_v2_item` only for organization-level projects, so a
user-owned board gets no webhook, with a token or with an App. Move the board under an
organization, or use the GitHub Issues tracker with labels (`docs/github-projects-setup.md`).
