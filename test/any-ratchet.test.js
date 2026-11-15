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
// Explicit-`any` detection — one documented pattern set, applied only to text
// already known to be a *type position*:
//   - src/*.js, src/*.mjs: the inside of a JSDoc tag's `{...}` type
//     annotation (@param/@returns/@type/@typedef/@property/@yields/@throws/
//     @callback), extracted by balanced-brace matching so it also covers a
//     multi-line object type like `@param {{ ... }} deps`. Prose that
//     follows the type's closing `}` on the same line is never scanned.
//   - ui/src/*.ts(x): the whole file with `/* ... */` and `// ...` comments
//     stripped first, so prose like "(primary subtag, any case)" inside a
//     doc comment is never scanned either.
// ---------------------------------------------------------------------------
const ANY_PATTERNS = [
  /\{any\[\]\}/g, // {any[]} — bare any-array JSDoc type (checked before {any})
  /\{any\}/g, // {any} — bare any JSDoc type
  /Promise<any>/g, // Promise<any>
  /Record<string,\s*any>/g, // Record<string, any>
  /\bas any\b/g, // TS type assertion: `x as any`
  /:\s*any\b/g, // `: any` type annotation (JSDoc member or TS)
  /<any\b/g, // generic type arg: `Foo<any`, `Array<any>`...
  /\bany\[\]/g, // `any[]` array shorthand
  /\|\s*any\b/g, // union member: `X | any`
];

/** Count `any` tokens in `text` using ANY_PATTERNS, left to right, without
 * double-counting overlapping matches (e.g. `{any[]}` also contains `any[]`). */
function countAny(text) {
  let remaining = text;
  let count = 0;
  for (const pattern of ANY_PATTERNS) {
    const matches = remaining.match(pattern);
    if (matches) count += matches.length;
    remaining = remaining.replace(pattern, (m) => ' '.repeat(m.length));
  }
  return count;
}

const JSDOC_TAG_RE = /@(?:param|returns?|type|typedef|property|yields|throws|callback)\b/g;

/** Extract the `{...}` type-annotation text following each JSDoc tag in
 * `block`, matching braces by depth so a multi-line object type is captured
 * whole. Text outside a tag's type braces (prose, descriptions) is dropped. */
function extractJsdocTypeRegions(block) {
  const regions = [];
  JSDOC_TAG_RE.lastIndex = 0;
  let m;
  while ((m = JSDOC_TAG_RE.exec(block))) {
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
  for (const region of extractJsdocTypeRegions(block)) count += countAny(region);
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

/** Strip `/* ... *\/` and `// ...` comments so prose inside them is never
 * scanned for `any`. */
function stripTsComments(content) {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Count explicit `any` tokens in a TypeScript source file, outside comments. */
function countTsAny(filepath) {
  const content = readFileSync(filepath, 'utf8');
  return countAny(stripTsComments(content));
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

  test('countTsAny — structural matches (string input via countAny)', () => {
    assert.strictEqual(countAny(': any'), 1);
    assert.strictEqual(countAny('as any'), 1);
    assert.strictEqual(countAny('<any'), 1);
    assert.strictEqual(countAny('any[] '), 1);
    assert.strictEqual(countAny('| any'), 1);
    assert.strictEqual(countAny('x: any | string'), 1);
    assert.strictEqual(countAny('const x: any[] = []'), 1);
  });

  test('stripTsComments — real comment prose with "any" is removed', () => {
    // Real lines: ui/src/speech.ts, ui/src/EpicPage.tsx, src/ui/server.js.
    assert.strictEqual(
      countAny(stripTsComments('/** The first voice (primary subtag, any case), preferring default */')),
      0,
    );
    assert.strictEqual(
      countAny(stripTsComments("/** A done ticket's PR link, any state, for the muted link */")),
      0,
    );
    assert.strictEqual(
      countAny(stripTsComments('// Bound to every interface (`0.0.0.0` / `::`), any `ip:<port>` whose ip')),
      0,
    );
    assert.strictEqual(countAny(stripTsComments('before any further await')), 0);
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
