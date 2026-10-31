// End-to-end smoke: a REAL receiver (`agenthook start`, as a child process — the engine calls
// process.exit on shutdown) against the `local` tracker and a stub agent (test/fixtures/
// stub-agent.mjs, a step `bin`; never a model). Each scenario enters a backlog ticket through
// the control-socket `run` op; from there the loop is the production one: in-process push →
// queue → dispatch spawns the stub → verdict → adapter.advance → the next step fires → done.
// Waits are event-driven (events.jsonl via waitForEvents, the receiver's stdout) — no sleeps.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { controlRequest } from "../src/ui/control-client.js";
import { waitForEvents } from "../src/agent-api.js";
import { readProfileState, buildRows } from "../src/ui/rows.js";
import { promptPathFor } from "../src/dispatch/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "agenthook.js");
const STUB = path.join(HERE, "fixtures", "stub-agent.mjs");
const NAME = "e2e";
const SCENARIO_MS = 15000; // hard per-scenario deadline (the whole file runs in a few seconds)

// One ref per scenario; the stub reads its verdicts per (ref, step) from this script.
const HELD_OPTIONS = ["Postgres", "SQLite"];
const SCRIPT = {
  happy: { triage: ["advance"], code: ["advance"], review: ["advance"] },
  loop: { triage: ["advance"], code: ["advance"], review: ["changes"] },
  hold: { triage: ["hold"] },
  crash: { triage: ["advance"], code: ["exit1"] },
  resting: { triage: ["advance"], code: ["advance"], review: ["advance"] },
  // #565: a hold with a clickable answer, then `release` resumes it with that answer as the comment.
  answer: { triage: [{ outcome: "hold", summary: { options: HELD_OPTIONS } }, "advance"], code: ["advance"], review: ["advance"] },
  // Blockers: two tickets added through `ticket_add` (numeric refs 1 and 2), 2 blocked by 1.
  1: { triage: ["advance"], code: ["advance"], review: ["advance"] },
  2: { triage: ["advance"], code: ["advance"], review: ["advance"] },
};
/** Created by the chain scenario itself (ticket_add), never seeded or `run`. */
const ADDED = new Set(["1", "2"]);
// Seeded straight into triage before boot (a ticket added while the receiver was down): boot
// never fires it — only an explicit `reconcile` does.
const RESTING = "resting";

/** @type {string} */ let root;
/** @type {string} */ let repo;
/** @type {string} */ let stateDir;
/** @type {string} */ let worktrees;
/** @type {string} */ let sock;
/** @type {import('node:child_process').ChildProcess | null} */ let child = null;
/** @type {Promise<void>} */ let exited;
let output = "";
/** @type {Array<() => void>} */ let outputWaiters = [];
let failed = false;

const git = (/** @type {string[]} */ args, /** @type {string} */ cwd) => execFileSync("git", args, { cwd, stdio: "pipe" });

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

/** Resolve once the receiver's combined stdout/stderr matches `re` (rejects at the deadline or
 * if the receiver dies). @param {RegExp} re @param {number} [timeoutMs] @returns {Promise<RegExpMatchArray>} */
function waitForOutput(re, timeoutMs = SCENARIO_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      outputWaiters = outputWaiters.filter((w) => w !== check);
      reject(new Error(`timed out waiting for receiver output ${re}`));
    }, timeoutMs);
    const check = () => {
      const m = output.match(re);
      if (m) {
        clearTimeout(timer);
        outputWaiters = outputWaiters.filter((w) => w !== check);
        resolve(m);
      } else if (child?.exitCode != null || child?.signalCode != null) {
        clearTimeout(timer);
        outputWaiters = outputWaiters.filter((w) => w !== check);
        reject(new Error(`receiver exited (${child.exitCode ?? child.signalCode}) while waiting for ${re}`));
      }
    };
    outputWaiters.push(check);
    check();
  });
}

/** Every event for `ref` up to and including the first of `types` (from the start of the file).
 * @param {string} ref @param {string[]} types */
async function eventsUntil(ref, types) {
  const deadline = Date.now() + SCENARIO_MS;
  /** @type {Record<string, any>[]} */
  const seen = [];
  let cursor = 0;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`timed out waiting for ${types.join("|")} on ${ref}; saw ${seen.map((e) => e.event).join(",")}`);
    const r = await waitForEvents(stateDir, cursor, { ref, types: null, limit: 1000, timeoutMs: left });
    cursor = r.cursor;
    for (const e of r.events) {
      seen.push(e);
      if (types.includes(e.event)) return seen;
    }
  }
}

/** Wait for the board move that follows `step`'s `outcome`, then return the ticket's stage.
 * @param {string} ref @param {string} step @param {string} outcome */
async function stageAfter(ref, step, outcome) {
  const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await waitForOutput(new RegExp(`\\[stage\\] moved ${esc(ref)} -> \\S+ \\(${esc(step)}:${esc(outcome)}`));
  return JSON.parse(fs.readFileSync(path.join(stateDir, "local-board.json"), "utf8"))[ref]?.stage;
}

const runEnds = (/** @type {Record<string, any>[]} */ events) => events.filter((e) => e.event === "run_end").map((e) => `${e.step}:${e.outcome}`);

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-e2e-")));
  repo = path.join(root, "repo");
  worktrees = path.join(root, "worktrees");
  const home = path.join(root, "home");
  stateDir = path.join(home, NAME);
  fs.mkdirSync(repo);
  fs.mkdirSync(stateDir, { recursive: true });

  git(["init", "-q", "-b", "master"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "e2e\n");
  git(["add", "README.md"], repo);
  git(["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "init"], repo);

  const scriptFile = path.join(root, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
  const port = await freePort();
  /** @param {string} id @param {Record<string, any>} extra */
  const agentStep = (id, extra) => ({ id, sourceStatus: id, failureStatus: "blocked", holdStatus: "held", bin: STUB, env: { STUB_STEP: id, STUB_SCRIPT: scriptFile }, ...extra });
  const config = {
    name: NAME,
    repoPath: repo,
    worktreePrefix: worktrees,
    port,
    maxConcurrent: Object.keys(SCRIPT).length,
    ingress: { type: "manual", url: `http://127.0.0.1:${port}` },
    tracker: {
      type: "local",
      pipeline: [
        agentStep("triage", { successStatus: "code" }),
        agentStep("code", { successStatus: "review", createsWorktree: true, maxAttempts: 2 }),
        agentStep("review", { successStatus: "done" }),
        { id: "done", manual: true, sourceStatus: "done", drainWorktree: true },
      ],
    },
  };
  const configPath = path.join(root, "agenthook.config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  // The board, seeded before boot. `backlog` is bound by no step, so nothing fires until `run`.
  /** @type {Record<string, any>} */
  const board = {};
  for (const ref of Object.keys(SCRIPT).filter((r) => !ADDED.has(r))) board[ref] = { name: `e2e ${ref}`, description: `scenario ${ref}`, stage: ref === RESTING ? "triage" : "backlog" };
  fs.writeFileSync(path.join(stateDir, "local-board.json"), JSON.stringify(board, null, 2));

  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, AGENTHOOK_HOME: home };
  delete env.AGENTHOOK_VERDICT_FILE;
  child = spawn(process.execPath, [BIN, "start", "--config", configPath], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  exited = new Promise((resolve) => child?.once("exit", () => resolve()));
  const onData = (/** @type {Buffer} */ chunk) => {
    output += chunk.toString("utf8");
    for (const w of [...outputWaiters]) w();
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.once("exit", () => {
    for (const w of [...outputWaiters]) w();
  });

  await waitForOutput(new RegExp(`agenthook \\[${NAME}\\] listening on 127\\.0\\.0\\.1:${port}`));
  sock = path.join(stateDir, "control.sock");
  // Enter every scenario up front; they run in parallel (maxConcurrent = #scenarios).
  for (const ref of Object.keys(SCRIPT).filter((r) => r !== RESTING && !ADDED.has(r))) {
    const reply = await controlRequest(sock, "run", { ref });
    assert.equal(reply.ok, true, `run ${ref}: ${!reply.ok ? reply.error : ""}`);
  }
});

after(async () => {
  if (child && child.exitCode == null && child.signalCode == null) {
    child.kill("SIGTERM");
    const killer = setTimeout(() => child?.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(killer);
  }
  if (failed) console.error(`--- receiver output ---\n${output}--- end receiver output ---`);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** A scenario test that dumps the receiver output when it fails. @param {string} name @param {() => Promise<void>} fn */
const scenario = (name, fn) =>
  test(name, async () => {
    try {
      await fn();
    } catch (e) {
      failed = true;
      throw e;
    }
  });

scenario("happy: triage → code → review → done drains the worktree", async () => {
  const events = await eventsUntil("happy", ["pipeline_done", "failed", "blocked"]);
  assert.equal(events.at(-1)?.event, "pipeline_done");
  assert.deepEqual(runEnds(events), ["triage:advance", "code:advance", "review:advance"]);
  const board = JSON.parse(fs.readFileSync(path.join(stateDir, "local-board.json"), "utf8"));
  assert.equal(board.happy.stage, "done");
  assert.equal(fs.existsSync(path.join(worktrees, "happy")), false, "worktree removed");

  // #596: review reuses the worktree `code` created, so it must get the real branch too.
  const logsDir = path.join(stateDir, "logs");
  const reviewLog = fs
    .readdirSync(logsDir)
    .find((f) => f.endsWith("-step-review-happy.log"));
  const prompt = fs.readFileSync(promptPathFor(path.join(logsDir, /** @type {string} */ (reviewLog))), "utf8");
  assert.ok(prompt.includes('branch "agent/happy"'), "review prompt names the real branch");
  assert.ok(!prompt.includes("undefined"), "review prompt never renders branch undefined");
});

scenario("chain: ticket_add --blocked-by rests the dependent until the blocker reaches done, then fires it in-process", async () => {
  const head = await controlRequest(sock, "ticket_add", { title: "chain head" });
  assert.equal(head.ok, true, `ticket_add head: ${!head.ok ? head.error : ""}`);
  assert.deepEqual(head.ok && head.result, { ref: "1", step: "triage", stage: "triage" });
  const tail = await controlRequest(sock, "ticket_add", { title: "chain tail", blockedBy: ["1"] });
  assert.equal(tail.ok, true, `ticket_add tail: ${!tail.ok ? tail.error : ""}`);
  assert.deepEqual(tail.ok && tail.result, { ref: "2", step: "triage", stage: "triage", blockedBy: ["1"] });

  const tailEvents = await eventsUntil("2", ["pipeline_done", "failed", "blocked"]);
  assert.equal(tailEvents.at(-1)?.event, "pipeline_done");
  assert.deepEqual(runEnds(tailEvents), ["triage:advance", "code:advance", "review:advance"]);
  assert.match(output, /\[unblock\] 1 done → firing 2 \(triage\)/);
  // Ordering: the tail's first run started only after the head's last agent step advanced it into
  // `done` (the manual step's drain job runs alongside the released tail — pipeline_done may land later).
  const all = fs.readFileSync(path.join(stateDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const headDone = all.findIndex((e) => e.ref === "1" && e.event === "run_end" && e.step === "review");
  const tailStart = all.findIndex((e) => e.ref === "2" && e.event === "run_start");
  assert.ok(headDone >= 0 && tailStart > headDone, `tail started (idx ${tailStart}) before head reached done (idx ${headDone})`);
  const board = JSON.parse(fs.readFileSync(path.join(stateDir, "local-board.json"), "utf8"));
  assert.equal(board["1"].stage, "done");
  assert.equal(board["2"].stage, "done");
  assert.deepEqual(board["2"].blockedBy, ["1"]);
});

scenario("changes: review → code loop stops at the code step's maxAttempts", async () => {
  const events = await eventsUntil("loop", ["failed", "pipeline_done", "blocked"]);
  const end = events.at(-1);
  assert.equal(end?.event, "failed");
  assert.equal(end?.step, "review");
  assert.match(String(end?.reason), /changes loop hit cap \(2\)/);
  assert.equal(events.filter((e) => e.event === "run_start" && e.step === "code").length, 2);
  // run_end carries the agent's own verdict; the cap turns the second `changes` into `failed` after it.
  assert.deepEqual(runEnds(events), ["triage:advance", "code:advance", "review:changes", "code:advance", "review:changes"]);
  assert.equal(await stageAfter("loop", "review", "fail"), "blocked");
});

scenario("hold: a hold verdict parks the ticket in the hold lane", async () => {
  const events = await eventsUntil("hold", ["blocked", "failed", "pipeline_done"]);
  assert.equal(events.at(-1)?.event, "blocked");
  assert.equal(events.at(-1)?.step, "triage");
  assert.deepEqual(runEnds(events), ["triage:hold"]);
  assert.equal(await stageAfter("hold", "triage", "hold"), "held");
  const held = JSON.parse(fs.readFileSync(path.join(stateDir, "held.json"), "utf8"));
  assert.equal(held.hold?.stepId, "triage");
});

scenario("answer: a hold's options reach run_end + TicketRow.options, and release resumes it with the chosen option (#565)", async () => {
  const held = await eventsUntil("answer", ["blocked"]);
  const holdEnd = held.find((e) => e.event === "run_end" && e.step === "triage");
  assert.deepEqual(holdEnd?.options, HELD_OPTIONS, "run_end carries the verdict's summary.options");
  assert.equal(await stageAfter("answer", "triage", "hold"), "held");

  const row = buildRows(NAME, readProfileState(stateDir)).find((r) => r.ref === "answer");
  assert.equal(row?.status, "held");
  assert.deepEqual(row?.options, HELD_OPTIONS, "TicketRow.options mirrors the hold run_end");

  const chosen = HELD_OPTIONS[0];
  const reply = await controlRequest(sock, "release", { ref: "answer", comment: chosen });
  assert.equal(reply.ok, true, `release: ${!reply.ok ? reply.error : ""}`);

  // Excludes "blocked" from the wait: the first triage run already produced one above, and
  // eventsUntil re-scans the ref's whole tail from the start on each call.
  const events = await eventsUntil("answer", ["pipeline_done", "failed"]);
  assert.equal(events.at(-1)?.event, "pipeline_done");
  assert.deepEqual(runEnds(events), ["triage:hold", "triage:advance", "code:advance", "review:advance"]);

  const logsDir = path.join(stateDir, "logs");
  const triageLogs = fs
    .readdirSync(logsDir)
    .filter((f) => f.endsWith("-step-triage-answer.log"))
    .sort();
  assert.equal(triageLogs.length, 2, "one log per triage run (held, then resumed)");
  const prompt = fs.readFileSync(promptPathFor(path.join(logsDir, /** @type {string} */ (triageLogs.at(-1)))), "utf8");
  assert.ok(prompt.includes(chosen), "the resumed run's prompt carries the owner's chosen option verbatim");
});

scenario("crash: a non-zero agent exit fails the step", async () => {
  const events = await eventsUntil("crash", ["failed", "blocked", "pipeline_done"]);
  assert.equal(events.at(-1)?.event, "failed");
  assert.equal(events.at(-1)?.step, "code");
  assert.deepEqual(runEnds(events), ["triage:advance", "code:fail"]);
  assert.equal(await stageAfter("crash", "code", "fail"), "blocked");
});

// Last, so every other scenario has settled and the resting ticket is the only one left in a
// step's source stage.
scenario("reconcile: a ticket left resting while the receiver was down runs to done", async () => {
  const reply = await controlRequest(sock, "reconcile", {});
  assert.equal(reply.ok, true, `reconcile: ${!reply.ok ? reply.error : ""}`);
  assert.equal(reply.result.replayed, 1, "boot did not fire it; reconcile queued exactly it");
  const events = await eventsUntil(RESTING, ["pipeline_done", "failed", "blocked"]);
  assert.equal(events.at(-1)?.event, "pipeline_done");
  assert.deepEqual(runEnds(events), ["triage:advance", "code:advance", "review:advance"]);
});
