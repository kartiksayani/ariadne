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

/** Stable per-root decorative hue in degrees, from a string hash of the root's key; selection and status also have shape/text cues. */
export function branchHue(key: string): number {
  return [...key].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0) * 139 % 360;
}
