/** Opening placement keeps the usual centre where the whole row fits, below its sticky topic band.
 * A row taller than the reading area starts at its clear top instead. The outer session/filter bars
 * already sit above the scroller, so only the target topic's measured height belongs in this offset.
 * `bottomInset` is the floating dock's height: the reading area ends above it. */
export function openingTop(viewportHeight: number, rowHeight: number, headerHeight: number, margin = 8, bottomInset = 0): number {
  const visible = viewportHeight - bottomInset;
  const top = headerHeight + margin;
  const lastTop = visible - margin - rowHeight;
  const centered = visible / 2 - Math.min(rowHeight, 120) / 2;
  return Math.max(top, Math.min(centered, lastTop));
}

/** The Back-to pill floating over an edge of the Map: where it sits (relative to the scroller's top) and which edge it points at. */
export interface BackPill { readonly edge: 'above' | 'below'; readonly top: number; readonly bottom: number }

/**
 * The least movement that clears the same measured sticky header as opening placement, and the dock (`bottomInset`) below.
 * A Back-to `pill` on an edge is cleared too: the row ends `margin` clear of it, so a row scrolled to is never under it.
 */
export function nearestDelta(viewportHeight: number, rowTop: number, rowHeight: number, headerHeight: number, margin = 0, bottomInset = 0,
  pill: BackPill | null = null): number {
  const top = Math.max(headerHeight + margin, pill?.edge === 'above' ? pill.bottom + margin : 0);
  const bottom = Math.min(viewportHeight - bottomInset - margin, pill?.edge === 'below' ? pill.top - margin : Infinity);
  if (rowTop < top) return rowTop - top;
  if (rowTop + rowHeight > bottom) return Math.min(rowTop + rowHeight - bottom, rowTop - top);
  return 0;
}
