# GitHub setup

GitHub Issues has no board sections, so agenthook drives the pipeline off **issue labels**: a step
binds `sourceLabel` and an issue carrying that label fires the step. Of the three trackers it's the
**least fiddly** — the webhook is created for you, the token is a normal bearer PAT, and it works
behind an ephemeral ngrok tunnel.

## 1. A token (`GITHUB_TOKEN`)

Create a Personal Access Token with rights on the one repo whose issues drive the pipeline:

- **Classic** (<https://github.com/settings/tokens>): scopes `repo` + `admin:repo_hook`.
- **Fine-grained** (<https://github.com/settings/tokens?type=beta>), scoped to that repo:
  **Issues → Read & write**, **Webhooks → Read & write**, **Metadata → Read**.

```bash
# .env
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

```jsonc
"tracker": {
  "type": "github",
  "repository": "your-org/your-repo",   // owner/name  (or set "owner" + "repo")
  "token": "${GITHUB_TOKEN}",
  "pipeline": [ /* steps bound to label names — see below */ ]
}
```

`init` reads the token owner via `/user`, so the assignee login used for scoping is derived
automatically — you never paste it.

## 2. Labels are your "sections"

There are no gids and no statuses — steps reference **label names** (matched case-insensitively):

```jsonc
"pipeline": [
  {
    "id": "code",
    "kind": "implement",
    "createsWorktree": true,
    "instructionsFile": "./INSTRUCTIONS_CODE.md",
    "sourceLabel":  "agent:code",      // issue gets this label → code runs
    "successLabel": "agent:review",    // = the review step's sourceLabel
    "failureLabel": "agent:blocked",
    "holdLabel":    "agent:needs-info"
  },
  {
    "id": "review",
    "kind": "review",
    "instructionsFile": "./INSTRUCTIONS_REVIEW.md",
    "sourceLabel":  "agent:review",
    "successLabel": "agent:done",
    "failureLabel": "agent:blocked"
  }
]
```

Same chaining rule as the others: **one step's `successLabel` is the next step's `sourceLabel`.**
`advance` adds the new label and then removes the old one (add-before-remove, so a crash mid-move
leaves the issue re-firing rather than stuck).

> **Labels are created for you.** GitHub's API won't add a label to an issue unless that label
> already exists in the repo, so `agenthook start` creates every label your pipeline names
> (`agent:code`, `agent:review`, …) on boot — idempotent, an existing label is left untouched. This
> is the GitHub equivalent of filling in Asana's section gids, done automatically. (You can still
> pre-create them under **Issues → Labels** if you want custom colours.)

## 3. The webhook is automatic

Unlike Jira, GitHub lets a token create webhooks — so `agenthook start` **creates it for you** on
the repo (`issues` event), scrubbing any of its own stale hooks first. The signing secret is
generated and stored by agenthook; deliveries are verified via `x-hub-signature-256: sha256=<hex>`
(constant-time HMAC). `GITHUB_TOKEN` is the only secret you supply.

Because the hook is auto-managed, GitHub is happy behind an **ephemeral** ingress — agenthook
re-creates the hook at the new URL on every boot:

```jsonc
"ingress": { "type": "ngrok", "authtoken": "${NGROK_AUTHTOKEN}" }   // ephemeral is fine
```

A stable `domain`/`hosted` URL still works and saves a hook-rewrite each boot, but it isn't
required (it is for Jira).

If you'd rather supply your own secret, set `"webhookSecret": "..."`; `false` accepts unsigned
deliveries (don't, outside local testing).

## 4. Assignee scoping

agenthook acts only on issues **assigned to the token owner** (resolved from `/user`), fail-closed:
if it can't resolve "us", it touches nothing. Assign the bot account to an issue (or set
`"assigneeFilter": false` to act on any assignee, repo-wide — deliberate, not a default).

## Verify

```bash
agenthook doctor          # token resolves, repo is git, port free
agenthook start           # creates the repo webhook, prints its id + URL
# add your first sourceLabel (e.g. agent:code) to an issue you're assigned
agenthook follow          # watch the agent
```

Stuck? See [troubleshooting](troubleshooting.md).
