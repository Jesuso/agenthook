# GitLab forge setup

The `gitlab` forge is the GitLab twin of the `github` forge. Your tracker (Asana, Jira, GitHub,
…) still says where work comes from. The forge watches the code side on GitLab:

- **MR merged → task done.** A merged merge request from a receiver-made `agent/<ref>` branch moves
  the task into the pipeline step marked `completeOnMerge` (a manual step), which completes it.
- **Pipeline red → retry once, then rework.** A failed pipeline on an `agent/<ref>` branch is
  retried once. If it fails again, agenthook posts the failing log tail as an MR note and bounces
  the task back to the coding step with `changes` (capped by `maxAttempts`, like any rework loop).
- **Pipeline green → `ci_green` event.** A signal for supervisors (MCP `events`); it moves nothing.

This is a forge only. A GitLab *tracker* (issues as the board) is not supported.

## 1. A token (`GITLAB_TOKEN`)

Create a personal (or project) access token with the **`api`** scope. The token's user needs the
**Maintainer** role on the project, because managing webhooks requires it.

```bash
# .env
GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx
```

## 2. The config block

```jsonc
"forge": {
  "type": "gitlab",
  "project": "your-group/sub-group/your-project",  // the path in the project URL; nested groups ok
  "token": "${GITLAB_TOKEN}"
  // "baseUrl": "https://gitlab.example.com",       // self-managed only; default https://gitlab.com
  // "redCi": false,                                 // don't react to failed pipelines
  // "greenCi": false,                               // don't emit ci_green
  // "ciTarget": "code",                             // step a red pipeline bounces to (default: the createsWorktree step)
  // "webhookSecret": "${GITLAB_HOOK_SECRET}"        // omit to let agenthook generate + store one
}
```

`agenthook init` offers this block when the repo's `origin` remote is a GitLab URL (any host
containing `gitlab`). A self-managed instance on another hostname has to be configured by hand:
set `project` and `baseUrl` as above. `agenthook doctor` warns when `project` or `token` is missing.

To complete tasks on merge, mark a manual step in `tracker.pipeline` with `"completeOnMerge": true`.

## 3. The webhook

On `agenthook start` the forge creates a project webhook on `<public URL>/forge` with **Merge
request events** and **Pipeline events**, SSL verification on, and its secret token. It replaces
only its own previous hook (by stored id or previous URL) — another profile's `/forge` hook on the
same project is left alone.

If the token can't manage hooks (403/404), boot continues and prints the manual steps. To add it by
hand: **Settings → Webhooks → Add new webhook**

- **URL:** `<your public URL>/forge`
- **Secret token:** the value printed at boot (or your `forge.webhookSecret`)
- **Trigger:** Merge request events, Pipeline events
- **Enable SSL verification:** on

> **Security:** GitLab authenticates webhooks with a **shared secret token** sent as-is in the
> `X-Gitlab-Token` header. It is not an HMAC signature over the body like GitHub's. agenthook
> always checks it (in constant time, with no opt-out), but it gives no body integrity, and anyone
> who sees one request's headers can replay it. **Use an HTTPS ingress** (ngrok, or a TLS-terminated
> hosted URL), never plain HTTP. A verified webhook can lead to code execution when `fullAuto` is
> on — see [architecture.md](architecture.md#security-posture).

## 4. Opening MRs from the code step

No forge opens pull or merge requests. The coding agent does, as its instruction file tells it. On
GitLab, use [`glab`](https://gitlab.com/gitlab-org/cli) in the `code` step's instruction file
instead of `gh`, from the receiver-made branch:

```markdown
## Open a merge request
- You are on branch `agent/<ref>` in a receiver-owned worktree. Commit, then push it:
  `git push -u origin HEAD`
- `glab mr create --draft --target-branch main --source-branch "$(git branch --show-current)" --title "<summary>" --description "<what & why, how tested>" --yes`
- Do not merge it yourself.
```

The forge only reacts to MRs whose source branch is `agent/<ref>` **in the same project**. MRs and
pipelines from forks are ignored.

## Notes

- **Retries:** GitLab's retry re-runs the failed jobs inside the same pipeline id, and reports no
  attempt number. agenthook records that it retried the pipeline, so the pipeline's next failure
  counts as attempt 2 and triggers the bounce. A pipeline a human retries again after that is not
  bounced a second time.
- **MR pipelines vs branch pipelines:** both work. For an MR pipeline the branch is taken from the
  payload's `merge_request.source_branch`.
- **The MCP `prs` tool** lists open `agent/*` MRs with mergeability (`detailed_merge_status`) and
  the head pipeline's status.
