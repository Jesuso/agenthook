import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// GitHub forge webhook registration, the forge registry (`createForge`), listAgentPrs/
// listMergedAgentPrs/ciStatus (fetch stubbed), and GitHub App auth (src/github/auth.js).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { forgeBlock } from "../src/forges/github.js";
import { createForge } from "../src/forges/index.js";
import { resetGithubAuthCache } from "../src/github/auth.js";
import { forge, makeStore, pipeline, SECRET, ghTracker, stubFetch } from "./_forge-helpers.js";

/** Writes `publicUrlFile` with `url` so the forge snapshots it as its previous URL
 * at construction time. @param {string} url */
function publicUrlFile(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-forge-"));
  const file = path.join(dir, "public_url.txt");
  fs.writeFileSync(file, url);
  return file;
}

// --- hooks ---

/** @param {{id:number,url:string}[]} hooks @param {{id:number,active:boolean}} [createBody] */
function stubHooks(hooks, createBody = { id: 9, active: true }) {
  /** @type {string[]} */
  const calls = [];
  let created;
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push(`${method} ${url}`);
    if (method === "GET") return { ok: true, status: 200, json: async () => hooks.map((h) => ({ id: h.id, config: { url: h.url } })) };
    if (method === "POST") created = JSON.parse(String(init.body));
    return { ok: true, status: 201, json: async () => createBody };
  };
  return {
    calls,
    get created() {
      return created;
    },
    restore: () => {
      global.fetch = orig;
    },
  };
}

test("registerWebhook deletes a legacy hook at the previous public URL, then creates+persists the new one", async () => {
  const urlFile = publicUrlFile("https://old.example");
  const store = makeStore();
  const s = stubHooks([
    { id: 1, url: "https://old.example/forge" },
    { id: 2, url: "https://old.example/github/" },
    { id: 3, url: "https://old.example/mytasks/" },
  ]);
  try {
    await forge({}, pipeline, store, { publicUrlFile: urlFile }).registerWebhook("https://new.example/");
  } finally {
    s.restore();
  }
  const deletes = s.calls.filter((c) => c.startsWith("DELETE"));
  assert.deepEqual(deletes, ["DELETE https://api.github.com/repos/o/r/hooks/1"]);
  assert.deepEqual(s.created.events, ["pull_request", "workflow_run"]);
  assert.equal(s.created.config.url, "https://new.example/forge");
  assert.equal(s.created.config.secret, SECRET);
  assert.equal(s.created.config.content_type, "json");
  assert.equal(store.getSecret("forge:github:hookId:o/r"), "9");
});

test("registerWebhook leaves another profile's /forge hook alone", async () => {
  const store = makeStore();
  store.setSecret("forge:github:hookId:o/r", "42"); // our previous hook, already gone
  const s = stubHooks([{ id: 5, url: "https://other.example/forge" }]);
  try {
    await forge({}, pipeline, store).registerWebhook("https://new.example/");
  } finally {
    s.restore();
  }
  assert.deepEqual(s.calls.filter((c) => c.startsWith("DELETE")), []);
  assert.equal(store.getSecret("forge:github:hookId:o/r"), "9");
});

test("registerWebhook deletes a hook matching the stored id even if its URL differs (ngrok rotation)", async () => {
  const store = makeStore();
  store.setSecret("forge:github:hookId:o/r", "7");
  const s = stubHooks([{ id: 7, url: "https://ngrok-old.example/forge" }]);
  try {
    await forge({}, pipeline, store).registerWebhook("https://ngrok-new.example/");
  } finally {
    s.restore();
  }
  assert.deepEqual(s.calls.filter((c) => c.startsWith("DELETE")), ["DELETE https://api.github.com/repos/o/r/hooks/7"]);
  assert.equal(store.getSecret("forge:github:hookId:o/r"), "9");
});

test("unregisterWebhooks deletes only the stored-id/previous-URL hook and clears the stored id", async () => {
  const urlFile = publicUrlFile("https://old.example");
  const store = makeStore();
  const s = stubHooks([
    { id: 1, url: "https://old.example/forge" },
    { id: 5, url: "https://other.example/forge" },
  ]);
  try {
    await forge({}, pipeline, store, { publicUrlFile: urlFile }).unregisterWebhooks();
  } finally {
    s.restore();
  }
  assert.deepEqual(s.calls.filter((c) => c.startsWith("DELETE")), ["DELETE https://api.github.com/repos/o/r/hooks/1"]);
  assert.equal(store.getSecret("forge:github:hookId:o/r"), "");
});

test("a missing/unset publicUrlFile does not throw", async () => {
  const s = stubHooks([{ id: 1, url: "https://old.example/forge" }]);
  try {
    await assert.doesNotReject(forge().unregisterWebhooks());
  } finally {
    s.restore();
  }
});

test("registerWebhook on 403 prints manual setup instead of throwing", async () => {
  const orig = global.fetch;
  const warn = console.warn;
  /** @type {string[]} */
  const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  // @ts-ignore - test stub
  global.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  try {
    await forge().registerWebhook("https://new.example");
  } finally {
    global.fetch = orig;
    console.warn = warn;
  }
  assert.ok(warnings.some((w) => w.includes("https://new.example/forge") && w.includes("Pull requests") && w.includes("Workflow runs")));
});

// --- registry ---

test("createForge: null without a forge block; throws on an unknown type", () => {
  assert.equal(createForge(/** @type {any} */ ({ pipeline }), /** @type {any} */ (makeStore())), null);
  assert.throws(() => createForge(/** @type {any} */ ({ pipeline, forge: { type: "bitbucket" } }), /** @type {any} */ (makeStore())), /unknown forge "bitbucket"/);
});

test("listAgentPrs: only same-repo agent/<ref> PRs, with CI roll-up and mergeability", async () => {
  const pr = (number, ref, extra = {}) => ({ number, title: `t${number}`, html_url: `u${number}`, draft: false, updated_at: "now", head: { ref, sha: `sha${number}`, repo: { full_name: "o/r" } }, ...extra });
  const s = stubFetch({
    "GET /repos/o/r/pulls?state=open&per_page=100&page=1": {
      json: [pr(1, "agent/10"), pr(2, "agent/11"), pr(3, "feature/x"), pr(4, "agent/12", { head: { ref: "agent/12", sha: "s4", repo: { full_name: "fork/r" } } }), pr(5, "agent/13", { draft: true })],
    },
    "GET /repos/o/r/pulls/1": { json: { mergeable: true, mergeable_state: "clean" } },
    "GET /repos/o/r/pulls/2": { json: { mergeable: false, mergeable_state: "dirty" } },
    "GET /repos/o/r/pulls/5": { json: { mergeable: null, mergeable_state: "unknown" } },
    "GET /repos/o/r/commits/sha1/check-runs?per_page=100": { json: { check_runs: [{ status: "completed", conclusion: "success" }] } },
    "GET /repos/o/r/commits/sha2/check-runs?per_page=100": { json: { check_runs: [{ status: "completed", conclusion: "failure" }, { status: "completed", conclusion: "success" }] } },
    "GET /repos/o/r/commits/sha5/check-runs?per_page=100": { json: { check_runs: [{ status: "in_progress", conclusion: null }] } },
  });
  try {
    const out = await forge().listAgentPrs?.();
    assert.deepEqual(out?.map((p) => [p.number, p.ref, p.ci, p.mergeable, p.mergeState, p.draft]), [
      [1, "10", "success", true, "clean", false],
      [2, "11", "failure", false, "dirty", false],
      [5, "13", "pending", null, "unknown", true],
    ]);
  } finally {
    s.restore();
  }
});

test("cfg.branchPrefix: listAgentPrs maps local/<ref> and skips agent/<ref> (#674)", async () => {
  const pr = (number, ref, extra = {}) => ({ number, title: `t${number}`, html_url: `u${number}`, draft: false, updated_at: "now", head: { ref, sha: `sha${number}`, repo: { full_name: "o/r" } }, ...extra });
  const s = stubFetch({
    "GET /repos/o/r/pulls?state=open&per_page=100&page=1": { json: [pr(1, "local/10"), pr(2, "agent/11")] },
    "GET /repos/o/r/pulls/1": { json: { mergeable: true, mergeable_state: "clean" } },
    "GET /repos/o/r/commits/sha1/check-runs?per_page=100": { json: { check_runs: [] } },
  });
  try {
    const f = forge({}, pipeline, makeStore(), { branchPrefix: "local/" });
    const out = await /** @type {any} */ (f).listAgentPrs();
    assert.deepEqual(out.map((p) => [p.number, p.ref]), [[1, "10"]]);
  } finally {
    s.restore();
  }
});

test("listAgentPrs: a failing list call throws; a failing detail call degrades that PR only", async () => {
  let s = stubFetch({ "GET /repos/o/r/pulls?state=open&per_page=100&page=1": { status: 500, json: {} } });
  try {
    await assert.rejects(() => /** @type {any} */ (forge()).listAgentPrs(), /list PRs 500/);
  } finally {
    s.restore();
  }
  s = stubFetch({ "GET /repos/o/r/pulls?state=open&per_page=100&page=1": { json: [{ number: 1, title: "t", html_url: "u", draft: false, updated_at: "n", head: { ref: "agent/1", sha: "s", repo: { full_name: "o/r" } } }] } });
  try {
    const out = await /** @type {any} */ (forge()).listAgentPrs();
    assert.equal(out[0].ci, "unknown", "a failed check-runs call is not 'no CI'");
    assert.equal(out[0].mergeable, null);
  } finally {
    s.restore();
  }
});

test("listAgentPrs: pages past 100 open PRs; cancelled/startup_failure/action_required are not green; a failed check-runs call is `unknown`, not `none`", async () => {
  const mk = (n, sha) => ({ number: n, title: "t", html_url: "u", draft: false, updated_at: "n", head: { ref: `agent/${n}`, sha, repo: { full_name: "o/r" } } });
  const page1 = Array.from({ length: 100 }, (_, i) => mk(1000 + i, `s${i}`)).map((p, i) => (i < 98 ? { ...p, head: { ...p.head, ref: `feature/${i}` } } : p)); // 2 agent PRs on page 1
  const s = stubFetch({
    "GET /repos/o/r/pulls?state=open&per_page=100&page=1": { json: page1 },
    "GET /repos/o/r/pulls?state=open&per_page=100&page=2": { json: [mk(2001, "late"), mk(2002, "boom")] },
    "GET /repos/o/r/commits/s98/check-runs?per_page=100": { json: { check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "cancelled" }] } },
    "GET /repos/o/r/commits/s99/check-runs?per_page=100": { json: { check_runs: [{ status: "completed", conclusion: "action_required" }] } },
    "GET /repos/o/r/commits/late/check-runs?per_page=100": { json: { check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "neutral" }] } },
    "GET /repos/o/r/commits/boom/check-runs?per_page=100": { status: 502, json: {} },
  });
  try {
    const out = await /** @type {any} */ (forge()).listAgentPrs();
    assert.deepEqual(out.map((/** @type {any} */ p) => [p.number, p.ci]), [[1098, "failure"], [1099, "failure"], [2001, "success"], [2002, "unknown"]]);
  } finally {
    s.restore();
  }
});

test("listAgentPrs: a not-yet-computed mergeability is re-read once instead of reported as unknown", async () => {
  const orig = global.fetch;
  let detailCalls = 0;
  // @ts-ignore - test stub
  global.fetch = async (/** @type {string} */ url) => {
    const u = String(url);
    const reply = (/** @type {any} */ body) => ({ ok: true, status: 200, json: async () => body });
    if (u.includes("/pulls?state=open")) return reply([{ number: 1, title: "t", html_url: "u", draft: false, updated_at: "n", head: { ref: "agent/1", sha: "s", repo: { full_name: "o/r" } } }]);
    if (u.endsWith("/pulls/1")) {
      detailCalls++;
      return reply(detailCalls === 1 ? { mergeable: null, mergeable_state: "unknown" } : { mergeable: true, mergeable_state: "clean" });
    }
    return reply({ check_runs: [{ status: "completed", conclusion: "success" }] });
  };
  try {
    const out = await /** @type {any} */ (forge()).listAgentPrs();
    assert.equal(detailCalls, 2);
    assert.deepEqual([out[0].mergeable, out[0].mergeState], [true, "clean"]);
  } finally {
    global.fetch = orig;
  }
});

test("listMergedAgentPrs: only merged agent/* PRs merged after since; stops paging at a page reaching updated_at < since", async () => {
  const since = "2026-10-10T00:00:00Z";
  const pr = (/** @type {number} */ number, /** @type {string} */ ref, /** @type {string|null} */ merged_at, /** @type {string} */ updated_at) => ({ number, merged_at, updated_at, head: { ref } });
  const page1 = Array.from({ length: 100 }, (_, i) => pr(1000 + i, `feature/${i}`, "2026-10-12T00:00:00Z", "2026-10-12T00:00:00Z"));
  page1[0] = pr(1, "agent/10", "2026-10-11T00:00:00Z", "2026-10-11T00:00:00Z"); // ✓
  page1[1] = pr(2, "agent/11", null, "2026-10-11T00:00:00Z"); // closed, not merged
  page1[2] = pr(3, "agent/12", "2026-10-09T00:00:00Z", "2026-10-11T00:00:00Z"); // merged before since (updated later)
  const page2 = [pr(4, "agent/13", "2026-10-10T12:00:00.000Z", "2026-10-10T12:00:00Z"), pr(5, "agent/14", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z")];
  page2.push(...Array.from({ length: 98 }, (_, i) => pr(2000 + i, `agent/x${i}`, "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z")));
  const s = stubFetch({
    "GET /repos/o/r/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1": { json: page1 },
    "GET /repos/o/r/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=2": { json: page2 },
    "GET /repos/o/r/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=3": { json: [pr(9, "agent/99", "2026-10-20T00:00:00Z", "2026-10-20T00:00:00Z")] },
  });
  try {
    const out = await /** @type {any} */ (forge()).listMergedAgentPrs(since);
    assert.deepEqual(out, [
      { pr: 1, ref: "10", mergedAt: "2026-10-11T00:00:00Z" },
      { pr: 4, ref: "13", mergedAt: "2026-10-10T12:00:00.000Z" },
    ]);
    assert.equal(s.calls.length, 2, "page 2 reached updated_at < since — page 3 is never fetched");
  } finally {
    s.restore();
  }
});

test("listMergedAgentPrs: boardCloses per PR on a same-repo github tracker", async () => {
  const base = { ref: "main", repo: { default_branch: "main" } };
  const at = "2026-10-11T00:00:00Z";
  const s = stubFetch({
    "GET /repos/o/r/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1": {
      json: [
        { number: 1, merged_at: at, updated_at: at, head: { ref: "agent/10" }, base, body: "Closes #10" },
        { number: 2, merged_at: at, updated_at: at, head: { ref: "agent/11" }, base, body: "Closes #10" },
      ],
    },
  });
  try {
    const out = await /** @type {any} */ (forge({}, pipeline, makeStore(), ghTracker)).listMergedAgentPrs("2026-10-10T00:00:00Z");
    assert.deepEqual(out, [
      { pr: 1, ref: "10", mergedAt: at, boardCloses: true },
      { pr: 2, ref: "11", mergedAt: at },
    ]);
  } finally {
    s.restore();
  }
});

test("listMergedAgentPrs: a non-2xx throws", async () => {
  const s = stubFetch({ "GET /repos/o/r/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1": { status: 502, json: {} } });
  try {
    await assert.rejects(() => /** @type {any} */ (forge()).listMergedAgentPrs("2026-10-10T00:00:00Z"), /list closed PRs 502/);
  } finally {
    s.restore();
  }
});

test("ciStatus: whole check-run roll-up + mergeability for one PR head", async () => {
  const run = (/** @type {any} */ o) => ({ status: "completed", conclusion: "success", ...o });
  const cases = [
    [[run(), run()], "success"],
    [[run(), run({ status: "in_progress", conclusion: null })], "pending"],
    [[run(), run({ conclusion: "failure" })], "failure"],
    [[], "none"],
  ];
  for (const [check_runs, want] of cases) {
    const s = stubFetch({
      "GET /repos/o/r/pulls/77": { json: { mergeable: true, mergeable_state: "clean" } },
      "GET /repos/o/r/commits/abc/check-runs?per_page=100": { json: { check_runs } },
    });
    try {
      assert.deepEqual(await forge().ciStatus(77, "abc"), { mergeable: true, mergeState: "clean", ci: want });
    } finally {
      s.restore();
    }
  }
});

// --- GitHub App auth (src/github/auth.js) ---

const APP_PEM = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const APP_AUTH = { type: "app", appId: "101", installationId: "202", privateKey: APP_PEM };

test("forgeBlock with the tracker's App auth: auth instead of token", () => {
  assert.deepEqual(forgeBlock({ repository: "o/r", auth: /** @type {any} */ (APP_AUTH) }), { type: "github", repository: "o/r", auth: APP_AUTH });
});

test("App auth: forge calls carry Bearer <installation token>; a 401 mints a fresh one and retries once", async () => {
  resetGithubAuthCache();
  let mints = 0;
  /** @type {string[]} */
  const seen = [];
  const orig = global.fetch;
  // @ts-ignore - test stub: the first installation token is rejected (revoked), the second works
  global.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/app/installations/202/access_tokens")) {
      mints++;
      return { ok: true, status: 201, json: async () => ({ token: `inst-${mints}`, expires_at: new Date(Date.now() + 3600e3).toISOString() }) };
    }
    const h = /** @type {any} */ (init.headers).Authorization;
    seen.push(`${init.method || "GET"} ${url} ${h}`);
    return h === "Bearer inst-2" ? { ok: true, status: 201, json: async () => ({}) } : { ok: false, status: 401, json: async () => ({ message: "Bad credentials" }) };
  };
  try {
    await forge({ token: undefined, auth: APP_AUTH }).rerunFailedJobs(555);
    await forge({ token: undefined, auth: APP_AUTH }).rerunFailedJobs(556);
  } finally {
    global.fetch = orig;
  }
  assert.deepEqual(seen, [
    "POST https://api.github.com/repos/o/r/actions/runs/555/rerun-failed-jobs Bearer inst-1",
    "POST https://api.github.com/repos/o/r/actions/runs/555/rerun-failed-jobs Bearer inst-2",
    "POST https://api.github.com/repos/o/r/actions/runs/556/rerun-failed-jobs Bearer inst-2",
  ]);
  assert.equal(mints, 2);
});

test("App auth: registerWebhook on 403 names the App's Webhooks permission", async () => {
  resetGithubAuthCache();
  const orig = global.fetch;
  const warn = console.warn;
  /** @type {string[]} */
  const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  // @ts-ignore - test stub
  global.fetch = async (url) =>
    String(url).endsWith("/access_tokens")
      ? { ok: true, status: 201, json: async () => ({ token: "inst", expires_at: new Date(Date.now() + 3600e3).toISOString() }) }
      : { ok: false, status: 403, json: async () => ({}) };
  try {
    await forge({ token: undefined, auth: APP_AUTH }).registerWebhook("https://new.example");
  } finally {
    global.fetch = orig;
    console.warn = warn;
  }
  assert.ok(warnings.some((w) => w.includes("GitHub App's Webhooks: Read & write")), warnings.join("\n"));
});
