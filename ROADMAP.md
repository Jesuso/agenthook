# Roadmap

Where agenthook is going, and why in this order. This is a plan, not a promise: dates are targets,
and each milestone's scope may move as real users tell us what hurts. Detailed work lives in GitHub
issues under one epic per milestone.

## Where we are (0.7.0)

agenthook turns a task board into a pipeline of coding agents: a ticket entering a stage fires a
webhook, the receiver spawns an agent in a per-ticket git worktree, and the agent's verdict moves the
ticket on. As of 0.7.0 it ships:

- **Trackers:** Asana, Jira, GitHub Issues (labels), GitHub Projects v2, and an offline `local` board.
- **Agents:** Claude Code (reference), Cursor, OpenCode, Hermes (experimental).
- **Forge and ingress:** GitHub (merged PRs, red CI); ngrok or any static HTTPS endpoint.
- **Operator surface:** CLI, local web UI (overview, stats, logs, epics, instruction and config
  editors), an MCP server and an event stream.
- **Cost:** reported spend, API-equivalent estimates, measured energy, Claude quota readout and
  opt-in quota pacing.

The architecture is sound: a tool-blind engine with one small adapter per axis (tracker, ingress,
agent, forge), event-driven with no implicit polling, and fail-closed assignee scoping on every path.

## What we learned

1. **Surface is ahead of adoption.** The feature set has grown faster than the user base. Every new
   key and adapter adds onboarding and maintenance cost without outside feedback to steer it.
2. **A few core modules carry too much.** `src/dispatch.js` (~1,300 lines) holds prompt building,
   spawning, verdict parsing, merge and CI handling, and the rework cap. `src/engine.js` is ~900 lines.
   `CLAUDE.md` is ~33 KB and is read by every agent run.
3. **First run is hard.** You need a tracker token, a tunnel and a stage mapping before anything
   happens. Jira hooks are manual; user-owned Projects v2 boards have no hook path at all. The
   `local` tracker can't serve as a quickstart yet: it has no event path, so steps only chain under
   an external poller.
4. **Trust boundary is the whole host.** With `fullAuto`, a verified webhook leads to unsandboxed
   code execution. The Docker setup isolates the receiver, not each run.
5. **We measure cost, not outcomes.** There is no merge rate, rework rate or cost per merged ticket,
   so the four agents can't be compared on what matters.
6. **Daily releases make "stable" meaningless.** Config defaults still change between minors.

## Milestones

### 0.8 — Stabilize and land ✅ shipped 2026-10-18 (epic #412)

*Goal: a stranger goes from `npm i -g` to a finished agent run in under five minutes, on a codebase
that is easier to change. Feature freeze outside this list.*

- **Split `dispatch.js`** into focused modules (prompt, spawn, verdict, merge, CI) with no behaviour
  change; slim `engine.js` the same way.
- **Tracker conformance suite**: one shared contract test every tracker adapter must pass, turning
  the reference doc-comment in `asana.js` into executable checks.
- **Event-driven `local` tracker**: stage changes on the local board push jobs in-process, so steps
  chain with no poller and no network.
- **Zero-setup quickstart**: `agenthook init --local` plus a way to add local tickets, a
  `docs/quickstart.md`, and a README that leads with it. No token, no tunnel.
- **End-to-end smoke in CI**: the real engine, the `local` tracker and a stub agent run a full
  multi-step pipeline on every PR.
- **Slim `CLAUDE.md`**: a short core plus per-area internals docs.
- **Release discipline**: weekly cadence, a release checklist, and a config-compatibility policy
  (deprecation warnings before a key changes meaning).
- **Launch**: a short demo recording and an announcement post (drafted; posting moved to 0.9).

### 0.9 — Reach (epic #453)

*Goal: fit the stacks people actually use, with stable URLs and fewer manual steps.*

Launch is split around it: a small post (r/ClaudeAI, the Claude Code Discord) once the first batch
lands, for feedback that can reorder the rest; the Show HN post once 0.9 ships, so a visitor's
stack is more likely covered on their first look.

- **Linear** tracker.
- **cloudflared** and **Tailscale Funnel** ingress (stable URLs; removes the one-tunnel ngrok limit).
- **GitHub App** auth as an alternative to personal tokens: narrower scopes, and a hook path for
  user-owned Projects v2 boards.
- **`@agent` resume** on Jira and Projects v2.
- **GitLab** forge adapter.
- `agenthook doctor --fix` for the common setup mistakes.

### 0.10 — Trust

*Goal: one bad ticket can't reach beyond its own worktree.*

- **Per-run container sandbox**: only the ticket's worktree mounted, per-step network policy,
  short-lived credentials.
- **Per-step policy** for allowed commands and paths, checked by `doctor`.
- **Untrusted-input handling**: treat ticket and comment text as hostile in the prompt builders, and
  document the prompt-injection model in `SECURITY.md`.

### 1.0 — Measure and promise

*Goal: know which setup gives the best work per dollar, and let others build on a stable base.*

- **Quality metrics**: merge rate, rework loops, time to merge and cost per merged ticket, by agent,
  model and step.
- **A/B routing**: send a share of a step's tickets to a second agent and compare them in Stats.
- **Stable contracts**: config schema and adapter interfaces frozen under semver, with migrations.
- **External adapters**: load trackers, agents and ingress from separate npm packages.

## Principles that hold across milestones

- No implicit polling. Forward motion is event-driven.
- Never act on work not assigned to us; fail closed.
- The engine names no tracker, ingress, agent or forge.
- Runs are isolated per ticket; state lives outside the repo.

## How to influence this

Open an issue or comment on a milestone epic. Reports from real setups (which tracker, which
agent, where the first run broke) move items up faster than anything else.
