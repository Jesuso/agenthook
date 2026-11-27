import fs from "node:fs";
import path from "node:path";
import { listRuns, resolveRunLog } from "../reader/run-logs.js";
import { readProfileState, readJson, isObj } from "../reader/rows.js";
import { pricingOf } from "../shared/pricing.js";
import { registryDir } from "../config/locations.js";

const LOG_BYTES_MAX = 24 * 1024;

/**
 * Run history for a ref (newest first) — step, outcome, cost, whether still running.
 * @param {string} profile @param {string} ref @param {string} dir @param {string} [registry]
 */
export function readRuns(profile, ref, dir, registry = registryDir) {
  const events = readProfileState(dir).events;
  // The step's stored summary (summaries.json) goes on the exact run that wrote it, only.
  const stored = readJson(path.join(dir, "summaries.json"), {}, isObj);
  const mine = Object.hasOwn(stored, ref) && isObj(stored[ref]) ? stored[ref] : {};
  return listRuns(registry, profile, ref, events, pricingOf(readJson(path.join(dir, "heartbeat.json"), null, isObj))).map((r) => {
    const s = Object.hasOwn(mine, r.step) ? mine[r.step] : null;
    return {
      run: r.run,
      step: r.step,
      at: r.startedAt,
      outcome: r.outcome,
      ...(r.model ? { model: r.model } : {}),
      ...(r.harness ? { harness: r.harness } : {}),
      ...(r.costUsd !== null ? { costUsd: r.costUsd } : {}),
      ...(r.estUsd !== null ? { estUsd: r.estUsd } : {}),
      ...(r.costBasis !== null ? { costBasis: r.costBasis } : {}),
      ...(r.energyKwh !== undefined ? { energyKwh: r.energyKwh, energyUsd: r.energyUsd } : {}),
      ...(r.turns !== undefined ? { turns: r.turns, ...(r.firstContext !== undefined ? { firstContext: r.firstContext } : {}), ...(r.peakContext !== undefined ? { peakContext: r.peakContext } : {}), ...(r.lastContext !== undefined ? { lastContext: r.lastContext } : {}), ...(r.compactions !== undefined ? { compactions: r.compactions } : {}) } : {}),
      ...(r.running ? { running: true } : {}),
      ...(isObj(s) && s.run === r.run && isObj(s.summary) ? { summary: s.summary } : {}),
    };
  });
}

/**
 * Last `lines` lines of a run log (the ref's newest run, or the named `run` / newest of
 * `step`). Capped at LOG_BYTES_MAX so a chatty agent can't blow the caller's context.
 * @param {string} profile @param {string} ref @param {string} dir
 * @param {{lines?: number, step?: string, run?: string}} [o] @param {string} [registry]
 */
export function readRunLogTail(profile, ref, dir, { lines = 40, step, run } = {}, registry = registryDir) {
  const runs = readRuns(profile, ref, dir, registry);
  const pick = run ? runs.find((r) => r.run === run) : runs.find((r) => !step || r.step === step);
  if (!pick) return { error: `no run log for ${ref}${step ? ` step ${step}` : ""}` };
  const file = resolveRunLog(registry, profile, pick.run);
  if (!file) return { error: "run log not readable" };
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  try {
    const len = Math.min(size, LOG_BYTES_MAX);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString("utf8");
    if (size > len) text = text.slice(text.indexOf("\n") + 1);
    const all = text.trimEnd().split("\n");
    const n = Math.max(1, Math.min(lines, 400));
    return { run: pick.run, step: pick.step, running: !!pick.running, totalBytes: size, tail: all.slice(-n).join("\n").trimEnd() };
  } finally {
    fs.closeSync(fd);
  }
}
