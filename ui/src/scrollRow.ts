// Pure geometry for a horizontally scrolling row (the Config tab strip): which edges hide content,
// and where to scroll so one item is fully visible. No DOM access — callers pass the measurements.

/** Sub-pixel slack: fractional scroll positions (zoom, HiDPI) never read as an overflowing edge. */
const SLACK = 1;

/** Which sides of the row have content scrolled out of view (each shows an edge fade). */
export function overflowEdges(m: { scrollLeft: number; scrollWidth: number; clientWidth: number }): { start: boolean; end: boolean } {
  return { start: m.scrollLeft > SLACK, end: m.scrollLeft + m.clientWidth < m.scrollWidth - SLACK };
}

/**
 * The row's `scrollLeft` that brings the item spanning `[start, end)` (in the row's content
 * coordinates) fully into view, `pad` px clear of an edge fade; the current one when it already is.
 * Only ever horizontal — unlike `scrollIntoView`, it never scrolls the page.
 */
export function revealScrollLeft(row: { scrollLeft: number; clientWidth: number }, item: { start: number; end: number }, pad = 0): number {
  if (item.start - pad < row.scrollLeft) return Math.max(0, item.start - pad);
  if (item.end + pad > row.scrollLeft + row.clientWidth) return Math.max(0, item.end + pad - row.clientWidth);
  return row.scrollLeft;
}
