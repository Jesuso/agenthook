# Jira example profile

A copy-paste-runnable agenthook profile for **Jira Cloud** — a 4-stage pipeline
(`triage → code → review`, plus a terminal `done`) driven off an issue's workflow **status**.
For the full provider walkthrough see [`docs/jira-setup.md`](../../docs/jira-setup.md).

## The pipeline

An issue entering a step's `sourceStatus` fires that step; on a clean exit the receiver
**transitions** the issue to the next status, which fires the next step.

| Step     | sourceStatus     | on advance →   | failure   | hold        |
| -------- | ---------------- | -------------- | --------- | ----------- |
| triage   | `Awaiting Triage`| `Agent Queue`  | `Blocked` | `Needs Info`|
| code     | `Agent Queue`    | `In Review`    | `Blocked` | `Needs Info`|
| review   | `In Review`      | `Done`         | `Blocked` | —           |
| done     | `Done`           | _(terminal — manual, no agent; drains the worktree)_ |||

Each step's `successStatus` is the next step's `sourceStatus` — that chaining is what makes one
move trigger the next stage.

## Setup

1. **Copy this directory** into the repo your agents work in (or anywhere), and point
   `repoPath` in `agenthook.config.json` at that repo.

2. **Fill the placeholders** in `agenthook.config.json`:
   - `tracker.site` → `YOUR_SITE` (your `<site>.atlassian.net`), or set a full `baseUrl`.
   - `tracker.email` → the Basic-auth username (the bot account's email; not secret).
   - `tracker.projectKey` → `YOUR_PROJECT_KEY`.
   - Rename the status names if your board's columns differ (keep the chaining intact).

3. **Set secrets** in a `.env` beside the config (Jira's API token is Basic auth — the email is
   the username, the token is the password):
   ```bash
   # .env
   JIRA_API_TOKEN=ATATT3x...          # https://id.atlassian.com/manage-profile/security/api-tokens
   NGROK_AUTHTOKEN=...                # if using the ngrok ingress
   ```

4. **Create the four workflow transitions.** Jira has no "set status" — agenthook moves an issue by
   executing the workflow **transition** whose target is the next status. If a transition between
   two adjacent statuses doesn't exist on your board, `advance` is a **logged no-op** (the issue
   stays put). Make sure your project workflow connects, at minimum:
   - `Awaiting Triage` → `Agent Queue`
   - `Agent Queue` → `In Review`
   - `In Review` → `Done`
   - `In Review` → `Agent Queue` (the review `changes` rework loop)

   (and the `Blocked` / `Needs Info` transitions you want failures and holds to land in). See
   [`docs/jira-setup.md §2`](../../docs/jira-setup.md#2-statuses-are-your-sections).

5. **Use a STABLE ingress.** The Jira webhook URL is created by hand and can't rotate, so pair it
   with an ngrok reserved `domain` (set in the config) or a `hosted` URL — **never** an ephemeral
   tunnel. See [`docs/jira-setup.md §4`](../../docs/jira-setup.md#4-use-a-stable-ingress).

6. **Start the receiver** and create the webhook:
   ```bash
   agenthook doctor      # token resolves, repo is git, port free, ingress URL/domain set
   agenthook start       # prints the by-hand webhook setup, including a generated Secret
   ```
   Jira Cloud forbids creating webhooks with an API token, so `start` prints the exact steps:
   in **Settings → System → WebHooks → Create a WebHook**, paste the printed URL, tick **Issue
   created** + **Issue updated**, and paste the printed **Secret** verbatim into the webhook's
   Secret field. agenthook verifies each delivery via `x-hub-signature`. See
   [`docs/jira-setup.md §3`](../../docs/jira-setup.md#3-create-the-webhook-by-hand-once).

7. **Try it:** assign yourself an issue and transition it into `Awaiting Triage`, then
   `agenthook follow` to watch the agent.

## Notes

- agenthook acts only on issues assigned to the token owner (resolved from `/myself`), fail-closed.
  Set `"assigneeFilter": false` in the tracker block to go project-wide.
- The three `INSTRUCTIONS_*.md` files are the standing prompts for each agent stage. Tune them to
  your repo. `done` is manual (no agent), so it has no instructions file.
