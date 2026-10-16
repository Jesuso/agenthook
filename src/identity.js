// A profile's visible identity (docs/web-ui.md § v4): a colour and an emoji the UI shows on its
// Home card and app bar. Both are optional config (`ui: { color, emoji }`); unset, they derive
// deterministically from the state key, so every profile is distinct out of the box.
// Import-free on purpose: src/config.js validates with it, the heartbeat/rows project it, and the
// browser bundles it (like contract.js). The palette's ids map to CSS tokens in ui/src/index.css
// (`--color-profile-<id>`); the values live there, tuned per colour scheme.

/** Palette ids. Red, amber and green are deliberately absent: those hues mean status. */
export const PROFILE_COLORS = /** @type {const} */ (["sky", "indigo", "violet", "pink", "teal", "cyan", "slate", "stone"]);

/** The curated emoji list (single code points, so config round-trips as plain strings). */
export const PROFILE_EMOJIS = /** @type {const} */ ([
  "💻", "🚀", "🧪", "🐞", "📦", "🧰", "🔧", "🧠", "🤖", "📊",
  "📈", "📝", "🎨", "🎬", "🎧", "📣", "🛒", "💬", "🧾", "💼",
  "🔒", "🔍", "🌱", "🌍", "⚡", "🔥", "⭐", "🎯", "🧭", "📚",
  "🎓", "🏠", "🐙", "🦊", "🐝", "🦉", "🐢", "🦄", "🌙", "☕",
  "🍀", "🧩", "🔔", "📡", "🔭", "🧬", "🪄", "🎮", "🎲", "🧱",
  "🔬", "💡", "🧲", "🪐", "🌊", "🍊", "🍋", "🍄", "🏁", "🛟",
]);

/** @param {unknown} v @returns {v is typeof PROFILE_COLORS[number]} */
export const isProfileColor = (v) => typeof v === "string" && /** @type {readonly string[]} */ (PROFILE_COLORS).includes(v);
/** @param {unknown} v @returns {v is typeof PROFILE_EMOJIS[number]} */
export const isProfileEmoji = (v) => typeof v === "string" && /** @type {readonly string[]} */ (PROFILE_EMOJIS).includes(v);

/** FNV-1a, 32-bit: small, stable across runtimes, spreads short keys well enough for 8 / 60 buckets. @param {string} s */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The identity a profile gets with nothing configured; the same key always gives the same pair.
 * @param {string} key the profile's state key
 * @returns {{ color: typeof PROFILE_COLORS[number], emoji: typeof PROFILE_EMOJIS[number] }}
 */
export function deriveIdentity(key) {
  const h = hash(key);
  return { color: PROFILE_COLORS[h % PROFILE_COLORS.length], emoji: PROFILE_EMOJIS[(h >>> 8) % PROFILE_EMOJIS.length] };
}

/**
 * A profile's effective identity: each configured value that is valid wins, the derived one fills the rest.
 * @param {string} key the state key
 * @param {{ color?: unknown, emoji?: unknown } | null | undefined} configured
 */
export function resolveIdentity(key, configured) {
  const d = deriveIdentity(key);
  return { color: isProfileColor(configured?.color) ? configured.color : d.color, emoji: isProfileEmoji(configured?.emoji) ? configured.emoji : d.emoji };
}

/**
 * validateRawConfig's check for the `ui` block: [] when absent or well-formed.
 * @param {any} ui
 * @returns {string[]}
 */
export function identityErrors(ui) {
  if (ui == null) return [];
  if (typeof ui !== "object" || Array.isArray(ui)) return [`config: "ui" must be an object.`];
  /** @type {string[]} */
  const errors = [];
  if (ui.color != null && !isProfileColor(ui.color)) errors.push(`config: ui.color must be one of ${PROFILE_COLORS.join(", ")} (got ${JSON.stringify(ui.color)}).`);
  if (ui.emoji != null && !isProfileEmoji(ui.emoji)) errors.push(`config: ui.emoji must be one of the supported emoji (got ${JSON.stringify(ui.emoji)}).`);
  return errors;
}
