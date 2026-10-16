# Jira setup

Jira Cloud drives the pipeline off an issue's **workflow status** (its board column) instead of
sections: a step binds `sourceStatus` and an issue entering that status fires the step. Two things
differ from Asana and trip people up — **Basic auth** (not bearer) and a **by-hand webhook**.

## 1. API token + email (Basic auth)

Create a token at <https://id.atlassian.com/manage-profile/security/api-tokens> (it looks like
`ATATT3x...`). Crucially, a Jira Cloud API token authenticates only as the **password in HTTP
Basic**, with your **account email as the username** — `Authorization: Bearer <token>` returns 403.
That's why the config needs both `email` and `token`. The email isn't secret, so it's inline; the
token is an env ref.

```bash
# .env
JIRA_API_TOKEN=ATATT3xFfGF0xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

```jsonc
"tracker": {
  "type": "jira",
  "site": "yourcompany",              // <site>.atlassian.net  (or set "baseUrl")
  "email": "bot@yourcompany.com",     // the Basic-auth username
  "token": "${JIRA_API_TOKEN}",
  "projectKey": "ENG",                // the project whose statuses drive the pipeline
  "pipeline": [ /* steps bound to status names — see below */ ]
}
```

`init` fetches your account via `/myself`, so your `assigneeAccountId` (for scoping) is derived
automatically — you never paste it.

## 2. Statuses are your "sections"

There are no gids. Steps reference **status names**, matched case-insensitively:

```jsonc
"pipeline": [
  {
    "id": "code",
    "kind": "implement",
    "createsWorktree": true,
    "instructionsFile": "./INSTRUCTIONS_CODE.md",
    "sourceStatus":  "In Progress",     // issue enters this status → code runs
    "successStatus": "In Review",       // = the review step's sourceStatus
    "failureStatus": "Blocked",
    "holdStatus":    "Needs Info"
  },
  {
    "id": "review",
    "kind": "review",
    "instructionsFile": "./INSTRUCTIONS_REVIEW.md",
    "sourceStatus":  "In Review",
    "successStatus": "Done",
    "failureStatus": "Blocked"
  }
]
```

Same chaining rule as Asana: **one step's `successStatus` is the next step's `sourceStatus`.**

> **Transitions must exist in your workflow.** Jira has no "set status" — agenthook moves an issue
> by executing the workflow **transition** whose target is your status. If your board's workflow
> has no transition from the issue's current status to the target, the move is a logged no-op (the
> issue stays put). Make sure your workflow actually connects the columns your pipeline walks.

## 3. Create the webhook by hand (once)

Jira Cloud restricts webhook creation over REST to Connect/Forge apps, so agenthook can't create it
with your token. On `agenthook start` it instead **prints the exact setup** — including a signing
secret it generated and stored for you:

```
[jira] Jira Cloud webhooks can't be created with an API token (Connect-app only).
       Create it ONCE, by hand, as a Jira admin:
         Settings → System → WebHooks → Create a WebHook
           URL:    https://<your-stable-url>/jira/
           Events: Issue → created, updated, deleted (deleted only feeds the epic view)
           Secret: <agenthook-generated-secret>
         ↑ agenthook generated + stored this. Paste it verbatim into the webhook's Secret field.
```

Paste the URL, tick **Issue created** + **Issue updated** (+ **Issue deleted** if you use [epics](#epics)), paste the **Secret**, save. agenthook
verifies each delivery via `x-hub-signature: sha256=<hex>` (constant-time HMAC). The token stays
the only secret *you* supply; the webhook secret is agenthook's to own.

If you'd rather supply your own secret, set `"webhookSecret": "..."` in the config; `false` accepts
unsigned deliveries (don't, outside local testing).

## Epics

Jira has epics natively, so there is nothing to invent. An issue **is an epic** when its issue type
sits at **hierarchy level 1** (the built-in `Epic`; also what Jira Premium's Advanced Planning calls
the epic level), and its **tickets are the issues whose `parent` is it** — Jira's own parent link,
the same one the board and roadmap use. agenthook never spawns an agent on an epic, even if it sits
in a pipeline status. Not an epic: a Story with sub-tasks (a Subtask's parent is a Story, level 0),
or any issue that merely has children.

```jsonc
"tracker": {
  "type": "jira",
  // optional: pin the epic issue type by NAME instead of "hierarchy level 1"
  "epicType": "Epic"
}
```

- Membership is **direct children only** (`parent = KEY`); sub-tasks of a child are not rolled up.
  Children of any assignee count — viewing an epic never acts on it, so assignee scoping does not apply.
- A ticket's stage in the epic view is its **status name**; an epic is finished when its status is in
  a done category.
- Children are linked from the issue's **Parent** field (board, issue view, or the API:
  `"parent": {"key": "PROJ-1"}`). The deprecated *Epic Link* custom field is not read.
- The epic view stays fresh from the webhook: tick **Issue deleted** too (optional). A parent change
  (`IssueParentAssociation` in the changelog), or an issue created/deleted under an epic, emits
  `epic_changed` for the old and new epic — read-only, no agent, no move.
- Token: the same read access as above; epics add no new permission.
- See epics in the dashboard ([`web-ui.md`](web-ui.md)) or via the MCP `epics` tool / `agenthook epics`.

## 4. Use a STABLE ingress

Because the webhook URL is fixed by hand, it can't rotate. Pair Jira with a **stable** ingress —
an ngrok reserved `domain`, or a `hosted` URL behind your own proxy — never an ephemeral tunnel
(whose URL changes every restart and would orphan the by-hand webhook).

```jsonc
"ingress": { "type": "ngrok", "authtoken": "${NGROK_AUTHTOKEN}", "domain": "your-app.ngrok.app" }
// or
"ingress": { "type": "hosted", "url": "https://hook.yourcompany.com" }
```

## 5. Assignee scoping

agenthook acts only on issues assigned to the token owner (resolved from `/myself`), fail-closed: if
it can't resolve "us", it touches nothing. `"assigneeFilter": false` opts into project-wide.

## 6. Resuming a held step

The `@agent` reply resume ([architecture → Resuming a held step](architecture.md#resuming-a-held-step-agent-reply))
is **not supported on Jira yet**: a comment does not re-run a held step. To resume, answer the
agent's question, then transition the issue from its `holdStatus` back to the step's `sourceStatus`.
The step re-runs, but without your reply in its prompt. (A future adapter would subscribe the
webhook to `comment_created`.)

## Routing to multiple repos

Route on a Jira field. `routeField` is one of: `components` (component names), `labels`, or a custom field id `customfield_N` (text, single/multi-select or labels-type; referenced by id only). Anything else is ignored with a warning.

```json
"tracker": { "type": "jira", "routeField": "components" },
"repos": [
  { "id": "web", "path": "/work/web", "default": true, "match": [] },
  { "id": "ios", "path": "/work/ios", "match": ["ios"] }
]
```

If a task yields more than one matching key, routing is a conflict and the task is held (no agent spawns) until you fix the value. Ops notes: [multi-repo profiles](usage.md#multi-repo-profiles).

## Verify

```bash
agenthook doctor          # token resolves, repo is git, port free, ingress.url/domain set
agenthook start           # prints the by-hand webhook instructions
# create the webhook in Jira admin per the print-out
# transition an issue you're assigned into the first sourceStatus
agenthook follow          # watch the agent
```

Stuck? See [troubleshooting](troubleshooting.md).
