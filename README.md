# agenthook

**Event-driven agentic development.** Move a task into a board section → a coding agent picks it
up *the instant it lands*, works that stage in an isolated git worktree, and (for the coding
stage) opens a draft PR. A clean exit moves the task to the next section — which fires the next
stage. You define the **pipeline** of stages (e.g. triage → code → review).

No polling loop. The tracker already knows the moment a task moves — so it pushes a webhook and
the matching stage starts. Latency is bounded by the network, not by a poll interval, and nothing
spins while you're idle.

> Event-first, poll only to reconcile. See [docs/architecture.md](docs/architecture.md) for the
> honest tradeoffs (push delivery isn't free — agenthook ships a targeted replay for the gaps).

Two swappable axes, engine blind to both: a **tracker** (where work comes from) and an
**ingress** (how the receiver is reachable). Ships with the **Asana** tracker and **ngrok** +
**hosted** ingress; adding another section/stage tracker or tunnel is one adapter file
([docs/providers.md](docs/providers.md)).

```
 move to a section       webhook POST            route to step        headless `claude -p`
 on your board    ─────▶  receiver (verify)  ──▶  dedup + queue   ──▶  branch + draft PR
                                                                        → advance to next section
```

## Install

Requires Node ≥ 20, the [`claude` CLI](https://claude.com/claude-code), `git`, and — for the
ngrok ingress — [`ngrok`](https://ngrok.com). Plus a tracker API token.

```bash
npm i -g agenthook        # or run ad-hoc with `npx agenthook <cmd>`
```

## Quickstart

agenthook is a tool you run *inside the project you want agents to work on* — its config lives
there like a `tsconfig.json`, while runtime state lives centrally in `~/.agenthook/<name>`.

```bash
cd ~/my-project

agenthook init            # interactive: pick tracker + ingress, fetches your
                          # workspace/project/repo so you choose from a list
                          # → writes ./agenthook.config.json

cp .env.example .env      # put your ASANA_TOKEN (or GITHUB_TOKEN + WEBHOOK_SECRET) here
$EDITOR .env              # (init prints exactly which vars it referenced)

agenthook doctor          # preflight: token resolves, repo is git, port free, …
agenthook start           # ingress up → register webhook → serve
```

Move a task into your pipeline's first section (Asana) → a run appears under
`~/.agenthook/<name>/logs/`. Watch it live with `agenthook follow`. Stop with `agenthook stop`.

`init` writes secrets as `${ENV}` **references**, never literal values, so the config is safe to
commit or share — the actual tokens stay in `.env` (gitignored) or your shell.

## Profiles & parallel runs

A **profile** is one config = one process = one isolated state dir. Run as many as you like
side by side; nothing is shared.

```bash
agenthook start --config ~/proj-a/agenthook.config.json   # port 4123
agenthook start --config ~/proj-b/agenthook.config.json   # port 4124 (set in its config)

agenthook ls              # every profile + live status
# NAME    UP  PORT  TRACKER  INGRESS  AGENTS  QUEUE  LAST EVENT
# proj-a  *   4123  asana    ngrok    1       0      2m ago
# proj-b  *   4124  asana    hosted   0       0      1h ago

agenthook status proj-a   # one profile in detail (url, queue, recent runs)
```

Each command auto-discovers `./agenthook.config.json` (walking up from the cwd); `--config`
selects one explicitly.

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
handshake secrets, pid, logs, heartbeat) lives centrally in `~/.agenthook/<name>/`.

| Field | Meaning |
|-------|---------|
| `name` | Profile name; keys the state dir. Must be unique across running profiles. |
| `repoPath` | The repo agents work in (worktrees are siblings). Relative paths resolve against the config. |
| `port` | Local receiver port. Distinct per parallel profile. |
| `trigger` | Comment prefix reserved for agent-authored comments (default `@agent`). |
| `maxConcurrent` | How many agents run at once (each in its own worktree). |
| `fullAuto` | Adds `--dangerously-skip-permissions` to `claude -p`. |
| `tracker` | `{ type, token, …, pipeline: [...] }` — `type` is `asana`; `pipeline` is the ordered steps (required). |
| `ingress` | `{ type, … }` — `ngrok` / `hosted`; type-specific options. |

See [`agenthook.config.example.json`](agenthook.config.example.json) for a fully-commented
template and [`.env.example`](.env.example) for the env vars each tracker/ingress needs.

## Reconcile a missed item

Webhooks are push-only and fire on a *transition* (a task moving into a section), not a state —
so a missed move can't be recovered by polling alone. Replay it explicitly through the running
server:

```bash
agenthook catchup <ref>           # forge + POST the exact signed event for one task
agenthook catchup <ref> --force   # re-run even if already handled
agenthook reconcile               # re-fire every task resting in a pipeline section (the one explicit poll)
```

## Operating running agents

Each run is a plain `claude -p` OS process working in its own git worktree.

```bash
agenthook agents                  # list running agent processes (pid, runtime, ref)
agenthook follow [session-id]     # tail a live agent read-only (no second process)
agenthook cleanup                 # dry run: which worktrees are done and safe to remove
agenthook cleanup --apply         #   remove them (add --force for dirty ones)
```

Agents never remove their own worktrees (INSTRUCTIONS §7); `cleanup` is the one place that
does, and only once the PR is merged/closed or the tracker item is completed.

## Safety

The receiver runs `claude -p --dangerously-skip-permissions` when `fullAuto` is set: a verified
webhook leads straight to code execution on your host. The only gate is the HMAC signature + a
non-guessable URL — it is **not** sandboxed. Agents branch off the default branch, open *draft*
PRs, and ask rather than guess. Run on a trusted host, scope the token, stop the tunnel when
idle, and prefer a container/VM with only the repo mounted for untrusted setups. Full posture
in [docs/architecture.md](docs/architecture.md#security-posture).

## How it works

- **Two blind axes.** The engine names neither tracker nor tunnel; `src/trackers/*` and
  `src/ingress/*` adapters own all platform specifics behind one interface each.
- **Server owns ingress.** `start` brings the tunnel up, registers the webhook (scrubbing
  stale hooks when the URL is ephemeral), serves, then tears down on exit.
- **Fast ACK, async work.** Verify synchronously, ACK in <10s (providers retry otherwise),
  then dispatch off the response path.
- **Dedup.** Providers deliver at-least-once; a per-event `seen` set keeps one event → one run.
- **Worktree isolation.** Parallel agents never collide; each gets its own worktree.

Details: [docs/architecture.md](docs/architecture.md) · [docs/providers.md](docs/providers.md) ·
[docs/agenthook-v2.md](docs/agenthook-v2.md)

## License

MIT
