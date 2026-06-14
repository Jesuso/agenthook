# Providers

A provider adapter is the only thing that knows about a specific tracker. The engine
(`server.js`, `queue.js`, `dispatch.js`) never changes when you add one.

## Interface

A factory `createXAdapter(cfg, store)` returns an object with:

| Method | Purpose |
|--------|---------|
| `describe()` | `{ platform, taskNoun, trigger, commentHowTo }` — feeds the prompt builder. |
| `authenticate({pathname, headers, rawBody})` | **Fast, no network.** Returns `{type:'handshake', headers}`, `{type:'reject'}`, or `{type:'accept'}`. Lets the receiver ACK quickly. |
| `processEvents({pathname, headers, rawBody})` | **Async, may call the API.** Returns `[job]`. |
| `fetchTask(ref)` | `{ name, description, url, completed, assignedToUs, ref }`. |
| `ensureCommentWebhook(ref)` | Create the per-item comment hook (idempotent). No-op where a repo/project-level hook already covers comments. |
| `registerWebhook(publicUrl)` | Create the top-level hook (CLI `register`). |
| `unregisterWebhooks()` | Delete this provider's hooks (CLI `unregister`). |
| `forgeCatchup(ref)` *(optional)* | `{ path, body, headers, dedupKey }` to replay a missed item. |

A **job** is `{ kind: 'implement' | 'change', ref, text?, dedupKey }`. The engine dedups on
`dedupKey`, then enqueues. `ref` is whatever opaque id your `fetchTask` understands.

## Built-in adapters

### Asana (`src/providers/asana.js`)
- Per-webhook `X-Hook-Secret` handshake; secrets keyed by request path.
- Two hooks: a My-Tasks-list hook (`/mytasks`) for assignment → implement, and a per-task
  story hook (`/task/<gid>`) created after the first run for `@agent` comments → change.
- Signature: HMAC-SHA256 hex in `X-Hook-Signature`.

### GitHub Issues (`src/providers/github.js`)
- One repo-level hook covering `issues` + `issue_comment`; `ensureCommentWebhook` is a no-op.
- Secret is config-supplied (no handshake). Signature: `X-Hub-Signature-256: sha256=<hex>`.
- `issues`/`assigned` (matching `assigneeLogin`) → implement; `issue_comment`/`created`
  starting with the trigger → change. Dedup on `X-GitHub-Delivery`.

## Adding a new one (e.g. Jira, GitLab, Linear)

1. Create `src/providers/<name>.js` exporting `create<Name>Adapter(cfg, store)`.
2. Implement the interface above. Map the platform's "assigned" and "comment" signals to
   `implement`/`change` jobs; map its signature scheme into `authenticate`.
3. Register it in `src/providers/index.js`.
4. Add a `providers.<name>` block to `config.example.json`.

The prompt, queue, dispatch, worktree isolation, and reconciliation all come for free.
