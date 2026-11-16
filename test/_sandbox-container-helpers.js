// Shared fixtures for the sandbox-container-*.test.js files (split from the former
// sandbox-container.test.js so no single test file costs ~45K to read — see #717). Not
// matched by the `test/*.test.js` glob `npm test` runs, so it is never itself executed
// as a test file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { containerArgs, SANDBOX_HOME } from "../src/sandbox/container.js";

/** @param {Partial<Parameters<typeof containerArgs>[0]>} [o] */
export const argsFor = (o = {}) =>
  containerArgs({
    runtime: "docker", id: "ah-p-42-code-abcd", stateKey: "p", ref: "42", stepId: "code", uid: 1234, gid: 5678,
    home: "/state/sandbox-home/ah-p-42-code-abcd",
    mounts: [{ path: "/wt/42" }, { path: "/repo/.git" }, { path: "/repo/.git/config", ro: true }, { path: "/tr", dst: `${SANDBOX_HOME}/.claude/projects/x` }],
    cwd: "/wt/42", env: { GH_TOKEN: "ghp_secretvalue", AGENTHOOK_VERDICT_FILE: "/state/verdicts/run-42-code/verdict.json" },
    image: "agenthook-agent:1", bin: "claude", args: ["-p", "do it", "--verbose"],
    ...o,
  });

/** A stub CLI runner: `answers` maps "arg0 arg1" → result; every call is recorded. */
export function stubRun(/** @type {Record<string, {code: number, stdout?: string, stderr?: string}>} */ answers) {
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

export const tmpCfg = (/** @type {any} */ sandbox = { type: "docker" }) =>
  /** @type {any} */ ({ stateKey: "p", stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "ah-sbx-")), sandbox });

/** A stub runner whose proxy `run -d` writes `ready` (and optional denials) into its /egress mount. */
export function egressRun(/** @type {{ready?: boolean, denied?: string, answers?: Record<string, {code: number, stdout?: string, stderr?: string}>}} */ { ready = true, denied, answers = {} } = {}) {
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

export const wrapArgs = (/** @type {any} */ egress) => ({ runId: "r", ref: "42", stepId: "code", bin: "claude", args: ["-p"], env: { GH_TOKEN: "ghp_x" }, cwd: "/wt", mounts: [{ path: "/wt" }], step: /** @type {any} */ ({ id: "code" }), ...(egress ? { egress } : {}) });
