# Architecture

## The thesis: event-first, not poll-loop

The popular "agentic loop" polls: wake on a timer, ask "anything to do?", sleep, repeat.
Polling burns work when idle and adds latency when busy (you wait up to one interval to notice
a change). agenthook is **event-driven** instead: the tracker already knows the instant a task
is assigned or commented on, so it pushes a webhook and the agent starts immediately. No timer,
no idle spin, latency bounded by network not by poll interval.

```
 assign / comment        webhook POST           normalize          headless claude -p
 on Asana/GitHub  ─────▶  receiver (verify)  ──▶  + dedup + queue ──▶ branch + draft PR
                                                                       + status comment back
```

## But: events are not a free lunch (read this before you tweet "loops are for noobz")

Push delivery buys latency and idle-efficiency at the cost of **delivery guarantees**. Two
honest caveats the loop crowd will (correctly) raise:

1. **At-least-once, sometimes zero.** Providers retry, so the same event can arrive twice —
   hence the dedup set (`seen.json`, keyed per event). And if your receiver is **down** when
   the event fires, most providers eventually give up. The event is gone.

2. **A push is a TRANSITION, not a STATE — and you cannot poll a transition back.** The event
   is "task *entered* My Tasks", which fires once, at assignment time. A task that has sat
   assigned for a month looks identical, by current state, to one assigned 10 seconds ago. So
   no state-scanning poll can recover a missed assignment — there is nothing in the present
   state that says "this one is new".

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

## Components

| File | Role |
|------|------|
| `bin/agenthook.js` | CLI router → `src/commands/*` (init/start/stop/ls/status/follow/agents/cleanup/webhook/catchup/doctor). |
| `src/engine.js`   | HTTP receiver + boot reconcile + heartbeat + shutdown. Verifies (via adapter), ACKs fast, dispatches async. |
| `src/trackers/*`  | One tracker adapter per platform. Owns all platform specifics. |
| `src/ingress/*`   | One ingress adapter per exposure method (`ngrok`, `manual`/`hosted`). |
| `src/store.js`    | JSON persistence: handshake secrets + dedup set. |
| `src/queue.js`    | Bounded-concurrency job queue. |
| `src/dispatch.js` | Spawns `claude -p` per job, streams to a per-run log. |
| `src/prompts.js`  | Blind implement/change prompt builders. |
| `src/config.js` · `src/heartbeat.js` · `src/paths.js` · `src/wizard.js` | Config loader (4 path roots, `${VAR}` refs), profile status, derived paths, `init` prompts. |

## Why a fast ACK then async work

Providers expect a 2xx within a few seconds or they treat the delivery as failed and retry
(amplifying load). So `authenticate()` is synchronous and network-free (just signature math);
the receiver ACKs, *then* `processEvents()` does any API calls and dispatch off the response
path.

## Concurrency & isolation

`maxConcurrent` agents run at once. Each works in its own **git worktree** (siblings of your
repo), so parallel runs never collide on the index or working tree. Agents never remove their
own worktree — a human (or a separate cleanup step) tears it down after the PR merges.

## Security posture

The receiver runs `claude -p --dangerously-skip-permissions`: a verified webhook leads
straight to code execution on your machine. The gate is the signature check (HMAC) plus a
non-guessable public URL. It is **not** sandboxed. Mitigations baked into the flow: agents
branch off the default branch, open *draft* PRs, and ask rather than guess on ambiguous work.
Run it on a trusted host, scope the API token, and stop the tunnel when idle. For untrusted or
shared environments, run the agent in a container/VM with only the repo mounted.
