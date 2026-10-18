# Internals

Per-area detail moved out of `CLAUDE.md` so the core stays small. See `../../CLAUDE.md`'s "Where
to read more" index for when to open each file.

- [cli.md](cli.md) — the full CLI command list, `bin/agenthook.js`, `src/commands/*`, `src/sessions.js`.
- [engine.md](engine.md) — request/boot flow detail, `src/engine/*`, `queue.js`, `heartbeat.js`, `profile.js`, `config.js`, `paths.js`, `prompts.js`, `wizard.js`.
- [dispatch.md](dispatch.md) — `src/dispatch/*`, verdict rules, the `changes` cap, CI/merge jobs, agent adapters, the `@agent` resume gate.
- [adapters.md](adapters.md) — tracker/ingress/forge adapter interfaces + registries, pipeline + worktree + queue-stage pull, multi-repo routing.
- [trackers.md](trackers.md) — Asana, Jira, GitHub, GitHub Projects v2 provider specifics.
- [state.md](state.md) — `store.js` state files, `state-move.js`, `archive.js`.
- [ui.md](ui.md) — the `ah ui` server, `identity.js`, `config-schema.js`.
- [agent-api-mcp.md](agent-api-mcp.md) — `agent-api.js`, `src/mcp/*`, `ops.js` (control ops, audit, caching).
- [epics.md](epics.md) — `epics.js`, `epic-changed.js`, the cross-provider epic model.
- [digest.md](digest.md) — `digest.js`, `digest-config.js`, `ticket-summary.js`.
