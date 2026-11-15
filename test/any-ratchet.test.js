// Ratchet test: the count of explicit JSDoc/TS `any` tokens in src/ and
// ui/src/ may only go down, never up, relative to test/any-baseline.json.
//
// A legitimate drop (you removed some `any`s) makes this fail with
// "lower the baseline for <area> to N in test/any-baseline.json" — edit
// test/any-baseline.json by hand to set that area's count to N and re-run.
// There is no --write-baseline flag; the fix is a one-line JSON edit.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively walk a directory, collecting files whose names end with one of
 * the extensions in `exts`.  Excludes `.test.` files (they are not source).
 */
function walk(dir, exts) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full, exts));
    } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
      if (!entry.name.includes('.test.')) files.push(full);
    }
  }
  return files;
}

/**
 * Prose heuristics — lines likely to contain the word "any" in
 * English sentences rather than in type positions.  When matched, the line
 * is skipped entirely.
 *
 * The list is intentionally conservative.  If a real type line contains one
 * of these words alongside a structural "any" pattern, both will still be
 * counted (the prose filter is line-level, not token-level).
 */
const PROSE = /\b(?:order|tier|holds|anyway|anywhere|another|anyone|anything|anytime|anyhow|anybody)\b/;

/** Count explicit `any` tokens in JSDoc doc-comment blocks inside a file. */
function countJsdocAny(filepath) {
  const content = readFileSync(filepath, 'utf8');
  const re = /\/\*\*[\s\S]*?\*\//g;
  const jsdocs = content.match(re) || [];

  let total = 0;
  for (const block of jsdocs) {
    total += countJsdocBlock(block);
  }
  return total;
}

/** Count any tokens inside a single JSDoc doc-comment block. */
function countJsdocBlock(block) {
  const lines = block.split('\n');
  let count = 0;

  for (const line of lines) {
    if (PROSE.test(line)) continue; // prose heuristics — skip this line

    let remaining = line;

    // 1. `{any}`, `{any[]}`
    const brace = /\{any\b|\{any\[\]\}/g;
    while (brace.test(remaining)) { count++; }
    remaining = remaining.replace(brace, '');

    // 2. `Promise<any>`
    const promise = /Promise<any>/g;
    while (promise.test(remaining)) { count++; }
    remaining = remaining.replace(promise, '');

    // 3. `Record<string, any>`
    const record = /Record<string,\s*any>/g;
    while (record.test(remaining)) { count++; }
    remaining = remaining.replace(record, '');

    // 4. Remaining structural type positions:
    //    `: any`, `as any`, `<any`, `any[]`, `, any`, `)`, `any`, `| any`
    const extra = /\bas any\b|: any\b|<any\b|any\[|, any\b|\), any\b|\| any\b/g;
    while (extra.test(remaining)) { count++; }
  }

  return count;
}

/** Count explicit `any` tokens in a TypeScript source file. */
function countTsAny(filepath) {
  const content = readFileSync(filepath, 'utf8');
  const lines = content.split('\n');
  let count = 0;

  for (const line of lines) {
    if (PROSE.test(line)) continue;
    count += countTsLine(line);
  }
  return count;
}

/** Count `any` tokens on a single TypeScript line (outside prose lines). */
function countTsLine(line) {
  const re = /: any\b|as any\b|<any\b|, any\b|any\[|\| any\b/g;
  let n = 0;
  while (re.test(line)) n++;
  return n;
}

/** Collect any-count maps for a directory tree. */
function countDirAny(dir, exts, fn) {
  const files = walk(dir, exts);
  const map = {};
  for (const f of files) {
    const c = fn(f);
    if (c > 0) map[f] = c;
  }
  return { map, total: Object.values(map).reduce((a, b) => a + b, 0) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('any-ratchet', () => {
  const baseline = JSON.parse(
    readFileSync(join(__dirname, 'any-baseline.json'), 'utf8'),
  );

  test('src/ has no new explicit `any` tokens', () => {
    const { map, total } = countDirAny(
      join(__dirname, '..', 'src'),
      ['.js', '.mjs'],
      countJsdocAny,
    );
    assert.strictEqual(total, baseline.src, ratchetMessage('src', total, baseline.src, map));
  });

  test('ui/src/ has no new explicit `any` tokens', () => {
    const { map, total } = countDirAny(
      join(__dirname, '..', 'ui', 'src'),
      ['.ts', '.tsx'],
      countTsAny,
    );
    assert.strictEqual(total, baseline['ui/src'], ratchetMessage('ui/src', total, baseline['ui/src'], map));
  });

  test('countJsdocBlock — structural matches', () => {
    assert.strictEqual(countJsdocBlock('@param {any} x'), 1);
    assert.strictEqual(countJsdocBlock('@param {any[]} xs'), 1);
    assert.strictEqual(countJsdocBlock('Promise<any>'), 1);
    assert.strictEqual(countJsdocBlock('Record<string, any>'), 1);
    assert.strictEqual(countJsdocBlock('{ value: any }'), 1);
    assert.strictEqual(countJsdocBlock('key: any,'), 1);
    assert.strictEqual(countJsdocBlock('results: any[],'), 1);
    assert.strictEqual(countJsdocBlock('x | any'), 1);
    assert.strictEqual(countJsdocBlock('as any'), 1);
    assert.strictEqual(countJsdocBlock('<any'), 1);
    assert.strictEqual(countJsdocBlock('@param {any} x @param {any} y'), 2);
    assert.strictEqual(countJsdocBlock('emit?: (...extra?: Record<string, any>) => void,'), 1);
    assert.strictEqual(countJsdocBlock('emit?: (event: string, extra?: Record<string, any>) => void,'), 1);
  });

  test('countJsdocBlock — prose is skipped', () => {
    assert.strictEqual(countJsdocBlock('before any further await'), 0);
    assert.strictEqual(countJsdocBlock('let any = false'), 0);
    assert.strictEqual(countJsdocBlock('anywhere'), 0);
    assert.strictEqual(countJsdocBlock(', any other tier holds'), 0);
    assert.strictEqual(countJsdocBlock('since (ISO), any order'), 0);
  });

  test('countTsLine — structural matches', () => {
    assert.strictEqual(countTsLine(': any'), 1);
    assert.strictEqual(countTsLine('as any'), 1);
    assert.strictEqual(countTsLine('<any'), 1);
    assert.strictEqual(countTsLine('any[] '), 1);
    assert.strictEqual(countTsLine(', any'), 1);
    assert.strictEqual(countTsLine('| any'), 1);
    assert.strictEqual(countTsLine('x: any | string'), 1);
    assert.strictEqual(countTsLine('const x: any[] = []'), 1);
  });

  test('countTsLine — prose is skipped', () => {
    assert.strictEqual(countTsLine('before any further await'), 0);
    assert.strictEqual(countTsLine('anywhere'), 0);
  });
});

// ---------------------------------------------------------------------------
// Output helpers (side-effect only; assertions above drive pass/fail)
// ---------------------------------------------------------------------------

/**
 * Build the assertion failure message for an area whose count diverged from
 * the baseline — grown (name the files) or shrunk (ask to lower the baseline).
 */
function ratchetMessage(area, total, baselineTotal, map) {
  if (total > baselineTotal) {
    const files = Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([f, c]) => `    ${f}: ${c}`)
      .join('\n');
    return `${area} grew from ${baselineTotal} to ${total} explicit any tokens. Files in ${area}:\n${files}`;
  }
  return `lower the baseline for ${area} to ${total} in test/any-baseline.json`;
}
