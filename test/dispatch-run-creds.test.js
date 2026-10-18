import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Per-run credentials (#474) through the real dispatcher: a fake adapter/forge `runCredentials`
// stub, a fake `claude` sh script that dumps its env. No network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../src/dispatch.js";
import { createStore } from "../src/store.js";

const DUMPED = ["GH_CONFIG_DIR", "GIT_CONFIG_COUNT", "GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK"];

/**
 * @param {{script?: string, step?: any, runCredentials?: any, forgeRunCredentials?: any, killGraceMs?: number}} o
 */
function harness({ script = `printf '%s' '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"`, step = {}, runCredentials, forgeRunCredentials, killGraceMs = 200 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-run-creds-"));
  const bin = path.join(dir, "fake-claude.sh");
  const out = path.join(dir, "env.out");
  const dump = DUMPED.map((n) => `"${n}=\${${n}-unset}"`).join(" ");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' ${dump} > "${out}"\n${script}\n`, { mode: 0o755 });
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", ...step }, { id: "done", manual: true }],
    claudeBin: bin,
    repoPath: dir,
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
  });
  const store = createStore(dir);
  /** @type {any[]} */
  const advanced = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment", agentEnv: ["GITHUB_TOKEN"] }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "https://github.com/o/r/issues/42", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ _ref, /** @type {string} */ _step, /** @type {any} */ v) => advanced.push(v),
    ...(runCredentials ? { runCredentials } : {}),
  });
  const forge = forgeRunCredentials ? /** @type {any} */ ({ describe: () => ({ name: "github", agentEnv: ["GH_TOKEN", "GITHUB_TOKEN"] }), runCredentials: forgeRunCredentials }) : null;
  const run = createDispatcher(cfg, adapter, undefined, store, () => {}, forge, undefined, { killGraceMs });
  const read = () => (fs.existsSync(out) ? Object.fromEntries(fs.readFileSync(out, "utf8").trim().split("\n").map((l) => /** @type {[string, string]} */ (l.split(/=(.*)/s).slice(0, 2)))) : null);
  const logText = () => fs.readdirSync(dir).filter((f) => f.endsWith(".log")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("");
  return { dir, store, run, advanced, read, logText };
}

/** A runCredentials stub recording its calls and disposes. @param {Record<string,string>} [env] */
function credsStub(env = {}) {
  const seen = { calls: /** @type {any[]} */ ([]), disposed: 0 };
  const fn = async (/** @type {any} */ o) => {
    seen.calls.push(o);
    return {
      env: { GH_CONFIG_DIR: path.join(o.dir, "gh"), GIT_CONFIG_COUNT: "4", ...env },
      strip: ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK"],
      label: "GitHub App token: o/r (contents:write), expires 14:05 UTC",
      dispose: async () => {
        seen.disposed++;
      },
    };
  };
  return { fn, seen };
}

/** Run with the receiver's env holding GITHUB_TOKEN/GH_TOKEN/SSH_AUTH_SOCK (all allowlisted by #470). @param {() => Promise<any>} fn */
async function withReceiverEnv(fn) {
  const names = ["GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  Object.assign(process.env, { GITHUB_TOKEN: "operator-pat", GH_TOKEN: "operator-gh", SSH_AUTH_SOCK: "/tmp/agent.sock" });
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

const job = { kind: /** @type {const} */ ("pipeline"), ref: "42", stepId: "code", dedupKey: "k" };

test("run creds: the child sees GH_CONFIG_DIR + GIT_CONFIG_COUNT and none of the operator's tokens; the label is logged; dispose once", async () => {
  const { fn, seen } = credsStub();
  const h = harness({ runCredentials: fn });
  await withReceiverEnv(() => h.run(job));
  const got = h.read();
  assert.equal(got?.GH_CONFIG_DIR, path.join(h.dir, "run-creds", "42-code", "gh"));
  assert.equal(got?.GIT_CONFIG_COUNT, "4");
  assert.equal(got?.GITHUB_TOKEN, "unset", "stripped though #470 allowlisted it");
  assert.equal(got?.GH_TOKEN, "unset");
  assert.equal(got?.SSH_AUTH_SOCK, "unset");
  assert.match(h.logText(), /\[agenthook\] GitHub App token: o\/r \(contents:write\), expires 14:05 UTC/);
  assert.equal(seen.disposed, 1);
  assert.deepEqual(h.advanced.map((v) => v.outcome), ["advance"]);
  const o = seen.calls[0];
  assert.equal(o.ref, "42");
  assert.equal(o.step.id, "code");
  assert.equal(o.task.url, "https://github.com/o/r/issues/42");
  assert.equal(o.repoPath, h.dir);
  assert.equal(o.dir, path.join(h.dir, "run-creds", "42-code"));
  o.log("a refresh line");
  assert.match(h.logText(), /\[agenthook\] a refresh line/);
});

test("run creds: a step env GH_TOKEN still reaches the child (the operator's explicit choice)", async () => {
  const { fn } = credsStub();
  const h = harness({ runCredentials: fn, step: { env: { GH_TOKEN: "step-pat" } } });
  await withReceiverEnv(() => h.run(job));
  assert.equal(h.read()?.GH_TOKEN, "step-pat");
  assert.equal(h.read()?.GITHUB_TOKEN, "unset");
});

test("run creds: dispose runs once after a timeout kill", async () => {
  const { fn, seen } = credsStub();
  const h = harness({ runCredentials: fn, script: "exec sleep 5", step: { maxMinutes: 0.001 } });
  await withReceiverEnv(() => h.run(job));
  assert.match(h.advanced[0].reason, /^timeout/);
  assert.equal(seen.disposed, 1);
});

test("run creds: dispose runs once after an operator cancel", async () => {
  const { fn, seen } = credsStub();
  const h = harness({ runCredentials: fn, script: "exec sleep 30" });
  await withReceiverEnv(async () => {
    const done = h.run(job);
    for (let i = 0; i < 200 && !h.store.listRunning()["42"]?.pid; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(h.run.cancel("42"), true);
    await done;
  });
  assert.equal(h.advanced[0].reason, "cancelled by operator");
  assert.equal(seen.disposed, 1);
});

test("run creds: a runCredentials that throws fails the run with its reason and never spawns the agent", async () => {
  const h = harness({
    runCredentials: async () => {
      throw new Error("GitHub run token: GitHub App installation token 422: no Contents permission");
    },
  });
  await withReceiverEnv(() => h.run(job));
  assert.equal(h.read(), null, "the fake binary never ran");
  assert.deepEqual(h.advanced, [{ outcome: "fail", reason: "GitHub run token: GitHub App installation token 422: no Contents permission" }]);
  assert.match(h.logText(), /\[agenthook\] GitHub run token: GitHub App installation token 422/);
});

test("run creds: no runCredentials, or one returning null, behaves exactly as #470", async () => {
  for (const runCredentials of [undefined, async () => null]) {
    const h = harness({ runCredentials });
    await withReceiverEnv(() => h.run(job));
    const got = h.read();
    assert.equal(got?.GITHUB_TOKEN, "operator-pat", "the tracker prompt's allowlisted token passes");
    assert.equal(got?.GH_CONFIG_DIR, "unset");
    assert.equal(got?.GIT_CONFIG_COUNT, "unset");
    assert.equal(got?.SSH_AUTH_SOCK, "/tmp/agent.sock");
    assert.deepEqual(h.advanced.map((v) => v.outcome), ["advance"]);
  }
});

test("run creds: the forge is asked first; the tracker only when the forge returns null", async () => {
  const forge = credsStub({ FROM: "forge" });
  const tracker = credsStub({ FROM: "tracker" });
  const h = harness({ runCredentials: tracker.fn, forgeRunCredentials: forge.fn });
  await withReceiverEnv(() => h.run(job));
  assert.equal(forge.seen.calls.length, 1);
  assert.equal(tracker.seen.calls.length, 0);
  assert.equal(forge.seen.disposed, 1);

  const t2 = credsStub();
  const h2 = harness({ runCredentials: t2.fn, forgeRunCredentials: async () => null });
  await withReceiverEnv(() => h2.run(job));
  assert.equal(t2.seen.calls.length, 1);
  assert.equal(h2.read()?.GITHUB_TOKEN, "unset");
  assert.equal(t2.seen.disposed, 1);
});
