#!/usr/bin/env node
// launch-watch collector: what people said about agenthook since the last check, from public
// read-only sources. No accounts, no writes anywhere except the local seen-state file.
//
//   node collect.mjs                 new items since last --mark, as JSON on stdout
//   node collect.mjs --mark          ...and remember them as seen (run after the user reviewed)
//   node collect.mjs --track <url>   also follow this HN item / Reddit post / any URL's thread
//   node collect.mjs --untrack <url>
//   node collect.mjs --all           ignore seen-state (show everything found)
//
// Sources: HN (Algolia API, strict match + tracked threads), Reddit (search RSS + tracked posts'
// comment RSS — the JSON API needs OAuth now), GitHub (issues, PRs, comments and discussions by
// anyone but the owner; stars, forks), npm weekly downloads.
// State: $XDG_STATE_HOME/agenthook/launch-watch.json (default ~/.local/state/...).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = "Jesuso/agenthook";
const OWNER = "Jesuso";
const PKG = "@jesuso/agenthook";
const TERMS = ["agenthook"];
const UA = "linux:agenthook-launch-watch:v0.1";

const args = process.argv.slice(2);
const flag = (/** @type {string} */ f) => args.includes(f);
const opt = (/** @type {string} */ f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);

const stateFile = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "agenthook", "launch-watch.json");
/** @type {{seen: Record<string, string>, tracked: string[], metrics?: any, lastRun?: string}} */
const state = (() => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return { seen: {}, tracked: [] };
  }
})();
if (opt("--track")) state.tracked = [...new Set([...state.tracked, String(opt("--track"))])];
if (opt("--untrack")) state.tracked = state.tracked.filter((u) => u !== opt("--untrack"));

/** @typedef {{id: string, source: string, kind: string, author: string, url: string, title?: string, text: string, at: string, parent?: string}} Item */
/** @type {Item[]} */
const items = [];
/** @type {string[]} */
const errors = [];
const since = state.lastRun || new Date(Date.now() - 7 * 864e5).toISOString();

await Promise.all([hn(), reddit(), github()].map((p) => p.catch((e) => errors.push(String(e.message || e)))));
const metrics = await collectMetrics().catch((e) => (errors.push(String(e.message || e)), {}));

const fresh = items.filter((i) => flag("--all") || !state.seen[i.id]).sort((a, b) => a.at.localeCompare(b.at));
const prev = state.metrics || {};
const out = {
  checkedAt: new Date().toISOString(),
  since,
  new: fresh,
  metrics,
  metricsDelta: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, typeof v === "number" && typeof prev[k] === "number" ? v - prev[k] : null])),
  tracked: state.tracked,
  errors,
};
console.log(JSON.stringify(out, null, 2));

if (flag("--mark") || opt("--track") || opt("--untrack")) {
  if (flag("--mark")) {
    for (const i of items) state.seen[i.id] ||= out.checkedAt;
    state.metrics = metrics;
    state.lastRun = out.checkedAt;
  }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// ── sources ──────────────────────────────────────────────────────────────────────────────

/** A real mention, not a fuzzy search hit ("agentfork") or another project's word ("agenthooks"). @param {string} s */
function matches(s) {
  return TERMS.some((t) => new RegExp(`\\b${t}\\b`, "i").test(s));
}

async function hn() {
  for (const term of TERMS) {
    const r = await getJson(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(term)}&tags=(story,comment)&typoTolerance=false&hitsPerPage=50`);
    for (const h of r.hits || []) {
      const text = strip(h.comment_text || h.story_text || "");
      if (!matches(`${h.title || ""} ${h.url || ""} ${text}`)) continue;
      items.push({ id: `hn:${h.objectID}`, source: "hn", kind: h.comment_text ? "comment" : "story", author: h.author, url: `https://news.ycombinator.com/item?id=${h.objectID}`, title: h.title || h.story_title, text, at: h.created_at, parent: h.story_id ? `hn:${h.story_id}` : undefined });
    }
  }
  // Every comment in a tracked thread, mention or not (a Show HN's replies rarely say the name).
  for (const u of state.tracked) {
    const id = u.match(/news\.ycombinator\.com\/item\?id=(\d+)/)?.[1];
    if (!id) continue;
    const walk = (/** @type {any} */ n, /** @type {string} */ storyTitle) => {
      if (n.type === "comment" && n.author) items.push({ id: `hn:${n.id}`, source: "hn", kind: "comment", author: n.author, url: `https://news.ycombinator.com/item?id=${n.id}`, title: storyTitle, text: strip(n.text || ""), at: n.created_at, parent: n.parent_id ? `hn:${n.parent_id}` : undefined });
      for (const c of n.children || []) walk(c, storyTitle);
    };
    const root = await getJson(`https://hn.algolia.com/api/v1/items/${id}`);
    walk(root, root.title);
  }
}

async function reddit() {
  /** @param {string} xml @param {string} kind @param {boolean} [all] every entry (a tracked thread), else mentions only */
  const entries = (xml, kind, all = false) => {
    for (const e of xml.match(/<entry>[\s\S]*?<\/entry>/g) || []) {
      const tag = (/** @type {string} */ t) => e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] ?? "";
      const id = tag("id");
      const link = e.match(/<link href="([^"]+)"/)?.[1] ?? "";
      const item = { id: `reddit:${id}`, source: "reddit", kind: id.startsWith("t1_") ? "comment" : kind, author: strip(tag("name")), url: link, title: strip(tag("title")), text: strip(decode(tag("content"))).slice(0, 4000), at: tag("updated") };
      if (all || matches(`${item.title} ${item.text} ${link}`)) items.push(item);
    }
  };
  for (const term of TERMS) entries(await getText(`https://www.reddit.com/search.rss?q=${encodeURIComponent(term)}&sort=new&limit=50`), "post");
  for (const u of state.tracked) {
    const m = u.match(/reddit\.com\/r\/[^/]+\/comments\/[a-z0-9]+/i);
    if (m) entries(await getText(`https://www.${m[0].replace(/^www\./, "")}/.rss?limit=200`), "post", true);
  }
}

async function github() {
  const gh = (/** @type {string} */ p) => JSON.parse(execFileSync("gh", ["api", "--paginate", p], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }) || "[]");
  const external = (/** @type {any} */ u) => u && u.login !== OWNER && u.type !== "Bot";
  for (const i of gh(`repos/${REPO}/issues?state=all&since=${since}&per_page=100`)) {
    if (!external(i.user) || i.created_at < since) continue;
    items.push({ id: `gh:${i.node_id}`, source: "github", kind: i.pull_request ? "pr" : "issue", author: i.user.login, url: i.html_url, title: i.title, text: (i.body || "").slice(0, 4000), at: i.created_at });
  }
  for (const c of gh(`repos/${REPO}/issues/comments?since=${since}&per_page=100`)) {
    if (!external(c.user)) continue;
    items.push({ id: `gh:${c.node_id}`, source: "github", kind: "comment", author: c.user.login, url: c.html_url, text: (c.body || "").slice(0, 4000), at: c.created_at, parent: c.issue_url });
  }
  try {
    const q = `query { repository(owner: "${REPO.split("/")[0]}", name: "${REPO.split("/")[1]}") { discussions(first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { id title url body createdAt author { login } comments(last: 30) { nodes { id url body createdAt author { login } } } } } } }`;
    const d = JSON.parse(execFileSync("gh", ["api", "graphql", "-f", `query=${q}`], { encoding: "utf8" }));
    for (const n of d.data?.repository?.discussions?.nodes || []) {
      if (n.author?.login !== OWNER && n.createdAt >= since) items.push({ id: `gh:${n.id}`, source: "github", kind: "discussion", author: n.author?.login, url: n.url, title: n.title, text: (n.body || "").slice(0, 4000), at: n.createdAt });
      for (const c of n.comments?.nodes || []) if (c.author?.login !== OWNER && c.createdAt >= since) items.push({ id: `gh:${c.id}`, source: "github", kind: "comment", author: c.author?.login, url: c.url, title: n.title, text: (c.body || "").slice(0, 4000), at: c.createdAt });
    }
  } catch {} // discussions disabled
}

async function collectMetrics() {
  const repo = JSON.parse(execFileSync("gh", ["api", `repos/${REPO}`], { encoding: "utf8" }));
  const npm = await getJson(`https://api.npmjs.org/downloads/point/last-week/${PKG}`).catch(() => ({}));
  return { stars: repo.stargazers_count, forks: repo.forks_count, watchers: repo.subscribers_count, openIssues: repo.open_issues_count, npmLastWeek: npm.downloads ?? null };
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────

/** @param {string} url */
async function getText(url) {
  let r = await fetch(url, { headers: { "User-Agent": UA } });
  if (r.status === 429) {
    // Reddit rate-limits anonymous RSS hard; one polite retry, then report it.
    await new Promise((res) => setTimeout(res, 8000));
    r = await fetch(url, { headers: { "User-Agent": UA } });
  }
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}${r.status === 429 ? " (rate-limited — retry in a few minutes)" : ""}`);
  return r.text();
}
/** @param {string} url */
async function getJson(url) {
  return JSON.parse(await getText(url));
}
/** @param {string} s */
function decode(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, "&");
}
/** HTML → plain text. @param {string} s */
function strip(s) {
  return decode(s.replace(/<p>/g, "\n\n").replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "")).replace(/\n{3,}/g, "\n\n").trim();
}
