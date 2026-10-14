import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Shared fail-closed owner check (src/trackers/owner.js): retry 5xx/429/throws with backoff,
// fail fast on other non-2xx, and only a positive 2xx match is "ours".
import test from "node:test";
import assert from "node:assert/strict";
import { checkOwner, MoveRefusedError } from "../src/trackers/owner.js";

const fast = { delays: [0, 0] };

/** A fetchAssignee that plays `script` in order (then repeats the last); each entry is a result or an Error to throw. @param {any[]} script */
function scripted(script) {
  const f = async () => {
    const r = script[Math.min(f.calls++, script.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  f.calls = 0;
  return f;
}

test("checkOwner: 5xx then 2xx-ours → ours after 2 calls", async () => {
  const f = scripted([{ ok: false, status: 503 }, { ok: true, status: 200, mine: true }]);
  assert.equal(await checkOwner(f, fast), "ours");
  assert.equal(f.calls, 2);
});

test("checkOwner: persistent 5xx → check_failed after 3 calls", async () => {
  const f = scripted([{ ok: false, status: 502 }]);
  assert.equal(await checkOwner(f, fast), "check_failed");
  assert.equal(f.calls, 3);
});

test("checkOwner: a thrown error is retried", async () => {
  const f = scripted([new Error("ECONNRESET"), { ok: true, status: 200, mine: true }]);
  assert.equal(await checkOwner(f, fast), "ours");
  assert.equal(f.calls, 2);
});

test("checkOwner: 429 is retried", async () => {
  const f = scripted([{ ok: false, status: 429 }, { ok: true, status: 200, mine: false }]);
  assert.equal(await checkOwner(f, fast), "not_ours");
  assert.equal(f.calls, 2);
});

for (const status of [403, 404]) {
  test(`checkOwner: ${status} → check_failed with no retry`, async () => {
    const f = scripted([{ ok: false, status }]);
    assert.equal(await checkOwner(f, fast), "check_failed");
    assert.equal(f.calls, 1);
  });
}

test("checkOwner: 2xx with another assignee → not_ours", async () => {
  const f = scripted([{ ok: true, status: 200, mine: false }]);
  assert.equal(await checkOwner(f, fast), "not_ours");
  assert.equal(f.calls, 1);
});

test("checkOwner: fail-closed — a 2xx without a positive match is never ours", async () => {
  assert.equal(await checkOwner(scripted([{ ok: true, status: 200 }]), fast), "not_ours");
});

test("MoveRefusedError carries code + reason", () => {
  const e = new MoveRefusedError("owner_check_failed");
  assert.ok(e instanceof Error);
  assert.equal(e.code, "move_refused");
  assert.equal(e.reason, "owner_check_failed");
});
