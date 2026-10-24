# Adapter interfaces, pipeline, worktree, multi-repo routing

The whole point is the **blind engine + swappable adapters** split, now on **two axes** plus
optional ones: the engine names neither the *tracker* (where work comes from) nor the *ingress*
(how it's reachable), nor the optional *forge* (what happened to the code — e.g. a PR merged), nor
the optional *sandbox* (where an agent run executes — a per-run container).
Each lives behind its own one-interface adapter. See `docs/agenthook-v2.md` for the full design.

## Key files

- `src/trackers/*.js` + `index.js` — tracker adapters. `asana.js`'s header is the **reference
  doc-comment for the adapter interface**; read it before adding one. Register in `index.js`'s
  `TRACKERS` (keyed by `cfg.tracker.type`). Interface: `describe`, `authenticate`, `processEvents`,
  `fetchTask`, `advance`, `listResting`, `registerWebhook`, `unregisterWebhooks`, `forgeCatchup`,
  optional `wizardSteps` (powers `init` live discovery), optional `listQueued(stepId)` (refs in the
  step's queue stage, board order, filtered like `listResting` — not `store.listQueued`, which is
  the local `queue.json`), optional `openBlockers(ref)` (unresolved blockers, fail-open; `dispatch.js`
  re-checks it at run time so a dependency added while a job waited in the local queue still gates it),
  optional `onJobs(emit)` (an in-process event source — `local` only, no webhooks: the engine wires a
  sink at boot; `createPushSink` parks a ref's pushed job until its current run settles), optional
  `createTask({name, description?, stepId?})` (`local` only: add one item under the next numeric ref and push
  its `step:<id>:<ref>` job — `agenthook ticket add`).
- `src/ingress/*.js` + `index.js` — ingress adapters (`ngrok` managed/ephemeral, `cloudflared`
  managed — quick tunnel ephemeral, named tunnel (`tunnel` + `hostname`) stable; logs to
  `<logDir>/cloudflared.log` — `tailscale` stable — one-shot `tailscale funnel --bg --set-path
  /<stateKey>` calls, no child; Tailscale strips the mount before proxying, so only `publicUrl`
  carries the path — and `manual`/`hosted` static). Registry `INGRESS` keyed by `cfg.ingress.type`. Interface: `describe() → {name,ephemeral}`,
  `up(port) → {url}`, `down()`, optional `wizardSteps`, optional `onExit(listener)` — cloudflared
  and ngrok call `listener(reason)` at most once if their managed tunnel dies unexpectedly after
  `up()` resolved (never on `down()` or a startup failure); boot wires it to a heartbeat
  `ingressDown` field that `status`/`doctor` surface (tailscale/manual have no child to watch, so
  no `onExit`).
- `src/sandbox/*.js` + `index.js` — optional sandbox adapters (`docker`, `podman`, both
  `container.js`). Registry `SANDBOXES` keyed by `cfg.sandbox.type`; no `sandbox` block →
  `createSandbox` returns null and runs spawn on the host. Interface: `describe() → {name, home}`,
  `check() → {ok, reason?}` (runtime + image present; boot refuses on `!ok`), `wrap({runId, ref,
  stepId, bin, args, env, cwd, mounts, step}) → {bin, args, env, id, kill, done}` (the argv that
  runs the agent in a fresh container; env passed by name only), `reap() → {containers, networks, runs}`
  (force-remove every container and network labelled with this profile's `stateKey`; `runs` is the
  distinct `"<ref>/<step>"` values read, best-effort, from the removed containers' `agenthook.ref`/
  `agenthook.step` labels). `names.js` `isSandboxed(cfg, step)` — a step's
  `sandbox: false` opts out. `src/dispatch/sandbox.js` holds the engine-blind run plumbing: the
  mount list (worktree, common git dir with `config`/`hooks` read-only, per-run verdict dir, the
  agent's own mounts from `AgentAdapter.sandbox()`), the container/runtime env split, and the git
  `insteadOf` + credential-helper env for HTTPS push. Host git calls on a sandboxed profile go
  through `worktree.js` `gitArgv` (`HOST_GIT_SAFE`: no hooks, no fsmonitor). An agent without a
  `sandbox()` hook is refused on a sandboxed step (`agentPreflight`).
  Egress (#473): `wrap`'s optional `egress: {mode, rules}` — `allowlist` creates a per-run
  `--internal` network plus a proxy container (`egress-proxy.mjs`, standalone `.mjs`, `node:`
  imports only, run in the built-in image) and hands the agent `HTTPS_PROXY`; `none` =
  `--network none`; absent/`open` = unchanged. `done()` tears both down and reports
  `denied.jsonl` as `notes` + `extra.egressDenied`; `reap()` also removes labelled networks.
  `egress.js` `egressRules` builds the rule list from what dispatch hands it — the agent's
  `egressHosts(env)`, the tracker meta's and forge `describe()`'s `egressHosts`, the origin —
  so `src/sandbox/` names no tracker, forge or agent (`TRACKER_EGRESS_HOSTS` /
  `FORGE_EGRESS_HOSTS` give doctor the same lists without building an adapter).
- `src/forges/*.js` + `index.js` — optional forge adapters (`github`, `gitlab`). Registry `FORGES` keyed by
  `cfg.forge.type`; no `forge` block → `createForge` returns null and nothing changes. Interface:
  `describe`, `authenticate` (sync), `processEvents`, `registerWebhook`, `unregisterWebhooks`. The
  engine routes POST `/forge[/]` to the forge (else the tracker). `github` turns a merged PR on an
  `agent/<ref>` branch into a `{kind:'merge', ref, stepId:<completeOnMerge step|"">, dedupKey:'merged:<n>'}`
  job; its hook path is `/forge` (**not** `/github`, which the github tracker's scrub deletes) and it
  always verifies `x-hub-signature-256` via the shared `src/hmac.js` `verifyHubSignature`. A red
  `workflow_run` on a same-repo `agent/<ref>` branch becomes a `{kind:'ci', dedupKey:'ci:<run>:<attempt>'}`
  job (`forge.redCi:false` disables) — see [dispatch.md](dispatch.md) for how dispatch handles the
  CI and merge jobs this produces.
  **Missed merges:** a PR merged while the receiver was down never sends its webhook, so the
  optional `listMergedAgentPrs(since)` (github only: closed PRs by `updated` desc, paged until one
  predates `since`, ≤ 5 × 100) lets `runMergeCatchup` (`src/commands/reconcile.js`) replay the same
  `merged:<n>` job — unforced, so a merge handled live stays deduped by `seen`. It runs **only**
  from `reconcile` (CLI → `reconcile_merges` op on a webhook tracker; the `reconcile` op/MCP tool)
  and `--reconcile-on-boot` — never a plain boot or a timer — skips a task already `completed`, and
  keeps a `merge-watermark.json` (newest `mergedAt` listed, held below the oldest PR whose task
  fetch failed; first run looks back 7 days). Dependents
  release through the tracker's own close webhook once the merge job's `complete` closes the blocker.
  A forge without the method (gitlab today) logs and skips.
  `gitlab` (`src/forges/gitlab.js`, config `project` + optional `baseUrl`, API `<baseUrl>/api/v4`
  with `PRIVATE-TOKEN`) produces the same jobs from the same `/forge` path, so engine and dispatch
  don't change. A `Merge Request Hook` with `action:"merge"` from a same-project `agent/<ref>`
  branch → `merge` (`merged:<iid>`); a `Pipeline Hook` `failed` → `ci`, `success` → `ci_green`.
  Three GitLab quirks: (1) **auth is a shared token, not an HMAC** — `x-gitlab-token` is compared
  in constant time with the secret (store key `forge:gitlab:webhookSecret`), which gives no body
  integrity and is replayable by anyone who sees the header, so the ingress must be HTTPS;
  (2) **retries keep the pipeline id** and carry no attempt number, so `rerunFailedJobs` writes a
  `gitlab:retried:<id>` seen marker and the next failure of that pipeline is `attempt: 2` (else it
  dedups against the first and the bounce + `changes` cap never fire); (3) **an MR pipeline's
  `object_attributes.ref` is `refs/merge-requests/<iid>/head`**, so the branch comes from
  `merge_request.source_branch` when present. Forks fail closed (`source_project_id` must equal
  `target_project_id`, and the pipeline's `path_with_namespace` must be `forge.project`). Hooks are
  scrubbed exactly like github's (stored id / previous URL / same target only). User setup:
  [gitlab.md](../gitlab.md).
- `src/pipeline.js` + `src/worktree.js` — the pipeline (`tracker.pipeline[]`, **required**). A task
  entering a step's `sourceSectionGid` fires that step; a clean exit advances to `successSectionGid`
  (= next step's source, so the move re-triggers the next step) unless the agent's verdict says
  `hold`/`changes`/`fail` (`prevStep()` resolves a `changes` target's default). `worktree.js` is the
  **receiver-owned** worktree (create on `createsWorktree`, `drainWorktree` to remove), keyed by task
  ref so all steps share one — no globbing. **No implicit polling**: forward motion is event-driven,
  crash recovery reads local `running.json` only, and the only board poll is the explicit
  `agenthook reconcile` command (which also asks the forge for PRs merged while down) — with **one narrow exception**: a step that sets a queue-stage key
  (`queueSectionGid` Asana / `queueStatus` Jira·github-projects·local / `queueLabel` GitHub) opts in
  to reading **that one stage**, only on `run_end` (when a slot is free) and once on boot. It is
  never timer-driven, and `listResting` is still never called on boot. `src/pull.js` pulls the top
  `maxConcurrent − active − queued − pending` items via `enterStage(…, {assign:false})` (the same
  move `ah run` makes — the webhook then fires the step). Order: Asana section order, Jira
  `Rank ASC`, GH Projects board position, GitHub labels **oldest-created first** (labels have no order).
- `src/repos.js` — multi-repo routing (pure). `cfg.repos[]` (`{id, path, match, default?,
  instructionsFile?, worktreePrefix?}`; no block → one synthesized `default` repo at `repoPath`,
  `cfg.multiRepo=false`, nothing changes). `resolveRepo(cfg, task.routeKeys)` → exactly one repo;
  no match → the `default` repo; two matches → `conflict`, none + no default → `unroutable` — both
  **hold** the task in `runStep` (no spawn, no attempt, `setHeld` so `@agent` re-runs it). The first
  routed step sticks the ref to its repo (`repo.json`, multi-repo only); worktrees then nest as
  `<base>/<repo.id>/<ref>`. Adapters only supply opaque `Task.routeKeys`.

See [trackers.md](trackers.md) for provider-specific tracker behavior (Asana, Jira, GitHub,
GitHub Projects v2).
