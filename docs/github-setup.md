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
the repo (`issues` + `issue_comment` + `sub_issues` events), scrubbing any of its own stale hooks first. The signing secret is
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

`issue_comment` carries the **`@agent` resume**: when a step ends with `hold` (the agent posted a
question and the issue moved to its `holdLabel`), reply on the issue with a comment starting with
`@agent` (your `trigger`), **from the token owner's account**. That re-runs the held step with your
reply in its prompt, and on its next verdict the issue leaves the hold label. Comments from anyone
else, comments on PRs, and edited/deleted comments are ignored, even with `assigneeFilter: false`.
See [architecture → Resuming a held step](architecture.md#resuming-a-held-step-agent-reply). The
event takes effect on the next `agenthook start`, which recreates the hook.

That webhook is the **tracker's** — it has no idea what happens to the code. For merge/CI
awareness (a `merge`/`ci`/`ci_green` event when the agent's PR lands or its checks go red/green),
add a `forge` block; `agenthook init` offers it, with no extra token scopes needed when the
tracker is already `github`. See [Configuration → Forge](configuration.md#forge-optional--what-happened-to-the-code).

## 4. Assignee scoping

agenthook acts only on issues **assigned to the token owner** (resolved from `/user`), fail-closed:
if it can't resolve "us", it touches nothing. Assign the bot account to an issue (or set
`"assigneeFilter": false` to act on any assignee, repo-wide — deliberate, not a default).

## 5. Issue blocking is respected

agenthook honours GitHub's **native issue dependencies** (an issue's *blocked by* relationships). An
issue with an **open** blocker won't fire its step — it rests in its source label until every blocker
closes, then the dependent fires automatically. Checked live per webhook event (no polling), so a
reopened or multi-blocker case stays correct. This is a workflow gate, not a security one: if the
dependencies API errors it fails **open** (treats the issue as unblocked) so a hiccup can't freeze the
pipeline.

To let an agent-finished blocker auto-release its dependents, flag the **terminal** (manual) step with
`"closeIssue": true` — entering it CLOSES the issue, which fires the close-release for everything it
was blocking:

```jsonc
{ "id": "done", "manual": true, "sourceLabel": "agent:done", "closeIssue": true }
```

`closeIssue` is **opt-in and meant for the dependency-release case** — turn it on only if you use
`blocked_by` dependencies and want a finished blocker to auto-release them. Otherwise leave it off:
the normal flow closes the issue when its **PR merges** (the agent puts `Closes #<issue>` in the PR
body), which keeps the issue open — work visible — until the change is actually integrated.
`closeIssue: true` closes the issue the moment it reaches `done`, i.e. while its PR is still open, so
turn it on only when auto-release is worth that early close.

## Epics

An **epic** is a parent issue that groups other issues as **direct native sub-issues**. agenthook
never spawns an agent on an epic, even if it carries a pipeline label.

Identity is type-**or**-label:

- **Issue type** `Epic` (organization repos only — personal accounts don't have issue types) —
  config key `tracker.epicType`, default `"Epic"`.
- **Label** `epic` (case-insensitive) — config key `tracker.epicLabel`, default `"epic"`. This is
  the path for personal accounts.

On a personal repo, GitHub answers the type query with a 422 — agenthook notes that once (info
log, not a warning) and uses the label path only from then on.

```jsonc
"tracker": {
  "type": "github",
  "epicType": "Epic",   // optional, this is the default
  "epicLabel": "epic"   // optional, this is the default
}
```

An issue with sub-issues but no matching type or label is **not** treated as an epic.

Membership is the epic's **direct** sub-issues only — nested levels below a direct child are not
rolled up. Add a sub-issue from the issue's UI, or via the API:

```bash
curl -X POST -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/<owner>/<repo>/issues/<epic-number>/sub_issues \
  -d '{"sub_issue_id": <child-issue-id>}'   # the child's id, not its number
```

GitHub limits: **100 sub-issues per parent**, **8 nesting levels**.

The epic view refreshes live off the `sub_issues` hook event and `issues` `typed`/`untyped`
actions. A hook created **before** this feature shipped only has `issues` + `issue_comment` and
needs recreating to pick up `sub_issues`: restart the receiver (`agenthook start` recreates the
hook on boot) or, for a static/hosted URL, run `agenthook register <url>`.

Token: the Issues **read** scope from [§1](#1-a-token-github_token) is enough — epics add no new
token requirement.

> The type path (`epicType`) is **untested** — exercising it needs an organization repo, which
> wasn't available to verify unattended. The label path (`epicLabel`) is the one dogfooded on this
> repo.

See epics in the dashboard ([`docs/web-ui.md`](web-ui.md) epics view) or query them programmatically
via the MCP `epics` tool / `agenthook epics`.

Bucket meaning for a sub-issue that hasn't run locally yet: an **open same-repo** sub-issue with
no `agent:*` pipeline label is **backlog** — plain, unstarted work in this tracker's view, not
hidden from it. A sub-issue in **another repo** is **untracked** — outside this tracker's view,
since it can never be matched to a local run here. A closed sub-issue is **finished** either way.

## Routing to multiple repos

Create a **label convention** yourself, e.g. `platform:ios`, `platform:web`. `routeField` is the label **prefix**; the text after it is the route key. Pipeline labels (`agent:*`, etc.) are never used as keys, and agenthook does not create routing labels.

```json
"tracker": { "type": "github", "routeField": "platform:" },
"repos": [
  { "id": "web", "path": "/work/web", "default": true, "match": [] },
  { "id": "ios", "path": "/work/ios", "match": ["ios"] }
]
```

If a task yields more than one matching key, routing is a conflict and the task is held (no agent spawns) until you fix the value. Ops notes: [multi-repo profiles](usage.md#multi-repo-profiles).

## Verify

```bash
agenthook doctor          # token resolves, repo is git, port free
agenthook start           # creates the repo webhook, prints its id + URL
# add your first sourceLabel (e.g. agent:code) to an issue you're assigned
agenthook follow          # watch the agent
```

Stuck? See [troubleshooting](troubleshooting.md).
