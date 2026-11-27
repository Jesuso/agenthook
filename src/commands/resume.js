// `agenthook resume [ref [session]] [--exec] [--limit N]` — open the headless agent
// session for a task ref interactively. Unlike `follow` (read-only tail), this hands
// you the exact `claude --resume` invocation (or runs it) so you can continue an
// agent in its own worktree. Receiver-spawned (`-p`/sdk-cli) sessions don't show in
// Claude's own `claude -r` picker, and their transcripts live under the worktree
// mangle — so finding the dir + session id by hand means hunting the filesystem.
//
// A ref usually has SEVERAL sessions (one per pipeline step run: code, review, …),
// so `resume <ref>` lists them with their step and you pick which to resume:
//
//   agenthook resume                       last N agent runs (default 10), one per ref
//   agenthook resume <ref>                  list that ref's sessions + their step
//   agenthook resume <ref> <id|prefix|n>    print `cd <worktree> && claude -r <id>`
//   agenthook resume <ref> <sel> --exec     run it now (interactive; inherits terminal)
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config/index.js";
import { createStore } from "../store/index.js";
import { worktreePath } from "../worktree.js";
import { branchName } from "../worktree.js";
import { sessionDirs, listSessions, recentRuns, refRepo, agentSessions } from "../sessions.js";
import { agentFor, getAgent } from "../agents/index.js";
import { remoteProbeArgv, sshInteractiveArgv, sshClientEnv, shQuote, remoteRunPaths } from "../dispatch/executor-ssh.js";
import { ago } from "./ls.js";

/** @param {string|number} s @param {number} n */
const pad = (s, n) => String(s).padEnd(n);
/** @param {string} s @param {number} n */
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString();

/** Count a ref's sessions (transcripts + usage.jsonl ones; 0 if none exist).
 * @param {import('../types/index.js').Config} cfg @param {string} ref @param {any} store */
const sessionCount = (cfg, ref, store) => listSessions(cfg, ref, store).length;

/** Where listSessions looked, for the "no session" error: the transcript dirs, else (no agent
 * of the profile keeps transcripts) the agents' plain error, or usage.jsonl when one resumes from it.
 * @param {import('../types/index.js').Config} cfg @param {string} ref @param {any} store */
export function lookedIn(cfg, ref, store) {
  try {
    return `looked in ${sessionDirs(cfg, ref, store).map((d) => d.dir).join(", ")}`;
  } catch (e) {
    const agents = [agentFor(cfg), ...(cfg.pipeline ?? []).filter((s) => !s.manual).map((s) => agentFor(cfg, s))];
    return agents.some((a) => a.resumeCommand) ? "looked in usage.jsonl" : e.message;
  }
}

/** Pick a session by exact id, unique prefix, or 1-based list index.
 * @param {{id: string, step: string, remote?: {harness: string, host: string, cwd?: string}}[]} sessions @param {string} sel */
function select(sessions, sel) {
  const exact = sessions.find((s) => s.id === sel);
  if (exact) return exact;
  const pref = sessions.filter((s) => s.id.startsWith(sel));
  if (pref.length === 1) return pref[0];
  if (pref.length > 1) throw new Error(`ambiguous session "${sel}" — ${pref.length} match; use more chars`);
  if (/^\d+$/.test(sel)) {
    const i = Number(sel) - 1;
    if (i >= 0 && i < sessions.length) return sessions[i];
  }
  return null;
}

/** The agent that wrote a session: its tagged `agent` (listSessions), else its step's (a
 * step renamed since → the profile's agent).
 * @param {Pick<import('../types/index.js').Config, 'agent'|'pipeline'>} cfg @param {{step: string, agent?: string, remote?: unknown}} session */
function sessionAgent(cfg, session) {
  const step = (cfg.pipeline ?? []).find((s) => s.id === session.step);
  return { step, agent: session.agent ? getAgent(session.agent) : agentFor(cfg, step) };
}

/** Why a drained worktree must come back before resuming a session: an agent with transcripts
 * (claude, cursor) finds its session by the worktree it ran in; one without (hermes, opencode)
 * keeps sessions in its own store, so it just needs to run there again — plus, for an isolated
 * hermes step, where its session actually lives (its own `HERMES_HOME`, not the worktree).
 * @param {Pick<import('../types/index.js').Config, 'agent'|'pipeline'|'stateDir'|'dataDir'>} cfg @param {{step: string, agent?: string}} session */
export function drainedReason(cfg, session) {
  const { step, agent } = sessionAgent(cfg, session);
  const name = agent.describe().name;
  const base = agent.sessions ? `${name} finds the session by its working directory` : `${name} runs in the worktree`;
  const homeDir = agent.env?.({ cfg, step })?.HERMES_HOME;
  return homeDir ? `${base}; its session lives in HERMES_HOME=${homeDir}, which the command sets` : base;
}

/** The resume argv (after the binary) for one session, from the agent that wrote it: its
 * transcripts' `resumeCommand`, else its top-level one (no transcripts, ids from usage.jsonl).
 * Throws for an agent with neither.
 * @param {Pick<import('../types/index.js').Config, 'agent'|'pipeline'>} cfg @param {{id: string, step: string, agent?: string}} session */
export function resumeArgs(cfg, session) {
  const { agent } = sessionAgent(cfg, session);
  const cmd = agent.sessions?.resumeCommand ?? agent.resumeCommand;
  return cmd ? cmd(session.id) : agentSessions(agent).resumeCommand(session.id);
}

/**
 * How to resume one session: the binary + env of the step that ran it (a step `bin`/`env`
 * overrides the agent's default bin, else cfg.claudeBin / adds to process.env, as at spawn),
 * the printable command, and — when the step sets env — a note naming its keys only (values
 * may be secrets; never printed). The agent's own env (`agent.env`, e.g. an isolated hermes
 * step's HERMES_HOME — a path, not a secret) sits under the step's and is printed inline.
 * Pure; exported for tests.
 * @param {Pick<import('../types/index.js').Config, 'agent'|'claudeBin'|'pipeline'|'stateDir'|'dataDir'>} cfg
 * @param {{id: string, step: string, agent?: string}} session @param {string} wt  the worktree (the agent's cwd)
 * @returns {{bin: string, env: Record<string, string>|undefined, line: string, envNote: string|null}}
 */
export function resumeCommand(cfg, session, wt) {
  const { step, agent } = sessionAgent(cfg, session);
  const bin = step?.bin ?? agent.defaults.bin ?? cfg.claudeBin;
  const stepEnv = step?.env && Object.keys(step.env).length ? step.env : undefined;
  const agentEnv = Object.fromEntries(Object.entries(agent.env?.({ cfg, step }) ?? {}).filter(([k]) => !stepEnv || !(k in stepEnv)));
  const env = stepEnv || Object.keys(agentEnv).length ? { ...agentEnv, ...(stepEnv ?? {}) } : undefined;
  const prefix = Object.entries(agentEnv).map(([k, v]) => `${k}=${v} `).join("");
  return {
    bin,
    env,
    line: `cd ${wt} && ${prefix}${[bin, ...resumeArgs(cfg, session)].join(" ")}   # ${session.step}`,
    envNote: stepEnv ? `step "${session.step}" sets env ${Object.keys(stepEnv).join(", ")} for its agent — export them too (--exec does)` : null,
  };
}

/** The one-line error both `follow` and `resume` share for a worker ssh that can't connect
 * (exit 255, or the ssh binary itself failing): names host + harness + the first stderr line.
 * @param {import('../types/index.js').RemoteHarness} remote @param {string} harnessName @param {unknown} e
 * @returns {Error} */
export function unreachableWorker(remote, harnessName, e) {
  const msg = e instanceof Error ? e.message.split("\n").map((l) => l.trim()).find(Boolean) ?? "" : String(e);
  return new Error(`worker ${remote.host} (harness "${harnessName}") unreachable: ${msg || "ssh failed"}`);
}

/** `resume <ref> <sel>` on a REMOTE session (#830): the session's worktree lived on the
 * worker, and `syncAfter` removes it after every run — so "gone" is the normal case for a
 * finished run. Present: the agent's own resume argv runs interactively over
 * `sshInteractiveArgv` (the only tty variant; `BatchMode=yes`, never `-A`) with the
 * executor's client env — NEVER the step's `env` or agent.env. Gone: say so, exit non-zero,
 * and print the operator's two options (re-run the step, or hand-recreate the dir) plus the
 * no-sync-back warning. Never recreates the dir or starts a fresh session automatically.
 * @param {import('../types/index.js').Config} cfg @param {{id: string, step: string, agent?: string}} session
 * @param {{harness: string, host: string, cwd?: string}} remoteInfo @param {string} ref @param {boolean} exec @param {string} bin the launch bin (`remote.bin` or the agent's default)
 * @returns {Promise<void>} */
async function resumeRemote(cfg, session, remoteInfo, ref, exec, bin) {
  const { harness, host, cwd } = remoteInfo;
  const remote = cfg.harnesses?.[harness]?.remote;
  if (!remote || remote.host !== host) throw new Error(`harness "${harness}" (host "${host}") is no longer in the config — its worker can't be reached`);
  if (!cwd) throw new Error(`can't locate this run's directory on ${host} (recorded before agenthook tracked a remote run's worker dir in usage.jsonl)`);
  const pipeline = cfg.pipeline ?? [];
  const i = pipeline.findIndex((s) => s.id === session.step);
  const step = i >= 0 ? pipeline[i] : undefined;
  // Whether the run lived in a worktree (the bare repo keeps its branch) is read from the
  // recorded cwd itself — a worktree run's cwd is the worktree path, an export run's is not —
  // so option 2 (hand `git worktree add`) is offered exactly when the run was in a worktree.
  const repoId = refRepo(cfg, ref).id;
  const hasWorktree = cwd === remoteRunPaths(remote, cfg.stateKey, { ref, stepId: session.step, hasWorktree: true, repoId }).cwd;
  const paths = remoteRunPaths(remote, cfg.stateKey, { ref, stepId: session.step, hasWorktree, repoId });

  // Probe first — the run is finished/hold when you resume, so the dir usually is gone.
  const probe = spawnSync("ssh", remoteProbeArgv(remote, `test -d ${shQuote(cwd)}`), { encoding: "utf8", env: sshClientEnv({ tty: false }) });
  if (probe.error) throw unreachableWorker(remote, harness, probe.error);
  if (probe.status !== 0 && probe.status !== 1) {
    throw unreachableWorker(remote, harness, probe.stderr?.trim().split("\n").find(Boolean) ?? `ssh exited ${probe.status}`);
  }
  if (probe.status !== 0) {
    console.log(`the worker's synced worktree ${cwd} on ${host} was removed after the run`);
    console.log("options:");
    console.log(`  1. re-run the step from the tracker (a new run recreates the worktree); or`);
    if (hasWorktree && paths.bareRepo) {
      console.log(`  2. recreate it by hand on ${host}, then resume:`);
      console.log(`       git -C ${paths.bareRepo} worktree add ${cwd} ${branchName(ref, cfg.branchPrefix)}`);
      console.log(`       agenthook resume ${ref} ${session.id} --exec`);
    }
    console.log("\nwarning: commits made in a hand-resumed worker session do NOT sync back to the hub, and the next run force-pushes over them.");
    process.exitCode = 1;
    return;
  }

  const argv = sshInteractiveArgv(remote, `cd ${shQuote(cwd)} && exec ${shQuote(bin)} ${resumeArgs(cfg, session).map(shQuote).join(" ")}`);
  const stepEnv = step?.env && Object.keys(step.env).length ? Object.keys(step.env) : null;
  // Printed on BOTH paths: the note is about what does NOT reach the worker, so it applies
  // whether you run the ssh or copy it. Keys only — never values.
  if (stepEnv) console.log(`  note: step "${session.step}" sets env ${stepEnv.join(", ")} for its agent — NOT forwarded to the worker`);
  if (exec) {
    const r = spawnSync("ssh", argv, { stdio: "inherit", env: sshClientEnv({ tty: true }) });
    if (r.error) throw r.error;
    process.exitCode = r.status ?? 0;
    return;
  }
  console.log(`ssh ${argv.join(" ")}`);
}

/** @param {any} args */
export async function resume(args) {
  const cfg = loadConfig({ configPath: args.config });
  const store = createStore(cfg.dataDir); // sticky ref → repo (multi-repo); refRepo falls back without it
  const ref = args._[0];
  const sel = args._[1];

  // No ref → recent runs across all refs (one row per ref).
  if (!ref) {
    const runs = recentRuns(cfg, args.limit ? Number(args.limit) : 10);
    if (!runs.length) {
      console.log("no agent runs recorded yet (no per-run logs under the profile's logDir).");
      return;
    }
    console.log(`${pad("REF", 22)}${pad("LAST STEP", 12)}${pad("LAST RUN", 12)}${pad("WT", 10)}SESSIONS`);
    for (const r of runs) {
      const present = fs.existsSync(worktreePath(cfg, r.ref, refRepo(cfg, r.ref, store)));
      console.log(
        `${pad(r.ref, 22)}${pad(r.step, 12)}${pad(ago(iso(r.at)), 12)}` +
          `${pad(present ? "present" : "drained", 10)}${sessionCount(cfg, r.ref, store)}`,
      );
    }
    console.log(`\nlist a ref's sessions:  agenthook resume <ref>`);
    return;
  }

  const sessions = listSessions(cfg, ref, store);
  if (!sessions.length) throw new Error(`no recorded agent session for ref ${ref} (${lookedIn(cfg, ref, store)})`);
  const wt = worktreePath(cfg, ref, refRepo(cfg, ref, store));
  const present = fs.existsSync(wt);

  // ref only → list the ref's sessions and how to resume each.
  if (!sel) {
    console.log(`sessions for ref ${ref}  (worktree: ${present ? wt : "drained — recreate before resuming"})\n`);
    console.log(`${pad("#", 3)}${pad("STEP", 10)}${pad("AGE", 10)}${pad("MSGS", 6)}${pad("SESSION", 38)}FIRST PROMPT`);
    sessions.forEach((s, i) => {
      console.log(
        `${pad(i + 1, 3)}${pad(s.step, 10)}${pad(ago(iso(s.at)), 10)}${pad(s.msgs, 6)}${pad(s.id + (s.remote ? ` @${s.remote.host}` : ""), 38)}${clip(s.prompt, 50)}`,
      );
    });
    console.log(`\nresume one:  agenthook resume ${ref} <#|session-id> [--exec]`);
    return;
  }

  // ref + selection → resolve to one session, print or run its resume command.
  const chosen = select(sessions, sel);
  if (!chosen) throw new Error(`no session "${sel}" for ref ${ref}. Run \`agenthook resume ${ref}\` to list them.`);

  // A remote session (#830): the worktree and transcript both live on the worker — a different
  // code path (probe the dir, resume over sshInteractiveArgv; never the step's env).
  if (chosen.remote) {
    const remote = cfg.harnesses?.[chosen.remote.harness]?.remote;
    const agent = sessionAgent(cfg, chosen).agent;
    return resumeRemote(cfg, chosen, chosen.remote, ref, !!args.exec, remote?.bin || agent.defaults.bin || "claude");
  }

  const cmd = resumeCommand(cfg, chosen, wt);
  if (args.exec) {
    if (!present)
      throw new Error(
        `worktree for ${ref} is drained (${wt}). Recreate it (re-run the step, or \`git worktree add\`) before resuming — ${drainedReason(cfg, chosen)}.`,
      );
    const r = spawnSync(cmd.bin, resumeArgs(cfg, chosen), { cwd: wt, stdio: "inherit", env: { ...process.env, ...(cmd.env ?? {}) } });
    if (r.error) throw r.error;
    process.exitCode = r.status ?? 0;
    return;
  }

  console.log(cmd.line);
  if (cmd.envNote) console.log(`  note: ${cmd.envNote}`);
  if (!present)
    console.log(`\n⚠ worktree is drained — recreate ${wt} before this works (${drainedReason(cfg, chosen)}).`);
}
