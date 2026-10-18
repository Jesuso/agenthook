import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CONFIG_SCHEMA, NO_FORM, schemaEntry, stepEntry } from "../src/config-schema.js";
import { SENSITIVE_FIELDS } from "../src/ui/contract.js";

// Drift guard: every key the config typedefs in src/types.js declare must have a schema entry
// (so the forms can reach it) or a NO_FORM reason. Adding a @property without either fails here.

const TYPES = fs.readFileSync(new URL("../src/types.js", import.meta.url), "utf8");

/** The `{…}` starting at `s[i]` (balanced braces), and the index just past it. @param {string} s @param {number} i */
function braced(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}" && --depth === 0) return { body: s.slice(i + 1, j), end: j + 1 };
  }
  throw new Error(`unbalanced braces at ${i}`);
}

/** `@property` name → its type text, for the JSDoc block that declares `@typedef {object} <name>`. @param {string} name */
function typedefProps(name) {
  const block = TYPES.split("/**").find((b) => new RegExp(`@typedef \\{object\\} ${name}\\s`).test(b.split("*/")[0]));
  assert.ok(block, `typedef ${name} not found in src/types.js`);
  const text = block.split("*/")[0];
  /** @type {Map<string, string>} */
  const props = new Map();
  for (let i = text.indexOf("@property"); i !== -1; i = text.indexOf("@property", i + 1)) {
    const { body, end } = braced(text, text.indexOf("{", i));
    const m = /^\s*\[?([A-Za-z_$][\w$]*)/.exec(text.slice(end));
    assert.ok(m, `${name}: unparsable @property at ${i}`);
    props.set(m[1], body);
  }
  return props;
}

/** Top-level keys of the first object-literal type inside `type` (`{a?: x, b: {c: y}}` → a, b). @param {string} type */
function literalKeys(type) {
  const { body } = braced(type, type.indexOf("{"));
  const keys = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{" || c === "(" || c === "[" || c === "<") depth++;
    else if (c === "}" || c === ")" || c === "]" || c === ">") depth--;
    else if (depth === 0) {
      const m = /^([A-Za-z_$][\w$]*)\??\s*:/.exec(body.slice(i));
      if (m && !/[\w$]/.test(body[i - 1] ?? "")) {
        keys.push(m[1]);
        i += m[0].length - 1;
      }
    }
  }
  return keys;
}

const config = typedefProps("Config");
const stepProps = typedefProps("Step");
const STEP = ["tracker", "pipeline", "*"];

/** @type {Array<[string, string[], string[]]>} source label, path prefix, keys */
const GROUPS = [
  ["Config", [], [...config.keys()]],
  ["Step", STEP, [...stepProps.keys()]],
  ["ProviderConfig", ["tracker"], [...typedefProps("ProviderConfig").keys()]],
  ["IngressConfig", ["ingress"], [...typedefProps("IngressConfig").keys()]],
  ["SinkConfig", ["sinks", "*"], [...typedefProps("SinkConfig").keys()]],
  ["ForgeConfig", ["forge"], [...typedefProps("ForgeConfig").keys()]],
  ["RepoConfig", ["repos", "*"], [...typedefProps("RepoConfig").keys()]],
  ["Config.ui", ["ui"], literalKeys(config.get("ui") ?? "")],
  ["Config.digest", ["digest"], literalKeys(config.get("digest") ?? "")],
  ["Config.energy", ["energy"], literalKeys(config.get("energy") ?? "")],
  ["Config.energy.source", ["energy", "source"], literalKeys((config.get("energy") ?? "").slice((config.get("energy") ?? "").indexOf("source:")))],
  ["Step.lite", [...STEP, "lite"], literalKeys(stepProps.get("lite") ?? "")],
  ["Step.escalate", [...STEP, "escalate", "*"], literalKeys(stepProps.get("escalate") ?? "")],
];

const schemaPaths = new Set(CONFIG_SCHEMA.map((e) => e.path.join(".")));

test("the typedef parser is non-trivial (a regex change can't make the drift test pass on nothing)", () => {
  assert.ok(stepProps.size >= 20, `found only ${stepProps.size} Step keys`);
  assert.ok(config.size >= 20, `found only ${config.size} Config keys`);
  const find = (/** @type {string} */ label) => GROUPS.find((g) => g[0] === label)?.[2];
  assert.deepEqual(find("Config.ui"), ["color", "emoji"]);
  assert.deepEqual(find("Config.digest"), ["soul", "access", "model", "maxBudgetUsd"]);
  assert.deepEqual(find("Config.energy"), ["usdPerKwh", "source"]);
  assert.deepEqual(find("Config.energy.source"), ["type", "name", "cmd", "watts"]);
  assert.deepEqual(find("Step.lite"), ["descriptionHeadings", "model", "effort"]);
  assert.deepEqual(find("Step.escalate"), ["model", "effort"]);
});

test("every typedef config key has a schema entry or a NO_FORM reason", () => {
  const missing = [];
  for (const [label, prefix, keys] of GROUPS) {
    for (const k of keys) {
      const dotted = [...prefix, k].join(".");
      if (!schemaPaths.has(dotted) && !Object.hasOwn(NO_FORM, dotted)) missing.push(`${label}.${k} → ${dotted}`);
    }
  }
  assert.deepEqual(missing, [], `config keys with no schema entry (add one to src/config-schema.js, or a NO_FORM reason):\n${missing.join("\n")}`);
});

test("NO_FORM entries carry a reason and never shadow a schema entry", () => {
  for (const [path, reason] of Object.entries(NO_FORM)) {
    assert.ok(typeof reason === "string" && reason.trim(), `NO_FORM ${path} has no reason`);
    assert.ok(!schemaPaths.has(path), `${path} is both a schema entry and NO_FORM`);
  }
});

test("every schema entry is well-formed: unique path, one-line help ≤120 chars, a valid section, options for enums", () => {
  const SECTIONS = ["basics", "pipeline-step", "tracker", "forge", "ingress", "integrations", "repos"];
  const TYPES_ = ["string", "number", "boolean", "enum", "string-list", "record", "object", "array"];
  assert.equal(schemaPaths.size, CONFIG_SCHEMA.length, "duplicate schema paths");
  for (const e of CONFIG_SCHEMA) {
    const at = e.path.join(".");
    assert.ok(e.path.length && e.path.every((s) => typeof s === "string" && s), `${at}: bad path`);
    assert.ok(typeof e.label === "string" && e.label.trim(), `${at}: no label`);
    assert.ok(typeof e.help === "string" && e.help.trim(), `${at}: empty help`);
    assert.ok(!/[\r\n]/.test(e.help), `${at}: multi-line help`);
    assert.ok(e.help.length <= 120, `${at}: help is ${e.help.length} chars (max 120)`);
    assert.ok(SECTIONS.includes(e.section), `${at}: invalid section ${e.section}`);
    assert.ok(TYPES_.includes(e.type), `${at}: invalid type ${e.type}`);
    if (e.type === "enum") assert.ok(Array.isArray(e.options) && e.options.length, `${at}: enum without options`);
    if (e.default !== undefined && e.options) assert.ok(e.options.includes(String(e.default)), `${at}: default not among options`);
    if (e.editor !== undefined) assert.equal(e.editor, "pending", `${at}: unknown editor`);
  }
});

test("the sensitive set equals SENSITIVE_FIELDS (which stays the source of truth)", () => {
  const sensitive = CONFIG_SCHEMA.filter((e) => e.sensitive).map((e) => e.path.join(".")).sort();
  const expected = SENSITIVE_FIELDS.map((f) => f.replaceAll("[*]", ".*")).sort();
  assert.deepEqual(sensitive, expected);
});

test("no schema entry is left pending (#343): every documented key has a form", () => {
  for (const e of CONFIG_SCHEMA) {
    const at = e.path.join(".");
    assert.equal(e.editor, undefined, `${at}: still editor:"pending" — give it a form`);
  }
});

test("schemaEntry matches indices and record keys against '*'; stepEntry is the step shorthand", () => {
  assert.equal(schemaEntry(["tracker", "pipeline", 2, "maxMinutes"])?.default, 120);
  assert.equal(schemaEntry(["tracker", "pipeline", 0, "escalate", "hard", "model"])?.label, "Escalated model");
  assert.equal(schemaEntry(["sinks", 1, "url"])?.sensitive, true);
  assert.equal(schemaEntry(["maxConcurrent"])?.min, 1);
  assert.equal(schemaEntry(["nope"]), undefined);
  assert.equal(schemaEntry(["tracker", "pipeline", 0]), undefined);
  assert.equal(stepEntry("maxAttempts"), schemaEntry(["tracker", "pipeline", 0, "maxAttempts"]));
  assert.equal(stepEntry("lite.effort")?.options?.length, 5);
});
