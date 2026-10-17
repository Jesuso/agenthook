// `agenthook tick [name…|--all] [--json] [--cursor <n|json>] [--no-board] [--no-prs]` — the same
// one-call supervisor snapshot the MCP `tick` tool returns (status + board + agent PRs + events
// since a cursor), for agents that shell out instead of speaking MCP. Default output is a compact
// text digest; --json prints the exact MCP payload. Multi-profile mode (`--all` or ≥2 names):
// --json prints an array of per-profile payloads, text one digest per profile, and --cursor is
// a JSON object `{stateKey: offset}`.
import { defaultProfileKey, pickProfile, pickProfiles, parseCursorMap, readTick } from "../agent-api.js";

/** One-line text digest of a tick payload. @param {Record<string, any>} t */
export function digest(t) {
  const s = t.slots;
  const lines = [
    `${t.profile} ${t.up ? "up" : "DOWN"}${t.paused ? " PAUSED" : ""}${t.restartPending ? " restart-pending" : ""} slots ${s.active}/${s.max ?? "?"} run, ${s.queued} queued, ${s.free ?? "?"} free`,
  ];
  const fmt = (/** @type {any} */ r) => `${r.id ?? r.ref}${r.title ? ` "${r.title}"` : ""}`;
  for (const r of t.running) lines.push(`  RUN  ${fmt(r)} ${r.step} ${Math.round((r.ageS ?? 0) / 60)}m`);
  for (const q of t.queue) lines.push(`  WAIT ${fmt(q)} ${q.step}`);
  for (const h of t.held) lines.push(`  HELD ${fmt(h)} ${h.step}${h.why ? ` — ${h.why}` : ""}`);
  if (t.board) for (const b of t.board) lines.push(`  board ${b.step}: ${b.resting.length} resting${b.backlog ? `, ${b.backlog.length} backlog` : ""}${b.resting.length ? ` [${b.resting.map((/** @type {any} */ c) => c.id ?? c.ref).join(" ")}]` : ""}`);
  if (t.boardError) lines.push(`  board: ${t.boardError}`);
  if (t.prs) for (const p of t.prs) lines.push(`  PR #${p.n} ${p.ref} ci=${p.ci}${p.conflict ? " CONFLICT" : ""}${p.state ? ` ${p.state}` : ""}${p.draft ? " draft" : ""}${typeof p.mine === "boolean" ? (p.mine ? " mine" : " not-mine") : ""}`);
  if (t.prsError) lines.push(`  prs: ${t.prsError}`);
  if (t.epics) for (const e of t.epics) lines.push(`  epic ${e.ref} "${e.name}" ${e.byStage.finished + e.byStage.merged}/${e.total}${e.needsYou.length ? ` needs-you: ${e.needsYou.join(" ")}` : ""}`);
  if (t.epicsError) lines.push(`  epics: ${t.epicsError}`);
  for (const e of t.events) lines.push(`  ev ${e.ts?.slice(11, 19)} ${e.e} ${e.ref}${e.step ? `/${e.step}` : ""}${e.outcome ? ` → ${e.outcome}` : ""}${e.reason ? ` (${e.reason})` : ""}${e.pr ? ` PR#${e.pr}` : ""}${e.sha ? ` ${String(e.sha).slice(0, 7)}` : ""}${e.mergeState ? ` ${e.mergeState}` : ""}`);
  lines.push(`  cursor ${t.cursor}`);
  return lines.join("\n");
}

/** @param {any} args */
export async function tick(args) {
  if (args.all === true || args._.length >= 2) return tickMulti(args);
  const picked = pickProfile(args._[0], defaultProfileKey(args.config));
  if ("error" in picked) {
    console.error(picked.error);
    process.exitCode = 1;
    return;
  }
  const cursor = args.cursor !== undefined ? Number(args.cursor) : undefined;
  const t = await readTick(picked.entry, { cursor, board: args["no-board"] !== true, prs: args["no-prs"] !== true, epics: args.epics === true });
  console.log(args.json ? JSON.stringify(t) : digest(t));
}

/** @param {any} args */
async function tickMulti(args) {
  const picked = pickProfiles(args._, { all: args.all === true });
  if ("error" in picked) {
    console.error(picked.error);
    process.exitCode = 1;
    return;
  }
  /** @type {Record<string, number>} */
  let cursors = {};
  if (args.cursor !== undefined) {
    const parsed = parseCursorMap(args.cursor);
    if ("error" in parsed) {
      console.error(parsed.error);
      process.exitCode = 1;
      return;
    }
    cursors = parsed.cursors;
  }
  const ticks = await Promise.all(
    picked.entries.map((entry) => readTick(entry, { cursor: Object.hasOwn(cursors, entry.stateKey) ? cursors[entry.stateKey] : undefined, board: args["no-board"] !== true, prs: args["no-prs"] !== true, epics: args.epics === true })),
  );
  console.log(args.json ? JSON.stringify(ticks) : ticks.map(digest).join("\n\n"));
}
