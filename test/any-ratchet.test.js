// Ratchet test: the count of explicit JSDoc/TS `any` tokens in src/ and
// ui/src/ may only go down, never up, relative to test/any-baseline.json.
//
// A legitimate drop (you removed some `any`s) makes this fail with
// "lower the baseline for <area> to N in test/any-baseline.json" — regenerate
// the baseline by running `node test/any-ratchet.test.js --write-baseline`
// (or edit test/any-baseline.json by hand).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Explicit-`any` detection — count the word, not enumerated shapes. The
// reviewer's round-2 decision: a fixed shape list always lags the forms the
// code actually uses, so instead we reduce each file to text that is known to
// be a *type position* and count whole `any` words in it.
//
//   - src/*.js, src/*.mjs: only the inside of a JSDoc tag's `{...}` type
//     annotation (the tags listed in JSDOC_TYPE_TAGS), extracted by
//     balanced-brace matching so a multi-line object type like
//     `@param {{ ... }} deps` is captured whole. Prose outside the type
//     braces — descriptions, "before any further await" — is dropped.
//   - ui/src/*.ts(x): the whole file with string literals blanked first
//     (so a URL like 'http://…' can't truncate the rest of its line), then
//     comments stripped, then every `any` word that is not member access
//     (`Promise.any(`) is counted.
//
// Either way the count is the number of /any/ whole-word matches in the
// reduced text — a new `any` shape can never slip past, and a line whose
// prose contains the word never counts, whatever word it happens to be.
// ---------------------------------------------------------------------------

const ANY_WORD = /\bany\b/g;

/** Tags whose argument is a `{...}` type annotation. `@type`/`@typedef`/
 * `@callback` may take the braces without a name; the rest need a name. */
const JSDOC_TYPE_TAGS =
  /@(?:param|arg|argument|returns?|type|typedef|property|prop|yields|throws|callback|template|this|satisfies|enum)\b/g;

/** Blank quoted literals ('…', "…", `…`) so prose inside quotes is never
 * scanned. No escapes in a *reduced* type region can hide a quote, and the
 * ui/src scan runs on code where a quoted `"` inside `'…'` is legal — hence
 * the quote-char-aware walk rather than three regexes. */
function blankLiterals(text) {
  let out = '';
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Count `any` whole-word tokens in text already reduced to type position
 * (quoted literals blanked). An `any` preceded by `.` is member access
 * (`Promise.any(`), not a type, and is not counted. */
function countAny(text) {
  let count = 0;
  ANY_WORD.lastIndex = 0;
  let m;
  while ((m = ANY_WORD.exec(text))) {
    if (m.index === 0 || text[m.index - 1] !== '.') count++;
  }
  return count;
}

/** Extract the `{...}` type-annotation text following each JSDoc tag in
 * `block`, matching braces by depth so a multi-line object type is captured
 * whole. Text outside a tag's type braces (prose, descriptions) is dropped. */
function extractJsdocTypeRegions(block) {
  const regions = [];
  JSDOC_TYPE_TAGS.lastIndex = 0;
  let m;
  while ((m = JSDOC_TYPE_TAGS.exec(block))) {
    let i = m.index + m[0].length;
    while (i < block.length && (block[i] === ' ' || block[i] === '\t')) i++;
    if (block[i] !== '{') continue;
    const start = i;
    let depth = 0;
    for (; i < block.length; i++) {
      if (block[i] === '{') depth++;
      else if (block[i] === '}') {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    regions.push(block.slice(start, i));
  }
  return regions;
}

/** Count explicit `any` tokens inside one JSDoc doc-comment block's type
 * annotations (not its prose). */
function countJsdocBlock(block) {
  let count = 0;
  for (const region of extractJsdocTypeRegions(block)) count += countAny(blankLiterals(region));
  return count;
}

/** Count explicit `any` tokens in JSDoc doc-comment blocks (`/** ... *\/`) inside a file. */
function countJsdocAny(filepath) {
  const content = readFileSync(filepath, 'utf8');
  const jsdocs = content.match(/\/\*\*[\s\S]*?\*\//g) || [];
  let total = 0;
  for (const block of jsdocs) total += countJsdocBlock(block);
  return total;
}

/** Reduce a TypeScript file to its code: a single left-to-right pass that
 * blanks block and line comments and `'…'`/`"…"`/backtick string literals
 * (honouring backslash escapes), so the remaining text is pure code and a
 * `any` in a comment, a string, or after a URL on a code line is never
 * counted. One pass (not regex strip-then-blank) because an apostrophe in a
 * line comment ("aren't") must not open a phantom string. */
function reduceTsText(content) {
  let out = '';
  let i = 0;
  const n = content.length;
  while (i < n) {
    const c = content[i];
    const c2 = content[i + 1];
    if (c === '/' && c2 === '*') { // block comment
      i += 2;
      while (i < n && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i = i < n ? i + 2 : n;
    } else if (c === '/' && c2 === '/') { // line comment
      i += 2;
      while (i < n && content[i] !== '\n') i++;
    } else if (c === "'" || c === '"' || c === '`') { // string literal
      const quote = c;
      i++;
      while (i < n && content[i] !== quote) {
        if (content[i] === '\\') i++; // skip escaped char
        i++;
      }
      i = i < n ? i + 1 : n; // skip closing quote
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Count explicit `any` tokens in a TypeScript source file, outside
 * comments and strings (member-access `any` like `Promise.any(` is not
 * counted). */
function countTsAny(filepath) {
  const content = readFileSync(filepath, 'utf8');
  return countAny(reduceTsText(content));
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

/** Recursively walk a directory, collecting files whose names end with one of
 * `exts`. Excludes `*.test.*` and ambient `*.d.ts` files. */
function walk(dir, exts) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full, exts));
    } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
      if (entry.name.includes('.test.') || entry.name.endsWith('.d.ts')) continue;
      files.push(full);
    }
  }
  return files;
}

/** Collect a repo-relative any-count map (and its total) for a directory tree. */
function countDirAny(dir, exts, fn) {
  const files = walk(dir, exts);
  const map = {};
  for (const f of files) {
    const c = fn(f);
    if (c > 0) map[relative(ROOT, f).split(sep).join('/')] = c;
  }
  const total = Object.values(map).reduce((a, b) => a + b, 0);
  return { map, total };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const BASELINE_PATH = join(__dirname, 'any-baseline.json');

describe('any-ratchet', () => {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

  test('src/ has no new explicit `any` tokens', () => {
    const { map, total } = countDirAny(join(ROOT, 'src'), ['.js', '.mjs'], countJsdocAny);
    assert.strictEqual(total, baseline.src.total, ratchetMessage('src', total, baseline.src, map));
  });

  test('ui/src/ has no new explicit `any` tokens', () => {
    const { map, total } = countDirAny(join(ROOT, 'ui', 'src'), ['.ts', '.tsx'], countTsAny);
    assert.strictEqual(
      total,
      baseline['ui/src'].total,
      ratchetMessage('ui/src', total, baseline['ui/src'], map),
    );
  });

  test('countJsdocBlock — structural matches', () => {
    assert.strictEqual(countJsdocBlock('@param {any} x'), 1);
    assert.strictEqual(countJsdocBlock('@param {any[]} xs'), 1);
    assert.strictEqual(countJsdocBlock('@returns {Promise<any>}'), 1);
    assert.strictEqual(countJsdocBlock('@property {Record<string, any>} opts'), 1);
    assert.strictEqual(countJsdocBlock('@param {{ value: any }} opts'), 1);
    assert.strictEqual(countJsdocBlock('@param {{ results: any[], }} opts'), 1);
    assert.strictEqual(countJsdocBlock('@param {string | any} x'), 1);
    assert.strictEqual(countJsdocBlock('@param {any} x @param {any} y'), 2);
    // Reviewer round 2: every common shape, no matter where the word sits.
    assert.strictEqual(countJsdocBlock('@param {() => any} fn'), 1);
    assert.strictEqual(countJsdocBlock('@param {Map<string, any>} m'), 1);
    assert.strictEqual(countJsdocBlock('@param {any|null} x'), 1);
    assert.strictEqual(countJsdocBlock('@param {any | undefined} x'), 1);
    assert.strictEqual(countJsdocBlock('@param {[any, string]} pair'), 1);
    // Record<string, any> right after another match on the same line (real:
    // src/engine/controllers.js).
    assert.strictEqual(countJsdocBlock('@param {Record<string, any>, Record<string, any>} x'), 2);
    assert.strictEqual(countJsdocBlock('@prop {any} x'), 1);
    assert.strictEqual(countJsdocBlock('@arg {any} x'), 1);
    assert.strictEqual(countJsdocBlock('@argument {any} x'), 1);
    assert.strictEqual(countJsdocBlock('@template {any} T'), 1);
    assert.strictEqual(countJsdocBlock('@this {any}'), 1);
    assert.strictEqual(countJsdocBlock('@satisfies {any} x'), 1);
    assert.strictEqual(countJsdocBlock('@enum {any}'), 1);
    // Real multi-line case: src/ci-green.js:9 — any inside a nested object type.
    assert.strictEqual(
      countJsdocBlock(
        "@param {{\n *   emit?: (event: string, extra?: Record<string, any>) => void,\n * }} deps",
      ),
      1,
    );
  });

  test('countJsdocBlock — prose after the type is skipped', () => {
    // Real lines: src/types.js — "any" in the description, not the type.
    assert.strictEqual(
      countJsdocBlock(
        "@property {string[]} [followUp]  approves and records them, any other tier holds",
      ),
      0,
    );
    assert.strictEqual(
      countJsdocBlock(
        "@property {(since: string) => Promise<MergedAgentPr[]>} [x]  after `since` (ISO), any order",
      ),
      0,
    );
    assert.strictEqual(countJsdocBlock('before any further await'), 0);
    assert.strictEqual(countJsdocBlock('let any = false'), 0);
  });

  test('countAny / reduceTsText — structural matches', () => {
    assert.strictEqual(countAny(': any'), 1);
    assert.strictEqual(countAny('as any'), 1);
    assert.strictEqual(countAny('<any'), 1);
    assert.strictEqual(countAny('any[] '), 1);
    assert.strictEqual(countAny('| any'), 1);
    assert.strictEqual(countAny('x: any | string'), 1);
    assert.strictEqual(countAny('const x: any[] = []'), 1);
    // Reviewer round 2: function-shape types in ui/src/state.ts.
    assert.strictEqual(countAny('const f = (x: Map<string, any>) => x'), 1);
    assert.strictEqual(countAny('const g = (): (() => any) => () => undefined'), 1);
    // Member access is not a type.
    assert.strictEqual(countAny('Promise.any(promiseArray)'), 0);
    assert.strictEqual(countAny('const x: any; Promise.any([p])'), 1);
  });

  test('reduceTsText — comments and string literals carry no "any"', () => {
    // Real lines: ui/src/speech.ts, ui/src/EpicPage.tsx, src/ui/server.js.
    assert.strictEqual(
      countAny(reduceTsText('/** The first voice (primary subtag, any case), preferring default */')),
      0,
    );
    assert.strictEqual(
      countAny(reduceTsText("/** A done ticket's PR link, any state, for the muted link */")),
      0,
    );
    assert.strictEqual(
      countAny(reduceTsText('// Bound to every interface (`0.0.0.0` / `::`), any `ip:<port>` whose ip')),
      0,
    );
    // A URL string followed by code on the same line must not swallow the
    // type `any` after it (blankLiterals runs before `//` stripping).
    assert.strictEqual(
      countAny(reduceTsText("const u = 'http://example.com/x'; const v: any = u;")),
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// Baseline regeneration (not run under `node --test`; invoke directly)
// ---------------------------------------------------------------------------

function buildBaseline() {
  const src = countDirAny(join(ROOT, 'src'), ['.js', '.mjs'], countJsdocAny);
  const ui = countDirAny(join(ROOT, 'ui', 'src'), ['.ts', '.tsx'], countTsAny);
  return {
    src: { total: src.total, files: src.map },
    'ui/src': { total: ui.total, files: ui.map },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])
  && process.argv.includes('--write-baseline')) {
  writeFileSync(BASELINE_PATH, JSON.stringify(buildBaseline(), null, 2) + '\n');
  console.log(`wrote ${BASELINE_PATH}`);
}

// ---------------------------------------------------------------------------
// Output helpers (side-effect only; assertions above drive pass/fail)
// ---------------------------------------------------------------------------

/** Build the assertion failure message for an area whose count diverged from
 * the baseline — grown (name only the files that grew) or shrunk (ask to
 * regenerate the baseline). */
function ratchetMessage(area, total, baselineEntry, map) {
  if (total > baselineEntry.total) {
    const baseFiles = baselineEntry.files || {};
    const grown = Object.entries(map)
      .filter(([f, c]) => c > (baseFiles[f] || 0))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([f, c]) => `    ${f}: ${baseFiles[f] || 0} -> ${c}`)
      .join('\n');
    return `${area} grew from ${baselineEntry.total} to ${total} explicit any tokens. Files that grew:\n${grown}`;
  }
  return `lower the baseline for ${area} to ${total} in test/any-baseline.json (run: node test/any-ratchet.test.js --write-baseline)`;
}
