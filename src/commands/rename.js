// `agenthook rename <newName>` — relabel a profile (epic #196, decision B: label-only).
// Changes only the config's top-level "name" (inserting "stateId" with the old name when
// one isn't already set), so the state dir (~/.agenthook/<stateKey>/) never moves. A running
// receiver keeps its old label until `agenthook restart` (or the UI's "Restart when idle")
// re-reads the config.
import { ensurePrivateDir, peekConfig, validName } from "../config.js";
import { listProfiles, readProfile } from "../heartbeat.js";
import { renameInConfigText } from "../json-edit.js";
import { atomicSave, readCurrent } from "../ui/save.js";

/**
 * The testable core: validates, checks for collisions, rewrites the config text, and saves it.
 * Throws on any failure (invalid name, collision, read/parse/save error) — the CLI wrapper
 * turns that into a printed error + non-zero exit.
 * @param {{ configPath: string, newName: string, registry?: string }} o
 * @returns {{ changed: boolean, running: boolean, from: string, to: string, stateKey: string }}
 */
export function renameProfile({ configPath, newName, registry }) {
  if (!validName(newName)) throw new Error(`rename: "${newName}" must match [A-Za-z0-9._-]+.`);
  const { name, stateKey, stateDir } = peekConfig({ configPath });

  if (newName === name) return { changed: false, running: readProfile(stateKey, registry).up, from: name, to: newName, stateKey };

  const others = listProfiles(registry).filter((p) => p.stateKey !== stateKey);
  const collision = others.find((p) => p.name === newName || p.stateKey === newName);
  if (collision) {
    throw new Error(`rename: "${newName}" collides with the existing profile "${collision.name}" (state key "${collision.stateKey}").`);
  }

  const cur = readCurrent(configPath);
  if (!cur) throw new Error(`rename: could not read ${configPath}.`);
  const next = Buffer.from(renameInConfigText(cur.cur.toString("utf8"), newName, stateKey), "utf8");

  ensurePrivateDir(stateDir);
  const saved = atomicSave({
    stateDir,
    file: configPath,
    cur: cur.cur,
    mode: cur.mode,
    next,
    bakSubdir: "config-bak",
    audit: { source: "cli", action: "rename", from: name, to: newName },
  });
  if (saved.status !== 200) throw new Error(`rename: failed to save ${configPath}.`);

  return { changed: true, running: readProfile(stateKey, registry).up, from: name, to: newName, stateKey };
}

/** @param {any} args */
export async function rename(args) {
  const newName = args._[0];
  if (!newName) {
    console.error("usage: agenthook rename <newName>");
    process.exitCode = 1;
    return;
  }
  let result;
  try {
    result = renameProfile({ configPath: args.config, newName: String(newName) });
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
    return;
  }
  if (!result.changed) {
    console.log(`already named "${result.from}".`);
    return;
  }
  console.log(`renamed "${result.from}" → "${result.to}" (state key "${result.stateKey}" unchanged)`);
  if (result.running) {
    console.log("renamed — run `agenthook restart` or use \"Restart when idle\" to apply the new label");
  }
}
