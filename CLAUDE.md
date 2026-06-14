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

```bash
node src/server.js                       # run the receiver (reads config.json)
node src/cli.js register <https-url>     # create the provider webhook at a public URL
node src/cli.js unregister               # delete this provider's webhooks
node src/cli.js catchup <ref> [--force]  # replay one missed item through the live server

./scripts/start.sh                       # boot receiver + ngrok + auto-register (local dev)
./scripts/stop.sh                        # kill receiver (by pidfile) + ngrok
./scripts/agents.sh                      # list running `claude -p` agent processes
./scripts/cleanup-worktrees.sh [--apply [--force]]  # tear down done agent worktrees
./scripts/resume.sh "<item name>"        # find + print how to resume an agent session
./scripts/follow.sh [session-id]         # tail a live agent's transcript read-only

npm run typecheck                         # tsc --noEmit over the JSDoc types (no build)
node --check src/**/*.js                   # syntax check (there is no test runner)
```

No build step, no bundler, no test framework — plain Node ESM (`"type": "module"`, Node ≥ 20).
The code ships as JS and runs unbuilt; TypeScript is used **only as a checker** via JSDoc +
`checkJs` (`tsconfig.json`, `noEmit`). Validation is `npm run typecheck` + `node --check` +
manual smoke tests. There is no lint config.

## Architecture

The whole point is the **provider-blind engine + swappable adapters** split. The engine never
names a tracker; everything platform-specific lives behind one adapter interface.

Request flow (`src/server.js`):
`POST` → `adapter.authenticate(ctx)` (sync, no network — must let the engine ACK in <10s) →
either reply to a handshake, `401` a bad signature, or **ACK 200 immediately** and then run
`adapter.processEvents(ctx)` off the response path → `intake()` dedups via the `seen` store →
`queue.enqueue` → `dispatch` spawns `claude -p`.

Key files:
- `src/server.js` — HTTP receiver. Fast-ACK-then-async is deliberate: providers retry if the
  2xx is slow, so no network call may happen before the ACK.
- `src/providers/*.js` + `index.js` — adapters. `asana.js`'s header is the **reference
  doc-comment for the adapter interface**; read it before adding a provider. Register new ones
  in `index.js`'s `REGISTRY`. Interface: `describe`, `authenticate`, `processEvents`,
  `fetchTask`, `ensureCommentWebhook`, `registerWebhook`, `unregisterWebhooks`, `forgeCatchup`.
- `src/dispatch.js` — builds the prompt (standing `INSTRUCTIONS.md` + per-item prompt joined by
  the `=== TICKET ===` marker), spawns `claude -p` with `cwd: repoPath`, streams to a per-run
  log, then calls `ensureCommentWebhook` so future comments re-trigger.
- `src/queue.js` — bounded-concurrency queue (`maxConcurrent`); worktree isolation is what makes
  parallel agents safe.
- `src/store.js` — two JSON files in `dataDir`: `secrets.json` (handshake secrets keyed by
  webhook path, mode 0600) and `seen.json` (dedup set). **`seen` is reloaded from disk on every
  batch** because `catchup` edits it out-of-band; disk is the source of truth.
- `src/prompts.js` — provider-blind prompt builders; platform words come from `adapter.describe()`.
- `src/config.js` — loads/validates `config.json`, expands paths to absolutes, auto-loads `.env`,
  and **resolves all secrets from the environment** (`ASANA_TOKEN`/`GITHUB_TOKEN`/`WEBHOOK_SECRET`,
  or `tokenEnv`/`webhookSecretEnv` overrides; `tokenFile` is a legacy fallback). The resolved
  `token`/`webhookSecret` are attached to `cfg.providerConfig` — adapters never read env/files.

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

- ESM only — `import`, never `require()` (one stray `require` in `asana.js` was a bug). The
  `*.mjs` helpers and inline `node -e` snippets in `scripts/` run as CommonJS and may use
  `require` — that boundary is intentional.
- The ops scripts stay provider-blind by going *through the engine*: `scripts/_config.mjs`
  resolves config paths (incl. the Claude transcript dir, mangled from `repoPath`) and
  `scripts/_done-check.mjs` asks the active adapter whether an item is complete. The receiver
  launches `claude -p` with `cwd: repoPath`, so agent transcripts live under that path's
  mangled name — `resume.sh`/`follow.sh` rely on this.
- Never `pkill -f` a pattern that matches the calling shell; kill by pidfile (`dataDir/server.pid`).
- `config.json`, `.env`, `INSTRUCTIONS.md`, logs, and `.runtime/` are gitignored — verify before
  any commit. `*.example` / `.env.example` files are the committed templates.

## Security posture

The receiver runs `claude -p --dangerously-skip-permissions` when `fullAuto` is set: a verified
webhook leads straight to code execution on the host, gated only by HMAC + a non-guessable URL.
It is **not** sandboxed. See `docs/architecture.md#security-posture` and `README.md`.
