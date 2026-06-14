# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

agenthook is an **event-driven agentic-development receiver**. A tracker (Asana, GitHub
Issues, …) fires a webhook the instant a task is assigned or an `@agent` comment is posted;
the receiver verifies it, then spawns a headless `claude -p` inside a target repo to do the
work in an isolated git worktree and open a draft PR. There is no polling loop — `catchup`
exists only to replay events missed during downtime.

> Note: this repo is the receiver/framework. The `claude -p` agents it spawns run in a
> *different* repo (`config.repoPath`) and read *that* repo's CLAUDE.md plus `INSTRUCTIONS.md`
> — not this file.

## Commands

Everything is one CLI: `bin/agenthook.js` (the `agenthook` bin). During development run it via
`node bin/agenthook.js <cmd>`. Each command auto-discovers `./agenthook.config.json` (walking up
from cwd); `--config <path>` selects one explicitly.

```bash
node bin/agenthook.js init               # interactive scaffold of agenthook.config.json (cwd)
node bin/agenthook.js start [--detach]   # ingress up → register webhook → serve (server owns ingress)
node bin/agenthook.js stop [--keep-hooks]# SIGTERM the receiver; also deletes its webhooks
node bin/agenthook.js ls                 # table of ALL profiles under ~/.agenthook + live status
node bin/agenthook.js status [name]      # one profile in detail (url, queue, recent runs)
node bin/agenthook.js follow [session]   # tail a live agent transcript read-only
node bin/agenthook.js agents             # list running `claude -p` processes
node bin/agenthook.js cleanup [--apply [--force]]  # tear down done agent worktrees
node bin/agenthook.js register <url>     # manual webhook create (hosted/static URL)
node bin/agenthook.js unregister         # delete this profile's webhooks
node bin/agenthook.js catchup <ref> [--force]  # replay one missed item through the live server
node bin/agenthook.js doctor             # preflight: token resolves, repo is git, port free, …

npm run typecheck                         # tsc --noEmit over the JSDoc types (no build)
node --check bin/agenthook.js src/**/*.js # syntax check (there is no test runner)
```

No build step, no bundler, no test framework — plain Node ESM (`"type": "module"`, Node ≥ 20).
The code ships as JS and runs unbuilt; TypeScript is used **only as a checker** via JSDoc +
`checkJs` (`tsconfig.json`, `noEmit`). Validation is `npm run typecheck` + `node --check` +
manual smoke tests. There is no lint config.

## Architecture

The whole point is the **blind engine + swappable adapters** split, now on **two axes**: the
engine names neither the *tracker* (where work comes from) nor the *ingress* (how it's reachable).
Each lives behind its own one-interface adapter. See `docs/agenthook-v2.md` for the full design.

Request flow (`src/engine.js`):
`POST` → `adapter.authenticate(ctx)` (sync, no network — must let the engine ACK in <10s) →
either reply to a handshake, `401` a bad signature, or **ACK 200 immediately** and then run
`adapter.processEvents(ctx)` off the response path → `intake()` dedups via the `seen` store →
`queue.enqueue` → `dispatch` spawns `claude -p`.

Boot flow (`engine.serve()`, server owns the ingress lifecycle):
`ingress.up(port)` → if `ingress.describe().ephemeral` then `adapter.unregisterWebhooks()` (scrub
dead-URL hooks) → `adapter.registerWebhook(url)` → listen + write pidfile + heartbeat → on exit
`ingress.down()`.

Key files:
- `bin/agenthook.js` — CLI router. Parses argv (global `--config`) and dispatches to `src/commands/*`.
- `src/commands/*.js` — one file per subcommand (init/start/stop/ls/status/follow/agents/cleanup/
  webhook/catchup/doctor). These replace the old bash `scripts/`.
- `src/engine.js` — the receiver. Fast-ACK-then-async is deliberate (providers retry a slow 2xx);
  also owns boot reconcile, heartbeat, and graceful shutdown.
- `src/trackers/*.js` + `index.js` — tracker adapters. `asana.js`'s header is the **reference
  doc-comment for the adapter interface**; read it before adding one. Register in `index.js`'s
  `TRACKERS` (keyed by `cfg.tracker.type`). Interface: `describe`, `authenticate`, `processEvents`,
  `fetchTask`, `ensureCommentWebhook`, `registerWebhook`, `unregisterWebhooks`, `forgeCatchup`,
  optional `wizardSteps` (powers `init` live discovery).
- `src/ingress/*.js` + `index.js` — ingress adapters (`ngrok` managed/ephemeral, `manual`/`hosted`
  static). Registry `INGRESS` keyed by `cfg.ingress.type`. Interface: `describe() → {name,ephemeral}`,
  `up(port) → {url}`, `down()`, optional `wizardSteps`.
- `src/dispatch.js` — builds the prompt (standing `INSTRUCTIONS.md` + per-item prompt joined by
  the `=== TICKET ===` marker), spawns `claude -p` with `cwd: repoPath`, streams to a per-run
  log, then calls `ensureCommentWebhook` so future comments re-trigger.
- `src/queue.js` — bounded-concurrency queue (`maxConcurrent`); worktree isolation makes parallel
  agents safe. Takes an `onChange` callback the engine wires to the heartbeat.
- `src/store.js` — two JSON files in `dataDir`: `secrets.json` (handshake secrets keyed by webhook
  path, 0600) and `seen.json` (dedup set). **`seen` is reloaded from disk on every batch** because
  `catchup` edits it out-of-band; disk is the source of truth.
- `src/heartbeat.js` — per-profile status JSON in the state dir, plus cross-profile readers
  (`listProfiles`/`readProfile`, pid-liveness) backing `ls`/`status`.
- `src/prompts.js` — blind prompt builders; platform words come from `adapter.describe()`.
- `src/wizard.js` — zero-dep prompt runner used by `init`; adapters contribute `WizardStep[]`.
- `src/paths.js` — derived paths (Claude transcript dir mangled from `repoPath`; worktree base).
- `src/config.js` — discovers `agenthook.config.json` (cwd walk-up / `--config`), interpolates
  `${VAR}` refs from the environment (auto-loads `.env` beside the config and in cwd), and resolves
  the **four distinct locations**: install dir, config dir, central state dir (`~/.agenthook/<name>`,
  also `dataDir`/`logDir`/pidfile/heartbeat), and `repoPath`. The active `tracker` block is mirrored
  to `cfg.providerConfig` so adapters are unchanged; `cfg.provider` = `tracker.type`.

The normalized unit passed engine-wide is the **job**: `{ kind: 'implement'|'change', ref,
text?, dedupKey }`. Adapters produce jobs; the engine only ever sees jobs.

## Provider specifics that bite

- **Asana** — every webhook carries its own `X-Hook-Secret` established by a handshake POST, so
  secrets are keyed by request path. Two flows: `/mytasks` (assignment → implement) and
  `/task/<gid>` (per-task comment → change). Dedup on task/story gid.
- **GitHub** — no handshake; the secret is config-supplied and signs every delivery as
  `X-Hub-Signature-256: sha256=…`. ONE repo-level hook covers everything, so
  `ensureCommentWebhook` is a no-op. Dedup on `X-GitHub-Delivery`.

## Typing (JSDoc + checkJs)

Types live in `src/types.js` as JSDoc `@typedef`s with no runtime code — `Adapter` there **is**
the provider contract. Reference any type with `import('./types.js').Foo`. Adapter factories are
tagged `/** @type {import('../types.js').AdapterFactory} */`, so an adapter missing a method or
returning the wrong shape fails `npm run typecheck` — that's the whole point of the setup.

`tsconfig.json` is `strict` but with `useUnknownInCatchVariables: false` (the code reads
`e.message`). External API JSON is genuinely untyped: each adapter has a local
`json(res) => Promise<any>` helper — map fields off that rather than fighting `unknown`. Keep
`npm run typecheck` green when touching `src/`.

## Conventions

- ESM only — `import`, never `require()` (one stray `require` in `asana.js` was a bug). All of
  `bin/` and `src/` is ESM.
- Ops are JS subcommands now (no bash `scripts/`). They stay blind by going *through the engine*:
  `src/paths.js` derives the Claude transcript dir (mangled from `repoPath`) that `follow` reads,
  and `cleanup` asks the active adapter (`fetchTask().completed`) whether an item is done. The
  receiver launches `claude -p` with `cwd: repoPath`, so transcripts live under that path's mangle.
- Never `pkill -f` a pattern that matches the calling shell; `stop` kills by the pidfile at
  `cfg.pidFile` (`~/.agenthook/<name>/server.pid`).
- Runtime state is central (`~/.agenthook/<name>/`), outside any repo. In *this* repo,
  `agenthook.config.json`, `config.json`, `.env`, `INSTRUCTIONS.md`, and `logs/` are gitignored —
  verify before any commit. `agenthook.config.example.json` / `.env.example` / `INSTRUCTIONS.example.md`
  are the committed templates.

## Security posture

The receiver runs `claude -p --dangerously-skip-permissions` when `fullAuto` is set: a verified
webhook leads straight to code execution on the host, gated only by HMAC + a non-guessable URL.
It is **not** sandboxed. See `docs/architecture.md#security-posture` and `README.md`.
