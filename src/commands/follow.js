// `agenthook follow [session-id]` — tail a LIVE agent read-only by streaming its
// Claude session transcript (JSONL). Never spawns a second process (unlike
// `claude --resume`), so it can't interfere with the running agent. With no id,
// auto-picks the newest dispatched transcript (its first turn carries the engine
// marker "=== TICKET ===", which a hand-run session won't have).
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { claudeProjectDir } from "../paths.js";

/** @param {string} s @param {number} [n] */
const clip = (s, n = 200) => {
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
};

/** Render one JSONL transcript line as a readable status line. @param {string} line */
function render(line) {
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return; // skip partial/non-JSON lines
  }
  const content = j.message?.content;
  const blocks = Array.isArray(content)
    ? content
    : typeof content === "string"
      ? [{ type: "text", text: content }]
      : [];
  for (const b of blocks) {
    if (b.type === "text" && b.text?.trim()) console.log("🤖 " + clip(b.text, 500));
    else if (b.type === "tool_use") console.log("🔧 " + b.name + "  " + clip(JSON.stringify(b.input), 140));
    else if (b.type === "tool_result") {
      const t = Array.isArray(b.content) ? b.content.map((/** @type {any} */ x) => x.text || "").join(" ") : b.content;
      console.log("   ↳ " + clip(t, 140));
    }
  }
}

/** @param {any} args */
export async function follow(args) {
  const cfg = loadConfig({ configPath: args.config });
  const proj = claudeProjectDir(cfg.repoPath);
  if (!fs.existsSync(proj)) throw new Error(`no transcript dir for ${cfg.repoPath}: ${proj}`);

  const id = args._[0];
  let file = "";
  if (id) {
    file = path.join(proj, `${id}.jsonl`);
  } else {
    const files = fs
      .readdirSync(proj)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: fs.statSync(path.join(proj, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const { f } of files) {
      const full = path.join(proj, f);
      if (fs.readFileSync(full, "utf8").slice(0, 8000).includes("=== TICKET ===")) {
        file = full;
        break;
      }
    }
  }
  if (!file || !fs.existsSync(file)) throw new Error(`session transcript not found: ${id || "<auto>"}`);

  console.log(`following: ${path.basename(file)}  (Ctrl+C to stop — agent keeps running)`);
  console.log("────────────────────────────────────────────────────────");

  // Render the tail of what's already there, then stream appended lines.
  const initial = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  for (const l of initial.slice(-15)) render(l);

  let pos = fs.statSync(file).size;
  let buf = "";
  const drain = () => {
    const size = fs.statSync(file).size;
    if (size < pos) pos = 0; // file truncated/rotated
    if (size === pos) return;
    const fd = fs.openSync(file, "r");
    const b = Buffer.alloc(size - pos);
    fs.readSync(fd, b, 0, b.length, pos);
    fs.closeSync(fd);
    pos = size;
    buf += b.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      render(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  };
  fs.watch(file, { persistent: true }, drain);
  // Keep the process alive until Ctrl+C.
  await new Promise(() => {});
}
