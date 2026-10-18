// Tracker conformance suite — the executable spec of the `Adapter` contract
// (src/types.js `Adapter`, prose copy at the top of src/trackers/asana.js). Every tracker
// adapter runs the same checks through a FIXTURE module (test/fixtures/trackers/<name>.js);
// tracker-specific behaviour stays in that tracker's own test file.
//
// A fixture exports:
//   name                      the tracker key (also the test-name prefix)
//   create(cfg, store)        the adapter factory
//   makeCfg()                 a fresh Config. pipeline[1] is the step the suite advances, pipeline[0]
//                             the `changes` target; both bind source/success/failure/hold stages, and
//                             only pipeline[0] binds a queue stage
//   refs                      { ours, notOurs? } — `ours` is assigned to us and rests in pipeline[1]'s
//                             source stage; `notOurs` (assigneeScoped only) rests there too, assigned
//                             to someone else
//   webhooks, handshake, assigneeScoped, resume   capability flags; a false flag SKIPS (reported as
//                             skipped) the checks that need it — the suite never special-cases a tracker
//   setup?(env)               seed state before the adapter is built (board file, handshake secret)
//   fetch?(url, init, env)    the fake tracker API (undefined → 404). Absent = the adapter must make
//                             NO network call at all (any fetch fails the check)
//   signedRequest(env) / badSignatureRequest(env) / handshakeRequest(env)  → EventCtx
//   ourEvent(env)             → { ctx, expect: {stepId, ref} } — a delivery for `ours`
//   notOursEvent(env)         → EventCtx — the same delivery for `notOurs`
//   commentEvent(env, {author: "owner"|"other", body})  (resume only) → EventCtx — a new comment on
//                             `ours` with that body, by our own identity ("owner") or someone else
//   stageOf(env, ref)         the stage the adapter's LAST move wrote for `ref` (read off env.calls or
//                             the board), or null when it never moved it
//
// `env` = { fixture, cfg, store, adapter, calls }; `calls` records every fetch as
// { url, method, body }. The check* helpers are exported so a meta-test can run one against
// a deliberately broken adapter (test/conformance.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import { MoveRefusedError } from "../../src/trackers/owner.js";
import { makeStore } from "./store-stub.js";
import { respond } from "./http.js";

/** @typedef {{url: string, method: string, body?: string}} Call */
/** @typedef {{fixture: any, cfg: any, store: any, adapter: any, calls: Call[]}} Env */

const JOB_KINDS = new Set(["pipeline", "merge", "ci", "ci_green", "epic_changed"]);
const STAGE_KEY_NAMES = ["source", "success", "failure", "hold", "queue"];
const OPTIONAL = [
  "enterStage", "currentStage", "listQueued", "openBlockers", "ownership", "forgeCatchup", "listStages",
  "listEpics", "listEpicTickets", "complete", "ensureLabels", "wizardSteps", "pipelineBindings", "createTask",
];

/**
 * Build a fresh env (cfg + store + adapter) with global.fetch swapped for a recording stub,
 * run `fn`, restore fetch. `opts.fetch` overrides the fixture's fake API (e.g. an erroring one).
 * @template T @param {any} fixture @param {(env: Env) => Promise<T>|T} fn
 * @param {{fetch?: (url: string, init: any, env: Env) => any}} [opts] @returns {Promise<T>}
 */
export async function withEnv(fixture, fn, opts = {}) {
  const cfg = fixture.makeCfg();
  const store = makeStore();
  /** @type {Env} */
  const env = { fixture, cfg, store, adapter: null, calls: [] };
  const impl = opts.fetch ?? fixture.fetch;
  const orig = globalThis.fetch;
  // @ts-ignore - test stub
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: String(init.method || "GET").toUpperCase(), body: typeof init.body === "string" ? init.body : undefined };
    env.calls.push(call);
    if (!impl) throw new Error(`${fixture.name}: unexpected fetch ${call.method} ${call.url} — the fixture declares no network`);
    return (await impl(call.url, init, env)) ?? respond(404, { message: "Not Found" });
  };
  try {
    fixture.setup?.(env);
    env.adapter = fixture.create(cfg, store);
    return await fn(env);
  } finally {
    globalThis.fetch = orig;
  }
}

/** The binding-key family: describe().stageKeys, else the fixture's. @param {Env} env */
function stageKeys(env) {
  const keys = env.adapter.describe().stageKeys ?? env.fixture.stageKeys;
  assert.ok(keys, `${env.fixture.name}: describe().stageKeys is absent and the fixture supplies none`);
  return keys;
}

/** pipeline[1] (advanced) and pipeline[0] (the `changes` target). @param {Env} env */
function steps(env) {
  const [back, step] = env.cfg.pipeline || [];
  assert.ok(back && step, `${env.fixture.name}: fixture pipeline needs ≥2 steps`);
  return { step, back };
}

/** Assert `job` is a well-formed Job for this cfg. @param {any} job @param {any} cfg @param {string} name */
export function checkJob(job, cfg, name) {
  const where = `${name}: job ${JSON.stringify(job)}`;
  assert.ok(JOB_KINDS.has(job?.kind), `${where}: kind must be one of ${[...JOB_KINDS].join("|")}`);
  assert.ok(typeof job.ref === "string" && job.ref !== "", `${where}: ref must be a non-empty string`);
  assert.equal(typeof job.stepId, "string", `${where}: stepId must be a string`);
  if (job.kind === "pipeline") assert.ok((cfg.pipeline || []).some((/** @type {any} */ s) => s.id === job.stepId), `${where}: stepId must name a pipeline step`);
  assert.ok(typeof job.dedupKey === "string" && job.dedupKey !== "", `${where}: dedupKey must be a non-empty string`);
  if (job.comment !== undefined) assert.equal(typeof job.comment, "string", `${where}: comment must be a string`);
}

/** processEvents, with a rejection read as "no jobs" (the engine logs it and drops the batch).
 * @param {Env} env @param {any} ctx @returns {Promise<any[]>} */
async function eventsOrNone(env, ctx) {
  try {
    return await env.adapter.processEvents(ctx);
  } catch {
    return [];
  }
}

/** describe(): the four prompt words are strings; stageKeys (when present) has all five keys. No network.
 * @param {any} fixture */
export function checkDescribe(fixture) {
  return withEnv(fixture, (env) => {
    const m = env.adapter.describe();
    for (const k of ["platform", "taskNoun", "trigger", "commentHowTo"]) assert.ok(typeof m[k] === "string" && m[k] !== "", `${fixture.name}: describe().${k} must be a non-empty string`);
    if (m.readCommentsHowTo !== undefined) assert.equal(typeof m.readCommentsHowTo, "string");
    if (m.usesPR !== undefined) assert.equal(typeof m.usesPR, "boolean");
    if (m.stageKeys !== undefined) for (const k of STAGE_KEY_NAMES) assert.equal(typeof m.stageKeys[k], "string", `${fixture.name}: describe().stageKeys.${k} must be a string`);
    assert.equal(env.calls.length, 0, `${fixture.name}: describe() must not fetch`);
  });
}

/** authenticate() is SYNC, returns an AuthResult and does no network I/O. @param {any} fixture */
export function checkAuthenticateSync(fixture) {
  return withEnv(fixture, (env) => {
    const ctx = fixture.signedRequest?.(env) ?? { pathname: "/", headers: {}, rawBody: "" };
    const r = env.adapter.authenticate(ctx);
    assert.ok(r && typeof r.then !== "function", `${fixture.name}: authenticate must return synchronously (not a Promise)`);
    assert.ok(["accept", "reject", "handshake"].includes(r.type), `${fixture.name}: unknown AuthResult type ${r.type}`);
    assert.equal(env.calls.length, 0, `${fixture.name}: authenticate must not fetch`);
  });
}

/** With webhooks: a valid signature → accept; a bad or absent one → reject. No network. @param {any} fixture */
export function checkSignature(fixture) {
  return withEnv(fixture, (env) => {
    const signed = fixture.signedRequest(env);
    assert.deepEqual(env.adapter.authenticate(signed), { type: "accept" }, `${fixture.name}: a validly signed delivery must be accepted`);
    assert.equal(env.adapter.authenticate(fixture.badSignatureRequest(env)).type, "reject", `${fixture.name}: a bad signature must be rejected`);
    assert.equal(env.adapter.authenticate({ ...signed, headers: {} }).type, "reject", `${fixture.name}: an absent signature must be rejected`);
    assert.equal(env.calls.length, 0, `${fixture.name}: authenticate must not fetch`);
  });
}

/** With handshake: the handshake request → {type:'handshake', headers} of strings. No network. @param {any} fixture */
export function checkHandshake(fixture) {
  return withEnv(fixture, (env) => {
    const r = env.adapter.authenticate(fixture.handshakeRequest(env));
    assert.equal(r.type, "handshake", `${fixture.name}: the handshake request must answer a handshake`);
    assert.ok(r.headers && typeof r.headers === "object", `${fixture.name}: a handshake carries reply headers`);
    for (const [k, v] of Object.entries(r.headers)) assert.equal(typeof v, "string", `${fixture.name}: handshake header ${k} must be a string`);
    assert.equal(env.calls.length, 0, `${fixture.name}: authenticate must not fetch`);
  });
}

/** An unparseable delivery resolves to [] (never throws, never a job). @param {any} fixture */
export function checkIgnoresGarbage(fixture) {
  return withEnv(fixture, async (env) => {
    const p = env.adapter.processEvents({ pathname: "/", headers: {}, rawBody: "not json" });
    assert.equal(typeof p?.then, "function", `${fixture.name}: processEvents must return a Promise`);
    assert.deepEqual(await p, [], `${fixture.name}: an unparseable/irrelevant delivery yields no jobs`);
  });
}

/** ourEvent → ≥1 well-formed job, one of them the expected pipeline job. @param {any} fixture */
export function checkProcessEvents(fixture) {
  return withEnv(fixture, async (env) => {
    const { ctx, expect } = fixture.ourEvent(env);
    const jobs = await env.adapter.processEvents(ctx);
    assert.ok(Array.isArray(jobs) && jobs.length >= 1, `${fixture.name}: ourEvent must yield ≥1 job, got ${JSON.stringify(jobs)}`);
    for (const j of jobs) checkJob(j, env.cfg, fixture.name);
    assert.ok(
      jobs.some((j) => j.kind === "pipeline" && j.ref === expect.ref && j.stepId === expect.stepId),
      `${fixture.name}: expected a pipeline job ${JSON.stringify(expect)}, got ${JSON.stringify(jobs)}`,
    );
  });
}

/** With assigneeScoped: a delivery for an item that isn't ours yields NO pipeline job (fail-closed). @param {any} fixture */
export function checkDropsNotOurs(fixture) {
  return withEnv(fixture, async (env) => {
    const jobs = await eventsOrNone(env, fixture.notOursEvent(env));
    const pipelineJobs = (jobs || []).filter((j) => j.kind === "pipeline");
    assert.equal(pipelineJobs.length, 0, `${fixture.name}: a not-ours item must yield no pipeline job, got ${JSON.stringify(pipelineJobs)}`);
  });
}

/** With assigneeScoped: when every tracker lookup errors (5xx), ourEvent yields no pipeline job.
 * Returns a skip reason when ourEvent routes without any lookup (nothing to fail). @param {any} fixture
 * @returns {Promise<string|undefined>} */
export function checkFailClosedOnLookupError(fixture) {
  return withEnv(
    fixture,
    async (env) => {
      const jobs = await eventsOrNone(env, fixture.ourEvent(env).ctx);
      if (env.calls.length === 0) return `${fixture.name}: ourEvent routes without a tracker lookup — nothing to fail`;
      const pipelineJobs = (jobs || []).filter((j) => j.kind === "pipeline");
      assert.equal(pipelineJobs.length, 0, `${fixture.name}: an erroring ownership/API lookup must yield no pipeline job, got ${JSON.stringify(pipelineJobs)}`);
      return undefined;
    },
    { fetch: () => respond(500, { message: "boom" }) },
  );
}

/** With resume: an owner `@agent` comment on `ours`, held on pipeline[1], yields exactly one
 * pipeline job resuming that step (dedupKey `trigger:…`, comment = the body); the same comment
 * with no held record yields none. @param {any} fixture */
export async function checkResume(fixture) {
  const body = `${fixture.makeCfg().trigger} the answer is 42`;
  await withEnv(fixture, async (env) => {
    const { step } = steps(env);
    const ref = fixture.refs.ours;
    env.store.setHeld(ref, { stepId: step.id });
    const jobs = await env.adapter.processEvents(fixture.commentEvent(env, { author: "owner", body }));
    for (const j of jobs) checkJob(j, env.cfg, fixture.name);
    const pipelineJobs = jobs.filter((/** @type {any} */ j) => j.kind === "pipeline");
    assert.equal(pipelineJobs.length, 1, `${fixture.name}: an owner @agent comment on a held item must yield exactly one pipeline job, got ${JSON.stringify(jobs)}`);
    const [j] = pipelineJobs;
    assert.equal(j.ref, ref, `${fixture.name}: the resume job must name ${ref}`);
    assert.equal(j.stepId, step.id, `${fixture.name}: the resume job must re-run the held step ${step.id}`);
    assert.ok(j.dedupKey.startsWith("trigger:"), `${fixture.name}: the resume dedupKey must be trigger:-prefixed, got ${j.dedupKey}`);
    assert.equal(j.comment, body, `${fixture.name}: the resume job must carry the comment body`);
  });
  await withEnv(fixture, async (env) => {
    const jobs = await eventsOrNone(env, fixture.commentEvent(env, { author: "owner", body }));
    const pipelineJobs = jobs.filter((/** @type {any} */ j) => j.kind === "pipeline");
    assert.equal(pipelineJobs.length, 0, `${fixture.name}: an @agent comment with no held record must yield no pipeline job, got ${JSON.stringify(pipelineJobs)}`);
  });
}

/** advance(ref, step, verdict) lands in the stage each outcome maps to: advance → success,
 * fail → failure, hold → hold, changes(target) → the target's source. @param {any} fixture */
export async function checkAdvance(fixture) {
  /** @type {Array<[any, (s: any, b: any, k: any) => string]>} */
  const cases = [
    [{ outcome: "advance" }, (s, _b, k) => s[k.success]],
    [{ outcome: "fail" }, (s, _b, k) => s[k.failure]],
    [{ outcome: "hold" }, (s, _b, k) => s[k.hold]],
    [{ outcome: "changes", target: "<back>" }, (_s, b, k) => b[k.source]],
  ];
  for (const [v, want] of cases) {
    await withEnv(fixture, async (env) => {
      const { step, back } = steps(env);
      const keys = stageKeys(env);
      const verdict = v.target ? { ...v, target: back.id } : v;
      const expected = want(step, back, keys);
      assert.ok(typeof expected === "string" && expected, `${fixture.name}: fixture pipeline must bind a stage for ${verdict.outcome}`);
      await env.adapter.advance(fixture.refs.ours, step.id, verdict);
      assert.equal(fixture.stageOf(env, fixture.refs.ours), expected, `${fixture.name}: advance ${verdict.outcome} must move ${fixture.refs.ours} to ${expected}`);
    });
  }
}

/** With assigneeScoped: advancing an item that isn't ours rejects with MoveRefusedError and moves nothing. @param {any} fixture */
export function checkAdvanceRefusesNotOurs(fixture) {
  return withEnv(fixture, async (env) => {
    const { step } = steps(env);
    await assert.rejects(env.adapter.advance(fixture.refs.notOurs, step.id, { outcome: "advance" }), (e) => {
      assert.ok(e instanceof MoveRefusedError, `${fixture.name}: expected MoveRefusedError, got ${e}`);
      return true;
    });
    assert.equal(fixture.stageOf(env, fixture.refs.notOurs), null, `${fixture.name}: a refused advance must not move the item`);
  });
}

/** fetchTask → Task shape; ours is assignedToUs, a not-ours item (assigneeScoped) is not. @param {any} fixture */
export function checkFetchTask(fixture) {
  return withEnv(fixture, async (env) => {
    const t = await env.adapter.fetchTask(fixture.refs.ours);
    for (const k of ["ref", "name", "url"]) assert.equal(typeof t[k], "string", `${fixture.name}: Task.${k} must be a string`);
    assert.equal(t.ref, fixture.refs.ours, `${fixture.name}: Task.ref must echo the requested ref`);
    for (const k of ["completed", "assignedToUs"]) assert.equal(typeof t[k], "boolean", `${fixture.name}: Task.${k} must be a boolean`);
    for (const k of ["description", "displayId"]) if (t[k] !== undefined) assert.equal(typeof t[k], "string", `${fixture.name}: Task.${k} must be a string when set`);
    if (t.routeKeys !== undefined) assert.ok(Array.isArray(t.routeKeys) && t.routeKeys.every((/** @type {any} */ k) => typeof k === "string"), `${fixture.name}: Task.routeKeys must be string[]`);
    assert.equal(t.assignedToUs, true, `${fixture.name}: our item must be assignedToUs`);
    if (fixture.assigneeScoped) assert.equal((await env.adapter.fetchTask(fixture.refs.notOurs)).assignedToUs, false, `${fixture.name}: a not-ours item must not be assignedToUs`);
  });
}

/** listResting → Job[] incl. ours (never notOurs when scoped); listQueued → string[], [] without a queue key. @param {any} fixture */
export function checkListShapes(fixture) {
  return withEnv(fixture, async (env) => {
    const { step, back } = steps(env);
    const keys = stageKeys(env);
    const jobs = await env.adapter.listResting();
    assert.ok(Array.isArray(jobs), `${fixture.name}: listResting must resolve to an array`);
    for (const j of jobs) checkJob(j, env.cfg, fixture.name);
    assert.ok(jobs.some((j) => j.ref === fixture.refs.ours && j.stepId === step.id), `${fixture.name}: listResting must list ${fixture.refs.ours} for ${step.id}, got ${JSON.stringify(jobs)}`);
    if (fixture.assigneeScoped) assert.ok(!jobs.some((j) => j.ref === fixture.refs.notOurs), `${fixture.name}: listResting must skip a not-ours item`);
    if (env.adapter.listQueued) {
      assert.ok(back[keys.queue] && !step[keys.queue], `${fixture.name}: fixture must bind a queue stage on pipeline[0] only`);
      const queued = await env.adapter.listQueued(back.id);
      assert.ok(Array.isArray(queued) && queued.every((r) => typeof r === "string"), `${fixture.name}: listQueued must resolve to string[]`);
      assert.deepEqual(await env.adapter.listQueued(step.id), [], `${fixture.name}: listQueued of a step with no queue key must be []`);
    }
  });
}

/** Every optional method is undefined or a function; where present, its result conforms. @param {any} fixture */
export function checkOptional(fixture) {
  return withEnv(fixture, async (env) => {
    const a = env.adapter;
    const { step, back } = steps(env);
    const keys = stageKeys(env);
    const { ours, notOurs } = fixture.refs;
    for (const m of OPTIONAL) assert.ok(a[m] === undefined || typeof a[m] === "function", `${fixture.name}: ${m} must be undefined or a function`);

    if (a.currentStage) {
      const s = await a.currentStage(ours);
      assert.equal(s, step[keys.source], `${fixture.name}: currentStage(${ours}) must be the stage it rests in`);
    }
    if (a.listStages) {
      const stages = await a.listStages();
      assert.ok(Array.isArray(stages), `${fixture.name}: listStages must resolve to an array`);
      for (const s of stages) assert.ok(typeof s?.id === "string" && typeof s?.label === "string", `${fixture.name}: listStages entries are {id,label} strings, got ${JSON.stringify(s)}`);
    }
    if (a.openBlockers) {
      const b = await a.openBlockers(ours);
      assert.ok(Array.isArray(b) && b.every((x) => typeof x === "string"), `${fixture.name}: openBlockers must resolve to string[]`);
    }
    if (a.ownership) {
      assert.equal(await a.ownership(ours), "ours", `${fixture.name}: ownership(${ours})`);
      if (fixture.assigneeScoped) assert.equal(await a.ownership(notOurs), "not_ours", `${fixture.name}: ownership(${notOurs})`);
    }
    if (a.listEpics) {
      const epics = await a.listEpics();
      assert.ok(Array.isArray(epics), `${fixture.name}: listEpics must resolve to an array`);
      for (const e of epics) assert.ok(typeof e.ref === "string" && typeof e.name === "string" && typeof e.completed === "boolean", `${fixture.name}: bad Epic ${JSON.stringify(e)}`);
    }
    if (a.listEpicTickets) {
      const tickets = await a.listEpicTickets(fixture.refs.epic ?? ours);
      assert.ok(Array.isArray(tickets), `${fixture.name}: listEpicTickets must resolve to an array`);
      for (const t of tickets) assert.ok(typeof t.ref === "string" && typeof t.completed === "boolean" && (t.stage === null || typeof t.stage === "string"), `${fixture.name}: bad EpicTicket ${JSON.stringify(t)}`);
    }
    if (a.wizardSteps) assert.ok(Array.isArray(a.wizardSteps({})), `${fixture.name}: wizardSteps must return an array`);
    if (a.pipelineBindings) {
      assert.equal(a.pipelineBindings({}), null, `${fixture.name}: pipelineBindings without stage picks must be null`);
      const b = a.pipelineBindings({ _sourceStage: "s", _successStage: "ok", _failureStage: "no" });
      assert.deepEqual(
        [b?.[keys.source], b?.[keys.success], b?.[keys.failure]],
        ["s", "ok", "no"],
        `${fixture.name}: pipelineBindings must write the stageKeys binding keys, got ${JSON.stringify(b)}`,
      );
    }
    // Last: the only mutation here.
    if (a.enterStage) {
      const r = await a.enterStage(ours, back.id, { assign: false });
      assert.equal(r?.stage, back[keys.source], `${fixture.name}: enterStage must return the source stage it entered`);
      assert.equal(fixture.stageOf(env, ours), back[keys.source], `${fixture.name}: enterStage must move ${ours} into ${back.id}'s source stage`);
    }
  });
}

/** forgeCatchup(ours) → a ForgedEvent the adapter's own authenticate accepts and whose
 * processEvents job carries the same dedupKey + stepId. @param {any} fixture */
export function checkForgeCatchup(fixture) {
  return withEnv(fixture, async (env) => {
    const { step } = steps(env);
    const f = await env.adapter.forgeCatchup(fixture.refs.ours);
    for (const k of ["path", "body", "dedupKey"]) assert.ok(typeof f[k] === "string" && f[k] !== "", `${fixture.name}: ForgedEvent.${k} must be a non-empty string`);
    assert.ok(f.headers && Object.values(f.headers).every((v) => typeof v === "string"), `${fixture.name}: ForgedEvent.headers must be strings`);
    assert.equal(f.stepId, step.id, `${fixture.name}: ForgedEvent.stepId must be the step ${fixture.refs.ours} rests in`);
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [k, v] of Object.entries(f.headers)) headers[k.toLowerCase()] = /** @type {string} */ (v);
    const ctx = { pathname: f.path, headers, rawBody: f.body };
    assert.deepEqual(env.adapter.authenticate(ctx), { type: "accept" }, `${fixture.name}: a forged event must pass authenticate`);
    const jobs = await env.adapter.processEvents(ctx);
    assert.ok(jobs.some((/** @type {any} */ j) => j.dedupKey === f.dedupKey && j.stepId === f.stepId), `${fixture.name}: the forged event's job must carry dedupKey ${f.dedupKey}, got ${JSON.stringify(jobs)}`);
  });
}

/** Register the whole suite for one fixture as node:test cases. A capability the fixture
 * lacks skips its checks (reported as skipped, never silently passed). @param {any} fixture */
export function runTrackerConformance(fixture) {
  const n = fixture.name;
  /** @param {boolean} cond @param {string} why */
  const unless = (cond, why) => (cond ? false : `${n}: ${why}`);
  const noWebhooks = unless(fixture.webhooks, "no webhooks");
  const notScoped = unless(fixture.assigneeScoped, "no assignee scoping");
  const probe = fixture.create(fixture.makeCfg(), makeStore()); // which optional methods exist

  test(`${n}: describe() returns the prompt words + stageKeys`, () => checkDescribe(fixture));
  test(`${n}: authenticate is sync and does no network I/O`, () => checkAuthenticateSync(fixture));
  test(`${n}: authenticate accepts a valid signature, rejects a bad/absent one`, { skip: noWebhooks }, () => checkSignature(fixture));
  test(`${n}: authenticate answers the handshake`, { skip: unless(fixture.handshake, "no handshake") }, () => checkHandshake(fixture));
  test(`${n}: processEvents ignores an unparseable delivery`, () => checkIgnoresGarbage(fixture));
  test(`${n}: processEvents turns a delivery into a well-formed job`, { skip: noWebhooks }, () => checkProcessEvents(fixture));
  test(`${n}: processEvents drops a not-ours item (fail-closed)`, { skip: notScoped || noWebhooks }, () => checkDropsNotOurs(fixture));
  test(`${n}: processEvents yields no job when the lookup errors (fail-closed)`, { skip: notScoped || noWebhooks }, async (t) => {
    const why = await checkFailClosedOnLookupError(fixture);
    if (why) t.skip(why);
  });
  test(`${n}: an owner @agent comment resumes the held step`, { skip: noWebhooks || unless(fixture.resume, "no @agent resume") }, () => checkResume(fixture));
  test(`${n}: advance moves to the stage each verdict maps to`, () => checkAdvance(fixture));
  test(`${n}: advance refuses a not-ours item with MoveRefusedError`, { skip: notScoped }, () => checkAdvanceRefusesNotOurs(fixture));
  test(`${n}: fetchTask returns a Task`, () => checkFetchTask(fixture));
  test(`${n}: listResting / listQueued shapes`, () => checkListShapes(fixture));
  test(`${n}: optional methods conform`, () => checkOptional(fixture));
  test(`${n}: forgeCatchup replays through authenticate + processEvents`, { skip: noWebhooks || unless(typeof probe.forgeCatchup === "function", "no forgeCatchup") }, () => checkForgeCatchup(fixture));
}
