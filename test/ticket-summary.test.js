import "./_setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeDescription, SUMMARY_MAX } from "../src/ticket-summary.js";

test("skips the heading, takes the first prose paragraph (a real agenthook issue body shape)", () => {
  const body = "## Problem\n\nAll pipeline steps share one `maxConcurrent` slot pool. A burst of new tickets fills every slot with triage runs.\n\n**Decision (owner approved):** add an optional cap.\n\n## Evidence\n\n- `src/queue.js:75`";
  assert.equal(summarizeDescription(body), "All pipeline steps share one maxConcurrent slot pool. A burst of new tickets fills every slot with triage runs.");
});

test("strips markdown: links keep text, images/html/emphasis/ticks go", () => {
  assert.equal(summarizeDescription("See [the **docs**](https://x.y/z) for `foo` — ![shot](a.png) <b>bold</b> _it_ ok"), "See the docs for foo — bold it ok");
});

test("ignores fences, comments, rules, tables, checklists and too-short fragments", () => {
  const body = "<!-- template -->\n\nTL;DR\n\n```sh\nrm -rf /\n```\n\n---\n\n| a | b |\n|---|---|\n\n- [ ] todo item here\n\nThe checkout page drops the discount code when the cart is edited.";
  assert.equal(summarizeDescription(body), "The checkout page drops the discount code when the cart is edited.");
});

test("a list item's bullet is dropped; joins a paragraph's wrapped lines", () => {
  assert.equal(summarizeDescription("- first thing that matters here\n  continues on the next line"), "first thing that matters here continues on the next line");
});

test("clips to SUMMARY_MAX with an ellipsis; handles CRLF", () => {
  const out = summarizeDescription("word ".repeat(200).replace(/ /g, " ").trim().replace(/\n/g, "\r\n"));
  assert.ok(out && out.length === SUMMARY_MAX && out.endsWith("…"));
  assert.equal(summarizeDescription("Line one is long enough.\r\n\r\nLine two."), "Line one is long enough.");
});

test("no usable prose, or not a string → undefined (never an empty string)", () => {
  for (const v of ["", "   ", "## Only a heading", "```\ncode only\n```", null, undefined, 7, {}]) assert.equal(summarizeDescription(v), undefined, JSON.stringify(v));
});

test("an unterminated fence swallows only the rest, not earlier prose", () => {
  assert.equal(summarizeDescription("Earlier prose that matters.\n\n```js\nnever closed"), "Earlier prose that matters.");
});
