/** Opening placement keeps the usual centre where the whole row fits, below its sticky topic band.
 * A row taller than the reading area starts at its clear top instead. The outer session/filter bars
 * already sit above the scroller, so only the target topic's measured height belongs in this offset. */
export function openingTop(viewportHeight: number, rowHeight: number, headerHeight: number, margin = 8): number {
  const top = headerHeight + margin;
  const lastTop = viewportHeight - margin - rowHeight;
  const centered = viewportHeight / 2 - Math.min(rowHeight, 120) / 2;
  return Math.max(top, Math.min(centered, lastTop));
}

/** The least movement that clears the same measured sticky header as opening placement. */
export function nearestDelta(viewportHeight: number, rowTop: number, rowHeight: number, headerHeight: number, margin = 0): number {
  const top = headerHeight + margin, bottom = viewportHeight - margin;
  if (rowTop < top) return rowTop - top;
  if (rowTop + rowHeight > bottom) return Math.min(rowTop + rowHeight - bottom, rowTop - top);
  return 0;
}
