import "./_setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTailscaleIngress, hostFromStatus, statusProblem } from "../src/ingress/tailscale.js";
import { createIngress } from "../src/ingress/index.js";

// The fields of a `tailscale status --json` the adapter reads, from a healthy Funnel-enabled node.
const HEALTHY = {
  BackendState: "Running",
  CertDomains: ["box.tail1234.ts.net"],
  Self: { DNSName: "box.tail1234.ts.net.", CapMap: { "https://tailscale.com/cap/funnel-ports?ports=443,8443,10000": null, funnel: null } },
};

const cfg = /** @type {any} */ ({ stateKey: "dogfood", port: 4124, ingress: { type: "tailscale" } });

/** A stub `run` recording each call's argv; `reply(args)` answers it.
 * @param {(args: string[]) => any} reply */
function stub(reply) {
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../src/types.js').IngressRun} */
  const run = async (_bin, args) => {
    calls.push(args);
    return reply(args);
  };
  return { calls, run };
}

/** Answers status with `status` and every funnel call with `funnel`. @param {any} [status] @param {any} [funnel] */
const replies =
  (status = HEALTHY, funnel = { code: 0, stdout: "", stderr: "" }) =>
  /** @param {string[]} args */ (args) =>
    args[0] === "status" ? { code: 0, stdout: JSON.stringify(status), stderr: "" } : funnel;

test("hostFromStatus: Self.DNSName with the trailing dot stripped", () => {
  assert.equal(hostFromStatus(HEALTHY), "box.tail1234.ts.net");
  assert.equal(hostFromStatus({ Self: { DNSName: "box.tail1234.ts.net" } }), "box.tail1234.ts.net");
  assert.equal(hostFromStatus({}), "");
});

test("statusProblem: not logged in, no HTTPS certs, no funnel cap; healthy → null", () => {
  assert.match(String(statusProblem({ ...HEALTHY, BackendState: "NeedsLogin" })), /NeedsLogin.*tailscale up/);
  assert.match(String(statusProblem({ ...HEALTHY, BackendState: "Stopped" })), /tailscale up/);
  assert.match(String(statusProblem({ ...HEALTHY, CertDomains: [] })), /HTTPS.*login\.tailscale\.com\/admin\/dns/);
  assert.match(String(statusProblem({ ...HEALTHY, CertDomains: undefined })), /HTTPS/);
  assert.match(String(statusProblem({ ...HEALTHY, Self: { ...HEALTHY.Self, CapMap: { "https://tailscale.com/cap/ssh": null } } })), /Funnel.*kb\/1223\/funnel/);
  assert.equal(statusProblem(HEALTHY), null);
  assert.equal(statusProblem({ ...HEALTHY, Self: { ...HEALTHY.Self, CapMap: { "https://tailscale.com/cap/funnel": null } } }), null);
  assert.equal(statusProblem({ ...HEALTHY, Self: { ...HEALTHY.Self, CapMap: { funnel: null } } }), null);
});

test("describe: stable URL; createIngress resolves the tailscale type", () => {
  assert.deepEqual(createTailscaleIngress(cfg).describe(), { name: "tailscale", ephemeral: false });
  assert.equal(createIngress(cfg).describe().name, "tailscale");
  assert.deepEqual(createTailscaleIngress(cfg).wizardSteps?.(), []);
});

test("up: preflights status, mounts /<stateKey> and returns https://<host>/<stateKey>", async () => {
  const { calls, run } = stub(replies());
  const { url } = await createTailscaleIngress(cfg, { run }).up(4124);
  assert.equal(url, "https://box.tail1234.ts.net/dogfood");
  assert.deepEqual(calls, [
    ["status", "--json"],
    ["funnel", "--bg", "--set-path", "/dogfood", "http://127.0.0.1:4124"],
  ]);
});

test("up: a failed preflight makes no funnel call", async () => {
  for (const status of [{ ...HEALTHY, BackendState: "NeedsLogin" }, { ...HEALTHY, CertDomains: [] }, { ...HEALTHY, Self: { ...HEALTHY.Self, CapMap: {} } }]) {
    const { calls, run } = stub(replies(status));
    await assert.rejects(createTailscaleIngress(cfg, { run }).up(4124));
    assert.deepEqual(calls, [["status", "--json"]]);
  }
});

test("up: a missing binary names it and gives the install hint", async () => {
  const run = async () => {
    throw Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" });
  };
  await assert.rejects(createTailscaleIngress(cfg, { run }).up(4124), (e) => {
    assert.match(e.message, /"tailscale" not found/);
    assert.match(e.message, /tailscale\.com\/download/);
    assert.match(e.message, /Tailscale\.app\/Contents\/MacOS\/Tailscale/);
    assert.match(e.message, /TAILSCALE/);
    return true;
  });
});

test("up: a non-zero funnel exit rejects with its stderr; access denied hints the operator", async () => {
  const { run } = stub(replies(HEALTHY, { code: 1, stdout: "", stderr: "foreground listener already exists for port 443" }));
  await assert.rejects(createTailscaleIngress(cfg, { run }).up(4124), /exit 1.*foreground listener already exists/);

  const denied = stub(replies(HEALTHY, { code: 1, stdout: "", stderr: "Access denied: serve config denied" }));
  await assert.rejects(createTailscaleIngress(cfg, { run: denied.run }).up(4124), /sudo tailscale set --operator=\$USER/);
});

test("up: a hung funnel call rejects after timeoutMs", async () => {
  /** @type {import('../src/types.js').IngressRun} */
  const run = (_bin, args) => (args[0] === "status" ? Promise.resolve({ code: 0, stdout: JSON.stringify(HEALTHY), stderr: "" }) : new Promise(() => {}));
  const t0 = Date.now();
  await assert.rejects(createTailscaleIngress(cfg, { run, timeoutMs: 50 }).up(4124), /no answer after/);
  assert.ok(Date.now() - t0 < 2000);
});

test("down: removes only /<stateKey> after up; before up it is a no-op", async () => {
  const before = stub(replies());
  await createTailscaleIngress(cfg, { run: before.run }).down();
  assert.deepEqual(before.calls, []);

  const { calls, run } = stub(replies());
  const ingress = createTailscaleIngress(cfg, { run });
  await ingress.up(4124);
  calls.length = 0;
  await ingress.down();
  assert.deepEqual(calls, [["funnel", "--set-path", "/dogfood", "off"]]);
  await ingress.down(); // second down: nothing left to remove
  assert.equal(calls.length, 1);
});

test("down: a failing removal is logged, never thrown", async () => {
  let n = 0;
  const { run } = stub((args) => (args[0] === "status" ? { code: 0, stdout: JSON.stringify(HEALTHY), stderr: "" } : n++ ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" }));
  const ingress = createTailscaleIngress(cfg, { run });
  await ingress.up(4124);
  const err = console.error;
  /** @type {string[]} */
  const logged = [];
  console.error = (m) => logged.push(m);
  try {
    await ingress.down();
  } finally {
    console.error = err;
  }
  assert.match(logged.join("\n"), /boom/);
});
