#!/usr/bin/env node
// Release smoke: what a stranger does with the shipped package, at machine speed.
//
//   node test/release/smoke.mjs [--tarball <path>] [--no-build] [--agent stub|claude]
//                               [--upgrade-from <version>] [--keep] [--json <file>]
//
// The unit/e2e suites run from source and drive the receiver directly; this runs the PACKED
// tarball, installed into an isolated prefix with its own AGENTHOOK_HOME, against a toy repo
// whose path has a space in it. Phases:
//
//   pack       npm pack (after build:ui) — required/forbidden files, every relative import and
//              bare dependency of the shipped code resolvable from the package alone, the UI
//              bundle's assets present; diff vs the latest published version (informational).
//   install    npm i -g into the prefix; `agenthook --version` matches package.json.
//   hints      every `agenthook <cmd>` named in shipped strings and the docs is a real command.
//   quickstart docs/quickstart.md's `agenthook …` lines run verbatim, back to back, no pauses
//              (init gets --yes --full-auto); `doctor` clean; every ticket reaches done; the
//              doc's `git log` line shows the change; `ui` serves.
//   tour       (stub only) scripted fail → blocked, hold → held, changes → code again → done.
//   remedy     stop the receiver, `ticket add`, then follow every `agenthook …` hint the CLI
//              printed, in order — the ticket must reach done.
//   ops        status / ls, `restart` at idle comes back, a ticket after the restart runs.
//   teardown   stop, remove --purge, nothing left running or registered.
//   upgrade    (--upgrade-from) the old version boots a profile, then this one takes it over.
//   long-path  a profile whose control.sock path is past the sun_path limit: `start` must refuse
//              it with a clear message and leave nothing running (Node would silently bind a
//              truncated path — at some lengths onto the state dir itself, #439).
//
// --agent stub (default) uses test/fixtures/stub-agent.mjs as every step's `bin` — no model,
// seconds per ticket; that is what CI runs. --agent claude uses the real CLI (fullAuto, in the
// throwaway repo; costs a few cents per ticket) and skips the scripted tour. Exit 1 on any
// failed phase; the temp dir is kept on failure (or with --keep) for inspection.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";
import { waitForEvents } from "../../src/agent-api.js";
import { readProfile } from "../../src/heartbeat.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STUB = path.join(ROOT, "test", "fixtures", "stub-agent.mjs");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const args = parseArgs(process.argv.slice(2));
const AGENT = args.agent === "claude" ? "claude" : "stub";
const TICKET_MS = AGENT === "stub" ? 30_000 : 400_000;

/** @type {{phase: string, status: "pass"|"fail"|"skip", detail: string[]}[]} */
const report = [];
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ah-smoke-")));
const prefix = path.join(base, "prefix");
const work = path.join(base, "my project"); // a space on purpose
const home = path.join(base, "h");
const env = { ...process.env, PATH: `${path.join(prefix, "bin")}${path.delimiter}${process.env.PATH}`, AGENTHOOK_HOME: home, NO_COLOR: "1" };
delete env.AGENTHOOK_VERDICT_FILE;
delete env.npm_config_prefix;

let tarball = "";
let pkgDir = "";
let name = "";
let stateDir = "";
let script = /** @type {Record<string, Record<string, any[]>>} */ ({ "*": { code: ["advance"], review: ["advance"] } });
const scriptFile = path.join(base, "stub-script.json");
/** @type {string[]} */
const failures = [];
class Stop extends Error {}
let repoDir = base;

try {
  await phase("pack", packPhase);
  await phase("install", installPhase);
  await phase("hints", hintsPhase);
  await phase("quickstart", quickstartPhase);
  if (AGENT === "stub") await phase("tour", tourPhase);
  else skip("tour", "scripted verdicts need --agent stub");
  await phase("remedy", remedyPhase);
  await phase("ops", opsPhase);
  await phase("teardown", teardownPhase);
  await phase("long-path", longPathPhase);
  if (args["upgrade-from"]) await phase("upgrade", upgradePhase);
} catch (e) {
  if (!(e instanceof Stop)) throw e;
} finally {
  if (stateDir && readProfile(name, home).up) sh(`agenthook stop`, { cwd: work });
}
finish();

// ── phases ──────────────────────────────────────────────────────────────────────────────

/** @param {string[]} d */
async function packPhase(d) {
  if (args.tarball) {
    tarball = path.resolve(String(args.tarball));
  } else {
    if (!args["no-build"]) must(sh("npm run -s build:ui", { cwd: ROOT, env: process.env, timeoutMs: 300_000 }), "build:ui");
    const r = must(sh(`npm pack --json --pack-destination ${q(base)}`, { cwd: ROOT, env: process.env, timeoutMs: 120_000 }), "npm pack");
    tarball = path.join(base, JSON.parse(r.out.slice(r.out.indexOf("[")))[0].filename);
  }
  pkgDir = path.join(base, "pkg");
  fs.mkdirSync(pkgDir);
  must(sh(`tar xzf ${q(tarball)} -C ${q(pkgDir)} --strip-components=1`, { cwd: base }), "untar");
  const files = walk(pkgDir).map((f) => path.relative(pkgDir, f).split(path.sep).join("/"));
  d.push(`${path.basename(tarball)}: ${files.length} files, ${(fs.statSync(tarball).size / 1024).toFixed(0)} KB`);

  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const required = ["package.json", "README.md", "LICENSE", "ui/dist/index.html", ...Object.values(pkg.bin || {}).map((b) => String(b).replace(/^\.\//, ""))];
  for (const f of required) if (!files.includes(f)) fail(`missing from the package: ${f}`);
  for (const entry of pkg.files || []) if (!files.some((f) => f === entry || f.startsWith(`${entry}/`))) fail(`package.json "files" entry ships nothing: ${entry}`);
  const forbidden = [/^test\//, /(^|\/)\.env(\.|$)/, /(^|\/)agenthook\.config\.json$/, /^config\.json$/, /(^|\/)INSTRUCTIONS(_[A-Z]+)?\.md$/, /^\.claude\//, /^\.github\//, /^docs\/img\//, /^logs\//, /\.tgz$/];
  for (const f of files) if (forbidden.some((re) => re.test(f))) fail(`must not ship: ${f}`);

  // Shipped code must run from the package alone: relative imports resolve inside it, bare ones
  // are node builtins or declared runtime dependencies (a devDependency here breaks npx users).
  const deps = new Set(Object.keys(pkg.dependencies || {}));
  const builtins = new Set(builtinModules);
  for (const f of files.filter((f) => /^(src|bin)\/.*\.m?js$/.test(f))) {
    const text = fs.readFileSync(path.join(pkgDir, f), "utf8");
    for (const m of text.matchAll(/(?:^|[\s;])(?:import|export)\s[^"'`;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm)) {
      const spec = m[1] || m[2];
      if (spec.startsWith(".")) {
        if (!fs.existsSync(path.resolve(path.dirname(path.join(pkgDir, f)), spec))) fail(`${f} imports ${spec}, which is not in the package`);
      } else if (!spec.startsWith("node:") && !builtins.has(spec)) {
        const bare = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        if (!deps.has(bare)) fail(`${f} imports "${spec}", not a runtime dependency`);
      }
    }
  }
  const index = fs.readFileSync(path.join(pkgDir, "ui/dist/index.html"), "utf8");
  for (const m of index.matchAll(/(?:src|href)="\/?(assets\/[^"]+)"/g)) if (!files.includes(`ui/dist/${m[1]}`)) fail(`ui/dist/index.html references missing ${m[1]}`);

  // Informational: what changed against the latest published version.
  const prev = sh(`npm pack ${PKG.name}@latest --dry-run --json`, { cwd: base, env: process.env, timeoutMs: 60_000 });
  if (prev.code === 0) {
    try {
      const p = JSON.parse(prev.out.slice(prev.out.indexOf("[")))[0];
      const norm = (/** @type {string} */ f) => f.replace(/^ui\/dist\/assets\/.*/, "ui/dist/assets/*");
      const before = new Set(p.files.map((/** @type {any} */ x) => norm(x.path)));
      const now = new Set(files.map(norm));
      const added = [...now].filter((f) => !before.has(f));
      const removed = [...before].filter((f) => !now.has(f));
      d.push(`vs ${p.version}: +${added.length} -${removed.length} files${added.length ? ` | added: ${added.slice(0, 12).join(", ")}` : ""}${removed.length ? ` | removed: ${removed.slice(0, 12).join(", ")}` : ""}`);
    } catch {}
  } else d.push("vs latest published: unavailable (offline?)");
}

/** @param {string[]} d */
async function installPhase(d) {
  must(sh(`npm i -g --prefix ${q(prefix)} --no-audit --no-fund --silent ${q(tarball)}`, { cwd: base, timeoutMs: 300_000 }), "npm i -g");
  const v = must(sh("agenthook --version", { cwd: base }), "agenthook --version").out.trim();
  if (v !== PKG.version) fail(`agenthook --version printed "${v}", package.json says ${PKG.version}`);
  d.push(`agenthook ${v} at ${path.join(prefix, "bin", "agenthook")}`);
}

/** @param {string[]} d */
async function hintsPhase(d) {
  const bin = fs.readFileSync(path.join(pkgDir, "bin", "agenthook.js"), "utf8");
  const table = bin.match(/const COMMANDS = \{([^}]*)\}/)?.[1] ?? "";
  const commands = new Set(table.split(",").map((t) => t.split(":")[0].trim().replace(/^"|"$/g, "")).filter(Boolean));
  if (!commands.size) return fail("could not read the COMMANDS table from bin/agenthook.js");
  const sources = [
    ...walk(path.join(pkgDir, "src")).filter((f) => f.endsWith(".js")),
    path.join(ROOT, "README.md"),
    ...walk(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md") && !f.includes(`${path.sep}experiments${path.sep}`) && !f.includes(`${path.sep}launch${path.sep}`)),
  ];
  let named = 0;
  for (const f of sources) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/`(?:agenthook|ah) ([a-z][a-z-]*)\b/g)) {
      named++;
      if (!commands.has(m[1])) fail(`${path.relative(f.startsWith(pkgDir) ? pkgDir : ROOT, f)} names \`agenthook ${m[1]}\` — no such command`);
    }
  }
  d.push(`${named} command mentions checked against ${commands.size} commands`);
}

/** @param {string[]} d */
async function quickstartPhase(d) {
  fs.mkdirSync(work, { recursive: true });
  const repo = path.join(work, "toy");
  fs.mkdirSync(repo);
  setRepo(repo);
  git(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  fs.writeFileSync(path.join(repo, "math.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./math.js";\n\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n');
  fs.writeFileSync(path.join(repo, "package.json"), '{ "type": "module", "scripts": { "test": "node --test" } }\n');
  git(["add", "-A"]);
  git(["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-q", "-m", "init"]);

  const lines = bashLines(fs.readFileSync(path.join(ROOT, "docs", "quickstart.md"), "utf8"));
  const initLine = lines.find((l) => /^agenthook init\b/.test(l));
  if (!initLine) return fail("docs/quickstart.md has no `agenthook init` line");
  let block = lines.filter((l) => /^agenthook /.test(l) && !/^agenthook (init|ui|stop)\b/.test(l));
  if (AGENT === "claude") {
    // A real agent would (rightly) hold on the doc's illustrative tickets the toy repo can't
    // satisfy; keep the first `ticket add`, the one the toy repo is built for.
    const adds = block.filter((l) => /^agenthook ticket add\b/.test(l));
    block = block.filter((l) => !adds.slice(1).includes(l));
    if (adds.length > 1) d.push(`claude: skipped ${adds.length - 1} illustrative ticket(s): ${adds.slice(1).join(" | ")}`);
  }
  const gitLines = lines.filter((l) => /^git /.test(l) && l.includes("<ref>"));
  for (const l of block) for (const m of l.matchAll(/--file (\S+)/g)) fs.writeFileSync(path.join(repo, m[1]), "notes for the ticket body\n");

  const init = run(`${initLine}${/--yes\b/.test(initLine) ? "" : " --yes"}${/--full-auto\b/.test(initLine) ? "" : " --full-auto"}`, d);
  const cfgPath = path.join(repo, "agenthook.config.json");
  if (init.code !== 0 || !fs.existsSync(cfgPath)) return;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  name = cfg.name;
  stateDir = path.join(home, name);
  if (!init.out.includes(stateDir.replace(os.homedir(), "~"))) fail(`init's summary does not name the real state dir (${stateDir})`);
  if (AGENT === "stub") {
    for (const s of cfg.tracker.pipeline) if (!s.manual) Object.assign(s, { bin: STUB, env: { STUB_STEP: s.id, STUB_SCRIPT: scriptFile } });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  }
  const tickets = block.filter((l) => /^agenthook ticket add\b/.test(l)).length;
  script[String(tickets + 1)] = { code: ["fail"] };
  script[String(tickets + 2)] = { code: ["hold"] };
  script[String(tickets + 3)] = { code: ["advance"], review: ["changes", "advance"] };
  fs.writeFileSync(scriptFile, JSON.stringify(script));

  const doctor = run("agenthook doctor", d);
  // Warnings are fine (CI has no `claude`, which only the Digest needs there); problems are not.
  if (!/all good|no problems/.test(doctor.out)) fail(`\`doctor\` found problems on a fresh profile:\n${tail(doctor.out, 20)}`);

  // The documented commands, back to back — no pause after `start --detach`.
  for (const l of block) {
    const r = run(l, d);
    // The contract, checked the instant it returns: a command typed next must reach the receiver.
    if (/^agenthook start\b.*--detach/.test(l) && r.code === 0 && !readProfile(name, home).up) fail(`\`${l}\` returned before the receiver was serving — the next command races its boot`);
    if (/No receiver running/.test(r.out)) fail(`\`${l}\` ran right after start but found no receiver (boot race)`);
  }
  const refs = ticketRefs();
  if (refs.length !== tickets) fail(`expected ${tickets} ticket(s) on the board, found ${refs.length}`);
  for (const ref of refs) await expectEnd(ref, "pipeline_done", d);

  for (const l of gitLines) {
    const r = sh(l.replace(/<ref>/g, refs[0] ?? "1"), { cwd: repo });
    if (r.code !== 0 || !/diff --git/.test(r.out)) fail(`\`${l}\` (ref ${refs[0]}) shows no change:\n${tail(r.out)}`);
    else d.push(`\`${l}\` → ${r.out.split("\n").length} lines of diff`);
  }
  await checkUi(d);
}

/** @param {string[]} d */
async function tourPhase(d) {
  const [failRef, holdRef, changesRef] = [1, 2, 3].map((n) => String(ticketRefs().length + n));
  run(`agenthook ticket add "tour: the code agent fails"`, d);
  await expectEnd(failRef, "failed", d, "blocked");
  run(`agenthook ticket add "tour: the code agent asks a question"`, d);
  await expectEnd(holdRef, "blocked", d, "held");
  run(`agenthook ticket add "tour: review sends it back once"`, d);
  await expectEnd(changesRef, "pipeline_done", d, "done");
  const codeRuns = Number(fs.readFileSync(`${scriptFile}.counts.${changesRef}.code`, "utf8"));
  if (codeRuns !== 2) fail(`changes should re-run code once (2 code runs), saw ${codeRuns}`);
}

/** @param {string[]} d */
async function remedyPhase(d) {
  must(sh("agenthook stop", { cwd: repoDir }), "stop");
  const ref = String(ticketRefs().length + 1);
  const added = run(`agenthook ticket add "add a multiply(a, b) function to math.js, with a test"`, d);
  const hints = [...added.out.matchAll(/`(agenthook [^`]+)`/g)].map((m) => m[1]).filter((h) => !h.includes("<"));
  if (!hints.length) return fail("`ticket add` with the receiver stopped offered no remedy");
  d.push(`hints, followed in order: ${hints.join(" → ")}`);
  for (const h of hints) {
    const r = run(h, d);
    if (/does not support|has no \w+ support|not supported|unknown command/i.test(r.out)) fail(`the CLI's own hint \`${h}\` is unsupported here:\n${tail(r.out)}`);
  }
  await expectEnd(ref, "pipeline_done", d);
}

/** @param {string[]} d */
async function opsPhase(d) {
  if (!/UP/.test(run("agenthook status", d).out)) fail("`status` does not show the profile UP");
  if (!run("agenthook ls", d).out.includes(name)) fail("`ls` does not list the profile");
  const before = readProfile(name, home).pid;
  run("agenthook restart", d);
  const back = await until(() => {
    const p = readProfile(name, home);
    return p.up && p.pid !== before;
  }, 30_000);
  if (!back) return fail(`\`restart\` at idle: no new receiver within 30 s (pid was ${before})`);
  d.push(`restarted: pid ${before} → ${readProfile(name, home).pid}`);
  if (AGENT !== "stub") return;
  const ref = String(ticketRefs().length + 1);
  run(`agenthook ticket add "ops: a ticket after the restart"`, d);
  await expectEnd(ref, "pipeline_done", d);
}

/** @param {string[]} d */
async function teardownPhase(d) {
  const pid = readProfile(name, home).pid;
  run("agenthook stop", d);
  if (await until(() => !readProfile(name, home).up, 10_000)) d.push(`receiver ${pid} gone`);
  else fail(`receiver ${pid} still alive after stop`);
  run(`agenthook remove ${name} --purge --yes`, d);
  if (fs.existsSync(stateDir)) fail(`state dir survived remove --purge: ${stateDir}`);
  if (!/no profiles/.test(run("agenthook ls", d).out)) fail("`ls` still lists a profile after remove --purge");
}

/** @param {string[]} d */
async function longPathPhase(d) {
  const longHome = path.join(base, "L".repeat(Math.max(1, 120 - base.length - "/".length - "/long/control.sock".length)));
  const repo = path.join(work, "long");
  fs.mkdirSync(repo);
  setRepo(repo);
  git(["init", "-q", "-b", "main"]);
  git(["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);
  const e = { ...env, AGENTHOOK_HOME: longHome };
  sh("agenthook init --local --yes --name long", { cwd: repo, env: e });
  const r = sh("agenthook start --detach", { cwd: repo, env: e, timeoutMs: 60_000 });
  d.push(`$ agenthook start --detach (control.sock ${Buffer.byteLength(path.join(longHome, "long", "control.sock"))} bytes)  → exit ${r.code}`);
  if (r.code === 0 || !/too long/.test(r.out)) fail(`an over-long control.sock path was not refused clearly (exit ${r.code}):\n${tail(r.out)}`);
  if (readProfile("long", longHome).up) {
    fail("a receiver is running on the over-long path");
    sh("agenthook stop", { cwd: repo, env: e });
  }
}

/** @param {string[]} d */
async function upgradePhase(d) {
  const from = String(args["upgrade-from"]);
  const oldPrefix = path.join(base, "prefix-old");
  must(sh(`npm i -g --prefix ${q(oldPrefix)} --no-audit --no-fund --silent ${PKG.name}@${from}`, { cwd: base, env: process.env, timeoutMs: 300_000 }), `install ${from}`);
  const repo = path.join(work, "upgrade");
  fs.mkdirSync(repo);
  setRepo(repo);
  git(["init", "-q", "-b", "main"]);
  git(["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);
  const port = await freePort();
  name = "upgrade";
  stateDir = path.join(home, name);
  const step = (/** @type {string} */ id, /** @type {any} */ extra) => ({ id, sourceStatus: id, failureStatus: "blocked", holdStatus: "held", bin: STUB, env: { STUB_STEP: id, STUB_SCRIPT: scriptFile }, ...extra });
  const config = {
    name, repoPath: repo, port, maxConcurrent: 1,
    ingress: { type: "manual", url: `http://127.0.0.1:${port}` },
    tracker: { type: "local", pipeline: [step("code", { successStatus: "review", createsWorktree: true }), step("review", { successStatus: "done" }), { id: "done", manual: true, sourceStatus: "done", drainWorktree: true }] },
  };
  fs.writeFileSync(path.join(repo, "agenthook.config.json"), JSON.stringify(config, null, 2));
  const old = path.join(oldPrefix, "bin", "agenthook");
  run(`${q(old)} start --detach`, d);
  if (!(await until(() => readProfile(name, home).up, 20_000))) return fail(`${from} did not boot the profile (see ${path.join(stateDir, "receiver.log")})`);
  run(`${q(old)} stop`, d);
  await until(() => !readProfile(name, home).up, 10_000);
  const doctor = run("agenthook doctor", d);
  if (doctor.code !== 0) fail(`doctor on the ${from} state dir exited ${doctor.code}`);
  run("agenthook start --detach", d);
  run(`agenthook ticket add "upgrade: first ticket on ${PKG.version}"`, d);
  await expectEnd(ticketRefs()[0] ?? "1", "pipeline_done", d);
  run("agenthook stop", d);
  run(`agenthook remove ${name} --purge --yes`, d);
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────

/** @param {string} label @param {(d: string[]) => Promise<void>} fn */
async function phase(label, fn) {
  /** @type {string[]} */
  const detail = [];
  const failsBefore = failures.length;
  try {
    await fn(detail);
  } catch (e) {
    if (!(e instanceof Stop)) failures.push(e.stack || String(e));
  }
  const mine = failures.slice(failsBefore);
  report.push({ phase: label, status: mine.length ? "fail" : "pass", detail: [...detail, ...mine.map((m) => `✗ ${m}`)] });
  console.log(`${mine.length ? "✗" : "✓"} ${label}`);
  for (const line of mine) console.log(`    ${line.split("\n").join("\n    ")}`);
  // Later phases need a package, an install and a profile; any other failure lets them run.
  if (mine.length && (["pack", "install"].includes(label) || (label === "quickstart" && !readProfile(name || "-", home).up))) throw new Stop();
}

/** @param {string} label @param {string} why */
function skip(label, why) {
  report.push({ phase: label, status: "skip", detail: [why] });
  console.log(`- ${label} (skipped: ${why})`);
}

/** @param {string} msg */
function fail(msg) {
  failures.push(msg);
}

function finish() {
  const failed = report.filter((r) => r.status === "fail");
  if (args.json) fs.writeFileSync(path.resolve(String(args.json)), JSON.stringify({ version: PKG.version, agent: AGENT, base, ok: !failed.length, phases: report }, null, 2));
  if (failed.length || args.keep) console.log(`\ntemp dir kept: ${base}`);
  else fs.rmSync(base, { recursive: true, force: true });
  console.log(failed.length ? `\nrelease smoke FAILED (${failed.map((r) => r.phase).join(", ")})` : `\nrelease smoke passed (${report.filter((r) => r.status === "pass").length} phases, agent ${AGENT})`);
  process.exit(failed.length ? 1 : 0);
}

/** @param {string} dir */
function setRepo(dir) {
  repoDir = dir;
}
/** @param {string[]} a */
function git(a) {
  const r = spawnSync("git", a, { cwd: repoDir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
}

/**
 * Run a shell line with the isolated PATH/AGENTHOOK_HOME; stdout+stderr combined.
 * @param {string} cmd @param {{cwd: string, env?: NodeJS.ProcessEnv, timeoutMs?: number}} o
 */
function sh(cmd, { cwd, env: e = env, timeoutMs = 120_000 }) {
  const r = spawnSync("bash", ["-c", `${cmd} 2>&1`], { cwd, env: e, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: r.stdout ?? "" };
}

/** A CLI line in the toy repo, logged to the phase detail; a non-zero exit is a failure. @param {string} cmd @param {string[]} d */
function run(cmd, d) {
  const r = sh(cmd, { cwd: repoDir });
  d.push(`$ ${cmd}  → exit ${r.code}`);
  if (r.code !== 0) fail(`\`${cmd}\` exited ${r.code}:\n${tail(r.out)}`);
  return r;
}

/** @param {{code: number, out: string}} r @param {string} what */
function must(r, what) {
  if (r.code !== 0) {
    fail(`${what} failed (exit ${r.code}):\n${tail(r.out)}`);
    throw new Stop();
  }
  return r;
}

function ticketRefs() {
  const r = sh("agenthook ticket ls --json", { cwd: repoDir });
  try {
    return JSON.parse(r.out).map((/** @type {any} */ t) => String(t.ref));
  } catch {
    return [];
  }
}

/**
 * Wait (fs.watch on events.jsonl, via agent-api) for the ref's first terminal event; it must be
 * `want`, and the board must then show `stage` when given.
 * @param {string} ref @param {string} want @param {string[]} d @param {string} [stage]
 */
async function expectEnd(ref, want, d, stage) {
  const terminal = ["pipeline_done", "failed", "blocked"];
  const deadline = Date.now() + TICKET_MS;
  const t0 = Date.now();
  let cursor = 0;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return fail(`#${ref}: no ${want} within ${TICKET_MS / 1000} s (board: ${sh("agenthook ticket ls", { cwd: repoDir }).out.trim()})`);
    const r = await waitForEvents(stateDir, cursor, { ref, types: null, limit: 1000, timeoutMs: left });
    cursor = r.cursor;
    const end = r.events.find((/** @type {any} */ e) => terminal.includes(e.event));
    if (!end) continue;
    if (end.event !== want) return fail(`#${ref}: expected ${want}, got ${end.event}${end.reason ? ` (${end.reason})` : ""}`);
    d.push(`#${ref} → ${want} (waited ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    if (stage) {
      const ok = await until(() => sh("agenthook ticket ls --json", { cwd: repoDir }).out.includes(`"ref":"${ref}","stage":"${stage}"`) || boardStage(ref) === stage, 10_000);
      if (!ok) fail(`#${ref}: expected stage ${stage}, board shows ${boardStage(ref)}`);
    }
    return;
  }
}

/** @param {string} ref */
function boardStage(ref) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, "local-board.json"), "utf8"))[ref]?.stage;
  } catch {
    return undefined;
  }
}

/** `agenthook ui` serves the dashboard on its token URL. @param {string[]} d */
async function checkUi(d) {
  const port = await freePort();
  const child = spawn("agenthook", ["ui", "--no-open", "--port", String(port)], { cwd: repoDir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  try {
    const url = await until(() => out.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0], 10_000);
    if (!url) return fail(`\`agenthook ui\` printed no URL:\n${tail(out)}`);
    const res = await fetch(url);
    const html = await res.text();
    if (res.status !== 200 || !/<div id="root"|<script/.test(html)) fail(`\`agenthook ui\` answered ${res.status} without the app`);
    else d.push(`ui: 200 on ${url.replace(/token=\S+/, "token=…")}`);
    if (/⚠/.test(out)) fail(`\`agenthook ui\` warned:\n${tail(out)}`);
  } finally {
    child.kill();
  }
}

/** Markdown ```bash block lines, comments stripped. @param {string} md */
function bashLines(md) {
  const out = [];
  for (const m of md.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g))
    for (const raw of m[1].split("\n")) {
      const l = raw.replace(/\s+#\s.*$/, "").trim();
      if (l) out.push(l);
    }
  return out;
}

/** @template T @param {() => T} fn @param {number} ms @returns {Promise<T | undefined>} */
async function until(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return undefined;
    await new Promise((r) => setTimeout(r, 200));
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {net.AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
  });
}

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/** @param {string} s */
function q(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** @param {string} s */
function tail(s, n = 12) {
  return s.trim().split("\n").slice(-n).join("\n");
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (["tarball", "agent", "upgrade-from", "json"].includes(key) && next && !next.startsWith("--")) o[key] = argv[++i];
    else o[key] = true;
  }
  return o;
}
