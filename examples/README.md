# Example profiles

One **copy-paste-runnable profile per tracker**. Each subdirectory is a complete 3-step
**triage → code → review** pipeline (plus a terminal `done` that drains the worktree), wired to
that tracker's real stage fields with clearly-marked placeholders. Copy the one for your tracker
instead of translating a generic template.

## Pick your tracker

| Example | Tracker | Stages are… | Webhook | Ingress | Setup |
|---|---|---|---|---|---|
| [`asana/`](asana/) | Asana | project **sections** | auto (project hook) | ephemeral OK | [docs/asana-setup.md](../docs/asana-setup.md) |
| [`jira/`](jira/) | Jira Cloud | issue **statuses** | **by hand** (Jira forbids token hooks) | **stable** | [docs/jira-setup.md](../docs/jira-setup.md) |
| [`github-labels/`](github-labels/) | GitHub Issues | issue **labels** | auto (repo hook) | ephemeral OK | [docs/github-setup.md](../docs/github-setup.md) |
| [`github-projects/`](github-projects/) | GitHub Projects v2 | board **Status** options | auto (org hook, `admin:org_hook`) | **stable** | [docs/github-projects-setup.md](../docs/github-projects-setup.md) |

Rule of thumb: already on Asana/Jira → use that. On GitHub and want the simplest path → **github-labels**.
Want a real board with columns → **github-projects** (needs an org-owned project + stable ingress).

## Use an example

1. Copy the tracker's directory into your project — it becomes the config dir.
2. Create a `.env` beside `agenthook.config.json` with that tracker's token (and `NGROK_AUTHTOKEN` if
   you use the managed ngrok ingress).
3. Fill the `YOUR_*` / `TODO_*` placeholders — ids/keys, `repoPath`, and each step's stage bindings
   (chained: one step's success stage = the next step's source stage). Tokens stay `${ENV}` refs.
4. `agenthook doctor` (structural preflight) → `agenthook start`.

Each subdirectory's `README.md` has the tracker-specific version of these steps and links to its
setup doc. Placeholders are always clearly marked — no example ships a real id or token.
