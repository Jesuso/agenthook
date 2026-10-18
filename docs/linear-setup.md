# Linear setup

Linear drives the pipeline off one team's **workflow states** (Backlog, Todo, In Progress, …): a step
binds `sourceStatus` and an issue entering that state fires the step. Things that differ from the
other trackers: a **personal API key with no `Bearer`**, a **team-scoped webhook that needs an
admin**, and a **60-second replay window** on deliveries.

## 1. API key

Create a personal API key under **Settings → Account → Security & access → Personal API keys** (it
looks like `lin_api_...`). Linear expects it in `Authorization: <key>` exactly as issued —
**no `Bearer ` prefix** (that form is for OAuth tokens). The key is the only Linear secret you
supply.

```bash
# .env
LINEAR_API_KEY=lin_api_<your-key>
```

```jsonc
"tracker": {
  "type": "linear",
  "token": "${LINEAR_API_KEY}",
  "team": "ENG",                      // the team KEY, or its URL (https://linear.app/<org>/team/ENG/…)
  "pipeline": [ /* steps bound to state names — see below */ ]
}
```

`agenthook init` lists your teams, then lets you pick the code step's source, success and failure
states from that team's real workflow, so the written config works as-is.

## 2. Workflow states are your "sections"

Steps reference **state names** of the team, matched case-insensitively:

```jsonc
"pipeline": [
  {
    "id": "code",
    "kind": "implement",
    "createsWorktree": true,
    "instructionsFile": "./INSTRUCTIONS_CODE.md",
    "sourceStatus":  "Todo",            // issue enters this state → code runs
    "successStatus": "In Review",       // = the review step's sourceStatus
    "failureStatus": "Blocked",
    "holdStatus":    "Needs Info",
    "queueStatus":   "Backlog"          // optional: pull from here when a slot frees
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

Same chaining rule as the other trackers: **one step's `successStatus` is the next step's
`sourceStatus`.** Linear has no transition graph, so any state can move to any other — every move
agenthook makes lands.

A misspelt state fails on boot with the team's real states listed:

```
linear: step "code" sourceStatus "Todoo" is not a state of team ENG (available: Backlog, Todo, In Progress, In Review, Done, Canceled)
```

Issues are addressed by their **identifier** (`ENG-123`) everywhere — CLI, logs, the MCP tools. An
issue whose state type is `completed` or `canceled` counts as done.

## 3. The webhook (auto-created — needs an admin)

On `agenthook start`, agenthook creates one webhook on your team for **Issues** and **Comments**,
pointed at `https://<your-url>/linear/` and signed with a secret it generated and stored for you (or
your own `"webhookSecret": "..."`; `false` accepts unsigned deliveries — don't, outside local
testing). Stale agenthook hooks on the team (URL ending `/linear/`) are removed first.

Creating webhooks in Linear needs a **workspace admin**. If the key's user isn't one, boot keeps
going and prints the exact manual setup instead:

```
[linear] couldn't create the team webhook with this API key (...) —
       creating webhooks needs a Linear ADMIN. Create it ONCE, by hand:
         Settings → API → Webhooks → New webhook
           URL:            https://<your-stable-url>/linear/
           Team:           ENG
           Resource types: Issues, Comments
           Secret:         <agenthook-generated-secret>
```

A hand-made hook can't follow a rotating URL, so in that case pair Linear with a **stable** ingress
(an ngrok reserved `domain`, or a `hosted` URL).

Every delivery is checked in this order: `linear-signature` (hex HMAC-SHA256 of the raw body,
constant-time), then `webhookTimestamp` — a delivery more than **60 s** from the receiver's clock is
rejected as a replay. Keep the host's clock in sync (NTP).

## 4. Assignee scoping

agenthook acts only on issues assigned to the API key's own user (GraphQL `viewer`), fail-closed: an
unassigned issue, an issue assigned to someone else, or a failed `viewer` lookup is never touched.
`"assigneeFilter": false` opts into team-wide.

## 5. Resuming a held step

When a step holds with a question, answer with a comment that starts with the trigger (default
`@agent`). The held step re-runs with your reply in its prompt. The comment must be written by the
**same user as the API key** — the author is checked strictly, even with `assigneeFilter: false`.

## Not supported

OAuth apps, several teams in one profile, Linear projects/cycles as stages, and epics (Linear
parents/projects) are out of scope for now.

## Verify

```bash
agenthook doctor          # key resolves, repo is git, port free
agenthook start           # creates the webhook (or prints manual setup)
# move an issue assigned to you into the first sourceStatus
agenthook follow          # watch the agent
```

Stuck? See [troubleshooting](troubleshooting.md).
