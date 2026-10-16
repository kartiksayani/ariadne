export const DOCK_DEFAULT = 330;
export const DOCK_MIN = 180;
export const DOCK_MAX = 2400;
export const DOCK_LINE = 40;
export const DOCK_FOLD_THRESHOLD = 120;

const STORAGE_KEY = 'ariadne.redesign.answerDock.height.v1';
const validHeight = (height: unknown): height is number => typeof height === 'number'
  && Number.isInteger(height) && height >= DOCK_MIN && height <= DOCK_MAX;

/** Browser-local layout keeps the native preferences readable by older releases. */
export function loadDockHeight(storage?: Pick<Storage, 'getItem'>): number {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(STORAGE_KEY);
    const height: unknown = raw === null ? null : JSON.parse(raw);
    return validHeight(height) ? height : DOCK_DEFAULT;
  } catch { return DOCK_DEFAULT; }
}

export function saveDockHeight(height: number, storage?: Pick<Storage, 'setItem'>): boolean {
  if (!validHeight(height)) return false;
  try {
    (storage ?? globalThis.localStorage).setItem(STORAGE_KEY, JSON.stringify(height));
    return true;
  } catch { return false; }
}

export function clampDockHeight(height: number, max = DOCK_MAX): number {
  const ceiling = Number.isFinite(max) ? Math.max(DOCK_MIN, Math.min(DOCK_MAX, Math.floor(max))) : DOCK_MAX;
  const rounded = Number.isFinite(height) ? Math.round(height) : DOCK_DEFAULT;
  return Math.max(DOCK_MIN, Math.min(ceiling, rounded));
}
