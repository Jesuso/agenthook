// `agenthook alias` — opt-in `ah` short command. Drops an `ah` symlink next to the
// installed `agenthook` bin (same PATH dir) so `ah agents` works. Strictly opt-in and
// non-destructive: never overwrites a foreign `ah` already on PATH, and never ships in
// package.json `bin` (which would force a global `ah` on every user and collide). On
// collision or a non-symlink target it falls back to printing a shell-alias line.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SHORT = "ah";

/** First PATH hit for a command, or null. POSIX `command -v` / Windows `where`. @param {string} name */
function whichPath(name) {
  try {
    const out =
      process.platform === "win32"
        ? execFileSync("where", [name], { encoding: "utf8" })
        : execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
    return out.split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

/** Is `p` a symlink we created (points at an `agenthook` bin)? @param {string} p */
function isOurLink(p) {
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) return false;
    return path.basename(fs.readlinkSync(p)) === "agenthook";
  } catch {
    return false;
  }
}

const ALIAS_HINT = `add this to your shell rc instead:\n  alias ah=agenthook`;

/**
 * Install (or remove) the `ah` shortcut. Pure-ish: returns a human message + whether it
 * changed anything, so both the CLI command and `init`'s offer can share it.
 * @param {{ remove?: boolean }} [opts]
 * @returns {{ ok: boolean, changed: boolean, message: string }}
 */
export function installAh({ remove = false } = {}) {
  if (process.platform === "win32") {
    return {
      ok: false,
      changed: false,
      message:
        "Windows symlinks need admin/developer mode — add an alias instead:\n" +
        "  doskey ah=agenthook $*        (cmd)\n" +
        "  Set-Alias ah agenthook        (PowerShell profile)",
    };
  }

  const ourPath = whichPath("agenthook");
  if (!ourPath) {
    return {
      ok: false,
      changed: false,
      message: "`agenthook` isn't on your PATH yet. Install it globally (npm i -g @jesuso/agenthook), then re-run `agenthook alias`.",
    };
  }
  const link = path.join(path.dirname(ourPath), SHORT);

  if (remove) {
    if (isOurLink(link)) {
      fs.unlinkSync(link);
      return { ok: true, changed: true, message: `removed \`ah\` (${link})` };
    }
    return { ok: true, changed: false, message: `\`ah\` is not an agenthook-created symlink — left it alone.` };
  }

  if (isOurLink(link)) return { ok: true, changed: false, message: `\`ah\` already points to agenthook (${link}).` };

  const existing = whichPath(SHORT);
  if ((existing && path.resolve(existing) !== path.resolve(link)) || fs.existsSync(link)) {
    return { ok: false, changed: false, message: `\`ah\` is already taken (${existing || link}) — ${ALIAS_HINT}` };
  }

  try {
    fs.symlinkSync("agenthook", link); // relative target → survives a moved bin dir
    return { ok: true, changed: true, message: `created \`ah\` → agenthook (${link})\ntry: ah agents` };
  } catch (e) {
    return { ok: false, changed: false, message: `could not create ${link} (${e.message}) — ${ALIAS_HINT}` };
  }
}

/** @param {{ remove?: boolean, uninstall?: boolean }} args */
export async function alias(args) {
  const res = installAh({ remove: !!(args.remove || args.uninstall) });
  console.log(res.message);
  if (!res.ok) process.exitCode = 1;
}
