# Sandboxed runs (recommended for `fullAuto`)

`fullAuto` runs agents with `--dangerously-skip-permissions`: a verified webhook leads straight to
code execution. Two ways to confine it:

- **Per-run sandbox** (0.10) — the receiver stays on the host; each agent run gets its own
  short-lived container that mounts only what that run needs. Recommended.
- **[Receiver in a container](#alternative-run-the-receiver-itself-in-a-container)** — the whole
  receiver and every agent share one container. Weaker; kept for hosts without the per-run setup.

## Per-run sandbox (0.10)

Add a `sandbox` block to the profile config:

```json
{
  "sandbox": { "type": "podman", "memory": "4g", "cpus": 2 }
}
```

| Key | Meaning |
|-----|---------|
| `type` | `docker` or `podman` (required). `DOCKER` / `PODMAN` env override the binary. |
| `image` | Image to run (default `agenthook-agent:<version>`). |
| `memory` | `--memory` limit, e.g. `4g`. |
| `cpus` | `--cpus` limit, e.g. `2`. |

A step can opt out with `"sandbox": false` — it then runs on the host as before. Every other
step runs sandboxed. A configured sandbox that is unavailable **refuses to boot**; a run is never
silently moved onto the host.

### Image

Build the default image once (and after each agenthook upgrade — the tag carries the version):

```bash
agenthook doctor --fix        # builds agenthook-agent:<version> when it is missing
```

or by hand, piping the recipe from `src/sandbox/image.js` (`AGENT_DOCKERFILE`) to
`docker build -t agenthook-agent:<version> -`. The image is `node:22-bookworm-slim` + `git`, `gh`
and the `claude` CLI. A custom `image` must provide `sh`, `git`, `gh` and the agent CLI; the
receiver runs it with `--pull never`, so it must already be present locally.

### Credentials

The container gets no host `~/.claude`, so Claude needs a token in the env. Run
`claude setup-token` and put `CLAUDE_CODE_OAUTH_TOKEN=…` in the profile's `.env` (or set
`ANTHROPIC_API_KEY`). Without one a sandboxed claude run is refused and `agenthook doctor` shows ✗.

Env reaches the container **by name** (`-e NAME`), never as a value on the command line. Git push
goes over HTTPS: `git@host:` / `ssh://` remotes are rewritten with `insteadOf`, and credentials
come from `gh auth git-credential` (GitHub, needs `GH_TOKEN`/`GITHUB_TOKEN`) or `GITLAB_TOKEN`
(GitLab). `SSH_AUTH_SOCK` is not passed.

### What a run sees

| Inside the container | Source | Notes |
|----------------------|--------|-------|
| the worktree (same path as on the host) | the run's worktree | read-write; read-only for a no-worktree step (the repo itself) |
| the repo's common git dir | `<repo>/.git` | read-write (commits, refs); read-only for a no-worktree step |
| `<repo>/.git/config`, `<repo>/.git/hooks` | host | **read-only** overlays — an agent can't plant a hook the host runs |
| the run's verdict dir | `<dataDir>/verdicts/run-<ref>-<step>/` | fresh per run, removed after the verdict is read |
| `/home/agent` (HOME) | `<stateDir>/sandbox-home/<run>/` | fresh per run (0700), removed when the run ends |
| `/home/agent/.claude/projects/<mangled>` | host `~/.claude/projects/<mangled worktree>`; for a no-worktree step `<stateDir>/sandbox-transcripts/<mangled repo>` | the transcript, so `follow` / `sessions` still work. A no-worktree step never gets the host dir for your main checkout: that holds your own Claude sessions and auto-memory |

The container runs as your uid (docker `--user`, podman `--userns=keep-id`), with
`--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 1024` and `--init`. The state
dir (signing secrets, tracker tokens on disk), other projects and your SSH keys are not mounted.
Host-side git calls on a sandboxed profile run with `core.hooksPath=/dev/null` and
`core.fsmonitor=false`.

A mount source never comes from a file an agent could have written. The common git dir is always
`<repoPath>/.git`, so `repoPath` must be a plain checkout (not itself a linked worktree). A
worktree's `.git` file and its admin dir's `commondir` are only checked: if an earlier run
rewrote either to point outside `<repoPath>/.git/worktrees/`, or replaced `config`/`hooks` with
a symlink, the run fails with `sandbox setup failed: …` instead of mounting it. The verdict
file is read only when it is a regular file of at most 1 MiB; a symlink, FIFO or larger file
is removed and counts as no verdict.

Cancel, timeout and shutdown kill the container (`<runtime> kill`); on boot the receiver removes
any container left from a previous process (labelled `agenthook.profile=<stateKey>`) before it
fails the interrupted runs.

### Rootless podman

Prefer rootless podman: membership in the `docker` group is root-equivalent on the host (doctor
notes this). With podman, `--userns=keep-id` maps your uid into the container so files the agent
writes in the worktree stay yours.

### Limits

- **The sandbox bounds the filesystem, not the env**: the container gets the same allowlisted
  agent env a host run gets (see `agentEnvPassthrough`), minus host-only keys (`PATH`, `HOME`,
  `SSH_AUTH_SOCK`, …). Any token that allowlist passes — the tracker token the prompt names,
  `GH_TOKEN` — is visible to the agent.
- **Network is open** (#473): the agent can reach anything the host can.
- **The common git dir is writable**: an agent can touch other branches' refs and other
  worktrees' admin dirs. A per-run clone is the follow-up.
- Only `claude` is supported. A sandboxed `cursor`, `hermes` or `opencode` step is refused —
  set `"sandbox": false` on it to run it on the host.

## Alternative: run the receiver itself in a container

> ⚠ Here agents share the receiver's user, env, state volume (signing secrets, dedup state) and
> network. A prompt-injected agent can read the webhook secrets and forge events. Prefer the
> per-run sandbox above.

Run the whole receiver — and therefore every `claude -p` agent it spawns — inside a container that
mounts only the repo. Then "code execution from a webhook" is confined to the container, not your
machine.

### What the container sees

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

### One-time config

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

### Run it

```bash
export REPO_PATH=/abs/path/to/your/repo
cp .env.example docker/.env        # fill in tracker token, NGROK_AUTHTOKEN, ANTHROPIC_API_KEY
docker compose -f docker/docker-compose.yml up --build
```

Claude auth: simplest is `ANTHROPIC_API_KEY` in `.env` (headless, no host mount). OAuth users
instead uncomment the `~/.claude` bind in the compose file and drop the API key.

### Building from a local tarball

To build the image from local source (a release candidate, or a patch you haven't published):

```bash
npm pack                                   # produces jesuso-agenthook-<version>.tgz
AGENTHOOK_SPEC=jesuso-agenthook-0.1.0.tgz \
  docker compose -f docker/docker-compose.yml up --build
```

The `.dockerignore` keeps the build context to source + that tarball; secrets and local config
never enter the image.

### What this does and doesn't buy you

- **Does**: confine `fullAuto` code execution to the container; isolate the repo from the rest of
  the host; keep secrets out of the image; make agent damage limited to the mounted repo + volumes.
- **Doesn't**: protect the repo itself (the agent has full read-write there — that's the job), make
  a leaked signing secret or ingress URL safe (still treat both as credentials — see
  [SECURITY.md](../SECURITY.md)), or sandbox network egress (the container can reach the internet;
  add an egress policy if your threat model needs it).
