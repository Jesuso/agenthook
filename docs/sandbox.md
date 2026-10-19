# Sandboxing agent runs

A verified webhook leads to an agent running code on your host. With `fullAuto` that agent runs
with its CLI's skip-permissions flag; without it, a headless agent still runs whatever its allow
rules permit. This page covers what confines it: the **per-run sandbox** (each run gets its own
short-lived container), the layers around it, and what none of them stop.

## What a bad ticket can reach

A ticket is untrusted input: anyone who can file or comment on it can try to steer the agent.
Each layer narrows what a hijacked run reaches:

| Layer | Protection | Unsandboxed (host) run | Sandboxed run |
|-------|------------|------------------------|---------------|
| filesystem | per-run container (#472) | everything your user can read: `~/.ssh`, other repos, `~/.agenthook` | only its worktree, the repo's git dir and its verdict dir |
| env | agent env stripped to an allowlist (#470, `agentEnvPassthrough`) | the allowlist (tracker token the prompt names, `GH_TOKEN`, the agent's own keys) | the same allowlist |
| network | egress allowlist (#473, [Network](#network)) | the host's network, unrestricted | model API, forge, tracker, origin, opted-in registries |
| tokens | per-run GitHub App token (#474, [docs/github-app.md](github-app.md#agent-run-tokens)) | a 1h repo-scoped token, but the host `gh` login and `~/.ssh` stay readable | a 1h repo-scoped token only |
| tools / paths | step `allow` / `deny` policy (#475, [configuration.md](configuration.md#step-policy-allow--deny)) | advisory: interpreters and absolute paths bypass it | paths outside the mounts don't exist; in-worktree rules are defence in depth |
| prompt | ticket text fenced as data (#471, [SECURITY.md](../SECURITY.md#prompt-injection)) | a mitigation, not a boundary | a mitigation, not a boundary |

`agenthook doctor` prints the profile's **isolation report**: one `isolation ·` row each for the
sandbox, env, egress, credentials, every step's permission mode and prompt fencing, with ⚠ where a
layer is missing (`fullAuto` without a sandbox, a `sandbox: false` step, a broad allow rule in
`~/.claude/settings.json`, a host git rule that pushes over SSH). The ⚠ rows never fail doctor or
block boot.

## Quick start

The config editor's Basics → Sandbox group sets the same `sandbox` block (backend, image,
memory, cpus, egress) — switching the backend select to Off removes it entirely.

Add a `sandbox` block to the profile config:

```json
{
  "sandbox": { "type": "podman", "memory": "4g", "cpus": 2 }
}
```

| Key | Meaning |
|-----|---------|
| `type` | `docker` or `podman` (required). `DOCKER` / `PODMAN` env override the binary. |
| `image` | Image to run (default `agenthook-agent:<version>`). See [Custom images](#custom-images). |
| `memory` | `--memory` limit, e.g. `4g`. |
| `cpus` | `--cpus` limit, e.g. `2`. |
| `egress` | Network policy, `{ "mode", "allow", "deny" }` — see [Network](#network). Default: allowlist. |

1. **Prefer rootless podman.** Membership in the `docker` group is root-equivalent on the host
   (doctor notes this). With podman, `--userns=keep-id` maps your uid into the container so files
   the agent writes in the worktree stay yours.
2. **Build the image** once, and after each agenthook upgrade (the tag carries the version):
   `agenthook doctor --fix` builds `agenthook-agent:<version>` when it is missing.
3. **Give Claude a token.** The container gets no host `~/.claude`. Run `claude setup-token` and put
   `CLAUDE_CODE_OAUTH_TOKEN=…` in the profile's `.env` (or set `ANTHROPIC_API_KEY`). Without one a
   sandboxed claude run is refused and `agenthook doctor` shows ✗.
4. **Allow the registries your agents install from**, e.g. `"egress": {"allow": ["@npm"]}`.
   Doctor suggests a preset when it sees a lockfile ([presets](#network)).

A step can opt out with `"sandbox": false` — it then runs on the host as before, and the boot
banner and doctor name it. Every other step runs sandboxed. A configured sandbox that is
unavailable **refuses to boot**; a run is never silently moved onto the host.

Env reaches the container **by name** (`-e NAME`), never as a value on the command line. Git push
goes over HTTPS: `git@host:` / `ssh://` remotes are rewritten with `insteadOf`, and credentials
come from `gh auth git-credential` (GitHub, needs `GH_TOKEN`/`GITHUB_TOKEN`) or `GITLAB_TOKEN`
(GitLab). `SSH_AUTH_SOCK` is not passed.

## What a run's container sees

| Inside the container | Source | Notes |
|----------------------|--------|-------|
| the worktree (same path as on the host) | the run's worktree | read-write; read-only for a no-worktree step (the repo itself) |
| nothing at each gitignored path of the repo, for a no-worktree step | `/dev/null` (file) or an empty read-only tmpfs (dir) | your checkout holds `.env`, `agenthook.config.json`, `logs/` and other ignored files a fresh worktree never has; each is masked, as are the profile's config and the `.env` beside it. Untracked files that aren't ignored stay visible. A checkout git can't list, or one with more than 500 ignored paths, fails the run with `sandbox setup failed: …` |
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

`.git/config` being read-only means `git push -u` / `git branch --set-upstream-to` print
`could not write config file … Device or resource busy` and save no upstream (git still exits 0).
The container sets `push.default=current`, so a later bare `git push` still pushes the branch to
`origin` under its own name.

Cancel, timeout and shutdown kill the container (`<runtime> kill`); on boot the receiver removes
any container left from a previous process (labelled `agenthook.profile=<stateKey>`) before it
fails the interrupted runs.

## Network

<a id="egress"></a>

A sandboxed run has **no route out** except an allowlisting HTTPS proxy. Each run gets its own
`--internal` network (no gateway) and a small proxy container (`<run>-proxy`, the built-in image
running `src/sandbox/egress-proxy.mjs`) attached to that network and to the runtime's default
one (`bridge` / `podman`). The agent's container is on the internal network only, with
`HTTPS_PROXY` / `HTTP_PROXY` (and the lower-case forms) pointing at the proxy and `NO_PROXY` set
to loopback. Claude Code, git over HTTPS, `gh`, curl, npm and pip honour them; a tool that
ignores them has no route at all, so it fails closed. Both containers and the network are removed
when the run ends (and reaped on boot).

The proxy only sees `host:port` (a `CONNECT`, or an absolute `http://` URL). It matches the
**requested hostname** against the run's rules; an IP literal is denied unless a rule names it.
The connection then goes to the address the name resolved to, and it is refused when that
address is loopback, link-local (`169.254/16` — cloud metadata — and `fe80::/10`), RFC1918,
CGNAT (`100.64/10`) or ULA (`fc00::/7`), unless the rule ends in `!private`. So an allowlisted
name can't be pointed at your LAN.

**Allowed by default** (`mode: "allowlist"`, the default whenever `sandbox` is set):

| Source | Hosts |
|--------|-------|
| model API (the agent) | `api.anthropic.com`; the host of `ANTHROPIC_BASE_URL` when set; `bedrock-runtime.<AWS_REGION>.amazonaws.com` with `CLAUDE_CODE_USE_BEDROCK`; `<CLOUD_ML_REGION>-aiplatform.googleapis.com` + `oauth2.googleapis.com` with `CLAUDE_CODE_USE_VERTEX` |
| tracker (the prompt tells the agent to read and post comments) | asana `app.asana.com`, jira the `baseUrl` host, linear `api.linear.app`, github / github-projects `api.github.com`; local: none |
| forge | github `github.com`, `api.github.com`, `uploads.github.com`, `*.githubusercontent.com`; gitlab the `baseUrl` host. With no `forge` block, inferred from the origin the same way (a `github.com` origin gets the github hosts, so `gh pr …` still works) |
| origin | the host of the repo's `origin` remote (an SSH origin is pushed over HTTPS, so port 443) |

**Package registries are opt-in.** `agenthook doctor` suggests a preset when it sees a lockfile:

| Preset | Hosts |
|--------|-------|
| `@npm` | `registry.npmjs.org` |
| `@yarn` | `registry.yarnpkg.com`, `repo.yarnpkg.com` |
| `@pypi` | `pypi.org`, `files.pythonhosted.org` |
| `@crates` | `crates.io`, `index.crates.io`, `static.crates.io` |
| `@go` | `proxy.golang.org`, `sum.golang.org` |
| `@rubygems` | `rubygems.org`, `index.rubygems.org` |
| `@maven` | `repo.maven.apache.org`, `repo1.maven.org` |

**Config** — on the profile, and per step (a step's `mode` overrides the profile's; its `allow`
and `deny` add to the profile's):

```jsonc
"sandbox": { "type": "podman",
  "egress": { "mode": "allowlist", "allow": ["@npm", "registry.internal:8443"], "deny": [] } },
"tracker": { "pipeline": [
  { "id": "review", "egress": { "deny": ["api.github.com"] } },   // this step may not comment
  { "id": "triage", "egress": { "mode": "none" } }                 // …or reach anything
] }
```

| Key | Meaning |
|-----|---------|
| `mode` | `allowlist` (default), `none` (`--network none`, no proxy) or `open` (the runtime's default network — unrestricted; doctor warns) |
| `allow` | rules or `@presets`. A rule is `host` (port 443), `*.domain` (any subdomain, not the apex), `host:port`, an IP literal (`10.0.0.5`, `[fd00::1]:8443`), each optionally ending `!private` |
| `deny` | rules or `@presets` removed from the defaults: every rule with that host pattern, or only that port's when the entry names one |

A step `egress` needs a profile `sandbox`, and is an error on a manual step or a
`"sandbox": false` step. The proxy runs the **built-in** image even when `sandbox.image` is
custom, so doctor (and boot) then also require `agenthook-agent:<version>`; `doctor --fix` builds
it. `doctor` lists each sandboxed step's effective allowlist.

**A denied request** gets `403 Forbidden` with `X-Agenthook-Egress: denied` and this body, which
the agent can quote in a `hold` reason:

```
agenthook egress: <host>:<port> is not in this sandbox's allowlist (add it to sandbox.egress.allow)
```

When the run ends, the run log gets one line per denied host:

```
[agenthook] egress denied: example.com:443 (3×) — add it to sandbox.egress.allow (or the step's egress.allow) if this step needs it
```

and `run_end` carries `egressDenied: ["example.com:443", …]` (at most 20). A denial never
changes the run's outcome. To allow the host, add it to `sandbox.egress.allow` (or the step's
`egress.allow`); the next run picks it up.

The proxy logs at most 1000 denials or 256 KiB per run, whichever comes first, so an injected
agent looping denied requests can't grow `denied.jsonl` without bound; past that it just counts
the rest and appends one summary line on exit. `run_end` then also carries
`egressDeniedTruncated: <n>` (the count of denials dropped from the log), omitted when nothing
was truncated.

**Not filtered.** The allowed hosts are exfiltration channels **by design**: the model API sees
the prompt and whatever the agent sends it, the forge accepts a pushed branch (or a gist, with a
broad token), and the tracker accepts a comment. Scoped short-lived tokens (#474) narrow the forge
leg. The proxy does no TLS inspection, per-path rules or size limits (it only sees `host:port`),
and non-HTTP protocols have no route at all. Unsandboxed (host) runs get no egress control.

## Custom images

The default image is `node:22-bookworm-slim` + `git`, `gh` and the `claude` CLI; its recipe is
`AGENT_DOCKERFILE` in `src/sandbox/image.js`. Build it by hand by piping that recipe to
`docker build -t agenthook-agent:<version> -`, or let `agenthook doctor --fix` do it.

A custom `image` (e.g. one built `FROM` the default with your toolchain added) must provide `sh`,
`git`, `gh` and the agent CLI. The receiver runs it with `--pull never`, so it must already be
present locally. The egress proxy always runs the built-in image, so a profile with a custom
`image` still needs `agenthook-agent:<version>`.

The image's `claude` is whatever `npm i -g @anthropic-ai/claude-code@latest` resolved when it was
built, so two builds on different days can differ. `agenthook doctor --fix` passes no build
argument; to pin, build the recipe yourself with `--build-arg CLAUDE_VERSION=<version>`. The pinned
permission mode needs Claude Code 2.1.303 or newer.

## What won't run inside the sandbox

The sandbox confines a run to its worktree, its verdict dir and the egress allowlist. That is the
point, and it also means anything that needs more fails inside it. Check your project's test and
build commands against this list before turning it on:

| Needs | Why it fails | What to do |
|-------|--------------|------------|
| a database or cache on your machine (`localhost:5432`, Redis, MinIO, LocalStack, a `docker compose` stack) | the container's network is `--internal`; it has no route to your host's loopback or private networks, and the proxy refuses loopback and RFC1918 targets even when a rule names them | an in-memory or embedded fake (`sqlite`, `ioredis-mock`), a custom image that bundles and starts the service, or run that step with `"sandbox": false` |
| the Docker socket (Testcontainers, `docker build`, `docker compose` from the agent) | not mounted, on purpose: it would give the run root-equivalent control of the host | the same options; there is no flag to mount it |
| a browser (Cypress, Playwright) | the default image has none | a custom image that installs one, plus a service the browser can reach |
| a toolchain other than node 22, git, gh, curl and claude (Python, Java, Go, Rust) | not in the default image | a custom `image` built `FROM` the default |
| packages from a registry | blocked unless allowed | `"egress": {"allow": ["@npm"]}` (see [Network](#network)) |
| cloud or database credentials in your shell or home (`~/.aws`, `~/.pgpass`, `AWS_PROFILE`, an SSM tunnel on localhost) | none of them reach the container | by design: they are what a hijacked run would use |

There is no sidecar-service feature today: a run cannot be given its own Postgres or Redis. The
escape hatch is per step: `"sandbox": false` runs that step on the host, as before, and the boot
banner and `agenthook doctor` name it. Use it only on a profile where nobody untrusted can file
or comment on tickets, and keep the steps that don't need services (triage, review) sandboxed.

## Permissions inside and outside the sandbox

Agents run headless: stdin is closed, so nobody can answer a permission prompt. **Headless agents
can't prompt: privileged tool calls are denied unless an allow rule (repo `.claude/settings.json`
or a step `allow` policy) permits them.** For `claude`, agenthook pins the mode on every run, so a
`defaultMode` in your `~/.claude/settings.json` never decides it:

| Step | Permission flags |
|------|------------------|
| `fullAuto`, no `allow` (bypass) | `--dangerously-skip-permissions` (+ `--disallowedTools …` for a `deny` policy) |
| `allow` set (any `fullAuto`) | `--setting-sources user,project --permission-mode dontAsk --allowedTools <policy rules> <verdict file> --disallowedTools <deny rules> <settings files>` |
| not `fullAuto`, no `allow` | `--setting-sources user,project --permission-mode dontAsk --allowedTools Edit(//<verdict file>) --disallowedTools <deny rules> <settings files>` |

- `--setting-sources user,project` loads `~/.claude/settings.json` and the repo's
  `.claude/settings.json` (and the repo `CLAUDE.md`), but never `.claude/settings.local.json`.
- `<settings files>` are `Edit(//<cwd>/.claude/settings.json)` and
  `Edit(//<cwd>/.claude/settings.local.json)`: a run can't widen the next run of the same ticket
  through the editor.
- Allow rules in your **user** settings still apply to every pinned step, allow policies
  included. Doctor ⚠ flags a broad one (`Bash`, `Edit(*)`, …).
- The verdict file is always writable, so a run's verdict routes.
- `cursor`, `opencode` and `hermes` keep their CLI's default (doctor reports `agent CLI default`);
  under `fullAuto` they get their own skip-permissions flag.

To restrict what a step may run, give it a [step policy](configuration.md#step-policy-allow--deny).
Inside the sandbox, paths outside the worktree and the verdict dir structurally don't exist, and
`allow.paths` / `deny.paths` add in-worktree granularity as defence in depth (a script the agent
runs can still bypass them). Without the sandbox, every part of the policy is advisory. Commands
are never structurally enforced.

## What it does NOT protect

- **Allowed hosts are exfiltration channels.** The model API, the forge and the tracker stay
  reachable, so each remains a way out for data the agent can read (see [Network](#network)).
- **The env is filtered, not empty**: the container gets the same allowlisted agent env a host run
  gets (see `agentEnvPassthrough`), minus host-only keys (`PATH`, `HOME`, `SSH_AUTH_SOCK`, …). Any
  token that allowlist passes — the tracker token the prompt names, `GH_TOKEN` — is visible to the
  agent.
- **The common git dir is writable**: an agent can touch other branches' refs and other
  worktrees' admin dirs, and can break host git on that repo (a corrupt or FIFO `HEAD` or
  `packed-refs`). Host git calls are time-capped, so a wedged repo fails later runs with a git error
  instead of freezing the receiver; fix the repo by hand. A per-run clone is the follow-up.
- **An allowed interpreter runs anything** inside the container: `node`, `python`, `npm run`, `sh`
  in `allow.commands` make the command allowlist advisory (doctor warns).
- **An allowed Bash interpreter can still write `.claude/settings.json`.** Only editor writes are
  denied. A script can plant an allow rule that widens the next run; only the sandbox and a
  reviewer catch it. Treat a `.claude/` change in an agent PR as a red flag.
- **Steps with `"sandbox": false`** run on the host with your user's full reach.
- **Unsupported agents** are refused, not run unsandboxed: a sandboxed `cursor`, `hermes` or
  `opencode` step fails; set `"sandbox": false` on it to run it on the host.

## Alternative: run the receiver itself in a container

> ⚠ This does **not** isolate tickets from each other or from the receiver's secrets: every agent
> shares the receiver's user, env, state volume (signing secrets, dedup state) and network. A
> prompt-injected agent can read the webhook secrets and forge events. Prefer the per-run sandbox.

`docker/docker-compose.yml` runs the whole receiver — and every agent it spawns — in one container
that mounts only the repo:

| Inside the container | Source | Notes |
|----------------------|--------|-------|
| `/work/repo` | host bind-mount (`REPO_PATH`) | the **only** host path exposed; read-write (agents commit/push) |
| `/work/worktrees` | named volume | per-task git worktrees, off the host tree |
| `/home/node/.agenthook` | named volume | receiver state (dedup, signing secrets, pid, logs) |
| `/home/node/.claude` | named volume (or host mount for OAuth) | Claude transcripts + credentials |
| tracker token, `NGROK_AUTHTOKEN`, Claude creds | `.env` / env | secrets, never baked into the image |

The config the receiver discovers (`/work/repo/agenthook.config.json`) must use container paths,
including `worktreePrefix` (the default sibling dir would land outside the mount):

```json
{ "repoPath": "/work/repo", "worktreePrefix": "/work/worktrees", "fullAuto": true }
```

Pair it with a **stable ingress** (`hosted` behind your reverse proxy, or `ngrok` with a reserved
`domain`): an ephemeral tunnel re-registers a new URL on every restart.

```bash
export REPO_PATH=/abs/path/to/your/repo
cp .env.example docker/.env        # fill in tracker token, NGROK_AUTHTOKEN, ANTHROPIC_API_KEY
docker compose -f docker/docker-compose.yml up --build
```

Claude auth: simplest is `ANTHROPIC_API_KEY` in `.env`. OAuth users instead uncomment the
`~/.claude` bind in the compose file. To build from local source, `npm pack` and set
`AGENTHOOK_SPEC=jesuso-agenthook-<version>.tgz` for the compose build; `.dockerignore` keeps
secrets and local config out of the image.

This confines code execution to the container and keeps the rest of the host out of reach. It
doesn't protect the repo itself, make a leaked signing secret or ingress URL safe, or restrict
network egress.
