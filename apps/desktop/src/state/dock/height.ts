// The dock's dragged height (§5.2). Without one the open dock is as tall as its content, up to 60% of the window.
export const DOCK_MIN = 180;
export const DOCK_MAX = 2400;
export const DOCK_LINE = 40;
export const DOCK_FOLD_THRESHOLD = 120;
/** The top bar (40) and the room the Map keeps above the dock (56). */
export const DOCK_RESERVED = 96;

const STORAGE_KEY = 'ariadne.dock.height.v1';
const validHeight = (height: unknown): height is number => typeof height === 'number'
  && Number.isInteger(height) && height >= DOCK_MIN && height <= DOCK_MAX;

/** The kept height, or null for "auto". Browser-local, so ui.json stays readable by older releases. */
export function loadDockHeight(storage?: Pick<Storage, 'getItem'>): number | null {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(STORAGE_KEY);
    const height: unknown = raw === null ? null : JSON.parse(raw);
    return validHeight(height) ? height : null;
  } catch { return null; }
}

export function saveDockHeight(height: number, storage?: Pick<Storage, 'setItem'>): boolean {
  if (!validHeight(height)) return false;
  try {
    (storage ?? globalThis.localStorage).setItem(STORAGE_KEY, JSON.stringify(height));
    return true;
  } catch { return false; }
}

/** A dragged height kept between 180 and the window less the top bar and the Map's room. */
export function clampDockHeight(height: number, windowHeight: number): number {
  const ceiling = Number.isFinite(windowHeight) ? Math.max(DOCK_MIN, Math.min(DOCK_MAX, Math.floor(windowHeight - DOCK_RESERVED))) : DOCK_MAX;
  const rounded = Number.isFinite(height) ? Math.round(height) : DOCK_MIN;
  return Math.max(DOCK_MIN, Math.min(ceiling, rounded));
}

/** What a released drag does: fold under 120, snap to 180 between 120 and 180, else keep the clamped height. */
export function releaseDockHeight(value: number, windowHeight: number): { readonly fold: true } | { readonly fold: false; readonly height: number } {
  if (value < DOCK_FOLD_THRESHOLD) return { fold: true };
  return { fold: false, height: clampDockHeight(value, windowHeight) };
}
