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
  "displayIdField": "ID",              // optional — see below
  "pipeline": [ /* TODO section gids — see below */ ]
}
```

`displayIdField` (optional, default `"ID"`) names the custom field that holds the task's human id
(e.g. `ID-2738`). `ah agents`, `ah status` and `ah events` show that id instead of the raw task
gid, and `ah events --ref ID-2738` accepts it. Matching is case-insensitive; with no such field the
raw gid is shown.

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

## Completing tasks on merge (forge)

Once a PR is open, the Asana board alone can't tell that it merged. An optional **forge** block
closes that loop: when a PR on a receiver-made `agent/<ref>` branch **merges**, agenthook moves the
task into your `done` section and marks it `completed` in Asana. "Done" means **merged**.

```json
{
  "forge": {
    "type": "github",
    "repository": "owner/name",
    "token": "${GITHUB_TOKEN}"
  },
  "tracker": {
    "type": "asana",
    "pipeline": [
      "… triage / code / review …",
      { "id": "done", "manual": true, "completeOnMerge": true, "drainWorktree": true,
        "sourceSectionGid": "DONE_GID" }
    ]
  }
}
```

- **`completeOnMerge`** goes on **one** `manual` step (config load rejects it anywhere else, or on
  two steps). On a merge the task is moved into that step's source section; Asana's own webhook then
  fires the `done` step, which drains the worktree and emits `pipeline_done`. The task is then
  marked `completed`. Without a `completeOnMerge` step the task is only marked completed and the
  worktree is drained directly.
- **Only merged PRs count.** A PR closed without merging, a branch that isn't `agent/*`, or a task
  not assigned to your `userGid` is a logged no-op with no Asana writes. A redelivered event for the
  same PR number is deduped (`merged:<number>`).
- **Events:** `merged` is appended to `events.jsonl` (plus `pipeline_done` from the `done` step).

**Token scope.** The forge token must be allowed to manage repo webhooks: `admin:repo_hook`
(classic) or **Webhooks: Read & write** (fine-grained) on the repository. For
[red CI](#red-ci-on-agent-prs) it also needs `repo` (classic) or **Actions: Read & write** +
**Pull requests: Read & write** (fine-grained).

**The webhook.** On `start` agenthook creates one repo webhook on the **Pull requests** and
**Workflow runs** events at
`<public-url>/forge`, signed with a secret it generates and stores (or `forge.webhookSecret` if you
set one). Every delivery is verified; an unsigned or badly signed POST to `/forge` gets a `401`.
`stop` (without `--keep-hooks`) and `unregister` delete it; an ephemeral ingress URL is scrubbed and
re-registered on each `start`. If the token can't manage hooks, `start` prints the manual setup and
carries on — add it by hand under **Settings → Webhooks → Add webhook**:

| Field | Value |
|-------|-------|
| Payload URL | `<public-url>/forge` |
| Content type | `application/json` |
| Secret | the one `start` printed |
| Events | *Let me select individual events* → **Pull requests**, **Workflow runs** |

A manual hook needs a **stable** ingress (reserved ngrok domain, or `hosted`), since its URL can't be
re-registered for you.

### Red CI on agent PRs

With a forge configured, a **red GitHub Actions run** on an `agent/<ref>` PR is handled for you
(on by default; `"redCi": false` in the `forge` block turns it off):

1. **First red run** (`failure` or `timed_out`): agenthook re-runs the **failed jobs once**. Nothing
   else happens, so a flaky job (e.g. a runner OOM) costs no agent run.
2. **Red again:** agenthook posts the failing log tail as a **PR comment**, then bounces the task
   with a `changes` verdict to the code step (the pipeline step with `createsWorktree`, or
   `"ciTarget": "<step id>"`). This goes through the normal rework loop, so the target step's
   `maxAttempts` caps it: at the cap the task goes to the failure lane instead.

Safety rules:

- **CI log text never reaches an agent prompt.** The PR head can shape CI output, so the log goes
  only into the PR comment. The rework prompt gets a fixed receiver-written line (short sha, run
  URL, attempt, PR number).
- If a step is **running** on the task when the second red arrives (e.g. review), the bounce waits
  for it. If that step exits with `advance`, the task goes back to code instead of moving on. A
  `changes`/`fail`/`hold` verdict from that step stands.
- A run on an **outdated commit** (the PR head moved on), a **closed** PR, a task **not assigned**
  to you, a branch from a **fork**, or a task that is not past the code step is a logged no-op.
  Each commit is bounced **at most once**, even if several workflows fail on it.
- `cancelled` and green runs are ignored. Only GitHub Actions is supported (not other check
  providers).

## Verify

```bash
agenthook doctor          # token resolves, repo is git, ngrok present, port free
agenthook start           # creates the webhook, serves
# move a task you're assigned into the first step's source section
agenthook follow          # watch the agent
```

Stuck? See [troubleshooting](troubleshooting.md).
