// Guard against barrels (files that only re-export another file's names): a folder may have
// several files that others import, but import from the file that defines what you use, not
// from a re-export of it (see CLAUDE.md § Conventions). Walks src/ and ui/src/, strips comments,
// and fails on (a) a file whose only statements are re-exports, or (b) any runtime re-export
// line (`export {...} from`, `export * from`, `export * as x from`) in a file with its own code.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const ROOT = join(__dirname, '..');

// src/types/index.js is JSDoc types only (no runtime code); whether it should stay a barrel is
// the owner's separate decision (see issue #875), not this guard's.
const ALLOWED = new Set(['src/types/index.js']);

function walk(dir, exts) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full, exts));
    } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

/** Strip block and line comments (escape-aware passthrough of string/template literals, so a
 * `//` or `/*` inside a quoted string — a URL, say — never opens a phantom comment). Unlike
 * test/any-ratchet.test.js's reduceTsText, literals are kept verbatim rather than blanked: the
 * re-export regexes below need the quotes around `from "..."` intact. */
function stripComments(content) {
  let out = '';
  let i = 0;
  const n = content.length;
  while (i < n) {
    const c = content[i];
    const c2 = content[i + 1];
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i = i < n ? i + 2 : n;
    } else if (c === '/' && c2 === '/') {
      i += 2;
      while (i < n && content[i] !== '\n') i++;
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n && content[i] !== quote) {
        if (content[i] === '\\') { out += content[i]; i++; }
        if (i < n) { out += content[i]; i++; }
      }
      if (i < n) { out += content[i]; i++; }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// A runtime re-export: `export {...} from "..."`, `export * from "..."`, `export * as x from
// "..."`. Deliberately excludes `export type {...} from` (type-only; allowed in a file with its
// own code).
const RUNTIME_REEXPORT = /export\s+(?:\*\s*(?:as\s+[A-Za-z0-9_$]+\s*)?|\{[^}]*\}\s*)from\s+["'][^"']*["']/g;

// Any re-export statement, type-only or runtime (used to detect "only re-exports"). Unlike
// RUNTIME_REEXPORT, this also matches `export type {...} from`. Deliberately requires a `from`
// clause — `export {}` (a bare module marker) and `export {x}` (the separate
// import-then-re-export shape, out of scope for this guard) are not re-exports.
const ANY_REEXPORT_STATEMENT = /export\s+(?:type\s*)?(?:\*\s*(?:as\s+[A-Za-z0-9_$]+\s*)?|\{[^}]*\}\s*)from\s+["'][^"']*["']/g;

function isPureBarrel(reduced) {
  const exportStatements = reduced.match(ANY_REEXPORT_STATEMENT) || [];
  if (exportStatements.length === 0) return false;
  // Remove every export statement; if nothing meaningful remains, the file only re-exports.
  let rest = reduced;
  for (const stmt of exportStatements) rest = rest.replace(stmt, '');
  // Remove import statements (a pure barrel may still import for other purposes — ignore them
  // for this check, matching the ticket's "every statement is export ... from").
  rest = rest.replace(/import\s+[^;]*;?/g, '');
  // Export statements don't consume their trailing `;`; drop stray semicolons too before
  // deciding nothing meaningful remains.
  return rest.replace(/;/g, '').trim() === '';
}

describe('no-barrels: detection helpers', () => {
  test('type-only pure barrel with trailing semicolon is caught', () => {
    const reduced = stripComments('export type { MessageKey } from "./i18n/en";\n');
    assert.equal(isPureBarrel(reduced), true);
  });

  test('runtime pure barrel is caught by both checks', () => {
    const reduced = stripComments('export { foo } from "./foo.js";\n');
    assert.equal(isPureBarrel(reduced), true);
    assert.deepEqual(reduced.match(RUNTIME_REEXPORT) || [], ['export { foo } from "./foo.js"']);
  });

  test('multi-line export {...} from is caught', () => {
    const reduced = stripComments('export {\n  foo,\n  bar,\n} from "./foo.js";\n');
    assert.equal((reduced.match(RUNTIME_REEXPORT) || []).length, 1);
  });

  test('a file with its own code plus a type-only re-export passes', () => {
    const reduced = stripComments(
      'export type { Foo } from "./foo.js";\nexport function bar() { return 1; }\n',
    );
    assert.equal(isPureBarrel(reduced), false);
    assert.deepEqual(reduced.match(RUNTIME_REEXPORT) || [], []);
  });
});

describe('no-barrels', () => {
  const files = [
    ...walk(join(ROOT, 'src'), ['.js', '.mjs']),
    ...walk(join(ROOT, 'ui', 'src'), ['.ts', '.tsx']),
  ];

  for (const f of files) {
    const rel = relative(ROOT, f).split(sep).join('/');
    if (ALLOWED.has(rel)) continue;
    test(`${rel}: not a barrel`, () => {
      const content = readFileSync(f, 'utf8');
      const reduced = stripComments(content);

      const runtimeReexports = reduced.match(RUNTIME_REEXPORT) || [];
      assert.deepEqual(
        runtimeReexports,
        [],
        `${rel}: import from the file that defines the name; do not add a file that only re-exports.`,
      );

      assert.equal(
        isPureBarrel(reduced),
        false,
        `${rel}: import from the file that defines the name; do not add a file that only re-exports.`,
      );
    });
  }
});
