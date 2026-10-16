// A one-glance "what is this ticket about": the first prose paragraph of a tracker description,
// stripped of markdown and clipped. Stored in refmeta.json (durable, so it must stay small) and
// shown by `ah ui`. Pure and import-free.

export const SUMMARY_MAX = 240;

/**
 * Real ticket bodies open with headings, checklists and fences ("## Problem"), so take the first
 * paragraph that is actual prose, not the first line.
 * @param {unknown} description
 * @returns {string|undefined}  undefined when there is no usable prose
 */
export function summarizeDescription(description) {
  if (typeof description !== "string") return undefined;
  const text = description
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?(```|$)/g, "");
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^#{1,6}\s/.test(l) && !/^[-*_]{3,}$/.test(l) && !/^\|/.test(l) && !/^[-*]\s*\[[ xX]\]/.test(l));
    const prose = lines
      .join(" ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links keep their text
      .replace(/<[^>]+>/g, "") // html tags
      .replace(/[*_`~]+/g, "") // emphasis, code ticks
      .replace(/^>\s*/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (prose.length < 12) continue; // "TL;DR", a lone word, leftover markup
    return prose.length > SUMMARY_MAX ? prose.slice(0, SUMMARY_MAX - 1).trimEnd() + "…" : prose;
  }
  return undefined;
}
