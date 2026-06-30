# GitHub Projects v2 example profile

A runnable 3-step pipeline — **triage → code → review** (plus a terminal **done**) — driven by a
GitHub **Projects v2 board's Status field**. Each stage is a Status single-select option; a card
entering a Status fires the step bound to it. On a clean verdict the receiver **sets** the card's
Status to the next stage (single-occupancy — a card is in exactly one column).

> This is the board-driven GitHub tracker. If you'd rather use issue **labels** as pseudo-sections
> with the lightest setup (a repo webhook, an ephemeral tunnel), use the labels-based
> [`github`](../../docs/github-setup.md) tracker instead. Full comparison:
> [docs/github-projects-setup.md](../../docs/github-projects-setup.md#labels-vs-board-which-github-tracker).

## The pipeline

| Step | Status (source → success) | What runs |
|------|---------------------------|-----------|
| `triage` | **Triage** → **In Progress** | verifies + specs the issue; no code |
| `code` | **In Progress** → **In Review** | implements in a worktree, opens a draft PR |
| `review` | **In Review** → **Done** | reviews the PR; `changes` bounces back to `code` |
| `done` | **Done** | terminal, no agent — drains the worktree |

`failureStatus` is **Blocked** and `holdStatus` is **Needs Info** for every agent step.

## Setup

### 1. Copy the profile

```bash
cp -r examples/github-projects ~/my-agenthook-profile
cd ~/my-agenthook-profile
```

Edit `agenthook.config.json` and replace every placeholder:

- `repoPath` → the absolute path of the repo the agents work in.
- `tracker.project` → `YOUR_ORG/NUMBER` (an **org**-owned project's owner + number, or its URL).
- `tracker.repository` → `YOUR_ORG/YOUR_REPO` (only used by `agenthook run`; omit otherwise).
- `ingress.domain` → your **reserved** ngrok domain (or switch to the `hosted` block).

### 2. Set `GITHUB_TOKEN`

A PAT used as a bearer token. **Classic:** scopes `project` + `repo` + `admin:org_hook`.
**Fine-grained:** Projects → R/W, Issues → R (R/W for `agenthook run`), Metadata → R, and
Organization → Webhooks → R/W. Without org-hook rights everything still works — agenthook just
**prints** the webhook for you to add once by hand.

```bash
# .env  (next to agenthook.config.json — gitignored, auto-loaded)
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NGROK_AUTHTOKEN=...
```

### 3. Create the board Status options FIRST

Projects v2 Status options are **not** auto-created. On the board, open **Project → ⋯ → Settings →
Status** and add every option this profile names, then save:

```
Triage   ·   In Progress   ·   In Review   ·   Done   ·   Blocked   ·   Needs Info
```

A verdict whose target Status has no matching option is a logged no-op and the card stays put.

### 4. Org webhook + stable ingress

Projects v2 events (`projects_v2_item`) are delivered by **one org-level webhook at a fixed URL** —
there is no per-project or per-repo hook. So:

- Use an **org-owned** project. `agenthook start` auto-creates the org webhook (with
  `admin:org_hook`), or prints copy-pasteable manual setup if the token lacks it. A **user-owned**
  project has **no PAT webhook path** — move it under an org (or use a GitHub App).
- Run behind a **stable** ingress (reserved ngrok `domain` or a `hosted` URL), **not** an ephemeral
  tunnel — the fixed URL would orphan the org hook on every boot.

### 5. Run

```bash
agenthook doctor          # token resolves, repo is git, port free
agenthook start           # resolves the project, creates (or prints) the org webhook
agenthook run <issue#>    # assign + set the card's Status to Triage
#   …or just set a card's Status to Triage on the board
agenthook follow          # watch the agent
```

## Files

- `agenthook.config.json` — the profile (placeholders marked `YOUR_*`).
- `INSTRUCTIONS_TRIAGE.md` / `INSTRUCTIONS_CODE.md` / `INSTRUCTIONS_REVIEW.md` — each step's standing
  prompt. Tune them to your repo.

## More

Full reference, token scopes, assignee scoping, and troubleshooting:
[docs/github-projects-setup.md](../../docs/github-projects-setup.md).
