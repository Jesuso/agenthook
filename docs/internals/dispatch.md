# Dispatch: running a step, verdicts, agent adapters, the `@agent` resume gate

## Key files

- `src/dispatch.js` — a one-line re-export shim (the public path every importer uses) over
  `src/dispatch/`, split by concern around one per-dispatcher state object (`context.js` typedefs;
  `index.js` = `createDispatcher` wiring + `runClaude`/`cancel`): `prompt.js`/`verdict.js`/`pr.js`
  pure helpers, factories `spawn.js` (spawn, log streaming, timeouts/kill; `agentSpawnEnv` = the
  receiver env filtered to `src/agent-env.js`'s allowlist — base + agent `envPassthrough` + tracker/forge
  `agentEnv` + `cfg.agentEnvPassthrough` — minus the run credentials' `strip`, under `agent.env`, then the run
  credentials' `env`, then step `env`, #470/#474; `runCredentials` = `forge.runCredentials` else
  `adapter.runCredentials` — a throw refuses the run like a preflight, `step.js` disposes them in a `finally`
  once the run settles; the GitHub App per-run token lives in `src/github-run-token.js`), `usage.js` (finalize,
  energy), `routing.js`, `merge.js`, `ci.js`, and `runStep` cut in two: `step.js` (gates, worktree,
  prompt — standing instructions + `stepPrompt` base joined by `=== TICKET ===` — and the spawn with
  `AGENTHOOK_VERDICT_FILE`) → `finish.js` (usage, verdict, run_end, `adapter.advance`, then the opt-in
  `forge.autoMerge` call in `src/auto-merge.js` when the approving step's move succeeded, or `auto_merge_skipped`; the enable is pinned to the PR head `step.js` recorded when the tier step started. A `changes`/`fail` first turns auto-merge off via `disableAutoMergeOnBounce` — as do a red-CI bounce in `ci.js`, `ops.cancel` and restart recovery — and a failed disable turns a `changes` into a `hold`. A `pr_push` signal job (forge `synchronize` webhook) runs `createPrPushGuard` outside the queue). **Verdict**:
  non-zero exit → `fail`; clean exit + valid file → its outcome; clean exit + no file → `hold` by
  default (`requireVerdict` defaults to `true`; set `false` on the step to advance instead). Before
  that hold fires, `step.js` tries up to `step.verdictRepairs` (default 1, 0 disables) **repair
  turns** (#677): right after the first `spawnAgent` resolves, inside the same `try` block, before
  `creds.dispose()` in the `finally` — the seam has to be here, not `finish.js`, because run creds
  and the `onPid`/cancel wiring are disposed/torn down right after. A repair turn resumes the same
  session (`agent.resumeArgs`, the same options as `buildArgs` plus `sessionId`) with
  `prompts.js`'s `verdictRepairPrompt`, needs a captured `result.session_id` and is skipped outright
  for an agent with no `resumeArgs` (hermes), a sandboxed run of an agent whose
  `describe().sandboxResume === false` (opencode: its session db lives in the per-run sandbox HOME,
  gone at teardown), or less than 60s of `maxMinutes` left (`maxMinutes: 0` = no cap, always enough).
  Only the final turn's `code`/`timedOut`/`lastText` become the run's (crash/timeout/question-hold
  resolve off it); the harness-health signals (`preflightDown`/`noOutput`/`apiDown`/`sandboxReport`)
  stay the first turn's. `finish.js` sums every repair turn's `usageRecord` into the one usage
  record (tokens/cost/duration add, `peakContext` is the max, `lastContext`/`sessionId` are the
  final turn's), emits `verdict_repair {result, turns}` right before `run_end` (which then carries
  `repaired: true|false`), and — only when still missing after every turn — appends
  `(after N repair turn(s))` to the hold reason (`verdict_missing`/`blocked` keep firing off it, via
  `verdict.js`'s shared `guardSandboxVerdict`, the same sandboxed-verdict lstat/size guard a repair
  turn's own pre-check uses before trusting the file).
  **Gate** (#710, `src/dispatch/gate.js`): after deduce/repair settle, while still inside the same
  `try` block, a step's optional `gate` runs when the exit is clean (no timeout/spawnError/cancel/
  sandbox sync-back failure) and the effective verdict peeks `"advance"` (agent-written, repaired,
  deduced, or the `requireVerdict:false` assumed-advance — `readVerdict` already covers all four).
  It never runs for a hold/fail/changes/missing-verdict. `runGate` always goes through this run's
  own `Executor`: host spawns the argv directly in `cwd`; sandbox wraps it through
  `executor.launch` with the run's own mounts/egress/image, then spawns the wrapped client
  command; ssh runs it on the worker via a `raw: true` launch (`executor-ssh.js`: the given argv
  runs verbatim, with an empty prompt on stdin, and `done()` never fetches edits back — only
  cleans up the worktree/export dir). An executor with no way to run a gate vetoes with a reason
  instead of ever falling back to the host. The env is the agent's `agentSpawnEnv` **without**
   `creds` — the gate never sees tracker/forge tokens — and a sandboxed gate also gets the run's
   own sandbox env (the git config pairs from `gitSandboxEnv` + the agent's sandbox env), filtered
   so no credential names and no `GH_CONFIG_DIR` (the per-run credential dir) leak through. A
   non-zero exit or timeout vetoes the advance: `gate_fail` fires, then — while `maxAttempts`
   isn't spent and ≥60s of `maxMinutes` remains — one more agent turn (a resume when possible,
   `prompts.js`'s `gateRepairPrompt` with the gate's redacted 4 KiB output tail fenced
   `GATE_OUTPUT`, else a fresh spawn with the step's original prompt prepended) gets a chance to
   fix it, then the gate runs again (`gate_pass` on a clean exit). Exhausting `maxAttempts` with
   the gate still failing forces a `hold` in `finish.js` (`gate.capExhausted`), with the reason
   `gate failed (exit N[, timed out]) after K attempt(s): <tail>`; a crashed/timed-out repair
   turn, or one that wrote something other than `"advance"`, instead resolves through the normal
   code/timedOut/verdict-file path, same as a verdict-repair turn's crash. The one exception: a
   DEDUCED advance (#680) whose repair turn, like the first, wrote no verdict file — `finish.js`
   would re-deduce the advance from `deduced` + missing-verdict and let it past the failing gate,
   so the gate loop returns `capExhausted` there too (and `finish.js` skips the deduced-advance
   whenever the last gate result is `fail`); the run holds, never advances. Every gate-repair
   turn's usage sums into the run record the same way a
  verdict-repair turn's does; `run_end`/the step summary carry `gate: "pass"|"fail"` only when a
  gate ran at least once.
  `changes` is capped per `(ref,step)` by `maxAttempts` (default 3) to bound the rework loop. A
  `merge` job spawns no agent; it is the **bridge** for boards that can't hear merges: fail-closed
  assignee check → `adapter.enterStage` into the `completeOnMerge` (manual) step (its own webhook
  then drains + emits `pipeline_done`) → optional `adapter.complete` (Asana: `completed:true`) → emit
  `merged`. A self-closing board skips the move and `complete` (see below).
- `src/agents/*.js` — agent adapters: the coding-agent CLI a step spawns (`claude`, `cursor`, `hermes`, `opencode`). Interface
  `AgentAdapter` (`src/types.js`): `describe` (optional `promptFile: true` — dispatch passes the prompt via a
  file, not argv, e.g. hermes' `--query-file`; optional `policy: {allow, deny}` — which step policies the CLI
  enforces, claude only; optional `sandboxResume: false` — a sandboxed run of this agent can never resume a
  session, opencode only), `buildArgs` (also gets the step's `allow`/`deny`, `cwd` and `verdictFile`), optional
  `resumeArgs` (same options plus `sessionId` — a verdict-repair turn, #677; claude/cursor/opencode, not hermes),
  `createParser` (stdout → log text + tally +
  `result`/`sessionId`; optional `pushStderr` feeds stderr to the parser, e.g. hermes' `session_id:` line),
  `usageRecord(result|null, ctx)` (decides `unpriced`), `sessions`
  (`{transcriptDir, resumeCommand, files, cwdDirs}` or null — backs `follow`/`resume`/`sessions.js`, which union every agent the profile + its steps run; a null-`sessions` agent with an optional top-level `resumeCommand` — opencode — is resumed from `usage.jsonl` session ids instead), `defaults`
  (`requireVerdict`/`bin`, under the step's), optional `env({cfg,step})` (agent env under the step's `env`, also in `resume`), optional `envPassthrough` (receiver env names the CLI needs, added to the allowlist)
  and `preflight({cfg,step,provider,sandboxed,env})` (a reason fails the run with no spawn; `agentPreflight` first
  refuses a step `allow`/`deny` the agent's `describe().policy` can't enforce, then, on a sandboxed step, an agent with no `sandbox` hook), optional `sandbox({cfg,step,cwd,ownsCwd,home}) → {mounts, env?}`
  (claude: its transcript dir mounted under the container HOME — for a no-worktree run (`ownsCwd` false) a receiver-owned
  `<stateDir>/sandbox-transcripts/<mangle>`, never the operator's `~/.claude/projects/<mangle(repo)>`, and `follow` searches it; see [adapters.md](adapters.md) for the sandbox axis). Hermes steps are `isolated` by default
  (`hermes-home.js`: own `HERMES_HOME` at `<stateDir>/hermes-home`, only `config.yaml` copied, local providers only). `index.js` = `AGENTS` + `getAgent`/`agentFor` (step `agent` →
  `cfg.agent` → `claude`); `names.js` = the import-free `AGENT_NAMES` the config schema + validation use.

## The executor axis (`src/dispatch/executor.js`, #682, #689)

Which launcher runs a job — the host (a plain spawn), the profile's sandbox (a per-run
container), or (experimental, #689) a harness's remote worker over ssh — is an **executor**,
picked per run by `executorFor(cfg, step, harnessName, executors)` right after `resolveHarness`
(before the prompt is built, so the prompt's `verdictFile` already comes from the chosen
executor's `paths()`). `createExecutors({cfg, sandbox, spawnPaths})` builds the `host` executor
(always), the `sandbox` executor when the profile configures one — its `launch`/`reap` wrap
`sandbox.wrap()`/`sandbox.reap()` verbatim — and one `ssh` executor per harness that declares a
`remote` block (`executors.ssh`, keyed by harness name). `executorFor` picks the harness's `ssh`
executor first; otherwise it answers exactly what `isSandboxed(cfg, step)`
(`src/sandbox/names.js`) answered before this axis existed. The engine builds one executor set
(`createEngine`) shared by dispatch (which run picks) and boot/teardown (which reap it, via
`reapAll` — sandbox containers/networks plus every remote harness's leftover pgids, one failing
executor never blocking the rest); `killNow`/timeout-SIGKILL/cancel-during-launch go through the
picked run's `executor.launch()` result (`executorRuns`, a per-ref map of live boxed runs — host
runs are never stored there).

### The `ssh` executor (`src/dispatch/executor-ssh.js`, #689 launch/kill/env, #690 code transport)

A harness with `remote: {host, user?, port?, identityFile?, workDir, bin?}` runs its agent under
`<workDir>/.agenthook/<stateKey>/…` on that worker. Config validation refuses a step on a remote
harness outright when: the step is sandboxed; per-run GitHub App credentials would be minted for
it (scoped to the hub, not the worker); its effective agent isn't `claude` or `opencode` (#739);
or `tracker.type` isn't `local`. `remote.bin` defaults to the resolved agent's own `defaults.bin`
(`defaultBin` on `launch()`), never a hard-coded `"claude"`.

**Code transport (#690).** The hub worktree stays the only real copy. `paths({stepId, ref,
hasWorktree})` returns a *deterministic per-ref(+step)* worker path — `worktrees/<ref>` when
`hasWorktree`, else `exports/<ref>-<stepId>` — never per-spawn, so a verdict-repair resume turn
(`step.js`, #677) relaunches into the same cwd and finds its session. `launch()`'s `hub:
{repoId, repoPath, worktree?, branch?}` (from `step.js`, absent only for this module's own
low-level unit tests, which then just cd into whatever `cwd` they were given with no sync) drives
a sync **before** every run:

- A worktree step (`hub.worktree`/`branch` set): refuse if the hub worktree has uncommitted
  changes to tracked files, or if its HEAD has a `.gitmodules` or a `.gitattributes` with
  `filter=lfs` (submodules/LFS aren't supported on a remote harness yet) — a clear reason, nothing
  spawns. Else `git push --force` the hub's branch to a bare repo on the worker
  (`repos/<repo.id>.git`, created on first use), record the pushed sha, then `git worktree add`
  it at the deterministic worktree path (pruning + removing any stale dir first). The hub is
  authoritative: a worker branch left ahead by a crashed/refused prior run is overwritten.
- A no-worktree step (e.g. triage): same submodule/LFS refusal against the repo's HEAD, then
  `git archive --format=tar HEAD` streamed straight into a fresh dir on the worker — only tracked,
  committed content ever travels; a gitignored/untracked file, `.env` or the profile config never
  do.

And **after** every run, always (including a timeout/cancel/crash — `done()` runs every time,
never just on a clean exit): for a worktree step, fetch the worker's branch into the hub repo
under a temp ref. Equal to the pushed sha → nothing to do. Not its descendant (rewritten/diverged
history) → refuse, touching nothing. Otherwise `git merge --ff-only` it into the hub worktree; a
failure there also refuses. Either way the temp ref is deleted and the worker worktree/export dir
is removed (best-effort, never masking a refusal). A refusal sets `SandboxReport.failed`, which
`step.js` maps onto `refused` — the run fails rather than advancing on code the hub never actually
got. The worker's own *uncommitted* edits never come back, only commits. `reap()` additionally
clears leftover `worktrees/*`/`exports/*` and prunes each bare repo's worktree admin.

Every hub-side git call this sync makes is `HOST_GIT_SAFE`-hardened (`src/worktree.js`
`hostGitSafe(cfg)`: true for a sandboxed profile OR one with any `harnesses[*].remote` — widening
what `gitArgv`/`listWorktrees` already harden for a sandbox) and the push/fetch go over
`GIT_SSH_COMMAND` (`ssh -o BatchMode=yes` + the harness's own `-p`/`-i`/`-l`, never `-A` — the same
options `sshBaseArgs` builds for the launcher, so there is one source for host/port/identity/user)
against an `ssh://<host><bare path>` URL.

`paths()` also returns a hub-local `hubVerdictFile` (built with the same `sandboxVerdictPathFor`
the sandbox executor uses) — `done()` copies the remote verdict back there once the run exits,
capped at `MAX_SANDBOX_VERDICT_BYTES` (oversize = no verdict, same as a sandboxed run's own cap).
`step.js`/`finish.js` read/guard/clear `hubVerdictFile ?? verdictFile` everywhere except the
prompt and `AGENTHOOK_VERDICT_FILE`, which always get the agent-facing `verdictFile`; the
`sandboxed` boolean they pass around now also covers `executor.name !== "host"`, so an ssh run's
verdict gets the same untrusted-writer guard (`guardSandboxVerdict`) a sandboxed run's does.
`step.js`'s `branchHead`/`commitsSince` (deduced-verdict, #680) read the HUB worktree, not
`executor.paths().cwd` — by the time they run, `done()` has already fast-forwarded it.

`launch()` never puts the prompt in argv, on either side of the connection: it's given the exact
`prompt` string `spawn.js` built `args` from, and removes that element — index 1 (`claude`'s own
`-p <prompt>`) or the final element (`opencode`'s trailing positional, behind `--`) — rather than
assuming either shape by agent name; a mismatch throws, refusing the run instead of risking the
prompt leaking into the worker's argv. The dropped text plus a strict env allowlist (`AGENTHOOK_*`
run metadata, `TERM`/`LANG`/`CI` from the receiver's own env, plus — #739 — an explicit, named
`remoteEnv` addition of exactly whatever keys an `AgentAdapter.remote` hook returned, never a
prefix passthrough — nothing else, never a tracker/forge token, a per-run App token,
`ANTHROPIC_*`/`CLAUDE_*`/the hub's own `OPENCODE_*`, or `SSH_AUTH_SOCK`) travel framed over the
ssh client's own stdin instead (`framePayload`: an env header, then — only when the hook returned
`files` — a file-count header and each file's path/mode/bytes, then a byte-length-prefixed prompt;
an empty `files` array adds nothing, so `claude`'s own frame is byte-for-byte unchanged). `shQuote`
(POSIX single-quote) quotes every element of the trailing ssh argv — ssh joins them with spaces
before the remote shell parses the line, so each one must already be a shell token on its own. The
ssh argv itself is always `-T -o BatchMode=yes` (+ `-p`/`-i`/`-l` as configured) — never `-A`.

**OpenCode on the worker (#739).** `AgentAdapter.remote({cfg, step, dir, verdictFile, standing})`
(opencode's hook; claude has none) returns the same shape as the sandbox hook's `files`/`env`/
`standingInInstructions`, but for a per-run directory on the worker (`paths().configDir`,
deterministic per ref+step like `verdictDir`, outside the synced worktree/export dir) instead of a
container HOME — the contract/standing files plus a generated `opencode.json` (any `opencodeConfig`
read and validated on the **hub**, same cap as the sandbox) whose `instructions` name both as
absolute worker paths, and `env: {OPENCODE_CONFIG: <that config>, OPENCODE_DISABLE_AUTOUPDATE: "1",
OPENCODE_DISABLE_MODELS_FETCH: "1"}`. `OPENCODE_CONFIG` merges on top of the worker's own global
config rather than replacing `HOME`, so the worker's own login/session db/model endpoint keep
working. `step.js`'s remote branch calls the hook (when present) with `executor.paths().configDir`
and puts the result on `sandboxedRun.files`/`.env`, reusing the exact same `executor.launch()`
plumbing `files`/`sandboxed.env` already had for the sandbox path — a throw there refuses the run
("remote setup failed: …"). The launcher script writes the files to disk (via `head -c`, from the
same stdin frame) before starting the agent, and removes the directory on every exit path, plus a
hub-side `done()` best-effort removal and a `reap()` sweep for anything a dropped connection missed.

A small inline POSIX-sh script on the worker reads that framed stdin, `export`s the env, puts the
agent in its own process group (`setsid`; the group's pgid is written to
`<workDir>/.agenthook/<stateKey>/runs/<runId>.pgid`), runs the agent with the prompt on *its*
stdin (a fifo, never argv), and backgrounds a watchdog that `kill -TERM` then `-KILL`s the group
once the hub's stdin closes — a dead client, a dropped link, or an explicit kill all look the
same from the worker's side. `spawn.js` keeps that stdin pipe open for the run's lifetime
(`ExecutorRun.stdin`, host/sandbox leave it unset and close stdin at once, same as before);
`kill()` ends it, then opens a second, independent ssh connection to send the same TERM-then-KILL
directly, in case the first connection is wedged. An ssh exit of 255 with no model output is
reported as a `spawnError` (`"ssh failed (exit <code>)"`), tripping the harness breaker
(`healthTrip`) at any wall time, like any other spawn failure. `reap()` lists, kills and removes
every `*.pgid` under the harness's `runs/` dir — boot recovery and shutdown call it for every
remote harness, independently of the profile's own sandbox reap.

A remote run's subscription-quota reading is the worker's, not paced by this hub (skipped before
`opts.onQuota`), and its power draw is the worker's, not this host's (the energy sampler is never
started for it) — both decided in `step.js` off `executor.name === "ssh"`.

## CI and merge jobs (forge-driven, `src/dispatch/ci.js` + `merge.js`)

A `github` forge turns a merged PR on an `agent/<ref>` branch into a
`{kind:'merge', ref, stepId:<completeOnMerge step|"">, dedupKey:'merged:<n>'}` job (see
[adapters.md](adapters.md) for the forge interface and hook routing). A red `workflow_run` on a
same-repo `agent/<ref>` branch becomes a `{kind:'ci', dedupKey:'ci:<run>:<attempt>'}` job
(`forge.redCi:false` disables): dispatch's `runCi` re-runs failed jobs on attempt 1, else posts
the log tail as a **PR comment only** (never into findings/prompts — the PR head controls it) and
bounces `changes` → `forge.ciTarget` (default the `createsWorktree` step) through the shared
`guardChanges` cap, parking it (`store.setCiRed`) while a step runs on the ref.

`runMerge` is a **bridge** for boards that can't hear merges. It is skipped (no `enterStage`, no
`complete`; only the direct drain + per-ref clears, `clearSummaries`, `prState:"merged"`,
`leavePipeline` and the `merged` event) when the board closes the ticket itself: the job carries
`boardCloses` (the `github` forge sets it when the PR merged into the default branch, its body says
`Closes #<ref>` and the tracker is `github` on the same repo), `forge.boardClosesOnMerge` is set
(Jira/Linear with a dev-tool integration), or the task is already `completed`. Where the bridge
didn't deliver (not ours, fetch failed, the move failed with no `complete()`, `complete()` threw, or
neither ran) the local `prState:"merged"` is still recorded (the not-ours/fetch-failed paths make no
tracker call and emit nothing), so Needs-you surfaces **"PR merged — close the ticket"** rather than
only a console line.

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
