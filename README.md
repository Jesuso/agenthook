# agenthook

**Event-driven agentic development.** Assign a task on your tracker → a coding agent picks it
up *the instant it's assigned*, works it in an isolated git worktree, and opens a draft PR.
Comment `@agent <change>` → it resumes that branch and applies the change.

No polling loop. The tracker already knows the moment something changes — so it pushes a
webhook and the agent starts. Latency is bounded by the network, not by a poll interval, and
nothing spins while you're idle.

> Event-first, poll only to reconcile. See [docs/architecture.md](docs/architecture.md) for the
> honest tradeoffs (push delivery isn't free — agenthook ships a targeted replay for the gaps).

Works with any tracker that does webhooks. Ships with **Asana** and **GitHub Issues**; adding
**Jira / GitLab / Linear** is one adapter file ([docs/providers.md](docs/providers.md)).

```
 assign / comment        webhook POST            normalize           headless `claude -p`
 on your tracker  ─────▶  receiver (verify)  ──▶  dedup + queue   ──▶  branch + draft PR
                                                                        + status comment back
```

## Quickstart (local, ngrok)

Requires Node ≥ 20, the [`claude` CLI](https://claude.com/claude-code), `git`, and
[`ngrok`](https://ngrok.com) (or any tunnel). A provider API token.

```bash
git clone <your-fork> agenthook && cd agenthook

cp config.example.json config.json        # non-secret wiring: provider, repoPath, gids/repo
cp INSTRUCTIONS.example.md INSTRUCTIONS.md # tune the standing agent policy to your repo
cp .env.example .env                       # secrets: put ASANA_TOKEN (or GITHUB_TOKEN) here

./scripts/start.sh                         # boots receiver + ngrok, registers the webhook
tail -f logs/server.log
```

Assign yourself a task (Asana) or assign an issue to yourself (GitHub) → a run appears in
`logs/<timestamp>-<kind>-<ref>.log`. Stop with `./scripts/stop.sh`.

## Hosted (stable URL, no tunnel)

For a real deploy, put the receiver behind anything that gives it a stable public HTTPS URL
(Caddy, Cloudflare Tunnel, a load balancer) and register once:

```bash
docker compose -f docker/compose.yml up -d --build
node src/cli.js register https://agenthook.your-domain.com
```

Config, instructions, tokens, and the target repo are **mounted**, never baked into the image.
See [docker/compose.yml](docker/compose.yml).

## Configuration

Non-secret wiring lives in `config.json`; **secrets live in `.env`** (both gitignored). The
receiver auto-loads `.env` at startup, and any shell-exported var overrides it.

`config.json` key fields:

| Field | Meaning |
|-------|---------|
| `provider` | `"asana"` or `"github"`. |
| `repoPath` | The repo agents work in (worktrees are created as siblings). |
| `trigger` | Comment prefix that requests a change (default `@agent`). |
| `maxConcurrent` | How many agents may run at once (each in its own worktree). |
| `fullAuto` | Adds `--dangerously-skip-permissions` to `claude -p`. |
| `providers.<name>` | Per-provider non-secret ids (gids / repo / assignee — see `config.example.json`). |

`.env` keys (see `.env.example`): `ASANA_TOKEN`, or `GITHUB_TOKEN` + `WEBHOOK_SECRET`.

## Reconcile a missed item

Webhooks are push-only and fire on a *transition* (assignment), not a state — so a missed
assignment can't be recovered by polling. Replay it explicitly:

```bash
node src/cli.js catchup <ref>           # forge + POST the exact signed event
node src/cli.js catchup <ref> --force   # re-run even if already handled
```

## Operating running agents

Each run is a plain `claude -p` OS process working in its own git worktree. Manage them with:

```bash
./scripts/agents.sh                       # list running agent processes (pid, runtime, ref)
./scripts/follow.sh [session-id]          # tail a live agent read-only (no second process)
./scripts/resume.sh "<item name>"         # find an agent's session/branch/PR + how to resume
./scripts/cleanup-worktrees.sh            # dry run: which worktrees are done (PR merged/closed
./scripts/cleanup-worktrees.sh --apply    #          or item completed) and safe to remove
```

Agents never remove their own worktrees (INSTRUCTIONS §7); `cleanup-worktrees.sh` is the one
place that does, and only once the PR is merged/closed or the tracker item is completed.

## Safety

The receiver runs `claude -p --dangerously-skip-permissions`: a verified webhook leads
straight to code execution on your host. The only gate is the HMAC signature + a
non-guessable URL — it is **not** sandboxed. Agents branch off the default branch, open
*draft* PRs, and ask rather than guess. Run on a trusted host, scope the token, stop the
tunnel when idle, and prefer a container/VM with only the repo mounted for untrusted setups.
Full posture in [docs/architecture.md](docs/architecture.md#security-posture).

## How it works

- **One engine, many adapters.** `src/server.js` is provider-blind; each `src/providers/*`
  adapter owns its tracker's signatures, payloads, and webhook lifecycle.
- **Fast ACK, async work.** Verify synchronously, ACK in <10s (providers retry otherwise),
  then dispatch off the response path.
- **Dedup.** Providers deliver at-least-once; a per-event `seen` set keeps one event → one run.
- **Worktree isolation.** Parallel agents never collide; each gets its own worktree.

Details: [docs/architecture.md](docs/architecture.md) · [docs/providers.md](docs/providers.md)

## License

MIT
