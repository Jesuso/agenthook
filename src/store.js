// Tiny JSON-file persistence shared by the engine and providers.
//   - secrets: handshake secrets keyed by webhook path (Asana). Mode 0600.
//   - seen:    dedup keys so one event triggers exactly one run.
//   - running: in-flight pipeline jobs (ref -> {stepId,pid,...}) for crash recovery.
//   - held:    refs parked by a `hold` verdict (ref -> {stepId,reason?,heldAt}), so an
//              owner's `@agent` reply comment knows which step to resume.
//   - repo:    per-ref sticky repo id (multi-repo routing), so a ref keeps the checkout
//              its first step routed to even if its route keys change mid-flow.
//   - paths / locks / overlap: the opt-in file-overlap guard (src/overlap.js) — predicted
//              paths per ref, in-flight locks (ref -> {paths,stepId}), and refs waiting on
//              another ref's lock (ref -> {stepId,blockedBy,heldAt}). Only written when
//              cfg.overlapGuard is on.
//   - refmeta: per-ref display metadata ({displayId,title,pr}) for the CLIs. Never
//     cleared — unlike running, status/events need it after the run ends.
//   - cired:   red-CI bounces parked while a step runs on the ref (dispatch applies
//              them when that run exits).
//   - queue:   jobs accepted but still waiting behind maxConcurrent (insertion order,
//              keyed by `${ref}:${stepId}`), so a crash/force-kill doesn't lose them.
//
// seen is reloaded from disk on every read (reloadSeen) because external tools
// (the `catchup` CLI) edit it out-of-band; the in-memory set would otherwise mask
// those edits and silently dedup-skip a re-dispatch.
//
// `running` is OUR OWN crash-recovery state, never a poll: on boot the engine reads
// it (a file, no network) to find jobs interrupted by a restart. Forward motion is
// always event-driven; recovering a half-run job is the one thing the board can't
// tell us (it can't distinguish "mid-run" from "fresh"), so we record it locally.
import fs from "node:fs";
import path from "node:path";

/**
 * State-based dedup keys (`step:<id>:<ref>`) are released when the run ends;
 * event-based ones (`secmove:`/`unblock:`/`reconcile:`/…) are unique per event and stay permanent.
 * @param {string} key
 */
export function isStateDedupKey(key) {
  return typeof key === "string" && key.startsWith("step:");
}

/**
 * queue.json identity: kind + ref + stepId (entries written before `merge` jobs have no
 * kind → pipeline); a `ci` job is one per run+attempt, so its dedupKey too.
 * @param {import('./types.js').Job} a @param {import('./types.js').Job} b
 */
const sameQueued = (a, b) =>
  (a.kind ?? "pipeline") === (b.kind ?? "pipeline") && a.ref === b.ref && a.stepId === b.stepId &&
  (a.kind !== "ci" || a.dedupKey === b.dedupKey);

/**
 * @param {string} dataDir
 * @returns {import('./types.js').Store}
 */
export function createStore(dataDir) {
  const secretsFile = path.join(dataDir, "secrets.json");
  const seenFile = path.join(dataDir, "seen.json");
  const runningFile = path.join(dataDir, "running.json");
  const queueFile = path.join(dataDir, "queue.json");
  const attemptsFile = path.join(dataDir, "attempts.json");
  const difficultyFile = path.join(dataDir, "difficulty.json");
  const repoFile = path.join(dataDir, "repo.json");
  const heldFile = path.join(dataDir, "held.json");
  const findingsFile = path.join(dataDir, "findings.json");
  const usageFile = path.join(dataDir, "usage.jsonl");
  const refmetaFile = path.join(dataDir, "refmeta.json");
  const pathsFile = path.join(dataDir, "paths.json");
  const locksFile = path.join(dataDir, "locks.json");
  const overlapFile = path.join(dataDir, "overlap.json");
  const ciRedFile = path.join(dataDir, "cired.json");

  /** @param {string} f @param {any} fallback */
  const readJson = (f, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      return fallback;
    }
  };

  let secrets = readJson(secretsFile, {});
  let seen = new Set(readJson(seenFile, []));

  return {
    // --- handshake secrets, keyed by webhook path ---
    getSecret: (key) => secrets[key],
    setSecret: (key, value) => {
      secrets[key] = value;
      fs.writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
    },
    secretCount: () => Object.keys(secrets).length,

    // --- dedup set ---
    reloadSeen: () => {
      seen = new Set(readJson(seenFile, []));
    },
    hasSeen: (key) => seen.has(key),
    markSeen: (key) => {
      seen.add(key);
      fs.writeFileSync(seenFile, JSON.stringify([...seen]));
    },
    unmarkSeen: (key) => {
      seen.delete(key);
      fs.writeFileSync(seenFile, JSON.stringify([...seen]));
    },
    seenCount: () => seen.size,
    seenFile,

    // --- in-flight pipeline jobs (crash recovery), keyed by task ref ---
    setRunning: (ref, info) => {
      const m = readJson(runningFile, {});
      m[ref] = info;
      fs.writeFileSync(runningFile, JSON.stringify(m));
    },
    clearRunning: (ref) => {
      const m = readJson(runningFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(runningFile, JSON.stringify(m));
      }
    },
    listRunning: () => readJson(runningFile, {}),

    // --- jobs waiting in the queue (queue.json), insertion-ordered, deduped by kind:ref:stepId ---
    // (kind keeps a `merge` job and the pipeline job for its completeOnMerge step apart)
    addQueued: (job) => {
      /** @type {import("./types.js").Job[]} */
      const l = readJson(queueFile, []);
      if (l.some((j) => sameQueued(j, job))) return;
      l.push(job);
      fs.writeFileSync(queueFile, JSON.stringify(l));
    },
    removeQueued: (job) => {
      /** @type {import("./types.js").Job[]} */
      const l = readJson(queueFile, []);
      const n = l.filter((j) => !sameQueued(j, job));
      if (n.length !== l.length) fs.writeFileSync(queueFile, JSON.stringify(n));
    },
    listQueued: () => readJson(queueFile, []),

    // --- per-(ref,step) attempt counters: the changes-loop guard (attempts.json) ---
    // Bumped each dispatch; read before routing a `changes` back into a step so an
    // endless code↔review ping-pong (= endless `claude -p` spawns) gets capped → fail.
    getAttempt: (ref, stepId) => {
      const m = readJson(attemptsFile, {});
      return m[ref]?.[stepId] || 0;
    },
    bumpAttempt: (ref, stepId) => {
      const m = readJson(attemptsFile, {});
      m[ref] = m[ref] || {};
      m[ref][stepId] = (m[ref][stepId] || 0) + 1;
      fs.writeFileSync(attemptsFile, JSON.stringify(m));
      return m[ref][stepId];
    },
    clearAttempts: (ref) => {
      const m = readJson(attemptsFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(attemptsFile, JSON.stringify(m));
      }
    },

    // --- per-ref difficulty tag (difficulty.json): persisted from triage verdict ---
    // Keyed by ref; cleared alongside attempts when the task reaches a terminal state.
    getDifficulty: (ref) => {
      const m = readJson(difficultyFile, {});
      return m[ref];
    },
    setDifficulty: (ref, difficulty) => {
      const m = readJson(difficultyFile, {});
      m[ref] = difficulty;
      fs.writeFileSync(difficultyFile, JSON.stringify(m));
    },
    clearDifficulty: (ref) => {
      const m = readJson(difficultyFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(difficultyFile, JSON.stringify(m));
      }
    },

    // --- per-ref sticky repo id (repo.json): written when a multi-repo ref first routes ---
    // Keyed by ref; cleared alongside difficulty when the task reaches a terminal state.
    getRepo: (ref) => {
      const m = readJson(repoFile, {});
      return m[ref];
    },
    setRepo: (ref, repoId) => {
      const m = readJson(repoFile, {});
      m[ref] = repoId;
      fs.writeFileSync(repoFile, JSON.stringify(m));
    },
    clearRepo: (ref) => {
      const m = readJson(repoFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(repoFile, JSON.stringify(m));
      }
    },

    // --- per-ref held step (held.json): written on a `hold` verdict ---
    // Names the step an owner's `@agent` reply resumes. Cleared when any step for the
    // ref starts again (the resume, or a manual drag-back) and on a terminal state.
    getHeld: (ref) => {
      const m = readJson(heldFile, {});
      return m[ref];
    },
    setHeld: (ref, info) => {
      const m = readJson(heldFile, {});
      m[ref] = info;
      fs.writeFileSync(heldFile, JSON.stringify(m));
    },
    clearHeld: (ref) => {
      const m = readJson(heldFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(heldFile, JSON.stringify(m));
      }
    },

    // --- file-overlap guard (opt-in): predicted paths, locks, waiting refs ---
    // paths.json: what a no-worktree step (triage) predicts the change will touch.
    getPredictedPaths: (ref) => readJson(pathsFile, {})[ref],
    setPredictedPaths: (ref, paths) => {
      const m = readJson(pathsFile, {});
      m[ref] = paths;
      fs.writeFileSync(pathsFile, JSON.stringify(m));
    },
    clearPredictedPaths: (ref) => {
      const m = readJson(pathsFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(pathsFile, JSON.stringify(m));
      }
    },
    // locks.json: paths an in-flight ref holds; cleared when it leaves the pipeline.
    getLock: (ref) => readJson(locksFile, {})[ref],
    setLock: (ref, lock) => {
      const m = readJson(locksFile, {});
      m[ref] = lock;
      fs.writeFileSync(locksFile, JSON.stringify(m));
    },
    clearLock: (ref) => {
      const m = readJson(locksFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(locksFile, JSON.stringify(m));
      }
    },
    listLocks: () => readJson(locksFile, {}),
    // overlap.json: refs resting in their source stage behind another ref's lock.
    // Separate from held.json (that one is the `@agent` resume).
    getOverlap: (ref) => readJson(overlapFile, {})[ref],
    setOverlap: (ref, info) => {
      const m = readJson(overlapFile, {});
      m[ref] = info;
      fs.writeFileSync(overlapFile, JSON.stringify(m));
    },
    clearOverlap: (ref) => {
      const m = readJson(overlapFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(overlapFile, JSON.stringify(m));
      }
    },
    listOverlap: () => readJson(overlapFile, {}),

    // --- per-ref display metadata (refmeta.json): human id, title, PR number ---
    // Written by dispatch (receiver-side only); read by agents/status/events. Shallow
    // merge so the PR lookup and the fetchTask write can land independently.
    getRefMeta: (ref) => readJson(refmetaFile, {})[ref],
    setRefMeta: (ref, patch) => {
      const m = readJson(refmetaFile, {});
      const cur = m[ref] || {};
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) cur[k] = v;
      m[ref] = cur;
      fs.writeFileSync(refmetaFile, JSON.stringify(m));
    },
    listRefMeta: () => readJson(refmetaFile, {}),
    // --- per-ref review findings (findings.json): set on a `changes` bounce, read by the target step ---
    getFindings: (ref) => readJson(findingsFile, {})[ref],
    setFindings: (ref, f) => {
      const m = readJson(findingsFile, {});
      m[ref] = f;
      fs.writeFileSync(findingsFile, JSON.stringify(m));
    },
    clearFindings: (ref) => {
      const m = readJson(findingsFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(findingsFile, JSON.stringify(m));
      }
    },

    // --- per-ref parked red-CI bounce (cired.json): set by a `ci` job, taken on run exit ---
    setCiRed: (ref, b) => {
      const m = readJson(ciRedFile, {});
      m[ref] = b;
      fs.writeFileSync(ciRedFile, JSON.stringify(m));
    },
    takeCiRed: (ref) => {
      const m = readJson(ciRedFile, {});
      const b = m[ref];
      if (b) {
        delete m[ref];
        fs.writeFileSync(ciRedFile, JSON.stringify(m));
      }
      return b;
    },

    // --- per-run token/cost records (usage.jsonl): append-only, one JSON per line ---
    // Distinct from the rewritten state files above: a finished run appends exactly one
    // record, so concurrent agents never read-modify-write the same file.
    recordUsage: (rec) => {
      fs.appendFileSync(usageFile, JSON.stringify(rec) + "\n");
    },
    readUsage: () => {
      let raw;
      try {
        raw = fs.readFileSync(usageFile, "utf8");
      } catch {
        return [];
      }
      const out = [];
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          out.push(JSON.parse(t));
        } catch {
          /* tolerate a trailing/garbage line (e.g. a partial append) */
        }
      }
      return out;
    },
  };
}
