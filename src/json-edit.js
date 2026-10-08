// Minimal, surgical JSON text editor for `agenthook rename`: changes only the top-level
// "name" value (and optionally inserts a top-level "stateId" right after it), or — for
// `rename --move` — sets/drops the top-level "stateId", without re-serialising the file —
// comments-as-keys, key order, indentation, blank lines and EOL style all survive untouched.
// Pure (no fs).

/**
 * Scan `text` for every top-level (depth-1, i.e. a direct child of the root object) member,
 * returning each as `{ key, keyStart, valueStart, valueEnd, isString }` — `valueStart`/`valueEnd`
 * bound the raw value token (for a string, including the quotes). Handles string escapes and
 * nested `{}`/`[]` so a nested "name" is never mistaken for the top-level one.
 * @param {string} text @returns {{ key: string, keyStart: number, valueStart: number, valueEnd: number, isString: boolean }[]}
 */
function scanTopLevelMembers(text) {
  let i = 0;
  const n = text.length;
  /** Skip whitespace. */
  const skipWs = () => {
    while (i < n && /\s/.test(text[i])) i++;
  };
  /** Parse a JSON string starting at text[i] === '"'; returns its raw (unescaped) value and advances i past the closing quote. */
  const readString = () => {
    const start = i;
    i++; // opening quote
    let out = "";
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        const next = text[i + 1];
        if (next === "u") {
          out += JSON.parse(`"${text.slice(i, i + 6)}"`);
          i += 6;
        } else {
          out += JSON.parse(`"\\${next}"`);
          i += 2;
        }
        continue;
      }
      if (c === '"') {
        i++;
        return { value: out, start, end: i };
      }
      out += c;
      i++;
    }
    throw new Error("json-edit: unterminated string");
  };
  /** Skip one JSON value starting at i (whatever it is), advancing past it. */
  const skipValue = () => {
    skipWs();
    const c = text[i];
    if (c === '"') {
      readString();
      return;
    }
    if (c === "{" || c === "[") {
      const open = c;
      const close = open === "{" ? "}" : "]";
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const ch = text[i];
        if (ch === '"') {
          readString();
          continue;
        }
        if (ch === open) depth++;
        else if (ch === close) depth--;
        i++;
      }
      return;
    }
    // number, true, false, null
    while (i < n && !/[,}\]]/.test(text[i])) i++;
  };

  skipWs();
  if (text[i] !== "{") throw new Error("json-edit: expected a top-level JSON object.");
  i++; // consume '{'
  /** @type {ReturnType<typeof scanTopLevelMembers>} */
  const members = [];
  for (;;) {
    skipWs();
    if (text[i] === "}") break;
    if (text[i] === ",") {
      i++;
      skipWs();
    }
    if (text[i] === "}") break;
    if (text[i] !== '"') throw new Error("json-edit: expected a top-level key.");
    const keyStart = i;
    const { value: key } = readString();
    skipWs();
    if (text[i] !== ":") throw new Error(`json-edit: expected ":" after key "${key}".`);
    i++;
    skipWs();
    const valueStart = i;
    const isString = text[i] === '"';
    skipValue();
    const valueEnd = i;
    members.push({ key, keyStart, valueStart, valueEnd, isString });
    skipWs();
    if (text[i] === ",") continue;
    if (text[i] === "}") break;
    throw new Error("json-edit: expected ',' or '}' after a member.");
  }
  return members;
}

/**
 * Replace the top-level "name" string value with `newName`, and — when there is no top-level
 * "stateId" and `stateKey !== newName` — insert `"stateId": "<stateKey>"` immediately after it,
 * matching the file's own EOL and indentation. Throws if "name" is missing, duplicated at the
 * top level, or not a string; also throws (as a safety net) if the result doesn't parse back to
 * the expected values.
 * @param {string} text @param {string} newName @param {string} stateKey @returns {string}
 */
export function renameInConfigText(text, newName, stateKey) {
  const members = scanTopLevelMembers(text);
  const nameMembers = members.filter((m) => m.key === "name");
  if (!nameMembers.length) throw new Error(`json-edit: no top-level "name" key found.`);
  if (nameMembers.length > 1) throw new Error(`json-edit: duplicate top-level "name" key.`);
  const nameMember = nameMembers[0];
  if (!nameMember.isString) throw new Error(`json-edit: top-level "name" is not a string.`);
  const hasStateId = members.some((m) => m.key === "stateId");

  let out = text.slice(0, nameMember.valueStart) + JSON.stringify(newName) + text.slice(nameMember.valueEnd);
  // Recompute the insertion point against `out` (name value length may have changed).
  const insertAt = nameMember.valueStart + JSON.stringify(newName).length;

  if (!hasStateId && stateKey !== newName) out = insertStateId(out, nameMember.keyStart, insertAt, stateKey);

  const check = JSON.parse(out);
  if (check.name !== newName) throw new Error("json-edit: post-write safety check failed (name mismatch).");
  if (!hasStateId && stateKey !== newName) {
    if (check.stateId !== stateKey) throw new Error("json-edit: post-write safety check failed (stateId mismatch).");
  } else if (hasStateId) {
    const prevStateId = JSON.parse(text).stateId;
    if (check.stateId !== prevStateId) throw new Error("json-edit: post-write safety check failed (stateId changed unexpectedly).");
  }
  return out;
}

/**
 * Insert `"stateId": <stateKey>` at `insertAt` (just past the "name" value whose key starts at
 * `keyStart`), matching the file's EOL and the "name" line's indentation.
 * @param {string} text @param {number} keyStart @param {number} insertAt @param {string} stateKey @returns {string}
 */
function insertStateId(text, keyStart, insertAt, stateKey) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // Indentation: the whitespace between the start of "name"'s line and its key.
  const lineStart = text.lastIndexOf("\n", keyStart) + 1;
  const indent = text.slice(lineStart, keyStart);
  // Compact JSON: "name" shares its line with the opening '{' (i.e. the line up to the key is
  // not pure whitespace) — fall back to an inline insertion instead of a new indented line.
  const compact = indent.trim() !== "";
  const literal = JSON.stringify(stateKey);
  const insertion = compact ? `, "stateId": ${literal}` : `,${eol}${indent}"stateId": ${literal}`;
  return text.slice(0, insertAt) + insertion + text.slice(insertAt);
}

/**
 * Set the top-level "stateId" to `stateId`, or drop it when `stateId` is null (`rename --move`).
 * An existing string value is replaced in place; null removes the member together with its
 * separating comma (and, multi-line, its line); an absent one is inserted right after "name".
 * Throws if "stateId" is duplicated or not a string, if it must be inserted but "name" is
 * missing, or (safety net) if the result doesn't parse back to the expected value.
 * @param {string} text @param {string|null} stateId @returns {string}
 */
export function setStateIdInConfigText(text, stateId) {
  const members = scanTopLevelMembers(text);
  const idx = members.findIndex((m) => m.key === "stateId");
  if (members.filter((m) => m.key === "stateId").length > 1) throw new Error(`json-edit: duplicate top-level "stateId" key.`);
  const member = idx === -1 ? null : members[idx];
  if (member && !member.isString) throw new Error(`json-edit: top-level "stateId" is not a string.`);

  let out = text;
  if (member && stateId !== null) {
    out = text.slice(0, member.valueStart) + JSON.stringify(stateId) + text.slice(member.valueEnd);
  } else if (member) {
    const next = members[idx + 1];
    const prev = members[idx - 1];
    // Not last: cut through to the next key (value, comma, newline + its indent go; the
    // stateId line's own indent stays for the next key). Last: cut from the previous value's
    // end, taking the separating comma with it.
    if (next) out = text.slice(0, member.keyStart) + text.slice(next.keyStart);
    else if (prev) out = text.slice(0, prev.valueEnd) + text.slice(member.valueEnd);
    else out = text.slice(0, member.keyStart) + text.slice(member.valueEnd);
  } else if (stateId !== null) {
    const nameMembers = members.filter((m) => m.key === "name");
    if (nameMembers.length !== 1) throw new Error(`json-edit: expected exactly one top-level "name" key to insert "stateId" after.`);
    out = insertStateId(text, nameMembers[0].keyStart, nameMembers[0].valueEnd, stateId);
  }

  const check = JSON.parse(out);
  if (check.stateId !== (stateId ?? undefined)) throw new Error("json-edit: post-write safety check failed (stateId mismatch).");
  return out;
}
