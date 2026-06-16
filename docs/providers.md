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
| `advance(ref, stepId, outcome)` | Resolve a finished step: move the task to the step's success (`advance`) or failure (`fail`) section. The success move is the next step's trigger. |
| `listResting()` | `[job]` for tasks currently resting in step source sections — drives the explicit `reconcile` command (never called on boot). |
| `registerWebhook(publicUrl)` | Create the project hook (called on `start`, or CLI `register`). |
| `unregisterWebhooks()` | Delete this tracker's hooks (`start` boot-scrub when ingress is ephemeral; CLI `unregister`; `stop`). |
| `forgeCatchup(ref)` *(optional)* | `{ path, body, headers, dedupKey }` to replay a missed item (`catchup`/`reconcile`). |
| `wizardSteps()` *(optional)* | `WizardStep[]` for `agenthook init`; may hit the API so the user PICKS a workspace/project instead of pasting ids. |

A **job** is `{ kind: 'pipeline', ref, stepId, dedupKey }`. The engine dedups on `dedupKey`, then
enqueues. `ref` is whatever opaque id your `fetchTask` understands; `stepId` selects the
`cfg.pipeline` step to run.

## Built-in trackers

### Asana (`src/trackers/asana.js`)
- Per-webhook `X-Hook-Secret` handshake; secrets keyed by request path.
- One project hook (path `/mytasks`) with filters `task/added` + `story/section_changed`. Both
  resolve the task's live `memberships.section.gid` → the step whose `sourceSectionGid` matches.
- Signature: HMAC-SHA256 hex in `X-Hook-Signature`.

### Section-less trackers (GitHub, …)
- Removed for now: the pipeline is section-driven and GitHub Issues has no sections. Slated for P3,
  mapped to labels / project columns (the adapter would translate a label/column change into the
  same section→step routing). Until then, only Asana ships.

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

## Adding a tracker (e.g. Jira, GitLab, Linear)

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
