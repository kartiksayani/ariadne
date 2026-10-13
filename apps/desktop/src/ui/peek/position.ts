export interface PeekBounds { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }

/** Prefer beside the source, then the opposite side; keep the card below the app chrome. */
export function peekPosition(anchor: PeekBounds, width: number, height: number, viewportWidth: number, viewportHeight: number, chromeBottom: number) {
  const edge = 12, gap = 8, top = Math.min(viewportHeight - edge, Math.max(edge, chromeBottom + gap));
  const maxWidth = Math.max(0, viewportWidth - edge * 2), maxHeight = Math.max(0, viewportHeight - top - edge);
  const fittedWidth = Math.min(width, maxWidth), fittedHeight = Math.min(height, maxHeight);
  const right = anchor.right + gap;
  const left = right + fittedWidth <= viewportWidth - edge ? right : anchor.left - fittedWidth - gap;
  return { left: Math.max(edge, Math.min(left, viewportWidth - fittedWidth - edge)), top: Math.max(top, Math.min(anchor.top, viewportHeight - fittedHeight - edge)), maxWidth, maxHeight };
}
