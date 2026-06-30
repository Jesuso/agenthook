# Architecture

## The thesis: event-first, not poll-loop

The popular "agentic loop" polls: wake on a timer, ask "anything to do?", sleep, repeat.
Polling burns work when idle and adds latency when busy (you wait up to one interval to notice
a change). agenthook is **event-driven** instead: the tracker already knows the instant a task
is assigned or commented on, so it pushes a webhook and the agent starts immediately. No timer,
no idle spin, latency bounded by network not by poll interval.

```
 assign / comment        webhook POST           normalize          headless claude -p
 on Asana board  ─────▶  receiver (verify)  ──▶  + dedup + queue ──▶ branch + draft PR
                                                                       + status comment back
```

## But: events are not a free lunch (read this before you tweet "loops are for noobz")

Push delivery buys latency and idle-efficiency at the cost of **delivery guarantees**. Two
honest caveats the loop crowd will (correctly) raise:

1. **At-least-once, sometimes zero.** Providers retry, so the same event can arrive twice —
   hence the dedup set (`seen.json`, keyed per event). And if your receiver is **down** when
   the event fires, most providers eventually give up. The event is gone.

2. **A push is a TRANSITION, not a STATE — and you cannot poll a transition back.** The event
   is "task *entered* this section", which fires once, at the moment of the move. A task that
   has sat in a section for a month looks identical, by current state, to one moved in 10 seconds
   ago. So no state-scanning poll can perfectly recover a missed move — which is why `reconcile`
   (the one explicit poll) re-fires the step a resting task currently maps to, rather than
   pretending to know what already ran.

### The resolution: event-first, poll only to reconcile

Mature event systems pair push with a **narrow reconciliation path** — not a state-scanning
loop, but a targeted replay. agenthook's `catchup` CLI forges the exact signed event the
provider would have sent and POSTs it to the running receiver, reusing the entire dispatch
path (dedup, prompt, worktree, PR, comment hook — no duplicated logic):

```bash
agenthook catchup <ref>           # replay one item the receiver missed
agenthook catchup <ref> --force   # re-run even if already handled
```

So the accurate tagline isn't "loops bad". It's: **push for the 99% hot path; a targeted
replay for the gaps.** Event-first, poll only to reconcile.

A step's source stage is its **inbox**, and these replay paths are exactly that — *replay*.
`catchup`/`reconcile` re-fire the step a resting item already maps to; they never **move** an item
into a stage, so they can't *start* backlog work. To start a new item you fill the inbox (assign +
move it in, or `agenthook run <ref>`). See the README's *Starting vs replaying work* for the full
trigger/run/reconcile/catchup table.

## Components

| File | Role |
|------|------|
| `bin/agenthook.js` | CLI router → `src/commands/*` (init/start/stop/ls/status/follow/agents/cleanup/webhook/catchup/reconcile/doctor). |
| `src/engine.js`   | HTTP receiver + local crash recovery + heartbeat + shutdown. Verifies (via adapter), ACKs fast, dispatches async. |
| `src/trackers/*`  | One tracker adapter per platform. Owns all platform specifics. |
| `src/ingress/*`   | One ingress adapter per exposure method (`ngrok`, `manual`/`hosted`). |
| `src/store.js`    | JSON persistence: handshake secrets + dedup set + in-flight `running.json` + `changes`-loop counters (`attempts.json`). |
| `src/queue.js`    | Bounded-concurrency job queue. |
| `src/dispatch.js` | Spawns `claude -p` per step (receiver-owned worktree as `cwd`, `AGENTHOOK_VERDICT_FILE` injected), streams to a per-run log, then reads the agent's verdict and resolves the section via `adapter.advance` on exit. |
| `src/pipeline.js` · `src/worktree.js` | `tracker.pipeline[]` (required): section-driven steps + receiver-owned shared worktree (create/`drainWorktree`), keyed by task ref. |
| `src/prompts.js`  | Blind `stepPrompt` builder (shapes itself per step `kind`: triage/implement/change/review). |
| `src/config.js` · `src/heartbeat.js` · `src/paths.js` · `src/wizard.js` | Config loader (4 path roots, `${VAR}` refs, pipeline resolution), profile status, derived paths, `init` prompts. |

## Why a fast ACK then async work

Providers expect a 2xx within a few seconds or they treat the delivery as failed and retry
(amplifying load). So `authenticate()` is synchronous and network-free (just signature math);
the receiver ACKs, *then* `processEvents()` does any API calls and dispatch off the response
path.

## Concurrency & isolation

`maxConcurrent` agents run at once. Each works in its own **git worktree** (siblings of your
repo), so parallel runs never collide on the index or working tree. Agents never remove their
own worktree — a human (or a separate cleanup step) tears it down after the PR merges.

## Step verdicts (where a finished step routes)

A step doesn't just "pass or fail on exit code" — the agent reports a **verdict**. The receiver
injects `AGENTHOOK_VERDICT_FILE`; the agent writes `{ outcome, target?, reason? }` there before
exiting, and `dispatch.js` reads it after the process closes:

| Outcome | Routes to | Used for |
|---------|-----------|----------|
| `advance` | success section (= next step's source) | normal forward motion |
| `hold` | hold section (parked, out of the queue) | blocked on a human answer; they reply + re-file |
| `changes` | the target step's source (re-fires it) | review bounces work back to coding — the rework loop |
| `fail` | failure section | needs a human; can't proceed unattended |

Trust rules: a **non-zero exit is always `fail`** (a crashed agent's verdict isn't trusted); a
**clean exit with no/garbage file defaults to `advance`** (the "clean exit advances" spine). The
`changes` loop keeps the worktree + draft PR (the re-fired step reworks the same branch, reading
the review feedback off the PR) and is **capped**: `maxAttempts` (default 3) runs of a step per
task, after which a further `changes` is forced to `fail` — bounding an endless code↔review
ping-pong, which under `--dangerously-skip-permissions` would be unbounded code execution.

## Security posture

**Default is locked down.** `fullAuto` defaults to `false`, so the receiver runs a
permission-gated `claude -p` — the agent prompts before each privileged action and the boot
logs no warning. This is the posture to ship and to point at any untrusted board.

**`fullAuto: true` is the dangerous opt-in.** It adds `--dangerously-skip-permissions`, and then
a verified webhook leads straight to code execution on your machine, gated only by the signature
check (HMAC) plus a non-guessable public URL. It is **not** sandboxed, and the server prints a
loud warning at every boot while it's on. Mitigations baked into the flow regardless: agents
branch off the default branch, open *draft* PRs, and ask rather than guess on ambiguous work; the
`changes` rework loop is capped by `maxAttempts` so a code↔review ping-pong can't become unbounded
execution. If you enable it, run on a trusted host, scope the API token, stop the tunnel when
idle, and for untrusted or shared environments run it in the [sandboxed container](sandbox.md) with
only the repo mounted (the blessed `fullAuto` path).

Vulnerability disclosure: see [SECURITY.md](../SECURITY.md).
