import { describe, it, expect } from "vitest";
import example from "../../agenthook.config.example.json?raw";
import {
  addStep,
  advancedSet,
  boolEdit,
  ciTargetOptions,
  clientErrors,
  defaultBoolEdit,
  effectiveBool,
  escalateEdit,
  formattingFor,
  identityEdit,
  ingressFields,
  ingressType,
  liteEdit,
  liteHeadingsEdit,
  moveStep,
  numberEdit,
  readBasics,
  readSteps,
  refInProgress,
  secretState,
  sectionFields,
  setCount,
  removeStep,
  renameEdit,
  setPath,
  stageKeysFor,
  stageSource,
  stepErrors,
  stepPath,
  textEdit,
} from "./configEdit";
import type { Discover } from "./configEdit";

/** The changed middle of a line diff: lines past the common prefix and before the common suffix. */
function lineDiff(a: string, b: string): { removed: string[]; added: string[] } {
  const x = a.split("\n");
  const y = b.split("\n");
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  return { removed: x.slice(p, x.length - s), added: y.slice(p, y.length - s) };
}

const raw = () => JSON.parse(example);
const commentKeys = (text: string) => text.split("\n").filter((l) => /^\s*"\/\//.test(l));

describe("formattingFor", () => {
  it("infers the indent unit and EOL", () => {
    expect(formattingFor(example)).toEqual({ insertSpaces: true, tabSize: 2, eol: "\n" });
    expect(formattingFor('{\r\n    "a": 1\r\n}')).toEqual({ insertSpaces: true, tabSize: 4, eol: "\r\n" });
    expect(formattingFor('{\n\t"a": 1\n}').insertSpaces).toBe(false);
    expect(formattingFor('{"a":1}')).toEqual({ insertSpaces: true, tabSize: 2, eol: "\n" });
  });
});

describe("read", () => {
  it("readBasics / readSteps", () => {
    expect(readBasics(raw())).toEqual({ name: "myproject", maxConcurrent: 2, fullAuto: false, port: 4123, trigger: "@agent" });
    expect(readSteps(raw()).map((s) => s.id)).toEqual(["triage", "code", "review"]);
    expect(readSteps({})).toEqual([]);
    expect(readSteps({ tracker: { pipeline: [1] } })).toEqual([{}]);
  });
});

describe("basics edits change only that value", () => {
  const cases: [string, (t: string) => string, string][] = [
    ["name", (t) => textEdit(t, ["name"], "other"), '  "name": "other",'],
    ["trigger", (t) => textEdit(t, ["trigger"], "@bot"), '  "trigger": "@bot",'],
    ["maxConcurrent", (t) => (numberEdit(t, ["maxConcurrent"], "5") as { text: string }).text, '  "maxConcurrent": 5,'],
    ["port", (t) => (numberEdit(t, ["port"], "8080") as { text: string }).text, '  "port": 8080,'],
    ["fullAuto", (t) => boolEdit(t, ["fullAuto"], true, false, true), '  "fullAuto": true,'],
  ];
  for (const [key, edit, line] of cases) {
    it(key, () => {
      const out = edit(example);
      const d = lineDiff(example, out);
      expect(d.added).toEqual([line]);
      expect(d.removed).toHaveLength(1);
      expect(d.removed[0]).toMatch(new RegExp(`^  "${key}": `));
      expect(commentKeys(out)).toEqual(commentKeys(example));
    });
  }

  it("fullAuto unchecked writes an explicit false", () => {
    const on = boolEdit(example, ["fullAuto"], true, false, true);
    expect(boolEdit(on, ["fullAuto"], false, true, true)).toBe(example);
  });
});

describe("renameEdit", () => {
  it("sets name and inserts stateId immediately after it, preserving comments/indentation/key order", () => {
    const out = renameEdit(example, "renamed", "myproject");
    expect(raw()["stateId"]).toBeUndefined(); // not present in the fixture before the edit
    const parsed = JSON.parse(out);
    expect(parsed.name).toBe("renamed");
    expect(parsed.stateId).toBe("myproject");
    expect(Object.keys(parsed).indexOf("stateId")).toBe(Object.keys(parsed).indexOf("name") + 1);
    expect(commentKeys(out)).toEqual(commentKeys(example));
    const lines = out.split("\n");
    const nameLine = lines.findIndex((l) => /^\s*"name": /.test(l));
    expect(lines[nameLine + 1]).toMatch(/^\s*"stateId": "myproject",$/);
  });

  it("is a no-op insert when stateId is already present", () => {
    const withId = setPath(example, ["stateId"], "myproject");
    const out = renameEdit(withId, "renamed", "myproject");
    const parsed = JSON.parse(out);
    expect(parsed.name).toBe("renamed");
    expect(parsed.stateId).toBe("myproject");
    expect(commentKeys(out)).toEqual(commentKeys(withId));
    // Only the name line changed — stateId was already there, so no second insertion.
    const d = lineDiff(withId, out);
    expect(d.added).toEqual(['  "name": "renamed",']);
    expect(d.removed).toEqual(['  "name": "myproject",']);
  });
});

describe("step edits change only that value", () => {
  // code = pipeline[1]: id/kind/maxAttempts/createsWorktree/instructionsFile/stage keys exist; the rest are inserted.
  const replaced: [string, (t: string) => string, string][] = [
    ["id", (t) => textEdit(t, stepPath(1, "id"), "build"), '        "id": "build",'],
    ["kind", (t) => textEdit(t, stepPath(1, "kind"), "change"), '        "kind": "change",'],
    ["maxAttempts", (t) => (numberEdit(t, stepPath(1, "maxAttempts"), "4") as { text: string }).text, '        "maxAttempts": 4,'],
    ["instructionsFile", (t) => textEdit(t, stepPath(1, "instructionsFile"), "./X.md"), '        "instructionsFile": "./X.md",'],
    ["sourceSectionGid", (t) => textEdit(t, stepPath(1, "sourceSectionGid"), "S1"), '        "sourceSectionGid": "S1",'],
    ["successSectionGid", (t) => textEdit(t, stepPath(1, "successSectionGid"), "S2"), '        "successSectionGid": "S2",'],
    ["failureSectionGid", (t) => textEdit(t, stepPath(1, "failureSectionGid"), "S3"), '        "failureSectionGid": "S3",'],
  ];
  for (const [key, edit, line] of replaced) {
    it(`replace ${key}`, () => {
      const out = edit(example);
      const d = lineDiff(example, out);
      expect(d.added).toEqual([line]);
      expect(d.removed).toHaveLength(1);
      expect(d.removed[0]).toMatch(new RegExp(`^        "${key}": `));
      expect(commentKeys(out)).toEqual(commentKeys(example));
    });
  }

  it("replace the last key (holdSectionGid) keeps no trailing comma", () => {
    const d = lineDiff(example, textEdit(example, stepPath(1, "holdSectionGid"), "H"));
    expect(d).toEqual({ removed: ['        "holdSectionGid": "NEEDS_ANSWER_GID"'], added: ['        "holdSectionGid": "H"'] });
  });

  const inserted: [string, (t: string) => string, string][] = [
    ["model", (t) => textEdit(t, stepPath(1, "model"), "claude-opus-5-5"), '"claude-opus-5-5"'],
    ["effort", (t) => textEdit(t, stepPath(1, "effort"), "high"), '"high"'],
    ["maxMinutes", (t) => (numberEdit(t, stepPath(1, "maxMinutes"), "30") as { text: string }).text, "30"],
    ["idleMinutes", (t) => (numberEdit(t, stepPath(1, "idleMinutes"), "5") as { text: string }).text, "5"],
    ["drainWorktree", (t) => boolEdit(t, stepPath(1, "drainWorktree"), true, undefined), "true"],
    ["manual", (t) => boolEdit(t, stepPath(1, "manual"), true, undefined), "true"],
    ["queueSectionGid", (t) => textEdit(t, stepPath(1, "queueSectionGid"), "Q"), '"Q"'],
  ];
  for (const [key, edit, value] of inserted) {
    it(`insert ${key}`, () => {
      const out = edit(example);
      const last = '        "holdSectionGid": "NEEDS_ANSWER_GID"';
      expect(lineDiff(example, out)).toEqual({ removed: [last], added: [`${last},`, `        "${key}": ${value}`] });
      expect(readSteps(JSON.parse(out))[1][key]).toEqual(JSON.parse(value));
    });
  }

  it("createsWorktree unchecked removes a true key; on an absent key it's a no-op", () => {
    const out = boolEdit(example, stepPath(1, "createsWorktree"), false, true);
    expect(lineDiff(example, out)).toEqual({ removed: ['        "createsWorktree": true,'], added: [] });
    expect(boolEdit(example, stepPath(1, "manual"), false, undefined)).toBe(example);
  });
});

describe("clearing a field removes the key", () => {
  it("text / number / select", () => {
    for (const [path, edit] of [
      [["name"], (t: string, p: (string | number)[]) => textEdit(t, p, "")],
      [["port"], (t: string, p: (string | number)[]) => (numberEdit(t, p, " ") as { text: string }).text],
      [stepPath(2, "effort"), (t: string, p: (string | number)[]) => textEdit(t, p, "")],
      [stepPath(1, "maxAttempts"), (t: string, p: (string | number)[]) => (numberEdit(t, p, "") as { text: string }).text],
      [stepPath(2, "failureSectionGid"), (t: string, p: (string | number)[]) => textEdit(t, p, "")],
    ] as const) {
      const out = edit(example, [...path]);
      const parsed = JSON.parse(out);
      const key = path[path.length - 1] as string;
      const holder = path.length === 1 ? parsed : parsed.tracker.pipeline[path[2] as number];
      expect(Object.hasOwn(holder, key)).toBe(false);
      expect(lineDiff(example, out).added.length).toBeLessThanOrEqual(1);
      expect(out).not.toMatch(new RegExp(`"${key}": ""`));
    }
  });

  it("a non-numeric number input is not applied", () => {
    expect(numberEdit(example, ["port"], "80a")).toEqual({ ok: false, error: "not a number" });
    expect(numberEdit(example, ["port"], "-")).toEqual({ ok: false, error: "not a number" });
    expect(numberEdit(example, ["port"], "0x10")).toEqual({ ok: false, error: "not a number" });
    expect(numberEdit(example, ["port"], "1.5")).toMatchObject({ ok: true });
  });

  it("setPath with undefined on an absent key is a no-op", () => {
    expect(setPath(example, ["nope"], undefined)).toBe(example);
  });
});

describe("addStep / removeStep / moveStep", () => {
  it("addStep appends one step with a unique id; earlier steps byte-identical", () => {
    const out = addStep(example);
    const steps = readSteps(JSON.parse(out));
    expect(steps).toHaveLength(4);
    expect(steps[3]).toEqual({ id: "step-4", kind: "implement" });
    const end = example.indexOf('"failureSectionGid": "BLOCKED_GID"\n      }', example.indexOf('"id": "review"'));
    const prefix = example.slice(0, example.indexOf("}", end) + 1);
    expect(out.startsWith(prefix)).toBe(true);
    expect(addStep(out).includes('"id": "step-5"')).toBe(true);
    // A taken step-N is skipped.
    const taken = textEdit(example, stepPath(0, "id"), "step-4");
    expect(readSteps(JSON.parse(addStep(taken)))[3].id).toBe("step-5");
  });

  it("removeStep removes exactly that element, no dangling comma", () => {
    for (const i of [0, 1, 2]) {
      const out = removeStep(example, i);
      const steps = readSteps(JSON.parse(out));
      expect(steps.map((s) => s.id)).toEqual(["triage", "code", "review"].filter((_, j) => j !== i));
      expect(out).not.toMatch(/,\s*\]/);
    }
  });

  it("moveStep swaps with comment keys intact; reversing restores the text exactly", () => {
    const down = moveStep(example, 0, 1);
    const steps = readSteps(JSON.parse(down));
    expect(steps.map((s) => s.id)).toEqual(["code", "triage", "review"]);
    expect(steps[1]["//lite"]).toBe(raw().tracker.pipeline[0]["//lite"]);
    expect(steps[0]["//maxAttempts"]).toBe(raw().tracker.pipeline[1]["//maxAttempts"]);
    expect([...commentKeys(down)].sort()).toEqual([...commentKeys(example)].sort());
    expect(moveStep(down, 1, -1)).toBe(example);
    const up = moveStep(example, 2, -1);
    expect(readSteps(JSON.parse(up)).map((s) => s.id)).toEqual(["triage", "review", "code"]);
    expect(moveStep(up, 1, 1)).toBe(example);
  });

  it("moveStep out of range is a no-op", () => {
    expect(moveStep(example, 0, -1)).toBe(example);
    expect(moveStep(example, 2, 1)).toBe(example);
  });
});

describe("stageKeysFor", () => {
  it("prefers discover.stageKeys", () => {
    const keys = { source: "a", success: "b", failure: "c", hold: "d", queue: "e" };
    const d: Discover = { tracker: "x", stageKeys: keys, stages: null };
    expect(stageKeysFor(d, "asana")).toBe(keys);
  });

  it("falls back by tracker.type", () => {
    expect(stageKeysFor(null, "asana")).toEqual({
      source: "sourceSectionGid",
      success: "successSectionGid",
      failure: "failureSectionGid",
      hold: "holdSectionGid",
      queue: "queueSectionGid",
    });
    expect(stageKeysFor(null, "github")?.source).toBe("sourceLabel");
    for (const t of ["jira", "github-projects", "local"]) expect(stageKeysFor(null, t)?.queue).toBe("queueStatus");
    expect(stageKeysFor({ tracker: "github", stageKeys: null, stages: null }, "github")?.hold).toBe("holdLabel");
    expect(stageKeysFor(null, "trello")).toBeNull();
    expect(stageKeysFor(null, undefined)).toBeNull();
    expect(stageKeysFor(null, "toString")).toBeNull();
  });
});

describe("advancedSet", () => {
  const githubKeys = stageKeysFor(null, "github")!;
  const asanaKeys = stageKeysFor(null, "asana")!;

  it("a step with no advanced values set has none", () => {
    expect(advancedSet({ id: "code", kind: "implement" }, "github", githubKeys)).toEqual([]);
  });

  it("a default value does not count", () => {
    expect(advancedSet({ maxMinutes: 120 }, "github", githubKeys)).toEqual([]);
  });

  it("maxMinutes: 0 counts, even though it's falsy", () => {
    expect(advancedSet({ maxMinutes: 0 }, "github", githubKeys)).toEqual(["maxMinutes"]);
  });

  it("holdLabel set on a github step counts", () => {
    expect(advancedSet({ holdLabel: "agent:held" }, "github", githubKeys)).toEqual(["holdLabel"]);
  });

  it("closeIssue on an asana config is out of scope and never counts", () => {
    expect(advancedSet({ closeIssue: true }, "asana", asanaKeys)).toEqual([]);
  });

  it("completeOnMerge in scope for every tracker counts when set", () => {
    expect(advancedSet({ completeOnMerge: true }, "github", githubKeys)).toEqual(["completeOnMerge"]);
  });
});

describe("clientErrors", () => {
  it("the example is clean", () => {
    expect(clientErrors(raw())).toEqual([]);
  });

  it("flags empty / duplicate ids and bad numbers, in validateRawConfig's wording", () => {
    const pipeline = [{ id: "" }, { id: "a", maxAttempts: 0 }, { id: "a", maxMinutes: -1 }, { id: "b", idleMinutes: 0 }, { id: "c", maxAttempts: 1.5 }, {}];
    expect(clientErrors({ tracker: { pipeline } })).toEqual([
      'config: every pipeline step needs an "id".',
      'config: pipeline step "a" maxAttempts must be a positive integer.',
      'config: duplicate pipeline step id "a".',
      'config: pipeline step "a" maxMinutes must be a number >= 0 (0 disables the cap).',
      'config: pipeline step "b" idleMinutes must be a number > 0.',
      'config: pipeline step "c" maxAttempts must be a positive integer.',
      'config: every pipeline step needs an "id".',
    ]);
    expect(clientErrors({ tracker: { pipeline: [{ id: "x", maxMinutes: "5" }] } })).toEqual([
      'config: pipeline step "x" maxMinutes must be a number >= 0 (0 disables the cap).',
    ]);
  });
});

describe("stepErrors", () => {
  const obj = (m: Map<number, string[]>) => Object.fromEntries(m);

  it("the example is clean", () => {
    expect(stepErrors(raw(), []).size).toBe(0);
  });

  it("attributes a missing id to its own index and a duplicate id to the later step", () => {
    const pipeline = [{ id: "a" }, {}, { id: "a" }];
    expect(obj(stepErrors({ tracker: { pipeline } }, []))).toEqual({
      1: ['config: every pipeline step needs an "id".'],
      2: ['config: duplicate pipeline step id "a".'],
    });
  });

  it("attributes a numeric-field error to its step", () => {
    const pipeline = [{ id: "a" }, { id: "b", maxAttempts: 0, idleMinutes: 0 }];
    expect(obj(stepErrors({ tracker: { pipeline } }, []))).toEqual({
      1: ['config: pipeline step "b" maxAttempts must be a positive integer.', 'config: pipeline step "b" idleMinutes must be a number > 0.'],
    });
  });

  it("attributes server messages by step id (first match) and by pipeline[i]; unmatched ones are left out", () => {
    const pipeline = [{ id: "triage" }, { id: "code" }, "oops"];
    const server = [
      'config: pipeline step "code" completeOnMerge requires manual:true (no agent runs on a merge).',
      "config: tracker.pipeline[2] must be an object.",
      'config: pipeline step "ghost" maxConcurrent must be a positive integer.',
      "config: tracker.pipeline[9] must be an object.",
      'config: "repoPath" is required.',
    ];
    expect(obj(stepErrors({ tracker: { pipeline } }, server))).toEqual({
      1: ['config: pipeline step "code" completeOnMerge requires manual:true (no agent runs on a merge).'],
      2: ["config: tracker.pipeline[2] must be an object."],
    });
  });

  it("lists an error once when the client check and the server agree", () => {
    const pipeline = [{ id: "a", maxAttempts: 0 }];
    const msg = 'config: pipeline step "a" maxAttempts must be a positive integer.';
    expect(obj(stepErrors({ tracker: { pipeline } }, [msg]))).toEqual({ 0: [msg] });
  });

  it("clientErrors is the flat view of the same checks", () => {
    const pipeline = [{ id: "a" }, {}, { id: "a", maxMinutes: -1 }];
    expect(clientErrors({ tracker: { pipeline } })).toEqual([...stepErrors({ tracker: { pipeline } }, []).values()].flat());
  });
});

describe("stageSource", () => {
  it("maps the discover outcome", () => {
    const stages = [{ id: "1", label: "Todo" }];
    expect(stageSource(200, { tracker: "asana", stageKeys: null, stages })).toEqual({ kind: "list", stages });
    expect(stageSource(503, null)).toEqual({ kind: "text", hint: "receiver not running — type the value" });
    expect(stageSource(200, { tracker: "x", stageKeys: null, stages: null })).toEqual({ kind: "text", hint: "couldn't list stages (the tracker has no stage list)" });
    expect(stageSource(404, null).kind).toBe("text");
    expect(stageSource(504, null)).toEqual({ kind: "text", hint: "couldn't list stages (receiver timed out)" });
    expect(stageSource(502, { error: "boom" } as any)).toEqual({ kind: "text", hint: "couldn't list stages (receiver error: boom)" });
    expect(stageSource(0, null)).toEqual({ kind: "text", hint: "couldn't list stages (network error)" });
  });
});

describe("identityEdit", () => {
  const base = JSON.stringify({ name: "p", repoPath: "/r" }, null, 2);

  it("creates the ui block, then sets and replaces its fields", () => {
    const a = identityEdit(base, "color", "teal");
    expect(JSON.parse(a).ui).toEqual({ color: "teal" });
    const b = identityEdit(a, "emoji", "🚀");
    expect(JSON.parse(b).ui).toEqual({ color: "teal", emoji: "🚀" });
    expect(JSON.parse(identityEdit(b, "color", "pink")).ui).toEqual({ color: "pink", emoji: "🚀" });
  });

  it("going back to automatic removes the key, and an emptied ui block with it", () => {
    const both = identityEdit(identityEdit(base, "color", "teal"), "emoji", "🚀");
    expect(JSON.parse(identityEdit(both, "color", undefined)).ui).toEqual({ emoji: "🚀" });
    expect(JSON.parse(identityEdit(identityEdit(both, "color", undefined), "emoji", undefined))).toEqual({ name: "p", repoPath: "/r" });
  });

  it("is a no-op on a config with no ui block when clearing", () => {
    expect(JSON.parse(identityEdit(base, "emoji", undefined))).toEqual({ name: "p", repoPath: "/r" });
  });

  it("keeps comment keys and other fields intact", () => {
    const text = '{\n  "//": "note",\n  "name": "p"\n}';
    const out = identityEdit(text, "color", "sky");
    expect(JSON.parse(out)).toEqual({ "//": "note", name: "p", ui: { color: "sky" } });
  });
});

describe("escalateEdit", () => {
  const noBlock = JSON.stringify({ tracker: { pipeline: [{ id: "code" }] } }, null, 2);

  it("adds a value to a step with no escalate block", () => {
    const out = escalateEdit(noBlock, 0, "easy", "model", "claude-haiku-5-5");
    expect(JSON.parse(out).tracker.pipeline[0].escalate).toEqual({ easy: { model: "claude-haiku-5-5" } });
  });

  it("edits an existing value", () => {
    const a = escalateEdit(noBlock, 0, "easy", "model", "claude-haiku-5-5");
    const b = escalateEdit(a, 0, "easy", "model", "claude-sonnet-5");
    expect(JSON.parse(b).tracker.pipeline[0].escalate).toEqual({ easy: { model: "claude-sonnet-5" } });
  });

  it("clears one leaf, keeping its sibling", () => {
    const a = escalateEdit(noBlock, 0, "easy", "model", "claude-haiku-5-5");
    const b = escalateEdit(a, 0, "easy", "effort", "low");
    const c = escalateEdit(b, 0, "easy", "model", "");
    expect(JSON.parse(c).tracker.pipeline[0].escalate).toEqual({ easy: { effort: "low" } });
  });

  it("clearing the last leaf removes the difficulty row, then the whole key once it's the last difficulty", () => {
    const withTwo = JSON.stringify({ tracker: { pipeline: [{ id: "code", escalate: { easy: { model: "a" }, hard: { model: "b" } } }] } }, null, 2);
    const a = escalateEdit(withTwo, 0, "easy", "model", "");
    expect(JSON.parse(a).tracker.pipeline[0].escalate).toEqual({ hard: { model: "b" } });
    const b = escalateEdit(a, 0, "hard", "model", "");
    expect(JSON.parse(b).tracker.pipeline[0]).not.toHaveProperty("escalate");
  });

  it("clearing when escalate (or the difficulty) is absent is a no-op, never throws", () => {
    expect(escalateEdit(noBlock, 0, "easy", "model", "")).toBe(noBlock);
    const onlyHard = JSON.stringify({ tracker: { pipeline: [{ id: "code", escalate: { hard: { model: "b" } } }] } }, null, 2);
    expect(escalateEdit(onlyHard, 0, "easy", "model", "")).toBe(onlyHard);
  });

  it("keeps comment and unknown keys inside the step, and inside escalate (an extra difficulty), through every edit", () => {
    const text = JSON.stringify(
      { tracker: { pipeline: [{ "//": "note", id: "code", unknownKey: 1, escalate: { "//": "note2", extreme: { model: "z" }, easy: { model: "a", effort: "low" } } }] } },
      null,
      2,
    );
    const a = escalateEdit(text, 0, "easy", "effort", "");
    const step = JSON.parse(a).tracker.pipeline[0];
    expect(step["//"]).toBe("note");
    expect(step.unknownKey).toBe(1);
    expect(step.escalate["//"]).toBe("note2");
    expect(step.escalate.extreme).toEqual({ model: "z" });
    expect(step.escalate.easy).toEqual({ model: "a" });
  });
});

describe("liteEdit / liteHeadingsEdit", () => {
  const noBlock = JSON.stringify({ tracker: { pipeline: [{ id: "code" }] } }, null, 2);

  it("adds a value to a step with no lite block", () => {
    const out = liteEdit(noBlock, 0, "model", "claude-haiku-5-5");
    expect(JSON.parse(out).tracker.pipeline[0].lite).toEqual({ model: "claude-haiku-5-5" });
  });

  it("edits an existing value", () => {
    const a = liteEdit(noBlock, 0, "model", "claude-haiku-5-5");
    const b = liteEdit(a, 0, "model", "claude-sonnet-5");
    expect(JSON.parse(b).tracker.pipeline[0].lite).toEqual({ model: "claude-sonnet-5" });
  });

  it("clears one leaf, keeping its sibling", () => {
    const a = liteEdit(noBlock, 0, "model", "claude-haiku-5-5");
    const b = liteEdit(a, 0, "effort", "low");
    const c = liteEdit(b, 0, "model", "");
    expect(JSON.parse(c).tracker.pipeline[0].lite).toEqual({ effort: "low" });
  });

  it("clearing the last leaf removes lite entirely", () => {
    const a = liteEdit(noBlock, 0, "model", "claude-haiku-5-5");
    const b = liteEdit(a, 0, "model", "");
    expect(JSON.parse(b).tracker.pipeline[0]).not.toHaveProperty("lite");
  });

  it("clearing when lite is absent is a no-op, never throws", () => {
    expect(liteEdit(noBlock, 0, "model", "")).toBe(noBlock);
  });

  it("keeps comment and unknown keys inside the step, and inside lite, through every edit", () => {
    const text = JSON.stringify(
      { tracker: { pipeline: [{ "//": "note", id: "code", unknownKey: 1, lite: { "//": "note2", unknownLite: "x", model: "a", effort: "low" } }] } },
      null,
      2,
    );
    const a = liteEdit(text, 0, "effort", "");
    const step = JSON.parse(a).tracker.pipeline[0];
    expect(step["//"]).toBe("note");
    expect(step.unknownKey).toBe(1);
    expect(step.lite).toEqual({ "//": "note2", unknownLite: "x", model: "a" });
  });

  it("headings: add, remove, reorder; blanks are never written; removing the last one removes descriptionHeadings", () => {
    const a = liteHeadingsEdit(noBlock, 0, ["one"]);
    expect(JSON.parse(a).tracker.pipeline[0].lite).toEqual({ descriptionHeadings: ["one"] });
    const b = liteHeadingsEdit(a, 0, ["one", "two"]);
    expect(JSON.parse(b).tracker.pipeline[0].lite.descriptionHeadings).toEqual(["one", "two"]);
    const c = liteHeadingsEdit(b, 0, ["two", "one"]);
    expect(JSON.parse(c).tracker.pipeline[0].lite.descriptionHeadings).toEqual(["two", "one"]);
    const d = liteHeadingsEdit(c, 0, ["two", "one", "  ", ""]);
    expect(JSON.parse(d).tracker.pipeline[0].lite.descriptionHeadings).toEqual(["two", "one"]);
    const e = liteHeadingsEdit(d, 0, ["two"]);
    expect(JSON.parse(e).tracker.pipeline[0].lite.descriptionHeadings).toEqual(["two"]);
    const f = liteHeadingsEdit(e, 0, []);
    expect(JSON.parse(f).tracker.pipeline[0]).not.toHaveProperty("lite");
  });

  it("removing the last heading removes lite entirely only when no other lite key remains", () => {
    const withModel = JSON.stringify({ tracker: { pipeline: [{ id: "code", lite: { descriptionHeadings: ["one"], model: "a" } }] } }, null, 2);
    const out = liteHeadingsEdit(withModel, 0, []);
    expect(JSON.parse(out).tracker.pipeline[0].lite).toEqual({ model: "a" });
  });

  it("clearing headings when lite (or descriptionHeadings) is absent is a no-op, never throws", () => {
    expect(liteHeadingsEdit(noBlock, 0, [])).toBe(noBlock);
    const onlyModel = JSON.stringify({ tracker: { pipeline: [{ id: "code", lite: { model: "a" } }] } }, null, 2);
    expect(liteHeadingsEdit(onlyModel, 0, [])).toBe(onlyModel);
  });

  it("a trailing or internal space in a heading is kept, not trimmed", () => {
    const out = liteHeadingsEdit(noBlock, 0, ["Problem statement "]);
    expect(JSON.parse(out).tracker.pipeline[0].lite.descriptionHeadings).toEqual(["Problem statement "]);
  });

  it("emptying a row mid-edit (one blank entry among others) drops only that entry, keeps the rest", () => {
    const a = liteHeadingsEdit(noBlock, 0, ["one", "two"]);
    const out = liteHeadingsEdit(a, 0, ["", "two"]);
    expect(JSON.parse(out).tracker.pipeline[0].lite.descriptionHeadings).toEqual(["two"]);
  });
});

describe("Tracker / Forge / Ingress helpers (#341)", () => {
  it("setPath removing an absent key (even under a missing parent) is a no-op", () => {
    const text = '{\n  "name": "p"\n}';
    expect(setPath(text, ["ingress", "url"], undefined)).toBe(text);
    expect(setPath(text, ["nope"], undefined)).toBe(text);
  });

  it("defaultBoolEdit: away from the default writes the value, back to it removes the key; boolEdit unchanged", () => {
    const text = '{\n  "forge": { "type": "github" }\n}';
    const off = defaultBoolEdit(text, ["forge", "redCi"], false, true);
    expect(JSON.parse(off).forge).toEqual({ type: "github", redCi: false });
    expect(JSON.parse(defaultBoolEdit(off, ["forge", "redCi"], true, true)).forge).toEqual({ type: "github" });
    expect(effectiveBool(undefined, true)).toBe(true);
    expect(effectiveBool(false, true)).toBe(false);
    // The plain boolEdit still makes unchecking an absent key a no-op.
    expect(boolEdit(text, ["forge", "redCi"], false, undefined)).toBe(text);
  });

  it("sectionFields: the section's keys minus type/pipeline, scoped, split by advanced", () => {
    const keys = (r: ReturnType<typeof sectionFields>) => ({ common: r.common.map((e) => e.path[1]), advanced: r.advanced.map((e) => e.path[1]) });
    expect(keys(sectionFields("tracker", "local"))).toEqual({ common: ["assigneeFilter"], advanced: ["routeField"] });
    expect(keys(sectionFields("forge", undefined))).toEqual({ common: ["token", "repository", "redCi", "greenCi"], advanced: ["owner", "repo", "webhookSecret", "ciTarget"] });
    expect(keys(ingressFields("ngrok"))).toEqual({ common: ["authtoken", "domain"], advanced: ["webAddr"] });
    expect(keys(ingressFields("hosted"))).toEqual({ common: ["url"], advanced: [] });
    expect(keys(ingressFields("custom"))).toEqual({ common: [], advanced: [] });
  });

  it("ingressType: absent block or type → manual", () => {
    expect(ingressType({})).toBe("manual");
    expect(ingressType({ ingress: {} })).toBe("manual");
    expect(ingressType({ ingress: { type: "ngrok" } })).toBe("ngrok");
  });

  it("setCount skips unset, empty and default values", () => {
    const adv = sectionFields("ingress", undefined).advanced;
    expect(setCount({ webAddr: "127.0.0.1:4040" }, adv)).toBe(0);
    expect(setCount({ webAddr: "127.0.0.1:4041" }, adv)).toBe(1);
    expect(setCount(undefined, adv)).toBe(0);
  });

  it("secretState / refInProgress", () => {
    expect([undefined, "", "${A}", false, "lit", 12].map(secretState)).toEqual(["absent", "absent", "ref", "disabled", "literal", "literal"]);
    for (const s of ["$", "${", "${GH_TO", "${GH_TOKEN}"]) expect(refInProgress(s), s).toBe(true);
    for (const s of ["", "ghp_x", "${a}", "x${A}"]) expect(refInProgress(s), s).toBe(false);
  });

  it("ciTargetOptions: non-manual step ids; the default is the first createsWorktree step", () => {
    const raw = { tracker: { pipeline: [{ id: "a" }, { id: "b", createsWorktree: true }, { id: "m", manual: true }, { kind: "x" }] } };
    expect(ciTargetOptions(raw)).toEqual({ ids: ["a", "b"], defaultId: "b" });
    expect(ciTargetOptions({})).toEqual({ ids: [], defaultId: null });
  });
});
