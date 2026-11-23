#!/usr/bin/env node
// Real-browser horizontal-overflow check for the built UI (docs/web-ui.md, "Horizontal-overflow
// check"). Serves `ui/dist` over a seeded throwaway registry in an in-process createUiServer
// and drives headless Chromium (chromium-headless-shell via playwright-core) through every
// route at desktop widths, failing if the page — or any guarded scroll container — scrolls
// sideways.
//
// Checked, per page × width × scheme:
//   a. document.documentElement.scrollWidth > clientWidth (the page itself);
//   b. every guarded container — [data-tickets-scroll] (the tickets table's scroll box, where
//      the #759 defect lived) and the opt-in [data-overflow-guard] attribute, for any container
//      that must never scroll sideways at desktop widths — where scrollWidth > clientWidth.
// Containers that scroll sideways by design (app-bar nav, config tabs, harnesses card, copy
// commands) are deliberately not checked.
//
//   npm run check:overflow   # = build:ui + this script
//
// The browser is downloaded on first use into playwright's cache (PLAYWRIGHT_BROWSERS_PATH if
// set, else ~/.cache/ms-playwright). If it can't be downloaded or launched (offline sandbox,
// egress blocked, missing shared libraries), the script prints exactly one line starting
// `skipped: no browser available` and exits 0 — except when CI is set, where the same
// condition exits 1, so CI can never go green by skipping.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createUiServer } from "../../src/ui/server.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const distDir = path.join(repo, "ui", "dist");
if (!fs.existsSync(path.join(distDir, "index.html"))) {
  console.error("ui/dist is missing — run `npm run build:ui` (or `npm run check:overflow`, which builds it)");
  process.exit(1);
}

// Fixture: a temp AGENTHOOK_HOME with the standard seed plus many rows (paging/scroll region)
// and long unbreakable titles with every optional column filled (title-width bugs).
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-overflow-"));
const seed = spawnSync(process.execPath, [path.join(repo, "test", "fixtures", "ui", "seed.js"), home, "--bulk", "60", "--long-titles"], { stdio: "inherit" });
if (seed.status !== 0) {
  console.error(`seed.js exited ${seed.status}`);
  process.exit(1);
}

// In-process UI server over the seeded registry, 127.0.0.1, ephemeral port, random token.
const token = crypto.randomBytes(24).toString("hex");
const server = createUiServer({ port: 0, token, distDir, registry: home });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
/** @type {number} */
const port = /** @type {{port:number}} */ (server.address()).port;
const base = `http://127.0.0.1:${port}`;

/** Close the server: disconnect any open SSE streams, then wait for the listener to drop. */
const closeServer = () => {
  try {
    /** @type {{ closeAllConnections?: () => void, close: (cb?: () => void) => unknown }} */
    const s = /** @type {any} */ (server);
    s.closeAllConnections?.(); // the app's /api/stream SSE would otherwise hold close() open
    return new Promise((r) => s.close(() => r()));
  } catch {
    return Promise.resolve();
  }
};

/** Close the browser (if any), stop the server and remove the fixture. */
const cleanup = () => {
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best effort */
  }
};

/** One-line reason from an error. @param {unknown} e */
const brief = (e) =>
  String(e instanceof Error ? e.message : e).replace(/\s+/g, " ").trim().slice(0, 200);

/** One-line reason from the installer's combined output. @param {string} text */
const installReason = (text) => {
  const lines = text.trim().split("\n").filter(Boolean);
  return (lines.find((l) => /^Error:|failed|denied|blocked|refused|not in this sandbox/i.test(l)) ?? lines.at(-1) ?? "install failed").replace(/\s+/g, " ").trim().slice(0, 200);
};

// Browser: make sure chromium-headless-shell is installed (the install is a no-op when the
// build is already in the cache), then launch. Any download/launch failure → skip.
let browser = null;
try {
  const bin = path.join(repo, "node_modules", "playwright-core", "cli.js");
  const install = spawnSync(process.execPath, [bin, "install", "chromium-headless-shell"], { cwd: repo, encoding: "utf8", timeout: 10 * 60 * 1000 });
  if (install.status !== 0) throw new Error(`install exited ${install.status ?? "null"}: ${installReason(String(install.stderr || "") + "\n" + String(install.stdout || ""))}`);
  browser = await chromium.launch();
} catch (e) {
  console.log(`skipped: no browser available (${brief(e)})`);
  await browser?.close().catch(() => {});
  await closeServer();
  cleanup();
  process.exit(process.env.CI ? 1 : 0);
}

const PAGES = [
  { name: "Home", route: "#/", ready: "[data-profile-card]" },
  // "show all" lifts the 24h-stale filter (the fixture's rows are all fresh, so the count is the
  // same either way — the toggle is on because that app state is what #770 asked us to cover).
  // The "All tickets" section is collapsed by default (Overview's ticketsOpen starts false and
  // resets on every remount), so the table — and [data-tickets-scroll] — is only reachable
  // through the [data-tickets-toggle] button; the section header is what the ready selector waits
  // for, and openTickets expands it before measuring.
  { name: "Overview", route: "#/p/agenthook", ready: "[data-all-tickets]", openTickets: true, showAll: true },
  { name: "Statistics", route: "#/p/agenthook/stats", ready: "[data-chart]" },
  // The fixture registry has no running receiver, so this page settles in its 503 state; the
  // status line renders on mount in every state, the rows never do.
  { name: "Epics", route: "#/p/agenthook/epics", ready: "[data-epics-status]" },
  { name: "Config", route: "#/p/agenthook/config", ready: "[data-config-pane]" },
];
const WIDTHS = [1328, 1366, 1920, 2560];
const HEIGHT = 900;
const SCHEMES = ["light", "dark"];
const WAIT_MS = 20_000;

const ctx = await browser.newContext();
const page = await ctx.newPage();
const failures = [];
let checks = 0;
try {
  // `?token=` → cookie exchange (same-origin redirect), then hash-route from the cookie.
  await page.goto(`${base}/?token=${token}`, { waitUntil: "domcontentloaded", timeout: WAIT_MS });
  await page.waitForSelector(PAGES[0].ready, { timeout: WAIT_MS });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: HEIGHT });
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const p of PAGES) {
        await page.goto(`${base}/${p.route}`, { waitUntil: "domcontentloaded", timeout: WAIT_MS });
        await page.waitForSelector(p.ready, { timeout: WAIT_MS });
        if (p.openTickets) {
          // Overview remounts between visits, so the section is collapsed again each time;
          // expand it (idempotent when a hash-only revisit left it open).
          const expanded = await page.getAttribute("[data-tickets-toggle]", "aria-expanded");
          if (expanded !== "true") await page.click("[data-tickets-toggle]");
          await page.waitForSelector("[data-tickets-scroll]", { timeout: WAIT_MS });
        }
        if (p.showAll) {
          // The box lives in the table's toolbar (only rendered once the section is open);
          // showAll itself is App-level state, so on revisits the box is already checked.
          await page.evaluate(() => {
            const c = document.querySelector('[data-all-tickets] input[type="checkbox"]');
            if (c && !c.checked) c.click();
          });
          // 60 bulk + 4 long-title + the manual seed rows → the 50-row page fills up.
          await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length >= 45, { timeout: WAIT_MS });
        }
        await page.evaluate(() => document.fonts.ready);
        await new Promise((r) => setTimeout(r, 400)); // fonts + layout settle
        /** @type {{ el: string, scrollWidth: number, clientWidth: number }[]} */
        const bad = await page.evaluate(() => {
          /** @type {{ el: string, scrollWidth: number, clientWidth: number }[]} */
          const out = [];
          const doc = document.documentElement;
          if (doc.scrollWidth > doc.clientWidth) out.push({ el: "document", scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth });
          for (const attr of ["data-tickets-scroll", "data-overflow-guard"]) {
            const els = Array.from(document.querySelectorAll(`[${attr}]`));
            els.forEach((el, i) => {
              if (el.scrollWidth > el.clientWidth)
                out.push({ el: els.length > 1 ? `[${attr}]:nth(${i})` : `[${attr}]`, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
            });
          }
          return out;
        });
        checks++;
        for (const b of bad) failures.push(`FAIL ${p.name} ${width}px ${scheme}: ${b.el} scrollWidth=${b.scrollWidth} clientWidth=${b.clientWidth}`);
      }
    }
  }
} finally {
  await ctx.close().catch(() => {});
  await browser.close().catch(() => {});
  await closeServer();
  cleanup();
}

if (failures.length > 0) {
  for (const f of failures) console.log(f);
  console.log(`failed: ${failures.length} of ${checks} checks`);
  process.exit(1);
}
console.log(`ok: ${checks} checks`);
