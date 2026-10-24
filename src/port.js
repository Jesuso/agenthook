// Loopback port probes shared by `doctor` (is the profile's port free?) and `init --local`
// (pick the first free one), plus `claimedPorts` — the registered-profile → port map that
// lets init/ls/doctor/start see a port a *stopped* profile owns, which nothing listening on
// the loopback can reveal.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DEFAULT_PORT, registryDir } from "./config.js";
import { readMarker } from "./profile.js";

/** Is a TCP port already bound on 127.0.0.1? @param {number} port @returns {Promise<boolean>} */
export function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}

/**
 * The first port from `from` upward that nothing listens on (at most `tries` probes).
 * @param {number} from @param {{tries?: number, inUse?: (port: number) => Promise<boolean>}} [opts]
 * @returns {Promise<number>}
 */
export async function firstFreePort(from, { tries = 100, inUse = portInUse } = {}) {
  for (let p = from; p < from + tries; p++) if (!(await inUse(p))) return p;
  throw new Error(`no free port in ${from}–${from + tries - 1}`);
}

/** `p` resolved to its real path, else itself (a dangling config path can't be realpath'd). @param {string} p */
function canonicalPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Every registered profile's port — the heartbeat's when it's running, else its config's
 * `port` (falling back to the config.js default when the key is absent), paired with the
 * profile's state key and name. A profile with no `profile.json` marker isn't "registered"
 * (it was never started — see profile.js `isFreshStateDir`) and is skipped, as is one whose
 * config is missing or unparsable. Never throws. `exclude` keeps a profile from conflicting
 * with itself (e.g. `init --force` rewriting its own config, or doctor/start checking the
 * current profile).
 * @param {{ registry?: string, exclude?: { stateKey?: string, configPath?: string } }} [opts]
 * @returns {{ port: number, stateKey: string, name: string }[]}
 */
export function claimedPorts({ registry = registryDir, exclude } = {}) {
  /** @type {{ port: number, stateKey: string, name: string }[]} */
  const out = [];
  /** @type {string[]} */
  let stateKeys = [];
  try {
    stateKeys = fs
      .readdirSync(registry, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out; // registry not created yet
  }
  const excludeConfig = exclude?.configPath ? canonicalPath(exclude.configPath) : null;
  for (const stateKey of stateKeys) {
    if (exclude?.stateKey && stateKey === exclude.stateKey) continue;
    const dir = path.join(registry, stateKey);
    const marker = readMarker(dir);
    if (!marker) continue; // never started — not a registered profile
    if (excludeConfig && typeof marker.configPath === "string" && canonicalPath(marker.configPath) === excludeConfig) continue;

    /** @type {number|null} */
    let port = null;
    try {
      const hb = JSON.parse(fs.readFileSync(path.join(dir, "heartbeat.json"), "utf8"));
      if (typeof hb.port === "number") port = hb.port;
    } catch {
      /* not running — fall through to the config */
    }
    if (port == null) {
      if (typeof marker.configPath !== "string") continue;
      try {
        const raw = JSON.parse(fs.readFileSync(marker.configPath, "utf8"));
        port = typeof raw.port === "number" ? raw.port : DEFAULT_PORT;
      } catch {
        continue; // config missing/unparsable — skip, never throw
      }
    }
    out.push({ port: /** @type {number} */ (port), stateKey, name: typeof marker.name === "string" && marker.name ? marker.name : stateKey });
  }
  return out;
}

/**
 * The first port from `from` upward that is neither claimed by another registered profile nor
 * listening, plus a reason for every port it skipped (runs of listening ports collapse into one
 * entry) — so a caller can print *why* it didn't get `from`. Claimed ports are checked first so a
 * port both claimed and listening reports as claimed.
 * @param {number} from
 * @param {{ tries?: number, inUse?: (port: number) => Promise<boolean>, claimed?: { port: number, name: string }[] }} [opts]
 * @returns {Promise<{ port: number, skipped: { from: number, to: number, reason: string }[] }>}
 */
export async function pickPort(from, { tries = 100, inUse = portInUse, claimed = [] } = {}) {
  const claimantOf = new Map(claimed.map((c) => [c.port, c.name]));
  /** @type {{ from: number, to: number, reason: string }[]} */
  const skipped = [];
  /** @type {{ from: number, to: number, reason: string } | null} */
  let listeningRun = null;
  const flushRun = () => {
    if (listeningRun) skipped.push(listeningRun);
    listeningRun = null;
  };
  for (let p = from; p < from + tries; p++) {
    const claimant = claimantOf.get(p);
    if (claimant) {
      flushRun();
      skipped.push({ from: p, to: p, reason: `claimed by profile "${claimant}"` });
      continue;
    }
    if (await inUse(p)) {
      if (listeningRun && listeningRun.to === p - 1) listeningRun.to = p;
      else {
        flushRun();
        listeningRun = { from: p, to: p, reason: "in use" };
      }
      continue;
    }
    flushRun();
    return { port: p, skipped };
  }
  throw new Error(`no free port in ${from}–${from + tries - 1}`);
}

/** `pickPort`'s `skipped` as the parenthetical `init --local` prints, e.g.
 * `4123 claimed by profile "x", 4124–4126 in use`; "" when nothing was skipped. Pure.
 * @param {{ from: number, to: number, reason: string }[]} skipped */
export function formatSkipped(skipped) {
  return skipped.map((s) => `${s.from === s.to ? s.from : `${s.from}–${s.to}`} ${s.reason}`).join(", ");
}
