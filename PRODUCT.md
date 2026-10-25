# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: a solo developer running coding agents across one or more **profiles** (areas of work, e.g.
development, support, content). The `ah ui` dashboard sits open on a second screen; they glance at
it between their own work to see what needs them, then act and look away. They are technical,
comfortable with the CLI, ids, paths and git, and supervise rather than write the code agents produce.

Secondary: the same developer (or a contributor) reading the docs to set up a tracker, ingress,
pipeline or sandbox.

## Product Purpose

agenthook turns a task board into a pipeline of coding agents. A ticket entering a stage fires a
webhook; the receiver runs a headless agent in its own git worktree; the agent's verdict (advance,
rework, hold, fail) moves the ticket on. Human attention is the bottleneck, so the product exists to
boil agent activity down to what a human must act on.

Success: the operator learns in one glance whether anything **needs them**, acts on it in one step,
and otherwise trusts the pipeline to keep moving without babysitting.

## Positioning

Event-driven, not polled: the tracker pushes and the stage starts the instant a ticket lands; nothing
spins while idle. A tool-blind engine with one small adapter per axis (tracker, ingress, agent,
forge) means it works with the board, tunnel, forge and coding agent the user already has. The UI is
a supervision surface that reduces information load, not a project-management tool.

## Operating Context

- Trackers: Asana, Jira, GitHub Issues (labels), GitHub Projects v2, Linear, or an offline `local`
  board. Agents: Claude Code (reference), Cursor, OpenCode, Hermes. Forge: GitHub or GitLab.
- The operator works one profile at a time (ADR 0001). Home shows one card per profile; the
  dashboard is scoped to a single profile. No cross-profile inbox, feed or aggregate totals.
- Dashboard surfaces: Home, Overview (Catch me up digest, Needs you, Now, Progress), Stats, Epics,
  per-run log viewer, ticket drawer, instruction-file editor, config editor, pipeline graph.
- Alongside the UI: the CLI (`agenthook` / `ah`), an MCP server and an event stream.

## Capabilities and Constraints

- **Surfaces in scope for design work:** the local dashboard (`ui/`, React 19 + Vite + Tailwind 4,
  CodeMirror editors) and a docs site rendered from `docs/*.md` (not yet built).
- **Localhost only.** The UI binds 127.0.0.1, token-protected; no remote access layer.
- **No secrets.** `${ENV}` refs are shown as refs, never resolved; `.env` is never read or written.
- **No polling.** Realtime comes from `fs.watch` → Server-Sent Events.
- **Blind reader of runtime state.** The UI writes only user-owned files (config, instruction files)
  via `src/ui/save.js`; write actions go through the receiver's control socket.
- Editing instructions edits what an unsandboxed agent runs under `fullAuto`: the editor is an
  RCE-grade surface and must read as consequential.
- Follows the system light/dark theme; both are first-class.
- `ui/dist` ships inside the npm package.
- **Terminology is binding** (see `CONTEXT.md`): Profile, Ticket, Epic, Finished, Merged, Needs you,
  Ready to close, Digest, Service, SOUL. Avoid the listed synonyms (task, issue, alerts, done, shipped…).

## Brand Commitments

- Name: **agenthook**, lowercase. Tagline in use: "Turn your task board into a team of coding agents."
- Voice: plain, direct, technical; states what happens and why, no hype.
- Profile identity: each profile has a user-chosen colour + emoji so several projects stay
  distinguishable at a glance.
- No logo asset exists.

## Evidence on Hand

- Screenshots of the current UI: `docs/img/ui-*.png`, before/after captures in `docs/ui-screens/`.
- Real run recording: `docs/img/quickstart.gif` / `.mp4`.
- Design decisions: `docs/web-ui.md`, ADRs in `docs/adr/`.
- No testimonials, user counts, benchmarks or case studies exist; do not fabricate them.

## Product Principles

1. **Attention is the scarce resource.** Every surface earns its place by reducing what the operator
   must read; "Needs you" is the headline number.
2. **One glance, one action.** A blocked ticket shows exactly the one thing to do about it.
3. **One profile at a time.** Never merge profiles into a combined view.
4. **Truthful state.** Show what the receiver actually knows (liveness, verdicts, cost); never imply
   work shipped when it only finished.
5. **Consequence is visible.** Actions that move real tickets or change what agents run look and feel
   weightier than reading.

## Accessibility & Inclusion

- **WCAG 2.2 AA** is a hard floor: contrast in both themes, visible focus, semantic structure.
- **Keyboard-first:** every action reachable without a mouse; shortcuts are a product expectation.
