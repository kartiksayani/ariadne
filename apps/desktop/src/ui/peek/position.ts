export interface PeekBounds { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }

const GAP = 6, EDGE = 8, TOP = 48;

/**
 * Under the name, 6px below it, left edges aligned and kept 8px inside the window.
 * If the card would cross the bottom it opens above the name instead, never higher than 48px.
 * With no room either way it takes the larger side and scrolls inside.
 */
export function peekPosition(anchor: PeekBounds, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const maxWidth = Math.max(0, viewportWidth - EDGE * 2), fittedWidth = Math.min(width, maxWidth);
  const left = Math.max(EDGE, Math.min(anchor.left, viewportWidth - EDGE - fittedWidth));
  const below = anchor.bottom + GAP, roomBelow = Math.max(0, viewportHeight - EDGE - below);
  const roomAbove = Math.max(0, anchor.top - GAP - TOP);
  if (height <= roomBelow || roomBelow >= roomAbove) return { left, top: below, maxWidth, maxHeight: roomBelow };
  const top = Math.max(TOP, anchor.top - GAP - height);
  return { left, top, maxWidth, maxHeight: anchor.top - GAP - top };
}
