# Sandboxed run (recommended for `fullAuto`)

`fullAuto` runs agents with `--dangerously-skip-permissions`: a verified webhook leads straight to
**unsandboxed code execution on the host**. The blessed way to enable it safely is to run the whole
receiver — and therefore every `claude -p` agent it spawns — **inside a container that mounts only
the repo**. Then "code execution from a webhook" is confined to the container, not your machine.

This is the recommended posture whenever `fullAuto` is on, and mandatory on any shared host.

## What the container sees

| Inside the container | Source | Notes |
|----------------------|--------|-------|
| `/work/repo` | host bind-mount (`REPO_PATH`) | the **only** host path exposed; read-write (agents commit/push) |
| `/work/worktrees` | named volume | per-task git worktrees, off the host tree |
| `/home/node/.agenthook` | named volume | receiver state (dedup, signing secrets, pid, logs) |
| `/home/node/.claude` | named volume (or host mount for OAuth) | Claude transcripts + credentials |
| tracker token, `NGROK_AUTHTOKEN`, Claude creds | `.env` / env | secrets, never baked into the image |

Everything else on the host is invisible. A prompt-injected or buggy agent can trash the repo
worktree and burn tokens — but it can't read your SSH keys, touch other projects, or persist
outside the named volumes.

## One-time config

The receiver discovers `agenthook.config.json` by walking up from its cwd (`/work/repo`). Because
paths inside the container differ from the host, that config **must** use container paths:

```json
{
  "repoPath": "/work/repo",
  "worktreePrefix": "/work/worktrees",
  "fullAuto": true
}
```

Keep this as a separate `agenthook.config.json` in the repo you mount (or a docker-specific copy you
bind over it). `worktreePrefix` is required — without it worktrees default to a sibling of the repo
(`../agenthook-worktrees`), which would land outside the mount.

Pair it with a **stable ingress**: the `hosted` type behind your own reverse proxy (publish the
receiver port), or `ngrok` with a reserved `domain` and `NGROK_AUTHTOKEN`. An ephemeral tunnel
re-registers a new URL on every restart, which fights container lifecycle.

## Run it

```bash
export REPO_PATH=/abs/path/to/your/repo
cp .env.example docker/.env        # fill in tracker token, NGROK_AUTHTOKEN, ANTHROPIC_API_KEY
docker compose -f docker/docker-compose.yml up --build
```

Claude auth: simplest is `ANTHROPIC_API_KEY` in `.env` (headless, no host mount). OAuth users
instead uncomment the `~/.claude` bind in the compose file and drop the API key.

## Building from a local tarball

To build the image from local source (a release candidate, or a patch you haven't published):

```bash
npm pack                                   # produces jesuso-agenthook-<version>.tgz
AGENTHOOK_SPEC=jesuso-agenthook-0.1.0.tgz \
  docker compose -f docker/docker-compose.yml up --build
```

The `.dockerignore` keeps the build context to source + that tarball; secrets and local config
never enter the image.

## What this does and doesn't buy you

- **Does**: confine `fullAuto` code execution to the container; isolate the repo from the rest of
  the host; keep secrets out of the image; make agent damage limited to the mounted repo + volumes.
- **Doesn't**: protect the repo itself (the agent has full read-write there — that's the job), make
  a leaked signing secret or ingress URL safe (still treat both as credentials — see
  [SECURITY.md](../SECURITY.md)), or sandbox network egress (the container can reach the internet;
  add an egress policy if your threat model needs it).
