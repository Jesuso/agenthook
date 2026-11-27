import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The container sandbox's service catalog (#529): service argv/env, the wait-probe exec
// poll, and how services compose with egress modes and reap() — over a stubbed CLI runner.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { containerArgs, createContainerSandbox, execRun, serviceArgs, serviceImages, DEFAULT_NETWORK } from "../src/sandbox/container.js";
import { DEFAULT_IMAGE } from "../src/sandbox/image.js";
import { stubRun, tmpCfg, egressRun, wrapArgs } from "./_sandbox-container-helpers.js";

test("serviceArgs: the fixed ADR 0007 hardening, the network alias, --pull never, the profile/ref/step labels, env by name only", () => {
  const a = serviceArgs({ id: "ah-p-42-code-abcd", stateKey: "p", ref: "42", stepId: "code", name: "db", network: "ah-p-42-code-abcd-net", image: "postgres:16.4", env: { POSTGRES_PASSWORD: "s3cret", POSTGRES_DB: "app" } });
  assert.deepEqual(a, [
    "run", "-d", "--init", "--pull", "never",
    "--name", "ah-p-42-code-abcd-svc-db",
    "--label", "agenthook.profile=p",
    "--label", "agenthook.ref=42",
    "--label", "agenthook.step=code",
    "--network", "ah-p-42-code-abcd-net",
    "--network-alias", "db",
    "--cap-drop", "ALL",
    "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "512",
    "--memory", "1g",
    "--cpus", "1",
    "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB",
    "postgres:16.4",
  ]);
  for (const flag of ["--user", "--userns=keep-id", "--mount", "-v", "-p", "--publish", "--privileged"]) assert.ok(!a.includes(flag), flag);
  assert.ok(!a.some((x) => x.includes("s3cret") || x === "app"), "no env value reaches argv");
  const b = serviceArgs({ id: "x", stateKey: "p", ref: "1", stepId: "c", name: "cache", network: "x-net", image: "redis:7", memory: "256m", cpus: 0.5 });
  assert.equal(b[b.indexOf("--memory") + 1], "256m");
  assert.equal(b[b.indexOf("--cpus") + 1], "0.5");
  assert.ok(!b.includes("-e"));
});

test("execRun: `env` is set over the receiver's own env (a `-e NAME` reads its value from there)", async () => {
  const r = await execRun("/bin/sh", ["-c", 'printf "%s|%s" "$AH_SVC_TEST" "${PATH:+path}"'], { timeoutMs: 10_000, env: { AH_SVC_TEST: "v1" } });
  assert.deepEqual(r, { code: 0, stdout: "v1|path", stderr: "" });
});

const SERVICES = {
  db: { image: "postgres:16.4", env: { POSTGRES_PASSWORD: "s3cret" }, wait: { cmd: ["pg_isready", "-U", "postgres"], timeoutS: 5 }, agentEnv: { DATABASE_URL: "postgres://postgres:s3cret@db:5432/postgres" } },
  cache: { image: "redis:7.2", agentEnv: { REDIS_URL: "redis://cache:6379" } },
};

/** A runner over egressRun that also records each call's opts, and answers `exec` from `execCodes` in turn (the last repeats). */
function svcRun(/** @type {{execCodes?: number[], execStderr?: string, ready?: boolean, answers?: Record<string, {code: number, stdout?: string, stderr?: string}>}} */ { execCodes = [0], execStderr = "not ready", ready = true, answers = {} } = {}) {
  const e = egressRun({ ready, answers });
  /** @type {any[]} */
  const opts = [];
  let n = 0;
  /** @type {import('../src/types/index.js').IngressRun} */
  const run = async (bin, args, o) => {
    opts.push(o);
    if (args[0] !== "exec") return e.run(bin, args, o);
    e.calls.push([bin, ...args]);
    const code = execCodes[Math.min(n++, execCodes.length - 1)];
    return { code, stdout: "", stderr: code ? execStderr : "" };
  };
  return { run, calls: e.calls, opts };
}

const svcCfg = (/** @type {any} */ extra = {}) => tmpCfg({ type: "docker", services: SERVICES, ...extra });
const svcWrap = (/** @type {any} */ egress, services = ["db"], env = { GH_TOKEN: "ghp_x" }) => ({ ...wrapArgs(egress), env, step: /** @type {any} */ ({ id: "code", services }) });
const networks = (/** @type {string[]} */ a) => a.flatMap((x, i) => (x === "--network" ? [a[i + 1]] : []));
const envNames = (/** @type {string[]} */ a) => a.flatMap((x, i) => (x === "-e" ? [a[i + 1]] : []));

test("wrap() allowlist + services: network, then each service (env via the runner), poll exec until 0, then the proxy; NO_PROXY names the services", async () => {
  const s = svcRun({ execCodes: [1, 1, 0] });
  const r = await createContainerSandbox(svcCfg(), { runtime: "docker", run: s.run, waitPollMs: 1 }).wrap(svcWrap({ mode: "allowlist", rules: [] }, ["db", "cache"]));
  assert.deepEqual(s.calls.map((c) => c.slice(1, 3)), [
    ["network", "create"],
    ["run", "-d"], ["exec", `${r.id}-svc-db`], ["exec", `${r.id}-svc-db`], ["exec", `${r.id}-svc-db`],
    ["run", "-d"],
    ["run", "-d"], ["network", "connect"],
  ]);
  assert.deepEqual(s.calls[2].slice(1), ["exec", `${r.id}-svc-db`, "pg_isready", "-U", "postgres"]);
  const db = s.calls[1].slice(1);
  assert.deepEqual(db, serviceArgs({ id: r.id, stateKey: "p", ref: "42", stepId: "code", name: "db", network: `${r.id}-net`, image: "postgres:16.4", env: SERVICES.db.env }));
  assert.deepEqual(s.opts[1].env, { POSTGRES_PASSWORD: "s3cret" }, "the service env reaches the runner, not argv");
  assert.deepEqual(s.opts[5].env, {}, "a service with no env");
  assert.equal(s.calls[5][s.calls[5].indexOf("--name") + 1], `${r.id}-svc-cache`);
  assert.equal(s.calls[6][s.calls[6].indexOf("--name") + 1], `${r.id}-proxy`);
  assert.ok(!s.calls.flat().some((x) => x.includes("s3cret")), "no env value in any argv");

  assert.deepEqual(networks(r.args), [`${r.id}-net`]);
  assert.equal(r.env.NO_PROXY, "localhost,127.0.0.1,::1,db,cache");
  assert.equal(r.env.no_proxy, "localhost,127.0.0.1,::1,db,cache");
  assert.equal(r.env.DATABASE_URL, SERVICES.db.agentEnv.DATABASE_URL);
  assert.equal(r.env.REDIS_URL, "redis://cache:6379");
  assert.ok(envNames(r.args).includes("DATABASE_URL") && envNames(r.args).includes("REDIS_URL"), "agentEnv passed by name");
  assert.ok(!r.args.some((x) => x.includes("s3cret")));
});

test("wrap() none + services: the agent is on the run network (not --network none), with no proxy env", async () => {
  const s = svcRun();
  const r = await createContainerSandbox(svcCfg(), { runtime: "podman", run: s.run }).wrap(svcWrap({ mode: "none", rules: [] }));
  assert.deepEqual(networks(r.args), [`${r.id}-net`]);
  assert.equal(r.env.HTTPS_PROXY, undefined);
  assert.equal(r.env.NO_PROXY, undefined);
  assert.equal(r.env.DATABASE_URL, SERVICES.db.agentEnv.DATABASE_URL);
  assert.deepEqual(s.calls.map((c) => c.slice(1, 3)), [["network", "create"], ["run", "-d"], ["exec", `${r.id}-svc-db`]], "no proxy");
});

for (const runtime of /** @type {const} */ (["docker", "podman"])) {
  test(`wrap() open + services (${runtime}): the run network AND the default network, one --network each`, async () => {
    const s = svcRun();
    const r = await createContainerSandbox(svcCfg(), { runtime, run: s.run }).wrap(svcWrap({ mode: "open", rules: [] }));
    assert.deepEqual(networks(r.args), [`${r.id}-net`, DEFAULT_NETWORK[runtime]]);
    assert.equal(r.env.HTTPS_PROXY, undefined);
    const noEgress = await createContainerSandbox(svcCfg(), { runtime, run: svcRun().run }).wrap(svcWrap(undefined));
    assert.deepEqual(networks(noEgress.args), [`${noEgress.id}-net`, DEFAULT_NETWORK[runtime]], "no egress = open");
  });
}

test("wrap(): a service's agentEnv never overrides the proxy vars or AGENTHOOK_VERDICT_FILE", async () => {
  const cfg = svcCfg({ services: { db: { image: "postgres:16.4", agentEnv: { HTTPS_PROXY: "http://evil", NO_PROXY: "*", AGENTHOOK_VERDICT_FILE: "/evil", GH_TOKEN: "svc" } } } });
  const r = await createContainerSandbox(cfg, { runtime: "docker", run: svcRun().run }).wrap(svcWrap({ mode: "allowlist", rules: [] }, ["db"], { GH_TOKEN: "ghp_x", AGENTHOOK_VERDICT_FILE: "/v/verdict.json" }));
  assert.equal(r.env.HTTPS_PROXY, `http://${r.id}-proxy:3128`);
  assert.equal(r.env.NO_PROXY, "localhost,127.0.0.1,::1,db");
  assert.equal(r.env.AGENTHOOK_VERDICT_FILE, "/v/verdict.json");
  assert.equal(r.env.GH_TOKEN, "svc", "any other var is the operator's to set");
});

test("wrap(): a step without services keeps today's argv even when the profile has a catalog", async () => {
  const cfg = svcCfg();
  const s = svcRun();
  const r = await createContainerSandbox(cfg, { runtime: "docker", run: s.run, uid: 1, gid: 2 }).wrap(wrapArgs(undefined));
  const home = path.join(cfg.stateDir, "sandbox-home", r.id);
  assert.deepEqual(r.args, containerArgs({ runtime: "docker", id: r.id, stateKey: "p", ref: "42", stepId: "code", uid: 1, gid: 2, home, mounts: [{ path: "/wt" }], cwd: "/wt", env: { GH_TOKEN: "ghp_x" }, image: DEFAULT_IMAGE, bin: "claude", args: ["-p"] }));
  assert.deepEqual(s.calls, []);
  assert.deepEqual(await r.done(), {}, "no services → no services field");
});

test("wrap(): a wait probe that never passes rejects with the service name and its log tail, and removes the service, network and HOME", async () => {
  const cfg = svcCfg({ services: { db: { ...SERVICES.db, wait: { cmd: ["pg_isready"], timeoutS: 0.2 } } } });
  const s = svcRun({ execCodes: [1], answers: { logs: { code: 0, stdout: "starting\nFATAL: bad setting\n", stderr: "" } } });
  const t0 = Date.now();
  await assert.rejects(
    createContainerSandbox(cfg, { runtime: "docker", run: s.run, waitPollMs: 20 }).wrap(svcWrap({ mode: "none", rules: [] })),
    /^Error: service "db" not ready within 0\.2s \(wait: pg_isready\) — last log lines: starting \| FATAL: bad setting$/,
  );
  assert.ok(Date.now() - t0 < 5000);
  const tail = s.calls.slice(-3).map((c) => c.slice(1));
  assert.equal(tail[0][0], "logs");
  assert.deepEqual(tail.slice(1).map((c) => c.slice(0, 2)), [["rm", "-f"], ["network", "rm"]]);
  assert.match(tail[1][2], /-svc-db$/);
  assert.match(tail[2][2], /-net$/);
  assert.deepEqual(fs.readdirSync(path.join(cfg.stateDir, "sandbox-home")), []);
});

test("wrap(): a service that fails to start rejects naming it, and removes what was started (no agent, no later service)", async () => {
  const s = svcRun({ answers: { "run -d": { code: 125, stderr: "Error: postgres:16.4: image not known" }, logs: { code: 1, stderr: "Error: no such container" } } });
  const cfg = svcCfg();
  await assert.rejects(
    createContainerSandbox(cfg, { runtime: "podman", run: s.run }).wrap(svcWrap({ mode: "open", rules: [] }, ["db", "cache"])),
    /^Error: service "db" failed to start: Error: postgres:16\.4: image not known — last log lines: Error: no such container$/,
  );
  assert.deepEqual(s.calls.map((c) => c.slice(1, 3)), [["network", "create"], ["run", "-d"], ["logs", "--tail"], ["rm", "-f"], ["network", "rm"]], "cache never starts");
  assert.deepEqual(fs.readdirSync(path.join(cfg.stateDir, "sandbox-home")), []);
});

test("wrap(): a service that exits before its probe passes fails fast", async () => {
  const s = svcRun({ execCodes: [1], execStderr: "Error: No such container: x" });
  await assert.rejects(createContainerSandbox(svcCfg(), { runtime: "docker", run: s.run, waitPollMs: 1 }).wrap(svcWrap({ mode: "none", rules: [] })), /service "db" exited before its wait probe passed/);
  assert.equal(s.calls.filter((c) => c[1] === "exec").length, 1);
});

test("wrap(): an early-exited service (no --rm) still has readable logs — not docker's daemon-removal error", async () => {
  const s = svcRun({
    execCodes: [1],
    execStderr: "Error response from daemon: container ah-svc-db is not running",
    answers: { logs: { code: 0, stdout: "Error: Database is uninitialized and superuser password is not specified.\n", stderr: "" } },
  });
  await assert.rejects(
    createContainerSandbox(svcCfg(), { runtime: "docker", run: s.run, waitPollMs: 1 }).wrap(svcWrap({ mode: "none", rules: [] })),
    /^Error: service "db" exited before its wait probe passed — last log lines: Error: Database is uninitialized and superuser password is not specified\.$/,
  );
  assert.equal(s.calls.filter((c) => c[1] === "exec").length, 1);
  const tail = s.calls.slice(-3).map((c) => c.slice(1));
  assert.equal(tail[0][0], "logs");
  assert.deepEqual(tail.slice(1).map((c) => c.slice(0, 2)), [["rm", "-f"], ["network", "rm"]]);
  assert.match(tail[1][2], /-svc-db$/);
});

test("wrap(): an early-exited service fails fast on podman's stopped-container exec error too", async () => {
  const s = svcRun({ execCodes: [1], execStderr: "Error: can only create exec sessions on running containers: container state improper" });
  await assert.rejects(createContainerSandbox(svcCfg(), { runtime: "podman", run: s.run, waitPollMs: 1 }).wrap(svcWrap({ mode: "none", rules: [] })), /service "db" exited before its wait probe passed/);
  assert.equal(s.calls.filter((c) => c[1] === "exec").length, 1);
});

test("wrap(): a proxy failure after the services started removes the proxy, the services, then the network — each once", async () => {
  const cfg = svcCfg();
  const s = svcRun({ ready: false });
  await assert.rejects(createContainerSandbox(cfg, { runtime: "docker", run: s.run, readyTimeoutMs: 100 }).wrap(svcWrap({ mode: "allowlist", rules: [] }, ["db", "cache"])), /egress proxy did not start/);
  const connect = s.calls.findIndex((c) => c[1] === "network" && c[2] === "connect");
  const id = s.calls[connect][4].slice(0, -"-proxy".length);
  assert.deepEqual(s.calls.slice(connect + 2).map((c) => c.slice(1)), [
    ["stop", "-t", "5", `${id}-proxy`], ["rm", "-f", `${id}-proxy`],
    ["rm", "-f", `${id}-svc-db`], ["rm", "-f", `${id}-svc-cache`],
    ["network", "rm", `${id}-net`],
  ], "after the proxy's logs");
  assert.equal(s.calls[connect + 1][1], "logs");
  assert.deepEqual(fs.readdirSync(path.join(cfg.stateDir, "egress")), []);
  assert.deepEqual(fs.readdirSync(path.join(cfg.stateDir, "sandbox-home")), []);
});

test("done() with services: removes the proxy, then the services, then the network; reports extra.services; idempotent", async () => {
  const s = svcRun();
  const r = await createContainerSandbox(svcCfg(), { runtime: "docker", run: s.run }).wrap(svcWrap({ mode: "allowlist", rules: [] }, ["db", "cache"]));
  const before = s.calls.length;
  const report = await r.done();
  assert.deepEqual(s.calls.slice(before).map((c) => c.slice(1)), [
    ["stop", "-t", "5", `${r.id}-proxy`], ["rm", "-f", `${r.id}-proxy`],
    ["rm", "-f", `${r.id}-svc-db`], ["rm", "-f", `${r.id}-svc-cache`],
    ["network", "rm", `${r.id}-net`],
  ]);
  assert.deepEqual(report, { extra: { services: ["db", "cache"] } });
  assert.deepEqual(await r.done(), report, "idempotent");
  assert.equal(s.calls.length, before + 5, "nothing removed twice");

  const none = svcRun();
  const n = await createContainerSandbox(svcCfg(), { runtime: "docker", run: none.run }).wrap(svcWrap({ mode: "none", rules: [] }));
  const at = none.calls.length;
  assert.deepEqual(await n.done(), { extra: { services: ["db"] } });
  assert.deepEqual(none.calls.slice(at).map((c) => c.slice(1)), [["rm", "-f", `${n.id}-svc-db`], ["network", "rm", `${n.id}-net`]]);
});

test("done() allowlist + services: the egress report and extra.services merge", async () => {
  const s = egressRun({ denied: JSON.stringify({ host: "example.com", port: 443 }) + "\n" });
  const r = await createContainerSandbox(svcCfg({ services: { cache: SERVICES.cache } }), { runtime: "docker", run: s.run }).wrap(svcWrap({ mode: "allowlist", rules: [] }, ["cache"]));
  const report = await r.done();
  assert.deepEqual(report.extra, { egressDenied: ["example.com:443"], services: ["cache"] });
  assert.equal(report.notes?.length, 1);
});

test("reap(): service containers go with the rest of the profile's (by label)", async () => {
  const s = stubRun({ ps: { code: 0, stdout: "ah-p-1-code-aaaa\nah-p-1-code-aaaa-svc-db\nah-p-1-code-aaaa-proxy\n" }, "network ls": { code: 0, stdout: "n1\n" } });
  await createContainerSandbox(svcCfg(), { runtime: "docker", run: s.run }).reap();
  assert.ok(s.calls[0].includes("label=agenthook.profile=p"));
  assert.deepEqual(s.calls[2].slice(1), ["rm", "-f", "ah-p-1-code-aaaa", "ah-p-1-code-aaaa-svc-db", "ah-p-1-code-aaaa-proxy"]);
  assert.deepEqual(s.calls[4].slice(1), ["network", "rm", "n1"]);
});

test("check(): every sandboxed step's service images are inspected; a missing one names the pull (or build, if locally built) to run", async () => {
  const pipeline = [{ id: "code", services: ["db", "cache"] }, { id: "review", services: ["db"] }, { id: "done", manual: true }];
  const cfg = { ...svcCfg({ egress: { mode: "open" } }), pipeline };
  const s = stubRun({});
  assert.deepEqual(await createContainerSandbox(cfg, { runtime: "docker", run: s.run }).check(), { ok: true });
  assert.deepEqual(s.calls.slice(1).map((c) => c[3]), [DEFAULT_IMAGE, "postgres:16.4", "redis:7.2"]);
  /** @type {import('../src/types/index.js').IngressRun} */
  const missing = async (_bin, args) => ({ code: args[2] === "redis:7.2" ? 1 : 0, stdout: "", stderr: "" });
  const r = await createContainerSandbox(cfg, { runtime: "podman", run: missing }).check();
  assert.deepEqual(r, { ok: false, reason: "service image redis:7.2 not found — run podman pull redis:7.2, or if it is built locally: podman build -t redis:7.2 <dir with its Dockerfile>" });
  assert.deepEqual(serviceImages({ ...cfg, pipeline: [{ id: "code", sandbox: false, services: ["db"] }] }), [], "an unsandboxed step's services are never run");
});
