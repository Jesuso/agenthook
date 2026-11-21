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

**The heart: reduce the cognitive load of a developer who now moves much faster.** Agents
multiplied how much work one person can start; they did not multiply how much that person can read,
track and decide. agenthook exists so the developer stays calm: they know things are fine and
moving without reading to check, and they are asked for attention only when a decision is theirs.

Unattended delivery is the means, not the goal. agenthook turns a task board into a pipeline of
coding agents: a ticket entering a stage fires a webhook; the receiver runs a headless agent in its
own git worktree; the agent's verdict (advance, rework, hold, fail) moves the ticket on.

### Levels of depth

Detail is never removed, it is placed. The developer chooses when to pay for it.

1. **Glance** — Home card, Now row, Board card. Essentials only: what it is, where it is, whether
   it needs you. No model, harness, context or cost. Colour, motion and sections that appear only
   when needed carry the meaning, not text.
2. **Drawer** — opened by a click on a ticket. The developer accepts the cost in exchange for
   specifics: steps, reworks, which harness and model ran each one, cost, the reason it is held.
3. **Run story** — the agent's own turns and raw log. For debugging one run.

A fact that helps debugging belongs to level 2 or 3, even when the person building the product
wants it at level 1 today. Debug-grade data may be opt-in per harness (useful for local models).

Success: the operator learns in one glance whether anything **needs them**, acts on it in one step,
and otherwise trusts the pipeline to keep moving without babysitting.

## Positioning

A supervision surface that lowers information load, not a project-management tool. Everything else
is a pillar that holds that up:

- **Event-driven engine.** The tracker pushes and the stage starts the instant a ticket lands;
  nothing polls, nothing spins while idle. The developer does not push work forward.
- **Works with what you have.** A tool-blind engine with one small adapter per axis (tracker,
  ingress, agent, forge): the board, tunnel, forge and coding agent the user already uses. No new
  place to keep in mind.
- **Local and cloud models side by side.** Named harnesses with routing and a health breaker, a
  per-run sandbox, and a remote (SSH) harness on another machine. Which model ran is the
  pipeline's concern until the developer asks.
- **Honest verdicts.** A run ends in a verdict the receiver can trust or else holds: written by the
  agent, deduced from commits, or held for a human. A question is never mistaken for progress.
- **Numbers on request.** Stats, cost, rework rate and per-harness outcomes exist to answer a
  question the developer brings, not to be watched.
- **One profile at a time.** Several areas of work, never merged into one feed.

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
  CodeMirror editors). Documentation is Markdown in `docs/`, read on GitHub; there is no docs
  site and none is planned for this product.
- **Local by default.** The UI binds 127.0.0.1, token-protected. `ah ui --host` can bind a LAN
  address over plain HTTP, where the token is the only credential; there is no remote access layer.
- **No secrets.** `${ENV}` refs are shown as refs, never resolved; `.env` is never read or written.
- **No polling.** Realtime comes from `fs.watch` → Server-Sent Events.
- **Blind reader of runtime state.** The UI writes only user-owned files (config, instruction files)
  via `src/ui/save.js`; write actions go through the receiver's control socket.
- Editing instructions edits what an unsandboxed agent runs under `fullAuto`: the editor is an
  RCE-grade surface and must read as consequential.
- Follows the system light/dark theme; both are first-class.
- `ui/dist` ships inside the npm package.
- **Terminology is binding** (see `CONTEXT.md`): Profile, Ticket, Epic, Done, Merged, Needs you,
  Ready to close, Digest, Service, SOUL. Done = closed on the tracker; a PR awaiting merge is Needs
  you. Avoid the listed synonyms (task, issue, alerts, finished (as a state name), shipped…).

## Brand Commitments

- Name: **agenthook**, lowercase. Tagline in use: "Turn your task board into a team of coding agents."
- Voice: plain, direct, technical; states what happens and why, no hype.
- Profile identity: each profile has a user-chosen colour + emoji so several projects stay
  distinguishable at a glance.
- No logo asset exists.

## Evidence on Hand

- Screenshots of the current UI: `docs/img/ui-*.png`.
- Real run recording: `docs/img/quickstart.gif` / `.mp4`.
- Design decisions: `docs/web-ui.md`, ADRs in `docs/adr/`.
- No testimonials, user counts, benchmarks or case studies exist; do not fabricate them.

## Product Principles

1. **Lower the load.** The test for every surface, field and animation: does a calm developer need
   this by default? If not, it moves down a level or appears only in an abnormal state. Anything
   not strictly necessary adds stress — more to see, read and understand.
2. **Less is more; detail is placed, not deleted.** Glance → drawer → run story. Never add to the
   glance what belongs in the drawer.
3. **Attention surfaces exist only when needed.** "Needs you" has its own clear place and is absent
   when nothing needs the operator. Calm is the default state and it must look calm.
4. **Colour and motion do the heavy lifting.** They say "fine, moving" or "look here" faster than
   text. Use them for that and for nothing decorative.
5. **One glance, one action.** A blocked ticket shows exactly the one thing to do about it.
6. **Truthful state.** Show what the receiver actually knows (liveness, verdicts, cost); never imply
   work shipped when it only finished. A misleading fact costs more than a missing one.
7. **Use the space before covering content.** Do not overlay or mute one thing while empty screen
   sits beside it.
8. **One profile at a time.** Never merge profiles into a combined view.
9. **Consequence is visible.** Actions that move real tickets or change what agents run look and feel
   weightier than reading.

## Accessibility & Inclusion

- **WCAG 2.2 AA** is a hard floor: contrast in both themes, visible focus, semantic structure.
- **Keyboard-first:** every action reachable without a mouse; shortcuts are a product expectation.
