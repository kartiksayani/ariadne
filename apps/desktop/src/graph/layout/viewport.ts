import type { Bounds } from './geometry';

export interface Viewport { readonly x: number; readonly y: number; readonly scale: number }
export interface Point { readonly x: number; readonly y: number }
export const MIN_ZOOM = 0.25, MAX_ZOOM = 2, FIT_PADDING = 32;
export const clampZoom = (scale: number): number => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));

export function zoomAt(view: Viewport, cursor: Point, requestedScale: number): Viewport {
  const scale = clampZoom(requestedScale), ratio = scale / view.scale;
  return { scale, x: cursor.x - (cursor.x - view.x) * ratio, y: cursor.y - (cursor.y - view.y) * ratio };
}

export function fitBounds(bounds: Bounds, width: number, height: number): Viewport {
  const scale = bounds.width && bounds.height
    ? clampZoom(Math.min(Math.max(0, width - 2 * FIT_PADDING) / bounds.width,
      Math.max(0, height - 2 * FIT_PADDING) / bounds.height)) : 1;
  return { scale, x: width / 2 - (bounds.x + bounds.width / 2) * scale,
    y: height / 2 - (bounds.y + bounds.height / 2) * scale };
}

export function fitsAtMinimum(bounds: Bounds, width: number, height: number): boolean {
  return bounds.width * MIN_ZOOM <= width - 2 * FIT_PADDING && bounds.height * MIN_ZOOM <= height - 2 * FIT_PADDING;
}
