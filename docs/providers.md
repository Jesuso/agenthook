# Adapters (trackers & ingress)

agenthook has **two** blind axes. A **tracker** adapter is the only thing that knows about a
specific issue tracker; an **ingress** adapter is the only thing that knows how the receiver is
exposed to the internet. The engine (`engine.js`, `queue.js`, `dispatch.js`) never changes when
you add either.

## Tracker interface

A factory `createXAdapter(cfg, store)` (in `src/trackers/`) returns an object with:

| Method | Purpose |
|--------|---------|
| `describe()` | `{ platform, taskNoun, trigger, commentHowTo }` — feeds the prompt builder. |
| `authenticate({pathname, headers, rawBody})` | **Fast, no network.** Returns `{type:'handshake', headers}`, `{type:'reject'}`, or `{type:'accept'}`. Lets the receiver ACK quickly. |
| `processEvents({pathname, headers, rawBody})` | **Async, may call the API.** Returns `[job]` — maps a board event to the step the task now rests in. |
| `fetchTask(ref)` | `{ name, description, url, completed, assignedToUs, ref }`. |
| `advance(ref, stepId, verdict)` | Resolve a finished step by moving the task to the section its `verdict.outcome` maps to: `advance`→success (the next step's trigger), `fail`→failure, `hold`→hold (parked for a human), `changes`→the target step's source (re-fires it — the rework loop). |
| `listResting()` | `[job]` for tasks currently resting in step source sections — drives the explicit `reconcile` command (never called on boot). |
| `registerWebhook(publicUrl)` | Create the project hook (called on `start`, or CLI `register`). |
| `unregisterWebhooks()` | Delete this tracker's hooks (`start` boot-scrub when ingress is ephemeral; CLI `unregister`; `stop`). |
| `forgeCatchup(ref)` *(optional)* | `{ path, body, headers, dedupKey }` to replay a missed item (`catchup`/`reconcile`). |
| `wizardSteps()` *(optional)* | `WizardStep[]` for `agenthook init`; may hit the API so the user PICKS a workspace/project instead of pasting ids. |

A **job** is `{ kind: 'pipeline', ref, stepId, dedupKey }`. The engine dedups on `dedupKey`, then
enqueues. `ref` is whatever opaque id your `fetchTask` understands; `stepId` selects the
`cfg.pipeline` step to run.

### Verdict contract (how a step decides where to go)

The receiver injects `AGENTHOOK_VERDICT_FILE` (a path) into every agent. Before exiting the agent
writes JSON there: `{ "outcome": "advance|hold|changes|fail", "target": "<stepId>", "reason": "…" }`.
After the process exits, `dispatch.js` resolves a `Verdict` and hands it to `advance`:

- **non-zero exit** → `fail` (a crashed agent's file is not trusted).
- **clean exit + valid file** → that outcome.
- **clean exit + missing/garbage file** → `advance` (the "clean exit advances" default).

`changes` bounces work back to `verdict.target` (a `stepId`), defaulting to the **previous** step;
the worktree + PR are kept so the re-fired step reworks the same branch. A per-`(ref,step)` attempt
counter caps the loop — once a step has run `maxAttempts` times (default 3) for one ref, a further
`changes` into it is forced to `fail`. `hold` parks the task (a human answers and re-files it).
The engine owns this resolution; an adapter only maps the final outcome → a board move.

## Built-in trackers

### Asana (`src/trackers/asana.js`)
- Per-webhook `X-Hook-Secret` handshake; secrets keyed by request path.
- One project hook (path `/mytasks`) with filters `task/added` + `story/section_changed`. Both
  resolve the task's live `memberships.section.gid` → the step whose `sourceSectionGid` matches.
- Signature: HMAC-SHA256 hex in `X-Hook-Signature`.

### Jira Cloud (`src/trackers/jira.js`)
- **Auth — `email` + API token, Basic (NOT bearer).** Jira Cloud classic API tokens (`ATATT…`)
  authenticate only as the *password* in HTTP Basic, with the account **email as the username**:
  `Authorization: Basic base64("<email>:<token>")`. Unlike GitHub/GitLab PATs, the token alone is
  not a bearer credential — `Authorization: Bearer <token>` returns 403 at `<site>.atlassian.net`
  and 401 at the `api.atlassian.com` gateway. That's why `tracker.email` is required and can't be
  derived from the token (querying identity needs auth, which needs the email). It isn't secret, so
  inline it in the config. The only bearer path is an OAuth 2.0 (3LO) *access* token — a different
  credential, not your API token.
  Source: <https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/#supply-basic-auth-headers>
- The "section" is the issue's workflow **status**: a step binds `sourceStatus`/`successStatus`/
  `failureStatus`/`holdStatus` (status names, matched case-insensitively). An issue entering a
  step's `sourceStatus` fires it.
- No handshake. The webhook signing secret is **generated and stored by agenthook** (or an
  explicit `tracker.webhookSecret`), printed on `start` to paste into the Jira webhook; the body
  is verified via `x-hub-signature: sha256=<hex>`. `webhookSecret: false` accepts unsigned. So the
  API token is the only Jira secret a user supplies.
- `advance` has no "set status" — it fetches the issue's available transitions and executes the
  one whose `to` status matches the target (a target not reachable in the workflow is a logged
  no-op). Auth is Basic `email:apiToken` (REST v2 → `description` is a plain string); the assignee
  accountId for scoping is derived from `/myself` and cached, so it isn't configured by hand.
- **Webhooks are created BY HAND** in Jira admin (Settings → System → WebHooks) — Jira Cloud
  restricts the webhook REST API to Connect/Forge apps, so `registerWebhook` just prints setup
  instructions and `unregisterWebhooks` is a no-op. The URL can't rotate, so pair Jira with a
  **stable ingress** (ngrok reserved `domain`, or `hosted`) — never an ephemeral tunnel.

### GitHub Issues (`src/trackers/github.js`)
- **Auth — a Personal Access Token as `Bearer <token>`** (`GITHUB_TOKEN`). Classic tokens need
  `repo` + `admin:repo_hook`; fine-grained tokens need **Issues: Read & write** + **Webhooks: Read
  & write** + **Metadata: Read** on the target repo.
- GitHub Issues has **no board sections, so the "section" is a label**: a step binds
  `sourceLabel`/`successLabel`/`failureLabel`/`holdLabel`, and an issue carrying a step's
  `sourceLabel` is "in" that step (matched case-insensitively). Set `tracker.repository` to
  `"owner/name"` (or `owner` + `repo`).
- `advance` **swaps the label** — it adds the target label, *then* removes the finished step's
  `sourceLabel`. The order is deliberate: a crash between the two leaves the issue carrying both
  labels (so it re-fires and is recoverable) rather than neither (stuck, invisible).
- One repo webhook on the `issues` event, **auto-created via REST** (`POST /repos/{owner}/{repo}/hooks`)
  — unlike Jira, a token can create it. The signing secret is **generated and stored by agenthook**
  (or an explicit `tracker.webhookSecret`); the body is verified via `x-hub-signature-256: sha256=<hex>`.
  `webhookSecret: false` accepts unsigned. So `GITHUB_TOKEN` is the only GitHub secret a user supplies.
- Routing: `opened`/`reopened`/`assigned` route by the issue's current labels (dedup `step:<id>:<n>`);
  `labeled` routes by the label just added (dedup `secmove:<delivery>`, so a later re-add fires again
  while webhook retries dedup). The assignee "us" is the token owner's login from `/user` (cached);
  scoping is fail-closed. The webhook URL is auto-managed, so GitHub works behind an **ephemeral**
  ingress (ngrok) — the hook is scrubbed + recreated each boot.

## Ingress interface

A factory `createXIngress(cfg)` (in `src/ingress/`) returns:

| Method | Purpose |
|--------|---------|
| `describe()` | `{ name, ephemeral }`. `ephemeral` = the public URL changes per restart → engine scrubs + re-registers the webhook on boot. |
| `up(port)` | Bring the receiver online publicly; returns `{ url }`. Managed adapters spawn a tunnel; static ones return the configured URL. |
| `down()` | Tear down (kill the tunnel; no-op for static). |
| `wizardSteps()` *(optional)* | `WizardStep[]` for `agenthook init`. |

Built-in: **`ngrok`** (managed, ephemeral unless a reserved `domain` is set) and
**`manual`/`hosted`** (static — `up()` returns `ingress.url`, `down()` is a no-op).

## Adding a tracker (e.g. GitLab, Linear)

1. Create `src/trackers/<name>.js` exporting `create<Name>Adapter(cfg, store)`.
2. Implement the interface above. Map the platform's "item moved to a stage" signal (section,
   status, label, column) to a `pipeline` job for the matching step; map its signature scheme into
   `authenticate`; implement `advance`/`listResting` against that same stage concept.
3. Register it in `src/trackers/index.js`'s `TRACKERS`.
4. (Optional) Add `wizardSteps()` for `init`, and document its env vars in `.env.example`.

## Adding an ingress (e.g. cloudflared)

1. Create `src/ingress/<name>.js` exporting `create<Name>Ingress(cfg)`.
2. Implement `describe`/`up`/`down`. Set `ephemeral` honestly — it drives boot reconcile.
3. Register it in `src/ingress/index.js`'s `INGRESS`.

The prompt, queue, dispatch, worktree isolation, reconciliation, heartbeat, and CLI all come
for free.
