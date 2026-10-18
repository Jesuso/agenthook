import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The container sandbox (src/sandbox/): the pure `run` argv, and check/reap/kill over a
// stubbed CLI runner — no container runtime needed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { containerArgs, containerName, createContainerSandbox, SANDBOX_HOME } from "../src/sandbox/container.js";
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
  assert.equal(none.calls.length, 1, "no rm with nothing to remove");
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
