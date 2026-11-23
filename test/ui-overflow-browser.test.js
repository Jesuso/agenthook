// test/ui-overflow/browser.mjs — pure browser-plan + launch-failure classification for the
// check:overflow script (no browser is launched or installed by this test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { browserPlan, launchFailure, LAUNCH_TIMEOUT_MS } from "./ui-overflow/browser.mjs";

test("AH_OVERFLOW_BROWSER unset → playwright path, no executablePath, launch bounded", () => {
  const plan = browserPlan({}, () => true);
  assert.equal(plan.mode, "playwright");
  assert.equal(plan.launchOptions.executablePath, undefined);
  assert.equal(plan.launchOptions.timeout, LAUNCH_TIMEOUT_MS);
  assert.ok(Number.isFinite(plan.launchOptions.timeout) && plan.launchOptions.timeout > 0);
});

test("AH_OVERFLOW_BROWSER empty string → same as unset", () => {
  const plan = browserPlan({ AH_OVERFLOW_BROWSER: "" }, () => true);
  assert.equal(plan.mode, "playwright");
  assert.equal(plan.launchOptions.executablePath, undefined);
  assert.equal(plan.launchOptions.timeout, LAUNCH_TIMEOUT_MS);
});

test("AH_OVERFLOW_BROWSER set and existing → explicit path, executablePath set, no install", () => {
  const p = "/usr/bin/google-chrome";
  const plan = browserPlan({ AH_OVERFLOW_BROWSER: p }, (x) => x === p);
  assert.equal(plan.mode, "explicit");
  assert.equal(plan.path, p);
  assert.equal(plan.launchOptions.executablePath, p);
  assert.equal(plan.launchOptions.timeout, LAUNCH_TIMEOUT_MS);
});

test("AH_OVERFLOW_BROWSER set but missing → error names the variable and the path, code 1 with and without CI", () => {
  const p = "/nope/chromium";
  for (const env of [{}, { CI: "true" }]) {
    const plan = browserPlan({ AH_OVERFLOW_BROWSER: p, ...env }, () => false);
    assert.equal(plan.mode, "error");
    assert.ok(plan.line.startsWith(`AH_OVERFLOW_BROWSER=${p}:`), `line names the variable and path: ${plan.line}`);
    assert.equal(plan.code, 1);
  }
});

test("explicit launch failure → code 1 with and without CI, line names the variable and the path", () => {
  const p = "/usr/bin/google-chrome";
  const plan = browserPlan({ AH_OVERFLOW_BROWSER: p }, () => true);
  const err = new Error("host system too old for Chromium");
  for (const env of [{}, { CI: "true" }]) {
    const f = launchFailure(plan, err, env);
    assert.equal(f.code, 1);
    assert.ok(f.line.startsWith(`AH_OVERFLOW_BROWSER=${p}:`), `line names the variable and path: ${f.line}`);
    assert.ok(f.line.includes("host system too old for Chromium"), `line carries the reason: ${f.line}`);
  }
});

test("playwright launch failure → skip line, code 0 without CI / 1 with CI, mentions AH_OVERFLOW_BROWSER", () => {
  const plan = browserPlan({}, () => true);
  const err = new Error("install exited 1: download blocked");
  const local = launchFailure(plan, err, {});
  assert.equal(local.code, 0);
  assert.ok(local.line.startsWith("skipped: no browser available"), `line: ${local.line}`);
  assert.ok(local.line.includes("AH_OVERFLOW_BROWSER"), `line points at the env var: ${local.line}`);
  const ci = launchFailure(plan, err, { CI: "true" });
  assert.equal(ci.code, 1);
  assert.ok(ci.line.startsWith("skipped: no browser available"));
});
