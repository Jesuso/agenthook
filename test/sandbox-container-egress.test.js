import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The container sandbox's egress mode (#473): allowlist proxy wiring, the egressReport
// denial summary, and the mask/none/open argv shapes — over a stubbed CLI runner.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { containerArgs, createContainerSandbox, egressReport, proxyArgs, DEFAULT_NETWORK } from "../src/sandbox/container.js";
import { EGRESS_PROXY_ENV_KEYS } from "../src/sandbox/names.js";
import { DEFAULT_IMAGE } from "../src/sandbox/image.js";
import { argsFor, stubRun, tmpCfg, egressRun, wrapArgs } from "./_sandbox-container-helpers.js";

for (const runtime of /** @type {const} */ (["docker", "podman"])) {
  test(`wrap() allowlist (${runtime}): internal network, proxy on it, then its outside leg; agent on the network with the proxy env by name`, async () => {
    const cfg = tmpCfg({ type: runtime });
    const s = egressRun();
    const sb = createContainerSandbox(cfg, { runtime, run: s.run, uid: 1, gid: 2 });
    const r = await sb.wrap(wrapArgs({ mode: "allowlist", rules: ["api.anthropic.com", "github.com"] }));
    const [create, proxy, connect] = s.calls.map((c) => c.slice(1));
    assert.deepEqual(create, ["network", "create", "--internal", "--label", "agenthook.profile=p", `${r.id}-net`]);
    assert.deepEqual(proxy.slice(0, 2), ["run", "-d"]);
    assert.equal(proxy[proxy.indexOf("--network") + 1], `${r.id}-net`);
    assert.equal(proxy[proxy.indexOf("--name") + 1], `${r.id}-proxy`);
    assert.ok(proxy.includes("agenthook.profile=p"));
    assert.equal(proxy[proxy.indexOf("--cap-drop") + 1], "ALL");
    assert.ok(runtime === "podman" ? proxy.includes("--userns=keep-id") : proxy[proxy.indexOf("--user") + 1] === "1:2");
    assert.deepEqual(proxy.slice(-4), [DEFAULT_IMAGE, "node", "/opt/agenthook/egress-proxy.mjs", "/egress"], "always the built-in image, even with a custom one");
    assert.ok(proxy.some((a) => /^type=bind,src=.*\/src\/sandbox\/egress-proxy\.mjs,dst=\/opt\/agenthook\/egress-proxy\.mjs,readonly$/.test(a)));
    assert.deepEqual(connect, ["network", "connect", DEFAULT_NETWORK[runtime], `${r.id}-proxy`]);
    assert.equal(DEFAULT_NETWORK[runtime], runtime === "docker" ? "bridge" : "podman");
    const egressDir = path.join(cfg.stateDir, "egress", r.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(egressDir, "allow.json"), "utf8")), { rules: ["api.anthropic.com", "github.com"] });
    assert.equal(fs.statSync(egressDir).mode & 0o777, 0o700);

    assert.equal(r.args[r.args.indexOf("--network") + 1], `${r.id}-net`);
    const names = r.args.flatMap((x, i) => (x === "-e" ? [r.args[i + 1]] : []));
    for (const k of EGRESS_PROXY_ENV_KEYS) assert.ok(names.includes(k), k);
    assert.ok(!r.args.some((a) => a.includes("-proxy:3128")), "no proxy URL (no env value) in argv");
    assert.equal(r.env.HTTPS_PROXY, `http://${r.id}-proxy:3128`);
    assert.equal(r.env.http_proxy, `http://${r.id}-proxy:3128`);
    assert.equal(r.env.NO_PROXY, "localhost,127.0.0.1,::1");
    assert.equal(r.env.NODE_USE_ENV_PROXY, "1");
    assert.equal(r.env.YARN_HTTPS_PROXY, `http://${r.id}-proxy:3128`);
    assert.equal(r.env.YARN_HTTP_PROXY, `http://${r.id}-proxy:3128`);
    assert.equal(r.env.GH_TOKEN, "ghp_x");
  });
}

test("done() (allowlist): removes the proxy then the network, folds denied.jsonl into notes/extra, idempotent", async () => {
  const cfg = tmpCfg();
  const lines = [
    { host: "example.com", port: 443 }, { host: "pypi.org", port: 443 }, { host: "example.com", port: 443 }, { host: "evil.io", port: 80 }, { host: "example.com", port: 443 },
  ].map((d) => JSON.stringify({ at: "2026-10-18T00:00:00Z", ...d })).join("\n") + "\n{torn";
  const s = egressRun({ denied: lines });
  const r = await createContainerSandbox(cfg, { runtime: "docker", run: s.run }).wrap(wrapArgs({ mode: "allowlist", rules: [] }));
  const before = s.calls.length;
  const report = await r.done();
  assert.deepEqual(s.calls.slice(before).map((c) => c.slice(1)), [["stop", "-t", "5", `${r.id}-proxy`], ["rm", "-f", `${r.id}-proxy`], ["network", "rm", `${r.id}-net`]]);
  assert.deepEqual(report.extra, { egressDenied: ["example.com:443", "evil.io:80", "pypi.org:443"] });
  assert.deepEqual(report.notes, [
    "egress denied: example.com:443 (3×) — add it to sandbox.egress.allow (or the step's egress.allow) if this step needs it",
    "egress denied: evil.io:80 (1×) — add it to sandbox.egress.allow (or the step's egress.allow) if this step needs it",
    "egress denied: pypi.org:443 (1×) — add it to sandbox.egress.allow (or the step's egress.allow) if this step needs it",
  ]);
  assert.equal(fs.existsSync(path.join(cfg.stateDir, "egress", r.id)), false);
  assert.deepEqual(await r.done(), report, "idempotent");
  assert.equal(s.calls.length, before + 3, "nothing removed twice");
});

test("egressReport: nothing denied → {}; more than 20 hosts are capped with '… and N more'", () => {
  assert.deepEqual(egressReport(""), {});
  const many = Array.from({ length: 23 }, (_, i) => JSON.stringify({ host: `h${String(i).padStart(2, "0")}.io`, port: 443 })).join("\n");
  const r = egressReport(many);
  assert.equal(r.notes?.length, 21);
  assert.equal(r.notes?.at(-1), "… and 3 more");
  assert.equal(r.extra?.egressDenied.length, 20);
});

test("egressReport: a {truncated} summary line adds egressDeniedTruncated + a note, egressDenied unchanged", () => {
  const lines = [{ host: "example.com", port: 443 }, { host: "evil.io", port: 80 }].map((d) => JSON.stringify(d)).join("\n") + "\n" + JSON.stringify({ truncated: 7 });
  const r = egressReport(lines);
  assert.equal(r.extra?.egressDeniedTruncated, 7);
  assert.deepEqual(r.extra?.egressDenied, ["evil.io:80", "example.com:443"]);
  assert.ok(r.notes?.at(-1).includes("7 more denied request(s) not logged (denied.jsonl cap)"));
  const noSummary = egressReport([{ host: "example.com", port: 443 }].map((d) => JSON.stringify(d)).join("\n"));
  assert.equal(noSummary.extra?.egressDeniedTruncated, undefined, "unaffected when nothing was truncated");
});

test("done() (allowlist): teardownEgress runs `stop -t 5` before `rm -f`; a benign 'is not running' stop error is not logged", async () => {
  const cfg = tmpCfg();
  const s = egressRun({ answers: { stop: { code: 1, stderr: "Error: container is not running" } } });
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    const r = await createContainerSandbox(cfg, { runtime: "docker", run: s.run }).wrap(wrapArgs({ mode: "allowlist", rules: [] }));
    const before = s.calls.length;
    await r.done();
    const calls = s.calls.slice(before).map((c) => c.slice(1));
    assert.deepEqual(calls[0], ["stop", "-t", "5", `${r.id}-proxy`]);
    assert.deepEqual(calls[1], ["rm", "-f", `${r.id}-proxy`]);
    assert.ok(!errors.some((e) => e.includes("stop")), "a 'not running' stop failure is benign");
  } finally {
    console.error = origError;
  }
});

test("wrap() mode none: --network none, no proxy, no proxy env", async () => {
  const s = egressRun();
  const r = await createContainerSandbox(tmpCfg(), { runtime: "docker", run: s.run }).wrap(wrapArgs({ mode: "none", rules: ["x.io"] }));
  assert.equal(r.args[r.args.indexOf("--network") + 1], "none");
  assert.deepEqual(s.calls, [], "no network, no proxy");
  assert.equal(r.env.HTTPS_PROXY, undefined);
  assert.equal(r.env.NODE_USE_ENV_PROXY, undefined);
  assert.equal(r.env.YARN_HTTPS_PROXY, undefined);
  assert.equal(r.env.YARN_HTTP_PROXY, undefined);
  assert.deepEqual(await r.done(), {});
});

test("wrap() with no egress (or open): today's argv, unchanged", async () => {
  const cfg = tmpCfg();
  const a = await createContainerSandbox(cfg, { runtime: "docker", run: stubRun({}).run, uid: 1, gid: 2 }).wrap(wrapArgs(undefined));
  const b = await createContainerSandbox(cfg, { runtime: "docker", run: stubRun({}).run, uid: 1, gid: 2 }).wrap(wrapArgs({ mode: "open", rules: [] }));
  for (const r of [a, b]) {
    assert.ok(!r.args.includes("--network"));
    assert.deepEqual(r.env, { GH_TOKEN: "ghp_x" });
    const home = path.join(cfg.stateDir, "sandbox-home", r.id);
    assert.deepEqual(r.args, containerArgs({ runtime: "docker", id: r.id, stateKey: "p", ref: "42", stepId: "code", uid: 1, gid: 2, home, mounts: [{ path: "/wt" }], cwd: "/wt", env: { GH_TOKEN: "ghp_x" }, image: DEFAULT_IMAGE, bin: "claude", args: ["-p"] }));
  }
});

test("wrap() allowlist: a proxy that never gets ready rejects within the timeout and removes the proxy, network, egress dir and HOME", async () => {
  const cfg = tmpCfg();
  const s = egressRun({ ready: false, answers: { logs: { code: 0, stdout: "", stderr: "Error: Cannot find module '/opt/agenthook/egress-proxy.mjs'" } } });
  const sb = createContainerSandbox(cfg, { runtime: "docker", run: s.run, readyTimeoutMs: 150 });
  const t0 = Date.now();
  await assert.rejects(sb.wrap(wrapArgs({ mode: "allowlist", rules: [] })), /egress proxy did not start within 0\.2s: Error: Cannot find module/);
  assert.ok(Date.now() - t0 < 5000);
  const tail = s.calls.slice(-2).map((c) => c.slice(1, 3));
  assert.deepEqual(tail, [["rm", "-f"], ["network", "rm"]]);
  assert.match(s.calls.at(-2)?.[3] ?? "", /-proxy$/);
  assert.match(s.calls.at(-1)?.[3] ?? "", /-net$/);
  assert.deepEqual(fs.readdirSync(path.join(cfg.stateDir, "egress")), []);
  assert.deepEqual(fs.readdirSync(path.join(cfg.stateDir, "sandbox-home")), []);
});

test("wrap() allowlist: a failed network create rejects and removes only what it made", async () => {
  const cfg = tmpCfg();
  const s = egressRun({ answers: { "network create": { code: 125, stderr: "Error: network exists" } } });
  await assert.rejects(createContainerSandbox(cfg, { runtime: "podman", run: s.run }).wrap(wrapArgs({ mode: "allowlist", rules: [] })), /network create` failed: Error: network exists/);
  assert.deepEqual(s.calls.map((c) => c.slice(1, 3)), [["network", "create"], ["network", "rm"]], "no proxy was started, so none is removed");
  assert.deepEqual(fs.readdirSync(path.join(cfg.stateDir, "egress")), []);
});

test("check(): allowlist with a custom sandbox.image also requires the built-in image (the proxy runs it)", async () => {
  const pipeline = [{ id: "code" }, { id: "done", manual: true }];
  const s = stubRun({});
  const cfg = { ...tmpCfg({ type: "docker", image: "mine:1" }), pipeline };
  assert.deepEqual(await createContainerSandbox(cfg, { runtime: "docker", run: s.run }).check(), { ok: true });
  assert.deepEqual(s.calls.slice(1).map((c) => c.slice(1)), [["image", "inspect", "mine:1"], ["image", "inspect", DEFAULT_IMAGE]]);
  /** @type {import('../src/types.js').IngressRun} */
  const missingDefault = async (_bin, args) => ({ code: args[2] === DEFAULT_IMAGE ? 1 : 0, stdout: "", stderr: "" });
  const r = await createContainerSandbox(cfg, { runtime: "docker", run: missingDefault }).check();
  assert.match(/** @type {any} */ (r).reason, new RegExp(`sandbox image ${DEFAULT_IMAGE.replace(/[.]/g, "\\.")} not found — run \`agenthook doctor --fix\``));
  const open = stubRun({});
  await createContainerSandbox({ ...tmpCfg({ type: "docker", image: "mine:1", egress: { mode: "open" } }), pipeline }, { runtime: "docker", run: open.run }).check();
  assert.deepEqual(open.calls.slice(1).map((c) => c[3]), ["mine:1"], "open mode: no proxy, no built-in image needed");
});

test("proxyArgs: hardened, labelled, script read-only, egress dir rw", () => {
  const a = proxyArgs({ runtime: "docker", id: "ah-p-1-c-abcd", stateKey: "p", ref: "1", stepId: "c", uid: 1, gid: 2, egressDir: "/s/egress/ah-p-1-c-abcd", network: "ah-p-1-c-abcd-net" });
  assert.deepEqual(a.slice(0, 6), ["run", "-d", "--rm", "--init", "--pull", "never"]);
  const i = a.indexOf("agenthook.profile=p");
  assert.deepEqual(a.slice(i - 1, i + 5), ["--label", "agenthook.profile=p", "--label", "agenthook.ref=1", "--label", "agenthook.step=c"]);
  assert.ok(a.includes("no-new-privileges"));
  assert.ok(a.includes("type=bind,src=/s/egress/ah-p-1-c-abcd,dst=/egress"));
});

test("containerArgs: a file mask binds /dev/null read-only, a dir mask an empty 0555 tmpfs", () => {
  const a = argsFor({ mounts: [{ path: "/repo", ro: true }, { path: "/repo/.env", mask: "file" }, { path: "/repo/secrets", mask: "dir" }] });
  assert.ok(a.includes("type=bind,src=/dev/null,dst=/repo/.env,readonly"));
  assert.ok(a.includes("type=tmpfs,dst=/repo/secrets,tmpfs-size=4096,tmpfs-mode=0555"));
  assert.ok(!a.some((x) => x.includes("src=/repo/.env") || x.includes("src=/repo/secrets")), "a masked path is never a mount source");
});
