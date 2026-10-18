# Configuration and ingress

## Ingress (how the webhook reaches you)

Set by `ingress.type` in the config; the server owns its lifecycle (brings the tunnel up on
`start`, tears it down on `stop`).

- **`ngrok`** — managed tunnel, URL rotates each boot (so agenthook scrubs + re-registers the
  webhook on every `start`). A reserved `domain` makes it stable. Needs `NGROK_AUTHTOKEN`.
- **`hosted`** (alias `manual`) — you front the receiver (`127.0.0.1:<port>`) with anything
  giving a stable HTTPS URL (Caddy, Cloudflare Tunnel, a load balancer) and set
  `ingress.url`. Stable URL → no re-register churn. Best for parallel/production.

## Configuration

`agenthook.config.json` holds non-secret wiring + `${ENV}` secret refs. State (dedup set,
handshake secrets, pid, logs, heartbeat) lives centrally in `~/.agenthook/<stateId ?? name>/`.

| Field | Meaning |
|-------|---------|
| `name` | Profile name; keys the state dir unless `stateId` is set. Must be unique across running profiles. |
| `stateId` | Optional stable state key (`[A-Za-z0-9._-]+`): the state dir is `~/.agenthook/<stateId>`, so `name` can be relabelled without moving state (`agenthook rename <new>`; `--move` moves the dir too and drops it). Renaming a profile *without* it makes `start` refuse (its config already owns another state dir — see `profile.json` there) rather than silently start on an empty dir. |
| `repoPath` | The repo agents work in (worktrees are siblings). Relative paths resolve against the config. |
| `port` | Local receiver port. Distinct per parallel profile. |
| `trigger` | Comment prefix reserved for agent-authored comments (default `@agent`). |
| `maxConcurrent` | How many agents run at once (each in its own worktree). |
| `overlapGuard` | **Off by default.** `true` holds a task's worktree step while the files its triage predicted overlap files another in-flight agent task has locked; it is released when that task drains, fails, or merges. See [File-overlap guard](architecture.md#file-overlap-guard-overlapguard-opt-in). |
| `ui` | Optional profile identity for `ah ui`: `{ "color": "teal", "emoji": "🚀" }`. `color` is one of `sky`, `indigo`, `violet`, `pink`, `teal`, `cyan`, `slate`, `stone`; `emoji` comes from a curated list (the config editor's Appearance picker). Unset values are derived from the state key, so profiles are distinct without any config. Shown after the receiver restarts. |
| `digest` | Optional settings for the web UI's on-demand "Catch me up" summary: `{ "soul": "./SOUL.md", "access": "snapshot", "model": "…", "maxBudgetUsd": 0.5 }`. `soul` (default `SOUL.md` beside the config) is a markdown file describing what matters to you and how the digest should sound; edit it in the Instructions tab. The digest agent only reads a snapshot the receiver builds (no tools, no board access), runs outside the agent slots, and is never started automatically. |
| `agent` | The coding-agent CLI steps run: `claude` (default), `cursor`, `hermes` or `opencode`. A step's own `agent` overrides it. See [Agents](agents.md). |
| `fullAuto` | **Off by default.** `true` adds `--dangerously-skip-permissions` to `claude -p` (unsandboxed code exec from a webhook — see the warning above). `false` = agents prompt for permission. |
| `tracker` | `{ type, token, …, pipeline: [...] }` — `type` is `asana`, `jira`, `github` (labels), or `github-projects` (Projects v2 board columns); `pipeline` is the ordered steps (required). Per-step keys, including `requireVerdict`, are documented in [getting-started.md](getting-started.md#4-map-your-sections-to-steps--the-part-that-actually-matters). To run some steps on a local model (per-step `bin`/`env`/`model`), see [Mixed pipelines / local models](local-models.md). |
| `ingress` | `{ type, … }` — `ngrok` / `hosted`; type-specific options. |

See [`agenthook.config.example.json`](../agenthook.config.example.json) for a fully-commented
template and [`.env.example`](../.env.example) for the env vars each tracker/ingress needs.

The `ah ui` config editor (below) has a form for every key above, including `repos`. Edit Raw
when you want to share a whole block, keep a `//` comment key, set a key the forms don't know
about yet, or fix invalid JSON — the forms refuse to touch anything they can't parse.

## Forge (optional — what happened to the code)

A tracker says where work comes from; a forge says what happened to the code (a PR merged, CI
went red). It's optional: no `forge` block = no PR awareness, nothing else changes. Today the
only forge is `github`:

```json
"forge": { "type": "github", "repository": "owner/name", "token": "${GITHUB_TOKEN}" }
```

- `repository` is **required** — the forge never falls back to the tracker's repo.
- `completeOnMerge` lives on a **manual pipeline step**, not here (`Step.completeOnMerge`): a
  merged PR moves the task into that step, which then marks it complete. No candidate step →
  a merge still drains the worktree and cleans up, it just doesn't mark the tracker item done.
- `redCi` / `greenCi` / `ciTarget` keep their defaults (react to red CI, emit a `ci_green`
  signal, bounce red CI to the `createsWorktree` step) unless overridden.

`agenthook init` offers to write this block (defaulting to yes when the tracker is `github` or
the repo's `origin` remote is a github.com URL); `agenthook doctor` warns when a `github` tracker
has no forge configured.
