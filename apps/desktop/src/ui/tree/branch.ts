// Branch hues: the five hues the Map gives its top-level items, and today's assignment of one to a root.
// Dependency-free so the Help panel and the row model can both import it.

/** Branch hues in the order the Map gives them to top-level items, with the chroma multiplier that evens them out. */
export const BRANCH_HUES: ReadonlyArray<{ readonly name: string; readonly hue: number; readonly chroma: number }> = [
  { name: 'violet', hue: 295, chroma: 1 },
  { name: 'olive', hue: 112, chroma: 1.15 },
  { name: 'orchid', hue: 325, chroma: 0.95 },
  { name: 'slate', hue: 220, chroma: 0.9 },
  { name: 'rose', hue: 355, chroma: 0.85 },
];

/**
 * A branch's slot in BRANCH_HUES: its top item's ordinal, counted from one, round the five hues. Core hands top-item
 * ordinals out from the session's `next_root` counter, which only ever counts up (removal and emptying the bin leave it
 * alone), so adding, removing and reloading never shift another branch's slot.
 */
export function branchSlot(rootOrdinal: number): number {
  return (((rootOrdinal - 1) % BRANCH_HUES.length) + BRANCH_HUES.length) % BRANCH_HUES.length;
}
