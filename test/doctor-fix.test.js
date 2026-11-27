import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Doctor — `doctor --fix` (#446): one fixable problem detected → fixed → clean on re-run.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { applyFixes, fixableCount, report, instructionLints, ingressChecks, ingressLivenessLints, runChecks } from "../src/commands/doctor.js";
import { worktreeDir } from "../src/paths.js";
import { loadConfig } from "../src/config/index.js";
import { instructionTargets } from "../src/heartbeat.js";
import { tmp, POSIX, DEAD_PID, git, cleanProfile, recorder, io, problem, silent } from "./_doctor-helpers.js";

// --- doctor --fix (#446) ---

/** name → mtime + mode for everything under each dir (missing dirs → nothing). @param {string[]} dirs */
function snapshot(dirs) {
  /** @type {Record<string, string>} */
  const out = {};
  /** @param {string} p */
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    out[p] = `${st.mtimeMs}:${st.mode}`;
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
  };
  dirs.forEach(walk);
  return out;
}

/** The shared fixer contract: exactly one fixable problem (matching `label`) before → `fixed:` →
 * none after → a second `--fix` finds nothing and changes nothing.
 * @param {any} cfg @param {RegExp} label @param {any} opts @param {string[]} watch dirs to snapshot */
async function fixCycle(cfg, label, opts, watch) {
  const before = await runChecks(cfg, opts);
  assert.deepEqual(before.filter(problem).map((c) => c.label).filter((l) => label.test(l)).length, 1, "detected");
  assert.equal(before.filter(problem).length, 1, `only the planted problem: ${before.filter(problem).map((c) => c.label)}`);
  assert.equal(fixableCount(before), 1);
  const lines = await applyFixes(before, silent);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^fixed: /);
  const after = await runChecks(cfg, opts);
  assert.deepEqual(after.filter(problem), [], "clean after the fix");
  const snap = snapshot(watch);
  assert.deepEqual(await applyFixes(after, silent), [], "second run detects nothing");
  assert.deepEqual(snapshot(watch), snap, "second run changes nothing");
}

/** Leave a unix socket file with no listener (a SIGKILLed child can't unlink it). @param {string} sock */
function deadSocket(sock) {
  spawnSync(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(sock)}, () => process.kill(process.pid, "SIGKILL"))`]);
  assert.ok(fs.existsSync(sock), "socket file left behind");
}

test("doctor --fix: a clean profile has no problems and nothing to fix", async () => {
  const { cfg } = cleanProfile();
  const checks = await runChecks(cfg, io());
  assert.deepEqual(checks.filter(problem), []);
  assert.deepEqual(await applyFixes(checks, silent), []);
});

test("doctor --fix: state dir with group/other bits → chmod 0700", { skip: !POSIX }, async () => {
  const { cfg } = cleanProfile();
  fs.chmodSync(cfg.stateDir, 0o755);
  await fixCycle(cfg, /^state dir is private/, io(), [cfg.stateDir]);
  assert.equal(fs.statSync(cfg.stateDir).mode & 0o777, 0o700);
});

test("doctor --fix: a missing state dir is ℹ, not a problem", async () => {
  const { cfg } = cleanProfile();
  fs.rmSync(cfg.stateDir, { recursive: true });
  const checks = await runChecks(cfg, io());
  assert.deepEqual(checks.filter(problem), []);
  assert.ok(checks.some((c) => c.info && /state dir not created yet/.test(c.label)));
});

test("doctor --fix: pidfile naming a dead pid → removed", async () => {
  const { cfg } = cleanProfile();
  fs.writeFileSync(cfg.pidFile, `${DEAD_PID}\n`);
  await fixCycle(cfg, /^stale pidfile$/, io(), [cfg.stateDir]);
  assert.ok(!fs.existsSync(cfg.pidFile));
});

test("doctor --fix: a live pid's pidfile is left alone", async () => {
  const { cfg } = cleanProfile();
  fs.writeFileSync(cfg.pidFile, `${process.pid}\n`);
  const checks = await runChecks(cfg, io({ portInUse: async () => false }));
  assert.ok(!checks.some((c) => /pidfile/.test(c.label)));
});

test("doctor --fix: control.sock with no listener and no live pid → removed", { skip: !POSIX }, async () => {
  const { cfg } = cleanProfile();
  deadSocket(cfg.controlSock);
  await fixCycle(cfg, /^stale control socket$/, io(), [cfg.stateDir]);
  assert.ok(!fs.existsSync(cfg.controlSock));
});

test("doctor --fix: a listening control.sock (receiver booting, no pid yet) is not stale", { skip: !POSIX }, async () => {
  const { cfg } = cleanProfile();
  const server = net.createServer((s) => s.destroy());
  await new Promise((r) => server.listen(cfg.controlSock, () => r(undefined)));
  try {
    const checks = await runChecks(cfg, io());
    assert.ok(!checks.some((c) => /control socket/.test(c.label)), "not flagged");
    assert.deepEqual(await applyFixes(checks, silent), []);
    assert.ok(fs.existsSync(cfg.controlSock), "not removed");
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
  }
});

test("doctor --fix: a missing instruction file (and its dir) → created from INSTRUCTIONS.example.md", async () => {
  const { cfg, root } = cleanProfile();
  fs.rmSync(path.join(root, "prompts"), { recursive: true });
  const target = path.join(root, "prompts", "CODE.md");
  await fixCycle(cfg, /^instructions file exists: .*CODE\.md$/, io(), [root]);
  assert.equal(fs.readFileSync(target, "utf8"), fs.readFileSync(path.join(cfg.installDir, "INSTRUCTIONS.example.md"), "utf8"));
});

test("doctor --fix: a missing instruction file is ⚠ (runs get empty instructions); the SOUL file is never checked", async () => {
  const { cfg, root } = cleanProfile();
  fs.rmSync(path.join(root, "INSTRUCTIONS.md"));
  const lints = instructionLints(cfg);
  assert.deepEqual(lints.map((l) => [l.level, l.label]), [["warn", `instructions file exists: ${path.join(root, "INSTRUCTIONS.md")}`]]);
  assert.ok(!fs.existsSync(cfg.digest.soul), "no SOUL.md, yet no lint for it");
});

test("doctor --fix: never overwrites an instruction file (incl. one created after detection)", async () => {
  const { cfg, root } = cleanProfile();
  const code = path.join(root, "prompts", "CODE.md");
  const dflt = path.join(root, "INSTRUCTIONS.md");
  fs.rmSync(code);
  const keep = fs.readFileSync(dflt);
  const [lint] = instructionLints(cfg);
  fs.writeFileSync(code, "written in between\n"); // a race: the file appears before apply runs
  await /** @type {any} */ (lint.fix).apply(); // EEXIST counts as fixed — no throw, no overwrite
  assert.equal(fs.readFileSync(code, "utf8"), "written in between\n");
  fs.rmSync(code);
  await applyFixes(await runChecks(cfg, io()), silent);
  assert.deepEqual(fs.readFileSync(dflt), keep, "existing file byte-identical");
});

test("doctor --fix: a missing worktree base → created", async () => {
  const { cfg } = cleanProfile();
  const base = worktreeDir(cfg);
  fs.rmSync(base, { recursive: true });
  await fixCycle(cfg, /^worktree base exists: /, io(), [path.dirname(base)]);
  assert.ok(fs.statSync(base).isDirectory());
});

test("doctor --fix: a prunable worktree under the base → `git -C <repo> worktree prune`, branch kept", async () => {
  const { cfg, repo } = cleanProfile();
  const wt = path.join(worktreeDir(cfg), "42");
  git(repo, ["worktree", "add", "-q", "-b", "agent/42", wt]);
  fs.rmSync(wt, { recursive: true });
  const rec = recorder(true);
  await fixCycle(cfg, /^prunable worktrees$/, io({ spawn: rec.spawn }), [worktreeDir(cfg)]);
  assert.deepEqual(rec.calls, [{ cmd: "git", args: ["-C", repo, "worktree", "prune"], cwd: undefined }]);
  assert.ok(!git(repo, ["worktree", "list", "--porcelain"]).includes(wt), "admin entry gone");
  assert.equal(git(repo, ["branch", "--list", "agent/42"]).trim(), "agent/42", "branch kept");
});

test("doctor --fix: a UI bundle the build can't fix → can't fix with the manual command", async () => {
  const { cfg } = cleanProfile();
  const checks = await runChecks(cfg, io({ uiBundle: () => ({ state: "missing" }), spawn: () => ({ status: 1 }) }));
  assert.deepEqual(await applyFixes(checks, silent), [`can't fix: UI bundle built — run \`npm run build:ui\` in ${cfg.installDir}`]);
});

/** A profile with every auto-fixable problem planted at once. */
function brokenProfile() {
  const p = cleanProfile();
  const { cfg, root, repo } = p;
  if (POSIX) fs.chmodSync(cfg.stateDir, 0o755);
  fs.writeFileSync(cfg.pidFile, `${DEAD_PID}\n`);
  if (POSIX) deadSocket(cfg.controlSock);
  fs.rmSync(path.join(root, "prompts"), { recursive: true });
  const wt = path.join(worktreeDir(cfg), "7");
  git(repo, ["worktree", "add", "-q", "-b", "agent/7", wt]);
  fs.rmSync(worktreeDir(cfg), { recursive: true }); // base missing + its worktree prunable
  return p;
}

test("doctor --fix --dry-run: one `would fix:` line per fixable problem, zero side effects", async () => {
  const { cfg, root, repo } = brokenProfile();
  const rec = recorder();
  const opts = io({ uiBundle: () => ({ state: "stale", newest: "App.tsx" }), spawn: rec.spawn });
  const checks = await runChecks(cfg, opts);
  const watch = [cfg.stateDir, root, ...instructionTargets(cfg).map((t) => t.path)];
  const snap = snapshot(watch);
  const lines = await applyFixes(checks, { dryRun: true, log: () => {} });
  assert.equal(lines.length, POSIX ? 7 : 5);
  assert.ok(lines.every((l) => l.startsWith("would fix: ")), lines.join("\n"));
  assert.ok(lines.includes(`would fix: prunable worktrees — git -C ${repo} worktree prune`));
  assert.deepEqual(snapshot(watch), snap);
  assert.deepEqual(rec.calls, [], "no child process spawned");
});

test("doctor --fix: every apply writes only inside the state dir, a worktree base, or a missing instruction path", async () => {
  const { cfg, repo } = brokenProfile();
  const rec = recorder();
  const checks = await runChecks(cfg, io({ uiBundle: () => ({ state: "missing" }), spawn: rec.spawn }));
  const missing = instructionTargets(cfg).filter((t) => t.scope !== "soul" && !fs.existsSync(t.path)).map((t) => t.path);
  assert.ok(missing.length);
  const allowed = new Set([...missing, ...missing.map((m) => path.dirname(m))]);
  const roots = [cfg.stateDir, worktreeDir(cfg)];
  /** @param {string} p */
  const ok = (p) => allowed.has(path.resolve(p)) || roots.some((r) => path.resolve(p) === r || path.resolve(p).startsWith(r + path.sep));

  /** @type {string[]} */
  const touched = [];
  const f = /** @type {any} */ (fs);
  const names = ["writeFileSync", "copyFileSync", "mkdirSync", "rmSync", "chmodSync", "renameSync", "openSync", "appendFileSync", "unlinkSync", "rmdirSync"];
  const orig = Object.fromEntries(names.map((n) => [n, f[n]]));
  for (const n of names) {
    f[n] = (/** @type {any[]} */ ...a) => {
      const writeFlag = n !== "openSync" || /[wa+]/.test(String(a[1] ?? "r"));
      if (writeFlag) touched.push(String(n === "copyFileSync" || n === "renameSync" ? a[1] : a[0]));
      return orig[n].apply(fs, a);
    };
  }
  /** @type {string[]} */
  let lines;
  try {
    lines = await applyFixes(checks, silent);
  } finally {
    Object.assign(f, orig);
  }
  assert.ok(lines.every((l) => l.startsWith("fixed: ")), lines.join("\n"));
  assert.ok(touched.length);
  assert.deepEqual(touched.filter((p) => !ok(p)), [], "every write is confined");
  assert.deepEqual(rec.calls, [
    { cmd: "npm", args: ["run", "build:ui"], cwd: cfg.installDir },
    { cmd: "git", args: ["-C", repo, "worktree", "prune"], cwd: undefined },
  ]);
});

test("doctor --fix: token, binaries, port, bindings are never auto-fixed — `can't fix:` + the command, nothing written", async () => {
  const root = tmp();
  const file = path.join(root, "agenthook.config.json");
  const pipeline = [{ id: "code", sourceSectionGid: "TODO_SOURCE", successSectionGid: "2" }];
  fs.writeFileSync(file, JSON.stringify({ name: `ah-doctor-manual-${process.pid}`, repoPath: root, ingress: { type: "manual", url: "http://x" }, tracker: { type: "asana", token: "", pipeline } }));
  fs.writeFileSync(path.join(root, ".env"), "OTHER=1\n");
  fs.writeFileSync(path.join(root, "INSTRUCTIONS.md"), "rules\n");
  const cfg = loadConfig({ configPath: file });
  const checks = await runChecks(cfg, io({ onPath: () => false, portInUse: async () => true, isAlive: () => false }));
  const snap = snapshot([root]);
  const lines = await applyFixes(checks, silent);
  assert.deepEqual(snapshot([root]), snap, "no file under the config dir (incl. .env) written");
  assert.ok(lines.every((l) => l.startsWith("can't fix: ")), lines.join("\n"));
  for (const want of [
    /^can't fix: tracker token resolved \(asana\) — set tracker\.token to a \$\{VAR\} ref, .*re-run doctor$/,
    /^can't fix: repoPath is a git repo: .* — point repoPath at a git checkout/,
    /^can't fix: claude binary on PATH: claude \(steps: code\) — install claude or put it on PATH$/,
    new RegExp(`^can't fix: port ${cfg.port} is free — stop whatever listens on port ${cfg.port}`),
    /^can't fix: pipeline bindings filled — fill code\.sourceSectionGid in the config/,
  ]) assert.ok(lines.some((l) => want.test(l)), `${want} in\n${lines.join("\n")}`);
  assert.equal(fixableCount(checks), 0);
});

test("doctor: the summary names how many problems --fix can handle, only when > 0", async () => {
  const { cfg } = cleanProfile();
  /** @param {any[]} checks */
  const out = (checks) => {
    /** @type {string[]} */
    const lines = [];
    report(checks, { log: (l) => lines.push(l) });
    return lines;
  };
  assert.ok(!out(await runChecks(cfg, io())).some((l) => /doctor --fix/.test(l)));
  fs.writeFileSync(cfg.pidFile, `${DEAD_PID}\n`);
  fs.rmSync(worktreeDir(cfg), { recursive: true });
  const lines = out(await runChecks(cfg, io()));
  assert.equal(lines.at(-1), "2 can be fixed with `agenthook doctor --fix`");
  assert.equal(lines.at(-2), "\nno problems; 2 warning(s).");
  assert.ok(!out(await runChecks(cfg, io())).slice(0, -1).some((l) => /doctor --fix/.test(l)));
  const quiet = [];
  report(await runChecks(cfg, io()), { hint: false, log: (l) => quiet.push(l) });
  assert.ok(!quiet.some((l) => /doctor --fix/.test(l)), "no hint in the post-fix report");
});

test("ingressChecks: tailscale needs only its binary, not ingress.url", () => {
  const seen = [];
  const checks = ingressChecks({ type: "tailscale" }, (bin) => (seen.push(bin), true));
  assert.deepEqual(checks, [{ ok: true, label: "tailscale binary on PATH", manual: "install tailscale or put it on PATH (or set $TAILSCALE)" }]);
  assert.deepEqual(seen, ["tailscale"]);
  assert.equal(ingressChecks({ type: "tailscale" }, () => false)[0].ok, false);
});

test("ingressLivenessLints: warns with a manual restart fix when up and ingressDown; [] otherwise", () => {
  const down = ingressLivenessLints({ up: true, heartbeat: { ingress: "cloudflared", ingressDown: { at: "2026-01-02T00:00:00.000Z", reason: "exited (1)" } } });
  assert.equal(down.length, 1);
  assert.equal(down[0].level, "warn");
  assert.match(down[0].label, /ingress tunnel is down/);
  assert.match(down[0].note, /cloudflared.*exited \(1\).*2026-01-02T00:00:00\.000Z/);
  assert.deepEqual(down[0].fix, { manual: "run `agenthook restart`" });

  assert.deepEqual(ingressLivenessLints({ up: false, heartbeat: { ingress: "cloudflared", ingressDown: { at: "x", reason: "y" } } }), []);
  assert.deepEqual(ingressLivenessLints({ up: true, heartbeat: { ingress: "cloudflared" } }), []);
  assert.deepEqual(ingressLivenessLints({ up: true, heartbeat: null }), []);
});

