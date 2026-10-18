import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Tracker conformance — every tracker adapter against the one executable Adapter contract
// (test/conformance/tracker.js), each through its fixture (test/fixtures/trackers/). Plus a
// meta-test: deliberately broken adapters must FAIL the checks, proving the suite has teeth.
import test from "node:test";
import assert from "node:assert/strict";
import { runTrackerConformance, checkDropsNotOurs, checkAdvanceRefusesNotOurs } from "./conformance/tracker.js";
import * as asana from "./fixtures/trackers/asana.js";
import * as jira from "./fixtures/trackers/jira.js";
import * as github from "./fixtures/trackers/github.js";
import * as githubProjects from "./fixtures/trackers/github-projects.js";
import * as local from "./fixtures/trackers/local.js";

for (const fixture of [asana, jira, github, githubProjects, local]) runTrackerConformance(fixture);

// --- meta: the suite catches broken scoping (a wrapped adapter, never a broken one in tree) ---

test("meta: an adapter whose processEvents ignores assignment fails checkDropsNotOurs", async () => {
  const broken = {
    ...github,
    create: (/** @type {any} */ cfg, /** @type {any} */ store) => ({
      ...github.create(cfg, store),
      processEvents: async () => [{ kind: "pipeline", ref: github.refs.notOurs, stepId: "code", dedupKey: "secmove:d-1" }],
    }),
  };
  await assert.rejects(checkDropsNotOurs(broken), /not-ours item must yield no pipeline job/);
});

test("meta: an adapter whose advance skips the owner check fails checkAdvanceRefusesNotOurs", async () => {
  const broken = {
    ...github,
    create: (/** @type {any} */ cfg, /** @type {any} */ store) => ({ ...github.create(cfg, store), advance: async () => {} }),
  };
  await assert.rejects(checkAdvanceRefusesNotOurs(broken));
});
