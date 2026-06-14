#!/usr/bin/env node
// agenthook CLI: register | unregister | catchup
//
//   agenthook register <https-public-url>   create the provider webhook at that URL
//   agenthook unregister                     delete this provider's webhooks
//   agenthook catchup <ref> [--force]        replay one missed item through the live server
//
// `catchup` exists because webhooks are PUSH-only and fire on a TRANSITION
// (assignment), not a STATE. If the receiver was down when an item was assigned,
// no poll can recover it — a task sitting assigned for a month looks identical to
// one assigned 10s ago. So we don't sweep; we forge the exact signed event the
// provider would have sent and POST it to the running server, reusing the whole
// dispatch path (dedup, prompt, worktree, PR, comment hook). See README "Reconcile".
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { createStore } from "./store.js";
import { createAdapter } from "./providers/index.js";

const [cmd, ...rest] = process.argv.slice(2);
const cfg = loadConfig();
const store = createStore(cfg.dataDir);
const adapter = createAdapter(cfg, store);

async function main() {
  switch (cmd) {
    case "register": {
      const url = rest[0];
      if (!url) die("usage: agenthook register <https-public-url>");
      fs.writeFileSync(cfg.publicUrlFile, url.trim());
      await adapter.registerWebhook(url.replace(/\/$/, ""));
      break;
    }
    case "unregister": {
      await adapter.unregisterWebhooks();
      console.log("done");
      break;
    }
    case "catchup": {
      const ref = rest.find((a) => !a.startsWith("--"));
      const force = rest.includes("--force");
      if (!ref) die("usage: agenthook catchup <ref> [--force]");
      if (typeof adapter.forgeCatchup !== "function") die(`provider "${cfg.provider}" has no catchup support`);

      const forged = adapter.forgeCatchup(ref);
      store.reloadSeen();
      if (store.hasSeen(forged.dedupKey) && !force) {
        die(`${ref} already seen — the server would dedup-skip it. Re-run with --force.`);
      }
      let removed = false;
      if (store.hasSeen(forged.dedupKey) && force) {
        store.unmarkSeen(forged.dedupKey);
        removed = true;
        console.log(`[force] cleared dedup key ${forged.dedupKey}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${cfg.port}${forged.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...forged.headers },
          body: forged.body,
        });
        console.log(`POST ${forged.path} -> ${res.status}`);
        if (res.status !== 200) throw new Error(`server returned ${res.status}`);
        console.log(`dispatched ${ref}. The server re-fetches and skips if completed or unassigned.`);
      } catch (e) {
        if (removed) {
          store.markSeen(forged.dedupKey);
          console.error(`[rollback] restored dedup key (state unchanged)`);
        }
        die(`could not reach server on 127.0.0.1:${cfg.port} (${e.message}). Is it running?`);
      }
      break;
    }
    default:
      die(`unknown command "${cmd || ""}". Use: register | unregister | catchup`);
  }
}

/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(msg);
  process.exit(1);
}

main().catch((e) => die(e.message));
