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

- **Org-owned project** — `agenthook start` **auto-creates** one `projects_v2_item` org webhook
  (scrubbing its own stale hooks first), signed with a secret agenthook generates. Deliveries are
  verified via `x-hub-signature-256: sha256=<hex>` (constant-time HMAC). If the token lacks
  `admin:org_hook`, agenthook **prints copy-pasteable setup** (Org Settings → Webhooks → Add
  webhook, with the URL, the `Projects v2 item` event, and the generated secret) to do once by
  hand — the receiver keeps serving either way.
- **User-owned project** — there is **no PAT/UI path** to a `projects_v2_item` webhook (personal
  accounts have no webhook settings; the event is org-webhook- or GitHub-App-only). `start` prints
  why. **Move the project under an organization** (or use a GitHub App) to receive events.

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

## Verify

```bash
agenthook doctor          # token resolves, repo is git, port free
agenthook start           # resolves the project, creates (or prints) the org webhook
agenthook run <issue#>    # assign + set its Status to your first sourceStatus
#   …or just set a card's Status to your first sourceStatus on the board
agenthook follow          # watch the agent
```

Stuck? See [troubleshooting](troubleshooting.md).

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
