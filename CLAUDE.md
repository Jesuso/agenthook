# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

agenthook is an **event-driven agentic-development receiver**. Work flows through a **pipeline**
of steps bound to a tracker's stages (Asana sections, Jira statuses, or GitHub labels). A task
entering a step's source stage fires a webhook; the receiver verifies it and spawns a headless
`claude -p` in a receiver-owned git worktree to do that step's work; on a clean exit it moves the
task to the next section, firing the next step. No polling loop — forward motion is event-driven,
crash recovery is local, and `catchup`/`reconcile` exist only to replay items missed during downtime.
The one narrow exception is an opt-in **queue stage**: a step that sets one pulls its
backlog when a slot frees — on `run_end` and once on boot, never on a timer.

> Note: this repo is the receiver/framework. The `claude -p` agents it spawns run in a
> *different* repo (`config.repoPath`) and read *that* repo's CLAUDE.md plus the step's
> instruction file — not this file.

## Commands

Everything is one CLI: `bin/agenthook.js` (the `agenthook` bin). During development run it via
`node bin/agenthook.js <cmd>`; each command auto-discovers `./agenthook.config.json` (walking up
from cwd), or `--config <path>` selects one explicitly. Full annotated command list:
[docs/internals/cli.md](docs/internals/cli.md).

```bash
npm run typecheck     # tsc --noEmit over the JSDoc types (no build)
npm test               # node --test test/*.test.js (units + conformance + e2e)
node --check bin/agenthook.js src/**/*.js  # syntax check
```

No build step, no bundler — plain Node ESM (`"type": "module"`, Node ≥ 22). TypeScript is used
**only as a checker** via JSDoc + `checkJs`. CI (`.github/workflows/ci.yml`) runs typecheck + tests
+ `node --check` on Node 22 & 24. There is no lint config.

## Architecture

The whole point is the **blind engine + swappable adapters** split, on **two axes** plus two
optional ones: the engine names neither the *tracker* (where work comes from, e.g. Asana/Jira/
GitHub) nor the *ingress* (how it's reachable), nor the optional *forge* (what happened to the
code — e.g. a PR merged) or *agent* (which coding-agent CLI a step spawns — `claude`/`cursor`/
`hermes`/`opencode`). Each lives behind its own one-interface adapter. Full interfaces, registries
and provider quirks: [docs/internals/adapters.md](docs/internals/adapters.md) and
[docs/internals/trackers.md](docs/internals/trackers.md). Full design: `docs/agenthook-v2.md`.

Request flow (`src/engine/http.js` → `src/engine/index.js` `intake`): `POST` →
`adapter.authenticate(ctx)` (sync, no network — must ACK in <10s) → handshake reply, `401` a bad
signature, or **ACK 200 immediately** then `adapter.processEvents(ctx)` off the response path →
`intake()` dedups via the `seen` store → `queue.enqueue` → `dispatch` spawns `claude -p` for the
step → on exit `dispatch` reads the agent's verdict file and `adapter.advance` moves the task to
the section that verdict maps to (advance → next step's trigger; fail → failure; hold → hold lane;
changes → the target step's source, the rework loop).

Boot flow (`engine.serve()` = `src/engine/boot.js`): `ingress.up(port)` → write `publicUrl` →
listen → `startControl` → write pidfile → scrub/register webhooks (tracker, then best-effort
forge) → `recoverInterrupted()` (local `running.json` only, no board poll) → `restoreQueued()` →
`puller.pull()` (queue-stage pull into free slots) → signal handlers. Full detail, including why
each step is ordered that way: [docs/internals/engine.md](docs/internals/engine.md).

The normalized unit passed engine-wide is the **job**: `{ kind: 'pipeline'|'merge', ref, stepId,
dedupKey, comment? }`. Adapters produce jobs; the engine only ever sees jobs. `src/engine.js` and
`src/dispatch.js` are one-line re-export shims — the public path every importer uses — over
`src/engine/` and `src/dispatch/`, which are split by concern; see
[docs/internals/engine.md](docs/internals/engine.md) and
[docs/internals/dispatch.md](docs/internals/dispatch.md) for the module breakdown.

## Rules agents must not miss

- **No implicit polling.** Forward motion is event-driven. The one exception is a step's opt-in
  queue stage, read only on `run_end` and once on boot — never on a timer. `listResting` is never
  called on boot.
- **Fail-closed assignee/author scoping.** The receiver must never act on a task not assigned to
  `userGid`/our identity. The `@agent` resume gate checks the comment author **strictly** equals
  our tracker identity — never reuse `isOurs` for that check.
- ESM only — `import`, never `require()`.
- Keep `npm run typecheck` green when touching `src/`.
- `seen.json` is reloaded from disk on every batch (`catchup` edits it out-of-band; disk is the
  source of truth).
- The only UI file writes go through `src/ui/save.js` (`atomicSave`) — never write a state dir
  from elsewhere in `src/ui/*`.
- A new config key needs a `src/config-schema.js` entry (a test enforces this).
- Update `docs/agent-guide.md` when an MCP tool, event, or error message changes.
- Never `pkill -f` a pattern that matches the calling shell; `stop` kills by the pidfile.
- Runtime state is central (`~/.agenthook/<name>/`), outside any repo. In *this* repo,
  `agenthook.config.json`, `config.json`, `.env`, `INSTRUCTIONS.md`, and `logs/` are gitignored —
  verify before any commit.

## Typing (JSDoc + checkJs)

Types live in `src/types.js` as JSDoc `@typedef`s with no runtime code — `Adapter` there **is**
the provider contract. Reference any type with `import('./types.js').Foo`. Adapter factories are
tagged `/** @type {import('../types.js').AdapterFactory} */`, so an adapter missing a method or
returning the wrong shape fails `npm run typecheck` — that's the whole point of the setup.

`tsconfig.json` is `strict` but with `useUnknownInCatchVariables: false` (the code reads
`e.message`). External API JSON is genuinely untyped: each adapter has a local
`json(res) => Promise<any>` helper — map fields off that rather than fighting `unknown`.

## Conventions

- Ops are JS subcommands (no bash `scripts/`). They stay blind by going *through the engine*:
  `src/paths.js` derives the transcript dir (mangled from `repoPath`) `follow` reads, and `cleanup`
  asks the active adapter (`fetchTask().completed`) whether an item is done.
- `agenthook.config.example.json` / `.env.example` / `INSTRUCTIONS.example.md` are the committed
  templates for the gitignored files above.

## Security posture

The receiver runs `claude -p --dangerously-skip-permissions` when `fullAuto` is set: a verified
webhook leads straight to code execution on the host, gated only by HMAC + a non-guessable URL.
It is **not** sandboxed. See `docs/architecture.md#security-posture` and `README.md`.

## Where to read more

Per-area detail lives in `docs/internals/` — read the relevant file when a ticket touches that
area; don't read all of them for every ticket.

- [docs/internals/cli.md](docs/internals/cli.md) — full CLI command list, `bin/agenthook.js`, `src/commands/*`, `src/sessions.js`.
- [docs/internals/engine.md](docs/internals/engine.md) — request/boot flow detail, `src/engine/*`, `queue.js`, `heartbeat.js`, `profile.js`, `config.js`, `paths.js`, `prompts.js`, `wizard.js`.
- [docs/internals/dispatch.md](docs/internals/dispatch.md) — `src/dispatch/*`, verdict rules, the `changes` cap, CI/merge jobs, agent adapters, the `@agent` resume gate.
- [docs/internals/adapters.md](docs/internals/adapters.md) — tracker/ingress/forge adapter interfaces + registries, pipeline + worktree + queue-stage pull, multi-repo routing.
- [docs/internals/trackers.md](docs/internals/trackers.md) — Asana, Jira, GitHub, GitHub Projects v2 provider specifics.
- [docs/internals/state.md](docs/internals/state.md) — `store.js` state files, `state-move.js`, `archive.js`.
- [docs/internals/ui.md](docs/internals/ui.md) — the `ah ui` server, `identity.js`, `config-schema.js`.
- [docs/internals/agent-api-mcp.md](docs/internals/agent-api-mcp.md) — `agent-api.js`, `src/mcp/*`, `ops.js` (control ops, audit, caching).
- [docs/internals/epics.md](docs/internals/epics.md) — `epics.js`, `epic-changed.js`, the cross-provider epic model.
- [docs/internals/digest.md](docs/internals/digest.md) — `digest.js`, `digest-config.js`, `ticket-summary.js`.
