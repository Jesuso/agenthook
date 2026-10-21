import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The container sandbox (src/sandbox/): the pure `run` argv, and check/reap/kill over a
// stubbed CLI runner — no container runtime needed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { containerArgs, containerName, createContainerSandbox, egressReport, proxyArgs, DEFAULT_NETWORK, SANDBOX_HOME } from "../src/sandbox/container.js";
import { SANDBOXES, createSandbox } from "../src/sandbox/index.js";
import { SANDBOX_NAMES, isSandboxed } from "../src/sandbox/names.js";
import { DEFAULT_IMAGE, AGENT_DOCKERFILE, buildImageArgs } from "../src/sandbox/image.js";

/** @param {Partial<Parameters<typeof containerArgs>[0]>} [o] */
const argsFor = (o = {}) =>
  containerArgs({
    runtime: "docker", id: "ah-p-42-code-abcd", stateKey: "p", ref: "42", stepId: "code", uid: 1234, gid: 5678,
    home: "/state/sandbox-home/ah-p-42-code-abcd",
    mounts: [{ path: "/wt/42" }, { path: "/repo/.git" }, { path: "/repo/.git/config", ro: true }, { path: "/tr", dst: `${SANDBOX_HOME}/.claude/projects/x` }],
    cwd: "/wt/42", env: { GH_TOKEN: "ghp_secretvalue", AGENTHOOK_VERDICT_FILE: "/state/verdicts/run-42-code/verdict.json" },
    image: "agenthook-agent:1", bin: "claude", args: ["-p", "do it", "--verbose"],
    ...o,
  });

test("containerArgs (docker): --user uid:gid, hardening flags, labels", () => {
  const a = argsFor();
  assert.deepEqual(a.slice(0, 5), ["run", "--rm", "--init", "--pull", "never"]);
  assert.equal(a[a.indexOf("--user") + 1], "1234:5678");
  assert.ok(!a.includes("--userns=keep-id"));
  assert.equal(a[a.indexOf("--cap-drop") + 1], "ALL");
  assert.equal(a[a.indexOf("--security-opt") + 1], "no-new-privileges");
  assert.equal(a[a.indexOf("--name") + 1], "ah-p-42-code-abcd");
  assert.ok(a.includes("agenthook.profile=p") && a.includes("agenthook.ref=42") && a.includes("agenthook.step=code"));
  assert.ok(!a.includes("--memory") && !a.includes("--cpus"), "no caps unless configured");
  assert.equal(a[a.indexOf("--workdir") + 1], "/wt/42");
});

test("containerArgs (podman): --userns=keep-id and no --user", () => {
  const a = argsFor({ runtime: "podman", memory: "4g", cpus: 2 });
  assert.ok(a.includes("--userns=keep-id"));
  assert.ok(!a.includes("--user"));
  assert.equal(a[a.indexOf("--memory") + 1], "4g");
  assert.equal(a[a.indexOf("--cpus") + 1], "2");
});

test("containerArgs: env by NAME only — no argv element holds a value", () => {
  const a = argsFor();
  const names = a.flatMap((x, i) => (x === "-e" ? [a[i + 1]] : []));
  assert.deepEqual(names, [`HOME=${SANDBOX_HOME}`, "GH_TOKEN", "AGENTHOOK_VERDICT_FILE"]);
  assert.ok(!a.some((x) => x.includes("ghp_secretvalue")), "the token never reaches argv");
});

test("containerArgs: mounts in order (home first), same path unless dst, readonly flagged", () => {
  const a = argsFor();
  const mounts = a.flatMap((x, i) => (x === "--mount" ? [a[i + 1]] : []));
  assert.deepEqual(mounts, [
    `type=bind,src=/state/sandbox-home/ah-p-42-code-abcd,dst=${SANDBOX_HOME}`,
    "type=bind,src=/wt/42,dst=/wt/42",
    "type=bind,src=/repo/.git,dst=/repo/.git",
    "type=bind,src=/repo/.git/config,dst=/repo/.git/config,readonly",
    `type=bind,src=/tr,dst=${SANDBOX_HOME}/.claude/projects/x`,
  ]);
  assert.ok(!a.includes("-v"));
});

test("containerArgs: the image is followed by bin + args unchanged", () => {
  const a = argsFor();
  const i = a.indexOf("agenthook-agent:1");
  assert.deepEqual(a.slice(i), ["agenthook-agent:1", "claude", "-p", "do it", "--verbose"]);
});

test("containerArgs: a path with a comma (or relative) is refused, never misparsed", () => {
  assert.throws(() => argsFor({ mounts: [{ path: "/a,b" }] }), /cannot mount/);
  assert.throws(() => argsFor({ mounts: [{ path: "rel/dir" }] }), /cannot mount/);
});

test("containerName: profile/ref/step + 4 hex, limited to [A-Za-z0-9_.-]", () => {
  assert.equal(containerName({ stateKey: "my prof", ref: "PROJ-1/x", stepId: "code", suffix: "beef" }), "ah-my_prof-PROJ-1_x-code-beef");
  assert.match(containerName({ stateKey: "p", ref: "1", stepId: "s" }), /^ah-p-1-s-[0-9a-f]{4}$/);
});

/** A stub CLI runner: `answers` maps "arg0 arg1" → result; every call is recorded. */
function stubRun(/** @type {Record<string, {code: number, stdout?: string, stderr?: string}>} */ answers) {
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../src/types.js').IngressRun} */
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    const a = answers[args.slice(0, 2).join(" ")] ?? answers[args[0]] ?? { code: 0 };
    return { code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { run, calls };
}

const tmpCfg = (/** @type {any} */ sandbox = { type: "docker" }) =>
  /** @type {any} */ ({ stateKey: "p", stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "ah-sbx-")), sandbox });

test("check(): ok when info + image inspect succeed; a missing image names doctor --fix", async () => {
  const ok = stubRun({});
  assert.deepEqual(await createContainerSandbox(tmpCfg(), { runtime: "docker", run: ok.run }).check(), { ok: true });
  assert.deepEqual(ok.calls[1].slice(1), ["image", "inspect", DEFAULT_IMAGE]);
  const missing = stubRun({ "image inspect": { code: 1, stderr: "Error: No such image" } });
  const r = await createContainerSandbox(tmpCfg({ type: "docker", image: "mine:1" }), { runtime: "docker", run: missing.run }).check();
  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).reason, /sandbox image mine:1 not found — run `agenthook doctor --fix`/);
  const down = stubRun({ info: { code: 1, stderr: "Cannot connect to the Docker daemon" } });
  const d = await createContainerSandbox(tmpCfg(), { runtime: "docker", run: down.run }).check();
  assert.match(/** @type {any} */ (d).reason, /info` failed: Cannot connect/);
  assert.equal(down.calls.length, 1, "no image probe once the runtime is down");
});

test("check(): a runtime binary that can't spawn is a reason, not a throw", async () => {
  const r = await createContainerSandbox(tmpCfg(), { runtime: "podman", run: async () => { throw Object.assign(new Error("spawn podman ENOENT"), { code: "ENOENT" }); } }).check();
  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).reason, /podman not runnable \(ENOENT\)/);
});

test("reap(): rm -f exactly the containers ps returned (by profile label), and drops leftover homes", async () => {
  const cfg = tmpCfg();
  fs.mkdirSync(path.join(cfg.stateDir, "sandbox-home", "ah-p-1-code-aaaa"), { recursive: true });
  const s = stubRun({ ps: { code: 0, stdout: "ah-p-1-code-aaaa\nah-p-2-review-bbbb\n" } });
  const names = await createContainerSandbox(cfg, { runtime: "docker", run: s.run }).reap();
  assert.deepEqual(names, ["ah-p-1-code-aaaa", "ah-p-2-review-bbbb"]);
  assert.ok(s.calls[0].includes("label=agenthook.profile=p"));
  assert.deepEqual(s.calls[1].slice(1), ["rm", "-f", "ah-p-1-code-aaaa", "ah-p-2-review-bbbb"]);
  assert.equal(fs.existsSync(path.join(cfg.stateDir, "sandbox-home")), false);
  const none = stubRun({ ps: { code: 0, stdout: "" } });
  assert.deepEqual(await createContainerSandbox(cfg, { runtime: "docker", run: none.run }).reap(), []);
  assert.deepEqual(none.calls.map((c) => c.slice(1, 3)), [["ps", "-a"], ["network", "ls"]], "no rm with nothing to remove");
});

test("reap(): also removes the profile's labelled networks (after the containers) and leftover egress dirs", async () => {
  const cfg = tmpCfg();
  fs.mkdirSync(path.join(cfg.stateDir, "egress", "ah-p-1-code-aaaa"), { recursive: true });
  const s = stubRun({ ps: { code: 0, stdout: "ah-p-1-code-aaaa\nah-p-1-code-aaaa-proxy\n" }, "network ls": { code: 0, stdout: "n1\nn2\n" } });
  await createContainerSandbox(cfg, { runtime: "podman", run: s.run }).reap();
  assert.deepEqual(s.calls.map((c) => c.slice(1)), [
    ["ps", "-a", "--filter", "label=agenthook.profile=p", "--format", "{{.Names}}"],
    ["rm", "-f", "ah-p-1-code-aaaa", "ah-p-1-code-aaaa-proxy"],
    ["network", "ls", "-q", "--filter", "label=agenthook.profile=p"],
    ["network", "rm", "n1", "n2"],
  ]);
  assert.equal(fs.existsSync(path.join(cfg.stateDir, "egress")), false);
});

test("wrap(): a per-run 0700 HOME with mountpoints for dst-under-home mounts; kill ignores No such container; done removes HOME", async () => {
  const cfg = tmpCfg();
  const s = stubRun({ kill: { code: 1, stderr: "Error response from daemon: No such container: x" } });
  const sb = createContainerSandbox(cfg, { runtime: "docker", run: s.run, uid: 1, gid: 2 });
  const r = await sb.wrap({ runId: "r", ref: "42", stepId: "code", bin: "claude", args: ["-p"], env: { A: "1" }, cwd: "/wt", mounts: [{ path: "/wt" }, { path: "/tr", dst: `${SANDBOX_HOME}/.claude/projects/m` }], step: /** @type {any} */ ({ id: "code" }) });
  const home = path.join(cfg.stateDir, "sandbox-home", r.id);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.ok(fs.statSync(path.join(home, ".claude", "projects", "m")).isDirectory());
  assert.deepEqual(r.env, { A: "1" });
  assert.equal(r.bin, "docker");
  const errs = [];
  const err = console.error;
  console.error = (/** @type {any[]} */ ...a) => void errs.push(a.join(" "));
  try {
    await r.kill();
  } finally {
    console.error = err;
  }
  assert.deepEqual(s.calls.at(-1)?.slice(1), ["kill", r.id]);
  assert.deepEqual(errs, [], "No such container is the expected race, not an error");
  assert.deepEqual(await r.done(), {});
  assert.equal(fs.existsSync(home), false);
  assert.deepEqual(await r.done(), {}, "idempotent");
});

test("DOCKER / PODMAN override the runtime binary", async () => {
  const prev = process.env.PODMAN;
  process.env.PODMAN = "/opt/podman";
  try {
    const s = stubRun({});
    await createContainerSandbox(tmpCfg(), { runtime: "podman", run: s.run }).check();
    assert.equal(s.calls[0][0], "/opt/podman");
  } finally {
    if (prev === undefined) delete process.env.PODMAN;
    else process.env.PODMAN = prev;
  }
});

test("registry: keys equal SANDBOX_NAMES; unset → null; unknown type throws", () => {
  assert.deepEqual(Object.keys(SANDBOXES), [...SANDBOX_NAMES]);
  assert.equal(createSandbox(/** @type {any} */ ({})), null);
  assert.equal(createSandbox(tmpCfg({ type: "podman" }))?.describe().name, "podman");
  assert.throws(() => createSandbox(tmpCfg({ type: "lxc" })), /unknown sandbox "lxc"/);
});

test("isSandboxed: a sandbox block, unless the step opts out with sandbox:false", () => {
  assert.equal(isSandboxed({}, { sandbox: true }), false);
  assert.equal(isSandboxed({ sandbox: { type: "docker" } }, {}), true);
  assert.equal(isSandboxed({ sandbox: { type: "docker" } }, { sandbox: false }), false);
});

test("image: default tag carries the package version; build reads the Dockerfile from stdin", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(DEFAULT_IMAGE, `agenthook-agent:${pkg.version}`);
  assert.deepEqual(buildImageArgs("podman", "x:1"), ["build", "-t", "x:1", "-"]);
  assert.match(AGENT_DOCKERFILE, /^FROM node:22-bookworm-slim/);
  assert.match(AGENT_DOCKERFILE, /@anthropic-ai\/claude-code@\$\{CLAUDE_VERSION\}/);
  assert.match(AGENT_DOCKERFILE, /install -y --no-install-recommends gh/);
  assert.doesNotMatch(AGENT_DOCKERFILE, /^(USER|CMD)\b/m);
});

// --- egress (#473) ---

/** A stub runner whose proxy `run -d` writes `ready` (and optional denials) into its /egress mount. */
function egressRun(/** @type {{ready?: boolean, denied?: string, answers?: Record<string, {code: number, stdout?: string, stderr?: string}>}} */ { ready = true, denied, answers = {} } = {}) {
  const s = stubRun(answers);
  /** @type {import('../src/types.js').IngressRun} */
  const run = async (bin, args, o) => {
    const r = await s.run(bin, args, o);
    if (args[0] === "run" && args[1] === "-d") {
      const m = args.find((a) => a.endsWith(",dst=/egress"));
      const dir = /src=([^,]+)/.exec(m ?? "")?.[1];
      if (dir && ready) fs.writeFileSync(path.join(dir, "ready"), "3128\n");
      if (dir && denied) fs.writeFileSync(path.join(dir, "denied.jsonl"), denied);
    }
    return r;
  };
  return { run, calls: s.calls };
}

const wrapArgs = (/** @type {any} */ egress) => ({ runId: "r", ref: "42", stepId: "code", bin: "claude", args: ["-p"], env: { GH_TOKEN: "ghp_x" }, cwd: "/wt", mounts: [{ path: "/wt" }], step: /** @type {any} */ ({ id: "code" }), ...(egress ? { egress } : {}) });

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
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY", "YARN_HTTPS_PROXY", "YARN_HTTP_PROXY"]) assert.ok(names.includes(k), k);
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
  const a = proxyArgs({ runtime: "docker", id: "ah-p-1-c-abcd", stateKey: "p", uid: 1, gid: 2, egressDir: "/s/egress/ah-p-1-c-abcd", network: "ah-p-1-c-abcd-net" });
  assert.deepEqual(a.slice(0, 6), ["run", "-d", "--rm", "--init", "--pull", "never"]);
  assert.ok(a.includes("no-new-privileges"));
  assert.ok(a.includes("type=bind,src=/s/egress/ah-p-1-c-abcd,dst=/egress"));
});

test("containerArgs: a file mask binds /dev/null read-only, a dir mask an empty 0555 tmpfs", () => {
  const a = argsFor({ mounts: [{ path: "/repo", ro: true }, { path: "/repo/.env", mask: "file" }, { path: "/repo/secrets", mask: "dir" }] });
  assert.ok(a.includes("type=bind,src=/dev/null,dst=/repo/.env,readonly"));
  assert.ok(a.includes("type=tmpfs,dst=/repo/secrets,tmpfs-size=4096,tmpfs-mode=0555"));
  assert.ok(!a.some((x) => x.includes("src=/repo/.env") || x.includes("src=/repo/secrets")), "a masked path is never a mount source");
});
