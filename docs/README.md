# agenthook docs

Every page under `docs/`, grouped. New here? Start with the [Quickstart](quickstart.md).

## Start

- [Quickstart](quickstart.md) — a first run on a local board: no token, no tunnel
- [Getting Started](getting-started.md) — install → token → pipeline → first run, end to end
- [Troubleshooting](troubleshooting.md) — symptom → fix

## Setup per provider

- Trackers: [Asana](asana-setup.md) · [Jira](jira-setup.md) · [GitHub Issues](github-setup.md) ·
  [GitHub Projects v2](github-projects-setup.md) · [Linear](linear-setup.md)
- Forge: [GitLab](gitlab.md) — MR merges and pipelines (the GitHub forge is in
  [configuration.md](configuration.md#forge-optional--what-happened-to-the-code))
- [GitHub App auth](github-app.md) — an App instead of a personal token for the GitHub trackers and forge
- Ingress (ngrok, cloudflared, Tailscale Funnel, hosted): [configuration.md](configuration.md#ingress-how-the-webhook-reaches-you)
- [Agents](agents.md) — Claude Code, Cursor, OpenCode, Hermes per step
- [Local models](local-models.md) — mixed pipelines with a local model on cheap steps
- [Sandbox](sandbox.md) — the container for running `fullAuto` safely

## Reference

- [Configuration & ingress](configuration.md) — every config key and ingress type
- [Profiles](profiles.md) — one config = one process = one state dir, side by side
- [Operating agents](operating.md) — starting, replaying, following and cleaning up runs
- [Web UI](web-ui.md) — the local dashboard
- [Usage](usage.md) — token and cost tracking
- [Events](events.md) — the append-only `events.jsonl` bus
- [Agent interface (MCP)](mcp.md) · [Agent guide](agent-guide.md) · [Agent skill](../skills/agenthook/SKILL.md) — let an agent read, drive and author work for the pipeline
- [Architecture](architecture.md) — how the engine works, the trade-offs, the security posture
- [Providers](providers.md) — writing a tracker or ingress adapter

## Internals

- [docs/internals/](internals/README.md) — per-area detail for contributors (engine, dispatch,
  adapters, trackers, state, UI, MCP, epics, digest)
- [Architecture decisions](adr/) — ADRs
- [agenthook v2 design](agenthook-v2.md) — the original design for the global tool
