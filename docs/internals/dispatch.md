# Dispatch: running a step, verdicts, agent adapters, the `@agent` resume gate

## Key files

- `src/dispatch.js` — a one-line re-export shim (the public path every importer uses) over
  `src/dispatch/`, split by concern around one per-dispatcher state object (`context.js` typedefs;
  `index.js` = `createDispatcher` wiring + `runClaude`/`cancel`): `prompt.js`/`verdict.js`/`pr.js`
  pure helpers, factories `spawn.js` (spawn, log streaming, timeouts/kill), `usage.js` (finalize,
  energy), `routing.js`, `merge.js`, `ci.js`, and `runStep` cut in two: `step.js` (gates, worktree,
  prompt — standing instructions + `stepPrompt` base joined by `=== TICKET ===` — and the spawn with
  `AGENTHOOK_VERDICT_FILE`) → `finish.js` (usage, verdict, run_end, `adapter.advance`). **Verdict**:
  non-zero exit → `fail`; clean exit + valid file → its outcome; clean exit + no file → `advance`.
  `changes` is capped per `(ref,step)` by `maxAttempts` (default 3) to bound the rework loop. A
  `merge` job spawns no agent: fail-closed assignee check → `adapter.enterStage` into the
  `completeOnMerge` (manual) step (its own webhook then drains + emits `pipeline_done`) → optional
  `adapter.complete` (Asana: `completed:true`) → emit `merged`.
- `src/agents/*.js` — agent adapters: the coding-agent CLI a step spawns (`claude`, `cursor`, `hermes`, `opencode`). Interface
  `AgentAdapter` (`src/types.js`): `describe` (optional `promptFile: true` — dispatch passes the prompt via a
  file, not argv, e.g. hermes' `--query-file`), `buildArgs`, `createParser` (stdout → log text + tally +
  `result`/`sessionId`; optional `pushStderr` feeds stderr to the parser, e.g. hermes' `session_id:` line),
  `usageRecord(result|null, ctx)` (decides `unpriced`), `sessions`
  (`{transcriptDir, resumeCommand, files, cwdDirs}` or null — backs `follow`/`resume`/`sessions.js`, which union every agent the profile + its steps run; a null-`sessions` agent with an optional top-level `resumeCommand` — opencode — is resumed from `usage.jsonl` session ids instead), `defaults`
  (`requireVerdict`/`bin`, under the step's), optional `env({cfg,step})` (agent env under the step's `env`, also in `resume`)
  and `preflight({cfg,step,provider,sandboxed,env})` (a reason fails the run with no spawn; on a sandboxed step
  `agentPreflight` first refuses an agent with no `sandbox` hook), optional `sandbox({cfg,step,cwd,ownsCwd,home}) → {mounts, env?}`
  (claude: its transcript dir mounted under the container HOME — for a no-worktree run (`ownsCwd` false) a receiver-owned
  `<stateDir>/sandbox-transcripts/<mangle>`, never the operator's `~/.claude/projects/<mangle(repo)>`, and `follow` searches it; see [adapters.md](adapters.md) for the sandbox axis). Hermes steps are `isolated` by default
  (`hermes-home.js`: own `HERMES_HOME` at `<stateDir>/hermes-home`, only `config.yaml` copied, local providers only). `index.js` = `AGENTS` + `getAgent`/`agentFor` (step `agent` →
  `cfg.agent` → `claude`); `names.js` = the import-free `AGENT_NAMES` the config schema + validation use.

## CI and merge jobs (forge-driven, `src/dispatch/ci.js` + `merge.js`)

A `github` forge turns a merged PR on an `agent/<ref>` branch into a
`{kind:'merge', ref, stepId:<completeOnMerge step|"">, dedupKey:'merged:<n>'}` job (see
[adapters.md](adapters.md) for the forge interface and hook routing). A red `workflow_run` on a
same-repo `agent/<ref>` branch becomes a `{kind:'ci', dedupKey:'ci:<run>:<attempt>'}` job
(`forge.redCi:false` disables): dispatch's `runCi` re-runs failed jobs on attempt 1, else posts
the log tail as a **PR comment only** (never into findings/prompts — the PR head controls it) and
bounces `changes` → `forge.ciTarget` (default the `createsWorktree` step) through the shared
`guardChanges` cap, parking it (`store.setCiRed`) while a step runs on the ref.

## The `@agent` resume gate

The normalized unit passed engine-wide is the **job**: `{ kind: 'pipeline'|'merge', ref, stepId, dedupKey, comment? }`.
Adapters produce jobs; the engine only ever sees jobs. The execution model is the pipeline: a task
moving between board sections drives it. The one comment path is the **`@agent` resume**: an
owner-authored comment starting with `cfg.trigger` on a **held** item re-runs the held step with
the comment as `job.comment` (appended to the prompt). Gate (all required, fail-closed): author
**strictly** = our tracker identity (independent of `assigneeFilter` — never reuse `isOurs`), body
starts with the trigger, the item passes the assignee gate, `store.getHeld(ref)` names a non-manual
step, and that step is under its `maxAttempts` cap (agent and owner share one token, so the cap
bounds self-triggering). Adapter-neutral half: `resumeJob` in `src/pipeline.js`. Asana, GitHub
labels and Jira (`comment_created`); Projects v2 not yet.
