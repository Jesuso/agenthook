import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// pi.remote unit tests (#827), split from test/agents-pi.test.js to keep that file under the
// ~25 KB test-file cap: the same contract/standing/args shape as sandbox(), a worker-dir base,
// and a step's piConfigDir IGNORED (the worker's own ~/.pi/agent is used) — never read, never
// copied. The ssh-transport side is covered in test/dispatch-executor-ssh-pi*.test.js.
import test from "node:test";
import assert from "node:assert/strict";

const { pi, piContract } = await import("../src/agents/pi.js");

/** Capture console.warn while fn runs. @param {() => void} fn */
function warns(fn) {
  /** @type {string[]} */
  const out = [];
  const orig = console.warn;
  console.warn = (m) => out.push(m);
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return out;
}

test("remote: contract + standing files under the worker per-run dir, --append-system-prompt args, env exactly { PI_OFFLINE: 1 }, piConfigDir ignored with a warn (never read)", () => {
  const own = pi.remote({
    cfg: /** @type {any} */ ({}),
    step: /** @type {any} */ ({ id: "code", piConfigDir: "/does/not/exist" }),
    dir: "/run/9-code.opencode",
    verdictFile: "/v/verdict.json",
    standing: "DO THE MINIMAL THING.",
  });
  assert.deepEqual(own.env, { PI_OFFLINE: "1" }, "the remote env is exactly the hook's own keys — no prefix passthrough");
  assert.equal(own.files.length, 2, JSON.stringify(own.files), "a missing piConfigDir must not be read (warn only) and adds nothing");
  assert.deepEqual(own.files[0], { dst: "/run/9-code.opencode/agenthook-unattended.md", content: piContract("/v/verdict.json"), mode: 0o600 });
  assert.deepEqual(own.files[1], { dst: "/run/9-code.opencode/agenthook-standing.md", content: "DO THE MINIMAL THING.", mode: 0o600 });
  assert.deepEqual(own.args, ["--append-system-prompt", "/run/9-code.opencode/agenthook-unattended.md", "--append-system-prompt", "/run/9-code.opencode/agenthook-standing.md"]);
  assert.equal(own.standingInInstructions, true);
  assert.equal(own.mounts, undefined, "a remote run has no mounts — the worker's cwd is a path on another machine");
  const w = warns(() => pi.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ id: "code", piConfigDir: "/does/not/exist" }), dir: "/run/9-code.opencode", verdictFile: "/v/verdict.json" }));
  assert.ok(w.some((m) => m.includes("piConfigDir /does/not/exist is ignored on a remote worker")), JSON.stringify(w));
});

test("remote: the same shape as sandbox() — contract-only when no standing; oversize standing dropped with a warn, same as sandbox()", () => {
  const bare = pi.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ id: "code" }), dir: "/run/1-code.opencode", verdictFile: "/v/verdict.json" });
  assert.equal(bare.files.length, 1);
  assert.deepEqual(bare.args, ["--append-system-prompt", "/run/1-code.opencode/agenthook-unattended.md"]);
  assert.equal(bare.standingInInstructions, undefined);

  const w = warns(() => {
    const big = pi.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ id: "code" }), dir: "/run/2-code.opencode", verdictFile: "/v/verdict.json", standing: "x".repeat(16 * 1024 + 1) });
    assert.equal(big.files.length, 1, "the oversize standing must not be written");
    assert.equal(big.standingInInstructions, undefined);
  });
  assert.ok(w.some((m) => m.includes("16385 bytes") && m.includes("not written")), JSON.stringify(w));

  // the contract file and the args shape are byte-identical to what sandbox() produces for the
  // same step/verdictFile — only the base dir differs.
  const sb = pi.sandbox({ step: /** @type {any} */ ({ id: "code" }), home: "/home/a", verdictFile: "/v/verdict.json", standing: "S" });
  assert.equal(pi.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ id: "code" }), dir: "/r", verdictFile: "/v/verdict.json", standing: "S" }).files[0].content, sb.files.find((f) => f.dst.endsWith("agenthook-unattended.md")).content);
});
