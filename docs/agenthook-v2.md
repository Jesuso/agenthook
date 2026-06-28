# agenthook v2 — the global tool

> Status: **design, not built.** This is the agreed roadmap from a design session on
> 2026-06-14. No code has changed. It supersedes the single-repo model described in
> the root `CLAUDE.md` once implemented.

## The shift

Today agenthook is *a repo you run*: clone it, edit `config.json`, `node src/server.js`.
One config, one `.runtime/`, one port, one ngrok tunnel — every one of those is a hard
pin to a single project. Switching projects clobbers the previous setup; running two at
once is impossible.

v2 makes agenthook *a tool you install*: `npm i -g @agenthook/cli`, scaffold a config per
project the way you scaffold a `tsconfig.json`, and run as many in parallel as you like —
each fully isolated. Same engine thesis (event-first receiver spawning headless
`claude -p`), new packaging and two clean extension axes.

## Decisions

### 1. Distribution — global package, one binary

`npm i -g @agenthook/cli` installs an `agenthook` CLI. The existing bash ops scripts
(`start.sh`, `stop.sh`, `resume.sh`, `follow.sh`, `agents.sh`, `cleanup-worktrees.sh`)
retire into JS subcommands so they ship cross-platform and work from any directory, not
just inside this repo.

```
agenthook init        scaffold agenthook.config.json (wizard)
agenthook start       ingress up → register webhook → serve
agenthook stop
agenthook ls          table of ALL profiles + status
agenthook status <name>   one profile in detail
agenthook follow [id] tail a live agent transcript
agenthook agents      running claude -p processes
agenthook cleanup     prune done worktrees
agenthook register / unregister    manual webhook escape hatch
agenthook catchup <ref>   replay a missed item
agenthook doctor      preflight checks
```

### 2. Config — `agenthook.config.json` in cwd, tsconfig-style

`agenthook init` writes `agenthook.config.json` into the current directory (typically the
target project root, e.g. `~/cahui/agenthook.config.json`). Every command auto-discovers
`./agenthook.config.json`; `--config <path>` overrides for full flexibility. The dev
chooses whether to commit it or `.gitignore` it.

This reduces setup friction to near zero — like `create-react-app`, you answer a few
questions and get a working config.

### 3. Two adapter axes — engine blind to both

The engine already names no tracker; v2 adds a second swappable slot so it also names no
tunnel. Both follow the existing ORM-driver / provider-blind pattern.

```
tracker  (asana | github)                          — WHERE work comes from   [exists]
ingress  (ngrok | cloudflared | hosted | manual)   — HOW the receiver is reachable  [new]
```

Keep the two off the word "provider" in code to avoid collision: `tracker` and `ingress`.

**Ingress interface:**

```js
describe() -> { name, ephemeral }      // ephemeral=true → URL changes per restart (e.g. free ngrok)
up(port)  -> Promise<{ url }>          // managed: spawn + wait for URL; static: return configured URL
down()    -> Promise<void>             // managed: kill; static: no-op
```

A "hosted" / "manual" ingress is just a static implementation: `up` returns the configured
URL, `down` is a no-op. ngrok/cloudflared are managed implementations that spawn a process.

### 4. Server owns the ingress lifecycle

One `agenthook start` is fully self-contained — no external ngrok juggling. Boot sequence:

```
ingress.up(port) -> url
if ingress.ephemeral:
    tracker.unregisterWebhooks()     # scrub hooks pointing at the dead previous URL
tracker.registerWebhook(url)         # idempotent no-op when the URL is stable
serve …
on exit: ingress.down()
```

The `ephemeral` flag is the whole reason the engine knows *whether* to scrub before
re-registering: stable hosted URLs skip the churn (and the brief blind window); ephemeral
tunnels get a clean reconcile every boot.

### 5. Secrets — env-ref interpolation, never literals in shared files

Config values may be literals **or** references: `"token": "${ASANA_TOKEN}"`. `init` writes
refs by default, so the config stays committable/shareable; a power user can inline a literal
for a private throwaway config. This folds the old `.env` *concept* into the config syntax
rather than a separate file — the env itself still comes from the shell, with an auto-loaded
`./.env` in cwd as a convenience (shell-exported vars win).

```jsonc
{
  "name": "cahui",
  "tracker": "asana",
  "token": "${ASANA_TOKEN}",
  "ingress": "ngrok",
  "ngrokAuthtoken": "${NGROK_AUTHTOKEN}"
}
```

This reconciles the two goals that otherwise conflict: *secrets in the config* and *config
is shareable*. They can't both be true for a literal token; they both hold for a reference.

### 6. State — central registry, keyed by profile name

Config placement is flexible (cwd or `--config`), but runtime state is **central**:
`~/.agenthook/<name>/` per profile holds handshake-secrets, the dedup `seen` set, the
pidfile, logs, and a **heartbeat** record. The heartbeat (pid, port, ingress URL, queue
depth, live agent count, last event time) is what lets `agenthook ls` report cross-profile
status without touching any running process. Central state outside any repo also keeps
secrets and dedup history out of version control by construction.

### 7. Observe — text status first

`agenthook ls` prints a table; `agenthook status <name>` drills in; `follow`/`agents`/`logs`
handle live tailing. All read the heartbeat + logs, so a TUI or web dashboard can layer on
the same state later without re-plumbing.

```
$ agenthook ls
NAME    UP  PORT  AGENTS  QUEUE  LAST EVENT
cahui   *   4123  1       0      2m ago
powmon  *   4124  0       0      1h ago
```

### 8. Parallel — N processes, zero shared state

A profile is one process with its own config, port, central state dir, and ingress. There
is no shared queue or shared `maxConcurrent` across profiles — isolation is the safety
property, same as worktrees give to parallel agents within a profile.

## Edges settled by recommendation

- **Profile identity** is the `name` field in the config; the central state dir is keyed by
  it. `agenthook start` refuses if that name's pidfile holds a *live* pid (liveness check,
  not mere file existence). Port collisions surface naturally as `EADDRINUSE`; the silent
  killer was a shared data dir, which name-keyed state + the pid guard both eliminate.
- **Packaging refactor**: `config.js` today conflates one `root` (computed from the
  package's own `__dirname`) for config, data, logs, and `.env`. v2 must split four distinct
  locations — install dir (read-only `node_modules`), config dir (cwd), state dir
  (`~/.agenthook/<name>`), and target repo (`repoPath`). The Claude-transcript path mangle
  stays keyed off `repoPath`, so `follow`/`resume` are unaffected.
- **Init wizard** is adapter-driven with live discovery: each tracker/ingress adapter
  declares its prompts *and* may call its API to offer choices (after token entry: list
  workspaces → projects so you pick "Cahui" instead of pasting a gid; fetch `/users/me` for
  the user gid). The engine orchestrates blindly — same contract discipline as the runtime
  adapters. This adds a wizard hook to the adapter interface.

## Migration plan

A rough build order; each step keeps `npm run typecheck` green.

1. **Decouple `root`** in `config.js` into install / config / state / repo paths; add
   `--config` discovery + cwd auto-find. Existing single-config setups keep working.
2. **Ingress adapter** axis: define the interface + registry, implement `ngrok` (managed,
   ephemeral) and `manual`/`hosted` (static) first. Move tunnel lifecycle into the server
   boot path; the boot reconcile uses the `ephemeral` flag.
3. **Central state** under `~/.agenthook/<name>/` with the heartbeat record; name-keyed,
   pid-liveness start guard.
4. **JS subcommands**: port `start`/`stop`/`register`/`unregister`/`catchup`, then
   `ls`/`status`/`follow`/`agents`/`cleanup`/`doctor`. Retire the bash scripts.
5. **`init` wizard** with adapter-contributed prompts + live discovery; env-ref
   interpolation in config loading.
6. **Package**: `bin` entry, publish metadata, `npm i -g` smoke test.

Cahui becomes the first profile of the new system rather than a one-off `config.json` edit.

## Open / deferred

- TUI and web dashboards (decided: text status is the first cut; both layer on the
  heartbeat later).
- Whether `cloudflared` ships in the first ingress batch or follows ngrok.
- Exact heartbeat write cadence and staleness threshold for `ls` "UP" detection.
- Per-profile vs global concurrency caps (currently: none global, by design — revisit if
  host CPU/cost becomes the binding constraint).
