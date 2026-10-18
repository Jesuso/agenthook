// Local energy basis for opted-in steps (#396, epic #393): a run's measured electricity in kWh
// and dollars, a third figure beside the reported `costUsd` and the rate-table `estUsd` — never
// summed into either, and `costBasis` is untouched. Import-free on purpose: src/config.js
// validates with it, the CLI and the `ah ui` readers format with it, and the browser bundles it
// (like src/pricing.js). The sampler that does the I/O lives in src/energy-sampler.js.

/** The `energy.source.type` values. */
export const ENERGY_SOURCES = /** @type {const} */ (["hwmon", "command", "watts"]);

/** The hwmon node name a `{type:"hwmon"}` source reads when it names none. */
export const DEFAULT_HWMON_NAME = "amdgpu";

/** @param {unknown} v */
const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Validation for the profile's `energy` block: `{ usdPerKwh ≥ 0, source }`, `source` one of
 * `{type:"hwmon", name?}`, `{type:"command", cmd}`, `{type:"watts", watts > 0}`. Pure.
 * @param {unknown} energy @returns {string[]}
 */
export function energyErrors(energy) {
  if (energy === undefined || energy === null) return [];
  if (!isRecord(energy)) return [`config: "energy" must be an object {usdPerKwh, source}.`];
  const e = /** @type {Record<string, any>} */ (energy);
  /** @type {string[]} */
  const errors = [];
  for (const k of Object.keys(e)) {
    if (k !== "usdPerKwh" && k !== "source") errors.push(`config: energy has unknown key "${k}" (allowed: usdPerKwh, source).`);
  }
  if (typeof e.usdPerKwh !== "number" || !Number.isFinite(e.usdPerKwh) || e.usdPerKwh < 0) {
    errors.push(`config: energy.usdPerKwh must be a finite number ≥ 0 (your electricity price, $/kWh).`);
  }
  const s = e.source;
  if (!isRecord(s)) {
    errors.push(`config: energy.source must be an object with a type (${ENERGY_SOURCES.join(", ")}).`);
    return errors;
  }
  if (!ENERGY_SOURCES.includes(s.type)) {
    errors.push(`config: energy.source.type must be one of ${ENERGY_SOURCES.join(", ")} (got ${JSON.stringify(s.type)}).`);
    return errors;
  }
  const allowed = { hwmon: ["type", "name"], command: ["type", "cmd"], watts: ["type", "watts"] }[/** @type {"hwmon"|"command"|"watts"} */ (s.type)];
  for (const k of Object.keys(s)) {
    if (!allowed.includes(k)) errors.push(`config: energy.source has unknown key "${k}" for type "${s.type}" (allowed: ${allowed.join(", ")}).`);
  }
  if (s.type === "hwmon" && s.name != null && (typeof s.name !== "string" || !s.name.trim())) {
    errors.push(`config: energy.source.name must be a non-empty string (the hwmon node name, e.g. "${DEFAULT_HWMON_NAME}").`);
  }
  if (s.type === "command" && (typeof s.cmd !== "string" || !s.cmd.trim())) {
    errors.push(`config: energy.source.cmd is required for type "command" (a shell command printing watts).`);
  }
  if (s.type === "watts" && (typeof s.watts !== "number" || !Number.isFinite(s.watts) || s.watts <= 0)) {
    errors.push(`config: energy.source.watts is required for type "watts" and must be a number > 0.`);
  }
  return errors;
}

/**
 * One sampling window: machine-wide power `watts` over `dtS` seconds, split by time share across
 * the opted-in runs active in it — each gets `watts·dtS / |activeIds|` joules — so overlapping
 * runs never double count. Mutates and returns `acc` (runId → joules); a run is in `acc` once any
 * window credited it, even with 0 J. Pure.
 * @param {Map<string, number>} acc @param {number} watts @param {number} dtS @param {Iterable<string>} activeIds
 * @returns {Map<string, number>}
 */
export function splitTick(acc, watts, dtS, activeIds) {
  const ids = [...activeIds];
  if (!ids.length) return acc;
  const share = (Math.max(0, watts) * Math.max(0, dtS)) / ids.length;
  for (const id of ids) acc.set(id, (acc.get(id) ?? 0) + share);
  return acc;
}

/** @param {number} joules */
export const joulesToKwh = (joules) => joules / 3.6e6;

/**
 * The record fields for a measured run: kWh rounded to 1e-9, dollars to 1e-6 (not cents —
 * a local run is a fraction of a cent), and the source type. Pure.
 * @param {number} kWh @param {number} usdPerKwh @param {string} source
 * @returns {{ energyKwh: number, energyUsd: number, energySource: string }}
 */
export function energyFields(kWh, usdPerKwh, source) {
  return { energyKwh: Math.round(kWh * 1e9) / 1e9, energyUsd: Math.round(kWh * usdPerKwh * 1e6) / 1e6, energySource: source };
}

/** `"$0.04"` at a cent or more, else two significant digits (`"$0.00029"`), `"$0"` for nothing. @param {number} usd */
function energyDollars(usd) {
  if (!(usd > 0)) return "$0";
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${Number(usd.toPrecision(2))}`;
}

/** `"1.9 Wh"`, `"12 Wh"`, `"0.05 Wh"`, `"1.25 kWh"`. @param {number} kWh */
function energyAmount(kWh) {
  const wh = Math.max(0, kWh) * 1000;
  if (wh >= 1000) return `${kWh.toFixed(2)} kWh`;
  if (wh >= 10) return `${wh.toFixed(0)} Wh`;
  if (wh >= 0.1 || wh === 0) return `${wh.toFixed(1)} Wh`;
  return `${Number(wh.toPrecision(1))} Wh`;
}

/**
 * `"energy $0.00029 (1.9 Wh)"` for a record (or a sum) carrying `energyKwh`; `""` when it has
 * none. Shown beside the reported cost / `~$x est.`, never added to them.
 * @param {{ energyKwh?: unknown, energyUsd?: unknown }|null|undefined} r @returns {string}
 */
export function formatEnergy(r) {
  const kWh = r?.energyKwh;
  if (typeof kWh !== "number" || !Number.isFinite(kWh) || kWh < 0) return "";
  const usd = typeof r?.energyUsd === "number" && Number.isFinite(r.energyUsd) ? r.energyUsd : 0;
  return `energy ${energyDollars(usd)} (${energyAmount(kWh)})`;
}
