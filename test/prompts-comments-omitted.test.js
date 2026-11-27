import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `formatTicketComments`'s omitted accounting (src/prompts.js, #829): the adapter's
// `fetchComments` reports how many OLDER comments sat outside its newest-100 window
// (`fetchOmitted`); anything the size cap drops on top must be ADDED to that number, and the
// single trailing line is the total.
import test from "node:test";
import assert from "node:assert/strict";
import { formatTicketComments } from "../src/prompts.js";

/** @param {number} n 50-byte bodies, short fixed headers */
const mk = (n) =>
  Array.from({ length: n }, (_, i) => ({ author: "a", body: "x".repeat(50), createdAt: "t", owner: false }));
/** Each entry: header `@a  t  not owner` (16) + \n + 50 = 67, +2 overhead = 69 bytes. */
const CAP = 200; // fits exactly floor((200-69+69)/69)=2... 69+69=138, 3rd would be 207 > 200

test("a thread that fits the cap omits nothing — no trailing line", () => {
  assert.equal(formatTicketComments(mk(2), CAP).split("older comments omitted").length - 1, 0);
});

test("the size cap's drops are counted in the trailing line", () => {
  const m = formatTicketComments(mk(5), CAP).match(/(\d+) older comments omitted/);
  assert.ok(m, "the line is present");
  assert.equal(Number(m[1]), 3, "2 fit, the 3 older were dropped for size");
});

test("the adapter's omitted count is ADDED to the size cap's drops", () => {
  const m = formatTicketComments(mk(5), CAP, 7).match(/(\d+) older comments omitted/);
  assert.ok(m, "the line is present");
  assert.equal(Number(m[1]), 10, "3 dropped for size + 7 the adapter left out");
});

test("an adapter omission with no size drops still says so", () => {
  assert.ok(formatTicketComments(mk(1), CAP, 100).endsWith("100 older comments omitted"));
});

test("zero fetchOmitted never prints a line", () => {
  assert.equal(formatTicketComments(mk(2), CAP, 0).split("older comments omitted").length - 1, 0);
});
