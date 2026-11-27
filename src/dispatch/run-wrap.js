// The sandbox/remote wrap (#710 sandboxed, #689/#826 remote harness): builds the box-run
// descriptor spawnAgent's `sandboxed` option carries, and applies the #731 standing-text dedupe
// to the prompt when the agent's own sandbox/remote hook already wrote the standing text into an
// instructions file on its side. Returns the three values callers used to mutate in place
// (`sandboxedRun`, `prompt`, `refused`) instead of mutating them, so step.js can build its run
// context from the result.
import fs from "node:fs";
import path from "node:path";
import { egressPolicy, egressRules } from "../sandbox/egress.js";
import { trustedGitDirs, gitSandboxEnv, mergeGitConfigEnv, hostGitFacts, inferredForgeEgressHosts, sandboxMounts, checkoutMasks } from "./sandbox.js";

/**
 * @param {object} wc
 * @param {boolean} wc.sandboxed
 * @param {boolean} wc.remote
 * @param {import('../types/index.js').Config} wc.cfg
 * @param {import('../types/index.js').Step} wc.step
 * @param {import('../types/index.js').Step} wc.spawnStep
 * @param {import('../types/index.js').Sandbox|null} wc.sandbox
 * @param {import('../types/index.js').AgentAdapter} wc.agent
 * @param {string} wc.cwd
 * @param {boolean} wc.hasWorktree
 * @param {string} wc.verdictFile
 * @param {string} wc.standing
 * @param {import('../types/index.js').RunCredentials|null} wc.creds
 * @param {import('../types/index.js').RepoConfig} wc.repo
 * @param {string|undefined} wc.sandboxImage
 * @param {import('../types/index.js').Forge|null|undefined} wc.forge
 * @param {import('../types/index.js').AdapterMeta} wc.meta
 * @param {Record<string, string>} wc.spawnEnv
 * @param {string|undefined} wc.remoteConfigDir
 * @param {string} wc.base  the ticket half of the prompt, below the `=== TICKET ===` marker
 * @param {string} wc.prompt  the run prompt before this wrap
 * @param {string} wc.logPath
 * @param {string} wc.ref
 * @param {string} wc.stepId
 * @param {string} [wc.worktree]  the hub worktree (hasWorktree only) — the remote hub's sync source/target
 * @param {string} [wc.branch]  the step's branch (hasWorktree only)
 * @param {string|undefined} wc.refused
 * @returns {{sandboxedRun: Parameters<import('./spawn.js').Spawn['spawnAgent']>[0]['sandboxed'], prompt: string, refused: string|undefined}}
 */
export function buildRunWrap(wc) {
  const { sandboxed, remote, cfg, step, spawnStep, sandbox, agent, cwd, hasWorktree, verdictFile, standing, creds, repo, sandboxImage, forge, meta, spawnEnv, remoteConfigDir, base, logPath, ref, stepId } = wc;
  let { prompt, refused } = wc;
  /** @type {Parameters<import('./spawn.js').Spawn['spawnAgent']>[0]['sandboxed']} */
  let sandboxedRun;
  if (sandboxed && sandbox && agent.sandbox && !refused) {
    try {
      const own = agent.sandbox({ cfg, step: spawnStep, cwd, ownsCwd: hasWorktree, home: sandbox.describe().home, verdictFile, standing });
      // The per-run GH_CONFIG_DIR (#474) is mounted read-only next to the agent's own mounts:
      // a refresh rewrites hosts.yml with an atomic rename, which the container sees because
      // the mount is the directory, not the file.
      const mounts = sandboxMounts({ cwd, hasWorktree, verdictDir: path.dirname(verdictFile), gitCommonDir: trustedGitDirs(repo.path, cwd).commonDir, agentMounts: own.mounts, credsMount: creds?.env?.GH_CONFIG_DIR, masks: hasWorktree ? [] : checkoutMasks(cwd, { extra: [cfg.configPath, cfg.configPath && path.join(path.dirname(cfg.configPath), ".env")] }) });
      const facts = hostGitFacts(repo.path);
      // When creds already supplies github.com's credential helper and insteadOf rewrite
      // (runGitEnv, under GH_CONFIG_DIR), skip gitSandboxEnv's own copy of those pairs —
      // mergeGitConfigEnv re-indexes what's left (safe.directory, author identity) after it.
      const gitEnv = mergeGitConfigEnv(creds?.env, gitSandboxEnv({ originUrl: facts.originUrl, forgeType: cfg.forge?.type, forgeBaseUrl: cfg.forge?.baseUrl, author: facts.author, skipHostAuth: !!creds }));
      // The network policy: the hosts come from the adapters dispatch holds, never from src/sandbox/.
      const policy = egressPolicy(cfg, step);
      const rules = policy.mode === "allowlist"
        ? egressRules({ agentHosts: agent.egressHosts?.(spawnEnv, { step: spawnStep }) ?? [], trackerHosts: meta?.egressHosts ?? [], forgeHosts: forge ? (forge.describe?.().egressHosts ?? []) : inferredForgeEgressHosts(facts.originUrl), originUrl: facts.originUrl, allow: policy.allow, deny: policy.deny })
        : [];
      sandboxedRun = { ref, stepId, step, mounts, env: { ...(own.env ?? {}), ...gitEnv }, egress: { mode: policy.mode, rules }, ...(sandboxImage ? { image: sandboxImage } : {}), ...(own.files ? { files: own.files } : {}), ...(own.args ? { args: own.args } : {}) };
      // #731: the standing text is already in the agent's `instructions` file (own.files) —
      // drop it from the run prompt so the model doesn't see it twice. Keep the marker: the
      // standing text itself refers to "the `=== TICKET ===` marker".
      if (own.standingInInstructions) prompt = `=== TICKET ===\n\n${base}`;
    } catch (e) {
      refused = `sandbox setup failed: ${e.message}`;
      try {
        fs.appendFileSync(logPath, `[agenthook] ${refused}\n`);
      } catch {
        /* best effort */
      }
    }
  } else if (remote && !refused) {
    // A remote harness's run (#689): no mounts/egress — the worker's cwd is a path on another
    // machine, not something the hub wraps. `ref`/`stepId`/`step` are what spawn.js's generic
    // box-run plumbing (executorRuns, kill/done on exit) actually needs. `hub` (#690) is the
    // HUB-side repo/worktree the ssh executor syncs code from/to around the run — `worktree`/
    // `branch` only for a worktree step; a no-worktree step (e.g. triage) gets a tracked-only
    // export instead.
    const hub = { repoId: repo.id, repoPath: repo.path, ...(hasWorktree ? { worktree: wc.worktree, branch: wc.branch } : {}) };
    sandboxedRun = { ref, stepId, step, mounts: [], hub };
    // An agent with a `remote` hook (opencode #739, pi #827) needs files/env on the worker
    // beyond the synced code — the contract/standing files (and, for opencode, a generated
    // config pointed at by `OPENCODE_CONFIG`), written into the per-run dir the ssh executor's
    // `paths()` computed. `args` (pi: the `--append-system-prompt` flags) are spliced before
    // the argv's `--` by spawn.js, resume turns included. claude has no `remote` hook, so this
    // is a no-op for it — same as before the feature.
    if (agent.remote) {
      try {
        const own = agent.remote({ cfg, step: spawnStep, dir: /** @type {string} */ (remoteConfigDir), verdictFile, standing });
        sandboxedRun = { ...sandboxedRun, env: own.env, ...(own.files ? { files: own.files } : {}), ...(own.args ? { args: own.args } : {}) };
        // #731: the standing text is already in a remote `instructions` file — drop it from the
        // run prompt so the model doesn't see it twice, same dedupe the sandbox branch does.
        if (own.standingInInstructions) prompt = `=== TICKET ===\n\n${base}`;
      } catch (e) {
        refused = `remote setup failed: ${e.message}`;
        try {
          fs.appendFileSync(logPath, `[agenthook] ${refused}\n`);
        } catch {
          /* best effort */
        }
      }
    }
  }
  return { sandboxedRun, prompt, refused };
}
