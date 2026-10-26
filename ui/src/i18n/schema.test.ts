import { describe, expect, it } from "vitest";
import { CONFIG_SCHEMA } from "../../../src/config-schema.js";
import { fieldMeta } from "../ConfigForms";
import { SCHEMA_ES } from "./schema.es";

// #562: the config forms' labels and help are translated by an overlay keyed by schema path, not by
// editing src/config-schema.js (the CLI and server share it, in English).
describe("schema overlay", () => {
  const paths = CONFIG_SCHEMA.map((e) => e.path.join(".")).sort();

  it("Spanish covers exactly CONFIG_SCHEMA's paths: none missing, none stale", () => {
    const keys = Object.keys(SCHEMA_ES).sort();
    expect(paths.filter((p) => !(p in SCHEMA_ES)), "missing from schema.es.ts").toEqual([]);
    expect(keys.filter((k) => !paths.includes(k)), "stale in schema.es.ts").toEqual([]);
    for (const [k, v] of Object.entries(SCHEMA_ES)) expect(v.label.trim() && v.help.trim(), k).toBeTruthy();
  });

  it("fieldMeta reads the overlay for its language; English and the raw key are unchanged", () => {
    const en = fieldMeta(["maxConcurrent"]);
    expect(fieldMeta(["maxConcurrent"], "en")).toEqual(en);
    expect(en).toMatchObject({ label: "Max concurrent agents", hint: "maxConcurrent", placeholder: "1 (default)" });
    const es = fieldMeta(["maxConcurrent"], "es");
    expect(es).toMatchObject({ label: SCHEMA_ES.maxConcurrent.label, help: SCHEMA_ES.maxConcurrent.help, hint: "maxConcurrent", placeholder: "1 (predeterminado)" });
    expect(fieldMeta(["tracker", "pipeline", 0, "maxMinutes"], "es").label).toBe(SCHEMA_ES["tracker.pipeline.*.maxMinutes"].label);
    // A path with no entry is its raw key in every language.
    expect(fieldMeta(["nope"], "es")).toMatchObject({ label: "nope", hint: "nope" });
  });
});
