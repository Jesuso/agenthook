# GitHub Projects v2 setup

GitHub has **two** trackers. This one (`github-projects`) drives the pipeline off a **Projects v2
board's `Status` field**: each stage is a Status single-select option, and an issue-backed card
entering a Status fires the step bound to it. It's the GitHub tracker for teams that already run a
**real kanban board** and want the pipeline stages to *be* the board columns.

If you just want the lightest setup — labels as pseudo-sections, a repo webhook, an ephemeral
tunnel — use the labels-based [`github`](github-setup.md) tracker instead. See
[Labels vs board](#labels-vs-board-which-github-tracker) below.

## 1. A token (`GITHUB_TOKEN`)

A Personal Access Token used as a normal bearer PAT, with rights on the project, its issues, and —
to auto-register the org webhook — the org's hooks:

- **Classic** (<https://github.com/settings/tokens>): scopes `project` (read **and** write the
  board) + `repo` (read issues / assign them) + `admin:org_hook` (auto-create the org webhook).
- **Fine-grained** (<https://github.com/settings/tokens?type=beta>): **Projects → Read & write**,
  **Issues → Read** (Read & write if you use `agenthook run` to assign + add backlog issues),
  **Metadata → Read**, and **Organization permissions → Webhooks → Read & write** (for org
  auto-register).

Without `admin:org_hook` (or the fine-grained org Webhooks permission) everything still works —
agenthook just **prints** the org webhook for you to create by hand once (see §3).

```bash
# .env
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

```jsonc
"tracker": {
  "type": "github-projects",
  "project": "your-org/5",            // owner/number  (or paste the project URL)
  "repository": "your-org/your-repo", // only for `agenthook run` (adds a loose issue to the board)
  "token": "${GITHUB_TOKEN}",
  "pipeline": [ /* steps bound to Status option names — see below */ ]
}
```

`project` is `"owner/number"` (the owner may be an **org or a user**) or the full board URL
(`https://github.com/orgs/<org>/projects/<n>`). The assignee login used for scoping is read from
the token's `viewer`, so you never paste it.

Prefer narrow, short-lived tokens? Use a [GitHub App](github-app.md) instead (`tracker.auth`, an
org-owned project, and `tracker.assigneeLogin` set to your login).

## 2. Status options are your "sections"

There are no gids — steps reference the board's **Status single-select option names** (matched
case-insensitively). The keys are the same ones Jira uses (`sourceStatus`/`successStatus`/
`failureStatus`/`holdStatus`):

```jsonc
"pipeline": [
  {
    "id": "code",
    "kind": "implement",
    "createsWorktree": true,
    "instructionsFile": "./INSTRUCTIONS_CODE.md",
    "sourceStatus":  "In Progress",   // a card's Status set to this → code runs
    "successStatus": "In Review",     // = the review step's sourceStatus
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

Same chaining rule as every tracker: **one step's `successStatus` is the next step's
`sourceStatus`.** Unlike the labels tracker, `advance` **sets** the card's Status to one concrete
option (a single `updateProjectV2ItemFieldValue` mutation) — single-occupancy, so a card is in
**exactly one** stage at a time. No add-before-remove, no card carrying two stages.

> **Create the Status options yourself.** GitHub auto-creates *labels* for the `github` tracker,
> but Projects v2 **Status options are not auto-created** — add every option your pipeline names
> (`In Progress`, `In Review`, `Blocked`, …) to the board's **Status** field first
> (Project → ⋯ → Settings → Status). A verdict whose target Status has no matching option is a
> logged no-op and the card stays put.

## 3. The webhook (org auto-create, with a manual fallback)

Projects v2 events (`projects_v2_item`) are delivered by an **org-level** webhook tied to a
**fixed URL** — there is no per-project or per-repo hook for them. Two cases:

- **Org-owned project** — `agenthook start` **auto-creates** one org webhook subscribed to
  `projects_v2_item` and `issue_comment` (the [`@agent` resume](#5-resuming-a-held-step)),
  scrubbing its own stale hooks first, signed with a secret agenthook generates. Deliveries are
  verified via `x-hub-signature-256: sha256=<hex>` (constant-time HMAC). If the token lacks
  `admin:org_hook`, agenthook **prints copy-pasteable setup** (Org Settings → Webhooks → Add
  webhook, with the URL, the `Projects v2 item` + `Issue comments` events, and the generated
  secret) to do once by hand — the receiver keeps serving either way.
- **User-owned project** — there is **no PAT/UI path** to a `projects_v2_item` webhook (personal
  accounts have no webhook settings, and GitHub sends `projects_v2_item` only for
  organization-level projects — a [GitHub App](github-app.md) doesn't change that). `start` prints
  why. **Move the project under an organization** to receive events.

Because the URL is **fixed**, run agenthook behind a **stable ingress** — an ngrok reserved
`domain`, or a `hosted` URL — **not** an ephemeral tunnel (the rotating URL would orphan the org
hook each boot). This is the same constraint as Jira.

```jsonc
"ingress": { "type": "ngrok", "domain": "your-name.ngrok.app", "authtoken": "${NGROK_AUTHTOKEN}" }
// or:       { "type": "hosted", "url": "https://hook.you.com" }
```

If you'd rather supply your own secret, set `"webhookSecret": "..."`; `false` accepts unsigned
deliveries (don't, outside local testing).

## 4. Assignee scoping

agenthook acts only on cards whose **issue is assigned to the token owner** (resolved from
`viewer`), fail-closed: if it can't resolve "us", it moves nothing. Assign the bot account to the
issue (`agenthook run` does this for you), or set `"assigneeFilter": false` to act on any assignee
board-wide (deliberate, not a default).

## 5. Resuming a held step

The `@agent` reply resume ([architecture → Resuming a held step](architecture.md#resuming-a-held-step-agent-reply))
works on GitHub Projects: answer a held card by commenting `@agent …` **on its issue**, as the token
owner. The held step re-runs with your reply in its prompt. Comments live on the issue, not the
card, so they arrive as `issue_comment`; agenthook maps the issue to its card on *this* board
(through the issue's project items, one query), and resumes only when the issue is assigned to us,
the card is held on a runnable step under its attempt cap, and — when that step sets a
`holdStatus` — the card still sits in it. If you already moved the card elsewhere, the comment is
ignored.

The org webhook from §3 carries `issue_comment` already. Where there is no org hook — a
**user-owned** board, or no `admin:org_hook` — add a **repo** webhook instead on each repo whose
issues are on the board (Repo Settings → Webhooks → Add webhook): the same Payload URL
(`<public-url>/github-projects/`), `application/json`, the same secret, and the **Issue comments**
event. `agenthook start` prints these values. (On a user-owned board this gives you the resume only;
Status moves still need an org-owned project and its org hook.)

Moving the card from its `holdStatus` back to the step's `sourceStatus` also re-runs the step, but
without your reply in its prompt.

## Epics

An **epic** is an issue that groups other issues as **direct native sub-issues**, same as the
[labels tracker](github-setup.md#epics) (ADR 0004). It is an epic when its **issue type** is
`tracker.epicType` (default `"Epic"`, organization repos only) **or** it carries the label
`tracker.epicLabel` (default `"epic"`, the path for personal accounts). A parent that merely has
sub-issues is not an epic, and agenthook never runs an agent on one, even in a pipeline Status.

```jsonc
"tracker": { "type": "github-projects", "project": "owner/1", "epicType": "Epic", "epicLabel": "epic" }
```

- **Scope = the board.** Only epic *cards on this board* are listed. Each ticket's stage is its own
  card's **Status**; a card with no Status reads as backlog, and a sub-issue that is not on the board
  (or lives in another repository) is shown as untracked.
- **Sub-issues follow their parent onto the board.** GitHub adds a sub-issue to its parent's projects
  by default, so adding an epic card also adds its children (verified: adding one epic card added its
  three sub-issues, with their Status). Untracked children are therefore rare for same-owner boards.
- No extra token scope: the epic fields ride on the same project item query the pipeline already uses.
- **No push for epic changes.** The `projects_v2_item` org hook carries card edits, not sub-issue
  changes (those are *repository* events), and a user-owned board has no webhook at all. The Epics
  view refreshes on ticket events and its Refresh button, like Asana. (If you also run a `github`
  labels profile on a repo, its hook emits `epic_changed` for that repo.)
- See epics in the dashboard ([`web-ui.md`](web-ui.md)) or via the MCP `epics` tool / `agenthook epics`.

## Verify

```bash
agenthook doctor          # token resolves, repo is git, port free
agenthook start           # resolves the project, creates (or prints) the org webhook
agenthook run <issue#>    # assign + set its Status to your first sourceStatus
#   …or just set a card's Status to your first sourceStatus on the board
agenthook follow          # watch the agent
```

Stuck? See [troubleshooting](troubleshooting.md).

## Routing to multiple repos

Add a second **single-select** field to the board (e.g. `Platform`) and set `routeField` to its name. The option name is the route key, read in the same query as Status.

```json
"tracker": { "type": "github-projects", "routeField": "Platform" },
"repos": [
  { "id": "web", "path": "/work/web", "default": true, "match": [] },
  { "id": "ios", "path": "/work/ios", "match": ["ios"] }
]
```

If a task yields more than one matching key, routing is a conflict and the task is held (no agent spawns) until you fix the value. (Not possible here: a single-select holds one value.) Ops notes: [multi-repo profiles](usage.md#multi-repo-profiles).

## Labels vs board: which GitHub tracker?

| | [`github`](github-setup.md) (labels) | `github-projects` (this) |
|---|---|---|
| **Stages are** | issue **labels** | a Projects v2 board's **Status** options (true columns) |
| **API** | REST | GraphQL |
| **Webhook** | one **repo** hook, **auto-created** | one **org** hook (auto-created for org projects; manual fallback) |
| **Ingress** | **ephemeral OK** (hook re-created each boot) | **stable required** (URL is fixed) |
| **Stage move** | add target label, then remove source (can briefly carry two) | set Status — single-occupancy (always exactly one) |
| **Org required?** | no | yes, for the webhook (user-owned projects can't receive events) |
| **Stages created for you?** | yes (labels) | no (create the Status options first) |

Pick **`github`** for the least fiddly setup — no org, an ephemeral tunnel is fine, labels stand in
for sections. Pick **`github-projects`** when your team already lives on a Projects v2 board and you
want the pipeline stages to *be* the board columns, with a real kanban view and one-stage-at-a-time
cards.
