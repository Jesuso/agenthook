# Getting started

This walks you from `npm i` to your first agent run, end to end. It does **not** skip the fiddly
parts (finding section gids, wiring the pipeline, the webhook) — those are exactly where setups
stall, so they're spelled out.

Budget ~15 minutes. You need: Node ≥ 20, the [`claude` CLI](https://claude.com/claude-code)
(logged in), `git`, a tracker account (Asana or Jira) with an API token, and — for the `ngrok`
ingress — an [ngrok](https://ngrok.com) account.

> ⚠️ Before a real run, read the [security posture](architecture.md#security-posture). With
> `fullAuto` on, a verified webhook executes code on your host. It ships **off** (agents prompt for
> permission); enable it only on a trusted host or in the [sandbox](sandbox.md).

## The mental model in one paragraph

You define a **pipeline** of **steps**. Each step is bound to a **section** of your tracker board
(an Asana section, or a Jira status). When a task **enters** a step's source section, the tracker
fires a webhook; agenthook spawns a headless `claude -p` for that step in an isolated git worktree.
When the agent exits it writes a **verdict** (`advance` / `hold` / `changes` / `fail`), and
agenthook moves the task to the matching section — and moving it into the *next* step's source
section is what fires the next step. No polling: motion is event-driven.

So setup is really three things: **(1)** point agenthook at your tracker, **(2)** map your board's
sections to steps, **(3)** tell each step's agent what to do.

## 1. Install

```bash
npm i -g @jesuso/agenthook      # installs the `agenthook` command (and an optional `ah` shortcut)
```

agenthook runs *inside the repo you want agents to work on*. Its config lives there like a
`tsconfig.json`; runtime state lives centrally in `~/.agenthook/<profile>/`.

```bash
cd ~/my-project
```

## 2. Get a tracker token

Follow the one for your tracker, grab the token, then come back:

- **[Asana setup](asana-setup.md)** — personal access token + project; sections drive the pipeline.
- **[Jira setup](jira-setup.md)** — API token + project; statuses drive the pipeline.

Put the token in a `.env` beside the config (it's gitignored):

```bash
# .env
ASANA_TOKEN=2/1199...          # or: JIRA_API_TOKEN=ATATT...
NGROK_AUTHTOKEN=2x...          # only if you use the ngrok ingress
```

## 3. Scaffold the config

```bash
agenthook init
```

The wizard asks for the profile name, repo path, port, and `fullAuto` (default **no** — keep it),
then uses your token to let you **pick** your workspace/project from a live list (no gid pasting
for those). It writes `./agenthook.config.json`.

**What `init` does _not_ do yet:** it leaves the pipeline as a single placeholder `code` step with
`TODO_*` section gids. You fill those in next. (`agenthook doctor` checks tokens/git/port but
**not** these gids — so a green doctor with TODO gids still fires nothing. This is the #1 "why is
nothing happening" cause.)

## 4. Map your sections to steps — the part that actually matters

Open `agenthook.config.json`. The `tracker.pipeline` array is the whole execution model. A minimal
three-stage Asana pipeline:

```jsonc
"pipeline": [
  {
    "id": "triage",
    "kind": "triage",
    "instructionsFile": "./INSTRUCTIONS_TRIAGE.md",
    "sourceSectionGid": "1200000000000001",   // task lands here → triage runs
    "successSectionGid": "1200000000000002",   // = the code step's source
    "failureSectionGid": "1200000000000009",
    "holdSectionGid":    "1200000000000010"
  },
  {
    "id": "code",
    "kind": "implement",
    "createsWorktree": true,
    "instructionsFile": "./INSTRUCTIONS_CODE.md",
    "sourceSectionGid": "1200000000000002",
    "successSectionGid": "1200000000000003",   // = the review step's source
    "failureSectionGid": "1200000000000009",
    "holdSectionGid":    "1200000000000010"
  },
  {
    "id": "review",
    "kind": "review",
    "instructionsFile": "./INSTRUCTIONS_REVIEW.md",
    "sourceSectionGid": "1200000000000003",
    "successSectionGid": "1200000000000004",   // a "done" section nothing sources
    "failureSectionGid": "1200000000000009"
  }
]
```

The rule that ties it together: **one step's `successSectionGid` is the next step's
`sourceSectionGid`.** That overlap is the chain — advancing a task *is* the trigger for the next
stage. A `review` step with no following step just lands the task in a "done" section.

How to get the real gids:

- **Asana** — sections have numeric gids. List them with your token:
  ```bash
  curl -s -H "Authorization: Bearer $ASANA_TOKEN" \
    "https://app.asana.com/api/1.0/projects/<projectGid>/sections?opt_fields=name" | jq
  ```
  (`<projectGid>` is already in your config after `init`.) See [asana-setup.md](asana-setup.md).
- **Jira** — there are no gids; steps use **status names** (`"sourceStatus": "In Progress"`,
  etc.), matched case-insensitively. Use your board's column names. See [jira-setup.md](jira-setup.md).

Extra step fields you'll want to know:
- `createsWorktree: true` — the receiver makes one git worktree for this task, shared by all its
  steps (so `code` and `review` operate on the same branch/PR). Set it on the first step that
  writes code.
- `maxAttempts` (default 3) — caps how many times a `changes` verdict can bounce back into a step
  before it's forced to `fail`, bounding an endless code↔review loop.
- `model` — pin a step to a specific Claude model (e.g. `"claude-opus-4-8"` for review).
- `effort` — per-step reasoning effort, passed to `claude -p --effort` (`low` | `medium` | `high`
  | `xhigh` | `max`). Spend tokens where they matter: `"low"`/`"medium"` for `triage`/`review`,
  `"high"` for `code`. Omit it to use the CLI default; an invalid value is dropped with a warning.
- `kind` — a free label used in prompts/logs (`triage`, `implement`, `review`).

The fully-commented reference is [`agenthook.config.example.json`](../agenthook.config.example.json).

## 5. Write the per-step instructions

Each step's `instructionsFile` is the **standing prompt** prepended to every task that hits that
step — your policy (work in a worktree, open a draft PR, how to report). Start from the shipped
example and split/tune it per step:

```bash
cp INSTRUCTIONS.example.md INSTRUCTIONS_CODE.md     # then trim to the coding stage
```

[`INSTRUCTIONS.example.md`](../INSTRUCTIONS.example.md) is a complete, opinionated coding-agent
policy (isolate → implement → pre-push checks → draft PR → self-review → proof → ask-don't-guess).
A `review` step's file would instead tell the agent to review the open PR and emit a `changes` or
`advance` verdict. These files live beside the config and are read fresh each run, so edits need no
restart.

**The verdict contract** (handled for you, but worth knowing): agenthook appends a footer telling
the agent to write `{ "outcome": "...", "target": "...", "reason": "..." }` to
`$AGENTHOOK_VERDICT_FILE` before exiting. Outcomes: `advance` (next stage), `hold` (parked for a
human answer), `changes` (bounce to an earlier step — the rework loop), `fail` (needs a human). A
non-zero exit is always treated as `fail`; a clean exit with no file defaults to `advance`.

## 6. Preflight

```bash
agenthook doctor
```

Confirms the token resolves, `repoPath` is a git repo, `claude`/`ngrok` are on PATH, and the port
is free. (Reminder: it does **not** validate your section gids — re-check those against step 4.)

## 7. Start it

```bash
agenthook start          # ingress up → register/instruct webhook → serve
```

- **Asana** creates the project webhook for you automatically.
- **Jira** prints **one-time** by-hand webhook instructions (Jira Cloud blocks token-based webhook
  creation) — paste the printed URL + secret into Jira admin once. See [jira-setup.md](jira-setup.md).

Leave it running. (Add `--detach` to background it; `agenthook stop` to stop and remove its
webhooks.)

## 8. Trigger your first run

Move a task into your first step's source section (Asana) or transition an issue into the first
status (Jira). It must be **assigned to you** — agenthook is fail-closed and ignores tasks
assigned to anyone else (see [assignee scoping](#assignee-scoping) below).

Watch it happen:

```bash
agenthook agents                 # the live claude -p process for that task
agenthook follow                 # tail the agent's transcript read-only
agenthook status <profile>       # queue depth, recent runs, public URL
```

A run log lands in `~/.agenthook/<profile>/logs/`. On a clean finish the task moves to the next
section and the next step fires.

## Assignee scoping

By default agenthook only acts on items **assigned to the token's own account** (your Asana
`userGid` / your Jira account). This is fail-closed: if it can't establish "us", it touches
nothing. To run project-wide (any assignee), set `"assigneeFilter": false` in the `tracker` block —
deliberately.

## When something doesn't fire

Most first-run problems are one of: TODO section gids still in the config, the task isn't assigned
to you, the webhook didn't register (Jira: not created by hand yet), or an ephemeral ngrok URL
rotated. Walk the [troubleshooting guide](troubleshooting.md) — it's symptom-first.

## Next

- [Asana setup](asana-setup.md) · [Jira setup](jira-setup.md) — token + board specifics
- [Troubleshooting](troubleshooting.md) — symptom → fix
- [Architecture](architecture.md) — how the engine works + the honest tradeoffs
- [Sandbox](sandbox.md) — the blessed way to run `fullAuto` safely
- [Providers](providers.md) — add a tracker or ingress adapter
