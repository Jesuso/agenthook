// Minimal JSON-Schema subset validator for the tool `inputSchema`s in tools.js. MCP clients are
// supposed to validate, but the server cannot rely on that: an LLM caller can send anything, and
// handlers must not see `last:"abc"` (slice(-NaN) = everything) or stray fields that would be
// forwarded into control-socket payloads and the audit line. Supports exactly what tools.js uses:
// type object/string/integer/boolean/array (of strings), required, additionalProperties:false,
// minimum/maximum. Returns an agent-readable message, or null when valid.

/**
 * @param {{properties?: Record<string, any>, required?: string[], additionalProperties?: boolean}} schema
 * @param {any} args
 * @returns {string|null}
 */
export function validateArgs(schema, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const props = schema.properties ?? {};
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(props, key)) return schema.additionalProperties === false ? `unknown argument "${key}" (allowed: ${Object.keys(props).join(", ") || "none"})` : null;
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) return `"${key}" is required`;
  }
  for (const [key, def] of Object.entries(props)) {
    const v = args[key];
    if (v === undefined) continue;
    switch (def.type) {
      case "string":
        if (typeof v !== "string") return `"${key}" must be a string`;
        break;
      case "boolean":
        if (typeof v !== "boolean") return `"${key}" must be a boolean`;
        break;
      case "integer":
        if (typeof v !== "number" || !Number.isInteger(v)) return `"${key}" must be an integer`;
        if (def.minimum !== undefined && v < def.minimum) return `"${key}" must be >= ${def.minimum}`;
        if (def.maximum !== undefined && v > def.maximum) return `"${key}" must be <= ${def.maximum}`;
        break;
      case "array":
        if (!Array.isArray(v)) return `"${key}" must be an array`;
        if (def.items?.type === "string" && v.some((x) => typeof x !== "string")) return `"${key}" must be an array of strings`;
        break;
      default:
        break;
    }
  }
  return null;
}
