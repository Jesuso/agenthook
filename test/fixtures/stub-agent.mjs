#!/usr/bin/env node
// Stub coding agent for test/e2e.test.js: a step's `bin`, exec'd with claude's argv (ignored).
// Never calls a model. Behaviour comes from the step's `env`:
//   STUB_STEP   — the step id; the ref is basename($AGENTHOOK_VERDICT_FILE) minus `-<step>.json`.
//   STUB_SCRIPT — a JSON file `{ "<ref>": { "<step>": [entry, …] } }`. Entry i is used on the
//                 step's i-th run (the last one repeats); a per-(ref,step) counter lives in
//                 `<script>.counts.json`. An entry is "advance"|"changes"|"hold"|"fail"|"exit1",
//                 or `{outcome, target?}` to send `changes` to an explicit step.
// "exit1" exits 1 with no verdict; anything else writes `{outcome, reason:"stub"}`.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const step = process.env.STUB_STEP || "";
const verdictFile = process.env.AGENTHOOK_VERDICT_FILE || "";
const scriptFile = process.env.STUB_SCRIPT || "";
if (!step || !verdictFile || !scriptFile) {
  console.error("stub-agent: STUB_STEP, STUB_SCRIPT and AGENTHOOK_VERDICT_FILE are required");
  process.exit(2);
}
const suffix = `-${step}.json`;
const base = path.basename(verdictFile);
const ref = base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;

const script = JSON.parse(fs.readFileSync(scriptFile, "utf8"));
const entries = (script?.[ref] ?? script?.["*"])?.[step];
if (!Array.isArray(entries) || !entries.length) {
  console.error(`stub-agent: no script for ref "${ref}" step "${step}"`);
  process.exit(2);
}

// Steps of different refs run in parallel, so each (ref, step) gets its own counter file.
const countsFile = `${scriptFile}.counts.${ref}.${step}`;
let run = 0;
try {
  run = Number(fs.readFileSync(countsFile, "utf8")) || 0;
} catch {}
fs.writeFileSync(countsFile, String(run + 1));
const entry = entries[Math.min(run, entries.length - 1)];
const { outcome, target } = typeof entry === "string" ? { outcome: entry, target: undefined } : entry;

// In a linked worktree (`.git` is a file there), leave a trivial commit like a real code step.
// CI has no git identity, so pass one inline.
if (fs.statSync(".git", { throwIfNoEntry: false })?.isFile()) {
  fs.writeFileSync(`stub-${step}-${run + 1}.txt`, `${ref} ${step} run ${run + 1}\n`);
  execFileSync("git", ["add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=stub", "-c", "user.email=stub@example.invalid", "commit", "-q", "-m", `stub: ${step} run ${run + 1}`], { stdio: "ignore" });
}

if (outcome === "exit1") process.exit(1);
fs.writeFileSync(verdictFile, JSON.stringify({ outcome, ...(target ? { target } : {}), reason: "stub" }));
