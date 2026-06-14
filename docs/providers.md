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
| `processEvents({pathname, headers, rawBody})` | **Async, may call the API.** Returns `[job]`. |
| `fetchTask(ref)` | `{ name, description, url, completed, assignedToUs, ref }`. |
| `ensureCommentWebhook(ref)` | Create the per-item comment hook (idempotent). No-op where a repo/project-level hook already covers comments. |
| `registerWebhook(publicUrl)` | Create the top-level hook (called on `start`, or CLI `register`). |
| `unregisterWebhooks()` | Delete this tracker's hooks (`start` boot-scrub when ingress is ephemeral; CLI `unregister`; `stop`). |
| `forgeCatchup(ref)` *(optional)* | `{ path, body, headers, dedupKey }` to replay a missed item. |
| `wizardSteps()` *(optional)* | `WizardStep[]` for `agenthook init`; may hit the API so the user PICKS a workspace/project/repo instead of pasting ids. |

A **job** is `{ kind: 'implement' | 'change', ref, text?, dedupKey }`. The engine dedups on
`dedupKey`, then enqueues. `ref` is whatever opaque id your `fetchTask` understands.

## Built-in trackers

### Asana (`src/trackers/asana.js`)
- Per-webhook `X-Hook-Secret` handshake; secrets keyed by request path.
- Two hooks: a project/My-Tasks hook (`/mytasks`) for assignment → implement, and a per-task
  story hook (`/task/<gid>`) created after the first run for `@agent` comments → change.
- Signature: HMAC-SHA256 hex in `X-Hook-Signature`.

### GitHub Issues (`src/trackers/github.js`)
- One repo-level hook covering `issues` + `issue_comment`; `ensureCommentWebhook` is a no-op.
- Secret is config-supplied (no handshake). Signature: `X-Hub-Signature-256: sha256=<hex>`.
- `issues`/`assigned` (matching `assigneeLogin`) → implement; `issue_comment`/`created`
  starting with the trigger → change. Dedup on `X-GitHub-Delivery`.

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
2. Implement the interface above. Map the platform's "assigned" and "comment" signals to
   `implement`/`change` jobs; map its signature scheme into `authenticate`.
3. Register it in `src/trackers/index.js`'s `TRACKERS`.
4. (Optional) Add `wizardSteps()` for `init`, and document its env vars in `.env.example`.

## Adding an ingress (e.g. cloudflared)

1. Create `src/ingress/<name>.js` exporting `create<Name>Ingress(cfg)`.
2. Implement `describe`/`up`/`down`. Set `ephemeral` honestly — it drives boot reconcile.
3. Register it in `src/ingress/index.js`'s `INGRESS`.

The prompt, queue, dispatch, worktree isolation, reconciliation, heartbeat, and CLI all come
for free.
