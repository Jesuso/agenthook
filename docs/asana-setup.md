# Asana setup

Asana is the reference tracker. Work flows through the **sections** of one project; each step binds
to a section gid. This page covers the token, finding gids, and the webhook.

## 1. Personal access token

Create one at **Asana → Settings → Apps → Developer apps → Personal access tokens**, or directly at
<https://app.asana.com/0/my-apps>. It looks like `2/1199xxxxxxxxxxxx/abcdef...`.

Scope it to the workspace that holds your project; don't reuse a token with more reach than this
needs. Put it in `.env` beside your config:

```bash
ASANA_TOKEN=2/1199xxxxxxxxxxxx/abcdef0123456789abcdef0123456789
```

`agenthook init` reads `ASANA_TOKEN` (or whatever env var you name) to power live discovery.

## 2. Workspace, project, and your user gid — discovered by `init`

The wizard uses your token to let you pick the **workspace** and **project** from a typeahead, and
fetches your **user gid** from `/users/me`. After `init`, the `tracker` block already has:

```jsonc
"tracker": {
  "type": "asana",
  "token": "${ASANA_TOKEN}",
  "userGid": "1200xxxxxxxxxxxx",       // you — used for assignee scoping
  "workspaceGid": "1199xxxxxxxxxxxx",
  "projectGid": "1200xxxxxxxxxxxx",    // the project whose sections drive the pipeline
  "pipeline": [ /* TODO section gids — see below */ ]
}
```

## 3. Section gids — the one thing you fill by hand

Sections have numeric gids that `init` does **not** auto-fill (it leaves `TODO_*` placeholders).
List them with your token and the `projectGid` from your config:

```bash
curl -s -H "Authorization: Bearer $ASANA_TOKEN" \
  "https://app.asana.com/api/1.0/projects/<projectGid>/sections?opt_fields=name" | jq
```

```jsonc
{ "data": [
  { "gid": "1200000000000001", "name": "Awaiting triage" },
  { "gid": "1200000000000002", "name": "Agent queue" },
  { "gid": "1200000000000003", "name": "Awaiting review" },
  { "gid": "1200000000000004", "name": "QC" },
  { "gid": "1200000000000009", "name": "Blocked" },
  { "gid": "1200000000000010", "name": "Needs answer" }
] }
```

Paste those gids into each step's `sourceSectionGid` / `successSectionGid` / `failureSectionGid` /
`holdSectionGid`, remembering the chaining rule: **one step's `successSectionGid` is the next step's
`sourceSectionGid`**. See [getting-started §4](getting-started.md#4-map-your-sections-to-steps--the-part-that-actually-matters).

> Tip: lay your Asana board out as columns matching your pipeline (Awaiting triage → Agent queue →
> Awaiting review → Done), plus a Blocked and a Needs-answer column for `fail`/`hold`. Then the
> board *is* the pipeline, visually.

## 4. The webhook — automatic

On `agenthook start`, the Asana adapter creates **one project webhook** for you (path `/mytasks`)
with these filters:

| Event | Why |
|-------|-----|
| `task` / `added` | a task created directly in a section → fire that section's step |
| `story` / `section_changed` | a task **moved** between sections → fire the destination's step |

Both route off the task's **live** `memberships.section.gid`, so even rapid back-to-back moves
resolve to where the task actually is now. Each Asana webhook carries its own `X-Hook-Secret`,
established by a handshake that agenthook answers automatically and stores (0600) keyed by request
path. Signatures are verified with constant-time HMAC-SHA256.

`agenthook stop` deletes the webhook; an ephemeral ingress URL (default ngrok) is scrubbed and
re-registered on each `start`. Nothing to do by hand.

## 5. Assignee scoping

By default agenthook acts **only on tasks assigned to your `userGid`** and is fail-closed: if
`userGid` is unset it refuses everything rather than going project-wide. To process every task in
the sections regardless of assignee, set `"assigneeFilter": false` in the `tracker` block —
explicitly.

## Verify

```bash
agenthook doctor          # token resolves, repo is git, ngrok present, port free
agenthook start           # creates the webhook, serves
# move a task you're assigned into the first step's source section
agenthook follow          # watch the agent
```

Stuck? See [troubleshooting](troubleshooting.md).
